'use strict';
// P3b (plan P3 AC1 AC5 AC7 AC8; spec §4 §7 §8): lib/runner.js + lib/recovery.js in-process on a FAKE clock. Real
// store on a temp TB_HOME; ps table, kill, kill(pid, 0), sleep, spawn, git, net probe and caffeinate are fakes, so no
// real process is started or signalled (fake pids are above the macOS pid range) and minutes pass by moving the clock,
// with a tick every 15 s as the 1 s ticker would. Sleep is as on a real Mac: the wall clock runs on with no ticks, and
// kern.sleeptime / kern.waketime record it; the real lib/monitor.js reads them from a sysctl fake (w.lid, w.sample).
// The same paths with real processes (SIGINT → 10 s → SIGKILL, resume argv): test/recovery-tbd.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Env before any lib require: phases scans at load, store reads TB_HOME at load (AC10: never the real home).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
process.env.TB_PHASES_DIR = path.join(root, 'phases');
fs.mkdirSync(process.env.HOME);
fs.mkdirSync(process.env.TB_HOME);
for (const ph of ['planning', 'working']) {
  const d = path.join(process.env.TB_PHASES_DIR, 'code', ph);
  fs.mkdirSync(d, { recursive: true });
  for (const f of ['prompt.md', 'settings.json', 'result.schema.json']) fs.writeFileSync(path.join(d, f), f.endsWith('.json') ? '{}' : '# fixture\n');
}
fs.writeFileSync(path.join(process.env.TB_HOME, 'config.json'), JSON.stringify({
  claude_bin: '/nonexistent/claude', max_concurrent: 2, // spawn is faked; two runs for the memory and wall-cap tests
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
}));
const phases = require('../lib/phases');
let onResult = async (_t, _out) => undefined; // the phase handlers (a test swaps it, then puts it back)
for (const ph of ['planning', 'working']) phases.registerHandler(`code/${ph}`, (k, out) => onResult(k, out));
const store = require('../lib/store');
const fsm = require('../lib/fsm');
const { createMonitor } = require('../lib/monitor');
const { createRunner } = require('../lib/runner');
const { RESUME_PROMPT } = require('../lib/spawn');
const { SCHEMA_PROMPT, liveness } = require('../lib/recovery');
const sh = require('../lib/sh');

before(() => store.init());
after(async () => {
  await store.releasePid();
  fs.rmSync(root, { recursive: true, force: true });
});

const MIN = 60_000;
const GB = 2 ** 30;
const NORMAL = Object.freeze({ pressure: 'normal', avail: 64 * GB, disk_free: 2 ** 40, docker: false, net: true, power: 'ac', at: 's0' });
const STATUS = { type: 'system', subtype: 'status' };
const TOOL = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash' }] } };
const SCHEMA_FAIL = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true };
const OK = { type: 'result', subtype: 'success', is_error: false, structured_output: {} };
const sec = (ms) => Math.floor(ms / 1000);
const iso = (ms) => new Date(ms).toISOString();

// One fake Mac + runner per test. Its tickets end as `done` without a lease, so later tests' runners skip them.
function world(t, deps = {}) {
  const w = {
    clock: Date.parse('2026-10-08T00:00:00.000Z'), os: { sleep: 0, wake: 0 }, // os: kern.sleeptime / kern.waketime, ms
    procs: new Map(), // pid → {ppid, pgid, nice, rss (KB), lstart}
    ignoreInt: new Set(), // pids that ignore SIGINT (D-0011 hang variant)
    exits: new Map(), kills: [], spawns: [], caf: [], waits: new Map(), waiting: new Set(), gates: [],
    snap: /** @type {any} */ ({ ...NORMAL }), net: true, git: '', nextPid: 4_000_000, hold: null, // hold: a spawn waits for it
    args: new Map(), psFail: false, // `ps -o pid=,args=` lines by pid (findRun)
  };
  w.exit = (pid, code = null) => { w.procs.delete(pid); w.exits.get(pid)?.({ code, signal: null }); };
  w.runner = createRunner({
    store, tbHome: process.env.TB_HOME, port: 7777, launchd: () => false,
    slots: {
      registerRoot() {}, endRun: async () => {}, usage: () => ({ alive: 0, spawned: 0 }),
      waits: (runId) => ({ wait_ms: w.waits.get(runId) ?? 0, waiting: w.waiting.has(runId) }),
    },
    system: () => w.snap, now: () => w.clock,
    sleep: async (ms) => { w.clock += ms; await new Promise((r) => setImmediate(r)); },
    procs: async () => new Map([...w.procs].map(([p, x]) => [p, { ...x }])),
    kill: (pid, sig) => {
      w.kills.push({ pid, sig, at: w.clock });
      const pids = pid < 0 ? [...w.procs].filter(([, x]) => x.pgid === -pid).map(([p]) => p) : [pid];
      for (const p of pids) if (sig !== 'SIGINT' || !w.ignoreInt.has(p)) w.exit(p);
    },
    alive: (pid) => w.procs.has(pid),
    probe: async () => w.net,
    psArgs: async () => (w.psFail ? { err: new Error('ps failed'), stdout: '' } : { err: null, stdout: [...w.args].map(([p, a]) => `${p} ${a}`).join('\n') }),
    exec: async (file) => ({ err: null, stdout: file === '/usr/bin/git' ? w.git : '', stderr: '' }),
    spawnRun: async (o) => {
      await w.hold;
      const pid = w.nextPid++;
      w.procs.set(pid, { ppid: 1, pgid: pid, nice: 0, rss: 100 * 1024, lstart: `start ${pid}` });
      const log = path.join(o.ticketDir, 'runs', `${o.n}.jsonl`);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, '');
      w.spawns.push({ id: o.ticket.id, n: o.n, session: o.session, resume: o.resume, prompt: o.prompt, pid });
      return { child: { pid }, ready: Promise.resolve(), done: new Promise((r) => w.exits.set(pid, r)), log: `runs/${o.n}.jsonl` };
    },
    caffeinate: () => { w.caf.push('start'); return { kill: () => void w.caf.push('kill') }; },
    rerunGate: async (k, phase) => void w.gates.push([k.id, phase]),
    ...deps,
  });
  t.after(() => w.runner.stop());
  // The monitor as tbd.js wires it; only its sysctl answer matters here (system() stays w.snap).
  const tv = (ms) => `{ sec = ${Math.floor(ms / 1000)}, usec = ${(ms % 1000) * 1000} } Thu Oct  8 00:00:00 2026`;
  const mon = createMonitor({
    config: store.config, clock: () => w.clock, statfs: async () => ({ bavail: 2 ** 30, bsize: 4096 }), connect: async () => true,
    exec: (file, _a, _o, cb) => setImmediate(() => cb(null, path.basename(file) === 'sysctl' ? `1\n43\n8589934592\n${tv(w.os.sleep)}\n${tv(w.os.wake)}\n` : '', '')),
  });
  mon.on('wake', (e) => w.runner.wake(e));
  const based = mon.sample(); // the first sample only records kern.waketime
  // The lid closed for ms: the wall clock runs on (no ticks), the OS records the sleep; the monitor tells on w.sample().
  w.lid = async (ms) => {
    await based;
    w.os = { sleep: w.clock, wake: w.clock + ms };
    w.clock += ms;
  };
  w.sample = () => mon.sample();
  w.settle = async () => { for (let i = 0; i < 3; i++) { await w.runner.tick(); await w.runner.idle(); } };
  // Ticks every 15 s of fake time up to `at` (room for step 2's up-to-10 s of polls between ticks), then settles.
  w.to = async (at) => {
    assert.ok(at >= w.clock, 'the fake clock never runs back');
    while (w.clock < at) {
      w.clock += Math.min(15_000, at - w.clock);
      await w.runner.tick();
      await w.runner.idle();
      await w.sample(); // the monitor samples on (every 5 s on a Mac): its last look is never long before a lid
    }
    await w.settle();
  };
  w.step = (ms = 0) => w.to(w.clock + ms);
  // Lets the event loop run until fn() holds; a bounded wait, so a broken guard fails the test instead of hanging it.
  w.until = async (fn, what) => {
    for (let i = 0; !fn(); i++) {
      if (i > 20_000) assert.fail(`never: ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  };
  w.ticket = async (over = {}) => {
    const k = await store.createFlow({ text: 'p3b', kind: 'code' });
    await store.updateTicket(k.id, (x) => ({ ...x, state: 'planning', ...over }));
    t.after(() => store.updateTicket(k.id, (x) => ({ ...x, state: 'done', lease: null, waiting: null })));
    return k.id;
  };
  w.get = (id) => store.getTicket(id);
  w.lease = (id) => store.getTicket(id).lease;
  // An event in the run's log at the fake time (the tail takes the log's mtime as the event time).
  w.say = (id, ev) => {
    const l = w.lease(id);
    const f = path.join(store.ticketDir(id), l.log);
    fs.appendFileSync(f, JSON.stringify({ session_id: l.session, ...ev }) + '\n');
    fs.utimesSync(f, w.clock / 1000, w.clock / 1000);
  };
  w.killsOf = (pid) => w.kills.filter((k) => Math.abs(k.pid) === pid).map((k) => [k.sig, k.at]);
  w.view = (id) => w.runner.view().runs.find((r) => r.id === id);
  return w;
}

// An ended lease, as a run that already died left it (pid gone: not in the fake ps table).
const ended = (over = {}) => ({
  gen: 3, pid: 3_999_999, lstart: 'start gone', pgid: 3_999_999, phase: 'planning', task: null, session: '11111111-1111-4111-8111-111111111111',
  log: 'runs/1.jsonl', started_at: '2026-10-07T23:00:00.000Z', last_event_at: '2026-10-07T23:10:00.000Z', ended_at: '2026-10-07T23:10:00.000Z',
  tool: null, slot_wait_ms: 0, subagents_alive: 0, subagents_spawned: 0, exit: 'crash', failure: true, ...over,
});
// A ticket's t:run lines in metrics.jsonl.
const runLines = (id) => fs.readFileSync(path.join(process.env.TB_HOME, 'metrics.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.t === 'run' && m.ticket === id);

test('liveness table (§8): offline > waiting > tool > stalled (15 min) > quiet (5 min) > thinking', () => {
  const lv = { quiet_min: 5, stall_min: 15 };
  const row = (o) => liveness({ ageMs: 0, tool: null, waiting: false, offline: false, ...o }, lv);
  assert.deepEqual([
    row({ ageMs: 59_000 }), row({ ageMs: 4 * MIN }), row({ ageMs: 5 * MIN }), row({ ageMs: 15 * MIN }),
    row({ ageMs: 20 * MIN, tool: 'Bash' }), row({ ageMs: 20 * MIN, tool: 'Bash', waiting: true }), row({ ageMs: 20 * MIN, waiting: true, offline: true }),
  ], ['thinking', 'thinking', 'quiet', 'stalled', 'tool', 'waiting', 'offline']);
});

test('AC5 stall: silent stall_min with no tool → SIGINT (it exits: no SIGKILL), resumed in the same session with the §8 prompt, counted; a running tool never stalls', async (t) => {
  const w = world(t);
  const [a, b] = [await w.ticket(), await w.ticket()];
  await w.step();
  const t0 = w.clock;
  const [la, lb] = [w.lease(a), w.lease(b)];
  const exit = w.exit; // P1: claude answers the SIGINT with a result line of its own, the session's total cost (2.1.295)
  w.exit = (pid, code) => { if (pid === la.pid) w.say(a, { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.25 }); exit(pid, code); };
  w.say(a, STATUS);
  w.say(b, TOOL);
  await w.step(15 * MIN - 1000);
  assert.deepEqual([w.view(a).liveness, w.view(b).liveness, w.view(b).tool, w.view(b).tool_s, w.view(a).rss_mb], ['quiet', 'tool', 'Bash', 899, 100]);
  assert.equal(w.spawns.length, 2, 'nothing recovered at 14:59');
  await w.step(1000);
  assert.deepEqual(w.killsOf(la.pid), [['SIGINT', t0 + 15 * MIN]], 'SIGINT only: it exited within the 10 s');
  assert.deepEqual(w.spawns.slice(2).map((s) => [s.id, s.n, s.resume, s.session, s.prompt]), [[a, 2, true, la.session, RESUME_PROMPT]], 'clean tree: the prompt verbatim');
  const l = w.lease(a);
  assert.deepEqual([l.gen, l.log, l.resumed, l.exit, l.pending, w.get(a).failures], [2, 'runs/2.jsonl', true, undefined, undefined, { planning: 1 }]);
  await w.step(10 * MIN); // b: a tool for 25 min, still no stall
  assert.deepEqual([w.killsOf(lb.pid), w.lease(b).gen, w.get(b).failures], [[], 1, {}]);
  await w.runner.stop(); // the run end's metering settled
  assert.deepEqual([runLines(a).map((m) => [m.exit, m.cost_delta]), l.cost_base], [[['stalled', 250_000]], 250_000], 'P1: the stop, not crash; L1: the resume counts from that total');
});

test('§8 waiting: the last event system/api_retry, or a heavy-slot / lock wait → liveness waiting, never stalled', async (t) => {
  const w = world(t);
  const [a, b] = [await w.ticket(), await w.ticket()];
  await w.step();
  w.say(a, { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 60_000, error_status: 529 });
  w.say(b, STATUS);
  w.waiting.add(`${b}.1`);
  await w.step(16 * MIN);
  assert.deepEqual([w.view(a).liveness, w.view(b).liveness, w.spawns.length, w.kills], ['waiting', 'waiting', 2, []]);
});

test('AC5 step 2: a run that ignores SIGINT gets SIGKILL after 10 s, then kill(pid, 0) finds it gone', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  const l = w.lease(a);
  w.ignoreInt.add(l.pid);
  w.say(a, STATUS);
  await w.step(15 * MIN);
  const [[s1, t1], [s2, t2]] = w.killsOf(l.pid);
  assert.deepEqual([s1, s2, t2 - t1], ['SIGINT', 'SIGKILL', 10_000]);
  assert.equal(w.procs.has(l.pid), false);
  assert.equal(w.spawns.at(-1).resume, true, 'resumed after the kill');
});

test('AC5 step 6: crash and interrupted count, the 4th failure → Blocked with no 5th run; every resume keeps the session', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  const session = w.lease(a).session;
  for (const [i, code] of [[1, 1], [2, null], [3, 1]]) {
    w.exit(w.lease(a).pid, code); // 1: crash; null without a result: interrupted
    await w.step();
    assert.deepEqual([w.get(a).failures, w.spawns.length, w.get(a).state], [{ planning: i }, i + 1, 'planning'], `failure ${i}`);
  }
  w.exit(w.lease(a).pid, null);
  await w.step();
  assert.deepEqual([w.get(a).state, w.get(a).blocked_from, w.get(a).failures, w.lease(a).exit, w.spawns.length], ['blocked', 'planning', { planning: 4 }, 'interrupted', 4]);
  assert.deepEqual(w.spawns.map((s) => [s.resume, s.session]), [[false, session], [true, session], [true, session], [true, session]]);
});

test('AC1 double resume: two Resumes + a Restart at once → exactly one wins by the gen CAS; Resume refused while live or while a recovery runs', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'blocked', blocked_from: 'planning', rework: 2, lease: ended({ exit: 'max_turns' }) });
  const res = await Promise.allSettled([w.runner.resume(a), w.runner.resume(a), w.runner.restart(a)]);
  assert.deepEqual(res.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message)), [true, false, false], 'losers stop quietly');
  assert.deepEqual(w.spawns.map((s) => [s.resume, s.session]), [[true, ended().session]], 'one run, same session');
  assert.deepEqual([w.get(a).state, w.get(a).rework, w.get(a).failures, w.lease(a).gen], ['planning', 0, { planning: 0 }, 4]);
  assert.deepEqual(w.gates, [[a, 'planning']], 'P5 seam: called once, before the run');
  await assert.rejects(w.runner.resume(a), /the run is live/);
  w.net = false; // a recovery that waits in step 3
  const b = await w.ticket({ lease: ended({ exit: 'usage', resets_at: iso(w.clock - 1000) }) });
  await w.runner.tick();
  await w.until(() => w.lease(b).pending, 'b pending');
  await assert.rejects(w.runner.resume(b), /a recovery is already running/);
  w.net = true;
  await w.runner.idle();
});

test('AC1 wake: each live run gets wake_grace_min (6) to speak; silent → recovered, not counted; one that speaks keeps going under the stall rule', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  const b = await w.ticket({ state: 'working' }); // wall 45 min: the stall comes first
  await w.step();
  w.say(a, STATUS);
  w.say(b, STATUS);
  await w.step(14 * MIN);
  await w.lid(40_000);
  await w.sample(); // the OS wake
  await w.step(MIN); // a silent 15 min: the stall rule waits for the grace
  assert.equal(w.spawns.length, 2);
  await w.step(2 * MIN);
  const spoke = w.clock;
  w.say(b, STATUS); // b speaks 3 min after the wake
  await w.step(3 * MIN - 1000);
  assert.equal(w.spawns.length, 2, 'nothing at 5:59 after the wake');
  await w.step(1000);
  assert.deepEqual([w.spawns.length, w.spawns[2].id, w.spawns[2].resume, w.get(a).failures], [3, a, true, {}], 'a: sleep is a pause');
  await w.to(spoke + 15 * MIN - 1000);
  assert.equal(w.lease(b).gen, 1, 'b spoke: grace over, 15 min stall rule from its last event');
  await w.to(spoke + 15 * MIN);
  assert.deepEqual([w.lease(b).gen, w.get(b).failures], [2, { working: 1 }]);
});

test('AC7 wall cap: run time minus heavy-slot wait ≥ wall_min → killed, Blocked (exit wall_cap, not a failure)', async (t) => {
  const w = world(t);
  const [a, b] = [await w.ticket(), await w.ticket()];
  await w.step();
  const t0 = w.clock;
  w.waits.set(`${a}.1`, 10 * MIN); // a waited 10 min for the heavy slot
  w.say(a, TOOL); // tools running: no stall
  w.say(b, TOOL);
  await w.step(30 * MIN - 1000);
  assert.deepEqual([w.get(a).state, w.get(b).state], ['planning', 'planning']);
  await w.step(1000);
  assert.deepEqual([w.get(b).state, w.lease(b).exit, w.get(b).failures, w.killsOf(w.lease(b).pid)[0][0]], ['blocked', 'wall_cap', {}, 'SIGINT']);
  assert.equal(w.get(a).state, 'planning', 'a: 30 min minus 10 min of slot wait');
  await w.to(t0 + 40 * MIN - 1000);
  assert.equal(w.get(a).state, 'planning');
  await w.to(t0 + 40 * MIN);
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.get(a).failures], ['blocked', 'wall_cap', {}]);
});

test('AC1 usage: allowed_warning is only a flag; rejected pauses the run (nothing new starts) and resumes it after resets_at, not counted', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  const pid = w.lease(a).pid;
  w.say(a, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: sec(w.clock + 3 * 3600_000) } });
  await w.step();
  assert.deepEqual([w.runner.view().system.usage_warning, w.runner.view().system.paused_until, w.killsOf(pid)], [true, null, []]);
  const reset = w.clock + 60 * MIN;
  w.say(a, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: sec(reset) } });
  await w.step();
  assert.deepEqual([w.lease(a).exit, w.lease(a).resets_at, w.killsOf(pid).map(([s]) => s)], ['usage', iso(reset), ['SIGINT']]);
  assert.deepEqual([w.runner.view().system.paused_until, w.view(a).liveness], [iso(reset), 'paused']);
  const b = await w.ticket();
  await w.step(59 * MIN);
  assert.deepEqual([w.get(b).waiting?.reason, w.get(a).waiting?.reason, w.spawns.length], ['usage', 'usage', 1], 'paused: no start, no resume');
  await w.step(MIN);
  assert.deepEqual(w.spawns.slice(1).map((s) => [s.id, s.resume]).sort(), [[a, true], [b, false]].sort());
  assert.deepEqual([w.get(a).failures, w.runner.view().system.paused_until], [{}, null]);
});

test('AC1 memory: critical pressure pauses the newest run only (SIGINT, exit paused, not counted); it resumes once canResume; none other while one dies', async (t) => {
  let gate = null; // holds step 2's 1 s polls: a run that ignores SIGINT dies as late as the test wants
  const w = world(t, { sleep: async (ms) => { w.clock += ms; await gate; await new Promise((r) => setImmediate(r)); } });
  const a = await w.ticket();
  await w.step();
  const b = await w.ticket();
  await w.step(1000); // b started later
  w.snap = { ...NORMAL, pressure: 'critical', at: 's1' };
  await w.step();
  await w.step(); // same monitor sample: no second pause
  assert.deepEqual([w.lease(b).exit, w.get(b).failures, w.killsOf(w.lease(b).pid).map(([s]) => s)], ['paused', {}, ['SIGINT']]);
  assert.deepEqual([w.lease(a).exit, w.killsOf(w.lease(a).pid)], [undefined, []], 'the older run goes on');
  assert.equal(w.get(b).waiting?.reason, 'memory', 'still critical: canResume false');
  w.snap = { ...NORMAL, at: 's2' };
  await w.step();
  assert.deepEqual([w.spawns.length, w.spawns[2].id, w.spawns[2].resume, w.get(b).failures], [3, b, true, {}]);
  // R1 R2: b paused again, it ignores SIGINT; a new critical sample while it dies pauses no other run, its slot stays taken
  let open;
  gate = new Promise((r) => { open = r; });
  w.ignoreInt.add(w.lease(b).pid);
  w.snap = { ...NORMAL, pressure: 'critical', at: 's3' };
  await w.runner.tick();
  await w.until(() => w.killsOf(w.lease(b).pid).length > 0, 'b SIGINTed');
  const c = await w.ticket();
  w.snap = { ...NORMAL, pressure: 'critical', at: 's4' };
  await w.runner.tick();
  assert.deepEqual([w.killsOf(w.lease(a).pid), w.get(c).waiting?.reason], [[], 'slot'], 'R1: a goes on; R2: the dying b still holds a slot');
  await w.runner.cancel(c);
  gate = null;
  open();
  await w.runner.idle();
  // S10: b's pause settled; its resume waits in step 3 (warn, a still runs). A new critical sample pauses a.
  w.snap = { ...NORMAL, pressure: 'warn', at: 's5' };
  await w.runner.tick();
  await w.until(() => w.get(b).waiting?.reason === 'memory', 'b resume waits for admission');
  w.snap = { ...NORMAL, pressure: 'critical', at: 's6' };
  await w.runner.tick();
  await w.until(() => w.killsOf(w.lease(a).pid).length > 0, 'S10: a paused');
  w.snap = { ...NORMAL, at: 's7' };
  await w.runner.idle();
});

test('AC1 schema retry: error_max_structured_output_retries → resumed once with the schema prompt (not counted) → again → Blocked; cost_delta per run though total_cost_usd adds up over --resume', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, { ...SCHEMA_FAIL, session_id: w.lease(a).session, total_cost_usd: 0.1 });
  w.exit(w.lease(a).pid, 1);
  await w.step();
  assert.deepEqual([w.spawns[1].resume, w.spawns[1].prompt, w.lease(a).schema_retry, w.get(a).state], [true, SCHEMA_PROMPT, true, 'planning']);
  w.say(a, { ...SCHEMA_FAIL, session_id: w.lease(a).session, total_cost_usd: 0.15 }); // the session's total, run 1 included
  w.exit(w.lease(a).pid, 1);
  await w.step();
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.get(a).failures, w.spawns.length], ['blocked', 'schema_fail', {}, 2]);
  const costs = () => runLines(a).map((m) => m.cost_delta);
  for (let i = 0; i < 100 && costs().length < 2; i++) await new Promise((r) => setTimeout(r, 20)); // metered after the run end
  assert.deepEqual(costs(), [100_000, 50_000], 'run 2 = 0.15 − 0.1, not 0.15');
});

test('AC1 net (H3): offline → liveness offline, no stall; net back starts the grace: a silent run is recovered 6 min later (not counted); a run in a tool is never killed for it', async (t) => {
  const w = world(t);
  const [a, b] = [await w.ticket(), await w.ticket()];
  await w.step();
  w.say(a, STATUS);
  w.say(b, TOOL); // a long jest run, say
  w.snap = { ...NORMAL, net: false };
  await w.step();
  assert.deepEqual([w.view(a).liveness, w.view(b).liveness], ['offline', 'offline']);
  await w.step(20 * MIN);
  assert.equal(w.spawns.length, 2, 'no stall while offline');
  w.snap = { ...NORMAL };
  await w.step(5000);
  assert.deepEqual([w.kills, w.spawns.length], [[], 2], 'net back alone kills nothing');
  await w.step(6 * MIN - 1000);
  assert.equal(w.spawns.length, 2, 'inside the grace');
  await w.step(1000);
  assert.deepEqual(w.spawns.slice(2).map((s) => [s.id, s.resume]), [[a, true]], 'a: silent through the grace');
  assert.deepEqual([w.get(a).failures, w.lease(b).gen, w.killsOf(w.lease(b).pid)], [{}, 1, []], 'b: in its tool, left alone');
  await w.step(MIN);
  assert.deepEqual([w.lease(b).gen, w.killsOf(w.lease(b).pid)], [1, []], 'grace over: the normal rules; a tool never stalls');
});

test('P3 net blip: a run inside a long tool when the net drops for 5 s is never SIGINTed', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, TOOL);
  await w.step(MIN);
  w.snap = { ...NORMAL, net: false, at: 'off' };
  await w.step(5000);
  w.snap = { ...NORMAL, net: true, at: 'on' };
  await w.step(8 * MIN);
  assert.deepEqual([w.kills, w.spawns.length, w.lease(a).gen], [[], 1, 1]);
});

test('AC5 step 3: a run that crashed while offline is not counted; its recovery waits for the probe, then for admission', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.snap = { ...NORMAL, net: false };
  w.net = false;
  await w.step();
  w.exit(w.lease(a).pid, 1);
  await w.runner.tick(); // end → crash; recovery starts and waits for the network
  await w.until(() => w.get(a).waiting?.reason === 'offline', 'waiting offline');
  assert.deepEqual([w.lease(a).failure, w.get(a).failures], [false, {}]);
  w.snap = { ...NORMAL, pressure: null }; // monitor without data: admission says memory
  w.net = true;
  await w.until(() => w.get(a).waiting?.reason === 'memory', 'waiting memory');
  assert.equal(w.spawns.length, 1);
  w.snap = { ...NORMAL };
  await w.runner.idle();
  assert.deepEqual([w.spawns.length, w.spawns[1].resume, w.get(a).failures], [2, true, {}]);
});

test('AC5 post-restart: a pending recovery left in ticket.json is taken from step 1 again (no second count); its old tree is killed; a reused pid is never signalled; dirty tree named in the prompt', async (t) => {
  const w = world(t);
  const [P, Q, X] = [4_100_001, 4_100_002, 4_100_003];
  w.procs.set(P, { ppid: 1, pgid: P, nice: 0, rss: 1, lstart: 'start P' });
  w.procs.set(Q, { ppid: P, pgid: Q, nice: 10, rss: 1, lstart: 'start Q' }); // its own group (tbx heavy): found by the ppid walk
  w.procs.set(X, { ppid: 1, pgid: X, nice: 0, rss: 1, lstart: 'another process' }); // pid of b's dead run, reused
  const pending = (pid) => ({ after: 'resume', why: 'stalled', prev: { gen: 4, pid, lstart: 'start P', pgid: pid } });
  const a = await w.ticket({ failures: { planning: 1 }, lease: ended({ gen: 5, pid: P, lstart: 'start P', pgid: P, exit: 'stalled', pending: pending(P) }) });
  const b = await w.ticket({ failures: { planning: 1 }, lease: ended({ gen: 5, pid: X, lstart: 'start P', pgid: X, exit: 'stalled', pending: pending(X) }) });
  w.git = ' M src/a.js\n?? notes.txt\n';
  await w.step();
  assert.deepEqual([w.killsOf(P).map(([s]) => s), w.killsOf(Q).map(([s]) => s), w.killsOf(X)], [['SIGINT'], ['SIGINT'], []]);
  assert.equal(w.procs.has(X), true, 'the reused pid lives on');
  for (const id of [a, b]) assert.deepEqual([w.get(id).failures, w.lease(id).gen, w.lease(id).pending], [{ planning: 1 }, 6, undefined], id);
  const note = '\n\nThe working tree has uncommitted changes (git status --porcelain):\n M src/a.js\n?? notes.txt\n';
  assert.deepEqual(w.spawns.map((s) => [s.resume, s.session, s.prompt]), [[true, ended().session, RESUME_PROMPT + note], [true, ended().session, RESUME_PROMPT + note]]);
});

test('AC7 Cancel kills the tree, state cancelled, worktree kept; Restart = fresh session, adds no failure/rework (I7: out of Blocked resets them); refused moves throw 409', async (t) => {
  const w = world(t);
  const wt = fs.mkdtempSync(path.join(root, 'wt-'));
  const a = await w.ticket({ worktree: wt });
  await w.step();
  const pid = w.lease(a).pid;
  assert.equal(await w.runner.cancel(a), true);
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.killsOf(pid).map(([s]) => s), fs.existsSync(wt)], ['cancelled', 'cancelled', ['SIGINT'], true]);
  await w.step();
  assert.equal(w.spawns.length, 1, 'no run after Cancel');
  await assert.rejects(w.runner.cancel(a), /cannot be cancelled/);
  const b = await w.ticket({ state: 'blocked', blocked_from: 'planning', rework: 3, failures: { planning: 4 }, lease: ended() });
  assert.equal(await w.runner.restart(b), true);
  const s = w.spawns.at(-1);
  assert.deepEqual([s.id, s.resume, s.session === ended().session, s.prompt], [b, false, false, store.renderMd(w.get(b))]);
  assert.deepEqual([w.get(b).state, w.get(b).failures, w.get(b).rework, w.lease(b).resumed], ['planning', { planning: 0 }, 0, undefined], 'I7: leaving Blocked resets that phase');
  const c = await w.ticket({ state: 'blocked', blocked_from: 'planning', lease: ended() });
  await assert.rejects(w.runner.resume(c, { phase: 'working' }), /resume only up to planning/);
  const d = await w.ticket({ state: 'plan_approval' });
  await assert.rejects(w.runner.restart(d), /no agent run/);
  assert.equal(w.spawns.length, 2);
});

test('AC7 Cancel while the spawn is in flight: the lease moved on, so the fresh child is SIGKILLed at once (no orphan run)', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  let go;
  w.hold = new Promise((r) => { go = r; });
  const ticking = w.runner.tick(); // T1: intent lease saved, spawn waits
  await w.until(() => w.lease(a), 'intent lease');
  assert.equal(await w.runner.cancel(a), true);
  go();
  await ticking;
  const pid = w.spawns[0].pid;
  assert.deepEqual([w.get(a).state, w.killsOf(pid).map(([s]) => s), w.procs.has(pid), w.runner.view().system.runs], ['cancelled', ['SIGKILL'], false, 0]);
});

test('AC8 caffeinate: started with the first run on AC power, killed with the last; never on battery', async (t) => {
  const w = world(t);
  const [a, b] = [await w.ticket(), await w.ticket()];
  await w.step();
  assert.deepEqual(w.caf, ['start'], 'one for both runs');
  w.say(a, OK);
  w.exit(w.lease(a).pid, 0);
  await w.step();
  assert.deepEqual([w.lease(a).exit, w.caf], ['result', ['start']], 'b still runs');
  w.say(b, OK);
  w.exit(w.lease(b).pid, 0);
  await w.step();
  assert.deepEqual(w.caf, ['start', 'kill']);
  w.snap = { ...NORMAL, power: 'battery' };
  await w.ticket();
  await w.step();
  assert.deepEqual([w.spawns.length, w.caf], [3, ['start', 'kill']], 'a run on battery: no caffeinate');
});

// ---- P3b fix loop: verifier probes P1-P7, Irfan I7 + I8, low items ----

test('P1 (H1, I8) lid closed 40 min on a run 5 min in, the OS wake (monitor) before the first tick: sleep is not run time; capped only at 30 min of run', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  const t0 = Date.parse(w.lease(a).started_at);
  w.say(a, TOOL); // busy: no stall
  await w.step(5 * MIN);
  await w.lid(40 * MIN);
  await w.sample(); // the monitor first: kern.waketime moved
  await w.step();
  await store.flush();
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.lease(a).sleep_ms, w.kills], ['planning', undefined, 40 * MIN, []]);
  await w.to(t0 + 70 * MIN - 15_000);
  assert.equal(w.get(a).state, 'planning', '29:45 of run');
  await w.to(t0 + 70 * MIN);
  assert.deepEqual([w.get(a).state, w.lease(a).exit], ['blocked', 'wall_cap']);
});

test('P2 (H2) 20 min asleep, the runner ticks before the monitor: its wall jump is a hint (grace, no stall, no failure); the OS wake brings sleep_ms once', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'working' });
  await w.step();
  w.say(a, STATUS);
  await w.lid(20 * MIN);
  await w.runner.tick();
  await w.sample(); // the monitor, up to 5 s later
  await w.sample(); // and again: the same kern.waketime is no second wake
  await w.runner.idle();
  await w.settle();
  await store.flush();
  assert.deepEqual([w.kills, w.get(a).failures, w.lease(a).gen, w.lease(a).sleep_ms], [[], {}, 1, 20 * MIN]);
  await w.step(6 * MIN);
  assert.deepEqual([w.lease(a).gen, w.get(a).failures, w.spawns.at(-1).resume], [2, {}, true], 'silent through the grace: a sleep pause');
});

test('P4 (M2) Restart over a pending block left by a stopped tbd restarts (fresh session); it never inherits the block', async (t) => {
  const w = world(t);
  const prev = { gen: 4, pid: 3_999_999, lstart: 'start gone', pgid: 3_999_999 };
  const a = await w.ticket({ failures: { planning: 4 }, lease: ended({ gen: 5, pending: { after: 'block', why: 'crash', prev } }) });
  assert.equal(await w.runner.restart(a), true);
  assert.deepEqual([w.get(a).state, w.spawns.map((s) => s.resume), w.lease(a).pending, w.lease(a).gen], ['planning', [false], undefined, 6]);
});

test('P5 (M1) a pending recovery whose old run had no start time: found by claude_bin + session (as adopt) and killed before the new run; ps failing → no spawn, next tick again; another session\'s pid untouched', async (t) => {
  const w = world(t);
  const [P, X] = [4_200_001, 4_200_002];
  w.procs.set(P, { ppid: 1, pgid: P, nice: 0, rss: 1, lstart: 'start P' });
  w.procs.set(X, { ppid: 1, pgid: X, nice: 0, rss: 1, lstart: 'start X' });
  w.args.set(P, `/nonexistent/claude -p --session-id ${ended().session} --output-format stream-json`);
  w.args.set(X, '/nonexistent/claude -p --session-id 22222222-2222-4222-8222-222222222222'); // another run
  const pend = (pid) => ended({ gen: 5, pid, lstart: '', pgid: pid, bin: '/nonexistent/claude', exit: 'paused', pending: { after: 'resume', why: 'restart', fresh: true, prev: { gen: 4, pid, lstart: '', pgid: pid } } });
  const bin = store.config.claude_bin;
  store.config.claude_bin = '/nonexistent/claude-2'; // L3: a pin switch while the old runs live: findRun goes by lease.bin
  t.after(() => { store.config.claude_bin = bin; });
  w.psFail = true;
  const [a, b] = [await w.ticket({ lease: pend(P) }), await w.ticket({ lease: pend(X) })];
  await w.step();
  assert.deepEqual([w.spawns.length, w.kills, w.lease(a).pending?.after, w.lease(b).pending?.after], [0, [], 'resume', 'resume'], 'ps failed: still pending, nothing spawned');
  w.psFail = false;
  await w.step(15_000);
  assert.equal(w.spawns.length, 0, 'R13: a failed attempt waits 30 s, not one tick');
  await w.step(15_000);
  assert.deepEqual([w.killsOf(P).map(([s]) => s), w.procs.has(P), w.killsOf(X), w.procs.has(X)], [['SIGINT'], false, [], true]);
  assert.deepEqual(w.spawns.map((s) => [s.id, s.resume]).sort(), [[a, false], [b, false]].sort());
  assert.equal(w.lease(a).bin, '/nonexistent/claude-2', 'L3: a lease keeps the binary it runs (findRun after a pin switch)');
});

test('P6 (H4) max_concurrent 1: a recovery (usage reset passed) and a T1 start in one tick → one run; the other waits with `slot` until it ends', async (t) => {
  const w = world(t);
  const max = store.config.max_concurrent;
  store.config.max_concurrent = 1;
  t.after(() => { store.config.max_concurrent = max; });
  const a = await w.ticket({ lease: ended({ exit: 'usage', resets_at: iso(w.clock - 1000) }) });
  const b = await w.ticket();
  await w.runner.tick();
  await w.until(() => [w.get(a).waiting?.reason, w.get(b).waiting?.reason].includes('slot') || w.spawns.length > 1, 'one waits with slot');
  assert.deepEqual([w.spawns.length, w.runner.view().system.runs], [1, 1]);
  const first = w.spawns[0].id;
  w.say(first, OK);
  w.exit(w.spawns[0].pid, 0);
  await w.runner.tick();
  await w.runner.idle();
  assert.deepEqual(w.spawns.map((s) => s.id).sort(), [a, b].sort(), 'the other one starts once the slot is free');
});

test('P7 (M3) Cancel (no lease yet) while the T1 start of the same tick is in flight → no run starts', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  const ticking = w.runner.tick();
  assert.equal(await w.runner.cancel(a), true);
  await ticking;
  await w.settle();
  assert.deepEqual([w.get(a).state, w.lease(a), w.spawns.length], ['cancelled', null, 0]);
});

test('I7 Irfan\'s Resume from Blocked resets that phase\'s failures to 0; automatic recoveries and a Resume outside Blocked never do', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'blocked', blocked_from: 'planning', failures: { planning: 4, working: 1 }, lease: ended() });
  assert.equal(await w.runner.resume(a), true);
  assert.deepEqual(w.get(a).failures, { planning: 0, working: 1 });
  w.exit(w.lease(a).pid, 1);
  await w.step();
  assert.deepEqual([w.get(a).failures, w.lease(a).gen], [{ planning: 1, working: 1 }, 5], 'an automatic recovery counts on');
  const b = await w.ticket({ failures: { planning: 2 }, lease: ended({ exit: 'paused' }) });
  assert.equal(await w.runner.resume(b), true);
  assert.deepEqual(w.get(b).failures, { planning: 2 }, 'not out of Blocked: kept');
});

test('I8 wall cap over the whole phase: automatic recoveries add up; Irfan\'s Resume starts a new clock', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, STATUS);
  await w.step(15 * MIN); // stalls: counted, resumed
  const s2 = Date.parse(w.lease(a).started_at);
  assert.deepEqual([w.lease(a).gen, w.get(a).wall], [2, { phase: 'planning', task: null, ms: 15 * MIN }]);
  w.say(a, TOOL); // busy from here
  await w.to(s2 + 15 * MIN - 15_000);
  assert.equal(w.get(a).state, 'planning', '15 + 14:45');
  await w.to(s2 + 15 * MIN);
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.get(a).failures], ['blocked', 'wall_cap', { planning: 1 }], '15 + 15');
  assert.equal(await w.runner.resume(a), true);
  const s3 = Date.parse(w.lease(a).started_at);
  assert.deepEqual(w.get(a).wall, { phase: 'planning', task: null, ms: 0 }, 'Irfan: a new clock');
  w.say(a, TOOL);
  await w.to(s3 + 30 * MIN - 15_000);
  assert.equal(w.get(a).state, 'planning');
  await w.to(s3 + 30 * MIN);
  assert.equal(w.get(a).state, 'blocked');
});

test('I8 pause time is not phase time; the phase clock is on the ticket, so a new tbd keeps it', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, TOOL);
  await w.step(10 * MIN);
  w.snap = { ...NORMAL, pressure: 'critical', at: 'c1' };
  await w.step();
  assert.deepEqual([w.lease(a).exit, w.get(a).wall.ms], ['paused', 10 * MIN]);
  await w.step(30 * MIN); // paused: not run time
  w.snap = { ...NORMAL, at: 'n1' };
  await w.step();
  const s2 = Date.parse(w.lease(a).started_at);
  w.say(a, TOOL);
  await w.to(s2 + 20 * MIN - 15_000);
  assert.equal(w.get(a).state, 'planning', '10 + 19:45: the 30 min pause not counted');
  await w.to(s2 + 20 * MIN);
  assert.deepEqual([w.get(a).state, w.lease(a).exit], ['blocked', 'wall_cap']);
  // another runner (a tbd restart) over a ticket.json with 15 min on the clock and a crashed 10 min run
  const v = world(t);
  const b = await v.ticket({ wall: { phase: 'planning', task: null, ms: 15 * MIN }, lease: ended() });
  await v.step();
  assert.deepEqual(v.get(b).wall, { phase: 'planning', task: null, ms: 25 * MIN });
  const s3 = Date.parse(v.lease(b).started_at);
  v.say(b, TOOL);
  await v.to(s3 + 5 * MIN - 15_000);
  assert.equal(v.get(b).state, 'planning');
  await v.to(s3 + 5 * MIN);
  assert.equal(v.get(b).state, 'blocked');
});

test('I8 I9b a new round of a phase (planning → clarify → planning after its run ended in a result) runs on its own clock; the same round never runs again', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'backlog' });
  await fsm.transition(store, a, 'planning', 'you', { assign: () => true });
  await w.step();
  w.say(a, STATUS);
  await w.step(15 * MIN); // stalls: resumed, 15 min on the phase clock
  w.say(a, OK);
  w.exit(w.lease(a).pid, 0);
  await w.step();
  assert.deepEqual([w.spawns.length, w.lease(a).exit, w.get(a).wall.ms], [2, 'result', 15 * MIN], 'this round has its result');
  await fsm.transition(store, a, 'clarify', 'runner', { questions: () => true });
  await fsm.transition(store, a, 'planning', 'you', { answers_complete: () => true });
  await w.step();
  assert.deepEqual([w.spawns.length, w.spawns[2]?.resume, w.lease(a).exit, w.get(a).wall.ms], [3, false, undefined, 0]);
});

test('M1 Resume in a new round of the phase (the lease is round 1\'s, ended in a result): a fresh session with the phase prompt, never round 1\'s session', async (t) => {
  const w = world(t);
  const a = await w.ticket({ round: 3, lease: ended({ round: 1, exit: 'result' }) });
  assert.equal(await w.runner.resume(a), true);
  assert.deepEqual(w.spawns.map((s) => [s.resume, s.session === ended().session, s.prompt]), [[false, false, store.renderMd(w.get(a))]]);
});

test('LOW `to` kept in pending: a Resume out of Blocked taken again after a tbd stop still calls the P5 gate seam', async (t) => {
  const w = world(t);
  const prev = { gen: 4, pid: 3_999_999, lstart: 'start gone', pgid: 3_999_999 };
  const a = await w.ticket({ lease: ended({ gen: 5, exit: 'max_turns', pending: { after: 'resume', why: 'resume', to: 'planning', prev } }) });
  await w.step();
  assert.deepEqual([w.gates, w.spawns.length], [[[a, 'planning']], 1]);
});

test('LOW the grace ends after wake_grace_min even if the run never spoke (a tool kept it busy): no recovery, and a crash after it counts', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, TOOL);
  await w.step(MIN);
  await w.lid(40_000);
  await w.sample();
  await w.step(7 * MIN);
  assert.deepEqual([w.kills, w.lease(a).gen], [[], 1]);
  w.exit(w.lease(a).pid, 1);
  await w.step();
  assert.deepEqual(w.get(a).failures, { planning: 1 });
});

test('LOW step 4 real git: no worktree (cwd = the ticket dir) never reports a repo above it; a dirty worktree is named', async (t) => {
  const w = world(t, { exec: async (file, args, opts) => (file === '/usr/bin/git' ? sh(file, args, opts) : { err: null, stdout: '', stderr: '' }) });
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(process.env.TB_HOME, 'init', '-q'); // a dirty repo above every ticket dir
  t.after(() => fs.rmSync(path.join(process.env.TB_HOME, '.git'), { recursive: true, force: true }));
  const wt = fs.mkdtempSync(path.join(root, 'wt-'));
  git(wt, 'init', '-q');
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
  const a = await w.ticket({ lease: ended() });
  const b = await w.ticket({ worktree: wt, lease: ended() });
  await w.step();
  const prompt = (id) => w.spawns.find((s) => s.id === id)?.prompt;
  assert.equal(prompt(a), RESUME_PROMPT);
  assert.equal(prompt(b), `${RESUME_PROMPT}\n\nThe working tree has uncommitted changes (git status --porcelain):\n?? x.txt\n`);
});

// ---- P3b fix loop 2: N1 (sleep during a tick), N2 (Cancel vs the T1 intent), Irfan I9 ----

// A world whose ps answers wait for `hold` (a tick in flight), as `world(t, holdPs())`.
function holdPs() {
  const h = { hold: null, release: () => {} };
  h.procs = async () => { await h.hold; return new Map([...h.w.procs].map(([p, x]) => [p, { ...x }])); };
  h.block = () => { h.hold = new Promise((r) => { h.release = () => { h.hold = null; r(undefined); }; }); };
  return h;
}

test('P7b (N2) a Cancel that saw no lease while the T1 intent write was queued: the fresh child is SIGKILLed, nothing tracked, ticket cancelled', async (t) => {
  let armed = null;
  const proxy = Object.create(store);
  proxy.updateTicket = (id, fn) => {
    const p = store.updateTicket(id, fn);
    if (armed && id === armed.id) { const go = armed.go; armed = null; go(); }
    return p;
  };
  const w = world(t, { store: proxy });
  const a = await w.ticket();
  let cancel;
  armed = { id: a, go: () => { cancel = w.runner.cancel(a); } }; // an HTTP Cancel lands right after the intent call
  await w.runner.tick();
  assert.equal(await cancel, true);
  await w.step(30_000);
  const pid = w.spawns[0]?.pid;
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.spawns.length, w.killsOf(pid).map(([s]) => s), w.procs.has(pid), w.runner.view().system.runs],
    ['cancelled', 'cancelled', 1, ['SIGKILL'], false, 0]);
});

test('P8 (N1) the lid closes while a tick awaits ps: the poll after it sees the jump first → grace, no stall, no failure; the OS wake counts the sleep once', async (t) => {
  const h = holdPs();
  const w = h.w = world(t, { procs: h.procs });
  const a = await w.ticket({ state: 'working' });
  await w.step();
  w.say(a, STATUS);
  await w.step(15_000);
  h.block();
  const ticking = w.runner.tick();
  await w.lid(20 * MIN); // asleep mid-tick
  h.release();
  await ticking;
  await w.runner.idle();
  await w.sample(); // the monitor, about 5 s later
  await w.settle();
  await store.flush();
  assert.deepEqual([w.kills, w.get(a).failures, w.lease(a).gen, w.lease(a).sleep_ms], [[], {}, 1, 20 * MIN]);
});

test('I9 a Resume back to an earlier phase resets the failures of that phase AND of the phase it blocked in', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'blocked', blocked_from: 'working', failures: { planning: 2, working: 4 }, lease: ended({ phase: 'working' }) });
  assert.equal(await w.runner.resume(a, { phase: 'planning' }), true);
  assert.deepEqual([w.get(a).state, w.get(a).failures, w.spawns.map((s) => s.resume)], ['planning', { planning: 0, working: 0 }, [false]], 'another phase: a fresh session');
});


// ---- P3b fix loop 3: code review R3 R4 ----

test('R4 a Restart while the phase handler still runs: the handler\'s move loses (lease gen changed), the restarted run lives', async (t) => {
  const w = world(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  let called = false;
  onResult = async () => { called = true; await gate; return { to: 'blocked' }; };
  t.after(() => { onResult = async () => undefined; });
  const a = await w.ticket();
  await w.step();
  w.say(a, OK);
  w.exit(w.lease(a).pid, 0);
  const ticking = w.runner.tick(); // the run's end: its handler waits on the gate
  await w.until(() => called, 'handler running');
  assert.equal(await w.runner.restart(a), true);
  release();
  await ticking;
  await w.settle();
  assert.deepEqual([w.get(a).state, w.spawns.length, w.lease(a).gen, w.lease(a).exit], ['planning', 2, 2, undefined]);
});

test('R3 HIGH1 the lid closes in the tail of a tick (a spawn in flight), 20 min on a silent run: the next tick\'s jump gives the grace, the OS wake the sleep_ms; no kill, no failure, no wall cap', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'working' });
  await w.step();
  w.say(a, STATUS);
  await w.step(15_000);
  let open;
  w.hold = new Promise((r) => { open = r; }); // b's spawn waits: the tick is in its tail (consider)
  const b = await w.ticket();
  const ticking = w.runner.tick();
  await w.until(() => w.lease(b)?.pid === null, 'b intent saved');
  await w.lid(20 * MIN);
  w.hold = null;
  open();
  await ticking;
  await w.runner.tick(); // a silent 20 min: the jump's grace holds the stall rule
  await w.sample(); // the OS wake
  await w.settle();
  await store.flush();
  assert.deepEqual([w.kills, w.get(a).failures, w.lease(a).gen, w.lease(a).sleep_ms, w.lease(a).exit], [[], {}, 1, 20 * MIN, undefined]);
});

test('HIGH1 cap hold: after a 40 min lid the runner ticks first and the run speaks before the monitor sample → no wall_cap (its sleep_ms is not in yet); the OS wake brings it', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, TOOL);
  await w.step(5 * MIN);
  await w.lid(40 * MIN);
  await w.runner.tick(); // the wall jump: a hint
  w.clock += 1000;
  w.say(a, TOOL); // it speaks: its grace ends, and 45 min look like run time to the cap
  await w.runner.tick();
  await w.runner.idle();
  await w.sample(); // the OS wake
  await w.settle();
  await store.flush();
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.lease(a).sleep_ms, w.kills], ['planning', undefined, 40 * MIN, []]);
});

test('HIGH1 dark wakes: an 82 min lid in 6 sleeps split by unsampled dark wakes (kern.* keep only the last, 693 s) → sleep_ms is the wall gap; no false wall_cap', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  w.say(a, TOOL);
  await w.step(5 * MIN);
  const segs = [72, 1012, 1075, 978, 992, 693].map((s) => s * 1000); // pmset 18:02 → 19:24
  const dark = [45, 2, 2, 2, 45].map((s) => s * 1000);
  for (const [i, ms] of segs.entries()) {
    await w.lid(ms);
    w.clock += dark[i] ?? 0; // awake a few seconds, no sample
  }
  await w.runner.tick();
  await w.sample();
  await w.step(7 * MIN); // the false Blocked came 7 min after the wake
  await store.flush();
  const gap = [...segs, ...dark].reduce((x, y) => x + y) - 5000; // the wall jump past one sample interval
  assert.deepEqual([w.get(a).state, w.lease(a).exit, w.lease(a).sleep_ms], ['planning', undefined, gap]);
});

test('R3 HIGH1 negative: a slow tick (40 s, no sleep: kern.waketime unchanged) is only a hint: grace, no stall, sleep_ms 0', async (t) => {
  const w = world(t);
  const a = await w.ticket({ state: 'working' });
  await w.step();
  w.say(a, STATUS);
  await w.step(14 * MIN + 30_000); // silent 14:30
  let open;
  w.hold = new Promise((r) => { open = r; }); // b's spawn takes 40 s: one tick that long
  const b = await w.ticket();
  const ticking = w.runner.tick();
  await w.until(() => w.lease(b)?.pid === null, 'b intent saved');
  w.clock += 40_000;
  w.hold = null;
  open();
  await ticking;
  await w.runner.tick(); // a silent 15:10, but the 40 s jump gave the grace
  await w.sample(); // no new kern.waketime: no OS wake
  await w.settle();
  await store.flush();
  assert.deepEqual([w.kills, w.get(a).failures, w.lease(a).gen, w.lease(a).sleep_ms], [[], {}, 1, 0]);
});

test('R15 boot: a re-attached run silent since before boot is not stalled until stall_min after boot, then counted', async (t) => {
  const w = world(t);
  const P = 4_300_011;
  w.procs.set(P, { ppid: 1, pgid: P, nice: 0, rss: 1, lstart: 'start P' });
  const live = { ...ended({ gen: 1, pid: P, lstart: 'start P', pgid: P, phase: 'working', started_at: iso(w.clock - 21 * MIN), last_event_at: iso(w.clock - 20 * MIN) }), exit: undefined, ended_at: undefined, failure: undefined };
  const a = await w.ticket({ state: 'working', lease: live });
  const f = path.join(store.ticketDir(a), live.log);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...STATUS, session_id: live.session }) + '\n');
  fs.utimesSync(f, (w.clock - 20 * MIN) / 1000, (w.clock - 20 * MIN) / 1000); // its last event: 20 min before boot
  const boot = w.clock;
  w.runner.start();
  await w.to(boot + 15 * MIN - 15_000);
  assert.deepEqual(w.killsOf(P), [], 'silent 35 min, 14:45 of it since boot');
  await w.to(boot + 15 * MIN);
  assert.deepEqual([w.killsOf(P).map(([s]) => s), w.get(a).failures], [['SIGINT'], { working: 1 }]);
});


test('LOW kept slot (max_concurrent 1): ps down while a stalled run dies → its slot is kept through the backoff (b waits), taken by the retry (a resumes, then b); a Cancel in a backoff takes it too (c starts)', async (t) => {
  let psDown = false;
  const w = world(t, { procs: async (fresh) => (psDown && fresh ? null : new Map([...w.procs].map(([p, x]) => [p, { ...x }]))) });
  const max = store.config.max_concurrent;
  store.config.max_concurrent = 1;
  t.after(() => { store.config.max_concurrent = max; });
  const a = await w.ticket();
  await w.step();
  w.say(a, STATUS);
  psDown = true;
  await w.step(15 * MIN); // a stalls; its recovery can't confirm it dead
  const b = await w.ticket();
  await w.step(15_000);
  assert.deepEqual([w.get(b).waiting?.reason, w.spawns.length], ['slot', 1], 'a may still live: its slot is kept');
  psDown = false;
  w.clock += 15_000;
  await w.runner.tick(); // the backoff is over: a is killed and resumed on the kept slot
  await w.until(() => w.spawns.length === 2, 'a resumed on the kept slot (a leaked slot never frees)');
  await w.runner.idle();
  assert.deepEqual(w.spawns.map((s) => [s.id, s.resume]), [[a, false], [a, true]]);
  w.say(a, OK);
  w.exit(w.lease(a).pid, 0);
  await w.step();
  assert.equal(w.spawns.at(-1).id, b, 'b after a');
  w.say(b, STATUS);
  psDown = true;
  await w.step(15 * MIN); // b stalls the same way; Irfan cancels it during the backoff
  psDown = false;
  assert.equal(await w.runner.cancel(b), true);
  const c = await w.ticket();
  await w.step();
  assert.deepEqual([w.get(b).state, w.spawns.at(-1).id], ['cancelled', c]);
});

test('P3d strays: claude runs each Bash call in its own process group; claude crashes → the run end still kills those kids and theirs (seen by a tick), never a pid reused since', async (t) => {
  const w = world(t);
  const a = await w.ticket();
  await w.step();
  const l = w.lease(a);
  const [K, K2, X] = [4_100_000, 4_100_001, 4_100_002];
  w.procs.set(K, { ppid: l.pid, pgid: K, nice: 0, rss: 1, lstart: 'start K' }); // a Bash call: its own group
  w.procs.set(K2, { ppid: K, pgid: K, nice: 0, rss: 1, lstart: 'start K2' }); // what it started
  w.procs.set(X, { ppid: l.pid, pgid: X, nice: 0, rss: 1, lstart: 'start X' });
  await w.step(); // a tick sees them
  w.procs.set(X, { ppid: 1, pgid: X, nice: 0, rss: 1, lstart: 'another process' }); // X ended, its pid reused
  w.procs.get(K).ppid = 1; // claude dies (OOM kill): its kids live on under launchd, out of its group and tree
  w.exit(l.pid, null);
  await w.step(5_000);
  assert.deepEqual([w.procs.has(K), w.procs.has(K2), w.procs.has(X)], [false, false, true], 'kids killed, the reused pid untouched');
  assert.deepEqual(w.killsOf(X), []);
  assert.equal(w.spawns.at(-1).resume, true, 'recovered as usual');
});
