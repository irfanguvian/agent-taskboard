'use strict';
// spawn: one agent run's command line, env and files (spec §8 "spawn so runs survive", §9 spawn line + env, §6).
// Files in <ticket>/runs/: <n>.prompt (stdin), <n>.jsonl (stdout), <n>.err (stderr), <n>.settings.json (the phase
// template rendered for this run), <n>.mcp.json when the phase has no mcp.json (--strict-mcp-config: none) and, for
// planning, <n>.plan-ctx.json (lib/plan-rules ctx for hooks/plan-check.js, J15).
// Files, never pipes: a tbd crash can't break a pipe the child writes to. detached: the run leads its own process
// group, so a signal to tbd never reaches it and it outlives tbd. Async only (D31).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const phases = require('./phases');
const { render, tools } = require('./phase-settings');
const planRules = require('./plan-rules');
const { skillSources } = require('./skills');
const { isObj, claudeEnv, git, isFile, within } = require('./util');

const TB_CODE = path.join(__dirname, '..');
const RESUME_PROMPT = 'Your previous run was interrupted. Check the current state and continue from your last step.'; // §8 step 5
const FABLE_OK = ['plan', 'credits_ok']; // §6 Fable gate: else opus xhigh
const capKey = (phase) => (phase === 'working' ? 'working_task' : phase); // max_turns + wall_min key
// The phase's model + effort (App A models); fable only when billing allows it (§6), else opus xhigh. t:run metrics too.
// opus: the run re-runs a phase Fable refused (P4 AC7, U7): opus xhigh whatever the config says.
function modelFor(config, phase, opus = false) {
  const m = config.models?.[phase] ?? {};
  const fable = !opus && m.model === 'fable' && FABLE_OK.includes(config.fable_billing);
  const [model, effort] = opus || (m.model === 'fable' && !fable) ? ['opus', 'xhigh'] : [m.model, m.effort];
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
// claude's staging dir: a real dir of plain files, none named like config
const ccWrites = async (p) => (await lstatDir(p)) && (await fsp.readdir(p, { withFileTypes: true })).every((e) => e.isFile() && !isConfig(e.name));
async function stagingOnly(dir) { // a .claude dir holding nothing but claude's staging dir
  const names = await fsp.readdir(dir);
  return names.every((n) => n === STAGING) && (!names.length || ccWrites(path.join(dir, STAGING)));
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

// A worktree's Claude config paths (relative, any depth, any case) that differ from t.base_sha: tracked ones changed
// (diff --raw: added, changed, deleted, both names of a rename), untracked ones (--exclude-standard: git never enters an
// ignored dir), and what its ignored entries hold (U10): an ignored config file or dir by name, else each ignored dir is
// walked, every run (configPaths: lstat, links never followed; a real node_modules, 21k files, ~90 ms warm; P3 listed
// every ignored file with git, 20 s), so a config planted in node_modules after setup is seen too; plantedConfig drops
// what the baseline holds. git never enters a nested repo (untracked: one `sub/` entry) or a submodule's work tree
// (gitlink, mode 160000: from the index, so a base submodule counts even with .gitmodules deleted; changed ones from diff
// --raw; .gitmodules paths, initialized or not), so its lists can't see config in them: each is walked the same way, only
// when it really lies inside the worktree (S4: realpath; a link is never walked). git output is NUL-separated (-z): names
// are never quoted (a `café/` nested repo). claude's staging (.claude/.cc-writes/<plain file>) is left out. 5 git
// processes, in parallel, git_dir + common_dir pinned (S1, util.git). → {paths, ignored: the ignored dirs seen} (approve
// saves both).
async function worktreeConfig(t, cwd, env) {
  if (typeof t.base_sha !== 'string' || !SHA_RE.test(t.base_sha)) throw new Error(`ticket.base_sha missing or not a sha: can't check worktree ${cwd} for agent-planted Claude config`);
  const run = (args, maxBuffer = 10 << 20) => git(cwd, args, { env, dirs: t, maxBuffer });
  const [modules, ...rs] = await Promise.all([run(['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']), // exit 1: none
    run(['ls-files', '-z', '--others', '--exclude-standard'], 64 << 20), run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    run(['diff', '--raw', '-z', '--ignore-submodules=dirty', t.base_sha], 64 << 20), run(['ls-files', '-s', '-z'], 64 << 20)]); // every index entry (gitlinks): a big repo's index lists MBs
  const bad = rs.find((r) => r.err);
  if (bad) throw Object.assign(new Error(`can't check worktree ${cwd} for agent-planted Claude config: git ${String(bad.stderr || bad.err.message).trim().slice(0, 200)}`), bad.err?.code === 'PLANTED' && { code: 'PLANTED' }); // a rewritten commondir: Blocked at once
  const [untracked, ignored, raw, index] = rs.map((r) => r.stdout.split('\0').filter(Boolean));
  const named = (p) => p.split('/').some(isConfig);
  const found = untracked.filter((p) => !p.endsWith('/') && named(p));
  const dirs = [];
  // p: a path git lists as one entry (dir: trailing /). Config-named → found (unless it is claude's staging), else a dir
  // is walked. → true when it walked p.
  const entry = async (p) => {
    const dir = p.endsWith('/');
    const rel = dir ? p.slice(0, -1) : p;
    if (named(rel)) {
      const staging = dir && (rel === '.claude' ? await stagingOnly(path.join(cwd, rel)) : rel === `.claude/${STAGING}` && await ccWrites(path.join(cwd, rel)));
      if (!staging) found.push(rel);
      return false;
    }
    if (dir) found.push(...(await configPaths(cwd, rel)));
    return dir;
  };
  for (const p of ignored) if (await entry(p)) dirs.push(p);
  // diff --raw -z: ":<modes> <shas> <status>" then its path (two for a rename or copy: the new one is last)
  const changedLinks = [];
  for (let i = 0; i < raw.length; i++) {
    const kind = /^:\S+ \S+ \S+ \S+ ([RC])/.exec(raw[i])?.[1];
    const n = kind ? 2 : 1;
    const names = raw.slice(i + 1, i + 1 + n);
    if (/^:160000 |^:\S+ 160000 /.test(raw[i]) && names[n - 1]) changedLinks.push(names[n - 1]);
    found.push(...(kind === 'C' ? names.slice(1) : names).filter(named)); // a copy's source is unchanged
    i += n;
  }
  const gitlinks = [...new Set([...changedLinks,
    ...index.filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1)), // "<mode> <sha> <stage>\t<path>"
    ...(modules.err ? [] : modules.stdout.split('\0').filter(Boolean).map((e) => e.slice(e.indexOf('\n') + 1)))])]; // "<key>\n<path>"
  // .gitmodules is the agent's to write: a path out of the worktree (/x, ../x) is never walked, it is refused; so is one
  // that leads out through a link on the way (S4: realpath)
  const inside = (g) => g && !path.isAbsolute(g) && !g.split('/').includes('..');
  found.push(...gitlinks.filter((g) => !inside(g)).map((g) => `.gitmodules: ${g}`));
  const root = await fsp.realpath(cwd);
  for (const g of gitlinks.filter(inside).map((x) => x.replace(/\/+$/, ''))) {
    const real = await fsp.realpath(path.join(cwd, g)).catch(() => null); // gone: nothing to walk
    if (real && !within(real, root)) found.push(`.gitmodules: ${g} (leads outside the worktree)`);
    else if (real && await lstatDir(path.join(cwd, g))) await entry(`${g}/`); // no trailing slash: a leaf link is not followed
  }
  for (const p of untracked.filter((x) => x.endsWith('/'))) if (await lstatDir(path.join(cwd, p.slice(0, -1)))) await entry(p); // nested repos
  // .cc-writes/<name>: a plain file only (lstat): a link there is planted (P3 carry)
  const staged = await Promise.all(found.map((f) => STAGING_RE.test(f) && !isConfig(path.basename(f)) && isFile(path.join(cwd, f))));
  return { paths: [...new Set(found.filter((_, i) => !staged[i]))], ignored: dirs };
}

// S1: Claude config in the run's cwd that tbd never wrote → refuse (an agent planted it: its hooks would run outside the
// sandbox as Irfan). Ticket dir: none may exist, at any depth (configPaths). Worktree: none may differ from base_sha
// (worktreeConfig) unless the post-setup baseline has it (U10: what setup made, e.g. node_modules/x/CLAUDE.md). A folder
// tag's path (--add-dir, its .claude/skills load too) has no baseline: not checked here, the Edit deny + sandbox
// write-deny gate it.
async function plantedConfig(t, cwd, ticketDir, env) {
  if (cwd === ticketDir) {
    const found = await configPaths(cwd);
    const clean = found.includes('.claude') && await lstatDir(path.join(cwd, '.claude')) && await stagingOnly(path.join(cwd, '.claude'));
    return found.filter((f) => !(clean && f === '.claude'));
  }
  const base = new Set(t.config_baseline?.paths ?? []);
  return (await worktreeConfig(t, cwd, env)).paths.filter((p) => !base.has(p));
}

/**
 * Writes the run's files and spawns config.claude_bin detached. n: run number; session: uuid (new run:
 * --session-id, resume: --resume and no --session-id); key: the run's slots key (TBX_RUN); tag: the ticket's tag def;
 * opus: on opus xhigh, not the phase's model (modelFor).
 * @param {{ticket: any, phase: string, n: number, session: string, resume?: boolean, key: string, prompt: string,
 *   config: any, tag?: any, tbHome: string, ticketDir: string, port: number, opus?: boolean, env?: Record<string, string | undefined>}} o
 */
async function start({ ticket: t, phase, n, session, resume = false, key, prompt, config, tag, tbHome, ticketDir, port, opus = false, env = process.env }) {
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
  const { model, effort, fable } = modelFor(config, phase, opus);
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
  // J15: hooks/plan-check.js reads the run's plan rules ctx here (TB_PLAN_CTX): runs/ is tbd's, no agent writes it
  const planning = phase === 'planning';
  if (planning) await fsp.writeFile(file('plan-ctx.json'), JSON.stringify(planRules.ctxOf(t, Object.keys((await skillSources()).skills).sort())) + '\n', { mode: 0o600, flag: 'wx' });

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
    TB_PHASE: phase, // bash-guard: planning's git is read-only (J16)
    ...(planning && { TB_PLAN_CTX: file('plan-ctx.json') }),
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

// J16: what changed in t's worktree: `git status --porcelain` lines (untracked files one by one), claude's own staging
// left out (.claude/.cc-writes/<plain file> not named like config: the planted-config rules) and Finder's .DS_Store (any
// depth: GIT_CONFIG_GLOBAL=/dev/null drops Irfan's global excludes). [] = clean. A planning run must leave it so
// (runner), and approve branches only from a clean one (planning.js). git_dir + common_dir pinned (S1).
async function dirtyPaths(t, env = process.env) {
  const cwd = t.worktree;
  // --ignore-submodules=dirty: never git inside a submodule (its own config, agent-writable, could run a filter). Accepted
  // trade-off: edits inside a populated submodule are not seen here (a changed submodule commit still is; S4 walks it)
  const r = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { env, dirs: t });
  if (r.err) throw Object.assign(new Error(`git status in ${cwd}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`), r.err?.code === 'PLANTED' && { code: 'PLANTED' });
  // -z: names unquoted (café.txt); a rename/copy entry is followed by its old path, which is skipped
  const items = r.stdout.split('\0');
  const lines = [];
  for (let i = 0; i < items.length; i++) if (items[i]) { lines.push(items[i]); if (/^[RC]/.test(items[i])) i++; }
  const skip = await Promise.all(lines.map((l) => path.basename(l.slice(3)) === '.DS_Store'
    || (STAGING_RE.test(l.slice(3)) && !isConfig(path.basename(l.slice(3))) && isFile(path.join(cwd, l.slice(3))))));
  return lines.filter((_, i) => !skip[i]);
}

// U10: the baseline approve saves after setup: every config path then (and the ignored dirs seen, for the record).
const configBaseline = (t, cwd, env = process.env) => worktreeConfig({ ...t, config_baseline: undefined }, cwd, env);

module.exports = { start, RESUME_PROMPT, capKey, modelFor, plantedConfig, configBaseline, dirtyPaths };
