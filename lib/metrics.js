'use strict';
// metrics: TB_HOME/metrics.jsonl, one JSON line per run end, gate, finished ticket (P4 AC8), chaos drill (spec App C,
// plan P3 AC10) and push (M5 C14 t:push {at, ticket, remote, ok, ms, why?}: lib/push.js appends it). Append only (mode
// 0600); a failed append is logged, never fails the caller. The last t:run lines stay in memory: admission takes the
// median peak RSS of a phase's last 10 runs from them (admission.needGb). M7: t:control, t:quiet, t:golden (+ TB_HOME/
// evals/golden.jsonl); appends go one at a time (one in-process chain: the only writer), and an append that finds the
// file over ROTATE_BYTES renames it to metrics.1.jsonl first (that one older file kept; no timer). lib/health.js reads
// the tail of both.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EXITS } = require('./stream');
const { isFile, ROUND_RE, eachLine } = require('./util');

const HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const FILE = path.join(HOME, 'metrics.jsonl');
const FILE1 = path.join(HOME, 'metrics.1.jsonl'); // the file before the last rotation
const GOLDEN = path.join(HOME, 'evals', 'golden.jsonl'); // one t:golden line per recorded eval run, never rotated
const KEEP = 200; // t:run lines in memory: 10 per phase with room to spare
const LOAD_BYTES = 1 << 20; // load() reads the file's tail only
const ROTATE_BYTES = 32 << 20;
const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW; // store's: never through a link
let recent = [];
let chain = Promise.resolve(); // every write to FILE (and GOLDEN) runs on it, one at a time

// t:run `exit` (App C enum + refusal + cancelled, T5 note in stream.js): every stream.EXITS value as is; anything else
// a lease could hold (none, or written by older code) counts as a lost run.
const exitOf = (x) => (EXITS.includes(x) ? x : 'interrupted');

function keep(lines) {
  recent.push(...lines.filter((l) => l?.t === 'run'));
  if (recent.length > KEEP) recent = recent.slice(-KEEP);
}

const serial = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};
// One line onto FILE: opened (append, 0600), its size from the fd; over ROTATE_BYTES → renamed to FILE1 (the old FILE1
// goes), FILE opened anew; a rename that fails is logged and the line goes onto FILE (metrics never stop). Throws. Only
// on the chain.
async function write(line) {
  let fh = await fsp.open(FILE, 'a', 0o600);
  try {
    if ((await fh.stat()).size > ROTATE_BYTES) {
      await fh.close();
      fh = null;
      await fsp.rename(FILE, FILE1).catch((e) => console.error(`tbd: ${FILE} not rotated: ${e.message}`));
      fh = await fsp.open(FILE, 'a', 0o600);
    }
    await fh.appendFile(`${JSON.stringify(line)}\n`);
  } finally {
    await fh?.close();
  }
}

// Resolves once the line is written (drill() answers with it); a failure is logged, never thrown.
function append(line) {
  keep([line]);
  return serial(() => write(line)).catch((e) => console.error(`tbd: metric not written to ${FILE}: ${e.message}`));
}

// The parsed lines of file's last max bytes (a cut first line goes); none when there is no file.
async function tail(file, max) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return { size: 0, lines: [] };
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, max));
    await fh.read(buf, 0, buf.length, size - buf.length);
    const lines = [];
    for (const l of buf.toString('utf8').split('\n').slice(size > buf.length ? 1 : 0)) {
      try { lines.push(JSON.parse(l)); } catch { /* a torn line */ }
    }
    return { size, lines };
  } finally {
    await fh.close();
  }
}

// Once at tbd start: the t:run lines of the file's last LOAD_BYTES, before any appended since; a file shorter than that
// (just rotated) is topped up from FILE1's tail, so admission's medians survive a rotation.
async function load() {
  const cur = await tail(FILE, LOAD_BYTES);
  const old = cur.size < LOAD_BYTES ? await tail(FILE1, LOAD_BYTES - cur.size) : { lines: [] };
  const since = recent;
  recent = [];
  keep([...old.lines, ...cur.lines, ...since]);
}

// P3d chaos drills (spec §12, `tb eval chaos`): {name, ok, note} + at (ISO-8601 UTC, when recorded). Resolves the line once appended (POST /api/drills
// answers with it).
const DRILLS = ['kill-tbd', 'kill-claude', 'restart', 'freeze', 'wifi', 'lid', 'reboot', 'disk', 'memory'];
async function drill({ name, ok, note = null }) {
  const line = { t: 'drill', at: new Date().toISOString(), name, ok: ok === true, note };
  await append(line);
  return line;
}

// P5 (spec App C + contract delta): one t:gate line per gate check, written by lib/gates. Every field always present
// (null when unknown): peak_rss_mb from the monitor's 5 s process-tree sample (null: the check ended between samples);
// detail ≤ 200 chars (no agent output: the tail lives in gates/NN.json). Resolves the line once appended.
const GATE_FIELDS = ['ticket', 'task', 'gate', 'check', 'ok', 'exit', 'class', 'ms', 'slot_wait_ms', 'head', 'attempt', 'flaky', 'failfirst', 'detail', 'peak_rss_mb'];
async function gate(o) {
  /** @type {Record<string, any>} */
  const line = { t: 'gate', at: new Date().toISOString(), ...Object.fromEntries(GATE_FIELDS.map((k) => [k, o[k] ?? null])) };
  if (typeof line.detail === 'string') line.detail = line.detail.slice(0, 200);
  await append(line);
  return line;
}

// M7: Irfan's Resume / Restart / Cancel (runner.control1, once its interventions row is written) and a quiet episode's end
// (runner closeQuiet: at = when the dot turned yellow). Resolve the line once appended.
async function control({ ticket, op, actor }) {
  const line = { t: 'control', at: new Date().toISOString(), ticket, op, actor };
  await append(line);
  return line;
}
async function quiet({ at, ticket, phase, task = null, quiet_s, end }) {
  const line = { t: 'quiet', at, ticket, phase, task, quiet_s, end };
  await append(line);
  return line;
}

// M7 POST /api/evals (AN1), one step on the chain: make(lines) gets GOLDEN's t:golden lines (oldest first) and returns
// {line, ...} or throws (a run_id seen: 409); its line goes to GOLDEN first (dir 0700, file 0600), then to FILE. Throws
// (unlike append): a failed FILE write after GOLDEN's leaves the run recorded there, so a retry is refused as a duplicate.
function golden(make) {
  return serial(async () => {
    await fsp.mkdir(path.dirname(GOLDEN), { recursive: true, mode: 0o700 });
    const lines = [];
    await eachLine(GOLDEN, (v) => { if (v?.t === 'golden') lines.push(v); }, ['"t":"golden"']);
    const out = make(lines);
    await fsp.appendFile(GOLDEN, `${JSON.stringify(out.line)}\n`, { mode: 0o600, flag: APPEND });
    await write(out.line);
    return out;
  });
}

// AC8 U11: one t:ticket line (App C) each time a ticket reaches done, blocked or cancelled. dir: the ticket's dir, read
// as kept: rounds/NN-*.json (planning rounds), decisions.json (the last result's decisions, by source: Irfan's answers
// and reject comments = you, the ticket, an ADR, else the planner) and events.jsonl (whole minutes per agent phase,
// from its transitions). Plain files only: a link is never read through. Errors are logged, never thrown. M7 (D-0148):
// + at (now), created_at, approved_at (the first plan_approval → working transition, else null) and hands_on (Irfan's
// interventions.jsonl rows after approved_at, actor cli | ui, verb not close | push; null when never approved).
const HANDS = ['cli', 'ui'];
const OUTCOMES = ['done', 'blocked', 'cancelled'];
const PHASES = ['planning', 'working', 'review', 'qa', 'final_gate'];
const sourceOf = (s) => (/^(answer|reject):/.test(s) ? 'you' : s.startsWith('ticket') ? 'ticket' : /^adr/i.test(s) ? 'adr' : 'planner');
async function ticket(t, dir) {
  if (!OUTCOMES.includes(t.state)) return undefined;
  try {
    const text = async (f) => ((await isFile(path.join(dir, f))) ? fsp.readFile(path.join(dir, f), 'utf8') : '');
    const rounds = (await fsp.readdir(path.join(dir, 'rounds')).catch(() => [])).filter((f) => ROUND_RE.test(f)).length;
    const decisions = { you: 0, ticket: 0, adr: 0, planner: 0 };
    let list = [];
    try { list = JSON.parse((await text('decisions.json')) || '[]'); } catch { /* unreadable: none counted */ }
    for (const d of Array.isArray(list) ? list : []) decisions[sourceOf(String(d?.source ?? ''))]++;
    const minutes = {};
    let at = Date.parse(t.created_at);
    let approved = null;
    for (const l of (await text('events.jsonl')).split('\n')) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e?.kind !== 'transition') continue;
      const ms = Date.parse(e.t) - at;
      if (PHASES.includes(e.from) && ms > 0) minutes[e.from] = (minutes[e.from] ?? 0) + ms;
      at = Date.parse(e.t);
      if (approved === null && e.from === 'plan_approval' && e.to === 'working' && typeof e.t === 'string') approved = e.t;
    }
    let hands = null;
    if (approved !== null) {
      hands = 0;
      await eachLine(path.join(dir, 'interventions.jsonl'), (v) => {
        if (HANDS.includes(v?.actor) && v.verb !== 'close' && v.verb !== 'push' && Date.parse(v.at) > Date.parse(approved)) hands++;
      });
    }
    const line = {
      t: 'ticket', ticket: t.id, kind: t.kind, tag: t.tag ?? null, outcome: t.state, rounds, decisions, rework: t.rework ?? 0,
      interventions: t.interventions ?? 0, phase_minutes: Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, Math.round(v / 60_000)])),
      pr_edited: t.pr?.edited_before_merge ?? null, fix_of: t.fix_of ?? null,
      ...(t.lane_of && { lane_of: t.lane_of.id }), // M5.5 D-0139: a lane's line names its parent (M7 filters lanes out of ticket counts)
      at: new Date().toISOString(), created_at: t.created_at ?? null, approved_at: approved, hands_on: hands,
    };
    await append(line);
    return line;
  } catch (e) {
    console.error(`tbd: ${t.id}: t:ticket not written: ${e.message}`);
    return undefined;
  }
}

module.exports = { append, load, drill, ticket, gate, control, quiet, golden, DRILLS, GATE_FIELDS, exitOf, runs: () => recent, FILE, FILE1, GOLDEN };
