'use strict';
// P4e (contract J15 J16 J17 J18): lib/plan-rules.js against a real temp git repo (package.json scripts, src/, an ADR):
// a valid plan and a valid questions result pass, all path checks in ONE `git cat-file --batch-check` (counted through
// the injected git); one negative per rule group → its exact reason, nothing else fires. hooks/plan-check.js through
// stdin like claude runs it: deny with the reasons, allow silent, fail open on a missing or garbled ctx.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const sh = require('../lib/sh');
const { check } = require('../lib/plan-rules');

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

const calls = []; // [args, stdin] of every git the rules ran
const git = (args, input) => {
  calls.push([args, input ?? '']);
  return sh('/usr/bin/git', ['-C', REPO, ...args], { env: GIT_ENV, timeout: 10_000, input });
};
const LOCKED = [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }, { id: 'R2C', text: 'keep /users/all', source: 'reject:R2' }];
const ctx = (over = {}) => ({ locked: LOCKED, must_ask: false, skills: ['learning'], base_sha: BASE, cwd: REPO, git, ...over });
const T1 = { id: 'T1', title: 'cursor pagination', files: ['src/users.js', 'src/cursor.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['add a cursor param to list()'] };
const T2 = { id: 'T2', title: 'keep /users/all', files: ['src/users.js'], modules: ['src', 'docs/adr/'], blocked_by: ['T1'], acceptance: ['A2'], type: 'preserve', test_cmd: 'npm run lint && npm test', steps: ['route /users/all to the old list()'] };
const PLAN = {
  kind: 'plan', summary: 'Paginate GET /users',
  acceptance: [{ id: 'A1', text: 'returns 50 per page', type: 'new' }, { id: 'A2', text: '/users/all still works', type: 'preserve' }],
  tasks: [T1, T2], allowed_schema_changes: [], allowed_api_changes: ['GET /users: add optional cursor'], skills: ['learning'], ui: null,
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
    ['npm script in package.json at base', task0({ test_cmd: 'npm run e2e -- --ci' }), {}, ['tasks[0].test_cmd: npm script "e2e" is not in package.json at base']],
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
  fs.writeFileSync(file, JSON.stringify({ locked: LOCKED, must_ask: false, skills: ['learning'], base_sha: BASE, cwd: REPO }));
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
