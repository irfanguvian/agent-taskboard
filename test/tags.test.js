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

// ---- M5.3: the ident + push keys (contract rev 4 C1 C12 C14) and util's git opts, d34 and ident (C12 C14, D34) ----------
const { execFileSync } = require('node:child_process');
const sh = require('../lib/sh');
const { git, d34, ident, SHA_RE } = require('../lib/util');
const EMAIL = 'i@example.com';

test('M5 C12 C14 tag keys: ident {name, email} a plain git ident, push {remote} a remote name; any other shape → 400', () => {
  tags.validate('m53', { ident: { name: 'Irfan G', email: 'i.g+tb@mail.example.com' }, push: { remote: 'mirror' } });
  tags.validate('m53', { ident: { name: 'x'.repeat(100), email: `${'a'.repeat(188)}@example.com` }, push: { remote: `my_remote-1.${'x'.repeat(52)}` } });
  /** @type {[string, any][]} */
  const bad = [
    ['ident', { name: 'Irfan' }], ['ident', { name: 'Irfan', email: EMAIL, extra: 1 }], ['ident', 'Irfan <i@example.com>'],
    ['ident', { name: '', email: EMAIL }], ['ident', { name: '  ', email: EMAIL }], ['ident', { name: 'x'.repeat(101), email: EMAIL }],
    ['ident', { name: 'a\nb', email: EMAIL }], ['ident', { name: 'a\u0007', email: EMAIL }], ['ident', { name: 'a <b@c.com>', email: EMAIL }],
    ['ident', { name: 'I', email: 'no-at' }], ['ident', { name: 'I', email: 'a@b@c' }], ['ident', { name: 'I', email: 'a b@c' }],
    ['ident', { name: 'I', email: '<a@b>' }], ['ident', { name: 'I', email: `${'a'.repeat(189)}@example.com` }], ['ident', { name: 'I', email: 'a@b\u0000' }],
    ['push', { remote: '' }], ['push', { remote: 'x'.repeat(65) }], ['push', { remote: 'https://github.com/x/y.git' }], ['push', { remote: '--force' }],
    ['push', { remote: 'a b' }], ['push', { remote: 'mirror', branch: 'main' }], ['push', 'mirror'],
  ];
  for (const [k, v] of bad) assert.throws(() => tags.validate('m53', { [k]: v }), new RegExp(`bad value for tag key "${k}"`), `${k} ${JSON.stringify(v)}`);
});

test('M5 C12 C14 util.git: add sets vars as given (env is only what the minimal env is picked from); system reads the system config and never prompts; by default no system config, whatever add says', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-opts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sys = path.join(dir, 'system.gitconfig');
  fs.writeFileSync(sys, '[tb]\n\tprobe = system\n');
  const who = { GIT_AUTHOR_NAME: 'Irfan G', GIT_AUTHOR_EMAIL: EMAIL };
  const author = async (o) => (await git(dir, ['var', 'GIT_AUTHOR_IDENT'], o)).stdout;
  assert.match(await author({ add: who }), /^Irfan G <i@example\.com> \d+ [+-]\d{4}\n$/);
  assert.doesNotMatch(await author({ env: { ...process.env, ...who } }), /Irfan G/, 'env vars outside the minimal set are dropped (hazard c)');
  const probe = async (o) => (await git(dir, ['config', '--get', 'tb.probe'], o)).stdout.trim();
  assert.equal(await probe({ system: true, add: { GIT_CONFIG_SYSTEM: sys } }), 'system');
  assert.equal(await probe({ add: { GIT_CONFIG_SYSTEM: sys, GIT_CONFIG_NOSYSTEM: '0' } }), '', 'GIT_ENV wins over add');
  // the child's real env in system mode: the minimal env + add + the 3 system vars; no GIT_CONFIG_NOSYSTEM, nothing else
  const env = (await git(dir, [], { system: true, add: { GIT_AUTHOR_NAME: 'Irfan G' }, env: { PATH: '/usr/bin:/bin', HOME: dir, SECRET: 's', GIT_CONFIG_NOSYSTEM: '1' },
    exec: (_bin, _args, o) => sh('/usr/bin/env', [], o) })).stdout.trim().split('\n').sort();
  assert.deepEqual(env, [`HOME=${dir}`, 'GIT_AUTHOR_NAME=Irfan G', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_TERMINAL_PROMPT=0', 'PATH=/usr/bin:/bin'].sort());
});

test('D34 util.d34: the first line with co-authored-by: then Claude or Anthropic, or with "generated with" (any case); claude elsewhere → null', () => {
  assert.equal(d34('fix\n\nCo-Authored-By: Claude <noreply@x.com>\n'), 'Co-Authored-By: Claude <noreply@x.com>');
  assert.equal(d34('feat\n\nco-authored-by: Bot (ANTHROPIC)'), 'co-authored-by: Bot (ANTHROPIC)');
  assert.equal(d34('docs\n\n  GENERATED WITH some tool  \nmore'), 'GENERATED WITH some tool');
  assert.equal(d34('fix claude_bin path\n\nco-authored-by: Bob <b@x.com>\nsee the anthropic docs'), null);
});

test('M5 C12 util.ident: the tag ident; a push tag without one → error; else the tested commit\'s author; a malformed ident or one naming Claude / Anthropic → error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args, env = {}) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }, encoding: 'utf8' }).trim();
  run(['init', '-q']);
  const commit = (name, email) => {
    run(['commit', '-q', '--allow-empty', '-m', 'x'], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'c', GIT_COMMITTER_EMAIL: 'c@example.com' });
    return run(['rev-parse', 'HEAD']);
  };
  const tested = commit('Irfan G', EMAIL);
  const tk = { id: 't_ident1', tag: 'self/x', worktree: dir };
  const mine = { name: 'Irfan Tag', email: 'tag@example.com' };
  assert.deepEqual(await ident(tk, tested, { ident: mine, push: { remote: 'mirror' } }), { ...mine, from: 'tag' });
  assert.deepEqual(await ident(tk, tested, { push: { remote: 'mirror' } }), { error: 'ident not set: run tb doctor --tag self/x --ident' });
  assert.deepEqual(await ident(tk, tested, {}), { name: 'Irfan G', email: EMAIL, from: 'commit' });
  for (const [name, email] of [['Claude', 'c@example.com'], ['Bot', 'noreply@anthropic.com']]) {
    assert.match((await ident(tk, commit(name, email), {})).error ?? 'passed', /commit ident names Claude or Anthropic/, name);
  }
  assert.match((await ident(tk, tested, { ident: { name: 'claude', email: EMAIL } })).error ?? 'passed', /tag ident names Claude or Anthropic/);
  assert.match((await ident(tk, commit('Irfan', 'no-at'), {})).error ?? 'passed', /commit ident is no git name \+ email/);
  assert.match((await ident(tk, 'f'.repeat(40), {})).error ?? 'passed', /git log failed/);
  assert.match((await ident(tk, 'HEAD', {})).error ?? 'passed', /no tested commit/);
});

test('M5.3 L6 util.SHA_RE: a SHA-1 (40 hex) or SHA-256 (64 hex) commit name, nothing between; ident takes a 64-hex tested commit', async () => {
  for (const n of [40, 64]) assert.ok(SHA_RE.test('a'.repeat(n)), String(n));
  for (const x of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(40), `${'a'.repeat(40)}\n`]) assert.ok(!SHA_RE.test(x), JSON.stringify(x));
  const tk = { id: 't_ident2', tag: 'self/x', worktree: os.tmpdir() };
  assert.match((await ident(tk, 'f'.repeat(64), {})).error ?? 'passed', /git log failed/, 'past the check: git is asked');
  assert.match((await ident(tk, 'f'.repeat(50), {})).error ?? 'passed', /no tested commit/);
});

// M7 review: a tag name is passed to tb as an argument (copy-command forms, doctor --tag): it never starts with -
test('M7 NAME_RE: a or a/b of lowercase letters, digits and - (a and a-b/c-1 ok); a name starting with - (-x, --setup) refused', () => {
  for (const ok of ['a', 'a/b', 'shop', 'self/taskboard', 'a-b/c-1', '9x']) assert.ok(tags.NAME_RE.test(ok), ok);
  for (const bad of ['-x', '--setup', '-', 'A', 'a b', 'a//b', '/a', 'a/']) assert.equal(tags.NAME_RE.test(bad), false, bad);
});
