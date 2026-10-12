'use strict';
// P5c (contract rev 4.1 K1 K2 K3 M9 M12 M15 T2 RO6, "UI parity in P5", plan P5 AC9 AC11): the HTTP routes + tb verbs of
// the working verbs, tb pass and the drawer's reads, on a real tbd (harness temp HOME + TB_HOME, port 0) with seeded
// tickets: no agent runs (every agent phase unbuilt here: a ticket that reaches one waits manual). Fixture phases:
// code/final_gate built (run-spy registers its handler), everything else unbuilt. A temp git repo stands in for the
// tag's: base → docs-only commit → the squash (src/a.js) on main; the ticket's branch changes src/a.js too.
// tbd.js itself wires lib/pass's watcher + boot scan (P5 Wire): AC11 fails without those lines.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { startTbd, runTb, phaseFixture, PHASE_FILES } = require('./helpers/tbd');
const { RUN_SPY, ticket, read, lines, until } = require('./helpers/runs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5routes-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = phaseFixture(path.join(ROOT, 'phases'), { 'code/final_gate': PHASE_FILES });
const ENV = { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY };
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.appendFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const ivs = (tbd, id) => lines(tk(tbd, id, 'interventions.jsonl')).map((l) => [l.actor, l.verb, l.task]);
const XSS = '<img src=x onerror=alert(1)>';

// The tag's repo: base → docs only (no shared path) → the squash on main; worktree on branch tb/t_par001-work changes
// src/a.js; an orphan commit (no parent).
const repo = path.join(ROOT, 'repo');
fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
const base = commit(repo, 'src/a.js', 'a\n', 'base');
const other = commit(repo, 'docs/x.md', 'x\n', 'docs only');
const squash = commit(repo, 'src/a.js', 'squash\n', 'feat: the squash');
const wt = path.join(ROOT, 'wt');
git(repo, 'worktree', 'add', '-q', '--detach', wt, base);
git(wt, 'switch', '-qc', 'tb/t_par001-work');
const tip = commit(wt, 'src/a.js', 'branch\n', 'work on the branch');
const orphan = execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', git(repo, 'rev-parse', `${base}^{tree}`), '-m', 'orphan'], { encoding: 'utf8', env: gitEnv }).trim();
const DIRS = { worktree: wt, base_sha: base, branch: 'tb/t_par001-work', git_dir: fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir')), common_dir: fs.realpathSync(path.join(repo, '.git')) };
const TAGS = { acme: {}, 'acme/api': { type: 'git', path: repo, base: 'main' }, 'acme/leak': { type: 'git', path: repo, base: 'main', leak_check: true } };
const WORK = (over = {}) => ({ task: 'T1', tasks: [{ id: 'T1', status: 'running', attempt: 1, pre: base, head: null, commit: null, session: 's1' }], tries: 0, unit_ms: null, scope: {}, denied: {}, gate: null, ...over });
const T = (id, over = {}) => ticket(id, { kind: 'research', tag: 'acme/api', round: 4, ...DIRS, ...over });
const jsonl = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

// cookie caller: tb open's cookie + same-origin; csrf: the synchronizer token (or a forged / no one)
async function browser(tbd) {
  const cookie = await tbd.unlock();
  const csrf = (await tbd.api('GET', '/api/session/csrf', undefined, { 'x-tb-token': undefined, cookie })).json.csrf;
  const h = (x = csrf) => ({ 'x-tb-token': undefined, cookie, 'sec-fetch-site': 'same-origin', ...(x !== null && { 'x-tb-csrf': x }) });
  return { csrf, h, post: (p, body, x = csrf) => tbd.api('POST', p, body, h(x)), get: (p) => tbd.api('GET', p, undefined, h()) };
}

const POLICY_PLAN = { kind: 'plan', summary: 's', acceptance: [], tasks: [{ id: 'T1', title: 't', files: ['src/a.js'], modules: ['src'], blocked_by: [], acceptance: [], type: 'preserve', test_cmd: null, steps: [] }], allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: [], decisions: [] };
const POLICY_HASH = crypto.createHash('sha256').update(canon(POLICY_PLAN)).digest('hex');
const policy = (id, round) => ({
  [`tickets/${id}/ticket.json`]: T(id, { state: 'clarify', round, clarify_origin: { phase: 'working', task: null, why: 'drop', class: 'policy' }, plan_hash: POLICY_HASH, plan_hashes: [POLICY_HASH],
    work: WORK({ task: null, tasks: [{ id: 'T1', status: 'done', attempt: 1, pre: base, head: tip }], gate: { gen: 0, kind: 'working', n: 1, ok: false, class: 'policy' } }) }),
  [`tickets/${id}/plan.json`]: POLICY_PLAN,
  [`tickets/${id}/gates/01.json`]: { v: 1, gate: 'working', ok: false, class: 'policy', checks: [], schema: [{ op: 'drop', ref: 'User.nickname', allowed: false }], api: [], ask: { kind: 'policy', changes: ['drop User.nickname'], reason: 'r' }, why: 'policy' },
  [`tickets/${id}/work.jsonl`]: jsonl({ t: 'ask', task: null, round, kind: 'policy', n: 1, changes: ['drop User.nickname'], reason: 'a schema change the plan does not allow' }),
});

test('P5c routes: CSRF on the cookie verbs, RO6 cookie scope-allow 401, answer dispatch (working | planning), allow / deny-change, rework text only + tb rework --feedback-file, feedback, every verb one intervention (cli | ui)', async (t) => {
  const askLine = (kind, files) => jsonl({ t: 'ask', task: 'T1', round: 4, kind, files, reason: 'needs it' });
  const files = {
    'tags.json': TAGS,
    'tickets/t_scp001/ticket.json': T('t_scp001', { state: 'clarify', clarify_origin: { phase: 'working', task: 'T1', why: 'scripts', class: 'protected' }, work: WORK() }),
    'tickets/t_scp001/work.jsonl': askLine('protected', ['package.json']),
    'tickets/t_scp002/ticket.json': T('t_scp002', { state: 'clarify', clarify_origin: { phase: 'working', task: 'T1', why: 'extra', class: 'scope' }, work: WORK() }),
    'tickets/t_scp002/work.jsonl': askLine('scope', ['lib/extra.js']),
    'tickets/t_ans001/ticket.json': T('t_ans001', { state: 'clarify', clarify_origin: { phase: 'working', task: 'T1', why: 'q', class: 'NEEDS_CONTEXT' }, work: WORK() }),
    'tickets/t_ans001/work.jsonl': jsonl({ t: 'result', task: 'T1', status: 'NEEDS_CONTEXT', question: `${XSS} which table?`, notes: 'n' }),
    'tickets/t_pln001/ticket.json': T('t_pln001', { state: 'clarify' }),
    ...policy('t_pol001', 4), ...policy('t_pol002', 4),
    'tickets/t_rwk001/ticket.json': T('t_rwk001', { state: 'review', work: WORK({ task: null, tasks: [{ id: 'T1', status: 'done', attempt: 1, pre: base, head: tip }] }) }),
  };
  const tbd = await startTbd({ files, env: ENV });
  t.after(() => tbd.stop());
  const ui = await browser(tbd);
  const k = (id) => read(tbd, id);
  assert.match(ui.csrf, /^[0-9a-f]{64}$/);
  assert.equal((await tbd.api('GET', '/api/session/csrf', undefined, { 'x-tb-token': undefined })).status, 401, 'no session, no token');

  // CSRF: each cookie verb without the token, with a wrong one, or without Sec-Fetch-Site → 403 before the route (a
  // ticket that does not exist: a hole would answer 404); the CLI needs neither
  const CSRF_ERR = 'missing or wrong X-TB-CSRF token: reload the page';
  const VERBS = [['scope', { allow: false }], ['rework', { feedback: 'x' }], ['pass', {}], ['answer', { text: 'x' }], ['allow-change', { change: 'drop A.b' }], ['deny-change', { change: 'drop A.b' }]];
  for (const [verb, body] of VERBS) {
    for (const [h, err] of /** @type {[any, string][]} */ ([[{ 'x-tb-csrf': undefined }, CSRF_ERR], [{ 'x-tb-csrf': 'f'.repeat(64) }, CSRF_ERR], [{ 'x-tb-csrf': ui.csrf.slice(0, 63) }, CSRF_ERR],
      [{ 'x-tb-csrf': ui.csrf.toUpperCase() }, CSRF_ERR], [{ 'sec-fetch-site': undefined }, 'cross-site request refused']])) {
      const r = await tbd.api('POST', `/api/tickets/t_zzzzzz/${verb}`, body, { ...ui.h(), ...h });
      assert.deepEqual([r.status, r.json.error], [403, err], `${verb} ${JSON.stringify(h)}`);
    }
    assert.equal((await tbd.api('POST', `/api/tickets/t_zzzzzz/${verb}`, body)).status, 404, `${verb}: the token needs no CSRF`);
  }
  assert.equal(k('t_scp001').state, 'clarify');

  // RO6: a cookie allow of a protected ask → 401 (the ask's kind from tbd's journal); deny by cookie works (actor ui)
  const no = await ui.post('/api/tickets/t_scp001/scope', { allow: true });
  assert.deepEqual([no.status, no.json.error], [401, 't_scp001: allowing a protected change needs the CLI (tb scope --allow)']);
  assert.equal(fs.existsSync(tk(tbd, 't_scp001', 'interventions.jsonl')), false);
  assert.equal((await ui.post('/api/tickets/t_scp001/scope', { allow: false })).status, 200);
  assert.deepEqual([k('t_scp001').state, ivs(tbd, 't_scp001')], ['working', [['ui', 'scope-deny', 'T1']]]);
  // scope: bad bodies, --task naming another task, wrong state, bad / unknown id
  for (const body of [{}, { allow: 'yes' }, { allow: true, files: ['x'] }, { allow: true, task: 3 }]) assert.equal((await tbd.api('POST', '/api/tickets/t_scp002/scope', body)).status, 400, JSON.stringify(body));
  assert.equal((await tbd.api('POST', '/api/tickets/t_scp002/scope', { allow: true, task: 'T9' })).status, 409);
  assert.equal((await tbd.api('POST', '/api/tickets/t_rwk001/scope', { allow: true })).status, 409, 'not in clarify');
  assert.equal((await tbd.api('POST', '/api/tickets/BAD/scope', { allow: true })).status, 400);
  assert.equal((await tbd.api('POST', '/api/tickets/t_zzzzzz/scope', { allow: true })).status, 404);
  const cli = await runTb(['scope', 't_scp002', '--allow', '--task', 'T1'], tbd);
  assert.equal(cli.code, 0, cli.stdout);
  assert.match(cli.stdout, /^scope: allowed · t_scp002 · working · /);
  assert.deepEqual(JSON.parse(fs.readFileSync(tk(tbd, 't_scp002', 'scope.json'), 'utf8')).allow.T1, [{ path: 'lib/extra.js' }]);
  assert.deepEqual(ivs(tbd, 't_scp002'), [['cli', 'scope-allow', 'T1']]);
  assert.equal((await runTb(['scope', 't_scp002', '--allow', '--deny'], tbd)).code, 2);

  // M12: GET the ticket carries the open ask; tb answer with no answer prints it (exit 1); a text answer by cookie
  const g = (await tbd.api('GET', '/api/tickets/t_ans001')).json.ask;
  assert.deepEqual(g, { kind: 'NEEDS_CONTEXT', task: 'T1', question: `${XSS} which table?`, notes: 'n' });
  const open = await runTb(['answer', 't_ans001'], tbd);
  assert.equal(open.code, 1);
  assert.match(open.stdout, /^error: t_ans001 asks \(NEEDS_CONTEXT, task T1\): answer it\nreason: <img src=x onerror=alert\(1\)> which table\?\nnotes: n\nhelp: tb answer t_ans001 "<your answer>" \| --replan\n$/);
  assert.equal((await runTb(['answer', 't_ans001', 'x', '--replan'], tbd)).code, 2, 'one answer at a time');
  assert.equal((await runTb(['answer', 'run', 't_ans001', 'x'], tbd)).code, 2, 'title words never take a text answer: the id first');
  assert.equal((await ui.post('/api/tickets/t_ans001/answer', { text: 'use the users table' })).status, 200);
  assert.deepEqual([k('t_ans001').state, ivs(tbd, 't_ans001')], ['working', [['ui', 'answer', 'T1']]]);
  // a planning clarify still takes planning's answers (dispatch on clarify_origin.phase)
  const pl = await tbd.api('POST', '/api/tickets/t_pln001/answer', { text: 'x' });
  assert.deepEqual([pl.status, pl.json.error], [400, 'body must be {"answers": {"<question id>": {...}}, "plan_now"?: true|false}']);
  assert.equal((await runTb(['answer', 't_pln001', 'some text'], tbd)).code, 2, 'a text answer is for a working ask');

  // M9: allow-change only of a not-allowed change the latest working gate named (else 409); the CLI flag; deny by cookie
  assert.deepEqual((await tbd.api('GET', '/api/tickets/t_pol001')).json.ask, { kind: 'policy', task: null, files: [], changes: ['drop User.nickname'], reason: 'a schema change the plan does not allow', online: false });
  assert.equal((await tbd.api('POST', '/api/tickets/t_pol001/allow-change', { change: 'drop User.email' })).status, 409);
  assert.equal((await tbd.api('POST', '/api/tickets/t_pol001/answer', { text: 'fine' })).status, 409, 'a policy ask takes allow / deny-change or replan');
  const ac = await runTb(['answer', 't_pol001', '--allow-change', 'drop User.nickname'], tbd);
  assert.equal(ac.code, 0, ac.stdout);
  const p1 = k('t_pol001');
  assert.deepEqual([p1.state, p1.plan_file, p1.plan_hashes.length], ['working', `plan-${p1.plan_hash}.json`, 2]);
  assert.deepEqual(ivs(tbd, 't_pol001'), [['cli', 'allow-change', null]]);
  assert.equal((await tbd.api('POST', '/api/tickets/t_pol001/deny-change', { change: 'drop User.nickname' })).status, 409, 'no ask open any more');
  assert.equal((await ui.post('/api/tickets/t_pol002/deny-change', { change: 'drop User.nickname' })).status, 200);
  assert.deepEqual([k('t_pol002').state, k('t_pol002').work.task, ivs(tbd, 't_pol002')], ['working', '@fix', [['ui', 'deny-change', '@fix']]]);

  // K1: rework over HTTP takes the text only; tb rework --feedback-file reads the file itself
  for (const body of [{ feedback_file: '/etc/hosts' }, { feedback: 'x', path: '/etc/hosts' }, { feedback: 7 }, null]) {
    const r = await tbd.api('POST', '/api/tickets/t_rwk001/rework', body);
    assert.deepEqual([r.status, r.json.error], [400, 'body must be {"feedback": "<text>"}: the text itself, never a path'], JSON.stringify(body));
  }
  assert.equal((await tbd.api('POST', '/api/tickets/t_rwk001/rework', { feedback: 'x'.repeat(64 * 1024 + 1) })).status, 400, '> 64 KB');
  assert.equal((await tbd.api('POST', '/api/tickets/t_scp002/rework', { feedback: 'x' })).status, 409, 'not in review / qa / final gate');
  const fb = path.join(ROOT, 'review.md');
  fs.writeFileSync(fb, `keep it sorted ${XSS}\n`);
  const rw = await runTb(['rework', 't_rwk001', '--feedback-file', fb], tbd);
  assert.equal(rw.code, 0, rw.stdout);
  assert.match(rw.stdout, /^rework: ok · t_rwk001 · working · rework 1 · /);
  assert.deepEqual([k('t_rwk001').work.task, ivs(tbd, 't_rwk001')], ['@rw1', [['cli', 'rework', '@rw1']]]);
  assert.deepEqual((await ui.get('/api/tickets/t_rwk001/feedback/1')).json, { id: 't_rwk001', n: 1, text: `keep it sorted ${XSS}\n` });
  assert.equal((await tbd.api('GET', '/api/tickets/t_rwk001/feedback/2')).status, 404);
  fs.symlinkSync(path.join(tbd.tbHome, 'token'), tk(tbd, 't_rwk001', 'feedback-3.md'));
  assert.equal((await tbd.api('GET', '/api/tickets/t_rwk001/feedback/3')).status, 404, 'a link is never read through');
  assert.equal((await runTb(['rework', 't_rwk001', '--feedback-file', path.join(ROOT, 'missing.md')], tbd)).code, 1);

  // T2: CLI_ONLY stays CLI_ONLY; /api/state keeps its shape (no work, gates or asks in it)
  assert.equal((await tbd.api('GET', '/api/gc', undefined, { 'x-tb-token': undefined, cookie: (await tbd.unlock()) })).status, 401);
  const s = (await tbd.api('GET', '/api/state')).json;
  assert.deepEqual(Object.keys(s).sort(), ['calendar', 'flows', 'reminders', 'system']);
  assert.deepEqual(Object.keys(s.flows[0]).sort(), ['id', 'kind', 'merged_at', 'rework', 'state', 'tag', 'title', 'updated_at', 'waiting']);
});

test('P5c reads: gates newest first, paged (default 20, 1-100, cursor n), ≤ 64 KB a page (a huge one cut to fit); a check log gunzipped as a stream (no link, no path out of gates/); interventions paged by cursor', async (t) => {
  const id = 't_gat001';
  const g = (n, over = {}) => ({ v: 1, gate: 'task', ticket: id, task: 'T1', attempt: 1, ms: 5, ok: true, class: null, checks: [{ check: 'unit', ok: true, exit: 0, ms: 5, log: null, tail: '' }], why: '', ...over });
  const files = { 'tags.json': TAGS, [`tickets/${id}/ticket.json`]: T(id, { state: 'review', work: WORK({ task: null }) }) };
  for (let n = 1; n <= 25; n++) files[`tickets/${id}/gates/${String(n).padStart(2, '0')}.json`] = g(n);
  const big = 'x'.repeat(200_000);
  files[`tickets/${id}/gates/24.json`] = g(24, { ok: false, class: 'work', why: big, checks: ['unit', 'lint', 'build'].map((c) => ({ check: c, ok: false, exit: 1, ms: 9, log: null, tail: big })) });
  files[`tickets/${id}/gates/25.json`] = g(25, { checks: [{ check: 'unit', ok: true, exit: 0, ms: 5, log: 'gates/25-T1-unit.log.gz', tail: 'ok' },
    { check: 'lint', ok: true, exit: 0, ms: 5, log: '../../token', tail: '' }, { check: 'build', ok: true, exit: 0, ms: 5, log: 'gates/25-T1-build.log.gz', tail: '' },
    { check: 'bomb', ok: false, exit: 1, ms: 5, log: 'gates/25-T1-bomb.log.gz', tail: '' }] });
  files['tickets/t_ivs001/ticket.json'] = T('t_ivs001', { state: 'review' });
  files['tickets/t_ivs001/interventions.jsonl'] = `${jsonl(...[1, 2, 3].map((i) => ({ at: '2026-10-10T00:00:00.000Z', actor: 'cli', verb: 'answer', task: `T${i}`, payload_sha256: 'a' })))}{"torn\n`;
  const tbd = await startTbd({ files, env: ENV });
  t.after(() => tbd.stop());
  const log = 'line one\n'.repeat(50_000); // 450 KB unpacked
  fs.writeFileSync(tk(tbd, id, 'gates', '25-T1-unit.log.gz'), zlib.gzipSync(log));
  fs.symlinkSync(path.join(tbd.tbHome, 'token'), tk(tbd, id, 'gates', '25-T1-build.log.gz'));
  const mb = zlib.gzipSync(Buffer.alloc(1 << 20)); // 64 gzip members of 1 MB zeros: 64 MB unpacked from ~64 KB
  fs.writeFileSync(tk(tbd, id, 'gates', '25-T1-bomb.log.gz'), Buffer.concat(Array(64).fill(mb)));

  const r1 = await tbd.api('GET', `/api/tickets/${id}/gates`);
  assert.equal(r1.status, 200);
  assert.ok(Buffer.byteLength(r1.text) <= 64 * 1024, `${Buffer.byteLength(r1.text)} bytes`);
  assert.deepEqual(r1.json.items.map((x) => x.n), [25, 24, ...Array.from({ length: 18 }, (_, i) => 23 - i)], 'newest first, default 20');
  assert.equal(r1.json.next, 5);
  const cut = r1.json.items[1];
  assert.deepEqual([cut.truncated, cut.why.length, cut.checks.map((c) => c.tail.length)], [true, 1024, [512, 512, 512]], 'the huge one lost its tails, kept its checks');
  const r2 = await tbd.api('GET', `/api/tickets/${id}/gates?n=${r1.json.next}`);
  assert.deepEqual([r2.json.items.map((x) => x.n), r2.json.next], [[5, 4, 3, 2, 1], null]);
  const one = await tbd.api('GET', `/api/tickets/${id}/gates?n=24&limit=1`);
  assert.deepEqual([one.json.items.map((x) => x.n), one.json.next], [[24], 23]);
  for (const q of ['limit=0', 'limit=101', 'limit=x', 'n=-1', 'n=1.5']) assert.equal((await tbd.api('GET', `/api/tickets/${id}/gates?${q}`)).status, 400, q);
  assert.deepEqual((await tbd.api('GET', '/api/tickets/t_ivs001/gates')).json, { id: 't_ivs001', items: [], next: null });
  assert.equal((await tbd.api('GET', '/api/tickets/t_zzzzzz/gates')).status, 404);

  // the full log: streamed text, by cookie too; a check without a log, a log path out of gates/, a link → 404
  const ui = await browser(tbd);
  const full = await ui.get(`/api/tickets/${id}/gates/25/log?check=unit`);
  assert.deepEqual([full.status, full.headers['content-type'], full.text === log], [200, 'text/plain; charset=utf-8', true]);
  for (const [q, status] of /** @type {[string, number][]} */ ([['check=lint', 404], ['check=build', 404], ['check=typecheck', 404], ['check=../x', 400], ['', 400]])) {
    assert.equal((await tbd.api('GET', `/api/tickets/${id}/gates/25/log?${q}`)).status, status, q);
  }
  assert.equal((await tbd.api('GET', `/api/tickets/${id}/gates/99/log?check=unit`)).status, 404);
  const bomb = await new Promise((resolve) => { // the stream is cut past 8 MB unpacked (the client sees a short body)
    let n = 0;
    const done = () => resolve(n);
    http.request({ host: '127.0.0.1', port: tbd.port, path: `/api/tickets/${id}/gates/25/log?check=bomb`, headers: { 'x-tb-token': tbd.token }, agent: false }, (res) => {
      res.on('data', (c) => { n += c.length; }).on('end', done).on('error', done).on('aborted', done).on('close', done);
    }).on('error', done).end();
  });
  assert.ok(bomb > 0 && bomb <= 8 << 20, `${bomb} bytes`);

  // interventions: oldest first by cursor; a torn line counts, skipped
  const i1 = await tbd.api('GET', '/api/tickets/t_ivs001/interventions?limit=2');
  assert.deepEqual([i1.json.items.map((x) => x.task), i1.json.next], [['T1', 'T2'], 2]);
  const i2 = await ui.get(`/api/tickets/t_ivs001/interventions?limit=2&after=${i1.json.next}`);
  assert.deepEqual([i2.json.items.map((x) => x.task), i2.json.next], [['T3'], null]);
  for (const q of ['limit=0', 'limit=101', 'after=-1', 'after=x']) assert.equal((await tbd.api('GET', `/api/tickets/t_ivs001/interventions?${q}`)).status, 400, q);
  const cliIv = await runTb(['interventions', 't_ivs001', '--limit', '2'], tbd);
  assert.match(cliIv.stdout, /^interventions\[2\]\{at,actor,verb,task\}:\n {2}"2026-10-10T00:00:00.000Z",cli,answer,T1\n {2}"2026-10-10T00:00:00.000Z",cli,answer,T2\nhelp: tb interventions t_ivs001 --cursor 2\n$/);
  const cliG = await runTb(['gates', id, '--n', '25', '--limit', '1'], tbd);
  assert.equal(cliG.code, 0, cliG.stdout);
  assert.match(cliG.stdout, /^gates: t_gat001 · 1 shown\ngates\[1\]\{n,gate,task,attempt,result,ms,checks\}:\n {2}25,task,T1,1,green,5,unit ok lint ok build ok bomb red\ngate 25:\nchecks\[4\]/);
  assert.match(cliG.stdout, /help: tb gates t_gat001 --n 24 for older ones\n$/);
});

test('AC9 M15 tb pass table: review → qa → final gate; final unbuilt (D9, leak_check or not) → --sha checked → done + merged_at + full sha; built + leak_check parked (D26) → waiting manual cleared only; built without → 409; every refusal writes nothing', async (t) => {
  const files = {
    'tags.json': TAGS,
    'tickets/t_neg001/ticket.json': T('t_neg001', { state: 'final_gate' }),
    'tickets/t_d9nol1/ticket.json': T('t_d9nol1', { state: 'final_gate' }),
    'tickets/t_d9lek1/ticket.json': T('t_d9lek1', { state: 'final_gate', tag: 'acme/leak' }),
    'tickets/t_d26ok1/ticket.json': T('t_d26ok1', { kind: 'code', state: 'final_gate', tag: 'acme/leak', waiting: { reason: 'manual', since: '2026-10-10T00:00:00.000Z' } }),
    'tickets/t_d26no1/ticket.json': T('t_d26no1', { kind: 'code', state: 'final_gate', waiting: { reason: 'manual', since: '2026-10-10T00:00:00.000Z' } }),
    'tickets/t_rev001/ticket.json': T('t_rev001', { state: 'review' }),
    'tickets/t_bsrev1/ticket.json': T('t_bsrev1', { kind: 'brainstorm', state: 'review' }),
    'tickets/t_bkl001/ticket.json': T('t_bkl001', { state: 'backlog' }),
  };
  const tbd = await startTbd({ files, env: ENV });
  t.after(() => tbd.stop());
  const k = (id) => read(tbd, id);
  const pass = (id, body) => tbd.api('POST', `/api/tickets/${id}/pass`, body);

  // M15: the form first (no git), then commit, after base_sha, ancestry, on main, a shared path; nothing written
  for (const sha of ['XYZ', 'abc', 'ABCDEF1', 'a'.repeat(41), '--all', 'HEAD~1', '', squash.toUpperCase()]) { // all 40: an 8-char prefix is all digits ~2% of runs (flaky 200)
    const r = await pass('t_neg001', { sha });
    assert.deepEqual([r.status, r.json.error], [400, 'sha must be 7-40 lowercase hex characters (a commit id)'], String(sha));
  }
  for (const [sha, re] of /** @type {[string, RegExp][]} */ ([['1234567', /is not a commit id in acme\/api's repo/], [base, /is base_sha itself/],
    [orphan, /is not an ancestor of/], [tip, /is not on main$/], [other, /changes none of the paths tb\/t_par001-work changed since base_sha$/]])) {
    const r = await pass('t_neg001', { sha });
    assert.equal(r.status, 409, sha);
    assert.match(r.json.error, re);
  }
  assert.deepEqual([(await pass('t_neg001', {})).status, (await pass('t_neg001', { sha: squash, n: 1 })).status], [400, 400], 'D9 needs --sha; strict body');
  // refs an agent can make in the shared repo never stand in: a tag `main` on the branch tip (the base is refs/heads/main),
  // a tag named like base's prefix pointing at the squash (the resolved sha must start with what was typed)
  git(repo, 'tag', 'main', tip);
  git(repo, 'tag', base.slice(0, 7), squash);
  try {
    const shadow = await pass('t_neg001', { sha: tip });
    assert.deepEqual([shadow.status, shadow.json.error.endsWith('is not on main')], [409, true], shadow.json.error);
    for (const r of [await pass('t_neg001', { sha: base.slice(0, 7) }), await tbd.api('GET', `/api/tickets/t_neg001/pass?sha=${base.slice(0, 7)}`)]) {
      assert.deepEqual([r.status, r.json.error], [409, `t_neg001: ${base.slice(0, 7)} is not a commit id in acme/api's repo`]);
    }
  } finally {
    git(repo, 'tag', '-d', 'main', base.slice(0, 7));
  }
  assert.deepEqual([k('t_neg001').state, k('t_neg001').pr, fs.existsSync(tk(tbd, 't_neg001', 'interventions.jsonl'))], ['final_gate', undefined, false]);
  assert.equal((await runTb(['pass', 't_neg001', '--sha', 'XYZ'], tbd)).code, 2, 'the CLI checks the form too');
  // the UI's confirm: resolved + subject, nothing written
  assert.deepEqual((await tbd.api('GET', `/api/tickets/t_neg001/pass?sha=${squash.slice(0, 7)}`)).json, { sha: squash, subject: 'feat: the squash' });
  assert.equal((await tbd.api('GET', `/api/tickets/t_neg001/pass?sha=${tip}`)).status, 409);

  // D9: a short sha → the full one, done, merged_at; leak_check does not matter while final is unbuilt; by cookie: ui
  const t0 = Date.now();
  const d9 = await runTb(['pass', 't_d9nol1', '--sha', squash.slice(0, 7)], tbd);
  assert.equal(d9.code, 0, d9.stdout);
  assert.equal(d9.stdout, `pass: ok · t_d9nol1 · done · run t_d9nol1\nmerged: ${squash} · ${k('t_d9nol1').pr.merged_at}\n`);
  assert.deepEqual([k('t_d9nol1').state, k('t_d9nol1').pr.sha], ['done', squash]);
  assert.ok(Date.parse(k('t_d9nol1').pr.merged_at) >= t0 - 1000 && k('t_d9nol1').pr.merged_at.endsWith('Z'));
  assert.deepEqual(ivs(tbd, 't_d9nol1'), [['cli', 'pass', null]]);
  const ui = await browser(tbd);
  assert.equal((await ui.post('/api/tickets/t_d9lek1/pass', { sha: squash })).status, 200);
  assert.deepEqual([k('t_d9lek1').state, k('t_d9lek1').pr.sha, ivs(tbd, 't_d9lek1')], ['done', squash, [['ui', 'pass', null]]]);
  assert.equal((await pass('t_d9nol1', { sha: squash })).status, 409, 'done: nothing to pass');

  // D26: built final gate + leak_check parked → waiting cleared, state kept, no pr; a sha is refused; no leak_check → 409
  assert.equal((await pass('t_d26ok1', { sha: squash })).status, 400);
  assert.equal((await pass('t_d26ok1', {})).status, 200);
  assert.deepEqual([k('t_d26ok1').state, k('t_d26ok1').waiting, k('t_d26ok1').pr], ['final_gate', null, undefined]);
  assert.equal((await pass('t_d26ok1', {})).status, 409, 'not parked any more');
  const built = await pass('t_d26no1', {});
  assert.deepEqual([built.status, built.json.error], [409, 't_d26no1: phase code/final_gate is built; the runner moves it']);

  // review → qa → final gate (brainstorm: review → final gate); a sha before the final gate is refused
  assert.equal((await pass('t_rev001', { sha: squash })).status, 400);
  assert.equal((await pass('t_rev001', {})).status, 200);
  assert.equal(k('t_rev001').state, 'qa');
  assert.equal((await pass('t_rev001')).status, 200);
  assert.equal(k('t_rev001').state, 'final_gate');
  assert.equal((await pass('t_bsrev1', {})).status, 200);
  assert.equal(k('t_bsrev1').state, 'final_gate');
  assert.equal((await pass('t_bkl001', {})).status, 409);
  assert.equal((await pass('BAD', {})).status, 400);
  assert.equal((await pass('t_zzzzzz', {})).status, 404);
  assert.equal((await ui.post('/api/tickets/t_bsrev1/pass', {}, null)).status, 403, 'CSRF');
});

test('AC11 children: own pass → final_gate waiting children 0/2; a child done → 1/2; a grandchild blocked → one alert; cancel; tbd restarts while a finish was lost → the boot scan finishes the child, which finishes the parent (any depth)', async (t) => {
  const kid = (id, parent, over = {}) => T(id, { state: 'final_gate', parent, ...over });
  const files = {
    'tags.json': TAGS,
    'tickets/t_par001/ticket.json': kid('t_par001', null, { children: ['t_kid001', 't_kid002'] }),
    'tickets/t_kid001/ticket.json': kid('t_kid001', 't_par001'),
    'tickets/t_kid002/ticket.json': kid('t_kid002', 't_par001', { children: ['t_gkd001', 't_gkd002'] }),
    'tickets/t_gkd001/ticket.json': kid('t_gkd001', 't_kid002', { state: 'review', rework: 2, work: WORK({ task: null, tasks: [] }) }),
    'tickets/t_gkd002/ticket.json': kid('t_gkd002', 't_kid002', { state: 'blocked', blocked_from: 'review' }), // blocked before its parent waits
  };
  let tbd = await startTbd({ files, env: ENV });
  t.after(() => tbd.stop());
  const k = (id) => read(tbd, id);
  const pass = (id) => tbd.api('POST', `/api/tickets/${id}/pass`, { sha: squash });

  const own = await runTb(['pass', 't_par001', '--sha', squash], tbd);
  assert.match(own.stdout, /^pass: ok · t_par001 · final_gate · waiting children 0\/2 · /);
  const w0 = k('t_par001').waiting;
  assert.deepEqual([w0.reason, w0.done, w0.total, k('t_par001').pr.sha], ['children', 0, 2, squash]);
  const pr0 = k('t_par001').pr;
  const again = await pass('t_par001');
  assert.deepEqual([again.status, k('t_par001').pr], [409, pr0], 'a 2nd pass never rewrites merged_at');
  assert.match(again.json.error, /^t_par001: passed already/);
  assert.equal((await pass('t_kid001')).status, 200);
  await until(() => k('t_par001').waiting?.done === 1, 10_000, 'parent 1/2');
  assert.deepEqual([k('t_par001').state, k('t_par001').waiting.since], ['final_gate', w0.since], 'since kept');
  const alerts = () => lines(path.join(tbd.tbHome, 'test-alerts.jsonl')).filter((a) => a.title === 'Child ticket blocked').map((a) => a.message);
  const told = (c) => `t_kid002 run t_kid002: waits for ${c} run ${c}, which is blocked`;
  assert.equal((await pass('t_kid002')).status, 200);
  assert.deepEqual([k('t_kid002').state, k('t_kid002').waiting.done, k('t_kid002').waiting.total, k('t_kid002').waiting.blocked], ['final_gate', 0, 2, ['t_gkd002']]);
  await until(() => alerts().length === 1, 10_000, 'alert: a child blocked before the wait began');

  // a grandchild blocked later (a 3rd rework) → one alert; blocked never counts as finished; then cancelled → 1/2
  assert.equal((await tbd.api('POST', '/api/tickets/t_gkd001/rework', { feedback: 'again' })).json.ticket.state, 'blocked');
  await until(() => alerts().length === 2, 10_000, 'alert');
  assert.deepEqual([k('t_kid002').waiting.done, k('t_kid002').waiting.blocked], [0, ['t_gkd001', 't_gkd002']]);
  assert.equal((await tbd.api('POST', '/api/tickets/t_gkd001/cancel')).status, 202);
  await until(() => k('t_kid002').waiting?.done === 1, 10_000, 'child 1/2');
  assert.deepEqual(alerts(), [told('t_gkd002'), told('t_gkd001')], 'once per child');

  // a lost finish: the last grandchild cancelled while tbd was down (its watcher never ran) → the boot scan
  await tbd.stop({ keep: true });
  const f = path.join(tbd.tbHome, 'tickets', 't_gkd002', 'ticket.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), state: 'cancelled' }));
  tbd = await startTbd({ root: tbd.root, env: ENV });
  await until(() => k('t_par001').state === 'done', 10_000, 'parent done after the boot scan');
  assert.deepEqual([k('t_kid002').state, k('t_kid002').waiting, k('t_par001').waiting, k('t_par001').pr.sha], ['done', null, null, squash]);
  assert.deepEqual(ivs(tbd, 't_par001'), [['cli', 'pass', null]], 'the watcher is no intervention');
  assert.equal(alerts().length, 2, 'the boot scan told nothing again');
});

test('SSE gate event: {id, task, check, ok} only, strings cut at 64, bad input → none (RAM bound)', () => {
  const home = fs.mkdtempSync(path.join(ROOT, 'sse-'));
  process.env.TB_HOME = home;
  process.env.HOME = home;
  const { gateEvent } = require('../lib/http');
  const ev = gateEvent({ id: 't_abc123', task: 'T'.repeat(5000), check: 'c'.repeat(5000), ok: false, tail: 'x'.repeat(1e6), why: 'w' });
  const data = JSON.parse(/^event: gate\ndata: (.*)\n\n$/.exec(ev)[1]);
  assert.deepEqual(Object.keys(data), ['id', 'task', 'check', 'ok']);
  assert.deepEqual([data.task.length, data.check.length, data.ok], [64, 64, false]);
  assert.ok(Buffer.byteLength(ev) <= 256, `${Buffer.byteLength(ev)} bytes`);
  for (const bad of [null, {}, { id: '../x', ok: true }, { id: 't_abc123', ok: 'yes' }, { id: 't_abc123' }]) assert.equal(gateEvent(bad), null, JSON.stringify(bad));
});
