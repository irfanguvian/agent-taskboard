'use strict';
// qa: code/qa, the QA phase (contract .omc/handoffs/m5-contract.md rev 4 C5 C7 C8 C9; D-0086 D-0087 D-0092). tbd.js
// requires it like lib/review.js: it registers the code/qa handler, seed and next hook. A fresh session runs the
// change's E2E cases (test-engineer-irfan method, no approval wait) against the app it starts itself, backend evidence
// only through `tbx req` (lib/recorder.js: tbd makes the call and keeps it in runs/<n>.rec.jsonl), and returns a
// QaResult (lib/gates/types.js) with its report under docs/verification/.
// Next hook (a new QA visit; runner.consider holds the QA lock before it): DB guard (util.dbLocal: fail → Blocked
// waiting db) → env files copied again (the copy the app reads = the file the guard checked) → one CAS qa {n, head}
// (n: the next free qa/NN.json) → {} (a fresh session). Resume out of Blocked → {stop}: the next tick starts the visit
// through consider (lock, then this hook), never a run past them.
// Handler, every check code (C21), a refusal = {reject} (runner: schema_fail, resumed once with the reason, then
// Blocked): tree pin (HEAD = qa.head; no tracked change but kept docs and env files), cause on FAIL and BLOCKED, no cause
// test, then the cross-check (positive + negative, sources in the diff or the plan's acceptance, every `new` acceptance
// named, recs recorded in this round with the last one's status, report + screenshots real files, verdict pass ⇔ every
// case PASS). Agent paths are read only when no link lies on the way (realpath = the path), O_NOFOLLOW, capped.
// Outcome: any BLOCKED, or no FAIL with cause code among the unproven → Blocked waiting qa; FAIL cause code → fix n =
// t.fixes + 1 (lib/review.js FIX_MAX, one counter per ticket) as the synthetic task @qa<n> (brief: the failed cases and
// their evidence) → lib/working.js, then review and QA again; a 4th fix → Blocked waiting qa; all PASS → final_gate.
// Every result is mirrored first (lib/docs.js); a taken one is kept in qa/NN.json (the move's write) with each case's
// evidence label and the need_review line for a PASS that rests on agent-made evidence (D-0092); at the visit's end the
// untracked docs leave the worktree (D-0101, handle).
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const phases = require('./phases');
const fsm = require('./fsm');
const planning = require('./planning');
const spawn = require('./spawn');
const docs = require('./docs');
const { FIX_MAX, nextN } = require('./review');
const { openTask, journal, head } = require('./working');
const { Stale } = require('./recovery');
const { git: gitIn, readPlain, eachLine, dbLocal } = require('./util');

/** @typedef {import('./gates/types').QaCase} QaCase @typedef {import('./gates/types').QaResult} QaResult */

const SHA_RE = /^[0-9a-f]{40,64}$/;
const REPORT_MAX = 1 << 20;
const SHOT_MIN = 200; // bytes a real screenshot is over
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STAT_MAX = 8192;
const iso = () => new Date().toISOString();
const cut = (s, n = STAT_MAX) => String(s ?? '').slice(0, n);
const list = (v, n = 10) => `${v.slice(0, n).join(', ')}${v.length > n ? ` (+${v.length - n} more)` : ''}`;
const git = (t, args) => gitIn(t.worktree, args, { timeout: 120_000, dirs: t });
const qaFile = (id, n) => path.join(store.ticketDir(id), 'qa', `${String(n).padStart(2, '0')}.json`);
const readQa = async (id, n) => JSON.parse((await readPlain(qaFile(id, n), 4 << 20)) ?? 'null');

// An agent's path (the schema let through docs/verification/ segments only, none starting with a dot) → its absolute
// path when no link lies on the way (realpath is the path itself), else null.
async function real(root, rel) {
  const abs = path.join(root, rel);
  return (await fsp.realpath(abs).catch(() => null)) === abs ? abs : null;
}
// a plain file over SHOT_MIN bytes that starts with the PNG signature (opened O_NOFOLLOW, checked on the fd)
async function png(abs) {
  const fh = abs && (await fsp.open(abs, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW).catch(() => null));
  if (!fh) return false;
  try {
    const st = await fh.stat();
    const b = Buffer.alloc(PNG.length);
    return st.isFile() && st.size > SHOT_MIN && (await fh.read(b, 0, b.length, 0)).bytesRead === b.length && b.equals(PNG);
  } finally {
    await fh.close();
  }
}

// The rec lines the cases cite, from runs/<run>.rec.jsonl files whose meta line is this ticket's QA in this round (a
// schema-retry resume runs under the next lease gen in the same round, citing the first run's recs). Only the cited
// lines are parsed (their first key is n). → Map rec id → its line.
async function recLines(t, cases) {
  const want = new Map();
  for (const id of cases.flatMap((c) => c.recs)) want.set(id.split('.')[0], (want.get(id.split('.')[0]) ?? new Set()).add(id));
  const got = new Map();
  for (const [run, ids] of want) {
    await eachLine(path.join(store.ticketDir(t.id), 'runs', `${run}.rec.jsonl`), (v, i) => {
      if (i === 1) return !(v?.meta === true && v.ticket === t.id && v.phase === 'qa' && v.round === t.round);
      if (ids.has(v?.n)) got.set(v.n, v);
      return false;
    }, ['{"meta":true,', ...[...ids].map((id) => `{"n":${JSON.stringify(id)},`)]);
  }
  return got;
}

// The qa_gate cross-check (C5 1-7). → {why} (refused) | {recs}
async function crossCheck(t, out, h) {
  const { cases } = out;
  const ids = cases.map((c) => c.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) return { why: `${dup} appears twice in cases: one entry per id` };
  if (!cases.some((c) => c.kind === 'positive') || !cases.some((c) => c.kind === 'negative')) return { why: 'cases need at least one positive and one negative case' };
  if ((out.verdict === 'pass') !== cases.every((c) => c.result === 'PASS')) return { why: `verdict ${out.verdict}: it is pass exactly when every case is PASS (ASSISTED is not proven)` };
  const plan = await planning.readPlan(t);
  if (!plan) throw new Error('the frozen plan is missing or not a plain file'); // fail closed: check 3 needs its acceptance
  const acc = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  if (!SHA_RE.test(t.base_sha ?? '')) throw new Error('ticket.base_sha missing or not a sha');
  const d = await git(t, ['diff', '--name-only', '-z', `${t.base_sha}..${h}`]);
  if (d.err) throw new Error(`git diff --name-only in ${t.worktree}: ${cut(d.stderr || d.err.message, 200)}`); // fail closed
  const changed = new Set(d.stdout.split('\0').filter(Boolean));
  const accIds = new Set(acc.map((a) => a.id));
  const stray = cases.filter((c) => !accIds.has(c.source) && !changed.has(c.source.replace(/:\d+(?:-\d+)?$/, ''))).map((c) => `${c.id} ${c.source}`);
  if (stray.length) return { why: `source must be a path:line changed in ${t.base_sha.slice(0, 12)}..HEAD (git diff --name-only) or a plan acceptance id: ${list(stray)}` };
  const named = new Set(cases.flatMap((c) => [c.source, ...c.acceptance]));
  const open = acc.filter((a) => a.type === 'new' && !named.has(a.id)).map((a) => a.id);
  if (open.length) return { why: `new acceptance ${list(open)} has no case: name it in a case's acceptance` };
  const recs = await recLines(t, cases);
  const lost = [...new Set(cases.flatMap((c) => c.recs))].filter((id) => !recs.has(id));
  if (lost.length) return { why: `rec ${list(lost)}: not recorded by tbd in this QA round: cite only rec ids tbx req printed in this QA` };
  for (const c of cases.filter((x) => x.type !== 'frontend' && (x.result === 'PASS' || x.result === 'FAIL'))) {
    if (!c.recs.length) return { why: `${c.id}: a ${c.type} case that is ${c.result} needs recs: the rec ids tbx req printed (curl output is never evidence)` };
    const last = recs.get(c.recs.at(-1));
    if (!last.res) return { why: `${c.id}: rec ${c.recs.at(-1)} has no answer (${cut(last.error, 200)}): its last rec must be a call the app answered` };
    if ((c.observed.status ?? null) !== last.res.status) return { why: `${c.id}: observed.status ${c.observed.status ?? 'none'} is not ${last.res.status}, the status of its last rec ${c.recs.at(-1)}` };
  }
  const root = await fsp.realpath(t.worktree);
  const rp = await real(root, out.report);
  const text = rp ? await readPlain(rp, REPORT_MAX) : null;
  if (text === null) return { why: `report ${out.report}: not a regular file of at most 1 MB in the worktree (no link on the way)` };
  if (!/^\s*```mermaid\b/m.test(text) || !text.includes('**Verdict:**')) return { why: `report ${out.report}: it needs a \`\`\`mermaid block and a **Verdict:** line` };
  for (const s of new Set(cases.flatMap((c) => c.screenshots))) {
    if (!(await png(await real(root, s)))) return { why: `screenshot ${s}: not a PNG file over ${SHOT_MIN} bytes in the worktree (no link on the way)` };
  }
  return { recs };
}

// A failed case and its evidence for the fix session's brief (rec bodies as tbd kept them: masked, env values redacted)
function caseText(c, recs) {
  const rec = (id) => {
    const r = recs.get(id);
    return `  rec ${id} (captured by tbd): ${r.method} ${r.url} → ${r.res ? `${r.res.status}${r.res.body ? `: ${cut(r.res.body, 300)}` : ''}` : `no answer: ${r.error}`}`;
  };
  return [`- ${c.id} (${c.kind}, ${c.type}) ${c.source}: expected ${c.expect}`, `  steps: ${c.steps.join(' / ')}`,
    `  observed: ${c.observed.status !== undefined ? `status ${c.observed.status}: ` : ''}${c.observed.note}`, ...c.recs.map(rec),
    ...c.screenshots.map((s) => `  screenshot (agent-made): ${s}`)].join('\n');
}

// ---- the result handler (runner.handle, after the schema) ---------------------------------------------------------
// D-0101: the docs live in the worktree during the visit only. Its end (a taken result, or a refusal of the schema
// retry: the runner blocks on that) takes the untracked ones out once the mirror holds them (a mirror that throws: no
// delete), so no later run loads or commits one; a refusal resumed with its reason keeps them.
/** @param {any} t @param {QaResult} out */
async function handle(t, out) {
  await docs.mirror(t); // every result, refused ones too
  const r = await judge(t, out);
  if (r.reject) {
    if (t.lease?.schema_retry) await docs.clean(t);
    return r;
  }
  return { ...r, after: async () => { await r.after(); await docs.clean(t); } };
}

/** @param {any} t @param {QaResult} out → {reject} | {to, ctx, patch, after, waiting?} */
async function judge(t, out) {
  const h = await head(t);
  if (!t.qa || t.qa.head !== h) return { reject: `HEAD is ${h.slice(0, 12)}, not ${String(t.qa?.head).slice(0, 12)} where this QA began: QA never commits nor moves HEAD` };
  const env = new Set(store.listTags()[t.tag]?.env_files ?? []);
  const changed = await docs.dropDocs(t.worktree, (await spawn.dirtyPaths(t)).filter((l) => !l.startsWith('?? ') && !env.has(l.slice(3))));
  if (changed.length) return { reject: `tracked files changed during QA: ${list(changed)}: QA never edits tracked files (it writes new files under docs/verification/ only); restore them` };
  const { cases } = out;
  const bare = cases.filter((c) => (c.result === 'FAIL' || c.result === 'BLOCKED') && !c.cause).map((c) => c.id);
  if (bare.length) return { reject: `${list(bare)}: a FAIL or BLOCKED case needs cause: code, test or env` };
  const wrong = cases.filter((c) => c.cause === 'test').map((c) => c.id);
  if (wrong.length) return { reject: `${list(wrong)} have cause test: a wrong case is yours to fix: correct it, run it again and report what the app does` };
  const x = await crossCheck(t, out, h);
  if (x.why) return { reject: x.why };

  const n = t.qa.n;
  const count = (r) => cases.filter((c) => c.result === r).length;
  const qa = { n, head: h, verdict: out.verdict, pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'), report: out.report };
  // D-0092: only a backend case resting on tbd's recs alone is captured; a screenshot or a frontend / mixed case is not
  const labelled = cases.map((c) => ({ ...c, evidence: c.type === 'backend' && c.recs.length > 0 && !c.screenshots.length ? 'captured by tbd' : 'agent-made' }));
  const made = labelled.filter((c) => c.result === 'PASS' && c.evidence === 'agent-made').map((c) => c.id);
  const needReview = made.length ? [`QA ${n}: ${made.join(', ')} passed on agent-made evidence only (screenshots, notes; D-0092): it can be faked, check it by hand`] : [];
  const save = async () => {
    await fsp.mkdir(path.dirname(qaFile(t.id, n)), { recursive: true, mode: 0o700 });
    await store.writeAtomic(qaFile(t.id, n), JSON.stringify({ n, at: iso(), round: t.round, head: h, verdict: out.verdict, cases: labelled, report: out.report, findings: out.findings, need_review: needReview }, null, 2) + '\n');
  };
  const unproven = cases.filter((c) => c.result !== 'PASS');
  if (!unproven.length) return { to: 'final_gate', ctx: { qa_gate: () => true }, patch: { qa }, after: save };
  const failed = unproven.filter((c) => c.result === 'FAIL' && c.cause === 'code');
  const blocked = (why) => ({ to: 'blocked', ctx: {}, patch: { qa }, after: save, waiting: { reason: 'qa', why: cut(why, 500), since: iso() } });
  // env: no app is a blocker, never skipped; ASSISTED is not proven
  if (!failed.length || unproven.some((c) => c.result === 'BLOCKED')) return blocked(`QA ${n} not proven: ${unproven.map((c) => `${c.id} ${c.result}${c.cause ? ` (${c.cause})` : ''}`).join(', ')}`);
  const fixes = (t.fixes ?? 0) + 1;
  if (fixes > FIX_MAX) return blocked(`QA ${n}: ${failed.length} failing case(s) need fix ${fixes}, max ${FIX_MAX} per ticket; Resume from Blocked resets the count`);
  const task = `@qa${n}`;
  const brief = [`QA ${n} found ${failed.length} failing case(s) (fix ${fixes} of ${FIX_MAX}). Fix the code so each one passes, commit, return done.`, '',
    ...failed.map((c) => caseText(c, x.recs))].join('\n');
  return {
    to: 'working', ctx: { rework: () => true }, patch: { qa, fixes, work: openTask(t.work, task, h) },
    after: async () => { await save(); await journal(t.id, { t: 'task', id: task, brief }); },
  };
}

// ---- seed: a fresh session's prompt -------------------------------------------------------------------------------
async function seed(t) {
  const plan = (await planning.readPlan(t).catch(() => null)) ?? {};
  const h = await head(t);
  const r = await git(t, ['diff', '--stat', `${t.base_sha}..${h}`]);
  if (r.err) throw new Error(`git diff ${t.base_sha}..${h} in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`); // fail closed
  const tag = store.listTags()[t.tag] ?? {};
  const out = [store.renderMd(t).trimEnd(),
    '## Plan', [plan.summary ?? '(no summary)', 'acceptance:', ...(plan.acceptance ?? []).map((a) => `- ${a.id} (${a.type}): ${a.text}`),
      'tasks:', ...(plan.tasks ?? []).map((x) => `- ${x.id} (${x.type}): ${x.title}`)].join('\n'),
    '## Diff', `base: ${t.base_sha}\nHEAD: ${h}\nthe whole change: git diff ${t.base_sha}..${h}\n\n${cut(r.stdout.trim() || '(no change)')}`,
    '## App', [`qa ports (tbx req calls only these: start the app on one): ${tag.qa_ports?.join(', ') || '(none: every backend case is BLOCKED, cause env)'}`,
      `env files (tbd copied them into the worktree; never edit them): ${tag.env_files?.join(', ') || '(none)'}`,
      `database: ${tag.db === 'local' ? 'local postgres, only through postgres-irfan-axi' : 'none (the tag has no db: local): no database server'}`,
      `report: docs/verification/${iso().slice(0, 10)}-${t.id}-qa.md`].join('\n')];
  const last = (await nextN(t.id, 'qa')) - 1; // the new visit's n has no file yet
  const prev = last > 0 ? await readQa(t.id, last).catch(() => null) : null;
  const open = (prev?.cases ?? []).filter((c) => c.result !== 'PASS');
  if (open.length) out.push('## Earlier QA', `QA ${last} left these cases unproven: run each one again.\n${open.map((c) => `- ${c.id} ${c.result}${c.cause ? ` (${c.cause})` : ''} ${c.source}: ${c.expect}`).join('\n')}`);
  return out.join('\n\n') + '\n';
}

// ---- the next hook (runner.consider after the QA lock; recovery rerunGate) -----------------------------------------
async function next(t, api) {
  if (api.rerun) return { stop: true }; // Resume out of Blocked: consider starts the visit next tick (lock, then below)
  const mine = (k) => k.state === 'qa' && k.round === t.round && (k.lease?.gen ?? 0) === (t.lease?.gen ?? 0);
  const write = (fn) => store.updateTicket(t.id, (k) => {
    if (!mine(k)) throw new Stale();
    return fn(k);
  }).then(() => true, (e) => { if (e instanceof Stale) return false; throw e; });
  const block = (reason, why) => write((k) => ({ ...fsm.move(k, 'blocked', 'runner'), waiting: { reason, why: cut(why, 500), since: iso() } }));
  const tag = store.listTags()[t.tag];
  if (!tag?.path) return void (await block('config', `tag ${t.tag} has no path`));
  const db = await dbLocal(tag); // why names env keys, never values
  if (!db.ok) return void (await block('db', `DB guard: ${db.why}`));
  let h;
  try {
    await planning.copyEnv(tag, t.worktree);
    h = await head(t);
  } catch (e) {
    return void (await block('config', e.message));
  }
  const n = await nextN(t.id, 'qa');
  return (await write((k) => ({ ...k, qa: { n, head: h } }))) ? {} : undefined;
}

phases.registerHandler('code/qa', handle, seed, next);

module.exports = { handle, seed, next };
