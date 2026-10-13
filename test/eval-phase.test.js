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
