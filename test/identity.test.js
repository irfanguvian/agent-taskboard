'use strict';
// D39 (fix loop 2, N1) + N3: a port squatter during a tbd restart must not get a usable session. Admin routes that run
// commands take only X-TB-Token; GET /api/ui-whoami lets the page prove tbd's identity without cookies; tbd binds its
// port before anything else and answers 503 starting until ready; http limits stop slow / idle sockets piling up.
// The page side (no EventSource auto-reconnect, identity check before reconnect) is checked in a real browser:
// docs/verification/screenshots/p2-identity-*.png.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startTbd, request, isolatedEnv, REPO, TBD } = require('./helpers/tbd');

const NONCE = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (key, n) => crypto.createHmac('sha256', key).update(n).digest('hex');
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = /** @type {net.AddressInfo} */ (s.address());
    s.close(() => resolve(port));
  });
});

describe('real tbd', () => {
  let tbd;
  let cookie;
  before(async () => {
    tbd = await startTbd();
    cookie = await tbd.unlock();
  });
  after(() => tbd.stop());

  test('D39 admin routes (tags POST, doctor, gc) take only X-TB-Token: a valid same-origin cookie → 401 CLI only, nothing written', async () => {
    const asUi = { 'x-tb-token': undefined, cookie, 'sec-fetch-site': 'same-origin' };
    for (const [method, p, body] of [
      ['POST', '/api/tags', { name: 'evil', def: { path: '/tmp', type: 'folder', checks: { lint: 'touch /tmp/pwned' } } }],
      ['POST', '/api/doctor', { tag: 'evil' }],
      ['GET', '/api/gc', undefined],
      ['POST', '/api/gc', { ids: ['x'] }],
    ]) {
      const r = await tbd.api(method, p, body, asUi);
      assert.equal(r.status, 401, `${method} ${p}`);
      assert.deepEqual(r.json, { error: 'CLI only: use tb' }, `${method} ${p}`);
    }
    assert.equal((await tbd.api('GET', '/api/tags')).json.tags.evil, undefined, 'no tag written');
    assert.equal(fs.existsSync(path.join(tbd.tbHome, 'doctor.json')), false, 'doctor never ran');

    assert.equal((await tbd.api('GET', '/api/tags', undefined, asUi)).status, 200, 'the UI still reads tags with the cookie');
    assert.equal((await tbd.api('POST', '/api/reminders', { title: 'ui add' }, asUi)).status, 201, 'and still writes reminders');
    assert.equal((await tbd.api('POST', '/api/tags', { name: 'ok', def: {} })).status, 201, 'the token still works');
    assert.equal((await tbd.api('GET', '/api/gc')).status, 200);
  });

  test('D39 GET /api/ui-whoami needs no cookie and answers HMAC-SHA256(ui_key bytes, n); bad nonce → 400', async () => {
    const { ui_key } = JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'session'), 'utf8'));
    const bare = { 'x-tb-token': undefined };
    const r = await tbd.api('GET', `/api/ui-whoami?n=${NONCE}`, undefined, bare);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mac: hmac(Buffer.from(ui_key, 'hex'), NONCE) });
    assert.equal(r.headers['set-cookie'], undefined);
    assert.notEqual(r.json.mac, (await tbd.api('GET', `/api/whoami?n=${NONCE}`, undefined, bare)).json.mac, 'not the token-keyed CLI mac');
    assert.deepEqual((await tbd.api('GET', `/api/ui-whoami?n=${NONCE}`, undefined, { ...bare, cookie })).json, r.json, 'a cookie changes nothing');
    for (const n of ['', 'a'.repeat(15), 'z'.repeat(32), 'a'.repeat(129)]) {
      assert.equal((await tbd.api('GET', `/api/ui-whoami?n=${n}`, undefined, bare)).status, 400, JSON.stringify(n));
    }
    assert.equal((await tbd.api('POST', `/api/ui-whoami?n=${NONCE}`, {}, bare)).status, 401, 'GET only');
  });
});

test('D39 boot: tbd binds its port before store and slots are up, answers 503 starting, then 200 once "tbd listening"', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-boot-'));
  const home = path.join(root, 'home');
  const tbHome = path.join(root, 'tbhome');
  fs.mkdirSync(home);
  fs.mkdirSync(tbHome);
  // slots.start() 1.5 s late: a window where the port is bound but tbd is not ready
  const preload = path.join(root, 'slow-slots.js');
  fs.writeFileSync(preload, `const s = require(${JSON.stringify(path.join(REPO, 'lib', 'slots.js'))});
const create = s.createSlots;
s.createSlots = (o) => { const x = create(o); const start = x.start; x.start = () => new Promise((r) => setTimeout(r, 1500)).then(start); return x; };
`);
  const port = await freePort();
  const child = spawn(process.execPath, [TBD], { env: isolatedEnv({ home, tbHome, port }, { NODE_OPTIONS: `--require ${preload}` }), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('close', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));

  let first = null;
  for (let i = 0; i < 250 && !first; i++) first = await request(port, 'GET', `/api/ui-whoami?n=${NONCE}`).catch(() => sleep(10).then(() => null));
  assert.ok(first, 'port never answered');
  assert.equal(first.status, 503);
  assert.deepEqual(first.json, { error: 'starting' });
  assert.equal(first.headers['x-frame-options'], 'DENY', 'security headers on 503 too');
  assert.equal(out, '', 'not ready yet');
  assert.equal((await request(port, 'GET', '/api/state')).status, 503, 'every route, before any auth');

  for (let i = 0; i < 100 && !out.includes('tbd listening'); i++) await sleep(50);
  assert.equal(out, `tbd listening ${port}\n`);
  const token = fs.readFileSync(path.join(tbHome, 'token'), 'utf8').trim();
  assert.equal((await request(port, 'GET', '/api/state', undefined, { 'x-tb-token': token })).status, 200);
  assert.equal((await request(port, 'GET', `/api/ui-whoami?n=${NONCE}`)).status, 200);
});

test('N3 limits: idle keep-alive closed after 2 s; 64 sockets max; slow headers and silent sockets cut at 10 s while SSE lives on', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  // raw sockets read (resume) so they see the server's close
  const raw = (onConnect) => net.connect(tbd.port, '127.0.0.1', onConnect).on('error', () => {}).resume();
  const closedAfter = (sock) => { const t0 = Date.now(); return new Promise((resolve) => sock.on('close', () => resolve(Date.now() - t0))); };

  // keep-alive: the socket stays after the response, then tbd closes it ~2 s later
  const agent = new http.Agent({ keepAlive: true });
  const kaMs = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: tbd.port, path: '/api/state', agent, headers: { 'x-tb-token': tbd.token } }, (res) => {
      res.resume();
      res.on('end', () => resolve(closedAfter(req.socket)));
    });
    req.on('error', reject);
  });
  agent.destroy();
  assert.ok(kaMs >= 1500 && kaMs < 4000, `keep-alive closed after ${kaMs} ms`);

  // maxConnections 64: the 65th+ are dropped at once (pooled harness sockets are gone: > 2 s idle)
  const socks = [];
  for (let i = 0; i < 70; i++) socks.push(raw());
  await sleep(500);
  assert.equal(socks.filter((s) => !s.destroyed && s.readyState === 'open').length, 64);
  socks.forEach((s) => s.destroy());
  await sleep(100);
  assert.equal((await tbd.api('GET', '/api/state')).status, 200, 'room again after they close');

  // slow headers + a silent socket: cut after headersTimeout (checked every 1 s); the SSE stream is a complete request
  const slow = raw(() => slow.write('GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
  const silent = raw();
  let stream = '';
  const sse = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { 'x-tb-token': tbd.token } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => (stream += c));
  });
  sse.on('error', () => {});
  t.after(() => sse.destroy());
  const [slowMs, silentMs] = await Promise.all([closedAfter(slow), closedAfter(silent)]);
  for (const [name, ms] of [['slow headers', slowMs], ['silent', silentMs]]) assert.ok(ms >= 9000 && ms < 13000, `${name} socket cut after ${ms} ms`);
  await sleep(1500); // past requestTimeout + one check for the stream too
  const { json } = await tbd.api('POST', '/api/reminders', { title: 'still live' });
  await tbd.api('PATCH', `/api/reminders/${json.reminder.id}`, { status: 'now' });
  for (let i = 0; i < 40 && !stream.includes(json.reminder.id); i++) await sleep(50);
  assert.ok(stream.includes(`"id":"${json.reminder.id}"`), `SSE still delivers after ${slowMs + 1500} ms: ${stream.slice(-200)}`);
});
