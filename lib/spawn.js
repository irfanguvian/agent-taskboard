'use strict';
// spawn: one agent run's command line, env and files (spec §8 "spawn so runs survive", §9 spawn line + env, §6).
// Files in <ticket>/runs/: <n>.prompt (stdin), <n>.jsonl (stdout), <n>.err (stderr), <n>.settings.json (the phase
// template rendered for this run), <n>.mcp.json when the phase has no mcp.json (--strict-mcp-config: none) and, for
// planning, <n>.plan-ctx.json (lib/plan-rules ctx for hooks/plan-check.js, J15); M5 C2: <n>.system.md, a code run's
// system prompt (phase prompt + phases/_rules.md).
// Files, never pipes: a tbd crash can't break a pipe the child writes to. detached: the run leads its own process
// group, so a signal to tbd never reaches it and it outlives tbd. Async only (D31).
const crypto = require('node:crypto');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const phases = require('./phases');
const { render, tools } = require('./phase-settings');
const planRules = require('./plan-rules');
const { gateTag } = require('./tags');
const { skillSources } = require('./skills');
const { isObj, claudeEnv, git, isFile, within, SHA_RE } = require('./util');

const TB_CODE = path.join(__dirname, '..');
const RESUME_PROMPT = 'Your previous run was interrupted. Check the current state and continue from your last step.'; // §8 step 5
const FABLE_OK = ['plan', 'credits_ok']; // §6 Fable gate: else opus xhigh
const capKey = (phase) => (phase === 'working' ? 'working_task' : phase); // max_turns + wall_min key
// The isolation flags of a run (§6: project settings + ours only, no MCP but ours, the tool list, no subagents, no
// prompts) and its env extras (D-0011), for a claude -p outside start() (golden-working --blind). start() writes the same
// pairs, not contiguous (test/spawn.test.js holds the drift).
const isolationArgv = (/** @type {{settings: string, mcp: string, tools: string[]}} */ { settings, mcp, tools: list }) => [
  '--setting-sources', 'project', '--settings', settings, '--strict-mcp-config', '--mcp-config', mcp,
  '--tools', list.join(','), ...(list.includes('Agent') ? [] : ['--disallowedTools', 'Agent']), '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
const ISOLATION_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
// git in a run: never a terminal prompt, no credential helper, and every push URL rewritten to no-push://<url>
// (pushInsteadOf "" matches all URLs). start() and the blind reviewer spread this one object.
const AGENT_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'url.no-push://.pushInsteadOf', GIT_CONFIG_VALUE_1: '',
};
// The phase's model + effort (App A models); fable only when billing allows it (§6), else opus xhigh. t:run metrics too.
// opus: the run re-runs a phase Fable refused (P4 AC7, U7): opus xhigh whatever the config says. M5 C11 G9: final_gate
// through finalModel (the runner's lease, spawn's argv and t:run all ask here).
function configured(config, phase, opus = false) {
  const m = config.models?.[phase] ?? {};
  const fable = !opus && m.model === 'fable' && FABLE_OK.includes(config.fable_billing);
  const [model, effort] = opus || (m.model === 'fable' && !fable) ? ['opus', 'xhigh'] : [m.model, m.effort];
  return { model, effort, fable };
}
// M5 C11 G9: the final review is a second pair of eyes, never on review's model: models.final_gate, else the first of
// opus, fable (billing ok), sonnet that differs (the config's effort kept)
function finalModel(config) {
  const m = configured(config, 'final_gate');
  const review = configured(config, 'review').model;
  if (m.model !== review) return m;
  const model = ['opus', FABLE_OK.includes(config.fable_billing) && 'fable', 'sonnet'].find((x) => x && x !== review);
  return { model, effort: m.effort, fable: model === 'fable' };
}
const modelFor = (config, phase, opus = false) => (phase === 'final_gate' && !opus ? finalModel(config) : configured(config, phase, opus));
const CONFIG = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md']; // what --setting-sources project loads from the cwd
const isConfig = (name) => CONFIG.some((c) => c.toLowerCase() === name.toLowerCase()); // APFS ignores case
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
    TAG_GIT: path.isAbsolute(t.common_dir ?? '') ? t.common_dir : undefined, // H2.7: the tag repo's real git dir
    CLONE: !t.worktree || !!t.clone, // C-H1: false = a worktree from before H2 (linked): its commits write the tag's .git
    // P5 M1: the secrets approve copied in; M5 C5 C7: qa + final_gate too (the copy the app reads = the file the DB guard checked)
    TB_PORT: port, HEAVY: tag?.heavy ?? [], ENV_FILES: ['working', 'qa', 'final_gate'].includes(phase) && t.worktree ? tag?.env_files ?? [] : [],
  });
  // P5 R1 (D-0040): the plan's skills (copied to skills/.claude/skills at approve) run only through the Skill tool
  if (phase === 'working' && Array.isArray(t.skills) && t.skills.length) settings.permissions.allow.push('Skill');
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
  // M5 C2 (D-0085): a code run's system prompt = the phase prompt + phases/_rules.md (lib/phases.js read it at load)
  let system = path.join(phaseDir, 'prompt.md');
  if (t.kind === 'code') {
    if (!phases.rules) throw new Error('phases/_rules.md is missing or over 8 KB: code phases are misconfigured');
    await fsp.writeFile(file('system.md'), `${await fsp.readFile(system, 'utf8')}\n\n${phases.rules.text}`, { mode: 0o600, flag: 'wx' });
    system = file('system.md');
  }
  // J15: hooks/plan-check.js reads the run's plan rules ctx here (TB_PLAN_CTX): runs/ is tbd's, no agent writes it
  const planning = phase === 'planning';
  // P5 K4: a replan (the ticket has a work cursor) checks paths at its branch HEAD (ctx.at), not base_sha, and may keep
  // the done prefix (ctx.keep_ok)
  const at = planning && t.work && t.worktree ? (await git(cwd, ['rev-parse', '--verify', 'HEAD'], { env, dirs: t })).stdout.trim() : '';
  if (planning) {
    const keep_ok = t.work ? (await require('./planning').keepOk(t)) ?? undefined : undefined; // lazy: planning requires spawn
    const ctx = planRules.ctxOf(t, Object.keys((await skillSources()).skills).sort(), { at: SHA_RE.test(at) ? at : undefined, test_scripts: tag ? gateTag(tag).test_scripts : undefined, keep_ok });
    await fsp.writeFile(file('plan-ctx.json'), JSON.stringify(ctx) + '\n', { mode: 0o600, flag: 'wx' });
  }

  const list = tools(settings);
  const argv = [
    '-p', ...(resume ? ['--resume', session] : ['--session-id', session]),
    '--setting-sources', 'project', '--settings', file('settings.json'),
    '--append-system-prompt-file', system,
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
    ...ISOLATION_ENV,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(Math.round(wallMin * 60_000)), // §6: background subagents live up to the wall cap
    BASH_DEFAULT_TIMEOUT_MS: '1800000',
    BASH_MAX_TIMEOUT_MS: '1800000',
    ...AGENT_GIT_ENV,
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
// (runner), and approve branches only from a clean one (planning.js). git_dir + common_dir pinned (S1). M5.2 sec F2: a
// tracked file flagged skip-worktree or assume-unchanged (`git update-index`) hides its edits from git status, so each
// one counts too, as a line `<ls-files -v tag>  <path>` (S, or lower case: `S  src/a.js`).
async function dirtyPaths(t, env = process.env) {
  const cwd = t.worktree;
  const fail = (/** @type {any} */ r, /** @type {string} */ what) => Object.assign(new Error(`git ${what} in ${cwd}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`), r.err?.code === 'PLANTED' && { code: 'PLANTED' });
  // --ignore-submodules=dirty: never git inside a submodule (its own config, agent-writable, could run a filter). Accepted
  // trade-off: edits inside a populated submodule are not seen here (a changed submodule commit still is; S4 walks it)
  const [r, f] = await Promise.all([git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { env, dirs: t }),
    git(cwd, ['ls-files', '-v', '-z'], { env, dirs: t })]);
  if (r.err) throw fail(r, 'status');
  if (f.err) throw fail(f, 'ls-files');
  // -z: names unquoted (café.txt); a rename/copy entry is followed by its old path, which is skipped
  const items = r.stdout.split('\0');
  const lines = [];
  for (let i = 0; i < items.length; i++) if (items[i]) { lines.push(items[i]); if (/^[RC]/.test(items[i])) i++; }
  // skip-worktree (S) / assume-unchanged (lowercase) hide an edit from status: dirty (sec F2). ponytail: ls-files lists
  // every tracked path per call under sh's 10 MB maxBuffer (~150k paths, then git errors → Blocked) and a sparse
  // worktree reads dirty everywhere; a bigger maxBuffer or a streamed filter if a repo ever gets there
  for (const e of f.stdout.split('\0')) if (/^(S|[a-z]) /.test(e)) lines.push(`${e[0]}  ${e.slice(2)}`);
  const skip = await Promise.all(lines.map((l) => path.basename(l.slice(3)) === '.DS_Store'
    || (STAGING_RE.test(l.slice(3)) && !isConfig(path.basename(l.slice(3))) && isFile(path.join(cwd, l.slice(3))))));
  return lines.filter((_, i) => !skip[i]);
}

// M5.3 SEC-2 (D-0107: the final gate and the final judge only): the tracked files of t's worktree whose content is not
// HEAD's, stat-independent. The worktree's index is the agent's to write: a stat cache forged onto HEAD's blob makes `git
// status` (dirtyPaths) clean while the file is not (`ls-files -v` shows H). So a fresh index read from HEAD into a temp
// dir tbd makes (GIT_INDEX_FILE, never in the worktree; no stat data: git hashes each file), attributes from HEAD too
// (--attr-source: a planted worktree .gitattributes changes no comparison). → `git status --porcelain` lines
// (` M src/a.js`), [] = HEAD's content. The temp dir lies in TB_HOME (0700: no agent reads or writes there), removed
// after. Throws when git fails. ponytail: hashes every tracked file per call (ceiling: repo size, 120 s timeout →
// Blocked infra); a tree hash cached per HEAD if a big repo ever waits on it.
async function contentDirty(t, env = process.env) {
  const dir = await fsp.mkdtemp(path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'idx-'));
  try {
    const o = { env, dirs: t, add: { GIT_INDEX_FILE: path.join(dir, 'index') }, timeout: 120_000 };
    let r = await git(t.worktree, ['read-tree', 'HEAD'], o);
    if (!r.err) r = await git(t.worktree, ['--attr-source=HEAD', 'status', '--porcelain', '-z', '--untracked-files=no', '--ignore-submodules=dirty'], o);
    if (r.err) throw Object.assign(new Error(`git content check in ${t.worktree}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`), r.err?.code === 'PLANTED' && { code: 'PLANTED' });
    return r.stdout.split('\0').filter(Boolean); // the index is HEAD: no staged entry, so no rename pair
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// H1 (D-0105, D-0107 at every gate): what changed in t's worktree whatever its index says: dirtyPaths (status: untracked
// files, skip-worktree flags) ∪ contentDirty (tracked content vs HEAD, stat-free), run in parallel (F19), one line per
// path (C-L2: a staged edit is `M  x` there, ` M x` here: status's line kept). Gates and judges call it with the trusted
// t (H2.5): HEAD's tree read from the tag repo's objects only.
async function treeDirty(t, env = process.env) {
  const [a, b] = await Promise.all([dirtyPaths(t, env), contentDirty(t, env)]);
  const seen = new Set();
  return [...a, ...b].filter((l) => !seen.has(l.slice(3)) && seen.add(l.slice(3)));
}

// P5 M1 tripwire: what setup left in node_modules that tests run through: sha256 of npm's hidden lockfile
// (node_modules/.package-lock.json, null when missing) and of node_modules/.bin's sorted "name→link target" list (a plain
// file there, a planted script, counts as "name!file"). lstat + readlink only: nothing is followed. Compact (two hashes)
// so ticket.json stays small; the gate is told only that it changed.
async function tripwire(cwd) {
  const nm = path.join(cwd, 'node_modules');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  // lstat both: a symlinked node_modules or .bin is recorded as a link (readdir/isFile would follow it into its target)
  const lst = (f) => fsp.lstat(f).catch(() => null);
  const [nmSt, lockSt, binSt] = await Promise.all([lst(nm), lst(path.join(nm, '.package-lock.json')), lst(path.join(nm, '.bin'))]);
  const lock = nmSt?.isSymbolicLink() ? 'link' : lockSt?.isFile() ? sha(await fsp.readFile(path.join(nm, '.package-lock.json'))) : null;
  const names = nmSt?.isSymbolicLink() || binSt?.isSymbolicLink() || !binSt ? [] : (await fsp.readdir(path.join(nm, '.bin')).catch(() => [])).sort();
  const links = nmSt?.isSymbolicLink() || binSt?.isSymbolicLink() ? ['link'] : await Promise.all(names.map((n) => fsp.readlink(path.join(nm, '.bin', n)).then((to) => `${n}→${to}`, () => `${n}!file`)));
  return { lock, bin: sha(links.join('\0')) };
}

// U10: the baseline approve saves after setup: every config path then (and the ignored dirs seen, for the record).
// P5 M1: + the node_modules tripwire at the same moment.
const configBaseline = async (t, cwd, env = process.env) => ({ ...(await worktreeConfig({ ...t, config_baseline: undefined }, cwd, env)), tripwire: await tripwire(cwd) });

module.exports = { start, isolationArgv, ISOLATION_ENV, AGENT_GIT_ENV, RESUME_PROMPT, capKey, modelFor, finalModel, plantedConfig, configBaseline, dirtyPaths, contentDirty, treeDirty, tripwire };
