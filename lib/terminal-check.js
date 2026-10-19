'use strict';
// terminal-check: `tb doctor --terminal` and Settings → Terminal "Check Terminal" / "Live Run…" (board-terminal-parity
// Phase 2 task 6, round 3 C3). POST /api/doctor {terminal: true, live?, tag?, yes?}: doctor.run hands it here (a cookie
// only with terminal.page_tools, CSRF as every page tool). Lazy: loaded at the first check. → {ok, checks: [{status:
// ok|warn|fail, name, detail}]}: detail is plain words + the fix, URL credentials masked, never an env or header value.
// Fixed checks (no AI cost): per git tag `git ls-remote <its push remote, else origin>` the git bridge's way (tbgit
// gitArgs + gitEnv, phase-settings gitProfile from the run wall, tbd's own SSH_AUTH_SOCK; the tag's main checkout, 20 s);
// per folder MCP server of each tag (spawn.folderMcp: the terminal's enable rules) a stdio command found on the run's
// PATH (never started) or an http host that answers a HEAD of its origin in 5 s (no auth, no path or query sent);
// tb-chrome start + stop as a run calls it (its wall profile, tbd's env; warn when Chrome is not installed, or skipped
// with a warn while memory pressure is not normal: the monitor's snapshot, deps.system); skills
// found (listSkills); node -v under the wall's profile (chromeProfile: the wall's reads and writes, node only); the
// pinned claude's --help lists --permission-mode auto + --permission-prompts host (no run); the 6 switches.
// Live run (live + yes, a git tag Irfan names): one short sonnet run (≤ 8 turns) through runner.oneOff (admission,
// spawn.start's argv / env / settings, a slots root) in its own clone (planning.worktree, removed after) and a temp
// ticket dir; it tries Bash `echo ok`, one subagent, one read-only-looking tool of the tag's first folder MCP server and
// tb-git ls-remote. Each PASS/FAIL is read from the stream log (a tool_use and its tool_result; the init line's Skill
// tool + skills), never from the model's words. live without yes: the tag checked and the cost line only (the CLI's
// --yes, the page's 2-click arm). One check at a time (409).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, claudeEnv, git, readPlain } = require('./util');
const { plain } = require('./toon');
const { NAME_RE } = require('./tags');
const { render, fullAccess, chromeProfile, gitProfile } = require('./phase-settings');
const { gitArgs, gitEnv } = require('./tbgit');
const spawn = require('./spawn');
const planning = require('./planning');
const { listSkills } = require('./skills');

const CODE = path.join(__dirname, '..');
const KEYS = ['terminal', 'live', 'tag', 'yes'];
const SWITCHES = ['bash_all_steps', 'folder_mcp', 'git_bridge', 'auto_mode', 'task_tickets', 'page_tools'];
// ponytail: an estimate scaled from the last opus xhigh runs (a 7-turn review: $0.48) to sonnet with one subagent;
// replace it with the measured cost after the first live runs
const LIVE_COST = '~$0.30 typical, ~$1 worst (one sonnet run, at most 8 turns and 1 subagent; subscription usage)';
const LIVE_TURNS = 8;
const LIVE_WALL_MIN = 10;
const READ_ONLY = /^(list|get|read|search|query|describe|find|show|echo)/i; // an MCP tool name that looks read-only
const WHY = { // admission's reasons, in plain words
  memory: 'memory is low now (the RAM guard holds new runs); try again when it frees',
  disk: 'the disk is almost full', slot: 'the board already runs its most tickets at once', usage: 'runs wait for the usage limit to reset',
};
let busy = false;

const bad = (/** @type {string} */ msg) => new TbError(400, msg);
const row = (/** @type {string} */ status, /** @type {string} */ name, /** @type {string} */ detail) => ({ status, name,
  detail: plain(detail).replace(/\s+/g, ' ').replace(/\/\/[^"\s]*@/g, '//***@').slice(0, 400) });
const tail = (/** @type {any} */ r) => String(r.stderr || r.stdout || r.err?.message || '').trim().split('\n').pop()?.slice(0, 200) ?? '';
const exists = (/** @type {string} */ p, mode = fsp.constants.F_OK) => fsp.access(p, mode).then(() => true, () => false);

function parse(/** @type {any} */ b) {
  const unknown = Object.keys(b).find((k) => !KEYS.includes(k));
  if (unknown) throw bad(`unknown field "${unknown}" (terminal takes live, tag and yes)`);
  if (b.terminal !== true) throw bad('terminal must be true');
  for (const k of ['live', 'yes']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} must be true or false`);
  if (!b.live && (b.tag !== undefined || b.yes !== undefined)) throw bad('tag and yes go with live (the fixed checks cover every tag)');
  if (b.live && (typeof b.tag !== 'string' || !NAME_RE.test(b.tag))) throw bad('a live run needs tag: a git tag, like shop/api');
  return { live: b.live === true, tag: b.tag, yes: b.yes === true };
}

// The run wall's sandbox block, as spawn.start builds it (render code/working + fullAccess), with dir as worktree and
// ticket dir → {sandbox, wall}
function wallOf(/** @type {any} */ store, /** @type {any} */ env, /** @type {string} */ tbHome, /** @type {string} */ dir) {
  const s = render('code', 'working', { WORKTREE: dir, TICKET_DIR: dir, OUT_DIR: path.join(dir, 'out'), TB_HOME: tbHome, TAG_PATH: path.join(tbHome, 'no-tag'),
    SKILLS_DIR: path.join(dir, 'skills'), TB_CODE: CODE, TB_NODE: process.execPath, TB_PORT: env.TB_PORT || '7777', HEAVY: [] });
  const wall = store.config.full_access_wall === true;
  fullAccess(s, { phase: 'working', learning: null, wall, worktree: dir });
  return { sandbox: s.sandbox, wall };
}

async function gitCheck(/** @type {string} */ name, /** @type {any} */ def, /** @type {any} */ c) {
  const id = `tb-git:${name}`;
  const remote = def.push?.remote ?? 'origin';
  const bin = await spawn.realGit();
  if (!bin) return row('fail', id, 'xcrun -f git found no git — fix: install the Command Line Tools (xcode-select --install)');
  const run = { git_dir: path.join(def.path, '.git'), repo: def.path, home: c.home, user: c.env.USER ?? '', lang: c.env.LANG ?? 'en_US.UTF-8',
    ssh_auth_sock: c.ssh, ...(c.fileRemote && { file_remote: c.fileRemote }) };
  const profile = gitProfile(c.sandbox, { home: c.home, cwd: c.dir, git: bin, ssh: c.ssh, remote: c.fileRemote });
  const r = await sh('/usr/bin/sandbox-exec', ['-p', profile, bin, ...gitArgs(run, ['ls-remote', remote])], { cwd: c.dir, env: gitEnv(run), timeout: 20_000 });
  if (!r.err) return row('ok', id, `ls-remote ${remote} answered (${r.stdout.split('\n').filter(Boolean).length} refs) through the git bridge's profile`);
  const why = r.err.killed ? 'no answer in 20 s' : tail(r);
  return row('fail', id, `ls-remote ${remote}: ${why} — fix: ssh key not loaded / remote unreachable (try git ls-remote ${remote} in your terminal in ${def.path})`);
}

// one folder MCP server: stdio → its command found (absolute, or on the run's PATH: the server's own env PATH, else
// <code>/bin + tbd's), never started; http / sse → a HEAD of the URL's origin answers in 5 s (any status)
async function serverCheck(/** @type {string} */ id, /** @type {any} */ d, /** @type {any} */ c, /** @type {string} */ cwd) {
  const type = d.type ?? 'stdio';
  if (type === 'stdio') {
    const cmd = typeof d.command === 'string' ? d.command : '';
    if (!cmd) return row('fail', id, 'stdio server with no command — fix: claude mcp get <name> in that folder, then add it again');
    const PATH = isObj(d.env) && typeof d.env.PATH === 'string' ? d.env.PATH : `${path.join(CODE, 'bin')}:${c.env.PATH ?? '/usr/bin:/bin'}`;
    const where = cmd.includes('/') ? [path.resolve(cwd, cmd)] : PATH.split(':').filter((p) => path.isAbsolute(p)).map((p) => path.join(p, cmd));
    for (const f of where) if (await exists(f, fsp.constants.X_OK)) return row('ok', id, `stdio: ${path.basename(cmd)} found (${f})`);
    return row('fail', id, `stdio: ${path.basename(cmd)} not found on the run's PATH — fix: install it, or give its full path (claude mcp add)`);
  }
  if (type === 'http' || type === 'sse') {
    let u = null;
    try { u = new URL(d.url); } catch { /* below */ }
    if (!u || !['http:', 'https:'].includes(u.protocol)) return row('fail', id, `${type}: its url is not an http(s) URL — fix: claude mcp get <name>`);
    const t0 = Date.now();
    try {
      const res = await fetch(u.origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return row('ok', id, `${type}: ${u.host} answered (HTTP ${res.status}) in ${Date.now() - t0} ms`);
    } catch (e) {
      return row('fail', id, `${type}: ${u.host} did not answer in 5 s (${e.name}) — fix: check the network or VPN, or the server's url`);
    }
  }
  return row('warn', id, `type ${String(type).slice(0, 20)}: not checked`);
}

// the folder MCP servers a run of the tag loads (a git tag: .mcp.json at its base branch tip, as a new ticket would get it)
async function mcpChecks(/** @type {string} */ name, /** @type {any} */ def, /** @type {any} */ c) {
  let t = {};
  if (def.type === 'git') {
    const r = await git(def.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${def.base}^{commit}`]);
    t = r.err ? {} : { worktree: def.path, base_sha: r.stdout.trim() };
  }
  const fm = await spawn.folderMcp(t, def, def.path, c.env, c.home, c.cj);
  const out = [];
  for (const [srv, d] of Object.entries(fm.servers)) out.push(await serverCheck(`mcp:${name}:${srv.slice(0, 64)}`, d, c, def.path)); // one at a time
  return out;
}

async function chromeCheck(/** @type {any} */ c) {
  const app = c.env.TB_CHROME_APP || '/Applications/Google Chrome.app'; // TB_CHROME_APP: test knob (chromeProfile runs only this path)
  if (!(await exists(app))) return row('warn', 'tb-chrome', 'Google Chrome is not installed: skipped (runs have no browser checks)');
  if (!c.wall) return row('warn', 'tb-chrome', 'full_access_wall is off: runs have no tb-chrome (skipped)');
  const pressure = c.system?.()?.pressure;
  if (pressure !== 'normal') return row('warn', 'tb-chrome', `memory pressure is ${pressure ?? 'not read yet'}: Chrome not started (skipped); check again when it is normal`);
  const sb = path.join(c.dir, 'runs', 'chrome.sb'); // tb-chrome names its session after <dir>, as tb-<ticket> in a run
  const port = spawn.chromePort(path.basename(c.dir));
  await fsp.mkdir(path.dirname(sb), { mode: 0o700 });
  await fsp.writeFile(sb, chromeProfile(c.sandbox, { home: c.home, cwd: c.dir, node: process.execPath, ports: [port, port + 1] }), { mode: 0o600, flag: 'wx' });
  const env = { ...claudeEnv(c.env), TB_CHROME_SB: sb, TB_CHROME_PORTS: `${port} ${port + 1}`, TB_CHROME_NODE: process.execPath };
  const start = await sh(spawn.TB_CHROME, ['start'], { cwd: c.dir, env, timeout: 60_000 });
  const stop = await sh(spawn.TB_CHROME, ['stop'], { cwd: c.dir, env, timeout: 20_000 });
  if (start.err) return row('fail', 'tb-chrome', `start: ${tail(start)} — fix: npm ci --ignore-scripts --prefix ${path.join(CODE, 'tools', 'chrome')}, then check again`);
  if (stop.err) return row('warn', 'tb-chrome', `started, but stop said: ${tail(stop)}`);
  return row('ok', 'tb-chrome', 'started and stopped under the run wall\'s browser profile');
}

async function skillsCheck(/** @type {string} */ home) {
  const n = (await listSkills(null, home)).length;
  return n ? row('ok', 'skills', `${n} skills found (~/.claude/skills and enabled plugins)`)
    : row('warn', 'skills', 'no skills in ~/.claude/skills or an enabled plugin: runs list none');
}

async function nodeCheck(/** @type {any} */ c) {
  if (!c.wall) return row('warn', 'wall:node', 'full_access_wall is off in config.json: runs have no seatbelt wall (skipped)');
  const profile = chromeProfile(c.sandbox, { home: c.home, cwd: c.dir, node: process.execPath, ports: [] });
  const r = await sh('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-v'], { cwd: c.dir, env: claudeEnv(c.env), timeout: 20_000 });
  const v = r.err ? '' : r.stdout.trim();
  return /^v\d+\.\d+\.\d+$/.test(v) ? row('ok', 'wall:node', `node -v → ${v} under the wall's profile`)
    : row('fail', 'wall:node', `node -v under the wall's profile: ${tail(r)} — fix: the wall blocks ${process.execPath}; check full_access_wall and the node path (D30)`);
}

// the option's lines in claude --help: its line (indent ≤ 4) + the wrapped ones (indent ≥ 5; one may start --print)
const option = (/** @type {string} */ help, /** @type {string} */ flag) => new RegExp(`^ {0,4}${flag}\\b.*(?:\\n {5,}.*)*`, 'm').exec(help)?.[0] ?? '';
async function claudeCheck(/** @type {any} */ store, /** @type {any} */ env) {
  const bin = String(store.config.claude_bin ?? '');
  const r = await sh(bin, ['--help'], { env: claudeEnv(env), cwd: os.tmpdir(), timeout: 20_000 });
  const name = path.basename(bin);
  if (r.err && !r.stdout) return row('fail', 'claude', `${name} --help: ${tail(r)} — fix: tb doctor --pin`);
  const miss = [['--permission-mode', 'auto'], ['--permission-prompts', 'host']].filter(([f, v]) => !option(r.stdout, f).includes(`"${v}"`)).map(([f, v]) => `${f} ${v}`);
  return miss.length ? row('fail', 'claude', `${name} --help lists no ${miss.join(' or ')} — fix: pin a newer claude (tb doctor --pin --version <x.y.z>)`)
    : row('ok', 'claude', `${name}: --permission-mode auto and --permission-prompts host listed`);
}

const switches = (/** @type {any} */ store) => row('ok', 'switches', SWITCHES.map((k) => `${k} ${store.config.terminal?.[k] === true ? 'on' : 'off'}`).join(', '));

async function fixed(/** @type {any} */ deps) {
  const { store, env, home, tbHome, system } = deps;
  const dir = await fsp.mkdtemp(path.join(tbHome, 'tcheck-'));
  try {
    const { sandbox, wall } = wallOf(store, env, tbHome, dir);
    const c = { env, home, dir, sandbox, wall, system, ssh: env.SSH_AUTH_SOCK ? await fsp.realpath(env.SSH_AUTH_SOCK).catch(() => '') : '',
      fileRemote: spawn.fileRemote(env, tbHome), // spawn's knob (tests): one local remote, never for the live ~/.taskboard
      cj: await readPlain(path.join(home, '.claude.json'), 20 << 20, true) }; // L-cj: read once for every tag's folderMcp
    const tags = Object.entries(store.listTags()).filter(([, d]) => isObj(d) && path.isAbsolute(d.path ?? ''));
    const each = async (/** @type {[string, any][]} */ list, /** @type {Function} */ fn) => { // one tag at a time (ssh, http)
      const out = [];
      for (const [n, d] of list) out.push(...[await fn(n, d, c)].flat());
      return out;
    };
    const gits = tags.filter(([, d]) => d.type === 'git');
    const [g, m, ...rest] = await Promise.all([each(gits, gitCheck), each(tags, mcpChecks), chromeCheck(c), skillsCheck(home), nodeCheck(c), claudeCheck(store, env)]);
    const checks = [...(gits.length ? g : [row('warn', 'tb-git', 'no git tag to check')]), ...m, ...rest, switches(store)];
    return { ok: !checks.some((x) => x.status === 'fail'), checks };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const PROMPT = (/** @type {string} */ tbGit, /** @type {string | null} */ prefix) => [
  'This run is the board\'s terminal check, not a code task: ignore the task format above. Do these steps in order, one tool call each, change no file, then stop:',
  '1. Run Bash: echo ok',
  '2. Start one subagent (the Task tool) with the prompt "Reply with the word ok." and wait for its answer.',
  prefix ? `3. Call one MCP tool whose name starts with ${prefix} and then list, get, read, search, query, describe, find, show or echo: the first such name, with the fewest arguments it takes. Call no other MCP tool.`
    : '3. Skip (no folder MCP server).',
  `4. Run Bash, alone in its call: ${tbGit} ls-remote origin`,
  'Then return the structured result: status "done", commit null, tests_added [], notes "terminal check".',
].join('\n');

const textOf = (/** @type {any} */ c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ') : '');
// PASS/FAIL from the stream events only: the init line, each tool_use (assistant) and its tool_result (user)
function verdict(/** @type {any[]} */ events, /** @type {{tbGit: string, prefix: string | null, term: any}} */ { tbGit, prefix, term }) {
  const init = events.find((e) => e?.type === 'system' && e.subtype === 'init') ?? {};
  const result = events.findLast((e) => e?.type === 'result');
  const uses = [], results = new Map();
  for (const e of events) {
    for (const x of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (e.type === 'assistant' && x?.type === 'tool_use' && typeof x.id === 'string') uses.push({ id: x.id, name: String(x.name ?? ''), input: isObj(x.input) ? x.input : {} });
      else if (e.type === 'user' && x?.type === 'tool_result' && typeof x.tool_use_id === 'string') results.set(x.tool_use_id, { error: x.is_error === true, text: textOf(x.content) });
    }
  }
  // name: the check; what: the step in words; pred: its tool_use; okText: its result is right; off: why it may fail
  const step = (/** @type {string} */ name, /** @type {string} */ what, /** @type {(u: any) => boolean} */ pred, okText = (/** @type {string} */ _t) => true, off = '') => {
    const hits = uses.filter(pred);
    const good = hits.find((u) => results.has(u.id) && !results.get(u.id).error && okText(results.get(u.id).text));
    if (good) return row('ok', name, `${what}: ran (${good.name})`);
    const r = hits.length ? results.get(hits[0].id) : null;
    return row('fail', name, `${what}: ${!hits.length ? 'not tried in the run' : r ? `tried, failed: ${r.text.slice(0, 160)}` : 'tried, no result'}${off && ` — ${off}`}`);
  };
  const cmd = (/** @type {any} */ u) => (u.name === 'Bash' && typeof u.input.command === 'string' ? u.input.command.trim() : '');
  const checks = [
    step('live:bash', 'Bash echo ok', (u) => cmd(u) === 'echo ok', (t) => /\bok\b/.test(t)),
    step('live:subagent', 'one subagent', (u) => u.name === 'Task' || u.name === 'Agent'),
  ];
  if (!prefix) checks.push(row('warn', 'live:mcp', `no folder MCP server for this tag: skipped${term.folder_mcp === true ? '' : ' (Folder MCP is off in Settings → Terminal)'}`));
  else {
    const listed = (Array.isArray(init.tools) ? init.tools : []).filter((n) => typeof n === 'string' && n.startsWith(prefix));
    const other = uses.find((u) => u.name.startsWith(prefix) && !READ_ONLY.test(u.name.slice(prefix.length)));
    checks.push(!listed.length ? row('fail', 'live:mcp', `the run listed no ${prefix}* tool — fix: check the server (tb doctor --terminal)`)
      : other ? row('fail', 'live:mcp', `called ${other.name}, which does not look read-only`)
        : step('live:mcp', 'one read-only MCP tool', (u) => u.name.startsWith(prefix)));
  }
  const skills = Array.isArray(init.skills) ? init.skills.length : 0;
  checks.push(Array.isArray(init.tools) && init.tools.includes('Skill') && skills ? row('ok', 'live:skill', `the Skill tool is listed with ${skills} skills`)
    : row('fail', 'live:skill', `the run's init line has ${init.tools?.includes?.('Skill') ? 'the Skill tool but no skills' : 'no Skill tool'}`));
  checks.push(step('live:tb-git', 'tb-git ls-remote origin', (u) => cmd(u).startsWith(`${tbGit} ls-remote`), undefined, term.git_bridge === true ? '' : 'Git Bridge is off in Settings → Terminal'));
  const cost = typeof result?.total_cost_usd === 'number' ? `, $${result.total_cost_usd.toFixed(2)}` : '';
  checks.push(!result ? row('fail', 'live:run', 'no result line: the run ended early (see tbd.log)')
    : row(result.subtype === 'success' ? 'ok' : 'warn', 'live:run', `result ${String(result.subtype).slice(0, 40)}, ${Number(result.num_turns) || 0} turns${cost}`));
  return checks;
}

async function live(/** @type {{tag: string, yes: boolean}} */ o, /** @type {any} */ deps) {
  const { store, env, home, tbHome, runner } = deps;
  const tags = store.listTags();
  const def = Object.hasOwn(tags, o.tag) ? tags[o.tag] : null;
  if (!def) throw bad(`no tag ${o.tag}: tb tag list`);
  if (def.type !== 'git' || !path.isAbsolute(def.path ?? '')) throw bad(`${o.tag} is no git tag: a live run needs one (it tries tb-git ls-remote)`);
  if (!o.yes) return { confirm: true, cost: LIVE_COST };
  if (!runner) throw new TbError(503, 'starting');
  const early = runner.admits('working'); // L-admit: before the clone (oneOff asks again)
  if (early) throw new TbError(409, `live run not started: ${WHY[early] ?? early}`);
  const dir = await fsp.mkdtemp(path.join(tbHome, 'tcheck-')); // the temp ticket dir; its name is the run's id (never a t_ id)
  const id = path.basename(dir);
  let made = null;
  try {
    made = await planning.worktree(id, def); // the clone a ticket gets (its origin with the git bridge on)
    const t = { id, kind: 'code', state: 'working', sandbox: false, tag: o.tag, ...made };
    const cfg = store.config;
    const fm = cfg.terminal?.folder_mcp === true ? await spawn.folderMcp(t, def, made.worktree, env, home) : null;
    const prefix = fm?.rules[0] ? `${fm.rules[0]}__` : null; // spawn's allow rule mcp__<normalized name>
    const config = { ...cfg, models: { ...cfg.models, working: { model: 'sonnet' } }, max_turns: { ...cfg.max_turns, working_task: LIVE_TURNS },
      liveness: { ...cfg.liveness, wall_min: { ...cfg.liveness?.wall_min, working_task: LIVE_WALL_MIN } } };
    const r = await runner.oneOff({ ticket: t, phase: 'working', prompt: PROMPT(spawn.TB_GIT, prefix), config, tag: def, ticketDir: dir, wallMs: LIVE_WALL_MIN * 60_000 });
    if (r.refused) throw new TbError(409, `live run not started: ${WHY[r.refused] ?? r.refused}`);
    const events = String((await readPlain(r.log, 32 << 20)) ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isObj);
    const checks = verdict(events, { tbGit: spawn.TB_GIT, prefix, term: cfg.terminal ?? {} });
    return { ok: !checks.some((x) => x.status === 'fail'), checks, cost: LIVE_COST };
  } finally {
    if (made) await planning.unclone(id, made.worktree, made.common_dir).catch((e) => console.error(`tbd: terminal check ${id}: clone not removed: ${e.message}`));
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function run(/** @type {any} */ input, /** @type {any} */ deps) {
  if (!isObj(input)) throw bad('body must be a JSON object');
  const o = parse(input);
  if (o.live && !o.yes) return live(o, deps); // the cost line: no run, no lock
  if (busy) throw new TbError(409, 'a terminal check is running: wait for it to finish');
  busy = true;
  try {
    return o.live ? await live(o, deps) : await fixed(deps);
  } finally {
    busy = false;
  }
}

module.exports = { run, verdict, LIVE_COST };
