'use strict';
// monitor: resource signals for admission and the board header (spec §7, plan D2, P2 contract). One sample every
// 5 s: sysctl (pressure, level, memsize), vm_stat (avail), statfs (disk), ps (claude tree RSS); pmset and the
// Docker socket every 60 s; net probe at start, on demand, on wake and every 60 s while it is down, with a breaker.
// Async execFile only (D31). snapshot() is null until the first sample. exec, clock, statfs and connect are injectable
// for tests. Units: bytes, ISO UTC.
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');

const GB = 1024 ** 3;
const SLOW_MS = 60_000; // pmset + Docker socket
const WAKE_MS = 30_000; // wall-clock jump between ticks that counts as sleep/wake
const NET_FAILS = 3; // breaker: after this many failed probes, probe at most every NET_RETRY_MS
const NET_RETRY_MS = 30_000;
const NET_REPROBE_MS = 60_000; // while net is down
const OPTS = { timeout: 4000 };
const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' }; // kern.memorystatus_vm_pressure_level
const RANK = { ok: 0, warn: 1, stop: 2 };
const EMPTY = Object.freeze({ // what readers show before the first sample

  ram_total: null, ram_used: null, avail: null, pressure: null, level: null, disk_free: null,
  claude_rss: null, net: null, power: null, docker: null, disk_warn: null, at: null,
});

// true when a socket connects within ms. opts = net.connect options (host+port or path).
function connect(opts, ms) {
  return new Promise((resolve) => {
    const s = net.connect(opts);
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// vm_stat: (free + inactive + speculative) pages × page size.
function vmAvail(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (k) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(text)?.[1]);
  const n = (pages('free') + pages('inactive') + pages('speculative')) * page;
  return Number.isFinite(n) ? n : null;
}

// ps -axo pid=,ppid=,rss=,comm= (rss KB): every process named claude or claude-<ver> plus all descendants, once each.
function claudeRss(text) {
  const rss = new Map();
  const kids = new Map();
  const stack = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, kb, comm] = m;
    rss.set(pid, Number(kb) * 1024);
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    if (/^claude(-\d[\d.]*)?$/.test(path.basename(comm.trim()))) stack.push(pid);
  }
  const seen = new Set();
  let total = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return total;
}

// ok → warn → stop as free space drops. ponytail: 1 GB hysteresis on the way up, so space hovering at a
// threshold notifies once instead of every 5 s.
function diskBand(free, prev, { warn_gb, stop_gb }) {
  if (free == null) return prev;
  const band = (margin) => (free < (stop_gb + margin) * GB ? 'stop' : free < (warn_gb + margin) * GB ? 'warn' : 'ok');
  return RANK[band(0)] < RANK[prev] ? band(1) : band(0);
}

// Header-precision view (0.1 GB ram/disk, 10 MB rss): a change event fires only when this differs.
const key = (s) => JSON.stringify([s.pressure, s.level, s.net, s.power, s.docker, s.disk_warn,
  ...[[s.ram_used, 1e8], [s.disk_free, 1e8], [s.claude_rss, 1e7]].map(([b, unit]) => (b == null ? null : Math.round(b / unit)))]);

/**
 * @param {{config: any, exec?: Function, clock?: () => number, statfs?: (p: string) => Promise<{bavail: number, bsize: number}>,
 *   connect?: (opts: object, ms: number) => Promise<boolean>, intervalMs?: number, home?: string}} deps
 */
function createMonitor({ config, exec = execFile, clock = Date.now, statfs = fsp.statfs, connect: dial = connect, intervalMs = 5000, home = os.homedir() }) {
  const emitter = new EventEmitter();
  /** @returns {Promise<any>} stdout; rejects when the command fails */
  const run = async (file, args) => {
    const r = await sh(file, args, OPTS, exec);
    if (r.err) throw r.err;
    return String(r.stdout);
  };
  let snap = null; // null until the first sample
  let sent = key(EMPTY); // key of the last snapshot a change event carried
  let last = null; // clock at the previous tick
  let lastSlow = -Infinity;
  let power = null;
  let docker = null;
  let band = 'ok';
  let netUp = null;
  let fails = 0;
  let lastProbe = -Infinity;
  let probing = null;
  let busy = false;
  let timer = null;
  let stopped = false;

  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const t = clock();
      const woke = last !== null && Math.abs(t - last - intervalMs) > WAKE_MS;
      if (woke) emitter.emit('wake', { gap_ms: t - last });
      last = t;
      if (woke || (netUp === false && Math.abs(t - lastProbe) >= NET_REPROBE_MS)) probeNet(); // after sleep, or still offline
      const slow = Math.abs(t - lastSlow) >= SLOW_MS;
      if (slow) lastSlow = t;
      const got = await Promise.allSettled([
        run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'hw.memsize']),
        run('/usr/bin/vm_stat', []),
        statfs(home),
        run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']),
        slow ? run('/usr/bin/pmset', ['-g', 'batt']) : null,
        slow ? dial({ path: path.join(home, '.docker', 'run', 'docker.sock') }, 1000) : null,
      ]);
      const [sys, vm, fsStat, ps, batt, dock] = got.map((r) => (r.status === 'fulfilled' ? r.value : null));
      if (slow) {
        power = batt == null ? null : /'AC Power'/.test(batt) ? 'ac' : /'Battery Power'/.test(batt) ? 'battery' : null;
        docker = dock;
      }
      const [p, level, total] = sys ? sys.trim().split('\n').map(Number) : [];
      const avail = vm ? vmAvail(vm) : null;
      const diskFree = fsStat ? fsStat.bavail * fsStat.bsize : null;
      const prevBand = band;
      band = diskBand(diskFree, band, config.disk);
      snap = {
        ram_total: total || null,
        ram_used: total && avail != null ? total - avail : null,
        avail,
        pressure: PRESSURE[p] ?? null,
        level: Number.isFinite(level) ? level : null,
        disk_free: diskFree,
        claude_rss: ps == null ? null : claudeRss(ps),
        net: netUp, power, docker,
        disk_warn: band !== 'ok',
        at: new Date(t).toISOString(),
      };
      if (RANK[band] > RANK[prevBand]) emitter.emit('disk', { band, disk_free: diskFree });
      if (key(snap) !== sent) {
        sent = key(snap);
        emitter.emit('change', snap);
      }
    } finally {
      busy = false;
    }
  }

  // TCP connect api.anthropic.com:443, 3 s timeout. Concurrent callers share one probe.
  function probeNet() {
    if (probing) return probing;
    const t = clock();
    if (fails >= NET_FAILS && Math.abs(t - lastProbe) < NET_RETRY_MS) return Promise.resolve(false);
    lastProbe = t;
    probing = dial({ host: 'api.anthropic.com', port: 443 }, 3000).catch(() => false).then((ok) => {
      fails = ok ? 0 : fails + 1;
      netUp = ok;
      if (snap) snap = { ...snap, net: ok }; // change event goes out with the next tick (max one per interval)
      probing = null;
      return ok;
    });
    return probing;
  }

  async function loop() {
    await sample().catch((e) => console.error(`tbd: monitor sample failed: ${e.message}`));
    if (!stopped) timer = setTimeout(loop, intervalMs).unref();
  }

  return {
    start() { stopped = false; probeNet(); loop(); },
    stop() { stopped = true; clearTimeout(timer); },
    snapshot: () => snap,
    on: (event, cb) => void emitter.on(event, cb),
    probeNet,
    sample,
  };
}

module.exports = { createMonitor, EMPTY };
