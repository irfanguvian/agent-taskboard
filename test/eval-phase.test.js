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

test('parse: --phase picks review or qa; --packet is the review evals only; --no-ram-wait --real only', () => {
  assert.equal(E.parse(['--fake', '--phase', 'qa']).phase, 'qa');
  assert.equal(E.parse(['--fake']).phase, 'review');
  assert.throws(() => E.parse(['--fake', '--phase', 'final']), /--phase: pick from review,qa/);
  assert.throws(() => E.parse(['--fake', '--phase', 'qa', '--packet', 'x']), /--packet: the review evals only/);
  assert.equal(E.parse(['--real', '--no-ram-wait']).noRamWait, true);
  assert.throws(() => E.parse(['--fake', '--no-ram-wait']), /--no-ram-wait: --real only/);
});
