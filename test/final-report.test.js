'use strict';
// M5.3 parity (contract .omc/handoffs/m5-contract.md rev 4 C13, C20 rows "tb report --kind final|summary|verdict", C21
// taint + A01): GET …/report?kind=final|summary|verdict and `tb report --kind final|summary|verdict` on a real tbd (temp
// HOME + TB_HOME, port 0) with a seeded ticket and the files lib/final.js writes (final/NN.json, summary.md, the mirrored
// verdict doc with tbd's evidence). No agent runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTbd, runTb } = require('./helpers/tbd');
const { ticket } = require('./helpers/runs');

const ID = 't_frp001';
const BARE = 't_frp002'; // no final review yet
const TESTED = 'b'.repeat(40);
const AT = '2026-10-14T01:02:03.000Z';
const VERDICT = `docs/verdicts/2026-10-14-${ID}.md`;
const VERIFY = `docs/verification/2026-10-14-${ID}-final.md`;
const DOC = '# Verdict\n\nPASS: <img src=x onerror=alert(1)>\n\n## Evidence (captured by tbd)\n\n### Final checks\n\n- unit: pass\n';
const SUMMARY = '**Title:** <script>alert(1)</script>\n\n**Description:** d\n\n**What I worked on:**\n- w\n\n**Blocker:** none\n\n**Need Review:** none\n\n**Verdict:** shipped\n';
const F = (id, over = {}) => ({ id, severity: 'HIGH', confidence: 'high', where: 'src/users.js:1', problem: `problem ${id}`, failure_scenario: `scenario ${id}`, fix: `fix ${id}`, cheap: false, ...over });
const S = { title: 'feat: users by id', description: 'd', worked_on: ['w'], blocker: 'none', need_review: 'none', verdict: 'shipped' };
const R = (n, over) => ({ n, at: AT, round: 6, tested_sha: TESTED, verdict: 'pass', findings: [], verdict_doc: VERDICT, verification_doc: VERIFY, summary: S, ...over });

let tbd;
before(async () => {
  tbd = await startTbd({ files: {
    [`tickets/${ID}/ticket.json`]: ticket(ID, { kind: 'code', state: 'backlog', fixes: 1, final: { n: 2, tested_sha: TESTED, verdict: 'pass', sha: 'c'.repeat(40), at: AT } }),
    [`tickets/${BARE}/ticket.json`]: ticket(BARE, { kind: 'code', state: 'backlog' }),
    // 1: a pass whose verdict doc lies under a linked dir in the mirror; 2: the pass; 3 (newest): a block whose path climbs out
    [`tickets/${ID}/final/01.json`]: R(1, { verdict_doc: 'docs/verdicts/sub/v.md' }),
    [`tickets/${ID}/final/02.json`]: R(2, { findings: [F('F3', { severity: 'LOW', confidence: 'medium' })] }),
    [`tickets/${ID}/final/03.json`]: R(3, { verdict: 'block', verdict_doc: 'docs/verdicts/../../ticket.json', findings: [F('F4', { confidence: 'medium' }), F('F5')] }),
    [`tickets/${ID}/summary.md`]: SUMMARY,
    [`tickets/${ID}/${VERDICT}`]: DOC,
    [`tickets/${ID}/other/v.md`]: 'outside the mirror\n',
  } });
  fs.symlinkSync('../../other', path.join(tbd.tbHome, 'tickets', ID, 'docs', 'verdicts', 'sub'));
});
after(() => tbd?.stop());
const get = (q, id = ID) => tbd.api('GET', `/api/tickets/${id}/report?${q}`);

test('report kind=final: the newest final review by default (a block too), --n; findings carry tbd\'s blocking rule, doc paths, summary; none kept → 404', async () => {
  const r = await get('kind=final');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.n, r.json.verdict, r.json.tested_sha, r.json.verification_doc], [3, 'block', TESTED, VERIFY]);
  assert.deepEqual(r.json.findings.map((f) => [f.id, f.blocking]), [['F5', true], ['F4', false]], 'blocking first');
  const two = await get('kind=final&n=2');
  assert.deepEqual([two.json.n, two.json.verdict, two.json.summary.title, two.json.findings.map((f) => [f.id, f.blocking])], [2, 'pass', S.title, [['F3', false]]]);
  assert.equal((await get('kind=final', BARE)).status, 404);
  assert.equal((await get('kind=final&n=9')).status, 404);
});

test('report kind=summary | verdict: summary.md and the mirrored verdict doc (tbd\'s evidence in it) as text; the newest PASSING final review\'s doc; a linked dir or ../ on the way → 404; bad kind / n → 400', async () => {
  const s = await get('kind=summary');
  assert.deepEqual([s.status, s.json.text], [200, SUMMARY]);
  const v = await get('kind=verdict');
  assert.deepEqual([v.status, v.json.n, v.json.path, v.json.text], [200, 2, VERDICT, DOC], 'final 3 blocked: the doc of pass 2');
  assert.match(v.json.text, /## Evidence \(captured by tbd\)/);
  assert.equal((await get('kind=verdict&n=1')).status, 404, 'a linked dir on the way');
  assert.equal((await get('kind=verdict&n=3')).status, 404, 'a path that climbs out of docs/');
  for (const k of ['summary', 'verdict']) assert.equal((await get(`kind=${k}`, BARE)).status, 404, k);
  for (const q of ['kind=bogus', 'kind=final&n=0', 'kind=verdict&n=../../token']) assert.equal((await get(q)).status, 400, q);
});

test('tb report --kind final | summary | verdict print the report, agent text as text; --n with summary: usage exit 2', async () => {
  const f = await runTb(['report', ID, '--kind', 'final', '--n', '2'], tbd);
  assert.equal(f.code, 0, f.stdout);
  assert.equal(f.stdout, [`report: ${ID} · final 2 · pass · tested bbbbbbbbbbbb · ${AT}`, `  verdict_doc: ${VERDICT}`, `  verification_doc: ${VERIFY}`,
    'findings[1]{id,severity,confidence,where,problem,scenario,fix,status}:', '  F3,LOW,medium,"src/users.js:1",problem F3,scenario F3,fix F3,need review',
    `help: tb report ${ID} --kind summary | --kind verdict`, ''].join('\n'));
  const s = await runTb(['report', ID, '--kind', 'summary'], tbd);
  assert.equal(s.stdout, [`summary: ${ID}`, ...SUMMARY.trimEnd().split('\n').map((l) => `  ${l}`), ''].join('\n'));
  const v = await runTb(['report', ID, '--kind', 'verdict'], tbd);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, new RegExp(`^verdict: ${ID} · final 2 · ${VERDICT}\n {2}# Verdict\n`));
  assert.match(v.stdout, /\n {2}## Evidence \(captured by tbd\)\n/);
  const none = await runTb(['report', BARE, '--kind', 'final'], tbd);
  assert.deepEqual([none.code, none.stdout.split('\n')[0]], [1, `error: ${BARE}: no final review`]);
  assert.equal((await runTb(['report', ID, '--kind', 'summary', '--n', '1'], tbd)).code, 2);
});
