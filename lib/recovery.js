'use strict';
// recovery: the one path every interrupted, stalled, paused, cancelled or restarted run goes through (spec §8
// "Recovery: one path for every case", §4 blocked rules, plan P3 AC5 AC7). recover() is steps 1-6 for every trigger:
// 1. in the store's queue (the ticket's mutex) bump the lease gen by compare-and-swap on the gen the trigger saw; a
//    second attempt (auto-resume, a button, the post-restart check) finds a newer gen and stops. Resume is refused
//    while the run is live. The same write counts a failure (crash, stall, lost run; never a pause or a button) and
//    turns the recovery into "block" past recovery.max_failures_per_phase, so a count is never lost or doubled.
// 2. the old run dies: SIGINT to its tree (process group + ppid walk), 10 s, SIGKILL what is left, kill(pid, 0).
//    Only its own processes: pid + start time, as P3a's killGroup.
// 3. wait for the network (probe; again every 30 s while down) and for admission (§7 + the usage pause).
// 4. git status in the run's cwd (H11 git, timeout): a dirty tree is fine and named in the prompt.
// 5. claude -p --resume <session> with the §8 prompt (no --session-id, no resume env var); Restart: a fresh session.
// 6. counted in step 1's write (see 1).
// Block, pause and cancel are steps 1-2 and one closing write. The lease carries the attempt (`pending`) until the
// new run's lease replaces it, so a tbd that stops halfway leaves a lease the next tbd takes from step 1 again.
// Async only (D31); clock, sleep, ps, kill, probe and git injectable.
const crypto = require('node:crypto');
const path = require('node:path');
const fsm = require('./fsm');
const { TbError } = require('./errors');
const { RESUME_PROMPT } = require('./spawn');
const { GIT_SAFE, GIT_ENV, minimalEnv } = require('./util');

const MIN = 60_000;
const INT_MS = 10_000; // step 2: SIGINT, then SIGKILL
const NET_MS = 30_000; // step 3: probe cadence while the network is down
const POLL_MS = 1000; // step 3: admission re-check
const RETRY_MS = 30_000; // a failed attempt is taken again after this, not every tick (R13)
const SCHEMA_PROMPT = 'Return the result matching the schema.'; // §8 invalid result: resumed once with this
const NOTE_LINES = 50;
const GIT = '/usr/bin/git';

class Stale extends Error {} // the lease gen moved on: a newer attempt owns the ticket

// The run's live processes, pid → start time: the root (pid AND start time match: a reused pid is not the run), its
// descendants by ppid, and the members of its own process group (pgid = its pid; a group outlives its leader).
// trust: no start time saved yet, but the pid is tbd's own unreaped child, so ps's start time for it is the run's.
function tree({ pid, lstart, pgid }, m, trust = false) {
  const out = new Map();
  if (!Number.isInteger(pid) || pid < 2) return out;
  const root = m.get(pid);
  const start = lstart || (trust ? root?.lstart : '');
  if (!start || (root && root.lstart !== start)) return out;
  if (pgid === pid) for (const [p, x] of m) if (x.pgid === pid) out.set(p, x.lstart);
  const kids = new Map();
  for (const [p, x] of m) (kids.get(x.ppid) ?? kids.set(x.ppid, []).get(x.ppid)).push(p);
  const seen = new Set();
  for (const stack = root ? [pid] : []; stack.length;) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    out.set(p, m.get(p).lstart);
    stack.push(...(kids.get(p) ?? []));
  }
  out.delete(process.pid);
  return out;
}

// What a run started that left its tree: claude runs each Bash call in a new process group, so once claude dies those
// children are in neither its group nor its ppid walk (ppid 1; P3d smoke 2.1.295). kids: pid → {ls: start time, lead:
// it led its own group} remembered by the runner each tick; each one still alive brings its own tree. A leader gone
// from ps brings its group's live members (S5: POSIX keeps a live group's id from reuse, as killGroup). ponytail: in
// memory only, so kids of a claude that died while tbd was down are missed (a reboot kills them anyway); persist them in
// the lease if that ever matters.
function strays(kids, m) {
  const out = new Map();
  for (const [p, k] of kids ?? []) {
    const x = m.get(p);
    if (x) for (const [q, qs] of tree({ pid: p, lstart: k.ls, pgid: x.pgid }, m)) out.set(q, qs); // tree: same start time or nothing
    else if (k.lead) for (const [q, y] of m) if (y.pgid === p) out.set(q, y.lstart);
  }
  return out;
}

// I8 phase wall clock: a run's time minus its heavy-slot wait and its sleep (wake gaps); ended_at missing = live (at).
const runMs = (l, at) => Math.max(0, (Date.parse(l.ended_at) || at) - Date.parse(l.started_at) - (l.slot_wait_ms ?? 0) - (l.sleep_ms ?? 0)) || 0;
// The phase time used before this run: the ticket's wall when it is this run's phase (and task), else 0.
const wallMs = (wall, l) => (wall && wall.phase === l.phase && (wall.task ?? null) === (l.task ?? null) ? wall.ms : 0);

// §8 liveness of a live run (P3c shows it), first match: offline (net probe fails) > waiting (heavy slot, lock,
// system/api_retry) > tool (a tool_use without its result) > stalled (no event for stall_min) > quiet (quiet_min) >
// thinking. So "stalled" never has a tool running.
function liveness({ ageMs, tool, waiting, offline }, lv) {
  if (offline) return 'offline';
  if (waiting) return 'waiting';
  if (tool) return 'tool';
  if (ageMs >= lv.stall_min * MIN) return 'stalled';
  if (ageMs >= lv.quiet_min * MIN) return 'quiet';
  return 'thinking';
}

/**
 * Runner callbacks: ready(t) → null (a start slot is now held) or why the run may not start yet (step 3); release()
 * gives that slot back when the attempt stops before startRun(t, opts) → started? (step 5; reserved: it takes the
 * slot over); findRun({pid, session, bin}) → {pid, pgid, lstart} of that claude_bin run, undefined (not it), null (ps
 * failed); takeRun(id) → the live run the loop tracked for it, now dropped from the loop (a start slot held for it,
 * given back with release()); endRun(runId) → slots of that run ended; afterKill() after a live run was killed (D37
 * check); setWaiting(id, why, gen) → throws Stale once the lease gen is not gen; stopped() → tbd is
 * stopping; rerunGate(t, phase) → P5's gate re-run before a Resume/Restart out of Blocked starts the run (a no-op
 * seam until gates exist; a throw stops the attempt); alert(a) tells Irfan.
 * @param {{store: any, now: () => number, sleep: (ms: number) => Promise<any>, procs: (fresh?: boolean) => Promise<Map<number, any>|null>,
 *   kill: (pid: number, sig: NodeJS.Signals) => void, alive: (pid: number) => boolean, probe: () => Promise<boolean>, exec: Function,
 *   ready: (t: any) => string|null, startRun: (t: any, o: any) => Promise<boolean>, takeRun: (id: string) => any,
 *   findRun: (l: {pid: number, session: string, bin?: string}) => Promise<any>, release: () => void,
 *   endRun: (runId: string) => Promise<any>, afterKill: () => Promise<any>, setWaiting: (id: string, why: string, gen: number) => Promise<any>,
 *   stopped: () => boolean, rerunGate: (t: any, phase: string) => Promise<any>, alert: (a: {title: string, message: string}) => void}} d
 */
function createRecovery(d) {
  const { store, now, sleep } = d;
  const inflight = new Map(); // ticket id → its recovery in this tbd (the loop leaves the ticket alone meanwhile)
  // R13: ticket id → no automatic retry before (a failed attempt: ps down, a root that will not die). ponytail: in
  // memory, so a tbd restart retries once at once; persist as pending.retry_at if that ever loops.
  const backoff = new Map();
  const kept = new Set(); // tickets whose failed attempt kept the dying run's start slot: its claude may still live
  const alerted = new Set(); // tickets Irfan was told have a failing recovery (S11)

  async function scan() {
    const m = await d.procs(true);
    if (!m) throw new Error('ps failed: the old run is not confirmed dead; tried again in 30 s');
    return m;
  }

  // Step 2. Returns whether anything of the run was alive. A root still alive after SIGKILL → throws.
  async function killTree(l, trust, kids) {
    let m = await scan();
    const pids = new Map([...tree(l, m, trust), ...strays(kids, m)]);
    if (!pids.size) return false;
    const left = () => [...pids].filter(([p, ls]) => m.get(p)?.lstart === ls).map(([p]) => p); // checked again each time
    const send = (sig) => left().forEach((p) => { try { d.kill(p, sig); } catch { /* exited meanwhile */ } });
    send('SIGINT');
    for (let ms = 0; ms < INT_MS && left().length; ms += POLL_MS) {
      await sleep(POLL_MS);
      m = await scan();
    }
    m = await scan(); // what the run started since the first scan gets the SIGKILL too (root start time as first seen)
    for (const [p, ls] of [...tree({ ...l, lstart: l.lstart || pids.get(l.pid) || '' }, m, trust), ...strays(kids, m)]) pids.set(p, ls);
    send('SIGKILL');
    const root = pids.get(l.pid);
    for (let i = 0; i < 25 && root && d.alive(l.pid) && (await scan()).get(l.pid)?.lstart === root; i++) await sleep(200); // reaped soon
    if (root && d.alive(l.pid) && (await scan()).get(l.pid)?.lstart === root) throw new Error(`run pid ${l.pid} still alive after SIGKILL`);
    return true;
  }

  // Step 1. o: gen (the CAS value), why, count, after ('resume' | 'block' | 'pause' | 'cancel'), exit (for a live
  // run), resets_at, fresh, schema, to (Resume/Restart from Blocked), refuseLive (Resume). A ticket with a pending
  // attempt keeps its fields unless o names new ones (Restart or Cancel over a waiting resume).
  function claim(id, o) {
    return store.updateTicket(id, (k) => {
      const l = k.lease;
      if ((l?.gen ?? 0) !== o.gen) throw new Stale();
      if (o.refuseLive && l && (!l.exit || l.pending)) throw new TbError(409, l.pending ? `${id}: a recovery is already running` : `${id}: the run is live; Resume works once it ended`);
      if (o.after === 'cancel' && !fsm.check(k, 'cancelled', 'you').ok) throw new TbError(409, `${id}: ${k.state} cannot be cancelled`);
      const next = o.to ? fsm.move(k, o.to, 'you') : k; // the fsm resume guard: only phases up to where it blocked
      const pick = ['why', 'after', 'fresh', 'schema', 'to'].filter((f) => o[f] !== undefined).map((f) => [f, o[f]]);
      const p = { after: 'resume', ...l?.pending, ...Object.fromEntries(pick) };
      const failures = { ...k.failures };
      if (o.to) { // I7 I9: Irfan leaving Blocked (Resume, Restart) resets the target phase's count, like rework, and
        failures[o.to] = 0; // the count of the phase it blocked in when the Resume goes back to an earlier phase
        if (failures[k.blocked_from] !== undefined) failures[k.blocked_from] = 0;
      }
      if (o.count && l) {
        failures[l.phase] = (failures[l.phase] ?? 0) + 1;
        if (failures[l.phase] > (store.config.recovery?.max_failures_per_phase ?? 3)) p.after = 'block';
      }
      const base = l ?? { gen: 0, pid: null, lstart: '', pgid: null, phase: next.state, session: null };
      p.prev = l?.pending?.prev ?? { gen: base.gen, pid: base.pid, lstart: base.lstart, pgid: base.pgid };
      const lease = {
        ...base, gen: base.gen + 1, exit: base.exit ?? o.exit ?? 'paused', ended_at: base.ended_at ?? new Date(now()).toISOString(),
        ...(o.resets_at !== undefined && { resets_at: o.resets_at }), pending: p, wall_added: true,
      };
      // I8: the old run's time joins the phase clock once (wall_added), so pauses and recovery waits between runs never
      // count; Irfan's Resume or Restart starts the clock again.
      const wall = o.user && p.after === 'resume' ? { phase: next.state, task: null, ms: 0 }
        : l && !l.wall_added ? { phase: l.phase, task: l.task ?? null, ms: wallMs(k.wall, l) + runMs(lease, now()) } : k.wall;
      return { ...next, failures, wall, lease };
    });
  }

  // Block / pause / cancel once the old run is dead: one CAS write ends the attempt and moves the ticket (§4).
  function finish(id, g, p) {
    return store.updateTicket(id, (k) => {
      if (k.lease?.gen !== g) throw new Stale();
      const lease = { ...k.lease };
      delete lease.pending;
      if (p.after === 'block' && k.state !== 'blocked') return { ...fsm.move(k, 'blocked', 'runner'), lease };
      if (p.after === 'cancel' && k.state !== 'cancelled') return { ...fsm.move(k, 'cancelled', 'you'), lease };
      return { ...k, lease };
    }).then(() => true);
  }

  // Step 4: the porcelain lines (first NOTE_LINES) as a prompt note; clean, not a repo or git failing → none. The
  // ceiling: a cwd that is not a repo itself (no worktree: the ticket dir) never reports a repo above it.
  async function dirtyNote(cwd) {
    const env = { ...minimalEnv(process.env), ...GIT_ENV, GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
    const r = await d.exec(GIT, [...GIT_SAFE, '-C', cwd, 'status', '--porcelain'], { env, timeout: 20_000 });
    const lines = r.err ? [] : String(r.stdout).split('\n').filter(Boolean);
    if (!lines.length) return '';
    return `\n\nThe working tree has uncommitted changes (git status --porcelain${lines.length > NOTE_LINES ? `, first ${NOTE_LINES} lines` : ''}):\n${lines.slice(0, NOTE_LINES).join('\n')}\n`;
  }

  async function steps(id, o) {
    // 1
    const t = await claim(id, o);
    const g = t.lease.gen;
    const p = t.lease.pending;
    const stale = () => store.getTicket(id).lease?.gen !== g;
    // 2. A saved pid without its start time (a tbd died before ps listed it) is the run only when ps shows claude_bin
    // with this session on that pid (as adopt); ps failing → throw: tried again after RETRY_MS, never spawned meanwhile.
    // A live run taken from the loop keeps a start slot (takeRun) until step 3 asks admission again (R2: its claude
    // still runs while it dies, so no other start may pass meanwhile).
    const had = kept.delete(id);
    const run = d.takeRun(id);
    if (had && run) d.release(); // one slot per attempt
    let slot = had || !!run; // this attempt holds a start slot: the dying run's (or one a failed attempt kept), then ready()'s
    let dead = false;
    try {
      const trust = !!run?.own && !run.exited;
      let prev = p.prev;
      if (Number.isInteger(prev.pid) && !prev.lstart && !trust) {
        const found = await d.findRun({ pid: prev.pid, session: t.lease.session, bin: t.lease.bin });
        if (found === null) throw new Error('ps failed: cannot tell whether the old run still lives');
        if (found) prev = { ...prev, lstart: found.lstart };
      }
      const killed = await killTree(prev, trust, run?.kids);
      dead = true;
      await d.endRun(`${id}.${p.prev.gen}`);
      if (killed) await d.afterKill();
      if (p.after !== 'resume') return stale() ? false : await finish(id, g, p);
      if (p.to) await d.rerunGate(store.getTicket(id), p.to); // left Blocked: P5 re-runs that phase's gate here
      // 3. ready() holds a start slot once it says go (H4: no second start passes admission meanwhile). A ticket out
      // of the agent phases (a Cancel that saw no lease) ends the attempt.
      for (let up = false; ;) {
        if (d.stopped() || stale() || !fsm.AGENT.includes(store.getTicket(id).state)) return false;
        if (!up && !(up = await d.probe())) {
          await d.setWaiting(id, 'offline', g);
          await sleep(NET_MS);
          continue;
        }
        if (slot) { // the dying run's slot, given back in the same breath as asking: no T1 start slips in between
          slot = false;
          d.release();
        }
        const why = d.ready(store.getTicket(id));
        if (!why) {
          slot = true;
          break;
        }
        await d.setWaiting(id, why, g);
        await sleep(POLL_MS);
      }
      // 4
      const cur = store.getTicket(id);
      const note = await dirtyNote(cur.worktree ?? store.ticketDir(id));
      if (d.stopped() || stale()) return false;
      // 5: a run that never spawned (pid null) has no session to resume
      const fresh = !!p.fresh || !Number.isInteger(p.prev.pid);
      const opts = {
        from: g, gen: g, resume: !fresh, session: fresh ? crypto.randomUUID() : cur.lease.session, reserved: true,
        prompt: (fresh ? store.renderMd(cur) : p.schema ? SCHEMA_PROMPT : RESUME_PROMPT) + note,
        extra: { schema_retry: !!p.schema || (!fresh && !!cur.lease.schema_retry), ...(!fresh && { resumed: true }) },
      };
      slot = false; // startRun owns the held slot from its first line (L1: never before the options exist)
      return await d.startRun(cur, opts);
    } finally {
      if (slot && !dead) kept.add(id); // ps failed or SIGKILL did not take: the slot waits for the next attempt (backoff)
      else if (slot) d.release();
    }
    // 6: counted in step 1
  }

  /**
   * Resolves true when the attempt finished its job (run started, or blocked / paused / cancelled), false when a
   * newer attempt owns the ticket or something failed (logged; a pending lease is taken again after RETRY_MS). A refused
   * button (TbError) rejects.
   * @param {string} id @param {{gen: number, why?: string, count?: boolean, after?: string, exit?: string, resets_at?: string|null,
   *   fresh?: boolean, schema?: boolean, to?: string, refuseLive?: boolean, user?: boolean}} o
   */
  function recover(id, o) {
    const p = steps(id, o).then((ok) => {
      if (ok) alerted.delete(id);
      return ok;
    }, (e) => {
      if (e instanceof Stale) return false;
      if (o.user && e instanceof TbError) throw e;
      console.error(`tbd: ${id}: recovery (${o.why ?? 'pending'}) stopped: ${e.message}`);
      if (!alerted.has(id)) { // S11: once per ticket until an attempt gets through
        alerted.add(id);
        d.alert({ title: 'Recovery failing', message: `${id}: ${e.message}; tried again every 30 s` });
      }
      backoff.set(id, now() + RETRY_MS);
      return false;
    });
    inflight.set(id, p);
    p.finally(() => { if (inflight.get(id) === p) inflight.delete(id); }).catch(() => {});
    return p;
  }

  // busy: a recovery runs for the ticket, or the last one failed less than RETRY_MS ago (the loop leaves it alone).
  const busy = (id) => inflight.has(id) || (backoff.get(id) ?? 0) > now();
  return { recover, busy, idle: () => Promise.allSettled(inflight.values()) };
}

module.exports = { createRecovery, tree, strays, liveness, runMs, wallMs, Stale, SCHEMA_PROMPT };
