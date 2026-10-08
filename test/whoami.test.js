'use strict';
// H9 (P2 fix loop): the tb CLI proves the port is tbd before it sends the token. GET /api/whoami?n=<nonce> is public and
// answers { mac: HMAC-SHA256(token, nonce) } (hex); tb sends X-TB-Token only after the mac matches, once per process.
// Real tbd on a temp HOME + TB_HOME (harness); "squatters" are plain http servers on a temp port. The gc-timeout test runs
// the CLI in process against a fake tbd, because a 10 minute timeout cannot be waited out.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { startTbd, runTb } = require('./helpers/tbd');

const mac = (token, n) => crypto.createHmac('sha256', token).update(n).digest('hex');
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const noToken = { 'x-tb-token': undefined };

const roots = [];
const servers = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// A HOME + TB_HOME holding only a token file: all the CLI needs to talk to something on a port.
function cliHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whoami-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const tbHome = path.join(root, 'tbhome');
  fs.mkdirSync(home);
  fs.mkdirSync(tbHome);
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(tbHome, 'token'), token, { mode: 0o600 });
  return { home, tbHome, token };
}

// http server on a free port; seen = [{ method, url, token }] for every request it got.
async function listen(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-tb-token'] });
    handler(req, res);
  });
  servers.push(server);
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, seen };
}

describe('GET /api/whoami on a real tbd', () => {
  let t;
  before(async () => { t = await startTbd(); });
  after(() => t.stop());

  test('H9 needs no token and answers HMAC-SHA256(token, n) as hex; another n, another mac; 16 and 128 hex chars are the bounds', async () => {
    const r = await t.api('GET', `/api/whoami?n=${NONCE}`, undefined, noToken);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mac: mac(t.token, NONCE) });
    assert.deepEqual((await t.api('GET', `/api/whoami?n=${NONCE}`)).json, r.json, 'a token in the request changes nothing');
    const other = (await t.api('GET', `/api/whoami?n=${'b'.repeat(32)}`, undefined, noToken)).json.mac;
    assert.notEqual(other, r.json.mac);
    for (const n of ['a'.repeat(16), 'A'.repeat(16), 'f'.repeat(128)]) {
      assert.deepEqual((await t.api('GET', `/api/whoami?n=${n}`, undefined, noToken)).json, { mac: mac(t.token, n) }, n.slice(0, 20));
    }
  });

  test('H9 n must be 16-128 hex characters: missing, empty, short, long, not hex are a 400 without a mac', async () => {
    const paths = ['/api/whoami', '/api/whoami?n=', `/api/whoami?n=${'a'.repeat(15)}`, `/api/whoami?n=${'a'.repeat(129)}`,
      `/api/whoami?n=${'g'.repeat(32)}`, `/api/whoami?n=${'a'.repeat(31)}%00`, `/api/whoami?x=${NONCE}`];
    for (const p of paths) {
      const r = await t.api('GET', p, undefined, noToken);
      assert.equal(r.status, 400, p);
      assert.equal(r.json.mac, undefined, p);
      assert.match(r.json.error, /16-128 hex/);
    }
  });

  test('H9 public means GET only and still behind the Host and cross-site guards: POST is 401, a rebinding Host and a cross-site fetch are 403', async () => {
    assert.equal((await t.api('POST', `/api/whoami?n=${NONCE}`, {}, noToken)).status, 401);
    assert.equal((await t.api('GET', `/api/whoami?n=${NONCE}`, undefined, { ...noToken, host: 'evil.example' })).status, 403);
    assert.equal((await t.api('GET', `/api/whoami?n=${NONCE}`, undefined, { ...noToken, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).status, 403);
    assert.equal((await t.api('GET', '/api/state', undefined, noToken)).status, 401, 'the rest of /api stays locked');
  });
});

// Stub tbd in its own process: the first `starting` whoami requests get 503 {"error":"starting"} (Infinity = all of them),
// later ones the real mac for c.token; /api/state answers an empty board. seen() = every request: { at, url, token }.
async function startingStub(c, starting, tc) {
  const log = path.join(path.dirname(c.tbHome), 'stub.log');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const crypto = require('crypto');
    const [token, log, starting] = process.argv.slice(1);
    let n = 0;
    const server = require('http').createServer((req, res) => {
      fs.appendFileSync(log, JSON.stringify({ at: Date.now(), url: req.url, token: req.headers['x-tb-token'] }) + '\\n');
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/api/whoami') return void res.end(JSON.stringify({ reminders: [], flows: [], system: {}, calendar: { updated: null, events: [] } }));
      if (n++ < Number(starting)) { res.writeHead(503); return void res.end('{"error":"starting"}'); }
      res.end(JSON.stringify({ mac: crypto.createHmac('sha256', token).update(url.searchParams.get('n')).digest('hex') }));
    }).listen(0, '127.0.0.1', () => console.log(server.address().port));`, c.token, log, String(starting)], { stdio: ['ignore', 'pipe', 'inherit'] });
  tc.after(() => child.kill());
  const [chunk] = await once(child.stdout, 'data');
  return { port: Number(String(chunk).trim()), seen: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

describe('tb CLI identity check while tbd starts (503 starting)', () => {
  test('D39 whoami 503 starting twice, then the right mac: tb waits ~250 ms between tries, then sends the token and succeeds', async (tc) => {
    const c = cliHome();
    const stub = await startingStub(c, 2, tc);
    const r = await runTb(['list'], { ...c, port: stub.port });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const seen = stub.seen();
    assert.deepEqual(seen.map((q) => [q.url.split('?')[0], q.token]), [
      ['/api/whoami', undefined], ['/api/whoami', undefined], ['/api/whoami', undefined], ['/api/state', c.token],
    ]);
    for (const i of [1, 2]) assert.ok(seen[i].at - seen[i - 1].at >= 200, `retry ${i} after ${seen[i].at - seen[i - 1].at} ms`);
  });

  test('D39 whoami 503 starting for good: exit 1 "tbd is starting; try again" after ~5 s, the token never sent', async (tc) => {
    const c = cliHome();
    const stub = await startingStub(c, Infinity, tc);
    const t0 = Date.now();
    const r = await runTb(['list'], { ...c, port: stub.port });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^error: tbd is starting; try again$/m);
    assert.doesNotMatch(r.stdout, /is not tbd/);
    assert.ok(Date.now() - t0 >= 4500, `gave up after ${Date.now() - t0} ms`);
    const seen = stub.seen();
    assert.ok(seen.length >= 10 && seen.every((q) => q.url.startsWith('/api/whoami?n=')), JSON.stringify(seen.map((q) => q.url)));
    assert.equal(seen.some((q) => q.token !== undefined), false, 'the token never left the CLI');
    assert.ok(!r.stdout.includes(c.token) && !r.stderr.includes(c.token));
  });
});

describe('tb CLI identity check', () => {
  const squatters = /** @type {[string, (req: http.IncomingMessage, res: http.ServerResponse) => void][]} */ ([
    ['answers 404 to everything', (req, res) => { res.writeHead(404); res.end('{}'); }],
    ['answers whoami with the wrong mac', (req, res) => { res.end(JSON.stringify({ mac: 'ab'.repeat(32) })); }],
    ['answers whoami with 200 and no mac', (req, res) => { res.end('{}'); }],
    ['answers whoami with a page, not JSON', (req, res) => { res.end('<html>hello</html>'); }],
    ['answers a mac whose bytes differ in length from its characters', (req, res) => { res.end(JSON.stringify({ mac: 'é'.repeat(64) })); }],
    ['says 200 with a mac but status 500', (req, res) => { res.writeHead(500); res.end(JSON.stringify({ mac: 'x' })); }],
  ]);

  for (const [what, handler] of squatters) {
    test(`H9 a server that ${what} gets no token: exit 1 "port is not tbd" after one whoami request`, async () => {
      const c = cliHome();
      const s = await listen(handler);
      const r = await runTb(['list'], { ...c, port: s.port });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, new RegExp(`^error: port ${s.port} is not tbd \\(identity check failed\\)$`, 'm'));
      assert.equal(s.seen.length, 1, JSON.stringify(s.seen));
      assert.match(s.seen[0].url, /^\/api\/whoami\?n=[0-9a-f]{32}$/);
      assert.equal(s.seen.some((q) => q.token !== undefined), false, 'the token never left the CLI');
      assert.ok(!r.stdout.includes(c.token) && !r.stderr.includes(c.token));
    });
  }

  test('H9 the real tbd passes: whoami without token first, then every request with it, one whoami per process', async (tc) => {
    const t = await startTbd({ files: { 'tasks.json': { tasks: [{ id: 't_k3x9qa', title: 'Reply to recruiter', status: 'now', created: '2026-09-23' }] } } });
    tc.after(() => t.stop());
    const proxy = await listen((req, res) => {
      const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    const r = await runTb(['done', 'Reply to recruiter'], { tbHome: t.tbHome, home: t.home, port: proxy.port }); // 3 api calls
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(proxy.seen.map((q) => `${q.method} ${q.url.split('?')[0]}`), ['GET /api/whoami', 'GET /api/state', 'PATCH /api/reminders/t_k3x9qa', 'GET /api/state']);
    assert.deepEqual(proxy.seen.map((q) => q.token), [undefined, t.token, t.token, t.token]);
    assert.equal((await t.api('GET', '/api/state')).json.reminders[0].status, 'done');
  });

  test('H9 a tbd that is down still reads "tbd not running"; a token file that is not the daemon\'s fails the identity check', async (tc) => {
    const c = cliHome();
    const probe = net.createServer();
    await once(probe.listen(0, '127.0.0.1'), 'listening');
    const dead = /** @type {import('node:net').AddressInfo} */ (probe.address()).port;
    probe.close();
    await once(probe, 'close');
    const down = await runTb(['list'], { ...c, port: dead });
    assert.equal(down.code, 1);
    assert.match(down.stdout, /^error: tbd not running$/m);

    const t = await startTbd();
    tc.after(() => t.stop());
    const wrong = await runTb(['list'], { ...c, port: t.port });
    assert.equal(wrong.code, 1, wrong.stdout);
    assert.match(wrong.stdout, new RegExp(`^error: port ${t.port} is not tbd \\(identity check failed\\)$`, 'm'));
  });
});

describe('tb gc request timeout', () => {
  test('H2 tb gc and tb gc --delete wait up to 10 minutes; the identity check does not carry the token and keeps the default 5 s', async () => {
    const c = cliHome();
    const fake = await listen((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/whoami') return void res.end(JSON.stringify({ mac: mac(c.token, url.searchParams.get('n')) }));
      res.end(JSON.stringify(req.method === 'GET' ? { items: [], total: 0, next: null } : { deleted: [], skipped: [] }));
    });
    Object.assign(process.env, { TB_HOME: c.tbHome, TB_PORT: String(fake.port), HOME: c.home }); // cli.js reads these when it loads
    const { main } = require('../lib/cli');
    const options = [];
    const realRequest = http.request;
    const log = console.log;
    http.request = /** @type {any} */ ((o, cb) => { options.push(o); return realRequest(o, cb); });
    console.log = () => {};
    try {
      await main(['gc']);
      await main(['gc', '--delete', 'cache/x']);
    } finally {
      http.request = realRequest;
      console.log = log;
    }
    assert.deepEqual(options.map((o) => [o.method, o.path.split('?')[0], o.timeout]), [
      ['GET', '/api/whoami', 5000], ['GET', '/api/gc', 600_000], ['POST', '/api/gc', 600_000],
    ]);
    assert.equal(options[0].headers['X-TB-Token'], undefined);
    assert.equal(options[1].headers['X-TB-Token'], c.token);
  });
});
