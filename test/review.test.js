'use strict';
// M5.1 (contract .omc/handoffs/m5-contract.md rev 4 C2 C3 C4; D-0085 D-0092): the review fix loop through a real tbd
// (harness temp HOME + TB_HOME, port 0) with the real code/planning + code/working + code/review handlers,
// test/fake-claude.js as claude_bin (exec steps make real commits in a temp git repo; review results scripted per run)
// and scripted gates (test/helpers/fake-gates.js: all green). Fixture phase dir: the real settings.json +
// result.schema.json, stub prompts; qa is not built there, so a passed review waits in qa. Kills only through run-spy.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, FAKE_GATES, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working', 'review']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
const RULES = fs.readFileSync(path.join(REPO, 'phases', '_rules.md'), 'utf8');
// Admission always yes: this 8 GB Mac's free RAM must not decide a test.
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 4,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const SHA = 'c'.repeat(40); // a working result's commit: the fake gates read the real HEAD
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const reviews = (tbd, id) => (fs.existsSync(tk(tbd, id, 'review')) ? fs.readdirSync(tk(tbd, id, 'review')).sort() : []);

// fake-claude scenarios: a working session (a real commit, then done) and a review session's result
const commit = (file, msg) => ({ exec: ['/bin/sh', '-c', `set -e; echo "${msg}" >> ${file}; git add ${file}; git -c user.name=t -c user.email=t@t commit -qm "${msg}"`] });
const done = (file, msg) => ({ steps: [commit(file, msg), { result: { structured_output: { status: 'done', commit: SHA, tests_added: [], notes: '' } } }] });
const reviewRun = (over) => ({ steps: [{ result: { structured_output: { verdict: 'pass', findings: [], closed: [], notes: [], declined: [], ...over } } }] });
const F = (id, over = {}) => ({ id, severity: 'HIGH', confidence: 'high', where: 'src/users.js:1', problem: `problem ${id}`, failure_scenario: `scenario ${id}`, fix: `fix ${id}`, ...over });

// One code ticket per tbd, approved for real (POST approve → setup → working) with one task T1 that changes src/users.js:
// run 1 = T1's session, then the review runs (sessions[0] = run 2, ...). → tbd, id, base, dumps().
/** @param {any} t @param {{sessions: any[], ticketOver?: any, extra?: any}} o */
async function reviewed(t, { sessions, ticketOver = {}, extra = {} }) {
  const id = 't_rev001';
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.test\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env.test'), 'SECRET=1\n');
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, base);
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  [done('src/users.js', 'T1'), ...sessions].forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const plan = {
    kind: 'plan', summary: 'users work', acceptance: [{ id: 'A1', text: 'users still work', type: 'preserve' }],
    tasks: [{ id: 'T1', title: 'task T1', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'preserve', test_cmd: 'npm test', steps: ['do it'] }],
    allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['src/users.js: the users module'], decisions: [],
  };
  const files = {
    'config.json': CONFIG,
    'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', env_files: ['.env.test'], checks: { unit: 'npm test' } } },
    [`tickets/${id}/ticket.json`]: ticket(id, { state: 'plan_approval', tag: 'acme/api', title: 'users work', base_sha: base, worktree: wt, round: 3, ...ticketOver }),
    [`tickets/${id}/rounds/01-plan.json`]: plan,
    ...Object.fromEntries(Object.entries(extra).map(([f, v]) => [`tickets/${id}/${f}`, v])),
  };
  const tbd = await startTbd({ files, env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_DUMP_DIR: dumps, FAKE_CLAUDE_SCENARIO_DIR: scn } });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  return {
    tbd, id, base, wt, k: () => read(tbd, id),
    dumps: () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => json(path.join(dumps, f))),
  };
}

test('R1 R4 a pass verdict with an open high-confidence MED → refused, resumed with why; pass with a medium-confidence HIGH → not blocking → qa, review/01.json + t.review, no fix', async (t) => {
  const w = await reviewed(t, { sessions: [
    reviewRun({ findings: [F('F1', { severity: 'MED' })] }), // R4 (−): the verdict contradicts the blocking rule
    reviewRun({ findings: [F('F1', { confidence: 'medium' })], notes: ['checked users'] }), // R4 (+) / R1: nothing blocks
  ] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'qa', 60_000, 'review → qa');
  const d = w.dumps();
  assert.equal(d.length, 3, 'T1 + the refused review run + its resume');
  assert.equal(d[1].opts['--resume'], undefined, 'the review starts as a fresh session');
  assert.ok(d[1].prompt.includes(`git diff ${w.base}..`) && d[1].prompt.includes('src/users.js'), 'seeded with the whole diff');
  assert.equal(d[2].opts['--resume'], d[1].opts['--session-id'], 'schema retry: same session');
  assert.match(d[2].prompt, /verdict must be block: F1 block/);
  const p = k();
  const head = git(w.wt, 'rev-parse', 'HEAD');
  assert.deepEqual([p.review, p.fixes ?? 0, p.work.task], [{ n: 1, head, open: [] }, 0, null]);
  assert.deepEqual(reviews(tbd, id), ['01.json'], 'the refused result is never stored');
  const r = json(tk(tbd, id, 'review', '01.json'));
  assert.deepEqual([r.verdict, r.head, r.findings.map((f) => [f.id, f.severity, f.confidence]), r.notes], ['pass', head, [['F1', 'HIGH', 'medium']], ['checked users']]);
});

test('R2 a HIGH finding → fix 1 as @rv1 (brief: F1 + the cheap LOW) → the fix commit, task gate + working gate → round 2 closes F1 → qa', async (t) => {
  const w = await reviewed(t, { sessions: [
    reviewRun({ verdict: 'block', findings: [F('F1'), F('F2', { severity: 'LOW', cheap: true, where: 'src/users.js:2' }), F('F3', { severity: 'LOW', where: 'src/users.js:1' })] }),
    done('src/users.js', 'fix F1'), // the @rv1 session
    reviewRun({ closed: [{ id: 'F1', how: 'fixed in the last commit' }] }),
  ] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'qa', 90_000, 'review → working → review → qa');
  const d = w.dumps();
  assert.equal(d.length, 4);
  const brief = lines(tk(tbd, id, 'work.jsonl')).find((l) => l.t === 'task' && l.id === '@rv1')?.brief ?? '';
  assert.match(brief, /fix 1 of 3/);
  assert.match(brief, /F1 HIGH \(high\) src\/users\.js:1: problem F1\n {2}fails when: scenario F1\n {2}fix: fix F1/);
  assert.match(brief, /F2 LOW/, 'a cheap LOW rides along');
  assert.doesNotMatch(brief, /F3/, 'a LOW that is not cheap stays out');
  assert.ok(d[2].prompt.includes('## Your task: @rv1') && d[2].prompt.includes('problem F1'), 'the fix session gets the brief');
  assert.ok(lines(path.join(tbd.tbHome, 'fake-gates.jsonl')).some((c) => c.fn === 'task' && c.task === '@rv1'), 'the fix went through a task gate');
  assert.ok(d[3].prompt.includes('## Earlier findings') && /F1 HIGH[^\n]*\n.*\n.*\n {2}blocking: close it or keep it/.test(d[3].prompt), 'round 2 sees F1 as open');
  assert.match(d[3].prompt, /## Since the last review/);
  const p = k();
  assert.deepEqual([p.fixes, p.review.n, p.review.open, p.review.head], [1, 2, [], git(w.wt, 'rev-parse', 'HEAD')]);
  assert.deepEqual(reviews(tbd, id), ['01.json', '02.json']);
  assert.deepEqual(json(tk(tbd, id, 'review', '02.json')).closed, [{ id: 'F1', how: 'fixed in the last commit' }]);
});

test('R3 round 2 drops the open F1 silently → refused, resumed once, refused again → Blocked; nothing stored', async (t) => {
  const old = { n: 1, at: '2026-10-12T00:00:00.000Z', round: 5, verdict: 'block', findings: [F('F1')], closed: [], notes: [], declined: [] };
  const w = await reviewed(t, {
    ticketOver: { review: { n: 1, head: 'a'.repeat(40), open: ['F1'] }, fixes: 1 }, extra: { 'review/01.json': old },
    sessions: [reviewRun({}), reviewRun({})],
  });
  const { tbd, id, k } = w;
  await until(() => k().state === 'blocked', 60_000, 'blocked');
  const p = k();
  assert.deepEqual([p.blocked_from, p.lease.exit, p.review.n, p.fixes], ['review', 'schema_fail', 1, 1]);
  assert.match(p.lease.error, /earlier blocking finding F1 dropped/);
  const d = w.dumps();
  assert.equal(d.length, 3);
  assert.equal(d[2].opts['--resume'], d[1].opts['--session-id']);
  assert.deepEqual(reviews(tbd, id), ['01.json']);
});

test('R8 a where path neither at HEAD nor in base..HEAD → refused, resumed once, refused again → Blocked; nothing stored', async (t) => {
  const bad = reviewRun({ verdict: 'block', findings: [F('F1', { where: 'src/nope.js:1' })] });
  const w = await reviewed(t, { sessions: [bad, bad] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'blocked', 60_000, 'blocked');
  const p = k();
  assert.deepEqual([p.blocked_from, p.lease.exit], ['review', 'schema_fail']);
  assert.match(p.lease.error, /where names a path that is neither at HEAD nor in the diff: src\/nope\.js/);
  assert.deepEqual(reviews(tbd, id), []);
});

test('R9 the same id twice in findings → refused, resumed once, refused again → Blocked; nothing stored', async (t) => {
  const bad = reviewRun({ verdict: 'block', findings: [F('F1'), F('F1')] });
  const w = await reviewed(t, { sessions: [bad, bad] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'blocked', 60_000, 'blocked');
  const p = k();
  assert.deepEqual([p.blocked_from, p.lease.exit], ['review', 'schema_fail']);
  assert.match(p.lease.error, /F1 appears twice in findings/);
  assert.deepEqual(reviews(tbd, id), []);
});

test('R5 R6 fixes already 3 (review + QA + final) + a new blocking finding → Blocked waiting review, no fix task; Resume resets fixes to 0 and starts a fresh review session', async (t) => {
  const w = await reviewed(t, { ticketOver: { fixes: 3 }, sessions: [
    reviewRun({ verdict: 'block', findings: [F('F1')] }),
    reviewRun({ closed: [{ id: 'F1', how: 'not a bug after all: the caller checks it' }] }),
  ] });
  const { tbd, id, k } = w;
  // the daemon's view, not ticket.json (store.save writes the file first): blocked by the handler, then the run's lease
  // ended (runner.end saves it after the move); a Resume before both → 409
  await until(async () => { const m = (await tbd.api('GET', `/api/tickets/${id}`)).json?.ticket; return m?.state === 'blocked' && m.lease?.exit; }, 60_000, 'blocked, the run ended');
  let p = k();
  assert.deepEqual([p.blocked_from, p.fixes, p.waiting?.reason, p.work.task, p.review.open], ['review', 3, 'review', null, ['F1']]);
  assert.match(p.waiting.why, /fix 4, max 3 per ticket/);
  assert.equal(lines(tk(tbd, id, 'work.jsonl')).some((l) => l.t === 'task' && l.id.startsWith('@rv')), false, 'no fix task opened');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/resume`, {})).status, 202);
  await until(() => k().state === 'qa', 60_000, 'resumed review → qa');
  p = k();
  assert.deepEqual([p.fixes, p.review.n, p.review.open], [0, 2, []]);
  const d = w.dumps();
  assert.equal(d.length, 3);
  assert.equal(d[2].opts['--resume'], undefined, 'Resume: a fresh review session, never the one that returned its result');
  assert.match(d[2].prompt, /## Earlier findings/);
});

test('R7 a planning run of a code ticket: runs/1.system.md = its prompt + phases/_rules.md; the lease records the rules sha12', async (t) => {
  const id = 't_rule01';
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [{ result: { structured_output: {} } }] }));
  const tbd = await startTbd({
    files: { 'config.json': CONFIG, [`tickets/${id}/ticket.json`]: ticket(id, { state: 'planning' }) },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO_DIR: scn }, // run-spy's fixture handler: the result is only logged
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  const l = await until(() => read(tbd, id).lease?.exit && read(tbd, id).lease, 30_000, 'planning run ended');
  assert.equal(fs.readFileSync(tk(tbd, id, 'runs', '1.system.md'), 'utf8'), `# planning fixture\n\n\n${RULES}`);
  assert.equal(l.rules, crypto.createHash('sha256').update(RULES).digest('hex').slice(0, 12));
});
