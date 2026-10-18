'use strict';
// interview: a planning Clarify round on a lavish-axi page (M5.4 C18; D-0083, D-0117..D-0121, D-0124). tbd renders the
// round as TB_HOME/interview/<id>-rNN/page.html (one 0700 dir per round; one form per question, recommended first;
// every agent string through esc() in text nodes and quoted attributes only, text nodes also vis(); ONE static script
// with no agent text; a per-round nonce, the ticket keeps its sha), opens it with the pinned lavish install
// (util.lavishDir: `node cli.mjs`, never npx, never `share`) and polls lavish for the answers. A send whose every item
// has the round's nonce + round and that answers every question → planning.answer(id, body, 'lavish') (an intervention
// row, D-0117); anything else is ignored: a journal line {at, why, n} in tickets/<id>/interview.jsonl and a fixed tbd
// text on the page (D-0120, never agent text); a wrong nonce also alerts once per round. The board and `tb answer`
// always work beside it; interview.lavish false = board only.
// - jail (D-0124): every lavish call (open, poll, end, stop, reopen) runs under /usr/bin/sandbox-exec -f lib/lavish.sb
//   (its detached server inherits it): reads only node, the install, the page dirs and its state dir; writes only its
//   state dir (= its cwd); binds only localhost:<port>; connects only to loopback. Share's API points at 127.0.0.1:9.
// - open (D-0118): when planning → clarify (prev planning, a planning clarify: X5, X11), any hour. Port owner check
//   first (F5): the port is free or held by our install's own server, else no open + 1 alert. lavish never opens the
//   browser (LAVISH_AXI_NO_OPEN always, SEC-2): tbd opens the url lavish prints, only when it is lavish's own form.
// - poll (S5): lavish's poll never times out, so tbd owns the cycle: interview.poll_min, then killed (SIGTERM; SIGKILL
//   5 s later) and run again; feedback waits queued in lavish meanwhile. Always --takeover. One ticket CAS
//   interview.poll {pid, lstart} per cycle (boot kills an orphan by it). D-0119: a send (stdout with status feedback,
//   read or not) is written to TB_HOME/interview-out/<id>-rNN.feedback (0600) before it is parsed; removed once applied
//   or ignored; boot applies a leftover. A cycle under 1 s waits 1 s; a failed one 2 s × failures.
// - breaker (F7): one for the one server. A failed poll or open +1, a normal poll end = 0; at 3 (or lavish not
//   installed) every poll is killed and one alert says so; rounds opened meanwhile get the board only. reopen() (tb
//   lavish, the board button) probes: reset + one open + poll, then every open round is polled again.
// - leave clarify (F6): poll killed → `end <html>` → the round's dir removed → ticket.interview dropped → `stop` the
//   server once no ticket holds an interview.
// Async only on request paths; children get util.minimalEnv + exact LAVISH_AXI_* keys and a timeout.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const store = require('./store');
const planning = require('./planning');
const sh = require('./sh');
const { procs } = require('./slots');
const { killOrphans } = require('./recovery');
const { TbError } = require('./errors');
const { isObj, isFile, minimalEnv, lavishDir, readPlain } = require('./util');

const TB_HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const PAGES = path.join(TB_HOME, 'interview'); // one dir per round, the only page dirs lavish may read
const OUTBOX = path.join(TB_HOME, 'interview-out'); // sends on disk (D-0119): never inside a page dir
const STATE = path.join(TB_HOME, 'lavish'); // lavish's state dir and cwd: the only place it writes
const PROFILE = path.join(__dirname, 'lavish.sb');
const CMD_MS = 30_000; // open, end, stop
const KILL_MS = 5000; // SIGTERM → SIGKILL
const OUT_MAX = 10 << 20; // a poll's stdout (dom_snapshot included)
const BREAK_AFTER = 3;
const MARK = '\n\nContext data:\n'; // lavish appends the queued data to the prompt after it (cli.mjs:6041)
const FEEDBACK = /^ {2}status: feedback$/m;
// D-0120: tbd's own texts, one per reason a send is ignored (never agent text)
const REPLY = {
  partial: 'tbd: not saved. Every question needs an answer (a choice, You decide, or your own text). Queue the missing ones, then Send to Agent again.',
  round: 'tbd: not saved. This page belongs to an older round. Open the newest round from the board or with tb lavish.',
  nonce: 'tbd: not saved. This send did not come from the page tbd made for this round. Open the round from the board or with tb lavish.',
};
class Moved extends Error {} // the ticket left the round a step expected: its write is dropped

const polls = new Map(); // id → its live poll child (one per open round)
const looping = new Set(); // `<id> <round>` with a poll loop running (a round's old loop may still end beside the next's)
const opening = new Set(); // ids with an open in flight (a double click = one open)
const warned = new Set(); // `<id> <round>` alerted for a wrong nonce (SEC-9); cleared when the round ends
let failures = 0;
let down = false;
let stopping = false;
let alert = (/** @type {{title: string, message: string}} */ a) => console.error(`tbd: ${a.title}: ${a.message}`);

const round = (/** @type {string} */ id, /** @type {number} */ n) => `${id}-r${String(n).padStart(2, '0')}`;
const outbox = (/** @type {string} */ id, /** @type {number} */ n) => path.join(OUTBOX, `${round(id, n)}.feedback`);
const cli = () => path.join(lavishDir(), 'node_modules', 'lavish-axi', 'dist', 'cli.mjs');
const sha = (/** @type {string} */ s) => crypto.createHash('sha256').update(s).digest('hex');
const log = (/** @type {string} */ id) => (/** @type {Error} */ e) => console.error(`tbd: ${id}: lavish: ${e.message}`);
const first = (/** @type {any} */ o) => String(o.stdout || o.err?.message || '').split('\n')[0].slice(0, 200);
const config = () => store.interviewConfig(store.config);
const live = (/** @type {string} */ id, /** @type {number} */ n) => {
  let k;
  try { k = store.getTicket(id); } catch { return null; }
  return planning.planningClarify(k) && k.interview?.round === n ? k : null;
};
// our kill: SIGTERM (lavish's poll exits 143 on it, cli.mjs:13067), SIGKILL when it is still there 5 s later
function kill(/** @type {any} */ c) {
  c.kill('SIGTERM');
  setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }, KILL_MS).unref();
}

// The env lavish runs with: the minimal env + exactly these keys. NO_OPEN always: tbd opens the browser itself (SEC-2).
// LINK_HOST localhost: the page's URL is on another host than the board's 127.0.0.1, so the browser never sends
// tb_session to the lavish server (spike m5-4 a). HTML_APP_API_URL: share's publish API on a dead loopback port.
function env(/** @type {any} */ cfg) {
  return {
    ...minimalEnv(process.env), LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_HOST: '127.0.0.1', LAVISH_AXI_LINK_HOST: 'localhost',
    LAVISH_AXI_STATE_DIR: STATE, LAVISH_AXI_PORT: String(cfg.port), LAVISH_AXI_IDLE_TIMEOUT_MS: String(Math.round(cfg.idle_min * 60_000)),
    LAVISH_AXI_NO_OPEN: '1', LAVISH_AXI_HTML_APP_API_URL: 'http://127.0.0.1:9',
  };
}
// sandbox-exec's argv before node: lib/lavish.sb with its params as real paths (SBPL matches resolved paths).
async function jail(/** @type {number} */ port, tbHome = TB_HOME, home = os.homedir()) {
  const tb = await fsp.realpath(tbHome);
  await fsp.mkdir(path.join(tb, 'lavish'), { recursive: true, mode: 0o700 });
  const d = { HOME: await fsp.realpath(home), TB_HOME: tb, NODE_DIR: await fsp.realpath(path.dirname(path.dirname(process.execPath))),
    LAVISH_DIR: await fsp.realpath(lavishDir()), PAGES: path.join(tb, 'interview'), STATE: path.join(tb, 'lavish'), PORT: String(port) };
  return ['-f', PROFILE, ...Object.entries(d).flatMap(([k, v]) => ['-D', `${k}=${v}`])];
}
const lavish = async (/** @type {string[]} */ args, /** @type {any} */ cfg) =>
  sh('/usr/bin/sandbox-exec', [...(await jail(cfg.port)), process.execPath, cli(), ...args], { env: env(cfg), cwd: STATE, timeout: CMD_MS });

// lavish's TOON stdout (S5): `key: value` lines, `session:` + indented `  key: value`, and prompts as a table
// (`prompts[n]{f1,f2,..}:` + n rows of comma-separated cells: a JSON-quoted string or a bare word) or, when a prompt
// carries more (target, attachments), as a list (`prompts[n]:` + `  - key: value` items, nested lines skipped). Each
// prompt gets `data`: the JSON lavish put after "Context data:", or null. → {session, prompts, code?} or null (a
// prompt row or item that does not parse, or fewer than n).
function parse(/** @type {string} */ text) {
  const value = (/** @type {string} */ s) => {
    const v = s.trim();
    if (!v.startsWith('"')) return v;
    try { return JSON.parse(v); } catch { return undefined; }
  };
  const cells = (/** @type {string} */ line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        cur += c;
        if (c === '\\') cur += line[++i] ?? '';
        else if (c === '"') quoted = false;
      } else if (c === ',') {
        out.push(cur);
        cur = '';
      } else {
        quoted = c === '"';
        cur += c;
      }
    }
    return quoted ? null : [...out, cur].map(value);
  };
  const data = (/** @type {any} */ p) => {
    const i = typeof p.prompt === 'string' ? p.prompt.lastIndexOf(MARK) : -1;
    try { return i < 0 ? null : JSON.parse(p.prompt.slice(i + MARK.length)); } catch { return null; }
  };
  /** @type {{session: Record<string, any>, prompts: any[], code?: string}} */
  const out = { session: {}, prompts: [] };
  const lines = String(text).split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^prompts\[(\d+)\]\{([^}]*)\}:$/.exec(l))) {
      const keys = m[2].split(',');
      for (let j = 0; j < Number(m[1]); j++) {
        const row = cells((lines[++i] ?? '').replace(/^ {2}/, ''));
        if (!row || row.length !== keys.length || row.includes(undefined)) return null;
        out.prompts.push(Object.fromEntries(keys.map((k, x) => [k, row[x]])));
      }
    } else if ((m = /^prompts\[(\d+)\]:$/.exec(l))) {
      let p = null;
      for (; /^ {2}\S|^ {4}/.test(lines[i + 1] ?? ''); i++) {
        const x = /^ {2}(- | {2})([a-z_]+)(?:\[\d+\](?:\{[^}]*\})?)?:(?: (.*))?$/.exec(lines[i + 1]); // an item's own keys; deeper lines skipped
        if (x?.[1] === '- ') out.prompts.push((p = {}));
        if (x && p && x[3] !== undefined) p[x[2]] = value(x[3]);
      }
      if (out.prompts.length !== Number(m[1]) || out.prompts.some((x) => Object.values(x).includes(undefined))) return null;
    } else if ((m = /^ {2}([a-z_]+): (.*)$/.exec(l)) && section === 'session') out.session[m[1]] = value(m[2]);
    else if ((m = /^([a-z_]+):(?: (.*))?$/.exec(l))) {
      section = m[1];
      if (m[1] === 'code') out.code = value(m[2] ?? '');
    }
  }
  out.prompts = out.prompts.map((p) => ({ ...p, data: data(p) }));
  return out;
}

// One send against the open round r of ticket k → {body} for planning.answer, or {why} it is ignored.
function judge(/** @type {any} */ k, /** @type {any} */ r, /** @type {any[]} */ prompts) {
  const items = prompts.map((p) => p.data).filter(isObj); // a chat line without tbd's data is no answer
  if (!items.length) return { why: 'partial' };
  if (items.some((d) => typeof d.nonce !== 'string' || sha(d.nonce) !== k.interview.nonce_sha)) return { why: 'nonce' };
  if (items.some((d) => d.round !== k.interview.round)) return { why: 'round' };
  const answers = Object.create(null); // question ids are agent text: never a prototype key
  for (const d of items) {
    const a = d.kind === 'pick' ? { pick: d.value } : d.kind === 'text' ? { text: d.value } : d.kind === 'you_decide' ? { use: 'you_decide' } : null;
    if (!a || !r.questions.some((x) => x.id === d.question)) return { why: 'partial' };
    answers[d.question] = a;
  }
  return r.questions.every((x) => Object.hasOwn(answers, x.id)) ? { body: { answers } } : { why: 'partial' };
}

// A send of round n on disk (D-0119) → applied or ignored, then its file removed. → why it was ignored, or null.
async function apply(/** @type {string} */ id, /** @type {number} */ n, /** @type {string} */ text) {
  const out = parse(text);
  const k = live(id, n);
  let why = 'round';
  if (k) {
    const r = await planning.currentRound(k);
    const j = r?.kind === 'questions' && r.n === n ? judge(k, r, out?.prompts ?? []) : { why: 'round' };
    why = j.why ?? null;
    if (j.body) {
      await planning.answer(id, j.body, 'lavish').catch((e) => {
        if (!(e instanceof TbError)) throw e;
        why = e.status === 400 ? 'partial' : 'round'; // a pick not among the options, a text too long; it moved on
      });
    }
  }
  if (why) {
    await fsp.appendFile(path.join(store.ticketDir(id), 'interview.jsonl'), JSON.stringify({ at: new Date().toISOString(), why, n: out?.prompts.length ?? 0 }) + '\n',
      { mode: 0o600, flag: store.APPEND }).catch(log(id));
    if (why === 'nonce' && !warned.has(`${id} ${n}`)) { // SEC-9: someone else posts to the page's session
      warned.add(`${id} ${n}`);
      alert({ title: 'Lavish send refused', message: `${id}: a send to round ${n} did not carry the page's nonce (not from tbd's page): ignored` });
    }
  }
  await fsp.rm(outbox(id, n), { force: true });
  return why;
}

function fail(/** @type {string} */ why) {
  if (down || ++failures < BREAK_AFTER) return;
  trip(why);
}
function trip(/** @type {string} */ why) {
  if (down) return;
  down = true;
  for (const c of polls.values()) kill(c);
  alert({ title: 'Lavish down', message: `answer in the board or with tb answer (${why})` });
}
const portTaken = (/** @type {number} */ port) => alert({ title: 'Lavish port taken', message: `port ${port} held by another process: answer in the board or with tb answer` });

// The poll child's {pid, lstart} on the ticket, while the round is still open (one CAS per cycle).
async function keepPoll(/** @type {string} */ id, /** @type {number} */ n, /** @type {number} */ pid) {
  const lstart = (await procs(true))?.get(pid)?.lstart;
  if (!lstart || !polls.has(id)) return;
  await store.updateTicket(id, (k) => {
    if (k.state !== 'clarify' || k.interview?.round !== n) throw new Moved();
    return { ...k, interview: { ...k.interview, poll: { pid, lstart } } };
  }).catch((e) => { if (!(e instanceof Moved)) log(id)(e); });
}

// One poll cycle of round n: lavish's poll under the jail, our timer (poll_min) kills it. → sh's {err, stdout}.
async function poll(/** @type {string} */ id, /** @type {number} */ n, /** @type {string} */ html, /** @type {any} */ cfg, /** @type {string | null} */ reply) {
  const args = [...(await jail(cfg.port)), process.execPath, cli(), 'poll', html, '--takeover', ...(reply ? ['--agent-reply', reply] : [])];
  let c;
  let timer;
  const r = await sh('/usr/bin/sandbox-exec', args, { env: env(cfg), cwd: STATE }, (/** @type {any[]} */ ...a) => {
    c = /** @type {any} */ (execFile)(...a);
    polls.set(id, c);
    timer = setTimeout(() => kill(c), cfg.poll_min * 60_000);
    if (c.pid) void keepPoll(id, n, c.pid);
    return c;
  });
  clearTimeout(timer);
  if (polls.get(id) === c) polls.delete(id);
  return r;
}

// One poll at a time per ticket while round n is open. reply: a fixed tbd text for the page (D-0120), sent with the
// next poll. NOT_FOUND (the session is gone): opened again without the browser, once until a normal poll end.
async function loop(/** @type {string} */ id, /** @type {number} */ n, /** @type {string | null} */ reply = null) {
  const key = `${id} ${n}`;
  if (looping.has(key)) return;
  looping.add(key);
  try {
    let found = true;
    for (let k = live(id, n); k && !down && !stopping; k = live(id, n)) {
      const cfg = config();
      const t0 = Date.now();
      const { err, stdout } = await poll(id, n, k.interview.html, cfg, reply);
      reply = null;
      const ours = !!err?.killed && typeof err.code !== 'string'; // our kill; a maxBuffer kill (code ERR_*) is not
      let ok = true;
      if (!ours && FEEDBACK.test(stdout)) { // D-0119 (CR-1): on disk before anything reads it, readable or not
        await fsp.mkdir(OUTBOX, { recursive: true, mode: 0o700 });
        await store.writeAtomic(outbox(id, n), stdout);
        const why = await apply(id, n, stdout);
        if (why) reply = REPLY[why];
        if (/^ {2}session_ended: true$/m.test(stdout)) return;
      } else {
        const out = parse(stdout);
        const status = err ? null : out?.session.status;
        if (status === 'ended') { // Irfan ended the session on the page: the board, tb answer or tb lavish go on
          failures = 0;
          return;
        }
        if (!ours && !['waiting', 'browser_disconnected'].includes(status)) {
          ok = false;
          if (err && out?.code === 'NOT_FOUND' && found) {
            found = false;
            if (!(await portOk(cfg.port))) {
              portTaken(cfg.port);
              fail(`port ${cfg.port} taken`);
            } else {
              const o = await lavish([k.interview.html], cfg);
              if (o.err) fail(`open: ${first(o)}`);
            }
          } else fail(`poll: ${String(err ? out?.code ?? err.message : 'unreadable output').split('\n')[0].slice(0, 200)}`);
        }
      }
      if (ok) {
        failures = 0;
        found = true;
      }
      const wait = Math.max(ok ? 0 : 2000 * failures, Date.now() - t0 < 1000 ? 1000 : 0); // CR-3: never a tight loop
      if (wait && !down && !stopping) await sleep(wait);
    }
  } finally {
    looping.delete(key);
  }
}
// Every open round polled again (boot; a probe after the breaker stopped them all). replies: id → a fixed text.
function repoll(/** @type {Map<string, string | null>} */ replies = new Map()) {
  if (!config().lavish) return;
  for (const k of store.listTickets()) if (k.interview?.html && planning.planningClarify(k)) void loop(k.id, k.interview.round, replies.get(k.id) ?? null).catch(log(k.id));
}

// F5 (N1): nothing listens on the port, or only our install's detached server (cli.mjs:14407-14418: tbd's node + its
// server.mjs + `server --port <p>`, spike m5-4 b). lsof as the recorder's check (5 s); a cut-short lsof refuses.
// Need Review: argv can be faked by a same-user process, and the port can change hands between this check and the open.
async function portOk(/** @type {number} */ port) {
  const r = await sh('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 5000 });
  if (r.err && (r.err.signal || r.err.code !== 1 || r.stdout)) return false; // exit 1 + no output: nothing listens
  const want = `${process.execPath} ${await fsp.realpath(lavishDir())}/node_modules/lavish-axi/dist/server.mjs server --port ${port}`;
  for (const [, pid] of String(r.stdout).matchAll(/^p(\d+)$/gm)) {
    const c = (await sh('/bin/ps', ['-o', 'command=', '-p', pid], { timeout: 5000 })).stdout.trim();
    if (c !== want && !c.startsWith(`${want} `)) return false;
  }
  return true;
}

const esc = (/** @type {any} */ s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// text nodes only (CR-14, same rule as ui/app.js vis): bidi controls and zero-width chars shown as [U+XXXX], never
// applied or hidden. Attribute values (radio values, data-q) stay exact: they go back as the answer.
const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const txt = (/** @type {any} */ s) => esc(String(s).replace(BIDI, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`));
// The page cannot link /foundation.css (lavish serves it from its own origin), so the board's foundation (the one source
// of truth, design/foundation.css) is read once, comments stripped, and inlined; a failed read is logged and retried
// by the next page. Only the page-local layout is written here, tokens and parts only.
const FOUNDATION = path.join(__dirname, '..', 'design', 'foundation.css');
/** @type {Promise<string> | undefined} */
let foundationCss;
const foundation = () => (foundationCss ??= fsp.readFile(FOUNDATION, 'utf8').then((c) => c.replace(/\/\*[\s\S]*?\*\//g, '')).catch((e) => {
  foundationCss = undefined;
  console.error(`tbd: lavish page: foundation.css: ${e.message}`);
  return '';
}));
const CSS = `body{max-width:720px;margin:0 auto;padding:32px 16px 64px}
body>p.lede{margin:4px 0 0;color:var(--fg-muted)}
h2.topic{margin:40px 0 12px}
fieldset.card{min-width:0;margin:16px 0 0}
fieldset.card legend{float:left;width:100%;padding:0}
fieldset.card legend+*{clear:both}
.why{margin:4px 0 16px;color:var(--fg-muted)}
.pick label{cursor:pointer}
.pick label:has(input:checked){background:var(--accent-soft);color:var(--accent-text)}
.pick input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--accent)}
.rec{margin-left:auto;color:var(--accent-text);font:500 var(--footnote) var(--font)}
.own{margin-top:16px;font:500 var(--footnote) var(--font)}
.own textarea{margin-top:6px}
.act{display:flex;align-items:center;gap:12px;margin-top:16px}
.st{color:var(--fg-muted);font:400 var(--footnote) var(--font)}`;
// The page's one script: no agent text. A form's question id, the nonce and the round come from the page itself.
const SCRIPT = `document.addEventListener('submit', function (e) {
  var f = e.target;
  if (!f.dataset || !f.dataset.q) return;
  e.preventDefault();
  var meta = function (n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : ''; };
  var t = f.querySelector('textarea').value.trim();
  var c = f.querySelector('input[type=radio]:checked');
  var st = f.querySelector('.st');
  var kind = t ? 'text' : c ? c.dataset.kind : '';
  if (!kind) { st.textContent = 'Pick an option or write your own answer first.'; return; }
  var value = kind === 'text' ? t : kind === 'pick' ? c.value : '';
  var label = f.dataset.q + ': ' + (kind === 'you_decide' ? 'you decide' : value);
  window.lavish.queuePrompt(label, { tag: 'tb-answer', text: label, element: f,
    data: { question: f.dataset.q, kind: kind, value: value, nonce: meta('tb-nonce'), round: Number(meta('tb-round')) } });
  st.textContent = 'Queued. Answer every question, then press Send to Agent.';
});`;

// The round as a page (Page spec F3 F4 m11): questions grouped by topic, per question its options with the recommended
// one first ("(Recommended)"), then "You decide", then a text box.
function page(/** @type {any} */ t, /** @type {any} */ r, /** @type {string} */ nonce, /** @type {string} */ css) {
  const topics = new Map();
  for (const x of r.questions) topics.set(x.topic ?? '', [...(topics.get(x.topic ?? '') ?? []), x]);
  const form = (/** @type {any} */ x) => {
    const opts = [...x.options].sort((a, b) => Number(b === x.recommended) - Number(a === x.recommended));
    return [`<form data-lavish-question="${esc(x.id)}" data-q="${esc(x.id)}"><fieldset class="card"><legend class="t-headline">${txt(x.id)}. ${txt(x.question)}</legend>`,
      `<p class="why t-subheadline">${txt(x.why)}</p>`,
      '<div class="glist pick">',
      ...opts.map((o) => `<label><input type="radio" name="c" value="${esc(o)}" data-kind="pick"><span>${txt(o)}</span>${o === x.recommended ? '<b class="rec">Recommended</b>' : ''}</label>`),
      '<label><input type="radio" name="c" value="" data-kind="you_decide"><span>You decide</span></label></div>',
      '<label class="field own">Or write your own answer<textarea name="t" rows="2" maxlength="10000"></textarea></label>',
      '<div class="act"><button type="submit" class="btn">Queue Answer</button><span class="st" role="status"></span></div></fieldset></form>'].join('\n');
  };
  const body = [...topics].map(([topic, qs]) => `${topic ? `<h2 class="topic t-title">${txt(topic)}</h2>\n` : ''}${qs.map(form).join('\n')}`).join('\n');
  return `<!doctype html>
<html lang="en" data-lavish-annotate="off"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="tb-nonce" content="${nonce}"><meta name="tb-round" content="${Number(r.n)}">
<title>${txt(t.title)}: round ${Number(r.n)}</title><style>${css}\n${CSS}</style></head>
<body class="app"><h1 class="t-large-title">${txt(t.title)}: questions, round ${Number(r.n)}</h1>
<p class="lede t-subheadline">Queue an answer for every question, then press Send to Agent. The board and <code>tb answer</code> work too.</p>
${body}
<script>${SCRIPT}</script></body></html>
`;
}

// D-0118 + SEC-2: the browser shows the page; tbd opens it, never lavish. TB_NOTIFY=0 (tests) shows nothing, as notify's
// banners do; a test preload may replace module.exports.opener.
const opener = (/** @type {string} */ url) => (process.env.TB_NOTIFY === '0' ? Promise.resolve({ err: null }) : sh('/usr/bin/open', [url], { timeout: CMD_MS }));

// Shows round r of a planning clarify: port check, the round's page (made once per round; again with a new nonce if its
// file is gone), lavish takes it, its url (lavish's own form only) opens in the browser, the poll loop starts. → {url}.
// Throws TbError 409 | 503 (no absolute path in the message: the alert and the log carry it, SEC-10).
async function show(/** @type {string} */ id, again = false) {
  const cfg = config();
  const t = store.getTicket(id);
  if (!planning.planningClarify(t)) throw new TbError(409, `${id}: no planning questions are open (state ${t.state})`);
  const r = await planning.currentRound(t);
  if (r?.kind !== 'questions' || !Array.isArray(r.questions)) throw new TbError(409, `${id}: no questions round to show`);
  if (!(await isFile(cli()))) {
    trip(`lavish is not installed in ${lavishDir()}`);
    throw new TbError(503, 'lavish is not installed: tb doctor; answer in the board or with tb answer');
  }
  if (!(await portOk(cfg.port))) {
    portTaken(cfg.port);
    throw new TbError(503, `lavish port ${cfg.port} is held by another process`);
  }
  let k = t;
  if (k.interview?.round !== r.n || !(await isFile(k.interview.html ?? ''))) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const dir = path.join(PAGES, round(id, r.n));
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const d of [PAGES, dir]) if (!(await fsp.lstat(d)).isDirectory()) throw new Error('an interview page dir is not a directory (a link?)'); // never written through
    const html = path.join(dir, 'page.html');
    await store.writeAtomic(html, page(t, r, nonce, await foundation()));
    k = await store.updateTicket(id, (x) => {
      if (!planning.planningClarify(x) || x.round !== t.round) throw new Moved();
      return { ...x, interview: { round: r.n, html, nonce_sha: sha(nonce), poll: null } };
    }).catch(async (e) => {
      await fsp.rm(dir, { recursive: true, force: true });
      throw e instanceof Moved ? new TbError(409, `${id}: it moved on meanwhile`) : e;
    });
  }
  const o = await lavish([k.interview.html, ...(again ? ['--reopen'] : [])], cfg);
  const url = o.err ? null : parse(o.stdout)?.session.url;
  if (typeof url !== 'string') {
    if (!live(id, r.n)) throw new TbError(409, `${id}: it moved on meanwhile`); // CR-12: no breaker count for that
    fail(`open: ${first(o)}`);
    throw new TbError(503, 'lavish did not open the page: answer in the board or with tb answer');
  }
  if (!new RegExp(`^http://localhost:${cfg.port}/session/[0-9a-f]{16}(\\?\\S*)?$`).test(url)) {
    alert({ title: 'Lavish page not opened', message: `${id}: lavish printed a page url of another form: answer in the board or with tb answer` });
    throw new TbError(503, 'lavish printed a page url tbd does not open: answer in the board or with tb answer');
  }
  void loop(id, r.n).catch(log(id));
  const op = await module.exports.opener(url);
  if (op.err) console.error(`tbd: ${id}: open ${url}: ${first(op)}`);
  return { url };
}

// The round opened (D-0118) or ended (F6). Registered on store `transition`, which fires inside the store queue: the
// work runs after it (setImmediate), never inside it.
function onTransition(/** @type {any} */ t, /** @type {string} */ prev) {
  if (t.state === 'clarify' && prev === 'planning') setImmediate(() => void start(t.id).catch(log(t.id)));
  else if (prev === 'clarify' && t.interview) setImmediate(() => void leave(t.id, t.interview).catch(log(t.id)));
}
async function start(/** @type {string} */ id) {
  if (!config().lavish || down || opening.has(id)) return; // breaker open: the board only, no alert
  opening.add(id);
  try {
    await show(id).catch((e) => { if (!(e instanceof TbError)) throw e; console.error(`tbd: ${id}: lavish: ${e.message}`); });
  } finally {
    opening.delete(id);
  }
}

async function leave(/** @type {string} */ id, /** @type {any} */ iv) {
  const c = polls.get(id);
  if (c) kill(c);
  warned.delete(`${id} ${iv.round}`);
  const cfg = config();
  if (typeof iv.html === 'string') {
    const o = await lavish(['end', iv.html], cfg);
    if (o.err) console.error(`tbd: ${id}: lavish end: ${first(o)}`);
    await fsp.rm(path.dirname(iv.html), { recursive: true, force: true });
  }
  await store.updateTicket(id, (k) => {
    if (k.state === 'clarify' || k.interview?.round !== iv.round) throw new Moved(); // a newer round holds it now
    const next = { ...k };
    delete next.interview;
    return next;
  }).catch((e) => { if (!(e instanceof Moved)) throw e; });
  if (!store.listTickets().some((k) => k.interview)) {
    const o = await lavish(['stop'], cfg);
    if (o.err) console.error(`tbd: lavish stop: ${first(o)}`);
  }
}

// tb lavish / the board's "Open in Lavish" (lane D's route; m9 m10): 409 unless a planning clarify, 503 when lavish is
// off or not installed, 409 while an open of this ticket runs. Writes the intervention row (verb lavish), resets the
// breaker (a probe), opens the round again (an ended session: --reopen) and polls every open round. → {url}.
async function reopen(/** @type {string} */ id, /** @type {string} */ actor) {
  const t = store.getTicket(id);
  if (!planning.planningClarify(t)) throw new TbError(409, `${id}: no planning questions are open (state ${t.state})`);
  if (!config().lavish) throw new TbError(503, 'lavish is off (config interview.lavish false): answer in the board or with tb answer');
  if (!(await isFile(cli()))) throw new TbError(503, 'lavish is not installed: tb doctor; answer in the board or with tb answer');
  if (opening.has(id)) throw new TbError(409, `${id}: the page is opening already`);
  opening.add(id);
  try {
    await store.intervention(id, { actor, verb: 'lavish' }, (k) => {
      if (!planning.planningClarify(k)) throw new TbError(409, `${id}: it moved on meanwhile (now ${k.state})`);
      return k;
    });
    failures = 0;
    down = false;
    const shown = await show(id, true);
    repoll(); // CR-6: the breaker stopped every round's loop
    return shown;
  } finally {
    opening.delete(id);
  }
}

// At boot (m17, N8; tbd awaits it before runs start): orphan polls of a dead tbd killed (pid + lstart); a leftover send
// (D-0119) of a round still open is applied as live (an ignored one gets its reply on the next poll), any other
// removed silently; an interview left on a ticket out of clarify is cleaned up; page dirs no ticket points to and tmp
// files removed; the open rounds polled again (NO_OPEN). Tickets in clarify without one: nothing until tb lavish.
async function boot({ alert: a = alert } = {}) {
  alert = a;
  const held = store.listTickets().filter((k) => k.interview);
  if (!(await killOrphans(held.map((k) => k.interview.poll).filter((p) => Number.isInteger(p?.pid) && p.lstart), procs))) {
    console.error('tbd: lavish: ps failed: a poll of the last tbd may still run');
  }
  const replies = new Map();
  for (const f of await fsp.readdir(OUTBOX).catch(() => [])) {
    try {
      const m = /^(t_[a-z0-9]{6})-r(\d{2,})\.feedback$/.exec(f);
      const text = m && live(m[1], Number(m[2])) ? await readPlain(path.join(OUTBOX, f), OUT_MAX) : null;
      if (text === null) await fsp.rm(path.join(OUTBOX, f), { force: true }); // another round's, a tmp file, unreadable
      else replies.set(m[1], REPLY[await apply(m[1], Number(m[2]), text)] ?? null);
    } catch (e) {
      console.error(`tbd: lavish: leftover send ${f}: ${e.message}`);
    }
  }
  for (const k of held.filter((x) => !planning.planningClarify(x))) await leave(k.id, k.interview).catch(log(k.id));
  const pages = new Set(store.listTickets().map((k) => k.interview?.html).filter((h) => typeof h === 'string'));
  for (const d of await fsp.readdir(PAGES).catch(() => [])) {
    try {
      const dir = path.join(PAGES, d);
      const keep = [...pages].some((h) => path.dirname(h) === dir);
      if (!keep) await fsp.rm(dir, { recursive: true, force: true });
      else for (const f of await fsp.readdir(dir)) if (f.endsWith('.tmp')) await fsp.rm(path.join(dir, f), { force: true });
    } catch (e) {
      console.error(`tbd: lavish: page dir ${d}: ${e.message}`);
    }
  }
  repoll(replies);
}

// tbd stops: no new poll starts, the live ones end (the next tbd polls again).
function stop() {
  stopping = true;
  for (const c of polls.values()) kill(c);
}

module.exports = { onTransition, reopen, boot, stop, parse, esc, jail, opener };
