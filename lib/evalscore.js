'use strict';
// golden (M7, spec §12 "golden-ticket score: no regression vs last run"): golden score JSON v1 (scripts/harness.js
// scoreJson, frozen in r-build.md) checked strictly, the t:golden line made from it, the base per case id and the
// verdict. Pure: no store, no fs, so tb (eval golden) loads it as well as tbd (POST /api/evals, lib/health.js).
// t:golden {t, at (the score's), run_id, commit, mode: real, cases: [{id, pass, total, contaminated, blind: score | null,
// rerun?}], pass, ok: the verdict's | null}; one line per recorded eval run in TB_HOME/evals/golden.jsonl (+ metrics.jsonl).
const SHA = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CASE_ID = /^(golden|planner|review|qa|final_gate):[A-Za-z0-9-]{1,16}$/;
const STOP = /^[a-z_]{1,32}(:[a-z_]{1,32})?$/; // <state> or <state>:<waiting reason>
const SOURCE = /^[a-z][a-z0-9-]{0,39}$/;
const TOP = ['v', 'kind', 'at', 'commit', 'sandbox_base', 'mode', 'sources', 'cases', 'pass'];
const CASE = ['id', 'run', 'stop', 'checks', 'contaminated', 'fix_rounds', 'rework', 'cost_micro', 'min', 'blind'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
const int = (v, lo, hi = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= lo && v <= hi;
const intOrNull = (v, lo) => v === null || int(v, lo);
// exactly these keys (opt: may be there too)
const keys = (o, want, opt = []) => isObj(o) && want.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => want.includes(k) || opt.includes(k));

// blind: null, or {scores: 2 or 3 integers 1-5, score: the lower of 2 / the median of 3, pass: score ≥ 4} (harness rule;
// 2 scores 2 or more apart need a 3rd reviewer: refused)
function blindOk(b) {
  if (b === null) return true;
  if (!keys(b, ['scores', 'score', 'pass']) || !Array.isArray(b.scores) || ![2, 3].includes(b.scores.length) || !b.scores.every((x) => int(x, 1, 5))) return false;
  const s = [...b.scores].sort((x, y) => x - y);
  if (s.length === 2 && s[1] - s[0] >= 2) return false;
  const score = s.length === 2 ? s[0] : s[1];
  return b.score === score && b.pass === score >= 4;
}

// → why o is no golden score JSON v1 (the first problem found; case ids are never echoed), or null. Strict: exact keys
// (a case may add rerun: true, tb eval golden's rerun), 40-hex shas, ISO at, ints only (money: cost_micro, integer
// micro-USD), 1-60 cases, one case per id, blind and the top pass as the harness derives them.
function checkScore(o) {
  if (!keys(o, TOP)) return `a score must have exactly the keys ${TOP.join(', ')}`;
  if (o.v !== 1 || o.kind !== 'golden-score') return 'v must be 1 and kind golden-score';
  if (!isIso(o.at)) return 'at must be an ISO-8601 UTC time';
  if (typeof o.commit !== 'string' || !SHA.test(o.commit) || typeof o.sandbox_base !== 'string' || !SHA.test(o.sandbox_base)) return 'commit and sandbox_base must be 40 hex';
  if (!['real', 'dry'].includes(o.mode)) return 'mode must be real or dry';
  if (!Array.isArray(o.sources) || !o.sources.length || o.sources.length > 10 || !o.sources.every((s) => typeof s === 'string' && SOURCE.test(s))) return 'sources must be 1-10 harness names';
  if (!Array.isArray(o.cases) || !o.cases.length || o.cases.length > 60) return 'cases must hold 1-60 cases';
  const ids = new Set();
  for (const [i, c] of o.cases.entries()) {
    const at = `case ${i + 1}`;
    if (!keys(c, CASE, ['rerun'])) return `${at}: must have exactly the keys ${CASE.join(', ')} (rerun optional)`;
    if (typeof c.id !== 'string' || !CASE_ID.test(c.id)) return `${at}: id must be <golden|planner|review|qa|final_gate>:<1-16 letters, digits or ->`;
    if (ids.has(c.id)) return `${at}: its id is already used by an earlier case`;
    ids.add(c.id);
    if (!(c.run === null || int(c.run, 1)) || !intOrNull(c.fix_rounds, 0) || !intOrNull(c.rework, 0) || !intOrNull(c.min, 0)) return `${at}: run, fix_rounds, rework and min must be whole numbers (or null)`;
    if (!(c.stop === null || (typeof c.stop === 'string' && STOP.test(c.stop)))) return `${at}: stop must be <state> or <state>:<reason>`;
    if (!keys(c.checks, ['pass', 'total']) || !int(c.checks.total, 0, 10_000) || !int(c.checks.pass, 0, c.checks.total)) return `${at}: checks must be {pass, total}, whole numbers, pass ≤ total`;
    if (typeof c.contaminated !== 'boolean') return `${at}: contaminated must be true or false`;
    if (!int(c.cost_micro, 0)) return `${at}: cost_micro must be a whole number ≥ 0 (micro-USD)`;
    if (!blindOk(c.blind)) return `${at}: blind must be null or {scores: 2-3 whole numbers 1-5 (2 at most 1 apart), score, pass} as the harness derives them`;
    if (c.rerun !== undefined && c.rerun !== true) return `${at}: rerun must be true when set`;
  }
  const pass = o.cases.every((c) => c.checks.pass === c.checks.total && !c.contaminated && (!c.blind || c.blind.pass));
  if (o.pass !== pass) return `pass must be ${pass}: every case's checks pass, none contaminated, blind null or passing`;
  return null;
}

// A checked score's t:golden line. ok stays null here: the caller sets the verdict's.
const lineOf = (s, runId) => ({
  t: 'golden', at: s.at, run_id: runId, commit: s.commit, mode: s.mode,
  cases: s.cases.map((c) => ({ id: c.id, pass: c.checks.pass, total: c.checks.total, contaminated: c.contaminated, blind: c.blind?.score ?? null, ...(c.rerun && { rerun: true }) })),
  pass: s.pass, ok: null,
});

// The base of each id in ids: its case in the newest line of lines (t:golden lines, oldest first; real only) holding it
// whose line ok is not false (a regressed run is never a base), with that line's at. No window. → {id: case + at}
function baseOf(lines, ids) {
  const want = new Set(ids);
  const out = {};
  for (let i = lines.length - 1; i >= 0 && want.size; i--) {
    const l = lines[i];
    if (l?.t !== 'golden' || l.mode !== 'real' || l.ok === false || !Array.isArray(l.cases)) continue;
    for (const c of l.cases) if (isObj(c) && want.delete(c.id)) out[c.id] = { ...c, at: l.at };
  }
  return out;
}
// the newest base line's at, null with no base
const baseAt = (base) => Object.values(base).map((b) => b.at).sort().at(-1) ?? null;

// cur (a t:golden line) against base (baseOf). Compared: cases with a base of the same total (a changed total → changed,
// not compared; a case with no base is new). Worse: fewer checks pass, contaminated now and not in the base, or a blind
// score set and under 4 (a lower blind than the base's alone is noise, not worse). → {ok: null with nothing compared,
// else nothing worse and cur passed; x: compared not worse; y: compared; worse: [{id, why}]; changed: [ids]}
function goldenVerdict(base, cur) {
  const worse = [];
  const changed = [];
  let y = 0;
  for (const c of cur.cases) {
    const b = Object.hasOwn(base, c.id) ? base[c.id] : null;
    if (!b) continue;
    if (b.total !== c.total) {
      changed.push(c.id);
      continue;
    }
    y++;
    const why = c.pass < b.pass ? 'fewer checks pass' : c.contaminated && !b.contaminated ? 'contaminated' : c.blind !== null && c.blind < 4 ? 'blind score under 4' : null;
    if (why) worse.push({ id: c.id, why });
  }
  return { ok: y ? !worse.length && cur.pass === true : null, x: y - worse.length, y, worse, changed };
}

module.exports = { checkScore, lineOf, baseOf, baseAt, goldenVerdict, isIso, ISO_RE, UUID_RE };
