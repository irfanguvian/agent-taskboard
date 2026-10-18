'use strict';
// util: helpers shared by more than one module.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sh = require('./sh');

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// p is root or inside it (both real paths)
const within = (/** @type {string} */ p, /** @type {string} */ root) => p === root || p.startsWith(root + path.sep);
// a plain file (lstat): a link is never read through
const isFile = (/** @type {string} */ p) => fsp.lstat(p).then((s) => s.isFile(), () => false);
// a ticket's planning rounds: rounds/NN-questions.json, rounds/NN-plan.json (NN = the round, 2+ digits; P4 U5)
const ROUND_RE = /^(\d{2,})-(questions|plan)\.json$/;
// a full commit name: SHA-1 (40 hex) or SHA-256 (64 hex) (M5.3 L6)
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The claude version new installs pin (spec §9). AC12 upgrade (README): fake suite, real smoke, then this default
// (Irfan 2026-10-09). One place: doctor, store's default claude_bin, scripts/chaos.js and scripts/contain-smoke.js.
const DEFAULT_PIN = '2.1.302';

// What a child process gets when it may run repo code: a shell's basics and nothing else (H8).
const MINIMAL_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const pick = (/** @type {string[]} */ keys, /** @type {Record<string, string | undefined>} */ env) =>
  Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const minimalEnv = (/** @type {Record<string, string | undefined>} */ env) => pick(MINIMAL_ENV, env);

// git in a repo or worktree an agent could have written to: its config must never run code in tbd (H11). H2.2: no auto
// maintenance / gc and no commit-graph in any git tbd runs: an auto gc under a swapped object dir (trusted, below) prunes
// the tag repo's objects by a clone's refs (data loss, spike S4), a detached one outlives the timeout, and an
// agent-planted commit-graph would steer history walks.
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.commitGraph=false']; // before -C / --git-dir
// GIT_NO_REPLACE_OBJECTS: a refs/replace ref (shared refs an agent may write) never swaps the content git checks out
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const GIT = '/usr/bin/git';

// M5 C14 (S2) system: true: git as Irfan's shell runs it minus his global config: the system config stays read (its
// osxkeychain credential helper answers `tb push`), never a terminal prompt. Only for git that never runs in a worktree.
const GIT_SYSTEM_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };

// Every git tbd runs (D31, D35d): argv only, GIT_SAFE + GIT_ENV, a minimal env (picked from env), a timeout; sh-shaped
// (never rejects). dirs (S1): a ticket's git_dir + common_dir, recorded at assign right after `worktree add`, pinned in
// the env with cwd as the work tree, so git never reads the worktree's .git file (the agent's to rewrite: a planted
// config's filter would run in tbd as Irfan). git 2.50 still reads refs through <git_dir>/commondir (a plain file, also
// writable by an agent that writes .git): it must resolve to common_dir, else git is refused (err, nothing run). No
// git_dir (a ticket from before the fix): git finds them itself, as before. ceiling: GIT_CEILING_DIRECTORIES. exec: an
// sh-shaped fake (tests). M5.3: add = vars set as given (env is only the source the minimal env is picked from: a
// GIT_AUTHOR_NAME there is dropped); GIT_ENV, the pin and ceiling win over them. system: GIT_SYSTEM_ENV for GIT_ENV.
// M5.5 X3: signal (an AbortSignal) is handed to the child: an abort kills it (a lane job's halt / memory / shutdown).
// H2.2: dirs.clone set (a ticket's own clone, cloneAt) → clone mode: cloneRefused's checks instead of commondir, git dir
// = common dir = the clone's .git; trusted (o.trusted or dirs.trusted === true) also points git at the tag repo's
// objects ONLY (GIT_OBJECT_DIRECTORY): the clone's own objects and its alternates file are never read (index + refs stay
// the clone's), so a gate reads what tbd fetched and fsck'd (D-0152), never what the agent planted. dirs.git_dir without
// dirs.clone: the legacy linked-worktree pin (D-0046).
// ponytail: legacy pin kept for hand-built worktree test fixtures (+ pre-H2 tickets, none live); follow-up: fixtures →
// cloneAt, then delete the legacy branch.
async function commonOf(/** @type {string} */ gitDir) {
  const f = path.join(gitDir, 'commondir');
  if (!(await fsp.lstat(f).then((st) => st.isFile(), () => false))) return null; // a link is never followed
  // git strips only the trailing newline (`../.. ` with a space is another dir): never trim more than git does. No
  // path.resolve: it folds `..` before links are followed, git follows them first (`L/../../..` with L a link)
  const d = (await fsp.readFile(f, 'utf8')).replace(/[\r\n]+$/, '');
  return fsp.realpath(path.isAbsolute(d) ? d : `${gitDir}/${d}`).catch(() => null);
}
// H2.2: what git would read from a clone's .git that could run code in tbd or swap what it reads: .git a real dir
// (lstat: a link or a gitfile = planted), no commondir file, the config bytes = the sha256 tbd took after its own last
// write (dirs.clone.config), alternates = the tag repo's objects and nothing else (git writes the path as given: cloneAt
// gets the real common dir). S-H1: the state files git parses as text, whose parse errors quote a line (packed-refs:
// "unexpected line in .git/packed-refs: <line>"; sequencer/todo: "invalid line N: <line>"), are missing or a plain file
// with one link: never a link (or a hard link) to a file of Irfan's that tbd's git, unsandboxed, would read. Reads in
// parallel. → why refused | null.
const CONFIG_MAX = 64 * 1024;
const sha256 = (/** @type {Buffer} */ b) => crypto.createHash('sha256').update(b).digest('hex');
const plainState = (/** @type {string} */ p) => fsp.lstat(p).then((s) => s.isFile() && s.nlink === 1, (e) => e.code === 'ENOENT');
async function cloneRefused(/** @type {any} */ dirs) {
  const g = dirs.git_dir;
  if (!path.isAbsolute(g ?? '') || !path.isAbsolute(dirs.common_dir ?? '')) return 'no absolute git_dir + common_dir on the ticket';
  const seq = path.join(g, 'sequencer');
  const [dir, cd, cfg, alt, packed, sq] = await Promise.all([
    fsp.lstat(g).then((s) => s.isDirectory(), () => false),
    fsp.lstat(path.join(g, 'commondir')).then(() => true, (e) => e.code !== 'ENOENT'),
    plainBytes(path.join(g, 'config'), CONFIG_MAX),
    readPlain(path.join(g, 'objects', 'info', 'alternates'), 4096),
    plainState(path.join(g, 'packed-refs')),
    fsp.lstat(seq).then(async (s) => s.isDirectory() && (await Promise.all((await fsp.readdir(seq)).map((f) => plainState(path.join(seq, f))))).every(Boolean),
      (e) => e.code === 'ENOENT'),
  ]);
  if (!dir) return `${g} is not a directory (a link or a gitfile)`;
  if (cd) return `${g}/commondir exists`;
  if (!cfg || sha256(cfg) !== dirs.clone.config) return `${g}/config is not the one tbd wrote`;
  if (alt !== `${dirs.common_dir}/objects\n`) return `${g}/objects/info/alternates does not name only ${dirs.common_dir}/objects`;
  if (!packed) return `${g}/packed-refs is a link or not a plain file`;
  if (!sq) return `${g}/sequencer holds a link or not a plain file`;
  return null;
}
const planted = (/** @type {string} */ msg) => ({ err: Object.assign(new Error(msg), { code: 'PLANTED' }), stdout: '', stderr: msg }); // runner: Blocked at once, not crash retries
// S-H1 (A09): git on an agent-written clone, or fetching from one (upload-pack's stderr), can print a line of any file
// Irfan can read through a link it follows: its stderr never reaches a message raw (gate why, Blocked text, alerts, a
// resume prompt). → the exit code + a fixed kind; a fetch refused for its objects keeps only the words that say why
// (index-pack's "did not receive expected object", fsck's message ids: a letter word).
function gitWhy(/** @type {any} */ r) {
  const s = String(r.stderr ?? '');
  const ids = [...new Set([...s.matchAll(/^(?:error|fatal|warning): object [0-9a-f]{40,64}: ([a-z][A-Za-z]{2,39}):/gm)].map((m) => m[1]))];
  if (/did not receive expected object/.test(s)) ids.unshift('did not receive expected object');
  const kind = ids.length || /index-pack failed|fsck error/.test(s) ? `index-pack/fsck refused the objects${ids.length ? ` (${ids.slice(0, 5).join(', ')})` : ''}` : 'pin/ref error';
  return `git exit ${r.err?.code ?? r.err?.signal ?? '?'}: ${kind}`;
}
const masked = (/** @type {any} */ r) => {
  const why = gitWhy(r);
  return { ...r, stderr: why, masked: true, err: Object.assign(new Error(why), { code: r.err.code, signal: r.err.signal, killed: r.err.killed }) };
};
async function git(/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{timeout?: number, input?: string, maxBuffer?: number, dirs?: any, trusted?: boolean, env?: Record<string, string | undefined>, add?: Record<string, string>, system?: boolean, ceiling?: string, signal?: AbortSignal, exec?: Function}} */ o = {}) {
  const { timeout = 20_000, input, maxBuffer, dirs, trusted = false, env = process.env, add, system = false, ceiling, signal, exec = sh } = o;
  let pin = {};
  if (dirs?.clone) {
    const why = await cloneRefused(dirs);
    if (why) return planted(`${why}: git refused in ${cwd}`);
    pin = { GIT_DIR: dirs.git_dir, GIT_COMMON_DIR: dirs.git_dir, GIT_WORK_TREE: cwd, GIT_NO_LAZY_FETCH: '1', ...((trusted || dirs.trusted === true) && { GIT_OBJECT_DIRECTORY: `${dirs.common_dir}/objects` }) };
  } else if (dirs?.git_dir) {
    const cd = await commonOf(dirs.git_dir);
    if (cd !== dirs.common_dir) return planted(`${dirs.git_dir}/commondir leads to ${cd ?? '(not a plain file)'}, not ${dirs.common_dir}: git refused in ${cwd}`);
    pin = { GIT_DIR: dirs.git_dir, GIT_COMMON_DIR: dirs.common_dir, GIT_WORK_TREE: cwd, GIT_NO_LAZY_FETCH: '1' };
  }
  const r = await exec(GIT, [...GIT_SAFE, '-C', cwd, ...args], {
    env: { ...minimalEnv(env), ...add, ...(system ? GIT_SYSTEM_ENV : GIT_ENV), ...pin, ...(ceiling && { GIT_CEILING_DIRECTORIES: ceiling }) },
    timeout, ...(input !== undefined && { input }), ...(maxBuffer && { maxBuffer }), ...(signal && { signal }),
  });
  return dirs?.clone && r.err ? masked(r) : r; // S-H1
}
// git's last 3 lines (a refused fetch ends `fatal: index-pack failed`; the cause is the line(s) above), ≤ 300 chars
const gitTail = (/** @type {any} */ r) => String(r.stderr || r.err?.message || '').trim().split('\n').slice(-3).join(' | ').slice(-300);

// H2.1: a ticket's own clone of the tag repo, made by tbd before any agent runs in it → {git_dir, clone: {config}}, kept
// on the ticket (every later git in it pins them, H2.2). common: the tag repo's common dir, a real path (git writes it
// as given into the clone's alternates; the pin compares). wt: a new absolute path whose parent exists. `clone --shared
// --revision` (git ≥ 2.49): no refs, HEAD detached at sha, objects read from the tag repo (alternates), none copied.
// ident {name, email} (the tag's, else `tb agent`): agents can't read ~/.gitconfig, so the clone's config names who
// commits; the config hash is taken after this, tbd's last write. from (M5.5 lanes, H2.6: the parent's pin {worktree,
// git_dir, common_dir, clone, base_sha}): cloned at the parent's base_sha with no checkout, sha (the parent's cur.pre,
// maybe only in the parent clone) fetched from the parent (fetchCommit, objects only; alt = its ref prefix), then checked
// out detached. Throws; the caller removes wt (and any base pin it made).
const AGENT_IDENT = { name: 'tb agent', email: 'tb-agent@localhost' };
async function cloneAt(/** @type {string} */ common, /** @type {string} */ wt, /** @type {string} */ sha, /** @type {{from?: any, ident?: {name: string, email: string}, alt?: string, signal?: AbortSignal}} */ o = {}) {
  const { from, ident: id = AGENT_IDENT, alt, signal } = o;
  const at = from ? from.base_sha : sha;
  if (!SHA_RE.test(sha ?? '') || !SHA_RE.test(at ?? '')) throw new Error(`clone ${wt}: not a commit name: ${JSON.stringify(String(from ? at : sha).slice(0, 80))}`);
  if (!path.isAbsolute(wt) || !path.isAbsolute(common) || (await fsp.realpath(common).catch(() => null)) !== common) throw new Error(`clone ${wt}: ${common} is not the real path of a tag repo's git dir`);
  const fail = (/** @type {any} */ r, /** @type {string} */ what) => new Error(`${what} ${wt} failed: ${gitTail(r)}`);
  const parent = path.dirname(wt); // no git in the clone before its config is hashed
  const c = await git(parent, ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--shared', ...(from ? ['--no-checkout'] : []), `--revision=${at}`, '--', common, wt], { timeout: 120_000, signal });
  if (c.err) throw fail(c, 'git clone');
  const git_dir = await fsp.realpath(path.join(wt, '.git'));
  if (!(await fsp.lstat(git_dir)).isDirectory() || (await readPlain(path.join(git_dir, 'objects', 'info', 'alternates'), 4096)) !== `${common}/objects\n`) {
    throw new Error(`clone ${wt}: its .git is not a dir whose alternates name only ${common}/objects`);
  }
  for (const [k, v] of [['user.name', id.name], ['user.email', id.email]]) {
    const r = await git(parent, ['config', '--file', path.join(git_dir, 'config'), k, v], { signal });
    if (r.err) throw fail(r, `git config ${k} in`);
  }
  // C-L3: no remote (tbd fetches by path; an agent's `git fetch origin` would list the tag's refs); the tag's own ignores
  // (info/exclude: setup output a tag ignores only there is no `??` in the clone)
  await git(parent, ['config', '--file', path.join(git_dir, 'config'), '--remove-section', 'remote.origin'], { signal }); // ponytail: none there is fine
  if (await isFile(path.join(common, 'info', 'exclude'))) await copyPlain(path.join(common, 'info', 'exclude'), path.join(git_dir, 'info', 'exclude'), 0o644);
  const clone = await cloneConfig(git_dir);
  if (from) {
    const dirs = { git_dir, common_dir: common, clone };
    await fetchCommit({ cwd: wt, dirs, from, sha, alt, signal });
    const r = await git(wt, ['checkout', '--quiet', '--detach', sha], { dirs, timeout: 120_000, signal });
    if (r.err) throw fail(r, 'git checkout in');
  }
  return { git_dir, clone };
}

// H2.1: a clone's `clone` field as the pin checks it: {config: sha256 of <git_dir>/config's bytes}. Taken by cloneAt and
// again by approve after the tag's setup (F3: husky's core.hooksPath writes it). Throws when it is no plain file ≤ 64 KB.
async function cloneConfig(/** @type {string} */ gitDir) {
  const cfg = await plainBytes(path.join(gitDir, 'config'), CONFIG_MAX);
  if (!cfg) throw new Error(`${gitDir}/config is not a plain file of at most ${CONFIG_MAX} bytes`);
  return { config: sha256(cfg) };
}

// H2.4: commit sha, made in a ticket's clone (from: its pin), fetched into cwd: the tag repo's common dir (dirs none) or
// another clone (dirs: its pin; never trusted here: the objects land in cwd's own store). Only tbd fetches, never an
// agent. 1) sha checked in from with from's pin (its config tbd-made + hashed: upload-pack runs there, no hooks); 2) fetch
// by raw sha, protocol v2: index-pack re-hashes every object (planted content can't keep its name), fetch.fsckObjects
// refuses bad trees (`.git` entries); ref: also set it (+force); --no-write-fetch-head: no shared FETCH_HEAD (2 gates
// may fetch at once). tips: refs in cwd as --negotiation-tip, only those that exist (else every ref in cwd is a "have":
// thousands of refs/tb/* in a tag repo). alt: core.alternateRefsPrefixes for a fetch into a clone (lanes, H2.6). 3) the
// commit (or ref) is there. Throws (gitWhy: never git's raw words, S-H1); code PLANTED when a pin refused; code LOCK (C-L5)
// when the ref's lock file is left (a git killed mid-write): no integrity matter, named so Irfan can remove it.
async function fetchCommit(/** @type {{cwd: string, dirs?: any, from: any, sha: string, ref?: string, tips?: string[], alt?: string, signal?: AbortSignal}} */ o) {
  const { cwd, dirs, from, sha, ref, tips = [], alt, signal } = o;
  if (!SHA_RE.test(sha ?? '') || !path.isAbsolute(from?.git_dir ?? '')) throw new Error(`fetch: not a commit name or no source git dir: ${JSON.stringify(String(sha).slice(0, 80))}`);
  const into = dirs && { ...dirs, trusted: false };
  const fail = (/** @type {any} */ r, /** @type {string} */ what) => Object.assign(new Error(`${what}: ${r.err?.code === 'PLANTED' || r.masked ? r.stderr : gitWhy(r)}`), r.err?.code === 'PLANTED' ? { code: 'PLANTED' } : {});
  const src = await git(from.worktree, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { dirs: { ...from, trusted: false }, signal });
  if (src.err || src.stdout.trim() !== sha) throw fail(src, `fetch ${sha}: not a commit in ${from.worktree}`);
  const have = tips.length ? await git(cwd, ['for-each-ref', '--format=%(refname)', '--', ...tips], { dirs: into, signal }) : { err: null, stdout: '' };
  if (have.err) throw fail(have, `fetch ${sha}: for-each-ref in ${cwd}`);
  const neg = have.stdout.split('\n').filter(Boolean).map((r) => `--negotiation-tip=${r}`);
  const r = await git(cwd, ['-c', 'fetch.fsckObjects=true', '-c', 'protocol.version=2', ...(alt ? ['-c', `core.alternateRefsPrefixes=${alt}`] : []),
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', ...neg, '--', from.git_dir, ref ? `+${sha}:${ref}` : sha], { dirs: into, timeout: 120_000, signal });
  const lock = ref && path.join(dirs?.git_dir ?? cwd, `${ref}.lock`);
  if (r.err && lock && (await fsp.lstat(lock).then(() => true, () => false))) {
    throw Object.assign(new Error(`fetch ${sha}: ${lock} is left (a git killed mid-write?): remove it once no git runs in that repo, then Resume`), { code: 'LOCK' });
  }
  if (r.err) throw fail(r, `fetch ${sha} from ${from.git_dir}`);
  const v = await git(cwd, ref ? ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] : ['cat-file', '-e', `${sha}^{commit}`], { dirs: into, signal });
  if (v.err || (ref && v.stdout.trim() !== sha)) throw fail(v, `fetch ${sha}: not in ${cwd} after the fetch`);
}

// D-0152 (C1): a gate's head sha (t's clone HEAD) into the tag repo as refs/tb/<id>/head, so the gate reads it from the
// tag's objects only (trusted). Tips: the ticket's own head + base pins (a lane: its parent's; a lane has no base pin).
// A ticket from before H2 (no clone) shares the tag's objects: nothing to fetch. Throws as fetchCommit (code LOCK: infra).
async function fetchHead(/** @type {any} */ t, /** @type {string} */ sha, /** @type {AbortSignal | undefined} */ signal = undefined) {
  if (!t.clone) return;
  const p = t.lane_of?.id ?? t.id;
  await fetchCommit({ cwd: t.common_dir, from: t, sha, ref: `refs/tb/${t.id}/head`, tips: [`refs/tb/${p}/head`, `refs/tb/${p}/base`], signal });
}

// The env of every claude child: runs (lib/spawn.js adds the run's own vars) and doctor's checks of the same binary,
// so doctor checks exactly what runs get (spec §9). Allowlist (S2/S3, D-0024): a shell's basics, nothing else of
// whatever started tbd, so no API key, OAuth token, ANTHROPIC_* / CLAUDE* override, push credential, TB_* var or
// NODE_OPTIONS can reach a run. Login: the claude.ai keychain entry (needs HOME only).
const CLAUDE_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
const claudeEnv = (/** @type {Record<string, string | undefined>} */ env) => ({ ...pick(CLAUDE_ENV, env), DISABLE_AUTOUPDATER: '1' });

// src, a plain file (lstat; check(st) may refuse more), copied to a new dest at mode: doctor's pin (H7), approve's env
// files (P4b U9). O_NOFOLLOW + the same inode close the gap between the lstat and the open; 'wx' after the rm: never
// written through a planted file or link. At most the st.size bytes check saw are read: a file that grows meanwhile
// throws (dest removed), so a writer can't push the copy past the size check passed.
async function copyPlain(/** @type {string} */ src, /** @type {string} */ dest, /** @type {number} */ mode, check = (/** @type {import('node:fs').Stats} */ _st) => {}) {
  const st = await fsp.lstat(src);
  if (!st.isFile()) throw new Error(`${src} is not a plain file (symlinks are refused)`);
  check(st);
  const from = await fsp.open(src, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
  try {
    const opened = await from.stat();
    if (opened.ino !== st.ino || opened.dev !== st.dev) throw new Error(`${src} changed while it was being copied`);
    await fsp.rm(dest, { force: true });
    const to = await fsp.open(dest, 'wx', mode);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let size = 0;
      for (let n = 1; n > 0 && size <= st.size; size += n) { // one byte past st.size at most: enough to see growth
        n = (await from.read(buf, 0, Math.min(buf.length, st.size + 1 - size), null)).bytesRead;
        if (n) await to.writeFile(buf.subarray(0, n));
      }
      if (size > st.size) throw new Error(`${src} grew while it was being copied`);
      await to.chmod(mode);
    } catch (e) {
      await fsp.rm(dest, { force: true });
      throw e;
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

// Each line of a JSONL file tbd keeps (interventions.jsonl, work.jsonl) as a stream, never the whole file in RAM:
// fn(value, n) per non-empty line (n from 1; a torn line counts, value undefined); true stops. Not a plain file: none.
// pre (optional): a line without this substring is counted but not parsed (value undefined). M7: file may be an open
// FileHandle (left open for the caller: lib/health.js reads both metrics files from fds it opened first); from (> 0):
// read from that byte on, its first (cut) line skipped. Read in LINE_CHUNK pieces into one buffer, a line decoded at its
// \n (\r\n too) and handled before the next read (M7 HL4: readline's async lines kept V8's young space growing to 128 MB
// over 100 back-to-back health reads).
const LINE_CHUNK = 64 * 1024;
async function eachLine(/** @type {string | import('node:fs/promises').FileHandle} */ file, /** @type {(v: any, n: number) => any} */ fn, /** @type {string[]} */ pre = [], { from = 0 } = {}) {
  const own = typeof file === 'string';
  let fh;
  try {
    fh = own ? await fsp.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW) : file;
  } catch {
    return;
  }
  try {
    if (!(await fh.stat()).isFile()) return;
    const buf = Buffer.allocUnsafe(LINE_CHUNK);
    let n = 0;
    let cut = from > 0;
    const rest = []; // copies of a line's start the last chunks did not end: joined once, at its \n
    const line = (/** @type {string} */ l) => {
      if (cut) return void (cut = false);
      if (l.endsWith('\r')) l = l.slice(0, -1);
      if (!l) return false;
      let v;
      if (!pre.length || pre.some((x) => l.includes(x))) try { v = JSON.parse(l); } catch { /* torn */ }
      return fn(v, ++n);
    };
    for (let pos = from; ;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const b = buf.subarray(0, bytesRead);
      let s = 0;
      for (let e = b.indexOf(10); e !== -1; s = e + 1, e = b.indexOf(10, s)) { // \n never sits inside a UTF-8 sequence
        const l = rest.length ? Buffer.concat([...rest.splice(0), b.subarray(s, e)]).toString('utf8') : b.toString('utf8', s, e);
        if (line(l)) return;
      }
      if (s < b.length) rest.push(Buffer.from(b.subarray(s))); // a copy: buf is read into again
    }
    if (rest.length) line(Buffer.concat(rest).toString('utf8'));
  } finally {
    if (own) await fh.close();
  }
}

// A line that may name a URL with credentials: all of the userinfo masked, :// up to the last @ of the word (a / or @ in
// the password too; an @ in a path masks the host as well: more, never less). push.js clean, lib/health.js doctor text.
const maskCreds = (/** @type {string} */ s) => s.replace(/:\/\/\S*@/g, '://***@');

// A small file tbd keeps, as text: opened O_NOFOLLOW, checked on the open fd (fstat: a plain file ≤ max bytes), so a
// link, or a swap after a check, is never read through. Else null. plainBytes: the same, as bytes (a hash of what git reads).
async function plainBytes(/** @type {string} */ file, /** @type {number} */ max) {
  let fh;
  try {
    fh = await fsp.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
    const st = await fh.stat();
    return st.isFile() && st.size <= max ? await fh.readFile() : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
async function readPlain(/** @type {string} */ file, /** @type {number} */ max) {
  return (await plainBytes(file, max))?.toString('utf8') ?? null;
}

// A tag's env_files KEY=value lines → [key, value] pairs, read from the tag's own files (readPlain: a plain file, no link
// followed, ≤ ENV_MAX). A file it can't read so is skipped (the gates' redaction), or with strict an error (dbLocal: fail
// closed). Gates redact the values (lib/gates/run.js), the recorder too (lib/recorder.js); dbLocal reads them.
const ENV_MAX = 64 * 1024;
async function envPairs(/** @type {any} */ tag, strict = false) {
  const out = [];
  for (const f of tag?.env_files ?? []) {
    const text = await readPlain(path.join(tag.path, f), ENV_MAX);
    if (text === null) {
      if (strict) throw new Error(`env file ${JSON.stringify(f)}: not a plain file of at most ${ENV_MAX} bytes`);
      continue;
    }
    // dotenv's forms: KEY=v, KEY: v, export KEY=v; a '…', "…" or `…` value runs to its closing quote, else to a ` #`
    // comment. Each regex is linear on a long line (no `\s*` before an optional tail).
    for (const line of text.split(/\r\n?|\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/s.exec(line);
      if (!m) continue;
      const q = /^(["'`])(.*?)\1\s*(?:#.*)?$/s.exec(m[2]);
      out.push([m[1], q ? q[2] : m[2].replace(/(?:^|\s)#.*$/s, '').trim()]);
    }
  }
  return out;
}

// D-0102: the env_files values that count as secret: a SECRET-named key's value of 4+ characters, and any value of 8+
// that is not all digits (PORT=3000 stays readable). Longest first: a redaction replaces the longer one first. push's
// temp denylist (D-0108) reads them strict (fail closed); recorder.js:202 still has its own copy of the filter.
const SECRET_KEY = /auth|cookie|token|secret|key|session|pass|pwd|credential/i; // pass: passwd, password too
async function envSecrets(/** @type {any} */ tag, strict = false) {
  return (await envPairs(tag, strict)).filter(([k, v]) => (SECRET_KEY.test(k) && v.length >= 4) || (v.length >= 8 && !/^\d+$/.test(v)))
    .map(([, v]) => v).sort((a, b) => b.length - a.length);
}

// H3 (D-0151, D-0153): the env_files values that BLOCK (push's temp denylist, the final summary), narrower than the
// redaction set above (no false alarms on NODE_ENV=development): a SECRET-named key's value of 4+ chars that is not a
// boolean word, not all digits and not a URL with no userinfo and no query (S-L2: a token as the user name or in
// ?token= blocks); and, under any key, the password of every URL in a value (WHATWG: userinfo ends at the last @), raw
// and percent-decoded when that differs, 4+ chars; a URL WHATWG cannot parse (a raw / # ? in the password): the regex's
// password (S-L2). Always strict (an unreadable env file throws: fail closed). Longest first.
const URL_RE = /[a-z][a-z0-9+.-]*:\/\//gi;
const urlAt = (/** @type {string} */ v) => { try { return new URL(v); } catch { return null; } };
async function envBlock(/** @type {any} */ tag) {
  const out = new Set();
  for (const [k, v] of await envPairs(tag, true)) {
    const whole = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? urlAt(v) : null;
    if (SECRET_KEY.test(k) && v.length >= 4 && !/^(true|false|yes|no|on|off)$/i.test(v) && !/^\d+$/.test(v) && !(whole && !whole.username && !whole.password && !whole.search)) out.add(v);
    for (const x of v.matchAll(URL_RE)) {
      const at = v.slice(x.index);
      const u = urlAt(at);
      const pw = u ? u.password : /^[a-z][\w+.-]*:\/\/[^/@\s]*:(.+)@/i.exec(at)?.[1] ?? '';
      let dec = pw;
      try { dec = decodeURIComponent(pw); } catch { /* a bad % escape: the raw form only */ }
      for (const p of [pw, dec]) if (p.length >= 4) out.add(p);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// M5 C7 (D-0087) DB guard: every postgres URL in the tag's env files names this Mac (host localhost / 127.0.0.1 / ::1,
// no host= or hostaddr= param), and PGHOST / PGHOSTADDR, if set (empty = unset, as libpq reads it), too. A URL is any
// postgres[ql][+driver]:// anywhere in a value, read from there to the value's end. A service (service= param, PGSERVICE,
// PGSERVICEFILE: pg_service.conf may name any host) fails it (D-0096). An env file it can't read or a postgres URL that
// does not parse fails it (fail closed). → {ok: true} | {ok: false, why}
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];
const PG_RE = /postgres(?:ql)?(?:\+[\w-]+)?:\/\//gi;
async function dbLocal(/** @type {any} */ tag) {
  let pairs;
  try {
    pairs = await envPairs(tag, true);
  } catch (e) {
    return { ok: false, why: e.message };
  }
  for (const [k, v] of pairs) {
    if ((k === 'PGHOST' || k === 'PGHOSTADDR') && v && !LOOPBACK.includes(v.toLowerCase())) return { ok: false, why: `${k} is not localhost, 127.0.0.1 or ::1` };
    if (k === 'PGSERVICE' || k === 'PGSERVICEFILE') return { ok: false, why: `${k}: a pg service may name any host` };
    for (const x of v.matchAll(PG_RE)) {
      // URL() ends the host at # or ?, libpq reads on to the first @ or / (`localhost#@db.example.com` is that host)
      if (/#|\?.*@/s.test(v.slice(x.index + x[0].length).split('/')[0])) return { ok: false, why: `${k}: libpq reads another host` };
      let u;
      try {
        u = new URL(v.slice(x.index));
      } catch {
        return { ok: false, why: `${k}: a postgres URL that does not parse` };
      }
      if (!LOOPBACK.includes(u.hostname.toLowerCase())) return { ok: false, why: `${k}: postgres host is not localhost, 127.0.0.1 or [::1]` };
      if ([...u.searchParams.keys()].some((y) => /^\s*(host|hostaddr|service)\s*$/i.test(y))) return { ok: false, why: `${k}: a host=, hostaddr= or service= param` };
    }
  }
  return { ok: true };
}

// D34 (D-0013): no commit tbd makes or takes names Claude as co-author or generator. d34(text) → the first line (trimmed,
// ≤ 200 chars) with `co-authored-by:` and then claude or anthropic on it, or with `generated with`, any case; else null.
// Linear: indexOf on a lower-cased line (the regex form went quadratic: 576 KB → 10 s). Here, not in lib/gates: final.js
// and push.js check messages outside a gate (RAM rule); gates/tests.js trailers() uses it per commit message.
const AI = ['claude', 'anthropic'];
function d34(/** @type {string} */ text) {
  for (const line of text.split('\n')) {
    const l = line.toLowerCase();
    const i = l.indexOf('co-authored-by:');
    if (l.includes('generated with') || (i >= 0 && AI.some((w) => l.includes(w, i)))) return line.trim().slice(0, 200);
  }
  return null;
}

// M5 C12 step 3 (A22): the ident a squash of t is made with → {name, email, from: 'tag' | 'commit'} | {error}. The tag's
// `ident` (Irfan's); a push tag without one → error (what ships must be his); else the author of fallbackSha (the
// tested commit: stays local). Either way a git ident (tags.isIdent) naming neither Claude nor Anthropic (D34), else
// error. tag: the ticket's tag def (default: the store's; loaded here, not at the top: store requires util).
async function ident(/** @type {any} */ t, /** @type {string} */ fallbackSha, /** @type {any} */ tag = require('./store').listTags()[t.tag], /** @type {AbortSignal | undefined} */ signal = undefined) {
  const { isIdent } = require('./tags');
  let id;
  if (tag?.ident) id = { name: tag.ident.name, email: tag.ident.email, from: 'tag' };
  else if (tag?.push) return { error: `ident not set: run tb doctor --tag ${t.tag} --ident` };
  else {
    if (!SHA_RE.test(fallbackSha ?? '') || !t.worktree) return { error: 'no tested commit to take the ident from' };
    const r = await git(t.worktree, ['log', '-1', '--format=%an%x00%ae', fallbackSha], { dirs: t, signal }); // signal: a lane merge's job (M5.5)
    if (r.err) return { error: `git log failed: ${String(r.stderr).trim().slice(0, 200)}` };
    const [name, email = ''] = r.stdout.replace(/\n$/, '').split('\0');
    id = { name, email, from: 'commit' };
  }
  if (!isIdent({ name: id.name, email: id.email })) return { error: `the ${id.from} ident is no git name + email (1-100 chars, no control chars or < >; one plain address ≤ 200)` };
  if (AI.some((w) => `${id.name}\n${id.email}`.toLowerCase().includes(w))) return { error: `the ${id.from} ident names Claude or Anthropic (D34)` };
  return id;
}

// M5.4 C18: the pinned lavish install (package.json pin + node_modules). TB_LAVISH_DIR (absolute only) = tests' fake
// install; anything else in it is ignored, never a relative path resolved against tbd's cwd.
const LAVISH_DIR = path.join(__dirname, '..', 'tools', 'lavish');
const lavishDir = (env = process.env) => (path.isAbsolute(env.TB_LAVISH_DIR ?? '') ? env.TB_LAVISH_DIR : LAVISH_DIR);

module.exports = { lavishDir, eachLine, maskCreds, readPlain, isObj, within, isFile, ROUND_RE, SHA_RE, minimalEnv, GIT, GIT_SAFE, GIT_ENV, git, cloneAt, cloneConfig, fetchCommit, fetchHead, claudeEnv, DEFAULT_PIN, copyPlain, envPairs, envSecrets, envBlock, SECRET_KEY, dbLocal, d34, ident };
