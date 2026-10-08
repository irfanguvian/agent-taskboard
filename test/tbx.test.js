'use strict';
// P2 AC3 (tbx heavy: slot wait, nice, TBX_LEASE re-entry, forged/stolen lease, holder death, tbd-down retry)
// and AC6 (tbx status TOON) against a real tbd on the harness temp HOME + TB_HOME.
// FX-1: F1 nonce resent on retry, F2 max-hold revoke (in-process slots), F5 signals reach the whole command group.
// Fix loop 2: N2 tbx sends TBX_RUN, N11 the command's inherited TBX_LEASE alone cannot release the slot.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startTbd, isolatedEnv, SLOT_ROOT, REPO } = require('./helpers/tbd');
const { call, createSlots } = require('../lib/slots');

const TBX = path.join(REPO, 'bin', 'tbx');
let tbd;
let sock;
let env;
let tmp;
before(async () => {
  tbd = await startTbd({ env: { NODE_OPTIONS: SLOT_ROOT } }); // test process = a run root: tbx it spawns may hold
  sock = path.join(tbd.tbHome, 'tbd.sock');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-'));
  fs.symlinkSync(TBX, path.join(tmp, 'tbx')); // nested `tbx` resolves on PATH, as in a run
  env = isolatedEnv(tbd, { TBD_SOCK: sock, PATH: `${tmp}:${process.env.PATH}` });
  delete env.TBX_LEASE;
});
after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await tbd.stop();
});

// Spawns bin/tbx (behind prefix, e.g. a nice command); done resolves {code, stdout, stderr, ms, end}. Killed in t.after if still running.
function tbx(t, args, extra = {}, prefix = []) {
  const t0 = Date.now();
  const [file, ...pre] = [...prefix, process.execPath];
  const child = spawn(file, [...pre, TBX, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const done = new Promise((r) => child.on('close', (code) => r({ code, stdout, stderr, ms: Date.now() - t0, end: Date.now() })));
  return { child, done };
}
const status = () => call(sock, { op: 'status' }, { timeoutMs: 2000 });
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`condition not met in ${ms} ms`);
}
const settled = (p, ms) => Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(r, ms, 'pending'))]);
const heldBy = async (pid) => (await status()).slots.heavy.held.some((h) => h.pid === pid);
const waiters = async () => (await status()).slots.heavy.waiting.map((w) => w.pid);
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
// SIGKILLs pids this test started; never pid 0 (own group), 1 or a non-number.
const reap = (pids) => pids.forEach((p) => { if (Number.isInteger(p) && p > 1) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } });
// The pid a command wrote to file (polled); SIGKILLed in t.after if still alive.
async function pidFrom(t, file) {
  const pid = Number(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()));
  t.after(() => reap([pid]));
  return pid;
}

test('AC3 tbx heavy runs the command niced with TBX_LEASE, exits with its code, releases the slot', async (t) => {
  const one = await tbx(t, ['heavy', '--', 'echo "$TBX_LEASE $(ps -o nice= -p $$)"; exit 7']).done;
  assert.equal(one.code, 7, one.stderr);
  // niced to 10, or left higher when the test itself already runs above 10 (e.g. zsh BG_NICE=15); never below 10
  const m = /^([0-9a-f]{32}) +(\d+)\n$/.exec(one.stdout);
  assert.ok(m, one.stdout);
  assert.equal(Number(m[2]), Math.max(10, os.getPriority()));
  const argv = await tbx(t, ['heavy', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1]); process.exit(3)', "it's \"$(x)\""]).done;
  assert.equal(argv.code, 3);
  assert.equal(argv.stdout, "it's \"$(x)\"", 'several args run as argv, no shell');
  assert.deepEqual((await status()).slots.heavy.held, []);
});

test('AC3 + AC6 a second tbx heavy waits while the first holds; tbx status shows holder and waiter', async (t) => {
  const a = tbx(t, ['heavy', '--', 'sleep 1.5']);
  await until(() => heldBy(a.child.pid));
  const b = tbx(t, ['heavy', '--', 'echo B']);
  await until(async () => (await waiters()).includes(b.child.pid));
  const view = await tbx(t, ['status']).done;
  assert.equal(view.code, 0, view.stderr);
  assert.match(view.stdout, /^(system\[1\]\{pressure,avail_gb,ram_used_gb,ram_total_gb,disk_free_gb,claude_rss_gb,net,power,docker\}:|system: unavailable)/);
  assert.match(view.stdout, /^heavy: 1\/1 held, 1 waiting$/m);
  assert.match(view.stdout, new RegExp(`^held\\[1\\]\\{pid,since,cmd\\}:\\n  ${a.child.pid},"[^"]+",sleep$`, 'm')); // F3: first word only
  assert.match(view.stdout, new RegExp(`^waiting\\[1\\]\\{pid,since,cmd\\}:\\n  ${b.child.pid},"[^"]+",echo$`, 'm'));
  assert.match(view.stdout, /^locks\[\d+\]/m);
  assert.match(view.stdout, /^subagents: \d+ sessions, \d+ alive$/m); // F3: totals, no session ids
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0);
  assert.equal(rb.code, 0);
  assert.equal(rb.stdout, 'B\n');
  assert.ok(rb.end >= ra.end, 'B ran after A released');
});

test('AC3 a child with the inherited lease re-enters at once; a stolen or forged TBX_LEASE waits', async (t) => {
  const nested = await tbx(t, ['heavy', '--', 'tbx heavy -- printenv TBX_LEASE; printenv TBX_LEASE']).done;
  assert.equal(nested.code, 0, nested.stderr);
  const [inner, outer] = nested.stdout.trim().split('\n');
  assert.match(outer, /^[0-9a-f]{32}$/);
  assert.equal(inner, outer, 're-entrant child got the same lease, no second wait');
  assert.ok(nested.ms < 5000);

  const file = path.join(tmp, 'lease');
  const holder = tbx(t, ['heavy', '--', `printenv TBX_LEASE > ${file}; exec sleep 30`]);
  const lease = await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim());
  const stolen = tbx(t, ['heavy', '--', 'true'], { TBX_LEASE: lease }); // live lease, but holder is no ancestor
  const forged = tbx(t, ['heavy', '--', 'true'], { TBX_LEASE: 'f'.repeat(32) });
  await until(async () => (await waiters()).length === 2);
  assert.equal(await settled(stolen.done, 200), 'pending');
  holder.child.kill('SIGTERM'); // forwarded to the command; tbx releases and exits
  assert.equal((await holder.done).code, 143);
  assert.equal((await stolen.done).code, 0);
  assert.equal((await forged.done).code, 0);
});

test('AC3 the lease is freed when the holder dies (kill -9 tbx)', async (t) => {
  const file = path.join(tmp, 'sleep.pid');
  const holder = tbx(t, ['heavy', '--', `echo $$ > ${file}; exec sleep 30`]);
  const sleepPid = Number(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()));
  t.after(() => reap([sleepPid]));
  const next = tbx(t, ['heavy', '--', 'echo next']);
  await until(async () => (await waiters()).includes(next.child.pid));
  holder.child.kill('SIGKILL');
  const r = await next.done;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'next\n');
});

test('AC3 tbd down: tbx heavy retries --wait-tbd seconds, then fails clearly; a tbd that comes up meanwhile is used', async (t) => {
  const none = path.join(tmp, 'none.sock');
  const down = await tbx(t, ['heavy', '--wait-tbd', '1', '--', 'echo never'], { TBD_SOCK: none }).done;
  assert.equal(down.code, 1);
  assert.equal(down.stdout, '');
  assert.equal(down.stderr, `error: tbd not reachable (socket ${none})\n`);
  assert.ok(down.ms >= 1000 && down.ms < 4000, `gave up after ${down.ms} ms`);

  const late = path.join(tmp, 'late.sock');
  const ops = [];
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d));
    ops.push(req.op);
    c.end(JSON.stringify(req.op === 'slot.acquire' ? { ok: true, lease: 'l1', waited_ms: 0 } : { ok: true }) + '\n');
  }));
  t.after(() => server.close());
  const run = tbx(t, ['heavy', '--wait-tbd', '5', '--', 'printenv TBX_LEASE'], { TBD_SOCK: late });
  await new Promise((r) => setTimeout(r, 700));
  await new Promise((r) => server.listen(late, () => r(undefined)));
  const r = await run.done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'l1\n');
  assert.deepEqual(ops, ['slot.acquire', 'slot.release']);
});

test('tbx usage errors exit 2', async (t) => {
  for (const args of [['heavy', 'true'], ['heavy', '--'], ['heavy', '--wait-tbd', 'x', '--', 'true'], ['nope']]) {
    const r = await tbx(t, args).done;
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^error: /);
  }
});

// F5
test('F5 SIGTERM to tbx reaches the whole command group: no orphaned background process, slot released', async (t) => {
  const file = path.join(tmp, 'bg.pid');
  const holder = tbx(t, ['heavy', '--', `sleep 300 >/dev/null 2>&1 & echo $! > ${file}; wait`]);
  const bg = await pidFrom(t, file);
  holder.child.kill('SIGTERM');
  assert.equal((await holder.done).code, 143);
  await until(() => gone(bg), 3000);
  assert.deepEqual((await status()).slots.heavy.held, []);
});

// F5
test('F5 a command longer than the socket line limit still runs: tbx sends only its first 500 chars', async (t) => {
  const r = await tbx(t, ['heavy', '--', `exit 4 # ${'x'.repeat(200_000)}`]).done;
  assert.equal(r.code, 4, r.stderr);
});

// F1
test('F1 tbx sends a 16-byte nonce and resends the same one when tbd drops its acquire (restart)', async (t) => {
  const drop = path.join(tmp, 'drop.sock');
  const reqs = [];
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d));
    reqs.push(req);
    if (reqs.length === 1) return void c.destroy(); // tbd restarted while this acquire waited
    c.end(JSON.stringify(req.op === 'slot.acquire' ? { ok: true, lease: 'l2', waited_ms: 0 } : { ok: true }) + '\n');
  }));
  t.after(() => server.close());
  await new Promise((r) => server.listen(drop, () => r(undefined)));
  const r = await tbx(t, ['heavy', '--', 'true'], { TBD_SOCK: drop }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(reqs.map((q) => q.op), ['slot.acquire', 'slot.acquire', 'slot.release']);
  assert.match(reqs[0].nonce, /^[0-9a-f]{32}$/);
  assert.equal(reqs[1].nonce, reqs[0].nonce);
  assert.deepEqual(reqs[2], { op: 'slot.release', lease: 'l2', nonce: reqs[0].nonce }, 'N11: release proves the acquirer');
});

// F2
test('F2 max hold: a heavy lease past slots.max_hold_min is revoked, its whole command group SIGTERMed, Irfan alerted', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  const alerts = [];
  const kills = [];
  const ours = new Set();
  // Real kill / renice only for this test's own group: a broken holder check must never touch another process.
  const kill = (pid, sig) => { kills.push([pid, sig]); if (ours.has(-pid)) process.kill(pid, sig); };
  const exec = async () => ({ err: null, stdout: '', stderr: '' });
  const slots = createSlots({ tbHome: home, config: { slots: { max_hold_min: 0.02 } }, alert: (a) => alerts.push(a), kill, exec }); // 1.2 s
  await slots.start(); // in-process: the test process is "tbd", so the tbx it spawns may hold
  t.after(async () => { await slots.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const isock = path.join(home, 'tbd.sock');
  const file = path.join(tmp, 'mh.pid');
  const holder = tbx(t, ['heavy', '--', `sleep 300 >/dev/null 2>&1 & echo $$ $! > ${file}.tmp; mv ${file}.tmp ${file}; wait`], { TBD_SOCK: isock, TBX_RUN: '' }); // under "tbd", no run
  const [group, bg] = (await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim())).split(' ').map(Number);
  t.after(() => reap([bg, group]));
  ours.add(group); // tbx's detached command: sh leads the group, sleep is in it
  const r = await holder.done; // revoked by the 2 s sweep once 1.2 s are up
  assert.equal(r.code, 143, r.stderr);
  assert.ok(r.ms >= 1200, `revoked after ${r.ms} ms`);
  assert.deepEqual(kills, [[-group, 'SIGTERM']]);
  await until(() => gone(bg), 3000);
  assert.deepEqual(alerts, [{ title: 'Heavy slot revoked', message: 'heavy slot revoked after 0.02 min: sleep' }]);
  assert.deepEqual((await call(isock, { op: 'status' }, { timeoutMs: 2000 })).slots.heavy.held, []);
});

// F7
test('F7 nice denied (setpriority EPERM): tbx still runs the command, quietly, and passes its exit code on', async (t) => {
  // above nice 10 an unprivileged setpriority(10) is refused, as the agent sandbox refuses every setpriority
  const r = await tbx(t, ['heavy', '--', 'ps -o nice= -p $$; exit 5'], {}, ['/usr/bin/nice', '-n', '19']).done;
  assert.equal(r.code, 5, r.stderr);
  assert.equal(r.stdout.trim(), String(Math.min(os.getPriority() + 19, 20)), 'ran at the nice tbx started with');
  assert.equal(r.stderr, '', 'no warning spam');
});

// N2
test('N2 tbx sends its run key (TBX_RUN): a wrong key or none (a run process not under tbd) is refused, nothing runs', async (t) => {
  assert.match(env.TBX_RUN, /^[0-9a-f]{32}$/, 'harness hands the test run key on');
  const wrong = await tbx(t, ['heavy', '--', 'echo never'], { TBX_RUN: 'a'.repeat(32) }).done;
  assert.deepEqual([wrong.code, wrong.stdout, wrong.stderr], [1, '', 'error: unknown run key (wrong, or the run ended)\n']);
  const none = tbx(t, ['heavy', '--', 'echo never'], { TBX_RUN: '' });
  const r = await none.done;
  assert.deepEqual([r.code, r.stdout, r.stderr], [1, '', `error: pid ${none.child.pid} is not under tbd outside every run (a run's process sends its TBX_RUN key)\n`]);
});

// N11
test('N11 the command cannot free the slot with its inherited TBX_LEASE (no nonce); tbx itself still releases on exit', async (t) => {
  const probe = `const { call } = require(${JSON.stringify(path.join(REPO, 'lib', 'slots.js'))});
call(process.env.TBD_SOCK, { op: 'slot.release', lease: process.env.TBX_LEASE }).then((r) => console.log(JSON.stringify(r)));`;
  const r = await tbx(t, ['heavy', '--', process.execPath, '-e', probe]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'release needs the nonce the lease was acquired with' });
  assert.deepEqual((await status()).slots.heavy.held, [], 'released by tbx with its nonce');
});
