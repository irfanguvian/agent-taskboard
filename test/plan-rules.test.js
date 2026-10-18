'use strict';
// P4e (contract J15 J16 J17 J18): lib/plan-rules.js against a real temp git repo (package.json scripts, src/, an ADR):
// a valid plan and a valid questions result pass, all path checks in ONE `git cat-file --batch-check` (counted through
// the injected git); one negative per rule group → its exact reason, nothing else fires. hooks/plan-check.js through
// stdin like claude runs it: deny with the reasons, allow silent, fail open on a missing or garbled ctx.
// P5b (K6+M3 RO4 K10 N4): the test_cmd grammar (testArgv) and the allowed_* grammar (parseAllowed, isAllowed,
// markAllowed) as pure tables, wired into check(); ctx.at checks paths at a branch HEAD (replan), scripts stay at base.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const sh = require('../lib/sh');
const { check, ctxOf, testArgv, parseAllowed, isAllowed, markAllowed } = require('../lib/plan-rules');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-rules-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const REPO = path.join(ROOT, 'repo');
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git0 = (...a) => execFileSync('/usr/bin/git', ['-C', REPO, ...a], { encoding: 'utf8', env: GIT_ENV }).trim();
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'docs', 'adr'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'oxlint' } }));
fs.writeFileSync(path.join(REPO, 'src', 'users.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(REPO, 'docs', 'adr', '0001-cursor.md'), '# cursor\n');
git0('init', '-q', '-b', 'main');
git0('add', '.');
git0('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
const BASE = git0('rev-parse', 'HEAD');
// N4: a branch commit after base (a replan checks paths at its HEAD): lib/new/x.js + a test:e2e script
git0('checkout', '-q', '-b', 'side');
fs.mkdirSync(path.join(REPO, 'lib', 'new'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'lib', 'new', 'x.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:e2e': 'node --test e2e' } }));
git0('add', '.');
git0('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'side');
const SIDE = git0('rev-parse', 'HEAD');
git0('checkout', '-q', 'main');

const calls = []; // [args, stdin] of every git the rules ran
const git = (args, input) => {
  calls.push([args, input ?? '']);
  return sh('/usr/bin/git', ['-C', REPO, ...args], { env: GIT_ENV, timeout: 10_000, input });
};
const LOCKED = [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }, { id: 'R2C', text: 'keep /users/all', source: 'reject:R2' }];
const ctx = (over = {}) => ({ locked: LOCKED, must_ask: false, round1: false, skills: ['learning'], base_sha: BASE, cwd: REPO, git, ...over });
const T1 = { id: 'T1', title: 'cursor pagination', files: ['src/users.js', 'src/cursor.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['add a cursor param to list()'] };
const T2 = { id: 'T2', title: 'keep /users/all', files: ['src/users.js'], modules: ['src', 'docs/adr/'], blocked_by: ['T1'], acceptance: ['A2'], type: 'preserve', test_cmd: 'npm test -- src/users.js src/users.test.js', steps: ['route /users/all to the old list()'] };
const PLAN = {
  kind: 'plan', summary: 'Paginate GET /users',
  acceptance: [{ id: 'A1', text: 'returns 50 per page', type: 'new' }, { id: 'A2', text: '/users/all still works', type: 'preserve' }],
  tasks: [T1, T2], allowed_schema_changes: [], allowed_api_changes: ['type GET /users#200'], skills: ['learning'], ui: null,
  children: [{ id: 'C1', title: 'docs', text: 'document paging', blocked_by: ['parent'] }],
  facts: ['src/users.js:1: exports nothing yet', 'docs/adr: one ADR so far'],
  // J17: R1Q1 echoed unchanged, R2C left out (both fine)
  decisions: [LOCKED[0], { id: 'D1', text: 'cursor, not offset', source: 'adr:docs/adr/0001-cursor.md' }, { id: 'D2', text: 'opaque cursor', source: 'planner' }],
};
const Q = { id: 'Q1', question: 'Page size?', why: 'API contract', options: ['20', '50'], recommended: '20' };
const QUESTIONS = { kind: 'questions', questions: [Q], facts: ['src/users.js: no paging'], decisions: [] };
const task0 = (over) => ({ ...PLAN, tasks: [{ ...T1, ...over }, T2] });
const qs = (over) => ({ ...QUESTIONS, questions: [{ ...Q, ...over }] });
const dec = (d) => ({ ...PLAN, decisions: [...PLAN.decisions.slice(0, 2), d] });
const kid = (id, blocked_by) => ({ id, title: `child ${id}`, text: 'do it', blocked_by });

test('full access: a board default plugin skill (not in ~/.claude/skills) is a known skill; an unknown name is still refused', async () => {
  assert.deepEqual(await check({ ...PLAN, skills: ['learning', 'caveman'] }, ctx()), []);
  assert.deepEqual(await check({ ...PLAN, skills: ['no-such-skill'] }, ctx()), ['unknown skills "no-such-skill": name only installed skills']);
});

test('J16 J17 J18: a valid plan and questions result pass; every path in ONE git cat-file --batch-check (+ one package.json read); folder tag: no git', async () => {
  calls.length = 0;
  assert.deepEqual(await check(PLAN, ctx()), []);
  assert.deepEqual(calls.map(([a]) => a.slice(0, 2).join(' ')), ['cat-file --batch-check', 'cat-file blob'], 'one batch for all paths, one package.json read');
  assert.equal(calls[0][1].split('\n').filter(Boolean).every((l) => l.startsWith(`${BASE}:`)), true, 'every path asked at base_sha');
  calls.length = 0;
  assert.deepEqual(await check(QUESTIONS, ctx()), []);
  assert.equal(calls.length, 1);
  calls.length = 0;
  assert.deepEqual(await check({ ...PLAN, facts: ['notes.md: no such file in any repo'] }, ctx({ cwd: null })), [], 'folder tag: path checks skipped');
  assert.equal(calls.length, 0);
});

test('J16 J17 J18: one negative per rule group → its exact reason, no other', async () => {
  /** @type {[string, any, any, string[]][]} */
  const rows = [
    ['shape: questions + plan fields', { ...QUESTIONS, summary: 'x', tasks: [] }, {}, ['kind "questions" carries plan fields summary, tasks: leave them out']],
    ['shape: plan missing a field', (({ ui: _ui, ...p }) => p)(PLAN), {}, ['a plan needs ui']],
    ['must_ask + plan', PLAN, { must_ask: true }, ['Irfan asked to be asked more first (must_ask)']],
    ['D-0116 round 1 is questions', PLAN, { round1: true }, ['round 1 must be questions (no answers or locked decisions yet)']],
    ['I5 recommended listed first', qs({ recommended: '50' }), {}, ['questions[0].options: list the recommended option "50" first']],
    ['M5.4 sec: an empty question id (page form key) is refused', qs({ id: '' }), {}, ['questions[0].id "": 1-16 letters, digits, _ or - (e.g. "Q1")']],
    ['options 2-4', qs({ options: ['20', '50', '100', '200', '500'] }), {}, ['questions[0].options: 2 to 4 options, got 5']],
    ['recommended = an option, byte for byte', qs({ recommended: '20 ' }), {}, ['questions[0].recommended "20 ": must be exactly one of its options']],
    ['why non-empty', qs({ why: '  ' }), {}, ['questions[0].why: say why the answer matters']],
    ['source pattern', dec({ id: 'D2', text: 'x', source: 'irfan' }), {}, ['decisions[2].source "irfan": must be answer:R<n>Q<id>, reject:R<n>, ticket, adr:<path> or planner']],
    ['answer:/reject: only on locked ids', dec({ id: 'D2', text: 'x', source: 'reject:R2' }), {}, [`decisions[2].source "reject:R2": answer: and reject: are only for Irfan's locked decisions, "D2" is not one`]],
    ['adr file at base', dec({ id: 'D2', text: 'x', source: 'adr:docs/adr/0009-nope.md' }), {}, ['decisions[2].source "docs/adr/0009-nope.md": no such file at base']],
    ['J17 locked text changed', { ...PLAN, decisions: [{ ...LOCKED[0], text: 'Page size? → 20' }] }, {}, ['decisions[0] "R1Q1": Irfan locked it as "Page size? → 50": return his text exactly or leave it out']],
    ['fact without a path', { ...PLAN, facts: ['list() returns every row'] }, {}, ['facts[0] "list() returns every row": start with the path it is about']],
    ['fact path at base', { ...PLAN, facts: ['src/nope.js: x'] }, {}, ['facts[0] "src/nope.js": no such file or folder at base']],
    ['files: the file or its folder', task0({ files: ['lib/new/x.js'] }), {}, ['tasks[0].files[0] "lib/new/x.js": neither the file nor its folder exists at base']],
    ['files: absolute and .. refused before git', task0({ files: ['/etc/passwd', 'src/../../x'] }), {},
      ['tasks[0].files[0] "/etc/passwd": a path relative to the repo root', 'tasks[0].files[1] "src/../../x": a path relative to the repo root']],
    ['modules: real folders', task0({ modules: ['src/users.js'] }), {}, ['tasks[0].modules[0] "src/users.js": not a folder at base']],
    ['blocked_by: earlier tasks only', { ...PLAN, tasks: [{ ...T1, blocked_by: ['T2'] }, T2] }, {}, ['tasks[0].blocked_by "T2": name only tasks listed before this one']],
    ['acceptance: every id covered', { ...PLAN, acceptance: [...PLAN.acceptance, { id: 'A3', text: 'x', type: 'new' }] }, {}, ['acceptance "A3": no task covers it']],
    ['acceptance: a task names a real id', task0({ acceptance: ['A1', 'A9'] }), {}, ['tasks[0].acceptance "A9": no such acceptance id']],
    ['J18 type enum', task0({ type: 'refactor' }), {}, ['tasks[0].type "refactor": must be "new" or "preserve"']],
    ['npm script in package.json at base', task0({ test_cmd: 'npm run test:e2e' }), {}, ['tasks[0].test_cmd: npm script "test:e2e" is not in package.json at base']],
    ['K6 test_cmd grammar: no npx, no shell', task0({ test_cmd: 'npx jest' }), {}, ['tasks[0].test_cmd "npx jest": must be `npm test [-- <paths>]`']],
    ['RO4 test scripts only', task0({ test_cmd: 'npm run deploy' }), {}, ['tasks[0].test_cmd "npm run deploy": npm script "deploy" is not a test script']],
    ['M6 a module is never the repo root', task0({ modules: ['.', './', 'src'] }), {},
      ['tasks[0].modules[0] ".": a folder below the repo root, not the root itself', 'tasks[0].modules[1] "./": a folder below the repo root, not the root itself']],
    ['K6 a test_cmd path: it or its folder at base', task0({ test_cmd: 'npm test -- lib/new/x.test.js' }), {}, ['tasks[0].test_cmd "lib/new/x.test.js": neither the file nor its folder exists at base']],
    ['K6 a bare word is no new test file (the root is never its folder)', task0({ test_cmd: 'npm test -- invoice' }), {},
      ['tasks[0].test_cmd "invoice": not at base; a new test file goes in an existing folder below the repo root']],
    ['K6 a new test file in a missing folder', task0({ test_cmd: 'npm test -- newdir/x.test.ts' }), {}, ['tasks[0].test_cmd "newdir/x.test.ts": neither the file nor its folder exists at base']],
    ['K6 a new test file in an existing folder passes', task0({ test_cmd: 'npm test -- src/invoice.test.ts' }), {}, []],
    ['K10 allowed_* exact grammar', { ...PLAN, allowed_schema_changes: ['User.nickname dropped'], allowed_api_changes: ['GET /users: add optional cursor'] }, {},
      ['allowed_schema_changes[0] "User.nickname dropped": not one change in the exact form', 'allowed_api_changes[0] "GET /users: add optional cursor": not one change in the exact form']],
    // C15 (D-0091): a child's blockers form one chain ("parent" counts), else it would need a rebase
    ['C15 sibling blockers that diverge', { ...PLAN, children: [kid('C1', ['parent']), kid('C2', ['parent']), kid('C3', ['C1', 'C2', 'parent'])] }, {},
      ['child "C3": blockers diverge: no rebase (D-0091): "C1" and "C2"']],
    ['C15 sibling blockers in one chain pass', { ...PLAN, children: [kid('C1', ['parent']), kid('C2', ['C1']), kid('C3', ['C2', 'C1', 'parent'])] }, {}, []],
    // M2: TBD/TODO upper case only, error handling / edge cases only as the whole step, no bare "fill in": real steps pass
    ['placeholder words', task0({ steps: ['wire the route', 'Add appropriate error handling', 'Add a todo list filter', 'Add error handling for 404 from gh', 'fill in the default tag in the form', 'TODO'] }), {},
      ['tasks[0].steps[1]: placeholder "Add appropriate error handling"', 'tasks[0].steps[5]: placeholder "TODO"']],
  ];
  for (const [name, out, over, want] of rows) {
    calls.length = 0;
    const why = await check(out, ctx(over));
    assert.equal(why.length, want.length, `${name}: ${JSON.stringify(why)}`);
    want.forEach((w, i) => assert.ok(why[i].startsWith(w), `${name}: ${JSON.stringify(why[i])}`));
    assert.ok(calls.every(([, input]) => !/passwd|\.\.\//.test(input)), `${name}: an absolute or .. path never reaches git`);
  }
  const many = await check({ ...PLAN, facts: Array.from({ length: 25 }, (_, i) => `fact ${i}`) }, ctx());
  assert.deepEqual([many.length, many.at(-1)], [21, '(+5 more)'], 'reasons capped');
});

test('D-0116 I1 I1b: ctxOf asks round 1 of a fresh ticket (questions pass, plan refused); a child with inherited locked decisions, or a past answer, may plan', async () => {
  const fresh = ctxOf({ id: 't1' }, ['learning']);
  assert.deepEqual(await check(PLAN, fresh), ['round 1 must be questions (no answers or locked decisions yet)']);
  assert.deepEqual(await check(QUESTIONS, fresh), []);
  for (const t of [{ id: 't2', locked_decisions: [LOCKED[0]] }, { id: 't3', answers: [{ id: 'R1Q1' }] }]) assert.deepEqual(await check({ ...PLAN, decisions: PLAN.decisions.slice(1) }, ctxOf(t, ['learning'])), [], t.id);
  assert.match((await check(PLAN, ctxOf({ id: 't4', must_ask: true, locked_decisions: [LOCKED[0]] }, ['learning'])))[0], /^Irfan asked to be asked more first \(must_ask\)/, 'the flag keeps its own text');
});

test('MED3 task ids: a git-ref-safe name, never @fix or a path-like one (table); T1, t-2.a pass', async () => {
  for (const id of ['@fix', 'a b', 'x..y', '', '__proto__', 'a.lock', 'a.', '-x', 'a'.repeat(33), 5]) {
    const why = await check(task0({ id }), ctx());
    assert.ok(why.some((w) => w.startsWith(`tasks[0].id ${JSON.stringify(String(id))}: 1-32 letters`)), `${JSON.stringify(id)}: ${JSON.stringify(why)}`);
  }
  for (const id of ['T1', 't-2.a']) assert.ok(!(await check(task0({ id }), ctx())).some((w) => w.includes('.id ')), id); // T2's blocked_by T1 is not under test
});

test('N4 ctx.at: paths checked at the branch HEAD (replan), package.json scripts still at base_sha (RO4)', async () => {
  calls.length = 0;
  assert.deepEqual(await check(task0({ files: ['lib/new/x.js'] }), ctx({ at: SIDE })), [], 'exists at the branch HEAD');
  assert.ok(calls[0][1].split('\n').filter(Boolean).every((l) => l.startsWith(`${SIDE}:`) || l === `${BASE}:package.json`), 'paths at `at`, package.json at base');
  assert.deepEqual(await check(task0({ files: ['nope/x.js'] }), ctx({ at: SIDE })), ['tasks[0].files[0] "nope/x.js": neither the file nor its folder exists at branch HEAD']);
  assert.deepEqual(await check(task0({ test_cmd: 'npm run test:e2e' }), ctx({ at: SIDE })), ['tasks[0].test_cmd: npm script "test:e2e" is not in package.json at base'],
    'a script added on the branch does not count');
  await assert.rejects(check(PLAN, ctx({ at: 'HEAD' })), /ctx.at "HEAD" is not a sha/);
});

test('K4 C2 M4 keep: a prefix of the old plan\'s done tasks, first in tasks, only on a replan', async () => {
  const T0 = { ...T1, id: 'T0', acceptance: [] };
  /** @type {[string, any, string[] | undefined, string[]][]} */
  const rows = [
    ['first plan, no keep', PLAN, undefined, []],
    ['first plan, keep: [] is no keep', { ...PLAN, keep: [] }, undefined, []],
    ['replan keeps the first done task', { ...PLAN, keep: ['T1'] }, ['T1', 'T2'], []],
    ['replan keeps all done tasks', { ...PLAN, keep: ['T1', 'T2'] }, ['T1', 'T2'], []],
    ['replan keeps nothing', { ...PLAN, keep: [] }, ['T1'], []],
    ['keep on a first plan', { ...PLAN, keep: ['T1'] }, undefined, ['keep: keep only on a replan']],
    ['keep names a task not done in the old plan', { ...PLAN, keep: ['T9'] }, ['T1', 'T2'], ['keep "T9": not a done task of the old plan ("T1", "T2")', 'keep: the kept tasks come first in tasks, in the same order']],
    ['keep skips a done task (not a prefix)', { ...PLAN, keep: ['T1'] }, ['T0', 'T1'], ['keep: a prefix of the old plan\'s done tasks in their order ("T0", "T1")']],
    ['kept tasks not first in tasks', { ...PLAN, tasks: [T0, T1, T2], keep: ['T1'] }, ['T1'], ['keep: the kept tasks come first in tasks, in the same order']],
  ];
  for (const [name, out, keepOk, want] of rows) assert.deepEqual(await check(out, ctx({ cwd: null, ...(keepOk && { keep_ok: keepOk }) })), want, name);
});

test('K6 M3 RO4 testArgv: npm test / npm run <test script> [-- paths] → argv, anything else → why', () => {
  const N = '/d30/bin/npm';
  /** @type {[string, any, any][]} */
  const ok = [
    ['npm test', {}, [N, 'test']],
    ['  npm   test  --  src/a.test.js ', {}, [N, 'test', '--', 'src/a.test.js']],
    ['npm run test:e2e -- users test/users.e2e-spec.ts', {}, [N, 'run', 'test:e2e', '--', 'users', 'test/users.e2e-spec.ts']],
    ['npm run unit', { test_scripts: '^unit$' }, [N, 'run', 'unit']],
  ];
  for (const [cmd, c, argv] of ok) assert.deepEqual(testArgv(cmd, { npm: N, ...c }), { argv, script: argv[1] === 'run' ? argv[2] : 'test', paths: argv.slice(argv.indexOf('--') + 1 || argv.length) }, cmd);
  /** @type {[any, any, RegExp][]} */
  const bad = [
    ['npm test -- -t x', {}, /^arg "-t": .*not a flag/],
    ['npm test -- --config=y', {}, /^arg "--config=y"/],
    ['npm test -- --passWithNoTests', {}, /^arg "--passWithNoTests"/],
    ['npm test -- ../x', {}, /^arg "\.\.\/x"/],
    ['npm test -- src/../../x', {}, /^arg "src\/\.\.\/\.\.\/x"/],
    ['npm test -- /abs/x.test.js', {}, /^arg "\/abs\/x\.test\.js"/],
    ['npx jest', {}, /^must be `npm test/],
    ['npm run deploy', {}, /^npm script "deploy" is not a test script/],
    ['npm run lint && npm test', {}, /args go after --/],
    ['npm test src/a.test.js', {}, /args go after --/],
    ['npm run "test"', {}, /^npm script "\\"test\\"": letters/],
    ['npm run test:../../x', {}, /^npm script "test:\.\.\/\.\.\/x": .*no \.\./],
    [`npm test -- ${Array.from({ length: 21 }, (_, i) => `f${i}`).join(' ')}`, {}, /^at most 20 args after --, got 21/],
    ['npm run test', { test_scripts: '^unit$' }, /^npm script "test" is not a test script \(tag test_scripts "\^unit\$"\)/],
    ['npm run test', { test_scripts: '(' }, /is not a valid regex/],
    [42, {}, /^must be/], ['npm', {}, /^must be/], ['npm run', {}, /^must be/],
  ];
  for (const [cmd, c, re] of bad) {
    const r = testArgv(cmd, c);
    assert.ok('why' in r && re.test(r.why), `${cmd}: ${JSON.stringify(r)}`);
  }
});

test('K10 parseAllowed: exact grammar per kind, normalized; isAllowed exact (no prefix), rename only with M.b added; markAllowed unused', () => {
  /** @type {['schema'|'api', any[], string[], number[]][]} */
  const rows = [
    ['schema', ['drop User.nickname', 'drop User', 'drop Role.ADMIN', 'rename User.nickname User.handle', 'type Order.totalMinor', 'required User.nickname', '  drop   User.nickname ', 'drop _UserToTag'],
      ['drop User.nickname', 'drop User', 'drop Role.ADMIN', 'rename User.nickname User.handle', 'type Order.totalMinor', 'required User.nickname', 'drop User.nickname', 'drop _UserToTag'], []],
    ['schema', ['drop User.nickname.x', 'rename User.a Order.b', 'remove User.nickname', 'drop User.*', 'drop nickname from User', '', 42, 'drop User.n\u0007'], [], [0, 1, 2, 3, 4, 5, 6, 7]],
    ['api', ['remove UserDto.nickname', 'remove UserDto', 'remove GET /users/{id}', 'required GET /users#query.limit', 'add-required CreateUserDto.age', 'optional UserDto.email', 'type UserDto.id', 'enum Role', 'remove GET /users/{id}#200.items',
      'required GET /h#header.X-Tenant', 'type GET /u/{id}/orders/{orderId}#path.orderId', 'type GET /u/{id}#path.nope'],
    ['remove UserDto.nickname', 'remove UserDto', 'remove GET /users/{}', 'required GET /users#query.limit', 'add-required CreateUserDto.age', 'optional UserDto.email', 'type UserDto.id', 'enum Role', 'remove GET /users/{}#200.items',
      'required GET /h#header.x-tenant', 'type GET /u/{}/orders/{}#path.1', 'type GET /u/{}#path.nope'], []],
    ['api', ['GET /users: add optional cursor', 'remove nickname from UserDto: GET /users, GET /users/{id}', 'drop User.nickname', 'remove get /users', 'type UserDto.id; rm -rf ~'], [], [0, 1, 2, 3, 4]],
  ];
  for (const [kind, list, entries, badAt] of rows) {
    const r = parseAllowed(list, kind);
    assert.deepEqual(r.entries, entries, `${kind} ${JSON.stringify(list)}`);
    assert.deepEqual(r.why.map((w) => Number(/\[(\d+)\]/.exec(w)?.[1])), badAt, JSON.stringify(r.why));
  }
  assert.deepEqual(parseAllowed('drop User', 'schema').why, ['allowed_schema_changes: a list of strings']);
  assert.match(parseAllowed(Array(51).fill('drop User'), 'schema').why[0], /at most 50 entries, got 51/);

  const drop = { op: 'drop', ref: 'User.nickname' };
  /** @type {[string, {op: string, ref: string}, string[], string[], boolean][]} */
  const allow = [
    ['exact', drop, ['drop User.nickname'], [], true],
    ['no prefix: drop User does not allow drop User.nickname', drop, ['drop User'], [], false],
    ['no partial name', drop, ['drop User.nick'], [], false],
    ['op must match', { op: 'type', ref: 'User.nickname' }, ['drop User.nickname'], [], false],
    ['rename with M.b added', drop, ['rename User.nickname User.handle'], ['User.handle'], true],
    ['rename without M.b added', drop, ['rename User.nickname User.handle'], [], false],
    ['rename allows only the drop', { op: 'type', ref: 'User.nickname' }, ['rename User.nickname User.handle'], ['User.handle'], false],
    ['API path params normalized both sides', { op: 'remove', ref: 'GET /users/{}' }, parseAllowed(['remove GET /users/{id}'], 'api').entries, [], true],
  ];
  for (const [name, change, entries, added, want] of allow) assert.equal(isAllowed(change, entries, added), want, name);
  assert.deepEqual(markAllowed([drop, { op: 'type', ref: 'Order.totalMinor' }], ['drop User.nickname', 'enum Role']),
    { changes: [{ ...drop, allowed: true }, { op: 'type', ref: 'Order.totalMinor', allowed: false }], unused: ['enum Role'] });
});

// ---- hooks/plan-check.js (J15): stdin JSON in, a deny or nothing out ---------------------------------------------
const HOOK = path.join(__dirname, '..', 'hooks', 'plan-check.js');
function hook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const call = (out) => ({ hook_event_name: 'PreToolUse', tool_name: 'StructuredOutput', tool_input: out, cwd: REPO }); // claude sends its cwd

test('J15 plan-check hook: a broken result → deny with every reason + "call again"; a valid one → exit 0 silent; missing or garbled ctx → fail open (exit 0, one stderr line)', async () => {
  const file = path.join(ROOT, 'plan-ctx.json');
  fs.writeFileSync(file, JSON.stringify({ locked: LOCKED, must_ask: false, round1: false, skills: ['learning'], base_sha: BASE, cwd: REPO }));
  const bad = await hook(call(task0({ files: ['lib/new/x.js'], steps: ['TBD'] })), { TB_PLAN_CTX: file });
  assert.equal(bad.code, 0);
  const o = JSON.parse(bad.stdout).hookSpecificOutput;
  assert.deepEqual([o.hookEventName, o.permissionDecision], ['PreToolUse', 'deny']);
  assert.equal(o.permissionDecisionReason, [
    'tasks[0].steps[0]: placeholder "TBD": say exactly what to do',
    'tasks[0].files[0] "lib/new/x.js": neither the file nor its folder exists at base',
    'fix these and call StructuredOutput again'].join('\n'));
  assert.deepEqual(await hook(call(PLAN), { TB_PLAN_CTX: file }), { code: 0, stdout: '', stderr: '' }, 'valid: allowed, silent');
  for (const env of [{}, { TB_PLAN_CTX: path.join(ROOT, 'nope.json') }, { TB_PLAN_CTX: HOOK }]) { // unset, missing, not JSON
    const r = await hook(call(task0({ steps: ['TBD'] })), env);
    assert.deepEqual([r.code, r.stdout], [0, ''], JSON.stringify(env));
    assert.match(r.stderr, /^plan-check: .+; allowing\n$/, JSON.stringify(env));
  }
});
