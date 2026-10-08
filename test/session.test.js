'use strict';
// D35 / fix B1 + B2: security headers, Sec-Fetch-Site refusal, `tb open` session cookie (one-time code → HttpOnly
// SameSite=Strict cookie). The page never carries the token; /api/* and /events need cookie or X-TB-Token.
// D39: TB_HOME/session = {"secret", "ui_key"}; /unlock hands ui_key to the page in the URL fragment.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startTbd, request } = require('./helpers/tbd');

const SECRET = 'ab'.repeat(32);
const UI_KEY = 'cd'.repeat(32);
const SESSION = JSON.stringify({ secret: SECRET, ui_key: UI_KEY });
const COOKIE = `tb_session=${crypto.createHmac('sha256', Buffer.from(SECRET, 'hex')).update('tb-ui-v1').digest('hex')}`;
const SEED = { tasks: [{ id: 't_s3cr3t', title: 'Private reminder', status: 'now', created: '2026-10-01' }] };
const CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'";

let tbd;
before(async () => { tbd = await startTbd({ files: { 'tasks.json': SEED, session: SESSION } }); });
after(() => tbd.stop());

const get = (p, headers = {}) => request(tbd.port, 'GET', p, undefined, headers);
/** @param {Record<string, string>} [headers] */
const mint = (headers = { 'x-tb-token': tbd.token }) => request(tbd.port, 'POST', '/api/session/code', undefined, headers);
const unlockPath = (url) => new URL(url).pathname + new URL(url).search;

test('B2 no cookie: GET / is the locked page (no token, no data); /api/state and /events → 401', async () => {
  for (const cookie of [undefined, 'tb_session=' + 'f'.repeat(64), 'tb_session=', 'other=1']) {
    const page = await get('/', { cookie });
    assert.equal(page.status, 403, `cookie ${cookie}`);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.text, /This browser is locked\./);
    assert.match(page.text, /Run <code>tb open<\/code> in Terminal\./);
    for (const leak of [tbd.token, 'tb-token', 'Private reminder', '<script']) assert.ok(!page.text.includes(leak), `locked page has ${leak}`);
    for (const p of ['/api/state', '/api/tags', '/api/tickets/t_aaaaaa', '/events']) assert.equal((await get(p, { cookie })).status, 401, `${p} cookie ${cookie}`);
  }
  assert.equal((await get('/app.js')).status, 200, 'static UI assets stay public');
  assert.equal((await get('/style.css')).status, 200);
});

test('B2 session code: needs X-TB-Token; unlock sets the cookie once; reused / unknown / missing code → 403', async () => {
  assert.equal((await mint({})).status, 401);
  assert.equal((await mint({ cookie: COOKIE, 'sec-fetch-site': 'same-origin' })).status, 401, 'a browser session cannot mint codes');
  const { status, json } = await mint();
  assert.equal(status, 200);
  assert.equal(json.expires_in, 60);
  assert.match(json.code, /^[0-9a-f]{64}$/);
  assert.equal(json.url, `http://127.0.0.1:${tbd.port}/unlock?code=${json.code}`);

  const ok = await get(unlockPath(json.url));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `/#k=${UI_KEY}`, 'D39 ui_key only in the fragment');
  assert.deepEqual(ok.headers['set-cookie'], [`${COOKIE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`], 'value = HMAC of TB_HOME/session');
  const again = await get(unlockPath(json.url));
  assert.equal(again.status, 403);
  assert.match(again.text, /This unlock link is used or expired\./);
  assert.equal(again.headers['set-cookie'], undefined);
  for (const p of ['/unlock?code=nope', '/unlock?code=', '/unlock']) assert.equal((await get(p)).status, 403, p);

  const file = path.join(tbd.tbHome, 'session');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), SESSION, 'existing secret + ui_key kept');
});

test('B2 code expires after its TTL; a bad session file is replaced by a fresh 0600 secret + ui_key', async (t) => {
  const short = await startTbd({ env: { TB_CODE_TTL_MS: '150' }, files: { session: 'not hex' } });
  t.after(() => short.stop());
  const { json } = await request(short.port, 'POST', '/api/session/code', undefined, { 'x-tb-token': short.token });
  await new Promise((r) => setTimeout(r, 250));
  const late = await request(short.port, 'GET', unlockPath(json.url));
  assert.equal(late.status, 403);
  assert.equal(late.headers['set-cookie'], undefined);
  const file = path.join(short.tbHome, 'session');
  assert.match(fs.readFileSync(file, 'utf8'), /^\{"secret":"[0-9a-f]{64}","ui_key":"[0-9a-f]{64}"\}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('D39 old secret-only session file: both secret and ui_key are new, so the old cookie stops working', async (t) => {
  const old = await startTbd({ files: { session: SECRET } });
  t.after(() => old.stop());
  const s = JSON.parse(fs.readFileSync(path.join(old.tbHome, 'session'), 'utf8'));
  assert.notEqual(s.secret, SECRET);
  assert.match(s.ui_key, /^[0-9a-f]{64}$/);
  assert.equal((await request(old.port, 'GET', '/api/state', undefined, { cookie: COOKIE })).status, 401, 'cookie of the old secret refused');
  assert.equal((await request(old.port, 'GET', '/api/state', undefined, { cookie: await old.unlock() })).status, 200, 'one new tb open fixes it');
});

test('B2 cookie: GET UI/state/events work; PATCH needs Sec-Fetch-Site same-origin', async () => {
  const page = await get('/', { cookie: COOKIE });
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/app\.js"><\/script>/);
  assert.ok(!page.text.includes(tbd.token) && !page.text.includes('tb-token'), 'served UI carries no token');
  assert.equal((await get('/api/state', { cookie: COOKIE })).json.reminders[0].title, 'Private reminder');
  const sse = await new Promise((resolve, reject) => {
    const req = require('node:http').get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { cookie: COOKIE } }, (res) => { resolve(res.statusCode); req.destroy(); });
    req.on('error', reject);
  });
  assert.equal(sse, 200);

  const patch = (status, headers) => request(tbd.port, 'PATCH', '/api/reminders/t_s3cr3t', { status }, { cookie: COOKIE, ...headers });
  for (const site of [undefined, 'cross-site', 'same-site', 'none']) {
    const r = await patch('later', { 'sec-fetch-site': site });
    assert.equal(r.status, 403, `sec-fetch-site ${site}`);
  }
  assert.equal((await tbd.api('GET', '/api/state')).json.reminders[0].status, 'now', 'refused PATCHes wrote nothing');
  const ok = await patch('next', { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal((await tbd.api('GET', '/api/state')).json.reminders[0].status, 'next');
  assert.equal((await tbd.api('PATCH', '/api/reminders/t_s3cr3t', { status: 'now' })).status, 200, 'X-TB-Token needs no fetch metadata');
});

test('B1 cross-site Sec-Fetch-Site → 403 even with the token; top-level GET navigation still lands', async () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await tbd.api('GET', '/api/state', undefined, { 'sec-fetch-site': site, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 403, site);
    const form = await tbd.api('POST', '/api/reminders', { title: 'csrf' }, { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(form.status, 403, `${site} form POST`);
  }
  assert.ok(!(await tbd.api('GET', '/api/state')).json.reminders.some((r) => r.title === 'csrf'));
  const nav = await get('/', { cookie: COOKIE, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.equal(nav.status, 200, 'link from another site opens the board');
  assert.equal((await get('/api/state', { 'x-tb-token': tbd.token, 'sec-fetch-site': 'none' })).status, 200);
});

test('B1 CSP, X-Frame-Options, nosniff, Referrer-Policy on every response kind', async () => {
  const { json } = await mint();
  const responses = {
    ui: await get('/', { cookie: COOKIE }),
    locked: await get('/'),
    unlock: await get(unlockPath(json.url)),
    asset: await get('/app.js'),
    state: await tbd.api('GET', '/api/state'),
    unauthorized: await get('/api/state'),
    notFound: await tbd.api('GET', '/nope'),
    badHost: await tbd.api('GET', '/api/state', undefined, { host: 'evil.com' }),
    badRequest: await tbd.api('POST', '/api/reminders', '{'),
  };
  for (const [name, r] of Object.entries(responses)) {
    assert.equal(r.headers['content-security-policy'], CSP, name);
    assert.equal(r.headers['x-frame-options'], 'DENY', name);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', name);
  }
  assert.deepEqual(Object.values(responses).map((r) => r.status), [200, 403, 302, 200, 200, 401, 404, 403, 400]);
});
