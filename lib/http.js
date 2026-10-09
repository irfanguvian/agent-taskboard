'use strict';
// http: JSON API, static UI and Server-Sent Events for tbd (spec App B + plan §3b routes).
// Host header must be localhost/127.0.0.1 (blocks DNS rebinding). D35: /api/* and /events need X-TB-Token (CLI)
// or the tb_session cookie (UI, from `tb open`); cookie mutations also need Sec-Fetch-Site same-origin.
// D39: routes that run commands (CLI_ONLY) take only the token; the page proves tbd's identity (/api/ui-whoami) before
// every SSE reconnect; tbd listens before it is ready and answers 503 starting until ready().
// The page never carries the token. No CORS headers ever. Async fs only on request paths (D31).
// P3c (plan P3 AC4 AC9): run log tail, Resume / Restart / Cancel (202 at once, the outcome as ticket + run events), and
// `run` events from runner.view() whenever a run changes.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { TbError } = require('./errors');
const doctor = require('./doctor');
const gc = require('./gc');
const metrics = require('./metrics');
const { EMPTY } = require('./monitor');
const { readLog } = require('./stream');
const { isObj } = require('./util');

const UI = path.join(__dirname, '..', 'ui');
const MAX_BODY = 1e6;
const DRAIN_MAX = 8e6; // a too-big body is read to its end up to this, so the client sees the 413 (not a reset)
const TAIL_MAX = 1000; // log lines per GET …/log
const TYPES = { 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
const clients = new Set();
let notifier; // set by ready
let monitor; // set by ready
let runner; // set by ready (tbd); absent in tests that wire http to a monitor only
let keys = null; // { cookie, ui, uiHex } from TB_HOME/session, set by ready(); null = not ready = 503 starting
const codes = new Map(); // one-time unlock code -> expiry ms
const CODE_TTL_MS = Number(process.env.TB_CODE_TTL_MS) || 60_000; // ponytail: env knob only so tests can expire codes fast
const PUBLIC = /^\/(|app\.js|style\.css|unlock|api\/whoami|api\/ui-whoami)$/; // GET only; no data behind these (whoami: a MAC of the caller's nonce)
// D39: these run commands outside the agent sandbox (tag checks, gc deletes): a cookie stolen by a port squatter must not reach them.
// Drills: only `tb eval chaos` records them (P3d T11).
const CLI_ONLY = /^(POST \/api\/(tags|doctor|gc|drills)|GET \/api\/gc)$/;
const NONCE_RE = /^[0-9a-f]{16,128}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
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
const cookieOk = (req) => same(keys.cookie, /(?:^|;\s*)tb_session=([^;]*)/.exec(req.headers.cookie || '')?.[1]);

// Startup only: TB_HOME/session (0600) = {"secret", "ui_key"}, 32 random bytes hex each. secret → tb_session cookie,
// ui_key → the page's identity check of tbd (D39). Anything else, the old secret-only file too, gets both new: every
// browser unlocks once more. Delete the file + restart tbd = log out every browser.
function loadSession() {
  const file = path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'session');
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8')); // startup
  } catch (e) {
    if (e.code && e.code !== 'ENOENT') throw e; // no code = not JSON: replaced below
  }
  if (!HEX64.test(s?.secret) || !HEX64.test(s?.ui_key)) {
    s = { secret: crypto.randomBytes(32).toString('hex'), ui_key: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 }); // startup
  }
  fs.chmodSync(file, 0o600); // startup
  const cookie = crypto.createHmac('sha256', Buffer.from(s.secret, 'hex')).update('tb-ui-v1').digest('hex');
  return { cookie, ui: Buffer.from(s.ui_key, 'hex'), uiHex: s.ui_key };
}

// null = allowed; else [status, body]. GET with a valid cookie is fine from any fetch site the global check let in.
function authError(req, url) {
  if (tokenOk(req.headers['x-tb-token'])) return null;
  if (CLI_ONLY.test(`${req.method} ${url}`)) return [401, { error: 'CLI only: use tb' }];
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

// A body over MAX_BODY is still read to its end (kept: none of it) before the 413 goes out: a client still writing
// when tbd answered and closed would get a reset instead of the answer. Past DRAIN_MAX (declared or sent) the request
// is cut; requestTimeout (10 s) bounds the time either way.
function body(req) {
  const big = new TbError(413, 'body too large (max 1 MB)');
  if (Number(req.headers['content-length']) > DRAIN_MAX) return Promise.reject(big);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > DRAIN_MAX) req.destroy(big);
      else if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(big);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new TbError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Live fields = monitor snapshot (null until the first sample): bytes for ram/avail/disk/rss, pressure
// normal|warn|critical, level %, net boolean, power ac|battery, docker boolean, disk_warn boolean, at ISO UTC.
// runs/max/paused_*/usage_warning from the runner (P3): live runs, paused_until ISO UTC (usage limit, nothing starts
// before it), paused_reason usage|null, usage_warning: a live run saw rate limit status allowed_warning.
function system() {
  const v = runner?.view().system;
  return {
    ...(monitor.snapshot() ?? EMPTY),
    runs: v?.runs ?? 0, max: store.config.max_concurrent, paused_until: v?.paused_until ?? null,
    paused_reason: v?.paused_until ? 'usage' : null, usage_warning: v?.usage_warning ?? false,
  };
}

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

// Single use: the code is gone after the first try, valid or not. ui_key rides in the fragment: browsers never send it.
function unlock(req, res) {
  const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
  const exp = codes.get(code);
  codes.delete(code);
  if (!exp || exp <= Date.now()) return send(res, 403, locked('This unlock link is used or expired.'), 'text/html; charset=utf-8');
  res.writeHead(302, {
    Location: `/#k=${keys.uiHex}`, 'Cache-Control': 'no-store',
    'Set-Cookie': `tb_session=${keys.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
  });
  res.end();
}

async function asset(req, res, m) {
  const text = await file(m[1]);
  if (text === null) return [404, { error: 'not found' }];
  send(res, 200, text, TYPES[m[1]]);
}

// Asked before a secret goes out, so a squatter on the port never sees it: HMAC-SHA256(key, n) hex. /api/whoami: key =
// the token, asked by tb and cutover (H9, N9). /api/ui-whoami: key = ui_key bytes, asked by the page without cookies (D39).
function whoami(req, key) {
  const n = new URL(req.url, 'http://x').searchParams.get('n') ?? '';
  if (!NONCE_RE.test(n)) throw new TbError(400, 'n must be 16-128 hex characters');
  return [200, { mac: crypto.createHmac('sha256', key).update(n).digest('hex') }];
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
  for (const r of runner?.view().runs ?? []) res.write(event('run', r));
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

// AC9: the last `tail` lines (default 200, at most TAIL_MAX) of a run log, or with after=<offset> the lines since an
// earlier read (a cursor: `tb logs -f`). run=<n>: that run, else the lease's (the current or last run). Plain while
// the run lives, .gz after (stream.readLog), read through streams. ended: packed, or (L9) nothing new while the lease
// says that run is over (exit set, or a newer run): `tb logs -f` stops even when packing failed.
async function log(req, res, m) {
  const t = store.getTicket(m[1]);
  const q = new URL(req.url, 'http://x').searchParams;
  const num = (k, re) => {
    const v = q.get(k);
    if (v !== null && !re.test(v)) throw new TbError(400, `${k} must be a whole number${k === 'after' ? '' : ' from 1'}`);
    return v === null ? null : Number(v);
  };
  const tail = Math.min(num('tail', /^[1-9]\d{0,8}$/) ?? 200, TAIL_MAX);
  const after = num('after', /^\d{1,15}$/);
  const cur = Number(/^runs\/(\d+)\.jsonl$/.exec(t.lease?.log ?? '')?.[1]);
  const run = num('run', /^[1-9]\d{0,8}$/) ?? cur;
  if (!run) throw new TbError(404, `${t.id}: no run log yet`);
  const r = await readLog(path.join(store.ticketDir(t.id), 'runs', `${run}.jsonl`), { tail, after });
  if (!r) throw new TbError(404, `${t.id}: run ${run} has no log`);
  return [200, { id: t.id, run, ...r, ended: r.ended || (!r.lines.length && (Boolean(t.lease?.exit) || cur !== run)) }];
}

// Resume / Restart / Cancel, the same guards as tb (runner.control). R16: it settles only once a run started, and its
// step 3 can wait hours, so tbd answers 202 at once and the outcome reaches the page as ticket + run events. Every
// refusal is thrown at or before step 1's store write, which the call queues before it returns: once the store queue
// has drained and the microtasks after it ran, a refusal (409, 404) has landed. Settled false that early: the gen CAS
// lost to a newer action.
async function control(req, res, m) {
  const [, id, op] = m;
  const b = op === 'resume' ? await body(req) : null;
  if (b !== null && !(isObj(b) && Object.keys(b).every((k) => k === 'phase') && (b.phase === undefined || typeof b.phase === 'string'))) {
    throw new TbError(400, 'body must be {} or {"phase": "<phase>"}');
  }
  if (!runner) throw new TbError(503, 'starting');
  let out = null;
  runner[op](id, { phase: b?.phase }).then((ok) => { out = { ok }; }, (e) => { out = { e }; });
  await store.flush();
  await new Promise((r) => setImmediate(r));
  if (out?.e) throw out.e;
  if (out?.ok === false) throw new TbError(409, `${id}: ${op} not done: a newer action on this ticket won (or see tbd.log)`);
  return [202, { id, op, accepted: true }];
}

// P3d T11: one t:drill line per `tb eval chaos` drill. Strict body: a typo is a 400, never a line.
async function drill(req) {
  const b = await body(req);
  const ok = isObj(b) && Object.keys(b).every((k) => ['name', 'ok', 'note'].includes(k)) && metrics.DRILLS.includes(b.name)
    && typeof b.ok === 'boolean' && (b.note === undefined || (typeof b.note === 'string' && b.note.length <= 200));
  if (!ok) throw new TbError(400, `body must be {"name": "${metrics.DRILLS.join('|')}", "ok": true|false, "note"?: "<at most 200 characters>"}`);
  return [201, await metrics.drill({ name: b.name, ok: b.ok, note: b.note })];
}

/** @type {[string, RegExp, Function][]} */
const ROUTES = [
  ['GET', /^\/$/, index],
  ['GET', /^\/(app\.js|style\.css)$/, asset],
  ['GET', /^\/unlock$/, unlock],
  ['GET', /^\/api\/whoami$/, (req) => whoami(req, store.token)],
  ['GET', /^\/api\/ui-whoami$/, (req) => whoami(req, keys.ui)],
  ['POST', /^\/api\/session\/code$/, sessionCode],
  ['GET', /^\/api\/state$/, state],
  ['GET', /^\/api\/tickets\/([^/]+)$/, (req, res, m) => [200, { ticket: store.getTicket(m[1]) }]],
  ['GET', /^\/api\/tickets\/([^/]+)\/log$/, log],
  ['POST', /^\/api\/tickets\/([^/]+)\/(resume|restart|cancel)$/, control],
  ['POST', /^\/api\/reminders$/, addReminder],
  ['PATCH', /^\/api\/reminders\/([^/]+)$/, async (req, res, m) => [200, await store.updateReminder(m[1], await body(req))]],
  ['DELETE', /^\/api\/reminders\/([^/]+)$/, async (req, res, m) => [200, { deleted: (await store.removeReminder(m[1])).id }]],
  ['POST', /^\/api\/flows$/, async (req) => [201, { ticket: await store.createFlow(await body(req)) }]],
  ['POST', /^\/api\/tickets\/([^/]+)\/promote$/, async (req, res, m) => [201, { ticket: await store.promote(m[1], await body(req)) }]],
  ['GET', /^\/api\/tags$/, () => [200, { tags: store.listTags() }]],
  ['POST', /^\/api\/tags$/, putTag],
  ['GET', /^\/events$/, events],
  ['POST', /^\/api\/notify-test$/, () => [200, notifier.doNow()]],
  ['POST', /^\/api\/doctor$/, async (req) => [200, await doctor.run(await body(req))]],
  ['GET', /^\/api\/gc$/, async (req) => [200, await gc.list(Object.fromEntries(new URL(req.url, 'http://x').searchParams))]],
  ['POST', /^\/api\/gc$/, async (req) => [200, await gc.remove(await body(req))]],
  ['POST', /^\/api\/drills$/, drill],
];

async function handle(req, res) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'forbidden' });
  if (crossSite(req)) return send(res, 403, { error: 'cross-site request refused' });
  const url = req.url.split('?')[0];
  const denied = req.method === 'GET' && PUBLIC.test(url) ? null : authError(req, url);
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

// tbd listens on this before anything else is up (D39), so it answers 503 starting until ready().
// N3: headers and body within 10 s each, checked every second (GET /events is a whole request once its headers are
// in, so the stream is never cut by it); idle keep-alive 2 s; at most 64 sockets (launchd fd limit 4096 in the plist).
function createServer() {
  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 10_000, keepAliveTimeout: 2_000, connectionsCheckingInterval: 1_000 }, (req, res) => {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    if (!keys) return send(res, 503, { error: 'starting' });
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof TbError) return send(res, e.status, { error: e.message });
      console.error(`tbd: ${req.method} ${req.url.split('?')[0]} failed:`, e.stack); // no headers: token never logged
      send(res, 500, { error: 'internal error' });
    });
  });
  server.maxConnections = 64;
  return server;
}

// Once a second while a page listens: a `run` event for each run whose view changed (liveness, tool, subagents, last
// event in 5 s steps, or RSS by RSS_STEP since the last event sent: a value sitting on a step edge sends nothing; the
// page counts the seconds between), {id, liveness: null} for a run gone from the view, and `system` when the runner's
// part of it changed. Nothing changed, nothing sent.
const RSS_STEP = 10; // MB
let sent = new Map(); // run id → {key, rss} of its last event
let sentSys = '';
function pushRuns() {
  if (!clients.size) return;
  const v = runner.view();
  const next = new Map();
  for (const r of v.runs) {
    const key = JSON.stringify([r.liveness, r.tool, r.subagents_alive, r.live, r.started_at, Math.floor(Date.parse(r.last_event_at) / 5000) || null]);
    const last = sent.get(r.id);
    if (last?.key === key && Math.abs(r.rss_mb - last.rss) < RSS_STEP) {
      next.set(r.id, last);
      continue;
    }
    next.set(r.id, { key, rss: r.rss_mb });
    broadcast(event('run', r));
  }
  for (const id of sent.keys()) if (!next.has(id)) broadcast(event('run', { id, liveness: null }));
  sent = next;
  const sys = JSON.stringify(v.system);
  if (sys !== sentSys) {
    sentSys = sys;
    broadcast(event('system', system()));
  }
}

// After store.init, monitor, slots and the runner: wires the live events and opens the doors.
function ready(n, m, r = undefined) {
  notifier = n;
  monitor = m;
  runner = r;
  if (runner) setInterval(pushRuns, 1000).unref();
  monitor.on('change', () => broadcast(event('system', system()))); // monitor emits at most once per 5 s tick
  store.on('reminder', (d) => broadcast(event('reminder', d)));
  store.on('ticket', (d) => broadcast(event('ticket', d)));
  setInterval(() => broadcast(': ping\n\n'), 25_000).unref();
  keys = loadSession();
}

module.exports = { createServer, ready };
