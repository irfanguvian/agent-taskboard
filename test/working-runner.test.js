'use strict';
// P5a carry (contract R1: "m4 m12 tests"; P4e mutants left uncaught, code correct): the runner's J16 planning clean
// check around a recovery. m4: a recovery's run (reserved) never re-takes the round-start dirty baseline, so a Resume
// out of Blocked still sees what the blocked run left (runner.js startRun `!reserved`). m12: a planning run started
// without a baseline (a recovery of a lease from before plan_dirty existed) is judged on its own dirt, not crashed on the
// missing baseline (runner.js escaped `plan_dirty?.`). Real tbd, real planning handler, test/fake-claude.js, temp git repo.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, NOW, ticket, read, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wrunner-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
fs.mkdirSync(path.join(PHASES, 'code', 'planning'), { recursive: true });
for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', 'planning', f), path.join(PHASES, 'code', 'planning', f));
fs.writeFileSync(path.join(PHASES, 'code', 'planning', 'prompt.md'), '# planning fixture\n');
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 4,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const PLAN = {
  kind: 'plan', summary: 'Paginate GET /users', acceptance: [{ id: 'A1', text: 'returns 20 per page', type: 'new' }],
  tasks: [{ id: 'T1', title: 'cursor pagination', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['add cursor'] }],
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['README.md: users list has no paging'], decisions: [],
};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

// a repo the plan passes the rules in, a detached worktree at its main, a tbd whose fake claude plays scenarios in order
async function boot(t, over, scenarios, dirty = []) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'users api\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, base);
  for (const f of dirty) fs.writeFileSync(path.join(wt, f), 'left before the round\n');
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  scenarios.forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const id = 't_plan01';
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: { 'config.json': CONFIG, 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main' } }, [`tickets/${id}/ticket.json`]: ticket(id, { tag: 'acme/api', base_sha: base, worktree: wt, ...over }) },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return { tbd, id, k: () => read(tbd, id) };
}
const plan = { result: { structured_output: PLAN } };

test('m4: Resume out of Blocked (a recovery run) keeps the round-start dirty baseline: what the blocked run left still blocks the next result', async (t) => {
  const { tbd, id, k } = await boot(t, { round: 1 }, [{ steps: [{ exec: ['/usr/bin/touch', 'escaped.txt'] }, plan] }, { steps: [plan] }], ['pre.txt']);
  await until(() => k().state === 'blocked' && k().lease?.exit, 30_000, 'blocked by the escaped file');
  assert.deepEqual(k().plan_dirty, { round: 1, paths: ['?? pre.txt'] });
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/resume`, {})).status, 202);
  await until(() => k().lease?.gen === 2 && k().lease.exit && !k().lease.pending, 30_000, 'the resumed run ended');
  assert.deepEqual([k().state, k().lease.error], ['blocked', 'worktree changed during planning (it is read-only): ?? escaped.txt']);
  assert.deepEqual(k().plan_dirty, { round: 1, paths: ['?? pre.txt'] }, 'the recovery did not re-take the baseline');
});

test('m12: a planning run with no baseline at all (a recovery of an older lease) is judged on its own: a clean result is taken', async (t) => {
  const lease = { gen: 1, pid: null, lstart: '', pgid: null, phase: 'planning', round: 1, task: null, session: crypto.randomUUID(), log: 'runs/1.jsonl', exit: 'crash', failure: true, started_at: NOW, ended_at: NOW, last_event_at: NOW };
  const { k } = await boot(t, { round: 1, lease, locked_decisions: [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }] }, [{ steps: [plan] }]); // D-0116: past round 1, so a plan may come
  await until(() => k().state === 'plan_approval', 30_000, 'plan taken');
  assert.equal(k().plan_dirty, undefined, 'no baseline was taken by the recovery');
});

test('K4: an empty keep on a first plan (no work yet) is no keep: taken, no resume', async (t) => {
  const { k, tbd, id } = await boot(t, { round: 1, locked_decisions: [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }] }, [{ steps: [{ result: { structured_output: { ...PLAN, keep: [] } } }] }]); // D-0116: past round 1
  await until(() => k().state === 'plan_approval', 30_000, 'plan taken');
  assert.equal(fs.existsSync(path.join(tbd.tbHome, 'tickets', id, 'runs', '2.jsonl.gz')), false, 'no resume');
});

test('security: assign pins base_sha to the base BRANCH tip even when a tag of the same name (an agent can make one in the shared repo) points elsewhere', async (t) => {
  const { tbd, id, k } = await boot(t, { state: 'backlog', worktree: undefined, base_sha: undefined }, [{ steps: [{ hang: true }] }]);
  const dir = JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tags.json'), 'utf8'))['acme/api'].path;
  const tip = git(dir, 'rev-parse', 'refs/heads/main');
  git(dir, 'checkout', '-q', '-b', 'evil');
  fs.writeFileSync(path.join(dir, 'README.md'), 'planted\n');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'evil');
  git(dir, 'tag', 'main'); // refs/tags/main → the evil commit: the bare name `main` resolves to it
  git(dir, 'checkout', '-q', 'main');
  assert.notEqual(git(dir, 'rev-parse', 'main^{commit}'), tip, 'fixture: the bare name is shadowed');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/assign`)).status, 200);
  assert.equal(k().base_sha, tip);
});
