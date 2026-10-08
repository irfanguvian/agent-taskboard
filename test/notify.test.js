'use strict';
// P1 AC6 notify (D3, D28, REMIND_AT port): ticket waits → 1 banner + sound, re-ping every 30 min, stops on
// leave; quiet 22:00-07:00 silent + 07:00 summary; weekday "Do now" once per slot; TB_NOTIFY=0 silent;
// POST /api/notify-test. In-process: real store on a temp TB_HOME, fake clock, stubbed exec (osascript/afplay).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, phaseFixture, PHASE_FILES } = require('./helpers/tbd');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
process.env.TB_PHASES_DIR = phaseFixture(path.join(root, 'phases'), { 'code/working': PHASE_FILES });
delete process.env.TB_TZ;
fs.mkdirSync(process.env.HOME);
require('../lib/phases').registerHandler('code/working', async () => {});
const store = require('../lib/store');
const { createNotifier } = require('../lib/notify');
store.init();

const MIN = 60_000;
const at = (iso) => Date.parse(iso); // tz Asia/Jakarta = UTC+7; 2026-10-07 is a Wednesday

// New notifier with a fake clock; calls = every exec (file + argv). Tickets get cancelled after the test
// so the next notifier doesn't start out tracking them.
function setup(t, iso, opts = {}) {
  const clock = { ms: at(iso) };
  const calls = [];
  const exec = (file, args, o, cb) => { calls.push([file, ...args]); cb(null, '', ''); };
  const n = createNotifier({ store, exec, now: () => clock.ms, ...opts });
  n.start();
  const made = [];
  t.after(async () => { for (const id of made) await store.updateTicket(id, (k) => ({ ...k, state: 'cancelled', waiting: null })); });
  return {
    n, clock, calls,
    banners: () => calls.filter((c) => c[0] === '/usr/bin/osascript').map((c) => ({ title: c[8], message: c[9], subtitle: c[10] })),
    sounds: () => calls.filter((c) => c[0] === '/usr/bin/afplay').length,
    tickAfter(min) { clock.ms += min * MIN; n.tick(); },
    async flow(title) { const k = await store.createFlow({ text: title, kind: 'code' }); made.push(k.id); return k; },
  };
}
const move = (id, patch) => store.updateTicket(id, (k) => ({ ...k, ...patch }));

test('AC6 entering clarify → 1 banner + 1 sound; re-ping at 30 min; leaving the state stops pings', async (t) => {
  const s = setup(t, '2026-10-07T03:00:00Z'); // 10:00 local
  const k = await s.flow('Answer my questions');
  await move(k.id, { state: 'clarify' });
  assert.deepEqual(s.banners(), [{ title: 'Questions for you', message: 'Answer my questions', subtitle: '' }]);
  assert.equal(s.sounds(), 1);
  assert.deepEqual(s.calls.map((c) => c[0]), ['/usr/bin/osascript', '/usr/bin/afplay'], 'A9 absolute paths: PATH cannot swap them');
  assert.deepEqual(s.calls[0].slice(1, 8), ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)', '-e', 'end run', '--']);

  await move(k.id, { rework: 1 }); // same wait, new event: no second banner
  s.tickAfter(29);
  assert.equal(s.banners().length, 1);
  s.tickAfter(1);
  assert.deepEqual(s.banners().at(-1), { title: 'Still waiting: Questions for you', message: 'Answer my questions', subtitle: '' });
  assert.equal(s.sounds(), 2);

  await move(k.id, { state: 'planning' });
  s.tickAfter(30);
  s.tickAfter(30);
  assert.equal(s.banners().length, 2, 'no pings after the ticket left clarify');
});

test('AC6 plan_approval, blocked, waiting manual / needs_scope each ping; waiting memory does not', async (t) => {
  const s = setup(t, '2026-10-07T03:00:00Z');
  const k = await s.flow('Ticket W');
  await move(k.id, { waiting: { reason: 'memory', since: '2026-10-07T03:00:00Z' } });
  assert.equal(s.calls.length, 0, 'memory pause is not a wait on you');
  await move(k.id, { waiting: { reason: 'manual', since: '2026-10-07T03:00:00Z' } });
  await move(k.id, { waiting: { reason: 'needs_scope', since: '2026-10-07T03:00:00Z' } });
  await move(k.id, { state: 'plan_approval', waiting: null });
  await move(k.id, { state: 'blocked' });
  assert.deepEqual(s.banners().map((b) => b.title), ['Waiting on you: manual step', 'Waiting on you: scope', 'Plan ready to approve', 'Blocked']);
  assert.equal(s.sounds(), 4);
});

test('AC6 quiet hours: 22:30 entry silent, night silent, 07:00 one summary, re-ping 30 min later', async (t) => {
  const s = setup(t, '2026-10-07T15:30:00Z'); // 22:30 local
  const k = await s.flow('Approve me');
  await move(k.id, { state: 'plan_approval' });
  for (const min of [60, 240, 209]) s.tickAfter(min); // 23:30, 03:30, 06:59
  assert.equal(s.calls.length, 0, 'no banner, no sound, no re-ping 22:00-07:00');
  s.tickAfter(1); // 07:00
  assert.deepEqual(s.banners(), [{ title: '1 waiting on you', message: 'Approve me', subtitle: '' }]);
  assert.equal(s.sounds(), 1);
  s.tickAfter(29);
  assert.equal(s.banners().length, 1);
  s.tickAfter(1);
  assert.equal(s.banners().at(-1).title, 'Still waiting: Plan ready to approve');

  await move(k.id, { state: 'working' }); // nothing waits: next morning has no summary
  s.tickAfter(16 * 60); // 23:30
  s.tickAfter(7.5 * 60); // 07:00
  assert.equal(s.banners().length, 2);
});

// FX-1 F2 (heavy slot revoked) + disk: one-off alerts
test('alert(): banner now in the day; in quiet hours held (latest per title) and sent once at 07:00', async (t) => {
  const s = setup(t, '2026-10-07T15:30:00Z'); // 22:30 local
  s.n.alert({ title: 'Heavy slot revoked', message: 'heavy slot revoked after 60 min: npm' });
  s.n.alert({ title: 'Heavy slot revoked', message: 'heavy slot revoked after 60 min: docker' });
  s.tickAfter(60);
  assert.equal(s.calls.length, 0, 'silent 22:00-07:00');
  s.tickAfter(7.5 * 60); // 07:00
  assert.deepEqual(s.banners(), [{ title: 'Heavy slot revoked', message: 'heavy slot revoked after 60 min: docker', subtitle: '' }]);
  s.n.alert({ title: 'Heavy slot revoked', message: 'heavy slot revoked after 60 min: make' });
  assert.equal(s.banners().length, 2, 'daytime: at once');
  s.tickAfter(30);
  assert.equal(s.banners().length, 2, 'not repeated');
});

test('AC6 REMIND_AT: weekday slot fires "Do now" once with v1 text; off-slot and weekend do not', async (t) => {
  await store.addReminder({ title: 'Ship it', status: 'now' });
  await store.addReminder({ title: 'Second', status: 'now' });
  await store.addReminder({ title: 'Sort me' });
  await store.addReminder({ title: 'Late', status: 'next', due: '2026-10-01' });
  const s = setup(t, '2026-10-07T02:00:00Z'); // Wed 09:00:00 local
  s.n.tick();
  s.clock.ms += 20_000;
  s.n.tick();
  s.clock.ms += 20_000;
  s.n.tick();
  assert.deepEqual(s.banners(), [{ title: 'Do now', message: 'Ship it', subtitle: '2 in Now · 1 overdue · 1 in Inbox' }]);
  assert.equal(s.sounds(), 0, '"Do now" is a banner only, as v1');
  s.tickAfter(1); // 09:01
  assert.equal(s.banners().length, 1);
  s.clock.ms = at('2026-10-07T06:00:00Z'); // 13:00
  s.n.tick();
  assert.equal(s.banners().length, 2);
  s.clock.ms = at('2026-10-10T02:00:00Z'); // Sat 09:00
  s.n.tick();
  s.clock.ms = at('2026-10-11T09:30:00Z'); // Sun 16:30
  s.n.tick();
  assert.equal(s.banners().length, 2, 'weekend is silent');
  s.clock.ms = at('2026-10-12T09:30:00Z'); // Mon 16:30
  s.n.tick();
  assert.equal(s.banners().length, 3);
});

test('AC6 startup: tickets already waiting are tracked silently, re-ping on schedule', async (t) => {
  const pre = await store.createFlow({ text: 'Waiting before start', kind: 'code' });
  await move(pre.id, { state: 'blocked' });
  const s = setup(t, '2026-10-07T03:00:00Z');
  t.after(() => move(pre.id, { state: 'cancelled' }));
  assert.equal(s.calls.length, 0);
  s.tickAfter(30);
  assert.deepEqual(s.banners(), [{ title: 'Still waiting: Blocked', message: 'Waiting before start', subtitle: '' }]);
});

test('AC6 TB_NOTIFY=0: no banner, no sound for waits, re-pings or Do now', async (t) => {
  process.env.TB_NOTIFY = '0';
  const s = setup(t, '2026-10-07T02:00:00Z'); // Wed 09:00
  delete process.env.TB_NOTIFY;
  const k = await s.flow('Silent one');
  await move(k.id, { state: 'clarify' });
  s.n.tick();
  s.tickAfter(30);
  assert.equal(s.n.doNow().sent, false);
  assert.equal(s.calls.length, 0);
});

// A9
test('AC6 POST /api/notify-test: 401 without token, 200 {sent, top, extra}; live tbd execs /usr/bin/osascript argv', async (t) => {
  const tbd = await startTbd(); // harness: TB_NOTIFY=0
  t.after(() => tbd.stop());
  assert.equal((await tbd.api('POST', '/api/notify-test', {}, { 'x-tb-token': undefined })).status, 401);
  const r = await tbd.api('POST', '/api/notify-test', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sent: false, top: 'Nothing in Now. Pick one from Next.', extra: '0 in Now' });

  // Preload for the live tbd: logs each execFile as file|argv| instead of running it (no real banner).
  const log = path.join(root, 'exec.log');
  const pre = path.join(root, 'exec-log.js');
  fs.writeFileSync(pre, `const cp = require('node:child_process');\nconst fs = require('node:fs');\ncp.execFile = (file, args, opts, cb) => { fs.appendFileSync(${JSON.stringify(log)}, [file, ...args, ''].join('|') + '\\n'); cb(null, '', ''); };\n`);
  const live = await startTbd({
    env: { TB_NOTIFY: '1', NODE_OPTIONS: `--require ${pre}` },
    files: { 'tasks.json': { tasks: [{ id: 't_aaaaa1', title: 'Top task', status: 'now', created: '2026-10-01' }] } },
  });
  t.after(() => live.stop());
  const sent = await live.api('POST', '/api/notify-test', {});
  assert.deepEqual(sent.json, { sent: true, top: 'Top task', extra: '1 in Now' });
  // P2: the monitor also execs (sysctl, vm_stat, ps, pmset), so look only at notifier binaries.
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => /^\/usr\/bin\/(osascript|afplay)\|/.test(l));
  assert.match(lines.at(-1), /^\/usr\/bin\/osascript\|.*\|--\|Do now\|Top task\|1 in Now\|$/);
  assert.ok(lines.every((l) => l.startsWith('/usr/bin/osascript|')), 'banner only, no afplay'); // a live REMIND_AT minute may add a 2nd Do now
});

test('AC6 tbd refuses to start on a malformed notify.quiet', async () => {
  await assert.rejects(startTbd({ files: { 'config.json': { notify: { quiet: 'late' } } } }), /notify\.quiet must look like 22:00-07:00/);
});
