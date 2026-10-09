'use strict';
// P3a (plan P3 AC1 AC2 AC3, contract T1 T3 T7): lib/runner.js + spawn.js + stream.js inside a real tbd (harness temp
// HOME + TB_HOME), test/fake-claude.js as config.claude_bin, fixture phases via TB_PHASES_DIR (D9: never in phases/).
// test/helpers/run-spy.js: fixture handlers, launchctl spy (no real launchctl), kills only of this test's fake-claude
// process groups. Every process a test starts is reaped in t.after, and only if it runs this repo's test code.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startTbd, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, NOW, ticket, read, lines, hasRun, spyLog, until, alive, command, reap, pidsOf } = require('./helpers/runs');
const { call } = require('../lib/slots');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const SCHEMA = { type: 'object' };
const HANG = path.join(ROOT, 'hang.json'); // T7 variant: SIGINT ignored
fs.writeFileSync(HANG, JSON.stringify({ steps: [{ hang: 'ignore_sigint' }] }));
const HANG_TERM = path.join(ROOT, 'hang-term.json'); // INT, TERM, HUP ignored: only SIGKILL ends it
fs.writeFileSync(HANG_TERM, JSON.stringify({ steps: [{ hang: 'ignore_term' }] }));

// Fixture phases: code/planning built (read-only: --disallowedTools Agent); code/qa misconfigured (prompt.md, no
// schema: D9 → Blocked, never spawned); code/review absent (unbuilt: waiting manual).
const PHASES = path.join(ROOT, 'phases');
for (const [key, files] of Object.entries({
  'code/planning': { 'prompt.md': '# planning fixture\n', 'settings.json': { permissions: { allow: ['Read', 'Glob', 'Grep'] } }, 'result.schema.json': SCHEMA },
  'code/qa': { 'prompt.md': '# qa fixture\n', 'settings.json': { permissions: { allow: ['Read'] } } },
})) {
  fs.mkdirSync(path.join(PHASES, key), { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(PHASES, key, f), typeof c === 'string' ? c : JSON.stringify(c));
}

// Admission always yes (unless critical pressure): this 8 GB Mac's free RAM must not decide a test. P3b: a counted
// failure blocks at once here (max_failures_per_phase 0), so these P3a tests see one run per ticket; recovery with the
// default 3: test/recovery-tbd.test.js.
const CONFIG = {
  claude_bin: FAKE, recovery: { max_failures_per_phase: 0 },
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};

const env = (extra = {}) => ({ TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: 'scenario.json', ...extra }); // scenario: <cwd>/scenario.json
function seed(tickets, { config = {}, files = {} } = {}) {
  const out = { 'config.json': { ...CONFIG, ...config }, ...files };
  for (const [id, { scenario, files: own = {}, ...over }] of Object.entries(tickets)) {
    out[`tickets/${id}/ticket.json`] = ticket(id, over);
    if (scenario) out[`tickets/${id}/scenario.json`] = scenario;
    for (const [f, c] of Object.entries(own)) out[`tickets/${id}/${f}`] = c;
  }
  return out;
}
async function boot(t, tickets, opts = {}) {
  const tbd = await startTbd({ files: seed(tickets, opts), env: env(opts.env) });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return tbd;
}

test('AC1 outcomes from the last result line: crash, invalid JSON, max turns, schema_fail, refusal, result (usage limit: recovery-tbd); T1 + D9 gates; P3b next step', async (t) => {
  const tbd = await boot(t, {
    t_crash1: { scenario: { steps: [{ emit: { type: 'assistant', message: { role: 'assistant', content: [] } } }, { crash: 3 }] } },
    t_ijson1: { scenario: { steps: ['invalid_json'] } },
    t_maxt01: { scenario: { steps: ['max_turns'] } },
    t_schem1: { scenario: { steps: ['schema_fail'] } },
    t_refus1: { scenario: { steps: ['refusal'] } },
    t_okres1: { scenario: { steps: [{ result: { structured_output: { answer: 'ok' } } }] } },
    t_next01: { scenario: { steps: [{ result: { structured_output: { next: 'blocked' } } }] } },
    t_throw1: { scenario: { steps: [{ result: { structured_output: { throw: 'handler bug' } } }] } }, // handler throws → blocked
    t_refsd1: { scenario: { steps: [{ result: { structured_output: { next: 'plan_approval' } } }] } }, // guard plan_valid missing → blocked
    t_unblt1: { state: 'review' }, // phase not built: waits on Irfan
    t_mscfg1: { state: 'qa' }, // prompt.md without schema/handler: Blocked, never spawned
    t_backl1: { state: 'backlog' }, // not an agent phase
  });
  // usage limit: test/recovery-tbd.test.js (its pause would hold every later start here)
  const ran = ['t_crash1', 't_ijson1', 't_maxt01', 't_schem1', 't_refus1', 't_okres1', 't_next01', 't_throw1', 't_refsd1'];
  const blocked = ['t_crash1', 't_ijson1', 't_maxt01', 't_schem1', 't_refus1']; // P3b: what follows these outcomes
  await until(() => ran.every((id) => read(tbd, id).lease?.exit) && blocked.every((id) => read(tbd, id).state === 'blocked'), 60_000, 'every run ended');
  assert.deepEqual(Object.fromEntries(ran.map((id) => [id, read(tbd, id).lease.exit])), {
    t_crash1: 'crash', t_ijson1: 'schema_fail', t_maxt01: 'max_turns', t_schem1: 'schema_fail', t_refus1: 'refusal',
    t_okres1: 'result', t_next01: 'result', t_throw1: 'result', t_refsd1: 'result',
  });
  const l = read(tbd, 't_okres1').lease;
  assert.deepEqual([l.gen, l.pgid, l.phase, l.log, l.task, l.tool], [1, l.pid, 'planning', 'runs/1.jsonl', null, null]);
  assert.match(l.session, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isInteger(l.pid) && l.started_at <= l.ended_at);
  // result → phase handler; its next state applied by the fsm, or the ticket stays
  assert.deepEqual(spyLog(tbd, 'test-handled.jsonl').map((h) => h.id).sort(), ['t_next01', 't_okres1', 't_refsd1', 't_throw1']);
  for (const id of ['t_next01', 't_throw1', 't_refsd1']) assert.deepEqual([read(tbd, id).state, read(tbd, id).blocked_from], ['blocked', 'planning'], id);
  assert.match(tbd.stderr(), /t_throw1: code\/planning result not taken: handler bug/);
  assert.match(tbd.stderr(), /t_refsd1: code\/planning result not taken: guard plan_valid unavailable/);
  assert.equal(read(tbd, 't_okres1').state, 'planning');
  // T1 negatives
  assert.deepEqual(read(tbd, 't_unblt1').waiting?.reason, 'manual');
  assert.equal(read(tbd, 't_mscfg1').state, 'blocked');
  for (const id of ['t_unblt1', 't_mscfg1', 't_backl1']) assert.equal(fs.existsSync(path.join(tbd.tbHome, 'tickets', id, 'runs')), false, `${id} never spawned`);
  assert.equal(read(tbd, 't_backl1').lease, null);
  // P3b (contract change; was "an ended lease in its phase is P3b's: no second run"): a counted failure past
  // max_failures_per_phase (0 here) and max_turns → Blocked at once; schema_fail → resumed once, then Blocked; a
  // result that kept the phase → no second run. P4 AC7 / U7 (contract change; was "refusal → Blocked at once"): a
  // refusal on fable (the planning default) → one fresh run on opus xhigh, not counted; it refuses too → Blocked.
  await new Promise((r) => setTimeout(r, 2500));
  const second = ['t_ijson1', 't_schem1'];
  const opus = ['t_refus1'];
  for (const id of ran) assert.equal(hasRun(tbd, id, 2), [...second, ...opus].includes(id), `${id}: a second run only for the schema retry or the opus re-run`);
  for (const id of second) assert.deepEqual([read(tbd, id).lease.resumed, read(tbd, id).lease.schema_retry, read(tbd, id).failures], [true, true, {}], id);
  for (const id of opus) assert.deepEqual([read(tbd, id).lease.resumed, read(tbd, id).lease.opus, read(tbd, id).lease.model, read(tbd, id).failures], [undefined, true, 'opus', {}], id);
  assert.deepEqual(read(tbd, 't_crash1').failures, { planning: 1 });
  // D37 positive: launchd checked after every run, job loaded → no alert
  const uid = process.getuid();
  assert.equal(spyLog(tbd, 'test-exec.jsonl').filter((e) => e.file === '/bin/launchctl' && e.args.join(' ') === `print gui/${uid}/local.taskboard`).length, ran.length + second.length + opus.length);
  assert.deepEqual(spyLog(tbd, 'test-alerts.jsonl'), []);
});

test('T1 admission refused → ticket.waiting says why, nothing spawned', async (t) => {
  const tbd = await boot(t, { t_disk01: {} }, { config: { disk: { warn_gb: 0, stop_gb: 1e9 } } });
  await until(() => read(tbd, 't_disk01').waiting?.reason === 'disk', 10_000, 'waiting disk'); // 'memory' first: no monitor sample yet
  assert.equal(read(tbd, 't_disk01').lease, null);
  assert.equal(fs.existsSync(path.join(tbd.tbHome, 'tickets/t_disk01/runs')), false);
});

test('spawn failure (claude_bin missing) → lease exit crash, pid null, the error kept; no retry (P3b: counted, Blocked at max 0); agent-planted config → Blocked at once, not counted, the file named (R17)', async (t) => {
  const tbd = await boot(t, { t_nobin1: {}, t_plant1: { files: { 'CLAUDE.md': '# planted\n' } } }, { config: { claude_bin: path.join(ROOT, 'no-such-claude') } });
  const l = await until(() => read(tbd, 't_plant1').state === 'blocked' && read(tbd, 't_nobin1').state === 'blocked' && read(tbd, 't_nobin1').lease, 10_000, 'crash recorded');
  const p = read(tbd, 't_plant1');
  assert.deepEqual([p.lease.exit, p.lease.gen, p.failures, /has CLAUDE\.md: agent-planted config/.test(p.lease.error)], ['crash', 1, {}, true], 'R17: no recovery, no count');
  assert.ok(spyLog(tbd, 'test-alerts.jsonl').some((a) => a.title === 'Run refused: agent-planted config' && /CLAUDE\.md/.test(a.message)), 'R17: Irfan is told which file');
  assert.deepEqual([l.exit, l.pid, l.gen, read(tbd, 't_nobin1').failures], ['crash', null, 2, { planning: 1 }], 'gen 2: the recovery\'s compare-and-swap');
  assert.match(l.error, /ENOENT/);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(fs.existsSync(path.join(tbd.tbHome, 'tickets/t_nobin1/runs/2.prompt')), false, 'no second attempt');
});

test('AC2 + AC3: §9 argv and env through tbd (removed keys absent, TBX_RUN live then dropped); an agent git push fails (real git)', async (t) => {
  const g = fs.mkdtempSync(path.join(ROOT, 'git-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const [bare, clone, tag, dump] = ['remote.git', 'clone', 'docs', 'dump'].map((d) => path.join(g, d));
  git('init', '-q', '--bare', '-b', 'main', bare);
  git('init', '-q', '-b', 'main', clone);
  git('-C', clone, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
  git('-C', clone, 'add', 'a.txt');
  git('-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a');
  fs.mkdirSync(tag);
  fs.mkdirSync(dump);
  const secrets = { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 'x', SSH_AUTH_SOCK: '/tmp/x.sock', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const oauth = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x' }; // S2: dropped too, runs log in through the claude.ai keychain entry
  const tbd = await boot(t, {
    t_argv01: { tag: 'acme/docs', scenario: { steps: [{ exec: ['git', '-C', clone, 'push', 'origin', 'HEAD:main'] }, { sleep_ms: 2500 }, { result: { structured_output: {} } }] } },
  }, { files: { 'tags.json': { acme: {}, 'acme/docs': { path: tag, type: 'folder' } } }, env: { FAKE_CLAUDE_DUMP_DIR: dump, ...secrets, ...oauth } });
  const lease = await until(() => read(tbd, 't_argv01').lease?.pid && read(tbd, 't_argv01').lease, 15_000, 'lease saved');
  const d = await until(() => fs.existsSync(path.join(dump, '1.json')) && JSON.parse(fs.readFileSync(path.join(dump, '1.json'), 'utf8')), 5000, 'dump');
  const tk = path.join(tbd.tbHome, 'tickets', 't_argv01');
  assert.deepEqual(d.argv, [
    '-p', '--session-id', lease.session, '--setting-sources', 'project', '--settings', path.join(tk, 'runs/1.settings.json'),
    '--append-system-prompt-file', path.join(PHASES, 'code/planning/prompt.md'), '--add-dir', path.join(tk, 'skills'), '--add-dir', tag,
    '--strict-mcp-config', '--mcp-config', path.join(tk, 'runs/1.mcp.json'), '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Agent',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'fable', '--effort', 'high', '--fallback-model', 'opus',
    '--max-turns', '60', '--json-schema', JSON.stringify(SCHEMA), '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tk, 'runs/1.mcp.json'), 'utf8')), { mcpServers: {} });
  const settings = fs.readFileSync(path.join(tk, 'runs/1.settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(settings).permissions.allow, ['Read', 'Glob', 'Grep']);
  assert.doesNotMatch(settings, /\$\{/);
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(tk), 'folder tag: cwd = ticket dir');
  assert.equal(d.prompt, '# run t_argv01\n\ndo the thing\n', 'prompt = ticket.md render, on stdin from runs/1.prompt');
  const want = {
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(30 * 60_000), BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000',
    DISABLE_AUTOUPDATER: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'url.no-push://.pushInsteadOf', GIT_CONFIG_VALUE_1: '', TBD_SOCK: path.join(tbd.tbHome, 'tbd.sock'),
  };
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, d.env[k]])), want);
  for (const k of [...Object.keys(secrets), ...Object.keys(oauth), 'TB_HOME', 'TB_PORT', 'TB_PHASES_DIR', 'NODE_OPTIONS']) assert.equal(k in d.env, false, `${k} removed`);
  assert.deepEqual(fs.readdirSync(d.env.GH_CONFIG_DIR), [], 'GH_CONFIG_DIR empty');
  assert.ok(d.env.PATH.startsWith(path.join(REPO, 'bin') + ':'), 'tbx first on PATH');
  // T3: TBX_RUN is the run's registered slots key while it lives, unknown once it ended
  assert.match(d.env.TBX_RUN, /^[0-9a-f]{32}$/);
  const sock = path.join(tbd.tbHome, 'tbd.sock');
  assert.deepEqual(await call(sock, { op: 'subagent.request', session: lease.session, run: d.env.TBX_RUN }, { timeoutMs: 2000 }), { ok: true, used: 1 });
  // lstart lands in a later save than pid (fillLstart, after ps lists the pid): wait for it, then check its form
  const { lstart } = await until(() => read(tbd, 't_argv01').lease?.lstart && read(tbd, 't_argv01').lease, 5000, 'lstart saved');
  assert.match(lstart, /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/, 'C-locale ps lstart');
  await until(() => read(tbd, 't_argv01').lease.exit, 15_000, 'run ended');
  assert.equal(read(tbd, 't_argv01').lease.exit, 'result');
  assert.deepEqual(await call(sock, { op: 'subagent.request', session: lease.session, run: d.env.TBX_RUN }, { timeoutMs: 2000 }),
    { ok: false, error: 'unknown run key (wrong, or the run ended)' });
  // AC3: the agent's push failed in the child env; the same push from a normal env works (the remote is pushable)
  const ex = lines(path.join(tk, 'runs/1.jsonl')).find((e) => e.subtype === 'fake_exec');
  assert.notEqual(ex.status, 0);
  assert.match(ex.stderr, /no-push/);
  assert.throws(() => git('--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main'), 'nothing reached the remote');
  git('-C', clone, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(git('--git-dir', bare, 'rev-parse', 'refs/heads/main'), git('-C', clone, 'rev-parse', 'HEAD'));
});

test('AC1 daemon restart: tbd SIGTERM leaves the run alive; the next tbd re-attaches by pid + lstart and takes the outcome from the log', async (t) => {
  const files = seed({ t_reatt1: { scenario: { steps: [{ emit: { type: 'system', subtype: 'status' } }, { sleep_ms: 5000 }, { result: { structured_output: { answer: 'late' } } }] } } });
  const tbd1 = await startTbd({ files, env: env() });
  let tbd2 = null;
  t.after(async () => {
    reap(pidsOf(tbd1));
    await tbd1.stop({ keep: true });
    await tbd2?.stop({ keep: true });
    fs.rmSync(tbd1.root, { recursive: true, force: true });
  });
  const l1 = await until(() => read(tbd1, 't_reatt1').lease?.lstart && read(tbd1, 't_reatt1').lease, 15_000, 'lease saved');
  assert.equal((await tbd1.stop({ keep: true })).code, 0);
  assert.ok(alive(l1.pid), 'the run outlived tbd');
  assert.equal(read(tbd1, 't_reatt1').lease.exit, undefined, 'tbd stopping is not a run end');
  tbd2 = await startTbd({ root: tbd1.root, env: env() });
  const l2 = await until(() => read(tbd2, 't_reatt1').lease.exit && read(tbd2, 't_reatt1').lease, 20_000, 'outcome after re-attach');
  assert.deepEqual([l2.exit, l2.gen, l2.pid, l2.lstart, l2.session], ['result', 1, l1.pid, l1.lstart, l1.session]);
  assert.deepEqual(spyLog(tbd2, 'test-handled.jsonl').map((h) => h.output), [{ answer: 'late' }]);
  assert.equal(hasRun(tbd2, 't_reatt1', 2), false, 'same run, not a new one');
});

test('AC1 + T3: dead pid without result → interrupted; a live pid with another start time is not the run: interrupted, its group never killed', async (t) => {
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => gone.on('exit', r));
  const x = spawn(FAKE, [], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: ROOT, FAKE_CLAUDE_SCENARIO: HANG } }); // own group, like a run
  x.unref();
  t.after(() => reap([x.pid]));
  await until(() => command(x.pid).includes('fake-claude'), 5000, 'foreign process up');
  const lease = (pid, lstart) => ({
    gen: 1, pid, lstart, pgid: pid, phase: 'planning', task: null, session: '33333333-3333-4333-8333-333333333333', log: 'runs/1.jsonl',
    started_at: NOW, last_event_at: NOW, tool: null, slot_wait_ms: 0, subagents_alive: 0, subagents_spawned: 0,
  });
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: '33333333-3333-4333-8333-333333333333' }) + '\n';
  const tbd = await boot(t, {
    t_dead01: { lease: lease(gone.pid, 'Thu Oct  8 00:00:00 2026'), files: { 'runs/1.jsonl': init } },
    t_forgn1: { lease: lease(x.pid, 'Thu Jan  1 00:00:00 1970'), files: { 'runs/1.jsonl': init } }, // pid reused since
  });
  await until(() => read(tbd, 't_dead01').lease.exit && read(tbd, 't_forgn1').lease.exit, 10_000, 'both ended');
  assert.deepEqual([read(tbd, 't_dead01').lease.exit, read(tbd, 't_forgn1').lease.exit], ['interrupted', 'interrupted']);
  await new Promise((r) => setTimeout(r, 1500)); // a kill would be async (spy checks ps first)
  assert.ok(alive(x.pid), 'foreign group untouched');
  assert.deepEqual(spyLog(tbd, 'test-kills.jsonl'), [], 'no kill attempted');
  assert.match(tbd.stderr(), new RegExp(`not killing group ${x.pid}: pid ${x.pid} is another process now`));
  for (const id of ['t_dead01', 't_forgn1']) assert.equal(hasRun(tbd, id, 2), false, `${id}: recovery is P3b's`);
});

test('T3 run end: what is left in the run group is killed; launchd job not loaded → alert (D37)', async (t) => {
  const leftover = { background: [process.execPath, FAKE], env: { FAKE_CLAUDE_SCENARIO: HANG } };
  const tbd = await boot(t, { t_left01: { scenario: { steps: [leftover, { result: { structured_output: {} } }] } } }, { env: { TEST_LAUNCHD: 'missing' } });
  const l = await until(() => read(tbd, 't_left01').lease?.exit && read(tbd, 't_left01').lease, 15_000, 'run ended');
  const child = lines(path.join(tbd.tbHome, 'tickets/t_left01/runs/1.jsonl')).find((e) => e.subtype === 'fake_child').pid;
  t.after(() => reap([child]));
  await until(() => !alive(child), 10_000, 'leftover child killed');
  await new Promise((r) => setTimeout(r, 2500)); // the grace: no SIGKILL once SIGTERM emptied the group
  assert.deepEqual(spyLog(tbd, 'test-kills.jsonl'), [{ who: 'runner', pid: -l.pgid, sig: 'SIGTERM', ok: true }]);
  assert.deepEqual(spyLog(tbd, 'test-alerts.jsonl').map((a) => a.title), ['tbd not loaded in launchd']);
  assert.deepEqual(spyLog(tbd, 'test-exec.jsonl'), [{ file: '/bin/launchctl', args: ['print', `gui/${process.getuid()}/local.taskboard`] }]);
});

test('T3 run end: a heavy-slot command group of the finished run (tbx heavy, TERM ignored) is SIGKILLed after the grace', async (t) => {
  const pidFile = path.join(ROOT, 'heavy.pid');
  const tbx = { background: [process.execPath, path.join(REPO, 'bin', 'tbx'), 'heavy', '--', `echo $$ > ${pidFile}; exec "${process.execPath}" "${FAKE}"`], env: { FAKE_CLAUDE_SCENARIO: HANG_TERM } };
  const tbd = await boot(t, { t_heavy1: { scenario: { steps: [{ sleep_ms: 1500 }, tbx, { sleep_ms: 2500 }, { result: { structured_output: {} } }] } } }); // 1.5 s: root registered first
  const heavy = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')), 15_000, 'heavy command up');
  t.after(() => reap([heavy]));
  assert.match(command(heavy), /fake-claude/);
  await until(() => read(tbd, 't_heavy1').lease?.exit, 15_000, 'run ended');
  await until(() => !alive(heavy), 10_000, 'heavy group gone');
  const kills = spyLog(tbd, 'test-kills.jsonl').filter((k) => k.who === 'slots');
  assert.deepEqual(kills.map((k) => [k.pid, k.sig, k.ok]), [[-heavy, 'SIGTERM', true], [-heavy, 'SIGKILL', true]]);
});

test('T3 run end: heavy group whose leader dies on SIGTERM but a member ignores it → the member is SIGKILLed', async (t) => {
  const [leaderFile, memberFile] = [path.join(ROOT, 'heavy2.leader'), path.join(ROOT, 'heavy2.member')];
  const cmd = `echo $$ > ${leaderFile}; "${process.execPath}" "${FAKE}" & echo $! > ${memberFile}; wait`; // sh leads, dies on TERM
  const tbx = { background: [process.execPath, path.join(REPO, 'bin', 'tbx'), 'heavy', '--', cmd], env: { FAKE_CLAUDE_SCENARIO: HANG_TERM } };
  const tbd = await boot(t, { t_heavy2: { scenario: { steps: [{ sleep_ms: 1500 }, tbx, { sleep_ms: 2500 }, { result: { structured_output: {} } }] } } });
  const member = await until(() => fs.existsSync(memberFile) && Number(fs.readFileSync(memberFile, 'utf8')), 15_000, 'member up');
  const leader = Number(fs.readFileSync(leaderFile, 'utf8'));
  t.after(() => reap([member, leader]));
  await until(() => read(tbd, 't_heavy2').lease?.exit, 15_000, 'run ended');
  await until(() => !alive(member), 10_000, 'member gone');
  const kills = spyLog(tbd, 'test-kills.jsonl').filter((k) => k.who === 'slots');
  assert.deepEqual(kills.map((k) => [k.pid, k.sig, k.ok]), [[-leader, 'SIGTERM', true], [-leader, 'SIGKILL', true]]);
});

test('gap a: an intent lease (pid null, tbd died before the pid was saved) → the run is adopted by its session id; none found → interrupted', async (t) => {
  const [sidLive, sidGone] = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-'));
  const tk = path.join(root, 'tbhome/tickets/t_adopt1');
  fs.mkdirSync(path.join(tk, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(tk, 'scenario.json'), JSON.stringify({ steps: [{ sleep_ms: 2500 }, { result: { structured_output: { answer: 'adopted' } } }] }));
  const out = fs.openSync(path.join(tk, 'runs/1.jsonl'), 'w');
  const x = spawn(FAKE, ['-p', '--session-id', sidLive, '--output-format', 'stream-json'], { // as the dead tbd spawned it
    cwd: tk, detached: true, stdio: ['ignore', out, 'ignore'], env: { PATH: process.env.PATH, HOME: root, FAKE_CLAUDE_SCENARIO: 'scenario.json' },
  });
  fs.closeSync(out);
  x.unref();
  t.after(() => reap([x.pid]));
  const intent = (session) => ({
    gen: 1, pid: null, lstart: '', pgid: null, phase: 'planning', task: null, session, log: 'runs/1.jsonl',
    started_at: NOW, last_event_at: NOW, tool: null, slot_wait_ms: 0, subagents_alive: 0, subagents_spawned: 0,
  });
  const tbd = await startTbd({ root, files: seed({ t_adopt1: { lease: intent(sidLive) }, t_nopid1: { lease: intent(sidGone) } }), env: env() });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  await until(() => read(tbd, 't_nopid1').lease.exit, 10_000, 'none found ended');
  assert.deepEqual([read(tbd, 't_nopid1').lease.exit, read(tbd, 't_nopid1').lease.pid], ['interrupted', null]);
  const l = await until(() => read(tbd, 't_adopt1').lease.pid && read(tbd, 't_adopt1').lease, 10_000, 'adopted');
  assert.deepEqual([l.pid, l.pgid, l.exit], [x.pid, x.pid, undefined]);
  assert.match(l.lstart, /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
  await until(() => read(tbd, 't_adopt1').lease.exit, 15_000, 'adopted run ended');
  assert.equal(read(tbd, 't_adopt1').lease.exit, 'result');
  assert.deepEqual(spyLog(tbd, 'test-handled.jsonl').map((h) => [h.id, h.output]), [['t_adopt1', { answer: 'adopted' }]]);
  for (const id of ['t_adopt1', 't_nopid1']) assert.equal(hasRun(tbd, id, 2), false, `${id}: no new run`);
});

test('C1: a lease with pid but no lstart (tbd died before ps listed it) → adopted when that pid is the run; a pid that is not the run → interrupted, that process untouched', async (t) => {
  const [sidRun, sidLost, sidOther] = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-'));
  const tk = path.join(root, 'tbhome/tickets/t_lstrt1');
  fs.mkdirSync(path.join(tk, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(tk, 'scenario.json'), JSON.stringify({ steps: [{ sleep_ms: 2500 }, { result: { structured_output: { answer: 'kept' } } }] }));
  const out = fs.openSync(path.join(tk, 'runs/1.jsonl'), 'w');
  const run = spawn(FAKE, ['-p', '--session-id', sidRun, '--output-format', 'stream-json'], {
    cwd: tk, detached: true, stdio: ['ignore', out, 'ignore'], env: { PATH: process.env.PATH, HOME: root, FAKE_CLAUDE_SCENARIO: 'scenario.json' },
  });
  fs.closeSync(out);
  const other = spawn(FAKE, ['-p', '--session-id', sidOther], { // a live claude_bin process, another session
    detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, FAKE_CLAUDE_SCENARIO: HANG },
  });
  for (const c of [run, other]) c.unref();
  t.after(() => reap([run.pid, other.pid]));
  const lease = (session, pid) => ({
    gen: 1, pid, lstart: '', pgid: pid, phase: 'planning', task: null, session, log: 'runs/1.jsonl',
    started_at: NOW, last_event_at: NOW, tool: null, slot_wait_ms: 0, subagents_alive: 0, subagents_spawned: 0,
  });
  const tbd = await startTbd({ root, files: seed({ t_lstrt1: { lease: lease(sidRun, run.pid) }, t_lostx1: { lease: lease(sidLost, other.pid) } }), env: env() });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  await until(() => read(tbd, 't_lostx1').lease.exit, 10_000, 'lost run ended');
  assert.equal(read(tbd, 't_lostx1').lease.exit, 'interrupted');
  const l = await until(() => read(tbd, 't_lstrt1').lease.lstart && read(tbd, 't_lstrt1').lease, 10_000, 'adopted');
  assert.deepEqual([l.pid, l.exit], [run.pid, undefined]);
  await until(() => read(tbd, 't_lstrt1').lease.exit, 15_000, 'adopted run ended');
  assert.equal(read(tbd, 't_lstrt1').lease.exit, 'result');
  assert.deepEqual(spyLog(tbd, 'test-handled.jsonl').map((h) => [h.id, h.output]), [['t_lstrt1', { answer: 'kept' }]]);
  assert.equal(alive(other.pid), true, 'a process that is not the run is never killed');
  assert.deepEqual(spyLog(tbd, 'test-kills.jsonl').filter((k) => Math.abs(k.pid) === other.pid), []);
});
