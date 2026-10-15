'use strict';
// recorder (M5 C6, D-0086 "HTTP evidence cannot be faked", A10): tbd makes a QA run's HTTP call itself. `tbx req` → socket
// op http.req → slots proves the caller is under the run root its key names → record(). Kept in the ticket's
// runs/<n>.rec.jsonl (O_APPEND|O_NOFOLLOW, 0600; the first line is the meta line, lines as lib/gates/types.js C1 says;
// headers as [name, value] pairs), never in tbd.log.
// Policy (A01 SSRF): only the run holding the ticket's lease gen in qa; http to localhost / 127.0.0.1 / [::1] on a port
// of the tag's qa_ports that is not tbd's, lavish's or 5432; every pid listening there under the same run root (lsof; a
// pass cached 10 s per run + port); the methods and caps below; redirects not followed, 30 s timeout; 200 requests a
// run, one at a time. A refusal sends and writes nothing.
// The file is masked, the agent's reply is not: secret-looking header names, JSON keys (depth ≤ 20; deeper: the subtree
// whole), form and query params → <masked:h8> (h8: HMAC-SHA256 under the per-install key TB_HOME/rec-key, so equal
// secrets match and none can be read back), then env_files values → [redacted] (D-0102: a SECRET-named key's value of 4+
// characters, and any value of 8+ that is not all digits, so PORT=3000 stays readable). Loaded on the first http.req only.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const sh = require('./sh');
const { envPairs, eachLine, isObj } = require('./util');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/; // an HTTP token
const TBD_SET = ['host', 'content-length', 'transfer-encoding', 'connection'];
const HEADERS_MAX = 30;
const VALUE_MAX = 4096;
const BODY_MAX = 48 * 1024; // the socket's request line is ≤ 64 KB (slots LINE_MAX)
const KEEP_MAX = 256 * 1024; // response body kept
const RUN_MAX = 200; // requests per run
const HEARD_MS = 10_000;
const SECRET = /auth|cookie|token|secret|key|session|pass|pwd|credential/i; // pass: passwd, password too
const RUN_RE = /^(t_[a-z0-9]{6})\.(\d+)$/; // runner runId <id>.<gen>
const LOG_RE = /^runs\/(\d+)\.jsonl$/; // lease.log: the run number n
const DEPTH = 20;

const runs = new Map(); // runId → {k: requests recorded (null: count the file first), busy}
const heard = new Map(); // '<runId>:<port>' → when its listener check last passed

// C6: the per-install HMAC key, 32 random bytes, 0600, made on first use and never replaced. The bytes go to a temp file
// ('wx') linked in as the key (link fails with EEXIST when it exists): a racer never reads a half-written key, and
// every racer reads back the one file that won.
async function recKey(/** @type {string} */ home) {
  const file = path.join(home, 'rec-key');
  const open = () => fsp.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
  let fh = await open().catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!fh) {
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}`;
    await fsp.writeFile(tmp, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    try {
      await fsp.link(tmp, file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    fh = await open();
  }
  try {
    const st = await fh.stat();
    const key = await fh.readFile();
    if (!st.isFile() || key.length !== 32) throw new Error('rec-key is not a plain file of 32 bytes');
    return key;
  } finally {
    await fh.close();
  }
}

const h8 = (/** @type {Buffer} */ key, /** @type {string} */ v) => `<masked:${crypto.createHmac('sha256', key).update(v).digest('hex').slice(0, 8)}>`;
const dec = (/** @type {string} */ s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
// name=value pairs (a form body, a query): a pair whose decoded name looks secret → name=<masked:h8>; the rest byte for byte
const maskPairs = (/** @type {string} */ s, /** @type {Buffer} */ key) => s.split('&').map((p) => {
  const i = p.indexOf('=');
  return i > 0 && SECRET.test(dec(p.slice(0, i))) ? `${p.slice(0, i)}=${h8(key, dec(p.slice(i + 1)))}` : p;
}).join('&');
/** @returns {any} */
function maskJson(/** @type {any} */ v, /** @type {Buffer} */ key, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (depth >= DEPTH) return h8(key, JSON.stringify(v)); // deeper than 20: masked whole (fail closed)
  if (Array.isArray(v)) return v.map((x) => maskJson(x, key, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? h8(key, typeof x === 'string' ? x : JSON.stringify(x)) : maskJson(x, key, depth + 1)]));
}
// JSON that does not parse (cut at KEEP_MAX, malformed), by pattern: a secret key's value → <masked:h8>, a string (to its
// closing quote or the end) or a scalar; an object or array → masked from there to the end (its end can't be found).
function maskCut(/** @type {string} */ s, /** @type {Buffer} */ key) {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*(?:("(?:[^"\\]|\\.)*"?|[^\s,{}[\]]+)|(?=[{[]))/g)) {
    if (!SECRET.test(m[1])) continue; // its string value is in the match: never read as a key
    const end = /** @type {number} */ (m.index) + m[0].length;
    if (m[2] === undefined) return `${out}${s.slice(at, end)}${h8(key, s.slice(end))}`;
    out += `${s.slice(at, end - m[2].length)}"${h8(key, m[2].replace(/^"|"$/g, ''))}"`;
    at = end;
  }
  return out + s.slice(at);
}
// a JSON object or array: masked by key (unchanged: as sent); one that does not parse: maskCut; text with no white space
// inside (ends trimmed: --data-file adds a newline) and an `=`: a form body; else as is. JSON too deep for the stack: the
// body masked whole.
function maskBody(/** @type {string | undefined} */ s, /** @type {Buffer} */ key) {
  if (!s) return s;
  try {
    const j = JSON.parse(s);
    if (j !== null && typeof j === 'object') {
      const out = JSON.stringify(maskJson(j, key));
      return out === JSON.stringify(j) ? s : out;
    }
  } catch (e) {
    if (e instanceof RangeError) return h8(key, s);
    if (/^\s*[{[]/.test(s)) return maskCut(s, key);
  }
  return s.includes('=') ? maskPairs(s, key) : s; // any k=v text (a space inside a form too): secret pairs masked
}

// → why the request may not go, or {u, port}
function policy(/** @type {any} */ req, /** @type {any} */ tag) {
  const { method, url, headers, body } = req;
  if (!METHODS.includes(method)) return { why: `method must be one of ${METHODS.join(' ')}` };
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { why: 'url does not parse' };
  }
  if (u.protocol !== 'http:' || !HOSTS.includes(u.hostname) || u.username || u.password) return { why: 'url must be http://localhost, http://127.0.0.1 or http://[::1] (no user:password@)' };
  const port = Number(u.port || 80);
  const tbd = Number(process.env.TB_PORT) || store.config.http?.port || 7777; // as the gate profile reads it
  const lavish = store.interviewConfig(store.config).port;
  if (!(Array.isArray(tag?.qa_ports) && tag.qa_ports.includes(port)) || [tbd, lavish, 5432].includes(port)) {
    return { why: `port ${port} is not one of the tag's qa_ports (tbd's, lavish's and 5432 never are)` };
  }
  if (!Array.isArray(headers) || headers.length > HEADERS_MAX) return { why: `headers: a list of at most ${HEADERS_MAX} [name, value] pairs` };
  for (const h of headers) {
    if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== 'string' || typeof h[1] !== 'string' || !NAME_RE.test(h[0])) return { why: 'a header is [name, value], the name an HTTP token' };
    if (TBD_SET.includes(h[0].toLowerCase())) return { why: `header ${h[0]}: tbd sets it` };
    if (Buffer.byteLength(h[1]) > VALUE_MAX || /[\r\n\0]/.test(h[1])) return { why: `header ${h[0]}: value over ${VALUE_MAX} bytes or with a line break` };
  }
  if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > BODY_MAX)) return { why: `body: text of at most ${BODY_MAX} bytes` };
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) return { why: `${method} sends no body` };
  return { u, port };
}

// every pid lsof lists listening on port is under the run root (under); a pass is cached 10 s. An lsof cut short by its
// timeout may list too few: refused.
async function listened(/** @type {string} */ runId, /** @type {number} */ port, /** @type {(pid: number) => Promise<boolean>} */ under) {
  const id = `${runId}:${port}`;
  if (Date.now() - (heard.get(id) ?? 0) < HEARD_MS) return true;
  const r = await sh('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 5000 });
  if (r.err?.signal) return false;
  const pids = [...String(r.stdout).matchAll(/^p(\d+)$/gm)].map((x) => Number(x[1]));
  for (const p of pids) if (!(await under(p))) return false;
  if (pids.length) heard.set(id, Date.now());
  return pids.length > 0;
}

// the response body, at most KEEP_MAX bytes of it read (the rest cancelled)
async function keep(/** @type {Response} */ r) {
  const parts = [];
  let size = 0;
  let truncated = false;
  for await (const c of /** @type {any} */ (r.body ?? [])) {
    if (size + c.length > KEEP_MAX) {
      parts.push(c.subarray(0, KEEP_MAX - size));
      truncated = true;
      break;
    }
    parts.push(c);
    size += c.length;
  }
  return { body: Buffer.concat(parts).toString('utf8'), truncated };
}

/**
 * The socket op http.req of a process under run runId's root (slots proved it). under(pid): pid is under that root too.
 * → {ok: true, rec: '<n>.<k>', status, headers, body, truncated, ms, error?} (status null + error: no answer, still
 * recorded) | {ok: false, error} (refused, nothing sent or written)
 * @param {any} req @param {{runId: string, tbHome: string, under: (pid: number) => Promise<boolean>}} ctx
 */
async function record(req, { runId, tbHome, under }) {
  const m = RUN_RE.exec(runId);
  let t = null;
  try { t = m && store.getTicket(m[1]); } catch { /* gone */ }
  const n = LOG_RE.exec(t?.lease?.log ?? '')?.[1];
  if (!m || !n || t.lease.gen !== Number(m[2]) || t.lease.phase !== 'qa') return { ok: false, error: 'tbx req works only in a qa run that holds its ticket' };
  const tag = store.listTags()[t.tag];
  const p = policy(req, tag);
  if (!p.u) return { ok: false, error: p.why };
  for (const [id, at] of heard) if (Date.now() - at >= HEARD_MS) heard.delete(id);
  if (runs.size > 32) for (const [id, x] of runs) if (!x.busy) runs.delete(id); // ponytail: k is counted from the file again
  const s = runs.get(runId) ?? runs.set(runId, { k: null, busy: false }).get(runId);
  if (s.busy) return { ok: false, error: 'one request at a time per run' };
  s.busy = true;
  try {
    const file = path.join(store.ticketDir(t.id), 'runs', `${n}.rec.jsonl`);
    if (s.k === null) {
      let lines = 0;
      await eachLine(file, (_v, i) => { lines = i; }, ['\n']); // counted, never parsed (no line holds a newline)
      s.k = Math.max(0, lines - 1); // the meta line
    }
    if (s.k >= RUN_MAX) return { ok: false, error: `${RUN_MAX} requests per run used` };
    if (!(await listened(runId, p.port, under))) return { ok: false, error: `port ${p.port}: no listener, or one this run did not start` };
    const key = await recKey(tbHome);
    const vals = (await envPairs(tag)).filter(([k, v]) => (SECRET.test(k) && v.length >= 4) || (v.length >= 8 && !/^\d+$/.test(v))) // D-0102
      .map(([, v]) => v).sort((a, b) => b.length - a.length); // before the call: a read error sends nothing
    const at = new Date().toISOString();
    const t0 = Date.now();
    let res = null;
    let error;
    try {
      const r = await fetch(p.u, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      res = { status: r.status, headers: [...r.headers], ...(await keep(r)) };
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'no answer in 30 s' : String(e.cause?.code ?? e.message);
    }
    const ms = Date.now() - t0;
    const red = (/** @type {any} */ x) => (typeof x === 'string' ? vals.reduce((y, v) => y.split(v).join('[redacted]'), x) : x);
    const heads = (/** @type {[string, string][]} */ hs) => hs.map(([k, v]) => [k, red(SECRET.test(k) ? h8(key, v) : v)]);
    const url = p.u.search ? p.u.href.replace(p.u.search, () => `?${maskPairs(p.u.search.slice(1), key)}`) : p.u.href;
    const rec = `${n}.${s.k + 1}`;
    const line = {
      n: rec, at, method: req.method, url: red(url), req: { headers: heads(req.headers), body: red(maskBody(req.body, key)) ?? null, truncated: false },
      res: res && { status: res.status, headers: heads(res.headers), body: red(maskBody(res.body, key)), truncated: res.truncated }, ms, ...(error && { error }),
    };
    const meta = { meta: true, ticket: t.id, run: Number(n), phase: t.lease.phase, round: t.lease.round, gen: t.lease.gen };
    const fh = await fsp.open(file, fsp.constants.O_WRONLY | fsp.constants.O_APPEND | fsp.constants.O_CREAT | fsp.constants.O_NOFOLLOW, 0o600);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error(`runs/${n}.rec.jsonl is not a plain file`);
      await fh.write(`${st.size ? '' : `${JSON.stringify(meta)}\n`}${JSON.stringify(line)}\n`);
    } finally {
      await fh.close();
    }
    s.k++;
    return { ok: true, rec, ...(res ?? { status: null }), ms, ...(error && { error }) };
  } finally {
    s.busy = false;
  }
}

// M5.2 (C20) + M5.3 D-0106: a rec line (this module wrote it: masked) for a human, the report's rec page (lib/http.js) and
// the verdict doc's evidence (lib/final.js): a curl line + status + headers + body, texts over max cut (…); a rec whose
// item is still over ITEM_MAX → every text cut to 1 KB.
const ITEM_MAX = 30 * 1024; // half a report page (http.js REPORT_MAX 60 KB)
const q1 = (/** @type {any} */ s) => `'${String(s).replaceAll("'", "'\\''")}'`; // shell single quotes
function recItem(/** @type {any} */ r, max = 16 * 1024) {
  const clip = (/** @type {any} */ s) => { const v = String(s ?? ''); return v.length > max ? `${v.slice(0, max)}…` : v; };
  const pairs = (/** @type {any} */ h) => (Array.isArray(h) ? h.filter((p) => Array.isArray(p)).slice(0, max > 1024 ? 50 : 10).map(([k, v]) => [clip(k), clip(v)]) : []);
  const rq = isObj(r.req) ? r.req : {}, rs = isObj(r.res) ? r.res : null;
  const verb = r.method === 'GET' ? '' : r.method === 'HEAD' ? ' -I' : ` -X ${r.method}`;
  const curl = `curl${verb} ${q1(r.url)}${pairs(rq.headers).map(([k, v]) => ` -H ${q1(`${k}: ${v}`)}`).join('')}${typeof rq.body === 'string' ? ` --data-raw ${q1(rq.body)}` : ''}`;
  /** @type {{n: any, at: any, ms: any, curl: string, status: number|null, headers: string[][], body: string, truncated: boolean, error?: string}} */
  const item = { n: r.n, at: r.at, ms: r.ms, curl: clip(curl), status: rs?.status ?? null, headers: pairs(rs?.headers), body: clip(rs?.body),
    truncated: Boolean(rs?.truncated) || curl.length > max || String(rs?.body ?? '').length > max, ...(r.error && { error: clip(r.error) }) };
  return max > 1024 && Buffer.byteLength(JSON.stringify(item)) > ITEM_MAX ? recItem(r, 1024) : item;
}

module.exports = { record, recKey, maskBody, recItem };
