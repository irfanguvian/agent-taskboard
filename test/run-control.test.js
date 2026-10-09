'use strict';
// P3c (plan P3 AC4 AC9 AC10; contract T5 T6; review R16): what Irfan uses to see and steer runs, through a real tbd
// (harness temp HOME + TB_HOME), test/fake-claude.js as claude_bin and test/helpers/run-spy.js (kills reach only this
// test's fake-claude processes; launchctl and caffeinate spied): tb logs / resume / restart / cancel, GET …/log,
// POST …/{resume,restart,cancel}, the SSE `run` event, the t:run line + gzipped log, admission from t:run peaks.
// Shown-line rendering and gz reading: stream.test.js; exit mapping: metrics.test.js; the UI: the orchestrator's
// browser walkthrough.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startTbd, runTb } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, alive, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'run-control-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const [f, c] of Object.entries({ 'prompt.md': '# fixture\n', 'settings.json': '{"permissions":{"allow":["Read"]}}', 'result.schema.json': '{"type":"object"}' })) {
    fs.writeFileSync(path.join(PHASES, 'code', ph, f), c);
  }
}
const CONFIG = { // admission always yes from config (no t:run lines), unless critical pressure
  claude_bin: FAKE,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const say = (role, content) => ({ emit: { type: role, message: { role, content } } });
const runLines = (tbd) => lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((l) => l.t === 'run');

// tickets: id → {scenario (fake-claude steps, read from <ticket dir>/scenario.json), ...ticket fields}
async function boot(t, tickets, files = {}) {
  const seed = { 'config.json': CONFIG, ...files };
  for (const [id, { scenario, ...over }] of Object.entries(tickets)) {
    seed[`tickets/${id}/ticket.json`] = ticket(id, over);
    seed[`tickets/${id}/scenario.json`] = scenario;
  }
  const tbd = await startTbd({ files: seed, env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: 'scenario.json' } });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return tbd;
}

// The /events stream; wait(re) → the first match in it so far or later.
function events(t, tbd) {
  let text = '';
  const req = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { 'x-tb-token': tbd.token } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
  });
  req.on('error', () => {});
  t.after(() => req.destroy());
  return (re, what) => until(() => re.exec(text), 20_000, what);
}

test('AC9 AC10 a run end: one t:run line (App C fields, cost in micro-USD), the log gzipped (0600); tb logs -f follows the run to its end; GET …/log tail + after cursor; tb show; tbd.log 0600 (F4)', async (t) => {
  const scenario = { steps: [
    say('assistant', [{ type: 'text', text: 'Reading the repo' }]),
    say('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }]),
    say('user', [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }]),
    { sleep_ms: 6000 }, // tb logs -f starts meanwhile
    { result: { structured_output: { answer: 'ok' }, num_turns: 3, total_cost_usd: 0.123456 } },
  ] };
  const tbd = await boot(t, { t_logs01: { scenario } }, { 'tbd.log': 'from an older tbd\n' });
  assert.equal(fs.statSync(path.join(tbd.tbHome, 'tbd.log')).mode & 0o777, 0o600, 'F4: tbd.log made 0600 at start');
  await until(() => read(tbd, 't_logs01').lease?.pid, 15_000, 'run live');
  const f = await runTb(['logs', 't_logs01', '-f'], tbd);
  const shown = ['init · model fable · claude fake', 'assistant: Reading the repo', 'tool Bash: {"command":"ls"}', 'tool result: a.txt', 'result success · turns 3 · $0.12'];
  assert.equal(f.code, 0, f.stdout);
  assert.match(f.stdout, /^log: t_logs01 run 1 · [1-4] lines\n/, 'first read: the live log, before its result');
  assert.deepEqual(f.stdout.split('\n').filter((l) => l.startsWith('  ')), shown.map((l) => `  ${l}`), 'each line once, in order');
  assert.match(f.stdout, /\nlog: run 1 ended\nhelp: tb show t_logs01\n$/);

  const [m] = await until(() => runLines(tbd).length && runLines(tbd), 15_000, 't:run line');
  const l = read(tbd, 't_logs01').lease;
  assert.deepEqual(m, {
    t: 'run', ticket: 't_logs01', phase: 'planning', task: null, model: 'fable', effort: 'high', started: l.started_at, ended: l.ended_at,
    exit: 'result', turns: 3, cost_delta: 123456, peak_rss_mb: m.peak_rss_mb, subagents_peak: 0, slot_wait_ms: 0, resumed: false,
  });
  assert.ok(Number.isInteger(m.peak_rss_mb) && m.peak_rss_mb > 0, `peak_rss_mb ${m.peak_rss_mb}`);
  const runs = path.join(tbd.tbHome, 'tickets/t_logs01/runs');
  assert.deepEqual([fs.existsSync(path.join(runs, '1.jsonl')), fs.statSync(path.join(runs, '1.jsonl.gz')).mode & 0o777], [false, 0o600]);

  const tail = await tbd.api('GET', '/api/tickets/t_logs01/log?tail=2');
  assert.deepEqual([tail.status, tail.json.run, tail.json.lines, tail.json.ended], [200, 1, shown.slice(-2), true]);
  const all = (await tbd.api('GET', '/api/tickets/t_logs01/log?after=0')).json;
  assert.deepEqual(all.lines, shown);
  assert.deepEqual((await tbd.api('GET', `/api/tickets/t_logs01/log?after=${all.offset}`)).json.lines, [], 'the cursor at the end: nothing new');
  assert.deepEqual(await tbd.api('GET', '/api/tickets/t_logs01/log?tail=0').then((r) => [r.status, r.json]), [400, { error: 'tail must be a whole number from 1' }]);
  assert.equal((await tbd.api('GET', '/api/tickets/t_logs01/log?run=2')).status, 404);
  assert.match((await runTb(['show', 't_logs01'], tbd)).stdout, /^ {2}run: runs\/1\.jsonl · ended result$/m);
});

test('AC4 AC7 R16 run control: SSE run event; Resume refused while live (409), no auth → 401; tb restart → a fresh session, tb cancel → run killed + cancelled, t:run per run; tb resume then refused (exit 1)', async (t) => {
  const tbd = await boot(t, { t_ctrl01: { scenario: { steps: [say('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }]), { hang: true }] } } });
  const wait = events(t, tbd);
  const l1 = await until(() => read(tbd, 't_ctrl01').lease?.lstart && read(tbd, 't_ctrl01').lease, 15_000, 'run 1 live');
  const [, data] = await wait(/event: run\ndata: (\{"id":"t_ctrl01","liveness":"tool"[^\n]*"rss_mb":[1-9][^\n]*)\n\n/, 'run event with RSS');
  const r = JSON.parse(data);
  assert.deepEqual([r.tool, r.subagents_alive, r.live, r.started_at, Number.isInteger(r.last_event_age_s)], ['Bash', 0, true, l1.started_at, true], data);

  const post = (op, headers = {}) => tbd.api('POST', `/api/tickets/t_ctrl01/${op}`, op === 'resume' ? {} : undefined, headers);
  assert.deepEqual(await post('resume').then((x) => [x.status, x.json]), [409, { error: 't_ctrl01: the run is live; Resume works once it ended' }]);
  for (const op of ['resume', 'restart', 'cancel']) assert.equal((await post(op, { 'x-tb-token': undefined })).status, 401, op);
  assert.deepEqual([read(tbd, 't_ctrl01').lease.gen, alive(l1.pid)], [1, true], 'refused: nothing changed');

  const restart = await runTb(['restart', 't_ctrl01'], tbd);
  assert.equal(restart.code, 0, restart.stdout);
  assert.match(restart.stdout, /^restart: accepted · t_ctrl01 · planning · run t_ctrl01$/m);
  const l2 = await until(() => { const l = read(tbd, 't_ctrl01').lease; return l.gen === 2 && l.lstart && !l.exit && l; }, 30_000, 'run 2 live');
  assert.deepEqual([l2.log, l2.session === l1.session, alive(l1.pid)], ['runs/2.jsonl', false, false], 'a fresh session; run 1 killed');

  const cancel = await runTb(['cancel', 't_ctrl01'], tbd);
  assert.equal(cancel.code, 0, cancel.stdout);
  await until(() => read(tbd, 't_ctrl01').state === 'cancelled' && !alive(l2.pid), 30_000, 'cancelled, run 2 killed');
  await wait(/event: run\ndata: \{"id":"t_ctrl01","liveness":null\}\n\n/, 'run gone from the view');
  const metered = await until(() => runLines(tbd).length === 2 && runLines(tbd), 15_000, 'a t:run line per run');
  assert.deepEqual(metered.map((x) => [x.exit, x.started]), [['cancelled', l1.started_at], ['cancelled', l2.started_at]], 'stopped by Irfan: cancelled in the metric');

  const resume = await runTb(['resume', 't_ctrl01'], tbd);
  assert.deepEqual([resume.code, resume.stdout], [1, 'error: t_ctrl01: cancelled has no agent run to resume\n']);
});

test('AC10 admission: a phase needs the median peak of its last 10 t:run lines (metrics.jsonl, read at start); a phase without lines keeps the config need', async (t) => {
  const huge = Array.from({ length: 10 }, (_, i) => `${JSON.stringify({ t: 'run', phase: 'planning', peak_rss_mb: 1e9 + i })}\n`).join(''); // ~1 PB
  const done = { steps: [{ result: { structured_output: {} } }] };
  const tbd = await boot(t, { t_needp1: { scenario: done }, t_needw1: { state: 'working', scenario: done } }, { 'metrics.jsonl': huge });
  await until(() => read(tbd, 't_needw1').lease?.exit === 'result', 20_000, 'the working run (config need 0) ran');
  await until(() => read(tbd, 't_needp1').waiting?.reason === 'memory', 15_000, 'planning waits for memory');
  assert.equal(read(tbd, 't_needp1').lease, null, 'planning never spawned');
});
