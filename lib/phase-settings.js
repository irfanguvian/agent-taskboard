'use strict';
// phase-settings: the `--settings` JSON for one agent run (spec §5, §9; plan §3b, D35, P2 AC8/AC10).
// phases/<kind>/<phase>/settings.json holds what differs per phase (permissions.allow, sandbox extras); BASE holds
// what every run gets: deny rules, guard hooks + their env, the Bash sandbox. Arrays concatenate, objects merge.
// ${NAME} placeholders are filled from ctx. ctx paths are absolute, so "Edit(/${WORKTREE}/**)" renders the "//abs"
// rule form (a single leading "/" would anchor at the settings file's directory). Folder tags: WORKTREE = the run's
// cwd (TICKET_DIR). TB_NODE = absolute node binary (hooks never resolve `node` through PATH). Derived: NODE_HOME (the
// node install dir). CLONE (C-H1): false = a pre-H2 linked worktree (spawn); absent = a clone. Templates load on first
// use (spawn path, never an HTTP request).
// bash-guard's heavy rewrite makes the command opaque (`tbx heavy -- sh -c '...'`): permission rules then judge only
// the wrapper (real run: inner `touch <skills>` got past the Edit deny, the sandbox stopped it). So no template allows
// `tbx` by name, and only bare-Bash phases (code/working, code/qa) can be rewritten into a run: there the sandbox walls
// the inner command; bash-guard checks its own denies on the original command before rewriting.
// P5 (contract M1, K5): ctx.ENV_FILES (the tag's env_files, relative: approve copies them into the worktree) are
// Edit- and write-denied in every phase (secrets; tbd copies them again before each gate). denyPaths(ctx) is the one deny
// source of the gate sandbox profile (lib/gates, P5b): this module's read + write denies of code/working, absolute.
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.TB_PHASES_DIR || path.join(__dirname, '..', 'phases');
const PATHS = ['WORKTREE', 'TICKET_DIR', 'OUT_DIR', 'TB_HOME', 'TAG_PATH', 'SKILLS_DIR', 'TB_CODE', 'TB_NODE']; // + TAG_GIT (values())
const SAFE_PATH = /^\/[^\0\n"`$\\()*?[\]]*$/; // nothing that breaks a rule, a glob or the hook command line
const NAME = /^[a-z][a-z_]*$/; // a kind or phase dir name (M5 C10: final_gate)
const REL = /^(?!\/)[^\0\n"`$\\()*?[\]]+$/; // an env file, relative to the worktree: SAFE_PATH's chars, no leading /
// What no gate may read either (contract K5): secrets in HOME (the profile reads only system, node, worktree, gate tmp).
// H4: ~/.pgpass too (gates only: SECRETS feeds denyPaths().read = the gate profile; agents read no home dir, AS1)
const SECRETS = ['~/.ssh', '~/.aws', '~/.netrc', '~/.git-credentials', '~/.docker', '~/.kube', '~/.gnupg', '~/.config/gh', '~/.npmrc',
  '~/Library/Keychains', '~/.zsh_history', '~/.claude*', '~/taskboard-live', '~/.pgpass'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hook = (name) => [{ type: 'command', command: `"\${TB_NODE}" "\${TB_CODE}/hooks/${name}.js"` }];
// TB_HOME files no agent reads or writes (D35c, SR6; slots.json holds lease secrets). Read deny covers the file tools;
// Edit deny also covers Bash redirects (`>> config.json` passed a Read-only deny in the sandbox-off smoke). Belt only:
// blockReadsOutsideWorkingDirectories already keeps the file tools out of all of TB_HOME but the worktree + skills.
const PRIVATE = ['config.json', 'tags.json', 'tasks.json', 'token', 'session', 'metrics.jsonl', 'leak-denylist.txt', 'calendar.json',
  'slots.json', 'doctor.json', 'events.jsonl', 'tbd.log', 'tbd.pid', 'deploy.log', 'backup/**', 'rec-key*', // rec-key: M5 C6 recorder HMAC key
  'metrics.1.jsonl', 'evals/**']; // M7: the rotated metrics file, the golden eval records
// Agent-planted config (S1): the next run in that dir loads .claude/ (settings, skills, agents: their hooks run outside
// the sandbox, as Irfan) and CLAUDE.md through --setting-sources project, also from nested dirs and --add-dir dirs. No
// agent writes them, at any depth, in a root an agent can write: Edit deny + sandbox write-deny (`**` there: P3d smoke).
// Top-level form too, in case `**/` needs a dir. lib/spawn.js refuses a run whose cwd already has one.
// board-terminal-parity Phase 2 task 1: + .mcp.json (a project MCP server's command runs as Irfan, outside the sandbox)
// and AGENTS.md (a full-access run loads it: agentsMd)
const planted = (rule) => ['WORKTREE', 'TICKET_DIR', 'TAG_PATH'].flatMap((x) => ['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', 'AGENTS.md']
  .flatMap((f) => [rule(`\${${x}}/${f}`), rule(`\${${x}}/**/${f}`)]));
// D-0151: node_modules entries no agent writes (tbd's setup / the gates' builds make them; a planted package runs in a
// gate): non-dot entries, .bin, npm's .package-lock.json, pnpm's .pnpm store + .modules.yaml, yarn's .yarn-state.yml.
// ONE list: BASE's Edit deny (`dir` → also dir/**) + sandbox write-deny. .cache / .prisma stay writable (spike: tools).
const NM = [['[a-zA-Z0-9@_-]*', true], ['.bin', true], ['.package-lock.json', false], ['.pnpm', true], ['.modules.yaml', false], ['.yarn-state.yml', false]];
const nm = (/** @type {boolean} */ edit) => NM.flatMap(([p, dir]) => {
  const at = `\${WORKTREE}/node_modules/${p}`;
  return edit ? [`Edit(/${at})`, ...(dir ? [`Edit(/${at}/**)`] : [])] : [at];
});
// H2 (D-0146): the clone's .git files an agent never writes (its own commits need index, HEAD, refs, objects): what git
// reads as config or hooks, what points it at other objects or another git dir (alternates, commondir, shallow), replace
// refs. tbd's pin (util.git) checks config, commondir, alternates again (belt).
const CLONE_NO_WRITE = ['config', 'config.worktree', 'commondir', 'hooks', 'info', 'modules', 'objects/info', 'refs/replace', 'shallow'];
// C-H1 (no breaking change): a ticket from before H2 (ctx.CLONE false: a linked worktree) commits from working into the
// tag repo's shared .git (worktrees/<id>, index, objects, refs), so there its tag .git gets the pre-H2 per-file denies
// (both names) + the worktree's .git file, not the whole dir. Its other phases, and every clone, keep the whole deny.
const LEGACY_TAG_NO_WRITE = ['config', 'hooks', 'info', 'modules', 'worktrees/*/config.worktree', 'worktrees/*/commondir', 'worktrees/*/gitdir', 'refs/replace'];
// Sandbox write-deny (SR): code, PATH dirs, claude, shell/git/npm config, the tag repo's whole .git (H2.7: agents work
// in their own clone; tbd alone moves objects into the tag repo, by fetch + fsck) and the clone's own git files above.
// Sandbox globs (sandbox-runtime globToRegex): `*` = one path part, `**` = any depth; a match covers what is below it too.
const NO_WRITE = ['${TB_CODE}', '~/taskboard-live', '/opt/homebrew/bin', '${NODE_HOME}/bin', '~/.local/bin', '~/bin',
  '~/.local/share/claude', '~/.claude*', '~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.zlogin', '~/.bashrc', '~/.bash_profile',
  '~/.profile', '~/.gitconfig', '~/.config/git', '~/.npmrc', '${TAG_GIT}', '${TAG_PATH}/.git',
  ...CLONE_NO_WRITE.map((f) => `\${WORKTREE}/.git/${f}`),
  ...nm(false),
  '${TICKET_DIR}/runs', // tbd's run files: a link planted there would aim tbd's log reads and gzip writes (P3c L1)
  '${TICKET_DIR}/skills', // --add-dir: a link planted there would be read as the run's skills (S3)
  // P4 L7: folder-tag runs have cwd = ticket dir: no planted round or ticket files (out/x.json stays writable: `*`)
  '${TICKET_DIR}/rounds', '${TICKET_DIR}/*.json',
  ...planted((p) => p)];

const BASE = {
  permissions: {
    blockReadsOutsideWorkingDirectories: true, // file tools: cwd + --add-dir only; sandboxed Bash: no home dirs
    deny: [
      ...PRIVATE.flatMap((f) => [`Read(/\${TB_HOME}/${f})`, `Edit(/\${TB_HOME}/${f})`]),
      'Edit(/${TB_HOME}/tbd.sock)',
      'Edit(/${TB_HOME}/bin/**)',
      // own ticket dir except out/ (§3b; the runner re-checks plan_hash). Other tickets have no allow rule (dontAsk
      // denies) and path-guard + the sandbox write boundary cover them: deny can't carve this ticket's out/ back.
      'Edit(/${TICKET_DIR}/*.json)',
      'Edit(/${TICKET_DIR}/*.jsonl)',
      'Edit(/${TICKET_DIR}/*.md)',
      'Edit(/${TICKET_DIR}/rounds/**)',
      'Edit(/${TICKET_DIR}/runs/**)',
      'Edit(/${TICKET_DIR}/design/**)',
      // H2.7 SPIKE S2 FIX: the clone's git files one by one, never Edit(/${WORKTREE}/.git) or .git/**: claude turns an
      // Edit deny into a sandbox write-deny of the whole subtree, and then `git commit` fails on index.lock
      ...CLONE_NO_WRITE.map((f) => `Edit(/\${WORKTREE}/.git/${f}${['config', 'config.worktree', 'commondir', 'shallow'].includes(f) ? '' : '/**'})`),
      'Edit(/${TAG_GIT}/**)',
      ...nm(true),
      ...planted((p) => `Edit(/${p}${p.endsWith('.claude') ? '/**' : ''})`),
      // Tag path: in each template except code/working + code/qa (BASE denies its .git in both layers). The main
      // checkout stays unwritable there anyway: no Edit allow, outside the sandbox write set. Read-only phases (planning,
      // review, context, qa, final_gate) write-deny the whole clone .git in their template (M5.2 sec F2: no index flag,
      // skip-worktree, can hide an edit; git status, diff, log still run read-only).
      'Edit(/${SKILLS_DIR}/**)', // --add-dir grants edit access, this takes it back
      'Edit(~/taskboard-live/**)',
      'Bash(git push *)',
      'WebFetch(domain:localhost)',
      'WebFetch(domain:127.0.0.1)',
    ],
  },
  env: { TBD_SOCK: '${TB_HOME}/tbd.sock', TB_PORT: '${TB_PORT}', TB_HEAVY: '${HEAVY}', TB_CODE: '${TB_CODE}' }, // + TB_WRITE_ROOTS
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: hook('bash-guard') },
      { matcher: 'Edit|Write|NotebookEdit|MultiEdit', hooks: hook('path-guard') },
      { matcher: 'Agent|Task', hooks: hook('subagent-count') },
    ],
    SubagentStart: [{ hooks: hook('subagent-count') }],
    SubagentStop: [{ hooks: hook('subagent-count') }],
  },
  // AC8: kept on. Bash sees TB_HOME only through this run's worktree, ticket dir and tbx's socket, and no other home
  // dir unless re-opened (Bash templates: node, npm cache, tbx code); writes stay in cwd + Edit allow paths + the
  // sandbox temp dir, minus NO_WRITE; network only via the proxy (no localhost unless the phase opts in). Signals reach
  // only the same sandbox (seatbelt `signal (target same-sandbox)`: kill -1 can't hit tbd or other runs).
  sandbox: {
    enabled: true,
    failIfUnavailable: true, // never run Bash unsandboxed because the sandbox could not start
    autoAllowBashIfSandboxed: false, // the phase allow list decides which commands run, the sandbox what they reach
    allowUnsandboxedCommands: false, // no dangerouslyDisableSandbox retry; from --settings, repo settings can't loosen it
    // H2.7: the clone reads the tag repo's objects through its alternates (a tag under HOME is unreadable otherwise, AS1);
    // the tag's config and refs stay unreadable
    filesystem: { denyRead: ['${TB_HOME}'], allowRead: ['${WORKTREE}', '${TICKET_DIR}', '${TB_HOME}/tbd.sock', '${TAG_GIT}/objects'], denyWrite: NO_WRITE },
    network: { allowUnixSockets: ['${TB_HOME}/tbd.sock'] },
  },
};

function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}

const fill = (v, vals) => typeof v === 'string'
  ? v.replace(/\$\{(\w+)\}/g, (_, k) => {
    if (!(k in vals)) throw new Error(`phase-settings: unknown placeholder \${${k}}`);
    return vals[k];
  })
  : Array.isArray(v) ? v.map((x) => fill(x, vals))
    : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vals)])) : v;

function values(ctx) {
  const vals = {};
  for (const k of PATHS) {
    const p = ctx[k];
    if (typeof p !== 'string' || !SAFE_PATH.test(p) || path.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) {
      throw new Error(`phase-settings: ${k} must be a normalized absolute path without quotes, globs or parens, got ${JSON.stringify(p)}`);
    }
    vals[k] = p;
  }
  if (!/^\d{1,5}$/.test(String(ctx.TB_PORT))) throw new Error(`phase-settings: TB_PORT must be a port number, got ${JSON.stringify(ctx.TB_PORT)}`);
  vals.TB_PORT = String(ctx.TB_PORT);
  if (!Array.isArray(ctx.HEAVY) || !ctx.HEAVY.every((h) => typeof h === 'string' && h.trim())) throw new Error('phase-settings: HEAVY must be an array of command prefixes');
  vals.HEAVY = JSON.stringify(ctx.HEAVY);
  vals.NODE_HOME = path.dirname(path.dirname(vals.TB_NODE)); // <prefix>/bin/node → <prefix>
  // H2.7: the tag repo's real git dir (a ticket's common_dir); absent (a folder tag, an old caller): <TAG_PATH>/.git
  const tg = ctx.TAG_GIT ?? `${vals.TAG_PATH}/.git`;
  if (typeof tg !== 'string' || !SAFE_PATH.test(tg) || path.normalize(tg) !== tg || tg.endsWith('/')) throw new Error(`phase-settings: TAG_GIT must be a normalized absolute path without quotes, globs or parens, got ${JSON.stringify(tg)}`);
  vals.TAG_GIT = tg;
  return vals;
}

/** @returns {any} settings object for `claude --settings` */
function render(kind, phase, ctx) {
  if (!NAME.test(kind) || !NAME.test(phase)) throw new Error(`phase-settings: bad phase ${kind}/${phase}`);
  let template;
  try {
    template = require(path.join(DIR, kind, phase, 'settings.json'));
  } catch (e) {
    throw new Error(`phase-settings: no settings template for ${kind}/${phase} (${e.code || e.message})`);
  }
  const vals = values(ctx);
  const out = fill(merge(BASE, template), vals);
  out.sandbox.filesystem.denyWrite = [...new Set(out.sandbox.filesystem.denyWrite)]; // TAG_GIT derived = ${TAG_PATH}/.git
  if (ctx.CLONE === false && phase === 'working') { // C-H1
    const whole = [vals.TAG_GIT, `${vals.TAG_PATH}/.git`];
    const f = out.sandbox.filesystem;
    f.denyWrite = [...new Set([...f.denyWrite.filter((p) => !whole.includes(p)), ...whole.flatMap((g) => LEGACY_TAG_NO_WRITE.map((x) => `${g}/${x}`)), `${vals.WORKTREE}/.git`])];
    out.permissions.deny = out.permissions.deny.map((r) => (r === `Edit(/${vals.TAG_GIT}/**)` ? `Edit(/${vals.WORKTREE}/.git)` : r));
  }
  if (kind === 'task') task(out, vals, ctx);
  for (const f of ctx.ENV_FILES ?? []) {
    const rel = typeof f === 'string' ? path.posix.normalize(f) : '';
    if (!REL.test(rel) || rel.split('/').includes('..') || rel === '.') throw new Error(`phase-settings: ENV_FILES entry ${JSON.stringify(f)} must be a plain relative path`);
    out.permissions.deny.push(`Edit(/${vals.WORKTREE}/${rel})`);
    out.sandbox.filesystem.denyWrite.push(`${vals.WORKTREE}/${rel}`);
  }
  // P4 L8: a run of a dev/eval tbd (temp TB_HOME) can't read the live board either
  const live = path.join(os.homedir(), '.taskboard');
  if (vals.TB_HOME !== live) {
    out.sandbox.filesystem.denyRead.push(live);
    // eval-only knob (golden harness): ':'-separated absolute paths (the real repo, holding the answer key) the agent can't
    // read, Bash or file tools. Ignored for the live TB_HOME. Each path is checked like a PATHS entry.
    for (const p of (process.env.TB_EVAL_DENY_READ ?? '').split(':').filter(Boolean)) {
      if (!SAFE_PATH.test(p) || path.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) throw new Error(`phase-settings: TB_EVAL_DENY_READ entry must be a normalized absolute path without quotes, globs or parens, got ${JSON.stringify(p)}`);
      out.sandbox.filesystem.denyRead.push(p);
      out.permissions.deny.push(`Read(/${p}/**)`);
    }
  }
  writeRoots(out);
  return out;
}

// Phase 4 Task (contract section 4 item 3): the run's cwd IS Irfan's folder (WORKTREE = TAG_PATH), so its own .git
// loses the whole-dir denies (commits need index, HEAD, refs, objects; the per-file CLONE_NO_WRITE denies stay: config,
// hooks, info, ...), and gains: .git/worktrees (finding 2), nested repos and gitfiles one folder deep or more (finding
// 1: `*/**/` never matches the folder's own .git; step 0 spike: the Edit layer refuses `.venv/src/pkg/.git` too), a
// plain folder's .git + root HEAD (round 2 MED 6: a bare-repo form), the hooks dir (ctx.HOOKS, relative), and with no
// node_modules at the run's start (ctx.NODE_MODULES false, G) the node_modules denies go (the agent may npm install).
function task(out, vals, ctx) {
  const W = vals.WORKTREE, d = out.permissions, f = out.sandbox.filesystem;
  if (ctx.TAG_GIT && vals.TAG_GIT === `${W}/.git`) { // a git folder: its .git is the run's own (never another repo's)
    const whole = [vals.TAG_GIT, `${vals.TAG_PATH}/.git`];
    f.denyWrite = f.denyWrite.filter((p) => !whole.includes(p));
    d.deny = d.deny.filter((r) => r !== `Edit(/${vals.TAG_GIT}/**)`);
  } else if (!ctx.TAG_GIT) { // a plain folder
    d.deny.push(`Edit(/${W}/.git)`, `Edit(/${W}/.git/**)`, `Edit(/${W}/HEAD)`);
    f.denyWrite.push(`${W}/.git`, `${W}/HEAD`);
  }
  d.deny.push(`Edit(/${W}/.git/worktrees/**)`, `Edit(/${W}/*/**/.git)`, `Edit(/${W}/*/**/.git/**)`);
  f.denyWrite.push(`${W}/.git/worktrees`, `${W}/*/**/.git`);
  if (ctx.HOOKS !== undefined) {
    const h = typeof ctx.HOOKS === 'string' ? path.posix.normalize(ctx.HOOKS) : '';
    if (!REL.test(h) || h.split('/').includes('..') || h === '.') throw new Error(`phase-settings: HOOKS ${JSON.stringify(ctx.HOOKS)} must be a plain relative path`);
    d.deny.push(`Edit(/${W}/${h}/**)`);
    f.denyWrite.push(`${W}/${h}`);
  }
  if (ctx.NODE_MODULES === false) {
    const edit = new Set(fill(nm(true), vals)), write = new Set(fill(nm(false), vals));
    d.deny = d.deny.filter((r) => !edit.has(r));
    f.denyWrite = f.denyWrite.filter((p) => !write.has(p));
  }
  d.deny = [...new Set(d.deny)];
  f.denyWrite = [...new Set(f.denyWrite)];
}

// path-guard roots = the dirs a settings object's Edit allow rules open, e.g. Edit(//wt/**) → /wt. render() and a
// full-access run (after its allow edits) both call it: one source for the write roots.
function writeRoots(settings) {
  settings.env.TB_WRITE_ROOTS = JSON.stringify(settings.permissions.allow.map((r) => /^Edit\((\/\/.+)\/\*\*\)$/.exec(r)?.[1].slice(1)).filter(Boolean));
}

// Full-access run (plan full-access-runs Phase 3; Irfan 2026-10-18 21:05): no ssh keys, no .env file but the ones the
// tag copied in. ONE place for the wall. Wall on (config full_access_wall, default true; Phase 1b smoke profile
// full-light-v2m, a-f/h pass): render()'s seatbelt kept on and widened for terminal tools (tool caches, temp, config
// dirs writable; Postgres' Unix socket named, never all sockets: the Docker one mounts ~/.ssh), with ~/.ssh, every
// .env* and ~/.config/gh read-denied AND write-denied (a rename would carry them out of the read deny), the tag's
// copied env files re-allowed by exact path (a dir allowRead does not reopen a glob deny). Known gap: the Chrome bridge
// can't start inside it (board note). Wall off: the seatbelt off (its rendered paths kept, inert). Both keep the Read
// deny rules (file tools) + bash-guard (TB_FULL_ACCESS). → {sandbox, deny: rules to add, wall}. envFiles: render's
// ENV_FILES (checked there).
// push credentials too (review MED); board-terminal-parity Phase 2: ~/.claude.json* (every project's MCP env, spike k:
// claude itself still starts) and ~/.zshenv (its exports reach the run as a filtered copy: lib/spawn.js zdot)
const WALL_NO_READ = ['~/.ssh', '/**/.env*', '~/.config/gh', '~/.git-credentials', '~/.netrc', '~/.aws', '~/.claude.json*', '~/.zshenv', '~/.zshrc', '~/.zprofile', '~/.zlogin']; // security review M2: tokens live in rc files too
const WALL_WRITE = ['~/.npm', '~/.cache', '~/Library/Caches', '~/.local/share', '~/.local/state', '~/.config', '~/.lavish-axi', '~/.chrome-devtools-axi', '/tmp', '/private/tmp'];
const WALL_NO_WRITE = ['~/.ssh', '/**/.env*', '~/.local/share/claude', '~/.config/git', '~/.config/gh', '~/.claude*', '~/.zshrc', '~/.zprofile', '~/.zshenv',
  '~/.bashrc', '~/.bash_profile', '~/.profile', '~/.gitconfig', '~/.npmrc'];
function fullAccessSandbox(sandbox, { wall = false, worktree = '', envFiles = [] } = {}) {
  const deny = ['Read(~/.ssh/**)', 'Read(~/**/.env*)', 'Read(**/.env*)', 'Read(//**/.env*)', // Phase 1 tested the first two
    'Read(~/.config/gh/**)', 'Read(~/.git-credentials)', 'Read(~/.netrc)', 'Read(~/.aws/**)', 'Read(~/.claude.json*)', 'Read(~/.zshenv)', 'Read(~/.zshrc)', 'Read(~/.zprofile)', 'Read(~/.zlogin)'];
  if (!wall) return { wall, deny, sandbox: { ...sandbox, enabled: false, failIfUnavailable: undefined } }; // undefined: left out of the file
  const f = sandbox.filesystem;
  return { wall, deny, sandbox: { ...sandbox, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    filesystem: { ...f, denyRead: [...f.denyRead, ...WALL_NO_READ], allowRead: [...f.allowRead, ...envFiles.map((r) => `${worktree}/${path.posix.normalize(r)}`)],
      allowWrite: [...(f.allowWrite ?? []), ...WALL_WRITE], denyWrite: [...f.denyWrite, ...WALL_NO_WRITE] },
    network: { ...sandbox.network, allowLocalBinding: true, allowUnixSockets: [...sandbox.network.allowUnixSockets, '/tmp/.s.PGSQL.5432', '/private/tmp/.s.PGSQL.5432'] } } };
}
// bin/tb-chrome's seatbelt profile. Chrome can't start inside claude's seatbelt (its singleton socket), so tb-chrome
// runs outside it under this, built from the run's own wall (one source) and as tight: files: the same read denies and
// re-allows (glob denies re-closed after dir re-allows), writes cwd + allowWrite + the user temp dir minus the same write
// denies, nothing mapped executable from a writable path. Programs: node, Chrome and the shell only (no open,
// osascript, launchctl: they start things outside any sandbox); no Apple Events. Signals stay open: each tb-chrome call is
// its own sandbox and must reach the bridge (same-sandbox broke every call after the first; residual: a kill, no read). Network:
// unix sockets only DNS + Chrome's singleton (no tbd.sock, Postgres, Docker, an editor's IPC); loopback TCP only `ports`
// (Chrome's bridge + debug port, the tag's qa ports); internet open as the wall's (WebFetch(domain:*)). Inside, the bridge
// runs any JS the agent sends (`run`): this profile is the only wall. SBPL: a later rule wins, and the unix-socket rules
// must come before the TCP ones (measured: after them they also refuse TCP). sandbox: a rendered sandbox block (paths
// absolute or ~, globs * ** [...]); home: for ~; node: the node binary (a literal: a prefix like /usr would reopen every
// program, security re-review). → profile text.
// SBPL pieces shared by the bridge profiles (chromeProfile, gitProfile): q an SBPL string literal (render's paths carry
// no quote or newline); real: ~ and /tmp, /var as the seatbelt sees them; glob: a sandbox glob as a regex; match: a path
// or glob as a filter; rule: one rule over a list (none for an empty list); reads(f, home, extra): the read rules of a
// rendered filesystem block, exactly as the wall reads them (glob denies re-closed after dir re-allows, exact re-allows
// of copied env files, the stat of each re-allowed path's parents).
const q = JSON.stringify;
const realOf = (home) => (p) => p.replace(/^~(?=\/|$)/, home).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1');
const globRe = (p) => `^${p.split(/(\[[^\]/]*\]|\*\*\/|\*\*|\*)/).map((s) => (s.startsWith('[') ? s : ({ '**/': '(.*/)?', '**': '.*', '*': '[^/]*' })[s] ?? s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('')}(/.*)?$`;
const matchOf = (home) => (p) => (/[*[]/.test(p) ? `(regex ${q(globRe(realOf(home)(p)))})` : `(subpath ${q(realOf(home)(p))})`);
const rule = (op, list) => (list.length ? [`(${op} ${list.join(' ')})`] : []);
function reads({ denyRead, allowRead = [] }, home) {
  const real = realOf(home), match = matchOf(home);
  const globs = denyRead.filter((p) => /[*[]/.test(p));
  // realpath walks every parent of a re-allowed path: their stat only, never their listing
  const parents = [...new Set(allowRead.flatMap((p) => real(p).split('/').slice(1, -1).map((_, i, a) => `/${a.slice(0, i + 1).join('/')}`)))];
  return [
    ...rule('deny file-read*', denyRead.map(match)),
    ...rule('allow file-read*', allowRead.map(match)),
    // as in the wall: a dir re-allow does not reopen a glob deny (.env* in the worktree); an exact path does (copied env files)
    ...rule('deny file-read*', globs.map(match)),
    ...rule('allow file-read*', allowRead.filter((p) => globs.some((g) => new RegExp(globRe(real(g))).test(real(p)))).map(match)),
    ...rule('allow file-read-metadata', parents.map((p) => `(literal ${q(p)})`)),
  ];
}
const DNS = '(remote unix-socket (path-literal "/private/var/run/mDNSResponder"))';

function chromeProfile(sandbox, { home, cwd, ports, node }) {
  const f = sandbox.filesystem;
  const match = matchOf(home);
  const temp = '(regex "^/private/var/folders/[^/]+/[^/]+/T/")';
  const writable = [cwd, ...(f.allowWrite ?? [])].map(match).concat(temp);
  return [
    '(version 1)', '(allow default)',
    '(deny process-exec*)',
    `(allow process-exec* (literal ${q(node)}) (subpath "/Applications/Google Chrome.app") (literal "/usr/bin/env") (literal "/bin/sh") (literal "/bin/bash"))`,
    '(deny appleevent-send)',
    ...reads(f, home),
    '(deny file-write*)',
    ...rule('allow file-write*', writable.concat('(literal "/dev/null")', '(literal "/dev/tty")', '(subpath "/dev/fd")')),
    ...rule('deny file-write*', f.denyWrite.map(match)),
    ...rule('deny file-map-executable', writable),
    '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
    `(allow network-outbound ${DNS} (remote unix-socket (path-regex #"^/private/var/folders/[^/]+/[^/]+/T/\\.com\\.google\\.Chrome\\.[^/]+/SingletonSocket$")))`,
    '(deny network-outbound (remote ip "localhost:*"))',
    ...rule('allow network-outbound', ports.map((p) => `(remote ip "localhost:${p}")`)),
    '',
  ].join('\n');
}

// board-terminal-parity Phase 2 task 5: bin/tb-git's git under this (runs/<n>.git.sb), built from the run's own wall
// (one source, spike h's git.sb the baseline). Programs: only git (the real binary, `xcrun -f git`: the /usr/bin/git
// shim needs xcrun) and its git-core (remote-http(s), credential-osxkeychain), /usr/bin/ssh; no shell. Files: the wall's
// reads minus its ~/.ssh deny (ssh reads Irfan's key files and config here only; .env* stays denied); writes: the repo
// (cwd) minus every write deny of the wall (the clone's git files, the planted names at any depth) and the repo's
// hooksPath dir, nothing mapped executable from it. Network: internet open; loopback TCP denied (tbd, lavish, Postgres);
// unix sockets only DNS + ssh (the SSH_AUTH_SOCK tbd itself got from launchd, real path). remote: a test-only local
// remote (TB_GIT_FILE_REMOTE, tbd's own env) read + written as the repo is, and /bin/sh (git starts a local remote's
// upload-pack / receive-pack through it; macOS's sh execs /bin/bash). → profile text.
function gitProfile(sandbox, { home, cwd, git, ssh = '', hooks = '', remote = '' }) {
  const f = sandbox.filesystem;
  const match = matchOf(home);
  const core = path.join(path.dirname(path.dirname(git)), 'libexec', 'git-core');
  const writable = [cwd, ...(remote ? [remote] : [])].map(match);
  return [
    '(version 1)', '(allow default)',
    '(deny process-exec*)',
    `(allow process-exec* (literal ${q(git)}) (subpath ${q(core)}) (literal "/usr/bin/ssh")${remote ? ' (literal "/bin/sh") (literal "/bin/bash")' : ''})`,
    '(deny appleevent-send)',
    ...reads({ denyRead: f.denyRead.filter((p) => p !== '~/.ssh'), allowRead: [...(f.allowRead ?? []), ...(remote ? [remote] : [])] }, home),
    '(deny file-write*)',
    ...rule('allow file-write*', writable.concat('(literal "/dev/null")', '(literal "/dev/tty")', '(subpath "/dev/fd")')),
    ...rule('deny file-write*', [...f.denyWrite, ...(hooks ? [`${cwd}/${hooks}`] : [])].map(match)),
    ...rule('deny file-map-executable', writable),
    '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
    `(allow network-outbound ${DNS}${ssh ? ` (remote unix-socket (path-literal ${q(ssh)}))` : ''})`,
    // security review L12 asked for 0.0.0.0 too: SBPL takes only * or localhost as a host ("host must be * or localhost"),
    // and its localhost already refuses 0.0.0.0 (measured 2026-10-19, Darwin 25: nc 0.0.0.0 <port> refused under this rule)
    '(deny network-outbound (remote ip "localhost:*"))',
    '',
  ].join('\n');
}

// rtk (Irfan's user hook) rewrites `git log` to `rtk git log`; read-only phases allow the rewritten form (choice 4)
const RTK = ['log', 'show', 'diff', 'status'].map((c) => `Bash(rtk git ${c} *)`);

// A full-access run's settings, after the pure render(): the light sandbox block, OMC off, learning (reads everywhere,
// writes in working only), the user allow list's bash / node / npx taken back in read-only phases (no bare Bash
// allow: planning, review, final_gate, context; deny wins). Every BASE deny and guard hook stays. ctx: {phase,
// learning: <tag>/.learning or null, wall, worktree, envFiles: fullAccessSandbox's, bashAll}. board-terminal-parity
// Phase 2 task 2 (bashAll: config.terminal.bash_all_steps): the read-only phases get bare Bash instead (their subagents
// and tb-chrome too); the wall, bash-guard's read-only rules (TB_PHASE) and the runner's escaped() keep them read-only.
function fullAccess(s, { phase, learning, wall = false, worktree = '', envFiles = [], bashAll = false }) {
  const block = fullAccessSandbox(s.sandbox, { wall, worktree, envFiles });
  s.sandbox = block.sandbox;
  if (block.wall) { // Phase 1b: the file-tool read block denied ~/bin, ~/.npm and HOME writes; hosts go through the proxy
    delete s.permissions.blockReadsOutsideWorkingDirectories;
    s.permissions.allow.push('WebFetch(domain:*)');
  }
  s.enabledPlugins = { 'oh-my-claudecode@omc': false };
  s.agentsMd = 'claude-md-and-agents-md'; // 2.1.302 key; did not load AGENTS.md beside CLAUDE.md under -p (spawn.js agentsMd)
  const p = s.permissions;
  p.deny.push(...block.deny, 'Edit(~/.claude/**)'); // --add-dir ~/.claude/skills: read, never write
  if (!p.allow.includes('Bash')) {
    if (bashAll) p.allow.push('Bash');
    else p.deny.push('Bash(bash:*)', 'Bash(node:*)', 'Bash(npx:*)');
    p.allow.push(...RTK); // ponytail: harmless beside a bare Bash
  }
  p.allow.push(phase === 'working' ? 'Bash(learn *)' : 'Bash(learn find *)'); // bin/learn limits the sub-commands
  if (learning) (phase === 'working' ? p.allow : p.deny).push(`Edit(/${learning}/**)`);
  writeRoots(s);
  return s;
}

// The `--tools` list for a rendered settings object: every tool its allow rules name. Edit rules also govern Write,
// which the agent needs to create files.
const tools = (settings) => [...new Set(settings.permissions.allow.flatMap((r) => (r.startsWith('Edit') ? ['Edit', 'Write'] : [r.split('(')[0]])))];

// P5 seam (contract K5 F4) → {read, write}: absolute paths (~ = HOME; globs kept: `*` one part, `**` any depth) no gate
// process may read or write. read holds all of TB_HOME (other tickets, worktrees, token, socket): the profile allows
// this ticket's worktree + gate tmp after it (a later SBPL rule wins). write: the agent's denies plus, for gates only
// (rev 4.1), every git dir: the tag repo's and the clone's whole .git (a check never writes git; agents commit). ctx: render's.
function denyPaths(ctx) {
  const f = render('code', 'working', ctx).sandbox.filesystem;
  const home = os.homedir();
  const abs = (p) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const git = [ctx.TAG_GIT ?? `${ctx.TAG_PATH}/.git`, `${ctx.TAG_PATH}/.git`, `${ctx.WORKTREE}/.git`];
  return { read: [...new Set([...f.denyRead, ...SECRETS].map(abs))], write: [...new Set([...f.denyWrite, ...git].map(abs))] };
}

module.exports = { render, tools, denyPaths, writeRoots, chromeProfile, gitProfile, fullAccess, fullAccessSandbox, WALL_WRITE, WALL_NO_WRITE, globRe };
