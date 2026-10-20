'use strict';
// lanes: M5.5 parallel lanes inside working (contract C19, D-0133..D-0139; build doc X1-X15). A parent in working whose
// plan leaves tasks free (blocked_by) runs one itself and hands another to a lane ticket (lane_of {id, task}): a normal
// working run of that one task (admitted, gated with fail-first) in its own clone at the parent's HEAD (H2.6: cloned
// from the tag repo, the parent's commits fetched from the parent's clone). Accepted, the lane waits `merge`; the
// parent, at a quiet point (no run, gate, job or merge; its cursor null or not started), cherry-picks it onto its branch
// and gates it again as preserve. Every lane end but a green merge or an abort (a setup cut short by a stop, Restart /
// Resume, Cancel or memory) puts the task on the parent's serial list
// (never a lane again): it runs on the parent, as before M5.5. D-0140: every other lane end is a journal line on the
// parent (lane_end.why, the lane's own field); a security end (planted config, Blocked integrity) also alerts the parent
// ("<parent> lane <id>: ...") and keeps the lane's worktree (lane_end.keep: tb gc removes it, boot does not).
// Parent fields (lib/gates/types.js): work.lanes {[task]: laneId} (an entry stays after a green merge until its lane
// closes), work.merging {task, pre, lane} (from a merge's start to its end), work.serial [task]. Waits: lane_setup and
// merge (a lane), lanes (a parent with nothing of its own to do).
// step() (lib/working.js next, at a parent's quiet point), first match: close lanes merged already (X13), merge a waiting
// lane (plan order, D-0133), take back a lane never started while the parent has nothing to do (D-0134), make one lane
// (fits: D-0134; no shared plan file: D-0136), else wait for the open lanes. A setup or a merge is a job of the parent's
// (lib/working.js jobs: a Restart / Resume, Cancel, critical memory or stop aborts it), never the tick's. watch(): lane
// ends and parent moves (store transition). boot(): what a killed tbd left. Async only; every git / cp child has a timeout
// and, inside a job, its signal.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');
const fsm = require('./fsm');
const spawn = require('./spawn');
const planning = require('./planning');
const W = require('./working');
const { Stale } = require('./recovery');
const { TbError } = require('./errors');
const { git, ident, copyPlain, isFile, within, fetchCommit, SHA_RE } = require('./util');

const TB_HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const ID_RE = /^t_[a-z0-9]{6}$/;
const MS = 120_000; // every git / cp child of a lane: worktree, clone, pick, reset, remove
const PICK_DELAY = Number(process.env.TB_LANE_PICK_DELAY_MS) || 0; // ponytail: test knob only (an abort during a pick), read once at load
const OPEN = ['working', 'clarify', 'blocked']; // a lane not ended yet
const cut = (s, n = 1000) => String(s ?? '').slice(0, n);
const tail = (r) => cut(String(r.stderr || r.err?.message || '').trim().split('\n').pop(), 200);
const log = (id, what) => (e) => { if (!(e instanceof Stale)) console.error(`tbd: ${id}: ${what}: ${e.message}`); };
const { ticketOf, serialOf, without } = W;
// D-0140: a task sent back to serial for a security reason (planted config, integrity) is never allowed back by Irfan's button
const secured = (w, task) => ({ serial_why: { ...w.serial_why, [task]: 'security' } });
// lanes are their own knob (off by default), and need room for a second run
const lanesOn = (config) => config.lanes?.enabled === true && config.max_concurrent >= 2;
const live = (k) => k.lease && (!k.lease.exit || k.lease.pending); // a run (or a recovery in flight) holds it
// the parent's open lanes: work.lanes entries whose task is not done (a merged one's entry stays until it closes)
const openOf = (w) => Object.entries(w.lanes ?? {}).filter(([task]) => w.tasks.find((x) => x.id === task)?.status !== 'done');
// the merge m is still the parent's (its CAS guard)
const same = (k, m) => k.work?.merging?.task === m.task && k.work.merging.pre === m.pre;
let stopRun = (/** @type {string} */ _id) => Promise.resolve(false); // runner.cancel (watch): a live lane run ends through recovery

/** At a parent's quiet point (lib/working.js next). → true when it acted (a job started, a lane ended, a wait set): the
 * tick does nothing else for t. */
async function step(t, api) {
  const w = t.work;
  if (!(lanesOn(store.config) || Object.keys(w.lanes ?? {}).length)) return false; // C#19: lanes off, nothing read
  const at = (task) => w.tasks.findIndex((x) => x.id === task);
  for (const [task, id] of Object.entries(w.lanes ?? {})) { // X13: merged, its lane not closed yet (a kill in between)
    if (w.tasks[at(task)]?.status === 'done' && ticketOf(id)?.state === 'working') await close(id);
  }
  const open = openOf(w).sort(([a], [b]) => at(a) - at(b)).map(([task, id]) => ({ task, k: ticketOf(id) }));
  const waiting = open.find(({ k }) => k?.state === 'working' && k.waiting?.reason === 'merge'); // D-0133: plan order
  if (waiting) {
    if (api.system?.()?.pressure === 'critical') { // K12: no pick + re-gate into a memory kill; merged once it eases
      await api.setWaiting?.('memory');
      return true;
    }
    void mergeJob(t, api, waiting.task, waiting.k.id); // never awaited: the job acts itself
    return true;
  }
  if (!W.current(w)) { // nothing of its own to do (X2b took any ready task)
    const idle = open.find(({ k }) => k?.state === 'working' && k.work && !k.lease); // D-0134: made, never started
    if (idle) await cancel(idle.k.id, api.cancel, { why: 'taken back: never started while the parent had nothing else to do' });
    else if (open.length) await api.setWaiting?.('lanes'); // X9
    return open.length > 0;
  }
  if (!api.fits?.()) return false; // first: no plan read per tick while no lane could start
  const task = await candidate(t);
  if (!task) return false;
  void setupJob(t, api, task);
  return true;
}

// Why no task of t may be a lane (plain words, null: they may): lanes off or < 2 tickets at once, not a code ticket on a
// git tag, a cursor knows no blocked_by (X1: none from before M5.5), and (slots) no room for one more (max_concurrent − 1 open).
function gate(t, slots = true) {
  const w = t.work;
  if (t.lane_of) return 'it is a parallel lane itself';
  if (!lanesOn(store.config)) return 'parallel lanes are off (Settings: Parallel Lanes, and tickets at once 2 or more)';
  if (t.kind !== 'code' || store.listTags()[t.tag]?.type !== 'git') return 'it is not a Code ticket on a git tag';
  if (!w.tasks.every((x) => Array.isArray(x.blocked_by))) return 'its plan is from before parallel runs';
  if (slots && openOf(w).length >= store.config.max_concurrent - 1) return 'every parallel slot is taken';
  return null;
}

// Why task x (pending) cannot be a lane though the ticket may have lanes: the parent's own task, synthetic, never back from
// a lane (serial), waits on a task, or shares a plan file with the parent's task or an open lane's (D-0136). null: it may.
function taskWhy(w, plan, x, open) {
  const files = (id) => plan?.tasks?.find((p) => p.id === id)?.files ?? [];
  const title = (id) => plan?.tasks?.find((p) => p.id === id)?.title || id;
  if (x.id === w.task) return 'it is the main run\'s task';
  if (x.id.startsWith('@')) return 'it is a built-in step';
  if (w.serial_why?.[x.id] === 'security') return 'it came back from a parallel run for a security reason (agent-planted config or an integrity failure)';
  if ((w.serial ?? []).includes(x.id)) return 'it came back from a parallel run';
  const dep = (x.blocked_by ?? []).find((b) => !w.tasks.some((y) => y.id === b && y.status === 'done'));
  if (dep) return `it waits for ${title(dep)}`;
  const mine = files(x.id);
  const other = [w.task, ...open].find((o) => o && files(o).some((f) => mine.includes(f)));
  return other ? `it shares a file with ${title(other)}` : null;
}

// The board's parallel view of a working ticket (GET …/tickets/:id): the top line + per pending/lane task
// {badge: running | can | one, why, next}. Same checks as candidate(): what the board says is what the next gap does.
function whyOf(t, plan) {
  const w = t.work;
  if (t.state !== 'working') return { top: 'off: the flow is not in its working step', tasks: {} };
  const open = openOf(w).map(([task]) => task);
  const g = gate(t);
  const top = gate(t, false);
  return {
    top: top ? `off: ${top}` : `on, up to ${store.config.max_concurrent - 1} extra at once`,
    tasks: Object.fromEntries(w.tasks.flatMap((x) => {
      if (open.includes(x.id)) return [[x.id, { badge: 'running' }]];
      if (x.status !== 'pending') return [];
      const why = g ?? taskWhy(w, plan, x, open);
      const serial = (w.serial ?? []).includes(x.id);
      return [[x.id, why ? { badge: 'one', why, ...(serial && { serial, security: w.serial_why?.[x.id] === 'security' }) } : { badge: 'can', next: w.lane_pick === x.id }]];
    })),
  };
}

// X15 + D-0136: the first ready task (plan order) that may be a lane (gate + taskWhy), Irfan's "Run in Parallel Next"
// pick first when it passes the same checks. ponytail: one lane per tick, so "the candidates picked this tick" is empty.
// → its id, or null.
async function candidate(t) {
  const w = t.work;
  if (gate(t)) return null;
  const open = openOf(w).map(([task]) => task);
  const plan = await planning.readPlan(t).catch(() => null);
  const can = (x) => W.ready(w, x) && !taskWhy(w, plan, x, open);
  const pick = w.tasks.find((x) => x.id === w.lane_pick);
  return (pick && can(pick) ? pick : w.tasks.find(can))?.id ?? null;
}

// Irfan's two buttons (board; cookie + CSRF): "Allow Back to Parallel" takes a task off work.serial, "Run in Parallel Next"
// sets work.lane_pick. One CAS each + an interventions row; 409 = refused. The lane itself still starts at a quiet point.
const refuse = (k, task, ok, what) => {
  if (k.state !== 'working' || !k.work) throw new TbError(409, `${k.id}: lanes work in a working ticket only (now ${k.state}${k.work ? '' : ', no work cursor yet'})`);
  if (!ok(k.work, k.work.tasks.find((x) => x.id === task))) throw new TbError(409, `${k.id}: ${task} ${what}`);
};
const allow = (id, task, actor) => store.intervention(id, { actor, verb: 'lane-allow', task, payload: { task } }, (k) => {
  refuse(k, task, (w) => (w.serial ?? []).includes(task), 'did not come back from a parallel run');
  refuse(k, task, (w) => w.serial_why?.[task] !== 'security', 'refused: this task came back for agent-planted config or an integrity failure');
  return { ...k, work: { ...k.work, serial: k.work.serial.filter((x) => x !== task) } };
});
const pick = (id, task, actor) => store.intervention(id, { actor, verb: 'lane-next', task, payload: { task } }, async (k) => {
  refuse(k, task, (w, x) => x && W.ready(w, x) && x.id !== w.task && !(w.serial ?? []).includes(task), 'cannot run in parallel now (not pending, waiting on a task, the main run\'s task, one at a time, or already a lane)');
  const plan = await planning.readPlan(k).catch(() => null); // the badge's own checks (whyOf): gate, built-in step, shared file
  const why = gate(k, false) ?? taskWhy(k.work, plan, k.work.tasks.find((x) => x.id === task), openOf(k.work).map(([o]) => o));
  if (why) throw new TbError(409, `${k.id}: ${task} cannot run in parallel: ${why}`);
  return { ...k, work: { ...k.work, lane_pick: task } };
});

// X7: lane `task` of parent t, in the parent's job (its signal checked between steps): the parent's lanes entry, the lane
// ticket, its worktree at the parent's HEAD (cur.pre), node_modules cloned (APFS, A7), the S1 config check against the
// parent's baseline (C#1: never a baseline of its own: it would whitelist config an earlier task committed), env files,
// the ticket-dir copies, then its one-task cursor. Any failure or abort: the entry gone (+ serial unless aborted), the
// lane cancelled (watch: a journal line on the parent, its worktree removed; planted config (D-0140): the parent alerted
// here, the worktree kept).
async function setupJob(t, api, task) {
  const j = W.job(t.id);
  if (!j) return; // a job of the parent's runs already
  const sig = j.ac.signal;
  const id = store.uid();
  const at = W.current(t.work).pre;
  let entry = false;
  const check = () => { if (sig.aborted) throw new Error(`aborted (${sig.reason})`); };
  try {
    await store.updateTicket(t.id, (k) => { // C#16
      const w = k.work;
      if (k.state !== 'working' || k.round !== t.round || live(k) || w.gate || w.merging || w.task === task || Object.hasOwn(w.lanes ?? {}, task)
        || (w.serial ?? []).includes(task) || w.tasks.find((x) => x.id === task)?.status !== 'pending' || openOf(w).length >= store.config.max_concurrent - 1) throw new Stale();
      const next = { ...w, lanes: { ...w.lanes, [task]: id } };
      if (w.lane_pick === task || w.tasks.find((x) => x.id === w.lane_pick)?.status !== 'pending') delete next.lane_pick; // spent, or its task moved on
      return { ...k, work: next };
    });
    entry = true;
    const p = store.getTicket(t.id);
    await store.createLane(p, task, id);
    const tag = store.listTags()[p.tag];
    check();
    // H2.6: the lane's own clone at the parent's base, cur.pre fetched from the parent's clone (objects only, fsck); a
    // parent from before H2 (no clone) shares the tag's objects: the clone is made at cur.pre straight from the tag repo
    const src = p.clone ? { id: p.id, worktree: p.worktree, git_dir: p.git_dir, common_dir: p.common_dir, clone: p.clone, base_sha: p.base_sha } : undefined;
    const wt = await planning.worktree(id, tag, at, sig, src);
    check();
    await planning.cloneModules(p.worktree, wt.worktree, sig);
    check();
    const base = p.config_baseline ?? {};
    const trip = await spawn.tripwire(wt.worktree);
    if (!base.tripwire || trip.lock !== base.tripwire.lock || trip.bin !== base.tripwire.bin) throw new Error('node_modules is not what the parent\'s setup left (tripwire)');
    const pin = { worktree: wt.worktree, git_dir: wt.git_dir, common_dir: wt.common_dir, clone: wt.clone }; // S1 H2.2: base_sha stays the parent's
    const planted = await spawn.plantedConfig({ ...store.getTicket(id), ...pin, config_baseline: base }, wt.worktree, store.ticketDir(id));
    if (planted.length) throw Object.assign(new Error(`agent-planted config: ${planted.slice(0, 10).join(', ')}`), { code: 'PLANTED' });
    check();
    await planning.copyEnv(tag, wt.worktree);
    const from = store.ticketDir(p.id);
    for (const f of [p.plan_file, ...(p.rules_sha ? ['rules.md'] : []), 'decisions.json']) {
      if (f !== 'decisions.json' || (await isFile(path.join(from, f)))) await copyPlain(path.join(from, f), path.join(store.ticketDir(id), f), 0o600);
    }
    const sc = await W.readScope(p.id);
    await W.writeScope(id, { allow: { [task]: sc.allow[task] ?? [] }, denied: { [task]: sc.denied[task] ?? [] } });
    const plan = await planning.readPlan(p);
    await planning.copySkills(id, plan?.skills ?? [], t.sandbox);
    check();
    await store.updateTicket(id, (k) => {
      if (k.state !== 'working' || k.work) throw new Stale();
      return { ...k, ...pin, config_baseline: { ...base, tripwire: trip }, work: W.seedWork({ tasks: plan.tasks.filter((x) => x.id === task) }, k, { pre: at }), waiting: null };
    });
  } catch (e) {
    if (!entry) return void log(t.id, `lane ${task} not made`)(e);
    const why = sig.aborted ? `aborted (${sig.reason})` : cut(e.message);
    const planted = !sig.aborted && e.code === 'PLANTED'; // D-0140: a security end
    if (planted) api.alert?.({ title: 'Lane refused: agent-planted config', message: `${t.id} lane ${id}: ${cut(why, 300)}` });
    await store.updateTicket(t.id, (k) => {
      if (k.work?.lanes?.[task] !== id) throw new Stale();
      return { ...k, work: { ...k.work, lanes: without(k.work.lanes, task), ...(!sig.aborted && { serial: serialOf(k.work, task), ...(planted && secured(k.work, task)) }) } };
    }).catch(log(t.id, `lane ${task} not dropped`));
    // the lane ticket's end journals it (watch); none made (createLane failed) → journaled here
    if (ticketOf(id)) await cancel(id, api.cancel, { why, keep: planted, abort: sig.aborted });
    else await W.journal(t.id, { t: 'lane', task, lane: id, ok: false, why }).catch(log(t.id, 'journal'));
  } finally {
    j.end();
  }
}

// X3 X4: the waiting lane `lane` merged into parent t, in the parent's job: merging {task, pre: HEAD (tbd's own head:
// W.trusted, else Blocked integrity), lane} → its commits picked onto the parent (committer = the tag's ident, C12;
// authors kept) → the re-gate (lib/working.js gateJob in this same job, then apply → regated). A lane that changed nothing (head = pre) is merged with no pick and no gate (C#10).
// ident error, conflict, empty pick, any git error → fail. [N#1] an abort is looked at first after any step: memory
// undoes the merge now (the lane waits on), cancel (halt) and shutdown (boot) leave that to them; never a fail.
async function mergeJob(t, api, task, lane) {
  const j = W.job(t.id);
  if (!j) return; // a job of the parent's runs already
  const sig = j.ac.signal;
  let m = null;
  try {
    const pre = await W.trusted(t, api, sig); // sec A08: tbd's own head, never one a lane's agent moved the branch to
    if (!pre) return;
    await store.updateTicket(t.id, (k) => {
      if (k.state !== 'working' || k.round !== t.round || live(k) || k.work.gate || k.work.merging || k.work.lanes?.[task] !== lane || W.tipOf(k.work) !== pre) throw new Stale();
      return { ...k, waiting: null, work: { ...k.work, merging: { task, pre, lane } } };
    });
    m = { task, pre, lane };
    const lt = ticketOf(lane)?.work?.tasks?.[0];
    if (!SHA_RE.test(lt?.pre ?? '') || !SHA_RE.test(lt?.head ?? '')) throw new Error(`lane ${lane} has no accepted head`);
    if (sig.aborted) return await aborted(t, sig);
    if (lt.head === lt.pre) return await green(t, m, pre, (fn) => store.updateTicket(t.id, fn));
    // H2.6: the lane's commits into the parent's clone first (objects only, index-pack + fsck; the lane's agent never
    // writes the parent's repo): a refused fetch → fail. Parent or lane from before H2: shared objects, nothing to fetch
    const lk = ticketOf(lane);
    if (t.clone && lk?.clone) await fetchCommit({ cwd: t.worktree, dirs: t, from: lk, sha: lt.head, alt: `refs/tb/${t.id}/`, signal: sig });
    if (sig.aborted) return await aborted(t, sig);
    const who = await ident(t, lt.head, undefined, sig);
    if (who.error) throw new Error(`ident: ${who.error}`);
    const r = await git(t.worktree, ['cherry-pick', `${lt.pre}..${lt.head}`], { timeout: MS, dirs: t, signal: sig, add: { GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } });
    if (PICK_DELAY) await new Promise((res) => { const tm = setTimeout(res, PICK_DELAY); sig.addEventListener('abort', () => { clearTimeout(tm); res(undefined); }, { once: true }); });
    if (sig.aborted) return await aborted(t, sig);
    if (r.err) throw new Error(`cherry-pick ${lt.pre.slice(0, 12)}..${lt.head.slice(0, 12)}: ${tail(r)}`);
    const k2 = await store.updateTicket(t.id, (k) => {
      if (!same(k, m) || k.state !== 'working' || k.round !== t.round || k.work.gate) throw new Stale();
      return { ...k, work: { ...k.work, gate: { gen: k.lease?.gen ?? 0, kind: 'task' } } };
    });
    await W.gateJob(structuredClone(k2), api, false, j);
  } catch (e) {
    if (!m) return void log(t.id, `lane ${task} not merged`)(e);
    if (sig.aborted) return void (await aborted(t, sig).catch(log(t.id, 'lane merge not undone')));
    if (e instanceof Stale) return;
    // S-L6 D-0140: the lane's commits refused (a planted pin, objects index-pack / fsck threw out) is a security end:
    // the parent alerted, the lane's worktree kept for tb gc
    const sec = e.code === 'PLANTED' || /index-pack|fsck/.test(e.message);
    if (sec) api.alert?.({ title: 'Lane merge refused: integrity', message: `${t.id} lane ${lane}: ${cut(e.message, 300)}` });
    await fail(store.getTicket(t.id), m, cut(e.message), sig, sec).catch(log(t.id, 'lane merge not failed'));
  } finally {
    j.end();
  }
}

// [N#1] a merge job aborted: critical memory undoes the merge now (the lane waits on, merged again later); a cancel
// (Restart / Resume: halt undoes it) or shutdown (boot does) leaves it.
async function aborted(t, sig) {
  const k = store.getTicket(t.id);
  if (sig.reason === 'memory' && k.work?.merging) await redo(structuredClone(k));
}

// A merge green at head: ONE CAS (cas: the caller's guarded write) with its journal line: the task done, merging null,
// the open task from head (lib/working.js merged); then the lane done.
async function green(t, m, head, cas) {
  await cas(async (k) => {
    if (!same(k, m)) throw new Stale();
    await W.journal(t.id, { t: 'merge', task: m.task, lane: m.lane, ok: true, head });
    return { ...k, work: W.merged(k.work, m, true, head, k.lease?.gen ?? 0) };
  });
  await close(m.lane);
}

/** lib/working.js apply, for a merge's re-gate (before decide): green → merged at HEAD; interrupted → undone now unless a
 * shutdown (boot) or cancel (halt) aborted it; a HARD class → hold; any other red → fail. */
async function regated(t, cas, res, j) {
  const m = t.work.merging;
  const sig = j.ac.signal;
  if (res.ok) await green(t, m, res.head || (await W.head(t, { signal: sig })), cas);
  else if (sig.aborted || res.class === 'interrupted') {
    if (!sig.aborted || sig.reason === 'memory') await redo(structuredClone(store.getTicket(t.id)));
  } else if (W.HARD.includes(res.class)) await hold(structuredClone(store.getTicket(t.id)), m, res, sig);
  else await fail(store.getTicket(t.id), m, `re-gate red (${res.class ?? 'work'}): ${cut(res.why, 500)}`, sig);
  return res.ok ? undefined : { stop: true };
}

// A re-gate red of a HARD class (the host's or the repo's, not the lane's work: a good lane is never thrown away): the
// lane's head kept (keepHead), the merge undone with the lane still waiting merge (redo), the parent Blocked with the
// class in redo's one CAS, as lib/working.js apply blocks any gate (notify.js pings it); a Resume merges it again. A
// reset that fails: redo's rule (merging kept, undone next tick). An abort first: the abort's rule.
async function hold(t, m, res, sig) {
  const why = `re-gate red (${res.class}): ${cut(res.why, 500)}${await keepHead(t, m, sig)}`;
  if (sig.aborted) return aborted(t, sig);
  return redo(t, async (k) => {
    await W.journal(t.id, { t: 'merge', task: m.task, lane: m.lane, ok: false, why });
    return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: res.wait ?? res.class, why: cut(why, 500), since: new Date().toISOString() } };
  });
}

// The lane's head kept as refs/tb/<id>/lane-<task> in t's clone ('': create only: a lane of this task merged and failed
// before, a replan ago, keeps its ref). → '' or, not made, a note naming the head for the journal line (still in the
// repo's objects until git gc).
async function keepHead(t, m, sig) {
  const head = ticketOf(m.lane)?.work?.tasks?.[0]?.head;
  const ref = `refs/tb/${t.id}/lane-${m.task}`;
  const u = SHA_RE.test(head ?? '') ? await git(t.worktree, ['update-ref', ref, head, ''], { timeout: MS, dirs: t, signal: sig }) : null;
  const had = u?.err && !sig.aborted && (await git(t.worktree, ['rev-parse', '--verify', '--quiet', ref], { timeout: MS, dirs: t, signal: sig })).stdout.trim() === head; // a retry's
  return !u?.err || had ? '' : `; ${ref} not made (${tail(u)}): the lane's head was ${head}`;
}

// X4: a merge that failed: the pick undone (unpick; a reset that fails keeps merging: undone next tick, X5), the lane's
// head kept (keepHead), then ONE CAS: merging null, the task back to serial (its entry gone), the next ready task at
// merging.pre when none is open, a journal line; then the lane cancelled. An abort before the CAS: the abort's rule
// instead.
async function fail(t, m, why, sig, keep = false) {
  const bad = await unpick(t, m.pre, sig);
  if (sig.aborted) return aborted(t, sig);
  if (bad) return void console.error(`tbd: ${t.id}: lane merge not undone: ${bad}`);
  const kept = await keepHead(t, m, sig);
  if (sig.aborted) return aborted(t, sig);
  await store.updateTicket(t.id, async (k) => {
    if (!same(k, m)) throw new Stale();
    await W.journal(t.id, { t: 'merge', task: m.task, lane: m.lane, ok: false, why: `${why}${kept}` });
    const w = W.merged(k.work, m, false, m.pre, k.lease?.gen ?? 0);
    return { ...k, work: keep ? { ...w, ...secured(w, m.task) } : w };
  }).catch(log(t.id, 'lane merge not ended'));
  await cancel(m.lane, stopRun, { why: cut(`merge failed: ${why}`, 500), keep });
}

// X4 X5: a pick undone in t's worktree: `cherry-pick --abort` when one is in progress (CHERRY_PICK_HEAD or sequencer/ in
// git_dir; failing is not fatal: the reset is the check), `reset -q --hard pre`, `cherry-pick --quit` (clears a sequencer
// a kill left). → '' or why the reset failed.
async function unpick(t, pre, signal = undefined) {
  const o = { timeout: MS, dirs: t, signal };
  const gd = t.git_dir ?? (await git(t.worktree, ['rev-parse', '--absolute-git-dir'], o)).stdout.trim();
  if (gd && (await Promise.all(['CHERRY_PICK_HEAD', 'sequencer'].map((f) => fsp.lstat(path.join(gd, f)).then(() => true, () => false)))).some(Boolean)) {
    await git(t.worktree, ['cherry-pick', '--abort'], o);
  }
  const r = await git(t.worktree, ['reset', '-q', '--hard', pre], o);
  if (r.err) return `git reset --hard ${pre.slice(0, 12)}: ${tail(r)}`;
  await git(t.worktree, ['cherry-pick', '--quit'], o);
  return '';
}

const resets = new Map(); // parent id → resets failed in a row (X5: the 3rd → Blocked), in memory only
/** X5: a merge with no job (a kill, an abort) undone: the re-gate's orphan / swap restored first (a throw: nothing else
 * done), the pick undone, then ONE CAS: merging + the re-gate gone (the lane still waits merge: merged again at a quiet
 * point), then end's own patch (hold: the parent Blocked). A reset that fails → false, tried again next tick (fail
 * closed); the 3rd in a row → Blocked infra. → undone? */
async function redo(t, end = (/** @type {any} */ k) => k) {
  const m = t.work?.merging;
  if (!m) return true;
  if (t.work.gate?.proc || t.work.gate?.swap) await W.restore(t, (k) => same(k, m));
  const why = await unpick(t, m.pre);
  if (why) {
    const n = (resets.get(t.id) ?? 0) + 1;
    resets.set(t.id, n);
    if (n >= 3) {
      resets.delete(t.id);
      await store.updateTicket(t.id, (k) => {
        if (!same(k, m) || k.state !== 'working') throw new Stale();
        return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: 'infra', why: cut(`lane merge not undone: ${why}`, 500), since: new Date().toISOString() } };
      }).catch(log(t.id, 'not blocked'));
    }
    return false;
  }
  resets.delete(t.id);
  await store.updateTicket(t.id, (k) => {
    if (!same(k, m)) throw new Stale();
    return end({ ...k, work: { ...k.work, merging: null, gate: null } });
  }).catch(log(t.id, 'lane merge not cleared'));
  return true;
}

// X11 X13: a lane its parent merged → done (runner row; lane_merged reads the parent)
const close = (id) => store.updateTicket(id, (k) => {
  if (k.state !== 'working') throw new Stale();
  return fsm.move(k, 'done', 'runner', { ticketOf });
}).catch(log(id, 'lane not closed'));

/** X11: lane id ends (runner row). A live run (or a recovery in flight) through run (runner.cancel: the one recovery path
 * kills it first); else one CAS (state + lease gen unchanged; changed meanwhile → looked at again). Not a lane or ended
 * → nothing. */
async function cancel(id, run = stopRun, end = { why: 'cancelled' }) {
  const k = ticketOf(id);
  if (!k?.lane_of || !OPEN.includes(k.state)) return undefined;
  if (live(k)) { // the end noted first (the first one stays), then the run killed through recovery
    await store.updateTicket(id, (x) => (x.lane_end ? x : { ...x, lane_end: end })).catch(log(id, 'lane end not noted'));
    return void (await run(id).catch(log(id, 'lane not cancelled')));
  }
  return store.updateTicket(id, (x) => {
    if (x.state !== k.state || (x.lease?.gen ?? 0) !== (k.lease?.gen ?? 0)) throw new Stale();
    return fsm.move({ ...x, lane_end: x.lane_end ?? end }, 'cancelled', 'runner');
  }).catch((e) => (e instanceof Stale ? cancel(id, run, end) : log(id, 'lane not cancelled')(e)));
}

// X12b (D-0138): lane k's worktree, ALWAYS TB_HOME/worktrees/<id> (one recorded on the lane must be that path: never
// another registered worktree; else refused + a journal line): the tag's env files (secrets) deleted from it first, then
// the dir removed (H2.3: a clone is a plain dir, no git; failing → a journal line on the parent).
async function remove(k) {
  const p = path.join(TB_HOME, 'worktrees', k.id);
  const note = (why) => W.journal(k.lane_of.id, { t: 'lane', task: k.lane_of.task, lane: k.id, ok: false, why }).catch(log(k.id, 'journal'));
  if (!ID_RE.test(k.id) || (k.worktree && k.worktree !== p)) return note(`worktree ${cut(k.worktree, 300)} not removed: not ${p}`);
  const tag = store.listTags()[k.tag];
  if (!tag?.path || !(await fsp.lstat(p).then(() => true, () => false))) return undefined;
  await dropEnv(tag, p).catch(log(k.id, 'env files not deleted'));
  await fsp.rm(p, { recursive: true, force: true }).catch((e) => note(`worktree ${p} not removed: ${cut(e.message, 200)}`));
  return undefined;
}
// The tag's env files in worktree p deleted: each inside p (its folder resolves inside p: never through a link on the
// way); a link by that name is deleted itself, never followed (rm).
async function dropEnv(tag, p) {
  const real = await fsp.realpath(p);
  for (const f of tag.env_files ?? []) {
    const rel = path.relative(tag.path, path.resolve(tag.path, f));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    const dest = path.join(p, rel);
    if (within(await fsp.realpath(path.dirname(dest)).catch(() => ''), real)) await fsp.rm(dest, { force: true });
  }
}

// X12 store transition: (a) a lane asks (clarify) or blocks → cancelled at once (lanes never ask Irfan); (b) a lane done or
// cancelled → its parent first (entry gone if it names this lane, + serial unless done or an abort; X9 [N#8] nothing left
// → the working gate), a cancelled one's end journaled there (D-0140), then its job (+ in setup, no cursor yet: the
// parent's, which sets it up) awaited, then its worktree removed unless kept (a security end); (c) a parent replanned or
// cancelled → its open lanes cancelled (D-0135: clarify / blocked keep them).
async function moved(k) {
  if (k.lane_of) {
    if (k.state === 'clarify') return cancel(k.id, stopRun, { why: cut(`asked: ${k.clarify_origin?.why ?? ''}`, 500) });
    if (k.state === 'blocked') return cancel(k.id, stopRun, { why: cut(`blocked ${k.waiting?.reason ?? ''}: ${k.waiting?.why ?? k.lease?.error ?? ''}`, 500) });
    if (k.state !== 'done' && k.state !== 'cancelled') return undefined;
    const { id, task } = k.lane_of;
    const end = k.state === 'cancelled' ? k.lane_end ?? { why: 'cancelled' } : null;
    await store.updateTicket(id, (p) => {
      if (p.work?.lanes?.[task] !== k.id) throw new Stale();
      const w = { ...p.work, lanes: without(p.work.lanes, task), ...(end && !end.abort && { serial: serialOf(p.work, task), ...(end.keep && secured(p.work, task)) }) };
      if (p.state === 'working' && !W.current(w) && !w.gate && !w.merging && !W.jobBusy(id) && w.tasks.every((x) => x.status === 'done')) w.gate = { gen: p.lease?.gen ?? 0, kind: 'working' };
      return { ...p, work: w };
    }).catch(log(id, `lane ${k.id} not dropped`));
    if (end) await W.journal(id, { t: 'lane', task, lane: k.id, ok: false, why: end.why }).catch(log(id, 'journal'));
    if (end?.keep) return undefined;
    await W.jobDone(k.id);
    if (!k.work) await W.jobDone(id);
    return remove(k);
  }
  if ((k.state === 'planning' || k.state === 'cancelled') && k.work?.lanes) for (const id of Object.values(k.work.lanes)) await cancel(id, stopRun, { why: `parent ${k.state}` });
  return undefined;
}

let watching = false;
/** tbd.js, once, after the runner is made and before boot() (N#7: boot's cancels reach it). cancel: runner.cancel. */
function watch({ cancel: run }) {
  stopRun = run;
  if (watching) return;
  watching = true;
  store.on('transition', (k) => void moved(k).catch(log(k.id, 'lanes')));
}

/** tbd.js, after working.boot and watch(), before runner.start: a lane ended with its worktree left → removed (not a
 * security end's: kept for tb gc); a lane in setup (no cursor: an abort), one its parent's lanes do not name, or whose
 * parent left working | clarify | blocked → cancelled; a parent's entry naming a missing or ended lane → dropped (+ serial
 * unless its task is done or the lane's end was an abort; a lane never made is one). */
async function boot() {
  for (const k of store.listTickets()) {
    if (k.lane_of) {
      const p = ticketOf(k.lane_of.id);
      const named = p?.work?.lanes?.[k.lane_of.task] === k.id;
      if (!OPEN.includes(k.state)) { if (!k.lane_end?.keep) await remove(k); } // D-0140: a security end's stays for tb gc
      // a crash after the merge-green CAS, before close: its task is done in the parent → done, never cancelled
      else if (k.state === 'working' && named && p.work.tasks?.find((x) => x.id === k.lane_of.task)?.status === 'done') await close(k.id);
      // a lane killed in setup (no cursor): an abort, never serial (N#1)
      else if (k.state === 'working' && !k.work) await cancel(k.id, stopRun, { why: 'setup cut short (tbd stopped)', abort: true });
      // a crash between a lane's ask / block and the watcher's cancel (a): cancelled here
      else if (k.state !== 'working' || !named || !OPEN.includes(p.state)) await cancel(k.id, stopRun, { why: `boot: ${!named ? 'its parent does not name it' : !OPEN.includes(p.state) ? `parent ${p.state}` : `lane ${k.state}`}` });
      continue;
    }
    const gone = Object.entries(k.work?.lanes ?? {}).filter(([, id]) => !OPEN.includes(ticketOf(id)?.state));
    if (!gone.length) continue;
    await store.updateTicket(k.id, (p) => {
      let w = p.work;
      for (const [task, id] of gone) {
        if (w.lanes?.[task] !== id) continue;
        // serial unless done or an abort; a lane never made (a kill before createLane) is a setup cut short: an abort
        const l = ticketOf(id);
        w = { ...w, lanes: without(w.lanes, task), ...(l && !l.lane_end?.abort && w.tasks.find((x) => x.id === task)?.status !== 'done' && { serial: serialOf(w, task), ...(l.lane_end?.keep && secured(w, task)) }) };
      }
      return { ...p, work: w };
    }).catch(log(k.id, 'lanes not dropped'));
  }
}

module.exports = { step, regated, redo, watch, boot, whyOf, allow, pick };
