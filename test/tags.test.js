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

// ---- P5b: the P5 tag keys (gates/types.js TagP5), pure ----------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tags = require('../lib/tags');

test('P5 tag keys: valid defs pass; each bad value → 400 bad value for that key', () => {
  const ok = {
    path: '/a/b', type: 'git', base: 'main', checks: { unit: 'npm test', generate: './node_modules/.bin/prisma generate' },
    generated: ['prisma/migrations/**', 'src/generated/*'], rules: ['/Users/x/rules.md'], protected: ['package.json', 'test/utils/**'],
    test_globs: ['**/*.spec.ts'], test_scripts: '^test(:|$)', deny_ports: [5432, 7777], openapi: { cmd: 'npm run openapi:json', file: 'openapi.json' },
    prisma: { schema: 'prisma/', migrations: 'prisma/migrations' }, timeout_min: { unit: 30, test_cmd: 25 },
  };
  tags.validate('p5', ok);
  tags.validate('p5', { openapi: { cmd: 'npm run openapi:json' }, prisma: {} }); // file and both prisma paths default
  /** @type {[string, any][]} */
  const bad = [
    ['generated', ['**']], // matches a lockfile
    ['generated', ['package-lock.json']],
    ['generated', ['src/[ab]/*']], // only * and **
    ['generated', ['/abs/**']],
    ['rules', ['rules.md']], // relative
    ['rules', ['/a/../rules.md']], // not normalized
    ['protected', ['../x']],
    ['test_globs', ['a\nb']],
    ['test_scripts', '('],
    ['deny_ports', [0]], ['deny_ports', [70000]], ['deny_ports', ['5432']],
    ['openapi', { cmd: '' }], ['openapi', { cmd: 'x', file: '/etc/passwd' }], ['openapi', { cmd: 'x', run: 'y' }],
    ['prisma', { schema: '../p' }], ['prisma', { schema: 'prisma/', extra: 1 }],
    ['checks', { generate: '' }], ['checks', { generate: 'npx prisma generate' }], // D5: never npx
    ['timeout_min', { unit: 60 }], ['timeout_min', { deploy: 5 }], ['timeout_min', { unit: '5' }], // < 60 min slot hold; known checks; numbers
  ];
  for (const [k, v] of bad) assert.throws(() => tags.validate('p5', { [k]: v }), new RegExp(`bad value for tag key "${k}"`), `${k} ${JSON.stringify(v)}`);
});

test('P5 gateTag: defaults filled; old shapes mapped at read time (checks.openapi → openapi, prisma_diff → prisma); new keys win', () => {
  const old = tags.gateTag({ checks: { unit: 'npm test', openapi: 'npm run openapi:json', prisma_diff: true } });
  assert.deepEqual(old.openapi, { cmd: 'npm run openapi:json', file: 'openapi.json' });
  assert.deepEqual(old.prisma, { schema: 'prisma/', migrations: 'prisma/migrations' });
  assert.deepEqual(old.checks, { unit: 'npm test' }, 'old keys leave checks');
  assert.deepEqual([old.protected, old.test_globs, old.test_scripts, old.generated, old.rules, old.deny_ports], [ // contract R2, K7, RO4
    ['package.json', '.npmrc', 'tsconfig*.json', 'jest.config.*', 'vitest.config.*', 'babel.config.*', '.swcrc', 'nest-cli.json', 'prisma.config.ts', 'test/utils/**', 'test/helpers/**'],
    ['**/*.{test,spec,e2e-spec}.*', 'test/**', '__tests__/**'], '^test(:|$)', [], [], []]);
  const none = tags.gateTag({ checks: { prisma_diff: false } });
  assert.deepEqual([none.openapi, none.prisma], [undefined, undefined], 'no shape set → that check is skipped');
  const both = tags.gateTag({ openapi: { cmd: 'new' }, prisma: { schema: 'db/schema.prisma' }, checks: { openapi: 'old', prisma_diff: true }, protected: ['src/keys/**', 'package.json'] });
  assert.deepEqual([both.openapi, both.prisma], [{ file: 'openapi.json', cmd: 'new' }, { schema: 'db/schema.prisma', migrations: 'prisma/migrations' }]);
  assert.deepEqual(both.protected, [...old.protected, 'src/keys/**'], 'R2 (Irfan 2026-10-11): a tag adds to the defaults, never drops one; no duplicates');
});

test('T1 checkRules: plain files ≤ 8 KB together pass; a link, a missing file or > 8 KB → 400', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = (name, size) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x'.repeat(size));
    return p;
  };
  const [a, b] = [f('a.md', 4096), f('b.md', 4096)];
  await tags.checkRules([a, b]);
  await tags.checkRules(undefined);
  fs.symlinkSync(a, path.join(dir, 'link.md'));
  await assert.rejects(tags.checkRules([path.join(dir, 'link.md')]), /not a plain file \(links are refused\)/);
  await assert.rejects(tags.checkRules([path.join(dir, 'nope.md')]), /not a plain file/);
  await assert.rejects(tags.checkRules([a, b, f('c.md', 1)]), { status: 400, message: 'tag rules: 8193 bytes in all, at most 8192 (never truncated)' });
});
