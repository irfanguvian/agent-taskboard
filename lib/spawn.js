'use strict';
// spawn: one agent run's command line, env and files (spec §8 "spawn so runs survive", §9 spawn line + env, §6).
// Files in <ticket>/runs/: <n>.prompt (stdin), <n>.jsonl (stdout), <n>.err (stderr), <n>.settings.json (the phase
// template rendered for this run) and <n>.mcp.json when the phase has no mcp.json (--strict-mcp-config: none).
// Files, never pipes: a tbd crash can't break a pipe the child writes to. detached: the run leads its own process
// group, so a signal to tbd never reaches it and it outlives tbd. Async only (D31).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const phases = require('./phases');
const sh = require('./sh');
const { render, tools } = require('./phase-settings');
const { isObj, claudeEnv, minimalEnv, GIT_SAFE, GIT_ENV } = require('./util');

const TB_CODE = path.join(__dirname, '..');
const RESUME_PROMPT = 'Your previous run was interrupted. Check the current state and continue from your last step.'; // §8 step 5
const FABLE_OK = ['plan', 'credits_ok']; // §6 Fable gate: else opus xhigh
const capKey = (phase) => (phase === 'working' ? 'working_task' : phase); // max_turns + wall_min key
// The phase's model + effort (App A models); fable only when billing allows it (§6), else opus xhigh. t:run metrics too.
function modelFor(config, phase) {
  const m = config.models?.[phase] ?? {};
  const fable = m.model === 'fable' && FABLE_OK.includes(config.fable_billing);
  const [model, effort] = m.model === 'fable' && !fable ? ['opus', 'xhigh'] : [m.model, m.effort];
  return { model, effort, fable };
}
const CONFIG = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md']; // what --setting-sources project loads from the cwd
const isConfig = (name) => CONFIG.some((c) => c.toLowerCase() === name.toLowerCase()); // APFS ignores case
const SHA_RE = /^[0-9a-f]{40,64}$/;
// claude's own write staging: with the sandbox on, a Bash call makes <cwd>/.claude/.cc-writes (seen 2.1.295, P3d smoke).
// No config loads from it and the agent can't write under .claude (Edit deny + sandbox denyWrite), so it isn't planted.
// Only plain files right in it (a claude killed mid-write may leave its temp file), none named like config.
const STAGING = '.cc-writes';
const STAGING_RE = /^\.claude\/\.cc-writes\/[^/]+$/; // cwd root only, exact case: where claude makes it
const lstatDir = (p) => fsp.lstat(p).then((st) => st.isDirectory(), () => false); // a symlink is never a dir here
async function stagingOnly(dir) { // a .claude dir holding nothing but claude's staging dir
  const names = await fsp.readdir(dir);
  if (!names.every((n) => n === STAGING)) return false;
  if (!names.length) return true;
  if (!(await lstatDir(path.join(dir, STAGING)))) return false;
  return (await fsp.readdir(path.join(dir, STAGING), { withFileTypes: true })).every((e) => e.isFile() && !isConfig(e.name));
}
// S2: every Claude config name under dir (relative paths), any depth, any case. Dirents are lstat: links never
// followed. A config dir is named, not walked into. Top-level runs/ and skills/ are tbd's own (no agent writes them:
// Edit deny + sandbox denyWrite); skills/ holds the skill copies tbd hands the run (--add-dir: their .claude/skills).
async function configPaths(dir, rel = '') {
  const ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  const found = await Promise.all(ents.filter((e) => rel || (e.name !== 'runs' && e.name !== 'skills')).map((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return isConfig(e.name) ? [p] : e.isDirectory() ? configPaths(dir, p) : [];
  }));
  return found.flat();
}

// S1: Claude config in the run's cwd that tbd never wrote → refuse (an agent planted it: its hooks would run outside the
// sandbox as Irfan). Ticket dir: none may exist, at any depth (configPaths). Worktree: none may differ from base_sha,
// tracked or untracked (ignored files count), at any depth, any case. ponytail: a folder tag's path (--add-dir, its
// .claude/skills load too) has no baseline: not checked here, the Edit deny + sandbox write-deny are its only gate.
async function plantedConfig(t, cwd, ticketDir, env) {
  if (cwd === ticketDir) {
    const found = await configPaths(cwd);
    const clean = found.includes('.claude') && await lstatDir(path.join(cwd, '.claude')) && await stagingOnly(path.join(cwd, '.claude'));
    return found.filter((f) => !(clean && f === '.claude'));
  }
  if (typeof t.base_sha !== 'string' || !SHA_RE.test(t.base_sha)) throw new Error(`ticket.base_sha missing or not a sha: can't check worktree ${cwd} for agent-planted Claude config`);
  const spec = ['--', ...CONFIG.flatMap((f) => [`:(icase)${f}`, `:(glob,icase)**/${f}${f === '.claude' ? '/**' : ''}`])];
  const git = (args) => sh('/usr/bin/git', [...GIT_SAFE, '-C', cwd, ...args], { env: { ...minimalEnv(env), ...GIT_ENV }, timeout: 20_000 });
  const rs = await Promise.all([git(['diff', '--name-only', t.base_sha, ...spec]), git(['ls-files', '--others', ...spec])]);
  const bad = rs.find((r) => r.err);
  if (bad) throw new Error(`can't check worktree ${cwd} for agent-planted Claude config: git ${String(bad.stderr || bad.err.message).trim().slice(0, 200)}`);
  return [...new Set(rs.flatMap((r) => r.stdout.split('\n').filter((f) => f && !(STAGING_RE.test(f) && !isConfig(path.basename(f))))))];
}

/**
 * Writes the run's files and spawns config.claude_bin detached. n: run number; session: uuid (new run:
 * --session-id, resume: --resume and no --session-id); key: the run's slots key (TBX_RUN); tag: the ticket's tag def.
 * @param {{ticket: any, phase: string, n: number, session: string, resume?: boolean, key: string, prompt: string,
 *   config: any, tag?: any, tbHome: string, ticketDir: string, port: number, env?: Record<string, string | undefined>}} o
 */
async function start({ ticket: t, phase, n, session, resume = false, key, prompt, config, tag, tbHome, ticketDir, port, env = process.env }) {
  const runs = path.join(ticketDir, 'runs');
  const skills = path.join(ticketDir, 'skills');
  const ghDir = path.join(tbHome, 'gh-empty'); // GH_CONFIG_DIR: no gh login reaches the agent
  const phaseDir = path.join(phases.DIR, t.kind, phase);
  const file = (ext) => path.join(runs, `${n}.${ext}`);
  if (t.worktree != null && !(typeof t.worktree === 'string' && path.isAbsolute(t.worktree))) {
    throw new Error(`ticket.worktree must be an absolute path, got ${JSON.stringify(t.worktree)}`); // never a silent fallback
  }
  const cwd = t.worktree ?? ticketDir; // no worktree (folder tags; code tags before P4): the ticket dir
  const planted = await plantedConfig(t, cwd, ticketDir, env); // new run and resume alike, before anything is written
  if (planted.length) {
    throw Object.assign(new Error(`refusing to start: ${cwd} has ${planted.slice(0, 10).join(', ')}${planted.length > 10 ? ` (+${planted.length - 10} more)` : ''}: agent-planted config, remove by hand`), { code: 'PLANTED' }); // runner: Blocked at once
  }
  // S3: skills goes to --add-dir; mkdir accepts a link planted there, and claude would read wherever it points
  const sk = await fsp.lstat(skills).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (sk && !sk.isDirectory()) throw Object.assign(new Error(`refusing to start: ${skills} is not a directory (a link?): agent-planted, remove by hand`), { code: 'PLANTED' });
  await Promise.all([runs, skills, ghDir].map((d) => fsp.mkdir(d, { recursive: true, mode: 0o700 })));

  const settings = render(t.kind, phase, {
    WORKTREE: cwd, TICKET_DIR: ticketDir, OUT_DIR: path.join(ticketDir, 'out'), TB_HOME: tbHome,
    TAG_PATH: tag?.path ?? path.join(tbHome, 'no-tag'), SKILLS_DIR: skills, TB_CODE, TB_NODE: process.execPath,
    TB_PORT: port, HEAVY: tag?.heavy ?? [],
  });
  const schema = JSON.parse(await fsp.readFile(path.join(phaseDir, 'result.schema.json'), 'utf8'));
  if (!isObj(schema)) throw new Error(`${t.kind}/${phase}: result.schema.json must hold a JSON object`);
  const { model, effort, fable } = modelFor(config, phase);
  const turns = config.max_turns?.[capKey(phase)];
  const wallMin = config.liveness?.wall_min?.[capKey(phase)];
  if (typeof model !== 'string' || !model) throw new Error(`config.models.${phase}.model is missing`);
  if (!Number.isInteger(turns) || turns < 1) throw new Error(`config.max_turns.${capKey(phase)} must be a positive integer`);
  if (!(wallMin > 0)) throw new Error(`config.liveness.wall_min.${capKey(phase)} must be a positive number`);

  let mcp = path.join(phaseDir, 'mcp.json');
  if (!(await fsp.access(mcp).then(() => true, () => false))) {
    mcp = file('mcp.json');
    await fsp.writeFile(mcp, '{"mcpServers":{}}\n', { mode: 0o600, flag: 'wx' });
  }
  await fsp.writeFile(file('settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fsp.writeFile(file('prompt'), prompt, { mode: 0o600, flag: 'wx' });

  const list = tools(settings);
  const argv = [
    '-p', ...(resume ? ['--resume', session] : ['--session-id', session]),
    '--setting-sources', 'project', '--settings', file('settings.json'),
    '--append-system-prompt-file', path.join(phaseDir, 'prompt.md'),
    '--add-dir', skills, ...(tag?.type === 'folder' ? ['--add-dir', tag.path] : []),
    '--strict-mcp-config', '--mcp-config', mcp,
    '--tools', list.join(','), ...(list.includes('Agent') ? [] : ['--disallowedTools', 'Agent']), // §6: no subagents
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--model', model, ...(effort ? ['--effort', effort] : []), ...(fable ? ['--fallback-model', 'opus'] : []),
    '--max-turns', String(turns),
    '--json-schema', JSON.stringify(schema), // the schema itself, not its path (`claude --help` 2.1.294: --json-schema <schema>, inline JSON example)
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  ];
  const childEnv = {
    ...claudeEnv(env), // the env doctor checks too (removed keys, DISABLE_AUTOUPDATER)
    PATH: `${path.join(TB_CODE, 'bin')}:${env.PATH ?? '/usr/bin:/bin'}`, // bash-guard's heavy rewrite calls plain `tbx`
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(config.subagents?.concurrent ?? 3),
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(config.subagents?.depth ?? 1),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(Math.round(wallMin * 60_000)), // §6: background subagents live up to the wall cap
    BASH_DEFAULT_TIMEOUT_MS: '1800000',
    BASH_MAX_TIMEOUT_MS: '1800000',
    GIT_TERMINAL_PROMPT: '0',
    // no credential helper, and every push URL rewritten to no-push://<url> (pushInsteadOf "" matches all URLs)
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'url.no-push://.pushInsteadOf', GIT_CONFIG_VALUE_1: '',
    GH_CONFIG_DIR: ghDir,
    TBD_SOCK: path.join(tbHome, 'tbd.sock'),
    TBX_RUN: key,
  };

  const fhs = [];
  try {
    fhs.push(await fsp.open(file('prompt'), 'r'), await fsp.open(file('jsonl'), 'wx', 0o600), await fsp.open(file('err'), 'wx', 0o600));
    const child = spawn(config.claude_bin, argv, { cwd, env: childEnv, stdio: fhs.map((f) => f.fd), detached: true });
    // listeners now, before any await: a fast exit must not be missed
    const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    ready.catch(() => {}); // rejects (e.g. ENOENT) while the fds close below: the caller awaits it after
    child.on('error', () => {}); // later errors (a failed kill) are not fatal to tbd
    child.unref();
    return { child, ready, done, log: `runs/${n}.jsonl` };
  } finally {
    await Promise.all(fhs.map((f) => f.close()));
  }
}

module.exports = { start, RESUME_PROMPT, capKey, modelFor };
