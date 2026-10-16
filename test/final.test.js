'use strict';
// M5.3 lane A (contract .omc/handoffs/m5-contract.md rev 4 C10 C11 C12 C13; D-0089 D-0090 D-0092 D-0105 D-0106): the final
// gate through a real tbd (harness temp HOME + TB_HOME, port 0) with the real code/working + code/final_gate handlers,
// test/fake-claude.js as claude_bin and scripted gates (test/helpers/fake-gates.js, steps under `final`). Each ticket has
// its own worktree + branch of one repo and its own tag (the QA lock is per tag); a final review run's scenario is
// <worktree>/scenario.json (ignored by the repo), so every ticket scripts its own runs. Tickets start in final_gate after
// QA (qa/01.json, a QA rec file, the mirrored QA report), or in a later state seeded as tbd would leave it. Fixture phase
// dir: the real settings.json + result.schema.json, stub prompts. Kills only through run-spy.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, FAKE_GATES, REPO } = require('./helpers/tbd');
const { cloneAt, fetchHead } = require('../lib/util');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['working', 'review', 'qa', 'final_gate']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
// Admission always yes: this 8 GB Mac's free RAM must not decide a test.
const NEED = { planning: 0, working: 0, review: 0, qa: 0, final_gate: 0 };
const CONFIG = { claude_bin: FAKE, max_concurrent: 6, memory: { min_free_gb: 0, phase_need_gb: NEED, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } };
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

const PLAN = {
  kind: 'plan', summary: 'users by id', acceptance: [{ id: 'A1', text: 'GET /users/:id returns that user', type: 'new' }],
  tasks: [{ id: 'T1', title: 'users by id', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'new', test_cmd: 'npm test', steps: ['do it'] }],
  allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: [], decisions: [],
};
const OWNER = { name: 'Tag Owner', email: 'owner@example.com' };

// one repo for every ticket of a test: base commit (a doc tracked in docs/verification; scenario.json + .env.test ignored)
function repo() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.test\nscenario.json\n');
  fs.mkdirSync(path.join(dir, 'docs', 'verification'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'verification', 'tracked.md'), 'tracked at base\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env.test'), 'SECRET=1\n');
  return { dir, base: git(dir, 'rev-parse', 'main') };
}
// id's worktree on branch tb/<id> from base, with `commits` commits (author `author`; files: [path, text] each)
function branch(r, id, { files = [['src/users.js', 'module.exports = { byId: (id) => ({ id }) };\n']], author = 't <t@t>' } = {}) {
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(r.dir, 'worktree', 'add', '-q', '-b', `tb/${id}`, wt, r.base);
  for (const [f, text] of files) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
    git(wt, 'add', f);
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', `--author=${author}`, '-m', `change ${f}`);
  }
  return { wt, branch: `tb/${id}`, head: git(wt, 'rev-parse', 'HEAD') };
}
// H2.1: the same on the ticket's own clone (util.cloneAt at base, then `switch -c` as approve does) → + its pin
async function cloned(r, id, o = {}) {
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'wt-'))), 'w');
  const common_dir = fs.realpathSync(path.join(r.dir, '.git'));
  const pin = { common_dir, ...(await cloneAt(common_dir, wt, r.base)) };
  git(wt, 'switch', '-q', '-c', `tb/${id}`);
  for (const [f, text] of o.files ?? [['src/users.js', 'module.exports = { byId: (id) => ({ id }) };\n']]) {
    fs.writeFileSync(path.join(wt, f), text);
    git(wt, 'add', f);
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `change ${f}`);
  }
  return { wt, branch: `tb/${id}`, head: git(wt, 'rev-parse', 'HEAD'), pin };
}
const tag = (r, over = {}) => ({ type: 'git', path: r.dir, base: 'main', env_files: ['.env.test'], ...over });
const C = (id, over = {}) => ({ id, type: 'backend', kind: 'positive', source: 'A1', acceptance: ['A1'], pre: '', steps: ['GET /users/1'], expect: '200', result: 'PASS', recs: [], screenshots: [], observed: { note: '' }, ...over });
// T1 done; gate: the working gate green
const work = (r, b, gate = { gen: 0, kind: 'working', ok: true }) => ({ task: null, tasks: [{ id: 'T1', status: 'done', attempt: 1, pre: r.base, head: b.head }], tries: 0, unit_ms: null, scope: {}, denied: {}, gate });
// a code ticket in final_gate after QA 1 (round 5); over: any field
const flow = (id, r, b, over = {}) => ticket(id, {
  state: 'final_gate', tag: `acme/${id}`, title: 'users by id', base_sha: r.base, worktree: b.wt, branch: b.branch, round: 6, plan_hash: sha256(canon(PLAN)),
  config_baseline: { tripwire: { lock: null, bin: sha256('') } }, review: { n: 1, head: b.head, open: [] },
  qa: { n: 1, head: b.head, verdict: 'pass', pass: 2, fail: 0, blocked: 0, report: 'docs/verification/qa.md' },
  work: work(r, b), ...over,
});
// seeded files of a ticket after QA 1: the frozen plan, qa/01.json, one rec of that QA round, the mirrored QA report
const qaFiles = (id, P = 4100) => ({
  [`tickets/${id}/plan.json`]: PLAN,
  [`tickets/${id}/qa/01.json`]: { n: 1, at: '2026-10-14T00:00:00.000Z', round: 5, verdict: 'pass', report: 'docs/verification/qa.md', findings: [], need_review: [],
    cases: [C('TC-1', { recs: ['1.1'], observed: { status: 200, note: '' }, evidence: 'captured by tbd' }), C('TC-2', { kind: 'negative', type: 'frontend', evidence: 'agent-made' })] },
  [`tickets/${id}/runs/1.rec.jsonl`]: [{ meta: true, ticket: id, run: 1, phase: 'qa', round: 5, gen: 1 },
    { n: '1.1', at: '2026-10-14T00:00:00.000Z', method: 'GET', url: `http://127.0.0.1:${P}/users/1`, req: { headers: [], body: null, truncated: false }, res: { status: 200, headers: [], body: '{"id":"1"}', truncated: false }, ms: 2 }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n',
  [`tickets/${id}/docs/verification/qa.md`]: '# QA\n\n**Verdict:** PASS\n',
});
const SUMMARY = { title: 'Users by id', description: 'GET /users/:id returns the user.\nIt was missing.', worked_on: ['src/users.js: byId'], blocker: 'none', need_review: 'none', verdict: 'shipped' };
const out = (over = {}) => ({ verdict: 'pass', findings: [], verdict_doc: 'docs/verdicts/v.md', verification_doc: 'docs/verification/f.md', summary: SUMMARY, ...over });
const F = (id, severity, over = {}) => ({ id, severity, confidence: 'high', where: 'src/users.js:1', problem: `${id} problem`, failure_scenario: `${id} input`, fix: `${id} fix`, ...over });
// a final review run (TB_PHASE final_gate only): writes both docs, returns the result; any other phase hangs (a fix session)
const WRITE = { exec: ['/bin/sh', '-c', '[ "$TB_PHASE" = final_gate ] || exit 0; mkdir -p docs/verdicts && printf "# Verdict\\n\\nPASS\\n" > docs/verdicts/v.md && printf "# Final\\n\\n**Verdict:** PASS\\n" > docs/verification/f.md'] };
const review = (o, resume = o) => ({ steps: [WRITE, { result: { structured_output: o } }], resume_steps: [WRITE, { result: { structured_output: resume } }] });
const ALL = path.join(ROOT, 'scenario-hang.json');
fs.writeFileSync(ALL, JSON.stringify({ steps: [{ hang: true }] }));

// tickets {id: ticket.json}; scenarios {id: scenario}: into the ticket's worktree; files: extra TB_HOME files
async function boot(t, { tickets, tags, scenarios = {}, files = {}, config = CONFIG, gates = {} }) {
  for (const [id, s] of Object.entries(scenarios)) fs.writeFileSync(path.join(tickets[id].worktree, 'scenario.json'), JSON.stringify(s));
  for (const k of Object.values(tickets)) if (!scenarios[k.id] && k.worktree) fs.copyFileSync(ALL, path.join(k.worktree, 'scenario.json'));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const tbd = await startTbd({
    files: {
      'config.json': config, 'tags.json': { acme: {}, ...tags }, ...files,
      ...Object.fromEntries(Object.entries(tickets).map(([id, k]) => [`tickets/${id}/ticket.json`, k])),
      ...Object.fromEntries(Object.entries(gates).map(([id, g]) => [`fake-gates/${id}.json`, g])),
    },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES}`, TEST_REAL_HANDLERS: '1', TEST_PRESSURE: 'normal', FAKE_CLAUDE_DUMP_DIR: dumps, FAKE_CLAUDE_SCENARIO: 'scenario.json' },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  const has = (f) => fs.existsSync(f);
  return {
    tbd, k: (id) => read(tbd, id),
    mem: async (id) => (await tbd.api('GET', `/api/tickets/${id}`)).json?.ticket, // the daemon's view (store.save: disk first)
    dumps: () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dumps, f), 'utf8'))),
    alerts: () => (has(path.join(tbd.tbHome, 'test-alerts.jsonl')) ? lines(path.join(tbd.tbHome, 'test-alerts.jsonl')) : []),
    calls: () => (has(path.join(tbd.tbHome, 'fake-gates.jsonl')) ? lines(path.join(tbd.tbHome, 'fake-gates.jsonl')) : []),
    journal: (id) => lines(tk(tbd, id, 'work.jsonl')),
  };
}

test('F1 F3b F3c F3d D-0106: final checks green → the final review on another model than review → pass → one squash commit (parent base, the tested tree, the summary as message) by the tag ident on a push tag, need_review line for the tested author, evidence appended to the mirrored verdict doc → waiting close + 1 alert; a non-push tag squashes as the tested author and numbers final-pre-<n> after final/NN.json', async (t) => {
  const r = repo();
  const [a, b] = ['t_fin101', 't_fin102'];
  const ba = branch(r, a);
  const bb = branch(r, b, { author: 'Dev One <dev@example.com>' });
  git(r.dir, 'update-ref', `refs/tb/${b}/final-pre-1`, r.base); // an earlier squash's ref (rework at close kept it)
  const { tbd, k, dumps, alerts, journal } = await boot(t, {
    tickets: { [a]: flow(a, r, ba), [b]: flow(b, r, bb) },
    tags: { [`acme/${a}`]: tag(r, { ident: OWNER, push: { remote: 'mirror' } }), [`acme/${b}`]: tag(r) },
    files: {
      ...qaFiles(a), ...qaFiles(b), [`tickets/${b}/final/01.json`]: { n: 1, verdict: 'pass', summary: SUMMARY },
      // M3: residuals tbd puts in summary.md itself: QA need_review, the review's medium-confidence + non-cheap LOW findings
      [`tickets/${a}/qa/01.json`]: { .../** @type {any} */ (qaFiles(a)[`tickets/${a}/qa/01.json`]), need_review: ['TC-2 screenshot only'] },
      [`tickets/${a}/review/01.json`]: { n: 1, verdict: 'pass', closed: [], findings: [F('R1', 'MED', { confidence: 'medium' }), F('R2', 'LOW'), F('R3', 'LOW', { cheap: true }), F('R4', 'HIGH')] },
    },
    gates: { [a]: { final: [{ checks: [{ check: 'e2e', ok: true, exit: 0, timed_out: false, ms: 9, flaky: false, log: null, tail: 'Tests: 3 passed' }] }] } },
    scenarios: { [a]: review(out({ findings: [F('F9', 'HIGH', { confidence: 'medium' }), F('F8', 'LOW')] })), [b]: review(out()) },
  });
  await until(() => [a, b].every((id) => k(id).waiting?.reason === 'close'), 60_000, 'both waiting close');
  const p = k(a);
  assert.deepEqual([p.state, p.final.n, p.final.tested_sha, p.final.verdict], ['final_gate', 1, ba.head, 'pass']);
  const sha = p.final.sha;
  assert.notEqual(sha, ba.head, 'a one-commit ticket on first entry squashes (the full path), never adopts');
  assert.deepEqual([git(ba.wt, 'rev-parse', 'HEAD'), git(r.dir, 'rev-parse', ba.branch), git(r.dir, 'rev-parse', `refs/tb/${a}/final-pre-1`)], [sha, sha, ba.head]);
  assert.equal(git(r.dir, 'rev-list', '--parents', '-n', '1', sha), `${sha} ${r.base}`, 'one commit on base');
  assert.equal(git(r.dir, 'rev-parse', `${sha}^{tree}`), git(r.dir, 'rev-parse', `${ba.head}^{tree}`), 'the tested tree');
  assert.equal(git(r.dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', sha), 'Tag Owner <owner@example.com>|Tag Owner <owner@example.com>');
  assert.equal(git(r.dir, 'log', '-1', '--format=%B', sha), `${SUMMARY.title}\n\n${SUMMARY.description}`);
  assert.deepEqual(alerts().filter((x) => x.message.startsWith(a)).map((x) => x.title), ['Ready to close'], 'exactly one alert');
  const models = dumps().filter((d) => d.env.TB_PHASE === 'final_gate').map((d) => d.opts['--model']);
  assert.ok(models.length >= 2 && models.every((m) => m === 'opus'), `final review on opus (review: fable by default), got ${models}`);
  const seed = dumps().find((d) => d.env.TB_PHASE === 'final_gate' && d.cwd === fs.realpathSync(ba.wt)).prompt;
  for (const x of [`the whole change: git diff ${r.base}..${ba.head}`, '- TC-1 positive backend PASS [captured by tbd] A1: 200', '# QA\n\n**Verdict:** PASS',
    '## Final checks\n\n- e2e: pass — Tests: 3 passed', `verdict doc: docs/verdicts/`]) assert.ok(seed.includes(x), `seed: ${x}`);
  const sum = fs.readFileSync(tk(tbd, a, 'summary.md'), 'utf8');
  assert.match(sum, /^\*\*Title:\*\* Users by id\n\n\*\*Description:\*\* GET \/users\/:id/);
  assert.match(sum, /\*\*Need Review:\*\* none\nThe squash is authored as the tag ident Tag Owner <owner@example\.com>; the tested commits were by t <t@t>/);
  for (const x of ['- QA 1 need review: TC-2 screenshot only', '- review 1 R1 MED (medium) src/users.js:1: R1 problem', '- review 1 R2 LOW (high) src/users.js:1: R2 problem',
    '- final F9 HIGH (medium) src/users.js:1: F9 problem']) assert.ok(sum.includes(`\n${x}\n`), `M3 summary.md need review: ${x}`);
  assert.doesNotMatch(sum, /R3|R4|F8/, 'a cheap LOW, a high-confidence finding of the review, a final high-confidence LOW: not residuals');
  const doc = fs.readFileSync(tk(tbd, a, 'docs', 'verdicts', 'v.md'), 'utf8');
  assert.ok(doc.startsWith('# Verdict\n\nPASS\n\n\n## Evidence (captured by tbd)\n'), 'the agent\'s prose, then tbd\'s section');
  assert.match(doc, /\| TC-1 \| positive \| PASS \| captured by tbd \|\n\| TC-2 \| negative \| PASS \| agent-made \|/);
  assert.match(doc, /#### rec 1\.1\n\n```\ncurl 'http:\/\/127\.0\.0\.1:4100\/users\/1'\n```\n\nstatus: 200\n\n```\n\{"id":"1"\}\n```/);
  assert.match(doc, /### Final checks\n\n- e2e: pass — Tests: 3 passed/);
  assert.deepEqual(journal(a).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok, l.do]), [['final', true, 'final']]);
  assert.deepEqual(fs.readdirSync(path.join(ba.wt, 'docs', 'verification')), ['tracked.md'], 'D-0101: the untracked docs left the worktree');
  assert.equal(fs.existsSync(path.join(ba.wt, 'docs', 'verdicts')), false);
  // b: a non-push tag without ident → the tested author; n = 2 after the kept final/01.json, final-pre-1 untouched
  const q = k(b);
  assert.deepEqual([q.final.n, git(r.dir, 'rev-parse', `refs/tb/${b}/final-pre-2`), git(r.dir, 'rev-parse', `refs/tb/${b}/final-pre-1`)], [2, bb.head, r.base]);
  assert.equal(git(r.dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', q.final.sha), 'Dev One <dev@example.com>|Dev One <dev@example.com>');
  assert.doesNotMatch(fs.readFileSync(tk(tbd, b, 'summary.md'), 'utf8'), /tag ident/, 'no ident line without a tag ident');
});

test('F2 C4 C11: final checks red (work) → fix 1 as @fx1 back in working, brief = the checks\' why; a blocking final review → @fx1, brief = its blocking + cheap LOW findings; fixes already 3 → Blocked waiting final (both kinds), the result kept; verdict ≠ the blocking rule → refused, resumed, refused → Blocked, nothing kept', async (t) => {
  const r = repo();
  const ids = ['t_fin201', 't_fin202', 't_fin203', 't_fin204', 't_fin205'];
  const [ga, gb, ra, rb, mm] = ids;
  const br = Object.fromEntries(ids.map((id) => [id, branch(r, id)]));
  const red = { final: [{ ok: false, class: 'work', why: 'e2e: exit 1\nTests: 1 failed (users 404)' }] };
  const blockOut = out({ verdict: 'block', findings: [F('F1', 'HIGH'), F('F2', 'LOW', { cheap: true }), F('F3', 'MED', { confidence: 'medium' })], summary: { ...SUMMARY, verdict: 'blocked' } });
  const { tbd, k, dumps, journal } = await boot(t, {
    tickets: Object.fromEntries(ids.map((id) => [id, flow(id, r, br[id], [gb, rb].includes(id) ? { fixes: 3 } : {})])),
    tags: Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r)])),
    files: Object.fromEntries(ids.flatMap((id) => Object.entries(qaFiles(id)))),
    gates: { [ga]: red, [gb]: red },
    scenarios: { [ra]: review(blockOut), [rb]: review(blockOut), [mm]: review(out({ findings: [F('F1', 'HIGH')] })) },
  });
  const fix = (id) => dumps().find((d) => d.cwd === fs.realpathSync(br[id].wt) && d.prompt.includes('## Your task: @fx1'));
  await until(() => fix(ga) && fix(ra) && [gb, rb, mm].every((id) => k(id).state === 'blocked') && k(rb).lease?.exit && k(mm).lease?.exit, 60_000, 'fix sessions started, the others blocked');
  for (const id of [ga, ra]) assert.deepEqual([k(id).fixes, journal(id).filter((l) => l.t === 'task').map((l) => l.id)], [1, ['@fx1']], id);
  assert.match(journal(ga).find((l) => l.t === 'task').brief, /^The final checks found these problems \(fix 1 of 3\)\. Fix them, commit, return done:\n\ne2e: exit 1\nTests: 1 failed \(users 404\)$/);
  const brief = journal(ra).find((l) => l.t === 'task').brief;
  assert.match(brief, /^The final review 1 found 1 blocking finding\(s\) \(fix 1 of 3\)/);
  assert.ok(brief.includes('- F1 HIGH (high) src/users.js:1: F1 problem') && brief.includes('Also fix these small ones while you are there:\n- F2 LOW'), brief);
  assert.doesNotMatch(brief, /F3/, 'a medium-confidence finding never blocks nor rides along');
  assert.ok(fix(ra).prompt.includes('F1 problem'), 'the fix session gets the brief');
  assert.equal(JSON.parse(fs.readFileSync(tk(tbd, ra, 'final', '01.json'), 'utf8')).verdict, 'block', 'a blocking result is kept');
  assert.equal(k(ra).final.verdict, undefined, 'final.n / verdict only with a pass (C1)');
  for (const id of [gb, rb]) {
    const p = k(id);
    assert.deepEqual([p.blocked_from, p.fixes, p.waiting?.reason], ['final_gate', 3, 'final'], id);
    assert.match(p.waiting.why, /fix 4.*max 3 per ticket/, id);
    assert.equal(journal(id).some((l) => l.t === 'task'), false, `${id}: no fix task`);
  }
  assert.ok(fs.existsSync(tk(tbd, rb, 'final', '01.json')), 'the 4th fix\'s result is kept');
  const m = k(mm);
  assert.deepEqual([m.blocked_from, m.lease.exit], ['final_gate', 'schema_fail']);
  assert.match(m.lease.error, /verdict must be block: F1 block/);
  assert.match(dumps().find((d) => d.cwd === fs.realpathSync(br[mm].wt) && d.opts['--resume']).prompt, /verdict must be block: F1 block/, 'resumed with the reason');
  assert.equal(fs.existsSync(tk(tbd, mm, 'final')), false, 'a refused result is never kept');
  assert.equal(fs.existsSync(path.join(br[mm].wt, 'docs', 'verdicts')), false, 'D-0101: the retry refused, the visit over: its docs out of the worktree');
});

test('F3 F3b F3c F3d F8 D-0105: squash refusals → Blocked config (HEAD past the tested commit, a docs dir path in base..tested, a push tag without ident with the fix hint, a Claude ident, an empty fallback email); a redo with final-pre-<n> already set → ok; a squash a crash left → adopted on boot, one by another author (SEC-7) → Blocked config; a tracked change at the gate start → Blocked integrity, an untracked leftover → the gate runs', async (t) => {
  const r = repo();
  const ids = ['t_sq3001', 't_sq3002', 't_sq3003', 't_sq3004', 't_sq3005', 't_sq3006', 't_sq3007', 't_sq3008', 't_cr3001', 't_cr3002'];
  const [past, docs, noid, ai, empty, redo, adopt, forged, tracked, untracked] = ids;
  const br = {
    [past]: branch(r, past), [docs]: branch(r, docs, { files: [['src/users.js', 'x\n'], ['docs/verdicts/old.md', 'committed\n']] }), [noid]: branch(r, noid),
    [ai]: branch(r, ai), [empty]: branch(r, empty, { author: 't <>' }), [redo]: branch(r, redo), [adopt]: branch(r, adopt), [forged]: branch(r, forged), [tracked]: branch(r, tracked), [untracked]: branch(r, untracked),
  };
  const tested = Object.fromEntries(ids.map((id) => [id, br[id].head]));
  git(br[past].wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'after the checks');
  git(r.dir, 'update-ref', `refs/tb/${redo}/final-pre-1`, tested[redo]); // a redo: the ref made, the rest not
  // F8: tbd died after the branch update (squash made by the tag ident with the summary message, refs moved), before
  // the ticket write. SEC-7: the same refs, the commit by another ident (another agent of the tag in that window)
  const crash = (id, who) => {
    const c = execFileSync('/usr/bin/git', ['-C', r.dir, 'commit-tree', `${tested[id]}^{tree}`, '-p', r.base, '-m', SUMMARY.title, '-m', SUMMARY.description],
      { encoding: 'utf8', env: { ...gitEnv, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } }).trim();
    git(r.dir, 'update-ref', `refs/tb/${id}/final-pre-1`, tested[id]);
    git(r.dir, 'update-ref', `refs/heads/${br[id].branch}`, c, tested[id]);
    return c;
  };
  const crashed = crash(adopt, OWNER);
  const other = crash(forged, { name: 'Mallory', email: 'm@example.com' });
  fs.appendFileSync(path.join(br[tracked].wt, 'src', 'users.js'), '// edited by hand\n');
  fs.writeFileSync(path.join(br[untracked].wt, 'qa.log'), 'left by QA\n');
  // a pass recorded by the handler (G3), the squash still to come: the next hook's
  const passed = (id) => flow(id, r, br[id], { final: { tested_sha: tested[id], n: 1, verdict: 'pass' }, work: work(r, br[id], { gen: 1, kind: 'final', ok: true, n: 1 }),
    lease: { gen: 2, pid: null, lstart: '', pgid: null, phase: 'final_gate', round: 6, session: null, log: null, exit: 'result', started_at: '2026-10-14T00:00:00.000Z', ended_at: '2026-10-14T00:01:00.000Z' } });
  const { k, alerts, calls } = await boot(t, {
    tickets: { ...Object.fromEntries(ids.slice(0, 8).map((id) => [id, passed(id)])), [tracked]: flow(tracked, r, br[tracked]), [untracked]: flow(untracked, r, br[untracked]) },
    tags: {
      ...Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r, { ident: OWNER })])), [`acme/${noid}`]: tag(r, { push: { remote: 'mirror' } }),
      [`acme/${ai}`]: tag(r, { ident: { name: 'Claude', email: 'noreply@anthropic.com' } }), [`acme/${empty}`]: tag(r),
    },
    files: Object.fromEntries(ids.flatMap((id) => [...Object.entries(qaFiles(id)), [`tickets/${id}/final/01.json`, { n: 1, verdict: 'pass', summary: SUMMARY }]])),
  });
  const blocked = [past, docs, noid, ai, empty, forged, tracked];
  await until(() => blocked.every((id) => k(id).state === 'blocked') && [redo, adopt].every((id) => k(id).waiting?.reason === 'close') && calls().some((c) => c.ticket === untracked), 60_000, 'squashes decided');
  const why = (id) => [k(id).waiting?.reason, k(id).waiting?.why];
  assert.match(why(past).join(' '), /^config HEAD [0-9a-f]{12} is not the tested commit/);
  assert.match(why(docs).join(' '), /^config docs\/verdicts\/old\.md: docs dirs are never committed/);
  assert.deepEqual(why(noid), ['config', `squash ident: ident not set: run tb doctor --tag acme/${noid} --ident`]);
  assert.match(why(ai).join(' '), /^config squash ident: the tag ident names Claude or Anthropic \(D34\)/);
  assert.match(why(empty).join(' '), /^config squash ident: the commit ident is no git name \+ email/);
  for (const id of [past, docs, noid, ai, empty]) assert.equal(git(r.dir, 'rev-parse', br[id].branch), git(br[id].wt, 'rev-parse', 'HEAD'), `${id}: no squash`);
  assert.equal(git(r.dir, 'rev-parse', br[docs].branch), tested[docs], 'branch untouched');
  // F3c: the redo squashes once, the ref as it was
  const rd = k(redo);
  assert.deepEqual([git(r.dir, 'rev-parse', `refs/tb/${redo}/final-pre-1`), git(r.dir, 'rev-list', '--parents', '-n', '1', rd.final.sha)], [tested[redo], `${rd.final.sha} ${r.base}`]);
  // F8: adopted, no second commit
  assert.equal(k(adopt).final.sha, crashed);
  assert.equal(git(r.dir, 'rev-parse', br[adopt].branch), crashed);
  assert.match(why(forged).join(' '), /^config HEAD [0-9a-f]{12} is not the tested commit [0-9a-f]{12} nor its squash \(the tag ident, the summary as message\)/, 'SEC-7');
  assert.deepEqual([k(forged).final.sha, git(r.dir, 'rev-parse', br[forged].branch)], [undefined, other], 'never adopted');
  assert.deepEqual(alerts().filter((x) => x.title === 'Ready to close').map((x) => x.message.slice(0, 8)).sort(), [adopt, redo].sort());
  // D-0105
  assert.deepEqual(why(tracked), ['integrity', `final checks integrity: tracked changes at the final gate:  M src/users.js: nobody commits there`]);
  assert.equal(calls().some((c) => c.ticket === tracked), false, 'the gate never ran on a tracked change');
  assert.notEqual(k(untracked).state, 'blocked', 'an untracked leftover is the gate\'s to clean');
});

test('F4 C13: tb close → done (one intervention, no push); refused: not squashed, a parent with an open child (n/m), Restart / Resume at close; rework at close → working (@rw1), final gone, push keeps ok_sha, fixes kept; refused once a dependent started', async (t) => {
  const r = repo();
  const ids = ['t_cl4001', 't_cl4002', 't_cl4003', 't_cl4004', 't_cl4005'];
  const [ok, nosha, parent, rw, dep] = ids;
  const br = Object.fromEntries(ids.map((id) => [id, branch(r, id)]));
  const close = (id, over = {}) => flow(id, r, br[id], {
    final: { n: 1, tested_sha: br[id].head, sha: br[id].head, at: '2026-10-14T00:00:00.000Z', verdict: 'pass' }, waiting: { reason: 'close', since: '2026-10-14T00:00:00.000Z' }, fixes: 2,
    lease: { gen: 2, pid: null, lstart: '', pgid: null, phase: 'final_gate', round: 6, session: null, log: null, exit: 'result', started_at: '2026-10-14T00:00:00.000Z', ended_at: '2026-10-14T00:01:00.000Z' }, ...over,
  });
  const { tbd, mem } = await boot(t, {
    tickets: {
      [ok]: close(ok), [nosha]: close(nosha, { final: { n: 1, tested_sha: br[nosha].head, verdict: 'pass' } }), [parent]: close(parent, { children: ['t_kid401'] }),
      t_kid401: ticket('t_kid401', { state: 'clarify', parent, tag: `acme/${parent}` }),
      [rw]: close(rw, { push: { state: 'ok', remote: 'mirror', ref: `refs/heads/${br[rw].branch}`, sha: br[rw].head, ok_sha: br[rw].head, at: '2026-10-14T00:00:00.000Z', why: 'x' } }),
      [dep]: close(dep), t_dep401: ticket('t_dep401', { state: 'clarify', blocked_by: [dep], tag: `acme/${dep}` }),
    },
    tags: Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r)])),
    files: Object.fromEntries(ids.map((id) => [`tickets/${id}/plan.json`, PLAN])),
  });
  const post = (id, op, body = {}) => tbd.api('POST', `/api/tickets/${id}/${op}`, body);
  const done = await post(ok, 'close');
  assert.deepEqual([done.status, done.json.ticket.state], [200, 'done']);
  assert.deepEqual(lines(tk(tbd, ok, 'interventions.jsonl')).map((l) => [l.actor, l.verb]), [['cli', 'close']]);
  const no = async (id, op, re, body = {}) => {
    const x = await post(id, op, body);
    assert.equal(x.status, 409, `${id} ${op}`);
    assert.match(x.json.error, re, `${id} ${op}`);
  };
  await no(nosha, 'close', /not ready to close: the final gate has not passed/);
  await no(parent, 'close', /waits for its children: 0\/1 done or cancelled/);
  await no(nosha, 'restart', /squashed, waiting for close/);
  await no(nosha, 'resume', /squashed, waiting for close/);
  await no(ok, 'close', /done → done is not allowed/);
  await no(dep, 'rework', /cancel children first/, { feedback: 'more' });
  const back = await post(rw, 'rework', { feedback: 'rename byId' });
  assert.equal(back.status, 200);
  const p = back.json.ticket;
  assert.deepEqual([p.state, p.final, p.push, p.fixes, p.work.task], ['working', undefined, { remote: 'mirror', ref: `refs/heads/${br[rw].branch}`, ok_sha: br[rw].head, at: '2026-10-14T00:00:00.000Z' }, 2, '@rw1']);
  assert.deepEqual([(await mem(dep)).state, (await mem(nosha)).waiting?.reason, (await mem(parent)).state], ['final_gate', 'close', 'final_gate'], 'the refused ones stayed');
});

test('M5.3 D-0105 pre-admit: the final gate job needs no run slot: it runs while run admission says memory; its green result then waits memory, no final review spawned', async (t) => {
  const r = repo();
  const id = 't_adm001';
  const b = branch(r, id);
  const { k, calls } = await boot(t, {
    tickets: { [id]: flow(id, r, b) }, tags: { [`acme/${id}`]: tag(r) }, files: qaFiles(id),
    config: { ...CONFIG, memory: { ...CONFIG.memory, phase_need_gb: { ...NEED, final_gate: 9999 } } },
  });
  await until(() => k(id).work?.gate?.ok === true && k(id).waiting?.reason === 'memory', 30_000, 'gate green, then waiting memory');
  assert.deepEqual(calls().filter((c) => c.ticket === id).map((c) => c.fn), ['final']);
  assert.deepEqual([k(id).state, k(id).lease, k(id).final.tested_sha], ['final_gate', null, b.head], 'no final review run');
});

// M5.3 D-0105 stuck path: QA may edit a tracked doc (its tree pin allows docs); the visit's end (docs.clean) puts it back
// to HEAD after the mirror took the edited copy, so the final gate that follows meets no tracked change
test('M5.3 docs.clean: QA edits the tracked docs/verification/tracked.md → after the QA visit the worktree file is HEAD\'s, the mirror holds the edit, the final checks run (no Blocked integrity)', async (t) => {
  const r = repo();
  const id = 't_qtd001';
  const b = branch(r, id);
  const report = path.join(ROOT, 'qa-report.md');
  fs.writeFileSync(report, '# QA\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n**Verdict:** PASS\n');
  const QA_EXEC = { exec: ['/bin/sh', '-c', `[ "$TB_PHASE" = qa ] || exit 0; echo "edited by QA" >> docs/verification/tracked.md && cp "${report}" docs/verification/qa.md`] };
  const cases = [C('TC-1', { type: 'frontend' }), C('TC-2', { type: 'frontend', kind: 'negative' })];
  const { tbd, k, journal } = await boot(t, {
    tickets: { [id]: flow(id, r, b, { state: 'qa', qa: undefined }) }, tags: { [`acme/${id}`]: tag(r) }, files: { [`tickets/${id}/plan.json`]: PLAN },
    scenarios: { [id]: { steps: [QA_EXEC, { result: { structured_output: { verdict: 'pass', cases, report: 'docs/verification/qa.md', findings: [] } } }] } },
  });
  await until(() => journal(id).some((l) => l.t === 'gate' && l.kind === 'final'), 60_000, 'the final checks ran');
  assert.deepEqual(journal(id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok, l.do]), [['final', true, 'final']]);
  assert.equal(fs.readFileSync(path.join(b.wt, 'docs', 'verification', 'tracked.md'), 'utf8'), 'tracked at base\n', 'back to HEAD');
  assert.equal(fs.readFileSync(tk(tbd, id, 'docs', 'verification', 'tracked.md'), 'utf8'), 'tracked at base\nedited by QA\n', 'the mirror kept the edit');
  assert.notEqual(k(id).waiting?.reason, 'integrity');
});

// M5.3 FA (code + security review fixes): the final review's verdict doc + summary refused in code, the final gate's
// tracked-change check content-based (SEC-2: a forged index stat cache)
const docExec = (doc) => ({ exec: ['/bin/sh', '-c', '[ "$TB_PHASE" = final_gate ] || exit 0; mkdir -p docs/verdicts && printf "%s" "$1" > docs/verdicts/v.md && printf "# Final\\n" > docs/verification/f.md', 'sh', doc] });
const reviewDoc = (doc, retry = doc, o = out()) => ({ steps: [docExec(doc), { result: { structured_output: o } }], resume_steps: [docExec(retry), { result: { structured_output: o } }] });
const { index: forgeIndex, blob: forgeBlob } = require('./helpers/forge'); // SEC-2 / C1 probes (H1)

test('M5.3 FA M1 SEC-5 SEC-2: a verdict doc with tbd\'s Evidence heading, a fence left open (an even count of fence lines) or an HTML comment left open, is refused, resumed, refused → Blocked; the fence closed on the retry → taken; an env file value in the summary → refused → Blocked; a forged index stat cache at the gate start → Blocked integrity naming the file, no checks run', async (t) => {
  const r = repo();
  const ENVVAL = ['tok', '9f8e7d6c5b'].join('-'); // built: a literal next to a key word trips gitleaks generic-api-key
  fs.writeFileSync(path.join(r.dir, '.env.test'), `SECRET=1\nAPI_TOKEN=${ENVVAL}\n`);
  const ids = ['t_fa1001', 't_fa1002', 't_fa1003', 't_fa1004', 't_fa1005'];
  const [head, fenced, secret, forge, comment] = ids;
  const br = Object.fromEntries(ids.map((id) => [id, branch(r, id)]));
  forgeIndex(br[forge].wt, 'src/users.js', 'module.exports = { byId: () => ({ id: "evil" }) };\n');
  assert.equal(git(br[forge].wt, 'status', '--porcelain', '--untracked-files=no'), '', 'the probe hides the change from git status');
  const OPEN = '# Verdict\n\n````text\nx\n```\n';
  const { tbd, k, dumps, calls } = await boot(t, {
    tickets: Object.fromEntries(ids.map((id) => [id, flow(id, r, br[id])])),
    tags: Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r)])),
    files: Object.fromEntries(ids.flatMap((id) => Object.entries(qaFiles(id)))),
    scenarios: {
      [head]: reviewDoc('# Verdict\n\nPASS\n\n## Evidence (captured by tbd)\n\nall green\n'),
      [fenced]: reviewDoc(OPEN, `${OPEN}\`\`\`\`\n\n~~~\n\`\`\`\n~~~\n`),
      [comment]: reviewDoc('# Verdict\n\n<!-- a note --> PASS\n\n<!-- hidden from here on\n'),
      [secret]: reviewDoc('# Verdict\n', undefined, out({ summary: { ...SUMMARY, description: `uses API_TOKEN ${ENVVAL}` } })),
    },
  });
  await until(() => [head, secret, forge, comment].every((id) => k(id).state === 'blocked') && [head, secret, comment].every((id) => k(id).lease?.exit) && k(fenced).waiting?.reason === 'close', 60_000, 'refusals blocked, the closed fence taken');
  for (const [id, re] of /** @type {[string, RegExp][]} */ ([[head, /verdict_doc: line "## Evidence \(captured by tbd\)": tbd appends the Evidence \(captured by tbd\) section itself/], [secret, /summary holds a secret value of the tag's env files/],
    [comment, /verdict_doc: an HTML comment <!-- is never closed with -->/]])) {
    assert.deepEqual([k(id).blocked_from, k(id).lease.exit], ['final_gate', 'schema_fail'], id);
    assert.match(k(id).lease.error, re, id);
    assert.equal(fs.existsSync(tk(tbd, id, 'final')), false, `${id}: a refused result is never kept`);
  }
  assert.doesNotMatch(k(secret).lease.error, new RegExp(ENVVAL), 'the refusal never repeats the value');
  const retry = dumps().find((d) => d.cwd === fs.realpathSync(br[fenced].wt) && d.opts['--resume']);
  assert.match(retry.prompt, /verdict_doc: a code fence opened with ```` is never closed/, 'resumed with the reason');
  assert.equal(k(fenced).final.n, 1);
  assert.deepEqual([k(forge).waiting?.reason, k(forge).waiting?.why], ['integrity', 'final checks integrity: tracked changes at the final gate:  M src/users.js: nobody commits there']);
  assert.equal(calls().some((c) => c.ticket === forge), false, 'no check ran on a tree that is not HEAD');
});

// H2.5 C1 on clone tickets: the final gate fetches HEAD into the tag repo (refs/tb/<id>/head = tested), the squash reads
// and writes the tag's objects (trusted, never saved) and sets the tag repo's branch by CAS (F13: tag_tip); a blob the agent
// rewrote → the fetch refused → Blocked integrity; the tag branch already elsewhere → Blocked config. H3 (D-0153): a
// summary naming NODE_ENV's value (development) is taken. H6 (C4): <!-- inside a closed fence with no tag-like prose →
// taken; a prose <div>, or a `- <div>` list item, before a fence holding <!-- → the whole doc checked → refused
test('H2.5 F13 H3 H6: clone squash → tag refs/tb/<id>/head = tested, tag branch = final.sha = tag_tip, no trusted key, a "development" summary taken; rewritten blob → Blocked integrity; tag branch moved → Blocked config; <!-- in a closed fence taken, after a prose or list-item <div> refused', async (t) => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.env.test'), 'SECRET=1\nNODE_ENV=development\n');
  const ids = ['t_h25001', 't_h25002', 't_h25003', 't_h6c001', 't_h6c002', 't_h6c003'];
  const [ok, bad, moved, fenced, div, item] = ids;
  // bad's blob is its own (one the tag repo already holds, e.g. ok's, is never sent: the tag's real copy is read)
  const cl = Object.fromEntries(await Promise.all([ok, bad, moved].map(async (id) => [id, await cloned(r, id, id === bad ? { files: [['src/users.js', 'module.exports = { bad: 1 };\n']] } : {})])));
  forgeBlob(cl[bad].wt, 'src/users.js', 'evil content\n'); // the agent rewrote its own commit's blob
  git(r.dir, 'update-ref', `refs/heads/tb/${moved}`, r.base); // the tag branch made outside tbd
  const br = { ...cl, ...Object.fromEntries([fenced, div, item].map((id) => [id, branch(r, id)])) };
  const DEV = { ...SUMMARY, description: 'GET /users/:id returns the user, in development too.' };
  const { tbd, k } = await boot(t, {
    tickets: Object.fromEntries(ids.map((id) => [id, flow(id, r, br[id], br[id].pin ?? {})])),
    tags: Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r)])),
    files: Object.fromEntries(ids.flatMap((id) => Object.entries(qaFiles(id)))),
    scenarios: {
      [ok]: review(out({ summary: DEV })), [moved]: review(out()),
      [fenced]: reviewDoc('# Verdict\n\nPASS\n\n```html\n<!-- a sample comment\n```\n'),
      [div]: reviewDoc('# Verdict\n\n<div>\n\n```\n<!-- in a fence\n```\n'),
      [item]: reviewDoc('# Verdict\n\n- <div>\n\n  ```\n  <!-- in a fence\n  ```\n'),
    },
  });
  await until(() => [ok, fenced].every((id) => k(id).waiting?.reason === 'close') && [bad, moved, div, item].every((id) => k(id).state === 'blocked') && [div, item].every((id) => k(id).lease?.exit), 60_000, 'squashed, blocked, refused');
  const p = k(ok);
  assert.deepEqual([git(r.dir, 'rev-parse', `refs/tb/${ok}/head`), git(r.dir, 'rev-parse', `refs/heads/${br[ok].branch}`), p.tag_tip, git(br[ok].wt, 'rev-parse', 'HEAD')],
    [br[ok].head, p.final.sha, p.final.sha, p.final.sha], 'tested head fetched; the squash on the tag branch, the clone branch and tag_tip');
  assert.equal(git(r.dir, 'rev-list', '--parents', '-n', '1', p.final.sha), `${p.final.sha} ${r.base}`, 'one commit on base, in the tag repo\'s objects');
  assert.equal(git(r.dir, 'log', '-1', '--format=%B', p.final.sha), `${DEV.title}\n\n${DEV.description}`);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(tk(tbd, ok, 'ticket.json'), 'utf8')), 'trusted'), false, 'trusted is never saved');
  assert.deepEqual([k(bad).waiting.reason, /HEAD not fetched into the tag repo: .*did not receive expected object/.test(k(bad).waiting.why)], ['integrity', true], k(bad).waiting.why);
  assert.deepEqual([k(moved).waiting.reason, k(moved).final.sha, git(r.dir, 'rev-parse', `refs/heads/tb/${moved}`)], ['config', undefined, r.base]);
  assert.match(k(moved).waiting.why, new RegExp(`^tag branch tb/${moved} moved outside tbd`));
  for (const id of [div, item]) assert.match(k(id).lease.error, /verdict_doc: an HTML comment <!-- is never closed with -->/, id);
});

// C-M5 (+) H2.3 F13 + F8: a clone squash a crash left after step 5 (the tag repo's branch set to the squash, tbd dead
// before the ticket write: no final.sha, no tag_tip) → adopted on boot: the tag CAS from no tag_tip is refused, the branch
// is already at the squash → done, never Blocked config (the "moved outside tbd" case is H2.5's `moved` above)
test('C-M5 F8 F13: a clone squash crashed after the tag branch CAS → adopted on boot: the refused CAS finds the branch at the squash → waiting close, final.sha = tag_tip = the squash, one alert', async (t) => {
  const r = repo();
  const id = 't_cr3003';
  const b = await cloned(r, id);
  const tested = b.head;
  await fetchHead({ id, worktree: b.wt, ...b.pin }, tested); // the final gate fetched it
  const sq = execFileSync('/usr/bin/git', ['-C', r.dir, 'commit-tree', `${tested}^{tree}`, '-p', r.base, '-m', SUMMARY.title, '-m', SUMMARY.description],
    { encoding: 'utf8', env: { ...gitEnv, GIT_AUTHOR_NAME: OWNER.name, GIT_AUTHOR_EMAIL: OWNER.email, GIT_COMMITTER_NAME: OWNER.name, GIT_COMMITTER_EMAIL: OWNER.email } }).trim();
  git(b.wt, 'update-ref', `refs/tb/${id}/final-pre-1`, tested); // steps 4 in the clone: its refs
  git(b.wt, 'update-ref', `refs/heads/${b.branch}`, sq, tested);
  git(r.dir, 'update-ref', `refs/heads/${b.branch}`, sq, ''); // step 5: the tag branch made
  const lease = { gen: 2, pid: null, lstart: '', pgid: null, phase: 'final_gate', round: 6, session: null, log: null, exit: 'result', started_at: '2026-10-14T00:00:00.000Z', ended_at: '2026-10-14T00:01:00.000Z' };
  const { k, alerts } = await boot(t, {
    tickets: { [id]: flow(id, r, b, { ...b.pin, final: { tested_sha: tested, n: 1, verdict: 'pass' }, work: work(r, b, { gen: 1, kind: 'final', ok: true, n: 1 }), lease }) },
    tags: { [`acme/${id}`]: tag(r, { ident: OWNER }) },
    files: { ...qaFiles(id), [`tickets/${id}/final/01.json`]: { n: 1, verdict: 'pass', summary: SUMMARY } },
  });
  await until(() => k(id).waiting?.reason === 'close' || k(id).state === 'blocked', 60_000, 'squash decided');
  const p = k(id);
  assert.deepEqual([p.state, p.waiting.reason, p.final.sha, p.tag_tip, git(r.dir, 'rev-parse', `refs/heads/${b.branch}`), git(b.wt, 'rev-parse', 'HEAD')], ['final_gate', 'close', sq, sq, sq, sq], JSON.stringify(p.waiting));
  await until(() => alerts().some((x) => x.title === 'Ready to close'), 10_000, 'alert');
  assert.equal(alerts().filter((x) => x.title === 'Ready to close').length, 1);
});

test('M5.3 FA M2: a final review edits the tracked docs/verification/tracked.md and ends without a result (max_turns) → Blocked; Resume → the doc back to HEAD at the gate start, the final checks run green (no Blocked integrity)', async (t) => {
  const r = repo();
  const id = 't_fa2001';
  const b = branch(r, id);
  const EDIT = { exec: ['/bin/sh', '-c', '[ "$TB_PHASE" = final_gate ] || exit 0; echo "edited by the final review" >> docs/verification/tracked.md && mkdir -p docs/verdicts && echo x > docs/verdicts/v.md'] };
  const { tbd, k, mem, journal } = await boot(t, {
    tickets: { [id]: flow(id, r, b) }, tags: { [`acme/${id}`]: tag(r) }, files: qaFiles(id),
    scenarios: { [id]: { steps: [EDIT, 'max_turns'] } },
  });
  await until(async () => (await mem(id))?.state === 'blocked', 60_000, 'Blocked after max_turns');
  assert.equal(git(b.wt, 'status', '--porcelain', '--', 'docs/verification/tracked.md'), 'M docs/verification/tracked.md', 'the run left its edit');
  fs.copyFileSync(ALL, path.join(b.wt, 'scenario.json')); // the next final review hangs
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/resume`, {})).status, 202);
  const gates = () => journal(id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok, l.do]);
  await until(() => gates().length === 2, 60_000, 'the final checks ran again');
  assert.deepEqual(gates(), [['final', true, 'final'], ['final', true, 'final']]);
  assert.equal(fs.readFileSync(path.join(b.wt, 'docs', 'verification', 'tracked.md'), 'utf8'), 'tracked at base\n', 'back to HEAD');
  assert.equal(fs.existsSync(path.join(b.wt, 'docs', 'verdicts')), false, 'the unfinished run\'s untracked doc gone');
  assert.notEqual(k(id).state, 'blocked');
});

test('M5.3 FA L1 + C10 coverage: Restart during the final gate job → 409, the job runs on (one green gate); a scope ask and a policy ask → Blocked config (nobody is asked at the final gate); interrupted → pending again, then green', async (t) => {
  const r = repo();
  const ids = ['t_fa3001', 't_fa3002', 't_fa3003', 't_fa3004'];
  const [rs, scope, policy, intr] = ids;
  const br = Object.fromEntries(ids.map((id) => [id, branch(r, id)]));
  const { tbd, k, calls, journal } = await boot(t, {
    tickets: Object.fromEntries(ids.map((id) => [id, flow(id, r, br[id])])),
    tags: Object.fromEntries(ids.map((id) => [`acme/${id}`, tag(r)])),
    files: Object.fromEntries(ids.flatMap((id) => Object.entries(qaFiles(id)))),
    gates: {
      [rs]: { final: [{ sleep_ms: 4000 }] }, [scope]: { final: [{ allow: ['src/other.js'] }] },
      [policy]: { final: [{ ok: false, class: 'policy', ask: { kind: 'policy', files: ['package.json'], reason: 'a new dependency' }, why: 'policy: a new dependency' }] },
      [intr]: { final: [{ ok: false, class: 'interrupted', why: 'aborted: memory' }] },
    },
  });
  await until(() => calls().some((c) => c.ticket === rs), 30_000, 'the slow gate job runs');
  const x = await tbd.api('POST', `/api/tickets/${rs}/restart`, {});
  assert.equal(x.status, 409);
  assert.match(x.json.error, /no final_gate run yet: it starts on its own/);
  const gates = (id) => journal(id).filter((l) => l.t === 'gate').map((l) => [l.kind, l.ok, l.do]);
  await until(() => gates(rs).length && gates(intr).length === 2 && [scope, policy].every((id) => k(id).state === 'blocked'), 60_000, 'gates decided');
  assert.deepEqual([gates(rs), calls().filter((c) => c.ticket === rs).length], [[['final', true, 'final']], 1], 'L1: never halted (no interrupted line, one call)');
  for (const [id, re] of /** @type {[string, RegExp][]} */ ([[scope, /^final checks scope: outside: src\/other\.js \(nobody is asked at the final gate/], [policy, /^final checks policy: policy: a new dependency \(nobody is asked/]])) {
    assert.equal(k(id).waiting?.reason, 'config', id);
    assert.match(k(id).waiting.why, re, id);
  }
  assert.deepEqual(gates(intr), [['final', false, 'gate'], ['final', true, 'final']], 'interrupted: no try used, run again');
});

// M4 in-process: a real store on its own TB_HOME, no runner (runner.decide calls the next hook every tick, unawaited)
test('M5.3 FA M4: two next() calls back to back on a pass not squashed yet → the 2nd returns at once (no squash of its own), then one squash commit, waiting close, one alert, never Blocked', async () => {
  const r = repo();
  const id = 't_fa4001';
  const b = branch(r, id);
  const home = fs.mkdtempSync('/private/tmp/tbe-fa4-');
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (f, v) => { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), JSON.stringify(v)); };
  put(`tickets/${id}/ticket.json`, flow(id, r, b, { final: { tested_sha: b.head, n: 1, verdict: 'pass' },
    lease: { gen: 2, pid: null, lstart: '', pgid: null, phase: 'final_gate', round: 6, session: null, log: null, exit: 'result', started_at: '2026-10-14T00:00:00.000Z', ended_at: '2026-10-14T00:01:00.000Z' } }));
  put(`tickets/${id}/final/01.json`, { n: 1, verdict: 'pass', findings: [], summary: SUMMARY });
  put('tags.json', { acme: {}, [`acme/${id}`]: tag(r, { ident: OWNER }) });
  process.env.TB_HOME = home; // store reads it at load: nothing in this file required lib/ before
  const store = require('../lib/store');
  store.init();
  const final = require('../lib/final');
  const alerts = [];
  const api = { alert: (/** @type {any} */ a) => alerts.push(a) };
  const first = final.next(structuredClone(store.getTicket(id)), api);
  assert.equal(await final.next(structuredClone(store.getTicket(id)), api), undefined);
  assert.equal(git(r.dir, 'rev-parse', b.branch), b.head, 'the 2nd call returned at once, no squash of its own (the 1st one still runs)');
  await first;
  const k = store.getTicket(id);
  assert.deepEqual([k.state, k.waiting?.reason, git(r.dir, 'rev-list', '--count', `${r.base}..${b.branch}`)], ['final_gate', 'close', '1']);
  assert.equal(git(r.dir, 'rev-parse', b.branch), k.final.sha);
  assert.deepEqual(alerts.map((a) => a.title), ['Ready to close']);
});
