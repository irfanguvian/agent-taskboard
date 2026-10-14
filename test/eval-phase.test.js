'use strict';
// scripts/eval-phase.js scoring (M5.1 review evals E1-E3): each case's example result passes its scripted checks; a
// result that misses the point fails the matching check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../scripts/eval-phase');

const fails = (c, result) => E.score(c, { accepted: true, why: '', result }).filter((x) => !x.ok).map((x) => x.name);

test('score: the example of E1-E3 passes; a wrong line, a too-low severity, an invented finding, a dropped close fail', () => {
  const [e1, e2, e3] = E.CASES.map(E.loadCase);
  for (const c of [e1, e2, e3]) assert.deepEqual(fails(c, c.example), [], c.key);
  const f1 = e1.example.findings[0];
  assert.deepEqual(fails(e1, { ...e1.example, findings: [{ ...f1, where: 'src/users/users.service.ts:30' }] }), ['an open HIGH high-confidence finding at src/users/users.service.ts:18-27']);
  assert.deepEqual(fails(e1, { ...e1.example, findings: [{ ...f1, severity: 'MED' }] }), ['an open HIGH high-confidence finding at src/users/users.service.ts:18-27']);
  assert.deepEqual(fails(e2, { ...e2.example, findings: [f1] }), ['at most 0 finding(s)']);
  assert.deepEqual(fails(e3, { ...e3.example, closed: [], findings: [...e3.example.findings, e3.prior.review.findings[0]] }), ['F1 closed, not kept open']);
  assert.equal(E.score(e2, { accepted: false, why: 'refused', result: null })[0].ok, false);
  assert.deepEqual(E.parseWhere('src/a.ts:3-9'), { path: 'src/a.ts', lo: 3, hi: 9 });
  assert.equal(E.parseWhere('src/a.ts'), null);
});

// M5.2 QA evals: what tbd kept (rec lines from each case's fake routes, the ticket as the handler leaves it, the changed
// files' line counts at HEAD) against each case's example; a forged rec, a source outside the diff, a pass among blocked
// cases, a FAIL put on env fail the matching check.
const LINES = { 'src/users/users.service.ts': 37, 'src/users/users.dto.ts': 25, 'src/users/users.service.spec.ts': 23 };
function qaRun(c, result, ticket = undefined) {
  const e = c.expect;
  return {
    accepted: true, why: '', result, lines: LINES,
    recs: c.fake.map(([u, status, body], i) => ({ n: `1.${i + 1}`, method: 'GET', url: `http://127.0.0.1:4000${u}`, res: { status, body: JSON.stringify(body) } })),
    ticket: ticket ?? { state: e.state, waiting: e.waiting ? { reason: e.waiting } : null, fixes: e.fix ? 1 : 0, work: { tasks: [{ id: 'T1' }, ...(e.fix ? [{ id: e.fix }] : [])] } },
  };
}
const qaFails = (c, result, ticket = undefined) => E.scoreQa(c, qaRun(c, result, ticket)).filter((x) => !x.ok).map((x) => x.name);

test('scoreQa: the example of QA E1-E3 passes; a rec tbd never recorded, a source outside the diff, a PASS in E2, a FAIL on env in E3 fail', () => {
  const [q1, q2, q3] = E.CASES.map((k) => E.caseOf('qa', k));
  for (const c of [q1, q2, q3]) assert.deepEqual(qaFails(c, c.example), [], c.key);
  const [a, b] = q1.example.cases;
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [a, { ...b, recs: ['1.9'] }] }), ['every cited rec is a call tbd recorded for this ticket; a PASS/FAIL case\'s status = its last rec']);
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [{ ...a, observed: { status: 404, note: '' } }, b] }), ['every cited rec is a call tbd recorded for this ticket; a PASS/FAIL case\'s status = its last rec']);
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [{ ...a, source: 'src/users/users.service.ts:30-40' }, b] }),
    ['every source is a plan acceptance id or a changed path:line inside the file at HEAD', '1+ case source is a changed path:line']);
  assert.deepEqual(qaFails(q2, { ...q2.example, cases: [{ ...q2.example.cases[0], result: 'PASS', cause: undefined }, q2.example.cases[1]] }), ['no PASS: every case BLOCKED or ASSISTED, a BLOCKED one cause env']);
  const [f, p] = q3.example.cases;
  assert.deepEqual(qaFails(q3, { ...q3.example, cases: [{ ...f, cause: 'env' }, p] }), ['a FAIL cause code case cites a recorded GET /users 200 with latestOrder in the body']);
  assert.deepEqual(qaFails(q3, q3.example, { state: 'blocked', waiting: { reason: 'qa' }, fixes: 0, work: { tasks: [{ id: 'T1' }] } }), ['ticket stops in working', 'fix task @qa1 opened (fix 1)']);
  assert.equal(E.scoreQa(q2, { ...qaRun(q2, null), accepted: false, why: 'refused' })[0].ok, false);
});

// M5.3 final review evals: what tbd kept (final/01.json = the example, the ticket as the handler leaves it, the mirrored
// docs with tbd's evidence section, the squash facts from git) against each case's example; an invented blocking
// finding, a rec missing from the evidence, a squash on two parents, a verdict doc without its work-done part, a HIGH
// where CRIT is due, a block that never names the unproven acceptance, a title over 120 fail the matching check.
const EVIDENCE = (c) => ['## Evidence (captured by tbd)', ...c.qa.cases.map((x) => `| ${x.id} | ${x.kind} | PASS | captured by tbd |`),
  ...c.recs.map((_, i) => `#### rec 1.${i + 1}\n\n\`\`\`\ncurl 'http://127.0.0.1:50461/orders'\n\`\`\``), '### Final checks', '(none)'].join('\n');
function finalRun(c, over = {}) {
  const e = c.expect;
  return {
    accepted: true, why: '', result: c.example, gate: { n: 1, ok: true, checks: [] }, base: 'b0', tested: 'h1',
    ticket: { state: e.state, waiting: e.waiting ? { reason: e.waiting } : null, fixes: e.fix ? 1 : 0, final: { tested_sha: 'h1' }, work: { tasks: [{ id: 'T1' }, ...(e.fix ? [{ id: e.fix }] : [])] } },
    report: `${c.docs.verdict}\n\n${EVIDENCE(c)}`, verification: c.docs.verification, summaryMd: '**Title:** x',
    git: { sha: 's1', head: 's1', branch: 's1', parents: ['b0'], tree: 'T', testedTree: 'T', pre: 'h1', subject: c.example.summary.title }, ...over,
  };
}
const finalFails = (c, over = {}) => E.scoreFinal(c, finalRun(c, over)).filter((x) => !x.ok).map((x) => x.name);

test('scoreFinal: the example of final E1-E3 passes; an invented block, a lost rec, a two-parent squash, no work done, HIGH for CRIT, an unnamed gap, a long title fail', () => {
  const [f1, f2, f3] = E.CASES.map((k) => E.caseOf('final_gate', k));
  for (const c of [f1, f2, f3]) assert.deepEqual(finalFails(c), [], c.key);
  const x1 = f1.example;
  const F = { id: 'F1', severity: 'MED', confidence: 'high', where: 'src/orders/orders.dto.ts:39', problem: 'no auth on POST /orders', failure_scenario: 'anyone posts', fix: 'add auth' };
  assert.deepEqual(finalFails(f1, { result: { ...x1, findings: [F] } }), ['no blocking finding (CRIT, HIGH or MED with high confidence)']);
  assert.deepEqual(finalFails(f1, { report: `${f1.docs.verdict}\n\n${EVIDENCE(f1).replace('#### rec 1.7\n', '')}` }),
    ['tbd appended "## Evidence (captured by tbd)" to the mirrored verdict doc: every QA case, every rec as curl, the final checks']);
  assert.deepEqual(finalFails(f1, { git: { ...finalRun(f1).git, parents: ['b0', 'h1'] } }),
    ['squash: HEAD + branch = final.sha, one commit on base, the tested tree, final-pre-<n> = tested, subject = summary title']);
  assert.deepEqual(finalFails(f1, { report: `${f1.docs.verdict.replace('All work done', 'Tasks')}\n\n${EVIDENCE(f1)}` }),
    ['verdict doc: Verdict + a line per phase + all work done + changes before → after']);
  assert.deepEqual(finalFails(f1, { result: { ...x1, summary: { ...x1.summary, title: 'x'.repeat(121) } } }),
    ['summary: the 6 fields (title ≤ 120, description ≤ 600, worked_on 1..15, blocker, need_review, verdict)', 'squash: HEAD + branch = final.sha, one commit on base, the tested tree, final-pre-<n> = tested, subject = summary title']);
  assert.deepEqual(finalFails(f2, { result: { ...f2.example, findings: [{ ...f2.example.findings[0], severity: 'HIGH' }] } }),
    ['a CRIT high-confidence finding at src/orders/orders.service.ts:19-23 or src/orders/orders.controller.ts:18-24']);
  assert.deepEqual(finalFails(f3, { result: { ...f3.example, findings: [{ ...F, problem: 'README row is stale', failure_scenario: 'a reader is misled', fix: 'reword it' }] } }),
    ['a blocking finding names the unproven acceptance (/\\bA1\\b|10[ _,.]?000[ _,.]?001|above the max/i)']);
  assert.equal(E.scoreFinal(f2, { ...finalRun(f2), accepted: false, why: 'refused' })[0].ok, false);
});

test('parse: --phase picks review, qa or final_gate; --packet is the review evals only; --no-ram-wait --real only', () => {
  assert.equal(E.parse(['--fake', '--phase', 'final_gate']).phase, 'final_gate');
  assert.equal(E.parse(['--fake', '--phase', 'qa']).phase, 'qa');
  assert.equal(E.parse(['--fake']).phase, 'review');
  assert.throws(() => E.parse(['--fake', '--phase', 'final']), /--phase: pick from review,qa/);
  assert.throws(() => E.parse(['--fake', '--phase', 'qa', '--packet', 'x']), /--packet: the review evals only/);
  assert.equal(E.parse(['--real', '--no-ram-wait']).noRamWait, true);
  assert.throws(() => E.parse(['--fake', '--no-ram-wait']), /--no-ram-wait: --real only/);
});
