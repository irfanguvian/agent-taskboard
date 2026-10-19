'use strict';
// task: Task tickets (board-terminal-parity Phase 4, .omc/handoffs/btp-p4-contract.md). A Task works in Irfan's real
// folder (the tag's path, realpath), like his terminal: ONE session from planning (reads only, the folder write-denied)
// over plan_approval to working (edits, left uncommitted), then it waits for him (waiting you: summary, done-when, commit
// message, the files to commit). Send, Commit and Push (lib/task-actions.js) and request-changes resume the same session
// (t.continue.why picks the prompt, lib/recovery.js continuePrompt). tbd.js requires it at boot: it registers
// task/planning + task/working. planning / spawn / recovery are required lazily (they require each other and this).
// Safety (S1 for a real folder): the start point (baseline, when the Task first holds the folder) records HEAD, refs (a
// sidecar task-refs.json), the hooks dir, Claude config hashes, the index's Claude config, hidden-flag files and the
// files already uncommitted; check() compares before every run, before a push and on Done, and a risky change Blocks
// (block: waiting task_changed + the undo steps). One Task per folder at a time (holds: its parents and subfolders too).
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');
const fsm = require('./fsm');
const phases = require('./phases');
const sh = require('./sh');
const { TbError } = require('./errors');
const { git, within, realConfig, realHash, readPlain, cloneRefused, SHA_RE } = require('./util');
const { WALL_WRITE, WALL_NO_WRITE, globRe } = require('./phase-settings');

const FREE = ['backlog', 'done', 'cancelled']; // a ticket in these holds no folder
const REFS_MAX = 20_000; // the refs sidecar
const PLANTED_MAX = 200; // planted map entries kept (more: the hash only)
const FLAGS_MAX = 200; // hidden-flag files at the start (more: Blocked)
const DIRTY_MAX = 500; // dirty_paths / files / left
const MOVED_MAX = 20; // changed refs checked one by one
const NAMES = 10; // names per reason
const SUMMARY_MAX = 4096;
const COMMIT_MAX = 2000;
const WHY_MAX = 2000; // waiting.why
// a credential in .git/config (key or value: url.<base>.insteadOf carries it in the key): any userinfo on http(s), a
// user:password@ on any scheme. Not spawn's CRED_URL: that one refuses the plain ssh://git@host form too
const CRED = /https?:\/\/[^/\s]*@|:\/\/[^/\s@:]+:[^/\s@]*@/i;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// tbgit.js branchOk (a CLI module, not required into tbd): a plain branch name tbd may name in a prompt or a push
const branchOk = (/** @type {string} */ b) => /^[\w./-]{1,200}$/.test(b) && !/^[-./]|[./]$|\.\.|\/\/|\/\.|\.lock(\/|$)/.test(b) && b !== 'HEAD';
const REL = /^(?!\/)[^\0\n"`$\\()*?[\]]+$/; // a hooks dir phase-settings can name in a rule
const iso = () => new Date().toISOString();
const sha256 = (/** @type {string | Buffer} */ x) => crypto.createHash('sha256').update(x).digest('hex');
const home = () => process.env.HOME || os.homedir();
const list = (/** @type {string[]} */ xs) => `${xs.slice(0, NAMES).join(', ')}${xs.length > NAMES ? ` (+${xs.length - NAMES} more)` : ''}`;
const tilde = (/** @type {string} */ p) => (p === '~' || p.startsWith('~/') ? path.join(home(), p.slice(1)) : p);
// Claude config + the hooks dir as git pathspecs (index hash, risky-commits scan, moved-ref diff)
const specs = (/** @type {string | null | undefined} */ hooks) => [':(glob,icase)**/.claude/**', ':(glob,icase)**/.claude', ':(glob,icase)**/CLAUDE.md', ':(glob,icase)**/CLAUDE.local.md',
  ':(glob,icase)**/.mcp.json', ':(glob,icase)**/AGENTS.md', ...(hooks ? [`:(literal)${hooks}`] : [])];
// git in the Task's folder, pinned (util.git real mode: the config pin is checked first, GIT_SAFE: no hooks, no fsmonitor)
const pinned = (/** @type {any} */ t, /** @type {string[]} */ args, o = {}) => git(t.worktree, args, { dirs: t, timeout: 30_000, maxBuffer: 64 << 20, ...o });
const failed = (/** @type {any} */ r, /** @type {string} */ what) => `git ${what} failed (${String(r.stderr || r.err?.message || '').trim().split('\n').pop()?.slice(0, 150)}): look at the folder, then Cancel`;
const refsFile = (/** @type {string} */ id) => path.join(store.ticketDir(id), 'task-refs.json');

// What Irfan's terminal sees for one key in his folder (hooksPath, includes, excludesFile, identity): his git with HOME
// and a plain PATH only, global config on, no GIT_SAFE (its -c core.hooksPath=/dev/null would answer the read). Reading
// config runs nothing. regexp: --show-origin --get-regexp → [[origin file, "key value"]]. → the value, '' = unset.
async function terminalConfig(/** @type {string} */ real, /** @type {string} */ key, regexp = false) {
  const r = await sh('/usr/bin/git', ['-C', real, 'config', '-z', ...(regexp ? ['--show-origin', '--get-regexp'] : ['--get']), key],
    { env: { HOME: home(), PATH: '/usr/bin:/bin' }, timeout: 20_000 });
  if (r.err) return regexp ? [] : '';
  if (!regexp) return r.stdout.replace(/\0$/, '');
  const parts = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i].replace(/^file:/, ''), parts[i + 1]]);
  return out;
}

// A: who commits: the tag's ident, else the identity Irfan's terminal uses in that folder (repo-local and includeIf
// win, as there). One line each, ≤ 200 chars. → {name, email} | null (then no env and Commit and Push is off).
async function identity(/** @type {any} */ t, /** @type {any} */ tag) {
  const ok = (/** @type {unknown} */ v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200 && !/[\0\n\r]/.test(v);
  if (ok(tag?.ident?.name) && ok(tag?.ident?.email)) return { name: tag.ident.name, email: tag.ident.email };
  const real = t.task?.real ?? t.worktree;
  if (typeof real !== 'string' || !path.isAbsolute(real)) return null;
  const [name, email] = await Promise.all([terminalConfig(real, 'user.name'), terminalConfig(real, 'user.email')]);
  return ok(name) && ok(email) ? { name: String(name), email: String(email) } : null;
}

// A path the full-access wall lets the agent write (WALL_WRITE minus WALL_NO_WRITE), ~ and /tmp as the seatbelt sees them
function wallWritable(/** @type {string} */ p) {
  const real = (/** @type {string} */ x) => tilde(x).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1');
  const hit = (/** @type {string} */ g) => new RegExp(globRe(real(g))).test(real(p));
  return WALL_WRITE.some(hit) && !WALL_NO_WRITE.some(hit);
}

// Lock (finding 15, round 2 MED 5): t holds its folder when it is the oldest open Task ([task.since, id]) on that folder,
// a folder inside it or around it, and no open code ticket's repo (dirname of its common_dir) lies there either way
// (those trust this repo's objects and refs/tb/*). ponytail: O(n) scan per tick, as runner holdsQa.
function holds(/** @type {any} */ t) {
  const me = t.task?.real;
  if (typeof me !== 'string') return false;
  const near = (/** @type {unknown} */ r) => typeof r === 'string' && (within(r, me) || within(me, r));
  const older = (/** @type {any} */ k) => (k.task?.since ?? '') < (t.task.since ?? '') || ((k.task?.since ?? '') === (t.task.since ?? '') && k.id < t.id);
  return !store.listTickets().some((k) => k.id !== t.id && !FREE.includes(k.state)
    && (k.kind === 'task' ? near(k.task?.real) && older(k)
      : typeof k.common_dir === 'string' && path.isAbsolute(k.common_dir) && near(path.dirname(k.common_dir))));
}

// D: the open Task on this folder, a folder inside it or around it (code assign refuses then). realpath first (a tag
// path through a link). → the ticket | null
async function holderAt(/** @type {string} */ p) {
  const real = await fsp.realpath(p).catch(() => p);
  return store.listTickets().find((k) => k.kind === 'task' && !FREE.includes(k.state) && typeof k.task?.real === 'string'
    && (within(real, k.task.real) || within(k.task.real, real))) ?? null;
}

// Assign: the folder checked → {worktree, task: {real, since}} (planning.assign writes it with the move). TbError 409:
// switch off, not a dir, a refused root, a git tag whose .git is not a real dir (a linked worktree: Q6), a token in
// .git/config (the agent can read it).
async function assignPatch(/** @type {any} */ t, /** @type {any} */ tag) {
  if (store.config.terminal?.task_tickets !== true) throw new TbError(409, `${t.id}: Task tickets are off (terminal.task_tickets)`);
  const real = await fsp.realpath(String(tag?.path ?? '')).catch(() => null);
  if (!real || !(await fsp.stat(real).then((s) => s.isDirectory(), () => false))) throw new TbError(409, `${t.id}: ${tag?.path} is not a folder`);
  if (await require('./page-tools').refused(real)) throw new TbError(409, `${t.id}: ${real} is a refused root (your home, /, ~/.claude or a board folder): pick a project folder`);
  // security review MED 5: a Task has no other wall than the seatbelt's (its planning is read-only by it)
  if (store.config.full_access_wall !== true) throw new TbError(409, `${t.id}: a Task needs the full-access wall on (full_access_wall)`);
  // security review HIGH 1: a bare repo the agent plants in a subfolder (HEAD, objects, refs, a config with core.fsmonitor)
  // runs code as you when your prompt or editor runs git there; git ignores such a folder only with this setting
  if ((await terminalConfig(real, 'safe.bareRepository')) !== 'explicit') throw new TbError(409, `${t.id}: first run in your terminal: git config --global safe.bareRepository explicit (a bare repo the agent planted in a subfolder would otherwise run code as you)`);
  if (tag.type === 'git') {
    const g = path.join(real, '.git');
    if (!(await fsp.lstat(g).then((s) => s.isDirectory(), () => false))) throw new TbError(409, `${t.id}: ${g} is not a real folder (a linked worktree or a link): use a Code ticket`);
    const cfg = await realConfig(g);
    if (!cfg) throw new TbError(409, `${t.id}: ${g}/config is not a plain readable file`);
    if (cfg.some((e) => CRED.test(e) || /^http\..*\.extraheader\n/i.test(e))) throw new TbError(409, `${t.id}: a token in ${g}/config would be readable by the agent: move it to your credential helper`);
  }
  return { worktree: real, task: { real, since: iso() } };
}

// sha256 of what sits at p (lstat, never followed): a file's bytes, a link's target, a dir's sorted entries with their
// own hashes (bounded depth; claude's .cc-writes staging under the root .claude left out). 'gone' when missing.
async function hashPath(/** @type {string} */ p, /** @type {string} */ rel, depth = 0) {
  const st = await fsp.lstat(p).catch(() => null);
  if (!st) return 'gone';
  if (st.isSymbolicLink()) return sha256(`link:${await fsp.readlink(p).catch(() => '')}`);
  if (st.isFile()) return sha256(await fsp.readFile(p));
  if (!st.isDirectory() || depth > 8) return sha256(`other:${st.mode}:${st.size}`);
  const names = (await fsp.readdir(p)).filter((n) => !(rel === '.claude' && n === '.cc-writes')).sort();
  return sha256(JSON.stringify(await Promise.all(names.map(async (n) => [n, await hashPath(path.join(p, n), `${rel}/${n}`, depth + 1)]))));
}

// The planted map now: Claude config paths that differ from base_sha (spawn.worktreeConfig; a plain folder: every one,
// spawn.configPaths all) + the hooks dir → {[rel]: sha256}
async function plantedNow(/** @type {any} */ t, /** @type {string | null | undefined} */ hooks) {
  const spawn = require('./spawn');
  const paths = t.git_dir ? (await spawn.worktreeConfig(t, t.worktree)).paths : await spawn.configPaths(t.worktree, '', true);
  if (hooks) paths.push(hooks);
  const uniq = [...new Set(paths)].sort();
  const hashes = await Promise.all(uniq.map((p) => hashPath(path.join(t.worktree, p), p)));
  return Object.fromEntries(uniq.map((p, i) => [p, hashes[i]]));
}
const mapHash = (/** @type {Record<string, string>} */ m) => sha256(JSON.stringify(Object.entries(m)));

// refs/ minus refs/tb/ → {refname: sha} | {why}
async function refsOf(/** @type {any} */ t) {
  const r = await pinned(t, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/']);
  if (r.err) return { why: failed(r, 'for-each-ref') };
  const refs = /** @type {Record<string, string>} */ ({});
  for (const l of r.stdout.split('\n')) {
    const [name, sha] = l.split('\0');
    if (name && !name.startsWith('refs/tb/')) refs[name] = sha;
  }
  return Object.keys(refs).length > REFS_MAX ? { why: `more than ${REFS_MAX} refs: too many for a Task: use a Code ticket` } : { refs };
}

// The index's Claude config (+ hooks) entries → sha256 | {why}
async function indexHash(/** @type {any} */ t, /** @type {string | null | undefined} */ hooks) {
  const r = await pinned(t, ['ls-files', '-s', '-z', '--', ...specs(hooks)]);
  return r.err ? { why: failed(r, 'ls-files') } : sha256(r.stdout);
}

// The start point (Q1: when the Task first holds the folder) → {patch, refs?: text for task-refs.json} | {reasons}.
// patch = the pin fields + task.base (section 3). Git all pinned through the real mode (util.git).
async function baseline(/** @type {any} */ t) {
  const spawn = require('./spawn');
  const real = t.worktree;
  const tag = store.listTags()[t.tag];
  const at = iso();
  if (tag?.type !== 'git') {
    const planted = await plantedNow({ ...t, git_dir: undefined }, null);
    const n = Object.keys(planted).length;
    return { patch: {}, base: { at, planted: n > PLANTED_MAX ? null : planted, planted_hash: mapHash(planted), dirty: null, dirty_paths: null, flags: [] } };
  }
  const g = path.join(real, '.git');
  const cfg = await realConfig(g);
  if (!cfg) return { reasons: [`${g}/config is not a plain readable file`] };
  const pin = { git_dir: g, common_dir: g, clone: { real: true, config: realHash(cfg), alternates: await readPlain(path.join(g, 'objects', 'info', 'alternates'), 4096) } };
  const reasons = [];
  // finding 9: an include the agent can write would feed tbd's own git and Irfan's terminal
  for (const [origin, kv] of /** @type {string[][]} */ (await terminalConfig(real, '^include(if\\..*)?\\.path$', true))) {
    const v = tilde(kv.slice(kv.indexOf('\n') + 1));
    const p = path.resolve(path.dirname(origin), v);
    if (within(p, real) || wallWritable(p)) reasons.push(`your git config includes ${p}, a file the agent can write: move it out of the folder`);
  }
  const t2 = { ...t, ...pin };
  const [head, sym] = await Promise.all([pinned(t2, ['rev-parse', '--verify', 'HEAD']), pinned(t2, ['symbolic-ref', '-q', 'HEAD'])]);
  const base_sha = head.stdout.trim();
  if (head.err || !SHA_RE.test(base_sha)) return { reasons: [...reasons, `no commit at HEAD (${failed(head, 'rev-parse')})`] };
  t2.base_sha = base_sha;
  const head_ref = sym.err ? null : sym.stdout.trim() || null;
  // findings 8, 9: hooksPath as the terminal sees it; kept only inside the folder (husky v9 .husky/_ → .husky)
  let hooks = null;
  const hp = String(await terminalConfig(real, 'core.hooksPath'));
  if (hp) {
    const abs = path.resolve(real, tilde(hp));
    if (within(abs, real) && !hp.split('/').includes('..')) {
      const h = path.relative(real, path.basename(abs) === '_' ? path.dirname(abs) : abs);
      if (!h || !REL.test(h)) reasons.push(`your hooks folder ${abs} is one the agent can write`);
      else hooks = h;
    } else if (wallWritable(abs)) reasons.push(`your hooks folder ${abs} is one the agent can write`);
  }
  const excludes = tilde(String(await terminalConfig(real, 'core.excludesFile')));
  const [refs, planted, index, dirty] = await Promise.all([refsOf(t2), plantedNow(t2, hooks).catch((e) => ({ why: `Claude config check failed: ${e.message}` })),
    indexHash(t2, hooks), spawn.dirtyPaths(t2, process.env, { excludes }).catch((/** @type {any} */ e) => ({ why: `git status failed: ${e.message}` }))]);
  for (const x of [refs, planted, index, dirty]) if (x?.why) reasons.push(x.why);
  if (reasons.length) return { reasons };
  const lines = /** @type {string[]} */ (dirty);
  const flags = lines.filter((l) => /^(S|[a-z]) {2}/.test(l)).map((l) => l.slice(3));
  const paths = lines.filter((l) => !/^(S|[a-z]) {2}/.test(l)).map((l) => l.slice(3));
  if (flags.length > FLAGS_MAX) return { reasons: [`more than ${FLAGS_MAX} files hidden from git status (sparse checkout?): use a Code ticket`] };
  const text = JSON.stringify(/** @type {any} */ (refs).refs) + '\n';
  const pm = /** @type {Record<string, string>} */ (planted);
  return {
    refs: text,
    patch: { base_sha, ...pin },
    base: { at, head_ref, refs_sha256: sha256(text), hooks, planted: Object.keys(pm).length > PLANTED_MAX ? null : pm, planted_hash: mapHash(pm),
      index, flags, dirty_paths: paths.length > DIRTY_MAX ? null : paths, dirty: paths.length },
  };
}

// S1 for a Task (section 4 item 3): what changed since the start point that could plant Claude config or run code as
// Irfan → reasons (plain words, each with its undo step; [] = clean). Any git failure is a reason (fail closed).
async function check(/** @type {any} */ t) {
  const b = t.task?.base;
  if (!b || typeof t.worktree !== 'string') return ['no start point: the Task never recorded one'];
  const out = [];
  if (t.git_dir) {
    const pin = await cloneRefused(t); // 1
    if (pin) return [`${pin}: undo: put it back as it was`];
    const own = `refs/heads/tb/${t.id}`;
    const short = (/** @type {string} */ r) => r.replace(/^refs\/heads\//, '');
    const [sym, head] = await Promise.all([pinned(t, ['symbolic-ref', '-q', 'HEAD']), pinned(t, ['rev-parse', '--verify', 'HEAD'])]);
    if (head.err) return [...out, failed(head, 'rev-parse')]; // review LOW: fail closed
    const cur = sym.err ? null : sym.stdout.trim(); // 2
    if (cur !== own && (b.head_ref ? cur !== b.head_ref : cur !== null)) {
      out.push(`HEAD moved to ${cur ? short(cur) : 'a detached commit'}: undo: git switch ${b.head_ref ? short(b.head_ref) : `--detach ${t.base_sha}`}`);
    }
    // 3 refs: the sidecar first (its hash in the ticket), then one for-each-ref
    const text = await readPlain(refsFile(t.id), 64 << 20);
    if (text === null || sha256(text) !== b.refs_sha256) return [...out, 'the start refs record changed or is gone: Cancel and start a new Task'];
    const was = /** @type {Record<string, string>} */ (JSON.parse(text));
    const now = await refsOf(t);
    if (now.why) return [...out, now.why];
    const refs = /** @type {Record<string, string>} */ (now.refs);
    const mine = new Set([own, ...(b.head_ref ? [b.head_ref] : [])]);
    const gone = Object.keys(was).filter((r) => r.startsWith('refs/heads/') && !mine.has(r) && !Object.hasOwn(refs, r));
    for (const r of gone.slice(0, NAMES)) out.push(`deleted ${r}: undo: git update-ref ${r} ${was[r]}`);
    const changed = Object.keys(refs).filter((r) => was[r] !== refs[r]);
    const replace = [...new Set([...changed, ...Object.keys(was).filter((r) => !Object.hasOwn(refs, r))])].filter((r) => r.startsWith('refs/replace/'));
    if (replace.length) out.push(`replace refs changed: ${list(replace)}: undo: git update-ref -d <ref> (or put back the old sha)`);
    const headSha = head.err ? '' : head.stdout.trim();
    const moved = [...changed.map((r) => [r, refs[r]]), ...(headSha && headSha !== t.base_sha ? [['HEAD', headSha]] : [])];
    const undo = (/** @type {string} */ r) => (r === 'HEAD' ? `git reset --hard ${t.base_sha} (keeps no change: look first)` : was[r] ? `git update-ref ${r} ${was[r]}` : `git update-ref -d ${r}`);
    if (moved.length) {
      const stops = [...new Set([...Object.values(was), t.base_sha])].map((s) => `^${s}`);
      const scan = async (/** @type {string[]} */ shas) => {
        const r = await pinned(t, ['log', '--no-renames', '--diff-merges=first-parent', '--format=', '--name-only', '-z', '--stdin', '--', ...specs(b.hooks)], { input: [...shas, ...stops].join('\n') + '\n' });
        return r.err ? { why: failed(r, 'log') } : { paths: [...new Set(r.stdout.split('\0').map((x) => x.trim()).filter(Boolean))] };
      };
      const groups = moved.length <= MOVED_MAX ? moved.map(([r, s]) => [r, [s]]) : [['the changed refs', moved.map(([, s]) => s)]];
      for (const [r, shas] of groups) {
        const s = await scan(/** @type {string[]} */ (shas));
        if (s.why) out.push(s.why);
        else if (s.paths?.length) out.push(`${r} has new commits that touch ${list(s.paths)}: undo: ${moved.length <= MOVED_MAX ? undo(String(r)) : 'git update-ref <ref> <old sha>'} (or git reset to ${t.base_sha})`);
      }
      // round 2 MED 8: a branch (or HEAD) moved to a commit with other Claude config, new commits or not
      const heads = moved.filter(([r]) => r === 'HEAD' || r.startsWith('refs/heads/'));
      if (heads.length > MOVED_MAX) out.push(`more than ${MOVED_MAX} branches changed at once: check by hand, then Cancel`);
      else {
        for (const [r, s] of heads) {
          const d = await pinned(t, ['diff', '--no-renames', '--name-only', '-z', r === 'HEAD' ? t.base_sha : was[r] ?? t.base_sha, s, '--', ...specs(b.hooks)]);
          const paths = d.stdout.split('\0').filter(Boolean);
          if (d.err) out.push(failed(d, 'diff'));
          else if (paths.length) out.push(`${r} now points at a commit with other Claude config: ${list(paths)}: undo: ${undo(r)}`);
        }
      }
    }
    const index = await indexHash(t, b.hooks); // 4
    if (typeof index !== 'string') out.push(index.why);
    else if (index !== b.index) out.push(`Claude config staged in the index changed: undo: git restore --staged -- ${specs(b.hooks).join(' ')}`);
    const lines = await require('./spawn').dirtyPaths(t).catch((/** @type {any} */ e) => [`(${e.message})`]); // 5
    if (lines[0]?.startsWith('(')) out.push(`git status failed ${lines[0]}`);
    const was5 = new Set(b.flags ?? []);
    const hidden = lines.filter((/** @type {string} */ l) => /^(S|[a-z]) {2}/.test(l)).map((/** @type {string} */ l) => l.slice(3)).filter((p) => !was5.has(p));
    if (hidden.length) out.push(`files hidden from git status (skip-worktree / assume-unchanged): ${list(hidden)}: undo: git update-index --no-skip-worktree --no-assume-unchanged ${hidden.slice(0, NAMES).join(' ')}`);
  }
  let now; // 6
  try {
    now = await plantedNow(t, b.hooks);
  } catch (e) {
    return [...out, `Claude config check failed: ${/** @type {Error} */ (e).message}`];
  }
  if (mapHash(now) !== b.planted_hash) {
    const old = b.planted ?? {};
    const names = b.planted ? [...new Set([...Object.keys(now), ...Object.keys(old)])].filter((p) => now[p] !== old[p]) : Object.keys(now);
    out.push(`${list(names)} changed: undo: ${t.git_dir ? `git checkout ${t.base_sha} -- <paths> (or remove the new ones)` : 'put them back as they were (or remove the new ones)'}`);
  }
  return out;
}

// One message for every Block (finding 22): spawn, Done and push
const why = (/** @type {string[]} */ reasons) => `changed since the ticket started, by you or the agent:\n${reasons.map((r) => `- ${r}`).join('\n')}`;

// Blocked with the undo steps (notify pings Blocked). One write.
function block(/** @type {string} */ id, /** @type {string[]} */ reasons) {
  return store.updateTicket(id, (k) => ({ ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: 'task_changed', why: why(reasons).slice(0, WHY_MAX), since: iso() } }));
}

// Send / Commit and Push (pure, inside the caller's store write): waiting you → working again in the SAME session (the
// round bump = a new T1 start: workNext resumes it). → the next ticket; TbError 409 when not waiting for Irfan.
function resume(/** @type {any} */ k, /** @type {'message' | 'commit'} */ why) {
  if (k.kind !== 'task' || k.state !== 'working' || k.waiting?.reason !== 'you' || !k.lease?.exit) throw new TbError(409, `${k.id}: the Task is not waiting for you (state ${k.state}${k.waiting?.reason ? `, waiting ${k.waiting.reason}` : ''})`);
  const next = fsm.move(k, 'working', 'you', { message: () => true });
  next.continue = { phase: 'working', session: k.lease.session, gen: k.lease.gen, why };
  if (why !== 'commit') delete next.push_grant;
  return next;
}

// Approve (planning.approve hands a Task here): the newest round is a plan (n: the one Irfan saw), frozen as plan.json +
// plan-<hash>.json, then ONE write: plan_approval → working with the planning session to resume (why approve). No
// setup, no branch, no env copy: the folder is Irfan's.
async function approve(/** @type {string} */ id, { n = undefined } = {}) {
  const planning = require('./planning');
  const t = store.getTicket(id);
  if (t.state !== 'plan_approval') throw new TbError(409, `${id}: only a plan in plan_approval can be approved, not ${t.state}`);
  const r = await planning.currentRound(t);
  if (r?.kind !== 'plan') throw new TbError(409, `${id}: no plan to approve`);
  if (n !== undefined && r.n !== n) throw new TbError(409, `${id}: the newest plan is round ${r.n}, not round ${n}: look at it again, then approve`);
  const plan = { ...r };
  delete plan.n;
  const hash = sha256(planning.canon(plan));
  const file = `plan-${hash}.json`;
  const text = JSON.stringify(plan, null, 2) + '\n';
  await store.writeAtomic(path.join(store.ticketDir(id), file), text);
  await store.writeAtomic(path.join(store.ticketDir(id), 'plan.json'), text);
  return store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval' || k.round !== t.round) throw new TbError(409, `${id}: it is ${k.state} now`);
    if (k.waiting?.reason === 'setup') throw new TbError(409, `${id}: approve is already running`);
    const next = fsm.move({ ...k, plan_hash: hash, plan_file: file, plan_hashes: [...(k.plan_hashes ?? []), hash] }, 'working', 'you', { approve: () => true });
    next.continue = { phase: 'working', session: k.lease?.session ?? null, gen: k.lease?.gen ?? 0, why: 'approve' };
    delete next.clarify_origin;
    return next;
  });
}

// The Waits-for-you card's push target (C): git tags only, all git pinned. → {push_to: {remote, branch, new_branch,
// files, left, ahead} | null, push_why?}. files = dirty now minus dirty at the start (Irfan's own changes: left, never
// committed by the board); with his core.excludesFile, as his git status.
async function pushTo(/** @type {any} */ t, /** @type {any} */ tag) {
  const none = (/** @type {string} */ w) => ({ push_to: null, push_why: w });
  if (tag?.type !== 'git' || !t.git_dir) return none('a plain folder: no git to commit to');
  const b = t.task?.base;
  if (!Array.isArray(b?.dirty_paths)) return none(`more than ${DIRTY_MAX} files were uncommitted before the Task: commit from your terminal`);
  const remote = tag.push?.remote ?? 'origin';
  const cfg = await realConfig(t.git_dir);
  if (!REMOTE_RE.test(remote) || !cfg?.some((e) => e.startsWith(`remote.${remote}.url\n`))) return none(`no remote ${remote} in ${t.git_dir}/config`);
  if (!(await identity(t, tag))) return none('no git identity for this folder: set user.name and user.email');
  const [cur, def, ahead, lines] = await Promise.all([pinned(t, ['symbolic-ref', '-q', '--short', 'HEAD']), pinned(t, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`]),
    pinned(t, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`]),
    require('./spawn').dirtyPaths(t, process.env, { excludes: tilde(String(await terminalConfig(t.task.real ?? t.worktree, 'core.excludesFile'))) })]);
  const current = cur.err ? '' : cur.stdout.trim();
  const dflt = def.err ? '' : def.stdout.trim().replace(`${remote}/`, '');
  const branch = current && current !== tag.base && current !== dflt && branchOk(current) ? current : `tb/${t.id}`;
  const before = new Set(b.dirty_paths);
  const paths = lines.filter((/** @type {string} */ l) => !/^(S|[a-z]) {2}/.test(l)).map((/** @type {string} */ l) => l.slice(3));
  const files = paths.filter((p) => !before.has(p));
  if (!files.length) return none('no changed files to commit');
  if (files.length > DIRTY_MAX) return none(`more than ${DIRTY_MAX} changed files: commit from your terminal`);
  return { push_to: { remote, branch, new_branch: branch !== current, files, left: paths.filter((p) => before.has(p)).slice(0, DIRTY_MAX), ahead: Number(ahead.stdout.trim()) || 0 } };
}

// ---- handlers (runner) ----------------------------------------------------------------------------------------------

// task/planning: questions → clarify (askFrom: the same session gets the answers), plan → plan_approval
async function planHandle(/** @type {any} */ t, /** @type {any} */ out) {
  const planning = require('./planning');
  if (out.kind === 'questions') {
    const m = await planning.askFrom(t, out);
    return m.reject ? m : { ...m, patch: { ...m.patch, must_ask: false } };
  }
  if (t.must_ask) return { reject: 'Irfan wants to be asked more before a plan: return kind "questions"' };
  if (typeof out.summary !== 'string' || !out.summary.trim() || !out.steps?.length || !out.done_when?.length) return { reject: 'kind "plan" needs summary, steps and done_when' };
  return { to: 'plan_approval', ctx: { plan_valid: () => true }, after: () => planning.writeRound(t, out) };
}

// task/planning next: the folder lock, then the start point (one CAS write; finding 3: undefined, the next tick starts
// the run with the fresh ticket), then the session (answers / request changes resume it; {} = a fresh one, round 1)
async function planNext(/** @type {any} */ t, /** @type {any} */ api) {
  if (api.rerun) return {};
  if (!holds(t)) {
    await api.setWaiting('folder_busy')?.catch(() => {}); // moved meanwhile: the next tick sees it
    return undefined;
  }
  if (!t.task?.base) {
    const r = /** @type {any} */ (await baseline(t).catch((e) => ({ reasons: [`the start point failed: ${e.message}`] }))); // fail closed: Blocked, never a walk per tick
    if (r.reasons) return void await block(t.id, r.reasons).catch((e) => console.error(`tbd: ${t.id}: not blocked: ${e.message}`));
    if (r.refs) await store.writeAtomic(refsFile(t.id), r.refs);
    await store.updateTicket(t.id, (k) => {
      if (k.state !== 'planning' || k.round !== t.round || k.task?.base) throw new TbError(409, 'moved');
      return { ...k, ...r.patch, task: { ...k.task, base: r.base }, waiting: null };
    }).catch((e) => { if (e.status !== 409) throw e; });
    return undefined;
  }
  return require('./planning').continueOf(t) ?? {};
}

// task/working: questions → clarify (same session), done → waits for Irfan with the result (stays in working)
async function workHandle(/** @type {any} */ t, /** @type {any} */ out) {
  if (out.kind === 'questions') {
    const m = await require('./planning').askFrom(t, out);
    return m.reject ? m : { ...m, ctx: { task_needs: () => true } };
  }
  if (typeof out.summary !== 'string' || !out.summary.trim() || typeof out.done_when_met !== 'boolean' || typeof out.commit_message !== 'string' || !out.commit_message.trim()) {
    return { reject: 'kind "done" needs summary, done_when_met and commit_message' };
  }
  const p = await pushTo(t, store.listTags()[t.tag]);
  return { patch: { task_result: { at: iso(), summary: out.summary.slice(0, SUMMARY_MAX), done_when_met: out.done_when_met, commit_message: out.commit_message.slice(0, COMMIT_MAX), ...p }, waiting: { reason: 'you', since: iso() } } };
}

// A fresh working session (finding 13: Restart, a recovery with no pid): the ticket + the approved plan
async function workSeed(/** @type {any} */ t, /** @type {string} */ system) {
  const plan = await require('./planning').readPlan(t).catch(() => null);
  const p = plan ? [plan.summary, 'Steps:', ...(plan.steps ?? []).map((/** @type {string} */ s, /** @type {number} */ i) => `${i + 1}. ${s}`), 'Done when:', ...(plan.done_when ?? []).map((/** @type {string} */ s) => `- ${s}`)].join('\n') : '(not found)';
  return [store.renderMd(t).trimEnd(), '## Approved plan', p,
    'A fresh session: check `git status` and `git diff` first; part of the plan may be done already. Leave changes uncommitted unless Irfan says commit.',
    '## System now', system].join('\n\n') + '\n';
}

// task/working next: a continue (approve, Send, Commit and Push, answers) resumes the session; else nothing (waiting you)
function workNext(/** @type {any} */ t, /** @type {any} */ api) {
  if (api.rerun) return {};
  if (t.continue?.phase !== 'working') return undefined;
  return { resume: true, session: t.continue.session, prompt: require('./recovery').continuePrompt(t), extra: { resumed: true } };
}

phases.registerHandler('task/planning', planHandle, undefined, planNext);
phases.registerHandler('task/working', workHandle, workSeed, workNext);

module.exports = { check, why, block, resume, holds, holderAt, assignPatch, approve, pushTo, identity, terminalConfig, baseline };
