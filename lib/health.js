'use strict';
// health (M7, contract §5, spec §12 targets; m7-build.md "§12 targets"): GET /api/health and GET /api/drills. Loaded on
// the first Health open (http.js: lazy), never at boot. No cache, no timer: each call streams the last TAIL_BYTES of
// metrics.1.jsonl + metrics.jsonl (lib/metrics.js rotates) and keeps aggregates only; one compute in flight at a time.
// Not a list route: a day window (1-365) + the byte cap (cut: true when older lines were left out).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const metrics = require('./metrics');
const golden = require('./evalscore');
const { AGENT } = require('./fsm');
const { eachLine, readPlain, maskCreds, isObj } = require('./util');

const TAIL_BYTES = 8 << 20;
const DAY = 86_400_000;
const DOCTOR = path.join(path.dirname(metrics.FILE), 'doctor.json');
const DOCTOR_MAX = 256 * 1024;
const RSS_MAX_MB = 80;
const INTERRUPTS = ['crash', 'interrupted', 'stalled', 'paused', 'usage', 'wall_cap'];
const EPISODES = ['resumed', 'stalled', 'died', 'you']; // `other` (a wake, the net, memory, usage, wall cap) is no alert
const FALSE_STALL_S = 360;
const FIX_DAYS = 14;
const PRE = ['"t":"run"', '"t":"control"', '"t":"gate"', '"t":"quiet"', '"t":"ticket"'];

// The last TAIL_BYTES of metrics.1.jsonl then metrics.jsonl, each line to fn. Both fds opened first, metrics.jsonl
// first: an fd outlives the rename a concurrent append's rotation makes; one made between the two opens leaves both fds
// on the same file (dev + ino), and the .1 one is dropped, so every line is read once. → {bytes_read, cut}
const open = (f) => fsp.open(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => null);
async function tail(fn, pre) {
  const fhs = [null, await open(metrics.FILE)];
  fhs[0] = await open(metrics.FILE1);
  try {
    const st = await Promise.all(fhs.map((fh) => fh?.stat()));
    if (st[0] && st[1] && st[0].dev === st[1].dev && st[0].ino === st[1].ino) {
      await fhs[0].close();
      fhs[0] = st[0] = null;
    }
    const sizes = st.map((x) => (x?.isFile() ? x.size : 0));
    const from = [0, 0];
    let left = TAIL_BYTES;
    for (const i of [1, 0]) { // the newest bytes first
      from[i] = Math.max(0, sizes[i] - left);
      left -= sizes[i] - from[i];
    }
    for (const i of [0, 1]) if (fhs[i] && sizes[i] > from[i]) await eachLine(fhs[i], fn, pre, { from: from[i] });
    return { bytes_read: TAIL_BYTES - left, cut: from[0] > 0 || from[1] > 0 };
  } finally {
    await Promise.all(fhs.map((fh) => fh?.close()));
  }
}

// doctor's last record (TB_HOME/doctor.json, lib/doctor.js save): name, ok, detail ≤ 200, fix; detail + fix may name a
// URL with credentials (a git remote): masked. Unreadable → null.
async function doctor() {
  let d = null;
  try { d = JSON.parse((await readPlain(DOCTOR, DOCTOR_MAX)) ?? 'null'); } catch { /* garbled: none */ }
  if (!isObj(d) || !Array.isArray(d.checks)) return null;
  const text = (v) => (v == null ? null : maskCreds(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200));
  return {
    at: typeof d.at === 'string' ? d.at.slice(0, 40) : null, ok: d.ok === true,
    checks: d.checks.filter(isObj).map((c) => ({ name: String(c.name ?? '').slice(0, 80), ok: c.ok === true, detail: text(c.detail), ...(c.fix != null && { fix: text(c.fix) }) })),
  };
}

// A ratio target: ok by op + threshold (integer percent math: no float edge), null with no data (y 0).
function ratio(key, label, x, y, op, threshold, extra = {}) {
  const pct = Math.round(threshold * 100);
  return { key, label, x, y, op, threshold, ok: y ? (op === '>=' ? x * 100 >= pct * y : x * 100 <= pct * y) : null, ...extra };
}

async function run(days) {
  const t0 = Date.now();
  const since = t0 - days * DAY;
  // RAM (HL4): only the interruptions are kept, never a line per run. ponytail: a run or control after an interruption
  // is assumed to come after its line (lines go in as things end: the next run's line at its end, a control at once);
  // one written in the same ms before it is missed.
  const ints = new Map(); // ticket → its interruptions [{started, ended, next: first later run start, ctl: first control at / after its end}]
  const gates = new Map(); // ticket+gate+task+attempt+head → {failed, infra}
  const tickets = new Map(); // ticket → its last t:ticket line
  let nRuns = 0, controls = 0, qx = 0, qy = 0;
  const io = await tail((l) => {
    if (!isObj(l) || !(Date.parse(l.t === 'run' ? l.ended : l.at) >= since)) return; // no time: not in the window
    if (l.t === 'run') {
      nRuns++;
      // the next run: started after the interrupted one started (its ended is the meter's, set after an async log read)
      const s0 = Date.parse(l.started);
      for (const i of ints.get(l.ticket) ?? []) if (s0 > i.started && s0 < i.next) i.next = s0;
      if (INTERRUPTS.includes(l.exit)) (ints.get(l.ticket) ?? ints.set(l.ticket, []).get(l.ticket)).push({ started: s0, ended: Date.parse(l.ended), next: Infinity, ctl: Infinity });
    } else if (l.t === 'control') {
      if (l.op === 'resume' || l.op === 'restart') controls++;
      const c = Date.parse(l.at);
      for (const i of ints.get(l.ticket) ?? []) if (c >= i.ended && c < i.ctl) i.ctl = c;
    } else if (l.t === 'gate') {
      const k = JSON.stringify([l.ticket, l.gate, l.task, l.attempt, l.head]);
      const g = gates.get(k) ?? { failed: false, infra: false };
      if (l.ok === false) Object.assign(g, { failed: true, infra: g.infra || l.class === 'infra' });
      gates.set(k, g);
    } else if (l.t === 'quiet' && EPISODES.includes(l.end)) {
      qy++;
      if (l.end === 'resumed' && l.quiet_s <= FALSE_STALL_S) qx++;
    } else if (l.t === 'ticket') tickets.set(l.ticket, l);
  }, PRE);

  // An interruption is recovered when the ticket's next run started before any Resume / Restart / Cancel of it; pending
  // (out of y) while it has neither and the ticket still sits in an agent phase.
  let rx = 0, ry = 0, pending = 0;
  const agent = (id) => { try { return AGENT.includes(store.getTicket(id).state); } catch { return false; } };
  for (const [id, list] of ints) {
    for (const i of list) {
      if (i.next < i.ctl) rx++;
      else if (i.next === Infinity && i.ctl === Infinity && agent(id)) { pending++; continue; }
      ry++;
    }
  }
  const T = [...tickets.values()].filter((l) => l.kind === 'code' && l.outcome === 'done' && !l.lane_of);
  const hands = T.filter((l) => Number.isInteger(l.hands_on));
  const fixes = new Map(); // a fix_of target → every fix's created time (a bad one skipped)
  for (const k of store.listTickets()) {
    const c = Date.parse(k.created_at);
    if (k.fix_of && Number.isFinite(c)) (fixes.get(k.fix_of) ?? fixes.set(k.fix_of, []).get(k.fix_of)).push(c);
  }
  // a fix created in [done at, at + 14 days]; one made before the original was done is no fix of its result
  const fixed = (l) => (fixes.get(l.ticket) ?? []).some((c) => c >= Date.parse(l.at) && c - Date.parse(l.at) <= FIX_DAYS * DAY);
  const sum = (f) => T.reduce((s, l) => s + f(isObj(l.decisions) ? l.decisions : {}), 0);
  const failed = [...gates.values()].filter((g) => g.failed);

  const lines = [];
  await eachLine(metrics.GOLDEN, (v) => { if (v?.t === 'golden') lines.push(v); }, ['"t":"golden"']);
  const cur = lines.at(-1);
  const base = cur ? golden.baseOf(lines.slice(0, -1), cur.cases.map((c) => c.id)) : {};
  const v = cur ? golden.goldenVerdict(base, cur) : { ok: null, x: 0, y: 0, worse: [], changed: [] };
  const note = [v.worse.length && `worse: ${v.worse.map((w) => `${w.id} (${w.why})`).join(', ')}`, v.changed.length && `changed (total moved, not compared): ${v.changed.join(', ')}`].filter(Boolean).join(' · ');
  const rss = Math.round(process.memoryUsage.rss() / 2 ** 20 * 10) / 10;

  return {
    window_days: days, from: new Date(since).toISOString(), to: new Date(t0).toISOString(), ...io, ms: Date.now() - t0,
    targets: [
      ratio('recovered', 'Interruptions recovered without you', rx, ry, '>=', 0.95, { pending }),
      ratio('resume_restart', 'Runs you had to Resume or Restart', controls, nRuns, '<=', 0.05),
      ratio('infra', 'Gate failures classified infra', failed.filter((g) => g.infra).length, failed.length, '<=', 0.05),
      ratio('false_stall', 'False stall alerts (the run produced events within 6 min)', qx, qy, '<=', 0.2),
      ratio('rework', 'Code tickets done with ≤ 1 rework', T.filter((l) => (l.rework ?? 0) <= 1).length, T.length, '>=', 0.7),
      ratio('hands_off', 'Hands-off after approve', hands.filter((l) => l.hands_on === 0).length, hands.length, '>=', 0.6, T.length > hands.length ? { no_data: T.length - hands.length } : {}),
      ratio('fix_of', 'fix_of tickets within 14 days of done', T.filter(fixed).length, T.length, '<=', 0.1),
      { key: 'golden', label: 'Golden-ticket score: no regression vs last run', x: v.x, y: v.y, op: 'all', threshold: null, ok: v.ok, base_at: golden.baseAt(base), ...(note && { note }) },
      { key: 'rss', label: 'tbd RSS', x: rss, y: RSS_MAX_MB, op: '<=', threshold: RSS_MAX_MB, unit: 'MB', ok: rss <= RSS_MAX_MB },
      { key: 'planner_call', label: 'Decisions marked "planner\'s call"', x: sum((d) => d.planner ?? 0), y: sum((d) => Object.values(d).reduce((s, n) => s + (Number.isInteger(n) ? n : 0), 0)), op: 'watch', threshold: null, ok: null },
    ],
    doctor: await doctor(),
  };
}

// One tail read in flight (RAM: never two 8 MB reads at once), a compute or a drill page: a call with the same key
// shares it; any other waits for it to settle, then runs. Nothing is kept once it settled.
let busy = null;
async function one(key, fn) {
  while (busy) {
    if (busy.key === key) return busy.p;
    await busy.p.catch(() => {});
  }
  const p = fn().finally(() => { if (busy?.p === p) busy = null; });
  busy = { key, p };
  return p;
}
const compute = (days) => one(`health ${days}`, () => run(days));

// The drill log, newest first: the limit newest t:drill lines older than before (ISO, keyset), from the same tail.
// next: the at to pass as before for the next older page, null at the end. ponytail: drills sharing one ms with the
// page edge are skipped by the keyset (one drill a run, minutes apart); a (at, n) cursor if they ever collide.
const drills = (limit, before = null) => one(`drills ${limit} ${before}`, () => drillPage(limit, before));
async function drillPage(limit, before) {
  const b = before === null ? Infinity : Date.parse(before);
  const ring = [];
  await tail((l) => {
    if (l?.t !== 'drill' || !(Date.parse(l.at) < b)) return;
    ring.push({ at: l.at, name: l.name, ok: l.ok, note: l.note ?? null });
    if (ring.length > limit + 1) ring.shift();
  }, ['"t":"drill"']);
  const items = ring.reverse();
  return { items: items.slice(0, limit), next: items.length > limit ? items[limit - 1].at : null };
}

module.exports = { compute, drills };
