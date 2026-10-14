'use strict';
// util: helpers shared by more than one module.
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
const DEFAULT_PIN = '2.1.295';

// What a child process gets when it may run repo code: a shell's basics and nothing else (H8).
const MINIMAL_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const pick = (/** @type {string[]} */ keys, /** @type {Record<string, string | undefined>} */ env) =>
  Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const minimalEnv = (/** @type {Record<string, string | undefined>} */ env) => pick(MINIMAL_ENV, env);

// git in a repo or worktree an agent could have written to: its config must never run code in tbd (H11).
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']; // before -C / --git-dir
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
async function commonOf(/** @type {string} */ gitDir) {
  const f = path.join(gitDir, 'commondir');
  if (!(await fsp.lstat(f).then((st) => st.isFile(), () => false))) return null; // a link is never followed
  // git strips only the trailing newline (`../.. ` with a space is another dir): never trim more than git does. No
  // path.resolve: it folds `..` before links are followed, git follows them first (`L/../../..` with L a link)
  const d = (await fsp.readFile(f, 'utf8')).replace(/[\r\n]+$/, '');
  return fsp.realpath(path.isAbsolute(d) ? d : `${gitDir}/${d}`).catch(() => null);
}
async function git(/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{timeout?: number, input?: string, maxBuffer?: number, dirs?: any, env?: Record<string, string | undefined>, add?: Record<string, string>, system?: boolean, ceiling?: string, exec?: Function}} */ o = {}) {
  const { timeout = 20_000, input, maxBuffer, dirs, env = process.env, add, system = false, ceiling, exec = sh } = o;
  const pin = dirs?.git_dir ? { GIT_DIR: dirs.git_dir, GIT_COMMON_DIR: dirs.common_dir, GIT_WORK_TREE: cwd, GIT_NO_LAZY_FETCH: '1' } : {};
  if (dirs?.git_dir) {
    const cd = await commonOf(dirs.git_dir);
    if (cd !== dirs.common_dir) {
      const msg = `${dirs.git_dir}/commondir leads to ${cd ?? '(not a plain file)'}, not ${dirs.common_dir}: git refused in ${cwd}`;
      return { err: Object.assign(new Error(msg), { code: 'PLANTED' }), stdout: '', stderr: msg }; // runner: Blocked at once, not crash retries
    }
  }
  return exec(GIT, [...GIT_SAFE, '-C', cwd, ...args], {
    env: { ...minimalEnv(env), ...add, ...(system ? GIT_SYSTEM_ENV : GIT_ENV), ...pin, ...(ceiling && { GIT_CEILING_DIRECTORIES: ceiling }) },
    timeout, ...(input !== undefined && { input }), ...(maxBuffer && { maxBuffer }),
  });
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
// pre (optional): a line without this substring is counted but not parsed (value undefined).
async function eachLine(/** @type {string} */ file, /** @type {(v: any, n: number) => any} */ fn, /** @type {string[]} */ pre = []) {
  let fh;
  try {
    fh = await fsp.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
  } catch {
    return;
  }
  const input = fh.createReadStream({ encoding: 'utf8', autoClose: false });
  try {
    if (!(await fh.stat()).isFile()) return;
    let n = 0;
    for await (const line of require('node:readline').createInterface({ input, crlfDelay: Infinity })) { // lazy: ~0.55 MB, not at boot
      if (!line) continue;
      let v;
      if (!pre.length || pre.some((x) => line.includes(x))) try { v = JSON.parse(line); } catch { /* torn */ }
      if (fn(v, ++n)) break;
    }
  } finally {
    input.destroy();
    await fh.close();
  }
}

// A small file tbd keeps, as text: opened O_NOFOLLOW, checked on the open fd (fstat: a plain file ≤ max bytes), so a
// link, or a swap after a check, is never read through. Else null.
async function readPlain(/** @type {string} */ file, /** @type {number} */ max) {
  let fh;
  try {
    fh = await fsp.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
    const st = await fh.stat();
    return st.isFile() && st.size <= max ? await fh.readFile('utf8') : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
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
async function ident(/** @type {any} */ t, /** @type {string} */ fallbackSha, /** @type {any} */ tag = require('./store').listTags()[t.tag]) {
  const { isIdent } = require('./tags');
  let id;
  if (tag?.ident) id = { name: tag.ident.name, email: tag.ident.email, from: 'tag' };
  else if (tag?.push) return { error: `ident not set: run tb doctor --tag ${t.tag} --ident` };
  else {
    if (!SHA_RE.test(fallbackSha ?? '') || !t.worktree) return { error: 'no tested commit to take the ident from' };
    const r = await git(t.worktree, ['log', '-1', '--format=%an%x00%ae', fallbackSha], { dirs: t });
    if (r.err) return { error: `git log failed: ${String(r.stderr).trim().slice(0, 200)}` };
    const [name, email = ''] = r.stdout.replace(/\n$/, '').split('\0');
    id = { name, email, from: 'commit' };
  }
  if (!isIdent({ name: id.name, email: id.email })) return { error: `the ${id.from} ident is no git name + email (1-100 chars, no control chars or < >; one plain address ≤ 200)` };
  if (AI.some((w) => `${id.name}\n${id.email}`.toLowerCase().includes(w))) return { error: `the ${id.from} ident names Claude or Anthropic (D34)` };
  return id;
}

module.exports = { eachLine, readPlain, isObj, within, isFile, ROUND_RE, SHA_RE, minimalEnv, GIT, GIT_SAFE, GIT_ENV, git, claudeEnv, DEFAULT_PIN, copyPlain, envPairs, envSecrets, dbLocal, d34, ident };
