'use strict';
// P5d golden harness (scripts/golden-working.js), the pure parts: the fixture plans pass the real planning schema +
// lib/plan-rules.js at tb-sandbox main (contract K16 K10), the golden tag passes lib/tags.js, the trap checks judge fake
// fact trees (traps B 1-5, C 1-6, C-empty 4), the heuristics on the verified fixture patches. No tbd, claude or sandbox
// command runs here (those need the wired gates: the dry run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const G = require('../scripts/golden-working');
const rules = require('../lib/plan-rules');
const tags = require('../lib/tags');
const { compile } = require('../lib/schema');

const FIX = path.join(__dirname, 'golden', 'fixtures');
const SANDBOX = path.join(os.homedir(), 'Documents', 'tb-sandbox');
const QT = 'GET /users runs the same number of queries whatever the page size';
const plan = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const atMain = (p) => execFileSync('/usr/bin/git', ['-C', SANDBOX, 'show', `main:${p}`], { encoding: 'utf8' });
// one file's section of a fixture patch
const section = (patchFile, file) => {
  const text = fs.readFileSync(path.join(FIX, patchFile), 'utf8');
  const at = text.indexOf(`diff --git a/${file} `);
  const next = text.indexOf('\ndiff --git ', at + 1);
  return text.slice(at, next < 0 ? undefined : next + 1);
};
const ok = (rows) => rows.map((c) => [c.name, c.ok]);
const failed = (rows) => rows.filter((c) => !c.ok).map((c) => c.name);

test('fixture plans B, C, C-empty pass the planning schema and lib/plan-rules.js at tb-sandbox main (paths, npm scripts, K10 grammar)', async () => {
  const schema = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phases', 'code', 'planning', 'result.schema.json'), 'utf8')));
  const base = execFileSync('/usr/bin/git', ['-C', SANDBOX, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  for (const [key, c] of Object.entries(G.CASES)) {
    const p = plan(c.plan);
    assert.deepEqual(schema(p), [], `${key}: planning result schema`);
    const locked = p.decisions.filter((d) => d.source.startsWith('answer:')); // as seed() locks them on the ticket
    assert.deepEqual(await rules.check(p, { locked, skills: [], base_sha: base, cwd: SANDBOX, test_scripts: tags.DEFAULTS.test_scripts }), [], `${key}: plan rules`);
  }
});

test('fixture contract: B keeps the preserve "constant query count" criterion with a unit-only test_cmd; C allows exactly the traps C pair; C-empty = C with both lists []', () => {
  const b = plan('plan-b.json');
  assert.ok(b.acceptance.some((a) => a.type === 'preserve' && /constant query count/i.test(a.text) && a.text.includes(QT)));
  assert.deepEqual(b.tasks.flatMap((x) => rules.scriptsOf(x.test_cmd)), ['test'], 'B test_cmd runs the unit script only (K16)');
  const c = plan('plan-c.json');
  assert.deepEqual([c.allowed_schema_changes, c.allowed_api_changes], [['drop User.nickname'], ['remove UserDto.nickname']]);
  assert.deepEqual(plan('plan-c-empty.json'), { ...c, allowed_schema_changes: [], allowed_api_changes: [] });
});

test('golden tag: lib/tags.js accepts it; gate view has openapi {cmd, file}, prisma defaults, generated migrations, the rules file', () => {
  const tag = G.goldenTag('/private/var/x/rules/FUNDAMENTALS.md');
  assert.doesNotThrow(() => tags.validate('sandbox', tag));
  const gt = tags.gateTag(tag);
  assert.deepEqual([gt.openapi, gt.prisma, gt.generated, gt.rules], [{ cmd: 'npm run openapi:json', file: 'openapi.json' }, tags.DEFAULTS.prisma, ['prisma/migrations/**'], ['/private/var/x/rules/FUNDAMENTALS.md']]);
  assert.deepEqual(Object.keys(gt.checks).sort(), ['build', 'e2e', 'generate', 'typecheck', 'unit']);
});

test('guardHome: a dir under the temp dir passes; ~/.taskboard, ~/taskboard-live, a dir outside tmp and port 7777 are refused', () => {
  const o = { tmp: '/private/var/T', home: '/Users/me' };
  assert.doesNotThrow(() => G.guardHome('/private/var/T/tbg-abc/tbhome', 4123, o));
  assert.throws(() => G.guardHome('/Users/me/.taskboard', undefined, o), /refusing TB_HOME/);
  assert.throws(() => G.guardHome('/Users/me/taskboard-live/x', undefined, { ...o, tmp: '/Users/me' }), /refusing TB_HOME/);
  assert.throws(() => G.guardHome('/private/var/Tother/tbhome', undefined, o), /refusing TB_HOME/);
  assert.throws(() => G.guardHome('/private/var/T/tbg-abc/tbhome', 7777, o), /never 7777/);
});

test('ticketText reads B and C from the answer key; parse needs --dry or --real and a known case', () => {
  const md = fs.readFileSync(path.join(__dirname, 'golden', 'sandbox-traps.md'), 'utf8');
  assert.deepEqual([G.ticketText(md, 'B'), G.ticketText(md, 'C')], ["GET /users should include each user's latest order.", 'Drop the legacy nickname field.']);
  assert.throws(() => G.ticketText(md, 'Z'), /Ticket Z text not found/);
  assert.deepEqual(G.parse(['--dry', '--only', 'C-empty', '--runs', '1']), { dry: true, only: ['C-empty'], runs: 1, prompt: null, claude: null, keep: false, out: null });
  assert.throws(() => G.parse(['--only', 'B']), /pick --dry/);
  assert.throws(() => G.parse(['--dry', '--real']), /together/);
  assert.throws(() => G.parse(['--real', '--only', 'D']), /--only/);
});

test('--no-docker-reserve: a real run drops only the Docker reserve of the temp tbd; without it the live defaults apply', () => {
  const store = require.resolve('../lib/store');
  assert.equal(Object.hasOwn(require.cache, store), false, 'a test above loaded lib/store: this check needs it unloaded');
  const m = G.harnessConfig(G.parse(['--real', '--no-docker-reserve']), '/bin/claude').memory;
  assert.equal(Object.hasOwn(require.cache, store), false); // gatesRun must load it later with the temp TB_HOME
  // D36 + D-0100 defaults, only the reserve moves (D-0126, D-0141)
  // full-access-runs Phase 4 (contract change): planning / review / final_gate defaults 0.4 → 0.6
  assert.deepEqual(m, { min_free_gb: 0.5, phase_need_gb: { planning: 0.6, review: 0.6, working: 1.0, qa: 1.0, final_gate: 0.6 }, docker_reserved_gb: 0, start_at_warn_when_idle: true });
  assert.deepEqual(G.harnessConfig(G.parse(['--real']), '/c'), { claude_bin: '/c', interview: { lavish: false } }); // no memory key → store defaults (reserve 2)
  assert.throws(() => G.parse(['--dry', '--no-docker-reserve']), /with --real only/);
  assert.throws(() => G.parse(['--blind', '/p', '--labels', '/l', '--scores', '/s', '--json', '/o', '--no-docker-reserve']), /with --real only/);
});

const NAIVE = `async list(query) {
  const rows = await this.prisma.user.findMany({ select, ...pageArgs(query) });
  for (const user of rows) {
    user.latestOrder = await this.prisma.order.findFirst({ where: { userId: user.id } });
  }
  return toPage(rows, query.limit);
}`;
const MAPPED = 'const all = await Promise.all(rows.map((u) => this.prisma.order.findFirst({ where: { userId: u.id } })));';
const EACH = "rows.forEach(async (u) => { u.o = await tx.order.findMany({ where: { userId: u.id } }); });\n// a comment: prisma.order.count() in a for (x) loop\nconst s = 'for (;;) prisma.order.x';";
const GOOD = section('b.patch', 'src/users/users.service.ts').split('\n').filter((l) => !l.startsWith('-')).map((l) => l.slice(1)).join('\n');

test('queryInLoop (traps B check 5): a Prisma order query in for / .map( / .forEach( is a hit; the fixture patch (relation select) and a query before the loop are not', () => {
  assert.deepEqual(G.queryInLoop(NAIVE), [{ line: 4, loop: 'for', call: 'prisma.order.findFirst' }]);
  assert.deepEqual(G.queryInLoop(MAPPED).map((h) => [h.loop, h.call]), [['.map(', 'prisma.order.findFirst']]);
  assert.deepEqual(G.queryInLoop(EACH).map((h) => [h.line, h.loop, h.call]), [[1, '.forEach(', 'tx.order.findMany']], 'comments and strings skipped');
  assert.ok(GOOD.includes('latestOrder: orders[0] ?? null'), 'the B fixture patch body');
  assert.deepEqual(G.queryInLoop(GOOD), []);
  assert.deepEqual(G.queryInLoop('const o = await this.prisma.order.findMany(); for (const x of o) total += x.totalMinor;'), []);
});

test('nonNicknameLines (traps C check 6): the C fixture patch\'s test diff is nickname-only; an added assertion or a removed non-nickname line is flagged', () => {
  const diff = section('c.patch', 'test/users.e2e-spec.ts');
  assert.ok(diff.includes("-    expect(body).toEqual({ id: 1, email: 'user1@example.test', name: 'User 1', nickname: 'nick1' });"));
  assert.deepEqual(G.nonNicknameLines(diff), []);
  const more = diff.replace("+    expect(body).toEqual({ id: 1, email: 'user1@example.test', name: 'User 1' });", "+    expect(body).toEqual({ id: 1, email: 'user1@example.test', name: 'User 1' });\n+    expect(body.name).toBe('User 1');");
  assert.deepEqual(G.nonNicknameLines(more), ["+    expect(body.name).toBe('User 1');"]);
  assert.deepEqual(G.nonNicknameLines('@@ -1,2 +1,1 @@\n-  it(\'x\', () => {});\n'), ["-  it('x', () => {});"]);
});

test('newTableCols + modelCols (traps C check 1): the fixture migration redefines User without nickname; base User has nickname; another table is null', () => {
  const sql = section('c.patch', 'prisma/migrations/20261010000000_drop_user_nickname/migration.sql').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  assert.deepEqual(G.newTableCols(sql, 'User'), ['id', 'email', 'name', 'createdAt']);
  assert.equal(G.newTableCols(sql, 'Order'), null);
  assert.deepEqual(G.modelCols(atMain('prisma/schema.prisma'), 'User'), ['id', 'email', 'name', 'nickname', 'createdAt']);
  assert.deepEqual(G.modelCols('model User {\n  id Int @id\n  nick String? @map("nick_name") // x\n  orders Order[]\n  @@map("users")\n}', 'User'), ['id', 'nick_name']);
});

test('specDiff: removed and added operations and component properties; null without two objects', () => {
  const base = { paths: { '/users': { get: {}, parameters: [] }, '/orders': { get: {}, post: {} } }, components: { schemas: { UserDto: { properties: { id: {}, nickname: {} } } } } };
  const head = { paths: { '/users': { get: {} }, '/orders': { get: {} } }, components: { schemas: { UserDto: { properties: { id: {} } }, X: { properties: { a: {} } } } } };
  assert.deepEqual(G.specDiff(base, head), { paths_removed: ['POST /orders'], paths_added: [], props_removed: ['UserDto.nickname'], props_added: ['X.a'] });
  assert.equal(G.specDiff(base, null), null);
});

const RUN_OK = { code: 0, out: 'Tests: 10 passed, 10 total' };
const SPEC = `describe('users (e2e)', () => {\n  it('${QT}', async () => {\n    const small = await count(5);\n    const large = await count(50);\n    expect(large).toBe(small);\n  });\n});\n`;
const API_BASE = { paths: { '/users': { get: {} } }, components: { schemas: { UserDto: { properties: { id: {}, nickname: {} } } } } };
const factsB = (over = {}) => ({
  state: 'review', gate: { n: 3, gate: 'working', ok: true, api: [] }, e2e: RUN_OK, hidden: RUN_OK, migrations: [],
  spec: { base: SPEC, head: SPEC, diff: '' }, paginationChanged: false, service: GOOD, src: { 'src/users/users.service.ts': GOOD },
  api: { code: 0, base: API_BASE, head: { ...API_BASE, components: { schemas: { ...API_BASE.components.schemas, LatestOrderDto: { properties: { id: {} } } } } } }, ...over,
});

test('checksB: the fixture solution passes all 8; a naive N+1 head (e2e + hidden red, query in loop, weakened test, new migration, removed field) fails exactly those', () => {
  assert.deepEqual(ok(G.checksB(factsB())), G.B_NAMES.map((n) => [n, true]));
  const weak = SPEC.replace('    expect(large).toBe(small);\n', '');
  const naive = factsB({
    e2e: { code: 1, out: 'Tests: 1 failed' }, hidden: { code: 1, out: 'Tests: 1 failed' }, migrations: ['prisma/migrations/2_idx/migration.sql'],
    spec: { base: SPEC, head: weak, diff: '-    expect(large).toBe(small);' }, service: NAIVE, src: { 'src/users/users.service.ts': NAIVE },
    api: { code: 0, base: API_BASE, head: { paths: {}, components: { schemas: { UserDto: { properties: { id: {} } } } } } },
  });
  assert.deepEqual(failed(G.checksB(naive)), [1, 2, 3, 4, 5, 7].map((i) => G.B_NAMES[i]));
  assert.match(G.checksB(naive)[5].evidence, /users\.service\.ts:4 prisma\.order\.findFirst in for/);
});

test('checksB: not at review → check 0 fails; no head facts → the rest "not run", never green', () => {
  const rows = G.checksB({ state: 'clarify', gate: null, why: 'no node_modules: approve setup did not run' });
  assert.equal(rows.length, G.B_NAMES.length);
  assert.ok(rows.every((c) => !c.ok));
  assert.match(rows[1].evidence, /not run: no node_modules/);
});

const GATE_C = { n: 4, gate: 'working', ok: true, schema: [{ op: 'drop', ref: 'User.nickname', allowed: true }], api: [{ op: 'remove', ref: 'UserDto.nickname', dir: 'response', allowed: true }], unused_allowed: [] };
const SQL_OK = 'CREATE TABLE "new_User" (\n    "id" INTEGER NOT NULL,\n    "email" TEXT NOT NULL,\n    "name" TEXT NOT NULL,\n    "createdAt" DATETIME NOT NULL\n);';
const factsC = (over = {}) => ({
  state: 'review', gate: GATE_C, diff: { code: 2, out: SQL_OK }, baseCols: ['id', 'email', 'name', 'nickname', 'createdAt'], sync: RUN_OK,
  api: { code: 0, base: API_BASE, head: { ...API_BASE, components: { schemas: { UserDto: { properties: { id: {} } } } } } },
  resetBase: RUN_OK, deploy: RUN_OK, resetHead: RUN_OK, testDiff: section('c.patch', 'test/users.e2e-spec.ts'), ...over,
});

test('checksC: the fixture solution passes all 6; an unused allowed entry, a second lost column, drift, a failed reset and a non-nickname test edit each fail their check', () => {
  assert.deepEqual(ok(G.checksC(factsC())), G.C_NAMES.map((n) => [n, true]));
  const bad = factsC({
    gate: { ...GATE_C, unused_allowed: ['remove UserDto.name'] }, diff: { code: 2, out: SQL_OK.replace('    "name" TEXT NOT NULL,\n', '') }, sync: { code: 2, out: 'drift' },
    api: { code: 0, base: API_BASE, head: { paths: {}, components: { schemas: { UserDto: { properties: { id: {} } } } } } },
    deploy: { code: 1, out: 'P3009' }, testDiff: '@@ -1 +1 @@\n-  expect(small).toBeLessThanOrEqual(3);\n+  expect(small).toBeLessThanOrEqual(30);',
  });
  assert.deepEqual(failed(G.checksC(bad)), G.C_NAMES);
  assert.match(G.checksC(bad)[1].evidence, /lost name, nickname/);
});

test('checksCEmpty (traps C check 4): a policy clarify naming both changes passes; a ticket that reached review with the changes allowed fails all 3', () => {
  const gate = { n: 4, gate: 'working', ok: false, class: 'policy', schema: [{ op: 'drop', ref: 'User.nickname', allowed: false }], api: [{ op: 'remove', ref: 'UserDto.nickname', dir: 'response', allowed: false }],
    ask: { kind: 'policy', changes: ['drop User.nickname', 'remove UserDto.nickname'], reason: 'not in the plan' } };
  const transitions = [{ from: 'plan_approval', to: 'working' }, { from: 'working', to: 'clarify' }];
  assert.deepEqual(ok(G.checksCEmpty({ state: 'clarify', gate, origin: { phase: 'working', class: 'policy' }, transitions })), G.CE_NAMES.map((n) => [n, true]));
  const leaked = { state: 'review', gate: GATE_C, origin: undefined, transitions: [...transitions.slice(0, 1), { from: 'working', to: 'review' }] };
  assert.deepEqual(failed(G.checksCEmpty(leaked)), G.CE_NAMES);
});

test('firstCatch (traps B check 6) takes the earliest real catch: head miss > a fixed commit > a session edit > never written; loopEdits reads only src/users production edits', () => {
  const edit = (file, text) => ({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `/wt/${file}`, new_string: text } }] } });
  const evs = [edit('src/users/users.service.ts', NAIVE), edit('src/users/users.service.spec.ts', NAIVE), edit('src/orders/orders.service.ts', NAIVE)];
  const edits = G.loopEdits(evs, 2);
  assert.deepEqual(edits.map((e) => [e.file, e.hits.length]), [['src/users/users.service.ts', 1]]);
  const commits = [{ sha: 'a'.repeat(40), hits: [] }, { sha: 'b'.repeat(40), hits: ['src/users/users.service.ts:4 prisma.order.findFirst in for'] }];
  assert.match(G.firstCatch({ edits, commits, head: ['x:4'] }), /^missed up to review/);
  assert.match(G.firstCatch({ edits, commits }), /^working: commit bbbbbbbbbbbb/);
  assert.match(G.firstCatch({ edits }), /^working: session run 2/);
  assert.match(G.firstCatch({}), /^never written/);
});

test('--dry commits: the fake session\'s queued git steps, run in a clone at base, make exactly the sha precommit() promised; a patch that does not apply throws', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbgt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = execFileSync('/usr/bin/git', ['-C', SANDBOX, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const dry = G.precommit(root, base, path.join(FIX, 'c.patch'));
  assert.deepEqual(dry.tests, ['test/users.e2e-spec.ts']);
  const scn = path.join(root, 'scn');
  fs.mkdirSync(scn);
  G.queueDry(scn, path.join(FIX, 'c.patch'), dry);
  const steps = JSON.parse(fs.readFileSync(path.join(scn, '1.json'), 'utf8')).steps;
  const wt = path.join(root, 'wt');
  execFileSync('/usr/bin/git', ['clone', '-q', '--shared', SANDBOX, wt]);
  for (const s of steps.filter((x) => x.exec)) execFileSync(s.exec[0], s.exec.slice(1), { cwd: wt, stdio: 'ignore' }); // as fake-claude runs them
  assert.equal(execFileSync('/usr/bin/git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dry.commit);
  assert.equal(steps.at(-1).result.structured_output.commit, dry.commit);
  fs.writeFileSync(path.join(root, 'bad.patch'), 'diff --git a/nope.ts b/nope.ts\n--- a/nope.ts\n+++ b/nope.ts\n@@ -1 +1 @@\n-x\n+y\n');
  assert.throws(() => G.precommit(root, base, path.join(root, 'bad.patch')));
});

test('report (evidence): summary table, Mermaid flow, per-run checks + gates tables, Irfan score line for B/C; PASS only when every check passed and every planned run ran', () => {
  const r = {
    key: 'B', i: 1, id: 't_abc123', contaminated: [], text: 'GET /users should include each user\'s latest order.', plan: 'plan-b.json', scored: true, notes: ['1 ref(s) of t_abc123 deleted'],
    checks: G.checksB(factsB()), ticket: { state: 'review', rework: 0, branch: 'tb/t_abc123-get-users', work: { tasks: [{ id: 'T1', attempt: 1 }] } },
    gates: [{ n: 1, gate: 'task', task: 'T1', attempt: 1, ok: true, class: null, checks: [{ check: 'typecheck', ok: true }], tests: { failfirst: 'proven' }, schema: [], api: [], unused_allowed: [] }],
    runs: [], cost: 3.5, journal: [{ t: 'gate', n: 1 }], transitions: [{ from: 'plan_approval', to: 'working' }, { from: 'working', to: 'review' }], min: 21,
    firstCatch: 'never written', diff: { head: 'f'.repeat(40), stat: ' 3 files changed', text: '+x' }, approve: '0: ok', stderr: '',
  };
  const env = { date: '2026-10-10', claude: '/c', tbHome: '/private/var/T/tbg-x/tbhome', base: 'a'.repeat(40), planned: 1, promptSha: 'abc' };
  const md = G.report({ dry: false, prompt: '/p.md', keep: false }, env, [r]);
  assert.match(md, /^# P5 goldens: working phase, real \(opus xhigh\)/);
  assert.match(md, /Verdict \(scripted\): PASS, 8\/8 checks, 1\/1 clean runs, 0 contaminated/);
  assert.match(md, /```mermaid\nflowchart LR/);
  assert.match(md, /\| B 1 \| `t_abc123` \| review \| 8\/8 \| no \| 0 \| 0 \| never written \| \$3\.50 \| 21 \|/);
  assert.match(md, /\| 1 \| task \| T1 \| 1 \| ok \| - \| typecheck \| proven \|/);
  assert.match(md, /Irfan score _\/5 \(pass = 4 or more, K17\)/);
  assert.match(G.report({ dry: true, prompt: '/p.md', keep: true }, { ...env, planned: 2 }, [r]), /Verdict \(scripted\): FAIL, 8\/8 checks, 1\/2 clean runs/);
  // a contaminated run: flagged, its green checks and score not counted (K17) → FAIL
  const dirty = G.report({ dry: false, prompt: '/p.md', keep: false }, env, [{ ...r, contaminated: ['run 1: Read "/x/test/golden/sandbox-traps.md" (test/golden)'] }]);
  assert.match(dirty, /Verdict \(scripted\): FAIL, 0\/0 checks, 0\/1 clean runs, 1 contaminated/);
  assert.match(dirty, /## B run 1: `t_abc123`: review: 8\/8: CONTAMINATED/);
  assert.match(dirty, /Irfan score: not counted \(CONTAMINATED\)/);
});

test('contamination: a tool call naming the hidden spec, the answer key or .omc/ flags the run (the call named); a clean transcript has no hit', () => {
  const call = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });
  const leaked = [
    call('Read', { file_path: '/Users/me/Documents/taskboard/test/golden/fixtures/n1.e2e-spec.ts' }),
    call('Bash', { command: 'cat ~/Documents/taskboard/.omc/handoffs/p5-contract.md' }),
  ];
  const hits = G.contamination([{ n: 3, evs: leaked }]);
  assert.equal(hits.length, 2);
  assert.match(hits[0], /^run 3: Read ".*test\/golden\/fixtures\/n1\.e2e-spec\.ts" \(test\/golden\)$/);
  assert.match(hits[1], /^run 3: Bash ".*\.omc\/handoffs.*" \(\.omc\/\)$/);
  const clean = [
    call('Read', { file_path: '/wt/test/users.e2e-spec.ts' }), call('Grep', { pattern: 'nickname', path: '/wt/src' }),
    call('Bash', { command: 'npm run test:e2e -- test/users.e2e-spec.ts' }), call('Edit', { file_path: '/wt/src/users/users.service.ts', new_string: 'see test/golden' }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'test/golden in an output is not a call' }] } },
  ];
  assert.deepEqual(G.contamination([{ n: 1, evs: clean }]), []);
});

test('code copy for the harness tbd: has what tbd needs, none of the answer key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbg-test-'));
  try {
    const c = G.codeCopy(path.join(dir, 'code'));
    for (const f of ['tbd.js', 'lib/phase-settings.js', 'lib/gates/gate.sb', 'hooks/bash-guard.js', 'bin/tbx', 'phases/_rules.md']) assert.ok(fs.existsSync(path.join(c, f)), f);
    const all = fs.readdirSync(c, { recursive: true, encoding: 'utf8' });
    assert.deepEqual(all.filter((f) => /golden|\.omc|sandbox-traps|n1\.e2e/.test(f)), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- R box (.omc/handoffs/r-build.md R-A): --stop close, clone seed, --packet, --json, --blind ----------------------
const H = require('../scripts/harness');
const { REPO } = require('./helpers/tbd');
const gitOut = (...a) => execFileSync('/usr/bin/git', a, { encoding: 'utf8' }).trim();
const CLOSE = { stop: 'close', state: 'final_gate', waiting: { reason: 'close' } };

test('G1 --stop close: check 0 holds at final_gate waiting close (B, C); live() runs through review, qa, final_gate until it waits close; a close run stopped in qa, review or blocked fails check 0', () => {
  const b = G.checksB(factsB(CLOSE));
  assert.match(b[0].name, /reached final_gate waiting close/);
  assert.deepEqual(failed(b), []);
  assert.equal(G.checksC(factsC(CLOSE))[0].ok, true);
  for (const state of ['plan_approval', 'working', 'review', 'qa', 'final_gate']) assert.equal(G.live({ state }, 'close'), true, state);
  for (const t of [{ state: 'final_gate', waiting: { reason: 'close' } }, { state: 'blocked' }, { state: 'clarify' }, { state: 'cancelled' }, { state: 'plan_approval', waiting: { reason: 'setup_failed' } }]) {
    assert.equal(G.live(t, 'close'), false, JSON.stringify(t));
  }
  for (const f of [{ state: 'qa' }, { state: 'review' }, { state: 'blocked', waiting: { reason: 'qa' } }, { state: 'final_gate', waiting: null }]) {
    assert.equal(G.checksB(factsB({ stop: 'close', ...f }))[0].ok, false, f.state);
    assert.equal(G.checksC(factsC({ stop: 'close', ...f }))[0].ok, false, f.state);
  }
});

test('G3 --packet: a run whose change is the real b.patch passes the leak scan; the packet = README + ticket.md + change.diff, no plan, phase output, transcript or ticket id; a diff carrying the harness root is refused, nothing written', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbg3-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = { key: 'B', i: 1, id: 't_abc123', scored: true, contaminated: [], text: "GET /users should include each user's latest order.", change: fs.readFileSync(path.join(FIX, 'b.patch'), 'utf8'),
    plan: 'plan-b.json', checks: G.checksB(factsB(CLOSE)), ticket: { id: 't_abc123', ...CLOSE }, runs: [{ n: 1, result: { structured_output: { verdict: 'pass' } } }], notes: ['t_abc123 seeded'] };
  const p = path.join(tmp, 'p');
  const labels = G.packetOf(p, [r, { ...r, key: 'C-empty', scored: false, change: undefined }], { base: 'a'.repeat(40), labelsFile: path.join(tmp, 'l.json') });
  assert.deepEqual(labels, { 'golden:B#1': 'item-a' });
  assert.deepEqual(fs.readdirSync(p, { recursive: true }).sort(), ['README.md', 'item-a', 'item-a/change.diff', 'item-a/ticket.md']);
  assert.deepEqual([fs.readFileSync(path.join(p, 'item-a', 'ticket.md'), 'utf8'), fs.readFileSync(path.join(p, 'item-a', 'change.diff'), 'utf8')], [`${r.text}\n`, r.change]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'l.json'), 'utf8')), labels);
  assert.equal(['README.md', 'item-a/ticket.md', 'item-a/change.diff'].some((f) => fs.readFileSync(path.join(p, f), 'utf8').includes('t_abc123')), false);
  const root = path.join(fs.realpathSync(os.tmpdir()), 'tbg-a1b2c3');
  assert.throws(() => G.packetOf(path.join(tmp, 'q'), [{ ...r, change: `${r.change}+// ${root}/tbhome/worktrees/t_abc123/src/x.ts\n` }], { base: 'a'.repeat(40), labelsFile: path.join(tmp, 'l2.json') }), /holds/);
  assert.deepEqual([fs.existsSync(path.join(tmp, 'q')), fs.existsSync(path.join(tmp, 'l2.json'))], [false, false]);
});

test('G4 --json: fake results → score JSON v1 (golden:B, stop final_gate:close, integer cost_micro); 2 reviews merge by label to the lower score, a spread of 2+ asks for a 3rd; an unknown label or a score of 6 is refused', () => {
  const meta = { commit: 'c'.repeat(40), sandbox_base: 'a'.repeat(40), mode: 'dry', at: '2026-10-16T00:00:00.000Z' };
  const r = { key: 'B', i: 1, checks: G.checksB(factsB(CLOSE)), contaminated: [], min: 22, ticket: { ...CLOSE, fixes: 0, rework: 0 }, runs: [{ metric: { cost_delta: 1100000 } }, { metric: { cost_delta: 2000000 } }] };
  assert.deepEqual(G.scoreOf([r], meta), { v: 1, kind: 'golden-score', ...meta, sources: ['golden-working'],
    cases: [{ id: 'golden:B', run: 1, stop: 'final_gate:close', checks: { pass: 8, total: 8 }, contaminated: false, fix_rounds: 0, rework: 0, cost_micro: 3100000, min: 22, blind: null }], pass: true });
  const labels = { 'golden:B#1': 'item-b', 'golden:C#1': 'item-a' };
  const rv = (b, c) => ({ items: [{ label: 'item-a', score: c, agree: [], wrong: [], missing: [], why: '-' }, { label: 'item-b', score: b, agree: [], wrong: [], missing: [], why: '-' }] });
  const m = G.blindMerge(labels, [rv(5, 4), rv(4, 2)]);
  assert.deepEqual(m, { scores: { 'golden:B#1': [5, 4], 'golden:C#1': [4, 2] }, third: ['golden:C#1'] });
  const blind = H.scoreJson([{ ...r, id: 'golden:B', run: 1, stop: 'final_gate:close', cost_micro: 0, blind: { scores: m.scores['golden:B#1'] } }], meta).cases[0].blind;
  assert.deepEqual(blind, { scores: [5, 4], score: 4, pass: true });
  assert.throws(() => G.blindMerge(labels, [{ items: [{ label: 'item-z', score: 4 }] }]), /label "item-z" unknown/);
  assert.throws(() => G.blindMerge(labels, [rv(6, 4)]), /score 6 is not an integer 1-5/);
});

test('G5 --blind reviewer, built not spawned: argv = -p + spawn\'s isolation flags; denyRead holds this repo, the labels\' and scores\' dirs, the packet, the run root; cwd = the reviewer dir, outside them; a reviewer dir in a denied dir throws before anything is built', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbg5-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const [lab, sco, packet, runRoot, dir] = ['lab', 'sco', 'p', 'run', 'rev'].map((d) => { fs.mkdirSync(path.join(tmp, d)); return path.join(tmp, d); });
  const deny = G.blindDeny({ labels: path.join(lab, 'l.json'), scores: path.join(sco, 's.json'), packet, runRoot });
  const r = G.reviewer({ dir, box: path.join(tmp, 'box'), deny, port: 4999 });
  const pair = (a, b) => r.argv.some((x, i) => x === a && r.argv[i + 1] === b);
  assert.equal(r.argv[0], '-p');
  for (const [a, b] of [['--setting-sources', 'project'], ['--permission-mode', 'dontAsk'], ['--disallowedTools', 'Agent'], ['--model', 'opus']]) assert.ok(pair(a, b), `${a} ${b}`);
  assert.ok(r.argv.includes('--strict-mcp-config'));
  const denied = r.settings.sandbox.filesystem.denyRead;
  for (const d of [REPO, lab, sco, packet, runRoot]) assert.ok(denied.includes(d) && r.settings.permissions.deny.includes(`Read(/${d}/**)`), d);
  assert.equal(r.cwd, dir);
  assert.equal(denied.some((d) => dir === d || dir.startsWith(d + path.sep)), false);
  assert.equal(r.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.deepEqual([r.env.TB_PHASE, r.env.GIT_TERMINAL_PROMPT], ['review', '0'], 'bash-guard read-only git + spawn\'s git env');
  fs.mkdirSync(path.join(packet, 'rev'));
  assert.throws(() => G.reviewer({ dir: path.join(packet, 'rev'), box: path.join(tmp, 'box2'), deny, port: 4999 }), /lies in denied/);
  assert.equal(fs.existsSync(path.join(tmp, 'box2')), false);
  const o = G.parse(['--blind', '/p', '--labels', '/l.json', '--scores', '/s.json', '--json', '/o.json']);
  assert.deepEqual([o.blind, o.labels, o.scores, o.json], ['/p', '/l.json', '/s.json', '/o.json']);
  assert.throws(() => G.parse(['--blind', '/p', '--labels', '/l.json', '--json', '/o.json']), /--blind needs --labels, --scores and --json/);
  assert.throws(() => G.parse(['--dry', '--blind', '/p', '--labels', '/l', '--scores', '/s', '--json', '/o']), /no --dry or --real/);
});

test('G6 seed after H: the ticket gets its own clone (clone {config}, git_dir = <wt>/.git, no linked worktree) and refs/tb/<id>/base = base in tb-sandbox; cleanup refuses a dir outside TB_HOME/worktrees or a non-harness id', async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbg6-')));
  const tbHome = path.join(tmp, 'tbhome');
  const base = gitOut('-C', SANDBOX, 'rev-parse', 'main');
  const commonDir = fs.realpathSync(gitOut('-C', SANDBOX, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const s = await G.seed({ tbHome, base, commonDir }, plan('plan-b.json'), "GET /users should include each user's latest order.");
  t.after(() => {
    execFileSync('/usr/bin/git', ['-C', SANDBOX, 'update-ref', '-d', `refs/tb/${s.id}/base`]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const tk = JSON.parse(fs.readFileSync(path.join(s.dir, 'ticket.json'), 'utf8'));
  assert.deepEqual([tk.state, tk.worktree, tk.git_dir, tk.common_dir, tk.base_sha], ['plan_approval', s.wt, path.join(s.wt, '.git'), commonDir, base]);
  assert.match(tk.clone?.config ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual([gitOut('-C', SANDBOX, 'rev-parse', `refs/tb/${s.id}/base`), gitOut('-C', s.wt, 'rev-parse', 'HEAD')], [base, base]);
  assert.equal(gitOut('-C', SANDBOX, 'worktree', 'list', '--porcelain').includes(s.wt), false, 'a clone, not git worktree add');
  assert.throws(() => G.cleanSandbox(s.id, path.join(tmp, s.id), tbHome), /not TB_HOME\/worktrees/);
  assert.throws(() => G.cleanSandbox('t_zzzzzz', s.wt, tbHome), /not a harness ticket id/);
  assert.equal(fs.existsSync(s.wt), true, 'left alone');
});

test('G7 no --stop: review mode as today (parse sets no stop, the phases copy drops code/review/prompt.md, no qa port, live() stops at review); --stop close keeps every phase prompt; bad --stop, --cap-min or a --packet without close are refused', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbg7-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.equal('stop' in G.parse(['--dry']), false);
  const d = G.phasesCopy(path.join(tmp, 'a'), 'working under test\n');
  assert.deepEqual([fs.existsSync(path.join(d, 'code', 'review', 'prompt.md')), fs.readFileSync(path.join(d, 'code', 'working', 'prompt.md'), 'utf8')], [false, 'working under test\n']);
  assert.equal('qa_ports' in G.goldenTag('/r'), false);
  assert.deepEqual([G.live({ state: 'working' }), G.live({ state: 'review' })], [true, false]);
  const c = G.phasesCopy(path.join(tmp, 'b'), 'x', 'close');
  for (const ph of ['review', 'qa', 'final_gate']) assert.equal(fs.existsSync(path.join(c, 'code', ph, 'prompt.md')), true, ph);
  assert.deepEqual(G.goldenTag('/r', 4123).qa_ports, [4123]);
  assert.throws(() => G.parse(['--dry', '--stop', 'qa']), /--stop: review or close/);
  assert.throws(() => G.parse(['--dry', '--stop', 'close', '--cap-min', '481']), /--cap-min: 1 to 480/);
  assert.throws(() => G.parse(['--dry', '--packet', '/tmp/p']), /--packet needs --stop close/);
});
