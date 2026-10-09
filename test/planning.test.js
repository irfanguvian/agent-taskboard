'use strict';
// P4a (plan P4 AC2 AC3-assign AC7; contract U1 U2 U3 U4 U5 U6 U7 J3 J6 J7): a real tbd (harness temp HOME + TB_HOME,
// port 0) with the real code/planning handler (lib/planning.js; run-spy's fixture handlers off), test/fake-claude.js
// as claude_bin, real git temp repos. Fixture phase dir: the real settings.json + result.schema.json and a stub
// prompt.md (the planner prompt lands in P4d, D9). Kills only through run-spy (this test's own processes).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, runTb, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, NOW, ticket, read, lines, until, reap, pidsOf } = require('./helpers/runs');
const { SCHEMA_PROMPT } = require('../lib/recovery');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
fs.mkdirSync(path.join(PHASES, 'code', 'planning'), { recursive: true });
for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', 'planning', f), path.join(PHASES, 'code', 'planning', f));
fs.writeFileSync(path.join(PHASES, 'code', 'planning', 'prompt.md'), '# planning fixture\n');

// Admission always yes: this 8 GB Mac's free RAM must not decide a test.
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 4,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const D1 = { id: 'D1', text: 'cursor, not offset', source: 'answer:R1Q1' };
// P4e (J16 J17) fixtures: facts name a path at base, answer: sources only on locked ids (locked ones may be left out),
// tasks name the acceptance ids they cover; repo() has the files and npm script the plan names.
const QUESTIONS = { kind: 'questions', round: 1, questions: [{ id: 'Q1', question: 'Page size?', why: 'API contract', options: ['20', '50'], recommended: '20' }], facts: ['README.md: users list has no paging'], decisions: [] };
const PLAN = {
  kind: 'plan', summary: 'Paginate GET /users', acceptance: [{ id: 'A1', text: 'returns 20 per page', type: 'new' }],
  tasks: [{ id: 'T1', title: 'cursor pagination', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['add cursor'] }],
  allowed_schema_changes: [], allowed_api_changes: ['GET /users: add optional cursor'], skills: ['learning'], ui: null,
  children: [{ id: 'C1', title: 'docs', text: 'document paging', blocked_by: ['parent'] }, { id: 'C2', title: 'client', text: 'use paging', blocked_by: ['C1'] }],
  facts: ['README.md: users list has no paging'], decisions: [],
};
const result = (out) => ({ result: { structured_output: out } });

// root with home/.claude/skills/learning (the plan's skill exists for skills.js) for startTbd({root}).
function newRoot() {
  const root = fs.mkdtempSync(path.join(ROOT, 'tbd-'));
  fs.mkdirSync(path.join(root, 'home', '.claude', 'skills', 'learning'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', '.claude', 'skills', 'learning', 'SKILL.md'), '---\nname: learning\n---\n');
  return root;
}
async function boot(t, tickets, { env = {}, files = {}, root = newRoot() } = {}) {
  const seed = { 'config.json': CONFIG, ...files };
  for (const [id, { scenario, ...over }] of Object.entries(tickets)) {
    seed[`tickets/${id}/ticket.json`] = ticket(id, over);
    if (scenario) seed[`tickets/${id}/scenario.json`] = scenario;
  }
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const tbd = await startTbd({ root, files: seed, env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_DUMP_DIR: dumps, ...env } });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return Object.assign(tbd, { dumps: () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => JSON.parse(fs.readFileSync(path.join(dumps, f), 'utf8'))) });
}
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'users api\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n'); // P4e: PLAN's test_cmd
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n'); // P4e: PLAN's files + modules
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n'); // P4e: setup's output stays out of a clean worktree (J16)
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

test('AC3 U1 U2 J6 J7: assign guards (blocker not merged, base ref missing, worktree add fails → backlog); tb assign → detached worktree at base_sha; AC2 U5 U6: planning runs there with the seed, questions → clarify, files kept', async (t) => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-')); // by invocation: 1 = t_hang01 (at boot), 2 = t_plan01 (after assign)
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [{ hang: true }] }));
  fs.writeFileSync(path.join(scn, '2.json'), JSON.stringify({ steps: [result(QUESTIONS)] }));
  const tbd = await boot(t, {
    t_hang01: {}, // another live run for "System now"
    t_plan01: {
      state: 'backlog', tag: 'acme/api', text: 'Paginate GET /users with cursors', blocked_by: ['t_dep001'], must_ask: true,
      answers: [{ id: 'R1Q1', question: 'Cursor or offset?', answer: { pick: 'cursor' } }, { id: 'R1Q2', question: 'Page size?', answer: { use: 'recommended' }, recommended: '20' }],
      locked_decisions: [D1], reject_comment: 'keep the old endpoint working',
    },
    t_dep001: { state: 'done', pr: { merged_at: NOW } },
    t_neg001: { state: 'backlog', tag: 'acme/api', blocked_by: ['t_dep002'] },
    t_dep002: { state: 'final_gate', pr: { merged_at: null } },
    t_base01: { state: 'backlog', tag: 'acme/nobase' },
    t_wtfl01: { state: 'backlog', tag: 'acme/api' },
  }, {
    files: { 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main' }, 'acme/nobase': { type: 'git', path: dir, base: 'nope' } }, 'worktrees/t_wtfl01/taken.txt': 'x' },
    env: { FAKE_CLAUDE_SCENARIO_DIR: scn, TEST_PRESSURE: 'normal' }, // two live runs at once (D2: none at warn)
  });
  await until(() => read(tbd, 't_hang01').lease?.pid, 15_000, 'other run live');

  // U2 negatives over HTTP: 409 with the reason, the ticket stays in backlog, no worktree
  for (const [id, re] of /** @type {[string, RegExp][]} */ ([['t_neg001', /blocker t_dep002 is not merged yet/], ['t_base01', /tag acme\/nobase fails doctor: base branch nope not found/], ['t_wtfl01', /git worktree add .*t_wtfl01 failed: .*; the ticket stays in backlog/]])) {
    const r = await tbd.api('POST', `/api/tickets/${id}/assign`);
    assert.equal(r.status, 409, id);
    assert.match(r.json.error, re, id);
    assert.deepEqual([read(tbd, id).state, read(tbd, id).base_sha, read(tbd, id).worktree], ['backlog', undefined, undefined], id);
  }
  assert.equal(fs.existsSync(path.join(tbd.tbHome, 'worktrees', 't_neg001')), false);

  // tb assign: usage exit 2, ok exit 0 (TOON), a second assign exit 1
  assert.equal((await runTb(['assign'], tbd)).code, 2);
  const ok = await runTb(['assign', 't_plan01'], tbd);
  assert.equal(ok.code, 0, ok.stdout);
  const wt = path.join(tbd.tbHome, 'worktrees', 't_plan01');
  assert.match(ok.stdout, new RegExp(`^assign: ok · t_plan01 · planning · .*\\nworktree: ${wt} · base_sha ${base}\\n`));
  const again = await runTb(['assign', 't_plan01'], tbd);
  assert.deepEqual([again.code, /error: t_plan01: already assigned \(state planning\)/.test(again.stdout)], [1, true], again.stdout); // was: "planning → planning is not allowed for you"
  // J6 U1: base_sha = local main, worktree detached at it; S1: its git dir + the repo's common dir kept for pinning
  assert.deepEqual([read(tbd, 't_plan01').base_sha, read(tbd, 't_plan01').worktree], [base, wt]);
  assert.deepEqual([read(tbd, 't_plan01').git_dir, read(tbd, 't_plan01').common_dir], [path.join(fs.realpathSync(dir), '.git', 'worktrees', 't_plan01'), path.join(fs.realpathSync(dir), '.git')]);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), base);
  assert.throws(() => git(wt, 'symbolic-ref', '-q', 'HEAD'), 'detached HEAD');

  // AC2: the planning run's cwd is that worktree; questions → clarify, must_ask cleared; U5 files
  await until(() => read(tbd, 't_plan01').state === 'clarify', 30_000, 'clarify');
  assert.equal(read(tbd, 't_plan01').must_ask, false);
  assert.deepEqual(json(tk(tbd, 't_plan01', 'rounds', '01-questions.json')), QUESTIONS);
  // J17 (contract change, was the result's decisions as returned): Irfan's locked D1 merged in though the result left it out
  assert.deepEqual([json(tk(tbd, 't_plan01', 'facts.json')), json(tk(tbd, 't_plan01', 'decisions.json'))], [QUESTIONS.facts, [D1]]);
  const d = tbd.dumps().find((x) => x.prompt.includes('Paginate GET /users with cursors'));
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(wt));
  assert.deepEqual([d.opts['--model'], d.opts['--session-id'] === read(tbd, 't_plan01').lease.session], ['fable', true], 'fresh session');
  // U6 seed: ticket text, answers as Q/A, locked decision marked, reject comment, must_ask note, System now with the other run
  for (const part of ['# run t_plan01\n\nPaginate GET /users with cursors\n', 'Q (R1Q1): Cursor or offset?\nA: cursor\n', 'Q (R1Q2): Page size?\nA: use your recommended answer (20)\n',
    '## Planning round 1', "- D1 (source: answer:R1Q1): cursor, not offset [locked: Irfan's decision: never plan against it; no need to repeat it]", 'keep the old endpoint working',
    '## Ask first', '## System now\n\nsystem[1]{pressure,', 'heavy: 0/', 'runs[1]{id,phase,started_at}:\n  t_hang01,planning,']) {
    assert.ok(d.prompt.includes(part), `prompt has ${JSON.stringify(part)}:\n${d.prompt}`);
  }
  assert.doesNotMatch(d.prompt, /```json/, 'answers are not a JSON dump');
});

test('U3 U4 J3: schema-invalid, changed locked decision, must_ask + plan, unknown skill, child cycle → resumed once with the reason → Blocked (or accepted); plan → plan_approval; U7 opus refusal → Blocked', async (t) => {
  const bad = (out) => ({ steps: [result(out)], resume_steps: [result(out)] });
  const tbd = await boot(t, {
    t_okpl01: { scenario: { steps: [result(PLAN)] } },
    t_schm01: { scenario: bad({ ...PLAN, tasks: [] }) },
    t_lock01: { locked_decisions: [D1], scenario: bad({ ...PLAN, decisions: [{ ...D1, text: 'offset' }] }) },
    t_must01: { must_ask: true, scenario: { steps: [result(PLAN)], resume_steps: [result(QUESTIONS)] } },
    t_skil01: { scenario: bad({ ...PLAN, skills: ['learning', 'no-such-skill'] }) },
    t_chld01: { scenario: { steps: [result({ ...PLAN, children: [{ ...PLAN.children[0], blocked_by: ['C2'] }, PLAN.children[1]] })], resume_steps: [result(PLAN)] } },
    t_rfse01: { scenario: { steps: ['refusal'] } },
  }, { env: { FAKE_CLAUDE_SCENARIO: 'scenario.json' } }); // <cwd = ticket dir>/scenario.json
  const blocked = ['t_schm01', 't_lock01', 't_skil01', 't_rfse01'];
  const ids = [...blocked, 't_okpl01', 't_must01', 't_chld01'];
  await until(() => ids.every((id) => read(tbd, id).lease?.exit && !read(tbd, id).lease.pending && read(tbd, id).state !== 'planning'), 60_000, 'every ticket left planning');
  const states = Object.fromEntries(ids.map((id) => [id, read(tbd, id).state]));
  assert.deepEqual(states, { t_schm01: 'blocked', t_lock01: 'blocked', t_skil01: 'blocked', t_rfse01: 'blocked', t_okpl01: 'plan_approval', t_must01: 'clarify', t_chld01: 'plan_approval' });
  const prompt = (id, n) => fs.readFileSync(tk(tbd, id, 'runs', `${n}.prompt`), 'utf8');
  const runs = (id) => fs.readdirSync(tk(tbd, id, 'runs')).filter((f) => f.endsWith('.prompt')).length;
  // the reject reason reaches the resume (same session), once; a second refusal blocks
  for (const [id, why] of [
    ['t_schm01', 'the result does not match the schema: /tasks: must have at least 1 item'],
    ['t_lock01', `decisions[0] "D1": Irfan locked it as "cursor, not offset": return his text exactly or leave it out`], // J17 (was: echo it exactly once)
    ['t_must01', 'Irfan asked to be asked more first (must_ask)'],
    ['t_skil01', 'unknown skills "no-such-skill"'],
    ['t_chld01', 'children blocked_by form a cycle: "C1", "C2"'],
  ]) {
    assert.ok(prompt(id, 2).startsWith(`${SCHEMA_PROMPT}\n\n${why}`), `${id}: ${prompt(id, 2)}`);
    assert.equal(runs(id), 2, id);
  }
  for (const id of ['t_schm01', 't_lock01', 't_skil01']) {
    const l = read(tbd, id).lease;
    assert.deepEqual([l.exit, l.schema_retry, l.resumed, read(tbd, id).blocked_from, read(tbd, id).failures], ['schema_fail', true, true, 'planning', {}], id);
  }
  assert.equal(fs.existsSync(tk(tbd, 't_schm01', 'rounds')), false, 'a refused result is never kept');
  const runExits = () => lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'run' && m.ticket === 't_lock01').map((m) => m.exit);
  assert.deepEqual(await until(() => runExits().length === 2 && runExits(), 10_000, 't:run lines'), ['schema_fail', 'schema_fail'], 'P4b LOW: a refused result is metered schema_fail');
  // accepted: plan → plan_approval (U5 round 01 = the accepted result), questions after a must_ask refusal → clarify
  assert.deepEqual(json(tk(tbd, 't_okpl01', 'rounds', '01-plan.json')), PLAN);
  assert.deepEqual(json(tk(tbd, 't_chld01', 'rounds', '01-plan.json')), PLAN);
  assert.deepEqual([fs.readdirSync(tk(tbd, 't_must01', 'rounds')), read(tbd, 't_must01').must_ask], [['01-questions.json'], false]);
  // U7: fable refused → a fresh opus run (not counted), it refused too → Blocked, no third run
  const r = read(tbd, 't_rfse01');
  assert.deepEqual([r.lease.exit, r.lease.model, r.lease.opus, r.lease.resumed, r.failures, runs('t_rfse01')], ['refusal', 'opus', true, undefined, {}, 2]);
});

test('AC7 U7: a Fable refusal re-runs planning as a fresh session on opus xhigh (same round, not a failure, one fallback note); its result is taken', async (t) => {
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: ['refusal'] }));
  fs.writeFileSync(path.join(scn, '2.json'), JSON.stringify({ steps: [result(QUESTIONS)] }));
  const tbd = await boot(t, { t_fabl01: { round: 1 } }, { env: { FAKE_CLAUDE_SCENARIO_DIR: scn } });
  await until(() => read(tbd, 't_fabl01').state === 'clarify', 30_000, 'clarify');
  const [d1, d2] = tbd.dumps();
  assert.deepEqual([d1.opts['--model'], d1.opts['--effort'], d1.opts['--fallback-model']], ['fable', 'high', 'opus']);
  assert.deepEqual([d2.opts['--model'], d2.opts['--effort'], d2.opts['--fallback-model'], d2.opts['--resume']], ['opus', 'xhigh', undefined, undefined]);
  assert.notEqual(d2.opts['--session-id'], d1.opts['--session-id'], 'fresh session');
  assert.ok(d2.prompt.includes('## Planning round 1'), 'same round, seeded again');
  const k = read(tbd, 't_fabl01');
  assert.deepEqual([k.failures, k.lease.model, k.round], [{}, 'opus', 2]); // the one move: planning (round 1) → clarify
  const notes = lines(tk(tbd, 't_fabl01', 'events.jsonl')).filter((e) => e.note);
  assert.deepEqual(notes.map((e) => e.note), ['fallback: fable refused; phase re-run on opus xhigh']);
  await until(() => lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'run').length === 2, 10_000, 't:run lines');
  assert.deepEqual(lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'run').map((m) => [m.model, m.exit]), [['fable', 'refusal'], ['opus', 'result']]);
});

// ---- P4b (plan P4 AC3 AC4 AC8; contract U8 U9 U10 U11 J3 J5 J12) ----------------------------------------------------
const crypto = require('node:crypto');
const { plantedConfig } = require('../lib/spawn');

// plan_hash, computed here on its own: sha256 of the JSON with keys sorted at every level
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const alerts = (tbd) => lines(path.join(tbd.tbHome, 'test-alerts.jsonl'));
const ticketLines = (tbd) => lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((m) => m.t === 'ticket');

test('item 8 E2E (U8 U9 J3 J12 AC3 AC4 AC8): assign → questions → tb answer → round 2 a fresh seeded session → plan → reject --ask → questions → answer --plan-now → plan → approve: setup fails (setup_failed, alert), approve again (two at once: one wins) → branch, env file, skills, setup in the heavy slot, baseline, children → working (manual); cancel → t:ticket', async (t) => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.test\n');
  // P4e F2: a submodule at base (gitlink + .gitmodules, its name with a space), never initialized: an empty mod/
  fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "my mod"]\n\tpath = mod\n\turl = ./mod\n');
  fs.mkdirSync(path.join(dir, 'mod'));
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},mod`);
  git(dir, 'add', '.gitignore', '.gitmodules');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore');
  fs.writeFileSync(path.join(dir, '.env.test'), 'SECRET=1\n'); // Irfan's env file: in the dev checkout, ignored
  const base = git(dir, 'rev-parse', 'main');
  const marker = path.join(ROOT, `setup-ok-${process.pid}`);
  // npm-like: fails until the marker exists; then node_modules with a CLAUDE.md, and the slot lease it ran under
  const setup = `test -f ${marker} || { echo boom >&2; exit 3; }; mkdir -p node_modules/x && echo "$TBX_LEASE" > node_modules/.lease && echo m > node_modules/x/CLAUDE.md`;
  const L1 = { id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' };
  const L2 = { id: 'R1Q2', text: 'Cursor or offset? → cursor', source: 'answer:R1Q2' };
  const R2C = { id: 'R2C', text: 'keep GET /users/all working', source: 'reject:R2' };
  const Q1 = { kind: 'questions', questions: [
    { id: 'Q1', question: 'Page size?', why: 'contract', options: ['20', '50'], recommended: '20' },
    { id: 'Q2', question: 'Cursor or offset?', why: 'scale', options: ['cursor', 'offset'], recommended: 'cursor' },
    { id: 'Q3', question: 'Max page?', why: 'abuse', options: ['100', '500'], recommended: '100' }], facts: ['README.md: no paging yet'], decisions: [] };
  const P1 = { ...PLAN, children: [], decisions: [L1, L2] };
  const Q3 = { kind: 'questions', questions: [{ id: 'Q1', question: 'Keep /users/all?', why: 'clients', options: ['yes', 'no'], recommended: 'yes' }], facts: ['README.md: no paging yet'], decisions: [L1, L2, R2C] };
  const P2 = { ...PLAN, decisions: [L1, L2, R2C, { id: 'D1', text: 'cursor in a header', source: 'planner' }] };
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  [Q1, P1, Q3, P2].forEach((out, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify({ steps: [result(out)] })));
  const root = newRoot();
  fs.symlinkSync('/etc/hosts', path.join(root, 'home', '.claude', 'skills', 'learning', 'hosts-link')); // never followed into the copy
  const tbd = await boot(t, { t_e2e001: { state: 'backlog', tag: 'acme/api', title: 'Paginate GET /users!', text: 'Paginate GET /users' } }, {
    files: { 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', setup, env_files: ['.env.test'] } } },
    env: { FAKE_CLAUDE_SCENARIO_DIR: scn }, root,
  });
  const id = 't_e2e001';
  const k = () => read(tbd, id);
  const post = (op, body) => tbd.api('POST', `/api/tickets/${id}/${op}`, body);

  assert.equal((await runTb(['assign', id], tbd)).code, 0);
  await until(() => k().state === 'clarify', 30_000, 'clarify 1');
  // U8: neither --file nor --plan-now → the open questions, exit 1; bad files → refused, still clarify
  const open = await runTb(['answer', id], tbd);
  assert.equal(open.code, 1, open.stdout);
  assert.match(open.stdout, /^error: answer every question with --file, or --plan-now\nquestions\[3\]\{id,question,options,recommended\}:\n {2}Q1,Page size\?,20 \| 50,"20"\n/);
  for (const [body, status, re] of /** @type {[any, number, RegExp][]} */ ([
    [{ answers: { Q9: { pick: '20' } } }, 400, /round 1 has no question "Q9"/],
    [{ answers: { Q1: { pick: '30' }, Q2: { use: 'recommended' }, Q3: { use: 'you_decide' } } }, 400, /answer to "Q1" must be \{"pick": "20" \| "50"\}/],
    [{ answers: { Q1: { pick: '20', text: 'x' }, Q2: { use: 'recommended' }, Q3: { use: 'you_decide' } } }, 400, /answer to "Q1" must be/],
    [{ answers: { Q1: { pick: '20' } } }, 409, /not answered: "Q2", "Q3": answer every question, or plan now/],
    [{ answers: {}, extra: 1 }, 400, /body must be/]])) {
    const r = await post('answer', body);
    assert.deepEqual([r.status, re.test(r.json.error), k().state], [status, true, 'clarify'], `${JSON.stringify(body)}: ${r.json.error}`);
  }
  const file = path.join(ROOT, `answers-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ Q1: { pick: '50' }, Q2: { use: 'recommended' }, Q3: { use: 'you_decide' } }));
  const ans = await runTb(['answer', id, '--file', file], tbd);
  assert.match(ans.stdout, /^answer: ok · t_e2e001 · planning · /, ans.stdout);
  assert.deepEqual(k().locked_decisions, [L1, L2], 'a pick and "use recommended" are locked; "you decide" is not');
  assert.ok(Q1.questions[1].options.includes(k().locked_decisions[1].text.split(' → ')[1]), 'item 6: "use recommended" locks one of the options (J16: recommended is one)');
  await until(() => k().state === 'plan_approval', 30_000, 'plan 1');
  const [d1, d2] = tbd.dumps();
  assert.notEqual(d2.opts['--session-id'], d1.opts['--session-id'], 'round 2: a fresh session');
  assert.equal(d2.opts['--resume'], undefined);
  for (const part of ['Q (R1Q1): Page size?\nA: 50\n', 'Q (R1Q2): Cursor or offset?\nA: use your recommended answer (cursor)\n', "Q (R1Q3): Max page?\nA: you decide (planner's call)\n",
    '## Planning round 2', "- R1Q1 (source: answer:R1Q1): Page size? → 50 [locked: Irfan's decision: never plan against it; no need to repeat it]"]) {
    assert.ok(d2.prompt.includes(part), `round 2 prompt has ${JSON.stringify(part)}:\n${d2.prompt}`);
  }

  // reject --ask: an empty comment is refused; the comment is kept + locked, must_ask honored (round 3 asks)
  assert.equal((await post('reject', { comment: '  ' })).status, 400);
  const rej = await runTb(['reject', id, 'keep GET /users/all working', '--ask'], tbd);
  assert.match(rej.stdout, /^reject: ok · t_e2e001 · planning · must_ask · /, rej.stdout);
  assert.deepEqual([k().reject_comment, k().locked_decisions.at(-1)], [R2C.text, R2C]);
  await until(() => k().state === 'clarify', 30_000, 'clarify 2');
  assert.equal(k().must_ask, false, 'cleared on entering clarify');
  const d3 = tbd.dumps()[2];
  for (const part of ["## Irfan's comment on the last plan\n\nkeep GET /users/all working", '## Ask first', '## Planning round 3']) assert.ok(d3.prompt.includes(part), part);
  // plan now: the open question is the planner's call
  assert.equal((await runTb(['answer', id, '--plan-now'], tbd)).code, 0);
  await until(() => k().state === 'plan_approval', 30_000, 'plan 2');
  assert.ok(tbd.dumps()[3].prompt.includes("Q (R3Q1): Keep /users/all?\nA: you decide (planner's call)\n"));
  assert.equal(k().locked_decisions.length, 3);

  // J12: setup fails → stays plan_approval, waiting setup_failed with the tail, an alert; the plan is frozen
  const appr = await runTb(['approve', id], tbd);
  assert.match(appr.stdout, /^approve: accepted · t_e2e001 · plan_approval · /, appr.stdout);
  await until(() => k().waiting?.reason === 'setup_failed', 30_000, 'setup_failed');
  assert.equal(k().state, 'plan_approval');
  assert.match(k().waiting.error, /^setup "test -f .*" failed \(exit 3\):\nboom\n$/);
  assert.ok(k().waiting.error.length <= 2048);
  // the alert follows the setup_failed save (ticket.json, ticket.md, event, then alert): wait for it, then exactly one
  await until(() => alerts(tbd).some((a) => a.title === 'Setup failed'), 5000, 'setup alert');
  assert.deepEqual(alerts(tbd).filter((a) => a.title === 'Setup failed').length, 1);
  const hash = crypto.createHash('sha256').update(canon(P2)).digest('hex');
  assert.equal(k().plan_hash, hash);
  // approve again, twice at once: one setup
  fs.writeFileSync(marker, '');
  const both = await Promise.all([post('approve'), post('approve')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [202, 409], JSON.stringify(both.map((r) => r.json)));
  assert.match(both.find((r) => r.status === 409).json.error, /approve is already running/);
  await until(() => k().state === 'working', 30_000, 'working');
  await until(() => k().waiting?.reason === 'manual', 10_000, 'working unbuilt → waiting manual');

  const p = k();
  const wt = p.worktree;
  // U9: frozen plan, branch from base, env file copied, skills copied (no link followed), setup ran holding the heavy slot
  assert.deepEqual([p.plan_hash, json(tk(tbd, id, 'plan.json')), p.skills], [hash, P2, ['learning']]);
  assert.deepEqual([git(wt, 'symbolic-ref', '--short', 'HEAD'), git(wt, 'rev-parse', 'HEAD'), p.branch], ['tb/t_e2e001-paginate-get-users', base, 'tb/t_e2e001-paginate-get-users']);
  assert.equal(fs.readFileSync(path.join(wt, '.env.test'), 'utf8'), 'SECRET=1\n');
  const sk = tk(tbd, id, 'skills', '.claude', 'skills', 'learning');
  assert.deepEqual([fs.lstatSync(path.join(sk, 'SKILL.md')).isFile(), fs.readdirSync(sk)], [true, ['SKILL.md']]);
  assert.match(fs.readFileSync(path.join(wt, 'node_modules', '.lease'), 'utf8'), /^\S{8,}\n$/, 'TBX_LEASE: setup ran in the heavy slot');
  // J3: children in Backlog, parent + blocked_by mapped, auto_assign; not assigned while the parent is not merged (J5)
  assert.equal(p.children.length, 2);
  const [c1, c2] = p.children.map((c) => read(tbd, c));
  for (const [c, title, by] of [[c1, 'docs', [id]], [c2, 'client', [c1.id]]]) {
    assert.deepEqual([c.state, c.kind, c.tag, c.parent, c.blocked_by, c.auto_assign, c.title, c.waiting], ['backlog', 'code', 'acme/api', id, by, true, title, null]);
    // J16: the parent's locked decisions, ids prefixed with the parent's (the child's own rounds count from R1 again)
    assert.deepEqual(c.locked_decisions, [L1, L2, R2C].map((d) => ({ ...d, id: `${id}.${d.id}` })));
  }
  // U10: setup's node_modules/x/CLAUDE.md is in the baseline (refused without it); an agent's CLAUDE.md after is refused
  assert.ok(p.config_baseline.paths.includes('node_modules/x/CLAUDE.md') && p.config_baseline.ignored.includes('node_modules/'), JSON.stringify(p.config_baseline));
  const ticketDir = tk(tbd, id);
  assert.deepEqual(await plantedConfig(p, wt, ticketDir, process.env), []);
  assert.deepEqual(await plantedConfig({ ...p, config_baseline: undefined }, wt, ticketDir, process.env), ['node_modules/x/CLAUDE.md']);
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'planted\n');
  assert.deepEqual(await plantedConfig(p, wt, ticketDir, process.env), ['CLAUDE.md']);
  // inside the ignored node_modules/ too: planted there after the baseline → refused; setup's x/CLAUDE.md still allowed
  fs.mkdirSync(path.join(wt, 'node_modules', 'z'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'z', 'CLAUDE.md'), 'planted\n');
  assert.deepEqual(await plantedConfig(p, wt, ticketDir, process.env), ['CLAUDE.md', 'node_modules/z/CLAUDE.md']);
  // git never enters a nested repo: config planted in one is still refused; a .gitmodules path out of the worktree too.
  // P4e F3: a nested repo named café/ (git quotes it without -z). F2: the base submodule mod/ with .gitmodules no longer
  // naming it (the agent rewrote it): found from the index, its planted CLAUDE.md refused
  const cafe = path.join(wt, 'café');
  execFileSync('git', ['init', '-q', cafe]);
  fs.writeFileSync(path.join(cafe, 'CLAUDE.md'), 'planted\n');
  fs.writeFileSync(path.join(wt, 'mod', 'CLAUDE.md'), 'planted\n');
  const sub = path.join(wt, 'sub');
  execFileSync('git', ['init', '-q', sub]);
  fs.mkdirSync(path.join(sub, '.claude'));
  fs.writeFileSync(path.join(sub, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(sub, 'CLAUDE.md'), 'planted\n');
  fs.writeFileSync(path.join(wt, '.gitmodules'), '[submodule "x"]\n\tpath = ../escape\n\turl = ./x\n');
  assert.deepEqual((await plantedConfig(p, wt, ticketDir, process.env)).sort(),
    ['.gitmodules: ../escape', 'CLAUDE.md', 'café/CLAUDE.md', 'mod/CLAUDE.md', 'node_modules/z/CLAUDE.md', 'sub/.claude', 'sub/CLAUDE.md']);

  // AC8 U11: cancelled → one t:ticket line
  assert.equal((await runTb(['cancel', id], tbd)).code, 0);
  await until(() => ticketLines(tbd).some((m) => m.ticket === id), 10_000, 't:ticket');
  const m = ticketLines(tbd).filter((x) => x.ticket === id);
  assert.equal(m.length, 1);
  assert.deepEqual({ ...m[0], phase_minutes: Object.keys(m[0].phase_minutes).sort() }, {
    t: 'ticket', ticket: id, kind: 'code', tag: 'acme/api', outcome: 'cancelled', rounds: 4, decisions: { you: 3, ticket: 0, adr: 0, planner: 1 },
    rework: 0, interventions: 0, phase_minutes: ['planning', 'working'], pr_edited: null, fix_of: null,
  });
  assert.ok(Object.values(m[0].phase_minutes).every(Number.isInteger));
});

test('J5: an approval-made child is assigned by tbd once its blockers are merged; not before; Irfan\'s own backlog ticket never; an auto-assign failure waits (assign_failed, one alert, no retry). J13: a cancelled blocker → blocker_cancelled, one alert, Irfan\'s assign goes on. J12/U9 negatives: approve/reject outside plan_approval → 409; a linked env file, a dirty worktree, HEAD off base_sha → setup_failed; U10: setup made a CLAUDE.md then failed, reject → planning runs', async (t) => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'main');
  fs.symlinkSync('/etc/hosts', path.join(dir, '.env.link'));
  const wtAt = () => { // a worktree detached at base
    const w = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
    git(dir, 'worktree', 'add', '-q', '--detach', w, base);
    return w;
  };
  const [wt, wtDirty, wtHead, wtRej, wtRace] = [wtAt(), wtAt(), wtAt(), wtAt(), wtAt()];
  fs.writeFileSync(path.join(wtDirty, 'junk.txt'), 'x\n');
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.npmrc\n');
  fs.writeFileSync(path.join(wtRace, '.npmrc'), 'registry=https://example.invalid/\n'); // S2: ignored, planted before approve
  git(wtHead, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'off base');
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [result(QUESTIONS)] })); // t_kid001's planning
  // t_rjct01 after the reject (its comment is locked: R1C; J17: the result may leave it out) and t_kid004 after Irfan's
  // assign, either order
  for (const n of [2, 3]) fs.writeFileSync(path.join(scn, `${n}.json`), JSON.stringify({ steps: [result(QUESTIONS)] }));
  const kid = { state: 'backlog', tag: 'acme/api', auto_assign: true };
  const approval = (tag, worktree) => ({ state: 'plan_approval', tag, base_sha: base, worktree });
  const tbd = await boot(t, {
    t_dep003: { state: 'done', pr: { merged_at: NOW } },
    t_dep004: { state: 'final_gate', pr: { merged_at: null } },
    t_kid001: { ...kid, blocked_by: ['t_dep003'] },
    t_kid002: { ...kid, blocked_by: ['t_dep004'] },
    t_kid003: { ...kid, tag: 'acme/nobase' },
    t_man001: { state: 'backlog', tag: 'acme/api' },
    t_kid004: { ...kid, blocked_by: ['t_dep003', 't_cncl01'] },
    t_cncl01: { state: 'cancelled' },
    t_envl01: approval('acme/envlink', wt),
    t_dirt01: approval('acme/api', wtDirty),
    t_head01: approval('acme/api', wtHead),
    t_rjct01: approval('acme/setupfail', wtRej),
    t_race01: approval('acme/slow', wtRace),
  }, {
    files: {
      'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main' }, 'acme/nobase': { type: 'git', path: dir, base: 'nope' }, 'acme/envlink': { type: 'git', path: dir, base: 'main', env_files: ['.env.link'] },
        'acme/setupfail': { type: 'git', path: dir, base: 'main', setup: 'mkdir -p node_modules/x && echo m > node_modules/x/CLAUDE.md && exit 1' },
        'acme/slow': { type: 'git', path: dir, base: 'main', setup: 'sleep 2' } },
      ...Object.fromEntries(['t_envl01', 't_dirt01', 't_head01', 't_rjct01', 't_race01'].map((id) => [`tickets/${id}/rounds/01-plan.json`, PLAN])),
    },
    env: { FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  await until(() => read(tbd, 't_kid001').state === 'clarify', 30_000, 'child assigned by tbd, planned');
  assert.deepEqual([read(tbd, 't_kid001').base_sha, read(tbd, 't_kid001').worktree], [base, path.join(tbd.tbHome, 'worktrees', 't_kid001')]);
  await until(() => read(tbd, 't_kid003').waiting?.reason === 'assign_failed', 10_000, 'assign_failed');
  assert.match(read(tbd, 't_kid003').waiting.error, /tag acme\/nobase fails doctor: base branch nope not found/);
  // U9 J12: a linked env file, a dirty worktree, HEAD off base_sha are refused (no branch); the approve and reject guards
  const failing = ['t_envl01', 't_dirt01', 't_head01', 't_rjct01'];
  for (const id of failing) assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`)).status, 202, id);
  await until(() => failing.every((id) => read(tbd, id).waiting?.reason === 'setup_failed'), 20_000, 'setup_failed');
  assert.match(read(tbd, 't_envl01').waiting.error, /^env file "\.env\.link": not a plain file inside /);
  assert.match(read(tbd, 't_dirt01').waiting.error, /^worktree .* is not clean:\n\?\? junk\.txt/);
  assert.match(read(tbd, 't_head01').waiting.error, /^worktree .* is at [0-9a-f]{12}, not base_sha [0-9a-f]{12}/);
  // U10: setup made node_modules/x/CLAUDE.md, then failed: tbd's own (baseline), so the next planning run starts
  assert.match(read(tbd, 't_rjct01').waiting.error, /^setup .* failed \(exit 1\)/);
  assert.equal((await tbd.api('POST', '/api/tickets/t_rjct01/reject', { comment: 'retry' })).status, 200);
  await until(() => read(tbd, 't_rjct01').state !== 'planning', 30_000, 'planning after reject ended');
  assert.equal(read(tbd, 't_rjct01').state, 'clarify', JSON.stringify(read(tbd, 't_rjct01').lease));
  // M3: a reject while the approve's setup runs → 409 (checked in the store write), the approve goes on to working.
  // S2: the ignored .npmrc planted before the approve is gone (reset + clean before setup), setup still ran
  assert.equal((await tbd.api('POST', '/api/tickets/t_race01/approve', { n: 1 })).status, 202);
  const late = await tbd.api('POST', '/api/tickets/t_race01/reject', { comment: 'too late' });
  assert.deepEqual([late.status, /setup of the approved plan is running/.test(late.json.error)], [409, true], late.json.error);
  await until(() => read(tbd, 't_race01').state === 'working', 30_000, 'race: working');
  assert.equal(fs.existsSync(path.join(wtRace, '.npmrc')), false, 'S2: the planted ignored file is gone');
  // J13: the cancelled blocker holds the auto-assign (one alert)
  await until(() => read(tbd, 't_kid004').waiting?.reason === 'blocker_cancelled', 10_000, 'blocker_cancelled');
  assert.equal(read(tbd, 't_kid004').waiting.blocker, 't_cncl01');
  for (const op of ['approve', 'reject']) {
    const r = await tbd.api('POST', `/api/tickets/t_kid002/${op}`, op === 'reject' ? { comment: 'no' } : undefined);
    assert.deepEqual([r.status, /backlog/.test(r.json.error)], [409, true], `${op}: ${r.json.error}`);
  }
  await new Promise((r) => setTimeout(r, 2500)); // more ticks: no retry, no assign of a blocked or manual ticket
  assert.deepEqual(['t_kid002', 't_kid003', 't_man001'].map((x) => [read(tbd, x).state, read(tbd, x).waiting?.reason ?? null]),
    [['backlog', null], ['backlog', 'assign_failed'], ['backlog', null]]);
  assert.equal(alerts(tbd).filter((a) => a.title === 'Auto-assign failed').length, 1);
  assert.equal(fs.existsSync(path.join(tbd.tbHome, 'worktrees', 't_kid002')), false);
  // J13: ticks later still backlog, still one alert; Irfan's assign treats the cancelled blocker as cleared
  assert.deepEqual([read(tbd, 't_kid004').state, alerts(tbd).filter((a) => a.title === 'Blocker cancelled').length], ['backlog', 1]);
  const man = await tbd.api('POST', '/api/tickets/t_kid004/assign');
  assert.deepEqual([man.status, man.json.ticket?.state], [200, 'planning'], JSON.stringify(man.json));
});

// ---- P4e (contract J15 J16 J17) -------------------------------------------------------------------------------------
test('J15 J16 J17 runner: a rule broken at base_sha → resumed once with the reason → the fixed plan taken, decisions.json = locked ∪ result (left out by it); seed ## Tag block; TB_PHASE + plan ctx reach the run; a run that dirties its worktree → Blocked, one alert, result not taken; folder tag: no git rules, no clean check', async (t) => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'scenario.json\n'); // the fake's per-ticket scenario sits in each worktree
  const base = git(dir, 'rev-parse', 'main');
  const wtAt = () => {
    const w = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
    git(dir, 'worktree', 'add', '-q', '--detach', w, base);
    return w;
  };
  const [wtRule, wtDirty] = [wtAt(), wtAt()];
  const L1 = { id: 'R1Q1', text: 'Page size? → 50', source: 'answer:R1Q1' };
  fs.writeFileSync(path.join(wtRule, 'scenario.json'), JSON.stringify({ steps: [result({ ...PLAN, tasks: [{ ...PLAN.tasks[0], files: ['lib/nope/x.js'] }] })], resume_steps: [result(PLAN)] }));
  fs.writeFileSync(path.join(wtDirty, 'scenario.json'), JSON.stringify({ steps: [{ exec: ['/usr/bin/touch', 'escaped.txt'] }, result(PLAN)] }));
  fs.writeFileSync(path.join(wtDirty, 'pre.txt'), 'a failed setup left this before the round\n'); // dirty at round start: not the planner's
  const notes = fs.mkdtempSync(path.join(ROOT, 'notes-'));
  const tags = { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main', checks: { unit: 'npm test', lint: 'npm run lint' }, context: ['docs/arch.md'], skills: ['learning'] }, 'acme/notes': { type: 'folder', path: notes } };
  const FOLDER_Q = { ...QUESTIONS, facts: ['notes.md: in no repo'] };
  const tbd = await boot(t, {
    t_rule01: { tag: 'acme/api', base_sha: base, worktree: wtRule, locked_decisions: [L1] },
    t_dirt02: { tag: 'acme/api', base_sha: base, worktree: wtDirty },
    t_fold01: { tag: 'acme/notes', scenario: { steps: [result(FOLDER_Q)] } },
  }, { files: { 'tags.json': tags }, env: { FAKE_CLAUDE_SCENARIO: 'scenario.json' } }); // <cwd>/scenario.json
  const ids = ['t_rule01', 't_dirt02', 't_fold01'];
  await until(() => ids.every((id) => read(tbd, id).lease?.exit && !read(tbd, id).lease.pending && read(tbd, id).state !== 'planning'), 60_000, 'every ticket left planning');
  assert.deepEqual(ids.map((id) => read(tbd, id).state), ['plan_approval', 'blocked', 'clarify']);
  const prompt = (id, n) => fs.readFileSync(tk(tbd, id, 'runs', `${n}.prompt`), 'utf8');

  // J15 runner = authoritative: plan-rules' git check (worktree + base_sha from the ticket) refused run 1, the resume fixed it
  assert.equal(prompt('t_rule01', 2), `${SCHEMA_PROMPT}\n\ntasks[0].files[0] "lib/nope/x.js": neither the file nor its folder exists at base`);
  assert.deepEqual(json(tk(tbd, 't_rule01', 'rounds', '01-plan.json')), PLAN);
  assert.deepEqual(json(tk(tbd, 't_rule01', 'decisions.json')), [L1], 'J17: locked L1 merged though the plan left it out');
  // J16 seed: the ## Tag block (folder tags too, no base)
  const seed = prompt('t_rule01', 1);
  assert.ok(seed.includes('## Tag\n\ntag: acme/api (git, base main)\nchecks: unit = npm test, lint = npm run lint\ncontext files: docs/arch.md\ndefault skills: learning\ninstalled skills: learning\n\n## System now'), seed);
  assert.ok(prompt('t_fold01', 1).includes('## Tag\n\ntag: acme/notes (folder)\nchecks: (none)\ncontext files: (none)\ndefault skills: (none)\ninstalled skills: learning\n'));
  // J15 J16: the run gets TB_PHASE (bash-guard) and TB_PLAN_CTX (plan-check hook) = runs/1.plan-ctx.json, tbd's ctx
  const d = tbd.dumps().find((x) => x.prompt === seed);
  assert.deepEqual([d.env.TB_PHASE, d.env.TB_PLAN_CTX], ['planning', tk(tbd, 't_rule01', 'runs', '1.plan-ctx.json')]);
  assert.deepEqual(json(d.env.TB_PLAN_CTX), { locked: [L1], must_ask: false, skills: ['learning'], base_sha: base, cwd: wtRule });

  // J16: the run wrote to its worktree → Blocked, its result not kept, one alert naming the file
  const k = read(tbd, 't_dirt02');
  assert.deepEqual([k.blocked_from, k.lease.exit, k.lease.error], ['planning', 'result', 'worktree changed during planning (it is read-only): ?? escaped.txt']);
  assert.equal(fs.existsSync(tk(tbd, 't_dirt02', 'rounds')), false);
  await until(() => alerts(tbd).some((a) => a.title === 'Planning changed its worktree'), 5000, 'escaped alert'); // it follows the Blocked save
  assert.deepEqual(alerts(tbd).filter((a) => a.title === 'Planning changed its worktree').map((a) => a.message), [`t_dirt02: ?? escaped.txt: check ${wtDirty} by hand, then Resume or Cancel`]);
  // folder tag: no worktree, so no path rule (notes.md exists nowhere) and no clean check; the result is taken
  assert.deepEqual(json(tk(tbd, 't_fold01', 'facts.json')), FOLDER_Q.facts);
});
