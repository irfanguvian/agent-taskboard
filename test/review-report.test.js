'use strict';
// M5.1 parity (contract .omc/handoffs/m5-contract.md rev 4 C20 rows "tb report --kind review" and "tb show", C21): GET
// …/report?kind=review, `tb report --kind review` and the "fix n/3" line of `tb show` on a real tbd (temp HOME + TB_HOME,
// port 0) with a seeded ticket and review/NN.json files as lib/review.js writes them. No agent runs.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, runTb } = require('./helpers/tbd');
const { ticket } = require('./helpers/runs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rvreport-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HEAD = 'a'.repeat(40);
const F = (id, over = {}) => ({ id, severity: 'HIGH', confidence: 'high', where: 'src/users.js:1', problem: `problem ${id}`, failure_scenario: `scenario ${id}`, fix: `fix ${id}`, ...over });
const R = (n, over) => ({ n, at: '2026-10-12T01:02:03.000Z', round: 1, head: HEAD, verdict: 'pass', findings: [], closed: [], notes: [], declined: [], ...over });

test('M5.1 report review: route, tb report, tb show fix n/3; unknown id 404, bad n / kind 400, usage exit 2', async (t) => {
  const id = 't_rrp001';
  const files = {
    [`tickets/${id}/ticket.json`]: ticket(id, { kind: 'code', state: 'backlog', fixes: 1, review: { n: 2, head: HEAD, open: [] } }),
    [`tickets/${id}/review/01.json`]: R(1, { verdict: 'block', findings: [F('F1'), F('F2', { confidence: 'medium' })] }),
    [`tickets/${id}/review/02.json`]: R(2, { findings: [F('F2', { confidence: 'medium' })], closed: [{ id: 'F1', how: 'fixed in abc' }] }),
  };
  const tbd = await startTbd({ files });
  t.after(() => tbd.stop());
  // newest by default; blocking comes from tbd's rule, closed ids ride along
  const r = await tbd.api('GET', `/api/tickets/${id}/report?kind=review`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.n, r.json.verdict, r.json.fixes, r.json.findings.map((f) => [f.id, f.blocking]), r.json.closed], [2, 'pass', 1, [['F2', false]], [{ id: 'F1', how: 'fixed in abc' }]]);
  const one = await tbd.api('GET', `/api/tickets/${id}/report?kind=review&n=1`);
  assert.deepEqual([r.json.fix_max, one.json.fixes], [3, undefined], 'fixes only for the newest review');
  assert.deepEqual(one.json.findings.map((f) => [f.id, f.blocking]), [['F1', true], ['F2', false]]);
  // refusals
  const status = async (p) => (await tbd.api('GET', p)).status;
  assert.equal(await status('/api/tickets/t_nope99/report?kind=review'), 404);
  assert.equal(await status(`/api/tickets/${id}/report?kind=review&n=3`), 404);
  for (const q of ['kind=qa', '', 'kind=review&n=0', 'kind=review&n=x', 'kind=review&n=../../token', 'kind=review&n=10000']) assert.equal(await status(`/api/tickets/${id}/report?${q}`), 400, q);
  // CLI
  const cli = await runTb(['report', id, '--kind', 'review', '--n', '1'], tbd);
  assert.equal(cli.code, 0, cli.stdout);
  assert.match(cli.stdout, /^report: t_rrp001 · review 1 · block · head aaaaaaaaaaaa · 2026-10-12T01:02:03.000Z\nfindings\[2\]\{id,severity,confidence,where,problem,scenario,fix,status\}:\n {2}F1,HIGH,high,"src\/users.js:1",problem F1,scenario F1,fix F1,open\n {2}F2,HIGH,medium,"src\/users.js:1",problem F2,scenario F2,fix F2,need review\nclosed\[0\]: none\n$/);
  assert.equal((await runTb(['report', id], tbd)).code, 2);
  assert.equal((await runTb(['report', id, '--kind', 'qa'], tbd)).code, 2);
  // tb show
  assert.match((await runTb(['show', id], tbd)).stdout, /\n {2}fix: 1\/3\n/);
});
