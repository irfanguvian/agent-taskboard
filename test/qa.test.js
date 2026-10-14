'use strict';
// M5.2 (contract .omc/handoffs/m5-contract.md rev 4 C5 C7 C9; D-0086 D-0087 D-0092): the QA phase through a real tbd
// (harness temp HOME + TB_HOME, port 0) with the real code/working + code/review + code/qa handlers, test/fake-claude.js
// as claude_bin and scripted gates (test/helpers/fake-gates.js). Tickets start in qa with T1 done (base commit, then T1's
// change at HEAD), each in its own worktree. A QA run's exec step (TB_PHASE qa only) starts the fixture app as a child
// of its own shell (under the run root), calls `tbx req` (rec <run>.1, .2, ...), copies a report + a screenshot into
// docs/verification/ and stops the app. Fixture phase dir: the real settings.json + result.schema.json, stub prompts;
// final_gate is not built there, so a passed QA waits in final_gate. Kills only through run-spy.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, FAKE_GATES, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['working', 'review', 'qa']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
// Admission always yes: this 8 GB Mac's free RAM must not decide a test.
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 4,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const has = (f) => fs.existsSync(f) && fs.readdirSync(f).length > 0;
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => r(port)); }); });

// the fixture app: 200 + the id for every /users/<id> (no not-found check: the bug Q3's negative case finds)
const SERVER = path.join(ROOT, 'server.js');
fs.writeFileSync(SERVER, `const [port, ready] = process.argv.slice(2);
require('node:http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ id: q.url.split('/').pop() })); })
  .listen(Number(port), '127.0.0.1', () => require('node:fs').writeFileSync(ready, ''));
`);
const REPORT = path.join(ROOT, 'report.md');
fs.writeFileSync(REPORT, '# QA users by id\n\n```mermaid\nflowchart LR\n  A[GET /users/1] --> B[200]\n```\n\n**Verdict:** PASS\n');
const SHOT = path.join(ROOT, 'shot.png');
fs.writeFileSync(SHOT, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300)]));

// A QA run's exec step (see the header): GET each path in order; extra: shell lines run last (in the worktree)
function qaExec(port, paths, extra = '') {
  const f = path.join(fs.mkdtempSync(path.join(ROOT, 'sh-')), 'qa.sh');
  fs.writeFileSync(f, `[ "$TB_PHASE" = qa ] || exit 0
ready=$(mktemp -u "${ROOT}/ready.XXXXXX")
"${process.execPath}" "${SERVER}" ${port} "$ready" & srv=$!
while [ ! -f "$ready" ]; do sleep 0.05; done
# the run root is registered a moment after the spawn: the first call is retried while tbd does not know the run key yet
i=0; while ! tbx req GET http://127.0.0.1:${port}${paths[0] ?? '/users/1'} > "$ready.out" 2>&1 && grep -q 'unknown run key' "$ready.out" && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done
${paths.slice(1).map((p) => `tbx req GET http://127.0.0.1:${port}${p} >> "$ready.out" 2>&1`).join('\n')}
mkdir -p docs/verification/screenshots
cp "${REPORT}" docs/verification/qa.md
cp "${SHOT}" docs/verification/screenshots/qa-1.png
kill $srv
${extra}
`);
  return { exec: ['/bin/sh', f] };
}
const C = (id, over = {}) => ({
  id, type: 'backend', kind: 'positive', source: 'src/users.js:1', acceptance: [], pre: 'the app runs', steps: ['GET /users/1'], expect: '200 and the user',
  result: 'PASS', recs: [], screenshots: [], observed: { note: 'as expected' }, ...over,
});
const result = (cases, over = {}) => ({
  result: { structured_output: { verdict: cases.every((c) => c.result === 'PASS') ? 'pass' : 'fail', cases, report: 'docs/verification/qa.md', findings: [], ...over } },
});

const PLAN = {
  kind: 'plan', summary: 'users by id', acceptance: [{ id: 'A1', text: 'GET /users/:id returns that user', type: 'new' }],
  tasks: [{ id: 'T1', title: 'users by id', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['do it'] }],
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: [], decisions: [],
};
// the repo: base commit (a doc tracked in docs/verification), then T1's change to src/users.js at HEAD; .env.test ignored
// (env holds the file a tag copies)
function repo(env = 'SECRET=1\n') {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.test\n');
  fs.mkdirSync(path.join(dir, 'docs', 'verification'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'verification', 'tracked.md'), 'tracked at base\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base = git(dir, 'rev-parse', 'main');
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = { byId: (id) => ({ id }) };\n');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'T1');
  fs.writeFileSync(path.join(dir, '.env.test'), env);
  return { dir, base, head: git(dir, 'rev-parse', 'main') };
}
const worktree = (r) => {
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(r.dir, 'worktree', 'add', '-q', '--detach', wt, r.head);
  return wt;
};
const tag = (r, over = {}) => ({ type: 'git', path: r.dir, base: 'main', env_files: ['.env.test'], ...over });
// T1 done; gate: a gate job pending
const work = (r, gate = null) => ({ task: null, tasks: [{ id: 'T1', status: 'done', attempt: 1, pre: r.base, head: r.head }], tries: 0, unit_ms: null, scope: {}, denied: {}, gate });
// a code ticket in qa (or over.state) after review, its own worktree at HEAD
const flow = (id, r, over = {}) => ticket(id, {
  state: 'qa', tag: 'acme/api', title: 'users by id', base_sha: r.base, worktree: worktree(r), round: 5, review: { n: 1, head: r.head, open: [] }, work: work(r), ...over,
});

// tickets {id: ticket.json}; sessions: one scenario per claude invocation (in spawn order), or scenario: the one for all
/** @param {any} t @param {{tickets: Record<string, any>, tags: Record<string, any>, sessions?: any[], scenario?: any, extra?: Record<string, any>}} o */
async function boot(t, { tickets, tags, sessions = undefined, scenario = undefined, extra = {} }) {
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  (sessions ?? []).forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  if (scenario) fs.writeFileSync(path.join(scn, 'all.json'), JSON.stringify(scenario));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const files = {
    'config.json': CONFIG, 'tags.json': { acme: {}, ...tags },
    ...Object.fromEntries(Object.entries(tickets).flatMap(([id, k]) => [[`tickets/${id}/ticket.json`, k], [`tickets/${id}/plan.json`, PLAN]])),
    ...extra,
  };
  const tbd = await startTbd({
    files, env: {
      TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', TEST_PRESSURE: 'normal', FAKE_CLAUDE_DUMP_DIR: dumps,
      ...(scenario ? { FAKE_CLAUDE_SCENARIO: path.join(scn, 'all.json') } : { FAKE_CLAUDE_SCENARIO_DIR: scn }),
    },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  return {
    tbd, k: (id) => read(tbd, id),
    dumps: () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => json(path.join(dumps, f))),
  };
}

test('Q1 Q12 tbx req → rec line → a case cites it → final_gate; a backend case on recs alone "captured by tbd", a frontend PASS with a rec + a screenshot "agent-made" + need_review line; docs mirrored, then out of the worktree, the tracked doc kept (D-0101)', async (t) => {
  const P = await free();
  const r = repo();
  const id = 't_qa1001';
  const cases = [
    C('TC-1', { acceptance: ['A1'], recs: ['1.1'], observed: { status: 200, note: 'user 1' } }),
    C('TC-2', { type: 'frontend', kind: 'negative', source: 'A1', steps: ['open /users/x'], expect: 'a not found page', recs: ['1.1'], screenshots: ['docs/verification/screenshots/qa-1.png'] }),
  ];
  const { tbd, k, dumps } = await boot(t, { tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r, { qa_ports: [P] }) }, sessions: [{ steps: [qaExec(P, ['/users/1']), result(cases)] }] });
  await until(() => k(id).state === 'final_gate', 60_000, 'qa → final_gate');
  assert.deepEqual(k(id).qa, { n: 1, head: r.head, verdict: 'pass', pass: 2, fail: 0, blocked: 0, report: 'docs/verification/qa.md' });
  const [meta, rec] = fs.readFileSync(tk(tbd, id, 'runs', '1.rec.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([meta.ticket, meta.phase, meta.round, rec.n, rec.method, rec.res.status], [id, 'qa', 5, '1.1', 'GET', 200]);
  const f = json(tk(tbd, id, 'qa', '01.json'));
  assert.deepEqual(Object.keys(f), ['n', 'at', 'round', 'head', 'verdict', 'cases', 'report', 'findings', 'need_review'], 'the frozen qa/NN.json shape');
  assert.deepEqual(f.cases.map((c) => [c.id, c.evidence]), [['TC-1', 'captured by tbd'], ['TC-2', 'agent-made']]);
  assert.equal(f.need_review.length, 1);
  assert.match(f.need_review[0], /TC-2 passed on agent-made evidence only/);
  assert.doesNotMatch(f.need_review[0], /TC-1/);
  assert.equal(fs.readFileSync(tk(tbd, id, 'docs', 'verification', 'qa.md'), 'utf8'), fs.readFileSync(REPORT, 'utf8'), 'the report mirrored');
  const wt = k(id).worktree;
  assert.deepEqual(fs.readdirSync(path.join(wt, 'docs', 'verification')), ['tracked.md'], 'D-0101: the untracked docs left the worktree, the tracked one stayed');
  assert.equal(fs.readFileSync(path.join(wt, 'docs', 'verification', 'tracked.md'), 'utf8'), 'tracked at base\n');
  assert.ok(dumps()[0].prompt.includes(`qa ports (tbx req calls only these: start the app on one): ${P}`), 'seeded with the tag\'s qa ports');
});

test('Q2 a rec of an earlier QA round → refused, resumed; a status unlike its last rec → refused again → Blocked; nothing stored', async (t) => {
  const P = await free();
  const r = repo();
  const id = 't_qa2001';
  const old = [{ meta: true, ticket: id, run: 1, phase: 'qa', round: 2, gen: 1 }, { n: '1.1', at: '2026-10-12T00:00:00.000Z', method: 'GET', url: `http://127.0.0.1:${P}/users/1`, req: { headers: [], body: null, truncated: false }, res: { status: 200, headers: [], body: '{}', truncated: false }, ms: 1 }];
  const neg = C('TC-2', { kind: 'negative', source: 'A1', steps: ['GET /users/1 twice'], expect: '200 again' });
  const { tbd, k, dumps } = await boot(t, {
    tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r, { qa_ports: [P] }) },
    extra: { [`tickets/${id}/runs/1.rec.jsonl`]: old.map((l) => JSON.stringify(l)).join('\n') + '\n' },
    sessions: [ // run 2 records rec 2.1; its cases cite the old round's 1.1, then (resumed) 2.1 with the wrong status
      { steps: [qaExec(P, ['/users/1']), result([C('TC-1', { acceptance: ['A1'], recs: ['1.1'], observed: { status: 200, note: '' } }), { ...neg, recs: ['1.1'], observed: { status: 200, note: '' } }])] },
      { steps: [result([C('TC-1', { acceptance: ['A1'], recs: ['2.1'], observed: { status: 201, note: '' } }), { ...neg, recs: ['2.1'], observed: { status: 200, note: '' } }])] },
    ],
  });
  await until(() => k(id).state === 'blocked', 60_000, 'blocked');
  const p = k(id);
  assert.deepEqual([p.blocked_from, p.lease.exit], ['qa', 'schema_fail']);
  assert.match(p.lease.error, /TC-1: observed\.status 201 is not 200, the status of its last rec 2\.1/);
  const d = dumps();
  assert.equal(d.length, 2);
  assert.equal(d[1].opts['--resume'], d[0].opts['--session-id'], 'schema retry: same session');
  assert.match(d[1].prompt, /rec 1\.1: not recorded by tbd in this QA round/);
  assert.equal(has(tk(tbd, id, 'qa')), false, 'a refused result is never stored');
  assert.equal(fs.existsSync(path.join(p.worktree, 'docs', 'verification', 'qa.md')), false, 'D-0101: the retry refused, the visit over: its docs out of the worktree');
});

test('Q3 a FAIL with cause code → fix 1 as @qa1, brief = the failed case + its rec → the fix session gets it; fixes already 3 → Blocked waiting qa, no fix task (one counter with review)', async (t) => {
  const P = await free();
  const r = repo();
  const [x, y] = ['t_qa3001', 't_qa3002'];
  const cases = [
    C('TC-1', { acceptance: ['A1'], recs: ['1.1'], observed: { status: 200, note: 'user 1' } }),
    C('TC-2', { kind: 'negative', steps: ['GET /users/999'], expect: '404 for a user that does not exist', result: 'FAIL', cause: 'code', recs: ['1.2'], observed: { status: 200, note: 'a user 999 came back' } }),
  ];
  // one scenario for every run (each ticket's QA run, then x's fix session, which skips the QA steps): run order is free
  const { tbd, k, dumps } = await boot(t, {
    tickets: { [x]: flow(x, r), [y]: flow(y, r, { fixes: 3 }) }, tags: { 'acme/api': tag(r, { qa_ports: [P] }) },
    scenario: { steps: [qaExec(P, ['/users/1', '/users/999']), result(cases)] },
  });
  await until(() => k(y).state === 'blocked' && dumps().some((d) => d.prompt.includes('## Your task: @qa1')), 90_000, 'y blocked, x\'s fix session started');
  const px = k(x);
  assert.deepEqual([px.fixes, px.qa.verdict, px.qa.fail], [1, 'fail', 1]);
  const brief = lines(tk(tbd, x, 'work.jsonl')).find((l) => l.t === 'task' && l.id === '@qa1')?.brief ?? '';
  assert.match(brief, /QA 1 found 1 failing case\(s\) \(fix 1 of 3\)/);
  assert.match(brief, /TC-2 \(negative, backend\) src\/users\.js:1: expected 404 for a user that does not exist/);
  assert.ok(brief.includes(`rec 1.2 (captured by tbd): GET http://127.0.0.1:${P}/users/999 → 200: {"id":"999"}`), 'its evidence: the rec');
  assert.doesNotMatch(brief, /TC-1/, 'a passed case stays out');
  const fix = dumps().find((d) => d.prompt.includes('## Your task: @qa1'));
  assert.equal(fix.env.TB_PHASE, 'working');
  assert.ok(fix.prompt.includes('TC-2') && fix.prompt.includes('/users/999'), 'the fix session gets the brief');
  const py = k(y);
  assert.deepEqual([py.blocked_from, py.fixes, py.waiting?.reason, py.qa.verdict], ['qa', 3, 'qa', 'fail']);
  assert.match(py.waiting.why, /QA 1: 1 failing case\(s\) need fix 4, max 3 per ticket/);
  assert.equal(lines(tk(tbd, y, 'work.jsonl')).some((l) => l.t === 'task' && l.id.startsWith('@qa')), false, 'no fix task opened');
  assert.ok(fs.existsSync(tk(tbd, y, 'qa', '01.json')), 'the result is kept');
});

test('Q10 a QA run moves HEAD → refused, resumed; then edits a tracked file outside the docs dirs → refused again → Blocked; nothing stored', async (t) => {
  const P = await free();
  const r = repo();
  const id = 't_qaa001';
  const cases = [C('TC-1', { type: 'frontend', acceptance: ['A1'], screenshots: ['docs/verification/screenshots/qa-1.png'] }), C('TC-2', { type: 'frontend', kind: 'negative', source: 'A1' })];
  const { tbd, k, dumps } = await boot(t, {
    tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r, { qa_ports: [P] }) },
    sessions: [
      { steps: [qaExec(P, ['/users/1'], 'git -c user.name=q -c user.email=q@q commit --allow-empty -qm qa'), result(cases)] },
      { steps: [{ exec: ['/bin/sh', '-c', 'git reset -q --hard HEAD~1; echo x >> src/users.js'] }, result(cases)] },
    ],
  });
  await until(() => k(id).state === 'blocked', 60_000, 'blocked');
  const p = k(id);
  assert.deepEqual([p.blocked_from, p.lease.exit], ['qa', 'schema_fail']);
  assert.match(p.lease.error, /tracked files changed during QA: {2}M src\/users\.js/);
  assert.match(dumps()[1].prompt, new RegExp(`HEAD is [0-9a-f]{12}, not ${r.head.slice(0, 12)} where this QA began`));
  assert.equal(has(tk(tbd, id, 'qa')), false);
});

// security review F2: an index flag hides a tracked edit from git status; the tree pin lists flagged files too
test('Q10 a tracked file edited under skip-worktree (git status blind to it) → refused as a tracked change, resumed, refused again → Blocked', async (t) => {
  const r = repo();
  const id = 't_qac001';
  const cases = [C('TC-1', { type: 'frontend', acceptance: ['A1'] }), C('TC-2', { type: 'frontend', kind: 'negative', source: 'A1' })];
  const hide = { exec: ['/bin/sh', '-c', 'git update-index --skip-worktree src/users.js && echo x >> src/users.js'] };
  const { k } = await boot(t, { tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r) }, sessions: [{ steps: [hide, result(cases)] }, { steps: [result(cases)] }] });
  await until(() => k(id).state === 'blocked' && k(id).lease?.exit, 60_000, 'blocked');
  const p = k(id);
  assert.equal(git(p.worktree, 'status', '--porcelain'), '', 'git status alone sees nothing');
  assert.deepEqual([p.blocked_from, p.lease.exit], ['qa', 'schema_fail']);
  assert.match(p.lease.error, /tracked files changed during QA: S {2}src\/users\.js/);
});

test('Q11 a FAIL without cause → refused, resumed; only ASSISTED among the unproven → Blocked waiting qa, the result kept, no fix', async (t) => {
  const P = await free();
  const r = repo();
  const id = 't_qab001';
  const pos = C('TC-1', { type: 'frontend', acceptance: ['A1'], screenshots: ['docs/verification/screenshots/qa-1.png'] });
  const neg = C('TC-2', { type: 'frontend', kind: 'negative', steps: ['open /users/x'], expect: 'a not found page' });
  const { tbd, k, dumps } = await boot(t, {
    tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r, { qa_ports: [P] }) },
    sessions: [
      { steps: [qaExec(P, ['/users/1']), result([pos, { ...neg, result: 'FAIL' }])] },
      { steps: [result([pos, { ...neg, result: 'ASSISTED', observed: { note: 'needed a manual reload' } }], { verdict: 'blocked' })] },
    ],
  });
  await until(() => k(id).state === 'blocked' && k(id).lease?.exit, 60_000, 'blocked, the lease saved'); // runner.end: handle, then saveLease
  const p = k(id);
  assert.match(dumps()[1].prompt, /TC-2: a FAIL or BLOCKED case needs cause: code, test or env/);
  assert.deepEqual([p.blocked_from, p.lease.exit, p.waiting?.reason, p.fixes ?? 0, p.qa.verdict], ['qa', 'result', 'qa', 0, 'blocked']);
  assert.match(p.waiting.why, /QA 1 not proven: TC-2 ASSISTED/);
  assert.deepEqual(json(tk(tbd, id, 'qa', '01.json')).cases.map((c) => c.result), ['PASS', 'ASSISTED']);
  assert.equal(lines(tk(tbd, id, 'work.jsonl')).some((l) => l.t === 'task'), false, 'no fix task');
});

test('Q6 DB guard: a remote postgres URL or a host= param → QA and a db:local gate Blocked waiting db (keys named, values never), nothing run; localhost, 127.0.0.1, [::1] → QA runs, the gate runs', async (t) => {
  process.env.TB_HOME = fs.mkdtempSync(path.join(ROOT, 'home-')); // lib/store (under lib/planning) reads it at load: never the real ~/.taskboard
  const { canon } = require('../lib/planning');
  const loc = repo('A=postgres://u@localhost/x\nB=postgresql://127.0.0.1:5432/x\nC=postgres://[::1]/x\n');
  const rem = repo('DATABASE_URL=postgres://app:pw@db.example.com:5432/app\n');
  const hst = repo('DATABASE_URL=postgres://localhost/app?host=10.0.0.5\n');
  const gate = (r) => ({ state: 'working', plan_hash: crypto.createHash('sha256').update(canon(PLAN)).digest('hex'), work: work(r, { gen: 0, kind: 'working' }) });
  const { tbd, k } = await boot(t, {
    tickets: {
      t_dbq001: flow('t_dbq001', rem, { tag: 'acme/rem' }), t_dbq002: flow('t_dbq002', hst, { tag: 'acme/hst' }), t_dbq003: flow('t_dbq003', loc, { tag: 'acme/loc' }),
      t_dbg001: flow('t_dbg001', rem, { tag: 'acme/rem', ...gate(rem) }), t_dbg002: flow('t_dbg002', loc, { tag: 'acme/loc', ...gate(loc) }),
    },
    tags: { 'acme/rem': tag(rem, { db: 'local' }), 'acme/hst': tag(hst), 'acme/loc': tag(loc, { db: 'local' }) },
    scenario: { steps: [{ hang: true }] },
  });
  const gates = () => (fs.existsSync(path.join(tbd.tbHome, 'fake-gates.jsonl')) ? lines(path.join(tbd.tbHome, 'fake-gates.jsonl')) : []);
  await until(() => ['t_dbq001', 't_dbq002', 't_dbg001'].every((id) => k(id).state === 'blocked') && k('t_dbq003').lease?.pid && gates().some((g) => g.ticket === 't_dbg002'), 60_000, 'guards decided');
  for (const [id, from, why] of /** @type {[string, string, RegExp][]} */ ([['t_dbq001', 'qa', /DATABASE_URL: postgres host is not localhost/], ['t_dbq002', 'qa', /DATABASE_URL: a host=, hostaddr= or service= param/], ['t_dbg001', 'working', /DATABASE_URL: postgres host is not localhost/]])) {
    const p = k(id);
    assert.deepEqual([p.blocked_from, p.waiting?.reason], [from, 'db'], id);
    assert.match(p.waiting.why, why, id);
    assert.doesNotMatch(p.waiting.why, /db\.example\.com|10\.0\.0\.5|pw/, `${id}: no env value in why`);
    assert.equal(p.lease, null, `${id}: never spawned`);
  }
  assert.equal(gates().some((g) => g.ticket === 't_dbg001'), false, 'the remote tag\'s gate never ran');
  const q = k('t_dbq003');
  assert.deepEqual([q.state, q.lease.phase, q.qa], ['qa', 'qa', { n: 1, head: loc.head }]);
  assert.equal(fs.readFileSync(path.join(q.worktree, '.env.test'), 'utf8'), fs.readFileSync(path.join(loc.dir, '.env.test'), 'utf8'), 'env files copied again before the run');
});

test('M5 C9 qa_lock on Resume: a ticket resumed into qa while another of its tag runs QA waits qa_lock, no run; Restart there → 409', async (t) => {
  const r = repo();
  const [a, b] = ['t_lka001', 't_lkb001'];
  const { tbd, k } = await boot(t, {
    tickets: { [a]: flow(a, r), [b]: flow(b, r, { state: 'blocked', blocked_from: 'qa', waiting: { reason: 'qa', since: '2026-10-13T00:00:00.000Z' } }) },
    tags: { 'acme/api': tag(r) }, scenario: { steps: [{ hang: true }] },
  });
  await until(() => k(a).lease?.pid && !k(a).lease.exit, 30_000, 'a\'s QA run live');
  assert.equal((await tbd.api('POST', `/api/tickets/${b}/resume`, {})).status, 202);
  await until(() => k(b).state === 'qa' && k(b).waiting?.reason === 'qa_lock', 30_000, 'b back in qa, waiting qa_lock');
  await new Promise((res) => setTimeout(res, 2500)); // a few runner ticks
  const restart = await tbd.api('POST', `/api/tickets/${b}/restart`, {});
  assert.equal(restart.status, 409);
  assert.match(restart.json.error, /no qa run yet: it starts on its own \(qa_lock\)/);
  await new Promise((res) => setTimeout(res, 1500));
  const p = k(b);
  assert.deepEqual([p.state, p.waiting?.reason, p.lease?.pid ?? null, p.qa], ['qa', 'qa_lock', null, undefined], 'no run, no start record');
  assert.equal(has(tk(tbd, b, 'runs')), false);
});

// M5.2 review: a qa ticket that admission turns back (memory, a usage pause) is turned back before the next hook, so a
// wait costs no DB guard, env copy, git or start-record write per runner tick
test('M5 C5 a qa ticket waiting on memory: no next hook per tick (no start record, no env copy, no ticket write)', async (t) => {
  const r = repo();
  const id = 't_qam001';
  const config = { ...CONFIG, memory: { ...CONFIG.memory, phase_need_gb: { ...CONFIG.memory.phase_need_gb, qa: 9999 } } };
  const { tbd, k } = await boot(t, { tickets: { [id]: flow(id, r) }, tags: { 'acme/api': tag(r) }, scenario: { steps: [{ hang: true }] }, extra: { 'config.json': config } });
  await until(() => k(id).waiting?.reason === 'memory', 30_000, 'waiting memory');
  const events = () => lines(tk(tbd, id, 'events.jsonl')).length;
  const n = events();
  await new Promise((res) => setTimeout(res, 2500)); // a few runner ticks
  const p = k(id);
  assert.deepEqual([p.state, p.waiting?.reason, p.qa, p.lease ?? null], ['qa', 'memory', undefined, null], 'the hook never ran: no start record');
  assert.equal(fs.existsSync(path.join(p.worktree, '.env.test')), false, 'no env copy');
  assert.equal(events(), n, 'no ticket write per tick');
});
