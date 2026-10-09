'use strict';
// P1 AC4: Host check, X-TB-Token on mutations, token never in served UI (D35), no CORS, SSE events, body limits
// and input validation at the trust boundary. P1 AC8: tag validation via POST /api/tags. Session cookie: session.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { startTbd, REPO } = require('./helpers/tbd');

let tbd;
before(async () => { tbd = await startTbd(); });
after(() => tbd.stop());

// Opens /events and resolves once the stream text matches re.
function sse(port, headers = {}) {
  let text = '';
  const waiters = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; waiters.forEach((w) => w()); });
      resolve(res);
    });
    req.on('error', reject);
  });
  const until = (re, ms = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${re} in SSE stream: ${text}`)), ms);
    const check = () => { const m = re.exec(text); if (m) { clearTimeout(timer); resolve(m); } };
    waiters.push(check);
    check();
  });
  return { ready, until, close: () => req.destroy() };
}

test('AC4 bad Host header → 403; localhost / 127.0.0.1 with or without port pass', async () => {
  for (const host of ['evil.com', 'localhost.evil.com', '127.0.0.1.nip.io', `evil.com:${tbd.port}`, '[::1]']) {
    const r = await tbd.api('GET', '/api/state', undefined, { host });
    assert.equal(r.status, 403, `host "${host}"`);
    assert.deepEqual(r.json, { error: 'forbidden' });
  }
  for (const host of ['localhost', `localhost:${tbd.port}`, '127.0.0.1', `127.0.0.1:${tbd.port}`]) {
    assert.equal((await tbd.api('GET', '/api/state', undefined, { host })).status, 200, `host "${host}"`);
  }
  // HTTP/1.0 without any Host header (http.request always adds one): raw socket
  const raw = await new Promise((resolve, reject) => {
    let text = '';
    const sock = net.connect(tbd.port, '127.0.0.1', () => sock.end('GET /api/state HTTP/1.0\r\n\r\n'));
    sock.on('data', (c) => (text += c)).on('end', () => resolve(text)).on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 403 /);
});

test('AC4 POST/PATCH/DELETE without or with a wrong X-TB-Token → 401 and nothing written', async () => {
  const wrong = 'f'.repeat(64);
  const before = (await tbd.api('GET', '/api/state')).json.reminders;
  for (const token of [undefined, wrong, tbd.token.slice(1), '']) {
    for (const [method, p] of [['POST', '/api/reminders'], ['PATCH', '/api/reminders/t_aaaaa1'], ['DELETE', '/api/reminders/t_aaaaa1'], ['POST', '/api/tags']]) {
      const r = await tbd.api(method, p, { title: 'sneaky' }, { 'x-tb-token': token });
      assert.equal(r.status, 401, `${method} ${p} token ${token}`);
    }
  }
  assert.deepEqual((await tbd.api('GET', '/api/state')).json.reminders, before);
  assert.equal((await tbd.api('POST', '/api/reminders', { title: 'with token' })).status, 201);
});

test('AC4 token file is 0600 and 32 random bytes hex', () => {
  const file = path.join(tbd.tbHome, 'token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/);
});

test('AC4 no Access-Control-* header on any response', async () => {
  const responses = [
    await tbd.api('GET', '/api/state', undefined, { origin: 'http://evil.com' }),
    await tbd.api('POST', '/api/reminders', { title: 'cors check' }, { origin: 'http://evil.com' }),
    await tbd.api('OPTIONS', '/api/reminders', undefined, { origin: 'http://evil.com', 'access-control-request-method': 'POST', 'x-tb-token': undefined }),
    await tbd.api('GET', '/nope'),
  ];
  for (const r of responses) assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), [], `status ${r.status}`);
  assert.equal(responses[2].status, 401, 'preflight gets no special treatment');
});

test('AC4 + D35 GET / serves ui/index.html as is (no token meta) to a session; 503 when the UI is missing', async (t) => {
  // tbd serves <code dir>/ui: run copies of the code with and without a fixture UI
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['with-ui', 'no-ui']) {
    fs.cpSync(path.join(REPO, 'lib'), path.join(root, name, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'tbd.js'), path.join(root, name, 'tbd.js'));
  }
  fs.mkdirSync(path.join(root, 'with-ui', 'ui'));
  fs.writeFileSync(path.join(root, 'with-ui', 'ui', 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  fs.writeFileSync(path.join(root, 'with-ui', 'ui', 'app.js'), 'console.log(1)');

  const a = await startTbd({ tbd: path.join(root, 'with-ui', 'tbd.js') });
  t.after(() => a.stop());
  const page = await a.api('GET', '/', undefined, { 'x-tb-token': undefined, cookie: await a.unlock() });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.text, '<!doctype html><html><head><title>t</title></head><body></body></html>');
  assert.ok(!page.text.includes(a.token) && !page.text.includes('tb-token'), 'GET / leaks the token');
  const js = await a.api('GET', '/app.js');
  assert.equal(js.text, 'console.log(1)');
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal((await a.api('GET', '/style.css')).status, 404);
  for (const p of ['/', '/api/state', '/api/tags', '/app.js']) assert.ok(!(await a.api('GET', p)).text.includes(a.token), `${p} leaks token`);

  const b = await startTbd({ tbd: path.join(root, 'no-ui', 'tbd.js') });
  t.after(() => b.stop());
  const missing = await b.api('GET', '/', undefined, { cookie: await b.unlock() });
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.json, { error: 'ui not built' });
});

test('AC4 SSE: system event on connect, reminder event after a PATCH; bad Host refused', async () => {
  const s = sse(tbd.port, { 'x-tb-token': tbd.token });
  const res = await s.ready;
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  const [, sys] = await s.until(/event: system\ndata: (.*)\n\n/);
  // P2: live monitor fields change between reads, so compare keys + the runner-owned fields (values: monitor.test.js).
  const keys = ['ram_total', 'ram_used', 'avail', 'pressure', 'level', 'disk_free', 'claude_rss', 'net', 'power', 'docker', 'disk_warn', 'at', 'runs', 'max', 'paused_until', 'paused_reason', 'usage_warning'].sort();
  const runner = ({ runs, max, paused_until, paused_reason, usage_warning }) => ({ runs, max, paused_until, paused_reason, usage_warning });
  const fromState = (await tbd.api('GET', '/api/state')).json.system;
  for (const [where, got] of [['SSE', JSON.parse(sys)], ['/api/state', fromState]]) {
    assert.deepEqual(Object.keys(got).sort(), keys, `${where} carries the system object`);
    assert.deepEqual(runner(got), { runs: 0, max: 1, paused_until: null, paused_reason: null, usage_warning: false }, where);
  }
  const { json } = await tbd.api('POST', '/api/reminders', { title: 'sse me' });
  await tbd.api('PATCH', `/api/reminders/${json.reminder.id}`, { status: 'now' });
  const [, data] = await s.until(new RegExp(`event: reminder\\ndata: (\\{"id":"${json.reminder.id}","status":"now"\\})\\n\\n`));
  assert.deepEqual(JSON.parse(data), { id: json.reminder.id, status: 'now' });
  s.close();

  const evil = sse(tbd.port, { host: 'evil.com', 'x-tb-token': tbd.token });
  assert.equal((await evil.ready).statusCode, 403);
  evil.close();
});

test('AC4 body > 1 MB → 413, bad JSON → 400, invalid status → 400, unknown id → 404', async () => {
  const big = await tbd.api('POST', '/api/reminders', JSON.stringify({ title: 'x', note: 'y'.repeat(1_100_000) }));
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { error: 'body too large (max 1 MB)' });
  const badJson = await tbd.api('POST', '/api/reminders', '{"title": "x",');
  assert.equal(badJson.status, 400);
  assert.deepEqual(badJson.json, { error: 'invalid JSON' });
  assert.equal((await tbd.api('POST', '/api/reminders', '[1,2]')).status, 400);
  const badStatus = await tbd.api('POST', '/api/reminders', { title: 'x', status: 'someday' });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.json.error, /^status must be one of inbox, now, next, later, done$/);
  assert.equal((await tbd.api('PATCH', '/api/reminders/t_zzzzzz', { status: 'now' })).status, 404);
  assert.equal((await tbd.api('GET', '/api/tickets/t_zzzzzz')).status, 404);
  assert.equal((await tbd.api('GET', '/api/tickets/..%2Fetc')).status, 400);
  assert.equal((await tbd.api('PATCH', '/api/reminders/T_BAD', { status: 'now' })).status, 400);
  assert.equal((await tbd.api('GET', '/api/nope')).status, 404);
});

test('AC8 POST /api/tags: hierarchical tag accepted and listed; bad names and bad defs rejected', async () => {
  const def = { path: '/tmp/acme-api', type: 'git', base: 'main', checks: { lint: 'npm run lint', prisma_diff: true }, heavy: ['npm ci'], leak_check: true };
  let r = await tbd.api('POST', '/api/tags', { name: 'acme/api', def });
  assert.equal(r.status, 201);
  assert.deepEqual((await tbd.api('GET', '/api/tags')).json.tags['acme/api'], def);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tags.json'), 'utf8'))['acme/api'], def);
  assert.equal((await tbd.api('POST', '/api/tags', { name: 'acme', def: {} })).status, 201, 'group tag');

  for (const name of ['Acme', 'a//b', '/a', 'a/', 'a b', 'a_b', '', 42]) {
    r = await tbd.api('POST', '/api/tags', { name, def: {} });
    assert.equal(r.status, 400, `name ${JSON.stringify(name)}`);
    assert.match(r.json.error, /tag name must look like/);
  }
  for (const bad of [{ path: '/x', type: 'git' }, { path: 'rel/x', type: 'folder' }, { path: '/x' }, { type: 'folder' },
    { path: '/x', type: 'svn' }, { color: 'red' }, { path: '/x', type: 'folder', leak_check: 'yes' }, { path: '/x', type: 'folder', checks: { deploy: 'x' } }]) {
    assert.equal((await tbd.api('POST', '/api/tags', { name: 'acme/bad', def: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await tbd.api('GET', '/api/tags')).json.tags['acme/bad'], undefined);
});
