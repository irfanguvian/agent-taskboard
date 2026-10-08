'use strict';
// Test preload (NODE_OPTIONS=--require <this>): registers tbd's parent (the test process) as a slots run root,
// so processes a test spawns may take leases with its run key, as a run's processes will (P3). The key goes to
// TB_HOME/test-run.key; helpers/tbd.js hands it to children as TBX_RUN. Kills and renices of this tbd reach only
// processes under the test process (never the test, tbd, pid 0 or 1): a broken tree check must never touch
// anything else (2026-10-08 incident). Production never loads this file.
const fsp = require('node:fs/promises');
const path = require('node:path');
const slots = require('../../lib/slots');
const sh = require('../../lib/sh');

// pid is under the test process, and is neither the test process nor this tbd.
async function ours(pid) {
  if (!(pid > 1) || pid === process.pid || pid === process.ppid) return false;
  const m = await slots.procs(true);
  for (let p = pid, hops = 0; p > 1 && hops < 64; p = m?.get(p)?.ppid ?? 0, hops++) if (p === process.ppid) return true;
  return false;
}
const refused = (what) => {
  console.error(`slot-root: refused ${what}: not a process this test started`);
  return { err: new Error('refused by slot-root'), stdout: '', stderr: '' };
};

const create = slots.createSlots;
slots.createSlots = (opts) => {
  const s = create({
    ...opts,
    kill: (pid, sig) => void ours(Math.abs(pid)).then((ok) => {
      if (!ok) return refused(`kill ${pid}`);
      try { process.kill(pid, sig); } catch { /* gone */ }
    }),
    exec: async (file, args, o) => (file === '/usr/bin/renice' && await ours(Number(args.at(-1))) ? sh(file, args, o) : refused(`${file} ${args.join(' ')}`)),
  });
  const start = s.start;
  s.start = async () => {
    const parent = (await slots.procs(true))?.get(process.ppid);
    if (parent) {
      const key = s.registerRoot({ pid: process.ppid, lstart: parent.lstart, runId: 'test' });
      await fsp.writeFile(path.join(opts.tbHome ?? process.env.TB_HOME, 'test-run.key'), key, { mode: 0o600 });
    }
    return start();
  };
  return s;
};
