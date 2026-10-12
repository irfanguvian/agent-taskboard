'use strict';
// P5b K12+RO3+M10: lib/gates/classify.js, pure. One row per rule: tbd's abort first (interrupted), top-argv spawn error
// (infra), the timer flag against base_ms (work in budget, infra over or absent for a tag check, work for a test_cmd
// without base), green on exit 0, EADDRINUSE / missing lockfile (infra), and the spoofs that stay work (exit 127 from
// sh, a self-exit 124). budgetMs is required: a call without it throws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../lib/gates/classify');
const { CLASSES } = require('../lib/gates/types');

test('K12 RO3 M10 classify: one row per rule', () => {
  const B = 60_000; // budget
  /** @type {[string, Partial<Parameters<typeof classify>[0]>, string | null][]} */
  const rows = [
    ['memory kill → interrupted, checked first (even with the timer flag)', { signalAborted: true, abortReason: 'memory', exit: null, timerFired: true }, 'interrupted'],
    ['abort wins over a spawn error (tbd killed it while it started)', { signalAborted: true, abortReason: 'cancel', spawnErr: { code: 'ENOENT' } }, 'interrupted'],
    ['shutdown kill → interrupted', { signalAborted: true, abortReason: 'shutdown', exit: 1 }, 'interrupted'],
    ['top argv spawn ENOENT → infra', { spawnErr: { code: 'ENOENT' }, exit: null }, 'infra'],
    ['exit 127 from sh (the agent named a missing command) → work', { exit: 127, tail: 'sh: jestx: command not found' }, 'work'],
    ['self-exit 124 without the timer flag → work (a timer here would be infra: no base number)', { exit: 124, check: 'unit', baseMs: null, budgetMs: B }, 'work'],
    ['timer, base ran in budget → work', { timerFired: true, exit: null, check: 'unit', baseMs: 30_000, budgetMs: B }, 'work'],
    ['timer, base took exactly the budget → work (≤)', { timerFired: true, exit: null, check: 'unit', baseMs: B, budgetMs: B }, 'work'],
    ['timer, base was over budget → infra', { timerFired: true, exit: null, check: 'unit', baseMs: 70_000, budgetMs: B }, 'infra'],
    ['timer, no base number for a tag check → infra', { timerFired: true, exit: null, check: 'typecheck', baseMs: null, budgetMs: B }, 'infra'],
    ['timer, test_cmd without base → work', { timerFired: true, exit: null, check: 'test_cmd', isTestCmd: true, baseMs: null, budgetMs: B }, 'work'],
    ['exit 0 → green', { exit: 0, tail: 'EADDRINUSE in an old log line' }, null],
    ['tail EADDRINUSE → infra', { exit: 1, tail: 'Error: listen EADDRINUSE: address already in use :::3000' }, 'infra'],
    ['missing lockfile → infra', { exit: 1, tail: 'npm error The `npm ci` command can only install with an existing package-lock.json or' }, 'infra'],
    ['any other red → work', { exit: 1, tail: 'Tests: 1 failed, 40 passed' }, 'work'],
  ];
  for (const [name, input, want] of rows) {
    const got = classify({ budgetMs: B, ...input });
    assert.equal(got, want, name);
    assert.ok(got === null || CLASSES.includes(got), `${name}: a class from types.js`);
  }
  for (const budgetMs of [undefined, 0, '60000']) {
    assert.throws(() => classify({ timerFired: true, exit: null, check: 'unit', baseMs: 1000, budgetMs: /** @type {any} */ (budgetMs) }), /budgetMs .* is required/, String(budgetMs));
  }
});
