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

test('check timeouts: one resolver for gates and doctor --tag: tag timeout_min, else config, else the default, under the max hold', () => {
  /** @type {[string, any, any, number][]} */
  const rows = [
    ['unit', {}, {}, 20], ['lint', {}, {}, 10], ['setup', {}, {}, 15], ['nope', {}, {}, 15],
    ['unit', { timeout_min: { unit: 30 } }, { gates: { timeout_min: { unit: 25 } } }, 30],
    ['unit', {}, { gates: { timeout_min: { unit: 25 } } }, 25],
    ['unit', { timeout_min: { unit: 50 } }, { slots: { max_hold_min: 40 } }, 39],
  ];
  for (const [key, tag, config, min] of rows) assert.equal(tags.checkTimeoutMs(key, tag, config), min * 60_000, `${key} ${JSON.stringify([tag, config])}`);
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

// ---- M5.2: the qa_ports + db keys (contract rev 4 C6 C7) and the DB guard util.dbLocal (C7, D-0087), pure ---------------
const { dbLocal } = require('../lib/util');

test('M5 C6 C7 tag keys: qa_ports a list of ports, db only "local"; any other value → 400', () => {
  tags.validate('m5', { qa_ports: [3000, 8080], db: 'local' });
  /** @type {[string, any][]} */
  const bad = [['qa_ports', [0]], ['qa_ports', ['3000']], ['qa_ports', 3000], ['db', 'remote'], ['db', true]];
  for (const [k, v] of bad) {
    assert.throws(() => tags.validate('m5', { [k]: v }), new RegExp(`bad value for tag key "${k}"`), `${k} ${JSON.stringify(v)}`);
  }
});

test('M5 C7 dbLocal: postgres URLs + PGHOST on localhost / 127.0.0.1 / [::1] (any dotenv form; empty PGHOST = unset) pass; a remote host (also quoted + # comment, KEY: v, backticks, a +driver scheme, mid-value, a # or ?…@ before the path, where libpq reads another host), ?host=, ?service=, PGSERVICE(FILE), a remote PGHOST, an unparsable URL or env file fail', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tag = { path: dir, env_files: ['.env'] };
  const env = (text) => { fs.rmSync(path.join(dir, '.env'), { force: true }); fs.writeFileSync(path.join(dir, '.env'), text); return tag; };
  for (const text of [
    'DATABASE_URL=postgres://u:p@localhost:5432/app\nPGHOST=localhost\n',
    'export DATABASE_URL="postgresql://u@127.0.0.1/app?sslmode=disable"\nPGHOSTADDR=127.0.0.1\n',
    "DATABASE_URL='postgres://u@[::1]:5432/app'\nPGHOST=::1\n",
    'DATABASE_URL: "postgres://u@localhost/app" # local\r\nPGHOST=\nPGHOSTADDR= # unset\n',
    'DATABASE_URL=postgres://u:p@localhost:5432/app?sslmode=disable\n',
  ]) assert.deepEqual(await dbLocal(env(text)), { ok: true }, text);
  /** @type {[string, RegExp][]} */
  const bad = [
    ['DATABASE_URL=postgres://u:p@db.example.com:5432/app\n', /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL=postgresql://u@localhost/app?sslmode=disable&host=10.0.0.5\n', /DATABASE_URL: a host=, hostaddr= or service= param/],
    ['DATABASE_URL=postgresql://u@localhost/app?hostaddr=10.0.0.5\n', /DATABASE_URL: a host=, hostaddr= or service= param/],
    ['DATABASE_URL=postgresql://u@localhost/app?service=prod\n', /DATABASE_URL: a host=, hostaddr= or service= param/],
    ['DATABASE_URL=postgres://u@localhost/app\nPGSERVICE=prod\n', /PGSERVICE: a pg service may name any host/],
    ['DATABASE_URL=postgres://u@localhost/app\nPGSERVICEFILE=/tmp/pg_service.conf\n', /PGSERVICEFILE: a pg service may name any host/],
    ['DATABASE_URL=postgres://u@localhost/app\nPGHOST=db.example.com\n', /PGHOST is not localhost/],
    ['DATABASE_URL=postgres://u@[::1/app\n', /DATABASE_URL: a postgres URL that does not parse/],
    ['DATABASE_URL="postgres://u@db.prod.example.com/app" # prod\n', /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL: postgres://u@db.prod.example.com/app\n', /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL=`postgres://u@db.prod.example.com/app`\n', /DATABASE_URL: postgres host is not/],
    ["export DATABASE_URL='postgres://u@db.prod.example.com/app' # prod\n", /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL=postgresql+asyncpg://u@db.prod.example.com/app\n', /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL=jdbc:postgresql://u@db.prod.example.com/app\n', /DATABASE_URL: postgres host is not/],
    ['DATABASE_URL=postgres://localhost#@db.prod.example.com/app\n', /DATABASE_URL: libpq reads another host/],
    ['DATABASE_URL=postgres://localhost?@db.prod.example.com/app\n', /DATABASE_URL: libpq reads another host/],
    ['DATABASE_URL=postgres://localhost#,db.prod.example.com/app\n', /DATABASE_URL: libpq reads another host/],
  ];
  for (const [text, why] of bad) assert.match((await dbLocal(env(text))).why ?? 'passed', why, text);
  fs.rmSync(path.join(dir, '.env'));
  fs.symlinkSync('/etc/hosts', path.join(dir, '.env'));
  assert.match((await dbLocal(tag)).why ?? 'passed', /env file ".env": not a plain file/, 'an env file it cannot read fails closed');
});
