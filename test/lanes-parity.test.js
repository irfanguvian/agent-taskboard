'use strict';
// M5.5 D (X14): a lane is a normal flow ticket + lane_of {id, task}; the parent owns what Irfan sees. Seeded ticket files
// (no runs): a lane is not a flow on /api/state or `tb list --flows`; GET parent has lanes[]; `tb show` prints them; a verb on
// a lane is 409 "act on the parent"; notify never pings for a lane.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, runTb, phaseFixture, PHASE_FILES } = require('./helpers/tbd');
const { ticket } = require('./helpers/runs');

const LANE_OF = { id: 't_par001', task: 'T2' };
const W = (over = {}) => ({ task: 'T2', tasks: [{ id: 'T2', status: 'running', attempt: 2, pre: null, head: null, commit: null, session: null }], tries: 0, unit_ms: null, scope: {}, denied: {}, gate: null, ...over });
const FILES = {
  'tickets/t_par001/ticket.json': ticket('t_par001', { state: 'blocked', waiting: { reason: 'lanes' }, work: { ...W(), lanes: { T2: 't_lan001' }, merging: null, serial: [] } }),
  // a lane done with its task, waiting merge while its parent waits (an open lane: boot keeps it; its next hook starts nothing)
  'tickets/t_lan001/ticket.json': ticket('t_lan001', { title: 'lane T2', state: 'working', waiting: { reason: 'merge' }, lane_of: LANE_OF, work: W({ tasks: [{ ...W().tasks[0], status: 'done' }] }) }),
};

test('P6 (+) a lane is not a flow: /api/state and `tb list --flows` list the parent only', async (t) => {
  const tbd = await startTbd({ files: FILES });
  t.after(() => tbd.stop());
  const flows = (await tbd.api('GET', '/api/state')).json.flows.map((f) => f.id);
  assert.deepEqual(flows, ['t_par001']);
  const out = (await runTb(['list', '--flows'], tbd)).stdout;
  assert.match(out, /t_par001/);
  assert.doesNotMatch(out, /t_lan001/);
});

test('P6 (+) GET parent has lanes[] built from work.lanes; a lane ticket has none', async (t) => {
  const tbd = await startTbd({ files: FILES });
  t.after(() => tbd.stop());
  const r = await tbd.api('GET', '/api/tickets/t_par001');
  assert.deepEqual(r.json.lanes, [{ id: 't_lan001', task: 'T2', state: 'working', waiting: { reason: 'merge' }, live: false, attempt: 2 }]);
  assert.equal((await tbd.api('GET', '/api/tickets/t_lan001')).json.lanes, undefined);
});

test('P6 (+) `tb show <parent>` prints the lanes table; the lanes wait reads as text', async (t) => {
  const tbd = await startTbd({ files: FILES });
  t.after(() => tbd.stop());
  const out = (await runTb(['show', 't_par001'], tbd)).stdout;
  assert.ok(out.includes('lanes[1]{task,id,state,waiting,live,attempt}:\n  T2,t_lan001,working,merge,no,2\n'), out);
  assert.ok(out.includes('waiting: waits for its lanes to finish\n'), out);
});

test('P6 (-) a verb on a lane is 409 "act on the parent", cookie routes too; the parent answers as before', async (t) => {
  const tbd = await startTbd({ files: FILES });
  t.after(() => tbd.stop());
  for (const op of ['cancel', 'resume', 'rework']) {
    const r = await tbd.api('POST', `/api/tickets/t_lan001/${op}`, {});
    assert.equal(r.status, 409, op);
    assert.deepEqual(r.json, { error: 't_lan001: a lane of t_par001: act on the parent' });
  }
  const cookie = await tbd.unlock();
  const csrf = (await tbd.api('GET', '/api/session/csrf', undefined, { 'x-tb-token': undefined, cookie })).json.csrf;
  const c = await tbd.api('POST', '/api/tickets/t_lan001/close', {}, { 'x-tb-token': undefined, cookie, 'sec-fetch-site': 'same-origin', 'x-tb-csrf': csrf });
  assert.deepEqual([c.status, c.json.error], [409, 't_lan001: a lane of t_par001: act on the parent']);
  assert.doesNotMatch(String((await tbd.api('POST', '/api/tickets/t_par001/rework', {})).json?.error), /a lane of/, 'the parent is not refused as a lane');
  assert.equal((await tbd.api('POST', '/api/tickets/t_nope99/cancel', {})).status, 404);
});

// in-process like notify.test.js: real store on a temp TB_HOME, fake clock, stubbed exec
test('P6 (-) notify: a lane waiting in clarify gives no banner, at once or after a restart scan; a plain flow does', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  Object.assign(process.env, { HOME: path.join(root, 'home'), TB_HOME: path.join(root, 'tbhome') });
  process.env.TB_PHASES_DIR = phaseFixture(path.join(root, 'phases'), { 'code/working': PHASE_FILES });
  fs.mkdirSync(process.env.HOME);
  require('../lib/phases').registerHandler('code/working', async () => {});
  const store = require('../lib/store');
  const { createNotifier } = require('../lib/notify');
  store.init();
  const calls = [];
  const exec = (file, args, o, cb) => { calls.push([file, ...args]); cb(null, '', ''); };
  const banners = () => calls.filter((c) => c[0] === '/usr/bin/osascript').length;
  const start = () => createNotifier({ store, exec, now: () => Date.parse('2026-10-07T03:00:00Z') }).start(); // 10:00 local, not quiet
  const lane = await store.createFlow({ text: 'a lane', kind: 'code' });
  await store.updateTicket(lane.id, (k) => ({ ...k, state: 'clarify', lane_of: LANE_OF })); // lane first: the scan sees it
  start();
  await store.updateTicket(lane.id, (k) => ({ ...k, rework: 1 }));
  assert.equal(banners(), 0, 'no banner for the lane');
  const flow = await store.createFlow({ text: 'a flow', kind: 'code' });
  await store.updateTicket(flow.id, (k) => ({ ...k, state: 'clarify' }));
  assert.equal(banners(), 1, 'a plain flow still pings');
});
