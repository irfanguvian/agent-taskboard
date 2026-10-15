'use strict';
// P5a (plan P5 AC1 AC2 AC4 AC5; contract rev 4.1 K1 K3 K4 K7 K12 K13 M1 M9 M12 M13 N3 N6, design §7 I1 I2 I4 I5 I7 I8 I10
// I13): a real tbd (harness temp HOME + TB_HOME, port 0) with the real code/planning + code/working handlers,
// test/fake-claude.js as claude_bin (exec steps make real commits in a temp git repo), scripted gates
// (test/helpers/fake-gates.js: lib/gates never loads). Verbs with no route yet (P5c) go through the preload's file RPC.
// Fixture phase dir: the real settings.json + result.schema.json, a stub prompt.md (P5d writes the real one). Kills only
// through run-spy (this test's own processes).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { startTbd, FAKE_GATES, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf, alive } = require('./helpers/runs');
// The daemon's own view, not ticket.json: store.save writes the file before its memory, so a disk read that sees
// plan_approval can run ahead of approve's check (409 under load: I13 + F2 RO2 flakes).
const inPlanApproval = (tbd, id) => until(async () => (await tbd.api('GET', `/api/tickets/${id}`)).json?.ticket?.state === 'plan_approval', 30_000, 'plan_approval');
const { GATE_PROMPT } = require('../lib/recovery');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'working-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working']) {
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
const SHA = 'c'.repeat(40); // a result's commit: the fake gates read the real HEAD
// GIT_OPTIONAL_LOCKS=0: a polling `git status` never takes index.lock (it made the fake gate's swap checkout fail under load)
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const journal = (tbd, id) => lines(tk(tbd, id, 'work.jsonl'));
const alerts = (tbd) => lines(path.join(tbd.tbHome, 'test-alerts.jsonl'));
const calls = (tbd) => lines(path.join(tbd.tbHome, 'fake-gates.jsonl'));
const gateFiles = (tbd, id) => (fs.existsSync(tk(tbd, id, 'gates')) ? fs.readdirSync(tk(tbd, id, 'gates')).length : 0); // gates/NN.json: one per gate run
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

function repo({ ignoreEnv = true, base = {} } = {}) { // base: {path: text} committed too
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(base)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), `node_modules/\n${ignoreEnv ? '.env.test\n' : ''}`);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env.test'), 'SECRET=1\n'); // Irfan's env file: in the dev checkout, never committed
  return dir;
}
const task = (id, over = {}) => ({ id, title: `task ${id}`, files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'preserve', test_cmd: 'npm test', steps: ['do it'], ...over });
const plan = (tasks, over = {}) => ({
  kind: 'plan', summary: 'users work', acceptance: [{ id: 'A1', text: 'users still work', type: 'preserve' }], tasks,
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['src/users.js: the users module'], decisions: [], ...over,
});
// fake-claude steps: a real commit in the worktree (cwd), then the result
const commit = (file, msg) => ({ exec: ['/bin/sh', '-c', `set -e; mkdir -p "$(dirname ${file})"; echo "${msg}" >> ${file}; git add ${file}; git -c user.name=t -c user.email=t@t commit -qm "${msg}"`] });
const result = (out) => ({ result: { structured_output: { commit: null, tests_added: [], notes: '', ...out } } });
const done = (file, msg) => ({ steps: [commit(file, msg), result({ status: 'done', commit: SHA })] });

// One ticket per tbd, approved for real (POST approve → setup → working). gates: the fake-gates script; sessions: the
// fake-claude scenarios by invocation. → tbd + its ticket id, worktree, base and helpers.
/** @param {any} t @param {any} o */
async function approved(t, { tasks, planOver = {}, gates = {}, sessions = [], tag = {}, env = {}, id = 't_work01', state = 'working', ignoreEnv = true, ticketOver = {}, extra = {}, baseFiles = {} }) {
  const dir = repo({ ignoreEnv, base: baseFiles });
  const base = git(dir, 'rev-parse', 'main');
  if (typeof sessions === 'function') sessions = sessions(base);
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, base);
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  sessions.forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const root = fs.mkdtempSync(path.join(ROOT, 'tbd-'));
  fs.mkdirSync(path.join(root, 'home', '.claude', 'skills', 'learning'), { recursive: true }); // a plan may name it (R1)
  fs.writeFileSync(path.join(root, 'home', '.claude', 'skills', 'learning', 'SKILL.md'), '---\nname: learning\n---\n');
  const p = plan(tasks, planOver);
  const files = {
    'config.json': CONFIG,
    'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', env_files: ['.env.test'], checks: { unit: 'npm test' }, ...tag } },
    [`tickets/${id}/ticket.json`]: ticket(id, { state: 'plan_approval', tag: 'acme/api', title: 'users work', base_sha: base, worktree: wt, round: 3,
      locked_decisions: [{ id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' }], ...ticketOver }), // D-0116: past round 1, so a replan may plan at once,
    ...Object.fromEntries(Object.entries(extra).map(([f, v]) => [`tickets/${id}/${f}`, v])),
    [`tickets/${id}/rounds/01-plan.json`]: p,
    [`fake-gates/${id}.json`]: gates,
  };
  const envAll = { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_DUMP_DIR: dumps, FAKE_CLAUDE_SCENARIO_DIR: scn, ...env };
  let tbd = await startTbd({ root, files, env: envAll });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  const k = () => read(tbd, id);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  if (state) await until(() => k().state === state || k().waiting?.reason === 'setup_failed', 30_000, `approve → ${state}`);
  let rpcN = 0;
  return {
    get tbd() { return tbd; }, id, wt, dir, base, plan: p, k, scn, root, envAll,
    // kill -9 tbd (its runs and gate processes live on), then a new tbd on the same HOME + TB_HOME
    async crash() {
      process.kill(Number(fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8')), 'SIGKILL');
      await tbd.stop({ keep: true });
      tbd = await startTbd({ root, env: envAll });
    },
    dumps: () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => json(path.join(dumps, f))),
    // a working verb inside tbd (fake-gates file RPC) → {ok, value} | {ok: false, status, error}
    /** @param {string} fn @param {...any} args */
    async rpc(fn, ...args) {
      const d = path.join(tbd.tbHome, 'test-rpc');
      fs.mkdirSync(d, { recursive: true });
      const n = ++rpcN;
      fs.writeFileSync(path.join(d, `${n}.tmp`), JSON.stringify({ fn, args: [id, ...args] }));
      fs.renameSync(path.join(d, `${n}.tmp`), path.join(d, `${n}.json`));
      const out = path.join(d, `${n}.out.json`);
      await until(() => fs.existsSync(out), 10_000, `rpc ${fn}`);
      return json(out);
    },
  };
}

test('I1 AC1 AC2 K13 RAM: a 10-task plan → one fresh session per task in order (lease.task, t:run task), each gated and accepted (pre = the last HEAD), the working gate → review; base checks seed unit_ms; ticket.json ≤ 16 KB; no lib/gates module loaded', async (t) => {
  const tasks = Array.from({ length: 10 }, (_, i) => task(`T${i + 1}`, i === 0 ? { type: 'new', acceptance: ['A1'] } : {}));
  const sessions = tasks.map((x) => done(`src/${x.id}.js`, x.id));
  const w = await approved(t, { tasks, sessions, planOver: { acceptance: [{ id: 'A1', text: 'users still work', type: 'new' }], allowed_api_changes: ['optional UserDto.cursor'] } });
  const { tbd, id, k } = w;
  assert.deepEqual(k().base_checks, { unit: { ok: true, ms: 4321 } }, 'N3: the base checks ran at approve');
  await until(() => k().state === 'review', 90_000, 'review');
  const p = k();
  // one fresh session per task, in plan order, each seeded with its own task (never --resume)
  const d = w.dumps();
  assert.equal(d.length, 10);
  d.forEach((x, i) => {
    assert.equal(x.opts['--resume'], undefined, `run ${i + 1} fresh`);
    assert.ok(x.prompt.includes(`## Your task: T${i + 1} (`), `run ${i + 1} seeded with T${i + 1}`);
  });
  assert.equal(new Set(d.map((x) => x.opts['--session-id'])).size, 10);
  // the seed's facts: the plan's allowed changes, the tag's gate facts, the later tasks (none for the last)
  assert.ok(d[0].prompt.includes('users work\nallowed schema changes: (none)\nallowed API changes: optional UserDto.cursor'), d[0].prompt);
  assert.ok(d[0].prompt.includes('\nacceptance: A1 (new): users still work\n'), 'acceptance with its type');
  assert.ok(d[0].prompt.includes(`later tasks (not yours: no work for them): ${tasks.slice(1).map((x) => `${x.id} ${x.title}`).join(', ')}`));
  assert.ok(d[9].prompt.includes('later tasks (not yours: no work for them): (none)'));
  assert.match(d[0].prompt, /## Gate\n\nchecks: unit = npm test\ntest files: .*\nprotected \(ask with NEEDS_SCOPE before changing\): package\.json, .*\ngenerated \(no scope needed\): \(none\)/);
  // K15 no Agent (disallowed), R1 no Skill without plan skills; M1 + D34 in the rendered settings
  assert.deepEqual([d[0].opts['--tools'], d[0].opts['--disallowedTools']], ['Read,Glob,Grep,Edit,Write,Bash', 'Agent']);
  const st = json(tk(tbd, id, 'runs', '1.settings.json'));
  for (const rule of [`Edit(/${w.wt}/node_modules/[a-zA-Z0-9@_-]*)`, `Edit(/${w.wt}/.env.test)`]) assert.ok(st.permissions.deny.includes(rule), rule);
  for (const p of [`${w.wt}/.env.test`, `${w.wt}/node_modules/.bin`, `${w.wt}/node_modules/[a-zA-Z0-9@_-]*`]) assert.ok(st.sandbox.filesystem.denyWrite.includes(p), p);
  assert.deepEqual(st.attribution, { commit: '', pr: '' });
  const runs = lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'run' && m.ticket === id);
  assert.deepEqual(runs.map((m) => m.task), tasks.map((x) => x.id), 'lease.task per run (t:run)');
  // every task done at its own commit, each next one starting from it (pre = the last HEAD)
  const log = git(w.wt, 'log', '--format=%H %s', `${w.base}..HEAD`).split('\n').reverse();
  assert.deepEqual(p.work.tasks.map((x) => [x.id, x.status, x.head]), log.map((l, i) => [`T${i + 1}`, 'done', l.split(' ')[0]]));
  assert.deepEqual(p.work.tasks.slice(1).map((x) => x.pre), log.slice(0, -1).map((l) => l.split(' ')[0]));
  assert.equal(p.work.tasks[0].pre, w.base);
  assert.equal(p.work.unit_ms, 1234, 'K13: unit_ms from the last gate (seeded from base_checks)');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok]), [...tasks.map(() => ['task', true]), ['working', true]]);
  assert.ok(fs.statSync(tk(tbd, id, 'ticket.json')).size <= 16 * 1024, `ticket.json ${fs.statSync(tk(tbd, id, 'ticket.json')).size} B`);
  const c = calls(tbd);
  assert.ok(c.length >= 12 && c.every((x) => x.gates_loaded === false), 'RAM: no lib/gates module in require.cache, before or after the first gate');
});

test('I2 N6 modes: red 1 → the same session resumed with the gate\'s why; red 2 → the attempt kept as refs/tb/<id>/T1-a2, tree reset to pre, a fresh session told what failed; red 3 → Blocked (work), an alert', async (t) => {
  const seen = path.join(ROOT, `run3-head-${process.pid}`);
  const sessions = [done('src/a.js', 'one'), done('src/a.js', 'two'),
    { steps: [{ exec: ['/bin/sh', '-c', `git rev-parse HEAD > ${seen}; ls src > ${seen}.ls`] }, commit('src/a.js', 'three'), result({ status: 'done', commit: SHA })] }];
  const red = (why) => ({ ok: false, class: 'work', why });
  const w = await approved(t, { tasks: [task('T1')], sessions, gates: { task: [red('unit: 1 failing (one)'), red('unit: 1 failing (two)'), red('unit: 1 failing (three)')] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'blocked', 60_000, 'blocked');
  const [d1, d2, d3] = w.dumps();
  assert.equal(d2.opts['--resume'], d1.opts['--session-id'], 'red 1: the same session, resumed');
  assert.ok(d2.prompt.startsWith(`${GATE_PROMPT}\n\nunit: 1 failing (one)`), d2.prompt);
  assert.equal(d3.opts['--resume'], undefined, 'red 2: a fresh session');
  assert.notEqual(d3.opts['--session-id'], d1.opts['--session-id']);
  assert.ok(d3.prompt.includes('## What the gate found on the last attempt (the tree is back at pre)\n\nunit: 1 failing (two)'), d3.prompt);
  // the fresh session started at pre (base), the discarded attempt kept by ref
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), w.base);
  assert.equal(fs.readFileSync(`${seen}.ls`, 'utf8').trim(), 'users.js', 'src/a.js of attempts 1-2 gone');
  const a2 = git(w.wt, 'rev-parse', `refs/tb/${id}/T1-a2`);
  assert.deepEqual(git(w.wt, 'log', '--format=%s', `${w.base}..${a2}`).split('\n'), ['two', 'one']);
  const p = k();
  assert.deepEqual([p.blocked_from, p.waiting.reason, p.work.tries, p.work.tasks[0].status, p.work.tasks[0].attempt], ['working', 'work', 2, 'red', 3]);
  assert.match(p.waiting.why, /^red 3 times: unit: 1 failing \(three\)/);
  await until(() => alerts(tbd).some((a) => a.title === 'Blocked: work'), 5000, 'alert');
});

test('N6 continue + M12: NEEDS_CONTEXT → clarify (why, class); tb answer → the same session goes on with the answer, uncommitted work kept, an intervention; answer outside clarify / empty / tb scope on it → refused', async (t) => {
  const kept = path.join(ROOT, `kept-${process.pid}`);
  const sessions = [
    { steps: [{ exec: ['/bin/sh', '-c', 'echo wip > wip.txt'] }, result({ status: 'NEEDS_CONTEXT', question: 'Page size 20 or 50?' })] },
    // M1 (O7): the agent edits the env file; the gate must see the tag's own copy again
    { steps: [{ exec: ['/bin/sh', '-c', `cp wip.txt ${kept}; rm wip.txt; echo HACKED > .env.test`] }, commit('src/a.js', 'paged'), result({ status: 'done', commit: SHA })] },
  ];
  const rules = path.join(ROOT, `rules-${process.pid}.md`);
  fs.writeFileSync(rules, 'Never use offset paging.\n');
  const L1 = { id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' };
  const w = await approved(t, { tasks: [task('T1')], sessions, planOver: { skills: ['learning'] }, tag: { rules: [rules] },
    ticketOver: { locked_decisions: [L1], reject_comment: 'keep GET /users/all' }, extra: { 'decisions.json': [L1, { id: 'D1', text: 'cursor in a header', source: 'planner' }] } });
  const { tbd, id, k } = w;
  fs.writeFileSync(rules, 'changed after approve\n'); // T1: the approve-time snapshot is what agents get
  assert.deepEqual((await w.rpc('answer', { text: '50' })).status, 409, 'not in clarify yet');
  await until(() => k().state === 'clarify', 30_000, 'clarify');
  assert.deepEqual(k().clarify_origin, { phase: 'working', task: 'T1', why: 'Page size 20 or 50?', class: 'NEEDS_CONTEXT' });
  assert.deepEqual([(await w.rpc('answer', { text: '  ' })).status, (await w.rpc('scope', { allow: true })).status, (await w.rpc('answer', { text: '50' }, 'web')).status], [400, 409, 400]);
  assert.equal(k().state, 'clarify');
  assert.equal((await w.rpc('answer', { text: '50' })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  const [d1, d2] = w.dumps();
  assert.equal(d1.opts['--tools'], 'Read,Glob,Grep,Edit,Write,Bash,Skill', 'R1: the plan names a skill → Skill allowed');
  assert.ok(d1.prompt.includes("## Irfan's rules\n\nNever use offset paging.\n") && !d1.prompt.includes(rules), 'T1: the text, never the path');
  assert.ok(d1.prompt.includes("## Decisions\n\n- R1Q1 [locked: Irfan]: Page size? → 50\n- D1: cursor in a header\nIrfan's last comment on the plan: keep GET /users/all"), d1.prompt);
  assert.equal(k().rules_sha, crypto.createHash('sha256').update('Never use offset paging.\n').digest('hex'));
  assert.equal(d2.opts['--resume'], d1.opts['--session-id'], 'continue: the same session');
  assert.equal(d2.prompt, 'Irfan answered:\n\n50\n\nGo on with the task with this in mind.');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'wip\n', 'continue: no reset, the uncommitted file was still there');
  assert.equal(fs.readFileSync(path.join(w.wt, '.env.test'), 'utf8'), 'SECRET=1\n', 'M1: env file copied again before the gate (it went green)');
  const iv = lines(tk(tbd, id, 'interventions.jsonl'));
  assert.deepEqual(iv.map((l) => [l.actor, l.verb, l.task, l.payload_sha256]), [['cli', 'answer', 'T1', crypto.createHash('sha256').update(JSON.stringify({ text: '50' })).digest('hex')]]);
  assert.equal(k().interventions, 1);
  assert.equal(k().clarify_origin, undefined);
});

test('I4 M1: a dirty tree after done → resumed once ("commit them or revert them"), the gate never asked; dirty again → Blocked; a link planted in node_modules/.bin → Blocked integrity', async (t) => {
  const dirty = (msg) => ({ steps: [commit('src/a.js', msg), { exec: ['/bin/sh', '-c', 'echo x > junk.txt'] }, result({ status: 'done', commit: SHA })] });
  const w = await approved(t, { tasks: [task('T1')], sessions: [dirty('one'), dirty('two')] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'blocked', 30_000, 'blocked');
  const [, d2] = w.dumps();
  assert.match(d2.prompt, /^The gate checked .*\n\nuncommitted changes: \?\? junk\.txt: commit them or revert them, then return the result again/);
  assert.match(k().waiting.why, /^uncommitted changes again: /);
  assert.equal(gateFiles(tbd, id), 0, 'the clean check comes before any gate');
  assert.equal(journal(tbd, id).filter((l) => l.t === 'gate').length, 2);

  // M1 tripwire: a link planted in node_modules/.bin (ignored: the tree stays clean) → the gate is told → Blocked integrity
  const plant = { steps: [commit('src/a.js', 'one'), { exec: ['/bin/sh', '-c', 'mkdir -p node_modules/.bin && ln -s /bin/sh node_modules/.bin/jest'] }, result({ status: 'done', commit: SHA })] };
  const m = await approved(t, { id: 't_trip01', tasks: [task('T1')], sessions: [plant] });
  await until(() => m.k().state === 'blocked', 30_000, 'blocked');
  assert.deepEqual([m.k().waiting.reason, m.k().waiting.why], ['integrity', 'integrity: node_modules/.bin links changed since setup']);
});

// M5.2 C8 Q7 (D-0088, D-0097). D-0101 (contract change; was: an md / png left uncommitted in the docs dirs was skipped):
// every untracked file there is an "uncommitted change" (I4 above). M5.3 G8 (contract change; was: an md / png there is
// dirty too): a plain md / png under a docs dir (docs.dropDocs: what a QA visit without a result leaves) is not dirty, the
// gate's cleanTree removes it before any check; any other file there, a link named x.md too, stays dirty
test('M5 C8 G8 dirty check: a .d.ts and a link named x.md left in docs/verification are dirty (resumed, each named), the md / png docs beside them are not; the two removed → the gate runs with the docs still there, on to review', async (t) => {
  const docs = { exec: ['/bin/sh', '-c', 'mkdir -p docs/verification/screenshots docs/verdicts && echo r > docs/verification/a.md && echo p > docs/verification/screenshots/a.png && echo v > docs/verdicts/b.md && echo x > docs/verification/x.d.ts && ln -s ../../src docs/verification/link.md'] };
  const tidy = { exec: ['/bin/sh', '-c', 'rm docs/verification/x.d.ts docs/verification/link.md'] };
  const sessions = [{ steps: [commit('src/a.js', 'one'), docs, result({ status: 'done', commit: SHA })] }, { steps: [tidy, result({ status: 'done', commit: SHA })] }];
  const w = await approved(t, { id: 't_docs01', tasks: [task('T1')], sessions });
  await until(() => w.k().state === 'review', 30_000, 'review');
  const [, d2] = w.dumps();
  assert.match(d2.prompt, /\n\nuncommitted changes: \?\? docs\/verification\/link\.md, \?\? docs\/verification\/x\.d\.ts: commit them or revert them/);
  assert.equal(w.dumps().length, 2, 'resumed once, then the docs alone are no dirty tree');
  assert.ok(gateFiles(w.tbd, w.id) >= 1, 'the gate ran');
  assert.ok(fs.existsSync(path.join(w.wt, 'docs', 'verdicts', 'b.md')), 'the docs were there when the (fake) gate ran: not called dirty');
});

// M5.3 (D-0101 F1 kept closed): G8 skips untracked docs only. cleanTree keeps a tracked file's edit, so an uncommitted
// edit of a tracked md (a test may require it) is dirty like any tracked change
test('M5 C8 G8 negative: a tracked docs/verification/old.md edited and left uncommitted → dirty, named, resumed; reverted → the gate runs', async (t) => {
  const edit = { exec: ['/bin/sh', '-c', 'echo "module.exports = 1" >> docs/verification/old.md'] };
  const revert = { exec: ['/bin/sh', '-c', 'git checkout -q -- docs/verification/old.md'] };
  const sessions = [{ steps: [commit('src/a.js', 'one'), edit, result({ status: 'done', commit: SHA })] }, { steps: [revert, result({ status: 'done', commit: SHA })] }];
  const w = await approved(t, { id: 't_docs02', tasks: [task('T1')], sessions, baseFiles: { 'docs/verification/old.md': '# old report\n' } });
  await until(() => w.k().state === 'review', 30_000, 'review');
  const [, d2] = w.dumps();
  assert.match(d2.prompt, /\n\nuncommitted changes: {2}M docs\/verification\/old\.md: commit them or revert them/);
  assert.equal(w.dumps().length, 2, 'resumed once, then clean');
});

test('I5 K3 RO6: NEEDS_SCOPE → clarify; tb scope --allow (UI ok for scope) → same session, the file allowed for T1; a protected ask from the gate: UI allow → 401, CLI allow binds the blob at HEAD → gate green; the other path: --deny, the same files asked again → Blocked', async (t) => {
  const ask = result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['lib/extra.js'], reason: 'a helper' } });
  const w = await approved(t, {
    tasks: [task('T1')],
    sessions: [{ steps: [ask] }, done('lib/extra.js', 'helper'), { steps: [result({ status: 'done', commit: SHA })] }],
    gates: { task: [{ allow: ['lib/extra.js'], ok: false, class: 'protected', ask: { kind: 'protected', files: ['package.json'], reason: 'package.json changed' }, why: 'protected: package.json' }, { allow: ['lib/extra.js'] }] },
  });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'scope ask');
  assert.equal(k().clarify_origin.class, 'scope');
  assert.equal((await w.rpc('scope', { allow: true }, 'ui')).ok, true);
  await until(() => k().state === 'clarify' && k().clarify_origin.class === 'protected', 30_000, 'protected ask');
  assert.equal(w.dumps()[1].opts['--resume'], w.dumps()[0].opts['--session-id']);
  assert.equal(w.dumps()[1].prompt, 'Irfan allowed these files for this task: lib/extra.js. Go on with the task.');
  const ui = await w.rpc('scope', { allow: true }, 'ui');
  assert.deepEqual([ui.status, ui.error], [401, `${id}: allowing a protected change needs the CLI (tb scope --allow)`]);
  assert.equal((await w.rpc('scope', { allow: true }, 'cli')).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual(json(tk(tbd, id, 'scope.json')).allow.T1, [{ path: 'lib/extra.js' }, { path: 'package.json', blob: git(w.wt, 'rev-parse', 'HEAD:package.json') }]);
  assert.deepEqual(k().work.scope, { T1: 2 }, 'F5: ticket.json keeps the count only');
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => [l.actor, l.verb]), [['ui', 'scope-allow'], ['cli', 'scope-allow']]);
  assert.equal(k().interventions, 2);

  const d = await approved(t, { id: 't_deny01', tasks: [task('T1')], sessions: [{ steps: [ask] }, { steps: [ask] }] });
  await until(() => d.k().state === 'clarify', 30_000, 'ask');
  assert.equal((await d.rpc('scope', { allow: false }, 'ui')).ok, true);
  await until(() => d.k().state === 'blocked', 30_000, 'blocked');
  assert.equal(d.dumps()[1].prompt, "Irfan denied these files: lib/extra.js. Stay inside the task's scope; if the task cannot be done without them, return NEEDS_CONTEXT.");
  assert.deepEqual([json(tk(d.tbd, 't_deny01', 'scope.json')).denied, d.k().work.denied], [{ T1: ['lib/extra.js'] }, { T1: 1 }]);
  assert.deepEqual(journal(d.tbd, 't_deny01').filter((l) => l.t === 'blocked').map((l) => l.why), ['T1 asked again for files Irfan denied: lib/extra.js']);
});

test('I7 K7 M11 decide side: a vacuous fail-first (tests pass at pre) is red → resumed; unproven_compile, proven_missing (as proven) + a flaky check are green → accepted, listed for review', async (t) => {
  const w = await approved(t, {
    tasks: [task('T1', { type: 'new' }), task('T2')], planOver: { acceptance: [{ id: 'A1', text: 'users still work', type: 'new' }] },
    sessions: [done('test/a.test.js', 'one'), done('src/a.js', 'two'), done('src/b.js', 'three')],
    gates: { task: [
      { ok: false, class: 'work', tests: { failfirst: 'vacuous', files: ['test/a.test.js'], skips_added: [], deleted: [], expects_removed: [], count: { pre: 0, head: 1 } }, why: 'fail-first: the new tests pass at pre (vacuous)' },
      { tests: { failfirst: 'unproven_compile', files: ['test/a.test.js'], skips_added: [], deleted: [], expects_removed: [], count: { pre: 0, head: 1 } } },
      { checks: [{ check: 'unit', ok: true, exit: 0, timed_out: false, ms: 900, flaky: true, log: null, tail: '' }], tests: { failfirst: 'proven_missing', files: [], skips_added: [], deleted: [], expects_removed: [], count: { pre: 0, head: 0 } } },
    ] },
  });
  const { tbd, id, k } = w;
  await until(() => k().state === 'review', 45_000, 'review');
  const d = w.dumps();
  assert.equal(d[1].opts['--resume'], d[0].opts['--session-id'], 'vacuous: red, resumed');
  assert.match(d[1].prompt, /fail-first: the new tests pass at pre \(vacuous\)/);
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'review').map((l) => [l.task, l.failfirst, l.flaky]), [['T1', 'unproven_compile', []], ['T2', 'proven_missing', ['unit']]]);
  assert.deepEqual(k().work.tasks.map((x) => x.status), ['done', 'done']);
});

test('I8 K7 crash: tbd killed -9 mid fail-first swap → the next tbd kills the orphaned gate process (pid + lstart), restores the tree to HEAD, runs the gate again: the task accepted exactly once; the boot marker check loads no lib/gates', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/users.js', 'changed')], gates: { task: [{ swap: 'src/users.js', sleep_ms: 60_000 }] } });
  const { id } = w;
  await until(() => w.k().work?.gate?.swap?.lstart, 30_000, 'swap marker');
  const { swap } = w.k().work.gate;
  await until(() => git(w.wt, 'status', '--porcelain') === 'M  src/users.js', 5000, 'mid-swap: the source back at pre (index + tree)'); // marker first, then the swap
  await w.crash();
  await until(() => w.k().state === 'review', 30_000, 'review after the restart');
  assert.equal(alive(swap.pid), false, 'the orphaned gate process was killed');
  assert.deepEqual([git(w.wt, 'status', '--porcelain'), git(w.wt, 'rev-parse', 'HEAD')], ['', swap.head], 'tree == head');
  assert.deepEqual(journal(w.tbd, id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok]), [['task', true], ['working', true]], 'accepted once (the killed gate wrote nothing)');
  assert.equal(w.k().work.tasks[0].status, 'done');
  assert.ok(calls(w.tbd).every((x) => x.gates_loaded === false), 'RAM: no lib/gates in require.cache after the boot marker check');
});

test('K12 memory: critical pressure aborts the running gate (reason memory, before its kill) → interrupted, no try used, no gate starts while critical (waiting memory); pressure back → the gate runs again → accepted', async (t) => {
  // the gate misses the abort and answers green after 3 s: tbd's own signal check (K12 backstop) still calls it interrupted
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one')], gates: { task: [{ sleep_ms: 3000, ignore_abort: true }, {}] } });
  const { tbd, id, k } = w;
  await until(() => calls(tbd).some((c) => c.fn === 'task'), 30_000, 'gate running');
  const pressure = path.join(tbd.tbHome, 'test-pressure');
  fs.writeFileSync(pressure, 'critical');
  await until(() => journal(tbd, id).some((l) => l.t === 'gate'), 30_000, 'gate interrupted');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => [l.class, l.do]), [['interrupted', 'gate']]);
  await until(() => k().waiting?.reason === 'memory', 10_000, 'waiting memory');
  assert.deepEqual([k().work.tries, k().work.tasks[0].status, k().work.gate.ok], [0, 'gating', undefined], 'no try used; the gate pending again');
  assert.equal(gateFiles(tbd, id), 1, 'no gate started while critical');
  fs.rmSync(pressure);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.equal(w.dumps().length, 1, 'no session spent on the interruption');
  assert.deepEqual(k().work.tries, 0);
});

test('M13 CAS gen: a Restart while the task gate runs → a fresh session; the old gate\'s green result (stale lease gen) is dropped, the new session\'s gate decides', async (t) => {
  const slow = { steps: [{ sleep_ms: 5000 }, commit('src/b.js', 'two'), result({ status: 'done', commit: SHA })] };
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one'), slow], gates: { task: [{ sleep_ms: 1500 }, {}] } });
  const { tbd, id, k } = w;
  await until(() => calls(tbd).some((c) => c.fn === 'task'), 30_000, 'gate running');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/restart`)).status, 202);
  await until(() => k().state === 'review', 45_000, 'review');
  assert.equal(w.dumps()[1].opts['--resume'], undefined, 'restart: a fresh session');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok, l.n]), [['task', true, 2], ['working', true, 3]], 'gate 1 (stale) left no line');
  assert.equal(k().work.tasks[0].head, git(w.wt, 'rev-parse', 'HEAD'));
});

test('M13 stale gen: a Restart while the task gate runs → the new session asks (NEEDS_CONTEXT): the gate left pending under the old lease gen is cleared → tb answer → the same session goes on, one gate after it (never a stale loop) → review', async (t) => {
  const ask = { steps: [result({ status: 'NEEDS_CONTEXT', question: 'which way?' })] };
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one'), ask, done('src/b.js', 'two')], gates: { task: [{ sleep_ms: 60_000 }] } });
  const { tbd, id, k } = w;
  await until(() => calls(tbd).some((c) => c.fn === 'task'), 30_000, 'gate running');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/restart`)).status, 202);
  await until(() => k().state === 'clarify', 30_000, 'the restarted session asks');
  assert.equal(k().work.gate, null, 'no gate pending from the old gen');
  assert.equal((await w.rpc('answer', { text: 'this way' })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.equal(w.dumps()[2].opts['--resume'], w.dumps()[1].opts['--session-id'], 'continue: the same session');
  assert.equal(calls(tbd).filter((c) => c.fn === 'task').length, 2, 'the halted gate, then one after the answer');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok]), [['task', true], ['working', true]]);
});

test('I10 K1: tb rework from review (unbuilt) → feedback-<n>.md, a fresh @rw<n> session seeded with it, its gate then the working gate → review; a 3rd rework → Blocked; Resume → the working gate again, rework 0. Refused: outside review, empty, too big, a file path', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one'), done('docs/a.md', 'rw one'), done('docs/b.md', 'rw two'), done('docs/c.md', 'rw three')] });
  const { tbd, id, k } = w;
  assert.equal((await w.rpc('rework', { feedback: 'too early' })).status, 409, 'not in review yet');
  await until(() => k().state === 'review', 30_000, 'review');
  for (const [body, status] of /** @type {any[]} */ ([[{ feedback: ' ' }, 400], [{ feedback: 'x'.repeat(64 * 1024 + 1) }, 400], [{ feedback_file: '/etc/hosts' }, 400], [{ feedback: 'ok' }, 400, 'web']])) {
    assert.equal((await w.rpc('rework', body, ...(body.feedback === 'ok' ? ['web'] : []))).status, status, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await w.rpc('rework', { feedback: 'add the docs please' })).ok, true);
  assert.deepEqual([k().state, k().rework, k().work.task], ['working', 1, '@rw1']);
  assert.equal(fs.readFileSync(tk(tbd, id, 'feedback-1.md'), 'utf8'), 'add the docs please\n');
  await until(() => k().state === 'review', 30_000, 'review after rework 1');
  const d2 = w.dumps()[1];
  assert.equal(d2.opts['--resume'], undefined);
  assert.ok(d2.prompt.includes('## Your task: @rw1 (preserve)') && d2.prompt.includes("## Irfan's rework feedback\n\nadd the docs please\n"), d2.prompt);
  assert.equal((await w.rpc('rework', { feedback: 'and the changelog' })).ok, true);
  await until(() => k().state === 'review' && k().rework === 2, 30_000, 'review after rework 2');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => `${l.kind}:${l.task ?? '-'}`), ['task:T1', 'working:-', 'task:@rw1', 'working:-', 'task:@rw2', 'working:-']);
  assert.equal((await w.rpc('rework', { feedback: 'once more' })).ok, true);
  assert.deepEqual([k().state, k().blocked_from, k().rework, k().waiting.reason], ['blocked', 'review', 2, 'rework']);
  assert.equal(fs.existsSync(tk(tbd, id, 'feedback-3.md')), false);
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => [l.verb, l.task]), [['rework', '@rw1'], ['rework', '@rw2'], ['rework', null]]);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/resume`, { phase: 'working' })).status, 202);
  await until(() => k().state === 'review', 30_000, 'resume → working gate → review');
  assert.equal(k().rework, 0);
  assert.equal(w.dumps().length, 3, 'resume re-ran the gate: no session');
  // the file/task number never resets with rework: the next one after the Resume writes feedback-3.md, never over 1
  assert.equal((await w.rpc('rework', { feedback: 'one more thing' })).ok, true);
  assert.deepEqual([k().rework, k().work.task, fs.readFileSync(tk(tbd, id, 'feedback-1.md'), 'utf8'), fs.readFileSync(tk(tbd, id, 'feedback-3.md'), 'utf8')],
    [1, '@rw3', 'add the docs please\n', 'one more thing\n']);
  await until(() => k().state === 'review', 30_000, 'review after rework 3');
  // D9: once passed (pr.merged_at), never reworked
  const r = await w.rpc('merged', '2026-10-10T00:00:00Z');
  assert.equal(r.ok, true);
  const no = await w.rpc('rework', { feedback: 'late' });
  assert.deepEqual([no.status, /passed already .*rework is closed/.test(no.error)], [409, true], no.error);
});

test('I13 K4+C2: --replan → planning (seed ## Replan) → keep naming an undone task refused, then keep [T1] → re-approve: dirty tree (untracked too) on replan-1-wip, old HEAD on replan-1, reset to T1, cleaned; T1 copied from the old plan; plan rules at the branch HEAD; T2 runs fresh from T1', async (t) => {
  const seen = path.join(ROOT, `replan-${process.pid}`);
  const T2 = task('T2', { title: 'second', files: ['lib2/a.js'], modules: ['lib2'] });
  const replanned = (keep) => ({ result: { structured_output: plan([task('T1', { title: 'IGNORED copy' }), T2], { keep }) } });
  const sessions = [
    done('lib2/a.js', 'T1'),
    { steps: [commit('src/b.js', 'T2 old'), { exec: ['/bin/sh', '-c', 'echo notes > notes.txt'] }, result({ status: 'NEEDS_CONTEXT', question: 'Split users?' })] },
    { steps: [replanned(['T2'])] }, { steps: [replanned(['T1'])] },
    { steps: [{ exec: ['/bin/sh', '-c', `git rev-parse HEAD > ${seen}; ls > ${seen}.ls`] }, commit('lib2/a.js', 'T2 new'), result({ status: 'done', commit: SHA })] },
  ];
  // the env file is not git-ignored here: M1 keeps it out of the dirty check and K4 out of the snapshot (a secret)
  const marker = path.join(ROOT, `i13-setup-${process.pid}`);
  const w = await approved(t, { tasks: [task('T1', { files: ['lib2/a.js'] }), task('T2')], sessions, ignoreEnv: false, tag: { setup: `echo run >> ${marker}` } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'clarify');
  const t1 = k().work.tasks[0].head;
  const oldHead = git(w.wt, 'rev-parse', 'HEAD');
  const oldHash = k().plan_hash;
  assert.equal((await w.rpc('answer', { replan: true })).ok, true);
  await inPlanApproval(tbd, id);
  const [, , p1, p2] = w.dumps();
  assert.match(p1.prompt, /## Replan\n\nWork stopped at T2: Split users\?\.\nDone so far:\n- T1 \([0-9a-f]{12}\): task T1 \| files: lib2\/a\.js \| test_cmd: npm test \| acceptance: A1 \(preserve\): users still work\n/);
  assert.match(p2.prompt, /keep\[0\] "T2": not done/);
  assert.deepEqual([json(p1.env.TB_PLAN_CTX).at, json(p1.env.TB_PLAN_CTX).keep_ok], [oldHead, ['T1']], 'plan rules at the branch HEAD (lib2/ exists only there); keep_ok = the done prefix');
  // earlier allows / denies (scope.json): the kept T1's stay, the replaced T2's go (the new T2 reuses the id)
  fs.writeFileSync(tk(tbd, id, 'scope.json'), JSON.stringify({ allow: { T1: [{ path: 'package.json', blob: 'a'.repeat(40) }], T2: [{ path: 'lib/z.js' }] }, denied: { T2: ['x.js'] } }));
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => k().state === 'review', 45_000, 'review');
  assert.deepEqual([json(tk(tbd, id, 'scope.json')), k().work.scope, k().work.denied], [{ allow: { T1: [{ path: 'package.json', blob: 'a'.repeat(40) }] }, denied: {} }, { T1: 1 }, {}]);
  // RO2: T1's lockfile (none) = what node_modules was built from + tripwire unchanged → no setup at all on the replan
  assert.deepEqual([fs.readFileSync(marker, 'utf8'), calls(tbd).filter((c) => c.fn === 'deps').length, k().work.deps_blob], ['run\n', 0, 'none']);
  assert.equal(git(w.wt, 'rev-parse', `refs/tb/${id}/replan-1`), oldHead);
  const wip = `refs/tb/${id}/replan-1-wip`;
  assert.equal(git(w.wt, 'show', `${wip}:notes.txt`), 'notes', 'untracked file saved');
  assert.equal(git(w.wt, 'rev-parse', `${wip}^`), oldHead);
  assert.throws(() => git(w.wt, 'cat-file', '-e', `${wip}:.env.test`), 'env files stay out of the snapshot');
  assert.equal(git(w.wt, 'status', '--porcelain'), '?? .env.test', 'only the env file, copied again');
  assert.deepEqual([fs.readFileSync(seen, 'utf8').trim(), fs.readFileSync(`${seen}.ls`, 'utf8').split('\n').filter(Boolean)], [t1, ['lib2', 'package.json', 'src']], 'T2 starts at T1, cleaned (notes.txt gone)');
  const p = k();
  assert.deepEqual(json(tk(tbd, id, p.plan_file)).tasks[0], task('T1', { files: ['lib2/a.js'] }), 'T1 copied from the old plan');
  assert.deepEqual([p.plan_hashes.length, p.plan_hashes[0], p.plan_hash === oldHash], [2, oldHash, false]);
  assert.deepEqual(p.work.tasks.map((x) => [x.id, x.status, x.pre]), [['T1', 'done', w.base], ['T2', 'done', t1]]);
  assert.equal(p.clarify_origin, undefined);
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => l.verb), ['replan']);
});

const POLICY = { ok: false, class: 'policy', ask: { kind: 'policy', changes: ['drop User.nickname'], reason: 'a schema change the plan does not allow' }, schema: [{ op: 'drop', ref: 'User.nickname', allowed: false }], why: 'policy: drop User.nickname' };

test('M9 N8: a policy red of the working gate → clarify alone; --allow-change of a change it did not name → 409 (tb scope, answer too); allow-change → immutable plan-<hash>.json + plan_hash + plan_hashes in one write, the gate runs again (no session) → review', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one')], gates: { working: [POLICY, {}] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'policy clarify');
  assert.deepEqual(k().clarify_origin, { phase: 'working', task: null, why: POLICY.ask.reason, class: 'policy' });
  const before = k().plan_hash;
  for (const [fn, body] of /** @type {[string, any][]} */ ([['allowChange', { change: 'drop User.email' }], ['scope', { allow: true }], ['answer', { text: 'fine' }], ['denyChange', { change: 'remove GET /x' }]])) {
    assert.equal((await w.rpc(fn, body)).status, 409, fn);
  }
  assert.equal((await w.rpc('allowChange', { change: 'drop User.nickname' })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  const p = k();
  assert.deepEqual([p.plan_hashes[0], p.plan_hashes.length, p.plan_hash !== before, p.plan_file], [before, 2, true, `plan-${p.plan_hash}.json`]);
  const frozen = json(tk(tbd, id, p.plan_file));
  assert.deepEqual(frozen.allowed_schema_changes, ['drop User.nickname']);
  assert.equal(crypto.createHash('sha256').update(canon(frozen)).digest('hex'), p.plan_hash);
  assert.deepEqual(json(tk(tbd, id, `plan-${before}.json`)).allowed_schema_changes, [], 'the old plan file is untouched');
  assert.equal(w.dumps().length, 1, 'no planner, no session');
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => l.verb), ['allow-change']);
});

test('M9: --deny-change → an @fix session from HEAD (no reset) told to revert it; its gate is the working gate → review', async (t) => {
  const seen = path.join(ROOT, `deny-${process.pid}`);
  const fix = { steps: [{ exec: ['/bin/sh', '-c', `git rev-parse HEAD > ${seen}`] }, commit('src/a.js', 'revert'), result({ status: 'done', commit: SHA })] };
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/a.js', 'one'), fix], gates: { working: [POLICY, {}] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'policy clarify');
  assert.equal((await w.rpc('denyChange', { change: 'drop User.nickname' })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  const d = w.dumps()[1];
  assert.equal(d.opts['--resume'], undefined);
  assert.ok(d.prompt.includes('## Your task: @fix (preserve)') && d.prompt.includes('## What to do\n\nRevert this change: drop User.nickname. Reach the goal without it, or return NEEDS_CONTEXT.'), d.prompt);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), k().work.tasks[0].head, '@fix starts from HEAD');
  assert.deepEqual(k().work.tasks.map((x) => [x.id, x.status]), [['T1', 'done'], ['@fix', 'done']]);
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'gate').map((l) => `${l.kind}:${l.ok}`), ['task:true', 'working:false', 'working:true']);
});

test('N3 T1: a red base check or OpenAPI base capture at approve → setup_failed "base red: <check>" (the ticket stays in plan_approval); tag rules over 8 KB → setup_failed', async (t) => {
  const a = await approved(t, { tasks: [task('T1')], state: null, gates: { base: [{ ok: false, checks: { unit: { ok: false, ms: 10 } }, why: '2 failing' }] } });
  await until(() => a.k().waiting?.reason === 'setup_failed', 30_000, 'setup_failed');
  assert.deepEqual([a.k().state, a.k().waiting.error, a.k().work], ['plan_approval', 'base red: unit: 2 failing', undefined]);
  const b = await approved(t, { id: 't_work02', tasks: [task('T1')], state: null, tag: { checks: undefined, openapi: { cmd: 'npm run openapi', file: 'openapi.json' } }, gates: { openapi: [{ ok: false, why: 'nest build failed' }] } });
  await until(() => b.k().waiting?.reason === 'setup_failed', 30_000, 'setup_failed');
  assert.deepEqual([b.k().state, b.k().waiting.error], ['plan_approval', 'base red: openapi: nest build failed']);
  const big = path.join(ROOT, `big-rules-${process.pid}.md`);
  fs.writeFileSync(big, 'r'.repeat(9000));
  const c = await approved(t, { id: 't_work03', tasks: [task('T1')], state: null, tag: { rules: [big] } });
  await until(() => c.k().waiting?.reason === 'setup_failed', 30_000, 'setup_failed');
  assert.match(c.k().waiting.error, /^tag rules are 9001 bytes, over 8192: shorten them \(never cut\)/, 'T1: refused, never truncated');
});

test('plan_hash: the frozen plan changed under a working ticket → its gate never runs: Blocked (config) + an alert; a no-op done on a new task → clarify', async (t) => {
  const tasks = [task('T1')];
  const hash = crypto.createHash('sha256').update(canon(plan(tasks))).digest('hex');
  const w = await approved(t, { tasks, sessions: [{ steps: [{ sleep_ms: 2000 }, result({ status: 'done', commit: SHA })] }] });
  fs.writeFileSync(tk(w.tbd, w.id, `plan-${hash}.json`), JSON.stringify({ ...plan(tasks), allowed_schema_changes: ['drop User.x'] }));
  await until(() => w.k().state === 'blocked', 30_000, 'blocked');
  assert.deepEqual([w.k().waiting.reason, gateFiles(w.tbd, w.id)], ['config', 0]);
  assert.match(w.k().waiting.why, /^config: the frozen plan plan-[0-9a-f]{64}\.json does not match plan_hash/);
  await until(() => alerts(w.tbd).some((a) => a.title === 'Blocked: config'), 5000, 'alert');

  const n = await approved(t, { id: 't_noop01', tasks: [task('T1', { type: 'new' })], planOver: { acceptance: [{ id: 'A1', text: 'x', type: 'new' }] }, sessions: (base) => [{ steps: [result({ status: 'done', commit: base })] }] });
  await until(() => n.k().state === 'clarify', 30_000, 'clarify');
  assert.equal(n.k().clarify_origin.class, 'noop');
  assert.match(n.k().clarify_origin.why, /^T1 returned done without a commit/);
});

test('n12 live migration: a ticket that reached working before P5 (no work cursor, no base checks, no tripwire) → work from its frozen plan (pre = HEAD), the base gate first, then its task → review', async (t) => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '-b', 'tb/t_old001-x', wt, base);
  const p = plan([task('T1')]);
  const hash = crypto.createHash('sha256').update(canon(p)).digest('hex');
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify(done('src/a.js', 'one')));
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: {
      'config.json': CONFIG, 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', checks: { unit: 'npm test' } } },
      'tickets/t_old001/ticket.json': ticket('t_old001', { state: 'working', tag: 'acme/api', base_sha: base, worktree: wt, branch: 'tb/t_old001-x', plan_hash: hash, round: 4, config_baseline: { paths: [], ignored: [] } }),
      'tickets/t_old001/plan.json': p,
    },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  const k = () => read(tbd, 't_old001');
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual([k().base_checks, k().plan_hashes, k().work.tasks[0].pre, typeof k().config_baseline.tripwire.bin], [{ unit: { ok: true, ms: 4321 } }, [hash], base, 'string']);
});

test('n12 Resume: the base gate of a migrated ticket red → Blocked; Resume runs the base gate again before any task gate or session → its task → review', async (t) => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '-b', 'tb/t_old002-x', wt, base);
  const p = plan([task('T1')]);
  const hash = crypto.createHash('sha256').update(canon(p)).digest('hex');
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify(done('src/a.js', 'one')));
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: {
      'config.json': CONFIG, 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', checks: { unit: 'npm test' } } },
      'tickets/t_old002/ticket.json': ticket('t_old002', { state: 'working', tag: 'acme/api', base_sha: base, worktree: wt, branch: 'tb/t_old002-x', plan_hash: hash, round: 4, config_baseline: { paths: [], ignored: [] } }),
      'tickets/t_old002/plan.json': p,
      'fake-gates/t_old002.json': { base: [{ ok: false, checks: { unit: { ok: false, ms: 10 } }, why: 'unit red at base' }] },
    },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  const k = () => read(tbd, 't_old002');
  await until(() => k().state === 'blocked', 30_000, 'blocked: base red');
  assert.equal((await tbd.api('POST', '/api/tickets/t_old002/resume', {})).status, 202);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual(calls(tbd).map((c) => c.fn), ['base', 'base', 'task', 'working'], 'the base gate again, before the task');
  assert.deepEqual(k().base_checks, { unit: { ok: true, ms: 4321 } });
});

test('F1 M13: a Restart while a fail-first swap is active → the gate aborted (no result), its process killed, the tree restored to HEAD before the new session starts; the swapped-back source is never committed', async (t) => {
  const seen = path.join(ROOT, `f1-${process.pid}`);
  const s2 = { steps: [{ exec: ['/bin/sh', '-c', `git status --porcelain > ${seen}; git show HEAD:src/users.js > ${seen}.head; cat src/users.js > ${seen}.tree`] }, commit('src/b.js', 'two'), result({ status: 'done', commit: SHA })] };
  // restore_ms: runner ticks pass while the swap is restored; the next hook must stay held (no gate job restarts meanwhile)
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/users.js', 'changed'), s2], gates: { task: [{ swap: 'src/users.js', sleep_ms: 60_000 }, {}], restore_ms: 2500 } });
  await until(() => w.k().work?.gate?.swap?.lstart, 30_000, 'swap marker');
  const { swap } = w.k().work.gate;
  assert.equal((await w.tbd.api('POST', `/api/tickets/${w.id}/restart`)).status, 202);
  await until(() => w.k().state === 'review', 45_000, 'review');
  assert.deepEqual([fs.readFileSync(seen, 'utf8'), fs.readFileSync(`${seen}.tree`, 'utf8')], ['', fs.readFileSync(`${seen}.head`, 'utf8')], 'session 2 started on a clean tree at HEAD');
  assert.equal(alive(swap.pid), false, 'the gate process was killed');
  assert.match(git(w.wt, 'show', 'HEAD:src/users.js'), /changed/);
  assert.deepEqual(journal(w.tbd, w.id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok]), [['task', true], ['working', true]], 'the aborted gate wrote nothing');
  assert.equal(w.dumps()[1].opts['--resume'], undefined);
});

test('DoD crash drills: tbd killed -9 mid-session → the next tbd re-attaches it (lease.task kept, no new session; the task was running); killed mid working gate → its orphaned process killed, the gate runs again', async (t) => {
  const slow = { steps: [{ sleep_ms: 3000 }, commit('src/a.js', 'one'), result({ status: 'done', commit: SHA })] };
  const w = await approved(t, { tasks: [task('T1')], sessions: [slow], gates: { working: [{ child: true, sleep_ms: 60_000 }, {}] } });
  await until(() => w.k().lease?.pid && !w.k().lease.exit, 30_000, 'session live');
  assert.deepEqual([w.k().lease.task, w.k().work.tasks[0].status], ['T1', 'running'], 'running from its spawn');
  await w.crash();
  await until(() => w.k().work?.gate?.kind === 'working' && w.k().work.gate.proc?.lstart, 45_000, 'working gate running');
  const { proc } = w.k().work.gate;
  await w.crash();
  await until(() => w.k().state === 'review', 30_000, 'review');
  assert.equal(alive(proc.pid), false, 'the orphaned gate process was killed');
  assert.equal(w.dumps().length, 1, 're-attached, never started again');
  assert.deepEqual(lines(path.join(w.tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'run' && m.ticket === w.id).map((m) => m.task), ['T1']);
  assert.deepEqual(journal(w.tbd, w.id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok]), [['task', true], ['working', true]]);
});

test('F3 RO2: a deps ask from the gate → tb scope --allow (CLI only) builds sandboxed offline; it needs the network → a 2nd ask; the 2nd allow builds online, the tripwire baseline is taken again → the same session goes on → green', async (t) => {
  const deps = { ok: false, class: 'deps', ask: { kind: 'deps', files: ['package-lock.json'], reason: 'package-lock.json changed' }, why: 'deps: package-lock.json' };
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('package-lock.json', 'lock'), { steps: [result({ status: 'done', commit: SHA })] }], gates: { task: [deps, {}], deps: [{ needs_online: true }] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'deps ask');
  assert.equal((await w.rpc('scope', { allow: true }, 'ui')).status, 401);
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  assert.deepEqual([k().state, k().clarify_origin.class], ['clarify', 'deps']);
  assert.match(k().clarify_origin.why, /needs the network \(443 to any host/);
  assert.equal(k().config_baseline.tripwire.lock, null, 'no build yet');
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.equal(typeof k().config_baseline.tripwire.lock, 'string', 'the baseline was taken again after the build (else integrity red)');
  assert.equal(w.dumps()[1].opts['--resume'], w.dumps()[0].opts['--session-id']);
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => [l.actor, l.verb]), [['cli', 'scope-allow'], ['cli', 'scope-allow']]);
});

test('RO2 deps build in flight: work.building holds the other verbs off (a 2nd tb scope → 409); the build\'s allow lands once → the same session goes on → review', async (t) => {
  const deps = { ok: false, class: 'deps', ask: { kind: 'deps', files: ['package-lock.json'], reason: 'package-lock.json changed' }, why: 'deps: package-lock.json' };
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('package-lock.json', 'lock'), { steps: [result({ status: 'done', commit: SHA })] }], gates: { task: [deps, {}], deps: [{ sleep_ms: 2000 }] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'deps ask');
  const allow = w.rpc('scope', { allow: true });
  await until(() => k().work.building && calls(tbd).some((c) => c.fn === 'deps'), 10_000, 'build in flight');
  assert.equal((await w.rpc('scope', { allow: false })).status, 409);
  assert.equal((await allow).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual([lines(tk(tbd, id, 'interventions.jsonl')).map((l) => l.verb), k().work.building], [['scope-allow'], undefined]);
});

test('F2 RO2 replan: kept commits change the lockfile vs base_sha → the tag\'s plain setup does not run again; the sandboxed build (offline) needs the network → clarify deps; the CLI allow builds online → the next task runs → green', async (t) => {
  const marker = path.join(ROOT, `setup-${process.pid}`);
  const replanned = { result: { structured_output: plan([task('T1'), task('T2', { title: 'second' })], { keep: ['T1'] }) } };
  const sessions = [done('package-lock.json', 'lock v1'), { steps: [commit('package-lock.json', 'lock v2'), result({ status: 'NEEDS_CONTEXT', question: 'Pin it?' })] }, { steps: [replanned] }, done('src/c.js', 'T2 new')];
  const w = await approved(t, { tasks: [task('T1'), task('T2')], sessions, tag: { setup: `echo run >> ${marker}` }, gates: { deps: [{ needs_online: true }] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'clarify');
  assert.equal((await w.rpc('answer', { replan: true })).ok, true);
  await inPlanApproval(tbd, id);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => k().state === 'clarify' && k().clarify_origin?.class === 'deps', 30_000, 'deps ask after the re-approve');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n', 'the unsandboxed tag setup ran at the first approve only');
  assert.deepEqual([k().clarify_origin.task, k().plan_hashes.length], ['T2', 2]);
  assert.match(k().clarify_origin.why, /dependencies \(package-lock\.json\) are not the ones node_modules was built from, and the build needs the network/);
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual(k().work.tasks.map((x) => [x.id, x.status]), [['T1', 'done'], ['T2', 'done']]);
  assert.equal(typeof k().config_baseline.tripwire.lock, 'string');
  assert.deepEqual(lines(tk(tbd, id, 'interventions.jsonl')).map((l) => l.verb), ['replan', 'scope-allow']);
});

test('F5 RAM worst case: a 30-task cursor + a NEEDS_SCOPE of 50 × 290-char paths (4 KB reason) allowed + a 4 KB red why + a 4 KB question → ticket.json stays ≤ 16 KB (lists in scope.json, text in work.jsonl)', async (t) => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '-b', 'tb/t_big001-x', wt, base);
  const tasks = Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`));
  const p = plan(tasks);
  const hash = crypto.createHash('sha256').update(canon(p)).digest('hex');
  const sha = (i) => crypto.createHash('sha1').update(String(i)).digest('hex');
  const work = { task: 'T30', tries: 0, unit_ms: 1234, scope: {}, denied: {}, gate: null,
    tasks: tasks.map((x, i) => (i < 29 ? { id: x.id, status: 'done', attempt: 1, pre: sha(i), head: sha(i + 1) } : { id: x.id, status: 'pending', attempt: 1, pre: base, head: null, commit: null, session: null })) };
  const files = Array.from({ length: 50 }, (_, i) => `src/${String(i).padStart(2, '0')}${'x'.repeat(280)}.js`);
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  [{ steps: [result({ status: 'NEEDS_SCOPE', needs_scope: { files, reason: 'r'.repeat(4000) } })] }, done('src/a.js', 'one'),
    { steps: [result({ status: 'NEEDS_CONTEXT', question: 'q'.repeat(4096), notes: 'n'.repeat(4096) })] }].forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const id = 't_big001';
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: {
      'config.json': CONFIG, 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', env_files: ['.env.test'], checks: { unit: 'npm test' } } },
      [`tickets/${id}/ticket.json`]: ticket(id, { state: 'working', tag: 'acme/api', title: 'x'.repeat(100), base_sha: base, worktree: wt, branch: 'tb/t_big001-x', round: 4, plan_hash: hash,
        plan_file: `plan-${hash}.json`, plan_hashes: [hash, hash], base_checks: { unit: { ok: true, ms: 4321 } }, rules_sha: null, skills: [],
        config_baseline: { paths: [], ignored: [], tripwire: { lock: null, bin: crypto.createHash('sha256').update('').digest('hex') } }, work }),
      [`tickets/${id}/plan-${hash}.json`]: p,
      [`fake-gates/${id}.json`]: { task: [{ ok: false, class: 'work', why: 'w'.repeat(5000) }] },
    },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  let max = 0;
  const size = () => { try { max = Math.max(max, fs.statSync(tk(tbd, id, 'ticket.json')).size); } catch { /* mid-rename */ } };
  const timer = setInterval(size, 20);
  t.after(() => clearInterval(timer));
  const k = () => read(tbd, id);
  await until(() => k().state === 'clarify', 30_000, 'scope ask');
  size();
  const rpcDir = path.join(tbd.tbHome, 'test-rpc');
  fs.mkdirSync(rpcDir);
  fs.writeFileSync(path.join(rpcDir, '1.json'), JSON.stringify({ fn: 'scope', args: [id, { allow: true }, 'cli'] }));
  await until(() => k().state === 'clarify' && k().clarify_origin.class === 'NEEDS_CONTEXT', 45_000, 'question after the red gate');
  size();
  clearInterval(timer);
  assert.equal(json(path.join(rpcDir, '1.out.json')).ok, true);
  assert.deepEqual([json(tk(tbd, id, 'scope.json')).allow.T30.length, k().work.scope], [50, { T30: 50 }]);
  assert.ok(journal(tbd, id).some((l) => l.t === 'result' && l.question?.length === 4096), 'the whole question is kept in work.jsonl');
  t.diagnostic(`ticket.json peak ${max} B`);
  assert.ok(max > 8 * 1024 && max <= 16 * 1024, `ticket.json peaked at ${max} B`);
});

test('RO2 single ask: NEEDS_SCOPE with packages → clarify deps at once (never scope first); the CLI allow installs them sandboxed (packages), binds package.json + lockfile to the built tree, the tripwire again → the session commits them as built → green; a protected file → protected', async (t) => {
  const pkgs = result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['src/users.js'], packages: ['zod@^3.23.0'], reason: 'validate input' } });
  const commitDeps = { exec: ['/bin/sh', '-c', 'git add package.json package-lock.json && git -c user.name=t -c user.email=t@t commit -qm deps'] };
  // first a plain scope allow: the deps build then gets t.work.scope as Allow[] lists (P5b's vouch reads them), not counts
  const extra = { steps: [result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['lib/extra.js'], reason: 'a helper' } })] };
  const w = await approved(t, { tasks: [task('T1')], sessions: [extra, { steps: [pkgs] }, { steps: [commitDeps, result({ status: 'done', commit: SHA })] }] });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'scope ask');
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  await until(() => k().state === 'clarify' && k().clarify_origin.class !== 'scope', 30_000, 'deps ask');
  assert.equal(k().clarify_origin.class, 'deps');
  const ask = journal(tbd, id).findLast((l) => l.t === 'ask');
  assert.deepEqual([ask.kind, ask.files, ask.packages], ['deps', ['src/users.js', 'package.json', 'package-lock.json'], ['zod@^3.23.0']]);
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.match(w.dumps()[2].prompt, /^Irfan allowed zod@\^3\.23\.0: tbd installed it; package\.json and the lockfile now hold it\. Commit both/);
  const allow = json(tk(tbd, id, 'scope.json')).allow.T1;
  for (const f of ['package.json', 'package-lock.json']) assert.equal(allow.find((a) => a.path === f).blob, git(w.wt, 'rev-parse', `HEAD:${f}`), `${f}: bound to the built blob the agent committed`);
  assert.match(git(w.wt, 'show', 'HEAD:package.json'), /"zod": "\^3\.23\.0"/);
  assert.equal(typeof k().config_baseline.tripwire.lock, 'string');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'ask').map((l) => l.kind), ['scope', 'deps'], 'the deps change: one ask');

  // the agent commits more than the build made (a script too): the deps allow is bound to the built blobs → asked again
  const more = { exec: ['/bin/sh', '-c', `node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.scripts.x='y';require('fs').writeFileSync(f,JSON.stringify(p))" && git add package.json package-lock.json && git -c user.name=t -c user.email=t@t commit -qm deps`] };
  const v = await approved(t, { id: 't_more01', tasks: [task('T1')], sessions: [{ steps: [pkgs] }, { steps: [more, result({ status: 'done', commit: SHA })] }], gates: { task: [{ protect: ['package.json'] }] } });
  await until(() => v.k().state === 'clarify', 30_000, 'deps ask');
  assert.equal((await v.rpc('scope', { allow: true })).ok, true);
  await until(() => v.k().state === 'clarify' && v.k().clarify_origin.class === 'protected', 30_000, 'package.json beyond the build: asked again');

  const p = await approved(t, { id: 't_prot01', tasks: [task('T1')], sessions: [{ steps: [result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['package.json'], reason: 'a test:e2e script' } })] }] });
  await until(() => p.k().state === 'clarify', 30_000, 'protected ask');
  assert.equal(p.k().clarify_origin.class, 'protected');
  assert.equal((await p.rpc('scope', { allow: true }, 'ui')).status, 401);
});

test('K3 RO2 single ask, protected: the agent asks before editing package.json → one ask; the allow is pending (no blob) until the first gate binds it to the agent\'s committed blob → green; a later edit (next task) asks again', async (t) => {
  const edit = (msg) => ({ steps: [{ exec: ['/bin/sh', '-c', `node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.scripts['${msg}']='node x';require('fs').writeFileSync(f,JSON.stringify(p))" && git add package.json && git -c user.name=t -c user.email=t@t commit -qm ${msg}`] }, result({ status: 'done', commit: SHA })] });
  const ask = { steps: [result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['package.json'], reason: 'a test:e2e script' } })] };
  const w = await approved(t, { tasks: [task('T1'), task('T2')], sessions: [ask, edit('e2e'), edit('lint')], gates: { task: [{ protect: ['package.json'] }, { protect: ['package.json'] }] } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'protected ask');
  assert.equal(k().clarify_origin.class, 'protected');
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  assert.deepEqual(json(tk(tbd, id, 'scope.json')).allow.T1, [{ path: 'package.json', blob: null, granted_at_head: git(w.wt, 'rev-parse', 'HEAD') }]);
  await until(() => k().state === 'clarify' && k().work.task === 'T2', 45_000, 'T2 asks for its own edit');
  const t1 = k().work.tasks[0];
  assert.equal(t1.status, 'done', 'T1 green after one ask');
  assert.deepEqual(json(tk(tbd, id, 'scope.json')).allow.T1, [{ path: 'package.json', blob: git(w.wt, 'rev-parse', `${t1.head}:package.json`) }], 'bound to the blob the agent committed');
  assert.deepEqual(journal(tbd, id).filter((l) => l.t === 'ask').map((l) => [l.task, l.kind, l.from ?? 'gate']), [['T1', 'protected', 'agent'], ['T2', 'protected', 'gate']]);
});

test('RO2 replan negative: a dropped task had a deps build → the kept commit\'s lockfile (base\'s) is not what node_modules was built from → the sandboxed build (offline), never the tag\'s own setup, though the lockfile equals base_sha\'s', async (t) => {
  const marker = path.join(ROOT, `neg-setup-${process.pid}`);
  const pkgs = result({ status: 'NEEDS_SCOPE', needs_scope: { files: ['src/users.js'], packages: ['zod@^3.23.0'], reason: 'validate' } });
  const commitAsk = { exec: ['/bin/sh', '-c', 'git add package.json package-lock.json && git -c user.name=t -c user.email=t@t commit -qm deps'] };
  const replanned = { result: { structured_output: plan([task('T1'), task('T2', { title: 'no zod' })], { keep: ['T1'] }) } };
  const sessions = [done('src/a.js', 'T1'), { steps: [pkgs] }, { steps: [commitAsk, result({ status: 'NEEDS_CONTEXT', question: 'zod is heavy, drop it?' })] }, { steps: [replanned] }, done('src/c.js', 'T2 new')];
  const w = await approved(t, { tasks: [task('T1'), task('T2')], sessions, tag: { setup: `echo run >> ${marker}` } });
  const { tbd, id, k } = w;
  await until(() => k().state === 'clarify', 30_000, 'deps ask');
  assert.equal((await w.rpc('scope', { allow: true })).ok, true);
  await until(() => k().state === 'clarify' && k().clarify_origin.class === 'NEEDS_CONTEXT', 30_000, 'question');
  assert.match(k().work.deps_blob, /^package-lock\.json:[0-9a-f]{40}$/, 'the zod build is recorded');
  assert.equal((await w.rpc('answer', { replan: true })).ok, true);
  await inPlanApproval(tbd, id);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => k().state === 'review', 45_000, 'review');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n', 'the tag setup ran at the first approve only');
  assert.deepEqual(calls(tbd).filter((c) => c.fn === 'deps').map((c) => c.online), [false, false], 'the allow, then the replan: both sandboxed offline');
  assert.equal(k().work.deps_blob, 'none');
});

test('K7 K12: a gate stopped by memory mid fail-first swap (it returns without its own restore) → tbd restores the tree to HEAD before anything else; the rerun accepts the task', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/users.js', 'changed')], gates: { task: [{ swap: 'src/users.js', sleep_ms: 60_000 }, {}] } });
  const { tbd, id, k } = w;
  await until(() => k().work?.gate?.swap?.lstart && git(w.wt, 'status', '--porcelain') === 'M  src/users.js', 30_000, 'mid-swap');
  const pressure = path.join(tbd.tbHome, 'test-pressure');
  fs.writeFileSync(pressure, 'critical');
  await until(() => journal(tbd, id).some((l) => l.t === 'gate' && l.class === 'interrupted'), 30_000, 'interrupted');
  assert.deepEqual([git(w.wt, 'status', '--porcelain'), k().work.gate.swap ?? null], ['', null], 'restored, marker cleared');
  fs.rmSync(pressure);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.match(git(w.wt, 'show', 'HEAD:src/users.js'), /changed/);
});

test('K7: the restore of a gate stopped mid fail-first swap fails (checks.generate red) → Blocked infra, the swap marker kept (never a silent revert); Resume restores the tree first, the gate runs again → accepted, no session spent', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/users.js', 'changed')], gates: { task: [{ swap: 'src/users.js', sleep_ms: 60_000 }, {}], restore_fail: true } });
  const { tbd, id, k } = w;
  await until(() => k().work?.gate?.swap?.lstart && git(w.wt, 'status', '--porcelain') === 'M  src/users.js', 30_000, 'mid-swap');
  const pressure = path.join(tbd.tbHome, 'test-pressure');
  fs.writeFileSync(pressure, 'critical');
  await until(() => k().state === 'blocked', 30_000, 'blocked');
  fs.rmSync(pressure);
  assert.deepEqual([k().waiting.reason, typeof k().work.gate.swap?.lstart, git(w.wt, 'status', '--porcelain')], ['infra', 'string', 'M  src/users.js'], 'the marker kept: the tree is still swapped');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/resume`, {})).status, 202);
  await until(() => k().state === 'review', 30_000, 'review');
  assert.deepEqual([git(w.wt, 'status', '--porcelain'), w.dumps().length], ['', 1], 'restored before the gate; no session on a swapped tree');
  assert.match(git(w.wt, 'show', 'HEAD:src/users.js'), /changed/);
});

test('P5c SSE: each finished gate check reaches /events as one `gate` frame {id, task, check, ok} (tbd.js live → http.onCheck)', async (t) => {
  const w = await approved(t, { tasks: [task('T1')], sessions: [done('src/T1.js', 'T1')], state: null, gates: { task: [{ sleep_ms: 2000 }] } });
  const frames = [];
  const req = http.get({ host: '127.0.0.1', port: w.tbd.port, path: '/events', headers: { 'x-tb-token': w.tbd.token } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const m = /^event: gate\ndata: (.*)$/.exec(buf.slice(0, i));
        if (m) frames.push(JSON.parse(m[1]));
      }
    });
  });
  t.after(() => req.destroy());
  await until(() => w.k().state === 'review', 90_000, 'review');
  assert.deepEqual(frames, [{ id: w.id, task: 'T1', check: 'unit', ok: true }, { id: w.id, task: null, check: 'unit', ok: true }]);
});
