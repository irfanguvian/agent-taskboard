'use strict';
// A8 [SR8]: tag def keys are an own-key allowlist (Object.prototype names → 400, never accepted or 500);
// a tag path must be absolute and normalized (no .., ., // or trailing /). Via POST /api/tags.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTbd } = require('./helpers/tbd');

let tbd;
before(async () => { tbd = await startTbd(); });
after(() => tbd.stop());

// A8
test('A8 prototype names as tag keys → 400 unknown tag key, nothing saved', async () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const r = await tbd.api('POST', '/api/tags', `{"name":"x","def":{"${key}":"v"}}`);
    assert.equal(r.status, 400, key);
    assert.match(r.json.error, /^unknown tag key/, key);
  }
  assert.deepEqual((await tbd.api('GET', '/api/tags')).json.tags, {});
});

// A8
test('A8 tag path must equal path.resolve(path); a normalized absolute path is saved', async () => {
  for (const p of ['/a/../b', '/a/./b', '/a//b', '/a/b/']) {
    assert.equal((await tbd.api('POST', '/api/tags', { name: 'y', def: { path: p, type: 'folder' } })).status, 400, p);
  }
  assert.equal((await tbd.api('POST', '/api/tags', { name: 'y', def: { path: '/a/b', type: 'folder' } })).status, 201);
});
