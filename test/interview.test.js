'use strict';
// M5.4 lane A (build doc "### A" tests; contract C18; D-0117..D-0121, D-0124): a real tbd (harness temp HOME + TB_HOME,
// port 0) with the real code/planning handler and lib/interview.js, test/fake-claude.js as claude_bin, the fake lavish
// install (test/helpers/fake-lavish.js: TB_LAVISH_DIR, run by tbd under the real lib/lavish.sb; scripted by
// TB_HOME/lavish/fake-lavish.json, calls in TB_HOME/lavish/fake-lavish.jsonl; OPENER records the urls tbd opens).
// Every config sets interview.port 7799 through cfg() (N6): never the live 7781, never Irfan's 4387. tb lavish's route is
// lane D's: here a test preload calls interview.reopen() on SIGUSR2 (the probe). Kills only through run-spy and tbd.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { startTbd, runTb, REPO, FAKE_GATES } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, until, reap, pidsOf, alive } = require('./helpers/runs');
const { lavishDir, calls, opened, OPENER } = require('./helpers/fake-lavish');
const { parse, jail } = require('../lib/interview');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
// the probe: SIGUSR2 → interview.reopen(<TB_HOME/probe-id>, 'cli') → TB_HOME/probe-out.jsonl (tb lavish is lane D's)
const PROBE = path.join(ROOT, 'probe.js');
fs.writeFileSync(PROBE, `const fs = require('node:fs');
const path = require('node:path');
process.on('SIGUSR2', () => {
  const h = process.env.TB_HOME;
  require(${JSON.stringify(path.join(REPO, 'lib', 'interview.js'))}).reopen(fs.readFileSync(path.join(h, 'probe-id'), 'utf8'), 'cli')
    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e.status, error: e.message }))
    .then((r) => fs.appendFileSync(path.join(h, 'probe-out.jsonl'), JSON.stringify(r) + '\\n'));
});
`);

const PORT = 7799;
// N6: the one config helper. Admission always yes (this 8 GB Mac's free RAM must not decide a test).
const cfg = (interview = {}) => ({
  claude_bin: FAKE, max_concurrent: 4,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
  interview: { port: PORT, idle_min: 2, poll_min: 1, ...interview },
});
const QUESTIONS = {
  kind: 'questions', round: 1, facts: ['README.md: users list has no paging'], decisions: [],
  questions: [{ id: 'Q1', question: 'Page size?', why: 'API contract', options: ['20', '50'], recommended: '20', topic: 'Paging' },
    { id: 'Q2', question: 'Cursor field name?', why: 'clients read it', options: ['a', 'b'], recommended: 'a', topic: 'Paging' }],
};
const result = (out) => ({ result: { structured_output: out } });
const FIX = path.join(__dirname, 'fixtures', 'lavish');
const FB = fs.readFileSync(path.join(FIX, 'poll-2.txt'), 'utf8'); // Q1 pick 20, Q2 text; {{NONCE}} = the page's (fake)
const PARTIAL = FB.replace('prompts[2]', 'prompts[1]').split('\n').filter((l) => !l.startsWith('  "2",')).join('\n');
const SERVER_ERROR = { out: 'error: boom\ncode: SERVER_ERROR\n', code: 1 };

const tk = (tbd, id, ...f) => path.join(tbd.tbHome, 'tickets', id, ...f);
const alerts = (tbd, title) => lines(path.join(tbd.tbHome, 'test-alerts.jsonl')).filter((a) => a.title === title);
const verb = (c) => (['poll', 'end', 'stop', 'reply'].includes(c.argv[0]) ? c.argv[0] : 'open');
const of = (tbd, v) => calls(tbd.tbHome).filter((c) => verb(c) === v);
const view = async (tbd, id) => (await tbd.api('GET', `/api/tickets/${id}`)).json?.ticket;
const stateIs = (tbd, id, s) => until(async () => (await view(tbd, id))?.state === s, 30_000, `${id} ${s}`);
const html = (tbd, id) => path.join(tbd.tbHome, 'interview', `${id}-r01`, 'page.html');
const feedbacks = (tbd) => (fs.existsSync(path.join(tbd.tbHome, 'interview-out')) ? fs.readdirSync(path.join(tbd.tbHome, 'interview-out')) : []);
const URL_RE = /^http:\/\/localhost:7799\/session\/[0-9a-f]{16}$/;
const rows = (tbd, id) => lines(tk(tbd, id, 'interventions.jsonl')).map((l) => [l.actor, l.verb]);
async function answerCli(tbd, id, answers) {
  const f = path.join(ROOT, `answers-${id}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(answers));
  const r = await runTb(['answer', id, '--file', f], tbd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
}
async function probe(tbd, id) {
  fs.writeFileSync(path.join(tbd.tbHome, 'probe-id'), id);
  const out = path.join(tbd.tbHome, 'probe-out.jsonl');
  const n = lines(out).length;
  process.kill(Number(fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8')), 'SIGUSR2');
  return until(() => lines(out)[n], 15_000, 'probe');
}

// One planning ticket per tbd: run 1 returns questions (→ clarify, the page), later runs hang.
async function boot(t, { id = 't_int001', over = {}, questions = QUESTIONS, interview = {}, lavish = undefined, env = {}, root = fs.mkdtempSync(path.join(ROOT, 'tbd-')) } = {}) {
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [result(questions)] }));
  for (const n of [2, 3, 4]) fs.writeFileSync(path.join(scn, `${n}.json`), JSON.stringify({ steps: [{ hang: true }] }));
  const files = { 'config.json': cfg(interview), [`tickets/${id}/ticket.json`]: ticket(id, over), ...(lavish && { 'lavish/fake-lavish.json': lavish }) };
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-')); // each run's argv + prompt, by invocation (fake-claude)
  const envAll = { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${OPENER} --require ${PROBE}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn, FAKE_CLAUDE_DUMP_DIR: dumps, ...env };
  const tbd = await startTbd({ root, files, env: envAll });
  // stop first, then reap: a tbd still up spawns the next run (an answer → planning) after the reap read the lease, and that
  // run outlives it (orphans, ppid 1); stopped, the lease names the last run. keep: a restart may run on root (ROOT goes at the end)
  t.after(async () => { await tbd.stop({ keep: true }).catch(() => {}); reap(pidsOf(tbd)); });
  return Object.assign(tbd, { envAll, seed: (n) => { const f = path.join(dumps, `${n}.json`); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).prompt; } });
}

test('task 0 unit: the real S5 poll output (fixture poll-1) parses to its session + prompts, each with the JSON after "Context data:"; a broken row → null', () => {
  const out = parse(fs.readFileSync(path.join(FIX, 'poll-1.txt'), 'utf8'));
  assert.deepEqual(out.session, { file: '/tmp/tbfix/interview/t_fix001-r01.html', status: 'feedback' });
  assert.deepEqual(out.prompts.map((p) => [p.uid, p.selector, p.tag, p.text, p.data]), [
    ['1', 'html > body > form:nth-of-type(1)', 'choice', 'q1: you_decide', { question: 'q1', answer: 'you_decide' }],
    ['2', 'html > body > form:nth-of-type(2)', 'text', 'q2: hello from spike', { question: 'q2', answer: 'hello from spike' }]]);
  assert.equal(parse('session:\n  status: feedback\nprompts[1]{uid,prompt}:\n  "1","open quote\n'), null);
});

test('CR-2 unit: prompts in TOON list form (a prompt with target + attachments, @toon-format/toon 2.3.1 output: fixture poll-3) parse as the table form does; fewer items than the header says → null', () => {
  const text = fs.readFileSync(path.join(FIX, 'poll-3.txt'), 'utf8');
  const out = parse(text);
  assert.deepEqual(out.session, { file: '/tmp/tbfix/interview/t_fix001-r01/page.html', status: 'feedback' });
  assert.deepEqual(out.prompts.map((p) => [p.uid, p.tag, p.text, p.data]), [
    ['1', 'tb-answer', 'Q1: 20', { question: 'Q1', kind: 'pick', value: '20', nonce: '{{NONCE}}', round: 1 }],
    ['2', 'tb-answer', 'Q2: hello from the page', { question: 'Q2', kind: 'text', value: 'hello from the page', nonce: '{{NONCE}}', round: 1 }]]);
  assert.equal(parse(text.replace('prompts[2]:', 'prompts[3]:')), null);
});

test('D-0124 unit: lib/lavish.sb with jail()\'s params, under the real sandbox-exec: binds only the port, connects only to loopback, reads none of HOME / TB_HOME but the pages + state, writes only the state dir', () => {
  const box = fs.mkdtempSync(path.join(ROOT, 'jail-'));
  const [tb, home] = [path.join(box, 'tb'), path.join(box, 'home')];
  for (const d of [path.join(tb, 'tickets', 't_x00001'), path.join(tb, 'interview', 't_x00001-r01'), path.join(tb, 'interview-out'), home]) fs.mkdirSync(d, { recursive: true });
  for (const f of [path.join(tb, 'tickets', 't_x00001', '.env'), path.join(tb, 'interview', 't_x00001-r01', 'page.html'), path.join(tb, 'interview-out', 't_x00001-r01.feedback'), path.join(home, '.secret')]) fs.writeFileSync(f, 'x');
  const probe = path.join(box, 'probe.js');
  fs.writeFileSync(probe, `const net = require('node:net'); const fs = require('node:fs'); const tb = process.argv[2]; const home = process.argv[3];
const L = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', (e) => r(e.code)); s.listen(p, '127.0.0.1', () => { s.close(); r('ok'); }); });
const C = (h, p) => new Promise((r) => { const c = net.connect({ host: h, port: p, timeout: 3000 }); c.once('error', (e) => r(e.code)); c.once('timeout', () => { c.destroy(); r('timeout'); }); c.once('connect', () => { c.destroy(); r('ok'); }); });
const R = (f) => { try { fs.readFileSync(f); return 'ok'; } catch (e) { return e.code; } };
const W = (f) => { try { fs.writeFileSync(f, 'x'); return 'ok'; } catch (e) { return e.code; } };
(async () => console.log(JSON.stringify({ bind: await L(7799), bindOther: await L(7797), out: await C('1.1.1.1', 443), loop: await C('127.0.0.1', 9),
  page: R(tb + '/interview/t_x00001-r01/page.html'), env: R(tb + '/tickets/t_x00001/.env'), outbox: R(tb + '/interview-out/t_x00001-r01.feedback'), home: R(home + '/.secret'),
  state: W(tb + '/lavish/w'), pageDir: W(tb + '/interview/t_x00001-r01/w'), tbHome: W(tb + '/w') })))();
`);
  return jail(PORT, tb, home).then((args) => {
    assert.deepEqual(args.slice(0, 2), ['-f', path.join(REPO, 'lib', 'lavish.sb')]);
    assert.ok(args.includes('PORT=7799'), 'the port param');
    const r = spawnSync('/usr/bin/sandbox-exec', [...args, process.execPath, probe, fs.realpathSync(tb), fs.realpathSync(home)], { cwd: path.join(tb, 'lavish'), encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { bind: 'ok', bindOther: 'EPERM', out: 'EPERM', loop: 'ECONNREFUSED', page: 'ok', env: 'EPERM', outbox: 'EPERM', home: 'EPERM',
      state: 'ok', pageDir: 'EPERM', tbHome: 'EPERM' });
  });
});

test('I2 (+) clarify → the page in its own 0700 dir under TB_HOME/interview; every lavish call jailed (lib/lavish.sb) with exactly the minimal env + LAVISH_AXI_* (port 7799, idle_min × 60000, TB_HOME/lavish, telemetry off, 127.0.0.1, link host localhost, NO_OPEN, share API dead); tbd opens lavish\'s url itself once; polls are --takeover; never share; 5 cycles killed → no alert, still polling; after kill -9 the orphan poll dies at boot and the round is polled again (no new open)', async (t) => {
  const tbd = await boot(t, { interview: { poll_min: 0.005 } }); // a 300 ms kill (the cycle waits for 1 s)
  const id = 't_int001';
  await stateIs(tbd, id, 'clarify');
  await until(() => of(tbd, 'poll').length >= 6, 30_000, '5 cycles killed + 1 live');
  const page = html(tbd, id);
  for (const d of [path.dirname(page), path.join(tbd.tbHome, 'interview')]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
  const MIN = ['HOME', 'LANG', 'PATH', 'TMPDIR'].filter((k) => k === 'HOME' || process.env[k] !== undefined);
  const LAVISH = { LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_HOST: '127.0.0.1', LAVISH_AXI_LINK_HOST: 'localhost', LAVISH_AXI_STATE_DIR: path.join(tbd.tbHome, 'lavish'),
    LAVISH_AXI_PORT: '7799', LAVISH_AXI_IDLE_TIMEOUT_MS: '120000', LAVISH_AXI_NO_OPEN: '1', LAVISH_AXI_HTML_APP_API_URL: 'http://127.0.0.1:9' };
  const keys = (e) => Object.keys(e).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort(); // macOS sets it in every process itself
  for (const c of calls(tbd.tbHome)) {
    assert.equal(c.jailed, true, `${c.argv[0]}: under lib/lavish.sb`);
    assert.deepEqual(keys(c.env), [...MIN, ...Object.keys(LAVISH)].sort(), 'nothing else leaks in');
    for (const [k, v] of Object.entries(LAVISH)) assert.equal(c.env[k], v, k);
    assert.equal(c.env.HOME, tbd.home);
  }
  assert.deepEqual(of(tbd, 'open').map((c) => c.argv), [[page]]);
  const shown = opened(tbd.tbHome).map((o) => o.url);
  assert.equal(shown.length, 1, 'D-0118 + SEC-2: tbd opened the page itself, once');
  assert.match(shown[0], URL_RE);
  for (const p of of(tbd, 'poll')) assert.deepEqual(p.argv, ['poll', page, '--takeover']);
  assert.equal(alerts(tbd, 'Lavish down').length, 0, 'own cycle kills never count');
  const seen = of(tbd, 'poll').length;
  await until(() => of(tbd, 'poll').length > seen + 2, 10_000, 'still polling');

  // boot: a long cycle, then kill -9 tbd: its live poll is left behind (pid + lstart on the ticket)
  await tbd.stop({ keep: true });
  fs.writeFileSync(path.join(tbd.tbHome, 'config.json'), JSON.stringify(cfg()));
  let next = await startTbd({ root: tbd.root, env: tbd.envAll });
  t.after(async () => { await next.stop({ keep: true }).catch(() => {}); reap(pidsOf(next)); }); // stop, then reap (see boot)
  const opens = of(tbd, 'open').length;
  const orphan = await until(() => { const p = read(next, id).interview?.poll?.pid; return p && alive(p) && of(next, 'poll').some((c) => c.pid === p) && p; }, 15_000, 'poll pid kept');
  process.kill(Number(fs.readFileSync(path.join(next.tbHome, 'tbd.pid'), 'utf8')), 'SIGKILL');
  await next.stop({ keep: true });
  assert.equal(alive(orphan), true, 'the poll outlived its tbd');
  const polls = of(tbd, 'poll').length;
  next = await startTbd({ root: tbd.root, env: tbd.envAll });
  await until(() => !alive(orphan), 15_000, 'orphan killed at boot');
  await until(() => of(next, 'poll').length > polls, 15_000, 'polled again');
  assert.equal(of(next, 'open').length, opens, 'boot never opens the round again');
  assert.equal(opened(next.tbHome).length, 1, 'nor the browser');
  assert.ok(calls(next.tbHome).every((c) => !c.argv.includes('share')), 'never share');
});

test('I2c (−) agent text with quotes, </script>, onmouseover= and <img onerror> in a question text, why, option and topic (ids: plan-rules allows [A-Za-z0-9_-] only): only escaped text, no agent text in the one <script> or in any on*= attribute', async (t) => {
  const X = { id: 'Q1', question: '<img src=x onerror=PWN2()> size?', why: '" onmouseover="PWN3()', options: ['\'><svg onload=PWN4()>', 'b'],
    recommended: '\'><svg onload=PWN4()>', topic: '</script><script>PWN5()</script>' };
  const tbd = await boot(t, { questions: { ...QUESTIONS, questions: [X] } });
  await until(() => fs.existsSync(html(tbd, 't_int001')), 30_000, 'page');
  const text = fs.readFileSync(html(tbd, 't_int001'), 'utf8');
  assert.equal(text.match(/<script/gi).length, 1);
  assert.equal(text.match(/<\/script>/gi).length, 1);
  assert.doesNotMatch(text.slice(text.indexOf('<script>'), text.indexOf('</script>')), /PWN/);
  for (const tag of text.match(/<[^>]*>/g)) assert.doesNotMatch(tag.replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=/i, tag);
  assert.doesNotMatch(text, /<img|<svg/i);
  for (const s of ['&lt;img src=x onerror=PWN2()&gt; size?', '&quot; onmouseover=&quot;PWN3()', '&#39;&gt;&lt;svg onload=PWN4()&gt;', '&lt;/script&gt;&lt;script&gt;PWN5()&lt;/script&gt;']) assert.ok(text.includes(s), s);
});

test('I3 (+) a send with the page nonce + round answering every question → planning: answers joined, one interventions row actor lavish verb answer (D-0117), the .feedback file gone (D-0119); m7 seed: round 1 of a fresh ticket asks first (D-0116), round 2 after the answers does not', async (t) => {
  const tbd = await boot(t, { lavish: { poll: [{ out: FB }] } });
  const id = 't_int001';
  const k = await until(async () => { const v = await view(tbd, id); return v?.answers && v; }, 30_000, 'answered from the page');
  assert.equal(k.state, 'planning');
  assert.deepEqual(k.answers, [{ id: 'R1Q1', question: 'Page size?', answer: { pick: '20' } }, { id: 'R1Q2', question: 'Cursor field name?', answer: { text: 'hello from the page' } }]);
  assert.deepEqual(rows(tbd, id), [['lavish', 'answer']]);
  assert.equal(k.interventions, 1);
  assert.deepEqual(feedbacks(tbd), []);
  // X1 m7: the seed note follows plan-rules' one mustAsk (no must_ask flag here: D-0116's no answers + no locked decisions)
  assert.match(tbd.seed(1), /\n## Ask first\n\n[^\n]*no answers or locked decisions yet/);
  const round2 = await until(() => tbd.seed(2), 30_000, 'round 2 seed');
  assert.ok(round2.includes('## Planning round 2'), 'the seed after the answers');
  assert.equal(round2.includes('## Ask first'), false);
});

test('I3b (−) a wrong nonce, a partial send, an unreadable send (CR-1: still through the outbox) → stays clarify, journal {at, why, n} only, no interventions row, the next poll carries tbd\'s fixed reply per reason (D-0120), one alert for the nonce (SEC-9)', async (t) => {
  const BROKEN = 'session:\n  file: x\n  status: feedback\nprompts[1]{uid,prompt}:\n  "1","open quote\n';
  const tbd = await boot(t, { lavish: { poll: [{ out: FB.replaceAll('{{NONCE}}', 'f'.repeat(32)) }, { out: PARTIAL }, { out: BROKEN }] } });
  const id = 't_int001';
  await until(() => of(tbd, 'poll').length >= 4, 30_000, 'fourth poll');
  assert.equal((await view(tbd, id)).state, 'clarify');
  const j = lines(tk(tbd, id, 'interview.jsonl'));
  assert.deepEqual(j.map((l) => [Object.keys(l).sort().join(), l.why, l.n]), [['at,n,why', 'nonce', 2], ['at,n,why', 'partial', 1], ['at,n,why', 'partial', 0]]);
  assert.equal(fs.existsSync(tk(tbd, id, 'interventions.jsonl')), false);
  const [p1, p2, p3, p4] = of(tbd, 'poll');
  assert.equal(p1.argv.includes('--agent-reply'), false);
  const reply = (p) => { assert.equal(p.argv.at(-2), '--agent-reply'); return p.argv.at(-1); };
  const [r1, r2] = [reply(p2), reply(p3)];
  assert.match(r1, /did not come from the page/);
  assert.match(r2, /Every question needs an answer/);
  assert.equal(reply(p4), r2);
  assert.equal(alerts(tbd, 'Lavish down').length, 0, 'a send, read or not, is no lavish failure');
  assert.equal(alerts(tbd, 'Lavish send refused').length, 1, 'SEC-9: a wrong nonce alerts once per round');
  const nonce = /name="tb-nonce" content="([0-9a-f]{32})"/.exec(fs.readFileSync(html(tbd, id), 'utf8'))[1];
  for (const r of [r1, r2]) {
    assert.match(r, /^tbd: /);
    for (const s of ['hello from the page', nonce, 'Page size']) assert.equal(r.includes(s), false, `reply never carries ${s}`);
  }
  assert.deepEqual(feedbacks(tbd), []);
});

test('I3c (−/+) race: tb answer lands while a send is on its way → one answers set and one row (cli); the late lavish send is journaled ignored (round)', async (t) => {
  const tbd = await boot(t, { lavish: { poll: [{ out: FB, delay_ms: 4000, ignore_term: true }] } });
  const id = 't_int001';
  await until(() => of(tbd, 'poll').length === 1, 30_000, 'poll on its way');
  await answerCli(tbd, id, { Q1: { pick: '50' }, Q2: { use: 'recommended' } });
  await until(() => lines(tk(tbd, id, 'interview.jsonl')).length, 15_000, 'late send journaled');
  const k = await view(tbd, id);
  assert.deepEqual(k.answers, [{ id: 'R1Q1', question: 'Page size?', answer: { pick: '50' } }, { id: 'R1Q2', question: 'Cursor field name?', answer: { use: 'recommended' }, recommended: 'a' }]);
  assert.deepEqual(rows(tbd, id), [['cli', 'answer']]);
  assert.deepEqual(lines(tk(tbd, id, 'interview.jsonl')).map((l) => [l.why, l.n]), [['round', 2]]);
  assert.deepEqual(feedbacks(tbd), []);
});

test('I3d (+) D-0119: a send on disk when tbd died before applying it → the next boot applies it once', async (t) => {
  const tbd = await boot(t);
  const id = 't_int001';
  await until(() => of(tbd, 'poll').length === 1, 30_000, 'polling');
  const nonce = /name="tb-nonce" content="([0-9a-f]{32})"/.exec(fs.readFileSync(html(tbd, id), 'utf8'))[1];
  await tbd.stop({ keep: true });
  fs.mkdirSync(path.join(tbd.tbHome, 'interview-out'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tbd.tbHome, 'interview-out', `${id}-r01.feedback`), FB.replaceAll('{{NONCE}}', nonce), { mode: 0o600 });
  const next = await startTbd({ root: tbd.root, env: tbd.envAll });
  t.after(async () => { await next.stop({ keep: true }).catch(() => {}); reap(pidsOf(next)); }); // stop, then reap (see boot)
  await stateIs(next, id, 'planning');
  assert.deepEqual(rows(next, id), [['lavish', 'answer']]);
  assert.equal((await view(next, id)).answers.length, 2);
  assert.deepEqual(feedbacks(next), []);
});

test('I4 (−/+) lavish not installed, or 3 failing polls → exactly 1 alert, tb answer still moves clarify → planning (row cli); the probe resets the breaker; leaving clarify kills the poll and ends the session', async (t) => {
  const none = fs.mkdtempSync(path.join(ROOT, 'no-lavish-'));
  const a = await boot(t, { env: { TB_LAVISH_DIR: none } });
  await until(() => alerts(a, 'Lavish down').length, 30_000, 'alert');
  await answerCli(a, 't_int001', { Q1: { pick: '20' }, Q2: { pick: 'a' } });
  await stateIs(a, 't_int001', 'planning');
  assert.deepEqual(rows(a, 't_int001'), [['cli', 'answer']]);
  assert.equal(alerts(a, 'Lavish down').length, 1);

  const b = await boot(t, { lavish: { poll: [SERVER_ERROR, SERVER_ERROR, SERVER_ERROR] } });
  const id = 't_int001';
  await until(() => alerts(b, 'Lavish down').length, 30_000, 'breaker alert');
  assert.equal(of(b, 'poll').length, 3, 'the breaker stops polling');
  const r = await probe(b, id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => of(b, 'poll').length === 4, 15_000, 'polling again after the probe');
  assert.deepEqual(of(b, 'open').at(-1).argv, [html(b, id), '--reopen']);
  assert.equal(opened(b.tbHome).length, 2, 'the probe opened the page again');
  assert.equal(alerts(b, 'Lavish down').length, 1);
  const live = of(b, 'poll').at(-1).pid;
  await answerCli(b, id, { Q1: { pick: '20' }, Q2: { pick: 'a' } });
  await stateIs(b, id, 'planning');
  assert.deepEqual(rows(b, id), [['cli', 'lavish'], ['cli', 'answer']]);
  await until(() => of(b, 'end').length && !alive(live), 15_000, 'poll killed + session ended');
  assert.deepEqual(of(b, 'end')[0].argv, ['end', html(b, id)]);
});

test('F8 (+) questions after a working replan are a planning clarify: clarify_origin names planning, the page opens, tb answer → planning', async (t) => {
  const tbd = await boot(t, { over: { clarify_origin: { phase: 'working', task: 'T1', why: 'Page size 20 or 50?', class: 'NEEDS_CONTEXT' } } });
  const id = 't_int001';
  await stateIs(tbd, id, 'clarify');
  assert.deepEqual((await view(tbd, id)).clarify_origin, { phase: 'planning', task: 'T1', why: 'Page size 20 or 50?', class: 'NEEDS_CONTEXT' });
  await until(() => of(tbd, 'open').length, 15_000, 'page opened');
  await answerCli(tbd, id, { Q1: { pick: '20' }, Q2: { pick: 'a' } });
  await stateIs(tbd, id, 'planning');
  assert.deepEqual(rows(tbd, id), [['cli', 'answer']]);
});

// A code ticket approved for real (fake gates green) whose T1 run returns `out` (a working ask) → clarify; run 2 hangs.
// lavish: fake-lavish steps. → {tbd, id, dump(n): run n's argv + prompt}
async function workAsk(t, out, lavish = undefined) {
  const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "node --test"}}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'users.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base = git(dir, 'rev-parse', 'main');
  const wt = path.join(fs.mkdtempSync(path.join(ROOT, 'wt-')), 'w');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, base);
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [{ result: { structured_output: { commit: null, tests_added: [], notes: '', ...out } } }] }));
  fs.writeFileSync(path.join(scn, '2.json'), JSON.stringify({ steps: [{ hang: true }] }));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const id = 't_work01';
  const plan = { kind: 'plan', summary: 'users work', acceptance: [{ id: 'A1', text: 'users still work', type: 'preserve' }],
    tasks: [{ id: 'T1', title: 'task T1', files: ['src/users.js'], modules: ['src'], blocked_by: [], acceptance: ['A1'], type: 'preserve', test_cmd: 'npm test', steps: ['do it'] }],
    allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: null, children: [], facts: ['src/users.js: the users module'], decisions: [] };
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: { 'config.json': cfg(), 'tags.json': { acme: {}, 'acme/api': { type: 'git', path: dir, base: 'main' } },
      [`tickets/${id}/ticket.json`]: ticket(id, { state: 'plan_approval', tag: 'acme/api', title: 'users work', base_sha: base, worktree: wt, round: 3 }),
      [`tickets/${id}/rounds/01-plan.json`]: plan, [`fake-gates/${id}.json`]: {}, ...(lavish && { 'lavish/fake-lavish.json': lavish }) },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${FAKE_GATES} ${OPENER}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn, FAKE_CLAUDE_DUMP_DIR: dumps },
  });
  t.after(async () => { await tbd.stop({ keep: true }).catch(() => {}); reap(pidsOf(tbd)); }); // stop, then reap (see boot)
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await stateIs(tbd, id, 'clarify');
  return { tbd, id, dump: (n) => { const f = path.join(dumps, `${n}.json`); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')); } };
}

// full-access-runs Phase 5 (contract change; was: a NEEDS_CONTEXT working clarify never opens lavish, N2): a working ask
// that takes a text answer opens a one-question free-text page; its send → working.answer with actor lavish (same session)
test('working-origin (+) a NEEDS_CONTEXT clarify opens a one-question text page (round = the ticket round); its send → working.answer actor lavish → the same session goes on with the text', async (t) => {
  const text = 'Use 50, as the API docs say';
  const data = { question: 'Q1', kind: 'text', value: text, nonce: '{{NONCE}}', round: 5 }; // plan_approval round 3 → working 4 → clarify 5
  const send = ['session:', '  file: x', '  status: feedback', 'prompts[1]{uid,prompt,selector,tag,text}:',
    `  "1",${JSON.stringify(`Q1: ${text}\n\nContext data:\n${JSON.stringify(data, null, 2)}`)},"html > body > form:nth-of-type(1)",tb-answer,${JSON.stringify(`Q1: ${text}`)}`].join('\n') + '\n';
  const { tbd, id, dump } = await workAsk(t, { status: 'NEEDS_CONTEXT', question: 'Page size 20 or 50?' }, { poll: [{ out: send, delay_ms: 3000 }] });
  const file = path.join(tbd.tbHome, 'interview', `${id}-r05`, 'page.html'); // read while the round is open: leaving clarify removes it
  const page = (await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8'), 15_000, 'page')).match(/<form[\s\S]*<\/form>/)?.[0] ?? '';
  await until(async () => (await view(tbd, id))?.state === 'working', 30_000, 'answered from the page');
  assert.deepEqual(rows(tbd, id), [['cli', 'approve'], ['lavish', 'answer']]); // gap 2026-10-20 contract change: + workAsk's approve row
  assert.match(page, /Q1\. Page size 20 or 50\?/);
  assert.equal(/type="radio"/.test(page), false, 'free text only: no options, no You Decide');
  assert.equal(opened(tbd.tbHome).length, 1, 'tbd opened the page once');
  const run2 = await until(() => dump(2), 30_000, 'run 2');
  assert.equal(run2.opts['--resume'], dump(1).opts['--session-id'], 'the same session goes on');
  assert.match(run2.prompt, new RegExp(`^Irfan answered:\n\n${text}\n`));
});

test('working-origin (−) a scope ask (no text answer) opens no lavish page; POST lavish → 409', async (t) => {
  const { tbd, id } = await workAsk(t, { status: 'NEEDS_SCOPE', needs_scope: { files: ['src/other.js'], reason: 'needs the other module' } });
  assert.deepEqual([(await view(tbd, id)).clarify_origin.phase, (await view(tbd, id)).clarify_origin.class], ['working', 'scope']);
  await new Promise((r) => setTimeout(r, 1500)); // an open would have run by now (setImmediate after the move)
  assert.deepEqual(calls(tbd.tbHome), []);
  assert.equal((await view(tbd, id)).interview, undefined);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/lavish`, {})).status, 409);
});

test('F5 (−/+) the lavish port held by a foreign listener → no open, 1 alert; held by our own lavish server (its argv) → the open goes ahead', async (t) => {
  const foreign = net.createServer();
  await new Promise((r) => foreign.listen(PORT, '127.0.0.1', () => r(null)));
  let ours;
  t.after(() => { foreign.close(); ours?.kill('SIGKILL'); });
  const tbd = await boot(t);
  const id = 't_int001';
  await until(() => alerts(tbd, 'Lavish port taken').length, 30_000, 'port alert');
  assert.deepEqual(of(tbd, 'open'), []);
  assert.equal((await view(tbd, id)).interview, undefined);
  await new Promise((r) => foreign.close(r));
  ours = spawn(process.execPath, [fs.realpathSync(path.join(lavishDir(), 'node_modules', 'lavish-axi', 'dist', 'server.mjs')), 'server', '--port', String(PORT)], { stdio: 'ignore' });
  await until(() => new Promise((r) => { const c = net.connect(PORT, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); }), 10_000, 'our server listens');
  const r = await probe(tbd, id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.v.url, URL_RE);
  assert.equal(of(tbd, 'open').length, 1);
  assert.deepEqual(opened(tbd.tbHome).map((o) => o.url), [r.v.url]);
  assert.equal(alerts(tbd, 'Lavish port taken').length, 1);
});

test('SEC-2 (−) lavish prints a page url of another form → tbd opens nothing, polls nothing, 1 alert', async (t) => {
  const tbd = await boot(t, { lavish: { open: [{ out: 'session:\n  file: x\n  url: "http://evil.example:7799/session/0123456789abcdef"\n  status: opened\n' }] } });
  await until(() => alerts(tbd, 'Lavish page not opened').length, 30_000, 'alert');
  await new Promise((r) => setTimeout(r, 1000)); // a poll would have started by now
  assert.deepEqual([opened(tbd.tbHome), of(tbd, 'poll')], [[], []]);
});
