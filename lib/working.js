'use strict';
// working: code/working, one task at a time (spec working ≈170-200, result ≈794; plan P5 AC1 AC2 AC4 AC5; contract rev 4.1
// K1 K3 K4 K7 K12 K13 M1 M9 M11 M12 M13 N3 N6 N8; design §1 §2 §4). tbd.js requires it (tests: test/helpers/fake-gates.js):
// it registers the code/working handler, seed and next hook. The work cursor t.work (lib/gates/types.js Work) walks the
// frozen plan's tasks; each task: a fresh session → its result (handle: shape + one CAS patch, never a gate) → a gate job
// in the background (next hook → gateJob: lib/gates runTaskGate) → decide() → one CAS that applies it: accepted (next task,
// pre = HEAD; after the last one the working gate), red (1st: resume with the gate's why; 2nd: the attempt saved as
// refs/tb/<id>/<task>-a<n>, reset to pre, a fresh session; 3rd: Blocked), an ask (clarify), Blocked (infra, integrity,
// config) or interrupted (runs again, no try used). Working gate green → review; policy red → clarify alone; other red →
// an @fix session (fresh from HEAD; its gate is the working gate).
// Session modes (N6): continue (same session, no reset: after an answer or tb scope), resume (after the 1st red), fresh
// (a new task, the 2nd red). Every working write is a CAS on state working + round + lease gen (+ work.gate.gen for a
// gate's own writes): a Restart, Cancel or recovery in between makes it stale (dropped).
// Gates (contract Interface): setGates(g) (first wins, like phases.registerHandler; never wired → every gate red, class
// infra "gates not wired": fail closed). lib/gates is never required here (RAM: tbd.js wires it lazily). Before each gate:
// the gate's own orphan (work.gate.proc / swap: pid + lstart) killed, a fail-first swap marker restored
// (gates.restoreSwap, only when t.work.gate.swap is set), the frozen plan's hash checked (mismatch → Blocked, config), the
// tree checked clean (dirty twice → Blocked: I4; M5 D-0101: an untracked doc too), env files copied again and the
// node_modules tripwire compared (integrity, passed in, M1). Critical memory (runner.js) and a Cancel abort the job's
// signal (reason memory | cancel | shutdown) before killing its group: a cancelled job writes nothing.
// Irfan's verbs (P5c routes call them; actor cli | ui, each one store.intervention): answer (text → continue; replan →
// planning), scope (allow / deny the asked files: continue; ui may not allow protected, scripts or deps: 401), allowChange
// (a not-allowed change of the latest working gate → immutable plan-<hash>.json + one CAS switching plan_file, plan_hash,
// plan_hashes; the working gate runs again, no session), denyChange (@fix from HEAD: revert it), rework (review | qa |
// final_gate unbuilt → working: feedback-<n>.md, task @rw<n>; a 3rd → Blocked).
// Files (long text never in ticket.json, ≤ 16 KB): work.jsonl (journal: results, gates, asks, answers, task briefs),
// gates/NN.json (lib/gates: the GateResult), scope.json (Irfan's allowed / denied paths per task; t.work.scope and
// t.work.denied hold their counts only), feedback-<n>.md, rules.md (T1 snapshot, approve). Asked files: ≤ 50 × 300 chars.
// A Restart / Resume while a gate runs (runner.control → halt): the job aborted (cancel: no result), awaited, its swap
// restored, before any session starts (a Cancel restores it too; a pending base gate: 409); the gate it leaves pending
// under the old lease gen is dropped (handle / next; a base gate re-stamped). A swap marker is cleared by restore() alone: its restore failing → Blocked infra with the
// marker kept (Resume restores first). RO2: a deps allow builds through gates.runDepsSetup (offline first; needs_online
// → a 2nd ask, Irfan's 2nd allow builds online), then the tripwire baseline is taken again; the build is a job too
// (work.building {since, pid, lstart} holds the other verbs off with 409 until its final CAS; boot kills an orphan).
// Children (P5c watcher): a parent waiting on its children holds waiting {reason: 'children', done, total, since}; notify
// does not re-ping that reason.
// M5 C10 (D-0089 D-0105): the final checks are a gate job of this kind too (work.gate kind final, in final_gate):
// lib/final.js starts it (gateJob) and decides its result (setFinal); the job, its kill, halt and boot work by state.
// boot() (tbd.js before runner.start): tickets in working from before P5 get a work cursor (pre = HEAD; a base gate job
// first when base checks / OpenAPI base are missing; no cursor → Blocked once, by the next hook), and a swap left by a
// killed tbd is restored. stop(): shutdown.
// M5.5 (C19, lib/lanes.js): the cursor knows each task's blocked_by (seedWork); the next task is the first ready one
// (nextReady). At a quiet point (no gate, no merge, the cursor null or not started) a parent's next hook asks lanes.step
// first (lanes made, merged, taken back, closed, waited for); a lane ticket (lane_of) works its one task like any ticket
// but waits `merge` once accepted and ends on a 2nd red. A merge is a job of the parent's (its re-gate: gateJob with the
// job given, apply → lanes.regated); one left half way (work.merging, no job) is undone first: next, halt, boot.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const fsm = require('./fsm');
const phases = require('./phases');
const spawn = require('./spawn');
const planning = require('./planning');
const tagsLib = require('./tags');
const { procs } = require('./slots');
const { killOrphans, Stale, GATE_PROMPT } = require('./recovery');
const { TbError } = require('./errors');
const { dropDocs, clean: cleanDocs } = require('./docs');
const { isObj, isFile, eachLine, readPlain, git: gitIn, dbLocal, fetchHead, SHA_RE } = require('./util');

/** @typedef {import('./gates/types').GateResult} GateResult @typedef {import('./gates/types').Decision} Decision */

const TRIES = 2; // reds of one task before Blocked: the 1st resumes, the 2nd starts fresh, the 3rd blocks
const REWORK_MAX = 2;
const WHY_MAX = 4096; // a gate's why, a question: the resume prompt
const TEXT_MAX = 10_000; // an answer
const FEEDBACK_MAX = 64 * 1024; // a rework's feedback (HTTP takes text only: never a path)
const ASK_FILES = 50; // files an ask may name (each ≤ 300 chars): RAM + ticket size
const DEP_FILES = ['package.json', 'package-lock.json']; // RO2: what a deps build changes (the agent commits them)
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']; // as the task gate (lib/gates/task.js)
const HARD = ['infra', 'integrity', 'config']; // Blocked at once, no try used
const ASKS = ['scope', 'protected', 'deps', 'policy'];
const NOT_WIRED = 'gates not wired';
const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const iso = () => new Date().toISOString();
const cut = (s, n = WHY_MAX) => String(s ?? '').slice(0, n);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bad = (msg) => new TbError(400, msg);

// ---- gates (contract Interface) -----------------------------------------------------------------------------------
/** @param {{gate: string, t: any, task?: any, pre?: string|null, head?: string}} o @param {string} why @returns {GateResult} */
const redResult = (o, why, cls = 'infra') => ({
  v: 1, gate: /** @type {any} */ (o.gate), ticket: o.t.id, task: o.task?.id ?? null, attempt: 0, pre: o.pre ?? null, head: o.head ?? '',
  plan_hash: o.t.plan_hash ?? null, at: iso(), ms: 0, slot_wait_ms: 0, ok: false, class: /** @type {any} */ (cls), checks: [],
  scope: { outside: [], protected: [], deps: false, bad: [] }, tests: { failfirst: 'n/a', files: [], skips_added: [], deleted: [], expects_removed: [], count_drops: [], count: { pre: 0, head: 0 } },
  schema: [], api: [], unused_allowed: [], migration: [], ask: null, why: cut(why),
});
const DEFAULT_GATES = {
  runTaskGate: async (/** @type {any} */ o) => redResult({ ...o, gate: 'task' }, NOT_WIRED),
  runWorkingGate: async (/** @type {any} */ o) => redResult({ ...o, gate: 'working' }, NOT_WIRED),
  runBaseChecks: async (/** @type {any} */ _o) => ({ ok: false, checks: {}, why: NOT_WIRED }),
  captureOpenapiBase: async (/** @type {any} */ _o) => ({ ok: false, why: NOT_WIRED }),
  restoreSwap: /** @type {(t: any, wt: string) => Promise<void>} */ (async (_t, _wt) => { throw new Error(NOT_WIRED); }),
  runDepsSetup: /** @type {(o: any) => Promise<{ok: boolean, why?: string, needs_online?: boolean}>} */ (async (_o) => ({ ok: false, why: NOT_WIRED })),
};
let wired = null;
/** First wins (a test preload's fakes stay when tbd.js wires the real ones). */
const setGates = (/** @type {Partial<typeof DEFAULT_GATES>} */ g) => void (wired ??= g);
const gates = () => ({ ...DEFAULT_GATES, ...wired });
// M5 C10: what a final gate's result means is lib/final.js's (it requires this module, never the reverse): setFinal(fn),
// fn(t, res) → a Decision (+ wait: the Blocked reason; fixes: the fix count of a `fix`). Never set → Blocked (fail closed).
let finalDecide = (/** @type {any} */ _t, /** @type {any} */ res) => ({ do: 'blocked', task: null, mode: null, why: `final gate: no decision wired (${res.class ?? 'green'})` });
const setFinal = (/** @type {typeof finalDecide} */ fn) => void (finalDecide = fn);
const JOB_STATES = ['working', 'final_gate']; // where a gate job runs (M5 C10: the final checks in final_gate)
const L = () => require('./lanes'); // M5.5: lib/lanes.js requires this module (lazy here: no cycle at load)
// a ticket by id for the fsm guards (children_done, close_rework); not found → null (counts as open: fail closed)
const ticketOf = (/** @type {string} */ id) => { try { return store.getTicket(id); } catch { return null; } };

// ---- small readers ------------------------------------------------------------------------------------------------
const current = (w) => (w?.task ? w.tasks.find((x) => x.id === w.task) ?? null : null);
// M5.5 X1: x may start: pending, no lane holds it, every blocked_by done (a cursor from before M5.5 has none: ready).
// nextReady: the first such task in plan order (skip: one passed over). Serial order is as before: blocked_by names
// earlier tasks only (plan-rules), so the first pending task is ready.
const ready = (w, x) => x.status === 'pending' && !Object.hasOwn(w.lanes ?? {}, x.id) && (x.blocked_by ?? []).every((b) => w.tasks.some((y) => y.id === b && y.status === 'done'));
const nextReady = (w, skip = null) => w.tasks.find((x) => x.id !== skip && ready(w, x)) ?? null;
// M5.5 (sec A08): tbd's own record of the parent's HEAD, w.tip (written by seedWork, a task accepted, a merge, X2b); a
// cursor without one: the open task's pre, else the last done task's head (before lanes plan order = branch order), else
// the first pre. Never a bare HEAD read: a lane's agent shares the tag's .git and can move the parent's branch.
const tipOf = (w) => w.tip ?? current(w)?.pre ?? w.tasks.findLast((x) => x.status === 'done')?.head ?? w.tasks[0]?.pre ?? null;
const kindOf = (id) => (id === '@fix' ? 'working' : 'task'); // @fix fixes the working gate's findings: that gate judges it
const git = (t, args, o = {}) => gitIn(t.worktree, args, { timeout: 120_000, dirs: t, ...o });
async function head(t, o = {}) { // o.signal: a lane job's (lib/lanes.js)
  const r = await git(t, ['rev-parse', '--verify', 'HEAD'], o);
  const h = r.stdout.trim();
  if (r.err || !SHA_RE.test(h)) throw new Error(`git rev-parse HEAD in ${t.worktree}: ${cut(r.stderr || r.err?.message, 200)}`);
  return h;
}
const journalFile = (id) => path.join(store.ticketDir(id), 'work.jsonl');
const journal = (id, line) => fsp.appendFile(journalFile(id), JSON.stringify({ at: iso(), ...line }) + '\n', { mode: 0o600, flag: APPEND });
// The journal's lines (a torn last line skipped), streamed; not a plain file → none.
async function lines(id) {
  const all = [];
  await eachLine(journalFile(id), (l) => { if (l !== undefined) all.push(l); });
  return all;
}
const lastLine = async (id, ok) => (await lines(id)).findLast(ok) ?? null;
// The newest gates/NN.json number (lib/gates writes them), null: none.
async function lastGateN(id) {
  const names = await fsp.readdir(path.join(store.ticketDir(id), 'gates')).catch(() => []);
  const ns = names.map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  return ns.length ? Math.max(...ns) : null;
}
// gates/NN.json (lib/gates writes it): opened O_NOFOLLOW (a link is never read), a plain file ≤ 1 MB, else null
async function gateFile(id, n) {
  if (!Number.isInteger(n)) return null;
  const text = await readPlain(path.join(store.ticketDir(id), 'gates', `${String(n).padStart(2, '0')}.json`), 1 << 20);
  return text === null ? null : JSON.parse(text);
}
// Irfan's allowed ({path, blob?}) and denied paths per task (F5: out of ticket.json). Not a plain file / unreadable → none.
// Null-prototype maps: a task id like `constructor` or `__proto__` is a plain key.
const scopeFile = (id) => path.join(store.ticketDir(id), 'scope.json');
const bare = (v) => Object.assign(Object.create(null), isObj(v) ? v : {});
async function readScope(id) {
  try {
    const v = (await isFile(scopeFile(id))) ? JSON.parse(await fsp.readFile(scopeFile(id), 'utf8')) : {};
    return { allow: bare(v.allow), denied: bare(v.denied) };
  } catch {
    return { allow: bare(), denied: bare() };
  }
}
// files → their blob ids at commit c (ls-tree, one call); missing (deleted) → git's null id in this object format
async function blobsAt(t, c, files) {
  const r = await git(t, ['ls-tree', '-z', c, '--', ...files]);
  if (r.err) throw new Error(`git ls-tree in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`);
  const m = new Map(r.stdout.split('\0').filter(Boolean).map((e) => [e.slice(e.indexOf('\t') + 1), e.split('\t')[0].split(' ')[2]])); // "<mode> <type> <sha>\t<path>"
  return new Map(files.map((p) => [p, m.get(p) ?? '0'.repeat(c.length)]));
}
// K3 + RO2 single ask: a protected allow granted before the agent's change (blob null, granted_at_head) binds to the blob
// the first gate after that change sees at HEAD; from then on any other change asks again. Saves scope.json. → sc.
async function bindGrants(t, sc, h) {
  const pend = Object.values(sc.allow).flat().filter((a) => !a.blob && a.granted_at_head);
  if (!pend.length) return sc;
  const now = await blobsAt(t, h, pend.map((a) => a.path));
  for (const at of new Set(pend.map((a) => a.granted_at_head))) {
    const was = await blobsAt(t, at, pend.filter((a) => a.granted_at_head === at).map((a) => a.path));
    for (const a of pend.filter((x) => x.granted_at_head === at)) {
      if (now.get(a.path) === was.get(a.path)) continue; // not changed yet: still pending
      a.blob = now.get(a.path);
      delete a.granted_at_head;
    }
  }
  await writeScope(t.id, sc);
  return sc;
}
// RO2: what node_modules was (or would be) built from: the npm lockfile's blob as '<name>:<sha>', at commit `at` or in
// the worktree (at null: a build may leave it uncommitted), 'none' without one. t.work.deps_blob keeps the last build's.
async function depsBlob(t, at = null) {
  for (const f of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const r = at ? await git(t, ['rev-parse', '--verify', '--quiet', `${at}:${f}`])
      : (await isFile(path.join(t.worktree, f))) ? await git(t, ['hash-object', '--', f]) : null;
    if (r && !r.err && r.stdout.trim()) return `${f}:${r.stdout.trim()}`;
  }
  return 'none';
}
// counts of a scope.json map (what t.work.scope / t.work.denied hold); t with the lists back, for a gate that reads
// t.work.scope as Allow[] per task (lib/gates/types.js Work: runDepsSetup's vouch)
const counts = (m) => Object.fromEntries(Object.entries(m).map(([x, v]) => [x, v.length]));
const withScope = (t, sc) => ({ ...t, work: { ...t.work, scope: sc.allow, denied: sc.denied } });
const writeScope = (id, sc) => store.writeAtomic(scopeFile(id), JSON.stringify(sc) + '\n');
const capFiles = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && f && f.length <= 300).slice(0, ASK_FILES) : []);
const synthetic = (id) => id.startsWith('@');
// The plan task a work task stands for; @fix / @rw<n> (synthetic): preserve, scope = every plan task's files + modules
// (K1: no fail-first; the working gate follows); what Irfan allowed reaches its gate as allow (blobs kept).
function planTask(plan, id) {
  const x = plan?.tasks?.find((p) => p.id === id);
  if (x) return x;
  const all = plan?.tasks ?? [];
  return { id, title: id.startsWith('@rw') ? 'rework' : 'fix', type: 'preserve', files: [...new Set(all.flatMap((p) => p.files ?? []))],
    modules: [...new Set(all.flatMap((p) => p.modules ?? []))], blocked_by: [], acceptance: [], test_cmd: null, steps: [] };
}

// ---- decide (pure) ------------------------------------------------------------------------------------------------
/**
 * What follows for t: from the gate result just in (last), or from the work cursor alone (last null). Contract M13.
 * @param {any} t @param {any} _plan @param {GateResult & {dirty?: boolean} | null} last @returns {Decision}
 */
function decide(t, _plan, last) {
  const w = t.work;
  /** @returns {Decision} */
  const D = (/** @type {Decision['do']} */ d, task = null, mode = null, why = '') => ({ do: d, task, mode, why: cut(why) });
  if (!w) return D('blocked', null, null, 'no work cursor');
  const cur = current(w);
  const id = cur?.id ?? null;
  const onward = (why) => {
    const nx = nextReady(w, id);
    return nx ? D('spawn', nx.id, 'fresh', why) : D('gate', null, null, `${why}; every task done: the working gate`);
  };
  if (last) {
    if (last.ok === true) {
      if (last.gate === 'working') return D('review', id, null, 'working gate green');
      if (last.gate === 'base') return decide({ ...t, work: { ...w, gate: null } }, null, null);
      return onward(`${id} accepted`);
    }
    if (last.class === 'interrupted') return D('gate', id, null, `gate interrupted: it runs again (${last.why})`);
    if (HARD.includes(last.class) || last.gate === 'base') return D('blocked', id, null, `${last.gate === 'base' ? 'base red' : last.class}: ${last.why}`);
    if (last.ask && ASKS.includes(last.ask.kind)) {
      const denied = new Set(w.denied?.[id] ?? []);
      const again = last.ask.kind === 'scope' ? (last.ask.files ?? []).filter((f) => denied.has(f)) : [];
      if (again.length) return D('blocked', id, null, `asked again for files Irfan denied: ${again.join(', ')}`);
      return D('clarify', id, null, last.ask.reason || last.why);
    }
    if (last.dirty) return !cur || (cur.dirty ?? 0) >= 1 ? D('blocked', id, null, `uncommitted changes${cur ? ' again' : ''}: ${last.why}`) : D('spawn', id, 'resume', last.why);
    if (last.gate === 'working' && id !== '@fix') return D('spawn', '@fix', 'fresh', last.why);
    if (w.tries < 1) return D('spawn', id, 'resume', last.why);
    if (w.tries < TRIES) return D('spawn', id, 'fresh', last.why);
    return D('blocked', id, null, `red ${w.tries + 1} times: ${last.why}`);
  }
  if (w.gate && w.gate.ok === undefined) return D('gate', id, null, `${w.gate.kind} gate pending`);
  if (!cur) return onward('no open task');
  switch (cur.status) {
    case 'pending': return D('spawn', id, 'fresh', 'a new task');
    case 'running': return D('spawn', id, cur.session ? 'continue' : 'fresh', 'the same task goes on');
    case 'gating': return D('gate', id, null, 'its session is done: the gate');
    case 'red': return w.tries <= 1 ? D('spawn', id, 'resume', 'red once') : w.tries <= TRIES ? D('spawn', id, 'fresh', 'red twice') : D('blocked', id, null, 'red too often');
    default: return onward(`${id} done`);
  }
}

// ---- work cursor --------------------------------------------------------------------------------------------------
/** approve's final write (planning.js): the plan's tasks, kept ones (K4) as they were, the first open one current. M5.5
 * X1: each with the plan's blocked_by (the ready set), serial empty (tasks back from a lane). */
function seedWork(plan, k, { pre, kept = [] }) {
  const old = new Map((k.work?.tasks ?? []).map((x) => [x.id, x]));
  const tasks = plan.tasks.map((x) => ({ ...(kept.includes(x.id) && old.has(x.id) ? old.get(x.id)
    : { id: x.id, status: 'pending', attempt: 0, pre: null, head: null, commit: null, session: null }), blocked_by: [...(x.blocked_by ?? [])] }));
  const first = tasks.find((x) => x.status === 'pending');
  if (first) Object.assign(first, { pre, attempt: 1 });
  return {
    task: first?.id ?? null, tasks, tries: 0, unit_ms: k.base_checks?.unit?.ms ?? k.work?.unit_ms ?? null, scope: {}, denied: {}, serial: [], tip: pre,
    gate: first ? null : { gen: k.lease?.gen ?? 0, kind: 'working' },
  };
}
const setTask = (w, id, patch) => ({ ...w, tasks: w.tasks.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
// A synthetic task (@fix, @rw<n>) becomes the current one, fresh from pre (replaces an older one of the same id).
const openTask = (w, id, pre) => ({
  ...w, task: id, tries: 0, gate: null,
  tasks: [...w.tasks.filter((x) => x.id !== id), { id, status: 'pending', attempt: 1, pre, head: null, commit: null, session: null }],
});
// M5.5 (lib/lanes.js too): the serial list + task (every lane end but a green merge or an abort); a lanes map less task
const serialOf = (w, task) => [...new Set([...(w.serial ?? []), task])];
const without = (lanes, task) => Object.fromEntries(Object.entries(lanes ?? {}).filter(([x]) => x !== task));
// M5.5 X3 X4 X9: the parent's cursor after a lane's merge (ok: m.task done at head, its lanes entry kept until the lane
// closes; failed: the task back to serial, its entry gone, head = m.pre), merging and the re-gate cleared either way, tip
// = head: the open (pending) task starts at head, else the next ready one; none left at all → the working gate (gen).
// The merged task's pre = m.pre, the commit it was picked onto: planning.keepOk reads the branch order from it.
function merged(w, m, ok, head, gen) {
  let w2 = { ...w, merging: null, gate: null, tip: head };
  if (ok) w2 = setTask(w2, m.task, { status: 'done', head, pre: m.pre });
  else w2 = { ...w2, lanes: without(w2.lanes, m.task), serial: serialOf(w2, m.task) };
  const c = current(w2);
  if (c) return setTask(w2, c.id, { pre: head });
  const nx = nextReady(w2);
  if (nx) return setTask({ ...w2, task: nx.id }, nx.id, { pre: head, attempt: 1 });
  return w2.tasks.every((x) => x.status === 'done') ? { ...w2, gate: { gen, kind: 'working' } } : w2;
}

// ---- the result handler (runner.handle, after the schema) ---------------------------------------------------------
// Shape + one CAS patch (contract: the gate never runs here). status → field (M12): done needs a commit sha; NEEDS_SCOPE
// needs needs_scope; NEEDS_CONTEXT / TEST_DISPUTES_SPEC a question. A no-op done (commit = pre) on a `new` task → clarify.
// NEEDS_SCOPE naming files Irfan denied for this task → Blocked (K3). Every result but done clears work.gate (a gate left
// pending by a Restart / Resume under an older lease gen never runs after the answer).
async function handle(t, out) {
  const w = t.work;
  const cur = current(w);
  if (!cur) return { reject: 'no task is open: nothing to report on' };
  const s = out.status;
  if (s === 'done' && !SHA_RE.test(out.commit ?? '')) return { reject: 'status done needs commit: the sha of your last commit (git rev-parse HEAD)' };
  if ((s === 'NEEDS_SCOPE') !== (out.needs_scope !== undefined)) return { reject: 'needs_scope goes with status NEEDS_SCOPE only (and it needs it)' };
  if ((s === 'NEEDS_CONTEXT' || s === 'TEST_DISPUTES_SPEC') && !String(out.question ?? '').trim()) return { reject: `status ${s} needs a question for Irfan` };
  const session = t.lease?.session ?? cur.session;
  const after = () => journal(t.id, { t: 'result', task: cur.id, attempt: cur.attempt, ...out });
  const clarify = (why, cls, extra = {}) => ({
    to: 'clarify', ctx: { task_needs: () => true }, after,
    patch: { work: { ...setTask(w, cur.id, { status: 'running', session }), gate: null }, clarify_origin: { phase: 'working', task: cur.id, why: cut(why, 1000), class: cls }, ...extra }, // full text: work.jsonl
  });
  if (s === 'done') {
    const plan = await planning.readPlan(t).catch(() => null);
    if (out.commit === cur.pre && planTask(plan, cur.id).type === 'new') return clarify(`${cur.id} returned done without a commit (HEAD is still pre ${cur.pre.slice(0, 12)}): a new task needs a change`, 'noop');
    return { patch: { work: { ...setTask(w, cur.id, { status: 'gating', commit: out.commit, session }), gate: { gen: t.lease?.gen ?? 0, kind: kindOf(cur.id) } } }, after };
  }
  if (s === 'NEEDS_SCOPE') {
    const denied = new Set((await readScope(t.id)).denied[cur.id] ?? []);
    const again = out.needs_scope.files.filter((f) => denied.has(f));
    if (again.length) {
      const why = `${cur.id} asked again for files Irfan denied: ${again.join(', ')}`;
      return { to: 'blocked', ctx: {}, after: async () => { await after(); await journal(t.id, { t: 'blocked', task: cur.id, why }); }, patch: { work: { ...setTask(w, cur.id, { status: 'running', session }), gate: null } } };
    }
    // RO2 single ask: the kind is decided now (packages or a lockfile → deps; a protected file, package.json's scripts
    // too → protected), so the gate never asks again for what Irfan answers here
    const packages = out.needs_scope.packages ?? [];
    const prot = tagsLib.gateTag(store.listTags()[t.tag] ?? {}).protected;
    const kind = packages.length || out.needs_scope.files.some((f) => LOCKFILES.includes(path.posix.basename(f))) ? 'deps'
      : out.needs_scope.files.some((f) => prot.some((g) => path.matchesGlob(f, g))) ? 'protected' : 'scope';
    const files = kind === 'deps' ? [...new Set([...out.needs_scope.files, ...DEP_FILES])] : out.needs_scope.files;
    const ask = { t: 'ask', from: 'agent', task: cur.id, round: (t.round ?? 0) + 1, kind, files, ...(packages.length && { packages }), reason: out.needs_scope.reason };
    const c = clarify(out.needs_scope.reason, kind);
    return { ...c, after: async () => { await after(); await journal(t.id, ask); } };
  }
  return clarify(out.question, s);
}

// ---- seed: a fresh session's prompt -------------------------------------------------------------------------------
async function seed(t, system) {
  const w = t.work;
  const cur = current(w);
  const plan = (await planning.readPlan(t).catch(() => null)) ?? {};
  const x = planTask(plan, cur?.id ?? '');
  const sc = await readScope(t.id);
  const all = await lines(t.id);
  const list = (v) => (v?.length ? v.join(', ') : '(none)');
  const acc = new Map((plan.acceptance ?? []).map((a) => [a.id, a]));
  const out = [store.renderMd(t).trimEnd(), '## Plan', [plan.summary ?? '(no summary)', `allowed schema changes: ${list(plan.allowed_schema_changes)}`,
    `allowed API changes: ${list(plan.allowed_api_changes)}`].join('\n')];
  const done = w.tasks.filter((y) => y.status === 'done').map((y) => `${y.id} (${String(y.head ?? y.commit ?? '').slice(0, 12)})`);
  const at = w.tasks.findIndex((y) => y.id === cur?.id);
  const later = w.tasks.slice(at + 1).filter((y) => y.status === 'pending').map((y) => `${y.id} ${plan.tasks?.find((p) => p.id === y.id)?.title ?? ''}`.trim());
  out.push(`## Your task: ${cur?.id} (${x.type})`, [`${x.title}`, `files: ${list(x.files)}`, `modules: ${list(x.modules)}`,
    `acceptance: ${(x.acceptance ?? []).map((a) => `${a} (${acc.get(a)?.type ?? '?'}): ${acc.get(a)?.text ?? '?'}`).join('; ') || '(none)'}`, `test_cmd: ${x.test_cmd ?? '(none)'}`,
    ...(x.steps?.length ? ['steps:', ...x.steps.map((st) => `- ${st}`)] : []), `pre (your start commit): ${cur?.pre ?? '?'}`, `done before you: ${list(done)}`,
    `later tasks (not yours: no work for them): ${list(later)}`].join('\n'));
  // the decisions this work follows (decisions.json: Irfan's locked ones marked) + his last reject comment
  const locked = new Set((t.locked_decisions ?? []).map((d) => d.id));
  const dfile = path.join(store.ticketDir(t.id), 'decisions.json');
  const decisions = (await isFile(dfile)) ? await fsp.readFile(dfile, 'utf8').then((v) => JSON.parse(v), () => []) : [];
  const dl = (Array.isArray(decisions) ? decisions : []).filter((d) => isObj(d)).map((d) => `- ${d.id}${locked.has(d.id) ? ' [locked: Irfan]' : ''}: ${d.text}`);
  if (dl.length || t.reject_comment) out.push('## Decisions', [...dl, ...(t.reject_comment ? [`Irfan's last comment on the plan: ${t.reject_comment}`] : [])].join('\n'));
  // the gate's facts for this tag (lib/tags.js gateTag): what runs, what counts as a test, what you may not change
  const gt = tagsLib.gateTag(store.listTags()[t.tag] ?? {});
  out.push('## Gate', [`checks: ${list(Object.entries(gt.checks ?? {}).map(([c, v]) => `${c} = ${v}`))}`, `test files: ${list(gt.test_globs)}`,
    `protected (ask with NEEDS_SCOPE before changing): ${list(gt.protected)}`, `generated (no scope needed): ${list(gt.generated)}`].join('\n'));
  const brief = all.findLast((l) => l.t === 'task' && l.id === cur?.id);
  if (brief?.brief) out.push('## What to do', brief.brief);
  if (brief?.feedback) out.push("## Irfan's rework feedback", await fsp.readFile(path.join(store.ticketDir(t.id), brief.feedback), 'utf8').catch(() => '(feedback file unreadable)'));
  const answers = all.filter((l) => l.t === 'answer' && l.task === cur?.id).map((l) => `- ${l.text}`);
  if (answers.length) out.push("## Irfan's answers on this task", answers.join('\n'));
  const allowed = (synthetic(cur?.id ?? '') ? Object.values(sc.allow).flat() : sc.allow[cur?.id] ?? []).map((a) => a.path);
  if (allowed.length || sc.denied[cur?.id]?.length) out.push('## Scope', `also allowed: ${list(allowed)}\ndenied (never touch): ${list(sc.denied[cur?.id])}`);
  if (cur?.status === 'red' && t.lease?.error) out.push('## What the gate found on the last attempt (the tree is back at pre)', t.lease.error);
  const rules = path.join(store.ticketDir(t.id), 'rules.md');
  if (t.rules_sha && (await isFile(rules))) out.push("## Irfan's rules", (await fsp.readFile(rules, 'utf8')).trimEnd()); // T1 snapshot
  out.push('## System now', system);
  return out.join('\n\n') + '\n';
}

// ---- gate jobs ----------------------------------------------------------------------------------------------------
const jobs = new Map(); // ticket id → its gate job or deps build (deps: true): {ac: AbortController, pid, proc, ending}; one per ticket
// One job entry of a ticket (a gate job; M5.5 a lane's setup or merge, lib/lanes.js): in `jobs` from now until end(),
// which settles done. jobDone(id): settles once t's job (if any) ends (lanes: a lane's worktree goes after its job). One
// per ticket: a 2nd (a next hook racing another, runner.js decide) → null, the caller starts nothing.
function job(id) {
  if (jobs.has(id)) return null;
  let end = /** @type {(v?: any) => void} */ (() => {});
  const j = { ac: new AbortController(), pid: null, proc: null, ending: false, done: new Promise((res) => { end = res; }), end: () => { if (jobs.get(id) === j) jobs.delete(id); end(); } };
  jobs.set(id, j);
  return j;
}
const jobDone = (/** @type {string} */ id) => jobs.get(id)?.done ?? Promise.resolve();
// The job's process group, killed by pid + start time (a reused pid is never touched); grace 0: TERM then KILL.
async function killJob(j) {
  const p = j.proc ?? (Number.isInteger(j.pid) ? { pid: j.pid, lstart: (await procs(true))?.get(j.pid)?.lstart } : null);
  if (p?.lstart) await killOrphans([p], procs, 0);
}
/** K12: abort every running gate job (signal reason first), then kill its group. → how many. runner.js: memory. */
function abortGates(reason) {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.ending || j.ac.signal.aborted) continue;
    j.ac.abort(reason);
    void killJob(j).catch((e) => console.error(`tbd: gate kill: ${e.message}`));
    n++;
  }
  return n;
}
// A Cancel (or any move not made by the job itself: out of working, or out of clarify for a deps build) ends the job: it
// writes nothing.
store.on('transition', (next) => {
  const j = jobs.get(next.id);
  if (j && !j.ending && !j.ac.signal.aborted) {
    j.ac.abort('cancel');
    void killJob(j).catch((e) => console.error(`tbd: gate kill: ${e.message}`));
  }
});

// M1: env files copied again (a gate may have read them: never trust the old copy) and the node_modules tripwire vs the
// approve-time baseline. → {ok, why?}
async function integrity(t, tag) {
  try {
    await planning.copyEnv(tag, t.worktree);
  } catch (e) {
    return { ok: false, why: `env files: ${e.message}` };
  }
  const base = t.config_baseline?.tripwire;
  if (!base) return { ok: false, why: 'no node_modules tripwire baseline (approve takes it)' };
  const now = await spawn.tripwire(t.worktree);
  const changed = [now.lock !== base.lock && 'node_modules/.package-lock.json', now.bin !== base.bin && 'node_modules/.bin links'].filter(Boolean);
  return changed.length ? { ok: false, why: `${changed.join(' and ')} changed since setup` } : { ok: true };
}

// The orphan of a tbd that died mid-gate (proc, swap: pid + lstart) killed, then a fail-first swap restored (K7: only
// when the marker is set; lib/gates is asked nothing else here). mine: the CAS guard of the caller. ps failing → throws,
// the markers kept (fail closed).
async function restore(t, mine) {
  const g = t.work?.gate;
  if (!g?.proc && !g?.swap) return;
  if (!(await killOrphans([g.proc, g.swap].filter((p) => Number.isInteger(p?.pid) && p.lstart), procs))) throw new Error('ps failed: the gate\'s orphan may still run (its marker kept)');
  if (g.swap) await gates().restoreSwap(t.clone ? { ...t, trusted: true } : t, t.worktree); // H2.5: the swap's head was fetched (tag objects)
  await store.updateTicket(t.id, (k) => {
    if (!mine(k)) throw new Stale();
    return { ...k, work: { ...k.work, gate: { ...k.work.gate, proc: null, swap: null } } };
  });
}

// One gate job for t (its work.gate pending). rerun: Recovery's rerunGate (Resume out of Blocked) awaits it → {fresh} |
// {gate} | {stop}; else it acts itself (api.recover). Never throws: a failure → Blocked infra. given (M5.5 X3): a lane
// merge's job entry, reused (its caller ends it).
async function gateJob(t, api, rerun = false, given = null) {
  const id = t.id;
  const r = t.round;
  const g = t.lease?.gen ?? 0;
  const kind = t.work.gate.kind;
  const st = t.state; // working, or final_gate (M5 C10: lib/final.js starts the final checks' job here)
  const j = given ?? job(id);
  if (!j) return { stop: true }; // a job of t's runs already
  const mine =(k) => k.state === st && k.round === r && (k.lease?.gen ?? 0) === g && k.work?.gate?.gen === g;
  const cas = (fn, note = undefined) => store.updateTicket(id, async (k) => {
    if (!mine(k)) throw new Stale();
    return fn(k);
  }, note);
  try {
    if (t.waiting?.reason === 'memory') await cas((k) => ({ ...k, waiting: null })); // K12: the wait is over
    await restore(t, mine);
    t = structuredClone(store.getTicket(id));
    const tag = store.listTags()[t.tag];
    if (!tag?.path) return await apply(t, api, cas, redResult({ gate: kind, t }, `tag ${t.tag} has no path`, 'config'), rerun, j);
    // M5 C7 (D-0087): a db "local" tag's gates may reach localhost:5432, so its env files must name this Mac's postgres
    // (checked before integrity copies them in); else Blocked, waiting db
    const db = tag.db === 'local' ? await dbLocal(tag) : { ok: true };
    if (!db.ok) return await apply(t, api, cas, { ...redResult({ gate: kind, t }, `DB guard: ${db.why}`, 'config'), wait: 'db' }, rerun, j);
    if (kind === 'base') return await baseJob(t, api, cas, tag, j, rerun);
    // plan_hash (contract): the frozen plan must still be the approved one
    const plan = await planning.readPlan(t).catch(() => null);
    if (!plan || sha256(planning.canon(plan)) !== t.plan_hash) return await apply(t, api, cas, redResult({ gate: kind, t }, `the frozen plan ${t.plan_file ?? 'plan.json'} does not match plan_hash ${String(t.plan_hash).slice(0, 12)}`, 'config'), rerun, j);
    const w = t.work;
    const cur = current(w);
    const h = await head(t);
    const env = new Set(tag.env_files ?? []);
    // M5.3 M2 (D-0105): a final review that ended without a taken result (wall, max_turns, crash) left its docs, a tracked
    // doc it edited too: back to HEAD first (no mirror: an unfinished run's docs are no result), else every Resume meets
    // Blocked integrity again. New visit and Resume alike start here.
    if (kind === 'final') {
      const e = await cleanDocs(t).then(() => null, (x) => x);
      if (e) return await apply(t, api, cas, redResult({ gate: kind, t, head: h }, `docs dirs not cleaned: ${e.message}`, 'infra'), rerun, j);
    }
    // H2.5 C1 (D-0152): HEAD fetched into the tag repo (refs/tb/<id>/head; index-pack + fsck), then every read of this
    // gate, the tree check, the checks' git, the fail-first swap and the restore, from the tag's objects only (trusted):
    // what the agent planted in its clone's object store is never read. A fetch refused → Blocked integrity (util.gitWhy's
    // words, never git's raw ones). A ticket from before H2 (no clone) shares the tag's objects: no fetch, nothing to swap.
    const fetched = await fetchHead(t, h, j.ac.signal).then(() => null, (e) => e);
    if (fetched) {
      if (j.ac.signal.reason === 'cancel') return { stop: true };
      return await apply(t, api, cas, redResult({ gate: kind, t, head: h }, `HEAD not fetched into the tag repo: ${cut(fetched.message, 500)}`, j.ac.signal.aborted ? 'interrupted' : fetched.code === 'LOCK' ? 'infra' : 'integrity'), rerun, j); // C-L5: a lock left: infra
    }
    const tt = t.clone ? { ...t, trusted: true } : t;
    // H1: one tree check for every gate kind, content too (spawn.treeDirty): a forged index stat cache hides nothing
    const lines0 = (await spawn.treeDirty(tt)).filter((l) => !env.has(l.slice(3)));
    // M5 D-0105: the final gate keeps no docs and asks nobody: a tracked change (or a skip-worktree / assume-unchanged
    // flag) is no one's commit → Blocked integrity; untracked leftovers (QA logs, a sqlite file, docs) go in cleanTree.
    const tracked = kind === 'final' ? lines0.filter((l) => !l.startsWith('?? ')) : [];
    if (tracked.length) return await apply(t, api, cas, redResult({ gate: kind, t, head: h }, `tracked changes at the final gate: ${tracked.slice(0, 20).join(', ')}${tracked.length > 20 ? ` (+${tracked.length - 20} more)` : ''}: nobody commits there`, 'integrity'), rerun, j);
    // G8: a QA visit that ended without a result leaves its docs: an untracked md / png there is cleaned by the gate
    // (cleanTree), not called dirty. A tracked doc changed stays dirty: cleanTree keeps tracked edits, and a test could
    // require it (D-0101)
    const kept = new Set(await dropDocs(t.worktree, lines0.filter((l) => l.startsWith('?? '))));
    const dirty = kind === 'final' ? [] : lines0.filter((l) => !l.startsWith('?? ') || kept.has(l));
    if (dirty.length) {
      const why = `uncommitted changes: ${dirty.slice(0, 20).join(', ')}${dirty.length > 20 ? ` (+${dirty.length - 20} more)` : ''}: commit them or revert them, then return the result again`;
      return await apply(t, api, cas, { ...redResult({ gate: kind, t, task: cur, pre: cur?.pre, head: h }, why, 'work'), dirty: true }, rerun, j);
    }
    const save = async (/** @type {any} */ p) => {
      const pick = { ...(p && 'proc' in p && { proc: p.proc }), ...(p && 'swap' in p && { swap: p.swap }) };
      if (pick.proc) j.proc = pick.proc;
      else if (pick.swap?.pid && !j.proc) j.proc = { pid: pick.swap.pid, lstart: pick.swap.lstart }; // the swap's gate process
      try {
        await cas((k) => ({ ...k, work: { ...k.work, gate: { ...k.work.gate, ...pick } } }));
        return true;
      } catch (e) {
        if (e instanceof Stale) return false;
        throw e;
      }
    };
    const onSpawn = (/** @type {number} */ pid) => { j.pid = pid; };
    const n0 = await lastGateN(id); // a gate that wrote no gates/NN.json (it failed early) has none
    const sc = await bindGrants(tt, await readScope(id), h); // C-M3: blobs at h and at a grant's head from the tag's objects
    const common = { t: withScope(tt, sc), wt: t.worktree, head: h, plan, tag, baseChecks: t.base_checks ?? {}, integrity: await integrity(t, tag), save, onSpawn, signal: j.ac.signal };
    let res;
    const all = Object.values(sc.allow).flat(); // the working gate and a synthetic task: every task's allows (blobs kept)
    if (kind === 'working' || kind === 'final') {
      res = await gates().runWorkingGate({ ...common, base: t.base_sha, allow: all, kind });
    } else {
      // M5.5 X3: a merge's re-gate judges the picked lane task as preserve (no fail-first) from merging.pre to HEAD
      const m = w.merging;
      const done = m ? null : await lastLine(id, (l) => l.t === 'result' && l.task === cur.id && l.status === 'done');
      res = await gates().runTaskGate({ ...common, task: m ? { ...planTask(plan, m.task), type: 'preserve' } : planTask(plan, cur.id), pre: m ? m.pre : cur.pre,
        out: m ? { commit: h, tests: [] } : { commit: cur.commit, tests: done?.tests_added ?? [] }, allow: m ? sc.allow[m.task] ?? [] : synthetic(cur.id) ? all : sc.allow[cur.id] ?? [], unitMs: w.unit_ms ?? null });
    }
    if (j.ac.signal.reason === 'cancel') return { stop: true }; // a cancel writes nothing
    // a gate stopped mid-swap (memory, shutdown) may return without its restore: the marker says so; restored first
    const k1 = store.getTicket(id);
    if (k1.work?.gate?.swap) await restore(structuredClone(k1), mine);
    if (!isObj(res) || typeof res.ok !== 'boolean') res = redResult({ gate: kind, t, task: cur, pre: cur?.pre, head: h }, 'the gate returned no result');
    if (j.ac.signal.aborted) res = { ...res, ok: false, class: 'interrupted' }; // contract K12: signal first
    const n = await lastGateN(id);
    return await apply(t, api, cas, { ...res, n: n !== n0 ? n : null }, rerun, j);
  } catch (e) {
    if (e instanceof Stale) return { stop: true };
    console.error(`tbd: ${id}: gate job failed: ${e.message}`);
    return apply(store.getTicket(id), api, cas, redResult({ gate: kind, t }, `gate job failed: ${e.message}`), rerun, j).catch((e2) => {
      if (!(e2 instanceof Stale)) console.error(`tbd: ${id}: gate result not saved: ${e2.message}`);
      return { stop: true };
    });
  } finally {
    try { // a Cancel leaves no swapped tree in the kept worktree (Restart / Resume: halt awaits this, then restores too)
      const k0 = j.ac.signal.reason === 'cancel' ? store.getTicket(id) : null;
      if (k0?.work?.gate?.swap) await restore(structuredClone(k0), (k) => k.state === k0.state && k.round === k0.round);
    } catch (e) {
      console.error(`tbd: ${id}: swap not restored: ${e.message}`);
    }
    if (!given) j.end();
  }
}

// N3 live migration (n12): the base gate of a ticket that reached working before P5 (HEAD = base_sha).
async function baseJob(t, api, cas, tag, j, rerun) {
  const gt = tagsLib.gateTag(tag);
  const onSpawn = (/** @type {number} */ pid) => { j.pid = pid; };
  const save = async (/** @type {any} */ p) => {
    if (p?.proc) j.proc = p.proc;
    return cas((k) => ({ ...k, work: { ...k.work, gate: { ...k.work.gate, ...(p && 'proc' in p && { proc: p.proc }) } } })).then(() => true, (e) => { if (e instanceof Stale) return false; throw e; });
  };
  const patch = {};
  let why = '';
  if (gt.openapi && !t.openapi_base) {
    const o = await gates().captureOpenapiBase({ t, wt: t.worktree, tag, onSpawn, signal: j.ac.signal });
    if (o?.ok) patch.openapi_base = { sha: t.base_sha, at: iso() };
    else why = `openapi: ${o?.why ?? 'no result'}`;
  }
  if (!why && !t.base_checks && ['typecheck', 'unit', 'lint', 'build'].some((c) => gt.checks?.[c])) {
    const b = await gates().runBaseChecks({ t, wt: t.worktree, tag, save, onSpawn, signal: j.ac.signal });
    if (b?.ok) patch.base_checks = Object.fromEntries(Object.entries(b.checks ?? {}).map(([c, x]) => [c, { ok: !!x?.ok, ms: Number.isFinite(x?.ms) ? x.ms : null }]));
    else why = `${Object.entries(b?.checks ?? {}).filter(([, x]) => !x?.ok).map(([c]) => c).join(', ') || 'checks'}: ${b?.why ?? 'no result'}`;
  }
  if (j.ac.signal.reason === 'cancel') return { stop: true };
  if (!why && !t.base_checks && !patch.base_checks) patch.base_checks = {};
  const res = why ? redResult({ gate: 'base', t }, why, j.ac.signal.aborted ? 'interrupted' : 'work') : { ...redResult({ gate: 'base', t }, ''), ok: true, class: null };
  return apply({ ...t, ...patch }, api, cas, { ...res, n: null }, rerun, j, patch);
}

// decide() on the result, then ONE CAS applying it (+ the journal line in the same write), then what follows outside the
// store: a session through the one recovery path (api.recover), or (rerun) what Recovery should start.
async function apply(t, api, cas, res, rerun, j, extra = {}) {
  j.ending = true; // the job's own move out of working is not a Cancel
  const w = t.work;
  if (w.merging) return L().regated(t, cas, res, j); // M5.5 X3: a merge's re-gate, before decide
  const cur = current(w);
  const kind = w.gate?.kind ?? 'task';
  if (res.ask) res = { ...res, ask: { ...res.ask, ...(res.ask.files && { files: capFiles(res.ask.files) }), ...(res.ask.changes && { changes: capFiles(res.ask.changes) }), reason: cut(res.ask.reason, 1000) } };
  const d = kind === 'final' ? finalDecide(t, res) // M5 C10: lib/final.js
    : decide({ ...t, work: { ...w, denied: (await readScope(t.id)).denied } }, null, res); // decide reads the denied lists
  const meta = { gen: w.gate?.gen ?? t.lease?.gen ?? 0, kind, n: res.n ?? null, ok: res.ok, class: res.ok ? null : res.class ?? 'work', proc: null, swap: null };
  const gateLine = { t: 'gate', n: meta.n, kind, task: cur?.id ?? null, attempt: cur?.attempt ?? 0, ok: res.ok, class: meta.class, do: d.do, why: cut(res.why) };
  const review = [res.checks?.filter?.((c) => c?.flaky).map((c) => c.check), String(res.tests?.failfirst ?? '').startsWith('unproven') && res.tests.failfirst].flat().filter(Boolean);
  const write = (fn) => cas(async (k) => {
    const next = await fn(k);
    await journal(t.id, gateLine);
    if (res.ok && review.length) await journal(t.id, { t: 'review', task: cur?.id ?? null, n: meta.n, flaky: res.checks.filter((c) => c?.flaky).map((c) => c.check), failfirst: res.tests?.failfirst ?? null }); // M11 K7: listed for review
    return next;
  });
  const unit = res.checks?.find?.((c) => c?.check === 'unit' && c.ok)?.ms;
  const blocked = (k, why) => {
    // a swap marker still set here = its restore threw (the only way it reaches apply): kept, never cleared but by
    // restore() itself (fail closed: Resume / Restart restores it before the gate or any session)
    let w2 = { ...k.work, gate: { ...meta, swap: k.work.gate?.swap ?? null } };
    if (cur && !HARD.includes(res.class) && kind !== 'base') w2 = setTask(w2, cur.id, { status: 'red' }); // red too often (or dirty twice)
    return { ...fsm.move({ ...k, ...extra, work: w2 }, 'blocked', 'runner'), waiting: { reason: d.wait ?? res.wait ?? res.class ?? 'gate', why: cut(why, 500), since: iso() } };
  };

  if (d.do === 'final') { // M5 C10: the final checks green: lib/final.js's next hook spawns the final review next tick
    await write((k) => ({ ...k, work: { ...k.work, gate: meta } }));
    return undefined;
  }
  if (d.do === 'fix') { // M5 C10 C4: red work at the final gate → fix n as the synthetic task d.task, back in working
    await write(async (k) => {
      await journal(t.id, { t: 'task', id: d.task, brief: d.why });
      return fsm.move({ ...k, fixes: d.fixes, work: openTask(k.work, d.task, res.head || k.final?.tested_sha || null) }, 'working', 'runner', { rework: () => true });
    });
    return { stop: true };
  }

  if (d.do === 'review') { // an @fix judged by the working gate is done with it
    const w2 = { gate: meta, task: null };
    await write((k) => fsm.move({ ...k, work: cur ? setTask({ ...k.work, ...w2 }, cur.id, { status: 'done', head: res.head || cur.commit, commit: undefined, session: undefined }) : { ...k.work, ...w2 } }, 'review', 'runner', { working_gate: () => true }));
    return { stop: true };
  }
  if (res.ok && (d.do === 'spawn' || d.do === 'gate')) { // accepted (or a base gate passed): the next task, else the working gate
    const next = await write((k) => {
      let w2 = { ...k.work, tries: 0, unit_ms: Number.isFinite(unit) ? unit : k.work.unit_ms ?? null, gate: null };
      // F5: a done task keeps its verified head only (its claimed commit + session live in work.jsonl): ticket.json small
      if (kind !== 'base' && cur) w2 = setTask({ ...w2, tip: res.head || cur.commit }, cur.id, { status: 'done', head: res.head || cur.commit, commit: undefined, session: undefined, dirty: undefined });
      // M5.5 X8: a lane's task accepted: no next task, no working gate; it waits for its parent to merge it
      if (t.lane_of && kind !== 'base') return { ...k, ...extra, work: { ...w2, task: null }, waiting: { reason: 'merge', since: iso() } };
      const nx = nextReady(w2);
      if (kind !== 'base' || !current(w2)) w2.task = nx?.id ?? null;
      if (nx && w2.task === nx.id && kind !== 'base') w2 = setTask(w2, nx.id, { pre: res.head || cur?.commit, attempt: 1 });
      if (!w2.task && w2.tasks.every((x) => x.status === 'done')) w2.gate = { gen: meta.gen, kind: 'working' }; // M5.5 X9: not while a lane's task is open
      return { ...k, ...extra, work: w2 };
    });
    if (rerun) return current(next.work)?.status === 'pending' ? { fresh: true } : { stop: true };
    return undefined; // the moved cursor: the runner's next tick starts the task (T1) or the working gate
  }
  if (d.do === 'gate') { // interrupted: pending again, no try used
    await write((k) => ({ ...k, work: { ...k.work, gate: { gen: meta.gen, kind } } }));
    return { stop: true };
  }
  if (d.do === 'blocked') {
    // M5.5 D-0140: a lane's block ends it (lib/lanes.js watch: its parent journals lane_end.why); integrity is a security
    // end: its parent's alert, its worktree kept (keep: tb gc removes it); any other block of a lane alerts nobody
    const end = t.lane_of && { why: cut(`blocked ${res.class ?? 'gate'}: ${d.why}`, 500), keep: res.class === 'integrity' };
    await write((k) => ({ ...blocked(k, d.why), ...(end && { lane_end: k.lane_end ?? end }) }));
    // ponytail: alert after the write; a tbd dying between loses only this banner: notify.js (D3) pings every blocked and
    // clarify ticket on its own (re-ping, after a restart too), and waiting.why keeps the reason
    if (!end || end.keep) api.alert?.({ title: `Blocked: ${res.class ?? 'gate'}`, message: `${end ? `${t.lane_of.id} lane ` : ''}${t.id}: ${cut(d.why, 300)}` });
    return { stop: true };
  }
  if (d.do === 'clarify') {
    const ask = res.ask;
    await write(async (k) => {
      const moved = fsm.move({ ...k, ...(cur && { work: setTask({ ...k.work, gate: meta }, cur.id, { status: 'running' }) }), ...(!cur && { work: { ...k.work, gate: meta } }),
        clarify_origin: { phase: 'working', task: cur?.id ?? null, why: cut(d.why, 1000), class: ask.kind } }, 'clarify', 'runner', { task_needs: () => true });
      await journal(t.id, { t: 'ask', task: cur?.id ?? null, round: moved.round, kind: ask.kind, n: meta.n, ...(ask.files && { files: ask.files }), ...(ask.changes && { changes: ask.changes }), reason: ask.reason });
      return moved;
    });
    return { stop: true };
  }
  // red: an @fix for the working gate, else resume / fresh (I4: a dirty tree resumes once, then blocks)
  if (d.task === '@fix' && cur?.id !== '@fix') {
    await write(async (k) => {
      await journal(t.id, { t: 'task', id: '@fix', brief: `The working gate found these problems (policy items excluded: Irfan decides those). Fix them, commit, return done:\n\n${cut(res.why)}` });
      return { ...k, work: { ...openTask(k.work, '@fix', res.head || cur?.commit || null), gate: meta } };
    });
    return { stop: true };
  }
  if (t.lane_of && d.mode === 'fresh') { // M5.5 X8: a lane's 2nd red: no fresh try, the lane ends (its task back to serial)
    await write((k) => fsm.move({ ...k, lane_end: k.lane_end ?? { why: cut(`red twice: ${res.why}`, 500) } }, 'cancelled', 'runner'));
    return { stop: true };
  }
  const t2 = await write((k) => {
    const c = current(k.work);
    const w2 = setTask({ ...k.work, tries: res.dirty ? k.work.tries : k.work.tries + 1, gate: meta }, c.id, { status: 'red', attempt: c.attempt + 1, ...(res.dirty && { dirty: (c.dirty ?? 0) + 1 }) });
    return { ...k, work: w2, lease: { ...k.lease, error: cut(res.why) } };
  });
  if (d.mode === 'fresh') await freshReset(t2);
  if (rerun) return d.mode === 'fresh' ? { fresh: true } : { gate: true };
  // not awaited (as next()): the job ends now, so a halt (Restart / Resume) never waits on the recovery's admission
  void api.recover?.({ why: 'gate', ...(d.mode === 'fresh' ? { fresh: true } : { gate: true }) });
  return undefined;
}

// N6 fresh: the discarded attempt kept as refs/tb/<id>/<task>-a<n> (create only: a retry after a crash keeps it), the
// tree reset to the task's pre. The ref not made (and not there from that retry, nor HEAD at pre already) → throws, never
// a reset that loses the attempt (fail closed).
async function freshReset(t) {
  const c = current(t.work);
  const ref = `refs/tb/${t.id}/${c.id}-a${c.attempt - 1}`;
  const u = await git(t, ['update-ref', ref, 'HEAD', '']); // '': create only, any object format
  if (u.err) {
    const h = await head(t);
    if (h !== c.pre && (await git(t, ['rev-parse', '--verify', '--quiet', ref])).stdout.trim() !== h) throw new Error(`git update-ref ${ref} in ${t.worktree}: ${cut(u.stderr || u.err.message, 200)}`);
  }
  const r = await git(t, ['reset', '-q', '--hard', c.pre]);
  if (r.err) throw new Error(`git reset --hard ${c.pre} in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`);
}

// ---- the next hook (runner.consider + decide, recovery rerunGate) ---------------------------------------------------
// A ticket in working with no live run: T1 (a new round or task) → start options for the runner ({} fresh with the seed,
// {resume, session, prompt} continue) or undefined (a gate job started, a wait); after a run's result (same round and
// task) it acts itself. api.rerun: Resume out of Blocked → the gate runs again (tries 0), awaited. A gate pending under an
// older lease gen (a Restart / Resume came between: every write of its job would be stale) is dropped, its orphan / swap
// restored first; decide() goes on from the task's status (gating: the gate pended again at this gen). A base gate
// (it judges base_sha, no session's work) gets this gen instead.
async function next(t, api) {
  if (jobs.has(t.id) || held.has(t.id)) return undefined;
  // M5.5 X8: a lane in setup (no cursor yet) or with its task done (waiting merge: the parent merges it) starts nothing
  if (t.lane_of && (!t.work || t.work.tasks.every((x) => x.status === 'done'))) return undefined;
  if (t.work?.merging) { // M5.5 X5: a merge left half way (no job: a kill, an abort) is undone first; the lane is merged again later
    await L().redo(t);
    return api.rerun ? { stop: true } : undefined;
  }
  if (!t.work) { // a Resume (rerun) starts no session before the new cursor's base gate: the next tick starts it
    await migrate(t).catch(noCursor(t));
    return api.rerun ? { stop: true } : undefined;
  }
  // M5.5 X2b: no open task at a quiet point but a ready one (back to serial while the parent waited on lanes) → it is the
  // cursor now, from HEAD (tbd's own only: trusted), before any session (a session with no task would be refused: "no
  // task is open")
  const nx = !current(t.work) && !t.work.gate ? nextReady(t.work) : null;
  if (nx) {
    const pre = await trusted(t, api);
    if (!pre) return api.rerun ? { stop: true } : undefined;
    const r = t.round;
    const k = await store.updateTicket(t.id, (x) => {
      if (x.state !== 'working' || x.round !== r || current(x.work) || x.work.gate || x.work.merging || tipOf(x.work) !== pre || nextReady(x.work)?.id !== nx.id) throw new Stale();
      return { ...x, work: setTask({ ...x.work, task: nx.id, tip: pre }, nx.id, { pre, attempt: 1 }) };
    }).catch((e) => { if (e instanceof Stale) return null; throw e; });
    if (!k) return api.rerun ? { stop: true } : undefined;
    t = structuredClone(k);
  }
  if (api.rerun) return rerunGate(t, api);
  const w = t.work;
  const cur = current(w);
  const sameRound = (k) => k.state === 'working' && k.round === t.round;
  // M5.5 X2: a parent's quiet point (no gate, no merge, the cursor null or not started): lanes first (lib/lanes.js); when
  // it acted (a job, a lane ended, a wait) nothing else this tick
  if (!t.lane_of && !w.gate && (!cur || cur.status === 'pending') && (await L().step(t, api))) return undefined;
  if (w.gate && w.gate.ok === undefined && w.gate.gen !== (t.lease?.gen ?? 0)) {
    await restore(t, sameRound);
    await store.updateTicket(t.id, (k) => {
      if (!sameRound(k) || k.work?.gate?.gen !== w.gate.gen || k.work.gate.ok !== undefined) throw new Stale();
      return { ...k, work: { ...k.work, gate: w.gate.kind === 'base' ? { ...k.work.gate, gen: k.lease?.gen ?? 0 } : null } };
    }).catch((e) => { if (!(e instanceof Stale)) throw e; });
    return undefined;
  }
  if (w.gate && (w.gate.ok === undefined || w.gate.swap || w.gate.proc)) {
    if (api.system?.()?.pressure === 'critical') return void (await api.setWaiting?.('memory')); // K12: no gate into a memory kill
    if (w.gate.ok !== undefined) await restore(t, sameRound);
    else void gateJob(t, api);
    return undefined;
  }
  const d = decide(t, null, null);
  const sameRun = t.lease && t.lease.phase === 'working' && t.lease.round === t.round && (t.lease.task ?? null) === (cur?.id ?? null);
  if (d.do === 'gate') { // a session done (gating) or every task done: its gate pending, then the job (next tick)
    await store.updateTicket(t.id, (k) => {
      if (k.state !== 'working' || k.round !== t.round || (k.lease?.gen ?? 0) !== (t.lease?.gen ?? 0)) throw new Stale();
      return { ...k, work: { ...k.work, gate: { gen: k.lease?.gen ?? 0, kind: cur ? kindOf(cur.id) : 'working' } } };
    }).catch((e) => { if (!(e instanceof Stale)) throw e; });
    return undefined;
  }
  if (d.do !== 'spawn') return undefined;
  if (d.mode === 'resume' || (d.mode === 'fresh' && cur?.status === 'red')) { // a red not yet followed (tbd died after the CAS)
    if (d.mode === 'fresh') await freshReset(t);
    // not awaited (as runner decide): recover marks the ticket busy at once and never rejects; awaiting it would hold the
    // runner's whole tick while it waits for admission
    return void api.recover?.({ why: 'gate', ...(d.mode === 'fresh' ? { fresh: true } : { gate: true }) });
  }
  if (cur?.status === 'pending') { // its session starts now (no session id yet: a start that fails stays fresh)
    await store.updateTicket(t.id, (k) => {
      if (k.state !== 'working' || k.round !== t.round || k.work?.task !== cur.id) throw new Stale();
      return { ...k, work: setTask(k.work, cur.id, { status: 'running', session: null }) };
    }).catch((e) => { if (!(e instanceof Stale)) throw e; });
  }
  if (sameRun) return void (await api.recover?.({ why: 'next task', fresh: d.mode !== 'continue' })); // the runner takes no options here
  if (d.mode === 'continue') {
    const c = await lastLine(t.id, (l) => l.t === 'continue' && l.task === cur.id && l.round === t.round);
    return { resume: true, session: cur.session, prompt: c?.prompt ?? spawn.RESUME_PROMPT };
  }
  return {};
}

async function rerunGate(t, api) {
  const cur = current(t.work);
  const g0 = t.work.gate;
  const pendingGate = g0 && (g0.ok === undefined || (g0.kind === 'base' && g0.ok === false)); // a red base gate: again, before any task
  if (cur && !['gating', 'red'].includes(cur.status) && !pendingGate) return cur.status === 'pending' ? { fresh: true } : {};
  // M5.5: no task of its own: the pending ones wait on lanes (X2b took any ready one) → no session, the lanes go on
  if (!cur && !pendingGate && t.work.tasks.some((x) => x.status === 'pending')) return nextReady(t.work) ? { fresh: true } : { stop: true };
  const g = t.lease?.gen ?? 0;
  const k2 = await store.updateTicket(t.id, (k) => { // the gate belongs to Recovery's new gen; Resume = tries 0
    if (k.state !== 'working' || (k.lease?.gen ?? 0) !== g) throw new Stale();
    const kind = k.work.gate?.kind ?? (cur ? kindOf(cur.id) : 'working');
    return { ...k, work: { ...k.work, tries: 0, gate: { ...k.work.gate, gen: g, kind, ok: undefined, class: undefined } } };
  });
  return gateJob(k2, api, true);
}

// Live migration (n12): a ticket in working without work (P4 approve): the cursor from the frozen plan, pre = HEAD; the
// tripwire baseline taken now if approve had none; a base gate job first when base checks / OpenAPI base are missing.
async function migrate(t) {
  const plan = await planning.readPlan(t);
  if (!plan?.tasks?.length) throw new Error('no frozen plan with tasks');
  const pre = await head(t);
  const tag = store.listTags()[t.tag] ?? {};
  const gt = tagsLib.gateTag(tag);
  const needBase = (gt.openapi && !t.openapi_base) || (!t.base_checks && ['typecheck', 'unit', 'lint', 'build'].some((c) => gt.checks?.[c]));
  const trip = t.config_baseline?.tripwire ? null : await spawn.tripwire(t.worktree);
  await store.updateTicket(t.id, (k) => {
    if (k.state !== 'working' || k.work) throw new Stale();
    const work = seedWork(plan, k, { pre });
    if (needBase) work.gate = { gen: k.lease?.gen ?? 0, kind: 'base' };
    return { ...k, work, plan_hashes: k.plan_hashes ?? [k.plan_hash], ...(trip && { config_baseline: { ...k.config_baseline, tripwire: trip } }), ...(!needBase && !k.base_checks && { base_checks: {} }) };
  }).catch((e) => { if (!(e instanceof Stale)) throw e; });
}
// A cursor that cannot be made (no frozen plan, git failing): Blocked once with the why, not a log line per tick; Resume
// from Blocked tries again.
const noCursor = (t) => (e) => store.updateTicket(t.id, (k) => {
  if (k.state !== 'working' || k.work) throw new Stale();
  return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: 'config', why: cut(`work cursor not made: ${e.message}`, 500), since: iso() } };
}).catch((e2) => { if (!(e2 instanceof Stale)) console.error(`tbd: ${t.id}: work cursor not made: ${e.message} (not blocked: ${e2.message})`); });
// M5.5: a parent at a quiet point Blocked once (pattern noCursor: infra = git failing, integrity = HEAD moved outside
// tbd), not a log line per tick. → blocked now?
const block = (t, reason, why) => store.updateTicket(t.id, (k) => {
  if (k.state !== 'working' || k.round !== t.round) throw new Stale();
  return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason, why: cut(why, 500), since: iso() } };
}).then(() => true, (e) => { if (!(e instanceof Stale)) console.error(`tbd: ${t.id}: not blocked (${reason}: ${why}): ${e.message}`); return false; });
/** M5.5 sec (A08): the parent's HEAD before tbd adopts it as a gated pre (X2b, a merge's start, lib/lanes.js): it must
 * be tbd's own record (tipOf), else Blocked integrity + an alert naming both, nothing adopted; git failing → Blocked
 * infra (an abort of the caller's job: nothing). → HEAD, or null (stop). */
async function trusted(t, api, signal = undefined) {
  let h;
  try {
    h = await head(t, { signal });
  } catch (e) {
    if (!signal?.aborted) await block(t, 'infra', e.message);
    return null;
  }
  const tip = tipOf(t.work);
  if (h === tip) return h;
  const why = `HEAD ${h} is not ${tip ?? '(none)'}, the last head tbd made or gated: the branch moved outside tbd (a lane's agent shares the repo). Put it back by hand, then Resume`;
  if (await block(t, 'integrity', why)) api.alert?.({ title: 'Blocked: integrity', message: `${t.id}: ${cut(why, 300)}` });
  return null;
}

// ---- Irfan's verbs (P5c routes; each is an intervention) ------------------------------------------------------------
const ACTORS = ['cli', 'ui'];
function inClarify(t, classes) {
  const o = t.clarify_origin;
  if (t.state !== 'clarify' || o?.phase !== 'working') throw new TbError(409, `${t.id}: no working question is open (state ${t.state})`);
  if (!classes.includes(o.class)) throw new TbError(409, `${t.id}: this ask (${o.class}) takes ${o.class === 'policy' ? '--allow-change, --deny-change or --replan' : ['scope', 'protected', 'deps'].includes(o.class) ? 'tb scope or --replan' : 'an answer or --replan'}`);
  return o;
}
// The move clarify → working, Irfan's continue prompt journaled for the session (N6 continue), in one write.
async function resume(k, task, prompt, patch = {}) {
  const moved = fsm.move({ ...k, ...patch }, 'working', 'you', { answer_added: () => true });
  delete moved.clarify_origin;
  if (prompt) await journal(k.id, { t: 'continue', task, round: moved.round, prompt });
  return moved;
}
// mine: the work.building token of the caller's own deps build (every other verb: 409 while one runs)
const same = (t, mine = undefined) => (k) => {
  if (k.state !== t.state || k.round !== t.round) throw new TbError(409, `${t.id}: it moved on meanwhile (now ${k.state})`);
  if (k.work?.building && k.work.building.since !== mine) throw new TbError(409, `${t.id}: a dependency build runs (since ${k.work.building.since}): try again when it ends`);
};
// A deps build's flag (work.building) cleared while it is still that build's (since: its token)
const unbuild = (id, since) => store.updateTicket(id, (k) => {
  if (k.work?.building?.since !== since) throw new Stale();
  return { ...k, work: { ...k.work, building: undefined } };
}).catch((e) => { if (!(e instanceof Stale)) throw e; });

/** M12: {text} → appended to the task's brief, the same session goes on; {replan: true} → planning (a new plan; K4). */
async function answer(id, body, actor = 'cli') {
  if (!isObj(body) || Object.keys(body).length !== 1 || !(typeof body.text === 'string' || body.replan === true)) throw bad('body must be {"text": "<answer>"} or {"replan": true}');
  // Phase 5: the lavish page (lib/interview.js) answers text asks only: a replan stays Irfan's own (cli | ui)
  if (!ACTORS.includes(actor) && !(actor === 'lavish' && !body.replan)) throw bad('actor must be cli or ui (lavish: a text answer only)');
  const t = store.getTicket(id);
  if (body.replan) {
    inClarify(t, ['NEEDS_CONTEXT', 'TEST_DISPUTES_SPEC', 'noop', 'scope', 'protected', 'deps', 'policy']);
    return store.intervention(id, { actor, verb: 'replan', task: t.clarify_origin.task, payload: body }, (k) => {
      same(t)(k);
      return fsm.move({ ...k, plan_hash: null, must_ask: false }, 'planning', 'you', { changes_plan: () => true }); // clarify_origin: the planner's why
    });
  }
  const text = body.text.trim();
  if (!text || text.length > TEXT_MAX) throw bad(`text must be 1-${TEXT_MAX} characters`);
  const o = inClarify(t, ['NEEDS_CONTEXT', 'TEST_DISPUTES_SPEC', 'noop']);
  return store.intervention(id, { actor, verb: 'answer', task: o.task, payload: body }, async (k) => {
    same(t)(k);
    await journal(id, { t: 'answer', task: o.task, text });
    return resume(k, o.task, `Irfan answered:\n\n${text}\n\nGo on with the task with this in mind.`);
  });
}

/** K3: allow (this task only; protected / scripts / deps bound to the blob at HEAD, CLI only) or deny the asked files.
 * RO2 (F3): a deps allow builds first (gates.runDepsSetup: offline, then online after Irfan's 2nd allow when the offline
 * build needs the network) and takes the tripwire baseline again; a build that needs the network → a 2nd ask. */
async function scope(id, body, actor = 'cli', want) {
  if (!isObj(body) || Object.keys(body).some((x) => x !== 'allow') || typeof body.allow !== 'boolean') throw bad('body must be {"allow": true|false}');
  if (!ACTORS.includes(actor)) throw bad('actor must be cli or ui');
  const t = structuredClone(store.getTicket(id));
  const o = inClarify(t, ['scope', 'protected', 'deps']);
  const ask = await lastLine(id, (l) => l.t === 'ask' && l.round === t.round);
  const files = capFiles(ask?.files);
  if (!files.length) throw new TbError(409, `${id}: the open ask names no files`);
  if (body.allow && actor === 'ui' && ask.kind !== 'scope') throw new TbError(401, `${id}: allowing a ${ask.kind} change needs the CLI (tb scope --allow)`); // RO6
  let allows = files.map((p) => ({ path: p }));
  if (body.allow && ask.kind !== 'scope') { // K3: bound to a blob; a later change asks again
    const h = await head(t);
    if (ask.from === 'agent') allows = files.map((p) => ({ path: p, blob: null, granted_at_head: h })); // its change is not written yet: the first gate binds it
    else allows = await blobsAt(t, h, files).then((b) => files.map((p) => ({ path: p, blob: b.get(p) }))); // the gate saw it at HEAD
  }
  const task = o.task;
  let build; // this call's deps build: the job in `jobs`, its since = the work.building token
  const sameAsk = (k) => { // want (--task): the ask is on that task, checked again inside the CAS
    same(t, build?.since)(k);
    if (want !== undefined && k.clarify_origin?.task !== want) throw new TbError(409, `${id}: the open ask is not on task ${JSON.stringify(want.slice(0, 64))}`);
  };
  sameAsk(t);
  const payload = { allow: body.allow, files, ...(ask.online && { online: true }) };
  let baseline = null;
  let built = null;
  try {
    if (body.allow && ask.kind === 'deps') {
      const tag = store.listTags()[t.tag] ?? {};
      const packages = Array.isArray(ask.packages) ? ask.packages.filter((x) => typeof x === 'string').slice(0, 20) : [];
      // a tracked job: in flight on the ticket first (work.building: every other verb 409s until the final CAS; its pid +
      // lstart let the next boot kill an orphan), in `jobs` while it runs (Cancel, stop, critical memory abort it)
      const since = iso();
      await store.updateTicket(id, (k) => {
        sameAsk(k);
        return { ...k, work: { ...k.work, building: { since } } };
      });
      build = { since, ac: new AbortController(), pid: null, proc: null, ending: false, deps: true };
      jobs.set(id, build);
      const onSpawn = (/** @type {number} */ pid) => {
        build.pid = pid;
        void procs(true).then((m) => m?.get(pid)?.lstart && store.updateTicket(id, (k) => {
          if (k.work?.building?.since !== since) throw new Stale();
          return { ...k, work: { ...k.work, building: { since, pid, lstart: m.get(pid).lstart } } };
        })).catch((e) => { if (!(e instanceof Stale)) console.error(`tbd: ${id}: deps build pid not saved: ${e.message}`); });
      };
      const r = await gates().runDepsSetup({ t: withScope(t, await readScope(id)), wt: t.worktree, tag, packages, online: !!ask.online, onSpawn, signal: build.ac.signal });
      build.ending = true; // what follows is the call's own (its move to working is no Cancel)
      if (r?.needs_online && !ask.online) { // RO2: the offline build needs the network: Irfan's 2nd allow builds online
        const why = `the dependency build needs the network (443 to any host while npm ci runs): tb scope ${id} --allow again to build online, or --replan`;
        return await store.intervention(id, { actor, verb: 'scope-allow', task, payload }, async (k) => {
          sameAsk(k);
          const { at: _at, ...again } = ask;
          await journal(id, { ...again, online: true, reason: why });
          return { ...k, work: { ...k.work, building: undefined }, clarify_origin: { ...k.clarify_origin, why } };
        });
      }
      if (!r?.ok) throw new TbError(409, `${id}: dependency setup failed: ${cut(r?.why ?? 'no result', 500)}`);
      // RO2: package.json + lockfile as the build left them (the agent commits exactly these), node_modules' tripwire
      const have = (await Promise.all(DEP_FILES.map((f) => isFile(path.join(t.worktree, f))))).map((ok, i) => ok && DEP_FILES[i]).filter(Boolean);
      const h = have.length ? await git(t, ['hash-object', '--', ...have]) : { err: null, stdout: '' };
      if (h.err) throw new Error(`git hash-object in ${t.worktree}: ${cut(h.stderr || h.err.message, 200)}`);
      const blobs = h.stdout.split('\n');
      allows = [...allows.filter((a) => !DEP_FILES.includes(a.path)), ...have.map((f, i) => ({ path: f, blob: blobs[i] }))];
      baseline = await spawn.configBaseline(t, t.worktree); // RO2: what the setup made is tbd's (tripwire)
      built = await depsBlob(t); // ... and the lockfile it was built from (a replan skips the build only on a match)
    }
    const prompt = body.allow && ask.kind === 'deps' ? `Irfan allowed ${ask.packages?.length ? ask.packages.join(', ') : 'the dependency change'}: tbd installed it; package.json and the lockfile now hold it. Commit both as they are (never edit them), then go on with the task.`
      : body.allow ? `Irfan allowed these files for this task: ${files.join(', ')}. Go on with the task.`
      : `Irfan denied these files: ${files.join(', ')}. Stay inside the task's scope; if the task cannot be done without them, return NEEDS_CONTEXT.`;
    return await store.intervention(id, { actor, verb: body.allow ? 'scope-allow' : 'scope-deny', task, payload }, async (k) => {
      sameAsk(k);
      const sc = await readScope(id); // F5: the lists live in scope.json, the ticket keeps counts
      if (body.allow) sc.allow[task] = [...(sc.allow[task] ?? []).filter((a) => !files.includes(a.path)), ...allows];
      else sc.denied[task] = [...new Set([...(sc.denied[task] ?? []), ...files])];
      await writeScope(id, sc);
      return resume(k, task, prompt, { work: { ...k.work, building: undefined, scope: counts(sc.allow), denied: counts(sc.denied), ...(built && { deps_blob: built }) }, ...(baseline && { config_baseline: baseline }) });
    });
  } finally {
    if (build) { // a failed or refused build: its flag cleared here
      if (jobs.get(id) === build) jobs.delete(id);
      await unbuild(id, build.since);
    }
  }
}

/** RO2 (F2): approve's final write when a replan's kept commits change dependencies and the offline build needs the
 * network: the ticket goes on to clarify (deps) on its first open task; tb scope --allow builds online. → the moved k. */
async function askDeps(k, files, why) {
  const task = current(k.work)?.id ?? null;
  const moved = fsm.move({ ...k, clarify_origin: { phase: 'working', task, why: cut(why, 1000), class: 'deps' } }, 'clarify', 'runner', { task_needs: () => true });
  await journal(k.id, { t: 'ask', task, round: moved.round, kind: 'deps', files: capFiles(files), online: true, reason: why });
  return moved;
}

/** F1: must runner.control halt id before a Restart / Resume starts a session on the same worktree? A gate job runs (a
 * deps build runs in clarify: no Restart / Resume there), a gate's orphan or swap marker is left (a killed tbd's, before
 * boot or the next tick restored it), or a base gate is pending. halt(id): a pending base gate → 409 (its task never
 * starts without base checks); else the job aborted (reason cancel: it writes nothing), awaited, its orphan killed and
 * a fail-first swap it left restored. */
const busy = (id) => {
  const w = store.getTicket(id).work;
  const g = w?.gate;
  return jobs.has(id) ? !jobs.get(id).deps : !!(w?.merging || g?.proc || g?.swap || (g?.kind === 'base' && g.ok === undefined)); // M5.5 X5: a merge to undo
};
const held = new Set(); // ids halt() holds off the next hook for, until release(id) (the caller's recovery is in flight)
const release = (id) => void held.delete(id);
const jobBusy = (/** @type {string} */ id) => jobs.has(id) || held.has(id); // M5 C10: lib/final.js starts no 2nd job
async function halt(id) {
  const t0 = store.getTicket(id);
  if (t0.state === 'working' && t0.work?.gate?.kind === 'base' && t0.work.gate.ok === undefined) throw new TbError(409, `${id}: base gate running: wait, or Cancel`);
  held.add(id);
  const j = jobs.get(id);
  if (j && !j.ending && !j.ac.signal.aborted) {
    j.ac.abort('cancel');
    await killJob(j).catch((e) => console.error(`tbd: gate kill: ${e.message}`));
  }
  await j?.done;
  const t = store.getTicket(id);
  if (JOB_STATES.includes(t.state) && (t.work?.gate?.swap || t.work?.gate?.proc)) await restore(structuredClone(t), (k) => k.state === t.state && k.round === t.round);
  // M5.5 X5: a merge left half way is undone before any session starts on this tree (not undone → refused: fail closed)
  const t2 = store.getTicket(id);
  if (t2.work?.merging && !(await L().redo(structuredClone(t2)))) throw new TbError(409, `${id}: a lane merge could not be undone yet: try again`);
}

// M9 N8: the change string must be a not-allowed change of the latest working GateResult (else 409).
async function policyChange(t, change) {
  inClarify(t, ['policy']);
  if (typeof change !== 'string' || !change || change.length > 300) throw bad('change must be a change string as the gate named it, e.g. "drop User.nickname"');
  const res = await gateFile(t.id, t.work?.gate?.n);
  const all = [...(res?.schema ?? []).map((c) => ({ ...c, list: 'allowed_schema_changes' })), ...(res?.api ?? []).map((c) => ({ ...c, list: 'allowed_api_changes' }))];
  const hit = all.find((c) => !c.allowed && `${c.op} ${c.ref}` === change);
  if (!hit) throw new TbError(409, `${t.id}: ${JSON.stringify(change.slice(0, 100))} is not a not-allowed change of the latest working gate`);
  return hit;
}

/** M9: allow one change: an immutable plan-<hash>.json with it in allowed_*, then ONE CAS switching the plan pointer +
 * plan_hash + plan_hashes; the gate that asked runs again (no planner, no session). */
async function allowChange(id, body, actor = 'cli') {
  if (!isObj(body) || Object.keys(body).some((x) => x !== 'change')) throw bad('body must be {"change": "<change>"}');
  if (!ACTORS.includes(actor)) throw bad('actor must be cli or ui');
  const t = store.getTicket(id);
  const hit = await policyChange(t, body.change);
  const plan = await planning.readPlan(t);
  if (!plan || sha256(planning.canon(plan)) !== t.plan_hash) throw new TbError(409, `${id}: the frozen plan does not match plan_hash`);
  const next = { ...plan, [hit.list]: [...(plan[hit.list] ?? []), body.change] };
  const hash = sha256(planning.canon(next));
  await store.writeAtomic(path.join(store.ticketDir(id), `plan-${hash}.json`), JSON.stringify(next, null, 2) + '\n');
  return store.intervention(id, { actor, verb: 'allow-change', task: null, payload: body }, (k) => {
    same(t)(k);
    if (k.plan_hash !== t.plan_hash) throw new TbError(409, `${id}: the plan changed meanwhile`);
    const kind = k.work.gate?.kind ?? 'working';
    return resume(k, null, '', { plan_file: `plan-${hash}.json`, plan_hash: hash, plan_hashes: [...(k.plan_hashes ?? []), hash], work: { ...k.work, gate: { gen: k.lease?.gen ?? 0, kind } } });
  });
}

/** M9: deny one change → an @fix session from HEAD (no reset) told to revert it. */
async function denyChange(id, body, actor = 'cli') {
  if (!isObj(body) || Object.keys(body).some((x) => x !== 'change')) throw bad('body must be {"change": "<change>"}');
  if (!ACTORS.includes(actor)) throw bad('actor must be cli or ui');
  const t = store.getTicket(id);
  await policyChange(t, body.change);
  const h = await head(t);
  return store.intervention(id, { actor, verb: 'deny-change', task: '@fix', payload: body }, async (k) => {
    same(t)(k);
    await journal(id, { t: 'task', id: '@fix', brief: `Revert this change: ${body.change}. Reach the goal without it, or return NEEDS_CONTEXT.` });
    return resume(k, '@fix', '', { work: openTask(k.work, '@fix', h) });
  });
}

/** K1: Irfan sends the work back while review / qa / final_gate is unbuilt: feedback-<n>.md, task @rw<n> fresh from HEAD;
 * rework > 2 → Blocked (reset only by Resume from Blocked). HTTP gives text only (≤ 64 KB), never a path. M5 C13 (D-0092):
 * also at close (final_gate waiting close) while no child or dependent has started (fsm close_rework, G7): `final` goes,
 * push keeps only ok_sha (+ remote, ref, at), fixes and the refs/tb/<id>/final-pre-<n> refs stay. */
async function rework(id, body, actor = 'cli') {
  if (!isObj(body) || Object.keys(body).some((x) => x !== 'feedback') || typeof body.feedback !== 'string') throw bad('body must be {"feedback": "<text>"}');
  if (!ACTORS.includes(actor)) throw bad('actor must be cli or ui');
  const feedback = body.feedback.trim();
  if (!feedback || Buffer.byteLength(feedback) > FEEDBACK_MAX) throw bad(`feedback must be 1-${FEEDBACK_MAX} bytes`);
  const t = store.getTicket(id);
  // a passed ticket (D9: pr.merged_at set, a parent may wait for its children) is never reworked: its sha is final
  const reworkOk = (k) => !k.pr?.merged_at || `passed already (merged ${k.pr.merged_at}): rework is closed; open a fix ticket`;
  const ctx = { ...fsm.GUARDS, rework_ok: reworkOk, ticketOf, dependentsOf: store.dependentsOf };
  const can = fsm.check(t, 'working', 'you', ctx);
  if (!can.ok) throw new TbError(409, `${id}: ${can.reason}`);
  if (!t.work) throw new TbError(409, `${id}: no work cursor to rework`);
  const n = (t.rework ?? 0) + 1; // the Blocked rule: reset by Resume
  if (n > REWORK_MAX) {
    return store.intervention(id, { actor, verb: 'rework', task: null, payload: body }, (k) => {
      same(t)(k);
      return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: 'rework', why: `rework ${n} > ${REWORK_MAX}: Resume from Blocked resets it`, since: iso() } };
    });
  }
  // the file + task number never resets (Resume resets rework): an earlier feedback-<m>.md is never written over ('wx':
  // two reworks at once take two numbers; the one that loses the CAS leaves its file unused)
  let seq = Math.max(0, ...(await fsp.readdir(store.ticketDir(id)).catch(() => [])).map((f) => Number(/^feedback-(\d+)\.md$/.exec(f)?.[1] ?? 0))) + 1;
  const made = (n) => fsp.writeFile(path.join(store.ticketDir(id), `feedback-${n}.md`), feedback + '\n', { flag: 'wx', mode: 0o600 }).then(() => true, (e) => { if (e.code === 'EEXIST') return false; throw e; });
  while (!(await made(seq))) seq++;
  const file = `feedback-${seq}.md`;
  const h = await head(t);
  const task = `@rw${seq}`;
  return store.intervention(id, { actor, verb: 'rework', task, payload: body }, async (k) => {
    same(t)(k);
    await journal(id, { t: 'task', id: task, feedback: file, brief: `Irfan sent the work back (rework ${seq}): do what his feedback below asks, commit, return done.` });
    const moved = fsm.move({ ...k, rework: n, work: openTask(k.work, task, h) }, 'working', 'you', ctx);
    delete moved.clarify_origin;
    if (k.state === 'final_gate') { // at close (C1 table): the squash is undone by the next one, its n numbering kept
      delete moved.final;
      if (moved.push) moved.push = Object.fromEntries(Object.entries(moved.push).filter(([x]) => !['state', 'sha', 'why'].includes(x)));
    }
    return moved;
  });
}

// ---- boot / stop (tbd.js) -----------------------------------------------------------------------------------------
// A deps build left by a killed tbd: its orphan killed (pid + lstart), then its flag cleared (Irfan allows again). ps
// failing → the flag kept (every verb 409s: never two builds on one node_modules), tried again in 30 s.
async function lostBuild(id, b) {
  if (await killOrphans([b].filter((p) => Number.isInteger(p.pid) && p.lstart), procs)) return unbuild(id, b.since);
  setTimeout(() => void lostBuild(id, b).catch((e) => console.error(`tbd: ${id}: deps build not ended: ${e.message}`)), 30_000).unref();
}
/** Before runner.start: work cursors for tickets that reached working before P5; a gate's orphan (proc) or swap left by a
 * killed tbd killed / restored; a deps build it left ended (lostBuild). */
async function boot() {
  for (const t of store.listTickets()) {
    if (t.type !== 'flow' || t.kind !== 'code') continue;
    if (t.work?.building) await lostBuild(t.id, t.work.building).catch((e) => console.error(`tbd: ${t.id}: deps build not ended: ${e.message}`));
    if (!JOB_STATES.includes(t.state)) continue;
    if (!t.work && t.state === 'working') {
      if (!t.lane_of) await migrate(t).catch((e) => console.error(`tbd: ${t.id}: work cursor not made: ${e.message}`)); // next() blocks it
      continue; // M5.5 X8: a lane killed in setup has no cursor to make (lanes.boot cancels it)
    }
    const restored = !(t.work?.gate?.swap || t.work?.gate?.proc) || await restore(t, (k) => k.state === t.state && k.round === t.round)
      .then(() => true, (e) => void console.error(`tbd: ${t.id}: gate orphan / swap not restored: ${e.message}`));
    // M5.5 X5: a merge a killed tbd left half way: undone now, its gate orphan killed first (above; not when that threw)
    if (restored && t.work?.merging) await L().redo(structuredClone(store.getTicket(t.id))).catch((e) => console.error(`tbd: ${t.id}: lane merge not undone: ${e.message}`));
  }
}
/** tbd stopping (await it): every gate job aborted (shutdown) and its group killed before tbd exits; its gate runs again
 * after the restart (a kill that did not land: the next boot kills it by work.gate.proc / swap, pid + lstart). */
async function stop() {
  const kills = [];
  for (const j of jobs.values()) {
    if (j.ending || j.ac.signal.aborted) continue;
    j.ac.abort('shutdown');
    kills.push(killJob(j));
  }
  await Promise.allSettled(kills);
}

phases.registerHandler('code/working', handle, seed, next);

// M5 C3: lib/review.js opens its @rv<n> fix task + brief the same way (openTask, journal) and reads the journal + HEAD
// M5.5 lib/lanes.js: job, jobDone, current, ready, merged, restore, trusted, tipOf, serialOf, without (+ gateJob, head,
// journal, the scope files)
module.exports = { HARD, setGates, setFinal, gateJob, jobBusy, ticketOf, gates, decide, seedWork, openTask, journal, lines, head, handle, seed, next, abortGates, busy, halt, release, askDeps, readScope, writeScope, withScope, counts, depsBlob, answer, scope, allowChange, denyChange, rework, boot, stop, GATE_PROMPT,
  job, jobDone, current, ready, merged, restore, trusted, tipOf, serialOf, without };
