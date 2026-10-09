'use strict';
// P4a U3 / T8: lib/schema.js, the zero-dep JSON-schema subset that checks agent results before any phase handler.
// Unit (pure): fail closed on keywords it lacks; the real phases/code/planning/result.schema.json compiles and judges
// both result kinds (App C questions, App A plan; J3 tasks minItems 1). The runner path: test/planning.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compile } = require('../lib/schema');

const PLANNING = require(path.join(__dirname, '..', 'phases', 'code', 'planning', 'result.schema.json'));
const D1 = { id: 'D1', text: 'cursor, not offset', source: 'answer:R1Q1' };
const PLAN = {
  kind: 'plan', summary: 's', acceptance: [{ id: 'A1', text: 'a', type: 'new' }],
  tasks: [{ id: 'T1', title: 't', files: ['a.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['x'] }],
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['f'], decisions: [D1],
};

test('U3 fail closed: a keyword the subset lacks (any depth) or a bad keyword value throws at compile', () => {
  assert.throws(() => compile({ type: 'object', oneOf: [] }), /unsupported keyword "oneOf"/);
  assert.throws(() => compile({ properties: { a: { type: 'string', pattern: '^x' } } }), /schema \/properties\/a: unsupported keyword "pattern"/);
  assert.throws(() => compile({ type: 'strng' }), /bad value for "type"/);
  assert.throws(() => compile([]), /must be an object/);
  assert.deepEqual(compile({})({ any: 1 }), [], 'the empty schema takes anything (fixture phases)');
});

test('U3 J3 planning schema: questions and plan results pass; wrong kind, empty tasks, unknown or missing fields, wrong types are named by pointer', () => {
  const check = compile(PLANNING);
  assert.deepEqual(check(PLAN), []);
  assert.deepEqual(check({ kind: 'questions', round: 1, questions: [{ id: 'Q1', question: 'q', why: 'w', options: ['a', 'b'], recommended: 'a' }], facts: [], decisions: [] }), []);
  assert.deepEqual(check({ ...PLAN, kind: 'plans', tasks: [] }), ['/kind: must be one of "questions", "plan"', '/tasks: must have at least 1 item']);
  const noFacts = { ...PLAN };
  delete noFacts.facts;
  assert.deepEqual(check({ ...noFacts, extra: 1, ui: 3, decisions: [{ ...D1, source: 7 }] }), ['/: missing "facts"', '/ui: must be string or null', '/decisions/0/source: must be string', '/: unknown field "extra"']);
  assert.deepEqual(check('not an object'), ['/: must be object']);
});

test('P4e J16 J18 keywords maxItems + minLength (and the planning schema using them: 2-4 options, a why, task acceptance + type enum)', () => {
  assert.deepEqual(compile({ type: 'array', maxItems: 2 })([1, 2, 3]), ['/: must have at most 2 items']);
  assert.deepEqual(compile({ type: 'array', maxItems: 2 })([1, 2]), []);
  assert.deepEqual(compile({ type: 'string', minLength: 1 })(''), ['/: must have at least 1 character']);
  assert.deepEqual(compile({ type: 'string', minLength: 2 })('ab'), []);
  assert.throws(() => compile({ maxItems: -1 }), /bad value for "maxItems"/);
  assert.throws(() => compile({ minLength: 1.5 }), /bad value for "minLength"/);
  const check = compile(PLANNING);
  const q = { id: 'Q1', question: 'q', why: '', options: ['a', 'b', 'c', 'd', 'e'], recommended: 'a' };
  assert.deepEqual(check({ kind: 'questions', questions: [q], facts: [], decisions: [] }), ['/questions/0/why: must have at least 1 character', '/questions/0/options: must have at most 4 items']);
  const t = { ...PLAN.tasks[0], type: 'refactor' };
  delete t.acceptance;
  assert.deepEqual(check({ ...PLAN, tasks: [t] }), ['/tasks/0: missing "acceptance"', '/tasks/0/type: must be one of "new", "preserve"']);
});
