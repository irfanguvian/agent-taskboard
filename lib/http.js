'use strict';
// http: JSON API, static UI and Server-Sent Events for tbd (spec App B + plan §3b routes).
// Host header must be localhost/127.0.0.1 (blocks DNS rebinding). D35: /api/* and /events need X-TB-Token (CLI)
// or the tb_session cookie (UI, from `tb open`); cookie mutations also need Sec-Fetch-Site same-origin.
// D39: routes that run commands (CLI_ONLY) take only the token; the page proves tbd's identity (/api/ui-whoami) before
// every SSE reconnect; tbd listens before it is ready and answers 503 starting until ready().
// The page never carries the token. No CORS headers ever. Async fs only on request paths (D31).
// P3c (plan P3 AC4 AC9): run log tail, Resume / Restart / Cancel (202 at once, the outcome as ticket + run events), and
// `run` events from runner.view() whenever a run changes. P4: Assign (lib/planning.js: same guards as `tb assign`).
// P4b (U8 U9): Answer, Reject (200: the ticket moved), Approve (202: setup runs in the background; the outcome comes as
// ticket events, a failure as waiting setup_failed + an alert). All three take the UI cookie too (AC5 buttons, not
// CLI_ONLY: approve's setup command comes from Irfan's own tags.json, D35d). GET a ticket: + its newest planning round.
// P5c (contract rev 4.1 K1 K2 K3 M9 M12 M15 T2 RO6, "UI parity in P5"): scope, rework, pass, answer (a working ask →
// lib/working.js, else planning), allow-change, deny-change for tb (actor cli) and the page (actor ui; each verb one
// intervention). A cookie caller of these verbs also sends the per-session synchronizer token (X-TB-CSRF, from GET
// /api/session/csrf); a cookie never allows a protected / scripts / deps ask (401, the ask's class from tbd's record);
// rework takes text only (≤ 64 KB), never a path. Reads on demand, paged, never into /api/state: gates (GateResults
// newest first, ≤ 64 KB a page), a gate check's full log (gunzipped as a stream), interventions, feedback-<n>.md, the
// open working ask (GET a ticket), the pass preview (sha resolved + subject). SSE `gate` = {id, task, check, ok} only.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const store = require('./store');
const { TbError } = require('./errors');
const doctor = require('./doctor');
const planning = require('./planning');
const interview = require('./interview');
const gc = require('./gc');
const metrics = require('./metrics');
const pass = require('./pass');
const { EMPTY } = require('./monitor');
const { readLog } = require('./stream');
const { isObj, eachLine, readPlain } = require('./util');
const review = () => require('./review'); // lazy like working: only a report needs it
const working = () => require('./working'); // tbd.js loads it at boot (P5 Wire); lazy here: no load before a verb needs it
const final = () => require('./final'); // M5 C13: tbd.js loads it at boot; lazy here as working

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
// P5: the verbs that change a flow's work: a cookie caller also needs X-TB-CSRF (synchronizer token); X-TB-Token needs none
const CSRF = /^POST \/api\/tickets\/[^/]+\/(scope|rework|pass|answer|allow-change|deny-change|close|push|lavish)$/;
const NONCE_RE = /^[0-9a-f]{16,128}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^t_[a-z0-9]{6}$/; // store's ticket id
const GATE_BUDGET = 60 * 1024; // bytes of GateResults per GET …/gates page: with its envelope ≤ 64 KB
const GATE_FILE_MAX = 1 << 20; // a gates/NN.json bigger than this is not read
const LOG_OUT_MAX = 8 << 20; // a gate log unpacked (lib/gates keeps ≤ 1 MB): the stream is cut past this
const LOG_RE = /^gates\/\d{2,9}-[A-Za-z0-9@._-]{1,200}\.log\.gz$/;
const CHECK_RE = /^[A-Za-z0-9_:-]{1,40}$/;
const FEEDBACK_MAX = 128 * 1024; // feedback-<n>.md (working.js keeps ≤ 64 KB)
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
  const mac = (label) => crypto.createHmac('sha256', Buffer.from(s.secret, 'hex')).update(label).digest('hex');
  // csrf (P5): the page's synchronizer token, per session secret (a new secret = a new token, like the cookie)
  return { cookie: mac('tb-ui-v1'), csrf: mac('tb-csrf-v1'), ui: Buffer.from(s.ui_key, 'hex'), uiHex: s.ui_key };
}

// null = allowed; else [status, body]. GET with a valid cookie is fine from any fetch site the global check let in.
function authError(req, url) {
  if (tokenOk(req.headers['x-tb-token'])) return null;
  if (CLI_ONLY.test(`${req.method} ${url}`)) return [401, { error: 'CLI only: use tb' }];
  if (!cookieOk(req)) return [401, { error: 'locked: run tb open in Terminal, or send X-TB-Token' }];
  if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== 'same-origin') return [403, { error: 'cross-site request refused' }];
  if (CSRF.test(`${req.method} ${url}`) && !same(keys.csrf, req.headers['x-tb-csrf'])) return [403, { error: 'missing or wrong X-TB-CSRF token: reload the page' }];
  return null;
}
// Who acts (interventions, RO6): the CLI's token, else the page's cookie (authError let one of them in).
const actorOf = (req) => (tokenOk(req.headers['x-tb-token']) ? 'cli' : 'ui');

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
// P5: one finished gate check → `gate` {id, task, check, ok}, nothing more (RAM: the page reads the GateResult itself,
// paged, while its drawer is open). Bad input → no event. tbd.js wires gate() to the gate engine (P5 Wire).
function gateEvent(d) {
  if (!isObj(d) || !ID_RE.test(d.id ?? '') || typeof d.ok !== 'boolean') return null;
  const s = (v) => (typeof v === 'string' ? v.slice(0, 64) : null);
  return event('gate', { id: d.id, task: s(d.task), check: s(d.check), ok: d.ok });
}
const gate = (d) => {
  const e = gateEvent(d);
  if (e) broadcast(e);
};
// the gate engine's onCheck for one gate job o ({t, task}): each finished check → one `gate` event
const onCheck = (o) => (c) => gate({ id: o.t?.id, task: o.task?.id ?? null, check: c.check, ok: c.ok });

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
    flows: store.listTickets().filter((k) => !k.lane_of).map(({ id, title, kind, tag, state, waiting, rework, updated_at, pr }) => ({ id, title, kind, tag, state, waiting, rework, updated_at, merged_at: pr?.merged_at ?? null })),
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

// ---- P5c: working verbs, tb pass, the drawer's reads ----------------------------------------------------------------
const query = (req) => new URL(req.url, 'http://x').searchParams;
// A whole-number query value, null when absent; anything else → 400. List pages: limit 1-100, default 20 (FUNDAMENTALS).
function whole(q, k) {
  const v = q.get(k);
  if (v !== null && !/^\d{1,9}$/.test(v)) throw new TbError(400, `${k} must be a whole number`);
  return v === null ? null : Number(v);
}
function limitOf(q) {
  const l = whole(q, 'limit') ?? 20;
  if (l < 1 || l > 100) throw new TbError(400, 'limit must be a number from 1 to 100');
  return l;
}

// The open working question (M12; the drawer's ask panel, tb answer): the newest work.jsonl `ask` of this round (scope,
// protected, deps, policy: files or changes + reason), else what the asking task returned (NEEDS_CONTEXT,
// TEST_DISPUTES_SPEC: question + notes; a no-op done: tbd's why). Agent text: shown by the page as text only.
async function openAsk(t) {
  const o = t.clarify_origin;
  if (t.state !== 'clarify' || o?.phase !== 'working') return null;
  let ask = null;
  let result = null;
  await eachLine(path.join(store.ticketDir(t.id), 'work.jsonl'), (l) => {
    if (l?.t === 'ask' && l.round === t.round) ask = l;
    else if (l?.t === 'result' && l.task === o.task) result = l;
  }, ['"t":"ask"', '"t":"result"']);
  if (ask) return { kind: ask.kind, task: ask.task ?? null, files: ask.files ?? [], changes: ask.changes ?? [], reason: ask.reason ?? '', online: ask.online === true };
  return { kind: o.class, task: o.task ?? null, question: result?.question || o.why || '', notes: result?.notes ?? '' };
}

async function scope(req, res, m) {
  const b = await body(req);
  if (!isObj(b) || Object.keys(b).some((k) => k !== 'allow' && k !== 'task') || typeof b.allow !== 'boolean' || (b.task !== undefined && typeof b.task !== 'string')) {
    throw new TbError(400, 'body must be {"allow": true|false, "task"?: "<task id>"}');
  }
  // RO6: actor ui (a cookie) never allows a protected / scripts / deps ask: working.scope refuses it (401) by the ask's
  // kind in tbd's own journal, never the body; --task is checked there too, inside the CAS
  return [200, { ticket: await working().scope(m[1], { allow: b.allow }, actorOf(req), b.task) }];
}

// K1: the feedback as text only (≤ 64 KB: working.js); a path never crosses HTTP (tb reads --feedback-file itself).
async function rework(req, res, m) {
  const b = await body(req);
  if (!isObj(b) || Object.keys(b).join() !== 'feedback' || typeof b.feedback !== 'string') throw new TbError(400, 'body must be {"feedback": "<text>"}: the text itself, never a path');
  return [200, { ticket: await working().rework(m[1], b, actorOf(req)) }];
}

// M12: a working ask takes the working answer ({text} | {replan}); any other clarify, planning's answers (M5.4 X11
// planningClarify; D-0117: with the actor).
async function answer(req, res, m) {
  const b = await body(req);
  const t = store.getTicket(m[1]);
  if (t.state === 'clarify' && !planning.planningClarify(t)) return [200, { ticket: await working().answer(t.id, b, actorOf(req)) }];
  return [200, { ticket: await planning.answer(t.id, b, actorOf(req)) }];
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function readGate(file) {
  try {
    return JSON.parse(await readPlain(file, GATE_FILE_MAX) ?? 'null');
  } catch {
    return null;
  }
}
function fit(g) {
  if (bytes(g) <= GATE_BUDGET) return g;
  const cut = (s, n) => String(s ?? '').slice(0, n);
  const few = (a) => (Array.isArray(a) ? a.slice(0, 50).map((x) => (typeof x === 'string' ? cut(x, 300) : x)) : a);
  const each = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, few(v)])) : o);
  const small = {
    ...g, why: cut(g.why, 1024), truncated: true, schema: few(g.schema), api: few(g.api), unused_allowed: few(g.unused_allowed), migration: few(g.migration),
    checks: Array.isArray(g.checks) ? g.checks.slice(0, 30).map((c) => (isObj(c) ? { ...c, tail: cut(c.tail, 512) } : c)) : [],
    scope: each(g.scope), tests: each(g.tests), ask: isObj(g.ask) ? { ...g.ask, files: few(g.ask.files), changes: few(g.ask.changes), reason: cut(g.ask.reason, 1000) } : g.ask,
  };
  if (bytes(small) <= GATE_BUDGET) return small;
  return { n: g.n, gate: cut(g.gate, 16), task: cut(g.task, 64), ok: g.ok === true, class: cut(g.class, 16), at: cut(g.at, 30), truncated: true };
}
// Newest first from ?n= (default: the newest), at most `limit`, cut so the page stays ≤ 64 KB (at least one result; one
// too big alone loses its tails first, then all but its summary). next: the n of the next older page.
async function gates(req, res, m) {
  const t = store.getTicket(m[1]);
  const q = query(req);
  const limit = limitOf(q);
  const from = whole(q, 'n') ?? Infinity;
  const dir = path.join(store.ticketDir(t.id), 'gates');
  const all = (await fsp.readdir(dir).catch(() => [])).flatMap((f) => {
    const x = /^(\d{1,9})\.json$/.exec(f);
    return x && Number(x[1]) <= from ? [[Number(x[1]), f]] : [];
  }).sort((a, b) => b[0] - a[0]);
  const items = [];
  let size = 0;
  let i = 0;
  for (; i < all.length && items.length < limit; i++) {
    const g = await readGate(path.join(dir, all[i][1]));
    const item = fit(isObj(g) ? { ...g, n: all[i][0] } : { n: all[i][0], unreadable: true });
    const b = bytes(item) + 1;
    if (items.length && size + b > GATE_BUDGET) break;
    items.push(item);
    size += b;
  }
  return [200, { id: t.id, items, next: i < all.length ? all[i][0] : null }];
}

// One check's full log (gates/NN-<task>-<check>.log.gz, named by the GateResult), gunzipped as a stream: never in RAM
// whole, cut past LOG_OUT_MAX. O_NOFOLLOW: a link is never read through.
async function gateLog(req, res, m) {
  const t = store.getTicket(m[1]);
  const check = query(req).get('check') ?? '';
  if (!CHECK_RE.test(check)) throw new TbError(400, 'check must name a gate check, e.g. ?check=unit');
  const g = await readGate(path.join(store.ticketDir(t.id), 'gates', `${String(Number(m[2])).padStart(2, '0')}.json`));
  const c = isObj(g) && Array.isArray(g.checks) ? g.checks.find((x) => x?.check === check) : null;
  const none = new TbError(404, `${t.id}: gate ${Number(m[2])} has no ${check} log`);
  if (typeof c?.log !== 'string' || !LOG_RE.test(c.log) || c.log.includes('..')) throw none;
  let fh;
  try {
    fh = await fsp.open(path.join(store.ticketDir(t.id), c.log), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw none;
  }
  try {
    if (!(await fh.stat()).isFile()) throw none;
    let out = 0;
    const cap = new Transform({ transform(chunk, _enc, cb) { out += chunk.length; cb(out > LOG_OUT_MAX ? new Error('gate log over 8 MB unpacked') : null, chunk); } });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    await pipeline(fh.createReadStream({ autoClose: false }), zlib.createGunzip(), cap, res);
  } finally {
    await fh.close();
  }
}

// interventions.jsonl {at, actor, verb, task, payload_sha256}, oldest first: lines (after, after + limit]; next = the
// cursor of the next page, null at the end.
async function interventions(req, res, m) {
  const t = store.getTicket(m[1]);
  const q = query(req);
  const limit = limitOf(q);
  const after = whole(q, 'after') ?? 0;
  const items = [];
  let more = false;
  await eachLine(path.join(store.ticketDir(t.id), 'interventions.jsonl'), (v, n) => {
    more = n > after + limit;
    if (!more && n > after && isObj(v)) items.push(v);
    return more;
  });
  return [200, { id: t.id, items, next: more ? after + limit : null }];
}

async function feedback(req, res, m) {
  const t = store.getTicket(m[1]);
  const text = await readPlain(path.join(store.ticketDir(t.id), `feedback-${m[2]}.md`), FEEDBACK_MAX);
  if (text === null) throw new TbError(404, `${t.id}: no feedback ${m[2]}`);
  return [200, { id: t.id, n: Number(m[2]), text }];
}

// M5.1: tickets/<id>/review/NN.json (lib/review.js writes it), ?kind=review[&n=] (default: the newest). A finding gets
// `blocking` (the one rule, lib/review.js) so the page needs no rule of its own. n is range-checked and padded here, no
// path segment comes from the caller. ≤ 64 KB: declined + notes, then the last (non-blocking first) findings are cut (truncated).
// `fixes` (the ticket's count now) rides only with the newest review.
// M5.2: ?kind=qa[&n=] = tickets/<id>/qa/NN.json (lib/qa.js writes it: cases with their evidence label, need_review), the
// newest file kept by default (not t.qa.n: a visit sets it when it starts, before its file exists), n checked as for
// review; ≤ 64 KB: findings go first, then PASS cases from the end, then the last cases (one stays), each case sized
// once. ?kind=rec: recs() below. M5.3: ?kind=final | summary | verdict: finals() below.
const REPORT_MAX = 60 * 1024;
async function report(req, res, m) {
  const t = store.getTicket(m[1]);
  const q = query(req);
  const kind = q.get('kind');
  if (kind === 'rec') return recs(t, q);
  if (!['review', 'qa', 'final', 'summary', 'verdict'].includes(kind ?? '')) throw new TbError(400, 'kind must be review, qa, rec, final, summary or verdict');
  const given = q.get('n');
  if (given !== null && !/^[1-9]\d{0,3}$/.test(given)) throw new TbError(400, 'n must be a whole number from 1 to 9999');
  if (kind === 'final' || kind === 'summary' || kind === 'verdict') return finals(t, kind, given);
  const n = given !== null ? Number(given) : kind === 'qa' ? (await review().nextN(t.id, 'qa')) - 1 : t.review?.n;
  const text = Number.isInteger(n) ? await readPlain(path.join(store.ticketDir(t.id), kind, `${String(n).padStart(2, '0')}.json`), kind === 'qa' ? 4 << 20 : 1 << 20) : null;
  let r;
  try { r = text === null ? null : JSON.parse(text); } catch { r = null; }
  if (!isObj(r) || !Array.isArray(kind === 'qa' ? r.cases : r.findings)) throw new TbError(404, `${t.id}: no ${kind}${given === null ? '' : ` ${n}`}`);
  if (kind === 'qa') {
    const list = (v) => (Array.isArray(v) ? v : []);
    const out = { id: t.id, kind, n, round: r.round, head: r.head, at: r.at, verdict: r.verdict, report: r.report, need_review: list(r.need_review), findings: list(r.findings), cases: r.cases.filter(isObj) };
    let size = bytes(out);
    if (size > REPORT_MAX) { out.findings = []; out.truncated = true; size = bytes(out); }
    const sizes = out.cases.map((c) => bytes(c) + 1); // a case and its comma
    while (out.cases.length > 1 && size > REPORT_MAX) {
      const i = out.cases.findLastIndex((c) => c.result === 'PASS'), k = i < 0 ? out.cases.length - 1 : i;
      size -= sizes.splice(k, 1)[0];
      out.cases.splice(k, 1);
    }
    return [200, out];
  }
  const closed = Array.isArray(r.closed) ? r.closed : [];
  /** @type {any} */
  const out = { id: t.id, kind: 'review', n, round: r.round, head: r.head, at: r.at, verdict: r.verdict, fix_max: review().FIX_MAX, ...(n === t.review?.n && { fixes: t.fixes ?? 0 }), closed, notes: r.notes, declined: r.declined,
    findings: r.findings.filter(isObj).map((f) => ({ ...f, blocking: review().blocking(/** @type {any} */ (f), closed) })).sort((a, b) => Number(b.blocking) - Number(a.blocking)) };
  // declined, notes and the closed `how` text go before any finding
  if (bytes(out) > REPORT_MAX) { out.declined = []; out.notes = []; out.closed = closed.map((c) => ({ id: c?.id, how: String(c?.how ?? '').slice(0, 200) })); out.truncated = true; }
  while (out.findings.length > 1 && bytes(out) > REPORT_MAX) { out.findings.pop(); out.truncated = true; }
  return [200, out];
}

// M5.3 (C13 C20 C21): ?kind=final[&n=] = tickets/<id>/final/NN.json (lib/final.js keeps every taken result, a block too;
// t.final.n comes with a pass only, so the newest file by default): verdict, findings with `blocking` (the one rule),
// the summary as the agent wrote it, both doc paths; ≤ 64 KB as review (the last findings cut). ?kind=summary =
// summary.md (Irfan's handoff block: the pass writes it, the squash adds tbd's need-review lines). ?kind=verdict[&n=] =
// the mirrored verdict doc (tbd's evidence appended, D-0106) of the newest PASSING final file, or of n: its path from that
// file must match the docs route's regex under docs/ and resolve inside tickets/<id>/docs with no link on the way, read
// O_NOFOLLOW (readPlain). Texts as JSON {text}: shown as text, never rendered. Absent or refused → 404.
const SUMMARY_MAX = 64 * 1024;
const VERDICT_MAX = (1 << 20) + 260 * 1024; // the handler's 1 MB doc + tbd's ≤ 256 KB evidence (lib/final.js)
async function finals(t, kind, given) {
  const dir = path.join(store.ticketDir(t.id), 'final');
  if (kind === 'summary') {
    const text = await readPlain(path.join(store.ticketDir(t.id), 'summary.md'), SUMMARY_MAX);
    if (text === null) throw new TbError(404, `${t.id}: no summary yet (a passing final review writes it)`);
    return [200, { id: t.id, kind, text }];
  }
  const ns = given !== null ? [Number(given)] : (await fsp.readdir(dir).catch(() => [])).flatMap((f) => {
    const x = /^(\d{1,9})\.json$/.exec(f);
    return x ? [Number(x[1])] : [];
  }).sort((a, b) => b - a);
  let n = 0, r = null;
  for (n of ns) { // ponytail: newest first, one file each (≤ FIX_MAX + 1 a round)
    try { r = JSON.parse(await readPlain(path.join(dir, `${String(n).padStart(2, '0')}.json`), 4 << 20) ?? 'null'); } catch { r = null; }
    if (isObj(r) && Array.isArray(r.findings) && (kind === 'final' || given !== null || r.verdict === 'pass')) break;
    r = null;
    if (kind === 'final') break; // the newest only, as review
  }
  const none = new TbError(404, `${t.id}: no ${kind === 'final' ? 'final review' : 'verdict doc'}${given === null ? '' : ` ${n}`}`);
  if (!r) throw none;
  if (kind === 'verdict') {
    const rel = /^docs\/(.+)$/.exec(typeof r.verdict_doc === 'string' ? r.verdict_doc : '')?.[1];
    const abs = rel && DOC_RE.exec(rel)?.[2] === 'md' ? await docAbs(t, rel) : null;
    const text = abs && await readPlain(abs, VERDICT_MAX);
    if (typeof text !== 'string') throw none;
    return [200, { id: t.id, kind, n, path: r.verdict_doc, text }];
  }
  /** @type {any} */
  const out = { id: t.id, kind, n, round: r.round, at: r.at, tested_sha: r.tested_sha, verdict: r.verdict, verdict_doc: r.verdict_doc, verification_doc: r.verification_doc,
    summary: isObj(r.summary) ? r.summary : null, findings: r.findings.filter(isObj).map((f) => ({ ...f, blocking: review().blocking(/** @type {any} */ (f)) })).sort((a, b) => Number(b.blocking) - Number(a.blocking)) };
  while (out.findings.length > 1 && bytes(out) > REPORT_MAX) { out.findings.pop(); out.truncated = true; }
  return [200, out];
}

// M5.2 (C6 C20): ?kind=rec[&run=][&cursor=]: one page of runs/<run>.rec.jsonl (lib/recorder.js wrote it, masked), the newest
// rec file by default; its meta line must be this ticket's QA. The recs after the cursor (= recs already shown), each as
// a curl line + status + headers + body (texts over 16 KB cut, a still too big rec cut to 1 KB), ≤ 64 KB with at least
// one; next: the cursor of the next page, null at the end. Read line by line, never whole. ponytail: the lines before
// the cursor are parsed too (≤ 200 recs a run); a byte-offset cursor if that ever costs.
const recItem = (/** @type {any} */ r) => require('./recorder').recItem(r); // M5.3 D-0106: shared with the verdict doc's evidence (lib/final.js)
async function recs(t, q) {
  const given = q.get('run'), from = q.get('cursor');
  if (given !== null && !/^[1-9]\d{0,8}$/.test(given)) throw new TbError(400, 'run must be a run number from 1');
  if (from !== null && !/^\d{1,9}$/.test(from)) throw new TbError(400, 'cursor must be a whole number');
  const dir = path.join(store.ticketDir(t.id), 'runs');
  const runs = (await fsp.readdir(dir).catch(() => [])).flatMap((f) => {
    const x = /^(\d{1,9})\.rec\.jsonl$/.exec(f);
    return x ? [Number(x[1])] : [];
  }).sort((a, b) => b - a);
  const run = given === null ? runs[0] : Number(given);
  const after = Number(from ?? 0);
  const items = [];
  let size = 0, mine = false, next = null;
  if (run) await eachLine(path.join(dir, `${run}.rec.jsonl`), (v, i) => {
    if (i === 1) return !(mine = v?.meta === true && v.ticket === t.id && v.phase === 'qa');
    if (i - 1 <= after || !isObj(v)) return false;
    const item = recItem(v), b = bytes(item) + 1;
    if (items.length && size + b > REPORT_MAX) {
      next = i - 2;
      return true;
    }
    items.push(item);
    size += b;
    return false;
  });
  if (!mine) throw new TbError(404, `${t.id}: ${run ? `run ${run} has no QA recs` : 'no QA recs yet'}`);
  return [200, { id: t.id, kind: 'rec', run, runs, items, next }];
}

// M5.2 (C8 C20 C21 A01): GET …/docs?path=<rel>: a mirrored doc (lib/docs.js copies them to tickets/<id>/docs/), md as
// text/plain, png as image/png (nosniff: SECURITY), never rendered by tbd. The path matches the contract's regex, no link
// lies on the way (its realpath is the path under the docs dir's own realpath), opened O_NOFOLLOW, a regular file ≤ 5 MB
// (fstat on the fd), streamed. Anything else → 404.
const DOC_RE = /^(verification|verdicts)\/(?:(?!\.\.?\/)[A-Za-z0-9._-]{1,120}\/){0,6}[A-Za-z0-9._-]{1,120}\.(md|png)$/; // ≤ 6 dirs, no . / ..
const DOC_MAX = 5 * 1024 * 1024;
// rel (a DOC_RE match) → its path under tickets/<id>/docs when no link lies on the way (realpath = the path), else null
async function docAbs(t, rel) {
  const base = await fsp.realpath(path.join(store.ticketDir(t.id), 'docs')).catch(() => null);
  const abs = base && path.join(base, rel);
  return abs && (await fsp.realpath(abs).catch(() => null)) === abs ? abs : null;
}
async function doc(req, res, m) {
  const t = store.getTicket(m[1]);
  const rel = query(req).get('path') ?? '';
  const x = DOC_RE.exec(rel);
  if (!x) throw new TbError(400, 'path must be verification/ or verdicts/, then up to 6 dirs (no . or ..), then a name ending .md or .png');
  const none = new TbError(404, `${t.id}: no doc ${rel}`);
  const abs = await docAbs(t, rel);
  if (!abs) throw none;
  let fh;
  try {
    fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw none;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > DOC_MAX) throw none;
    res.writeHead(200, { 'Content-Type': x[2] === 'md' ? 'text/plain; charset=utf-8' : 'image/png', 'Cache-Control': 'no-store' });
    await pipeline(fh.createReadStream({ autoClose: false, end: Math.max(st.size - 1, 0) }), res);
  } finally {
    await fh.close();
  }
}

// X14: the parent's own work.lanes entries, one getTicket each (a lane gone from the store is left out); live = a run holds the lease (recovery.js rule)
function lanesOf(t) {
  return Object.entries(t.work.lanes).flatMap(([task, id]) => {
    try {
      const l = store.getTicket(id);
      return [{ id, task, state: l.state, waiting: l.waiting, live: Boolean(l.lease && (!l.lease.exit || l.lease.pending)), attempt: l.work?.tasks?.find((x) => x.id === task)?.attempt ?? null }];
    } catch { return []; }
  });
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
  ['GET', /^\/api\/session\/csrf$/, () => [200, { csrf: keys.csrf }]], // P5: the page's synchronizer token (cookie: same-origin reads only)
  ['GET', /^\/api\/tickets\/([^/]+)$/, async (req, res, m) => { // round: the newest planning round; plan: the frozen one (L7); ask: the open working ask
    const ticket = store.getTicket(m[1]);
    const [round, plan, ask] = await Promise.all([planning.currentRound(ticket), planning.frozenPlan(ticket), openAsk(ticket)].map((p) => p.catch(() => null))); // a garbled or linked file: none
    return [200, { ticket, fix_max: review().FIX_MAX, ...(round && { round }), ...(plan && { plan }), ...(ask && { ask }), ...(ticket.work?.lanes && { lanes: lanesOf(ticket) }) }];
  }],
  ['GET', /^\/api\/tickets\/([^/]+)\/log$/, log],
  ['GET', /^\/api\/tickets\/([^/]+)\/gates$/, gates],
  ['GET', /^\/api\/tickets\/([^/]+)\/gates\/(\d{1,9})\/log$/, gateLog],
  ['GET', /^\/api\/tickets\/([^/]+)\/interventions$/, interventions],
  ['GET', /^\/api\/tickets\/([^/]+)\/feedback\/([1-9]\d{0,3})$/, feedback],
  ['GET', /^\/api\/tickets\/([^/]+)\/report$/, report],
  ['GET', /^\/api\/tickets\/([^/]+)\/docs$/, doc],
  ['GET', /^\/api\/tickets\/([^/]+)\/pass$/, async (req, res, m) => [200, await pass.preview(m[1], query(req).get('sha'))]], // the UI's confirm: nothing written
  ['POST', /^\/api\/tickets\/([^/]+)\/(resume|restart|cancel)$/, control],
  ['POST', /^\/api\/tickets\/([^/]+)\/assign$/, async (req, res, m) => [200, { ticket: await planning.assign(m[1]) }]],
  ['POST', /^\/api\/tickets\/([^/]+)\/answer$/, answer],
  // M5.4 D: reopen the Clarify page; interview.reopen writes the interventions row (verb lavish) itself
  ['POST', /^\/api\/tickets\/([^/]+)\/lavish$/, async (req, res, m) => [200, await interview.reopen(m[1], actorOf(req))]],
  ['POST', /^\/api\/tickets\/([^/]+)\/scope$/, scope],
  ['POST', /^\/api\/tickets\/([^/]+)\/rework$/, rework],
  ['POST', /^\/api\/tickets\/([^/]+)\/close$/, async (req, res, m) => { // M5 C13: tb close (token, or cookie + X-TB-CSRF: CSRF above)
    const b = await body(req);
    if (b !== null && !(isObj(b) && !Object.keys(b).length)) throw new TbError(400, 'body must be empty or {}');
    return [200, { ticket: await final().close(m[1], actorOf(req)) }];
  }],
  ['POST', /^\/api\/tickets\/([^/]+)\/pass$/, async (req, res, m) => [200, { ticket: await pass.pass(m[1], (await body(req)) ?? {}, actorOf(req)) }]],
  ['POST', /^\/api\/tickets\/([^/]+)\/(allow|deny)-change$/, async (req, res, m) => [200, { ticket: await working()[m[2] === 'allow' ? 'allowChange' : 'denyChange'](m[1], await body(req), actorOf(req)) }]],
  // M5 C14 (A18): cli or ui (cookie + CSRF); 202 once the push is recorded running, its end as ticket events (push.state)
  ['POST', /^\/api\/tickets\/([^/]+)\/push$/, async (req, res, m) => [202, await require('./push').start(m[1], actorOf(req))]],
  ['POST', /^\/api\/tickets\/([^/]+)\/reject$/, async (req, res, m) => [200, { ticket: await planning.reject(m[1], await body(req)) }]],
  ['POST', /^\/api\/tickets\/([^/]+)\/approve$/, async (req, res, m) => { // L7: n = the plan round Irfan saw (the UI sends it)
    const b = await body(req);
    if (b !== null && !(isObj(b) && Object.keys(b).every((k) => k === 'n') && (b.n === undefined || Number.isInteger(b.n)))) throw new TbError(400, 'body must be {} or {"n": <plan round>}');
    if (!runner) throw new TbError(503, 'starting');
    await planning.approve(m[1], { alert: runner.alert, n: b?.n });
    return [202, { id: m[1], op: 'approve', accepted: true }];
  }],
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
    if (method !== 'GET' && url.startsWith('/api/tickets/') && ID_RE.test(m[1])) { // X14: a lane takes no verb of its own
      let parent;
      try { parent = store.getTicket(m[1]).lane_of?.id; } catch { /* unknown id: the handler answers */ }
      if (parent) throw new TbError(409, `${m[1]}: a lane of ${parent}: act on the parent`);
    }
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

module.exports = { createServer, ready, gate, gateEvent, onCheck };
