'use strict';
// slots: tbd's unix socket TB_HOME/tbd.sock for tbx and the agent hooks (spec §6, §7, App B).
// Heavy slot semaphore, named locks (qa:<tag>) and the per-session subagent budget.
// One JSON request line → one JSON response line; acquire ops answer when granted.
// A lease belongs to pid + process start time: a dead owner (or a reused pid) frees it, checked every 2 s
// and on each acquire. State is saved to slots.json before a grant is answered and rebuilt at start.
// Agents can reach this socket (D35), so: a run's process acquires only with its run key (TBX_RUN, from
// registerRoot) for a pid under that run's root, anything else only for a pid under tbd outside every run;
// a lost answer is re-claimed, and a lease released, only with the acquirer's nonce (a lease taken without
// one: released with the holder's pid + lstart); a lease held past slots.max_hold_min is revoked (its command
// group SIGTERMed); every list a client can grow is capped; the request line must come within 2 s.
// Sandboxed agents can't nice (setpriority EPERM), so tbd renices a heavy holder's command groups to 10.
const net = require('node:net');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sh = require('./sh');
const { writeAtomic } = require('./store');

const SOCK_MAX = 103; // macOS sun_path: 104 bytes incl. NUL
const SWEEP_MS = 2000;
const FIRST_LINE_MS = 2000; // the request line must arrive within this of connecting (N6)
const LINE_MAX = 64 * 1024;
const SESSION_TTL_MS = 6 * 3_600_000; // subagent counters dropped 6 h after their last op
const PS_TTL_MS = 500;
const FRESH_MS = 100; // fresh ps scans start at most this often (N4)
const MAX_WAITERS = 64;
const MAX_LOCKS = 32; // distinct lock names held or waited for
const MAX_SESSIONS = 256;
const RUN_SESSIONS = 4; // per run key (T2)
const TBD_SESSIONS = 8; // keyless ('tbd:'): a process without TBX_RUN can't fill the table either
const MAX_CONNS = 128;
const NAME_RE = /^[\w.:/-]{1,200}$/;
const NONCE_RE = /^[0-9a-f]{32,128}$/;
const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/; // no ':' so '<runId>:<session>' keys can't collide
const CTRL_RE = /\p{Cc}/gu; // C0, DEL, C1: terminal escapes in a client's cmd (N10)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex'); // slots.json keeps no usable nonce
// First word of a command; an env assignment shows its name only (`TOKEN=…`), never the value (N10).
function word(cmd) {
  const w = cmd.trim().split(/\s+/)[0].slice(0, 80);
  return w.includes('=') ? `${w.split('=')[0]}=…` : w;
}
// p is anc or below it in the ps snapshot m.
function under(p, anc, m) {
  for (let hops = 0; p > 1 && hops < 64; p = m.get(p)?.ppid ?? 0, hops++) if (p === anc) return true;
  return false;
}

const sockPath = (env = process.env) => env.TBD_SOCK || path.join(env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'tbd.sock');

// Client: one request, one answer. Rejects with code ENOENT / ECONNREFUSED (tbd down), ECONNRESET (closed
// without an answer, e.g. tbd restarted) or ETIMEDOUT (timeoutMs of silence; 0 = wait forever).
function call(sock, msg, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    let buf = '';
    const fail = (code, m) => { s.destroy(); reject(Object.assign(new Error(m), { code })); };
    if (timeoutMs) s.setTimeout(timeoutMs, () => fail('ETIMEDOUT', `no answer on ${sock} within ${timeoutMs} ms`));
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
    s.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      s.destroy();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch { reject(new Error(`bad answer on ${sock}`)); }
    });
    s.on('error', reject);
    s.on('close', () => fail('ECONNRESET', `${sock} closed without an answer`));
  });
}

// pid → {ppid, pgid, nice, lstart} for every process, or null when ps fails (then nobody is judged dead).
// Single-flight, reused for 500 ms. fresh: a scan that starts after the call (for a pid newer than the
// cache); fresh callers join one queued scan and scans start ≥ 100 ms apart, so a flood of unknown pids
// costs at most 10 ps a second (N4). lstart is UTC + C locale: registerRoot callers take their lstart
// from here so the strings compare equal.
let psCache = null;
let queued = null; // the next fresh scan: fresh callers join it until it starts
let freshAt = 0;
function procs(fresh = false) {
  if (fresh) {
    return (queued ??= new Promise((r) => setTimeout(r, Math.max(0, freshAt + FRESH_MS - Date.now()))).then(() => {
      queued = null;
      freshAt = Date.now();
      return scan();
    }));
  }
  return psCache && Date.now() - psCache.at < PS_TTL_MS ? psCache.p : scan();
}
function scan() {
  const p = sh('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,nice=,rss=,lstart='], { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).then((r) => {
    if (r.err) return null;
    const m = new Map();
    for (const line of r.stdout.split('\n')) {
      const x = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (x) m.set(Number(x[1]), { ppid: Number(x[2]), pgid: Number(x[3]), nice: Number(x[4]), rss: Number(x[5]), lstart: x[6].replace(/\s+/g, ' ') }); // rss: KB
    }
    return m;
  });
  psCache = { at: Date.now(), p };
  return p;
}

/** @param {{tbHome?: string, config: any, system?: () => any, alert?: (a: {title: string, message: string}) => void, exec?: typeof sh, niceLevel?: number, kill?: (pid: number, sig: NodeJS.Signals) => void}} opts */
function createSlots({
  tbHome = process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), config, system = () => null, alert = () => {},
  exec = sh, niceLevel = 10, kill = (pid, sig) => void process.kill(pid, sig),
}) {
  const sock = path.join(tbHome, 'tbd.sock');
  const file = path.join(tbHome, 'slots.json');
  const heavyCap = Number.isInteger(config.slots?.heavy) && config.slots.heavy > 0 ? config.slots.heavy : 1;
  const maxHoldMin = Number.isFinite(config.slots?.max_hold_min) && config.slots.max_hold_min > 0 ? config.slots.max_hold_min : 60;
  const total = config.subagents?.per_session_total ?? 3;
  const cap = (key) => (key === 'heavy' ? heavyCap : 1);
  /** @type {{lease: string, key: string, pid: number, lstart: string, cmd: string, since: string, tag?: string, run?: string}[]} */
  let leases = []; // key: 'heavy' or 'lock:<name>'; tag: sha256 of the acquirer's nonce; run: its runId
  const waiting = []; // {key, pid, lstart, tag, run, cmd, since, t0, conn, resolve} in arrival order
  const waited = new Map(); // runId → ms its processes waited for the heavy slot (finished waits; P3 wall cap)
  const subagents = new Map(); // '<runId|tbd>:<session>' → {alive, spawned, at}; a Map: session ids are client input
  /** @type {Map<string, {pid: number, lstart: string, runId: string}>} */
  const roots = new Map(); // sha256(run key) → root: run processes tbd started (P3 runner registers them)
  const reniced = new WeakMap(); // heavy lease → group ids already reniced (tried once each)
  const conns = new Set();
  let server = null;
  let listening = false;
  let timer = null;
  let saving = null;
  let dirty = false;
  let sweeping = null;
  let loaded = false;

  function save() {
    if (!loaded) return Promise.resolve(); // before load(): a registerRoot must not overwrite the saved state
    dirty = true;
    saving ??= (async () => {
      while (dirty) {
        dirty = false;
        const text = JSON.stringify({ leases, subagents: Object.fromEntries(subagents), roots: Object.fromEntries(roots) }) + '\n';
        await writeAtomic(file, text).catch((e) => console.error(`tbd: slots.json not saved: ${e.message}`));
      }
      saving = null;
    })();
    return saving;
  }

  // A finished wait (granted, or the waiter went away) of a run's process for the heavy slot.
  function noteWait(w) {
    if (w.run && w.key === 'heavy') waited.set(w.run, (waited.get(w.run) ?? 0) + Date.now() - w.t0);
  }

  // FIFO per key: the first waiter of a key with room gets it.
  function grant() {
    for (let i = 0; i < waiting.length;) {
      const w = waiting[i];
      if (leases.filter((l) => l.key === w.key).length >= cap(w.key)) { i++; continue; }
      waiting.splice(i, 1);
      noteWait(w);
      const l = { lease: crypto.randomBytes(16).toString('hex'), key: w.key, pid: w.pid, lstart: w.lstart, tag: w.tag, run: w.run, cmd: w.cmd, since: new Date().toISOString() };
      leases.push(l);
      w.resolve(l);
    }
  }

  // Over max hold: SIGTERM the holder's command group, i.e. a direct child of the live holder that leads its
  // own group (what tbx spawns detached), and only inside the run tree it acquired in (N2); none when that
  // run is gone. Never a group that is not the holder's own child. Then tell Irfan.
  function revoke(l, m) {
    const root = l.run ? [...roots.values()].find((r) => r.runId === l.run) : undefined;
    for (const [pid, p] of m) {
      if (p.ppid === l.pid && p.pgid === pid && (root || !l.run) && inTree(pid, m, root)) try { kill(-pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
    }
    const heavy = l.key === 'heavy';
    alert({ title: heavy ? 'Heavy slot revoked' : 'Lock revoked', message: `${heavy ? 'heavy slot' : `lock ${l.key.slice(5)}`} revoked after ${maxHoldMin} min${l.cmd ? `: ${word(l.cmd)}` : ''}` });
  }

  // Renices to niceLevel (10) every group led by the heavy holder or a process under it that runs below it
  // (tbx could not nice: sandbox). Absolute, so a command that did get niced is left alone. Best effort.
  function renice(l, m) {
    const done = reniced.get(l) ?? reniced.set(l, new Set()).get(l);
    for (const [pid, p] of m) {
      if (p.pgid !== pid || p.nice >= niceLevel || done.has(pid) || !under(pid, l.pid, m)) continue;
      done.add(pid);
      exec('/usr/bin/renice', [String(niceLevel), '-g', String(pid)], { timeout: 5000 }).then((r) => {
        if (r.err) console.error(`tbd: renice of group ${pid} failed: ${String(r.stderr || r.err.message).trim()}`);
      });
    }
  }

  // Drops leases whose owner died or whose pid now runs another process, revokes leases (heavy and named
  // locks, N7) held past max_hold_min, renices live heavy holders' groups; grants the freed room.
  function sweep() {
    sweeping ??= (async () => {
      const checked = new Set(leases);
      const m = checked.size ? await procs() : null;
      if (!m) return;
      const now = Date.now();
      const alive = (l) => m.get(l.pid)?.lstart === l.lstart;
      const gone = leases.filter((l) => checked.has(l) && (!alive(l) || now - Date.parse(l.since) >= maxHoldMin * 60_000));
      for (const l of leases) if (l.key === 'heavy' && checked.has(l) && !gone.includes(l)) renice(l, m);
      if (!gone.length) return;
      leases = leases.filter((l) => !gone.includes(l));
      for (const l of gone) if (alive(l)) revoke(l, m);
      grant();
      await save();
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  // With root (the request's run): pid is that live root or under it, nearer to it than to any other run's
  // root. Without: pid is under tbd and outside every run (doctor, gates); tbd itself may not hold.
  function inTree(pid, m, root) {
    const live = [...roots.values()].filter((r) => m.get(r.pid)?.lstart === r.lstart);
    for (let p = pid, hops = 0; p > 1 && hops < 64; p = m.get(p)?.ppid ?? 0, hops++) {
      const r = live.find((x) => x.pid === p);
      if (r) return r === root;
      if (p === process.pid) return !root && p !== pid;
    }
    return false;
  }

  // The run a request names with its key (TBX_RUN): undefined for none, null for a bad or unknown key.
  const runOf = (req) => (req.run === undefined ? undefined : (typeof req.run === 'string' && roots.get(hash(req.run))) || null);
  const NO_RUN = 'unknown run key (wrong, or the run ended)';

  async function acquire(key, req, conn) {
    const { pid, lease, nonce } = req;
    if (!Number.isInteger(pid) || pid < 2) return { ok: false, error: 'pid must be a process id' };
    if (nonce !== undefined && (typeof nonce !== 'string' || !NONCE_RE.test(nonce))) return { ok: false, error: 'nonce must be 32-128 hex chars (16+ random bytes)' };
    const root = runOf(req);
    if (root === null) return { ok: false, error: NO_RUN };
    const started = Date.now();
    let m = await procs();
    if (m && !m.has(pid)) m = await procs(true);
    if (!m) return { ok: false, error: 'ps failed; cannot check process liveness' };
    const me = m.get(pid);
    if (!me) return { ok: false, error: `pid ${pid} is not running` };
    // Inherited lease: re-entrant only while its owner lives and is an ancestor of pid.
    const held = typeof lease === 'string' && leases.find((l) => l.lease === lease && l.key === key);
    if (key === 'heavy' && held && m.get(held.pid)?.lstart === held.lstart && under(me.ppid, held.pid, m)) {
      return { ok: true, lease, waited_ms: 0, reentrant: true };
    }
    if (!inTree(pid, m, root)) return { ok: false, error: root ? `pid ${pid} is not under this run's root` : `pid ${pid} is not under tbd outside every run (a run's process sends its TBX_RUN key)` };
    await sweep();
    // Same process asking again (its answer was lost, e.g. tbd restarted): its own lease back, proven by its nonce.
    const tag = nonce && hash(nonce);
    const own = tag && leases.find((l) => l.key === key && l.pid === pid && l.lstart === me.lstart && l.tag === tag);
    if (own) return { ok: true, lease: own.lease, waited_ms: 0 };
    const mine = (x) => x.key === key && x.pid === pid;
    if (leases.some(mine) || waiting.some(mine)) return { ok: false, error: `pid ${pid} already holds or waits for ${key}` };
    const full = leases.filter((l) => l.key === key).length >= cap(key);
    if (full && waiting.length >= MAX_WAITERS) return { ok: false, error: `too many waiters (max ${MAX_WAITERS})` };
    const names = new Set([...leases, ...waiting].map((x) => x.key).filter((k) => k !== 'heavy'));
    if (key !== 'heavy' && !names.has(key) && names.size >= MAX_LOCKS) return { ok: false, error: `too many lock names (max ${MAX_LOCKS})` };
    if (conn.destroyed) return null;
    const cmd = typeof req.cmd === 'string' ? req.cmd.slice(0, 500).replace(CTRL_RE, ' ') : '';
    const l = await new Promise((resolve) => {
      waiting.push({ key, pid, lstart: me.lstart, tag, run: root?.runId, cmd, since: new Date().toISOString(), t0: Date.now(), conn, resolve });
      grant();
    });
    await save();
    return { ok: true, lease: l.lease, waited_ms: Date.now() - started };
  }

  // The lease plus proof of being its acquirer: the nonce it acquired with, or (acquired without one) the
  // holder's pid + lstart. A command that inherited TBX_LEASE has the lease, not tbx's nonce (N11).
  async function release(isKey, req) {
    const i = leases.findIndex((l) => l.lease === req.lease && isKey(l.key));
    if (i < 0) return { ok: false, error: 'unknown lease (already released, or its owner died)' };
    const l = leases[i];
    if (l.tag ? !(typeof req.nonce === 'string' && hash(req.nonce) === l.tag) : req.pid !== l.pid || req.lstart !== l.lstart) {
      return { ok: false, error: l.tag ? 'release needs the nonce the lease was acquired with' : 'release needs the holder pid and lstart' };
    }
    leases.splice(i, 1);
    grant();
    await save();
    return { ok: true };
  }

  // The session's counters, or an error string. Keyed per run (N5): a run can't spend another's session. A run
  // has at most RUN_SESSIONS sessions (T2: one run can't fill the table). At the cap a new session evicts the
  // oldest one that never spawned, else it is refused.
  function session(req) {
    if (typeof req.session !== 'string' || !req.session || req.session.length > 200) return 'session must be a 1-200 character string';
    const root = runOf(req);
    if (root === null) return NO_RUN;
    const id = `${root?.runId ?? 'tbd'}:${req.session}`;
    if (!subagents.has(id)) {
      const max = root ? RUN_SESSIONS : TBD_SESSIONS;
      if ([...subagents.keys()].filter((k) => k.startsWith(`${root?.runId ?? 'tbd'}:`)).length >= max) {
        return `too many subagent sessions ${root ? 'for this run' : 'without a run key'} (max ${max})`;
      }
      if (subagents.size >= MAX_SESSIONS) {
        let old = null;
        for (const [k, s] of subagents) if (s.spawned === 0 && (!old || s.at < subagents.get(old).at)) old = k;
        if (!old) return `too many subagent sessions (max ${MAX_SESSIONS})`;
        subagents.delete(old);
      }
      subagents.set(id, { alive: 0, spawned: 0, at: '' });
    }
    const s = subagents.get(id);
    s.at = new Date().toISOString();
    return s;
  }

  // Totals and first command words only: session ids and full command lines stay in tbd.
  function status() {
    let sys = null;
    try { sys = system() ?? null; } catch { /* monitor not ready: null */ }
    const view = ({ pid, cmd, since }) => ({ pid, cmd: word(cmd), since });
    const heavy = (x) => x.key === 'heavy';
    return {
      ok: true,
      system: sys,
      slots: { heavy: { capacity: heavyCap, held: leases.filter(heavy).map(view), waiting: waiting.filter(heavy).map(view) } },
      locks: leases.filter((l) => !heavy(l)).map((l) => ({
        name: l.key.slice(5), pid: l.pid, since: l.since, waiting: waiting.filter((w) => w.key === l.key).length,
      })),
      subagents: { sessions: subagents.size, alive_total: [...subagents.values()].reduce((n, s) => n + s.alive, 0) },
      runs: [],
    };
  }

  async function handle(req, conn) {
    switch (req.op) {
      case 'slot.acquire': return acquire('heavy', req, conn);
      case 'slot.release': return release((k) => k === 'heavy', req);
      case 'lock.acquire':
        if (typeof req.name !== 'string' || !NAME_RE.test(req.name)) return { ok: false, error: 'name must be 1-200 of A-Z a-z 0-9 _ . : / -' };
        return acquire(`lock:${req.name}`, req, conn);
      case 'lock.release': return release((k) => k.startsWith('lock:'), req);
      case 'subagent.request': {
        const s = session(req);
        if (typeof s === 'string') return { ok: false, error: s };
        if (s.spawned >= total) return { ok: false, denied: true, used: s.spawned, message: `subagent budget used (${s.spawned}/${total}); do the rest yourself` };
        const res = { ok: true, used: ++s.spawned }; // read before the await: others change s meanwhile
        await save();
        return res;
      }
      case 'subagent.start':
      case 'subagent.stop': {
        const s = session(req);
        if (typeof s === 'string') return { ok: false, error: s };
        s.alive =Math.max(0, s.alive + (req.op === 'subagent.start' ? 1 : -1));
        const res = { ok: true, alive: s.alive, spawned: s.spawned };
        await save();
        return res;
      }
      case 'status': return status();
      default: return { ok: false, error: `unknown op ${JSON.stringify(req.op)}; ops: slot.acquire slot.release lock.acquire lock.release subagent.request subagent.start subagent.stop status` };
    }
  }

  function onConn(conn) {
    conns.add(conn);
    let buf = '';
    const answer = (res) => { if (res && !conn.destroyed) conn.end(JSON.stringify(res) + '\n'); };
    conn.setEncoding('utf8');
    const deadline = setTimeout(() => conn.destroy(), FIRST_LINE_MS); // a deadline, not idle: no slow drip (N6)
    conn.on('error', () => {}); // client went away; close below cleans up
    conn.on('close', () => {
      clearTimeout(deadline);
      conns.delete(conn);
      const i = waiting.findIndex((w) => w.conn === conn);
      if (i >= 0) noteWait(waiting.splice(i, 1)[0]);
    });
    conn.on('data', (c) => {
      if (buf === null) return; // one request per connection
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) {
        if (buf.length > LINE_MAX) { buf = null; answer({ ok: false, error: 'request line too long' }); }
        return;
      }
      const line = buf.slice(0, i);
      buf = null;
      clearTimeout(deadline); // acquire may wait as long as the holder runs
      let req;
      try { req = JSON.parse(line); } catch { /* answered below */ }
      if (!isObj(req)) return answer({ ok: false, error: 'request must be one JSON object on one line' });
      handle(req, conn).then(answer, (e) => answer({ ok: false, error: e.message }));
    });
  }

  // Saved state: leases and run roots kept only while their owner (pid + start time) lives (a run outlives a tbd
  // restart and keeps its TBX_RUN key); counters kept as they are.
  async function load() {
    let saved;
    try {
      saved = JSON.parse(await fsp.readFile(file, 'utf8')); // startup
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`tbd: slots.json unreadable, starting empty: ${e.message}`);
    }
    if (!isObj(saved)) return roots.size > 0;
    const valid = (l) => isObj(l) && typeof l.lease === 'string' && typeof l.key === 'string' &&
      Number.isInteger(l.pid) && typeof l.lstart === 'string' && typeof l.cmd === 'string' && typeof l.since === 'string';
    const list = Array.isArray(saved.leases) ? saved.leases.filter(valid) : [];
    const savedRoots = Object.entries(isObj(saved.roots) ? saved.roots : {})
      .filter(([k, r]) => /^[0-9a-f]{64}$/.test(k) && isObj(r) && Number.isInteger(r.pid) && typeof r.lstart === 'string' && typeof r.runId === 'string' && RUN_ID_RE.test(r.runId));
    const m = list.length || savedRoots.length ? await procs() : null;
    leases = list.filter((l) => !m || m.get(l.pid)?.lstart === l.lstart);
    for (const [k, r] of savedRoots) if (m && m.get(r.pid)?.lstart === r.lstart) roots.set(k, { pid: r.pid, lstart: r.lstart, runId: r.runId });
    for (const [k, s] of Object.entries(isObj(saved.subagents) ? saved.subagents : {})) {
      if (isObj(s) && Number.isInteger(s.alive) && Number.isInteger(s.spawned)) subagents.set(k, { alive: s.alive, spawned: s.spawned, at: String(s.at ?? '') });
    }
    return leases.length !== (saved.leases?.length ?? 0) || roots.size !== savedRoots.length;
  }

  function unregisterRoot(runId) {
    let gone = false;
    for (const [k, r] of roots) if (r.runId === runId) gone = roots.delete(k);
    waited.delete(runId);
    if (gone) save();
  }

  function tick() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let pruned = false;
    for (const [k, s] of subagents) {
      if (!(Date.parse(s.at) >= cutoff)) pruned = subagents.delete(k); // alive > 0 too: a stop that never came
    }
    if (pruned) save();
    if (leases.length) sweep();
  }

  return {
    // In-process only (never a socket op): the P3 runner registers each run's root process (lstart from
    // procs()) and exports the key to the run's env as TBX_RUN. key: the one already in the run's env (it is
    // spawned with it), else a new one is returned. Registering a runId again replaces it. Saved as sha256 only.
    registerRoot({ pid, lstart, runId, key = crypto.randomBytes(16).toString('hex') }) {
      if (!Number.isInteger(pid) || pid < 2 || typeof lstart !== 'string' || typeof runId !== 'string') throw new Error('registerRoot needs {pid, lstart, runId}');
      if (!RUN_ID_RE.test(runId)) throw new Error(`registerRoot: runId must match ${RUN_ID_RE} (it prefixes session keys)`);
      if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) throw new Error('registerRoot: key must be 32 hex chars');
      unregisterRoot(runId);
      roots.set(hash(key), { pid, lstart, runId });
      save();
      return key;
    },
    unregisterRoot,
    // Run end (P3 T3): drops the run's root and ends the command groups of the leases it holds. `tbx heavy` runs its
    // command in its own detached group and forwards only INT/TERM/HUP: a SIGKILLed tbx leaves that group behind.
    // Same groups as revoke(): a direct child of the live holder (pid + lstart) that leads its own group. SIGTERM,
    // then after graceMs SIGKILL to those same groups while any member is left (leader gone, or still the same pid + lstart).
    async endRun(runId, graceMs = 2000) {
      unregisterRoot(runId);
      const held = leases.filter((l) => l.run === runId);
      // ps failing twice: these groups can't be told apart, so none is killed and Irfan is told they may be left running
      const psTwice = async () => (await procs(true)) ?? (await procs(true)) ??
        void alert({ title: 'Run cleanup failed', message: `ps failed twice ending run ${runId}: its heavy-slot or lock commands may still run` });
      let m = held.length ? await psTwice() : null;
      if (!m) return;
      const groups = [];
      for (const l of held) {
        if (m.get(l.pid)?.lstart !== l.lstart) continue; // holder gone: its children can't be told apart any more
        for (const [pid, p] of m) if (p.ppid === l.pid && p.pgid === pid) groups.push({ pid, lstart: p.lstart });
      }
      if (!groups.length) return;
      for (const g of groups) try { kill(-g.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
      await new Promise((r) => setTimeout(r, graceMs));
      m = await psTwice();
      for (const g of groups) {
        // still alive while any member has its pgid; the leader may be gone (POSIX keeps a live group's id from reuse)
        const leader = m?.get(g.pid);
        const live = m && [...m.values()].some((p) => p.pgid === g.pid);
        if (live && (!leader || leader.lstart === g.lstart)) try { kill(-g.pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
      }
    },
    // A run's heavy-slot wait in ms, finished waits plus the ones still going (spec §4/§8: excluded from the wall
    // cap; lease slot_wait_ms), and whether one of its processes waits for the slot or a lock now (liveness
    // "waiting"). In memory: a tbd restart starts from the lease's saved slot_wait_ms.
    waits(runId) {
      const now = Date.now();
      const mine = waiting.filter((w) => w.run === runId);
      const ongoing = mine.filter((w) => w.key === 'heavy').reduce((n, w) => n + now - w.t0, 0);
      return { wait_ms: (waited.get(runId) ?? 0) + ongoing, waiting: mine.length > 0 };
    },
    // A run's subagent counters summed over its sessions (lease subagents_alive / subagents_spawned).
    usage(runId) {
      const u = { alive: 0, spawned: 0 };
      for (const [k, s] of subagents) if (k.startsWith(`${runId}:`)) { u.alive += s.alive; u.spawned += s.spawned; }
      return u;
    },
    async start() {
      const n = Buffer.byteLength(sock);
      if (n > SOCK_MAX) throw new Error(`socket path ${sock} is ${n} bytes (max ${SOCK_MAX}); use a shorter TB_HOME`);
      const changed = await load();
      loaded = true;
      if (changed) await save();
      await fsp.rm(sock, { force: true }); // tbd.pid makes this tbd the only one: a socket file here is stale
      server = net.createServer(onConn);
      server.maxConnections = MAX_CONNS;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(sock, () => resolve(undefined));
      });
      server.on('error', (e) => console.error(`tbd: socket error: ${e.message}`));
      listening = true;
      await fsp.chmod(sock, 0o600); // TB_HOME is 0700, so the moment before this is not exposed
      timer = setInterval(tick, SWEEP_MS);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      server?.close();
      for (const c of conns) c.destroy();
      await saving;
      if (listening) await fsp.rm(sock, { force: true });
    },
  };
}

module.exports = { createSlots, call, sockPath, procs };
