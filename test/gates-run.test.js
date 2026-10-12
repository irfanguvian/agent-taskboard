'use strict';
// P5b-run pure parts: the fail-first adapters (jest, node:test, vitest summaries; contract K7, spike jest table), the
// glob → SBPL regex of the profile's deny lists (K5 F4), and the RAM rule that nothing under lib/gates/ loads at boot.
// The sandboxed runner itself: gates-gate.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summary } = require('../lib/gates/task');
const { globRe } = require('../lib/gates/run');

const ESC = String.fromCharCode(27);

test('K7 adapters: jest pass / fail / mixed / suite failed to run / no tests (spike lines), ANSI stripped first', () => {
  assert.deepEqual(summary('PASS src/a.spec.ts\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total\n'), { total: 3, failed: 0, compile: false });
  assert.deepEqual(summary('Tests:       1 failed, 1 skipped, 1 todo, 1 passed, 4 total\n'), { total: 4, failed: 1, compile: false });
  const compile = `  ● Test suite failed to run\n\n    ${ESC}[96msrc/a.ts${ESC}[0m:1:63 - error TS1005: ';' expected.\n\nTests:       0 total\n`;
  assert.deepEqual(summary(compile), { total: 0, failed: 0, compile: true });
  assert.deepEqual(summary('No tests found, exiting with code 1\nPattern: test/users.e2e-spec.ts - 0 matches\n'), { noTests: true });
  assert.deepEqual(summary('  ● Test suite failed to run\n    Your test suite must contain at least one test.\nTests:       0 total\n'), { noTests: true });
});

test('K7 adapters: node:test (spec ℹ and tap #) and vitest summaries; unknown output → null (unproven_unparsed)', () => {
  assert.deepEqual(summary('✖ a (1ms)\nℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\n'), { total: 2, failed: 1, compile: false });
  assert.deepEqual(summary('# tests 1\n# pass 0\n# fail 1\nSyntaxError: Unexpected token\n'), { total: 1, failed: 1, compile: true });
  assert.deepEqual(summary('ℹ tests 0\nℹ fail 0\n'), { noTests: true });
  assert.deepEqual(summary(' Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n'), { total: 3, failed: 1, compile: false });
  assert.deepEqual(summary(' FAIL  a.test.ts [ a.test.ts ]\n Test Files  1 failed (1)\n      Tests  no tests\n'), { total: 0, failed: 0, compile: true });
  assert.deepEqual(summary('No test files found, exiting with code 1\n'), { noTests: true });
  assert.equal(summary('Segmentation fault\n'), null);
  assert.equal(summary(''), null);
});

test('K5 deny globs → SBPL regex: * one part, ** any depth (zero too), [class] kept, dots escaped; a non-match stays out', () => {
  const re = (g) => new RegExp(`^${globRe(g)}(/.*)?$`);
  assert.ok(re('/h/.claude*').test('/h/.claude.json') && re('/h/.claude*').test('/h/.claude/settings.json'));
  assert.ok(!re('/h/.claude*').test('/h/xclaude') && !re('/h/.claude*').test('/h/a/.claude'));
  assert.ok(re('/w/**/CLAUDE.md').test('/w/CLAUDE.md') && re('/w/**/CLAUDE.md').test('/w/a/b/CLAUDE.md'));
  assert.ok(re('/w/node_modules/[a-zA-Z0-9@_~+-]*').test('/w/node_modules/left-pad/index.js'));
  assert.ok(!re('/w/node_modules/[a-zA-Z0-9@_~+-]*').test('/w/node_modules/.cache/x'), 'dot dirs stay out of the class');
  assert.ok(!re('/w/a.b').test('/w/axb'), '. is literal');
  assert.throws(() => globRe('/w/[abc'), /unclosed/);
});

test('RAM: no lib/gates module is loaded by what tbd requires at boot (working, planning, runner, doctor, metrics, monitor, tbx)', () => {
  const REPO = path.join(__dirname, '..');
  const code = `for (const m of ['store', 'working', 'planning', 'runner', 'doctor', 'metrics', 'monitor', 'tbx', 'slots']) require('./lib/' + m);
    process.stdout.write(String(Object.keys(require.cache).filter((k) => k.includes('/lib/gates/')).length));`;
  const env = { ...process.env, TB_HOME: path.join(require('node:os').tmpdir(), 'gates-run-no-home') };
  assert.equal(execFileSync(process.execPath, ['-e', code], { cwd: REPO, env, encoding: 'utf8' }), '0');
  const after = `require('./lib/gates'); process.stdout.write(String(Object.keys(require.cache).some((k) => k.includes('/lib/gates/run.js'))));`;
  assert.equal(execFileSync(process.execPath, ['-e', after], { cwd: REPO, env, encoding: 'utf8' }), 'true', 'positive control: the entry loads the runner');
});
