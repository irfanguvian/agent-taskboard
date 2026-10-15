'use strict';
// M5.4 lane D (build doc "### D"): tb lavish + POST /api/tickets/:id/lavish reopen the Clarify page of a planning clarify.
// A real tbd with the fake lavish install (test/helpers/fake-lavish.js), config as test/interview.test.js (port 7799).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, runTb, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, lines, until, reap, pidsOf } = require('./helpers/runs');
const { calls, opened, OPENER } = require('./helpers/fake-lavish');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lavish-parity-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
for (const ph of ['planning', 'working']) {
  fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
  for (const f of ['settings.json', 'result.schema.json']) fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, f), path.join(PHASES, 'code', ph, f));
  fs.writeFileSync(path.join(PHASES, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
}
const QUESTIONS = {
  kind: 'questions', round: 1, facts: ['README.md: users list has no paging'], decisions: [],
  questions: [{ id: 'Q1', question: 'Page size?', why: 'API contract', options: ['20', '50'], recommended: '20', topic: 'Paging' },
    { id: 'Q2', question: 'Auth?', why: 'who calls', options: ['a', 'b'], recommended: 'a' },
    { id: 'Q3', question: 'Cursor field?', why: 'clients read it', options: ['x', 'y'], recommended: 'x', topic: 'Paging' }],
};

test('tb lavish / POST lavish: a planning clarify reopens its page (cli row, tbd opens the url; lavish always NO_OPEN); a working-origin clarify is 409; tb lavish on a non-clarify ticket fails', async (t) => {
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  fs.writeFileSync(path.join(scn, '1.json'), JSON.stringify({ steps: [{ result: { structured_output: QUESTIONS } }] }));
  for (const n of [2, 3, 4]) fs.writeFileSync(path.join(scn, `${n}.json`), JSON.stringify({ steps: [{ hang: true }] }));
  const cfg = {
    claude_bin: FAKE, max_concurrent: 4,
    memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
    disk: { warn_gb: 0, stop_gb: 0 }, interview: { port: 7799, idle_min: 2, poll_min: 1 },
  };
  const tbd = await startTbd({
    root: fs.mkdtempSync(path.join(ROOT, 'tbd-')),
    files: { 'config.json': cfg,      'tickets/t_int001/ticket.json': ticket('t_int001', {}),
      'tickets/t_work01/ticket.json': ticket('t_work01', { state: 'clarify', clarify_origin: { phase: 'working', task: 'T1', why: 'q', class: 'NEEDS_CONTEXT' } }),
      'tickets/t_back01/ticket.json': ticket('t_back01', { state: 'backlog' }) },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: `${RUN_SPY} ${OPENER}`, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop().catch(() => {}); });
  const opens = () => calls(tbd.tbHome).filter((c) => !['poll', 'end', 'stop', 'reply'].includes(c.argv[0]));
  await until(async () => (await tbd.api('GET', '/api/tickets/t_int001')).json?.ticket?.state === 'clarify', 30_000, 'clarify');
  await until(() => opens().length === 1, 15_000, 'auto open');

  const r = await runTb(['lavish', 't_int001'], tbd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /http:\/\/localhost:7799\/session\/[0-9a-f]{16}/);
  assert.equal(opens().length, 2);
  assert.equal(opens()[1].env.LAVISH_AXI_NO_OPEN, '1', 'SEC-2: lavish never opens the browser');
  assert.equal(opened(tbd.tbHome).length, 2, 'D-0118: tbd opened the page itself (round open + reopen)');
  assert.match(opened(tbd.tbHome)[1].url, /^http:\/\/localhost:7799\/session\/[0-9a-f]{16}$/);
  assert.deepEqual(lines(path.join(tbd.tbHome, 'tickets', 't_int001', 'interventions.jsonl')).map((l) => [l.actor, l.verb]), [['cli', 'lavish']]);

  const w = await tbd.api('POST', '/api/tickets/t_work01/lavish', {});
  assert.equal(w.status, 409, JSON.stringify(w.json));
  // tb answer without --file: the open questions, grouped by topic (Q3 beside Q1), a topic column
  const a = await runTb(['answer', 't_int001'], tbd);
  assert.equal(a.code, 1);
  const ids = a.stdout.split('\n').filter((l) => /\bQ[123]\b/.test(l)).map((l) => l.match(/\bQ[123]\b/)[0]);
  assert.deepEqual(ids, ['Q1', 'Q3', 'Q2']);
  assert.match(a.stdout, /topic/);
  const n = await runTb(['lavish', 't_back01'], tbd);
  assert.notEqual(n.code, 0);
  assert.match(n.stdout + n.stderr, /t_back01: no planning questions are open/);
  assert.equal(opens().length, 2, 'refusals opened nothing');
  assert.equal(opened(tbd.tbHome).length, 2);
});
