'use strict';
// P2 AC1 monitor (spec §7, P2 contract lib/monitor.js): sysctl / vm_stat / pmset outputs recorded on this Mac + a
// small synthetic ps tree (test/fixtures/monitor) through a fake exec → snapshot in bytes + pressure words; pmset and
// Docker every 60 s; change only when the header view changes; wake on clock jump; disk crossing → one notification
// per crossing; net breaker; failed commands → null. HTTP: real server + real monitor (fake exec) → SSE `system`
// only on change. Live: harness tbd reports this Mac's real values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { startTbd, request } = require('./helpers/tbd');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
delete process.env.TB_TZ;
fs.mkdirSync(process.env.HOME);
const store = require('../lib/store');
const { createMonitor } = require('../lib/monitor');
const { createNotifier } = require('../lib/notify');
const { createServer, ready } = require('../lib/http');
store.init();

const GB = 1024 ** 3;
const FIX = path.join(__dirname, 'fixtures', 'monitor');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const AVAIL = (6961 + 99954 + 1669) * 16384; // vm_stat.txt: (free + inactive + speculative) × page size
const CLAUDE_KB = 300000 + 40000 + 120000 + 500000 + 200000 + 10000; // ps.txt: two claude trees + claude-2.1.292 copy
const T0 = Date.parse('2026-10-08T03:00:00.000Z'); // 10:00 Asia/Jakarta

// Monitor on fake exec / clock / statfs / connect. out = what each command prints (an Error = it fails).
function world() {
  /** @type {Record<string, any>} */
  const out = { sysctl: read('sysctl.txt'), vm_stat: read('vm_stat.txt'), pmset: read('pmset.txt'), ps: read('ps.txt') };
  const calls = [];
  const opts = [];
  const exec = (file, args, o, cb) => {
    const name = path.basename(file);
    calls.push(name);
    opts.push(o);
    setImmediate(() => (out[name] instanceof Error ? cb(out[name]) : cb(null, out[name], '')));
  };
  const clock = { ms: T0 };
  const disk = { gb: 30 };
  const link = { net: true, docker: false };
  const dials = [];
  const dial = async (opts) => { dials.push(opts.path ? 'docker' : `${opts.host}:${opts.port}`); return opts.path ? link.docker : link.net; };
  const statfs = async () => ({ bavail: Math.round((disk.gb * GB) / 4096), bsize: 4096 });
  const mon = createMonitor({ config: store.config, exec, clock: () => clock.ms, statfs, connect: dial, home: process.env.HOME });
  const events = { change: [], wake: [], disk: [] };
  for (const e of Object.keys(events)) mon.on(e, (d) => events[e].push(d));
  return {
    mon, out, calls, opts, clock, disk, link, dials, events,
    async tick(ms = 5000) { clock.ms += ms; await mon.sample(); },
  };
}

test('AC1 snapshot from real macOS outputs: bytes, pressure words, claude tree RSS once per process', async () => {
  const w = world();
  await w.mon.sample();
  assert.deepEqual(w.mon.snapshot(), {
    ram_total: 8589934592, ram_used: 8589934592 - AVAIL, avail: AVAIL, pressure: 'normal', level: 43,
    disk_free: 30 * GB, claude_rss: CLAUDE_KB * 1024, net: null, power: 'battery', docker: false, disk_warn: false,
    at: '2026-10-08T03:00:00.000Z',
  });
  for (const [raw, word] of [['2', 'warn'], ['4', 'critical'], ['1', 'normal'], ['0', null]]) {
    w.out.sysctl = `${raw}\n43\n8589934592\n`;
    await w.tick();
    assert.equal(w.mon.snapshot().pressure, word, `memorystatus_vm_pressure_level ${raw}`);
  }
});

test('AC1 failed commands → null fields, no throw; other signals still read', async () => {
  const w = world();
  w.out.sysctl = new Error('sysctl: timeout');
  w.out.ps = new Error('ps: timeout');
  await w.mon.sample();
  const s = w.mon.snapshot();
  assert.deepEqual([s.pressure, s.level, s.ram_total, s.ram_used, s.claude_rss], [null, null, null, null, null]);
  assert.equal(s.avail, AVAIL);
  assert.equal(s.disk_free, 30 * GB);
});

test('AC1 pmset + Docker every 60 s, the rest every 5 s; change event only when the header view changes', async () => {
  const w = world();
  await w.mon.sample(); // t=0
  for (let i = 0; i < 12; i++) await w.tick(); // t=5..60 s
  assert.equal(w.calls.filter((c) => c === 'sysctl').length, 13);
  assert.equal(w.calls.filter((c) => c === 'pmset').length, 2, 'pmset at 0 s and 60 s');
  assert.equal(w.dials.filter((d) => d === 'docker').length, 2, 'Docker socket at 0 s and 60 s');
  assert.equal(w.events.change.length, 1, 'same outputs for 60 s → only the first sample is a change');

  w.out.vm_stat = w.out.vm_stat.replace(/Pages free:\s+\d+/, 'Pages free: 6900'); // −1 MB: below header precision
  await w.tick();
  assert.equal(w.events.change.length, 1);
  w.out.vm_stat = w.out.vm_stat.replace(/Pages free:\s+\d+/, 'Pages free: 30000'); // +377 MB avail
  await w.tick();
  assert.equal(w.events.change.length, 2);
  assert.equal(w.events.change[1].avail, (30000 + 99954 + 1669) * 16384);
});

test('AC1 wake event when the wall clock jumps > 30 s between ticks (sleep or clock change)', async () => {
  const w = world();
  await w.mon.sample();
  await w.tick(5000);
  await w.tick(5000 + 29_000);
  assert.equal(w.events.wake.length, 0, '29 s late is not a wake');
  await w.tick(10 * 60_000);
  await w.tick(-60_000);
  assert.deepEqual(w.events.wake.map((e) => e.gap_ms), [10 * 60_000, -60_000]);
});

test('H6 snapshot() is null until the first sample, even after a net probe; the probe result shows in the first snapshot', async () => {
  const w = world();
  assert.equal(w.mon.snapshot(), null);
  await w.mon.probeNet();
  assert.equal(w.mon.snapshot(), null, 'a probe alone makes no snapshot');
  await w.mon.sample();
  assert.equal(w.mon.snapshot().net, true);
  assert.equal(w.mon.snapshot().pressure, 'normal');
});

test('H6 net is re-probed every 60 s while it is down, and on a wake even when it was up', async () => {
  const w = world();
  w.link.net = false;
  await w.mon.probeNet(); // as start() does
  await w.mon.sample();
  const settle = () => new Promise((r) => setImmediate(r));
  const net = () => w.dials.filter((d) => d !== 'docker').length;
  for (let i = 0; i < 11; i++) await w.tick(); // 5 .. 55 s
  assert.equal(net(), 1, 'not before 60 s');
  await w.tick(); // 60 s
  await settle();
  assert.equal(net(), 2);
  for (let i = 0; i < 12; i++) await w.tick();
  await settle();
  assert.equal(net(), 3, 'again 60 s later: down stays under watch (the breaker allows one per 30 s)');
  assert.equal(w.mon.snapshot().net, false);

  w.link.net = true;
  for (let i = 0; i < 12; i++) await w.tick();
  await settle();
  assert.equal(net(), 4);
  assert.equal(w.mon.snapshot().net, true, 'back up');
  for (let i = 0; i < 24; i++) await w.tick();
  await settle();
  assert.equal(net(), 4, 'up: no polling');

  await w.tick(10 * 60_000); // sleep/wake
  await settle();
  assert.equal(w.events.wake.length, 1);
  assert.equal(net(), 5, 'a wake re-probes');
});

test('H10 every command runs through lib/sh.js: a timeout and an output cap on each', async () => {
  const w = world();
  await w.mon.sample();
  assert.deepEqual([...new Set(w.calls)].sort(), ['pmset', 'ps', 'sysctl', 'vm_stat']);
  assert.equal(w.opts.length, 4);
  for (const o of w.opts) assert.deepEqual([o.timeout, o.maxBuffer, o.encoding], [4000, 10 << 20, 'utf8'], JSON.stringify(o));
});

test('AC2 disk < 15 GB → disk_warn + one notification per crossing; < 8 GB → stop notification; quiet hours hold it', async () => {
  const w = world();
  const calls = [];
  const n = createNotifier({ store, exec: (f, a, o, cb) => { calls.push([f, ...a]); cb(null, '', ''); }, now: () => w.clock.ms, enabled: true });
  w.mon.on('disk', n.disk);
  const banners = () => calls.filter((c) => c[0] === '/usr/bin/osascript').map((c) => `${c[8]} | ${c[9]}`);
  const warns = [];
  for (const gb of [30, 14, 15.5, 14, 7, 7, 30, 14]) {
    w.disk.gb = gb;
    await w.tick();
    warns.push(w.mon.snapshot().disk_warn);
  }
  assert.deepEqual(warns, [false, true, true, true, true, true, false, true], '1 GB hysteresis: 15.5 GB stays warn');
  assert.deepEqual(banners(), [
    'Disk space low | 14.0 GB free. Run tb gc to free space.',
    'Disk almost full: new runs stopped | 7.0 GB free. Run tb gc to free space.',
    'Disk space low | 14.0 GB free. Run tb gc to free space.',
  ]);
  assert.equal(calls.filter((c) => c[0] === '/usr/bin/afplay').length, 3);

  w.disk.gb = 30;
  await w.tick();
  w.clock.ms = Date.parse('2026-10-08T16:00:00.000Z'); // 23:00 local: quiet (D28)
  w.disk.gb = 14;
  await w.mon.sample();
  assert.equal(banners().length, 3, 'no banner in quiet hours');
  w.clock.ms = Date.parse('2026-10-09T00:30:00.000Z'); // 07:30 local
  n.tick();
  assert.equal(banners().at(-1), 'Disk space low | 14.0 GB free. Run tb gc to free space.', 'held alert sent when quiet hours end');
});

test('AC1 net probe: api.anthropic.com:443; breaker after 3 fails = at most one probe per 30 s; callers share a probe', async () => {
  const w = world();
  w.link.net = false;
  for (let i = 0; i < 3; i++) assert.equal(await w.mon.probeNet(), false);
  assert.equal(await w.mon.probeNet(), false);
  assert.deepEqual(w.dials, Array(3).fill('api.anthropic.com:443'), '4th call within 30 s does not dial');
  w.clock.ms += 30_000;
  w.link.net = true;
  assert.equal(await w.mon.probeNet(), true);
  assert.deepEqual(await Promise.all([w.mon.probeNet(), w.mon.probeNet()]), [true, true]);
  assert.equal(w.dials.length, 5, 'two concurrent callers → one dial');
  await w.mon.sample(); // snapshot() is null until the first sample
  assert.equal(w.mon.snapshot().net, true);
});

test('AC1 Docker = ~/.docker/run/docker.sock accepts a connection (real socket, temp HOME)', async (t) => {
  const sock = path.join(process.env.HOME, '.docker', 'run', 'docker.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const real = () => createMonitor({ config: store.config, exec: (f, a, o, cb) => cb(new Error('not needed')), statfs: async () => ({ bavail: 0, bsize: 0 }), home: process.env.HOME });
  const before = real();
  await before.sample();
  assert.equal(before.snapshot().docker, false, 'no socket → false');
  const server = net.createServer((c) => c.end()).listen(sock);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const later = real();
  await later.sample();
  assert.equal(later.snapshot().docker, true, 'listening socket → true');
});

test('AC1 HTTP: /api/state.system = monitor snapshot; SSE system event only when it changes', async (t) => {
  const w = world();
  const server = createServer();
  ready(createNotifier({ store, enabled: false }), w.mon);
  await once(server.listen(0, '127.0.0.1'), 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const state = async () => (await request(port, 'GET', '/api/state', undefined, { 'x-tb-token': store.token })).json.system;
  assert.equal((await state()).pressure, null, 'before the first sample');

  let text = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { 'x-tb-token': store.token } });
  t.after(() => req.destroy());
  req.on('response', (res) => { res.setEncoding('utf8'); res.on('data', (c) => (text += c)); });
  const frames = () => [...text.matchAll(/event: system\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]));
  const settle = () => new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 50 && !frames().length; i++) await settle();

  await w.mon.sample();
  await w.tick(); // unchanged → no frame
  w.out.sysctl = '2\n43\n8589934592\n';
  await w.tick();
  await settle();
  assert.deepEqual(frames().map((f) => f.pressure), [null, 'normal', 'warn'], 'connect frame, then one frame per change');
  const live = await state();
  assert.deepEqual(live, frames().at(-1));
  assert.deepEqual(live, { ...w.mon.snapshot(), runs: 0, max: 1, paused_until: null, paused_reason: null, usage_warning: false });
});

test('AC1 live: harness tbd reports real RAM, pressure, disk, claude RSS, power from this Mac', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  let s = {};
  for (let i = 0; i < 50 && !s.at; i++) {
    s = (await tbd.api('GET', '/api/state')).json.system;
    if (!s.at) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(s.ram_total >= GB, `ram_total ${s.ram_total}`);
  assert.ok(s.ram_used > 0 && s.ram_used < s.ram_total);
  assert.ok(['normal', 'warn', 'critical'].includes(s.pressure), `pressure ${s.pressure}`);
  assert.ok(s.level >= 0 && s.level <= 100);
  assert.ok(s.disk_free > 0);
  assert.ok(Number.isInteger(s.claude_rss));
  assert.ok(['ac', 'battery'].includes(s.power), `power ${s.power}`);
  assert.equal(s.docker, false, 'temp HOME has no Docker socket');
  assert.equal(s.disk_warn, s.disk_free < 15 * GB);
});
