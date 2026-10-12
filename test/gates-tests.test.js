'use strict';
// P5b M5+N7 K7 R2: lib/gates/tests.js, pure. scan(): skip/only/todo/focus markers added per file (one already at pre is
// no add; jest, vitest, node:test forms), deleted files echoed, the it/test count per path (a drop in one file is never
// hidden by tests added in another; comments and strings don't count), removed expect( lines listed. isTestFile():
// tag test_globs minus protected (protected wins). missingNames(): K7 proven_missing names from a failing run's log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scan, globs, isTestFile, missingNames, trailers } = require('../lib/gates/tests');
const { DEFAULTS } = require('../lib/tags');

const F = 'test/users.e2e-spec.ts';
const PRE = `describe('users', () => {
  it('lists', () => {
    expect(list()).toHaveLength(20);
  });
  test('pages', () => {
    expect(page(2).items).toEqual([]);
  });
  it.each([1, 2])('limit %d', () => {});
  it.${'skip'}('legacy', () => {});
});
`; // fixture text for the scanner; a literal skip line here trips the repo's skipped-test guard
const NT = "test('subtests', async (t) => {\n  await t.test('a', () => {});\n  await t.test('b', () => {});\n  expect(/x/.test(y)).toBe(true);\n});\n"; // node:test
const swap = (from, to) => {
  assert.ok(PRE.includes(from), from);
  return PRE.replace(from, to);
};

test('M5 N7 scan: one row per rule', () => {
  const none = { skips_added: [], deleted: [], expects_removed: [], count: { pre: 3, head: 3 }, count_drops: [] };
  /** @type {[string, Record<string, string>, Record<string, string>, string[], Partial<ReturnType<typeof scan>>][]} */
  const rows = [
    ['unchanged: the .skip already at pre is no add', { [F]: PRE }, { [F]: PRE }, [], {}],
    ['a test turned .skip: marker + per-file drop', { [F]: PRE }, { [F]: swap("it('lists'", "it.skip('lists'") }, [],
      { skips_added: [`${F}: .skip`], count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`] }],
    ['jest/vitest markers each named', { [F]: PRE },
      { [F]: `${PRE}describe.only('a', () => {});\nxit('b');\nxtest('c');\nxdescribe('d', () => {});\nfdescribe('e', () => {});\ntest.skipIf(ci)('f');\nit.runIf(ci)('g');\nit.fails('h');\n` }, [],
      { skips_added: ['.only', '.skipIf', '.runIf', '.fails', 'xit', 'xtest', 'xdescribe', 'fdescribe'].map((m) => `${F}: ${m}`), count: { pre: 3, head: 3 } }],
    ['jest fit: a focus added', { [F]: PRE }, { [F]: swap("test('pages'", "fit('pages'") }, [],
      { skips_added: [`${F}: fit`], count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`] }],
    ['todo forms: it.todo, test.todo, t.todo', { [F]: PRE }, { [F]: `${PRE}it.todo('a');\ntest('b', (t) => { t.todo(); });\n` }, [],
      { skips_added: [`${F}: .todo`], count: { pre: 3, head: 4 } }],
    ['node:test options: { skip: true }, { todo: "why" }, t.skip()', { [F]: PRE },
      { [F]: swap("test('pages', () => {", "test('pages', { skip: true }, () => {") + "it('x', { todo: 'later' }, (t) => { t.skip(); });\n" }, [],
      { skips_added: [`${F}: .skip`, `${F}: { skip }`, `${F}: { todo }`], count: { pre: 3, head: 4 } }],
    ['node:test { skip: false } is no marker', { [F]: PRE }, { [F]: swap("test('pages', () => {", "test('pages', { skip: false }, () => {") }, [], {}],
    ['a line-commented test leaves the count; its expect is listed', { [F]: PRE }, { [F]: swap("  it('lists', () => {\n    expect(list()).toHaveLength(20);\n  });\n", "  // it('lists', () => {\n  //   expect(list()).toHaveLength(20);\n  // });\n") }, [],
      { count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`], expects_removed: [`${F}: expect(list()).toHaveLength(20);`] }],
    ['a block-commented test leaves the count', { [F]: PRE }, { [F]: swap("  test('pages', () => {", "  /* test('pages', () => {").replace('  });\n  it.each', '  }); */\n  it.each') }, [],
      { count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`], expects_removed: [`${F}: expect(page(2).items).toEqual([]);`] }],
    ['per path: a drop in file B is not hidden by tests added in file A', { [F]: PRE }, { [F]: swap("  it.each([1, 2])('limit %d', () => {});\n", ''), 'test/a.test.ts': "it('n', () => {});\n" }, [],
      { count: { pre: 3, head: 3 }, count_drops: [`${F}: 3 → 2`] }],
    ['it( inside a string or re.test( is no test', { [F]: PRE }, { [F]: swap("  it.each([1, 2])('limit %d', () => {});\n", "  const s = \"it( test( it(\";\n  /x/.test('it(');\n") }, [],
      { count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`] }],
    ["a regex holding a quote can't hide a marker (raw text counts too)", { [F]: PRE }, { [F]: `${PRE}if (x) /'/.test(y); it.only('z', () => {}); const q = /'/;\n` }, [],
      { skips_added: [`${F}: .only`], count: { pre: 3, head: 3 } }],
    ['a deleted test file: listed, its tests and expects leave', { [F]: PRE, 'test/orders.test.ts': "it('x', () => { expect(1).toBe(1); });\n" }, { [F]: PRE }, ['test/orders.test.ts'],
      { deleted: ['test/orders.test.ts'], count: { pre: 4, head: 3 }, count_drops: ['test/orders.test.ts: 1 → 0'], expects_removed: ["test/orders.test.ts: it('x', () => { expect(1).toBe(1); });"] }],
    ["a regex holding /* after ) can't hide a marker (T1)", { [F]: PRE }, { [F]: `${PRE}if (s) /\\/*/.test(s);\nit.${'only'}('c', () => {});\n// */\n` }, [],
      { skips_added: [`${F}: .only`] }], // the count reads the desynced code-only view: the marker is the catch
    ['a comment naming a marker is no marker', { [F]: PRE }, { [F]: `${PRE}// TODO: use test.todo, never it.only\n` }, [], {}],
    ['ordinary code is no marker: dto.skip, item.todo, run.fails, chart.fit(), a ".only" string, a .only comment', { [F]: PRE },
      { [F]: `${PRE}expect(q.skip).toBe(10);\nexpect(item.todo).toBe(true);\nexpect(run.fails).toBe(0);\nchart.fit();\nexpect(label).toBe('.only');\n// never use .only here\n` }, [], {}],
    ['a chained modifier is a marker: describe.concurrent.only', { [F]: PRE }, { [F]: `${PRE}describe.concurrent.${'only'}('c', () => {});\n` }, [], { skips_added: [`${F}: .only`] }],
    ['a node:test subtest t.test(title, fn) removed → drop', { [F]: NT }, { [F]: NT.replace("  await t.test('b', () => {});\n", '') }, [],
      { count: { pre: 3, head: 2 }, count_drops: [`${F}: 3 → 2`] }],
    ['a re.test(y) line removed → no drop', { [F]: NT }, { [F]: NT.replace("  expect(/x/.test(y)).toBe(true);\n", '') }, [],
      { count: { pre: 3, head: 3 }, expects_removed: [`${F}: expect(/x/.test(y)).toBe(true);`] }],
    ['test.concurrent removed → drop', { [F]: `${PRE}test.concurrent('c', async () => {});\n` }, { [F]: PRE }, [], { count: { pre: 4, head: 3 }, count_drops: [`${F}: 4 → 3`] }],
    ['an expect edited (trap C: only the nickname line) is listed, never a drop', { [F]: PRE }, { [F]: swap('toHaveLength(20)', 'toHaveLength(50)') }, [],
      { expects_removed: [`${F}: expect(list()).toHaveLength(20);`] }],
    ["a computed marker describe['skip'](…) is a marker (no dotted form names it)", { [F]: PRE }, { [F]: `${PRE}describe['${'skip'}']('c', () => {});\n` }, [],
      { skips_added: [`${F}: [key]`] }],
    ['an empty table it.each([]) is a marker: the test is counted, never runs', { [F]: PRE }, { [F]: `${PRE}it.each([])('c', () => {});\n` }, [],
      { skips_added: [`${F}: .each([])`], count: { pre: 3, head: 4 } }],
    ['indexing near a test word is no marker: items[0], testCases[1], it.each([[1]])', { [F]: PRE }, { [F]: `${PRE}expect(items[0]).toEqual(testCases[1]);\nit.each([[1]])('one', () => {});\n` }, [],
      { count: { pre: 3, head: 4 } }],
  ];
  for (const [name, pre, head, deleted, want] of rows) assert.deepEqual(scan({ pre, head, deleted }), { ...none, ...want }, name);
});

test('M5 scan stays linear on hostile blobs (the child has 30 s): each < 1000 ms', () => {
  const { performance } = require('node:perf_hooks');
  /** @type {[string, string, number][]} */
  const rows = [
    ['t. ×20k (40 KB; unbounded regexes took 16 s here)', 't.'.repeat(20_000), 200], // small first: an unbounded mutant fails fast
    ['it(,{ ×8k (40 KB)', 'it(,{'.repeat(8_000), 200],
    ['t. ×2.5M (5 MB)', 't.'.repeat(2_500_000), 1000],
    ['it(,{ ×1M (5 MB)', 'it(,{'.repeat(1_000_000), 1000],
    ['describe.a.a…only (2 MB chain)', `describe${'.a'.repeat(1_000_000)}.only`, 1000],
  ];
  for (const [name, blob, max] of rows) {
    const t0 = performance.now();
    scan({ pre: {}, head: { [F]: blob } });
    const ms = performance.now() - t0;
    assert.ok(ms < max, `${name}: ${Math.round(ms)} ms`);
  }
});

test('D34 trailers: an AI attribution on a co-authored-by line (any case) or "Generated with"; linear on a hostile 576 KB message', () => {
  const log = (...msgs) => msgs.map((m, i) => `${String(i).repeat(40)} ${m}\0`).join('');
  assert.deepEqual(trailers(log('fix\n\nco-authored-by: CLAUDE <x>', 'feat\n\nCo-Authored-By: Bob\nClaude helped', 'docs\n\nGenerated with Claude Code', 'plain')), ['000000000000', '222222222222']);
  const { performance } = require('node:perf_hooks');
  const t0 = performance.now();
  trailers(log('Co-Authored-By: x '.repeat(32_000))); // the regex form: 10 s
  assert.ok(performance.now() - t0 < 100, `${Math.round(performance.now() - t0)} ms`);
});

test('K7 R2 isTestFile: default test_globs, protected wins', () => {
  const T = [...DEFAULTS.test_globs];
  const P = [...DEFAULTS.protected];
  /** @type {[string, boolean][]} */
  const rows = [
    ['src/users/users.service.spec.ts', true],
    ['test/users.e2e-spec.ts', true],
    ['__tests__/a.js', true],
    ['src/users/users.service.ts', false],
    ['test/utils/query-counter.ts', false], // test/** matches, protected test/utils/** wins
    ['test/helpers/db.ts', false],
    ['jest.config.test.js', false], // **/*.test.* matches, protected jest.config.* wins
  ];
  for (const [p, want] of rows) assert.equal(isTestFile(p, T, P), want, p);
  assert.equal(isTestFile('test/utils/query-counter.ts', T, []), true, 'with no protected globs it is a test file');
  // review 2b: APFS reads TSConfig.json as tsconfig.json → protected / test globs ignore case; generated (widens scope) doesn't
  assert.deepEqual([globs(P)('TSConfig.json'), isTestFile('src/Foo.TEST.ts', T, P), globs(['src/generated/*'], false)('SRC/generated/x.ts')], [true, true, false]);
});

test('K7 rev 4.1 missingNames: the names a run at pre says are missing, ANSI stripped; other failures name nothing', () => {
  /** @type {[string, string, string[]][]} */
  const rows = [
    ['TS2305 (ts-jest, coloured)', "src/a.spec.ts:1:10 - \x1b[91merror\x1b[0m\x1b[90m TS2305: \x1b[0mModule '\"./pagination\"' has no exported member 'brandNewFn'.", ['brandNewFn']],
    ['TS2307', "error TS2307: Cannot find module './brand-new-module' or its corresponding type declarations.", ['./brand-new-module']],
    ['TS2339', "error TS2339: Property 'countQueries' does not exist on type 'typeof import(\"./db\")'.", ['countQueries']],
    ['jest CJS resolver', "Cannot find module './users.repo' from 'src/users/users.service.spec.ts'", ['./users.repo']],
    ['ESM missing export (spike)', "SyntaxError: The requested module './pagination.js' does not provide an export named 'brandNewFn'", ['brandNewFn']],
    ['jest moduleNameMapper (spike)', 'Configuration error:\n\nCould not locate module ./brand-new-module.js mapped as:', ['./brand-new-module.js']],
    ['is not a function, both forms, deduped', 'TypeError: svc.latestOrder is not a function\nTypeError: (0 , _users.latestOrder) is not a function', ['latestOrder']],
    ['an assertion failure names nothing', 'expect(received).toBe(expected)\nExpected: 6\nReceived: 51\nTests:       1 failed, 1 total', []],
    ['a syntax error names nothing', "  ● Test suite failed to run\nsrc/a.spec.ts:1:63 - error TS1005: ';' expected.", []],
  ];
  for (const [name, out, want] of rows) assert.deepEqual(missingNames(out), want, name);
});
