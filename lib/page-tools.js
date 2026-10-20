'use strict';
// page-tools (board-terminal-parity Phase 1, tasks 4 + 6.5): what the page's 3-field tag form, folder picker and Open in
// Terminal run. A cookie caller reaches these only while config.terminal.page_tools is on (lib/http.js PAGE_TOOLS); the
// token (tb) always. Request input never reaches a shell or an AppleScript string: git and osascript get argv only
// (util.git: GIT_SAFE; osascript's `on run argv`), absolute binaries, timeouts. Async fs only (request paths).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');
const tagsLib = require('./tags');
const sh = require('./sh');
const { TbError } = require('./errors');
const { git, isObj, within, readPlain, shq } = require('./util');
const { UUID_RE } = require('./evalscore');

const OSA = process.env.TB_OSASCRIPT || '/usr/bin/osascript'; // ponytail: test knob (a fake that records argv), read at load
const PICK_MS = 120_000;
const TERMINAL_MS = 30_000;
const TERMINAL_COOL_MS = 15_000;
const BRANCHES_MAX = 200;
const RECENT_MAX = 200;
const CLAUDE_JSON_MAX = 20 << 20;
const bad = (/** @type {string} */ msg) => new TbError(400, msg);

// The refused roots as real paths, once (they never move while tbd runs): a tag folder equal to, inside or a parent of
// one is refused, and / and HOME themselves. Inside any ~/.claude* entry: refused by name (refused() below), so a
// ~/.claude-x made later counts too; a parent of one is HOME or above it (refused). The ~/.claude* entries there now
// also by their real path (a ~/.claude that is a link to another folder). The list mirrors lib/phase-settings.js
// NO_WRITE + SECRETS (the HOME ones): a folder added there is added here.
const real = (/** @type {string} */ p) => fsp.realpath(p).catch(() => path.resolve(p));
/** @type {Promise<{home: string, list: string[]}> | null} */
let roots = null;
function rootsOf() {
  roots ??= (async () => {
    const home = await real(os.homedir());
    const tbHome = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
    const under = ['taskboard-live', 'Library', '.ssh', '.config', '.local', '.aws', '.gnupg', '.docker', '.kube', 'bin'].map((n) => path.join(home, n));
    const claude = (await fsp.readdir(home).catch(() => [])).filter((n) => n.startsWith('.claude')).map((n) => path.join(home, n));
    const list = await Promise.all([tbHome, path.join(__dirname, '..'), ...under, ...claude, '/opt/homebrew/bin', path.dirname(process.execPath)].map(real));
    return { home, list };
  })();
  return roots;
}
async function refused(/** @type {string} */ p) {
  const { home, list } = await rootsOf();
  const top = p !== home && within(p, home) ? path.relative(home, p).split(path.sep)[0] : '';
  return p === '/' || p === home || top.startsWith('.claude') || list.some((r) => within(p, r) || within(r, p));
}

// path (request input) → its real path: absolute, a directory, not refused; else 400
async function folderOf(/** @type {unknown} */ p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024 || /\p{Cc}/u.test(p)) throw bad('path must be an absolute folder path');
  const r = await fsp.realpath(p).catch(() => null);
  if (!r || !(await fsp.stat(r).then((s) => s.isDirectory(), () => false))) throw bad(`${p} is not a folder`);
  if (await refused(r)) throw bad(`${r} is refused: never HOME, /, the board's own folders, or a system or secret folder`);
  return r;
}

// {type: git when <dir>/.git exists, else folder; current: HEAD's branch or null; all: every local branch}
async function infoOf(/** @type {string} */ dir) {
  if (!(await fsp.lstat(path.join(dir, '.git')).then(() => true, () => false))) return { type: 'folder', current: null, all: [] };
  const [refs, head] = await Promise.all([
    git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads']),
    git(dir, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  if (refs.err) throw bad(`${dir}: git cannot read its branches`);
  const short = (/** @type {string} */ r) => r.replace(/^refs\/heads\//, '');
  const all = refs.stdout.split('\n').filter((r) => r.startsWith('refs/heads/')).map(short);
  const cur = head.err ? '' : head.stdout.trim();
  return { type: 'git', current: cur.startsWith('refs/heads/') ? short(cur) : null, all };
}

/** POST /api/folders/branches {path} → {type, current, branches ≤ 200} */
async function branches(/** @type {any} */ b) {
  if (!isObj(b) || Object.keys(b).join() !== 'path') throw bad('body must be {"path": "<folder>"}');
  const { type, current, all } = await infoOf(await folderOf(b.path));
  return { type, current, branches: all.slice(0, BRANCHES_MAX) };
}

/** POST /api/tags/quick {name, path, base?} → {tag: {name, type, path, base?, leak_check?}}; saved as `tb tag add` saves
 * (store.putTag: tags.validate + checkRules), an existing name → 409. */
async function quickTag(/** @type {any} */ b) {
  if (!isObj(b) || Object.keys(b).some((k) => !['name', 'path', 'base'].includes(k))) throw bad('body must be {"name", "path", "base"?}');
  tagsLib.validName(b.name);
  const dir = await folderOf(b.path);
  const { type, all } = await infoOf(dir);
  /** @type {Record<string, any>} */
  const def = { path: dir, type };
  if (type === 'git') {
    if (typeof b.base !== 'string' || !all.includes(b.base)) throw bad(`base must be a local branch of ${dir}`);
    Object.assign(def, { base: b.base, leak_check: true });
  } else if (b.base !== undefined) throw bad(`${dir} is a plain folder (no .git): it takes no base`);
  return { tag: { name: b.name, ...(await store.putTag(b.name, def, { fresh: true })) } };
}

/** GET /api/folders/recent → {folders: [{name, path}]}: ~/.claude.json projects keys that are folders now, not refused,
 * sorted by path, ≤ 200. Read async, ≤ 20 MB. */
async function recent() {
  const text = await readPlain(path.join(os.homedir(), '.claude.json'), CLAUDE_JSON_MAX, true);
  let projects = {};
  try { projects = JSON.parse(text ?? '{}')?.projects ?? {}; } catch { /* not JSON: none */ }
  const keys = Object.keys(isObj(projects) ? projects : {}).filter((k) => path.isAbsolute(k)).sort();
  const folders = [];
  // ponytail: 50 stats at a time until 200 folders; a file with thousands of keys reads them in batches
  for (let i = 0; i < keys.length && folders.length < RECENT_MAX; i += 50) {
    const ok = await Promise.all(keys.slice(i, i + 50).map(async (k) => {
      const r = await fsp.realpath(k).catch(() => null);
      return r !== null && (await fsp.stat(r).then((s) => s.isDirectory(), () => false)) && !(await refused(r));
    }));
    keys.slice(i, i + 50).forEach((k, j) => { if (ok[j] && folders.length < RECENT_MAX) folders.push({ name: path.basename(k), path: k }); });
  }
  return { folders };
}

/** POST /api/pick-folder {} → {path} | {cancelled: true}: the Mac folder dialog, one at a time (409), 120 s. */
let picking = false;
async function pickFolder(/** @type {any} */ b) {
  if (b !== null && !(isObj(b) && !Object.keys(b).length)) throw bad('body must be empty or {}');
  if (picking) throw new TbError(409, 'a folder dialog is open already');
  picking = true;
  try {
    const r = await sh(OSA, ['-e', 'POSIX path of (choose folder with prompt "Pick the tag folder")'], { timeout: PICK_MS });
    if (!r.err) return { path: r.stdout.trim().replace(/(.)\/$/, '$1') };
    if (/User canceled/.test(r.stderr)) return { cancelled: true };
    if (r.err.killed) throw new TbError(504, `no folder picked in ${PICK_MS / 1000} s`);
    throw new TbError(502, `the folder dialog failed: ${String(r.stderr).trim().split('\n').at(-1)?.slice(0, 200) ?? r.err.code}`);
  } finally {
    picking = false;
  }
}

/** POST /api/tickets/:id/terminal {} → 202 {ok: true}: a held run (Pause and Copy: lease exit held, no recovery in flight,
 * a uuid session, a worktree, as the page's heldBox: never two writers of one session) opens in Terminal as `cd <worktree> && claude --resume <session>`, the command one
 * argv item of `on run argv` (no AppleScript string building). http asks runner.terminalFree first (a terminal already
 * runs it: 409); one open per ticket per 15 s (409), a failed one frees it. Awaited (30 s): the first use asks macOS
 * Automation permission once; unanswered → 504, osascript failed → 502 with its last stderr line. */
/** @type {Map<string, number>} */
const opening = new Map(); // ticket id → when its Open in Terminal started; entries past 15 s dropped on each call
async function openTerminal(/** @type {string} */ id, /** @type {any} */ b) {
  if (b !== null && !(isObj(b) && !Object.keys(b).length)) throw bad('body must be empty or {}');
  const t = store.getTicket(id);
  const l = t.lease;
  if (l?.exit !== 'held' || l.pending || !UUID_RE.test(l.session ?? '') || typeof t.worktree !== 'string') throw new TbError(409, `${t.id}: not held: Pause and Copy first (a held run with a session in a worktree)`);
  const planted = await require('./spawn').heldPlanted(t, t.tag ? store.listTags()[t.tag] : undefined, store.ticketDir(t.id)); // review HIGH 3: his `claude --resume` loads the worktree's Claude config outside the wall
  if (planted) throw new TbError(409, `${t.id}: ${planted}`);
  const now = Date.now();
  for (const [k, at] of opening) if (now - at >= TERMINAL_COOL_MS) opening.delete(k);
  if (opening.has(t.id)) throw new TbError(409, `${t.id}: already opening in Terminal`);
  opening.set(t.id, now);
  const cmd = `cd ${shq(t.worktree)} && claude --resume ${l.session}`;
  const r = await sh(OSA, ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'tell application "Terminal" to activate', '-e', 'end run', cmd], { timeout: TERMINAL_MS });
  if (!r.err) return { ok: true };
  opening.delete(t.id);
  if (r.err.killed) throw new TbError(504, 'answer the macOS prompt, then press Open in Terminal again');
  throw new TbError(502, `Open in Terminal failed: ${(String(r.stderr).trim().split('\n').at(-1) || String(r.err.code ?? r.err.message)).slice(0, 200)}`);
}

module.exports = { quickTag, branches, recent, pickFolder, openTerminal, refused };
