'use strict';
// P2 AC4 (qa:<tag> locks), AC5 (subagent budget, persistence across a tbd restart) and the socket contract
// (0600, one JSON line each way, path < 104 bytes): lib/slots.js inside a real tbd (harness temp HOME + TB_HOME).
// FX-1 F1-F4: nonce-bound lease re-claim, run-root ancestry, caps, totals-only status (some in-process slots).
// Fix loop 2 N2 N4-N7 N10 N11: run keys, coalesced fresh ps, per-run sessions, first-line deadline, lock max
// hold, sanitized cmd, release proof. Kills and renices only through spies that reach this test's own processes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { startTbd, isolatedEnv, SLOT_ROOT, TBD } = require('./helpers/tbd');
const { call, createSlots, procs } = require('../lib/slots');
const sh = require('../lib/sh');

let tbd;
let sock;
let run; // the test process's run key (N2): its children acquire with it
const nonce = 'c3'.repeat(16); // N11: releases prove the acquirer with it
before(async () => {
  tbd = await startTbd({ env: { NODE_OPTIONS: SLOT_ROOT } }); // test process = a run root: its children may hold
  sock = path.join(tbd.tbHome, 'tbd.sock');
  run = tbd.runKey;
});
after(() => tbd.stop());

// A live process to own leases; SIGKILLed in t.after.
function sleeper(t) {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => c.kill('SIGKILL'));
  return c;
}
const died = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r(undefined) : c.on('exit', () => r(undefined))));
const settled = (p, ms) => Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(r, ms, 'pending'))]);
const status = (s = sock) => call(s, { op: 'status' }, { timeoutMs: 2000 });
const saved = (home = tbd.tbHome) => JSON.parse(fs.readFileSync(path.join(home, 'slots.json'), 'utf8'));
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  throw new Error(`condition not met in ${ms} ms`);
}

// Runs /bin/sh -c script; its stdout pids are returned and SIGKILLed in t.after. Background jobs it leaves
// are reparented to launchd once sh exits: processes outside every run tree.
function orphans(t, script) {
  return new Promise((resolve) => execFile('/bin/sh', ['-c', script], (e, out) => {
    const pids = out.trim().split(/\s+/).map(Number).filter((p) => Number.isInteger(p) && p > 1); // never 0 (own group) or 1
    t.after(() => reap(pids));
    resolve(pids);
  }));
}

// SIGKILLs pids this test started; never pid 0 (own group), 1 or a non-number.
const reap = (pids) => pids.forEach((p) => { if (Number.isInteger(p) && p > 1) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } });

// In-process slots on its own temp TB_HOME (here "tbd" is the test process); stopped in t.after. kill and
// renice are no-op spies unless a test passes its own (allow-listing only processes it started).
async function local(t, opts = {}, create = createSlots) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const s = create({ tbHome: home, config: {}, kill: () => {}, exec: async () => ({ err: null, stdout: '', stderr: '' }), ...opts });
  await s.start();
  t.after(async () => { await s.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return Object.assign(s, { sock: path.join(home, 'tbd.sock') });
}

function raw(line) {
  return new Promise((resolve, reject) => {
    let text = '';
    const s = net.connect(sock, () => s.write(line));
    s.setEncoding('utf8');
    s.on('data', (c) => (text += c)).on('end', () => resolve(JSON.parse(text))).on('error', reject);
  });
}

test('socket is 0600 and speaks one JSON line each way; bad requests get an error, not a hang', async () => {
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  const s = await status();
  assert.equal(s.ok, true);
  assert.deepEqual(s.slots.heavy, { capacity: 1, held: [], waiting: [] });
  assert.deepEqual(s.runs, []);
  assert.match((await call(sock, { op: 'nope' })).error, /^unknown op "nope"; ops: slot\.acquire/);
  assert.deepEqual(await raw('not json\n'), { ok: false, error: 'request must be one JSON object on one line' });
  assert.deepEqual(await raw('[1]\n'), { ok: false, error: 'request must be one JSON object on one line' });
  assert.equal((await call(sock, { op: 'lock.acquire', name: 'bad name!', pid: process.pid })).ok, false);
  const gone = spawn('true');
  await died(gone);
  assert.deepEqual(await call(sock, { op: 'slot.acquire', pid: gone.pid, cmd: 'x' }), { ok: false, error: `pid ${gone.pid} is not running` });
});

test('AC4 qa:<tag> lock is exclusive: the 2nd acquirer waits until release; other names are independent', async (t) => {
  const a = sleeper(t);
  const b = sleeper(t);
  const first = await call(sock, { op: 'lock.acquire', name: 'qa:shop', pid: a.pid, run, nonce });
  assert.equal(first.ok, true);
  const second = call(sock, { op: 'lock.acquire', name: 'qa:shop', pid: b.pid, run });
  assert.equal(await settled(second, 400), 'pending');
  assert.equal((await call(sock, { op: 'lock.acquire', name: 'qa:blog', pid: b.pid, run })).ok, true, 'other tag not blocked');
  const locks = (await status()).locks.filter((l) => l.name === 'qa:shop');
  assert.deepEqual(locks.map((l) => [l.pid, l.waiting]), [[a.pid, 1]]);
  assert.deepEqual(await call(sock, { op: 'lock.release', lease: first.lease, nonce }), { ok: true });
  const got = await second;
  assert.equal(got.ok, true);
  assert.ok(got.waited_ms >= 300, `waited ${got.waited_ms} ms`);
  assert.equal((await call(sock, { op: 'lock.release', lease: first.lease, nonce })).ok, false, 'double release refused');
});

test('AC4 a dead lock holder frees the lock for the waiter', async (t) => {
  const a = sleeper(t);
  const b = sleeper(t);
  assert.equal((await call(sock, { op: 'lock.acquire', name: 'qa:dead', pid: a.pid, run })).ok, true);
  const waiter = call(sock, { op: 'lock.acquire', name: 'qa:dead', pid: b.pid, run });
  assert.equal(await settled(waiter, 300), 'pending');
  a.kill('SIGKILL');
  assert.equal(await settled(waiter, 5000), 'settled', 'freed by the 2 s liveness sweep');
  assert.equal((await waiter).ok, true);
});

test('AC5 10 concurrent subagent.request in one session → exactly 3 ok, 7 denied; sessions independent; live counters', async () => {
  const res = await Promise.all(Array.from({ length: 10 }, () => call(sock, { op: 'subagent.request', session: 's-ten' })));
  assert.deepEqual(res.filter((r) => r.ok).map((r) => r.used).sort(), [1, 2, 3]);
  const denied = res.filter((r) => !r.ok);
  assert.equal(denied.length, 7);
  for (const d of denied) assert.deepEqual(d, { ok: false, denied: true, used: 3, message: 'subagent budget used (3/3); do the rest yourself' });
  assert.deepEqual(await call(sock, { op: 'subagent.request', session: 's-other' }), { ok: true, used: 1 });
  await call(sock, { op: 'subagent.start', session: 's-ten' });
  await call(sock, { op: 'subagent.start', session: 's-ten' });
  assert.deepEqual(await call(sock, { op: 'subagent.stop', session: 's-ten' }), { ok: true, alive: 1, spawned: 3 });
  assert.deepEqual([saved().subagents['tbd:s-ten'].alive, saved().subagents['tbd:s-ten'].spawned], [1, 3]); // no run key: 'tbd:'
  assert.equal((await call(sock, { op: 'subagent.request', session: '' })).ok, false);
});

test('AC5 leases and counters survive a tbd restart; dead-pid and reused-pid leases are dropped', async (t) => {
  const a = sleeper(t);
  const b = sleeper(t);
  const heavy = await call(sock, { op: 'slot.acquire', pid: a.pid, cmd: 'npm test', run, nonce });
  await call(sock, { op: 'lock.acquire', name: 'qa:keep', pid: a.pid, run });
  await call(sock, { op: 'lock.acquire', name: 'qa:drop', pid: b.pid, run });
  await call(sock, { op: 'subagent.request', session: 's-restart' });
  await call(sock, { op: 'subagent.request', session: 's-restart' });
  const seed = saved();
  const keep = seed.leases.find((l) => l.key === 'lock:qa:keep');
  seed.leases.push({ ...keep, lease: 'f'.repeat(32), key: 'lock:qa:reused', lstart: 'Thu Jan 1 00:00:00 1970' }); // pid reused since
  seed.subagents['tbd:s-stale'] = { alive: 2, spawned: 1, at: '2026-01-01T00:00:00.000Z' }; // F4: a stop that never came
  b.kill('SIGKILL');
  await died(b);
  await call(sock, { op: 'slot.release', lease: heavy.lease, nonce }); // tbd #1 frees: tbd #2 must still see it held

  const tbd2 = await startTbd({ files: { 'slots.json': seed } });
  t.after(() => tbd2.stop());
  const sock2 = path.join(tbd2.tbHome, 'tbd.sock');
  const s = await status(sock2);
  assert.deepEqual(s.slots.heavy.held.map((h) => [h.pid, h.cmd]), [[a.pid, 'npm']]);
  assert.deepEqual(s.locks.map((l) => [l.name, l.pid]), [['qa:keep', a.pid]]);
  assert.deepEqual(await call(sock2, { op: 'subagent.request', session: 's-restart' }), { ok: true, used: 3 });
  assert.equal((await call(sock2, { op: 'subagent.request', session: 's-restart' })).denied, true);
  assert.deepEqual(saved(tbd2.tbHome).leases.map((l) => l.key).sort(), ['heavy', 'lock:qa:keep']);
  // F4: idle 6 h+ sessions are pruned even with alive > 0; slots.json is compact JSON
  await until(() => !saved(tbd2.tbHome).subagents['tbd:s-stale']);
  assert.ok(saved(tbd2.tbHome).subagents['tbd:s-restart']);
  assert.doesNotMatch(fs.readFileSync(path.join(tbd2.tbHome, 'slots.json'), 'utf8'), /\n /);
});

test('tbd refuses to start when TB_HOME/tbd.sock would be 104+ bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tbHome = path.join(root, 'x'.repeat(100));
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(tbHome);
  const child = spawn(process.execPath, [TBD], { env: isolatedEnv({ home: path.join(root, 'home'), tbHome, port: 0 }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 1);
  assert.match(err, /^error: socket path .*tbd\.sock is \d+ bytes \(max 103\); use a shorter TB_HOME$/m);
  assert.equal(fs.existsSync(path.join(tbHome, 'tbd.pid')), false, 'pid file released');
});

// F1
test('F1 lease theft: the holder pid without its nonce gets no lease; only the holder retry with its own nonce does', async (t) => {
  const a = sleeper(t);
  const nonce = 'a1'.repeat(16);
  const heavy = await call(sock, { op: 'slot.acquire', pid: a.pid, nonce, cmd: 'npm test', run });
  const lock = await call(sock, { op: 'lock.acquire', name: 'qa:f1', pid: a.pid, nonce, run });
  assert.deepEqual([heavy.ok, lock.ok], [true, true]);
  for (const thief of [{}, { nonce: 'b2'.repeat(16) }]) { // knows pid + start time (ps), not the nonce
    assert.deepEqual(await call(sock, { op: 'slot.acquire', pid: a.pid, cmd: 'x', run, ...thief }, { timeoutMs: 2000 }),
      { ok: false, error: `pid ${a.pid} already holds or waits for heavy` });
    assert.deepEqual(await call(sock, { op: 'lock.acquire', name: 'qa:f1', pid: a.pid, run, ...thief }, { timeoutMs: 2000 }),
      { ok: false, error: `pid ${a.pid} already holds or waits for lock:qa:f1` });
  }
  assert.deepEqual(await call(sock, { op: 'slot.acquire', pid: a.pid, nonce, cmd: 'npm test', run }), { ok: true, lease: heavy.lease, waited_ms: 0 });
  assert.equal((await call(sock, { op: 'lock.acquire', name: 'qa:f1', pid: a.pid, nonce, run })).lease, lock.lease);
  assert.equal((await call(sock, { op: 'slot.acquire', pid: a.pid, nonce: 'short' })).error, 'nonce must be 32-128 hex chars (16+ random bytes)');
  assert.ok(!fs.readFileSync(path.join(tbd.tbHome, 'slots.json'), 'utf8').includes(nonce), 'slots.json keeps only a hash');
  await call(sock, { op: 'slot.release', lease: heavy.lease, nonce });
  await call(sock, { op: 'lock.release', lease: lock.lease, nonce });
});

// F2
test('F2 only processes under tbd or a registered run may acquire: an unrelated long-lived pid, pid 1 and tbd itself are refused', async (t) => {
  const [stray] = await orphans(t, 'sleep 300 >/dev/null 2>&1 & echo $!');
  await new Promise((r) => setTimeout(r, 600)); // outlive tbd's 500 ms ps cache from before the reparent
  const refused = (pid) => ({ ok: false, error: `pid ${pid} is not under this run's root` });
  assert.deepEqual(await call(sock, { op: 'slot.acquire', pid: stray, cmd: 'x', run }, { timeoutMs: 2000 }), refused(stray));
  assert.deepEqual(await call(sock, { op: 'lock.acquire', name: 'qa:f2', pid: stray, run }, { timeoutMs: 2000 }), refused(stray));
  const tbdPid = Number(fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8'));
  assert.deepEqual(await call(sock, { op: 'slot.acquire', pid: tbdPid, cmd: 'x', run }, { timeoutMs: 2000 }), refused(tbdPid));
  assert.equal((await call(sock, { op: 'slot.acquire', pid: 1, cmd: 'x', run })).ok, false);
  const child = sleeper(t); // child of the registered test root
  const ok = await call(sock, { op: 'slot.acquire', pid: child.pid, cmd: 'x', run, nonce }, { timeoutMs: 2000 });
  assert.equal(ok.ok, true);
  await call(sock, { op: 'slot.release', lease: ok.lease, nonce });
});

// F2
test('F2 registerRoot / unregisterRoot: a registered root\'s child may acquire; unregistered or a stale start time may not', async (t) => {
  const slots = await local(t);
  // root: an sh outside the test's tree (reparented to launchd) with a sleep child
  const [root, kid] = await orphans(t, "/bin/sh -c 'sleep 300 >/dev/null 2>&1 & echo $$ $!; exec >/dev/null 2>&1; wait' &");
  let m;
  await until(async () => (m = await procs(true)).get(root)?.ppid === 1);
  const acq = (key) => call(slots.sock, { op: 'slot.acquire', pid: kid, cmd: 'x', nonce, ...(key && { run: key }) }, { timeoutMs: 2000 });
  assert.equal((await acq()).ok, false, 'not registered');
  const stale = slots.registerRoot({ pid: root, lstart: 'Thu Jan  1 00:00:00 1970', runId: 'stale' });
  assert.equal((await acq(stale)).ok, false, 'root pid with another start time (pid reused)');
  const key = slots.registerRoot({ pid: root, lstart: m.get(root).lstart, runId: 'r1' });
  assert.match(key, /^[0-9a-f]{32}$/); // N2
  const got = await acq(key);
  assert.equal(got.ok, true);
  await call(slots.sock, { op: 'slot.release', lease: got.lease, nonce });
  slots.unregisterRoot('r1');
  assert.deepEqual(await acq(key), { ok: false, error: 'unknown run key (wrong, or the run ended)' }, 'unregistered');
  assert.throws(() => slots.registerRoot({ pid: 'x', lstart: '', runId: 'r' }), /registerRoot needs/);
  assert.throws(() => slots.registerRoot({ pid: root, lstart: m.get(root).lstart, runId: 'a:b' }), /runId must match/, "':' would collide session keys");
});

// F2
test('F2 caps: 256 subagent sessions, 32 lock names, 64 waiters, 128 connections', async (t) => {
  const slots = await local(t);
  const ask = (msg) => call(slots.sock, msg, { timeoutMs: 2000 });
  const res = [];
  for (let i = 0; i < 300; i++) res.push(await ask({ op: 'subagent.request', session: `s${i}` }));
  assert.equal(res.filter((r) => r.ok).length, 256);
  assert.deepEqual(res[299], { ok: false, error: 'too many subagent sessions (max 256)' });
  assert.deepEqual(await ask({ op: 'subagent.request', session: 's0' }), { ok: true, used: 2 }, 'known session still served');
  assert.deepEqual((await ask({ op: 'status' })).subagents, { sessions: 256, alive_total: 0 });

  const holder = sleeper(t);
  for (let i = 0; i < 32; i++) assert.equal((await ask({ op: 'lock.acquire', name: `n${i}`, pid: holder.pid })).ok, true);
  assert.deepEqual(await ask({ op: 'lock.acquire', name: 'n32', pid: holder.pid }), { ok: false, error: 'too many lock names (max 32)' });

  assert.equal((await ask({ op: 'slot.acquire', pid: holder.pid, cmd: 'x' })).ok, true);
  const others = Array.from({ length: 65 }, () => sleeper(t));
  const waits = others.slice(0, 64).map((c) => call(slots.sock, { op: 'slot.acquire', pid: c.pid, cmd: 'x' }).catch(() => null));
  await until(async () => (await ask({ op: 'status' })).slots.heavy.waiting.length === 64, 10_000);
  assert.deepEqual(await ask({ op: 'slot.acquire', pid: others[64].pid, cmd: 'x' }), { ok: false, error: 'too many waiters (max 64)' });
  assert.equal((await ask({ op: 'lock.acquire', name: 'n0', pid: others[64].pid })).ok, false, 'lock n0 full: also a waiter');
  holder.kill('SIGKILL'); // frees heavy + locks: one waiter gets heavy
  assert.equal((await Promise.race(waits)).ok, true);

  // waiter connections stay open: fill up to 128, the next one is closed unanswered
  const open = (await ask({ op: 'status' })).slots.heavy.waiting.length;
  const idle = [];
  t.after(() => idle.forEach((c) => c.destroy()));
  for (let i = open; i < 128; i++) idle.push(await new Promise((r) => { const c = net.connect(slots.sock, () => r(c)); c.on('error', () => {}); }));
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(ask({ op: 'status' }), (/** @type {any} */ e) => ['ECONNRESET', 'EPIPE'].includes(e.code)); // closed before or after our write
  idle.splice(0, 8).forEach((c) => c.destroy());
  await until(async () => (await ask({ op: 'status' }).catch(() => ({}))).ok);
});

// F3
test('F3 status shows totals and first command words only: no session ids, no full command lines', async (t) => {
  const a = sleeper(t);
  const got = await call(sock, { op: 'slot.acquire', pid: a.pid, cmd: 'deploy --token=hunter2 now', run, nonce });
  await call(sock, { op: 'subagent.request', session: 'sess-private-id' });
  await call(sock, { op: 'subagent.start', session: 'sess-private-id' });
  const s = await status();
  assert.deepEqual(s.slots.heavy.held.map((h) => [h.pid, h.cmd]), [[a.pid, 'deploy']]);
  assert.deepEqual(Object.keys(s.subagents), ['sessions', 'alive_total']);
  assert.ok(s.subagents.sessions >= 1 && s.subagents.alive_total >= 1);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('sess-private-id') && !text.includes('hunter2'), text);
  await call(sock, { op: 'subagent.stop', session: 'sess-private-id' });
  await call(sock, { op: 'slot.release', lease: got.lease, nonce });
});

// A child sh whose background sleep leads its own process group (set -m), like tbx's detached command.
// Resolves {sh, job} pids; both SIGKILLed in t.after.
function groupJob(t) {
  const c = spawn('/bin/sh', ['-c', 'set -m; sleep 300 >/dev/null 2>&1 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => c.stdout.once('data', (d) => {
    const job = Number(String(d).trim());
    t.after(() => reap([job, c.pid]));
    resolve({ sh: c.pid, job });
  }));
}

// F7
test('F7 tbd renices the heavy holder\'s command groups to the slot nice level (sandboxed agents cannot nice); other groups untouched', async (t) => {
  const base = os.getPriority(); // the level sits above whatever nice this test runs at: renice can only raise it
  const level = base + 5;
  assert.ok(level <= 20, `test runs at nice ${base}; needs 15 or less`);
  const calls = [];
  const ours = new Set();
  // Real renice only for this test's own groups: a broken tree check must never touch the user's processes.
  const exec = (file, args, opts) => {
    calls.push([file, ...args]);
    return ours.has(Number(args.at(-1))) ? sh(file, args, opts) : Promise.resolve({ err: null, stdout: '', stderr: '' });
  };
  const slots = await local(t, { exec, niceLevel: level });
  const holder = await groupJob(t);
  const other = await groupJob(t); // same nice 0, but not under the holder
  ours.add(holder.job).add(other.job);
  const got = await call(slots.sock, { op: 'slot.acquire', pid: holder.sh, cmd: 'npm test', nonce }, { timeoutMs: 2000 });
  assert.equal(got.ok, true);
  await until(async () => (await procs(true)).get(holder.job)?.nice === level); // within one 2 s sweep
  assert.deepEqual(calls, [['/usr/bin/renice', String(level), '-g', String(holder.job)]]);
  assert.equal((await procs(true)).get(other.job).nice, base);
  await call(slots.sock, { op: 'slot.release', lease: got.lease, nonce });
});

// N2
test('N2 a run key binds acquires to that run\'s tree; without a key only pids under tbd outside every run may hold', async (t) => {
  const slots = await local(t); // "tbd" = the test process; runs A and B are its children, as P3 runs are tbd's
  const [a, b] = [await groupJob(t), await groupJob(t)];
  const m = await procs(true);
  const keyA = slots.registerRoot({ pid: a.sh, lstart: m.get(a.sh).lstart, runId: 'ra' });
  const keyB = slots.registerRoot({ pid: b.sh, lstart: m.get(b.sh).lstart, runId: 'rb' });
  assert.notEqual(keyA, keyB);
  const ask = (msg) => call(slots.sock, { nonce, cmd: 'x', ...msg }, { timeoutMs: 2000 });
  const got = await ask({ op: 'slot.acquire', pid: a.job, run: keyA });
  assert.equal(got.ok, true, got.error);
  assert.deepEqual(await ask({ op: 'lock.acquire', name: 'qa:n2', pid: a.job, run: keyB }), { ok: false, error: `pid ${a.job} is not under this run's root` });
  assert.deepEqual(await ask({ op: 'lock.acquire', name: 'qa:n2', pid: b.job }),
    { ok: false, error: `pid ${b.job} is not under tbd outside every run (a run's process sends its TBX_RUN key)` }, 'inside run B, no key');
  for (const bad of ['f'.repeat(32), 42]) assert.deepEqual(await ask({ op: 'slot.acquire', pid: a.job, run: bad }), { ok: false, error: 'unknown run key (wrong, or the run ended)' });
  const plain = sleeper(t); // under tbd, in no run: doctor / gate checks
  assert.equal((await ask({ op: 'lock.acquire', name: 'qa:n2', pid: plain.pid })).ok, true);
  assert.equal((await ask({ op: 'lock.acquire', name: 'qa:n2b', pid: plain.pid, run: keyA })).ok, false);
  await ask({ op: 'slot.release', lease: got.lease });
});

// N2
test('N2 max-hold revoke SIGTERMs only inside the holder\'s run tree: its run unregistered → lease dropped, nothing signalled', async (t) => {
  const kills = [];
  const alerts = [];
  const slots = await local(t, { config: { slots: { max_hold_min: 0.02 } }, kill: (pid, sig) => kills.push([pid, sig]), alert: (a) => alerts.push(a) });
  const holder = await groupJob(t); // the run root holds; its job leads its own group
  const key = slots.registerRoot({ pid: holder.sh, lstart: (await procs(true)).get(holder.sh).lstart, runId: 'gone' });
  assert.equal((await call(slots.sock, { op: 'slot.acquire', pid: holder.sh, cmd: 'npm test', run: key, nonce }, { timeoutMs: 2000 })).ok, true);
  slots.unregisterRoot('gone');
  await until(async () => !(await call(slots.sock, { op: 'status' })).slots.heavy.held.length); // 1.2 s + one 2 s sweep
  assert.deepEqual(kills, []);
  assert.deepEqual(alerts, [{ title: 'Heavy slot revoked', message: 'heavy slot revoked after 0.02 min: npm' }]);
});

// N4
test('N4 a flood of unknown pids costs one coalesced fresh ps, not one per acquire; a pid newer than the cache is still found', async (t) => {
  // a second slots module whose sh counts ps runs (real ps: read-only)
  const shPath = require.resolve('../lib/sh');
  const slotsPath = require.resolve('../lib/slots');
  const [realSh, realSlots] = [require.cache[shPath].exports, require.cache[slotsPath]];
  const ps = [];
  require.cache[shPath].exports = (file, ...rest) => { if (file === '/bin/ps') ps.push(Date.now()); return realSh(file, ...rest); };
  delete require.cache[slotsPath];
  let counted;
  try { counted = require('../lib/slots'); } finally { require.cache[shPath].exports = realSh; require.cache[slotsPath] = realSlots; }
  const slots = await local(t, {}, counted.createSlots);
  await counted.procs(true);
  ps.length = 0;
  const pids = Array.from({ length: 30 }, (_, i) => 100_000 + i); // above macOS pid_max 99998: never running
  const res = await Promise.all(pids.map((pid) => call(slots.sock, { op: 'slot.acquire', pid, cmd: 'x' }, { timeoutMs: 5000 })));
  assert.deepEqual(res, pids.map((pid) => ({ ok: false, error: `pid ${pid} is not running` })));
  assert.ok(ps.length <= 3, `${ps.length} ps runs for 30 unknown pids`);
  await counted.procs(true);
  const fresh = sleeper(t); // started after the last scan, inside the 500 ms cache
  const got = await call(slots.sock, { op: 'slot.acquire', pid: fresh.pid, cmd: 'x', nonce }, { timeoutMs: 5000 });
  assert.equal(got.ok, true, got.error);
  await call(slots.sock, { op: 'slot.release', lease: got.lease, nonce });
});

// N5 (at cap with every session spawned ≥ 1 → refused: F2 caps test)
test('N5 subagent sessions are per run key; at the cap a new session evicts the oldest one that never spawned', async (t) => {
  const slots = await local(t);
  const holder = sleeper(t);
  const key = slots.registerRoot({ pid: holder.pid, lstart: (await procs(true)).get(holder.pid).lstart, runId: 'r5' });
  const ask = (msg) => call(slots.sock, msg, { timeoutMs: 2000 });
  for (let i = 1; i <= 3; i++) assert.deepEqual(await ask({ op: 'subagent.request', session: 'same', run: key }), { ok: true, used: i });
  assert.deepEqual(await ask({ op: 'subagent.request', session: 'same' }), { ok: true, used: 1 }, 'same id outside the run: own budget');
  assert.deepEqual(await ask({ op: 'subagent.request', session: 'same', run: 'e'.repeat(32) }), { ok: false, error: 'unknown run key (wrong, or the run ended)' });
  for (let i = 0; i < 254; i++) assert.equal((await ask({ op: 'subagent.start', session: `idle${i}` })).ok, true); // 256 sessions now
  assert.deepEqual(await ask({ op: 'subagent.request', session: 'late' }), { ok: true, used: 1 });
  const kept = Object.keys(JSON.parse(fs.readFileSync(path.join(path.dirname(slots.sock), 'slots.json'), 'utf8')).subagents);
  assert.equal(kept.length, 256);
  assert.ok(!kept.includes('tbd:idle0') && kept.includes('tbd:idle1') && kept.includes('tbd:late') && kept.includes('r5:same'), 'oldest never-spawned evicted');
});

// N6
test('N6 a connection must send its request line within 2 s (a deadline: a slow drip is cut too); a granted wait then lasts', async (t) => {
  const slots = await local(t);
  const closedAfter = (drip) => new Promise((resolve) => {
    const t0 = Date.now();
    const c = net.connect(slots.sock);
    const iv = drip ? setInterval(() => c.write('{'), 300) : null;
    c.on('error', () => {});
    c.on('close', () => { clearInterval(iv); resolve(Date.now() - t0); });
    t.after(() => { clearInterval(iv); c.destroy(); });
  });
  const [silent, drip] = await Promise.all([closedAfter(false), closedAfter(true)]);
  for (const ms of [silent, drip]) assert.ok(ms >= 1900 && ms < 3000, `closed after ${ms} ms`);
  const [a, b] = [sleeper(t), sleeper(t)];
  const first = await call(slots.sock, { op: 'lock.acquire', name: 'qa:n6', pid: a.pid, nonce });
  const second = call(slots.sock, { op: 'lock.acquire', name: 'qa:n6', pid: b.pid });
  assert.equal(await settled(second, 2500), 'pending');
  await call(slots.sock, { op: 'lock.release', lease: first.lease, nonce });
  assert.equal((await second).ok, true);
});

// N7
test('N7 a named lock held past slots.max_hold_min is revoked like the heavy slot: its command group SIGTERMed, Irfan alerted', async (t) => {
  const kills = [];
  const alerts = [];
  const ours = new Set();
  // Real kill only for this test's own group: a broken holder check must never signal another process.
  const kill = (pid, sig) => { kills.push([pid, sig]); if (ours.has(-pid)) process.kill(pid, sig); };
  const slots = await local(t, { config: { slots: { max_hold_min: 0.02 } }, kill, alert: (a) => alerts.push(a) }); // 1.2 s
  const holder = await groupJob(t);
  ours.add(holder.job);
  assert.equal((await call(slots.sock, { op: 'lock.acquire', name: 'qa:n7', pid: holder.sh, cmd: 'npm run e2e', nonce }, { timeoutMs: 2000 })).ok, true);
  await until(async () => !(await call(slots.sock, { op: 'status' })).locks.length); // 1.2 s + one 2 s sweep
  assert.deepEqual(kills, [[-holder.job, 'SIGTERM']]);
  assert.deepEqual(alerts, [{ title: 'Lock revoked', message: 'lock qa:n7 revoked after 0.02 min: npm' }]);
  await until(async () => !(await procs(true)).has(holder.job), 3000);
});

// N10
test('N10 client cmd: control chars stripped before it is stored or shown; an env-assignment first word shows its name only', async (t) => {
  const slots = await local(t);
  const [a, b] = [sleeper(t), sleeper(t)];
  const got = await call(slots.sock, { op: 'slot.acquire', pid: a.pid, cmd: 'API_TOKEN=hunter2 npm test', nonce });
  const waiter = call(slots.sock, { op: 'slot.acquire', pid: b.pid, cmd: '\x1b]0;pwn\x07\x1b[2Jrm\x9b\x7f -rf' });
  await until(async () => (await call(slots.sock, { op: 'status' })).slots.heavy.waiting.length === 1);
  const s = (await call(slots.sock, { op: 'status' })).slots.heavy;
  assert.deepEqual([s.held[0].cmd, s.waiting[0].cmd], ['API_TOKEN=…', ']0;pwn']);
  await call(slots.sock, { op: 'slot.release', lease: got.lease, nonce });
  await waiter;
  const stored = JSON.parse(fs.readFileSync(path.join(path.dirname(slots.sock), 'slots.json'), 'utf8')).leases[0].cmd;
  assert.equal(stored, ' ]0;pwn  [2Jrm   -rf');
  const { cell } = require('../lib/toon');
  assert.deepEqual([cell('a\x1bb\x07'), cell('x\x9by\x00\x7f'), cell('l1\nl2\tz'), cell('plain')], ['ab', 'xy', '"l1\\nl2\\tz"', 'plain']); // \t \n: quoted + escaped
});

// N11
test('N11 release needs the lease and the acquirer\'s nonce, or for a lease taken without one the holder pid + lstart', async (t) => {
  const slots = await local(t);
  const ask = (msg) => call(slots.sock, msg, { timeoutMs: 2000 });
  const a = sleeper(t);
  const heavy = await ask({ op: 'slot.acquire', pid: a.pid, cmd: 'x', nonce });
  for (const proof of [{}, { nonce: 'd4'.repeat(16) }, { pid: a.pid, lstart: (await procs(true)).get(a.pid).lstart }]) {
    assert.deepEqual(await ask({ op: 'slot.release', lease: heavy.lease, ...proof }), { ok: false, error: 'release needs the nonce the lease was acquired with' });
  }
  assert.deepEqual(await ask({ op: 'slot.release', lease: heavy.lease, nonce }), { ok: true });
  const lock = await ask({ op: 'lock.acquire', name: 'qa:n11', pid: a.pid }); // no nonce
  const lstart = (await procs(true)).get(a.pid).lstart;
  for (const proof of [{}, { nonce }, { pid: a.pid, lstart: 'Thu Jan  1 00:00:00 1970' }]) {
    assert.deepEqual(await ask({ op: 'lock.release', lease: lock.lease, ...proof }), { ok: false, error: 'release needs the holder pid and lstart' });
  }
  assert.deepEqual(await ask({ op: 'lock.release', lease: lock.lease, pid: a.pid, lstart }), { ok: true });
});
