'use strict';
// Test preload (NODE_OPTIONS=--require <this>) for runner tests (P3 T4). Production never loads this file.
// 1. A fixture handler for every <kind>/<phase> under TB_PHASES_DIR: appends {id, phase, output} to
//    TB_HOME/test-handled.jsonl; throws when the result has `throw`, returns {to: output.next} when it names one.
//    TEST_REAL_HANDLERS=1: none, so the handlers tbd registers itself run (P4 code/planning: lib/planning.js).
// 2. Wraps createRunner deps: launchd check on, launchctl answered by a spy (TEST_LAUNCHD=missing → exit 1; every
//    call logged to TB_HOME/test-exec.jsonl, nothing real runs; git, read-only `git status` of recovery step 4, runs
//    for real), alerts logged to TB_HOME/test-alerts.jsonl, caffeinate a spy (start/kill logged to
//    TB_HOME/test-caffeinate.jsonl, no real caffeinate), net probe answers TEST_NET (down → false; else true),
//    TEST_PRESSURE=normal: the runner sees that memory pressure (this 8 GB Mac sits at warn under the full suite, and
//    D2 admits no 2nd run at warn: a test that needs two live runs sets it).
// 3. Group kills of the runner AND of slots (endRun, revoke) allowed only when every process of the group is this
//    tbd's own: by ppid ancestry, it descends from tbd or from a member of a run's process group tbd spawned (a run's
//    children outlive it, reparented to launchd, in its group), or was approved before with the same pid + start time
//    (its parent died between SIGTERM and SIGKILL); a single-pid kill (recovery step 2) only when that process is.
//    Logged to TB_HOME/test-kills.jsonl. slots' renice: refused.
//    A broken ownership check must never reach anything else (LESSONS 2026-10-08 renice incident).
// 4. claudeEnv (an allowlist, S3) also passes FAKE_CLAUDE_* on, so the fake claude_bin finds its scenario.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

require('./runs').passFakeEnv(); // before lib/spawn loads
const phases = require('../../lib/phases');
const runner = require('../../lib/runner');
const slots = require('../../lib/slots');
const spawn = require('../../lib/spawn');
const sh = require('../../lib/sh');

const HOME = process.env.TB_HOME;
const log = (name, obj) => fsp.appendFile(path.join(HOME, name), JSON.stringify(obj) + '\n');

const dir = process.env.TB_PHASES_DIR;
for (const kind of dir && process.env.TEST_REAL_HANDLERS !== '1' ? fs.readdirSync(dir) : []) {
  for (const phase of fs.readdirSync(path.join(dir, kind))) {
    phases.registerHandler(`${kind}/${phase}`, async (t, output) => {
      await log('test-handled.jsonl', { id: t.id, phase, output });
      if (typeof output.throw === 'string') throw new Error(output.throw);
      return typeof output.next === 'string' ? { to: output.next } : undefined;
    });
  }
}

const runRoots = new Set(); // pids of the runs this tbd spawned: each leads its own process group
const approved = new Set(); // 'pid lstart' of processes a kill was approved for
// pid < 0: every member of process group -pid is this tbd's own (and there is at least one). pid > 0: that one process
// is. ponytail: run roots by pid only (no start time): a test is over long before a pid comes round again.
async function ours(pid) {
  if (!Number.isInteger(pid) || Math.abs(pid) < 2) return false;
  const r = await sh('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (r.err) return false;
  const m = new Map();
  for (const l of r.stdout.split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
    if (x) m.set(Number(x[1]), { ppid: Number(x[2]), pgid: Number(x[3]), id: `${x[1]} ${x[4]}` });
  }
  const own = (p) => {
    for (let x = p, hops = 0; x > 1 && hops < 64; x = m.get(x)?.ppid ?? 0, hops++) {
      if (x === process.pid || runRoots.has(m.get(x)?.pgid) || approved.has(m.get(x)?.id)) return true;
    }
    return false;
  };
  const members = [...m.keys()].filter((p) => (pid < 0 ? m.get(p).pgid === -pid : p === pid));
  const ok = members.length > 0 && members.every((p) => p !== process.pid && own(p));
  if (ok) for (const p of members) approved.add(m.get(p).id);
  return ok;
}
const spyKill = (who) => (pid, sig) => void ours(pid).then(async (ok) => {
  await log('test-kills.jsonl', { who, pid, sig, ok });
  if (!ok) return console.error(`run-spy: refused ${who} kill ${pid}: not this test's processes`);
  try { process.kill(pid, sig); } catch { /* gone */ }
});

const createRunner = runner.createRunner;
runner.createRunner = (deps) => createRunner({
  ...deps,
  spawnRun: async (o) => {
    const s = await (deps.spawnRun ?? spawn.start)(o);
    if (s.child.pid) runRoots.add(s.child.pid);
    return s;
  },
  launchd: () => true,
  exec: async (file, args, opts) => {
    if (file === '/usr/bin/git' && args.includes('status')) return sh(file, args, opts); // recovery's dirty-tree note: real git, read-only
    await log('test-exec.jsonl', { file, args });
    const missing = file === '/bin/launchctl' && process.env.TEST_LAUNCHD === 'missing';
    return { err: file !== '/bin/launchctl' || missing ? new Error('spy: not loaded') : null, stdout: '', stderr: '' };
  },
  alert: (a) => void log('test-alerts.jsonl', a),
  kill: spyKill('runner'),
  probe: async () => process.env.TEST_NET !== 'down',
  ...(process.env.TEST_PRESSURE && { system: () => { const s = deps.system?.(); return s && { ...s, pressure: process.env.TEST_PRESSURE }; } }),
  caffeinate: () => {
    void log('test-caffeinate.jsonl', { op: 'start', at: Date.now() });
    return { kill: () => void log('test-caffeinate.jsonl', { op: 'kill', at: Date.now() }) };
  },
});

const createSlots = slots.createSlots;
slots.createSlots = (opts) => createSlots({
  ...opts,
  kill: spyKill('slots'),
  exec: async (file, args) => ({ err: new Error(`run-spy: refused ${file} ${args.join(' ')}`), stdout: '', stderr: '' }),
});
