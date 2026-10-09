'use strict';
// phase-settings: the `--settings` JSON for one agent run (spec §5, §9; plan §3b, D35, P2 AC8/AC10).
// phases/<kind>/<phase>/settings.json holds what differs per phase (permissions.allow, sandbox extras); BASE holds
// what every run gets: deny rules, guard hooks + their env, the Bash sandbox. Arrays concatenate, objects merge.
// ${NAME} placeholders are filled from ctx. ctx paths are absolute, so "Edit(/${WORKTREE}/**)" renders the "//abs"
// rule form (a single leading "/" would anchor at the settings file's directory). Folder tags: WORKTREE = the run's
// cwd (TICKET_DIR). TB_NODE = absolute node binary (hooks never resolve `node` through PATH). Derived: NODE_HOME (the
// node install dir). Templates load on first use (spawn path, never an HTTP request).
// bash-guard's heavy rewrite makes the command opaque (`tbx heavy -- sh -c '...'`): permission rules then judge only
// the wrapper (real run: inner `touch <skills>` got past the Edit deny, the sandbox stopped it). So no template allows
// `tbx` by name, and only bare-Bash phases (code/working, code/qa) can be rewritten into a run: there the sandbox walls
// the inner command; bash-guard checks its own denies on the original command before rewriting.
const path = require('node:path');

const DIR = process.env.TB_PHASES_DIR || path.join(__dirname, '..', 'phases');
const PATHS = ['WORKTREE', 'TICKET_DIR', 'OUT_DIR', 'TB_HOME', 'TAG_PATH', 'SKILLS_DIR', 'TB_CODE', 'TB_NODE'];
const SAFE_PATH = /^\/[^\0\n"`$\\()*?[\]]*$/; // nothing that breaks a rule, a glob or the hook command line
const NAME = /^[a-z]+$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hook = (name) => [{ type: 'command', command: `"\${TB_NODE}" "\${TB_CODE}/hooks/${name}.js"` }];
// TB_HOME files no agent reads or writes (D35c, SR6; slots.json holds lease secrets). Read deny covers the file tools;
// Edit deny also covers Bash redirects (`>> config.json` passed a Read-only deny in the sandbox-off smoke). Belt only:
// blockReadsOutsideWorkingDirectories already keeps the file tools out of all of TB_HOME but the worktree + skills.
const PRIVATE = ['config.json', 'tags.json', 'tasks.json', 'token', 'session', 'metrics.jsonl', 'leak-denylist.txt', 'calendar.json',
  'slots.json', 'doctor.json', 'events.jsonl', 'tbd.log', 'tbd.pid', 'deploy.log', 'backup/**'];
// Agent-planted config (S1): the next run in that dir loads .claude/ (settings, skills, agents: their hooks run outside
// the sandbox, as Irfan) and CLAUDE.md through --setting-sources project, also from nested dirs and --add-dir dirs. No
// agent writes them, at any depth, in a root an agent can write: Edit deny + sandbox write-deny (`**` there: P3d smoke).
// Top-level form too, in case `**/` needs a dir. lib/spawn.js refuses a run whose cwd already has one.
const planted = (rule) => ['WORKTREE', 'TICKET_DIR', 'TAG_PATH'].flatMap((x) => ['.claude', 'CLAUDE.md', 'CLAUDE.local.md']
  .flatMap((f) => [rule(`\${${x}}/${f}`), rule(`\${${x}}/**/${f}`)]));
// Sandbox write-deny (SR): code, PATH dirs, claude, shell/git/npm config, and the git files whose contents run code
// (hooks, config, fsmonitor via a redirected worktree .git). Most sit outside the write set already; the tag repo's
// shared .git and the worktree's .git file are inside it (linked-worktree commits need the rest of .git).
const NO_WRITE = ['${TB_CODE}', '~/taskboard-live', '/opt/homebrew/bin', '${NODE_HOME}/bin', '~/.local/bin', '~/bin',
  '~/.local/share/claude', '~/.claude*', '~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.zlogin', '~/.bashrc', '~/.bash_profile',
  '~/.profile', '~/.gitconfig', '~/.config/git', '~/.npmrc', '${TAG_PATH}/.git/config', '${TAG_PATH}/.git/hooks',
  '${TAG_PATH}/.git/info', '${TAG_PATH}/.git/modules', '${TAG_PATH}/.git/worktrees/*/config.worktree', '${WORKTREE}/.git',
  '${TICKET_DIR}/runs', // tbd's run files: a link planted there would aim tbd's log reads and gzip writes (P3c L1)
  '${TICKET_DIR}/skills', // --add-dir: a link planted there would be read as the run's skills (S3)
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
      'Edit(/${WORKTREE}/.git)', // gitdir redirect → fsmonitor/hooks run by the runner's git
      ...planted((p) => `Edit(/${p}${p.endsWith('.claude') ? '/**' : ''})`),
      // Tag path: in each template except code/working + code/qa. Their agents commit in a linked worktree, which
      // writes the tag repo's shared .git (the sandbox allows that minus .git/hooks + config); a deny here blocks it.
      // The main checkout stays unwritable there anyway: no Edit allow, outside the sandbox write set.
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
    filesystem: { denyRead: ['${TB_HOME}'], allowRead: ['${WORKTREE}', '${TICKET_DIR}', '${TB_HOME}/tbd.sock'], denyWrite: NO_WRITE },
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
  const out = fill(merge(BASE, template), values(ctx));
  // path-guard roots = the dirs this phase's Edit allow rules open, e.g. Edit(//wt/**) → /wt
  const roots = out.permissions.allow.map((r) => /^Edit\((\/\/.+)\/\*\*\)$/.exec(r)?.[1].slice(1)).filter(Boolean);
  out.env.TB_WRITE_ROOTS = JSON.stringify(roots);
  return out;
}

// The `--tools` list for a rendered settings object: every tool its allow rules name. Edit rules also govern Write,
// which the agent needs to create files.
const tools = (settings) => [...new Set(settings.permissions.allow.flatMap((r) => (r.startsWith('Edit') ? ['Edit', 'Write'] : [r.split('(')[0]])))];

module.exports = { render, tools };
