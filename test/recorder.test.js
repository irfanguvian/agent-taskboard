'use strict';
// M5.2 C6 (contract .omc/handoffs/m5-contract.md rev 4; D-0086, A10): `tbx req` → tbd's socket op http.req → lib/recorder.js
// through a real tbd (harness temp HOME + TB_HOME, TB_PORT fixed so its own port is known) with fixture code/qa and
// code/working phases and test/fake-claude.js as claude_bin. One scenario for both tickets: an exec step runs probe.sh with
// the run's env (TBD_SOCK, TBX_RUN, TB_PHASE, bin/tbx on PATH); the qa run starts an echo server under its own run root,
// then calls `tbx req`; the working run calls it once. Each tbx output lands in OUT. Q4 Q5 Q9 read them after both runs.
// Q5b: lib/recorder.js recKey in-process.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startTbd, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const OUT = path.join(ROOT, 'out');
const QA = 't_qa0001';
const WK = 't_wk0001';
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => r(port)); }); });
let tbd;
let foreign;
let P = /** @type {Record<string, number>} */ ({});
const out = (name) => fs.readFileSync(path.join(OUT, `${name}.out`), 'utf8');
const recFile = () => path.join(tbd.tbHome, 'tickets', QA, 'runs', '1.rec.jsonl');

before(async () => {
  P = { ok: await free(), foreign: await free(), tbd: await free(), out: await free() };
  fs.mkdirSync(OUT);
  // Q9: a listener on a qa port that this test process holds, not the run
  foreign = http.createServer((_q, r) => r.end('foreign')).listen(P.foreign, '127.0.0.1');
  const phases = path.join(ROOT, 'phases');
  for (const ph of ['qa', 'working']) {
    fs.mkdirSync(path.join(phases, 'code', ph), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'phases', 'code', ph, 'settings.json'), path.join(phases, 'code', ph, 'settings.json'));
    fs.writeFileSync(path.join(phases, 'code', ph, 'result.schema.json'), '{}');
    fs.writeFileSync(path.join(phases, 'code', ph, 'prompt.md'), `# ${ph} fixture\n`);
  }
  const tagDir = path.join(ROOT, 'repo');
  fs.mkdirSync(tagDir);
  // D-0102: PORT (all digits) stays readable in the rec file, the DB URL (8+ characters) is redacted
  fs.writeFileSync(path.join(tagDir, '.env.test'), `API_SECRET=env-FFF-secret\nPORT=${P.ok}\nDATABASE_URL=postgres://app:pw-HHH@localhost/app\n`);
  // echo server: the request's headers and parsed body back, plus a session cookie
  const server = path.join(ROOT, 'server.js');
  fs.writeFileSync(server, `const [port, ready] = process.argv.slice(2);
require('node:http').createServer((q, r) => {
  let b = '';
  q.on('data', (c) => (b += c));
  q.on('end', () => {
    const got = (q.headers['content-type'] ?? '').includes('json') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b));
    r.setHeader('set-cookie', 'sid=sess-GGG');
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ headers: q.headers, got }));
  });
}).listen(Number(port), '127.0.0.1', () => require('node:fs').writeFileSync(ready, ''));
`);
  const probe = path.join(ROOT, 'probe.sh');
  fs.writeFileSync(probe, `req() { name=$1; shift; tbx req "$@" > "${OUT}/$name.out" 2>&1; echo "exit $?" >> "${OUT}/$name.out"; }
# the run root is registered a moment after the spawn: the first call is retried while tbd does not know the run key yet
first() { i=0; req "$@"; while grep -q 'unknown run key' "${OUT}/$1.out" && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; req "$@"; done; }
if [ "$TB_PHASE" = working ]; then first working GET http://127.0.0.1:${P.ok}/; exit 0; fi
"${process.execPath}" "${server}" ${P.ok} "${OUT}/ready" & srv=$!
while [ ! -f "${OUT}/ready" ]; do sleep 0.05; done
first port GET http://127.0.0.1:${P.out}/
req host GET http://10.0.0.1:${P.ok}/
req tbd GET http://127.0.0.1:${P.tbd}/api/state
req foreign GET http://127.0.0.1:${P.foreign}/
req json POST "http://localhost:${P.ok}/login?token=q-EEE&page=2" -H 'Authorization: Bearer tok-AAA' -H 'Cookie: sid=cookie-BBB' -H 'X-Note: env-FFF-secret' -H 'X-Db: postgres://app:pw-HHH@localhost/app' -H 'Content-Type: application/json' -d '{"user":"ann","password":"pw-CCC"}'
req form POST http://127.0.0.1:${P.ok}/login -H 'Content-Type: application/x-www-form-urlencoded' -d 'user=ann&password=pw-DDD'
kill $srv
`);
  const scenario = path.join(ROOT, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ steps: [{ exec: ['/bin/sh', probe] }, { result: { structured_output: { throw: 'probe done' } } }] }));
  const files = {
    'config.json': {
      claude_bin: FAKE, max_concurrent: 2, disk: { warn_gb: 0, stop_gb: 0 },
      memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
    },
    // P.tbd is listed on purpose: tbd's own port is refused even when the tag names it
    'tags.json': { acme: {}, 'acme/api': { type: 'git', path: tagDir, base: 'main', env_files: ['.env.test'], qa_ports: [P.ok, P.foreign, P.tbd] } },
    [`tickets/${QA}/ticket.json`]: ticket(QA, { state: 'qa', tag: 'acme/api', round: 1 }),
    [`tickets/${WK}/ticket.json`]: ticket(WK, { state: 'working', tag: 'acme/api', round: 1 }),
  };
  tbd = await startTbd({ files, env: { TB_PORT: String(P.tbd), TB_PHASES_DIR: phases, NODE_OPTIONS: RUN_SPY, TEST_PRESSURE: 'normal', FAKE_CLAUDE_SCENARIO: scenario } });
  // the fixture handler throws on the scenario's result: each ticket ends Blocked after its one run
  await until(() => read(tbd, QA).state === 'blocked' && read(tbd, WK).state === 'blocked', 60_000, 'both probe runs');
});
after(async () => {
  foreign?.close();
  if (tbd) {
    reap(pidsOf(tbd));
    await tbd.stop().catch(() => {});
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const recLines = () => fs.readFileSync(recFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('Q4 tbx req to a non-loopback host, a port not in qa_ports, tbd\'s port (though listed), or from a working run → refused, nothing written', () => {
  /** @type {[string, RegExp][]} */
  const refused = [
    ['host', /url must be http:\/\/localhost/],
    ['port', new RegExp(`port ${P.out} is not one of the tag's qa_ports`)],
    ['tbd', new RegExp(`port ${P.tbd} is not one of the tag's qa_ports`)],
    ['working', /works only in a qa run/],
  ];
  for (const [name, why] of refused) {
    const o = out(name);
    assert.match(o, why, name);
    assert.match(o, /exit 1\n$/, name);
    assert.doesNotMatch(o, /^rec /m, `${name}: no rec id`);
  }
  const urls = recLines().slice(1).map((l) => l.url);
  assert.deepEqual(urls.map((u) => new URL(u).port), [String(P.ok), String(P.ok)], 'only the two allowed calls are in the file');
  assert.deepEqual(fs.readdirSync(path.join(tbd.tbHome, 'tickets', WK, 'runs')).filter((f) => f.includes('.rec.')), [], 'the working run has no rec file');
});

test('Q9 a listener on a qa port that is not under the run root → refused, nothing written; one under it → recorded', () => {
  assert.match(out('foreign'), new RegExp(`port ${P.foreign}: no listener, or one this run did not start\\nexit 1\\n$`));
  assert.ok(!recLines().some((l) => l.url?.includes(`:${P.foreign}`)));
  assert.match(out('json'), /^rec 1\.1\nstatus 200\n/);
  assert.match(out('form'), /^rec 1\.2\nstatus 200\n/);
});

test('Q5 Authorization, Cookie, a JSON and a form-encoded password, a query token: <masked:h8> (HMAC, rec-key) in the file; env values [redacted]; the agent gets them unmasked', () => {
  const key = fs.readFileSync(path.join(tbd.tbHome, 'rec-key'));
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(path.join(tbd.tbHome, 'rec-key')).mode & 0o777, 0o600);
  const h8 = (v) => `<masked:${crypto.createHmac('sha256', key).update(v).digest('hex').slice(0, 8)}>`;
  const text = fs.readFileSync(recFile(), 'utf8');
  assert.equal(fs.statSync(recFile()).mode & 0o777, 0o600);
  for (const s of ['tok-AAA', 'cookie-BBB', 'pw-CCC', 'pw-DDD', 'q-EEE', 'env-FFF-secret', 'sess-GGG', 'pw-HHH']) assert.ok(!text.includes(s), `${s} is not in the rec file`);
  const [meta, json, form] = recLines();
  assert.deepEqual(meta, { meta: true, ticket: QA, run: 1, phase: 'qa', round: 1, gen: 1 });
  assert.equal(json.n, '1.1');
  assert.equal(json.url, `http://localhost:${P.ok}/login?token=${h8('q-EEE')}&page=2`, 'PORT=<P.ok> in the env file: an all-digit value stays readable (D-0102)');
  const sent = Object.fromEntries(json.req.headers);
  assert.deepEqual([sent.Authorization, sent.Cookie, sent['X-Note'], sent['X-Db']], [h8('Bearer tok-AAA'), h8('sid=cookie-BBB'), '[redacted]', '[redacted]']);
  assert.deepEqual(JSON.parse(json.req.body), { user: 'ann', password: h8('pw-CCC') });
  assert.equal(json.res.status, 200);
  assert.equal(Object.fromEntries(json.res.headers)['set-cookie'], h8('sid=sess-GGG'));
  const echoed = JSON.parse(json.res.body);
  assert.deepEqual([echoed.headers.authorization, echoed.headers.cookie, echoed.got.password], [h8('Bearer tok-AAA'), h8('sid=cookie-BBB'), h8('pw-CCC')], 'the same secret masks the same in the reply body');
  assert.equal(form.req.body, `user=ann&password=${h8('pw-DDD')}`);
  // the agent's own output: the reply as the app sent it
  for (const s of ['pw-CCC', 'Bearer tok-AAA', 'sid=cookie-BBB', 'sid=sess-GGG']) assert.ok(out('json').includes(s), `${s} reaches the agent`);
  assert.ok(out('form').includes('pw-DDD'));
  // bodies a regex reads: JSON cut short or malformed, a form body ending in a newline (--data-file), pass / pwd / credential keys
  process.env.TB_HOME = fs.mkdtempSync(path.join(ROOT, 'home-')); // lib/store (required by the recorder) reads it at load: never the real ~/.taskboard
  const { maskBody } = require('../lib/recorder');
  assert.ok(!maskBody('{"user":"ann","password":"pw-III","list":[1,', key).includes('pw-III'), 'JSON that does not parse');
  assert.ok(!maskBody('user=ann&password=pw-JJJ\n', key).includes('pw-JJJ'), 'a form body with a trailing newline');
  assert.ok(!maskBody('{"db_pass":"pw-KKK","pwd":"pw-LLL","credentials":"pw-MMM"}', key).includes('pw-'), 'pass, pwd, credential keys');
});

test('Q5b two first uses of rec-key at once → one key (32 bytes, 0600, no temp file left)', async () => {
  const home = fs.mkdtempSync(path.join(ROOT, 'key-'));
  process.env.TB_HOME = home; // lib/store (required by the recorder) reads it at load: never the real ~/.taskboard
  const { recKey } = require('../lib/recorder');
  const keys = await Promise.all(Array.from({ length: 8 }, () => recKey(home)));
  assert.equal(keys[0].length, 32);
  for (const k of keys) assert.ok(k.equals(keys[0]), 'every racer reads back the one key');
  assert.ok(keys[0].equals(fs.readFileSync(path.join(home, 'rec-key'))));
  assert.equal(fs.statSync(path.join(home, 'rec-key')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home), ['rec-key']);
});
