'use strict';
// scripts/eval-phase.js scoring (M5.1 review evals E1-E3): each case's example result passes its scripted checks; a
// result that misses the point fails the matching check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../scripts/eval-phase');
const H = require('../scripts/harness');
const P = require('../scripts/eval-planner');
const golden = require('../lib/evalscore');

const fails = (c, result) => E.score(c, { accepted: true, why: '', result }).filter((x) => !x.ok).map((x) => x.name);

test('score: the example of E1-E3 passes; a wrong line, a too-low severity, an invented finding, a dropped close fail', () => {
  const [e1, e2, e3] = E.CASES.map(E.loadCase);
  for (const c of [e1, e2, e3]) assert.deepEqual(fails(c, c.example), [], c.key);
  const f1 = e1.example.findings[0];
  assert.deepEqual(fails(e1, { ...e1.example, findings: [{ ...f1, where: 'src/users/users.service.ts:30' }] }), ['an open HIGH high-confidence finding at src/users/users.service.ts:18-27']);
  assert.deepEqual(fails(e1, { ...e1.example, findings: [{ ...f1, severity: 'MED' }] }), ['an open HIGH high-confidence finding at src/users/users.service.ts:18-27']);
  assert.deepEqual(fails(e2, { ...e2.example, findings: [f1] }), ['at most 0 finding(s)']);
  assert.deepEqual(fails(e3, { ...e3.example, closed: [], findings: [...e3.example.findings, e3.prior.review.findings[0]] }), ['F1 closed, not kept open']);
  assert.equal(E.score(e2, { accepted: false, why: 'refused', result: null })[0].ok, false);
  assert.deepEqual(E.parseWhere('src/a.ts:3-9'), { path: 'src/a.ts', lo: 3, hi: 9 });
  assert.equal(E.parseWhere('src/a.ts'), null);
});

// M5.2 QA evals: what tbd kept (rec lines from each case's fake routes, the ticket as the handler leaves it, the changed
// files' line counts at HEAD) against each case's example; a forged rec, a source outside the diff, a pass among blocked
// cases, a FAIL put on env fail the matching check.
const LINES = { 'src/users/users.service.ts': 37, 'src/users/users.dto.ts': 25, 'src/users/users.service.spec.ts': 23 };
function qaRun(c, result, ticket = undefined) {
  const e = c.expect;
  return {
    accepted: true, why: '', result, lines: LINES,
    recs: c.fake.map(([u, status, body], i) => ({ n: `1.${i + 1}`, method: 'GET', url: `http://127.0.0.1:4000${u}`, res: { status, body: JSON.stringify(body) } })),
    ticket: ticket ?? { state: e.state, waiting: e.waiting ? { reason: e.waiting } : null, fixes: e.fix ? 1 : 0, work: { tasks: [{ id: 'T1' }, ...(e.fix ? [{ id: e.fix }] : [])] } },
  };
}
const qaFails = (c, result, ticket = undefined) => E.scoreQa(c, qaRun(c, result, ticket)).filter((x) => !x.ok).map((x) => x.name);

test('scoreQa: the example of QA E1-E3 passes; a rec tbd never recorded, a source outside the diff, a PASS in E2, a FAIL on env in E3 fail', () => {
  const [q1, q2, q3] = E.CASES.map((k) => E.caseOf('qa', k));
  for (const c of [q1, q2, q3]) assert.deepEqual(qaFails(c, c.example), [], c.key);
  const [a, b] = q1.example.cases;
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [a, { ...b, recs: ['1.9'] }] }), ['every cited rec is a call tbd recorded for this ticket; a PASS/FAIL case\'s status = its last rec']);
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [{ ...a, observed: { status: 404, note: '' } }, b] }), ['every cited rec is a call tbd recorded for this ticket; a PASS/FAIL case\'s status = its last rec']);
  assert.deepEqual(qaFails(q1, { ...q1.example, cases: [{ ...a, source: 'src/users/users.service.ts:30-40' }, b] }),
    ['every source is a plan acceptance id or a changed path:line inside the file at HEAD', '1+ case source is a changed path:line']);
  assert.deepEqual(qaFails(q2, { ...q2.example, cases: [{ ...q2.example.cases[0], result: 'PASS', cause: undefined }, q2.example.cases[1]] }), ['no PASS: every case BLOCKED or ASSISTED, a BLOCKED one cause env']);
  const [f, p] = q3.example.cases;
  assert.deepEqual(qaFails(q3, { ...q3.example, cases: [{ ...f, cause: 'env' }, p] }), ['a FAIL cause code case cites a recorded GET /users 200 with latestOrder in the body']);
  assert.deepEqual(qaFails(q3, q3.example, { state: 'blocked', waiting: { reason: 'qa' }, fixes: 0, work: { tasks: [{ id: 'T1' }] } }), ['ticket stops in working', 'fix task @qa1 opened (fix 1)']);
  assert.equal(E.scoreQa(q2, { ...qaRun(q2, null), accepted: false, why: 'refused' })[0].ok, false);
});

// M5.3 final review evals: what tbd kept (final/01.json = the example, the ticket as the handler leaves it, the mirrored
// docs with tbd's evidence section, the squash facts from git) against each case's example; an invented blocking
// finding, a rec missing from the evidence, a squash on two parents, a verdict doc without its work-done part, a HIGH
// where CRIT is due, a block that never names the unproven acceptance, a title over 120 fail the matching check.
const EVIDENCE = (c) => ['## Evidence (captured by tbd)', ...c.qa.cases.map((x) => `| ${x.id} | ${x.kind} | PASS | captured by tbd |`),
  ...c.recs.map((_, i) => `#### rec 1.${i + 1}\n\n\`\`\`\ncurl 'http://127.0.0.1:50461/orders'\n\`\`\``), '### Final checks', '(none)'].join('\n');
function finalRun(c, over = {}) {
  const e = c.expect;
  return {
    accepted: true, why: '', result: c.example, gate: { n: 1, ok: true, checks: [] }, base: 'b0', tested: 'h1',
    ticket: { state: e.state, waiting: e.waiting ? { reason: e.waiting } : null, fixes: e.fix ? 1 : 0, final: { tested_sha: 'h1' }, work: { tasks: [{ id: 'T1' }, ...(e.fix ? [{ id: e.fix }] : [])] } },
    report: `${c.docs.verdict}\n\n${EVIDENCE(c)}`, verification: c.docs.verification, summaryMd: '**Title:** x',
    git: { sha: 's1', head: 's1', branch: 's1', parents: ['b0'], tree: 'T', testedTree: 'T', pre: 'h1', subject: c.example.summary.title }, ...over,
  };
}
const finalFails = (c, over = {}) => E.scoreFinal(c, finalRun(c, over)).filter((x) => !x.ok).map((x) => x.name);

test('scoreFinal: the example of final E1-E3 passes; an invented block, a lost rec, a two-parent squash, no work done, HIGH for CRIT, an unnamed gap, a long title fail', () => {
  const [f1, f2, f3] = E.CASES.map((k) => E.caseOf('final_gate', k));
  for (const c of [f1, f2, f3]) assert.deepEqual(finalFails(c), [], c.key);
  const x1 = f1.example;
  const F = { id: 'F1', severity: 'MED', confidence: 'high', where: 'src/orders/orders.dto.ts:39', problem: 'no auth on POST /orders', failure_scenario: 'anyone posts', fix: 'add auth' };
  assert.deepEqual(finalFails(f1, { result: { ...x1, findings: [F] } }), ['no blocking finding (CRIT, HIGH or MED with high confidence)']);
  assert.deepEqual(finalFails(f1, { report: `${f1.docs.verdict}\n\n${EVIDENCE(f1).replace('#### rec 1.7\n', '')}` }),
    ['tbd appended "## Evidence (captured by tbd)" to the mirrored verdict doc: every QA case, every rec as curl, the final checks']);
  assert.deepEqual(finalFails(f1, { git: { ...finalRun(f1).git, parents: ['b0', 'h1'] } }),
    ['squash: HEAD + branch = final.sha, one commit on base, the tested tree, final-pre-<n> = tested, subject = summary title']);
  assert.deepEqual(finalFails(f1, { report: `${f1.docs.verdict.replace('All work done', 'Tasks')}\n\n${EVIDENCE(f1)}` }),
    ['verdict doc: Verdict + a line per phase + all work done + changes before → after']);
  assert.deepEqual(finalFails(f1, { result: { ...x1, summary: { ...x1.summary, title: 'x'.repeat(121) } } }),
    ['summary: the 6 fields (title ≤ 120, description ≤ 600, worked_on 1..15, blocker, need_review, verdict)', 'squash: HEAD + branch = final.sha, one commit on base, the tested tree, final-pre-<n> = tested, subject = summary title']);
  assert.deepEqual(finalFails(f2, { result: { ...f2.example, findings: [{ ...f2.example.findings[0], severity: 'HIGH' }] } }),
    ['a CRIT high-confidence finding at src/orders/orders.service.ts:19-23 or src/orders/orders.controller.ts:18-24']);
  assert.deepEqual(finalFails(f3, { result: { ...f3.example, findings: [{ ...F, problem: 'README row is stale', failure_scenario: 'a reader is misled', fix: 'reword it' }] } }),
    ['a blocking finding names the unproven acceptance (/\\bA1\\b|10[ _,.]?000[ _,.]?001|above the max/i)']);
  assert.equal(E.scoreFinal(f2, { ...finalRun(f2), accepted: false, why: 'refused' })[0].ok, false);
});

test('parse: --phase picks review, qa or final_gate; --packet is the review evals only; --no-ram-wait --real only', () => {
  assert.equal(E.parse(['--fake', '--phase', 'final_gate']).phase, 'final_gate');
  assert.equal(E.parse(['--fake', '--phase', 'qa']).phase, 'qa');
  assert.equal(E.parse(['--fake']).phase, 'review');
  assert.throws(() => E.parse(['--fake', '--phase', 'final']), /--phase: pick from review,qa/);
  assert.throws(() => E.parse(['--fake', '--phase', 'qa', '--packet', 'x']), /--packet: the review evals only/);
  assert.equal(E.parse(['--real', '--no-ram-wait']).noRamWait, true);
  assert.throws(() => E.parse(['--fake', '--no-ram-wait']), /--no-ram-wait: --real only/);
});

// D-0110 review E4 = final_gate E2's IDOR: a blocking finding at the service or controller lines passes whether labelled
// CRIT (the example) or HIGH; the check's evidence keeps the label for the report.
test('score E4: the CRIT example and a HIGH copy pass, the label in the evidence; verdict pass or the finding in another file fail', () => {
  const e4 = E.loadCase('E4');
  const f = e4.example.findings[0];
  const want = 'an open HIGH/CRIT high-confidence finding at src/orders/orders.service.ts:19-23 or src/orders/orders.controller.ts:18-24';
  const evidence = (result) => E.score(e4, { accepted: true, why: '', result }).find((x) => x.name === want).evidence;
  const high = { ...e4.example, findings: [{ ...f, severity: 'HIGH' }] };
  assert.deepEqual(fails(e4, e4.example), []);
  assert.equal(evidence(e4.example), 'F1 CRIT (high) src/orders/orders.controller.ts:22-23');
  assert.deepEqual(fails(e4, high), []);
  assert.equal(evidence(high), 'F1 HIGH (high) src/orders/orders.controller.ts:22-23');
  assert.deepEqual(fails(e4, { ...e4.example, verdict: 'pass' }), ['verdict block']);
  assert.deepEqual(fails(e4, { ...e4.example, findings: [{ ...f, where: 'src/common/caller.guard.ts:10-11' }] }), [want]);
});

test('parse: E4 is a review case, only when named (default E1-E3); qa or final_gate E4 refused', () => {
  assert.deepEqual(E.parse(['--fake', '--cases', 'E1,E2,E3,E4']).cases, ['E1', 'E2', 'E3', 'E4']);
  assert.deepEqual(E.parse(['--fake']).cases, ['E1', 'E2', 'E3']);
  assert.throws(() => E.parse(['--fake', '--phase', 'qa', '--cases', 'E4']), /^Error: --cases: pick from E1,E2,E3$/);
  assert.throws(() => E.parse(['--fake', '--phase', 'final_gate', '--cases', 'E1,E4']), /^Error: --cases: pick from E1,E2,E3$/);
  assert.throws(() => E.caseOf('qa', 'E4'), /no qa case E4/);
});

// harness.js blindPacket (D-0069): neutral labels, README with the lenses, labels outside; agent text may say "expect" or
// "PASS"; an answer-key name, a labels file inside, a file over 1 MB throw before anything is written.
test('blindPacket: neutral labels, README (7 lenses, 1-5, ./repo-at-base/, base), labels outside, "expect"/"PASS" kept; a key name, labels inside, > 1 MB throw', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbbp-')));
  try {
    const base = 'a1'.repeat(20);
    const diff = '+  it(\'answers 404\', () => expect(res.status).toBe(404)); // PASS before, FAIL after\n';
    const items = ['B', 'C'].map((key) => ({ key, files: { 'ticket.md': `# Ticket\n\nchange ${key.toLowerCase()}\n`, 'change.diff': diff } }));
    const dir = path.join(tmp, 'p');
    const labelsFile = path.join(tmp, 'labels.json');
    const labels = H.blindPacket(dir, items, { base, labelsFile });
    assert.deepEqual(Object.keys(labels).sort(), ['B', 'C']);
    assert.deepEqual(Object.values(labels).sort(), ['item-a', 'item-b']);
    assert.deepEqual(JSON.parse(fs.readFileSync(labelsFile, 'utf8')), labels);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['README.md', 'item-a', 'item-b']);
    assert.deepEqual(fs.readdirSync(path.join(dir, labels.B)).sort(), ['change.diff', 'ticket.md']);
    assert.equal(fs.readFileSync(path.join(dir, labels.C, 'change.diff'), 'utf8'), diff);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    for (const s of ['correctness, security, performance, API and data, code, tests, honesty', 'Score each folder 1-5', '`./repo-at-base/`', base]) assert.ok(readme.includes(s), s);

    const leak = path.join(tmp, 'leak');
    const l2 = path.join(tmp, 'l2.json');
    assert.throws(() => H.blindPacket(leak, [{ key: 'B', files: { 'change.diff': '+// the traps: sandbox-traps.md\n' } }], { base, labelsFile: l2 }), /blind packet: B change\.diff holds "sandbox-traps"/);
    assert.equal(fs.existsSync(leak), false);
    assert.equal(fs.existsSync(l2), false);
    const inside = path.join(tmp, 'in');
    assert.throws(() => H.blindPacket(inside, items, { base, labelsFile: path.join(inside, 'labels.json') }), /the labels file must lie outside/);
    assert.equal(fs.existsSync(inside), false);
    assert.throws(() => H.blindPacket(path.join(tmp, 'big'), [{ key: 'B', files: { 'change.diff': 'x'.repeat(1024 * 1024 + 1) } }], { base, labelsFile: path.join(tmp, 'l3.json') }),
      /diff too big for blind scoring/);
    assert.equal(fs.existsSync(path.join(tmp, 'big')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// eval-phase --packet keeps working through blindPacket: a transcript's worktree path and ticket id are anonymised, a
// tool named get_feedback stays; a transcript naming the answer key throws, nothing written.
test('writePacket: <root>/tbhome/worktrees/t_1a2b3c → <tmp>/tbhome/worktrees/<ticket>, get_feedback kept; test/golden/ in the transcript throws', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbr-')));
  try {
    const e1 = E.loadCase('E1');
    const use = (input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'get_feedback', input }] } });
    const run = (evs) => [{ key: 'E1', text: e1.ticket, diff: fs.readFileSync(e1.commits[0], 'utf8'), result: e1.example, runs: [{ n: 1, evs }] }];
    const evs = [use({ file_path: `${root}/tbhome/worktrees/t_1a2b3c/src/x.ts` })];
    const env = { root, base: 'b2'.repeat(20) };
    const dir = path.join(root, 'packet');
    const labels = E.writePacket(dir, env, run(evs));
    assert.deepEqual(labels, { E1: 'review-a' });
    const t = fs.readFileSync(path.join(dir, 'review-a', 'transcript.md'), 'utf8');
    assert.ok(t.includes('<tmp>/tbhome/worktrees/<ticket>/src/x.ts'), t);
    assert.ok(t.includes('**tool get_feedback:**'), t);
    assert.equal(t.includes('t_1a2b3c'), false);
    assert.equal(t.includes(root), false);

    const dir2 = path.join(root, 'packet2');
    assert.throws(() => E.writePacket(dir2, env, run([...evs, use({ command: 'cat test/golden/m5/review/E1/case.json' })])), /blind packet: E1 transcript\.md holds "test\/golden"/);
    assert.equal(fs.existsSync(dir2), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// M7 JS1 (tb eval golden): --json turns the fake results into a golden score JSON v1 (r-build.md frozen shape: ids
// <phase>:<case> / planner:<case>, cost_micro integer micro-USD, blind null) that lib/evalscore.js checkScore accepts; without
// --json none is asked for; --json with no file is refused.
test('JS1 --json: eval-phase + eval-planner fake results → score JSON v1 (review:E1, planner:e2, integer cost_micro from cost_delta or rounded dollars) that checkScore accepts; no --json → null; --json without a file → refused', () => {
  const meta = { commit: 'c'.repeat(40), sandbox_base: 'a'.repeat(40), mode: 'dry', at: '2026-10-18T00:00:00.000Z' };
  const r = { phase: 'review', key: 'E1', checks: [{ ok: true }, { ok: true }, { ok: false }], contaminated: [], min: 3, ticket: { state: 'working', waiting: { reason: 'manual' }, fixes: 0, rework: 1 },
    runs: [{ metric: { cost_delta: 410000 } }, { metric: null, result: { cost_usd: 0.1234567 } }] };
  const s = E.scoreOf([r], meta);
  assert.deepEqual(s, { v: 1, kind: 'golden-score', ...meta, sources: ['eval-phase'], pass: false,
    cases: [{ id: 'review:E1', run: 1, stop: 'working:manual', checks: { pass: 2, total: 3 }, contaminated: false, fix_rounds: 0, rework: 1, cost_micro: 533457, min: 3, blind: null }] });
  assert.equal(golden.checkScore(s), null);
  const p = P.scoreOf([{ key: 'e2', checks: [{ ok: true }], rounds: [{ secs: 200, ticket: { state: 'plan_approval', waiting: null }, runs: [{ metric: { cost_delta: 900000 } }] }] }], meta);
  assert.deepEqual(p.cases, [{ id: 'planner:e2', run: 1, stop: 'plan_approval', checks: { pass: 1, total: 1 }, contaminated: false, fix_rounds: null, rework: null, cost_micro: 900000, min: 3, blind: null }]);
  assert.deepEqual([p.sources, p.pass, golden.checkScore(p)], [['eval-planner'], true, null]);
  assert.deepEqual([E.parse(['--fake']).json, P.parse(['--fake']).json, E.parse(['--fake', '--json', 'out.json']).json], [null, null, 'out.json']);
  assert.throws(() => E.parse(['--fake', '--json']), /--json needs a file/);
  assert.throws(() => P.parse(['--fake', '--json']), /--json needs a file/);
});
