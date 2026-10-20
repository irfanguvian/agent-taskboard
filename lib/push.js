'use strict';
// push: `tb push` (M5 C14, D-0090, S2; A15 A18 A21). start(id, actor) sends a ticket's squash (final.sha, C12) to its
// tag's push remote as refs/heads/<branch>. Allowed at the final gate waiting close, or done. Refused (409, nothing
// written): no tag key push, a push already running for this ticket, the remote's breaker open, any push URL not
// https:// (file:// only with the test knob), no squash, a squash whose author or committer is not the tag ident. Then
// one intervention CAS push {state running, remote, ref, sha, ok_sha (kept), at} → 202 at once; a background job:
// 1. leak scan: TB_CODE's scripts/leak-check "<sha> --not <tips>" (unpushed base commits, a child's parent squash,
//    messages, the branch name), cwd common_dir (never a worktree, S1). SEC-1: tips = the shas `git ls-remote <url>`
//    reports now for every push URL of the remote (in all of them) that exist here (one cat-file --batch-check), never
//    refs/remotes or packed-refs (the agents' to write: a ref planted at an unpushed commit hid it from the scan). D-0108: TB_DENYLIST = a 0600 temp file under TB_HOME (no
//    agent reads there) = Irfan's denylist + the tag's env secret values (util.envBlock, strict), removed after. Exit 1
//    → failed `leak`; exit 2, timeout, ls-remote or the denylist failing → failed `leak-check error` (fail closed; an
//    ls-remote failure is the remote's, so it counts for the breaker). Nothing pushed either way; the ticket stays (A21).
// 2. git push --porcelain --force-with-lease=<ref>:<ok_sha or empty> <remote> <sha>:<ref>, util.git system (Irfan's
//    system config: the osxkeychain helper; never a prompt). Refused → ls-remote: the remote at sha = ok (an earlier
//    attempt landed, its tbd died before the CAS); branch absent with a lease set = retry once with an empty lease;
//    else failed with git's reason.
// The end: CAS push {state ok, ok_sha: sha} | {state failed, why}, one t:push metrics line, an alert on any failure.
// board-terminal-parity 6.8 Push and Close (close: true): a green push closes the flow first (lib/final.js close: the
// same guards and intervention as tb close), before the end CAS, so a reader that sees push ok sees the close too; a
// refused close leaves it waiting close (one alert). A red push never closes.
// Breaker per remote (of a repo): 3 failed pushes in a row (leak scans don't count) → 409 for 10 min, memory only.
// boot(): a push left running by a dead tbd → failed `tbd restarted` (a re-push is safe: lease + ls-remote); the temp
// files it left removed. stop() (tbd's): the job's child groups killed, so no push outlives its tbd.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./store');
const metrics = require('./metrics');
const { TbError } = require('./errors');
const { git, minimalEnv, GIT_ENV, ident, SHA_RE, envBlock, maskCreds } = require('./util');

const LEAK_CHECK = path.join(__dirname, '..', 'scripts', 'leak-check'); // TB_CODE's copy (D18): the live one under launchd
const TB_HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
// ponytail: test knob only (a file:// remote), read once at load; never for the live ~/.taskboard (as spawn fileRemote)
const FILE_OK = process.env.TB_PUSH_FILE_OK === '1' && path.resolve(TB_HOME).toLowerCase() !== path.join(os.homedir(), '.taskboard').toLowerCase();
const PUSH_MS = 120_000, LEAK_MS = 120_000, LS_MS = 30_000;
const BREAK_AFTER = 3, BREAK_MS = 10 * 60_000;
const OUT_MAX = 64 * 1024; // the tail kept of a child's stdout / stderr
const BRANCH = /^tb\/[\w.-]{1,120}$/; // planning's tb/<id>-<slug>
const iso = () => new Date().toISOString();
const no = (msg) => new TbError(409, msg);
const running = new Set(); // ticket ids with a push job
const groups = new Set(); // pids (= pgids) of the grouped children alive now: stop() kills them
let stopped = false; // stop() came: no new child
const breaker = new Map(); // `${common_dir} ${remote}` → {fails, until}
let alert = (/** @type {{title: string, message: string}} */ _a) => {};

// A line of git's that may name a remote URL: credentials in it masked (util.maskCreds), ≤ 200 chars.
const clean = (s) => maskCreds(String(s ?? '').trim()).slice(0, 200);
const lastLine = (s) => String(s ?? '').trim().split('\n').at(-1);

// sh-shaped (resolves {err, stdout, stderr}, never rejects), but the child leads its own process group and the timeout
// SIGKILLs the whole group (git push's remote helper + credential helper, leak-check's git + gitleaks): execFile's
// timeout kills only its pid, and a child left holding the pipes would keep the call from ever resolving.
function grouped(/** @type {string} */ file, /** @type {string[]} */ args, /** @type {{cwd?: string, env: any, timeout: number}} */ { cwd, env, timeout }) {
  return new Promise((resolve) => {
    if (stopped) return void resolve({ err: new Error('tbd is stopping'), stdout: '', stderr: '' });
    const c = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = /** @type {number} */ (c.pid);
    if (pid) groups.add(pid);
    const out = { stdout: '', stderr: '' };
    for (const k of /** @type {const} */ (['stdout', 'stderr'])) c[k].setEncoding('utf8').on('data', (s) => { out[k] = (out[k] + s).slice(-OUT_MAX); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }, timeout);
    c.once('error', (e) => { clearTimeout(timer); groups.delete(pid); resolve({ err: e, ...out }); });
    c.once('close', (code, signal) => {
      clearTimeout(timer);
      groups.delete(pid);
      resolve({ err: code === 0 ? null : Object.assign(new Error(`${path.basename(file)} ended ${code ?? signal}`), { code, signal, timedOut }), ...out });
    });
  });
}

const pushable = (k) => SHA_RE.test(k.final?.sha ?? '') && ((k.state === 'final_gate' && k.waiting?.reason === 'close') || k.state === 'done');

/** POST /api/tickets/:id/push, `tb push`: the checks, the running CAS (one intervention), the job in the background. */
async function start(/** @type {string} */ id, /** @type {'cli'|'ui'} */ actor, { close = false } = {}) {
  const t = store.getTicket(id); // id regex + lookup: 400 / 404
  const tag = store.listTags()[t.tag];
  const remote = tag?.push?.remote;
  if (!remote) throw no(`${id}: tag ${t.tag ?? '(none)'} has no push remote (tb tag add ${t.tag ?? '<tag>'} --push-remote <remote>)`);
  if (!pushable(t)) throw no(`${id}: push needs the final gate passed (waiting close) or done with a squash; it is ${t.state}${t.waiting ? ` waiting ${t.waiting.reason}` : ''}`);
  if (typeof t.common_dir !== 'string' || !path.isAbsolute(t.common_dir) || !BRANCH.test(t.branch ?? '')) throw no(`${id}: no repo (common_dir) or tb/ branch recorded`);
  if (running.has(id)) throw no(`${id}: a push is running`);
  const key = `${t.common_dir} ${remote}`;
  const b = breaker.get(key);
  if (b?.until > Date.now()) throw no(`push breaker open until ${new Date(b.until).toISOString()}`);
  running.add(id);
  const sha = t.final.sha;
  let k, list;
  try {
    const urls = await git(t.common_dir, ['remote', 'get-url', '--push', '--all', remote], { system: true });
    if (urls.err) throw no(`${id}: no remote ${remote} in ${t.tag}'s repo: ${clean(lastLine(urls.stderr))}`);
    list = urls.stdout.split('\n').filter(Boolean);
    if (!list.length || !list.every((u) => u.startsWith('https://') || (FILE_OK && u.startsWith('file://')))) throw no(`${id}: every push URL of ${remote} must start with https://`);
    const want = await ident(t, '', tag); // a push tag: the tag ident, checked (isIdent, D34), else why
    if ('error' in want) throw no(`${id}: ${want.error}`);
    const log = await git(t.common_dir, ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', sha]);
    if (log.err) throw no(`${id}: squash ${sha.slice(0, 12)} not found in ${t.tag}'s repo`);
    const [an, ae, cn, ce] = log.stdout.replace(/\n$/, '').split('\0');
    if (an !== want.name || ae !== want.email || cn !== want.name || ce !== want.email) throw no(`${id}: squash made with another ident: tb rework to re-squash (or cancel the children first)`);
    k = await store.intervention(id, { actor, verb: 'push', payload: { remote, sha } }, (x) => {
      if (!pushable(x) || x.final.sha !== sha) throw no(`${id}: it moved on meanwhile (now ${x.state})`);
      return { ...x, push: { state: 'running', remote, ref: `refs/heads/${t.branch}`, sha, ok_sha: x.push?.ok_sha ?? null, at: iso() } };
    });
  } catch (e) {
    running.delete(id);
    throw e;
  }
  void job(k, { remote, sha, key, tag, urls: list, close, actor });
  return { id, state: 'running' };
}

async function job(t, { remote, sha, key, tag, urls, close = false, actor = 'cli' }) {
  const t0 = Date.now();
  const ref = `refs/heads/${t.branch}`;
  let ok = false, why = 'internal error';
  // GIT_ALLOW_PROTOCOL: the URL check above holds for whatever the config says by now
  const o = { system: true, exec: grouped, add: { GIT_ALLOW_PROTOCOL: FILE_OK ? 'https:file' : 'https' } };
  const failed = (/** @type {string} */ msg) => {
    const f = (breaker.get(key)?.fails ?? 0) + 1;
    breaker.set(key, { fails: f, until: f >= BREAK_AFTER ? Date.now() + BREAK_MS : 0 });
    alert({ title: 'Push failed', message: `${t.id}: ${remote} ${t.branch}: ${msg}` });
  };
  const refused = (/** @type {string} */ w, /** @type {string} */ msg) => {
    why = w;
    alert({ title: `Push refused: ${w}`, message: `${t.id}: nothing pushed. ${msg}` });
  };
  try {
    const s = await leakScan({ cwd: t.common_dir, sha, urls, branch: t.branch, tag });
    if (!s.ok) {
      why = s.why;
      if (s.net) failed(`${why}: ${s.msg}`); // an ls-remote failure is the remote's: it counts for the breaker
      else refused(s.why, s.msg);
      return;
    }
    const send = (lease) => git(t.common_dir, ['push', '--porcelain', `--force-with-lease=${ref}:${lease}`, remote, `${sha}:${ref}`], { ...o, timeout: PUSH_MS });
    const lease = t.push?.ok_sha ?? '';
    let r = await send(lease);
    if (r.err) {
      const ls = await git(t.common_dir, ['ls-remote', remote, ref], { ...o, timeout: LS_MS });
      const at = ls.err ? null : (ls.stdout.split('\n').find((l) => l.endsWith(`\t${ref}`)) ?? '').split('\t')[0];
      if (at === sha) r = { err: null, stdout: '', stderr: '' }; // landed before: an earlier attempt's tbd died before its CAS
      else if (at === '' && lease) r = await send(''); // the branch is gone (merged, deleted): once more as a new branch
    }
    ok = !r.err;
    if (!ok) {
      why = /** @type {any} */ (r.err).timedOut ? `git push timed out after ${PUSH_MS / 1000} s`
        : clean(/^!\t[^\t]*\t(.+)$/m.exec(r.stdout)?.[1] ?? lastLine(r.stderr)) || 'git push failed';
      failed(why);
    } else breaker.delete(key);
  } catch (e) {
    console.error(`tbd: ${t.id}: push: ${e.stack}`);
  } finally {
    await metrics.append({ t: 'push', at: iso(), ticket: t.id, remote, ok, ms: Date.now() - t0, ...(!ok && { why }) });
    if (ok && close) {
      await require('./final').close(t.id, actor) // lazy: tbd has it loaded; push alone never needs it
        .catch((/** @type {any} */ e) => alert({ title: 'Pushed, not closed', message: `${t.id}: ${String(e.message).replace(`${t.id}: `, '').slice(0, 300)}` }));
    }
    running.delete(t.id); // before the end CAS is queued: a start after this point writes after it (store queue)
    await end(t.id, sha, ok, ok ? undefined : why);
  }
}

// 1. of the module header: the leak scan of <sha> --not <the tips every push URL reports that exist here>, cwd a repo's
// common_dir (never a worktree, S1). Shared by job() (a code push, byte for byte) and Phase 4's Task push
// (task-actions.grantOk: protocols ssh:https, its SSH_AUTH_SOCK). → {ok: true} | {ok: false, why: 'leak' | 'leak-check
// error', msg, net?: true (ls-remote failed: the remote's)}; fail closed. tips: the remote's real tips present here (a
// Task's grant compares against them, never refs/remotes: the agent's to write).
/** @returns {Promise<{ok: boolean, why?: string, msg?: string, net?: boolean, tips?: string[]}>} */
async function leakScan(/** @type {{cwd: string, sha: string, urls: string[], branch: string, tag: any, protocols?: string, add?: Record<string, string>}} */ { cwd, sha, urls, branch, tag, protocols = 'https', add = {} }) {
  const o = { system: true, exec: grouped, add: { GIT_ALLOW_PROTOCOL: FILE_OK ? `${protocols}:file` : protocols, ...add } }; // the test knob for every caller (a Task's ssh:https too)
  const err = (/** @type {string} */ msg, net = false) => ({ ok: false, why: 'leak-check error', msg, ...(net && { net: true }) });
  // every push URL (checked by the caller; the fetch URL may be another repo): a tip all of them have
  const all = await Promise.all(urls.map((u) => git(cwd, ['ls-remote', u], { ...o, timeout: LS_MS })));
  const bad = all.find((r) => r.err);
  if (bad) return err(`ls-remote: ${/** @type {any} */ (bad.err).timedOut ? `timed out after ${LS_MS / 1000} s` : clean(lastLine(bad.stderr))}`, true);
  const sets = all.map((r) => new Set(r.stdout.split('\n').map((l) => l.split('\t')[0]).filter((x) => SHA_RE.test(x))));
  const shas = [...sets[0]].filter((x) => sets.every((y) => y.has(x)));
  const have = await git(cwd, ['cat-file', '--batch-check'], { input: shas.map((x) => `${x}^{commit}\n`).join(''), add: { GIT_NO_LAZY_FETCH: '1' } });
  if (have.err) return err(`cat-file: ${clean(lastLine(have.stderr))}`);
  // "<oid> commit <size>" per tip here (a tag peeled), "<name> missing" else. ponytail: tips on the command line; ~20k
  // remote refs present here near ARG_MAX (1 MB): then pass them on stdin
  const tips = have.stdout.split('\n').map((l) => l.split(' ')).filter(([x, kind]) => kind === 'commit' && SHA_RE.test(x)).map(([x]) => x);
  const tmp = await fsp.mkdtemp(path.join(TB_HOME, 'push-')); // a tbd killed mid-scan leaves it: boot() removes it (no agent reads TB_HOME)
  try {
    const deny = path.join(tmp, 'deny');
    try {
      const own = await fsp.readFile(process.env.TB_DENYLIST || path.join(process.env.HOME ?? os.homedir(), '.taskboard', 'leak-denylist.txt'), 'utf8');
      const vals = (await envBlock(tag)).map((v) => v.replace(/^#+/, '')); // a leading # would read as a comment
      await fsp.writeFile(deny, `${own}\n${vals.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      return err(`denylist: ${/** @type {any} */ (e).message}`); // a path or an env file's name, never a value
    }
    // leak-check's own git and gitleaks: a minimal env, git config of the repo only (no replace refs swap what it reads);
    // Phase 4 design section 6: no commit-graph either, for all three of its gits (a planted graph would hide a commit)
    const env = { ...minimalEnv(process.env), ...GIT_ENV, TB_DENYLIST: deny, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'false' };
    const scan = await grouped('/bin/bash', [LEAK_CHECK, [sha, '--not', ...tips].join(' '), '--branch', branch], { cwd, env, timeout: LEAK_MS });
    if (scan.err) return { ok: false, why: /** @type {any} */ (scan.err).code === 1 ? 'leak' : 'leak-check error', msg: clean(lastLine(scan.stdout || scan.stderr)) };
    return { ok: true, tips };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch((e) => console.error(`tbd: push temp dir not removed: ${e.message}`));
  }
}

// The attempt's record, if still this attempt (a rework at close clears it); ok_sha whenever sha landed: the next lease.
async function end(id, sha, ok, why) {
  try {
    await store.updateTicket(id, (k) => {
      const mine = k.push?.state === 'running' && k.push.sha === sha;
      return { ...k, push: { ...k.push, ...(ok && { ok_sha: sha }), ...(mine && { state: ok ? 'ok' : 'failed', at: iso(), ...(why && { why }) }) } };
    });
  } catch (e) {
    console.error(`tbd: ${id}: push result not saved: ${e.message}`);
  }
}

/** tbd.js boot, before http opens: a push a dead tbd left running → failed (never throws). First, what a killed tbd left
 * directly under TB_HOME (nothing runs yet): push-* (a 0600 denylist holding env secret values) and lib/spawn.js
 * contentDirty's idx-* (a temp index). Regular files and dirs only; a link goes itself, never what it points at (readdir's
 * types are lstat's and rm never follows one). */
async function boot({ alert: a = alert } = {}) {
  alert = a;
  for (const e of await fsp.readdir(TB_HOME, { withFileTypes: true }).catch(() => [])) {
    if (!/^(push|idx)-/.test(e.name) || !(e.isFile() || e.isDirectory() || e.isSymbolicLink())) continue;
    await fsp.rm(path.join(TB_HOME, e.name), { recursive: true, force: true }).catch((err) => console.error(`tbd: ${e.name} not removed: ${err.message}`));
  }
  for (const t of store.listTickets()) {
    if (t.push?.state !== 'running' || running.has(t.id)) continue;
    await store.updateTicket(t.id, (k) => (k.push?.state === 'running' ? { ...k, push: { ...k.push, state: 'failed', why: 'tbd restarted', at: iso() } } : k))
      .catch((e) => console.error(`tbd: ${t.id}: push state not reset: ${e.message}`));
  }
}

/** tbd.js stop(): the push / leak-check groups alive now (a push must not outlive its tbd; the next boot marks it failed):
 * TERM, up to 2 s for them to end, then KILL; no child starts after this. */
async function stop() {
  stopped = true;
  const kill = (/** @type {NodeJS.Signals} */ sig) => { for (const pid of groups) try { process.kill(-pid, sig); } catch { /* gone */ } };
  kill('SIGTERM');
  for (let i = 0; i < 20 && groups.size; i++) await new Promise((res) => setTimeout(res, 100));
  kill('SIGKILL');
}

module.exports = { start, boot, stop, clean, leakScan };
