'use strict';
// M5.2 parity (contract .omc/handoffs/m5-contract.md rev 4 C20 rows "tb report --kind qa / rec", "GET …/docs", "tb show";
// C21 A01): GET …/report?kind=qa|rec, GET …/docs?path=, `tb report --kind qa|rec` and the QA line of `tb show` on a real
// tbd (temp HOME + TB_HOME, port 0) with a seeded ticket and the files lib/qa.js, lib/recorder.js and lib/docs.js write
// (qa/NN.json, runs/<n>.rec.jsonl, the docs mirror). No agent runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTbd, runTb } = require('./helpers/tbd');
const { ticket } = require('./helpers/runs');

const ID = 't_qrp001';
const HEAD = 'a'.repeat(40);
const AT = '2026-10-13T01:02:03.000Z';
const REPORT = `docs/verification/2026-10-13-${ID}-qa.md`;
const MD = '# QA\n<script>alert(1)</script>\n';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
const C = (id, over = {}) => ({ id, type: 'backend', kind: 'positive', source: 'src/users.js:3', acceptance: ['A1'], pre: '', steps: ['POST /api/users'], expect: '201',
  result: 'PASS', recs: ['7.1'], screenshots: [], observed: { status: 201, note: 'made' }, evidence: 'captured by tbd', ...over });
const Q = (n, cases, over = {}) => ({ n, at: AT, round: 1, head: HEAD, verdict: 'fail', cases, report: REPORT, findings: [], need_review: [], ...over });
// rec lines as lib/recorder.js writes them (masked already); 2..5 carry a 20 KB answer, 6 a 20 KB request + answer
const rec = (k, over = {}) => ({ n: `7.${k}`, at: AT, method: 'POST', url: 'http://127.0.0.1:4100/api/users?token=<masked:0badc0de>',
  req: { headers: [['authorization', '<masked:1234abcd>'], ['content-type', 'application/json']], body: '{"name":"o\'brien"}', truncated: false },
  res: { status: 201, headers: [['content-type', 'application/json']], body: k === 1 ? '{"id":1}' : 'x'.repeat(20_000), truncated: false }, ms: 12, ...over });
const jsonl = (...v) => v.map((x) => JSON.stringify(x)).join('\n') + '\n';
const meta = (run, phase) => ({ meta: true, ticket: ID, run, phase, round: 1, gen: 1 });

let tbd;
const tk = (...f) => path.join(tbd.tbHome, 'tickets', ID, ...f);
before(async () => {
  tbd = await startTbd({ files: {
    [`tickets/${ID}/ticket.json`]: ticket(ID, { kind: 'code', state: 'backlog', qa: { n: 2, head: HEAD, verdict: 'fail', pass: 2, fail: 1, blocked: 0, report: REPORT } }),
    // QA 1: too big for one page (30 cases of 8 KB steps), its one FAIL last
    [`tickets/${ID}/qa/01.json`]: Q(1, Array.from({ length: 30 }, (_, i) => C(`TC-${i + 1}`, { steps: Array(4).fill('s'.repeat(2048)), ...(i === 29 && { result: 'FAIL', cause: 'code' }) })), { findings: ['f'.repeat(2048)] }),
    [`tickets/${ID}/qa/02.json`]: Q(2, [C('TC-1'),
      C('TC-2', { type: 'frontend', kind: 'negative', result: 'FAIL', cause: 'code', recs: [], screenshots: ['docs/verification/screenshots/s.png'], observed: { note: 'no error shown' }, evidence: 'agent-made' }),
      C('TC-3', { type: 'frontend', recs: [], observed: { note: 'list shown' }, evidence: 'agent-made' })],
    { need_review: ['QA 2: TC-3 passed on agent-made evidence only (screenshots, notes; D-0092): it can be faked, check it by hand'] }),
    [`tickets/${ID}/runs/7.rec.jsonl`]: jsonl(meta(7, 'qa'), rec(1), rec(2), rec(3), rec(4), rec(5), rec(6, { req: { headers: [], body: 'b'.repeat(20_000), truncated: false } })),
    [`tickets/${ID}/runs/3.rec.jsonl`]: jsonl(meta(3, 'working'), rec(1, { n: '3.1' })),
    [`tickets/${ID}/${REPORT}`]: MD,
    [`tickets/${ID}/other/x.md`]: 'outside the mirror\n',
  } });
  fs.mkdirSync(tk('docs', 'verification', 'screenshots'), { recursive: true });
  fs.writeFileSync(tk('docs', 'verification', 'screenshots', 's.png'), PNG);
  fs.mkdirSync(tk('docs', 'verification', 'screenshots', 'run1'));
  fs.writeFileSync(tk('docs', 'verification', 'screenshots', 'run1', 'x.png'), PNG); // nested, as the result schema allows
  fs.symlinkSync('../../ticket.json', tk('docs', 'verification', 'link.md')); // a link in the mirror
  fs.symlinkSync('../other', tk('docs', 'verdicts')); // a linked dir on the way
  fs.writeFileSync(tk('docs', 'verification', 'big.md'), '');
  fs.truncateSync(tk('docs', 'verification', 'big.md'), 5 * 1024 * 1024 + 1); // sparse: over 5 MB on no disk
});
after(() => tbd?.stop());
const get = (p, h) => tbd.api('GET', `/api/tickets/${ID}${p}`, undefined, h);

test('report kind=qa: newest by default, cases with evidence labels + need_review; cut to 64 KB PASS cases first; 404 missing n, 400 bad n', async () => {
  const r = await get('/report?kind=qa');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.n, r.json.verdict, r.json.report, r.json.need_review.length], [2, 'fail', REPORT, 1]);
  assert.deepEqual(r.json.cases.map((c) => [c.id, c.result, c.evidence]), [['TC-1', 'PASS', 'captured by tbd'], ['TC-2', 'FAIL', 'agent-made'], ['TC-3', 'PASS', 'agent-made']]);
  const big = await get('/report?kind=qa&n=1');
  assert.ok(Buffer.byteLength(big.text) <= 64 * 1024, `${Buffer.byteLength(big.text)} bytes`);
  assert.equal(big.json.truncated, true);
  assert.deepEqual(big.json.findings, [], 'findings go first');
  assert.equal(big.json.cases.at(-1).id, 'TC-30', 'the FAIL case outlives the PASS ones');
  assert.ok(big.json.cases.length < 30);
  assert.equal((await get('/report?kind=qa&n=3')).status, 404);
  for (const q of ['kind=qa&n=0', 'kind=qa&n=x', 'kind=qa&n=../../token']) assert.equal((await get(`/report?${q}`)).status, 400, q);
});

test('report kind=rec: pages ≤ 64 KB by cursor, each rec as curl + status + headers + body as kept (masked); a non-QA rec file 404; bad run / cursor 400', async () => {
  const p1 = await get('/report?kind=rec');
  assert.equal(p1.status, 200);
  assert.ok(Buffer.byteLength(p1.text) <= 64 * 1024, `${Buffer.byteLength(p1.text)} bytes`);
  assert.deepEqual([p1.json.run, p1.json.runs, p1.json.items.map((x) => x.n), p1.json.next], [7, [7, 3], ['7.1', '7.2', '7.3', '7.4'], 4]);
  const [one, two] = p1.json.items;
  assert.equal(one.curl, `curl -X POST 'http://127.0.0.1:4100/api/users?token=<masked:0badc0de>' -H 'authorization: <masked:1234abcd>' -H 'content-type: application/json' --data-raw '{"name":"o'\\''brien"}'`);
  assert.deepEqual([one.status, one.headers, one.body, one.truncated], [201, [['content-type', 'application/json']], '{"id":1}', false]);
  assert.deepEqual([two.body.length, two.truncated], [16 * 1024 + 1, true], 'a long answer is cut and says so');
  const p2 = await get('/report?kind=rec&run=7&cursor=4');
  assert.deepEqual([p2.json.items.map((x) => x.n), p2.json.next], [['7.5', '7.6'], null]);
  assert.ok(p2.json.items[1].curl.length <= 1025 && p2.json.items[1].truncated, 'a rec too big for half a page is cut to 1 KB texts');
  assert.equal((await get('/report?kind=rec&run=3')).status, 404, 'a rec file whose meta line is not QA');
  assert.equal((await get('/report?kind=rec&run=9')).status, 404);
  for (const q of ['run=0', 'run=x', 'run=-1', 'cursor=x', 'cursor=-1']) assert.equal((await get(`/report?kind=rec&${q}`)).status, 400, q);
});

test('docs route: md as text/plain, png as image/png (also dirs down), nosniff; regex, .., link, linked dir, > 5 MB, missing → refused; token or cookie needed; unknown id 404', async () => {
  const md = await get(`/docs?path=${encodeURIComponent(REPORT.slice(5))}`);
  assert.deepEqual([md.status, md.headers['content-type'], md.headers['x-content-type-options'], md.text], [200, 'text/plain; charset=utf-8', 'nosniff', MD]);
  const png = await fetch(`${tbd.url}/api/tickets/${ID}/docs?path=verification/screenshots/s.png`, { headers: { 'x-tb-token': tbd.token } });
  assert.deepEqual([png.status, png.headers.get('content-type'), Buffer.from(await png.arrayBuffer()).equals(PNG)], [200, 'image/png', true]);
  assert.equal((await get('/docs?path=verification/screenshots/run1/x.png')).status, 200, 'a doc two dirs down');
  for (const p of ['', '../ticket.json', 'verification/../../ticket.json', '..%2Fticket.json', 'verification/x.txt', 'verification/run1/../x.md', '/etc/passwd', 'qa/01.json']) {
    assert.equal((await get(`/docs?path=${p}`)).status, 400, p);
  }
  for (const p of ['verification/none.md', 'verification/a/b.md', 'verification/link.md', 'verdicts/x.md', 'verification/big.md']) assert.equal((await get(`/docs?path=${p}`)).status, 404, p);
  assert.equal((await get('/docs?path=verification/screenshots/s.png', { 'x-tb-token': undefined })).status, 401);
  const cookie = await tbd.unlock();
  assert.equal((await get('/docs?path=verification/screenshots/s.png', { 'x-tb-token': undefined, cookie })).status, 200, 'the page reads it with its cookie');
  assert.equal((await tbd.api('GET', '/api/tickets/t_nope99/docs?path=verification/none.md')).status, 404);
});

test('tb report --kind qa | rec, tb show QA line; --n with rec, --run with qa: usage exit 2', async () => {
  const qa = await runTb(['report', ID, '--kind', 'qa'], tbd);
  assert.equal(qa.code, 0, qa.stderr);
  assert.equal(qa.stdout, [`report: ${ID} · qa 2 · fail · head aaaaaaaaaaaa · ${AT}`, `  file: ${REPORT}`,
    'cases[3]{id,type,kind,result,cause,evidence,source,recs}:',
    '  TC-1,backend,positive,PASS,"",captured by tbd,"src/users.js:3","7.1"', '  TC-2,frontend,negative,FAIL,code,agent-made,"src/users.js:3",""',
    '  TC-3,frontend,positive,PASS,"",agent-made,"src/users.js:3",""',
    'need_review[1]:', '  "QA 2: TC-3 passed on agent-made evidence only (screenshots, notes; D-0092): it can be faked, check it by hand"', 'findings[0]: none', ''].join('\n'));
  const r1 = await runTb(['report', ID, '--kind', 'rec'], tbd);
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stdout, new RegExp(`^recs: ${ID} · run 7 · 4 shown · runs 7, 3\nrec 7\\.1 · 201 · 12 ms · ${AT}\n {4}\\$ curl -X POST 'http://127\\.0\\.0\\.1:4100/api/users\\?token=<masked:0badc0de>' -H 'authorization: <masked:1234abcd>'.*\n {4}HTTP 201\n {4}content-type: application/json\n {4}\n {4}\\{"id":1\\}\n`));
  assert.match(r1.stdout, /\nhelp: \S+ report t_qrp001 --kind rec --run 7 --cursor 4 for more\n$/);
  const r2 = await runTb(['report', ID, '--kind', 'rec', '--run', '7', '--cursor', '4'], tbd);
  assert.match(r2.stdout, /^recs: t_qrp001 · run 7 · 2 shown/);
  assert.doesNotMatch(r2.stdout, /help:/, 'the last page names no next cursor');
  assert.match((await runTb(['show', ID], tbd)).stdout, /\n {2}qa: fail · pass 2 · fail 1 · blocked 0 · qa 2\n/);
  for (const args of [['--kind', 'rec', '--n', '1'], ['--kind', 'qa', '--run', '7'], ['--kind', 'rec', '--run', '0']]) assert.equal((await runTb(['report', ID, ...args], tbd)).code, 2, args.join(' '));
});
