'use strict';
// P3a fix loop H1 + M-e: lib/runner.js in-process (real store on a temp TB_HOME, real spawn of test/fake-claude.js),
// so a test can fail ps once and change the lease under a live run. slots is a recorder; kills are recorded, never
// sent (the fake runs exit on their own); launchd check off.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Env before any lib require: phases scans at load, store reads TB_HOME at load (AC10: never the real home).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-loop-'));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
process.env.TB_PHASES_DIR = path.join(root, 'phases');
process.env.FAKE_CLAUDE_SCENARIO = 'scenario.json'; // <run cwd = ticket dir>/scenario.json
fs.mkdirSync(process.env.HOME);
fs.mkdirSync(process.env.TB_HOME);
for (const ph of ['planning', 'working']) {
  const d = path.join(process.env.TB_PHASES_DIR, 'code', ph);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'prompt.md'), '# fixture\n');
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  fs.writeFileSync(path.join(d, 'result.schema.json'), '{"type":"object"}');
}
fs.writeFileSync(path.join(process.env.TB_HOME, 'config.json'), JSON.stringify({ claude_bin: path.join(__dirname, 'fake-claude.js') }));
require('./helpers/runs').passFakeEnv(); // FAKE_CLAUDE_SCENARIO through the claudeEnv allowlist
const handled = [];
const phases = require('../lib/phases');
for (const ph of ['planning', 'working']) phases.registerHandler(`code/${ph}`, async (t, output) => void handled.push({ id: t.id, output }));
const store = require('../lib/store');
const slotsLib = require('../lib/slots');
const { createRunner } = require('../lib/runner');

let psFails = 0; // the next n procs() calls answer null (ps failed)
const roots = [];
const errors = [];
let runner;
before(() => {
  store.init();
  runner = createRunner({
    store, tbHome: process.env.TB_HOME, port: 7777, launchd: () => false, kill: () => {}, caffeinate: () => ({ kill() {} }),
    slots: { registerRoot: (r) => void roots.push(r), endRun: async () => {}, usage: () => ({ alive: 0, spawned: 0 }) },
    system: () => ({ pressure: 'normal', avail: 64 * 2 ** 30, disk_free: 2 ** 40, docker: false }),
    procs: (fresh) => (psFails-- > 0 ? Promise.resolve(null) : slotsLib.procs(fresh)),
  });
  const error = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); error(...a); };
  runner.start();
});
after(async () => {
  await runner.stop();
  await store.releasePid();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (id) => store.getTicket(id);
async function until(fn, ms = 15_000, what = 'condition') {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`${what} not met in ${ms} ms`);
}
// A planning ticket whose run follows steps; the runner picks it up on its next tick.
async function ticket(steps) {
  const t = await store.createFlow({ text: 'loop test', kind: 'code' });
  fs.writeFileSync(path.join(store.ticketDir(t.id), 'scenario.json'), JSON.stringify({ steps }));
  await store.updateTicket(t.id, (k) => ({ ...k, state: 'planning' }));
  return t.id;
}

test('H1 a run this tbd spawned stays live while ps fails; its start time and slots root are filled on a later tick', async () => {
  psFails = 1; // the spawn's lstart lookup
  const id = await ticket([{ sleep_ms: 2500 }, { result: { structured_output: { answer: 'h1' } } }]);
  const l = await until(() => read(id).lease?.lstart && read(id).lease, 10_000, 'lstart filled');
  assert.equal(l.exit, undefined, 'still live after the failed ps');
  assert.deepEqual(roots.map((r) => [r.pid, r.lstart, r.runId]), [[l.pid, l.lstart, `${id}.1`]]);
  assert.match(roots[0].key, /^[0-9a-f]{32}$/);
  await until(() => read(id).lease.exit, 10_000, 'run ended');
  assert.equal(read(id).lease.exit, 'result');
  assert.deepEqual(handled.filter((h) => h.id === id).map((h) => h.output), [{ answer: 'h1' }]);
});

test('M-e a result whose run no longer holds the ticket lease (gen replaced, P3b) is ignored with a note', async () => {
  const id = await ticket([{ sleep_ms: 2500 }, { result: { structured_output: { answer: 'stale' } } }]);
  const l = await until(() => read(id).lease?.pid && read(id).lease, 10_000, 'run live');
  await store.updateTicket(id, (k) => ({ ...k, lease: { ...k.lease, gen: 99 } })); // P3b's recovery took the lease
  await until(() => errors.some((e) => e.includes(`${id}.${l.gen}: result ignored`)), 10_000, 'note');
  assert.deepEqual(handled.filter((h) => h.id === id), []);
  assert.deepEqual([read(id).state, read(id).lease.gen, read(id).lease.exit], ['planning', 99, undefined], 'the newer lease is untouched');
});
