'use strict';
// runner: agent runs for flow tickets (spec §8, plan P3, contract T1 T3). One tick a second: tail each live run's
// log and check its process, then start a run for each ticket that may run (T1: agent phase, no lease of this round of
// the phase, phase built (D9), admission ok, no usage pause; else ticket.waiting says why). The lease in ticket.json
// carries the run.
// Liveness: a run this tbd spawned is alive until its exit event (ps can fail or lag). A run re-attached after a tbd
// restart is alive only while its pid AND start time (C locale, UTC: slots.procs) match, so a reused pid is never the
// run; a failed ps means "unknown, ask again next tick", never "dead".
// Start: the lease is saved before the spawn (intent: pid null) and gets its pid in the spawn event's tick. A tbd
// killed in between finds the run again by its session id in ps (adopt), or calls it interrupted.
// tbd stopping leaves runs alive (own process groups, output in files); the next tbd re-attaches every lease without
// `exit`: alive → tail on; gone → outcome from the log's last result line, none → interrupted.
// Run end (T3): end its slots root and the command groups of its leases, SIGTERM then SIGKILL what is left in the
// run's own group, hand a result to the phase handler (only while the ticket still holds this run's lease gen; it
// returns the next state), record `exit` on the lease, check launchd still has local.taskboard (D37).
// P3b (spec §4 §7 §8, plan P3 AC1 AC5 AC7 AC8): each tick also applies the liveness rules to every live run (stall
// without a tool, wake grace, net back, wall cap minus slot wait, usage `rejected`, memory critical → pause the
// newest) and decides what follows a run that ended in the ticket's phase. Every one of them goes through
// lib/recovery.js, the one recovery path; gen is its compare-and-swap counter, n (runs/<n>.*) the run number.
// view() is what P3c shows; resume/restart/cancel are its buttons. caffeinate -i runs while runs do.
// P3c (plan P3 AC9 AC10): each run end writes one `t:run` metrics line and gzips the run's log (meter); admission
// expects a phase to need the median peak RSS of its last 10 runs.
// Async only (D31); exec, kill, procs, clock, sleep, probe, spawn and caffeinate injectable.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const fsm = require('./fsm');
const phases = require('./phases');
const admission = require('./admission');
const sh = require('./sh');
const spawn = require('./spawn');
const slotsLib = require('./slots');
const metrics = require('./metrics');
const { createTail, outcome, packLog } = require('./stream');
const { createRecovery, tree, strays, liveness, runMs, wallMs, Stale } = require('./recovery');
const { TbError } = require('./errors');

const { AGENT } = fsm;
const TICK_MS = 1000;
const SAVE_MS = 10_000; // liveness fields reach ticket.json at most this often; outcomes at once
const GRACE_MS = 2000; // SIGTERM → SIGKILL for what a run leaves behind
const MIN = 60_000;
const WAKE_MS = 30_000; // a wall-clock jump above this since the runner last looked: maybe sleep (a hint, see jump())
const USAGE_RETRY_MS = 30 * MIN; // ponytail: a usage pause with no reset time is tried again after this
const FAILS = ['crash', 'interrupted', 'stalled']; // §4 failures, unless a pause (offline, sleep) explains them
const PAUSES = ['paused', 'usage'];
const LABEL = 'local.taskboard';
const LOG_RE = /^runs\/\d+\.jsonl$/;
const ID_RE = /^t_[a-z0-9]{6}$/; // file paths derive from it
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (ms) => new Date(ms).toISOString();
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const usageUntil = (l) => Date.parse(l.resets_at ?? '') || Date.parse(l.ended_at) + USAGE_RETRY_MS;

// AC8: -w: it also ends with tbd, so a tbd killed hard never leaves it behind.
function startCaffeinate() {
  const c = spawnChild('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  c.on('error', (e) => console.error(`tbd: caffeinate: ${e.message}`));
  c.unref();
  return c;
}

/** @param {{store: any, slots: any, tbHome: string, port: number, system?: () => any, alert?: (a: {title: string, message: string}) => void, exec?: typeof sh, psArgs?: () => Promise<{err: any, stdout: string}>, kill?: (pid: number, sig: NodeJS.Signals) => void, procs?: typeof slotsLib.procs, launchd?: () => boolean, uid?: number, now?: () => number, sleep?: (ms: number) => Promise<any>, alive?: (pid: number) => boolean, probe?: () => Promise<boolean>, spawnRun?: (o: any) => Promise<{child: {pid?: number}, ready: Promise<any>, done: Promise<any>}>, caffeinate?: () => {kill: () => any, on?: Function}, rerunGate?: (t: any, phase: string) => Promise<any>}} deps */
function createRunner({
  store, slots, tbHome, port, system = () => null, alert = () => {}, exec = sh,
  psArgs = () => sh('/bin/ps', ['-axww', '-o', 'pid=,args='], { timeout: 5000 }),
  kill = (pid, sig) => void process.kill(pid, sig), procs = slotsLib.procs, launchd = () => process.ppid === 1, uid = process.getuid?.() ?? -1,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), alive = isAlive, probe = async () => true,
  spawnRun = spawn.start, caffeinate = startCaffeinate,
  rerunGate = async () => {}, // P5 seam (recovery step 2→3): "that phase's gate re-runs first" when Resume/Restart leaves Blocked; no gates yet
}) {
  /** @type {Map<string, any>} */
  const runs = new Map(); // ticket id → its live run
  let timer = null;
  let current = null;
  let stopped = false;
  let offlineAt = null; // when the net probe started failing
  let memAt = null; // monitor sample of the last memory pause: one per sample
  let pausing = null; // the memory pause in flight: no other until it settles (R1: its run leaves `runs` at once)
  let usageFloor = 0; // a usage pause go() started, before its claim saved exit usage (R11)
  let caff = null;
  let paused = 0; // pausedUntil() of this tick
  let starting = 0; // starts that passed admission and are not in `runs` yet (H4: they count as runs)
  let lookedAt = null; // wall clock when the runner last looked (jump)
  let hintAt = null; // a wall jump the OS has not confirmed yet: the wall cap waits for its sleep_ms (watch)
  let wokeAt = null; // kern.waketime of the last OS wake taken: one sleep counts once
  const taken = new Map(); // runId → a live run handed to a recovery (takeRun), until its step 2 ended it (endRun)
  const metering = new Map(); // run log → its t:run line + packing in flight (stop() waits for them)
  let loading = null; // metrics.load() of start(): the first tick waits for it (admission needs the peaks)

  // own: spawned by this tbd (key: its TBX_RUN, known only here); else re-attached from ticket.json.
  function track(id, lease, own = false, key = null) {
    const log = typeof lease.log === 'string' && LOG_RE.test(lease.log) ? path.join(store.ticketDir(id), lease.log) : null;
    const run = {
      id, runId: `${id}.${lease.gen}`, lease: { ...lease }, tail: log && createTail(log), own, key, code: null, exited: false, savedAt: Date.now(),
      waitBase: lease.slot_wait_ms ?? 0, wakeAt: null, wakeWhy: null, bootAt: null, going: null, live: null, peak: 0, subPeak: 0,
    };
    runs.set(id, run);
    return run;
  }
  const drop = (run) => { if (runs.get(run.id) === run) runs.delete(run.id); };

  // false: the ticket's lease is no longer this run's (a recovery replaced it), or ok(ticket) says no.
  async function saveLease(run, patch, ok = (_k) => true) {
    try {
      await store.updateTicket(run.id, (k) => {
        if (k.lease?.gen !== run.lease.gen || !ok(k)) throw new Stale();
        return { ...k, lease: { ...k.lease, ...patch } };
      });
      Object.assign(run.lease, patch);
      return true;
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      return false;
    }
  }

  // ok(ticket) false → Stale (a recovery's wait, only while it still holds the lease gen: R10)
  const setWaiting = (t, reason, ok = (_k) => true) => (t.waiting?.reason === reason ? undefined
    : store.updateTicket(t.id, (k) => {
      if (!ok(k)) throw new Stale();
      return { ...k, waiting: { reason, since: iso(now()) } };
    }));

  async function lastRun(dir) {
    const names = await fsp.readdir(path.join(dir, 'runs')).catch(() => []);
    return Math.max(0, ...names.map((f) => Number(/^(\d+)\./.exec(f)?.[1] ?? 0)));
  }

  // The start time from ps once it lists the pid (it can fail or lag a fresh spawn: retried each tick), then the
  // slots root, so the run's TBX_RUN key works. Only with the key the run was spawned with: a re-attached or adopted run
  // (key null) keeps the root an earlier tbd registered (slots.json) and never gets a new key.
  async function fillLstart(run, m) {
    const p = m?.get(run.lease.pid);
    if (!p) return;
    if (run.key) slots.registerRoot({ pid: run.lease.pid, lstart: p.lstart, runId: run.runId, key: run.key });
    await saveLease(run, { lstart: p.lstart });
  }

  // T1, and step 5 of a recovery: takes lease gen `gen` by compare-and-swap on `from` (the gen the caller saw) while
  // the ticket is still in the run's phase (M3: a Cancel meanwhile wins), writes runs/<n>.* (n: the next free run
  // number) and spawns; resume: --resume the session. It counts as a run for admission from its first line (reserved:
  // the slot step 3 held) until it is tracked or fails (H4). A T1 start opens the phase's wall clock (I8: a new round
  // of a phase is a new clock); a recovery (reserved) runs on it. The lease keeps the binary it ran (bin: a pin switch
  // later must not hide it from findRun) and the ticket's round (consider). A lease lost while spawning (Restart), or a ticket gone from the phase (a
  // Cancel that saw no lease yet) → this fresh child, not reaped yet so surely ours, is SIGKILLed. → started?
  async function startRun(t, { from = t.lease?.gen, gen = (t.lease?.gen ?? 0) + 1, session = crypto.randomUUID(), resume = false, prompt = store.renderMd(t), extra = {}, reserved = false } = {}) {
    if (!reserved) starting++;
    let held = true;
    const free = () => { if (held) { held = false; starting--; } };
    try {
      const dir = store.ticketDir(t.id);
      const n = (await lastRun(dir)) + 1;
      const at = iso(now());
      const lease = {
        gen, pid: null, lstart: '', pgid: null, phase: t.state, round: t.round, task: null, session, log: `runs/${n}.jsonl`, bin: store.config.claude_bin,
        started_at: at, last_event_at: at, tool: null, slot_wait_ms: 0, sleep_ms: 0, subagents_alive: 0, subagents_spawned: 0, ...extra,
        // total_cost_usd adds up over --resume (P3d smoke 2.1.295): this run's cost = its total − the session's total so far
        cost_base: resume && t.lease?.session === session ? t.lease.cost_total ?? t.lease.cost_base ?? 0 : 0,
      };
      try {
        await store.updateTicket(t.id, (k) => { // intent: before the spawn
          if (k.lease?.gen !== from || k.state !== t.state || !AGENT.includes(k.state)) throw new Stale();
          return { ...k, lease, waiting: null, ...(!reserved && { wall: { phase: t.state, task: null, ms: 0 } }) };
        });
      } catch (e) {
        if (e instanceof Stale) return false;
        throw e;
      }
      const run = track(t.id, lease, true, crypto.randomBytes(16).toString('hex')); // key: TBX_RUN, in the env from the start
      free();
      try {
        const s = await spawnRun({
          ticket: t, phase: t.state, n, session, resume, key: run.key, prompt, config: store.config,
          tag: t.tag ? store.listTags()[t.tag] : undefined, tbHome, ticketDir: dir, port,
        });
        s.done.then(({ code }) => { run.code = code; run.exited = true; });
        await s.ready;
        run.lease.pid = run.lease.pgid = s.child.pid;
        // queued in the spawn event's tick, before any ps
        if (!(await saveLease(run, { pid: s.child.pid, pgid: s.child.pid }, (k) => k.state === run.lease.phase))) {
          if (!run.exited) try { kill(-s.child.pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
          drop(run);
          if (await saveLease(run, { exit: 'cancelled', ended_at: iso(now()) })) meter(t.id, run.lease, run); // still this lease: the ticket left the phase (N2); metered + packed (Mt4)
          return false;
        }
        await fillLstart(run, await procs(true));
      } catch (e) {
        // bad config or template, claude_bin missing: a crash, counted like one. Agent-planted config (S1): no retry
        // can pass it, so Blocked at once, not counted, the files named in lease.error and an alert (R17).
        console.error(`tbd: ${t.id}: run ${n} not started: ${e.message}`);
        if (run.lease.pid) return true; // spawned: the loop follows it to its exit event
        const error = String(e.message).slice(0, 300);
        const planted = e.code === 'PLANTED';
        if (planted) alert({ title: 'Run refused: agent-planted config', message: error });
        try {
          await store.updateTicket(t.id, (k) => {
            if (k.lease?.gen !== run.lease.gen) throw new Stale();
            const lease = { ...k.lease, exit: 'crash', ended_at: iso(now()), error, failure: !planted && failure('crash', run) };
            return planted ? { ...fsm.move(k, 'blocked', 'runner'), lease } : { ...k, lease };
          });
        } catch (e2) {
          if (!(e2 instanceof Stale)) throw e2;
        }
        drop(run); // only now: a save that threw leaves the run tracked (R14)
        return false;
      }
      return true;
    } finally {
      free();
    }
  }

  // §4: crash, stall and a run lost without a result count, unless it ended while the net was down or in a wake grace.
  // A run found dead at boot is a lost run: it counts (the gap is unknown, so no sleep is assumed).
  const failure = (exit, run) => FAILS.includes(exit) && offlineAt == null && run.wakeAt == null;

  // §8 usage pause: the latest reset of a run paused on the limit; nothing new starts before it.
  function pausedUntil() {
    let until = usageFloor;
    for (const k of store.listTickets()) if (k.lease?.exit === 'usage' && AGENT.includes(k.state)) until = Math.max(until, usageUntil(k.lease));
    return until;
  }

  // AC10: what a run of the phase is expected to need, GB: the median peak of its last 10 runs, else the config's.
  const need = (phase) => admission.needGb(phase, metrics.runs(), store.config);

  // Step 3's admission: a new run's rules (§7) plus the usage pause. null: go, and a start slot is held (H4).
  function ready(t) {
    if (pausedUntil() > now()) return 'usage';
    const a = admission.admit({ snap: system(), runs: runs.size + starting, phase: t.state, config: store.config, needGb: need(t.state) });
    if (a.ok) starting++;
    return a.ok ? null : a.reason;
  }

  // T3: what is left in the run's own process group once its claude is gone: SIGTERM, then SIGKILL after GRACE_MS.
  // Only this run's group: the lease's pgid is its own pid (spawned detached) and that pid is gone or still this run
  // (pid + lstart). A live pid with another start time leads someone else's group now (POSIX keeps a group's id from
  // reuse only while the group lives). Checked again before each signal. Its kids' own groups too (strays).
  async function killGroup(run) {
    const { pid, pgid, lstart } = run.lease;
    let group = Number.isInteger(pgid) && pgid >= 2 && pgid === pid;
    for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGKILL'])) {
      const m = (await procs(true)) ?? (await procs(true)); // S4: once more, then Irfan is told
      if (!m) {
        console.error(`tbd: ${run.runId}: ps failed twice: group ${pgid} and its Bash calls not killed`);
        return void alert({ title: 'Run cleanup failed', message: `ps failed twice ending run ${run.runId}: its process group or Bash calls may still run` });
      }
      const leader = group ? m.get(pgid) : null;
      if (leader && leader.lstart !== lstart) {
        console.error(`tbd: ${run.runId}: not killing group ${pgid}: pid ${pgid} is another process now`);
        group = false;
      }
      if (group && ![...m.values()].some((p) => p.pgid === pgid)) group = false;
      const kids = [...strays(run.kids, m).keys()]; // its Bash calls' own groups (start time checked in strays)
      if (!group && !kids.length) return;
      if (group) try { kill(-pgid, sig); } catch { /* exited meanwhile */ }
      for (const p of kids) try { kill(p, sig); } catch { /* exited meanwhile */ }
      if (sig === 'SIGTERM') await sleep(GRACE_MS);
    }
  }

  // D37: an agent could boot tbd's job out of launchd (bash-guard denies launchctl, best effort): tell Irfan.
  async function checkLaunchd() {
    if (!launchd()) return; // a dev or test tbd: no launchd job to check
    const r = await exec('/bin/launchctl', ['print', `gui/${uid}/${LABEL}`], { timeout: 5000 });
    if (r.err) alert({ title: 'tbd not loaded in launchd', message: `${LABEL} is not loaded after an agent run; reload it (scripts/deploy)` });
  }

  const rec = createRecovery({
    store, now, sleep, procs, kill, alive, probe, exec, ready, startRun, rerunGate, findRun, alert,
    release: () => { starting--; },
    takeRun: (id) => { // R2: a live run keeps counting for admission (a start slot) until step 3 releases it
      // L2: a failed attempt (ps down, SIGKILL did not take) left it in taken: the retry takes it again (kids, trust)
      const r = runs.get(id) ?? [...taken.values()].find((x) => x.id === id);
      runs.delete(id);
      if (r) {
        starting++;
        taken.set(r.runId, r);
      }
      return r;
    },
    endRun: async (runId) => { // step 2: the old run is dead. Its lease now is the recovery's, still naming the run's log
      const r = taken.get(runId);
      taken.delete(runId);
      const wait = r && r.waitBase + (slots.waits?.(runId).wait_ms ?? 0); // before endRun forgets it
      await slots.endRun(runId);
      const id = runId.slice(0, runId.lastIndexOf('.'));
      // L1: its result line on the SIGINT carries the session's total: the resume's cost_base (CAS on the lease gen)
      const cost = r?.tail && (await r.tail.read({ final: true })).result?.cost_micro;
      const l = store.getTicket(id).lease;
      if (l && Number.isInteger(cost)) {
        await store.updateTicket(id, (k) => {
          if (k.lease?.gen !== l.gen) throw new Stale();
          return { ...k, lease: { ...k.lease, cost_total: cost } };
        }).catch((e) => { if (!(e instanceof Stale)) throw e; });
      }
      if (l) meter(id, l, r, wait);
    },
    afterKill: checkLaunchd,
    setWaiting: (id, why, gen) => setWaiting(store.getTicket(id), why, (k) => k.lease?.gen === gen), stopped: () => stopped,
  });

  // A rule fired for a live run: to the recovery path once, with the gen this run holds. → the attempt, settled.
  function go(run, o) {
    if (run.going) return;
    run.going = o.why;
    if (o.exit === 'usage') usageFloor = Math.max(usageFloor, usageUntil({ resets_at: o.resets_at, ended_at: iso(now()) })); // R11
    return rec.recover(run.id, { gen: run.lease.gen, ...o }).then((ok) => { if (!ok && runs.get(run.id) === run) run.going = null; });
  }

  // An ended run in the ticket's phase (§4 blocked rules, §8 triggers): what follows. Every tick until it acts.
  function decide(t) {
    const l = t.lease;
    const next = (o) => void rec.recover(t.id, { gen: l.gen, why: l.exit, ...o });
    switch (l.exit) {
      case 'result': case 'cancelled': return undefined; // the phase handler decided (P4: the next task)
      case 'crash': case 'interrupted': case 'stalled': return next({ count: l.failure !== false });
      case 'usage': return now() >= usageUntil(l) ? next({}) : setWaiting(t, 'usage');
      case 'paused': return admission.canResume({ snap: system(), run: { phase: l.phase, need_gb: need(l.phase) }, config: store.config }) ? next({}) : setWaiting(t, 'memory');
      case 'schema_fail': return next(l.schema_retry ? { after: 'block' } : { schema: true }); // resumed once, then Blocked
      default: return next({ after: 'block' }); // max_turns, refusal, wall_cap: Irfan decides. P4 AC7 changes refusal to an Opus re-run
    }
  }

  // T1 gate for one ticket, or what follows its last run.
  async function consider(t) {
    if (t.type !== 'flow' || !ID_RE.test(t.id) || runs.has(t.id) || rec.busy(t.id)) return;
    const l = t.lease;
    if (l?.pending) return void rec.recover(t.id, { gen: l.gen }); // left by a tbd that stopped mid-recovery: from step 1
    if (!AGENT.includes(t.state) || (l && !l.exit)) return; // live: tracked since start()
    // I9: a lease of an earlier visit to this phase (fsm.move bumped round since) is not this round's: T1, new clock.
    // A lease from before `round` existed has none: the same round while the ticket has not moved since.
    if (l && l.phase === t.state && l.round === t.round) return decide(t);
    if (!phases.built(t.kind, t.state)) {
      if (phases.misconfigured(t.kind, t.state)) return void await fsm.transition(store, t.id, 'blocked', 'runner'); // D9: never spawned
      return setWaiting(t, 'manual'); // D9: an unbuilt phase waits on Irfan
    }
    if (paused > now()) return setWaiting(t, 'usage');
    const a = admission.admit({ snap: system(), runs: runs.size + starting, phase: t.state, config: store.config, needGb: need(t.state) });
    if (!a.ok) return setWaiting(t, a.reason);
    await startRun(t); // counts as a run from its first line, before any await

  }

  // The phase handler gets the result object (untrusted: it validates against the phase schema, P4) and returns
  // {to, ctx} for the next state, or nothing to stay. Only while the ticket still holds this run's lease and phase
  // (a recovery may have replaced the lease; a crash between handler and save leaves the phase). A throw or a refused
  // transition blocks the ticket. The move is checked in its own write (R4: a Restart or Cancel during an async
  // handler wins over it).
  async function handle(run, output) {
    const t = store.getTicket(run.id);
    const mine = (k) => k.lease?.gen === run.lease.gen && k.state === run.lease.phase;
    if (!mine(t)) return void console.error(`tbd: ${run.runId}: result ignored: the ticket now holds lease gen ${t.lease?.gen} in ${t.state}`);
    const move = (to, ctx) => store.updateTicket(t.id, (k) => {
      if (!mine(k)) throw new Stale();
      return fsm.move(k, to, 'runner', ctx);
    });
    try {
      const next = await phases.handler(t.kind, t.state)?.(structuredClone(t), output);
      if (next?.to) await move(next.to, next.ctx ?? {});
    } catch (e) {
      if (e instanceof Stale) return void console.error(`tbd: ${run.runId}: result ignored: the ticket moved on during its handler`);
      console.error(`tbd: ${t.id}: ${t.kind}/${t.state} result not taken: ${e.message}`);
      await move('blocked', {}).catch((e2) => { if (!(e2 instanceof Stale)) console.error(`tbd: ${t.id}: not blocked: ${e2.message}`); });
    }
  }

  async function end(run) {
    const s = run.tail ? await run.tail.read({ final: true }) : null;
    const res = s ? outcome(s, { code: run.code, session: run.lease.session }) : { exit: 'interrupted' };
    const wait = run.waitBase + (slots.waits?.(run.runId).wait_ms ?? 0); // before endRun forgets it
    // slots first: it owns the heavy command groups (its own grace + alerts); then the run's group and its kids (strays),
    // whatever slots left. In parallel they raced for the same heavy group (both SIGKILL after 2 s; P3 review flake).
    await slots.endRun(run.runId);
    await killGroup(run);
    if (res.exit === 'result') await handle(run, res.output);
    const saved = await saveLease(run, {
      exit: res.exit, ended_at: iso(now()), tool: null, last_event_at: s?.last_event_at ?? run.lease.last_event_at, slot_wait_ms: wait,
      ...(Number.isInteger(s?.result?.cost_micro) && { cost_total: s.result.cost_micro }),
      ...(FAILS.includes(res.exit) && { failure: failure(res.exit, run) }), ...(res.exit === 'usage' && { resets_at: res.resets_at ?? null }),
    });
    drop(run);
    if (saved) meter(run.id, run.lease, run, wait); // not saved: a recovery took the lease; its step 2 meters the run
    await checkLaunchd();
  }

  // AC10 + AC9 (T6), once per run end (end() above, a recovery's step 2): one `t:run` line, then the log gzipped. The
  // plain log is the marker (gone once packed), so a run seen ending by both paths is metered once. l: a lease naming
  // the run's log with its exit; run: the run as this tbd tracked it (tail, peaks), if it did. In the background: a run
  // end never waits on it; stop() does. → the metering promise, or undefined when there is nothing (left) to meter.
  // exit (L3): the one the run reached itself (its own result line) wins; else a run Irfan stopped (Resume, Restart,
  // Cancel: the recovery's pending.why) is `cancelled` in the metric, though its lease says paused for the recovery.
  // P1: claude answers the recovery's SIGINT with a result line of its own (error_during_execution, 2.1.295): that
  // crash is the stop, not the run's own end.
  function meter(id, l, run, waitMs = l.slot_wait_ms ?? 0) {
    const file = typeof l.log === 'string' && LOG_RE.test(l.log) ? path.join(store.ticketDir(id), l.log) : null;
    if (!file || metering.has(file)) return undefined;
    metering.set(file, (async () => {
      if (!(await fsp.access(file).then(() => true, () => false))) return; // packed already
      const s = await (run?.tail ?? createTail(file)).read({ final: true });
      const { model, effort } = spawn.modelFor(store.config, l.phase);
      const res = s.result?.valid && s.result.session_id === l.session ? outcome(s, { session: l.session }).exit : null;
      const own = res === 'crash' && l.pending && s.result.subtype === 'error_during_execution' ? null : res;
      const exit = own ?? (['resume', 'restart', 'cancel'].includes(l.pending?.why) ? 'cancelled' : l.exit);
      await metrics.append({
        t: 'run', ticket: id, phase: l.phase, task: l.task ?? null, model: model ?? null, effort: effort ?? null, started: l.started_at,
        ended: l.ended_at ?? iso(now()), exit: metrics.exitOf(exit), turns: s.result?.num_turns ?? null, cost_delta: Number.isInteger(s.result?.cost_micro) ? Math.max(0, s.result.cost_micro - (l.cost_base ?? 0)) : null,
        peak_rss_mb: run?.peak || null, subagents_peak: run ? run.subPeak : null, slot_wait_ms: waitMs, resumed: !!l.resumed,
      });
      await packLog(file);
    })().catch((e) => console.error(`tbd: ${id}: run end not metered: ${e.message}`)).finally(() => metering.delete(file)));
    return metering.get(file);
  }

  // The run of a lease without a start time, from a tbd that died before it had one: pid null (died between saving the
  // intent and the pid) or lstart '' (died before ps listed the pid). It is the claude_bin process whose argv names
  // the lease's session id; a saved pid must be that process, else exactly one may match. → {pid, pgid, lstart};
  // undefined: none (never spawned, gone, no single clear match); null: ps failed, ask again.
  async function findRun(l) {
    const ps = UUID_RE.test(l.session) ? await psArgs() : { err: null, stdout: '' };
    const m = ps.err ? null : await procs(true);
    if (!m) return null;
    const re = new RegExp(`\\s--(session-id|resume) ${l.session}(\\s|$)`);
    const bin = l.bin ?? store.config.claude_bin;
    const pids = ps.stdout.split('\n').filter((x) => x.includes(bin) && re.test(x)).map((x) => Number(/^\s*(\d+)/.exec(x)?.[1]));
    const pid = Number.isInteger(l.pid) ? pids.find((x) => x === l.pid) : pids.length === 1 ? pids[0] : undefined;
    const p = m.get(pid);
    return p ? { pid, pgid: p.pgid === pid ? pid : null, lstart: p.lstart } : undefined;
  }

  async function adopt(run) {
    const found = await findRun(run.lease);
    if (found === null) return; // ps failed: ask again next tick
    if (!found) return end(run); // the log decides (none → interrupted)
    await saveLease(run, found);
  }

  // §8 liveness of a live run and its rules. Usage `rejected` → paused until its reset. A grace (after a wake or net
  // back): no other rule until it speaks or wake_grace_min passes; then silent with no tool, wait or outage →
  // recovery, not counted (sleep, network), else the normal rules. Wall cap over the phase (I8: earlier runs of it +
  // this one, minus heavy-slot wait and sleep) → killed, Blocked. Stall (silent stall_min, no tool, not offline or
  // waiting) → recovery, counted. A run re-attached at boot is silent since boot at most (R15: the gap while tbd was
  // down is unknown).
  function watch(run, s, w, m) {
    jump(); // N1: the lid may have closed during the poll's awaits (lstart, lease save): before any rule sees the time
    const lv = store.config.liveness;
    const l = run.lease;
    const t = now();
    const last = Date.parse(s?.last_event_at ?? l.last_event_at);
    const st = { ageMs: t - Math.max(last, run.bootAt ?? -Infinity), tool: s?.tool ?? null, waiting: w.waiting || !!s?.retrying, offline: offlineAt != null };
    const state = liveness(st, lv);
    let rss = 0;
    if (m) {
      const pids = tree(l, m, run.own && !run.exited);
      for (const p of pids.keys()) rss += m.get(p).rss ?? 0;
      // kids for the run end and a recovery (strays): every descendant seen, the dead ones dropped, except a group
      // leader gone from ps while its group lives (S5: strays brings the members it left)
      const led = (p) => [...m.values()].some((x) => x.pgid === p);
      for (const [p, k] of run.kids ??= new Map()) if (m.get(p)?.lstart !== k.ls && !(k.lead && !m.has(p) && led(p))) run.kids.delete(p);
      for (const [p, ls] of pids) if (p !== l.pid) run.kids.set(p, { ls, lead: m.get(p).pgid === p });
    }
    run.peak = Math.max(run.peak, Math.round(rss / 1024));
    run.live = {
      id: run.id, liveness: state, last_event_age_s: Math.max(0, Math.round((t - last) / 1000)), tool: st.tool,
      tool_s: st.tool && s?.tool_since ? Math.max(0, Math.round((t - Date.parse(s.tool_since)) / 1000)) : null,
      subagents_alive: l.subagents_alive, rss_mb: Math.round(rss / 1024),
      live: true, started_at: l.started_at, last_event_at: s?.last_event_at ?? l.last_event_at,
    };
    if (s?.rejected) return go(run, { why: 'usage', after: 'pause', exit: 'usage', resets_at: s.rejected.resets_at });
    if (run.wakeAt != null) {
      // it spoke after the grace began: event time, not a count (a line written before a sleep is often read after it)
      if (t - st.ageMs > run.wakeAt) run.wakeAt = null;
      else if (t - run.wakeAt < lv.wake_grace_min * MIN) return;
      else {
        run.wakeAt = null; // grace over: from here a crash counts again
        if (!st.offline && !st.waiting && !st.tool) return go(run, { why: run.wakeWhy, exit: 'paused' });
      }
    }
    const used = wallMs(store.getTicket(run.id).wall, l) + runMs({ ...l, slot_wait_ms: run.waitBase + w.wait_ms }, t);
    const held = hintAt != null && t - hintAt < lv.wake_grace_min * MIN; // a sleep whose sleep_ms is not in yet
    if (!held && used >= lv.wall_min[spawn.capKey(l.phase)] * MIN) return go(run, { why: 'wall_cap', after: 'block', exit: 'wall_cap' });
    if (state === 'stalled') go(run, { why: 'stalled', count: true, exit: 'stalled' });
  }

  async function poll(run, m) {
    if (run.going) return; // the recovery path has it
    const l = run.lease;
    if (!run.own && (!Number.isInteger(l.pid) || !l.lstart)) return adopt(run);
    const s = run.tail ? await run.tail.read() : null;
    jump(); // N1: the lid may have closed during this tick's awaits (ps, tail): before end() judges a lost run
    let ok;
    if (run.own) ok = !run.exited; // spawned here: the exit event decides, never ps
    else if (!m) return; // ps failed: unknown, ask again next tick
    else ok = typeof l.lstart === 'string' && l.lstart !== '' && m.get(l.pid)?.lstart === l.lstart;
    if (!ok) return end(run);
    if (run.own && !l.lstart && Number.isInteger(l.pid)) await fillLstart(run, m);
    const u = slots.usage(run.runId);
    run.subPeak = Math.max(run.subPeak, u.alive ?? 0);
    const w = slots.waits?.(run.runId) ?? { wait_ms: 0, waiting: false };
    const patch = {
      last_event_at: s?.last_event_at ?? l.last_event_at, tool: s?.tool ?? null, subagents_alive: u.alive, subagents_spawned: u.spawned,
      slot_wait_ms: run.waitBase + w.wait_ms,
    };
    if (Object.entries(patch).some(([k, v]) => l[k] !== v) && Date.now() - run.savedAt >= SAVE_MS) {
      run.savedAt = Date.now();
      await saveLease(run, patch);
    }
    watch(run, s, w, m);
  }

  // wake_grace_min from now for run r to speak (watch); why ('sleep' | 'net'): what the recovery is if it stays silent.
  function grace(r, why) {
    r.wakeAt = now();
    r.wakeWhy = why;
  }

  // Net back after an offline period (offlineAt: liveness "offline", no stall rule, a run ending meanwhile is not a
  // failure): each run silent since the net went gets the grace (H3: never killed on net back alone; a tool or a
  // wait keeps it going). After the polls: their events are fresh.
  function netBack() {
    for (const r of runs.values()) if (Date.parse(r.tail?.state.last_event_at ?? r.lease.last_event_at) <= offlineAt) grace(r, 'net');
    offlineAt = null;
  }

  // Sleep, early hint (R3): the wall clock jumped more than WAKE_MS since the runner last looked (tick start, poll
  // before end(), watch: H2 N1). A sleep or a slow tick: Node's hrtime counts sleep on macOS, so the runner can't tell.
  // Each live run gets the grace (no stall, no failure while it is silent) and the wall cap waits up to the same
  // wake_grace_min for the OS wake (wake()): the monitor's next sample (5 s) carries it. No sleep_ms from a hint. A jump
  // the OS wake already covered (it woke after this last look) is no hint.
  function jump() {
    const t = now();
    if (lookedAt != null && t - lookedAt > WAKE_MS && !(wokeAt > lookedAt)) hint();
    lookedAt = t;
  }
  function hint() {
    hintAt = now();
    for (const r of runs.values()) grace(r, 'sleep');
  }

  // Monitor 'wake' (spec §8). With `at`: the OS slept gap_ms (kern.sleeptime → kern.waketime = at), taken once: every
  // live run gets the grace, and one that lived through the sleep has it leave its wall clock (I8; saved now, so a tbd
  // restart keeps it). Without `at` (a wall jump the monitor saw): a hint, as jump().
  /** @param {{gap_ms: number, at?: number}} [e] */
  function wake(e) {
    if (e?.at == null) return hint();
    if (e.at === wokeAt || !(e.gap_ms > 0)) return;
    wokeAt = e.at;
    hintAt = null;
    for (const r of runs.values()) {
      grace(r, 'sleep');
      if (Date.parse(r.lease.started_at) > e.at - e.gap_ms) continue; // started after the Mac fell asleep
      r.lease.sleep_ms = (r.lease.sleep_ms ?? 0) + e.gap_ms;
      saveLease(r, { sleep_ms: r.lease.sleep_ms }).catch((err) => console.error(`tbd: run ${r.runId}: sleep not saved: ${err.message}`));
    }
  }

  // §7 critical pressure: pause the most recently started run (SIGINT through step 2; not a failure). At most one per
  // monitor sample, none while one is still being paused (its recovery runs); it resumes when admission.canResume (D2).
  function memory(snap) {
    if (snap?.at === memAt || pausing) return;
    const live = [...runs.values()].filter((r) => !r.going);
    const [p] = admission.decide({ snap, runs: live.map((r) => ({ id: r.id, started_at: r.lease.started_at })) });
    if (!p) return;
    memAt = snap.at;
    pausing = go(runs.get(p.runId), { why: 'memory', after: 'pause', exit: 'paused' })?.finally(() => { pausing = null; });
  }

  // AC8: caffeinate -i from the first live run to the last; with caffeinate "ac_only" (default) only on AC power.
  function awake(snap) {
    const mode = store.config.caffeinate;
    const want = runs.size > 0 && mode !== 'off' && (mode !== 'ac_only' || snap?.power === 'ac');
    if (want && !caff) {
      const c = caffeinate();
      c.on?.('exit', () => { if (caff === c) caff = null; }); // died on its own: started again next tick
      caff = c;
    } else if (!want && caff) {
      caff.kill();
      caff = null;
    }
  }

  function tick() {
    if (current || stopped) return current;
    jump();
    current = (async () => {
      await loading;
      const snap = system();
      if (snap?.net === false) offlineAt ??= now();
      if (runs.size) {
        const m = await procs();
        for (const run of runs.values()) await poll(run, m).catch((e) => console.error(`tbd: run ${run.runId}: ${e.message}`));
        memory(snap);
      }
      if (snap?.net === true && offlineAt != null) netBack();
      paused = pausedUntil();
      for (const t of store.listTickets()) {
        if (stopped) break;
        await consider(t).catch((e) => console.error(`tbd: ${t.id}: ${e.message}`));
      }
      awake(snap);
    })().catch((e) => console.error(`tbd: runner tick: ${e.message}`)).finally(() => { current = null; }); // R12: never an unhandled rejection
    return current;
  }

  // P3c buttons (spec §8, §4): Resume = same session through the recovery path, refused while the run is live, from
  // Blocked only to phases up to where it blocked (fsm guard; another phase than the run's, or a new round of it, gets a
  // fresh session);
  // Restart = a fresh session in the same phase, a live run killed first; Cancel = the tree killed, state cancelled,
  // worktree kept (tb gc). None counts rework or failures. Resolve true once done (Resume/Restart: the run started,
  // which may wait for admission), false when a newer attempt won; a refused request throws TbError 409.
  async function control(id, op, phase) {
    const t = store.getTicket(id);
    const l = t.lease;
    const gen = l?.gen ?? 0;
    if (op === 'cancel') {
      if (!l) return fsm.transition(store, id, 'cancelled', 'you').then(() => true);
      return rec.recover(id, { gen, why: 'cancel', after: 'cancel', exit: 'cancelled', user: true });
    }
    const to = t.state === 'blocked' ? (op === 'resume' && phase) || t.blocked_from : undefined;
    const target = to ?? t.state;
    if (phase && phase !== target) throw new TbError(409, `${id}: --phase works from Blocked only (now ${t.state})`);
    if (!AGENT.includes(target)) throw new TbError(409, `${id}: ${target} has no agent run to ${op}`);
    if (!phases.built(t.kind, target)) throw new TbError(409, `${id}: ${t.kind}/${target} is not built (D9)`);
    return rec.recover(id, {
      gen, why: op, to, after: 'resume', exit: 'paused', user: true, refuseLive: op === 'resume', // M2: never inherits a pending block
      // M1: an earlier round's lease (I9) never resumes into this round: its session holds the old round's prompt
      fresh: op === 'restart' || !l || l.phase !== target || (!to && l.round !== t.round),
    });
  }

  return {
    // Re-attach: every lease without `exit` is a run until its process proves gone (a pending recovery has `exit`).
    // R15: tbd may start after a sleep or a long stop (gap unknown: no sleep_ms), so a re-attached run's silence counts
    // from boot at the earliest under the normal stall rule: one thinking quietly is not cut short, a real stall counts.
    start() {
      for (const t of store.listTickets()) if (t.lease && !t.lease.exit && ID_RE.test(t.id)) track(t.id, t.lease).bootAt = now();
      loading = metrics.load().catch((e) => console.error(`tbd: metrics not loaded: ${e.message}`)); // then config defaults
      // L2: a run end saved but not metered (tbd stopped in between) left its plain log: metered now, one at a time. A
      // pending recovery meters its run in its own step 2.
      const unmetered = store.listTickets().filter((t) => t.lease?.exit && !t.lease.pending && ID_RE.test(t.id));
      loading.then(async () => { for (const t of unmetered) if (!stopped) await meter(t.id, t.lease, null); });
      timer = setInterval(tick, TICK_MS);
      timer.unref();
      tick();
    },
    // Runs keep going (they outlive tbd); only the loop stops, after the tick in flight. A recovery in flight stops at
    // its next step-3 check; its pending lease is the next tbd's.
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current; // R6: first, its awake() could start caffeinate again
      await Promise.allSettled(metering.values());
      caff?.kill();
      caff = null;
    },
    tick, // tests drive the loop with a fake clock
    idle: () => rec.idle(),
    wake, // monitor 'wake' (see wake())
    // P3c: the `run` SSE payload of every agent-phase ticket with a run (live: tracked here; else ended), and the usage
    // part of `system`.
    view() {
      const t = now();
      const out = [...runs.values()].map((r) => r.live).filter(Boolean);
      for (const k of store.listTickets()) {
        const l = k.lease;
        if (runs.has(k.id) || !AGENT.includes(k.state) || !l?.exit || l.exit === 'result' || l.exit === 'cancelled') continue;
        out.push({
          id: k.id, liveness: offlineAt != null ? 'offline' : PAUSES.includes(l.exit) ? 'paused' : 'interrupted',
          last_event_age_s: l.last_event_at ? Math.max(0, Math.round((t - Date.parse(l.last_event_at)) / 1000)) : null, tool: null, tool_s: null, subagents_alive: 0, rss_mb: 0,
          live: false, started_at: l.started_at ?? null, last_event_at: l.last_event_at ?? null,
        });
      }
      const until = pausedUntil();
      const warn = [...runs.values()].some((r) => r.tail?.state.rate_limit?.status === 'allowed_warning');
      return { runs: out, system: { runs: runs.size, paused_until: until > t ? iso(until) : null, usage_warning: warn } };
    },
    resume: (id, { phase = undefined } = {}) => control(id, 'resume', phase),
    restart: (id) => control(id, 'restart'),
    cancel: (id) => control(id, 'cancel'),
  };
}

module.exports = { createRunner };
