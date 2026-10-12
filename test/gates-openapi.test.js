'use strict';
// P5b K9+M7: lib/gates/openapi.js. diff() pure: one row per breaking rule (response, request, both, operation), each
// with a positive (no change) and a negative (exact change + dir): 3.0 nullable ≡ 3.1 type null both ways, $ref cycle,
// required ↔ optional, new required property/param, param rename, enum, type, inline names, removed op / 2xx. The CLI
// as tbd runs it (a child): exit codes for a missing file, 6 MB, a link, outside root, bad JSON, and the JSON line;
// readSpec refuses a file swapped between its checks and the open. Guards: a non-component $ref cycle ends (reach walks
// each $ref once, cmp each pair once), nesting over DEPTH is refused.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diff, readSpec } = require('../lib/gates/openapi');

const json = (schema) => ({ content: { 'application/json': { schema } } });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const BASE = {
  openapi: '3.0.3', info: { title: 't', version: '1' },
  paths: {
    '/users': {
      get: {
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('UserDto') }, next: { type: 'string' } }, required: ['items'] }) },
      },
      post: { requestBody: { required: true, ...json(ref('CreateUserDto')) }, responses: { 201: json(ref('UserDto')) } },
    },
    '/users/{id}': {
      get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: json(ref('UserDto')), 404: { description: 'no such user' } } },
    },
  },
  components: {
    schemas: {
      UserDto: {
        type: 'object', required: ['id', 'email', 'role'],
        properties: { id: { type: 'integer' }, email: { type: 'string' }, nickname: { type: 'string', nullable: true }, role: { type: 'string', enum: ['user', 'admin'] }, manager: ref('UserDto') },
      },
      CreateUserDto: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, nickname: { type: 'string' }, role: { type: 'string', enum: ['user', 'admin'] } } },
    },
  },
};
const S = () => structuredClone(BASE);
const edit = (fn, doc = S()) => (fn(doc), doc);
const run = (head, base = BASE) => diff(base, head).map((c) => `${c.op} ${c.ref} ${c.dir}`);
const U = (d) => d.components.schemas.UserDto;
const C = (d) => d.components.schemas.CreateUserDto;

test('K9 M7 openapi diff: one row per rule, positive and negative', () => {
  /** @type {[string, any, string[], any?][]} */
  const rows = [
    ['same document (self $ref UserDto.manager: the cycle guard ends the walk)', S(), []],
    ['3.0 nullable → 3.1 type [T, "null"]: equal', edit((d) => { d.openapi = '3.1.0'; U(d).properties.nickname = { type: ['string', 'null'] }; }), []],
    ['3.1 type [T, "null"] → 3.0 nullable: equal', S(), [], edit((d) => { d.openapi = '3.1.0'; U(d).properties.nickname = { type: ['string', 'null'] }; })],
    ['response: null added (3.1 form)', edit((d) => { d.openapi = '3.1.0'; U(d).properties.email = { type: ['string', 'null'] }; }), ['type UserDto.email response']],
    ['response: property removed (trap C)', edit((d) => delete U(d).properties.nickname), ['remove UserDto.nickname response']],
    ['response: a new property is additive', edit((d) => { U(d).properties.age = { type: 'integer' }; }), []],
    ['response: required → optional', edit((d) => { U(d).required = ['id', 'role']; }), ['optional UserDto.email response']],
    ['response: type change', edit((d) => { U(d).properties.id = { type: 'string' }; }), ['type UserDto.id response']],
    ['response: enum value added', edit((d) => U(d).properties.role.enum.push('owner')), ['enum UserDto.role response']],
    ['request: enum value added is fine', edit((d) => C(d).properties.role.enum.push('owner')), []],
    ['request: enum value removed', edit((d) => { C(d).properties.role.enum = ['user']; }), ['enum CreateUserDto.role request']],
    ['request: optional → required', edit((d) => C(d).required.push('nickname')), ['required CreateUserDto.nickname request']],
    ['request: new required property', edit((d) => { C(d).properties.age = { type: 'integer' }; C(d).required.push('age'); }), ['add-required CreateUserDto.age request']],
    ['request: new optional property is fine', edit((d) => { C(d).properties.age = { type: 'integer' }; }), []],
    ['request: property removed is fine', edit((d) => delete C(d).properties.nickname), []],
    ['both: type change → dir both; property removed → response only',
      edit((d) => { C(d).properties.email = { type: 'integer' }; delete C(d).properties.nickname; d.paths['/users'].post.responses[201] = json(ref('CreateUserDto')); }),
      ['type CreateUserDto.email both', 'remove CreateUserDto.nickname response'],
      edit((d) => { d.paths['/users'].post.responses[201] = json(ref('CreateUserDto')); })],
    ['param: path param renamed ({id} → {userId}) is no change', edit((d) => {
      d.paths['/users/{userId}'] = d.paths['/users/{id}'];
      delete d.paths['/users/{id}'];
      d.paths['/users/{userId}'].get.parameters[0].name = 'userId';
    }), []],
    ['param: new required query param', edit((d) => d.paths['/users'].get.parameters.push({ name: 'q', in: 'query', required: true, schema: { type: 'string' } })), ['add-required GET /users#query.q request']],
    ['param: optional → required', edit((d) => { d.paths['/users'].get.parameters[0].required = true; }), ['required GET /users#query.limit request']],
    ['inline response schema: property removed, named METHOD /path#<status>', edit((d) => delete d.paths['/users'].get.responses[200].content['application/json'].schema.properties.next),
      ['remove GET /users#200.next response']],
    // contract change 2026-10-11 (golden B dry): another component is compared by shape (oasdiff), not by name
    ['inline: items $ref to another component → its shape compared: what breaks is named', edit((d) => { d.paths['/users'].get.responses[200].content['application/json'].schema.properties.items.items = ref('CreateUserDto'); }),
      ['remove GET /users#200.items[].id response', 'optional GET /users#200.items[].role response', 'remove GET /users#200.items[].manager response']],
    ['a component swapped at two paths: each path names its break (cycle guard per path, not per walk)',
      edit((d) => { d.paths['/pair'] = { get: { responses: { 200: json({ type: 'object', properties: { a: ref('CreateUserDto'), b: ref('CreateUserDto') } }) } } }; }),
      ['a', 'b'].flatMap((x) => [`remove GET /pair#200.${x}.id response`, `optional GET /pair#200.${x}.role response`, `remove GET /pair#200.${x}.manager response`]),
      edit((d) => { d.paths['/pair'] = { get: { responses: { 200: json({ type: 'object', properties: { a: ref('UserDto'), b: ref('UserDto') } }) } } }; })],
    ['inline: items $ref to a renamed superset component is fine (UserDto → UserListItemDto + latestOrder)', edit((d) => {
      d.components.schemas.UserListItemDto = { ...structuredClone(d.components.schemas.UserDto), properties: { ...structuredClone(d.components.schemas.UserDto.properties), latestOrder: { type: 'string' } } };
      d.paths['/users'].get.responses[200].content['application/json'].schema.properties.items.items = ref('UserListItemDto');
    }), []],
    ['operation: method removed', edit((d) => delete d.paths['/users'].post), ['remove POST /users operation']],
    ['operation: path removed', edit((d) => delete d.paths['/users/{id}']), ['remove GET /users/{} operation']],
    ['operation: 2xx status removed', edit((d) => delete d.paths['/users/{id}'].get.responses[200]), ['remove GET /users/{}#200 operation']],
    ['operation: a 4xx status removed is fine', edit((d) => delete d.paths['/users/{id}'].get.responses[404]), []],
    ['param: header names compare lower case', edit((d) => d.paths['/users'].get.parameters.push({ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } })),
      ['required GET /users#header.x-tenant request'], edit((d) => d.paths['/users'].get.parameters.push({ name: 'x-tenant', in: 'header', schema: { type: 'string' } }))],
  ];
  for (const [name, head, want, base] of rows) assert.deepEqual(run(head, base), want, name);
});

test('K9 the change list is capped: over 1000 → throw (the CLI exits 6: a work red, never an out-of-heap infra)', () => {
  const wide = edit((d) => { for (let i = 0; i < 1001; i++) U(d).properties[`p${i}`] = { type: 'string' }; });
  assert.equal(diff(wide, wide).length, 0);
  assert.throws(() => diff(wide, BASE), /more than 1000 API changes/);
});

test('K9 a non-component $ref cycle (a linked list) ends: same doc → [], a change inside → named once', () => {
  const list = edit((d) => {
    d.components.x = { Node: { type: 'object', properties: { v: { type: 'integer' }, next: { $ref: '#/components/x/Node' } } } };
    d.paths['/list'] = { get: { responses: { 200: json({ $ref: '#/components/x/Node' }) } } };
  });
  assert.deepEqual(run(structuredClone(list), list), []);
  assert.deepEqual(run(edit((d) => { d.components.x.Node.properties.v = { type: 'string' }; }, structuredClone(list)), list), ['type GET /list#200.v response']);
});

test('K9 fail closed: not OpenAPI 3, an external $ref, a $ref → $ref cycle, nesting over DEPTH → throws', () => {
  let deep = { type: 'string' };
  for (let i = 0; i < 150; i++) deep = { type: 'object', properties: { a: deep } }; // 2 levels each: 300 > 256
  const nest = edit((d) => { d.paths['/deep'] = { get: { responses: { 200: json({ oneOf: [deep, { type: 'integer' }] }) } } }; });
  assert.throws(() => diff(nest, structuredClone(nest)), /a schema nests deeper than 256/);
  const chain = (n) => edit((d) => { // $ref → $ref → ... n hops, no cycle
    d.components.x = Object.fromEntries(Array.from({ length: n + 1 }, (_, i) => [`L${i}`, i === n ? { type: 'string' } : { $ref: `#/components/x/L${i + 1}` }]));
    d.paths['/chain'] = { get: { responses: { 200: json({ $ref: '#/components/x/L0' }) } } };
  });
  assert.deepEqual(run(chain(5), chain(5)), [], 'a short chain resolves');
  assert.throws(() => diff(chain(25), chain(25)), /a cycle or a chain over 20 hops/);
  assert.throws(() => diff({ swagger: '2.0', paths: {} }, BASE), /base: not an OpenAPI 3 document/);
  assert.throws(() => diff(BASE, edit((d) => { U(d).properties.x = { $ref: 'https://evil.example/x.json' }; })), /only local refs/);
  const loop = edit((d) => { d.components.schemas.A = ref('B'); d.components.schemas.B = ref('A'); U(d).properties.a = ref('A'); });
  assert.throws(() => diff(loop, edit((d) => { d.components.schemas.A = ref('B'); d.components.schemas.B = ref('A'); U(d).properties.a = { type: 'string' }; })), /a cycle/);
});

// ---- the CLI tbd runs as a child (--max-old-space-size=128) --------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-openapi-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const CLI = path.join(__dirname, '..', 'lib', 'gates', 'openapi.js');
const cli = (...args) => spawnSync(process.execPath, ['--max-old-space-size=128', CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
const put = (name, body) => {
  const f = path.join(DIR, name);
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};

test('K9 CLI: one JSON line + exit 0; missing 3, over 5 MB 4, link / outside root 5, bad JSON or spec 6', () => {
  const base = put('base.json', BASE);
  const wt = fs.mkdtempSync(path.join(DIR, 'wt-'));
  const head = path.join(wt, 'openapi.json');
  fs.writeFileSync(head, JSON.stringify(edit((d) => delete U(d).properties.nickname)));
  const ok = cli(base, head, wt);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { changes: [{ op: 'remove', ref: 'UserDto.nickname', dir: 'response', allowed: false }] });
  fs.symlinkSync(base, path.join(wt, 'link.json'));
  /** @type {[string, string[], number, RegExp][]} */
  const rows = [
    ['head missing', [base, path.join(wt, 'nope.json'), wt], 3, /ENOENT/],
    ['6 MB', [base, put('big.json', `{"openapi":"3.0.0","x":"${'a'.repeat(6 * 1024 * 1024)}"}`)], 4, /bytes, at most 5242880/],
    ['a link is refused, never followed', [base, path.join(wt, 'link.json'), wt], 5, /not a regular file/],
    ['head outside its root', [base, base, wt], 5, /outside/],
    ['not JSON', [base, put('bad.json', '{"openapi":')], 6, /not JSON/],
    ['not OpenAPI 3', [base, put('v2.json', { swagger: '2.0' })], 6, /not an OpenAPI 3 document/],
    ['usage', [base], 2, /usage/],
  ];
  for (const [name, args, code, msg] of rows) {
    const r = cli(...args);
    assert.deepEqual([r.status, r.stdout], [code, ''], name);
    assert.match(r.stderr, msg, name);
  }
});

test('K9 readSpec: a file swapped after the checks, before the open → refused (exit 5); untouched → parsed', () => {
  const f = put('swap.json', BASE);
  assert.equal(readSpec(f, DIR).openapi, '3.0.3');
  const other = put('other.json', { openapi: '3.0.3', paths: {} });
  assert.throws(() => readSpec(f, DIR, () => fs.renameSync(other, f)), { exit: 5, message: `${f}: changed while it was read` });
});
