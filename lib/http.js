'use strict';
// http: JSON API, static UI and Server-Sent Events for tbd (spec App B + plan §3b routes).
// Host header must be localhost/127.0.0.1 (blocks DNS rebinding). D35: /api/* and /events need X-TB-Token (CLI)
// or the tb_session cookie (UI, from `tb open`); cookie mutations also need Sec-Fetch-Site same-origin.
// The page never carries the token. No CORS headers ever. Async fs only on request paths (D31).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { TbError } = require('./errors');

const UI = path.join(__dirname, '..', 'ui');
const MAX_BODY = 1e6;
const TYPES = { 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
const clients = new Set();
let notifier; // set by createServer
let session = ''; // tb_session cookie value, set by createServer
const codes = new Map(); // one-time unlock code -> expiry ms
const CODE_TTL_MS = Number(process.env.TB_CODE_TTL_MS) || 60_000; // ponytail: env knob only so tests can expire codes fast
const PUBLIC = /^\/(|app\.js|style\.css|unlock)$/; // GET only; no data behind these
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const locked = (why = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Taskboard locked</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main class="locked"><h1>This browser is locked.</h1>${why && `<p>${why}</p>`}<p>Run <code>tb open</code> in Terminal.</p></main>
</body>
</html>
`;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function same(secret, got) {
  const want = Buffer.from(secret);
  const have = Buffer.from(typeof got === 'string' ? got : '');
  return want.length > 0 && have.length === want.length && crypto.timingSafeEqual(have, want);
}
const tokenOk = (got) => same(store.token, got);
const cookieOk = (req) => same(session, /(?:^|;\s*)tb_session=([^;]*)/.exec(req.headers.cookie || '')?.[1]);

// Startup only: 32 random bytes hex in TB_HOME/session (0600). Delete the file + restart tbd = log out every browser.
function loadSession() {
  const file = path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'session');
  let secret = '';
  try {
    secret = fs.readFileSync(file, 'utf8').trim(); // startup
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 }); // startup
  }
  fs.chmodSync(file, 0o600); // startup
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update('tb-ui-v1').digest('hex');
}

// null = allowed; else [status, body]. GET with a valid cookie is fine from any fetch site the global check let in.
function authError(req) {
  if (tokenOk(req.headers['x-tb-token'])) return null;
  if (!cookieOk(req)) return [401, { error: 'locked: run tb open in Terminal, or send X-TB-Token' }];
  if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== 'same-origin') return [403, { error: 'cross-site request refused' }];
  return null;
}

// Sec-Fetch-Site present and cross-site / same-site → refused, except a top-level GET navigation (link, bookmark).
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (!site || site === 'same-origin' || site === 'none') return false;
  return !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document');
}

function body(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) return Promise.reject(new TbError(413, 'body too large (max 1 MB)'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new TbError(413, 'body too large (max 1 MB)'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new TbError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// P1: no monitor yet, so every live field is null (filled by P2/P3). Units: bytes for ram/disk/rss,
// pressure normal|warn|critical, net boolean, paused_until ISO UTC, paused_reason usage|memory|you.
const system = () => ({
  ram_used: null, ram_total: null, pressure: null, disk_free: null, claude_rss: null,
  runs: 0, max: store.config.max_concurrent, net: null, paused_until: null, paused_reason: null,
});

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const broadcast = (text) => clients.forEach((res) => res.write(text));

async function file(name) {
  try {
    return await fsp.readFile(path.join(UI, name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function index(req, res) {
  if (!cookieOk(req)) return send(res, 403, locked(), 'text/html; charset=utf-8');
  const html = await file('index.html');
  if (html === null) return [503, { error: 'ui not built' }];
  send(res, 200, html, 'text/html; charset=utf-8');
}

function sessionCode(req) {
  if (!tokenOk(req.headers['x-tb-token'])) return [401, { error: 'session codes need X-TB-Token' }];
  const now = Date.now();
  for (const [c, exp] of codes) if (exp <= now) codes.delete(c); // ponytail: prune on mint; size = codes minted per TTL
  const code = crypto.randomBytes(32).toString('hex');
  codes.set(code, now + CODE_TTL_MS);
  return [200, { code, url: `http://127.0.0.1:${req.socket.localPort}/unlock?code=${code}`, expires_in: CODE_TTL_MS / 1000 }];
}

// Single use: the code is gone after the first try, valid or not.
function unlock(req, res) {
  const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
  const exp = codes.get(code);
  codes.delete(code);
  if (!exp || exp <= Date.now()) return send(res, 403, locked('This unlock link is used or expired.'), 'text/html; charset=utf-8');
  res.writeHead(302, {
    Location: '/', 'Cache-Control': 'no-store',
    'Set-Cookie': `tb_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
  });
  res.end();
}

async function asset(req, res, m) {
  const text = await file(m[1]);
  if (text === null) return [404, { error: 'not found' }];
  send(res, 200, text, TYPES[m[1]]);
}

async function state() {
  return [200, {
    reminders: store.listReminders(),
    flows: store.listTickets().map(({ id, title, kind, tag, state, waiting, rework, updated_at }) => ({ id, title, kind, tag, state, waiting, rework, updated_at })),
    system: system(),
    calendar: await store.readCalendar(),
  }];
}

function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(event('system', system()));
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

async function addReminder(req) {
  const r = await store.addReminder(await body(req));
  return [r.noop ? 200 : 201, r];
}

async function putTag(req) {
  const b = await body(req);
  if (b === null || typeof b !== 'object') throw new TbError(400, 'body must be a JSON object');
  return [201, { name: b.name, def: await store.putTag(b.name, b.def) }];
}

/** @type {[string, RegExp, Function][]} */
const ROUTES = [
  ['GET', /^\/$/, index],
  ['GET', /^\/(app\.js|style\.css)$/, asset],
  ['GET', /^\/unlock$/, unlock],
  ['POST', /^\/api\/session\/code$/, sessionCode],
  ['GET', /^\/api\/state$/, state],
  ['GET', /^\/api\/tickets\/([^/]+)$/, (req, res, m) => [200, { ticket: store.getTicket(m[1]) }]],
  ['POST', /^\/api\/reminders$/, addReminder],
  ['PATCH', /^\/api\/reminders\/([^/]+)$/, async (req, res, m) => [200, await store.updateReminder(m[1], await body(req))]],
  ['DELETE', /^\/api\/reminders\/([^/]+)$/, async (req, res, m) => [200, { deleted: (await store.removeReminder(m[1])).id }]],
  ['POST', /^\/api\/flows$/, async (req) => [201, { ticket: await store.createFlow(await body(req)) }]],
  ['POST', /^\/api\/tickets\/([^/]+)\/promote$/, async (req, res, m) => [201, { ticket: await store.promote(m[1], await body(req)) }]],
  ['GET', /^\/api\/tags$/, () => [200, { tags: store.listTags() }]],
  ['POST', /^\/api\/tags$/, putTag],
  ['GET', /^\/events$/, events],
  ['POST', /^\/api\/notify-test$/, () => [200, notifier.doNow()]],
];

async function handle(req, res) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'forbidden' });
  if (crossSite(req)) return send(res, 403, { error: 'cross-site request refused' });
  const url = req.url.split('?')[0];
  const denied = req.method === 'GET' && PUBLIC.test(url) ? null : authError(req);
  if (denied) return send(res, denied[0], denied[1]);
  for (const [method, re, fn] of ROUTES) {
    const m = re.exec(url);
    if (!m || method !== req.method) continue;
    const out = await fn(req, res, m);
    if (out) send(res, out[0], out[1]);
    return;
  }
  send(res, 404, { error: 'not found' });
}

function createServer(n) {
  notifier = n;
  session = loadSession();
  store.on('reminder', (d) => broadcast(event('reminder', d)));
  store.on('ticket', (d) => broadcast(event('ticket', d)));
  setInterval(() => broadcast(': ping\n\n'), 25_000).unref();
  return http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof TbError) return send(res, e.status, { error: e.message });
      console.error(`tbd: ${req.method} ${req.url.split('?')[0]} failed:`, e.stack); // no headers: token never logged
      send(res, 500, { error: 'internal error' });
    });
  });
}

module.exports = { createServer };
