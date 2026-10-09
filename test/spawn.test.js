'use strict';
// P3a AC2 variants of the §9 spawn line (lib/spawn.js in-process, fake-claude as claude_bin, argv/env dump): resume
// uses --resume without --session-id and the §8 resume prompt; Fable gate (§6); a phase with Agent gets no
// --disallowedTools; a phase's own mcp.json is used; config errors spawn nothing; S1: agent-planted Claude config in
// the cwd (ticket dir, or a worktree vs ticket.base_sha) refuses the run before anything is written. The new-run line
// through a real tbd (env from tbd, TBX_RUN registered) is in runner.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
const SCHEMA = { type: 'object', required: ['status'] };
for (const [file, content] of Object.entries({
  'prompt.md': '# working fixture\n',
  'settings.json': { permissions: { allow: ['Read', 'Glob', 'Grep', 'Edit(/${WORKTREE}/**)', 'Bash', 'Agent'] } },
  'result.schema.json': SCHEMA,
  'mcp.json': { mcpServers: {} },
})) {
  fs.mkdirSync(path.join(PHASES, 'code/working'), { recursive: true });
  fs.writeFileSync(path.join(PHASES, 'code/working', file), typeof content === 'string' ? content : JSON.stringify(content));
}
process.env.TB_PHASES_DIR = PHASES; // read by lib/phases + lib/phase-settings at load
require('./helpers/runs').passFakeEnv(); // FAKE_CLAUDE_DUMP_DIR through the claudeEnv allowlist
const spawn = require('../lib/spawn');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SID = '22222222-2222-4222-8222-222222222222';
const CONFIG = {
  claude_bin: FAKE, fable_billing: 'unknown', subagents: { concurrent: 3, depth: 1 },
  models: { working: { model: 'fable', effort: 'high' } }, max_turns: { working_task: 80 }, liveness: { wall_min: { working_task: 45 } },
};

// One spawn.start into a fresh temp dir; err set when it refused (then nothing may have been spawned).
async function attempt({ config = CONFIG, resume = true, ticket = {}, env = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'run-'));
  const tbHome = path.join(dir, 'tbhome');
  const ticketDir = path.join(tbHome, 'tickets', 't_spawn1');
  const dump = path.join(dir, 'dump');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(dump);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ticketDir, f)), { recursive: true });
    fs.writeFileSync(path.join(ticketDir, f), c);
  }
  try {
    const s = await spawn.start({
      ticket: { id: 't_spawn1', kind: 'code', ...ticket }, phase: 'working', n: 2, session: SID, resume, key: 'ef'.repeat(16),
      prompt: spawn.RESUME_PROMPT, config, tbHome, ticketDir, port: 7777,
      env: { PATH: process.env.PATH, HOME: dir, FAKE_CLAUDE_DUMP_DIR: dump, ...env },
    });
    await s.ready;
    await s.done;
    return { d: JSON.parse(fs.readFileSync(path.join(dump, '1.json'), 'utf8')), ticketDir, dump };
  } catch (err) {
    return { err, ticketDir, dump };
  }
}
async function run(opts) {
  const r = await attempt(opts);
  if (r.err) throw r.err;
  return r;
}

test('AC2 resume: --resume <session> and no --session-id, resume prompt verbatim; Fable gate; Agent phase; phase mcp.json; claude env', async () => {
  const base = { ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x', NODE_OPTIONS: '--require /x.js', GH_TOKEN: 'x', TB_HOME: '/x', CLAUDECODE: '1' };
  const { d, ticketDir } = await run({ env: base });
  assert.equal(d.opts['--resume'], SID);
  assert.equal(d.argv.includes('--session-id'), false, 'resume never sends --session-id (§8 step 5)');
  assert.equal(d.prompt, 'Your previous run was interrupted. Check the current state and continue from your last step.');
  assert.deepEqual([d.opts['--model'], d.opts['--effort'], d.opts['--fallback-model']], ['opus', 'xhigh', undefined], 'fable_billing unknown: opus xhigh');
  assert.equal(d.argv.includes('--disallowedTools'), false, 'phase allows Agent');
  assert.equal(d.opts['--tools'], 'Read,Glob,Grep,Edit,Write,Bash,Agent');
  assert.equal(d.opts['--mcp-config'], path.join(PHASES, 'code/working/mcp.json'));
  assert.equal(fs.existsSync(path.join(ticketDir, 'runs/2.mcp.json')), false);
  assert.deepEqual([d.opts['--max-turns'], d.opts['--json-schema']], ['80', JSON.stringify(SCHEMA)], 'working → working_task cap; schema inline');
  assert.equal(d.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(45 * 60_000));
  for (const k of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'GH_TOKEN', 'TB_HOME', 'CLAUDECODE']) assert.equal(k in d.env, false, `${k} dropped`); // S2: no env token
  assert.equal(d.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(ticketDir), 'no worktree yet: ticket dir');
});

test('AC2 Fable gate: fable only with fable_billing plan or credits_ok, then with --fallback-model opus', async () => {
  for (const billing of ['plan', 'credits_ok']) {
    const { d } = await run({ config: { ...CONFIG, fable_billing: billing }, resume: false });
    assert.deepEqual([d.opts['--model'], d.opts['--effort'], d.opts['--fallback-model'], d.opts['--session-id']], ['fable', 'high', 'opus', SID], billing);
  }
});

test('config errors spawn nothing: no model, no turn cap, worktree not absolute, schema not an object', async (t) => {
  /** @type {[any, RegExp][]} */
  const cases = [
    [{ config: { ...CONFIG, models: {} } }, /config\.models\.working\.model is missing/],
    [{ config: { ...CONFIG, max_turns: { working_task: 0 } } }, /max_turns\.working_task must be a positive integer/],
    [{ ticket: { worktree: '~/.taskboard/worktrees/t_spawn1' } }, /ticket\.worktree must be an absolute path/], // never the ticket dir instead
  ];
  const check = (r, re) => {
    assert.match(r.err?.message ?? 'no error', re);
    assert.deepEqual(fs.readdirSync(r.dump), [], 'never spawned');
    assert.equal(fs.existsSync(path.join(r.ticketDir, 'runs/2.jsonl')), false);
  };
  for (const [opts, re] of cases) check(await attempt(opts), re);
  fs.writeFileSync(path.join(PHASES, 'code/working/result.schema.json'), '[]');
  t.after(() => fs.writeFileSync(path.join(PHASES, 'code/working/result.schema.json'), JSON.stringify(SCHEMA)));
  check(await attempt(), /result\.schema\.json must hold a JSON object/);
});

// S1 layer 2. Every refusal: the message names the file, nothing written, nothing spawned (new run and resume alike).
const refused = (r, re) => {
  assert.match(r.err?.message ?? 'no error', re);
  assert.deepEqual(fs.readdirSync(r.dump), [], 'never spawned');
  assert.equal(fs.existsSync(path.join(r.ticketDir, 'runs')), false, 'nothing written');
};

test('S1 ticket dir as cwd: a .claude dir, CLAUDE.md or CLAUDE.local.md (any case) refuses the run; a clean ticket dir runs', async () => {
  /** @type {[string, boolean][]} */
  const cases = [['.claude/settings.json', true], ['CLAUDE.md', false], ['claude.local.md', true], ['.claude/.cc-writes/CLAUDE.md', false]];
  for (const [f, resume] of cases) {
    refused(await attempt({ resume, files: { [f]: '{}' } }), new RegExp(`has ${f.split('/')[0].replaceAll('.', '\\.')}: agent-planted config, remove by hand`, 'i')); // APFS: any case
  }
  const ok = await attempt({ files: { 'out/claude.ts': 'x', 'notes.md': 'x' } });
  assert.equal(ok.err, undefined, 'look-alikes are not config');
  assert.equal((await attempt({ files: { '.claude/.cc-writes/tmp': 'x' } })).err, undefined, "claude's own sandbox write staging (2.1.295) is not planted");
  refused(await attempt({ files: { '.claude/.cc-writes/tmp': 'x', '.claude/settings.json': '{}' } }), /has \.claude: agent-planted config/);
});

test('S1 worktree as cwd: config changed since base_sha (tracked, untracked, ignored, nested, committed) or no base_sha refuses; the base\'s own config runs', async () => {
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
  const put = (f, c = 'x') => { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), c); };
  git('init', '-q');
  put('.claude/settings.json', '{}');
  put('CLAUDE.md', 'repo notes');
  put('.gitignore', 'ignored/\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base_sha = git('rev-parse', 'HEAD');
  put('src/a.js'); // dirty, but no config
  put('.claude/.cc-writes/tmp'); // claude's own sandbox write staging (2.1.295), untracked
  const ok = await attempt({ ticket: { worktree: wt, base_sha } });
  assert.equal(ok.err, undefined, 'unchanged base config + other dirty files run');
  assert.equal(fs.realpathSync(ok.d.cwd), fs.realpathSync(wt));

  refused(await attempt({ ticket: { worktree: wt } }), /ticket\.base_sha missing/);
  /** @type {[() => void, string][]} */
  const plants = [
    [() => put('.claude/settings.json', '{"hooks":{}}'), '.claude/settings.json'], // tracked, changed
    [() => put('pkg/.Claude/skills/x/SKILL.md'), 'pkg/.Claude/skills/x/SKILL.md'], // untracked, nested, other case
    [() => put('ignored/CLAUDE.local.md'), 'ignored/CLAUDE.local.md'], // ignored still counts
    [() => put('.claude/.cc-writes/sub/x.json'), '.claude/.cc-writes/sub/x.json'], // staging holds depth-1 files only
    [() => { put('lib/CLAUDE.md'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'agent'); }, 'lib/CLAUDE.md'],
  ];
  for (const [plant, f] of plants) {
    plant();
    refused(await attempt({ ticket: { worktree: wt, base_sha } }), new RegExp(`${f.replaceAll('.', '\\.')}.*agent-planted config, remove by hand`));
    git('reset', '-q', '--hard', base_sha);
    git('clean', '-qfdx');
  }
});
