'use strict';
// P5a unit (pure): lib/working.js decide() (contract M13 N6 K3 K12: what follows a gate result, or the cursor alone) and
// the working result schema caps (contract schema caps: notes/question ≤ 4 KB, needs_scope.files ≤ 50, path pattern +
// hidden characters) through lib/schema.js's new maxLength + pattern. The runner path: test/working.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// env before any lib require: store reads TB_HOME at load (never the real home)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wdecide-'));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { decide, handle } = require('../lib/working');
const { compile } = require('../lib/schema');
const { render, denyPaths } = require('../lib/phase-settings');

const T = (id, status, extra = {}) => ({ id, status, attempt: 1, pre: 'p', head: null, commit: null, session: 's1', ...extra });
const tk = (work) => ({ id: 't_x00001', state: 'working', round: 1, work: { task: 'T1', tries: 0, unit_ms: null, scope: {}, denied: {}, gate: null, ...work } });
const red = (over = {}) => ({ gate: 'task', ok: false, class: 'work', ask: null, why: 'unit red', ...over });
const pick = (d) => [d.do, d.task, d.mode];

test('M13 N6 decide on a gate result: accept → next task fresh, last → the working gate, working green → review; reds: 1st resume, 2nd fresh, 3rd Blocked; hard classes block, interrupted reruns, asks clarify', () => {
  const two = [T('T1', 'gating'), T('T2', 'pending')];
  const rows = [
    [tk({ tasks: two }), { gate: 'task', ok: true }, ['spawn', 'T2', 'fresh']],
    [tk({ tasks: [T('T1', 'gating')] }), { gate: 'task', ok: true }, ['gate', null, null]],
    [tk({ task: null, tasks: [T('T1', 'done')] }), { gate: 'working', ok: true }, ['review', null, null]],
    [tk({ tasks: two, tries: 0 }), red(), ['spawn', 'T1', 'resume']],
    [tk({ tasks: two, tries: 1 }), red(), ['spawn', 'T1', 'fresh']],
    [tk({ tasks: two, tries: 2 }), red(), ['blocked', 'T1', null]],
    [tk({ tasks: two, tries: 1 }), red({ class: 'interrupted' }), ['gate', 'T1', null]], // no try used
    ...['infra', 'integrity', 'config'].map((c) => [tk({ tasks: two }), red({ class: c }), ['blocked', 'T1', null]]),
    [tk({ tasks: two }), red({ class: 'protected', ask: { kind: 'protected', files: ['package.json'], reason: 'r' } }), ['clarify', 'T1', null]],
    [tk({ tasks: two, denied: { T1: ['a.js'] } }), red({ class: 'scope', ask: { kind: 'scope', files: ['a.js'], reason: 'r' } }), ['blocked', 'T1', null]], // K3 again
    [tk({ tasks: two, denied: { T1: ['a.js'] } }), red({ class: 'scope', ask: { kind: 'scope', files: ['b.js'], reason: 'r' } }), ['clarify', 'T1', null]],
    [tk({ task: null, tasks: [T('T1', 'done')] }), red({ gate: 'working' }), ['spawn', '@fix', 'fresh']],
    [tk({ task: '@fix', tasks: [T('T1', 'done'), T('@fix', 'gating')], tries: 0 }), red({ gate: 'working' }), ['spawn', '@fix', 'resume']],
    [tk({ task: null, tasks: [T('T1', 'done')] }), red({ gate: 'working', class: 'policy', ask: { kind: 'policy', changes: ['drop U.a'], reason: 'r' } }), ['clarify', null, null]],
    [tk({ tasks: two }), red({ dirty: true }), ['spawn', 'T1', 'resume']], // I4: once
    [tk({ tasks: [T('T1', 'gating', { dirty: 1 }), T('T2', 'pending')] }), red({ dirty: true }), ['blocked', 'T1', null]],
    [tk({ tasks: two }), red({ gate: 'base' }), ['blocked', 'T1', null]], // n12 base red
  ];
  rows.forEach(([t, last, want], i) => assert.deepEqual(pick(decide(t, null, /** @type {any} */ (last))), want, `row ${i}`));
  assert.match(decide(tk({ tasks: two, tries: 2 }), null, /** @type {any} */ (red({ why: 'x'.repeat(5000) }))).why, /^red 3 times: x+$/);
  assert.ok(decide(tk({ tasks: two, tries: 2 }), null, /** @type {any} */ (red({ why: 'x'.repeat(5000) }))).why.length <= 4096);
});

test('M13 N6 decide from the cursor alone: pending → fresh, running → continue (fresh without a session), gating or a pending gate → gate, red → resume / fresh by tries; no cursor → blocked', () => {
  const rows = [
    [{ tasks: [T('T1', 'pending')] }, ['spawn', 'T1', 'fresh']],
    [{ tasks: [T('T1', 'running')] }, ['spawn', 'T1', 'continue']],
    [{ tasks: [T('T1', 'running', { session: null })] }, ['spawn', 'T1', 'fresh']],
    [{ tasks: [T('T1', 'gating')] }, ['gate', 'T1', null]],
    [{ tasks: [T('T1', 'running')], gate: { gen: 1, kind: 'task' } }, ['gate', 'T1', null]],
    [{ tasks: [T('T1', 'red')], tries: 1 }, ['spawn', 'T1', 'resume']],
    [{ tasks: [T('T1', 'red')], tries: 2 }, ['spawn', 'T1', 'fresh']],
    [{ task: null, tasks: [T('T1', 'done')] }, ['gate', null, null]],
  ];
  rows.forEach(([w, want], i) => assert.deepEqual(pick(decide(tk(w), null, null)), want, `row ${i}`));
  assert.deepEqual(pick(decide({ id: 't_x00001', state: 'working' }, null, null)), ['blocked', null, null]);
});

test('schema caps (working result): done passes; notes/question over 4 KB, more than 50 files, an absolute, `..` or hidden-character path refused; a bad pattern fails closed at compile', () => {
  const check = compile(require('../phases/code/working/result.schema.json'));
  const ok = { status: 'done', commit: 'a'.repeat(40), tests_added: ['test/a.test.js'], notes: '' };
  assert.deepEqual(check(ok), []);
  assert.deepEqual(check({ ...ok, status: 'NEEDS_SCOPE', needs_scope: { files: ['src/x.js'], reason: 'r' } }), []);
  assert.deepEqual(check({ ...ok, notes: 'x'.repeat(4097), question: 'q'.repeat(4097) }), ['/notes: must have at most 4096 characters', '/question: must have at most 4096 characters']);
  assert.deepEqual(check({ ...ok, needs_scope: { files: Array(51).fill('a.js'), reason: 'r' } }), ['/needs_scope/files: must have at most 50 items']);
  for (const p of ['/etc/passwd', '../x.js', 'a/../../x.js', 'a/..', `x${String.fromCodePoint(0x202e)}sj.js`, `a${String.fromCodePoint(0x200b)}.js`, 'a\nb.js']) {
    assert.deepEqual(check({ ...ok, tests_added: [p] }), ["/tests_added/0: must match the schema's pattern"], JSON.stringify(p));
  }
  for (const p of ['a..b.js', 'test/..hidden/x.js', '.github/x.yml']) assert.deepEqual(check({ ...ok, tests_added: [p] }), [], p);
  assert.throws(() => compile({ type: 'string', pattern: '(' }), /bad value for "pattern"/);
  assert.throws(() => compile({ type: 'string', maxLength: -1 }), /bad value for "maxLength"/);
});

test('M12 handler: status → field (untrusted result): done needs a commit sha, NEEDS_SCOPE needs needs_scope (and only it), NEEDS_CONTEXT / TEST_DISPUTES_SPEC a question → {reject}; a good done → gate pending, no move', async () => {
  const t = { ...tk({ tasks: [T('T1', 'pending')] }), lease: { gen: 7, session: 's2' } };
  const base = { commit: null, tests_added: [], notes: '' };
  for (const out of [{ status: 'done' }, { status: 'done', commit: 'HEAD' }, { status: 'NEEDS_SCOPE' }, { status: 'done', commit: 'a'.repeat(40), needs_scope: { files: ['x'], reason: 'r' } },
    { status: 'NEEDS_CONTEXT' }, { status: 'TEST_DISPUTES_SPEC', question: ' ' }]) {
    assert.ok((await handle(structuredClone(t), { ...base, ...out })).reject, JSON.stringify(out));
  }
  const ok = await handle(structuredClone(t), { ...base, status: 'done', commit: 'a'.repeat(40) });
  assert.deepEqual([ok.to, ok.patch.work.gate, ok.patch.work.tasks[0].status, ok.patch.work.tasks[0].session], [undefined, { gen: 7, kind: 'task' }, 'gating', 's2']);
});

test('K5 F4 denyPaths (the gate profile\'s one deny source): TB_HOME, the live board and HOME secrets unreadable; the agent\'s write denies + env files + node_modules, and (gates only) the whole git dir', () => {
  const H = '/u/.taskboard';
  const ctx = { WORKTREE: `${H}/worktrees/t_abc123`, TICKET_DIR: `${H}/tickets/t_abc123`, OUT_DIR: `${H}/tickets/t_abc123/out`, TB_HOME: H, TAG_PATH: '/u/code/repo',
    SKILLS_DIR: `${H}/tickets/t_abc123/skills`, TB_CODE: '/u/tb', TB_NODE: '/u/node/bin/node', TB_PORT: 7777, HEAVY: [], ENV_FILES: ['.env.test'] };
  const d = denyPaths(ctx);
  for (const p of [H, path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.config', 'gh'), path.join(os.homedir(), 'Library', 'Keychains')]) assert.ok(d.read.includes(p), p);
  for (const p of ['/u/code/repo/.git', `${ctx.WORKTREE}/.git`, `${ctx.WORKTREE}/.env.test`, `${ctx.WORKTREE}/node_modules/.bin`, path.join(os.homedir(), '.npmrc')]) assert.ok(d.write.includes(p), p);
  assert.ok(d.read.concat(d.write).every((p) => path.isAbsolute(p)), 'absolute only');
  // H2.7 (contract change; was: the tag's .git not write-denied for working, 'the agent still commits'): the agent commits in its
  // own clone, so the tag's .git is denied and the clone's .git is not (only its config-like files, phase-settings test)
  const wd = render('code', 'working', ctx).sandbox.filesystem.denyWrite;
  assert.deepEqual([wd.includes('/u/code/repo/.git'), wd.includes(`${ctx.WORKTREE}/.git`)], [true, false], 'the agent still commits, in its own clone');
  assert.throws(() => denyPaths({ ...ctx, ENV_FILES: ['../x'] }), /ENV_FILES/);
});

test('RO2 single ask (handler): NEEDS_SCOPE naming packages, a lockfile (npm, yarn, pnpm) → deps at once; a protected file → protected; others → scope. packages must match lib/gates PACKAGE_RE (no dist-tags, no spaces)', async () => {
  const t = { ...tk({ tasks: [T('T1', 'running')] }), lease: { gen: 1, session: 's1' }, tag: null };
  const ns = (files, packages) => ({ status: 'NEEDS_SCOPE', commit: null, tests_added: [], notes: '', needs_scope: { files, reason: 'r', ...(packages && { packages }) } });
  for (const [out, kind] of /** @type {[any, string][]} */ ([[ns(['src/a.js'], ['zod@^3.23.0']), 'deps'], [ns(['yarn.lock']), 'deps'], [ns(['web/pnpm-lock.yaml']), 'deps'], [ns(['package.json']), 'protected'],
    [ns(['jest.config.ts']), 'protected'], [ns(['src/a.js']), 'scope']])) {
    assert.equal(/** @type {any} */ (await handle(structuredClone(t), out)).patch.clarify_origin.class, kind, JSON.stringify(out.needs_scope));
  }
  const check = compile(require('../phases/code/working/result.schema.json'));
  for (const [p, ok] of /** @type {[string, boolean][]} */ ([['zod@^3.23.0', true], ['@prisma/client@7.10.0', true], ['zod@latest', false], ['lodash@>=1 <2', false], ['zod', false]])) {
    assert.equal(check(ns(['package.json'], [p])).length === 0, ok, p);
  }
});

test('RAM: lib/working.js runs no interval timer (gate jobs are driven by the runner tick)', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'lib', 'working.js'), 'utf8'), /setInterval/);
});
