'use strict';
// M5.5 lanes (contract C19, D-0133..D-0139; build doc lane A tests P1-P5 P7 P7b P8 P9, setup, config, D-0134, D-0135): a
// real tbd (harness temp HOME + TB_HOME, port 0) with the real code/planning + code/working handlers and lib/lanes.js,
// test/fake-claude.js as claude_bin (exec steps make real commits in a temp git repo; per-task scenario dirs
// task-<id>/<n>.json: a parent and its lane run at once), scripted gates (test/helpers/fake-gates.js; a lane's under
// `lane:<task>` of its parent's script). Memory pressure through TB_HOME/test-pressure (normal unless a case says).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, FAKE_GATES, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf, alive } = require('./helpers/runs');
const { cloneAt } = require('../lib/util');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
// Admission always yes (this 8 GB Mac's free RAM must not decide a test); 2 runs: a parent + one lane
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 2, lanes: { enabled: true }, // Phase 4 contract change: lanes are their own knob (was on at max_concurrent >= 2)
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const SHA = 'c'.repeat(40);
const IDENT = { name: 'Irfan Lane', email: 'irfan@example.com' };
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const journal = (tbd, id) => lines(tk(tbd, id, 'work.jsonl'));
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function repo() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.test\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env.test'), 'SECRET=1\n');
  return dir;
}
// a plan task: its own file by default (D-0136: no overlap), free unless blocked_by says
const task = (id, over = {}) => ({ id, title: `task ${id}`, files: [`src/${id}.js`], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'preserve', test_cmd: 'npm test', steps: ['do it'], ...over });
const plan = (tasks, over = {}) => ({
  kind: 'plan', summary: 'lanes work', acceptance: [{ id: 'A1', text: 'users still work', type: 'preserve' }], tasks,
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['src/users.js: the users module'], decisions: [], ...over,
});
// fake-claude steps: a real commit in the cwd (the run's worktree), then the result
const commit = (file, msg) => ({ exec: ['/bin/sh', '-c', `set -e; mkdir -p "$(dirname ${file})"; echo "${msg}" >> ${file}; git add ${file}; git -c user.name=t -c user.email=t@t commit -qm "${msg}"`] });
const result = (out) => ({ result: { structured_output: { commit: null, tests_added: [], notes: '', ...out } } });
const done = (file, msg, before = []) => ({ steps: [...before, commit(file, msg), result({ status: 'done', commit: SHA })] });
const hold = (marker) => ({ exec: ['/bin/sh', '-c', `while [ ! -f ${marker} ]; do sleep 0.1; done`] }); // a run waits for the test (≤ 30 s: fake exec cap)
const note = (file) => ({ exec: ['/bin/sh', '-c', `git rev-parse HEAD > ${file}`] }); // what HEAD a run started on

// A marker file a held run waits for (hold); the test writes it
const marker = (name) => path.join(ROOT, `${name}-${process.pid}`);
const go = (name) => fs.writeFileSync(marker(name), '');
// the tripwire of a worktree whose node_modules has no npm lockfile and no .bin (lib/spawn.js tripwire)
const TRIP = { lock: null, bin: sha256('') };

// A parent ticket on a temp repo + worktree: in plan_approval, approved for real (POST approve → setup → working); or with
// seed (base → work cursor) seeded as approved (its plan frozen as plan-<hash>.json, base checks done, the tripwire
// baseline of trip) in clarify, then answered. Either moves to working only once the monitor has sampled (a lane needs a
// fit: before the first sample none does, and the parent's own task is then marked running: no quiet point any more). sessions: {T1: [scenario, ...]} (task-<id>/<n>.json). gates: the parent's
// fake-gates script. more: extra TB_HOME files (base → {path: value}). before(wt): the worktree before tbd starts.
async function parent(t, { tasks, sessions = {}, gates = {}, config = {}, tag = {}, env = {}, planOver = {}, ticketOver = {}, extra = {}, pressure = 'normal',
  seed = null, trip = TRIP, more = (/** @type {string} */ _base) => ({}), before = (/** @type {string} */ _wt) => {}, legacy = false }) {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  // H2.1 (contract change; was a linked worktree from `git worktree add --detach`): the parent's own clone, as assign
  // makes it (util.cloneAt), its pin on the ticket: lane setup, the lanes' gates and the merge run the clone paths.
  // legacy (C-M5): a parent from before H2, a linked worktree pinned by git_dir + common_dir (no clone)
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'wt-'))), 'w');
  const common_dir = fs.realpathSync(path.join(dir, '.git'));
  if (legacy) git(dir, 'worktree', 'add', '-q', '--detach', wt, base);
  const pin = legacy ? { common_dir, git_dir: fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir')) } : { common_dir, ...(await cloneAt(common_dir, wt, base)) };
  before(wt);
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  for (const [id, list] of Object.entries(sessions)) {
    fs.mkdirSync(path.join(scn, `task-${id}`));
    list.forEach((s, i) => fs.writeFileSync(path.join(scn, `task-${id}`, `${i + 1}.json`), JSON.stringify(s)));
  }
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const root = fs.mkdtempSync(path.join(ROOT, 'tbd-'));
  fs.mkdirSync(path.join(root, 'home', '.claude', 'skills', 'learning'), { recursive: true }); // a plan may name it (R1)
  fs.writeFileSync(path.join(root, 'home', '.claude', 'skills', 'learning', 'SKILL.md'), '---\nname: learning\n---\n');
  const id = 't_lane01';
  const p = plan(tasks, planOver);
  const hash = sha256(canon(p));
  const seeded = seed && { state: 'clarify', clarify_origin: { phase: 'working', task: null, why: 'seeded', class: 'NEEDS_CONTEXT' }, round: 4, plan_file: `plan-${hash}.json`, plan_hash: hash, plan_hashes: [hash], base_checks: {}, rules_sha: null,
    config_baseline: { paths: [], ignored: [], tripwire: trip }, work: seed(base) };
  const files = {
    'config.json': { ...CONFIG, ...config },
    'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', env_files: ['.env.test'], checks: { unit: 'npm test' }, ident: IDENT, ...tag } },
    [`tickets/${id}/ticket.json`]: ticket(id, { state: 'plan_approval', tag: 'acme/api', title: 'lanes work', base_sha: base, worktree: wt, ...pin, round: 3,
      answers: [{ id: 'R1Q1', question: 'Page size?', answer: { text: '50' } }], locked_decisions: [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }], ...seeded, ...ticketOver }),
    ...Object.fromEntries(Object.entries(extra).map(([f, v]) => [`tickets/${id}/${f}`, v])),
    [`tickets/${id}/${seed ? `plan-${hash}.json` : 'rounds/01-plan.json'}`]: p,
    [`fake-gates/${id}.json`]: gates,
    ...(pressure && { 'test-pressure': pressure }),
    ...more(base),
  };
  const envAll = { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_DUMP_DIR: dumps, FAKE_CLAUDE_SCENARIO_DIR: scn, ...env };
  const h = handles({ tbd: await startTbd({ root, files, env: envAll }), id, wt, dir, base, plan: p, root, envAll, dumps });
  t.after(async () => { reap(pidsOf(h.tbd)); await h.tbd.stop().catch(() => {}); });
  await until(async () => (await h.tbd.api('GET', '/api/state')).json?.system?.pressure, 15_000, 'a monitor sample');
  if (seed) assert.equal((await h.rpc('answer', { text: 'go on' })).ok, true);
  else assert.equal((await h.tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => h.k().state === 'working', 30_000, `${seed ? 'answer' : 'approve'} → working`);
  return h;
}

// The parent's handles: its ticket and lanes (from disk), the test pressure, its HEAD, kill -9 tbd, a stop + edit + start.
function handles(h) {
  return Object.assign(h, {
    k: () => read(h.tbd, h.id),
    // A ticket dir exists a moment before its ticket.json is renamed in (store writeJson): skip that one, poll again.
    lanes: () => fs.readdirSync(path.join(h.tbd.tbHome, 'tickets')).flatMap((x) => {
      try { return [read(h.tbd, x)]; } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    }).filter((x) => x.lane_of?.id === h.id),
    lane: () => h.lanes()[0],
    pressure: (p) => fs.writeFileSync(path.join(h.tbd.tbHome, 'test-pressure'), p),
    head: () => git(h.wt, 'rev-parse', 'HEAD'),
    async crash() {
      process.kill(Number(fs.readFileSync(path.join(h.tbd.tbHome, 'tbd.pid'), 'utf8')), 'SIGKILL');
      await h.tbd.stop({ keep: true });
      h.tbd = await startTbd({ root: h.root, env: h.envAll });
    },
    // tbd stopped (runs reaped unless keep), edit(h) while it is down, then started again on the same TB_HOME
    async restart(edit, { keep = false } = {}) {
      if (!keep) reap(pidsOf(h.tbd));
      await h.tbd.stop({ keep: true });
      edit(h);
      h.tbd = await startTbd({ root: h.root, env: h.envAll });
    },
    patch(id, fn) {
      const f = tk(h.tbd, id, 'ticket.json');
      fs.writeFileSync(f, JSON.stringify(fn(json(f)), null, 2));
    },
    // a working verb inside tbd (fake-gates file RPC) → {ok, value} | {ok: false, status, error}
    async rpc(fn, ...args) {
      const d = path.join(h.tbd.tbHome, 'test-rpc');
      fs.mkdirSync(d, { recursive: true });
      const n = (h.rpcN = (h.rpcN ?? 0) + 1);
      fs.writeFileSync(path.join(d, `${n}.tmp`), JSON.stringify({ fn, args: [h.id, ...args] }));
      fs.renameSync(path.join(d, `${n}.tmp`), path.join(d, `${n}.json`));
      await until(() => fs.existsSync(path.join(d, `${n}.out.json`)), 10_000, `rpc ${fn}`);
      return json(path.join(d, `${n}.out.json`));
    },
  });
}
// a seeded work task (lib/working.js seedWork shape)
const wtask = (id, over = {}) => ({ id, status: 'pending', attempt: 0, pre: null, head: null, commit: null, session: null, blocked_by: [], ...over });
const cursor = (tasks, over = {}) => ({ task: tasks.find((x) => x.status === 'pending')?.id ?? null, tasks, tries: 0, unit_ms: null, scope: {}, denied: {}, serial: [], gate: null, ...over });
const merges = (w) => journal(w.tbd, w.id).filter((l) => l.t === 'merge');
const laneLines = (w) => journal(w.tbd, w.id).filter((l) => l.t === 'lane');
const alerts = (w) => lines(path.join(w.tbd.tbHome, 'test-alerts.jsonl'));
const subjects = (w) => git(w.wt, 'log', '--format=%s', `${w.base}..HEAD`).split('\n').filter(Boolean).reverse();
const waitsMerge = (w) => until(() => w.lane()?.state === 'working' && w.lane().waiting?.reason === 'merge', 45_000, 'the lane waits merge');

test('P1 P8 P9: T1, T2 free, T3 after T1 (max 2) → T2 in a lane; it waits merge while T1 runs (parent HEAD, branch, merging untouched); T1 accepted → T2 picked (committer = tag ident) and re-gated as preserve → T3 from the merged HEAD → working gate → review; the lane done, its worktree gone, its t:ticket line names the parent', async (t) => {
  const rules = path.join(ROOT, `rules-${process.pid}.md`);
  fs.writeFileSync(rules, 'Never use offset paging.\n');
  const w = await parent(t, {
    tasks: [task('T1'), task('T2'), task('T3', { blocked_by: ['T1'] })],
    planOver: { skills: ['learning'] }, ticketOver: { sandbox: true }, tag: { rules: [rules] },
    extra: { 'decisions.json': [{ id: 'D1', text: 'cursor in a header', source: 'planner' }], 'scope.json': { allow: { T2: [{ path: 'lib/t2.js' }] }, denied: {} } },
    sessions: {
      T1: [done('src/T1.js', 'T1', [hold(marker('p1-go'))])],
      T2: [done('src/T2.js', 'T2')],
      T3: [done('src/T3.js', 'T3', [note(marker('p1-t3'))])],
    },
  });
  const { id } = w;
  await waitsMerge(w);
  const lane = w.lane();
  const branch = w.k().branch;
  // P8: the lane ticket: one task (T2), its own worktree pinned (S1), the parent's plan / rules / decisions / answers / base
  assert.deepEqual([lane.lane_of, lane.state, lane.kind, lane.tag, lane.base_sha, lane.plan_hash, lane.plan_file], [{ id, task: 'T2' }, 'working', 'code', 'acme/api', w.base, w.k().plan_hash, w.k().plan_file]);
  assert.deepEqual(lane.answers, w.k().answers);
  // H2.6 (contract change; was git_dir under common_dir/worktrees): the lane's own clone, pinned with its config hash
  assert.deepEqual([lane.git_dir, lane.common_dir, typeof lane.clone?.config], [path.join(lane.worktree, '.git'), w.k().common_dir, 'string'], 'S1 H2.2: the lane clone pinned');
  assert.equal(lane.worktree, path.join(w.tbd.tbHome, 'worktrees', lane.id));
  assert.deepEqual(lane.work.tasks.map((x) => [x.id, x.status, x.pre]), [['T2', 'done', w.base]]);
  assert.equal(fs.readFileSync(tk(w.tbd, lane.id, 'rules.md'), 'utf8'), 'Never use offset paging.\n');
  assert.ok(fs.statSync(tk(w.tbd, lane.id, 'skills', '.claude', 'skills', 'learning')).isDirectory(), 'skills/ copied');
  assert.deepEqual(json(tk(w.tbd, lane.id, 'scope.json')), { allow: { T2: [{ path: 'lib/t2.js' }] }, denied: { T2: [] } });
  assert.deepEqual(json(tk(w.tbd, lane.id, lane.plan_file)), json(tk(w.tbd, id, lane.plan_file)));
  assert.deepEqual(json(tk(w.tbd, lane.id, 'decisions.json')), [{ id: 'D1', text: 'cursor in a header', source: 'planner' }]);
  const laneHead = lane.work.tasks[0].head;
  assert.equal(git(lane.worktree, 'log', '-1', '--format=%s', laneHead), 'T2');
  // P9 + done-when: T1 still runs; the lane wrote nothing to the parent's branch, no merge starts
  for (let i = 0; i < 20; i++) {
    // H2.3 (contract change; was the branch read in the tag repo): the parent's branch lives in its clone
    assert.deepEqual([w.head(), git(w.wt, 'rev-parse', `refs/heads/${branch}`), w.k().work.merging ?? null, w.k().work.tasks[0].status], [w.base, w.base, null, 'running']);
    await sleep(100);
  }
  go('p1-go');
  await until(() => w.k().state === 'review', 60_000, 'review');
  const p = w.k();
  const log = git(w.wt, 'log', '--format=%H%x00%s%x00%an%x00%cn%x00%ce', `${w.base}..HEAD`).split('\n').reverse().map((l) => l.split('\0'));
  assert.deepEqual(log.map((l) => l[1]), ['T1', 'T2', 'T3']);
  assert.deepEqual(log[1].slice(2), ['t', IDENT.name, IDENT.email], 'C12: the pick keeps the author, the committer is the tag ident');
  assert.deepEqual(p.work.tasks.map((x) => [x.id, x.status, x.head]), [['T1', 'done', log[0][0]], ['T2', 'done', log[1][0]], ['T3', 'done', log[2][0]]]);
  assert.equal(p.work.tasks[2].pre, log[1][0], 'T3 starts from the merged HEAD');
  assert.equal(fs.readFileSync(marker('p1-t3'), 'utf8').trim(), log[1][0]);
  // the re-gate: a task gate on the parent for T2, preserve, from merging.pre (T1's head), no fail-first
  const regate = lines(path.join(w.tbd.tbHome, 'fake-gates.jsonl')).filter((c) => c.ticket === id && c.task === 'T2');
  assert.deepEqual(regate.map((c) => [c.fn, c.type, c.pre]), [['task', 'preserve', log[0][0]]]);
  assert.deepEqual(journal(w.tbd, id).filter((l) => l.t === 'merge').map((l) => [l.task, l.lane, l.ok, l.head]), [['T2', lane.id, true, log[1][0]]]);
  assert.deepEqual(journal(w.tbd, id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.task, l.ok]), [['task', 'T1', true], ['task', 'T3', true], ['working', null, true]]);
  // the lane: done (runner), its entry gone, its worktree removed (D-0138), its t:ticket line names the parent (D-0139)
  // the t:ticket line follows the lane's save (store event): wait on it too
  const tl = () => lines(path.join(w.tbd.tbHome, 'metrics.jsonl')).find((m) => m.t === 'ticket' && m.ticket === lane.id);
  // H2.3 (contract change; was also: `git worktree list` forgot it): a lane clone is a plain dir, removed with rm
  await until(() => w.lane().state === 'done' && !fs.existsSync(lane.worktree) && tl(), 10_000, 'lane done, its clone gone, t:ticket line');
  assert.equal(git(w.dir, 'for-each-ref', `refs/tb/${lane.id}/head`).split(' ')[0], lane.work.tasks[0].head, 'H2.5: the lane\'s gate fetched its head into the tag repo');
  assert.deepEqual([p.work.lanes, p.work.serial, p.work.merging], [{}, [], null]);
  const tline = tl();
  assert.deepEqual([tline.outcome, tline.lane_of], ['done', id]);
});

test('P2 (+/−): a conflicting pick → cherry-pick aborted, the parent reset to merging.pre, refs/tb/<id>/lane-T2 = the lane head, T2 back to serial (never a lane again), the lane cancelled, its worktree gone; T2 runs on the parent → review', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: {
      T1: [done('src/shared.js', 'parent', [hold(marker('p2-go')), commit('src/T1.js', 'T1')])],
      T2: [done('src/shared.js', 'lane', [commit('src/T2.js', 'T2')]), done('src/T2.js', 'T2 serial')],
    },
  });
  await waitsMerge(w);
  const lane = w.lane();
  go('p2-go');
  await until(() => merges(w).length === 1, 45_000, 'the merge ended');
  const t1 = w.k().work.tasks[0].head;
  assert.deepEqual(merges(w).map((l) => [l.task, l.lane, l.ok]), [['T2', lane.id, false]]);
  assert.match(merges(w)[0].why, /^cherry-pick [0-9a-f]{12}\.\.[0-9a-f]{12}: /);
  // H2.3 (contract change; was the tag repo's refs and git dir): the lane-fail ref and the pick state live in the parent's clone
  assert.equal(git(w.wt, 'rev-parse', `refs/tb/${w.id}/lane-T2`), lane.work.tasks[0].head, 'the lane\'s commits kept by ref');
  assert.equal(fs.existsSync(path.join(w.wt, '.git', 'CHERRY_PICK_HEAD')), false, 'the pick aborted');
  await until(() => w.k().state === 'review', 45_000, 'review');
  const p = w.k();
  assert.deepEqual([p.work.serial, p.work.lanes, p.work.merging], [['T2'], {}, null]);
  assert.deepEqual(subjects(w), ['T1', 'parent', 'T2 serial'], 'reset to T1\'s head (merging.pre), T2 again on top');
  assert.equal(p.work.tasks[1].pre, t1);
  assert.deepEqual(w.lanes().map((x) => x.state), ['cancelled'], 'one lane only: T2 never a lane again');
  assert.equal(fs.existsSync(lane.worktree), false);
});

test('P2 (−): the re-gate red → the same fallback: reset to merging.pre, lane-T2 ref, T2 serial, lane cancelled', async (t) => {
  const red = { ok: false, class: 'work', why: 'unit: 1 failing after the pick' };
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    gates: { task: [{}, red, {}] },
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p2r-go'))])], T2: [done('src/T2.js', 'T2'), done('src/T2.js', 'T2 serial')] },
  });
  await waitsMerge(w);
  const lane = w.lane();
  go('p2r-go');
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.deepEqual(merges(w).map((l) => [l.task, l.ok]), [['T2', false]]);
  assert.match(merges(w)[0].why, /re-gate red.*unit: 1 failing after the pick/);
  assert.equal(git(w.wt, 'rev-parse', `refs/tb/${w.id}/lane-T2`), lane.work.tasks[0].head); // H2.3: in the parent's clone
  assert.deepEqual(subjects(w), ['T1', 'T2 serial']);
  assert.deepEqual([w.k().work.serial, w.lanes().map((x) => x.state)], [['T2'], ['cancelled']]);
});

test('P3 (−) no lane: max_concurrent 1; T2\'s plan files overlap T1\'s (D-0136); memory warn (fits fails, D-0134); a cursor from before M5.5 (no blocked_by)', async (t) => {
  // each: T1 starts (a lane is made before the parent's own run, so none by then = none at all)
  const started = async (w) => {
    await until(() => w.k().work?.tasks?.[0]?.status === 'running' && Number.isInteger(w.k().lease?.pid), 30_000, 'T1 runs');
    assert.deepEqual([w.lanes().length, w.k().work.lanes ?? {}], [0, {}]);
  };
  const T1 = { T1: [{ steps: [{ hang: true }] }] };
  await started(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1, config: { max_concurrent: 1 } }));
  await started(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1, config: { max_concurrent: 3, lanes: { enabled: false } } })); // Phase 4: the knob off
  await started(await parent(t, { tasks: [task('T1'), task('T2', { files: ['src/T1.js'] })], sessions: T1 }));
  await started(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1, pressure: 'warn' }));
  await started(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1,
    seed: (base) => cursor([{ ...wtask('T1', { attempt: 1, pre: base }), blocked_by: undefined }, { ...wtask('T2'), blocked_by: undefined }]) }));
});

test('P4 (+): parent cancelled while its lane runs → the lane cancelled by the runner (no intervention), its run\'s group gone, its worktree gone; a parent replanned (clarify → planning) → the same', async (t) => {
  const w = await parent(t, { tasks: [task('T1'), task('T2')], sessions: { T1: [{ steps: [{ hang: true }] }], T2: [{ steps: [{ hang: true }] }] } });
  await until(() => Number.isInteger(w.lane()?.lease?.pid) && Number.isInteger(w.k().lease?.pid), 30_000, 'both run');
  const lane = w.lane();
  assert.equal((await w.tbd.api('POST', `/api/tickets/${w.id}/cancel`, {})).status, 202);
  await until(() => w.lane().state === 'cancelled' && !fs.existsSync(lane.worktree), 45_000, 'lane cancelled, worktree gone');
  assert.equal(alive(lane.lease.pid), false, 'the lane\'s run killed');
  assert.equal(fs.existsSync(tk(w.tbd, lane.id, 'interventions.jsonl')), false, 'the runner\'s end, not Irfan\'s');
  assert.equal(w.k().state, 'cancelled');

  const r = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [{ steps: [hold(marker('p4-ask')), result({ status: 'NEEDS_CONTEXT', question: 'Split users?' })] }, { steps: [{ hang: true }] }], T2: [{ steps: [{ hang: true }] }] },
  });
  await until(() => Number.isInteger(r.lane()?.lease?.pid), 30_000, 'lane runs');
  go('p4-ask');
  await until(() => r.k().state === 'clarify', 30_000, 'parent clarify');
  assert.equal(r.lane().state, 'working', 'D-0135: a parent in clarify keeps its lane');
  assert.equal((await r.rpc('answer', { replan: true })).ok, true);
  const rl = r.lane();
  await until(() => r.lane().state === 'cancelled' && !fs.existsSync(rl.worktree), 45_000, 'lane cancelled on replan');
  assert.equal(alive(rl.lease.pid), false);
  assert.equal(fs.existsSync(tk(r.tbd, rl.id, 'interventions.jsonl')), false);
});

// (the "no alert" of a lane in clarify is notify's: lane D's test)
test('P5 (−): a lane red twice → cancelled (no fresh try), T2 back to serial: the idle parent takes it as its cursor (X2b) → done; a lane asking (NEEDS_CONTEXT) → cancelled at once, T2 serial', async (t) => {
  const red = (n) => ({ ok: false, class: 'work', why: `unit: red ${n}` });
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    gates: { 'lane:T2': [red(1), red(2)] },
    sessions: { T1: [done('src/T1.js', 'T1')], T2: [done('src/T2.js', 'lane 1', [{ sleep_ms: 2500 }]), done('src/T2.js', 'lane 2'), done('src/T2.js', 'T2 serial')] },
  });
  await until(() => w.k().work.tasks[0].status === 'done' && w.k().waiting?.reason === 'lanes', 30_000, 'T1 done, the parent waits lanes');
  assert.equal(w.k().work.task, null);
  await until(() => w.k().state === 'review', 60_000, 'review');
  const lane = w.lanes()[0];
  assert.equal(lane.state, 'cancelled');
  assert.equal(fs.readdirSync(tk(w.tbd, lane.id, 'runs')).filter((f) => /^\d+\.jsonl/.test(f)).length, 2, 'two lane runs: the 2nd red started no 3rd');
  assert.deepEqual([w.k().work.serial, subjects(w)], [['T2'], ['T1', 'T2 serial']]);

  const a = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p5-go'))])], T2: [{ steps: [result({ status: 'NEEDS_CONTEXT', question: 'Which table?' })] }, done('src/T2.js', 'T2 serial')] },
  });
  // store.save writes ticket.json before its events line: wait on the line itself, not on the state.
  const ev = () => (a.lane() ? lines(tk(a.tbd, a.lane().id, 'events.jsonl')).filter((e) => e.kind === 'transition').map((e) => [e.from, e.to]) : []);
  await until(() => ev().at(-1)?.[1] === 'cancelled', 30_000, 'lane cancelled');
  assert.deepEqual(ev(), [['working', 'clarify'], ['clarify', 'cancelled']]);
  go('p5-go');
  await until(() => a.k().state === 'review', 45_000, 'review');
  assert.deepEqual(a.k().work.serial, ['T2']);
});

test('P7 (+): tbd killed mid re-gate → boot kills the gate orphan, resets to merging.pre, clears merging → the merge redone → green', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    gates: { task: [{}, { child: true, sleep_ms: 60_000 }, {}] },
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p7a-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  go('p7a-go');
  await until(() => w.k().work.merging && w.k().work.gate?.proc?.lstart, 45_000, 're-gate running');
  const { merging: m, gate } = w.k().work;
  assert.notEqual(w.head(), m.pre, 'picked');
  await w.crash();
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.equal(alive(gate.proc.pid), false, 'the orphan killed at boot');
  assert.deepEqual(subjects(w), ['T1', 'T2'], 'one pick of T2: the first undone');
  assert.deepEqual(merges(w).map((l) => l.ok), [true]);
  assert.equal(lines(path.join(w.tbd.tbHome, 'fake-gates.jsonl')).filter((c) => c.ticket === w.id && c.task === 'T2').length, 2, 're-gated again');
});

test('P7 (+): seeded work.merging with a real CHERRY_PICK_HEAD → boot aborts the pick, resets to merging.pre, clears merging → merged again once T1 is done', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p7b-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  const lane = w.lane();
  const gd = path.join(w.wt, '.git'); // H2.1 (contract change; was <tag>/.git/worktrees/w): the parent's clone
  await w.restart((h) => { // a kill mid-pick, by hand: a conflicting commit, then the lane picked onto it
    fs.writeFileSync(path.join(h.wt, 'src', 'T2.js'), 'other\n');
    git(h.wt, 'add', 'src/T2.js');
    git(h.wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other');
    assert.throws(() => git(h.wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', lane.work.tasks[0].head));
    assert.ok(fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD')));
    h.patch(h.id, (k) => ({ ...k, work: { ...k.work, merging: { task: 'T2', pre: h.base, lane: lane.id } } }));
  }, { keep: true });
  await until(() => w.k().work.merging === null, 30_000, 'merging cleared at boot');
  assert.deepEqual([w.head(), fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD')), git(w.wt, 'status', '--porcelain')], [w.base, false, '']);
  assert.equal(w.lane().waiting?.reason, 'merge', 'the lane waits on');
  go('p7b-go');
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.deepEqual(subjects(w), ['T1', 'T2']);
});

test('P7 (+): a Restart of the parent during a merge job → halt aborts it, the pick undone, then the session starts on merging.pre with a clean tree (C#7c); merged later', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2'), task('T3', { blocked_by: ['T1'] })],
    gates: { task: [{}, { sleep_ms: 60_000 }, {}, {}] },
    sessions: {
      T1: [done('src/T1.js', 'T1', [hold(marker('p7c-go'))])], T2: [done('src/T2.js', 'T2')],
      T3: [done('src/T3.js', 'T3', [{ exec: ['/bin/sh', '-c', `git rev-parse HEAD > ${marker('p7c-head')}; git status --porcelain > ${marker('p7c-status')}`] }])],
    },
  });
  await waitsMerge(w);
  go('p7c-go');
  // the re-gate's own call (H2.5: its pre-check now fetches HEAD and compares content first; a Restart before the call
  // would hand the scripted 60 s sleep to T3's gate)
  await until(() => w.k().work.merging && w.k().work.gate && w.head() !== w.k().work.merging.pre
    && lines(path.join(w.tbd.tbHome, 'fake-gates.jsonl')).some((c) => c.ticket === w.id && c.task === 'T2'), 45_000, 'merge re-gate running');
  const pre = w.k().work.merging.pre;
  assert.equal((await w.tbd.api('POST', `/api/tickets/${w.id}/restart`, {})).status, 202);
  await until(() => fs.existsSync(marker('p7c-status')), 30_000, 'T3 started');
  assert.deepEqual([fs.readFileSync(marker('p7c-head'), 'utf8').trim(), fs.readFileSync(marker('p7c-status'), 'utf8')], [pre, ''], 'no session on a half-picked tree');
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.deepEqual(subjects(w), ['T1', 'T3', 'T2']);
  assert.deepEqual(merges(w).map((l) => l.ok), [true]);
});

test('P7 (+): an abort during the pick (critical memory) → the merge undone, the lane still waits merge, T2 not serial; merged once memory is back', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')], env: { TB_LANE_PICK_DELAY_MS: '3000' },
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p7d-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  go('p7d-go');
  await until(() => w.k().work.merging && w.head() !== w.k().work.merging.pre, 45_000, 'picked, in the delay');
  const pre = w.k().work.merging.pre;
  w.pressure('critical');
  await until(() => !w.k().work.merging && w.head() === pre, 30_000, 'undone');
  assert.deepEqual([w.lane().waiting?.reason, w.k().work.serial, merges(w)], ['merge', [], []]);
  // K12: while memory stays critical the parent waits memory: no pick (and re-gate) into the next memory kill per tick
  await until(() => w.k().waiting?.reason === 'memory', 10_000, 'the parent waits memory');
  for (let i = 0; i < 30; i++) {
    assert.deepEqual([w.k().work.merging ?? null, w.head()], [null, pre], 'no pick while critical');
    await sleep(100);
  }
  w.pressure('normal');
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.deepEqual(subjects(w), ['T1', 'T2']);
  assert.deepEqual(merges(w).map((l) => l.ok), [true]);
});

test('P7b (+): seeded crash after the merge CAS (parent T2 done, merging null) but before the lane closed → the next quiet point closes it (done), no pick', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p7e-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  const lane = w.lane();
  await w.restart((h) => h.patch(h.id, (k) => ({
    ...k, lease: { ...k.lease, exit: 'result' },
    work: { ...k.work, task: null, tasks: k.work.tasks.map((x) => ({ ...x, status: 'done', head: h.base })) },
  })));
  await until(() => w.lane().state === 'done' && !fs.existsSync(lane.worktree), 30_000, 'the lane closed');
  await until(() => w.k().state === 'review', 30_000, 'review');
  assert.deepEqual([merges(w), w.k().work.lanes, w.k().work.serial], [[], {}, []]);
});

test('P7b (+) boot: seeded crash after a merge-green CAS that also set the working gate (no quiet point follows) → boot closes the lane done, never cancelled', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('p7f-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  const lane = w.lane();
  await w.restart((h) => h.patch(h.id, (k) => ({
    ...k, lease: { ...k.lease, exit: 'result' },
    work: { ...k.work, task: null, gate: { gen: k.lease?.gen ?? 0, kind: 'working' }, tasks: k.work.tasks.map((x) => ({ ...x, status: 'done', head: h.base })) },
  })));
  await until(() => w.lane().state === 'done' && !fs.existsSync(lane.worktree), 30_000, 'the lane closed done at boot');
  await until(() => w.k().state === 'review', 30_000, 'review');
  assert.deepEqual([w.k().work.lanes, w.k().work.serial], [{}, []]);
});

test('Setup (−) [C#7d]: the parent\'s node_modules not what its baseline says (tripwire) → no lane: cancelled, worktree gone, entry gone, T2 serial; node_modules that cannot be cloned → the same', async (t) => {
  const seed = (base) => cursor([wtask('T1', { attempt: 1, pre: base }), wtask('T2')]);
  const check = async (w, why) => {
    await until(() => laneLines(w).length === 1 && w.lane()?.state === 'cancelled', 30_000, 'lane refused');
    const lane = w.lane();
    assert.match(laneLines(w)[0].why, why);
    assert.deepEqual([laneLines(w)[0].task, laneLines(w)[0].lane, lane.lease], ['T2', lane.id, null]);
    await until(() => !fs.existsSync(path.join(w.tbd.tbHome, 'worktrees', lane.id)), 15_000, 'worktree gone');
    assert.deepEqual([w.k().work.lanes, w.k().work.serial], [{}, ['T2']]);
  };
  const T1 = { T1: [{ steps: [{ hang: true }] }] };
  await check(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1, seed, trip: { lock: 'f'.repeat(64), bin: sha256('') } }), /tripwire/);
  const locked = [];
  t.after(() => locked.forEach((f) => fs.chmodSync(f, 0o644)));
  await check(await parent(t, { tasks: [task('T1'), task('T2')], sessions: T1, seed, before: (wt) => {
    fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
    locked.push(path.join(wt, 'node_modules', 'pkg', 'index.js'));
    fs.writeFileSync(locked[0], 'x\n', { mode: 0o000 });
  } }), /node_modules clone failed/);
});

test('Config (−) [C#7e C#1]: T1 commits .claude/settings.json (its gate green) → the lane made at T1\'s head is refused as agent-planted (never its own baseline): cancelled before any run, T3 serial', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2', { blocked_by: ['T1'] }), task('T3', { blocked_by: ['T1'] })],
    sessions: { T1: [done('src/T1.js', 'T1', [commit('.claude/settings.json', '{}')])], T2: [{ steps: [{ hang: true }] }], T3: [{ steps: [{ hang: true }] }] },
  });
  await until(() => laneLines(w).length === 1, 45_000, 'lane refused');
  const lane = w.lane();
  assert.equal(laneLines(w)[0].task, 'T3');
  assert.match(laneLines(w)[0].why, /planted.*\.claude\/settings\.json/);
  await until(() => w.lane().state === 'cancelled', 15_000, 'lane cancelled');
  assert.deepEqual([w.lane().lease, fs.existsSync(tk(w.tbd, lane.id, 'runs'))], [null, false], 'the lane never ran');
  assert.deepEqual(w.k().work.serial, ['T3']);
  // D-0140: a security end: the parent alerted as "<parent> lane <id>: <error>", its worktree kept for tb gc (boot too)
  const mine = alerts(w).filter((a) => a.message.startsWith(`${w.id} lane `));
  assert.deepEqual(mine.map((a) => a.title), ['Lane refused: agent-planted config']);
  assert.match(mine[0].message, new RegExp(`^${w.id} lane ${lane.id}: agent-planted config: .*\\.claude/settings\\.json`));
  await w.restart(() => {});
  assert.equal(fs.existsSync(path.join(w.tbd.tbHome, 'worktrees', lane.id)), true, 'the lane worktree kept');
});

test('D-0134 (+): a lane made but never started while its parent has nothing to do → taken back: cancelled, T2 serial, the parent\'s cursor', async (t) => {
  const lane = 't_lane02';
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')], sessions: {}, pressure: 'warn', config: { memory: { ...CONFIG.memory, start_at_warn_when_idle: false } },
    seed: (base) => cursor([wtask('T1', { status: 'done', attempt: 1, pre: base, head: base }), wtask('T2')], { task: null, lanes: { T2: lane } }),
    more: (base) => ({ [`tickets/${lane}/ticket.json`]: ticket(lane, { state: 'working', tag: 'acme/api', round: 1, base_sha: base, lane_of: { id: 't_lane01', task: 'T2' },
      work: cursor([wtask('T2', { attempt: 1, pre: base })]) }) }),
  });
  await until(() => w.k().work.task === 'T2', 30_000, 'T2 the parent\'s cursor');
  assert.deepEqual([read(w.tbd, lane).state, read(w.tbd, lane).lease, w.k().work.lanes, w.k().work.serial], ['cancelled', null, {}, ['T2']]);
});

test('D-0135 (+): parent T1 asks (clarify) while lane T2 runs → the lane reaches waiting merge, no merge while the parent is in clarify; answered → T1 goes on from its own HEAD → merged at T1\'s accept', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: {
      T1: [{ steps: [hold(marker('d135-ask')), result({ status: 'NEEDS_CONTEXT', question: 'Page size?' })] },
        { steps: [note(marker('d135-head')), commit('src/T1.js', 'T1'), result({ status: 'done', commit: SHA })] }],
      T2: [done('src/T2.js', 'T2')],
    },
  });
  await waitsMerge(w);
  go('d135-ask');
  await until(() => w.k().state === 'clarify', 30_000, 'parent clarify');
  for (let i = 0; i < 10; i++) {
    assert.deepEqual([w.lane().state, w.lane().waiting?.reason, w.k().work.merging ?? null, w.head()], ['working', 'merge', null, w.base]);
    await sleep(100);
  }
  assert.equal((await w.rpc('answer', { text: '50' })).ok, true);
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.equal(fs.readFileSync(marker('d135-head'), 'utf8').trim(), w.base, 'T1 went on before any merge');
  assert.deepEqual(subjects(w), ['T1', 'T2']);
  const j = journal(w.tbd, w.id);
  assert.ok(j.findIndex((l) => l.t === 'gate' && l.task === 'T1') < j.findIndex((l) => l.t === 'merge'), 'merged at T1\'s accept');
});

test('D-0135 (+) [C#7g]: a parent Blocked keeps its lane running; the lane reaches waiting merge, nothing merged while blocked', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    gates: { task: [{ ok: false, class: 'infra', why: 'gate host gone' }] },
    sessions: { T1: [done('src/T1.js', 'T1')], T2: [done('src/T2.js', 'T2', [hold(marker('d135b-go'))])] },
  });
  await until(() => w.k().state === 'blocked' && Number.isInteger(w.lane()?.lease?.pid), 45_000, 'parent blocked, lane runs');
  const pid = w.lane().lease.pid;
  await sleep(1500);
  assert.deepEqual([w.lane().state, alive(pid)], ['working', true]);
  go('d135b-go');
  await waitsMerge(w);
  assert.deepEqual([w.k().state, w.k().work.merging ?? null, w.k().work.tasks[1].status], ['blocked', null, 'pending']);
});

// H2.6 (contract change; was: the lane's agent moved the parent's branch through the shared .git): a lane's agent now
// writes only its own clone (its ref write below stays there); the guard is kept for anything else that moves the
// parent's branch outside tbd (the test does, in the parent's clone)
test('sec A08 (−): the parent\'s branch moved outside tbd while the parent waits for its lanes (a lane\'s own ref write stays in its clone) → no merge: the parent Blocked integrity naming both heads + an alert, nothing picked, every pre unchanged; a Restart of a parent waiting for its lanes → 409', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')],
    sessions: {
      T1: [done('src/T1.js', 'T1')],
      // C-L10: the lane's agent moves "the parent's branch" to its own new head (a value no rewind below can mask): with
      // its own clone (H2.6) that ref is its clone's, the parent's branch never moves
      T2: [{ steps: [hold(marker('a08-go')), commit('src/T2.js', 'T2'), { exec: ['/usr/bin/git', 'update-ref', 'refs/heads/tb/t_lane01-lanes-work', 'HEAD'] }, result({ status: 'done', commit: SHA })] }],
    },
  });
  await until(() => w.k().work.tasks[0].status === 'done' && w.k().waiting?.reason === 'lanes', 30_000, 'T1 done, the parent waits lanes');
  const t1 = w.k().work.tasks[0].head;
  const r = await w.tbd.api('POST', `/api/tickets/${w.id}/restart`, {});
  assert.deepEqual([r.status, r.json, w.k().state], [409, { error: `${w.id}: waits for its lanes` }, 'working'], 'no session with no task of its own');
  git(w.wt, 'update-ref', `refs/heads/${w.k().branch}`, w.base); // rewound to the base outside tbd: a done task gone
  go('a08-go');
  // the alert follows the Blocked save: wait on both
  await until(() => w.k().state === 'blocked' && alerts(w).some((a) => a.title === 'Blocked: integrity'), 45_000, 'parent blocked, alerted');
  const p = w.k();
  assert.deepEqual([p.waiting.reason, p.work.merging ?? null, p.work.tasks.map((x) => [x.id, x.status, x.pre])], ['integrity', null, [['T1', 'done', w.base], ['T2', 'pending', null]]]);
  assert.match(p.waiting.why, new RegExp(`^HEAD ${w.base} is not ${t1}`));
  assert.deepEqual([merges(w), w.head(), w.lane().waiting?.reason], [[], w.base, 'merge'], 'nothing picked; the lane waits on');
  const lh = w.lane().work.tasks[0].head;
  assert.deepEqual([git(w.lane().worktree, 'rev-parse', 'refs/heads/tb/t_lane01-lanes-work'), git(w.wt, 'rev-parse', `refs/heads/${p.branch}`) !== lh], [lh, true], 'C-L10: the lane\'s ref write stayed in its clone');
  const integ = alerts(w).filter((a) => a.title === 'Blocked: integrity');
  assert.equal(integ.length, 1);
  assert.match(integ[0].message, new RegExp(`^${w.id}: HEAD ${w.base} is not ${t1}`));
});

// C-M5 (+) no breaking change: a parent from before H2 (a linked worktree, no clone) and its lane (always a clone, H2.6):
// the lane cloned at cur.pre straight from the tag repo (no parent clone to fetch from), its gate fetches its head into
// the tag repo, the merge picks it with no fetch (the parent reads the tag's objects) and re-gates it → review
test('C-M5 (+): a legacy parent (linked worktree, no clone) + a clone lane: T2 in its own clone from the tag repo, picked onto the parent\'s branch with no fetch, re-gated → review; the lane done, its clone gone', async (t) => {
  const w = await parent(t, {
    legacy: true,
    tasks: [task('T1'), task('T2')],
    sessions: { T1: [done('src/T1.js', 'T1', [hold(marker('cm5-go'))])], T2: [done('src/T2.js', 'T2')] },
  });
  await waitsMerge(w);
  const lane = w.lane();
  assert.deepEqual([w.k().clone, typeof lane.clone?.config, lane.git_dir, lane.common_dir], [undefined, 'string', path.join(lane.worktree, '.git'), w.k().common_dir]);
  go('cm5-go');
  await until(() => w.k().state === 'review', 60_000, 'review');
  assert.deepEqual(subjects(w), ['T1', 'T2']);
  assert.deepEqual(merges(w).map((l) => [l.task, l.lane, l.ok]), [['T2', lane.id, true]]);
  await until(() => w.lane().state === 'done' && !fs.existsSync(lane.worktree), 10_000, 'lane done, its clone gone');
});

// C-M4 (−) D-0140: the parent's clone config changed (agent-planted) → the lane setup's fetch from the parent is refused
// PLANTED inside planning.worktree, which keeps the code: a security end (the parent alerted "Lane refused", lane_end
// keep), never an ordinary lane failure; T2 serial
test('C-M4 (−): the parent\'s clone config planted → lane setup refused PLANTED through planning.worktree → "Lane refused: agent-planted config" alert naming the lane, lane cancelled (keep), T2 serial', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2')], sessions: { T1: [{ steps: [{ hang: true }] }] },
    seed: (base) => cursor([wtask('T1', { attempt: 1, pre: base }), wtask('T2')]),
    before: (wt) => fs.appendFileSync(path.join(wt, '.git', 'config'), '[tb]\n\tplanted = 1\n'),
  });
  await until(() => laneLines(w).length === 1 && w.lane()?.state === 'cancelled', 30_000, 'lane refused');
  const lane = w.lane();
  assert.match(laneLines(w)[0].why, /config is not the one tbd wrote/);
  assert.deepEqual([laneLines(w)[0].task, lane.lane_end?.keep, w.k().work.serial], ['T2', true, ['T2']]);
  await until(() => alerts(w).some((a) => a.message.startsWith(`${w.id} lane `)), 10_000, 'the parent alerted');
  const mine = alerts(w).filter((a) => a.message.startsWith(`${w.id} lane `));
  assert.deepEqual(mine.map((a) => a.title), ['Lane refused: agent-planted config']);
  assert.match(mine[0].message, new RegExp(`^${w.id} lane ${lane.id}: .*config is not the one tbd wrote`));
});

test('K4 + lanes: T3 accepted before lane T2 merges (branch T1 T3 T2, plan T1 T2 T3) → a replan may keep T1 only (keep_ok): a reset to the last kept head never drops the merged T2', async (t) => {
  const w = await parent(t, {
    tasks: [task('T1'), task('T2'), task('T3', { blocked_by: ['T1'] }), task('T4', { blocked_by: ['T3'] })],
    sessions: {
      T1: [done('src/T1.js', 'T1')],
      T2: [done('src/T2.js', 'T2', [hold(marker('k4-lane'))])],
      T3: [done('src/T3.js', 'T3', [hold(marker('k4-t3'))])],
      // T4 asks; the replan's planner run (no task: its cwd's last one, T4) waits
      T4: [{ steps: [result({ status: 'NEEDS_CONTEXT', question: 'Split users?' })] }, { steps: [{ hang: true }] }],
    },
  });
  await until(() => w.k().work.task === 'T3' && w.k().work.tasks[2].status === 'running', 30_000, 'T3 runs, T2 still in its lane');
  go('k4-lane');
  await waitsMerge(w);
  go('k4-t3');
  await until(() => w.k().state === 'clarify', 60_000, 'T4 asks, T2 merged after T3');
  assert.deepEqual(subjects(w), ['T1', 'T3', 'T2']);
  assert.equal((await w.rpc('answer', { replan: true })).ok, true);
  const planner = () => fs.readdirSync(w.dumps).map((f) => json(path.join(w.dumps, f))).find((d) => d.env.TB_PLAN_CTX);
  await until(() => planner(), 30_000, 'the planner run');
  assert.deepEqual(json(planner().env.TB_PLAN_CTX).keep_ok, ['T1']);
});
