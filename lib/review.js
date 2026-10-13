'use strict';
// review: code/review, the review fix loop (contract .omc/handoffs/m5-contract.md rev 4 C3 C4; D-0085 D-0092). tbd.js
// requires it like lib/working.js: it registers the code/review handler, seed and next hook. A fresh session reads the
// whole diff base_sha..HEAD (round 2+: also the delta since the last review and that review's findings) with the read-only
// phases/code/review/settings.json and returns a ReviewResult (lib/gates/types.js).
// Every check is code, never AI (C21): verdict = the blocking rule, round 2+ every earlier open blocking id closed or kept,
// every `where` path at HEAD or in the diff (one cat-file), no duplicate ids; caps live in the schema. A refusal is
// {reject} (runner: schema_fail, resumed once with the reason, then Blocked). The result is kept as data in review/NN.json
// (written in the move's write; agent text is never run or rendered here) and t.review {n, head, open}.
// Move: 0 blocking → qa. Blocking → fix n = t.fixes + 1 (one counter per ticket for review, QA and final fixes): the
// synthetic task @rv<n> fresh from HEAD with a brief (blocking findings + cheap LOW ones) → lib/working.js runs it (task
// gate without fail-first, then the working gate, then review again); a 4th fix → Blocked, waiting review. Resume from
// Blocked resets t.fixes (lib/fsm.js) and starts a fresh review session (next hook).
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const phases = require('./phases');
const planning = require('./planning');
const { openTask, journal, lines, head } = require('./working');
const { git: gitIn, readPlain } = require('./util');

/** @typedef {import('./gates/types').Finding} Finding @typedef {import('./gates/types').ReviewResult} ReviewResult */

const FIX_MAX = 3; // D-0092: fix sessions per ticket, review + QA + final; no config
const BLOCKS = ['CRIT', 'HIGH', 'MED'];
const SHA_RE = /^[0-9a-f]{40,64}$/;
const STAT_MAX = 8192; // a diff --stat in the seed
const iso = () => new Date().toISOString();
const cut = (s, n = STAT_MAX) => String(s ?? '').slice(0, n);
const git = (t, args, o = {}) => gitIn(t.worktree, args, { timeout: 120_000, dirs: t, ...o });
const reviewFile = (id, n) => path.join(store.ticketDir(id), 'review', `${String(n).padStart(2, '0')}.json`);

/** The one blocking rule (C3; the final review reuses it; prompt.md states it word for word): severity CRIT, HIGH or MED
 * AND confidence high AND id not in closed. @param {Finding} f @param {{id: string}[]} [closed] */
const blocking = (f, closed = []) => BLOCKS.includes(f.severity) && f.confidence === 'high' && !closed.some((c) => c.id === f.id);

const findingText = (f) => `- ${f.id} ${f.severity} (${f.confidence}) ${f.where}: ${f.problem}\n  fails when: ${f.failure_scenario}\n  fix: ${f.fix}`;

// review/NN.json (this module writes them): opened O_NOFOLLOW, a plain file ≤ 1 MB, else null
async function readReview(id, n) {
  const text = Number.isInteger(n) ? await readPlain(reviewFile(id, n), 1 << 20) : null;
  return text === null ? null : JSON.parse(text);
}
async function nextN(id) {
  const names = await fsp.readdir(path.join(store.ticketDir(id), 'review')).catch(() => []);
  return Math.max(0, ...names.map((f) => Number(/^(\d+)\.json$/.exec(f)?.[1] ?? 0))) + 1;
}

// The `where` paths that are neither at HEAD nor at base_sha (= not in base..HEAD: a path the diff deleted is at base):
// one `cat-file --batch-check`, two object names per path. The schema already refused absolute paths, `..` and control
// characters (a newline would split the batch).
async function unknownPaths(t, h, findings) {
  const paths = [...new Set(findings.map((f) => f.where.replace(/:\d+(?:-\d+)?$/, '')))];
  if (!paths.length) return [];
  if (!SHA_RE.test(t.base_sha ?? '')) throw new Error('ticket.base_sha missing or not a sha');
  const r = await git(t, ['cat-file', '--batch-check'], { input: paths.flatMap((p) => [`${h}:${p}`, `${t.base_sha}:${p}`]).join('\n') + '\n' });
  if (r.err) throw new Error(`git cat-file in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`);
  const out = r.stdout.split('\n');
  return paths.filter((_, i) => out[2 * i]?.endsWith(' missing') && out[2 * i + 1]?.endsWith(' missing'));
}

// ---- the result handler (runner.handle, after the schema) ---------------------------------------------------------
/** @param {any} t @param {ReviewResult} out */
async function handle(t, out) {
  for (const [name, list] of /** @type {[string, {id: string}[]][]} */ ([['findings', out.findings], ['closed', out.closed]])) {
    const ids = list.map((x) => x.id);
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) return { reject: `${dup} appears twice in ${name}: one entry per id` };
  }
  // a closed id must be an earlier open one (or in the last findings) and not also a finding: else a HIGH could dodge the rule
  const last = t.review ? await readReview(t.id, t.review.n).catch(() => null) : null;
  const known = new Set([...(t.review?.open ?? []), ...(last?.findings ?? []).map((f) => f.id)]);
  const bad = out.closed.find((c) => out.findings.some((f) => f.id === c.id) || !known.has(c.id));
  if (bad) return { reject: `${bad.id} in closed: close only an earlier finding, and not one that is also in findings (keep it open there instead)` };
  const block = out.findings.filter((f) => blocking(f, out.closed));
  const want = block.length ? 'block' : 'pass';
  if (out.verdict !== want) {
    return { reject: `verdict must be ${want}: ${block.length ? `${block.map((f) => f.id).join(', ')} block` : 'no finding blocks'} (a finding blocks when its severity is CRIT, HIGH or MED AND its confidence is high AND its id is not in closed)` };
  }
  const listed = new Set([...out.findings, ...out.closed].map((x) => x.id));
  const dropped = (t.review?.open ?? []).filter((id) => !listed.has(id));
  if (dropped.length) return { reject: `earlier blocking finding ${dropped.join(', ')} dropped: close each one in closed (how it was fixed) or keep it in findings with the same id` };
  const h = await head(t);
  const unknown = await unknownPaths(t, h, out.findings);
  if (unknown.length) return { reject: `where names a path that is neither at HEAD nor in the diff: ${unknown.slice(0, 10).join(', ')}` };

  const n = await nextN(t.id);
  const review = { n, head: h, open: block.map((f) => f.id) };
  const save = async () => {
    await fsp.mkdir(path.dirname(reviewFile(t.id, n)), { recursive: true, mode: 0o700 });
    await store.writeAtomic(reviewFile(t.id, n), JSON.stringify({ n, at: iso(), round: t.round, head: h, ...out }, null, 2) + '\n');
  };
  if (!block.length) return { to: 'qa', ctx: { no_blocking: () => true }, patch: { review }, after: save };
  const fixes = (t.fixes ?? 0) + 1;
  if (fixes > FIX_MAX) {
    return { to: 'blocked', ctx: {}, patch: { review }, after: save, waiting: { reason: 'review', why: `review ${n}: ${block.length} blocking finding(s) need fix ${fixes}, max ${FIX_MAX} per ticket; Resume from Blocked resets the count`, since: iso() } };
  }
  const task = `@rv${n}`;
  const cheap = out.findings.filter((f) => f.severity === 'LOW' && f.cheap);
  const brief = [`Review ${n} found ${block.length} blocking finding(s) (fix ${fixes} of ${FIX_MAX}). Fix each one, commit, return done.`, '', ...block.map(findingText),
    ...(cheap.length ? ['', 'Also fix these small ones while you are there:', ...cheap.map(findingText)] : [])].join('\n');
  return {
    to: 'working', ctx: { rework: () => true }, patch: { review, fixes, work: openTask(t.work, task, h) },
    after: async () => { await save(); await journal(t.id, { t: 'task', id: task, brief }); },
  };
}

// ---- seed: a fresh session's prompt -------------------------------------------------------------------------------
async function seed(t) {
  const plan = (await planning.readPlan(t).catch(() => null)) ?? {};
  const h = await head(t);
  const stat = async (from, soft) => { // soft: the delta since a head the repo no longer has says so (the whole-diff stat fails closed)
    const r = await git(t, ['diff', '--stat', `${from}..${h}`]);
    if (r.err && soft) return `(the last review head is not in this repo: read the whole diff; git: ${cut(r.stderr || r.err.message, 200)})`;
    if (r.err) throw new Error(`git diff ${from}..${h} in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`); // fail closed, never "(no change)"
    return cut(r.stdout.trim() || '(no change)');
  };
  const out = [store.renderMd(t).trimEnd(),
    '## Plan', [plan.summary ?? '(no summary)', 'acceptance:', ...(plan.acceptance ?? []).map((a) => `- ${a.id} (${a.type}): ${a.text}`),
      'tasks:', ...(plan.tasks ?? []).map((x) => `- ${x.id} (${x.type}): ${x.title}`)].join('\n'),
    '## Diff', `base: ${t.base_sha}\nHEAD: ${h}\nthe whole change: git diff ${t.base_sha}..${h}\n\n${await stat(t.base_sha)}`];
  // what the gates left for review (working.js journal `review` lines: flaky checks, unproven fail-first) + the last
  // working gate's extras
  const notes = (await lines(t.id)).filter((l) => l.t === 'review').map((l) => `- ${l.task ?? 'working gate'}: ${[l.flaky?.length && `flaky ${l.flaky.join(', ')}`,
    String(l.failfirst ?? '').startsWith('unproven') && `fail-first ${l.failfirst}`].filter(Boolean).join('; ')}`);
  const gn = t.work?.gate?.n;
  const g = Number.isInteger(gn) ? await readPlain(path.join(store.ticketDir(t.id), 'gates', `${String(gn).padStart(2, '0')}.json`), 1 << 20).then((x) => x && JSON.parse(x), () => null) : null;
  const list = (v) => (v?.length ? v.join(', ') : '(none)');
  if (g) {
    notes.push(`- expectations removed: ${list(g.tests?.expects_removed)}`, `- protected files changed (Irfan allowed): ${list(g.scope?.protected?.map((p) => p.path))}`,
      `- allowed schema/API changes used: ${list([...(g.schema ?? []), ...(g.api ?? [])].filter((c) => c.allowed).map((c) => `${c.op} ${c.ref}`))}`);
  }
  out.push('## Gate notes', notes.join('\n') || '(none)');
  if (t.review) { // round 2+
    const last = await readReview(t.id, t.review.n).catch(() => null);
    const open = new Set(t.review.open ?? []);
    out.push('## Earlier findings', `open blocking ids: ${list([...open])}\n${(last?.findings ?? []).map((f) => `${findingText(f)}${open.has(f.id) ? '\n  blocking: close it or keep it' : ''}`).join('\n') || (last ? '(none)' : '(review file unreadable)')}`);
    const delta = SHA_RE.test(t.review.head ?? '') ? `last review at: ${t.review.head}\nthe delta: git diff ${t.review.head}..${h}\n\n${await stat(t.review.head, true)}` : '(last review head unknown)';
    out.push('## Since the last review', `${delta}\n\nClose each earlier blocking id in closed, or keep it open in findings with the same id.`);
  }
  return out.join('\n\n') + '\n';
}

// Resume from Blocked (api.rerun): a fresh session, never the old one (it returned its result already). T1: {} = fresh.
const next = async (_t, api) => (api.rerun ? { fresh: true } : {});

phases.registerHandler('code/review', handle, seed, next);

module.exports = { FIX_MAX, blocking, handle, seed, next };
