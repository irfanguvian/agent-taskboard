// Taskboard UI: vanilla, no deps. Same-origin only: /api/* and one EventSource on /events.
// Auth is the HttpOnly tb_session cookie from `tb open` (fetch sends it same-origin); the page holds no token.
// D39: before any cookie goes out the page checks it talks to tbd (see "tbd identity"); the browser never auto-reconnects.
// Server strings reach the DOM only through textContent (el() text nodes), never as HTML.

const COLS = [['inbox', 'Inbox'], ['now', 'Now'], ['next', 'Next'], ['later', 'Later'], ['done', 'Done']];
const EMPTY = {
  inbox: 'Nothing to sort.', now: 'Nothing in Now. Pull one up from Next.',
  next: 'Nothing queued.', later: 'Nothing parked.', done: 'Nothing finished yet.',
};
const FLOW_COLS = [
  ['backlog', 'Backlog'], ['planning', 'Planning'], ['clarify', 'Clarify'], ['plan_approval', 'Plan Approval'],
  ['working', 'Working'], ['review', 'Review'], ['qa', 'QA'], ['final_gate', 'Final Gate'],
  ['done', 'Done'], ['blocked', 'Blocked'],
];
const YOU = new Set(['clarify', 'plan_approval', 'blocked']); // states that wait on Irfan
// board-terminal-parity Phase 2 task 4: a run's Approve card or auto mode's block waits on him too (ticket.waiting)
// manual / needs_scope: an unbuilt phase or a scope ask (notify.js pings them); close: squashed, waits for close or push
const ON_YOU = ['approve', 'blocked_action', 'manual', 'needs_scope', 'close'];
// approve right after Approve: tbd sets the branch up for minutes (waiting setup); nothing is on Irfan then
const settingUp = f => f.state === 'plan_approval' && f.waiting?.reason === 'setup';
// 2026-10-20 (Irfan: "finished, still on working"): a Task that waits for Irfan reads Your Turn, once the run's end is saved
const yourTurn = f => f.kind === 'task' && f.state === 'working' && f.waiting?.reason === 'you' && !!f.lease_exit;
const needsYou = f => !settingUp(f) && (YOU.has(f.state) || ON_YOU.includes(f.waiting?.reason) || yourTurn(f));
const AGENT = ['planning', 'working', 'review', 'qa', 'final_gate']; // phases with agent runs (fsm.AGENT)
const NOW_LIMIT = 3, DONE_SHOWN = 15, GB = 2 ** 30, MB = 2 ** 20, DASH = '—';

let state = null; // { reminders, flows, system, calendar } after first load
let es = null; // the one EventSource
let trusted = false; // tbd proved itself and the stream has not dropped since: only then do requests carry the cookie
let wait = 1000; // reconnect backoff, ms (max 30 s)
const ui = { drag: null, editing: null, tray: null, promote: null, pick: { kind: '', tag: '' }, dirty: false, tags: [], tagDefs: {}, tagsLoaded: false, locked: false,
  runs: new Map(), open: null, ticket: null, log: null, act: null, arm: null, // runs: id → `run` event; open: the drawer's flow id + its ticket, log tail, last action, Cancel / Approve armed
  round: null, plan: null, drafts: new Map(), busy: new Map(), err: null, // the open ticket's newest planning round and frozen plan, Clarify / Reject drafts (`${id}:${n}` → draft), planning action in flight (id → role), its refusal
  csrf: null, ask: null, gates: null, ivs: null, fb: null, pass: null, phase: new Map(), // P5: synchronizer token, the open working ask, gate / intervention pages + a feedback file (on demand), the pass check, Resume's phase pick (id → phase)
  q: '', hl: null, days: 30, follow: null, // M7: reminder search (lowercase), the Health view's data + its days, the drawer's log Follow
  fview: 'all', rfilter: null, tab: 'overview', day: null, // calm UI: Flows segment (all|you|running|done), Reminders filter from a Today highlight (overdue|today), inspector tab (overview|activity|reports), the date of the last render (midnight)
  cont: new Set(), // flows whose Continue in Terminal was clicked on this page: Terminal opens by itself once held (heldBox)
  cfg: null, cfgErr: null, notes: new Map(), // full-access-runs Phase 8 + 9: GET /api/config's answer + the last refused setting ({role, text}), note drafts (id → text)
  pres: new Map(), shown: new Map(), // board-terminal-parity 3: the drawer's kept <pre>s (data-role → {key, node, text}), see keptPre; when each plan round first showed (`${id}:${n}` → ms, approve)
  tc: null, // board-terminal-parity Phase 2 task 6: Settings → Terminal check ({busy, res, err, live, tags, tag, cost, armedAt})
  feed: null, raw: false, tech: false }; // board-terminal-parity Phase 3: the open ticket's Activity feed (see readFeed), Show Raw Log, Tech Details open

// board-terminal-parity 6.2: the New Flow and Promote kinds are the built ones tbd names (GET /api/state system.kinds)
const kinds = () => (Array.isArray(state?.system?.kinds) ? state.system.kinds : []);
// board-terminal-parity Phase 4: while Task tickets are on (system.kinds holds task), Code and Task say how they differ
const KIND_WORDS = Object.assign(Object.create(null), { code: 'Code — copy of the repo, checks, review', task: 'Task — your folder, like the terminal' });
const kindLabel = k => (kinds().includes('task') && KIND_WORDS[k]) || String(k).charAt(0).toUpperCase() + String(k).slice(1);
// Page Tools (Settings → Terminal): on, the page runs Check Setup, Clean Up, Add Tag and Open in Terminal itself
const pageTools = () => ui.cfg?.config?.terminal?.page_tools === true;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const day = v => { const d = new Date(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const today = () => day(Date.now());
const hhmm = v => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = v => (v ? `${day(v)} ${hhmm(v)}` : null); // one time format everywhere: local, 24 h
const byId = id => state.reminders.find(r => r.id === id);
const colOf = status => state.reminders.filter(r => r.status === status);

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...nodes(kids));
  return e;
}
// children as el() takes them: arrays flattened, null / undefined / false dropped (replaceChildren would print them as text)
const nodes = (...kids) => kids.flat(Infinity).filter(k => k != null && k !== false);
// Bidi controls and zero-width chars in agent text: stripped (run errors) or shown as [U+202E] (plan, questions,
// titles), never applied or hidden, so a file name or test_cmd reads the way it runs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // lib/runner.js's: a claude session id
const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const vis = s => String(s ?? '').replace(BIDI, c => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safe = fn => { try { return fn(); } catch { return undefined; /* storage blocked */ } };

// a segmented control (.seg of buttons): the one whose value matches is pressed
const press = (group, value) => { for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === value)); };

// Icons: lucide shapes (ISC licence, lucide.dev), 24 viewBox, as path data only (circles as two arcs). The page CSP
// allows no outside files, so they are drawn here with createElementNS; foundation .icon sets stroke 1.75.
const circ = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS = {
  today: [circ(12, 12, 4), 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41'],
  reminders: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8M13 12h8M13 18h8'],
  flows: ['M6 3v12', circ(18, 6, 3), circ(6, 18, 3), 'M18 9a9 9 0 0 1-9 9'],
  health: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  system: ['M20 7h-9M14 17H5', circ(17, 17, 3), circ(7, 7, 3)],
  settings: ['M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3', 'M14 2v4M8 10v4M16 18v4'], // lucide sliders-horizontal
  search: [circ(11, 11, 8), 'm21 21-4.3-4.3'],
  plus: ['M5 12h14M12 5v14'],
  close: ['M18 6 6 18M6 6l12 12'],
  more: [circ(12, 12, 1), circ(19, 12, 1), circ(5, 12, 1)],
  check: ['M20 6 9 17l-5-5'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  bell: ['M10.268 21a2 2 0 0 0 3.464 0', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'],
  clock: [circ(12, 12, 10), 'M12 6v6l4 2'],
  calendar: ['M8 2v4M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  alert: [circ(12, 12, 10), 'M12 8v4M12 16h.01'],
  done: [circ(12, 12, 10), 'm9 12 2 2 4-4'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
  grip: [circ(9, 12, 1), circ(9, 5, 1), circ(9, 19, 1), circ(15, 12, 1), circ(15, 5, 1), circ(15, 19, 1)],
};
const SVG = 'http://www.w3.org/2000/svg';
function icon(name, cls = '') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

// Status pills (DESIGN.md §8): a word on its hue's soft fill. The flow stage map is Irfan's (plan, round 1 Q6):
// waits on you butter, in progress lavender, blocked peach, done mint, new sky, cancelled gray.
const pill = (hue, ...text) => el('span', { class: `pill hue-${hue}` }, ...text);
const STAGE_HUE = Object.assign(Object.create(null), {
  backlog: 'sky', clarify: 'butter', plan_approval: 'butter', planning: 'lavender', working: 'lavender', review: 'lavender',
  qa: 'lavender', final_gate: 'lavender', blocked: 'peach', done: 'mint', cancelled: 'gray',
});
const stagePill = s => pill(STAGE_HUE[s] || 'gray', stateLabel(s));
// 2026-10-20 (Irfan: "a status change if you need me"): every wait on him reads in words, never a running-looking stage
const NEED_PILL = { clarify: ['butter', 'Questions'], plan_approval: ['butter', 'Approve Plan'] };
const WAIT_PILL = { approve: ['butter', 'Approve Action'], blocked_action: ['peach', 'Action Blocked'], manual: ['butter', 'Your Call'], needs_scope: ['butter', 'Your Call'], close: ['butter', 'Close or Push'] };
// a pill that already says what the flow waits on: the row skips its "waiting: …" line
const pilled = f => settingUp(f) || yourTurn(f) || !!WAIT_PILL[f.waiting?.reason];
const flowPill = (f, s = f.state) => {
  const g = { ...f, state: s };
  const x = settingUp(g) ? ['lavender', 'Setting Up'] : yourTurn(g) ? ['butter', 'Your Turn'] : WAIT_PILL[f.waiting?.reason]
    || (s === 'clarify' && f.clarify_class && f.clarify_class !== 'questions' ? ['butter', 'Your Call'] : NEED_PILL[s]); // a working ask (scope, protected, deps, policy) is a call, not questions
  return x ? pill(...x) : stagePill(s);
};

// ---------- theme: Auto follows the system (foundation.css light-dark()), Light / Dark pin it with data-theme ----------
const root = document.documentElement;
const THEMES = ['auto', 'light', 'dark'];
function setTheme(t) {
  if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
  press($('#theme'), t);
}
const savedTheme = safe(() => localStorage.getItem('tb-theme'));
setTheme(THEMES.includes(savedTheme) ? savedTheme : 'auto');
$('#theme').addEventListener('click', e => {
  const t = e.target.closest('button')?.value;
  if (!THEMES.includes(t)) return;
  setTheme(t);
  safe(() => localStorage.setItem('tb-theme', t));
});

// ---------- views: one per hash (#today #reminders #flows #health, #system below 1280px), so back / forward work ----------
const VIEWS = { today: 'Today', reminders: 'Reminders', flows: 'Flows', health: 'Health', settings: 'Settings', system: 'System' };
const COMPACT = matchMedia('(max-width: 1279px)'); // icon rail or tab bar: the sidebar's metrics live in the System view
const compact = () => COMPACT.matches;
COMPACT.addEventListener('change', e => { if (!e.matches && root.dataset.view === 'system') location.replace('#today'); }); // the full sidebar shows System: widening leaves it
const ADDS = new Set(['today', 'reminders', 'flows']); // views with the New button (and the N key)
function route() {
  if (ui.locked) return; // lockOut replaced the body: no views left to show
  const h = location.hash.slice(1);
  const v = Object.hasOwn(VIEWS, h) && (h !== 'system' || compact()) ? h : root.dataset.view || 'today'; // own keys only (#constructor is no view); any other hash (#main: skip link) keeps the view
  if (v === root.dataset.view) return;
  root.dataset.view = v;
  $('#viewTitle').textContent = VIEWS[v];
  document.title = `${VIEWS[v]} · Taskboard`;
  for (const s of document.querySelectorAll('main > .view')) s.hidden = s.dataset.view !== v;
  for (const a of document.querySelectorAll('a[data-view]')) a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false');
  root.scrollTop = 0;
  if (v === 'health') loadHealth(); // loads on open and on Refresh only: no timer
  if (v === 'settings') loadSettings(); // full-access-runs Phase 8: on open, and after each save
}
// the toolbar turns to material with a hairline once content scrolls under it (foundation .material falls back to solid)
document.addEventListener('scroll', () => $('#toolbar')?.classList.toggle('material', root.scrollTop > 0), { passive: true });

// ---------- api + toasts ----------
// 401 = no valid session cookie: swap the board for the same hint the server's locked page shows. Nothing runs after.
const LOCKED_TITLE = 'This browser is locked.'; // lib/http.js `locked` says the same
function lockOut(title = LOCKED_TITLE, hint = ['Run ', el('code', null, 'tb open'), ' in Terminal.']) {
  ui.locked = true;
  es?.close();
  document.title = 'Taskboard locked';
  document.body.replaceChildren(el('main', { class: 'locked' }, el('h1', null, title), el('p', null, ...hint)));
}

// kind 'info': a short confirmation as the one top capsule (2 s, a new one replaces the old; the title is its words).
// 'error' / 'warn': a closable card, since the server's reason is long (DESIGN.md deviation, plan defaults).
let capTimer = 0;
function toast(msg, { kind = 'error', title } = {}) {
  const box = $('#toasts');
  if (kind === 'info') {
    clearTimeout(capTimer);
    $('.toast-cap', box)?.remove();
    const cap = el('div', { class: 'toast-cap' }, icon('check'), title || msg, title && msg && el('span', { class: 'sr' }, ` ${msg}`));
    box.append(cap);
    capTimer = setTimeout(() => cap.remove(), 2000);
    return;
  }
  const t = el('div', { class: `toast ${kind}` }, el('i', { class: 'dot', 'aria-hidden': 'true' }),
    el('div', { class: 'toast-text' }, title && el('strong', null, title), el('p', null, msg)),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('close')));
  box.append(t);
  while (box.querySelectorAll('.toast').length > 3) $('.toast', box).remove();
  setTimeout(() => t.remove(), kind === 'error' ? 10000 : 7000);
}

// P5: every change sends the session's synchronizer token (X-TB-CSRF), read once per trusted connection.
const CLI_ONLY = 'CLI only: use tb'; // lib/http.js: a CLI-only route, or a Page Tools one while the switch is off
async function api(method, path, body, text = false) { // text: the reply as text (a doc), not JSON
  if (!trusted) throw Object.assign(new Error('tbd is not reachable.'), { status: 0 });
  if (method !== 'GET' && !ui.csrf) ui.csrf = (await api('GET', '/api/session/csrf')).csrf;
  const init = { method, headers: method === 'GET' ? {} : { 'X-TB-CSRF': ui.csrf } };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('tbd is not reachable.'), { status: 0 });
  }
  if (r.status === 401) {
    // board-terminal-parity: a Page Tools route while the switch is off answers 401 "CLI only": the session is fine, so
    // no lock-out; the page hides those buttons from now on. Any other 401: the page is gone, callers never resume.
    const j = await r.json().catch(() => ({}));
    if (j.error !== CLI_ONLY) { lockOut(); return new Promise(() => {}); }
    if (ui.cfg?.config?.terminal) ui.cfg.config.terminal.page_tools = false;
    throw Object.assign(new Error('Page Tools is off in Settings, so this runs in Terminal now.'), { status: 401, cliOnly: true, server: true });
  }
  if (text && r.ok) return r.text();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status}).`), { status: r.status, server: typeof j.error === 'string' && j.error !== '' });
  for (const w of j.warnings || []) toast(w, { kind: 'warn', title: 'Heads Up' });
  return j;
}

// ---------- load + live updates ----------
let loadSeq = 0;
async function load() {
  if (saving.n || ui.locked || !trusted) return; // the save chain reloads once it drains; reconnect() reloads
  const mine = ++loadSeq;
  try {
    const r = await fetch('/api/state');
    if (r.status === 401) return lockOut();
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (mine !== loadSeq) return; // a newer load is in flight
    state = { reminders: j.reminders || [], flows: j.flows || [], system: j.system || {}, calendar: j.calendar || {} };
    if (ui.drag || ui.editing) ui.dirty = true; else render();
    reloadOpen(); // whatever changed (an event, a reconnect after missed ones), the open drawer reads its ticket again
  } catch {
    if ($('#live').dataset.live === 'on') toast('Could not load the board.', { title: 'Load Failed' });
  }
}
const refresh = debounce(load, 150);

function setLive(on) {
  const p = $('#live');
  p.dataset.live = on ? 'on' : 'off';
  $('span', p).textContent = on ? 'Live' : 'Disconnected, retrying';
  $('.sys-link')?.setAttribute('aria-label', on ? 'System and Appearance' : 'System and Appearance, disconnected'); // its red dot, in words (never color alone)
}

// ---------- tbd identity (D39) ----------
// During a tbd restart anything may bind the port, and an EventSource auto-reconnect would hand it the cookie. So on
// any stream error the page closes the stream and asks GET /api/ui-whoami?n=<nonce> WITHOUT cookies; only the answer
// HMAC-SHA256(ui_key, n) lets it refetch and reopen. ui_key comes once in the unlock URL fragment (#k=, never sent to
// a server) and stays in localStorage. Residual: a page opened (top-level) during a restart gap still sends the cookie.
const KEY_RE = /^[0-9a-f]{64}$/;
const fragKey = /^#k=([0-9a-f]{64})$/.exec(location.hash)?.[1];
if (location.hash.startsWith('#k=')) history.replaceState(null, '', location.pathname + location.search);
if (fragKey) safe(() => localStorage.setItem('tb-ui-key', fragKey));
const storedKey = safe(() => localStorage.getItem('tb-ui-key'));
const uiKey = fragKey || (KEY_RE.test(storedKey || '') ? storedKey : null);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// true = tbd; false = something else answers; null = nobody answers yet (down, or 503 starting): ask again later
async function isTbd() {
  const n = hex(crypto.getRandomValues(new Uint8Array(16)));
  let r;
  try { r = await fetch(`/api/ui-whoami?n=${n}`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) }); } catch { return null; }
  if (r.status === 503) return null;
  const mac = r.ok ? (await r.json().catch(() => ({}))).mac : null;
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(uiKey.match(/../g).map(h => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return mac === hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(n)));
  } catch { return false; } // no WebCrypto (not a secure context): cannot prove it, so fail closed
}

function retry() {
  setTimeout(reconnect, wait);
  wait = Math.min(wait * 2, 30000);
}

async function reconnect() {
  if (ui.locked) return;
  const ok = await isTbd();
  if (ok === null) return retry();
  if (!ok) {
    return lockOut('This is not your taskboard (identity check failed).',
      ['Something else answers on this port, and this page stopped before sending it your session. When tbd is back, run ', el('code', null, 'tb open'), ' in Terminal.']);
  }
  trusted = true;
  ui.csrf = null; // read again: tbd may have a new session since
  ui.runs.clear(); // the stream opens with every current run
  await load(); // events may have been missed while down
  if (!ui.locked) connect();
  if (root.dataset.view === 'health') loadHealth(); // opened by hash before the page was trusted
  if (root.dataset.view === 'settings') loadSettings(); // the same for Settings (full-access-runs Phase 8)
}

function connect() {
  es = new EventSource('/events');
  es.onopen = () => { wait = 1000; setLive(true); };
  es.onerror = () => { // never let the browser reconnect by itself (D39)
    es.close();
    trusted = false;
    setLive(false);
    retry();
  };
  es.addEventListener('reminder', refresh);
  es.addEventListener('ticket', refresh); // load() then re-reads the open drawer too
  es.addEventListener('run', onRun);
  es.addEventListener('gate', onGate); // P5: {id, task, check, ok}: the open drawer reads its gates again
  es.addEventListener('system', e => {
    try { state.system = JSON.parse(e.data); renderHeader(); } catch { /* ignore malformed frame */ }
  });
}

// ---------- header ----------
// Contract: ram_*, disk_free, claude_rss are integer bytes; pressure is normal|warn|critical; net is boolean.
const PRESSURE = { normal: 'ok', warn: 'warn', critical: 'crit' };
const WORD = { warn: 'high', crit: 'critical' };
const PAUSE = { usage: 'Usage limit reached.', memory: 'Memory pressure.', you: 'Paused by you.' };
const fmtBytes = b => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

function metric(id, text, level, word = WORD[level]) {
  const m = $(`#${id}`);
  m.dataset.level = text == null ? 'na' : level || '';
  $('.v', m).textContent = text == null ? DASH : text + (word ? ` (${word})` : '');
}

function renderHeader() {
  const s = state.system || {};
  const mem = s.ram_used != null && s.ram_total != null ? `${(s.ram_used / GB).toFixed(1)} / ${(s.ram_total / GB).toFixed(1)} GB` : null;
  metric('m-ram', mem, PRESSURE[s.pressure] || (mem ? 'unknown' : null));
  const free = s.disk_free == null ? null : s.disk_free / GB;
  metric('m-disk', free == null ? null : `${free.toFixed(1)} GB`, free == null ? null : free < 8 ? 'crit' : free < 15 ? 'warn' : 'ok');
  metric('m-runs', s.runs != null ? `${s.runs} / ${s.max ?? DASH}` : null);
  metric('m-rss', s.claude_rss == null ? null : fmtBytes(s.claude_rss));
  metric('m-net', s.net == null ? null : s.net ? 'online' : 'offline', s.net == null ? null : s.net ? 'ok' : 'crit', '');

  $('#usage').hidden = !s.usage_warning;
  const p = $('#paused');
  p.hidden = !s.paused_until;
  if (s.paused_until) {
    const d = new Date(s.paused_until);
    const until = d.toDateString() === new Date().toDateString() ? hhmm(d) : when(d);
    p.textContent = `Agent runs are paused until ${until}.${PAUSE[s.paused_reason] ? ` ${PAUSE[s.paused_reason]}` : ''}`;
  }
}

// ---------- Today: a summary (DESIGN.md §10). Do This Now (the top of Now) + Calendar, three highlights, Next Up ----------
function dueInfo(due) {
  const [y, m, d] = due.split('-').map(Number);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(y, m - 1, d) - midnight) / 864e5);
  if (n < 0) return { hue: 'rose', text: `Overdue ${-n} ${n === -1 ? 'Day' : 'Days'}` };
  if (n === 0) return { hue: 'butter', text: 'Due Today' };
  if (n === 1) return { text: 'Due Tomorrow' };
  return { text: `Due ${new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}` };
}

// due first (overdue a rose pill, due today a butter one, later plain text), then project and #tag, joined by a dot in CSS
function chips(t) {
  const out = [];
  if (t.due && t.status !== 'done') {
    const d = dueInfo(t.due);
    out.push(el('span', { class: d.hue ? `pill hue-${d.hue}` : 'mt', title: t.due }, d.text));
  }
  if (t.project) out.push(el('span', { class: 'mt' }, t.project));
  if (t.tag) out.push(el('span', { class: 'mt' }, `#${t.tag}`));
  return out;
}
const metaOf = t => { const m = chips(t); return m.length ? el('div', { class: 'meta' }, m) : null; };

// the Reminders filters a Today highlight applies (ui.rfilter); a done reminder is never late or due
const isLate = t => t.status !== 'done' && !!t.due && t.due < today();
const isDue = t => t.status !== 'done' && t.due === today();
const RFILTER = { overdue: ['Overdue', isLate], today: ['Due Today', isDue] };
function filterReminders(f) {
  ui.rfilter = f;
  ui.tray = ui.promote = null;
  renderReminders();
  location.hash = '#reminders';
}

// a reminder row: round check (done), title, meta; Next Up uses it as is, the Reminders columns add drag and ⋯
const rcheck = (t, done = false) => el('input', {
  type: 'checkbox', name: 'check', class: 'rcheck', checked: done, 'data-role': 'check', 'aria-label': `${done ? 'Reopen' : 'Mark done'}: ${t.title}`,
  onchange: ev => move(t.id, ev.target.checked ? 'done' : 'next', 0),
});

function renderToday() {
  $('#viewSub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const now = colOf('now'), top = now[0];
  // a re-render replaces the controls: focus goes to the same place (the next Mark Done, the next row's check, the same
  // highlight card or Open Reminders by data-role)
  const a = document.activeElement, inHero = !!a?.closest?.('#hero'), at = [...document.querySelectorAll('#nextUp .rcheck')].indexOf(a);
  const role = a?.closest?.('#highlights, #nextUp') && a.dataset.role;
  $('#hero').replaceChildren(...nodes(
    el('h2', { id: 'focus-h', class: 'eyebrow' }, 'Do This Now'),
    el('p', { class: 't-title hero-title' }, top ? top.title : 'Nothing in Now.'),
    top ? metaOf(top) : el('p', { class: 'hero-note' }, 'Pull one up from Next.'),
    top?.note && el('p', { class: 'hero-note' }, top.note),
    el('div', { class: 'hero-acts' }, top
      ? el('button', { type: 'button', class: 'btn', 'data-role': 'focus-done', onclick: () => move(top.id, 'done', 0) }, 'Mark Done')
      : el('a', { class: 'btn btn-gray', href: '#reminders' }, 'Open Reminders'))));

  const you = state.flows.filter(needsYou).length;
  const late = state.reminders.filter(isLate).length, due = state.reminders.filter(isDue).length;
  const unit = n => (n === 1 ? 'reminder' : 'reminders');
  const card = (hue, ic, label, period, n, u, go) => el('button', { type: 'button', class: `card hl-card hue-${hue}`, 'data-role': `hl-${ic}`, onclick: go },
    el('span', { class: 'hl-top' }, icon(ic), label, el('span', { class: 'hl-period' }, period)),
    el('span', { class: 'metric-2' }, String(n), el('span', { class: 'unit' }, u)));
  $('#highlights').replaceChildren(
    card('butter', 'bell', 'Needs You', 'Flows', you, 'waiting', () => { ui.fview = 'you'; renderFlows(); location.hash = '#flows'; }),
    card('rose', 'clock', 'Overdue', 'Reminders', late, unit(late), () => filterReminders('overdue')),
    card('sky', 'calendar', 'Due Today', 'Reminders', due, unit(due), () => filterReminders('today')));

  const next = [...now.slice(1), ...colOf('next')].slice(0, 5);
  $('#nextUp').replaceChildren(
    el('div', { class: 'card-head' }, el('h2', { id: 'next-h', class: 'card-title' }, 'Next Up'), el('a', { class: 'btn btn-plain btn-sm', href: '#reminders', 'data-role': 'next-open' }, 'Open Reminders')),
    next.length
      ? el('ul', null, ...next.map(t => el('li', { class: 'rrow' }, rcheck(t), el('div', { class: 'rbody' }, el('span', { class: 'rtitle' }, t.title), metaOf(t)))))
      : el('p', { class: 'empty' }, EMPTY.next));
  if (inHero) $('#hero .hero-acts > *')?.focus();
  else if (at >= 0) (document.querySelectorAll('#nextUp .rcheck')[at] || $('#nextUp .card-head a'))?.focus();
  else if (role) $(`:is(#highlights, #nextUp) [data-role="${CSS.escape(role)}"]`)?.focus();
  renderSched();
}

function renderSched() {
  const s = $('#sched'), c = state?.calendar || {};
  const line = text => s.append(el('p', { class: 'hint' }, text));
  const hint = 'Ask Claude to “sync calendar”.';
  s.replaceChildren(el('div', { class: 'card-head' }, el('h2', { id: 'cal-h', class: 'card-title' }, 'Calendar')));
  if (!c.updated) return line(`Not synced yet. ${hint}`);
  const upd = new Date(c.updated), now = new Date();
  if (upd.toDateString() !== now.toDateString()) return line(`Last synced ${upd.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}. ${hint}`);
  const left = (c.events || []).filter(e => !e.allDay && new Date(e.end) > now && new Date(e.start).toDateString() === now.toDateString());
  if (!left.length) return line(`No more meetings today. Synced ${hhmm(c.updated)}.`);
  s.append(el('ul', { class: 'cal-list' }, ...left.map((e, i) => {
    const mins = Math.round((new Date(e.start) - now) / 60000);
    const soon = i === 0 && mins > 0 && mins <= 120 ? `in ${mins} min` : i === 0 && mins <= 0 ? 'now' : '';
    return el('li', { class: 'cal-row' }, el('time', null, hhmm(e.start)), el('span', { class: 'cal-ev' }, e.title), soon && el('span', { class: 'cal-soon' }, soon));
  })));
  line(`Synced ${hhmm(c.updated)}.`);
}

// ---------- reminders board ----------
function rememberFocus() {
  const a = document.activeElement, s = a?.closest?.('.strip');
  if (!$('#board').contains(a)) return null;
  return s ? { id: s.dataset.id, role: a.dataset.role === 'edit' ? 'menu' : a.dataset.role } : a.dataset.role ? { role: a.dataset.role } : null; // a row's control, or the empty state's button
}
function restoreFocus(f) {
  if (f) $(f.id ? `.strip[data-id="${CSS.escape(f.id)}"] [data-role="${f.role || 'menu'}"]` : `#board [data-role="${f.role}"]`)?.focus();
}

// search: case-insensitive substring over title, note, project and id, in every column; a search lifts the Done cap.
// A Today highlight's filter (ui.rfilter) narrows the same way, and both combine.
const filtered = () => !!(ui.q || ui.rfilter); // a filtered list has no true drop index: no drag, no Move Up / Down
const hit = t => (!ui.q || [t.title, t.note, t.project, t.id].some(v => v && String(v).toLowerCase().includes(ui.q))) && (!ui.rfilter || RFILTER[ui.rfilter][1](t));

function renderReminders() {
  const f = rememberFocus();
  const cols = COLS.filter(([key]) => !filtered() || colOf(key).some(hit));
  // nothing matches (§8 empty state): one Gray button clears the search (or, with none typed, the Today filter)
  const clear = () => { if (ui.q) { ui.q = ''; $('#q').value = ''; } else ui.rfilter = null; renderReminders(); $('#q').focus(); };
  $('#board').replaceChildren(...(cols.length ? cols.map(([key, label]) => bay(key, label))
    : [el('div', { class: 'empty-state board-empty', role: 'status' }, icon('search'), el('p', { class: 'empty-title' }, 'No Matches'),
      el('p', null, ui.q ? 'Try another word, or clear the search.' : 'Nothing here matches this filter.'),
      el('button', { type: 'button', class: 'btn btn-gray', 'data-role': 'clear-search', onclick: clear }, ui.q ? 'Clear Search' : 'Clear Filter'))]));
  renderFilters();
  const ed = $('.strip input.edit');
  if (ed) { ed.focus(); ed.select(); } else restoreFocus(f);
}

// the applied Today filter: a chip with its count (× clears it), and Clear All for the filter and the search
function renderFilters() {
  const box = $('#rfilters'), f = state && RFILTER[ui.rfilter], role = box.contains(document.activeElement) && document.activeElement.dataset.role; // a rebuild keeps focus on the chip or Clear All
  if (!f) return box.replaceChildren();
  const n = state.reminders.filter(f[1]).length;
  const clear = all => { ui.rfilter = null; if (all) { ui.q = ''; $('#q').value = ''; } renderReminders(); $('#q').focus(); };
  box.replaceChildren(
    el('button', { type: 'button', class: 'filter-chip', 'aria-pressed': 'true', 'data-role': 'rfilter', 'aria-label': `${f[0]}, ${n}. Clear this filter.`, onclick: () => clear(false) },
      `${f[0]} · ${n}`, icon('close')),
    el('button', { type: 'button', class: 'btn btn-plain btn-sm', 'data-role': 'rfilter-clear', onclick: () => clear(true) }, 'Clear All'));
  if (role) $(`#rfilters [data-role="${CSS.escape(role)}"]`)?.focus();
}

function bay(key, label) {
  const all = colOf(key), items = all.filter(hit), cut = filtered();
  const shown = key === 'done' && !cut ? items.slice(0, DONE_SHOWN) : items;
  const over = key === 'now' && !cut && all.length > NOW_LIMIT;
  const count = key === 'now' && !cut ? `${all.length} / ${NOW_LIMIT}` : String(items.length); // a search counts matches in every column
  const list = el('ul', { class: 'list', 'aria-labelledby': `bh-${key}` },
    ...shown.map((t, i) => strip(t, i, items.length, key === 'now' && i === 0 && !cut)),
    !shown.length && el('li', { class: 'empty' }, EMPTY[key]),
    items.length > shown.length && el('li', { class: 'empty' }, `${items.length - shown.length} older not shown`));
  // the heading takes focus (tabindex -1) once a Delete empties the column
  const b = el('section', { class: `card card-flush bay${over ? ' over' : ''}`, 'data-col': key },
    el('div', { class: 'bay-head' }, el('h3', { id: `bh-${key}`, tabindex: '-1' }, label, el('span', { class: 'count' }, count), over && pill('rose', 'Over Limit'))), list);
  b.addEventListener('dragover', e => dragOver(e, b, list, key));
  b.addEventListener('dragleave', e => { if (!b.contains(e.relatedTarget)) clearDrop(); });
  b.addEventListener('drop', e => drop(e, list, key));
  return b;
}

function strip(t, i, total, isTop) {
  const done = t.status === 'done';
  const editing = ui.editing === t.id;
  const open = ui.tray === t.id;
  const s = el('li', { class: `rrow strip${done ? ' done' : ''}`, draggable: !editing && !filtered(), 'data-id': t.id });
  s.addEventListener('dragstart', e => {
    ui.drag = t.id;
    s.classList.add('lift'); // the drag image is taken from this frame: the row floats; then its place dims
    setTimeout(() => { s.classList.remove('lift'); s.classList.add('dragging'); });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
  });
  s.addEventListener('dragend', endDrag);

  const title = editing
    ? editInput(t)
    : el('span', { class: 'rtitle', title: 'Double-click to edit', ondblclick: () => startEdit(t.id) }, t.title);
  s.append(
    icon('grip', 'grip'),
    rcheck(t, done),
    el('div', { class: 'rbody' }, isTop && el('span', { class: 'now-mark' }, 'Do This Now'), title, editing ? null : metaOf(t), t.note && !editing ? el('span', { class: 'note' }, t.note) : null),
    el('button', {
      type: 'button', class: 'icon-btn menu', 'data-role': 'menu', 'aria-expanded': String(open), 'aria-label': `Actions for ${t.title}`,
      onclick: () => { ui.tray = open ? null : t.id; renderReminders(); },
    }, icon('more')),
    ...(open ? [tray(t, i, total)] : []));
  return s;
}

const closeTray = () => { ui.tray = ui.promote = null; renderReminders(); };

// the ⋯ menu: a popover under its button (foundation .popmenu); Escape (focus on ⋯ or in the menu) or a click outside
// closes it (boot)
function tray(t, i, total) {
  const item = (label, fn, extra, keys) => el('button', { type: 'button', class: 'popmenu-item', onclick: fn, ...extra },
    label, keys && el('span', { class: 'trail', 'aria-hidden': 'true' }, keys));
  const del = item('Delete', () => {
    if (!del.classList.contains('armed')) { // two clicks: the first arms it for 4 s
      del.classList.add('armed');
      del.textContent = 'Confirm Delete';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete'; }, 4000);
    } else remove(t.id);
  }, { 'data-role': 'del', class: 'popmenu-item danger' });
  return el('div', { class: 'popmenu tray', role: 'group', 'aria-label': `Actions for ${t.title}` },
    detailLine(t),
    el('div', { class: 'popmenu-sep' }),
    item('Edit', () => startEdit(t.id), { 'aria-keyshortcuts': 'E' }, 'E'),
    item('Move Up', () => move(t.id, t.status, i - 1), { disabled: i === 0 || filtered(), 'aria-keyshortcuts': 'Alt+ArrowUp' }, '⌥↑'),
    item('Move Down', () => move(t.id, t.status, i + 1), { disabled: i >= total - 1 || filtered(), 'aria-keyshortcuts': 'Alt+ArrowDown' }, '⌥↓'),
    el('label', { class: 'popmenu-item' }, 'Move To',
      el('select', { name: 'move-to', class: 'input mini', onchange: ev => move(t.id, ev.target.value, 0) },
        ...COLS.map(([k, l]) => el('option', { value: k, selected: k === t.status }, l)))),
    item('Promote…', () => {
      ui.promote = ui.promote === t.id ? null : t.id;
      loadTags();
      renderReminders();
      $('[data-role="promote-kind"]')?.focus();
    }, { 'data-role': 'promote', 'aria-expanded': String(ui.promote === t.id) }),
    ui.promote === t.id && promoteForm(t),
    el('div', { class: 'popmenu-sep' }),
    del);
}

// D-0156: id, created and (done only) the done date, as plain text
const detailLine = t => el('p', { class: 'detail', 'data-role': 'detail' },
  [`Id ${t.id}`, t.created && `Created ${t.created}`, t.status === 'done' && t.done_at && `Done ${t.done_at}`].filter(Boolean).join(' · '));

function promoteForm(t) {
  const pick = (name, opts) => el('label', null, name,
    el('select', { name: `promote-${name.toLowerCase()}`, class: 'input mini', 'data-role': `promote-${name.toLowerCase()}`, onchange: ev => { ui.pick[name.toLowerCase()] = ev.target.value; } }, ...opts));
  if (!kinds().includes(ui.pick.kind)) ui.pick.kind = kinds()[0] ?? ''; // the shown first option is the one sent
  return el('form', { class: 'promote', 'aria-label': 'Promote to flow', onsubmit: ev => { ev.preventDefault(); promote(t); } },
    pick('Kind', kinds().map(k => el('option', { value: k, selected: k === ui.pick.kind }, kindLabel(k)))),
    pick('Tag', tagOptions(ui.pick.tag)),
    el('div', { class: 'promote-acts' },
      el('button', { type: 'submit', class: 'btn btn-sm' }, 'Promote to Flow'),
      el('button', { type: 'button', class: 'btn btn-sm btn-gray', onclick: () => { ui.promote = null; renderReminders(); } }, 'Cancel')));
}

async function promote(t) {
  try {
    await api('POST', `/api/tickets/${encodeURIComponent(t.id)}/promote`, { kind: ui.pick.kind, tag: ui.pick.tag || undefined });
    state.reminders = state.reminders.filter(r => r.id !== t.id);
    ui.tray = ui.promote = null;
    render();
    refresh();
    toast(`“${t.title}” is now a ${ui.pick.kind} flow.`, { kind: 'info', title: 'Promoted' });
  } catch (e) { toast(e.message, { title: refused(e, 'Couldn’t Promote') }); }
}

// ---------- reminder changes (optimistic, then server) ----------
function applyMove(id, status, index) {
  const i = state.reminders.findIndex(r => r.id === id);
  const [t] = state.reminders.splice(i, 1);
  if (status === 'done') t.done_at = today(); else if (t.status === 'done') delete t.done_at;
  t.status = status;
  const col = colOf(status), before = col[index];
  const at = before ? state.reminders.indexOf(before) : col.length ? state.reminders.indexOf(col.at(-1)) + 1 : state.reminders.length;
  state.reminders.splice(at, 0, t);
}

// One PATCH at a time, in click order (CR9). body() runs at send time, so pos comes from the latest local
// state; load() waits while saves are queued, so that state is never swapped for a stale server copy mid-chain.
const saving = { chain: Promise.resolve(), n: 0 };
function patch(id, body) {
  saving.n++;
  saving.chain = saving.chain.then(async () => {
    const b = body();
    try { if (b) await api('PATCH', `/api/reminders/${encodeURIComponent(id)}`, b); }
    catch (e) { toast(e.message, { title: 'Couldn’t Save Change' }); }
    if (--saving.n === 0) load();
  });
}
const placeOf = id => () => { const t = byId(id); return t && { status: t.status, pos: colOf(t.status).indexOf(t) + 1 }; };

// index = 0-based position in the target column once the card is out of it; server pos is 1-based
function move(id, status, index) {
  const t = byId(id);
  const last = colOf(status).length - (t?.status === status ? 1 : 0); // last valid index
  if (!t || index < 0 || index > last || (t.status === status && colOf(status).indexOf(t) === index)) return;
  applyMove(id, status, index);
  render();
  patch(id, placeOf(id));
}

async function remove(id) {
  const t = byId(id), col = t ? colOf(t.status).filter(hit) : [], at = col.indexOf(t), near = col[at + 1] || col[at - 1];
  state.reminders = state.reminders.filter(r => r.id !== id);
  ui.tray = null;
  render();
  // focus never drops to <body>: the next row's ⋯ in the column, else the row before, else the column heading, else search
  ((near && $(`.strip[data-id="${CSS.escape(near.id)}"] [data-role="menu"]`)) || (t && $(`#bh-${CSS.escape(t.status)}`)) || $('#q'))?.focus();
  try { await api('DELETE', `/api/reminders/${encodeURIComponent(id)}`); }
  catch (e) { toast(e.message, { title: 'Couldn’t Delete' }); load(); }
}

function startEdit(id) { ui.editing = id; ui.tray = null; loadTags(); renderReminders(); }

// The edit form: the title input is as it was (Enter saves, Escape cancels, leaving the form saves); project, due, note
// and tag join it. Only fields that changed go in the PATCH; an emptied one is null (cleared). D-0149.
const TAG_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9-]+)*$/; // lib/tags.js NAME_RE (the first character is never -: a name must not read as a flag); the server checks it again
function editInput(t) {
  const title = el('input', { type: 'text', name: 'edit', class: 'input edit', 'data-role': 'edit', 'aria-label': 'Edit title', maxLength: 200, value: t.title });
  title.value = t.title;
  const names = [...new Set([...ui.tags, ...Object.keys(ui.tagDefs)])].sort();
  const field = (label, ctl) => el('label', { class: 'ef' }, el('span', null, label), ctl);
  const project = el('input', { type: 'text', name: 'project', class: 'input', maxLength: 200, autocomplete: 'off' });
  const due = el('input', { type: 'date', name: 'due', class: 'input' });
  const tag = el('input', { type: 'text', name: 'tag', class: 'input', list: 'tag-names', maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
  const note = el('textarea', { name: 'note', class: 'input', rows: 2, maxLength: 10000 });
  project.value = t.project ?? ''; due.value = t.due ?? ''; tag.value = t.tag ?? ''; note.value = t.note ?? '';
  let finished = false;
  const finish = save => {
    if (finished) return;
    const v = title.value.trim(), body = {};
    if (save) {
      if (v && v !== t.title) body.title = v;
      for (const [k, c] of [['project', project], ['due', due], ['tag', tag], ['note', note]]) {
        const nv = k === 'note' ? c.value : c.value.trim();
        if (nv !== (t[k] ?? '') && !(k === 'tag' && nv && !TAG_RE.test(nv))) body[k] = nv || null; // a malformed tag is left out
      }
    }
    finished = true;
    ui.editing = null;
    if (Object.keys(body).length) {
      for (const [k, nv] of Object.entries(body)) { if (nv == null) delete t[k]; else t[k] = nv; }
      patch(t.id, () => body);
    }
    render();
  };
  const form = el('form', { class: 'editform', 'aria-label': 'Edit reminder',
    onsubmit: e => {
      e.preventDefault();
      if (!tag.value.trim() || TAG_RE.test(tag.value.trim())) return finish(true);
      tag.setCustomValidity('Lowercase letters, digits and -; a/b for a child.'); // stay in the form until it is fixed
      tag.reportValidity();
    } },
    title,
    field('Project', project), field('Due', due), field('Tag', tag), field('Note', note),
    el('datalist', { id: 'tag-names' }, ...names.map(n => el('option', { value: n }))),
    el('div', { class: 'ef-acts' },
      el('button', { type: 'submit', class: 'btn btn-sm', onmousedown: e => e.preventDefault() }, 'Save'),
      el('button', { type: 'button', class: 'btn btn-sm btn-gray', onmousedown: e => e.preventDefault(), onclick: () => finish(false) }, 'Cancel')));
  tag.addEventListener('input', () => tag.setCustomValidity(''));
  form.addEventListener('keydown', e => {
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  form.addEventListener('focusout', e => { if (!form.contains(e.relatedTarget)) finish(true); }); // leaving the whole form saves, as leaving the title did
  return form;
}

// ---------- drag and drop ----------
function dropIndex(list, y) {
  const strips = [...list.querySelectorAll('.strip:not(.dragging)')];
  const i = strips.findIndex(s => { const r = s.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return { strips, index: i < 0 ? strips.length : i };
}
function clearDrop() {
  document.querySelectorAll('.drop-ph').forEach(p => p.remove());
  document.querySelectorAll('.bay.drop').forEach(b => b.classList.remove('drop'));
}
function dragOver(e, bayEl, list) {
  if (!ui.drag) return;
  e.preventDefault();
  const { strips, index } = dropIndex(list, e.clientY);
  clearDrop();
  bayEl.classList.add('drop');
  list.insertBefore(el('li', { class: 'drop-ph', 'aria-hidden': 'true' }), strips[index] || null);
}
function drop(e, list, status) {
  e.preventDefault();
  const id = ui.drag || e.dataTransfer.getData('text/plain');
  const { index } = dropIndex(list, e.clientY);
  clearDrop();
  ui.drag = null;
  move(id, status, index);
}
function endDrag() {
  ui.drag = null;
  clearDrop();
  document.querySelectorAll('.strip:is(.dragging, .lift)').forEach(s => s.classList.remove('dragging', 'lift'));
  if (ui.dirty) render();
}

// ---------- keyboard: alt+arrows move, e edits, arrows walk the column ----------
$('#board').addEventListener('keydown', e => {
  const s = e.target.closest('.strip');
  if (!s || e.target.matches('input:not([type="checkbox"]), textarea, select')) return;
  const t = byId(s.dataset.id);
  if (!t) return;
  const ci = COLS.findIndex(c => c[0] === t.status), i = colOf(t.status).indexOf(t);
  const colMove = d => COLS[ci + d] && move(t.id, COLS[ci + d][0], 0);
  const moves = { ArrowUp: () => move(t.id, t.status, i - 1), ArrowDown: () => move(t.id, t.status, i + 1), ArrowLeft: () => colMove(-1), ArrowRight: () => colMove(1) };
  if (e.altKey && moves[e.key] && !filtered()) { e.preventDefault(); moves[e.key](); }
  else if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'e' || e.key === 'F2')) { e.preventDefault(); startEdit(t.id); }
  else if (!e.altKey && e.target.dataset.role === 'check' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const checks = [...s.parentNode.querySelectorAll('[data-role="check"]')];
    const next = checks[checks.indexOf(e.target) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) { e.preventDefault(); next.focus(); }
  }
});

// ---------- flows ----------
// a duration as 40s / 12m / 3h / 2d; span: the time since v
const dur = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const span = v => dur(Date.now() - new Date(v));
const ago = v => `${span(v)} ago`;

// Spec §8 liveness: a status dot and a word (mint: working, butter: held or quiet, rose: stuck or gone).
const LIVE = {
  thinking: ['ok', 'Thinking'], tool: ['ok', 'Tool'], waiting: ['wait', 'Waiting'], quiet: ['wait', 'Quiet'],
  stalled: ['bad', 'Stalled'], offline: ['bad', 'Offline'], paused: ['wait', 'Paused'], interrupted: ['bad', 'Interrupted'],
};
const liveTag = r => {
  const [tone, word] = LIVE[r.liveness] || ['', String(r.liveness)];
  return el('span', { class: `status lv ${tone}` },
    r.liveness === 'tool' && r.tool ? [r.tool, r.tool_at && el('span', { 'data-since': r.tool_at }, span(r.tool_at))] : word);
};

// The Run cell (`run` event): liveness, then elapsed, agents and RSS while live, the last activity once not. Times tick
// in place (ticker).
function runStats(r) {
  const n = r.subagents_alive ?? 0;
  const meta = r.live ? [el('span', { 'data-since': r.started_at }, span(r.started_at)), ` elapsed · ${n} ${n === 1 ? 'agent' : 'agents'} · ${r.rss_mb ?? 0} MB`]
    : r.last_event_at ? ['Last activity ', el('span', { 'data-ago': r.last_event_at }, ago(r.last_event_at))] : [];
  return el('span', { class: 'fstats' }, liveTag(r), meta.length > 0 && el('span', { class: 'run-meta' }, ...meta));
}
// a status word with its dot, for runs of text: tone ok mint, wait butter, bad rose, '' gray (foundation .status)
const dot = (tone, ...text) => el('span', { class: `status${tone ? ` ${tone}` : ''}` }, ...text);
// a state or verdict word as a pill: PASS, merged, done mint; FAIL, red rose (agent-set: no prototype keys). A known word
// shows in Title Case (§8 pills) with the raw word in its title; any other word as it came (vis). hue: a caller's own map.
const WORD_HUE = Object.assign(Object.create(null), { done: 'mint', merged: 'mint', pass: 'mint', red: 'rose', failed: 'rose', fail: 'rose', blocked: 'peach', running: 'lavender' });
const WORD_LABEL = Object.assign(Object.create(null), Object.fromEntries(FLOW_COLS), {
  cancelled: 'Cancelled', pass: 'Pass', fail: 'Fail', failed: 'Failed', block: 'Block', running: 'Running', pending: 'Pending', gating: 'Gating',
  red: 'Red', green: 'Green', merged: 'Merged', closed: 'Closed', 'need review': 'Need Review', assisted: 'Assisted',
  completed: 'Completed', stopped: 'Stopped', killed: 'Killed', // board-terminal-parity 3: a subagent's status (Now card)
});
const wordPill = (w, other = 'gray', hue = WORD_HUE[String(w ?? '').toLowerCase()]) => {
  const label = WORD_LABEL[String(w ?? '').toLowerCase()];
  return el('span', { class: `pill hue-${hue ?? other}`, title: label && vis(w) }, label ?? vis(w));
};

// what a flow waits on, as row and drawer name it: qa:<tag> while another ticket of its tag holds QA (C9)
const waitLabel = (w, tag) => (w?.reason === 'qa_lock' ? `qa:${tag}` : w?.reason === 'blocked_action' ? 'blocked action'
  : w?.reason === 'you' ? 'your turn' : w?.reason === 'folder_busy' ? 'folder busy' : w?.reason === 'task_changed' ? 'folder changed' : w?.reason); // Phase 4: a Task's waits
// One flow, one table row (DESIGN §8 Table): the whole row opens the inspector. The row holds the one click handler; the
// title is a real button (keyboard, screen readers) whose click bubbles to it. ponytail: no ::after over the row, which
// needs a <tr> as containing block (engine-dependent); a click handler has no such ceiling.
function flowRow(f) {
  const w = f.waiting, run = ui.runs.get(f.id);
  const waits = w?.reason && !pilled(f) && `waiting: ${waitLabel(w, f.tag)}${w.reason === 'children' ? ` ${w.done ?? '?'}/${w.total ?? '?'}` : ''}`;
  return el('tr', { class: 'go', 'data-flow': f.id, 'aria-current': ui.open === f.id ? 'true' : null, onclick: () => openTicket(f.id) },
    el('td', { class: 'f-flow' },
      el('button', { type: 'button', class: 'row-open cell-title', 'data-id': f.id, 'aria-label': vis(f.title || f.id) }, vis(f.title || f.id)),
      el('span', { class: 'cell-sub' }, [f.kind, f.tag && `#${f.tag}`, f.id, f.fix_of && `Fix of ${f.fix_of}`, f.promoted_from && 'From reminder'].filter(Boolean).join(' · '))),
    el('td', { class: 'f-stage' }, flowPill(f),
      (waits || f.rework > 0) && el('span', { class: 'stage-sub' }, waits, f.rework > 0 && pill('rose', `Rework ${f.rework}`))),
    el('td', { class: 'f-run', 'data-run': f.id }, run ? runStats(run) : DASH),
    el('td', { class: 'num f-upd' }, f.updated_at ? el('span', { 'data-ago': f.updated_at }, ago(f.updated_at)) : DASH));
}

// A `run` event: that row's Run cell (and the open drawer's run box) change in place; liveness null = the run left the view.
function onRun(e) {
  let r;
  try { r = JSON.parse(e.data); } catch { return; }
  if (typeof r?.id !== 'string') return;
  if (r.liveness == null) ui.runs.delete(r.id);
  else ui.runs.set(r.id, { ...r, tool_at: r.tool_s == null ? null : new Date(Date.now() - r.tool_s * 1000).toISOString() });
  const run = ui.runs.get(r.id);
  for (const cell of document.querySelectorAll(`#flowsView [data-run="${CSS.escape(r.id)}"]`)) cell.replaceChildren(run ? runStats(run) : DASH);
  if (ui.open === r.id) {
    renderRunBox();
    reloadOpen(); // the run moved: the lease changed too (the drawer, its Now card and step bar render again)
    followLog(r.id, r.liveness == null);
    readFeed(r.id);
  }
}

// Segments (plan round 1 Q3): Needs You = clarify, plan approval, blocked; Running = an agent phase or a live run; Done =
// done and cancelled; All = every flow but cancelled. Rows: needs you, running, backlog, then done; newest update first.
const isRunning = f => !needsYou(f) && (settingUp(f) || AGENT.includes(f.state) || !!ui.runs.get(f.id)?.live); // a ticket waiting on Irfan is Needs You, not Running
const isOver = f => f.state === 'done' || f.state === 'cancelled';
const FSEGS = [['all', 'All', f => f.state !== 'cancelled'], ['you', 'Needs You', needsYou], ['running', 'Running', isRunning], ['done', 'Done', isOver]];
const FEMPTY = { all: 'Nothing open. Finished and cancelled flows are under Done.', you: 'Nothing needs you right now.', running: 'No running flows.', done: 'Nothing finished yet.' };
const rank = f => (needsYou(f) ? 0 : isRunning(f) ? 1 : isOver(f) ? 3 : 2);
function flowsTable() {
  const [key, label, keep] = FSEGS.find(s => s[0] === ui.fview) ?? FSEGS[0];
  const rows = state.flows.filter(keep).sort((a, b) => rank(a) - rank(b) || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))); // ISO UTC: text order is time order
  return el('table', { class: 'table flows' }, el('caption', { class: 'sr-only' }, `Flows: ${label}`),
    el('thead', null, el('tr', null, ...['Flow', 'Stage', 'Run', 'Updated'].map(h => el('th', { scope: 'col', class: h === 'Updated' ? 'num' : null }, h)))),
    el('tbody', null, ...(rows.length ? rows.map(flowRow) : [el('tr', { class: 'f-none' }, el('td', { colSpan: 4 }, FEMPTY[key]))])));
}
// One table card in #flowsView. A board load rebuilds it and keeps keyboard focus on the same row or segment; a segment
// switch rebuilds only the table.
function renderFlows() {
  const box = $('#flowsView'), a = document.activeElement;
  const keep = a?.closest?.('#flowsView') && (a.dataset.id ? `[data-id="${CSS.escape(a.dataset.id)}"]` : a.value ? `.seg [value="${CSS.escape(a.value)}"]` : null);
  if (!state.flows.length) {
    return box.replaceChildren(el('div', { class: 'card card-flush' }, el('div', { class: 'empty-state' }, icon('flows'),
      el('p', { class: 'empty-title' }, 'No Flows Yet'), el('p', null, 'Start a flow to hand a goal to the agents.'),
      el('button', { type: 'button', class: 'btn btn-gray', onclick: () => openNew('flow') }, 'New Flow'))));
  }
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show flows' }, ...FSEGS.map(([v, label, keepIt]) => el('button', {
    type: 'button', value: v, 'aria-pressed': String(ui.fview === v),
    onclick: () => { ui.fview = v; press(seg, v); $('#flowsView .flows-body').replaceChildren(flowsTable()); },
  }, label, el('span', { class: 'n' }, String(state.flows.filter(keepIt).length)))));
  box.replaceChildren(el('div', { class: 'card card-flush' }, el('div', { class: 'flows-bar' }, seg), el('div', { class: 'flows-body' }, flowsTable())));
  if (keep) $(`#flowsView ${keep}`)?.focus();
}
// the open flow's row reads as selected (accent-soft; aria-current: a plain table has no selected state); none once the
// drawer closes
const markOpen = () => {
  for (const r of document.querySelectorAll('#flowsView tr[data-flow]')) {
    if (r.dataset.flow === ui.open) r.setAttribute('aria-current', 'true');
    else r.removeAttribute('aria-current');
  }
};

const stateLabel = s => FLOW_COLS.find(([k]) => k === s)?.[1] || (s === 'cancelled' ? 'Cancelled' : s);
const flowOf = id => state.flows.find(x => x.id === id) || { id };
const OPS = { resume: 'Resume', restart: 'Restart Phase', cancel: 'Cancel Flow' };
const BTN1 = 'btn btn-sm', BTN2 = 'btn btn-sm btn-gray'; // foundation capsules: the one Prominent (ink) action of a drawer state, the rest Gray
// A two-click action (Cancel, Approve): armed by the first click for 4 s, kept across re-renders. A second click within
// 400 ms of arming is ignored (early): a held Enter repeats clicks on the refocused button.
const armed = (id, op) => ui.arm?.id === id && ui.arm.op === op && ui.arm.until > Date.now();
const early = () => Date.now() - ui.arm.at < 400;
const arm = (id, op) => { ui.arm = { id, op, at: Date.now(), until: Date.now() + 4000 }; };

// Re-renders keep keyboard focus on the same control (data-role) inside the drawer, with a text box's caret.
const drawerFocus = () => {
  const a = document.activeElement;
  return a?.closest?.('#drawer') && a.dataset.role ? { role: a.dataset.role, sel: typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null } : null;
};
// A control gone after its click (Send, Approve, Assign): focus goes to Close, never to <body>.
// Focus on <body> while the drawer is open (no drawer focus to keep: the clicked control was gone first, or a disabled
// one took none): Close too, without a scroll jump. A closed drawer takes nothing.
const refocus = f => {
  const e = f && $(`#drawer [data-role="${CSS.escape(f.role)}"]`);
  if (e) {
    e.focus();
    if (f.sel) e.setSelectionRange(...f.sel);
  } else if (f) $('#drawer [data-role="close"]')?.focus();
  const a = document.activeElement;
  if ((!a || a === document.body) && $('#drawer').open) $('#drawer [data-role="close"]')?.focus({ preventScroll: true });
};
// ...and each <pre data-role> (log tail, error tail) where the reader left it (at the bottom: stays at the bottom).
const logScroll = () => new Map([...document.querySelectorAll('#drawer pre[data-role]')]
  .map(p => [p.dataset.role, { top: p.scrollTop, end: p.scrollTop + p.clientHeight >= p.scrollHeight - 2 }]));
const rescroll = m => {
  for (const p of document.querySelectorAll('#drawer pre[data-role]')) {
    const s = m.get(p.dataset.role);
    if (s) p.scrollTop = s.end ? p.scrollHeight : s.top;
  }
};
const redraw = () => { if (ui.open && $('#drawer').open) drawerBody(flowOf(ui.open), ui.ticket); };
// board-terminal-parity 3: the log tail (and a feedback file) is one <pre> per open ticket that every rebuild re-inserts
// as is: its text is written only when it changed (more lines at the end: appended), so its box and its lines never
// re-lay out under the reader; rescroll() puts its scroll back. key: what it shows (ticket, feedback n).
// kept: that one node per data-role (Phase 3: the Activity feed list too); keptPre: a <pre> of it, its text kept in step.
function kept(key, attrs, tag = 'pre') {
  let p = ui.pres.get(attrs['data-role']);
  if (p?.key !== key) ui.pres.set(attrs['data-role'], p = { key, node: el(tag, attrs), text: null });
  return p;
}
function keptPre(key, attrs, text) {
  const p = kept(key, attrs);
  if (text !== p.text) {
    if (p.text && text.startsWith(p.text)) p.node.append(text.slice(p.text.length));
    else p.node.replaceChildren(text);
    p.text = text;
  }
  return p.node;
}

// The inspector (DESIGN §8 Drawer, 520 wide: plan round 1 Q5): a sticky header (title, stage, kind · tag · id, the
// Overview · Activity · Reports control), then the three panes. Every pane renders and CSS shows the one in data-tab, so a
// switch is instant and keeps drafts. Overview: what waits on Irfan first (waiting notice, Assign, Clarify, the plan to
// approve, asks, your call, Push), then the facts, related tickets, the request and an approved plan (read only, long).
// Activity: the run, the work, gates, your actions. Reports: review, QA, final.
// The control is a tablist (role tab + tabpanel): the selected tab alone is in the Tab order, Left / Right move between them.
const TABS = ['overview', 'activity', 'reports'];
function setTab(t) {
  ui.tab = t;
  const insp = $('#drawer .insp');
  if (!insp) return;
  insp.dataset.tab = t;
  if (t === 'activity') feedScroll(); // review M1: a hidden pane has no layout box, so the feed scrolls once it shows
  for (const b of insp.querySelectorAll('.insp-tabs [role="tab"]')) {
    b.setAttribute('aria-selected', String(b.value === t));
    b.tabIndex = b.value === t ? 0 : -1;
  }
  $('#drawer').scrollTop = 0;
}
function tabKeys(e) {
  const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (!d) return;
  e.preventDefault();
  const t = TABS[(TABS.indexOf(ui.tab) + d + TABS.length) % TABS.length];
  setTab(t);
  $(`#itab-${t}`)?.focus();
}
const NEEDS_BY = { manual: 'Pass this phase on or send it back, below.', needs_scope: 'Pass this phase on or send it back, below.',
  approve: 'The run asks for your OK. Answer below.', blocked_action: 'Auto mode blocked an action. Allow it or dismiss it, below.' };
const NEEDS = { clarify: 'The agent asked you questions. Answer them below; it goes on after you do.', plan_approval: 'A plan is ready. Read it below, then approve it or ask for changes.',
  blocked: 'Blocked. Read why in the run below, then Resume, Restart, Continue in Terminal or Cancel.' };
function drawerBody(f, ticket, error) {
  const foc = drawerFocus(), scroll = logScroll();
  const dd = (k, v) => v == null || v === '' ? null : [el('dt', null, k), el('dd', null, String(v))];
  const k = ticket || {};
  const w = waitLabel(ticket ? k.waiting : f.waiting, f.tag || k.tag), tg = f.tag || k.tag, td = tagDef(tg);
  // L7: once frozen (plan_hash) the plan shown is the one approve froze (GET's plan), never a newer round file
  const qr = ui.round?.kind === 'questions' && Array.isArray(ui.round.questions) ? ui.round : null; // a Task's ask from working has a plan_hash: r is then the plan, the questions are the newest round
  const r = ticket ? (k.plan_hash && ui.plan ? { ...ui.plan, n: ui.round?.n } : ui.round) : null, st = k.state;
  const plan = r?.kind === 'plan' && (st === 'plan_approval' || k.plan_hash) ? planView(f.id, k, r) : null; // a rejected plan (hash cleared) is not shown
  const live = !!ui.runs.get(f.id)?.live || (!!k.lease && !k.lease.exit), reports = isObj(k.review) || isObj(k.qa) || isObj(k.final);
  const tab = (v, label, mark) => el('button', { type: 'button', role: 'tab', id: `itab-${v}`, value: v, 'data-role': `tab-${v}`, 'aria-selected': String(ui.tab === v),
    'aria-controls': `ipane-${v}`, tabindex: ui.tab === v ? '0' : '-1', onclick: () => setTab(v) },
    label, mark && el('span', { class: `tab-mark ${v}` }, el('span', { class: 'sr-only' }, mark)));
  // what the pills and the Needs You box judge: the ticket's own waiting, lease end and ask class once it is loaded (a stale board row after fsm.move says less)
  const row = { ...f, kind: f.kind || k.kind, state: st || f.state, waiting: ticket ? k.waiting : f.waiting, lease_exit: ticket ? k.lease?.exit : f.lease_exit, clarify_class: ticket ? k.clarify_origin?.class : f.clarify_class };
  const you = ticket && yourTurn(row), reason = row.waiting?.reason;
  const cards = ticket && (reason === 'approve' || reason === 'blocked_action') && actionCards(f.id, k); // in the box, not also below
  const stage = ticket && ['review', 'qa', 'final_gate'].includes(st) && (reason === 'manual' || reason === 'needs_scope' || reason === 'close'); // pass / send back / Close / Push
  const runSec = el('section', { id: 'runbox', class: 'part runbox', 'aria-labelledby': 'run-h' }, ...runBox(f.id, ticket));
  // 2026-10-20 (Irfan: "when it blocks I can't decide anything"): ONE box right under the step bar for every flow that waits on
  // him: what to do in a sentence (the wait's own text when it has one), then the questions / plan / result / Resume buttons
  const body = st === 'clarify' ? (k.clarify_origin?.phase === 'working' && k.kind !== 'task' ? askPanel(f.id, k, ui.ask) // Phase 4: a Task's asks are planning rounds
      : qr ? clarifyForm(f.id, qr) : el('p', { class: 'hint' }, 'No open questions found.'))
    : st === 'plan_approval' ? (settingUp(row) ? null : plan || el('p', { class: 'hint' }, 'No plan found.'))
    : you ? youCard(f.id, k) // the run's end saved: Done never meets a live run
    : st === 'blocked' ? runSec : null; // Resume / Restart / Cancel / the refusal live here (plan Q5), not behind Activity
  const nt = ticket && notice(f.id, k.waiting), why = typeof k.waiting?.why === 'string' ? k.waiting.why : '';
  // a block reason WAIT has no text for (interrupted, policy, deps, a gate): the wait's own why, as text
  const box = ticket && needsYou(row) && el('section', { class: 'part you card needs', 'data-role': 'needs-you', 'aria-labelledby': 'ny-h' }, el('h3', { id: 'ny-h' }, 'Needs You'),
    nt || [el('p', null, NEEDS[st] ?? NEEDS_BY[reason] ?? 'Your turn.'), why && el('pre', { class: 'log', 'data-role': 'wait-why', tabindex: '0', 'aria-label': 'Why it waits' }, vis(why))],
    body, cards, stage && [stageActs(f.id, k), pushView(f.id, k, tg)]);
  // the parts inside the box sit one level under its heading
  if (box) for (const h of box.querySelectorAll('h3:not(#ny-h)')) h.setAttribute('aria-level', '4');
  $('#drawer').replaceChildren(el('div', { class: 'insp', 'data-tab': ui.tab },
    el('header', { class: 'insp-head material' },
      el('div', { class: 'insp-top' },
        el('h2', { class: 'insp-title' }, vis(f.title || f.id)),
        el('button', { type: 'button', class: 'icon-btn insp-close', 'data-role': 'close', 'aria-label': 'Close', onclick: () => $('#drawer').close() }, icon('close'))),
      el('p', { class: 'insp-sub' }, (st || f.state) && flowPill(row, st || f.state), el('span', null, [f.kind || k.kind, tg && `#${tg}`, f.id].filter(Boolean).join(' · '))),
      el('div', { class: 'seg insp-tabs', role: 'tablist', 'aria-label': 'Flow sections', onkeydown: tabKeys },
        tab('overview', 'Overview'), tab('activity', 'Activity', live && ', run live'), tab('reports', 'Reports', reports && ', has reports'))),
    el('div', { class: 'pane', 'data-pane': 'overview', role: 'tabpanel', id: 'ipane-overview', 'aria-labelledby': 'itab-overview' },
      ticket && [
        progress(f.id, k, box),
        !cards && actionCards(f.id, k),
        !box && nt,
        !['done', 'cancelled'].includes(st) && subagentsPart(f.id, k),
        st === 'backlog' && el('section', { class: 'part', 'aria-labelledby': 'as-h' },
          el('h3', { id: 'as-h' }, 'Assign'),
          el('p', { class: 'hint' }, 'Assign starts planning: the planner reads the code, then asks you questions or writes a plan.'),
          el('div', { class: 'acts' }, actBtn(f.id, 'assign', () => post(f.id, 'assign'), { cls: BTN1 })),
          errLine(f.id, 'assign'), k.kind !== 'task' && sandboxPart(f.id, k)), // Phase 4 F: a Task never takes a locked run
        st === 'planning' && k.reject_comment && el('p', { class: 'hint' }, 'Your comment on the last plan: ', el('q', null, k.reject_comment)),
        st === 'planning' && k.must_ask && el('p', { class: 'hint' }, 'You asked for more: the planner asks you questions before it plans.'),
        contSec(f.id, k, you), // Continue in Terminal (a Blocked flow's is in its Run section below)
        !stage && ['review', 'qa', 'final_gate'].includes(st) && stageActs(f.id, k),
        !stage && pushView(f.id, k, tg),
      ],
      el('section', { class: 'part', 'aria-labelledby': 'fa-h' }, el('h3', { id: 'fa-h' }, 'Details'),
        el('dl', { class: 'facts' },
          dd('Waiting', w), dd('Rework', k.rework ?? f.rework), dd('Fix', k.fixes > 0 ? `${k.fixes}/${ui.fixMax}` : null),
          dd('QA', k.qa?.verdict ? `${k.qa.verdict} · ${k.qa.pass} pass · ${k.qa.fail} fail · ${k.qa.blocked} blocked` : null),
          dd('Final', isObj(k.final) ? finalText(k.final) : null),
          dd('Branch', k.branch), dd('Base', isObj(k.work) ? null : k.base_sha?.slice(0, 12)), // with work: under Activity → Tech Details
          dd('Push', isObj(k.push) ? pushText(k.push, k) : null),
          fact('Ident', identText(td) ?? (td?.push ? noIdent(tg) : null)),
          fact('Fix of', k.fix_of && el('button', { type: 'button', class: 'link-btn', 'data-role': 'fix-of', onclick: () => openTicket(k.fix_of) }, vis(state.flows.find(x => x.id === k.fix_of)?.title || k.fix_of))),
          fact('Promoted from', k.promoted_from && vis(k.promoted_from)),
          dd('Created', when(k.created_at)), dd('Updated', when(k.updated_at || f.updated_at)))),
      ticket && family(k),
      el('section', { class: 'part', 'aria-labelledby': 'rq-h' }, el('h3', { id: 'rq-h' }, 'Request'),
        el('p', { class: 'ticket-text' }, error || (ticket ? vis(ticket.text) || 'No text.' : 'Loading…'))),
      (st !== 'plan_approval' || !box) && plan),
    el('div', { class: 'pane', 'data-pane': 'activity', role: 'tabpanel', id: 'ipane-activity', 'aria-labelledby': 'itab-activity' },
      ui.feed?.id === f.id && el('section', { id: 'feedbox', class: 'part', 'aria-labelledby': 'fd-h' }, ...feedBox(f.id)),
      st === 'blocked' ? el('p', { class: 'hint' }, 'Resume, Restart and the log are under Overview.') : runSec,
      ticket && isObj(k.work) && [workView(f.id, k), gatesView(f.id)],
      ticket && k.interventions > 0 && ivsView(f.id)),
    el('div', { class: 'pane', 'data-pane': 'reports', role: 'tabpanel', id: 'ipane-reports', 'aria-labelledby': 'itab-reports' },
      ticket && isObj(k.review) && reviewView(f.id, k),
      ticket && isObj(k.qa) && qaView(f.id, k),
      ticket && isObj(k.final) && finalView(f.id, k),
      !reports && (ticket ? el('div', { class: 'empty-state' }, icon('inbox'), el('p', { class: 'empty-title' }, 'No Reports Yet'), el('p', null, 'Review, QA and the final gate put their reports here.'))
        : el('p', { class: 'hint' }, 'Loading…')))));
  refocus(foc);
  rescroll(scroll);
  feedScroll();
}

// board-terminal-parity Phase 3, Overview top: where the flow is (step bar), what its run does now (Now card), the
// approved plan's tasks by title. Rebuilt with the drawer on each run event (onRun → reloadOpen); times tick in place
// (data-since). Agent text (task titles, model, what it does, subagent names) as text only (vis).
const STEPS = [['planning', 'Planning'], ['clarify', 'Questions'], ['plan_approval', 'Plan Approval'], ['working', 'Working'],
  ['review', 'Review'], ['qa', 'QA'], ['final_gate', 'Final Check'], ['done', 'Done']];
// Phase 4: a Task's steps (no review, QA or final check); its clarify lights the step it asked from
const TASK_STEPS = [['planning', 'Questions'], ['plan_approval', 'Plan'], ['working', 'Working'], ['done', 'Done']];
const kilo = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const sep = parts => parts.filter(Boolean).flatMap((p, i) => (i ? [' · ', p] : [p])); // a run of facts joined by ' · '
// marks in a row: [text, done | now | next, extra]; done: a check + "done" for screen readers, now: the accent dot +
// aria-current, next: dim (the step bar, the plan tasks)
const track = (cls, label, items) => el('ol', { class: cls, 'aria-label': label }, ...items.map(([text, at, extra]) =>
  el('li', { class: at, 'aria-current': at === 'now' ? 'step' : null },
    at === 'done' ? icon('check') : el('i', { class: `dot${at === 'now' ? ' hue-lavender' : ''}`, 'aria-hidden': 'true' }),
    el('span', null, text, at === 'done' && el('span', { class: 'sr-only' }, ', done')), extra)));
function progress(id, k, needs) { // needs: the Needs You box, right under the step bar
  const st = k.state, isTask = k.kind === 'task', steps = isTask ? TASK_STEPS : STEPS.filter(([s]) => s !== 'qa' || k.kind !== 'brainstorm');
  const at = s => steps.findIndex(([x]) => x === s);
  let from = st === 'blocked' ? k.blocked_from : st;
  if (isTask && from === 'clarify') from = k.clarify_origin?.phase === 'working' ? 'working' : 'planning';
  const cur = at(from); // backlog, cancelled: -1, nothing lit
  const upto = from === 'clarify' && at(k.clarify_origin?.phase) > cur ? at(k.clarify_origin.phase) : cur; // asked from working on (or blocked there): the steps before it stay done
  const phase = from === 'clarify' ? k.clarify_origin?.phase : from;
  const w = isObj(k.work) ? k.work : {}, by = new Map((Array.isArray(w.tasks) ? w.tasks : []).filter(isObj).map(x => [x.id, x.status]));
  const tasks = Array.isArray(ui.plan?.tasks) && at(phase) >= at('working') ? ui.plan.tasks.filter(isObj) : [];
  return el('section', { class: 'part progress', 'aria-label': 'Progress' },
    track('stepbar', 'Flow steps', steps.map(([, label], i) => [label, i === cur ? 'now' : i < upto ? 'done' : 'next', i === cur && st === 'blocked' && pill('rose', 'Blocked')])),
    st === 'cancelled' && el('p', null, pill('gray', 'Cancelled')),
    needs,
    nowCard(id, k, w),
    tasks.length > 0 && [el('h4', null, 'Plan Tasks'),
      track('ptasks', 'Plan tasks', tasks.map(x => [vis(x.title || 'Task'), by.get(x.id) === 'done' ? 'done' : x.id === w.task ? 'now' : 'next'])),
      parallelPart(id, k, tasks)]);
}
// flow-form-parallel-terminal Phase 3: which plan tasks may run in parallel (k.parallel from GET …/tickets/:id, one helper
// on the server = what the next gap does), "Allow Back to Parallel" (POST …/lane op allow), "Run in Parallel Next" (op next)
const PAR = { running: ['mint', 'Running in parallel'], can: ['sky', 'Can run in parallel'] };
function parallelPart(id, k, tasks) {
  const p = k.parallel;
  if (!isObj(p) || !isObj(p.tasks)) return null;
  const rows = tasks.filter(x => isObj(p.tasks[x.id]));
  return el('div', { class: 'parallel' },
    el('p', { class: 'hint', 'data-role': 'parallel-top' }, 'Parallel lanes: ', vis(p.top)),
    rows.length > 0 && el('ul', { class: 'par-list' }, ...rows.map(x => {
      const b = p.tasks[x.id], [hue, text] = PAR[b.badge] ?? ['gray', `One at a time: ${b.why}`];
      return el('li', { 'data-task': vis(x.id) }, el('span', null, vis(x.title || 'Task')), ' ', pill(hue, vis(text)),
        b.badge === 'can' && (b.next ? el('span', { class: 'hint' }, 'Next: starts at the next gap between the main run’s tasks.')
          : actBtn(id, `lane-next:${x.id}`, () => post(id, 'lane', { task: x.id, op: 'next' }, `lane-next:${x.id}`, 'lane-next'), { sent: 'lane-next', aria: `Run in Parallel Next: ${vis(x.title || 'Task')}` })),
        b.badge === 'one' && b.serial === true && b.security !== true && actBtn(id, `lane-allow:${x.id}`, () => post(id, 'lane', { task: x.id, op: 'allow' }, `lane-allow:${x.id}`, 'lane-allow'), { sent: 'lane-allow', aria: `Allow Back to Parallel: ${vis(x.title || 'Task')}` }));
    })),
    errLine(id, ...rows.flatMap(x => [`lane-next:${x.id}`, `lane-allow:${x.id}`])));
}
// "Subagents for This Ticket" (POST …/subagents {concurrent: 1-4 | null}): its next runs; any kind
function subagentsPart(id, k) {
  const n = k.subagents?.concurrent, def = ui.cfg?.config?.subagents?.concurrent ?? 2;
  return el('div', { class: 'sandbox' },
    el('label', { class: 'pick' }, 'Subagents for This Ticket',
      el('select', { class: 'input', name: 'subagents', 'data-role': 'subagents', disabled: ui.busy.has(id),
        onchange: e => post(id, 'subagents', { concurrent: e.target.value ? Number(e.target.value) : null }, 'subagents') },
        el('option', { value: '', selected: n == null }, `Default (${def})`),
        ...[1, 2, 3, 4].map(v => el('option', { value: String(v), selected: n === v }, String(v))))),
    el('p', { class: 'hint' }, 'How many subagents one run may use at once. It applies from the next run.'),
    (n ?? def) >= 3 && el('p', { class: 'hint', 'data-role': 'subagents-warn' }, pill('butter', '3 or 4 subagents at once can slow down or pause runs on this 8 GB Mac.')),
    errLine(id, 'subagents'));
}
// The Now card: the run live, or the lease's last run. Line 1 the stage (working: task n of m and its title), then model
// and effort, what it does now and since when (live) or how it ended, its subagents, context, refusals, cost, elapsed.
// Money arrives as integer micro-USD: divided only here, for display.
// how the last run ended, in words (Irfan: the raw log must never be needed to know it)
const EXIT = { result: 'finished', crash: 'crashed', interrupted: 'stopped before it ended', stalled: 'stalled: no output', usage: 'paused: usage limit',
  paused: 'paused', held: 'in your terminal', schema_fail: 'its answer was rejected', cancelled: 'cancelled',
  max_turns: 'hit the turn limit', refusal: 'the model refused', wall_cap: 'stopped: time cap' };
// a crash with no pid never started (lease.pid stays null: refusing to start, task_changed); any other exit is the run's own end
const endWord = l => vis(l.exit === 'crash' && !Number.isInteger(l.pid) ? 'refused' : EXIT[l.exit] ?? l.exit ?? DASH);
const lastRun = l => {
  const err = typeof l.error === 'string' && !l.pending ? l.error.replace(BIDI, '').split('\n')[0].slice(0, 200) : '';
  return `ended: ${endWord(l)}${err ? `: ${vis(err)}` : ''}`;
};
function nowCard(id, k, w) {
  const r = ui.runs.get(id), l = k.lease, live = !!r?.live || (!!l && !l.exit);
  if (!live && !l?.started_at) return null;
  const phase = l?.phase || k.state, tasks = Array.isArray(w.tasks) ? w.tasks : [], n = tasks.findIndex(x => x?.id === w.task);
  const title = phase === 'working' && Array.isArray(ui.plan?.tasks) ? ui.plan.tasks.find(x => x?.id === w.task)?.title : null;
  const doing = isObj(r?.doing) ? [r.doing.tool, r.doing.text].filter(Boolean).map(vis).join(': ') : '';
  const subs = Array.isArray(r?.subs) ? r.subs.filter(isObj) : [], cost = r?.cost_total ?? l?.cost_total;
  const start = l?.started_at ?? r?.started_at, took = Date.parse(l?.ended_at) - Date.parse(start);
  const model = [r?.model ?? l?.model, r?.effort].filter(Boolean).map(vis).join(' · ');
  const idle = r?.liveness && r.liveness !== 'thinking' && r.liveness !== 'tool' ? LIVE[r.liveness]?.[1] : null; // a slot, retry or Approve wait
  const dirty = k.kind === 'task' ? k.task?.base?.dirty : null; // Phase 4: files Irfan had changed before the Task started
  return el('div', { class: 'card now-card', role: 'group', 'aria-label': 'Now' },
    el('p', { class: 'now-stage' }, sep([k.state === 'blocked' && (k.blocked_from ?? phase) !== 'blocked' ? `Blocked in ${stateLabel(k.blocked_from ?? phase)}` : stateLabel(phase), phase === 'working' && n >= 0 && `task ${n + 1} of ${tasks.length}`, title && vis(title)])),
    model && el('p', { class: 'hint' }, model),
    Number.isInteger(dirty) && dirty > 0 && el('p', { class: 'hint' }, `${dirty} ${dirty === 1 ? 'file was' : 'files were'} already uncommitted`),
    live ? el('p', null, doing || idle || 'Thinking or writing', doing && r.tool_at && [' · ', el('span', { 'data-since': r.tool_at }, span(r.tool_at))])
      : el('p', null, `Last run · ${lastRun(l)}`),
    subs.length > 0 && el('ul', { class: 'now-subs', 'aria-label': 'Subagents' }, ...subs.map(s => el('li', null,
      el('span', { class: 'now-sub' }, el('span', null, vis(s.desc || s.type || 'Subagent')),
        el('span', { class: 'hint' }, sep([s.type && vis(s.type), s.tool && vis(s.tool), Number.isFinite(s.tokens) && `${kilo(s.tokens)} tokens`]))),
      wordPill(s.status, s.status === 'completed' ? 'mint' : 'gray')))),
    el('p', { class: 'now-facts' }, ...sep([Number.isFinite(r?.ctx_tokens) && `Context ${kilo(r.ctx_tokens)} tokens`, r?.denied > 0 && dot('wait', `${r.denied} refused`),
      Number.isInteger(cost) && `$${(cost / 1e6).toFixed(2)}`,
      live && start ? el('span', { 'data-since': start }, span(start)) : took >= 0 && dur(took)])));
}

// Run section of the drawer (spec §10 card detail): run line, refused-run error (R17), Resume / Restart / Cancel,
// the outcome of the last click, log tail on demand.
function runBox(id, k) {
  const r = ui.runs.get(id), l = k?.lease, st = k?.state;
  const running = !!r?.live || (!!l && !l.exit);
  const live = running || !!l?.pending; // Resume is refused for both
  const n = /^runs\/(\d+)\.jsonl$/.exec(l?.log || '')?.[1];
  const out = [el('h3', { id: 'run-h' }, 'Run')];
  out.push(!l ? el('p', { class: 'hint' }, k ? 'No run yet.' : 'Loading…') : el('p', { class: 'run-line' }, r && liveTag(r),
    el('span', null, [l.phase && stateLabel(l.phase), n && `run ${n}`, l.started_at && `started ${hhmm(l.started_at)}`,
      l.pending ? `recovering (${l.pending.why || l.pending.after})` : l.exit ? `ended: ${endWord(l)}` : 'live'].filter(Boolean).join(' · '))));
  if (l?.error && !l.pending) out.push(el('p', { class: 'warnbox' }, el('strong', null, endWord(l) === 'refused' ? 'Run refused. ' : `Run ended: ${endWord(l)}. `), l.error.replace(BIDI, ''))); // names agent-made files: no bidi reordering
  const can = AGENT.includes(st) || st === 'blocked';
  const sure = armed(id, 'cancel'); // Cancel's confirm click
  // Cancel is the destructive one: danger text on Gray, the confirm click in danger fill (DESIGN §8 Buttons)
  const btn = (op, extra) => el('button', { type: 'button', class: op !== 'cancel' ? BTN2 : sure ? 'btn btn-sm btn-danger-fill' : 'btn btn-sm btn-danger', 'data-role': op,
    onclick: () => runAction(id, op), ...extra }, op === 'cancel' && sure ? 'Confirm Cancel' : OPS[op]);
  // from blocked: the phase it blocked in, or an earlier one (tb resume --phase)
  const at = s => FLOW_COLS.findIndex(([c]) => c === s);
  const back = st === 'blocked' ? AGENT.filter(p => at(p) <= at(k.blocked_from) && !(p === 'qa' && k.kind === 'brainstorm')) : [];
  // full-access-runs Phase 9: held = Irfan's terminal has the session (no Resume / Restart until Hand Back)
  const held = l?.exit === 'held', open = st && st !== 'done' && st !== 'cancelled';
  const hold = !!k && canHold(k); // k is null while the ticket loads
  const acts = [
    back.length > 1 && el('label', { class: 'pick' }, 'Resume in',
      el('select', { class: 'input', name: 'resume-phase', 'data-role': 'resume-phase', onchange: e => ui.phase.set(id, e.target.value) },
        ...back.map(p => el('option', { value: p, selected: (ui.phase.get(id) ?? k.blocked_from) === p }, stateLabel(p))))),
    can && !held && btn('resume', { disabled: live, title: live ? 'The run is live. Resume works once it ended.' : null }),
    can && !held && btn('restart'),
    hold && holdBtn(id),
    open && btn('cancel'),
  ].filter(Boolean);
  if (acts.length) out.push(el('div', { class: 'run-actions' }, ...acts));
  if (sure) out.push(el('p', { class: 'hint' }, 'Press again to cancel this flow.'));
  if (hold) out.push(el('p', { class: 'hint' }, 'Continue in Terminal stops the run at once: its turn ends, and a tool call in flight finishes or dies with it.'));
  out.push(errLine(id, 'hold'));
  if (held && open && (AGENT.includes(st) || st === 'blocked')) out.push(heldBox(id, k)); // a cancelled or closed flow keeps no Hand Back; blocked + held: Hand Back resumes from Blocked
  out.push(el('p', { class: 'hint', 'aria-live': 'polite' }, outcome(id, k, running)));
  if (open) out.push(noteBox(id, k, running));
  const shown = ui.log?.id === id;
  const follow = ui.follow?.id === id && ui.follow.on;
  const raw = ui.raw || follow; // board-terminal-parity 3: the Activity feed is the default view, this tail sits behind Show Raw Log (Follow keeps it shown)
  const rawBtn = () => { ui.raw = !raw; if (!ui.raw) ui.follow = null; renderRunBox(); };
  // the heading only over a shown tail: alone it read as the title of the card below it (Irfan 2026-10-20)
  if (l?.log || shown) out.push(el('div', { class: 'log-head' }, raw ? el('h4', null, 'Log Tail') : el('span'),
    el('span', { class: 'log-acts' },
      raw && l?.log && el('button', { type: 'button', class: 'link-btn', 'data-role': 'follow', 'aria-pressed': String(follow), onclick: () => toggleFollow(id) }, follow ? 'Following' : 'Follow'),
      raw && l?.log && el('button', { type: 'button', class: 'link-btn', 'data-role': 'log', onclick: () => loadLog(id) }, shown ? 'Refresh' : 'Show Last 200 Lines'),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'raw-log', 'aria-pressed': String(raw), onclick: rawBtn }, 'Show Raw Log'))));
  if (shown && raw) out.push(ui.log.error ? el('p', { class: 'hint' }, ui.log.error)
    : keptPre(id, { class: 'log log-box', 'data-role': 'log-tail', tabindex: '0', 'aria-label': 'Run log, last lines' }, ui.log.lines.join('\n') || 'Empty so far.'));
  return out;
}

// Continue in Terminal (op hold): the run's phase is the ticket's, or the one it blocked in. Squashed (waiting close):
// nothing to pause; a usage wait: tbd refuses; a start refused before any spawn that was no resume: no session yet.
const canHold = k => {
  const l = k.lease, blocked = k.state === 'blocked', at = blocked ? k.blocked_from : k.state;
  // steer's cheap rules (lib/runner.js): Blocked only from planning | working, its round is the run's + 1 (fsm.move), the
  // run's task is the ticket's, never a lane; a run that never started and was no resume has no session. The planted-config
  // check stays on the server (the click's 409 shows through errLine)
  return !k.lane_of && AGENT.includes(at) && (!blocked || at === 'planning' || at === 'working') && l?.exit !== 'held' && l?.phase === at
    && l.round === (blocked ? k.round - 1 : k.round) && (l.task ?? null) === (at === 'working' ? k.work?.task ?? null : null)
    && UUID_RE.test(l.session ?? '') && typeof k.worktree === 'string' && k.waiting?.reason !== 'close' && l.exit !== 'usage'
    && (Number.isInteger(l.pid) || !!l.resumed);
};
// One click = hold; heldBox then opens Terminal by itself (Page Tools on), else its resume line + Copy shows
const holdBtn = id => actBtn(id, 'hold', async () => { ui.cont.add(id); if (await post(id, 'hold')) ui.cont.delete(id); });
// The Overview's part for a running agent-phase flow: the button, or (held) the In Your Terminal box. A Task's Your Turn
// card holds the button itself (you), a Blocked flow's Run section does.
const contSec = (id, k, you) => {
  const held = k.lease?.exit === 'held';
  if (!AGENT.includes(k.state) || (!held && (you || !canHold(k)))) return null;
  return el('section', { class: 'part', 'aria-labelledby': 'ct-h' }, el('h3', { id: 'ct-h' }, 'Terminal'),
    held ? heldBox(id, k) : [el('p', { class: 'hint' }, 'Stops the run at once and continues its session in your terminal.'), el('div', { class: 'acts' }, holdBtn(id)), errLine(id, 'hold')]);
};
// full-access-runs Phase 9: Continue in Terminal → "In Your Terminal": the resume line built only from shq() (the worktree)
// and a session id that passes UUID_RE, a Copy button (copyCmd) and the one Hand Back button. While the run still dies
// (pending) no line yet: two writers of one session never.
const HELD_WAIT = { // a held flow's recovery in flight (lease.pending.why)
  hold: 'Stopping the run. The command shows once it has stopped.',
  handback: 'Handing back: the board resumes the same session (it may wait for memory first).',
  cancel: 'Cancelling the flow.',
};
function heldBox(id, k) {
  const l = k.lease, cmd = UUID_RE.test(l.session ?? '') && typeof k.worktree === 'string' ? `cd ${shq(k.worktree)} && claude --resume ${l.session}` : null;
  const pre = cmd && el('pre', { class: 'log', 'data-role': 'resume-cmd', tabindex: '0', 'aria-label': 'Command, as text' }, cmd);
  const open = cmd && pageTools(); // board-terminal-parity 6.5: tbd opens Terminal with this line (POST …/terminal); the one Prominent action then
  const clicked = !l.pending && !ui.busy.has(id) && ui.cont.delete(id); // Continue in Terminal was clicked here: taken on the first held render, Page Tools or not
  if (clicked && open) Promise.resolve().then(() => post(id, 'terminal', {})); // once, not on every render
  return el('div', { class: 'held', 'data-role': 'held' }, el('h4', null, 'In Your Terminal'),
    l.pending ? el('p', { class: 'hint' }, HELD_WAIT[l.pending.why] ?? 'Working on it.') : [
      el('p', { class: 'hint' }, 'tbd starts nothing on this flow until you hand it back. Run this exact line in Terminal (tbd cannot see claude -c), work in the session, type /exit, then Hand Back.'),
      pre || el('p', { class: 'hint' }, 'No session to resume.'),
      el('div', { class: 'acts' }, open && actBtn(id, 'terminal', () => post(id, 'terminal', {}), { cls: BTN1 }),
        cmd && el('button', { type: 'button', class: BTN2, 'data-role': 'copy-resume', onclick: () => copyCmd(pre, cmd) }, 'Copy Command'),
        actBtn(id, 'handback', () => post(id, 'handback'), { cls: open ? BTN2 : BTN1 })),
      errLine(id, 'handback', 'terminal')]);
}
// Phase 9: a note to the agent (text only, into its prompt file: never a shell). The draft survives the run box's re-renders.
function noteBox(id, k, running) {
  const ta = el('textarea', { class: 'input', rows: 2, maxlength: '10000', 'data-role': 'note-text', 'aria-label': 'Note to the agent',
    placeholder: running ? 'The run stops and its session goes on with your note first.' : 'The next run starts with your note.', oninput: e => ui.notes.set(id, e.target.value) });
  ta.value = ui.notes.get(id) ?? '';
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (!(await post(id, 'note', { text }))) ui.notes.delete(id);
  };
  const n = k.notes?.length ?? 0;
  return el('div', { class: 'note-box' }, el('h4', null, 'Note'), ta,
    el('div', { class: 'acts' }, actBtn(id, 'note', send), n > 0 && el('span', { class: 'hint' }, `${n} ${n === 1 ? 'note waits' : 'notes wait'} for the next run.`)),
    errLine(id, 'note'));
}
// Phase 8; board-terminal-parity 6.3: the page turns the locked run on and off (POST …/sandbox {on}, backlog only).
function sandboxPart(id, k) {
  return el('div', { class: 'sandbox' },
    el('label', { class: 'switch-row' }, el('span', null, el('span', { class: 'set-label' }, 'Locked Run'),
      el('span', { class: 'cell-sub' }, 'For untrusted text (an issue, a pasted log). Fewer tools, slower.')),
      el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'data-role': 'sandbox', checked: !!k.sandbox, disabled: ui.busy.has(id),
        onchange: e => post(id, 'sandbox', { on: e.target.checked }, 'sandbox', e.target.checked ? 'sandbox' : 'sandbox-off') })),
    errLine(id, 'sandbox'));
}

// L4: the last click wins (gen CAS in tbd); this line shows what came of it once the ticket and run events arrive.
function outcome(id, k, running) {
  const a = ui.act?.id === id ? ui.act : null;
  if (!a) return '';
  const at = hhmm(a.at);
  if (a.state !== 'accepted') return a.state === 'sent' ? `${OPS[a.op]}: sending.` : `${OPS[a.op]} refused at ${at}: ${a.error}`;
  const l = k?.lease;
  // a recovery waiting (pending) has no live run: its waiting reason says what it waits for
  const run = running ? 'run live' : l?.pending ? null : l?.exit ? `run ended (${l.exit})` : 'no run';
  return `${OPS[a.op]} accepted at ${at}. Now: ${[stateLabel(k?.state), run, k?.waiting?.reason && `waiting: ${k.waiting.reason}`].filter(Boolean).join(', ')}.`;
}

function renderRunBox() {
  const box = $('#runbox');
  if (!box || !ui.open) return;
  const foc = drawerFocus(), scroll = logScroll();
  box.replaceChildren(...nodes(runBox(ui.open, ui.ticket)));
  refocus(foc);
  rescroll(scroll);
}

async function runAction(id, op) {
  if (op === 'cancel' && !armed(id, 'cancel')) { // stops the run: one more click to confirm
    arm(id, op);
    renderRunBox();
    setTimeout(renderRunBox, 4000);
    return;
  }
  if (op === 'cancel' && early()) return;
  ui.arm = null;
  ui.act = { id, op, at: Date.now(), state: 'sent' };
  renderRunBox();
  try {
    const phase = ui.ticket?.state === 'blocked' && ui.phase.get(id);
    await api('POST', `/api/tickets/${encodeURIComponent(id)}/${op}`, op === 'resume' ? (phase ? { phase } : {}) : undefined);
    ui.act.state = 'accepted';
    ui.phase.delete(id);
  } catch (e) {
    Object.assign(ui.act, { state: 'refused', error: e.message });
    toast(e.message, { title: `${OPS[op]} Refused` });
  }
  renderRunBox();
  reloadOpen();
}

async function loadLog(id) {
  try {
    const r = await api('GET', `/api/tickets/${encodeURIComponent(id)}/log?tail=200`);
    ui.log = { id, lines: r.lines, run: r.run, offset: r.offset, ended: !!r.ended };
  } catch (e) {
    ui.log = { id, lines: [], error: e.status === 404 ? 'No run log yet.' : e.message };
  }
  renderRunBox();
  const pre = $('#runbox pre.log-box');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

// Follow (tb logs -f): on, each `run` event of the open ticket reads the log after the last offset: one request at a time
// (an event during it asks for one more round), the last 1000 lines kept; the run ending, an error or closing the drawer ends it.
async function toggleFollow(id) {
  if (ui.follow?.id === id && ui.follow.on) ui.follow = null;
  else {
    ui.follow = { id, on: true };
    if (ui.log?.id !== id || ui.log.error) await loadLog(id);
    if (ui.log?.error || ui.log?.ended) ui.follow = null;
  }
  renderRunBox();
}
async function followLog(id, ending) {
  const f = ui.follow, lg = ui.log;
  if (!f?.on || f.id !== id || lg?.id !== id || lg.offset == null) return;
  if (ending) { f.ending = true; f.last = f.busy ? 'next' : 'this'; } // the run left the view: one more read (after the one in flight), then off
  if (f.busy) { f.again = true; return; }
  f.busy = true;
  try {
    do {
      f.again = false;
      const r = await api('GET', `/api/tickets/${encodeURIComponent(id)}/log?after=${lg.offset}&run=${lg.run}`);
      if (ui.follow !== f || ui.log !== lg) return;
      lg.lines = [...lg.lines, ...r.lines].slice(-1000);
      lg.offset = r.offset ?? lg.offset;
      if (r.ended || (f.ending && f.last === 'this')) f.on = false; // the last read, ended or not (press Follow again)
      else if (f.ending) { f.last = 'this'; f.again = true; } // the run ended during this read: one more
    } while (f.again && f.on);
  } catch (e) {
    f.on = false;
    toast(e.message, { title: 'Follow Stopped' });
  } finally {
    f.busy = false;
  }
  if (ui.follow === f) renderRunBox();
}

// board-terminal-parity Phase 3, Activity feed (GET …/activity): the first read of an open ticket (no after) brings the
// run's last lines and the state moves + your actions (steps; steps first on a tie); each `run` event of the open ticket
// reads after the cursor, as Follow does: one request at a time, an event during it asks for one more round. A newer
// run of the ticket (its lease) starts again with that run's last lines. The last 1000 rows are kept, append only, in
// one kept list node (kept) that every rebuild re-inserts.
const FEED_MAX = 1000;
const TONE = Object.assign(Object.create(null), { info: 'gray', ok: 'mint', warn: 'butter', bad: 'rose', you: 'lavender' });
const FEED_EMPTY = Object.assign(Object.create(null), { loading: 'Loading…', none: 'No activity yet.', ok: 'Nothing yet.' }); // else: the error
const feedAdd = (a, xs) => { a.rows = [...a.rows, ...xs.map(x => ({ at: x.at ?? a.rows.at(-1)?.at ?? null, text: x.text, tone: x.tone, n: ++a.seq }))].slice(-FEED_MAX); };
async function readFeed(id) {
  const a = ui.feed;
  if (a?.id !== id) return;
  if (a.busy) { a.again = true; return; }
  a.busy = true;
  const seq = a.seq, was = a.state;
  try {
    do {
      a.again = false;
      const cur = Number(/^runs\/(\d+)\.jsonl$/.exec(ui.ticket?.lease?.log ?? '')?.[1]);
      if (a.run && cur > a.run) Object.assign(a, { run: cur, cursor: null });
      const first = a.cursor == null;
      const r = await api('GET', `/api/tickets/${enc(id)}/activity?limit=200${a.run ? `&run=${a.run}` : ''}${first ? '' : `&after=${enc(a.cursor)}`}`);
      if (ui.feed !== a) return;
      const lines = Array.isArray(r.lines) ? r.lines.filter(isObj) : [];
      const steps = first && !a.rows.length && Array.isArray(r.steps) ? r.steps.filter(isObj)
        .map(x => ({ ...x, text: String(x.text ?? '').replace(/^Moved to (\w+)$/, (_, s) => `Moved to ${stateLabel(s)}`) })) : [];
      const t = x => Date.parse(x.at) || 0;
      feedAdd(a, first ? [...steps, ...lines].sort((x, y) => t(x) - t(y)) : lines); // a stable sort: steps first on a tie
      Object.assign(a, { run: r.run ?? a.run, cursor: r.cursor ?? a.cursor, state: 'ok' });
      if (!first && lines.length >= 200) a.again = true; // more waiting after this page
    } while (a.again);
  } catch (e) {
    if (ui.feed === a) a.state = e.status === 404 ? 'none' : e.message;
  } finally {
    a.busy = false;
  }
  if (ui.feed === a && (a.seq !== seq || a.state !== was)) renderFeed(); // nothing new: the section stays as it is
}
// the feed section's parts: heading, the kept list (new rows appended, the oldest past 1000 dropped) or why it is empty,
// Jump to Latest while Irfan reads further up. role log, aria-live off: the run box's outcome line is the one that speaks.
function feedBox(id) {
  const a = ui.feed;
  if (a?.id !== id) return [];
  const p = kept(id, { class: 'feed', 'data-role': 'feed', role: 'log', 'aria-live': 'off', tabindex: '0', 'aria-label': 'Activity, oldest first', onscroll: e => feedScrolled(e.currentTarget) }, 'div');
  for (const x of a.rows) {
    if (x.n <= (p.drawn ?? 0)) continue;
    p.node.append(el('div', { class: 'feed-row' }, el('span', { class: 'feed-at' }, Number.isFinite(Date.parse(x.at)) ? hhmm(x.at) : '--:--'),
      el('i', { class: `dot hue-${TONE[x.tone] ?? 'gray'}`, 'aria-hidden': 'true' }), el('span', { class: 'feed-text' }, vis(x.text))));
  }
  p.drawn = a.seq;
  for (let n = p.node.children.length - FEED_MAX; n > 0; n--) p.node.firstElementChild?.remove();
  return [el('h3', { id: 'fd-h' }, 'Activity'),
    a.rows.length ? p.node : el('p', { class: 'hint' }, FEED_EMPTY[a.state] ?? a.state),
    el('button', { type: 'button', class: 'link-btn', 'data-role': 'feed-latest', hidden: a.pinned, onclick: () => {
      const n = $('#drawer [data-role="feed"]');
      if (!n) return;
      n.focus(); // first: the button hides under the focus
      n.scrollTop = n.scrollHeight;
      feedScrolled(n);
    } }, 'Jump to Latest')];
}
// it sticks to the bottom unless Irfan scrolled up; a re-inserted node is put back where he left it
function feedScrolled(n) {
  const a = ui.feed;
  if (!a) return;
  a.pinned = n.scrollTop + n.clientHeight >= n.scrollHeight - 2;
  a.top = n.scrollTop;
  const b = $('#drawer [data-role="feed-latest"]');
  if (b) b.hidden = a.pinned;
}
const feedScroll = () => {
  const a = ui.feed, n = a && $('#drawer [data-role="feed"]');
  if (n) n.scrollTop = a.pinned ? n.scrollHeight : a.top;
};
function renderFeed() {
  const box = $('#feedbox');
  if (!box || !ui.open) return;
  const foc = drawerFocus();
  box.replaceChildren(...nodes(feedBox(ui.open)));
  refocus(foc);
  feedScroll();
}

// The open drawer's ticket, read again (state, lease: the run box shows the outcome). Reads can answer out of order:
// only the newest one renders. Called on open, after every board load (any ticket event, a reconnect), on the flow's
// run events and after a click.
let openSeq = 0;
async function readOpen() {
  const id = ui.open;
  if (!id || !$('#drawer').open) return;
  const mine = ++openSeq;
  try {
    const j = await api('GET', `/api/tickets/${encodeURIComponent(id)}`);
    if (mine === openSeq && ui.open === id) {
      ui.round = j.round ?? null;
      ui.plan = j.plan ?? null;
      ui.ask = j.ask ?? null;
      ui.fixMax = j.fix_max;
      // Phase 3: a state move seen here is a feed row of its own (the first read's steps hold the older ones): no request
      const a = ui.feed, s = j.ticket?.state;
      if (a?.id === id && s) {
        if (a.seen && a.seen !== s && a.cursor != null) feedAdd(a, [{ at: j.ticket.updated_at ?? new Date().toISOString(), text: `Moved to ${stateLabel(s)}`, tone: 'info' }]);
        a.seen = s;
      }
      drawerBody(flowOf(id), ui.ticket = j.lanes || j.parallel ? { ...j.ticket, lanes: j.lanes, parallel: j.parallel } : j.ticket); // M5.5: a parent's lanes (and the Phase 3 parallel view) ride on its ticket
    }
  } catch (e) {
    if (mine === openSeq && ui.open === id && !ui.ticket) drawerBody(flowOf(id), null, e.message); // else the next read tries again
  }
}
const reloadOpen = debounce(readOpen, 200);

async function openTicket(id) {
  const d = $('#drawer');
  if (ui.open !== id) ui.cont.clear(); // a Continue in Terminal click belongs to the flow it was clicked on
  if (ui.open !== id) Object.assign(ui, { follow: null, log: null, ticket: null, round: null, plan: null, arm: null, err: null, ask: null, gates: null, ivs: null, fb: null, pass: null, qa: null, rec: null, final: null, tab: 'overview', pres: new Map(), shown: new Map(),
    raw: false, tech: false, feed: { id, rows: [], seq: 0, run: null, cursor: null, state: 'loading', pinned: true, top: 0, seen: null } });
  ui.open = id;
  markOpen();
  drawerBody(flowOf(id), ui.ticket);
  if (!d.open) d.showModal();
  else { d.scrollTop = 0; $('#drawer [data-role="close"]').focus(); } // moved to a parent, child or blocker inside the drawer
  // M5 C20: the tag's ident + push remote for the drawer, read per open (set by the CLI only; none read = no Push button);
  // the config once (Page Tools: Open in Terminal)
  await Promise.all([readOpen(), readFeed(id), api('GET', '/api/tags').then(j => { ui.tagDefs = j.tags || {}; redraw(); }, () => {}), !ui.cfg?.config && loadSettings().then(redraw)]);
}
// A held Enter repeats clicks on the refocused button: the repeats are dropped here (a repeat would confirm an armed
// action, or Approve a plan that just showed); Approve also ignores a click in its plan's first 400 ms (approve()).
$('#drawer').addEventListener('keydown', e => { if (e.repeat && e.key === 'Enter' && e.target.closest?.('button')) e.preventDefault(); });
$('#drawer').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
// Closed (Esc, Close, a click outside): focus goes back to the flow's row, rebuilt or not since it opened; a row gone from
// the segment (Approve moved it): the pressed segment, else the first row. A late close event never ends a newer open.
$('#drawer').addEventListener('close', () => {
  if ($('#drawer').open) return;
  const id = ui.open;
  ui.open = null;
  ui.follow = null;
  ui.feed = null; // its rows and reads too
  ui.cont.clear();
  ui.pres.clear(); // the kept log text goes with the drawer
  ui.shown.clear();
  markOpen();
  if (id) ($(`#flowsView [data-id="${CSS.escape(id)}"]`) || $('#flowsView .seg [aria-pressed="true"]') || $('#flowsView .row-open'))?.focus();
});

// ---------- planning in the drawer (P4 AC5): Assign, Clarify form, plan + decision sources, Approve / Reject, children ----------
// POST /api/tickets/:id/{assign,answer,approve,reject}, same guards as tb. Agent text (questions, plan) is shown via vis().
const SENT = { // button role → [label, label while sending, toast title, toast text]
  // board-terminal-parity Phase 2 task 4: the Approve cards and auto mode's blocks (actionCards)
  'approve-yes': ['Yes Once', 'Sending…', 'Allowed Once', 'The run does exactly this action.'],
  'approve-no': ['No', 'Sending…', 'Refused', 'The run is told: Irfan said no.'],
  'allow-blocked': ['Allow and Retry', 'Sending…', 'Allowed Once', 'This exact call is allowed once; the same session retries it.'],
  'dismiss-blocked': ['Dismiss', 'Sending…', 'Dismissed', 'The card is gone; the action stays blocked.'],
  assign: ['Assign', 'Assigning…', 'Assigned', 'Planning starts when a run slot is free.'],
  answer: ['Send Answers', 'Sending…', 'Answers Sent', 'The planner plans the next round with them.'],
  'plan-now': ['Enough, Plan Now', 'Sending…', 'Planning Now', 'What you left open is the planner’s call.'],
  // full-access-runs Phase 5: a review / qa / final gate ask's round: the answers go back into the asking session
  'answer-on': ['Send Answers', 'Sending…', 'Answers Sent', 'The same session goes on with them.'],
  'decide-now': ['Enough, Decide Yourself', 'Sending…', 'Answers Sent', 'The same session goes on; what you left open is its call.'],
  approve: ['Approve', 'Approving…', 'Approved', 'Setting up: branch, skills, setup command, child tickets.'],
  'task-approve': ['Approve', 'Approving…', 'Approved', 'The same session starts the work in your folder.'], // Phase 4: a Task has no setup
  reject: ['Reject', 'Sending…', 'Rejected', 'The planner plans again with your comment.'],
  ask: ['Ask Me More', 'Sending…', 'Asked for More', 'The planner asks you questions first.'],
  // P5 (working): every one is a two-click action (armed first)
  'work-answer': ['Send Answer', 'Sending…', 'Answer Sent', 'The same session goes on with it.'],
  replan: ['Replan', 'Sending…', 'Replanning', 'The planner makes a new plan; done tasks it keeps stay done.'],
  'scope-allow': ['Allow Files', 'Sending…', 'Files Allowed', 'This task may touch them now; the same session goes on.'],
  'scope-deny': ['Deny Files', 'Sending…', 'Files Denied', 'The agent stays in scope or asks you again.'],
  'allow-change': ['Allow Change', 'Sending…', 'Change Allowed', 'The working gate runs again with it allowed.'],
  'deny-change': ['Deny Change', 'Sending…', 'Change Denied', 'A fix session reverts it.'],
  rework: ['Send Back', 'Sending…', 'Sent Back', 'A fix task works on your feedback.'],
  pass: ['Pass', 'Passing…', 'Passed', 'tbd recorded your pass.'],
  push: ['Push', 'Pushing…', 'Push Started', 'Leak scan first, then git push. The outcome shows in the drawer.'],
  close: ['Close Flow', 'Closing…', 'Flow Closed', 'The flow is done. Nothing was pushed; the worktree stays until tb gc.'],
  lavish: ['Open in Lavish', 'Opening…', 'Opening Lavish', 'The questions page opens in your browser.'],
  // full-access-runs Phase 8 + 9: the Sandbox switch, a note, Continue in Terminal, Hand Back
  sandbox: ['Sandbox', 'Saving…', 'Locked Run On', 'Its runs are locked: seatbelt on, project settings only.'],
  // flow-form-parallel-terminal Phase 3: the parallel buttons and the Subagents pick
  'lane-allow': ['Allow Back to Parallel', 'Saving…', 'Allowed Back to Parallel', 'It can run in a parallel lane again, at the next gap between the main run’s tasks.'],
  'lane-next': ['Run in Parallel Next', 'Saving…', 'Parallel Next', 'It starts in a parallel lane at the next gap between the main run’s tasks, if there is room.'],
  subagents: ['Subagents', 'Saving…', 'Subagents Saved', 'The new number applies from the next run.'],
  'sandbox-off': ['Sandbox', 'Saving…', 'Locked Run Off', 'Its runs get full access.'], // board-terminal-parity 6.3
  // board-terminal-parity 6.5 + 6.8
  terminal: ['Open in Terminal', 'Opening…', 'Terminal Opened', 'Work in the session, type /exit, then Hand Back. macOS may ask once to let tbd use Terminal.'],
  'push-close': ['Push and Close', 'Pushing…', 'Push Started', 'Leak scan first, then git push; the flow closes once the push is green.'],
  note: ['Send Note', 'Sending…', 'Note Sent', 'A live run takes it now; else the next run starts with it.'],
  hold: ['Continue in Terminal', 'Stopping…', 'Stopping', 'The run stops; then Terminal opens with the command to continue it (or the command shows here).'],
  handback: ['Hand Back', 'Handing Back…', 'Handed Back', 'The board resumes the same session.'],
  'pass-check': ['Check SHA', 'Checking…', '', ''],
  // board-terminal-parity Phase 4: a Task's Waits-for-you card
  'task-done': ['Done', 'Closing…', 'Flow Done', 'Your folder is free for the next Task. After a Commit and Push it stays on the Task\'s branch (tb/<id>).'],
  'task-send': ['Send', 'Sending…', 'Sent', 'The same session goes on with your message.'],
  'commit-push': ['Commit and Push', 'Sending…', 'Commit Sent', 'The same session commits only the listed files, then pushes.'],
};
const WAIT = {
  setup: 'Setting up the approved plan: branch, env files, skills, the setup command, child tickets.',
  setup_failed: 'Setup failed. The plan stays as approved. Fix the cause, then approve again.',
  assign_failed: 'Auto-assign failed. Fix the cause, then assign it.',
  blocker_cancelled: 'A ticket this one waits for was cancelled. Assign it to go on without it, or cancel this ticket.',
  blockers_diverge: 'Blockers diverge: no final commit of the tickets this one waits for holds the others, and tbd does not rebase. Cancel it, or re-plan it.',
  // P5: why working blocked (waiting.why says more), then Resume
  infra: 'Blocked: a gate could not run (infra: a missing tool, a port in use, a timeout over the base run). Fix the cause, then Resume.',
  integrity: 'Blocked: node_modules or an env file changed since setup (integrity). Check the worktree, then Resume.',
  config: 'Blocked: the frozen plan or the tag does not match (config). Fix it, then Resume.',
  work: 'Blocked: the gate stayed red after a resume and a fresh try. Read the gate under Activity, then Resume or Restart.',
  scope: 'Blocked: the agent asked again for files you denied. Replan or Resume.',
  rework: 'Blocked: sent back more than twice. Resume resets the count.',
  // M5.2: QA not proven (a BLOCKED or ASSISTED case, or a 4th fix), the DB guard (a database URL not on this Mac)
  qa: 'Blocked: QA did not prove the change (or a 4th fix was needed). Read the QA under Reports, then Resume.',
  db: 'Blocked: the DB guard refused an env file (a database not on this Mac). Fix the tag’s env file, then Resume.',
  // M5.5: lanes (parallel tasks, each a ticket of its own; act on the parent)
  merge: 'Merging a finished lane into the branch. It goes on by itself.',
  lanes: 'Waiting for its lanes to finish. It goes on by itself.',
  lane_setup: 'Setting up the lane clones. Nothing to approve; it goes on by itself.',
  // M5.3 C12 C13: squashed, waiting on Irfan
  close: 'Waits for close: the final gate passed and the squash is made. Close it, push it, or send it back below.',
  // board-terminal-parity Phase 4: a Task (task_changed: waiting.why lists each change with its undo step)
  you: 'The Task finished: your turn. Read what it did below, then press Done, send it a message, or Commit and Push.',
  folder_busy: 'Another Task works in this folder, a folder inside it, or a folder around it. It starts by itself when that one ends.',
  task_changed: 'Blocked: your folder changed since the Task started. Undo each change below (each line says how), or remove the new files, then Resume.',
};
const BLOCKS = ['infra', 'integrity', 'config', 'work', 'scope', 'rework', 'qa', 'db', 'task_changed'];
const code = s => el('code', null, vis(s));
const none = () => el('p', { class: 'hint' }, 'None.');

// While a request runs its buttons are aria-disabled, not disabled: keyboard focus stays on them across re-renders.
function actBtn(id, role, onclick, { cls = BTN2, label = undefined, sent = role, disabled = false, aria = null } = {}) {
  const busy = ui.busy.get(id); // one request per ticket; other tickets stay usable
  return el('button', { type: 'button', class: cls, 'data-role': role, disabled, 'aria-label': aria, 'aria-disabled': busy ? 'true' : null, onclick: () => { if (!ui.busy.has(id)) onclick(); } },
    busy === role ? SENT[sent][1] : label ?? SENT[sent][0]);
}
const errLine = (id, ...roles) => ui.err?.id === id && roles.includes(ui.err.role) && el('p', { class: 'err' }, ui.err.text);

// A refusal shows inline (ui.err) and as a toast: the toast region is the one that speaks it. → null when tbd took it,
// else the refusal text (ui.err may be gone by then: a click elsewhere during the re-read resets it). send: a call of its
// own instead of POST …/<op> (board-terminal-parity Phase 2 task 4: a card's route names its card id too)
async function post(id, op, body, role = op, sent = role, send = () => api('POST', `/api/tickets/${encodeURIComponent(id)}/${op}`, body)) {
  ui.busy.set(id, role);
  ui.err = null;
  redraw();
  try {
    await send();
    toast(SENT[sent][3], { kind: 'info', title: SENT[sent][2] });
    return null;
  } catch (e) {
    ui.err = { id, role, text: e.message };
    toast(e.message, { title: `${SENT[sent][0]} Refused` });
    return e.message;
  } finally {
    await readOpen(); // the fresh ticket first: with the old one the same buttons would work again (a 2nd click → 409)
    ui.busy.delete(id);
    redraw();
  }
}

// waiting reasons the drawer explains (manual, usage, memory…: the Waiting fact says enough)
// P5: + why working blocked (infra, integrity, config…: waiting.why), children n/m, setup_failed "base red".
function notice(id, w) {
  const text = w?.reason === 'children' ? `Waiting for its child tickets: ${w.done ?? '?'} of ${w.total ?? '?'} done or cancelled${w.blocked?.length ? `, ${w.blocked.length} blocked` : ''}. It finishes by itself after the last one.` : WAIT[w?.reason];
  if (!text) return null;
  const why = w.error || w.why;
  return el('div', { class: `notice${w.reason.endsWith('_failed') || BLOCKS.includes(w.reason) ? ' bad' : ''}` },
    el('p', null, w.reason === 'setup' && el('span', { class: 'spin', 'aria-hidden': 'true' }), text),
    w.reason === 'setup_failed' && /base red/.test(w.error ?? '') && el('p', null, el('strong', null, 'The base branch is red: '),
      'a check fails on base_sha itself, before any change. Fix main first (main stays green), then approve again.'),
    why && el('pre', { class: 'log', 'data-role': 'wait-error', tabindex: '0', 'aria-label': 'Error output, last part' }, vis(why)),
    w.reason === 'setup_failed' && el('div', { class: 'acts' }, actBtn(id, 'approve', () => approve(id), { cls: BTN1, label: 'Approve Again' })));
}

// board-terminal-parity Phase 2 task 4, at the top of Overview: each waiting Approve card (tool, the input exactly as the
// run will do it, the agent's words: Yes Once / No; too long to show, or a carriage return / long blank run that could
// hide part of it: No only) and each open auto-mode block (Allow and Retry when tbd can allow exactly that call, with what
// it allows; Dismiss), then how the last asks ended. Agent text as text only (vis); line breaks, tabs and blank runs of 4+
// shown as marks (security review L4), so no part of a command hides in them.
const ASKED = { yes: 'Yes', no: 'No', timeout: 'Timed out: No', gone: 'The run went away', lost: 'Could not ask you: board restarted' };
const marked = s => vis(s).replace(/\t/g, '→').replace(/ {4,}/g, m => `␣×${m.length}`).replace(/\r/g, '␍').replace(/\n/g, '⏎\n');
// M2: what Allow and Retry allows: a Bash call's exact rule; a WebFetch / MCP call only with this input, other calls its rule matches ask first
const allows = b => (b.tool === 'Bash' ? `Allow this exact command for the next run: ${vis(b.rule)}`
  : `Allow this exact call once: ${vis(b.tool)} with the input above. Other ${vis(b.rule)} calls ask you first.`);
// review M3: Allow only while the next run resumes the blocked session (lib/approvals.js resumes, the same check)
const RESUMES = ['crash', 'interrupted', 'stalled', 'usage', 'paused', 'held', 'schema_fail'];
const resumes = (k, b) => typeof b.session === 'string' && k.state === b.phase && k.lease?.phase === b.phase && k.lease.session === b.session
  && !k.lease.pending?.fresh && (!k.lease.exit || (RESUMES.includes(k.lease.exit) && Number.isInteger(k.lease.pid))
    || (k.lease.exit === 'result' && k.continue?.phase === b.phase && k.continue.session === b.session));
function actionCards(id, k) {
  const list = v => (Array.isArray(v) ? v.filter(isObj) : []);
  const asks = list(k.approvals).filter(a => a.status === 'pending'), blocks = list(k.blocked_actions).filter(b => b.status === 'open');
  const past = list(k.approvals).filter(a => a.status !== 'pending').slice(-3);
  if (!asks.length && !blocks.length && !past.length) return null;
  // L-a11y: an answered card is gone: focus the next card's first button, else the heading, else (the section went with
  // the last card) the Overview tab (refocus would take Close)
  const answer = (role, sent, send) => post(id, null, null, role, sent, send).then(e => {
    if (!e) ($('#drawer .notice[data-role^="approve-"] button, #drawer .notice[data-role^="blocked-"] button') ?? $('#ok-h') ?? $('#itab-overview'))?.focus();
  });
  // note: tbd's word on a block (e.g. Allow was not used: the run did not start)
  const card = (role, title, text, why, acts, note) => el('div', { class: 'notice', 'data-role': role }, el('p', null, el('strong', null, title)),
    el('pre', { class: 'log', tabindex: '0', 'aria-label': `${title}: the action` }, marked(text)), why && el('p', { class: 'hint' }, 'The agent says: ', vis(why)),
    typeof note === 'string' && note && el('p', { class: 'hint' }, vis(note)),
    el('div', { class: 'acts' }, ...acts));
  return el('section', { class: 'part', 'aria-labelledby': 'ok-h' }, el('h3', { id: 'ok-h', tabindex: '-1' }, 'Needs Your OK'),
    ...asks.map(a => card(`approve-${a.id}`, `Approve? ${vis(a.tool)}`, a.too_long ? 'Too long to show: only No is possible.' : a.input_text, a.reason, [
      !a.too_long && !a.hidden && actBtn(id, `yes-${a.id}`, () => answer(`yes-${a.id}`, 'approve-yes',
        () => api('POST', `/api/tickets/${encodeURIComponent(id)}/approvals/${encodeURIComponent(a.id)}`, { yes: true })), { cls: BTN1, sent: 'approve-yes' }),
      actBtn(id, `no-${a.id}`, () => answer(`no-${a.id}`, 'approve-no',
        () => api('POST', `/api/tickets/${encodeURIComponent(id)}/approvals/${encodeURIComponent(a.id)}`, { yes: false })), { sent: 'approve-no' }),
      a.hidden && el('span', { class: 'hint' }, 'It holds a carriage return or a long blank run that can hide part of it: only No.'),
      errLine(id, `yes-${a.id}`, `no-${a.id}`)])),
    ...blocks.map(b => card(`blocked-${b.id}`, `Blocked: ${vis(b.tool)}`, b.input_text, b.reason, [
      b.rule && resumes(k, b) && actBtn(id, `allow-${b.id}`, () => answer(`allow-${b.id}`, 'allow-blocked',
        () => api('POST', `/api/tickets/${encodeURIComponent(id)}/blocked/${encodeURIComponent(b.id)}/allow`)), { cls: BTN1, sent: 'allow-blocked' }),
      actBtn(id, `dismiss-${b.id}`, () => answer(`dismiss-${b.id}`, 'dismiss-blocked',
        () => api('POST', `/api/tickets/${encodeURIComponent(id)}/blocked/${encodeURIComponent(b.id)}/dismiss`)), { sent: 'dismiss-blocked' }),
      el('span', { class: 'hint' }, !b.rule ? 'The board cannot allow exactly this one: run it from your terminal.'
        : !resumes(k, b) ? 'The blocked run is over: run it from your terminal, or Dismiss.' : allows(b)),
      errLine(id, `allow-${b.id}`, `dismiss-${b.id}`)], b.note)),
    past.length > 0 && el('ul', { class: 'plist', 'aria-label': 'Earlier asks' }, ...past.map(a => el('li', null, `${vis(a.tool)}: ${ASKED[a.status] ?? vis(a.status)}`))));
}

// Parent, blockers and children from the board's flow list: no request per ticket. A row: title and what it waits on,
// its stage pill trailing; the whole row opens that flow.
function family(k) {
  const row = id => {
    const c = state.flows.find(x => x.id === id);
    return el('li', null, el('button', { type: 'button', class: 'kin', 'data-role': `kin-${id}`, onclick: () => openTicket(id) },
      el('span', { class: 'kin-main' }, el('span', { class: 'kin-title' }, vis(c?.title || id)),
        c?.waiting?.reason && el('span', { class: 'kin-sub' }, `waiting: ${c.waiting.reason}`)),
      c ? flowPill(c) : pill('gray', 'Not Found')));
  };
  const kids = Array.isArray(k.children) ? k.children : [];
  const done = kids.filter(id => ['done', 'cancelled'].includes(state.flows.find(x => x.id === id)?.state)).length; // J4
  const parts = [
    k.parent && [el('h3', null, 'Part Of'), el('ul', { class: 'kids' }, row(k.parent))],
    k.blocked_by?.length && [el('h3', null, 'Waits For'), el('ul', { class: 'kids' }, ...k.blocked_by.map(row))],
    kids.length && [el('h3', null, 'Child Tickets', el('span', { class: 'count' }, `${done}/${kids.length} finished`)), el('ul', { class: 'kids' }, ...kids.map(row))],
  ].filter(Boolean);
  return parts.length ? el('section', { class: 'part', 'aria-label': 'Related tickets' }, ...parts) : null;
}

// ---------- working in the drawer (P5): asks, rework, pass, tasks, gates, your actions ----------
// Contract "UI parity in P5": every tb verb and view of a working flow. Gates, interventions and feedback load on demand,
// paged (GET …/gates, …/interventions, …/feedback/<n>); /api/state is unchanged. Every change is two clicks (armed, as
// Cancel); pass at the final gate instead wants the short sha typed again. Agent text (questions, notes, file names,
// gate output, why) reaches the DOM only as text (el() + vis()).
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : DASH);
const fact = (k, v) => (v == null || v === '' ? null : [el('dt', null, k), el('dd', null, ...[].concat(v))]);
const enc = encodeURIComponent;

function twoStep(id, op, send) {
  if (!armed(id, op)) {
    arm(id, op);
    redraw();
    setTimeout(redraw, 4000);
    return;
  }
  if (early()) return;
  ui.arm = null;
  send();
}
function armBtn(id, op, role, send, { sent = role, cls = BTN2, label = SENT[sent][0], disabled = false } = {}) {
  const sure = armed(id, op);
  return actBtn(id, role, () => twoStep(id, op, send), { cls, label: sure ? `Confirm ${label}` : label, sent, disabled });
}
const replanBtn = id => armBtn(id, 'replan', 'replan', () => post(id, 'answer', { replan: true }, 'replan'));

const ASKS = {
  scope: 'Files Outside the Task', protected: 'A Protected File Changed', deps: 'Dependencies Changed', policy: 'A Change the Plan Doesn’t Allow',
  NEEDS_CONTEXT: 'The Agent Needs Context', TEST_DISPUTES_SPEC: 'A Test Disputes the Spec', noop: 'Done Without a Change',
};
// M12: the open working ask (GET ticket's ask). scope / protected / deps: allow (scope only: RO6) or deny the files;
// policy: allow or deny each change the gate named; a question: an answer. Replan always.
function askPanel(id, k, a) {
  const o = k.clarify_origin || {}, kind = a?.kind || o.class;
  const files = Array.isArray(a?.files) ? a.files : [], changes = Array.isArray(a?.changes) ? a.changes : [];
  let acts;
  if (['scope', 'protected', 'deps'].includes(kind)) {
    const cli = kind !== 'scope';
    acts = [files.length ? el('ul', { class: 'plist' }, ...files.map(p => el('li', null, code(p)))) : none(),
      cli && el('p', { class: 'hint' }, `Only the CLI can allow a ${kind} change: `, code(`tb scope ${id} --allow`), '. Deny works here.'),
      el('div', { class: 'acts' },
        armBtn(id, 'scope-allow', 'scope-allow', () => post(id, 'scope', { allow: true }, 'scope-allow'), { disabled: cli }),
        armBtn(id, 'scope-deny', 'scope-deny', () => post(id, 'scope', { allow: false }, 'scope-deny')), replanBtn(id))];
  } else if (kind === 'policy') {
    acts = [changes.length ? el('ul', { class: 'plist' }, ...changes.map((c, i) => el('li', { class: 'change' }, code(c), el('span', { class: 'acts' },
      armBtn(id, `allow:${i}`, `allow-change-${i}`, () => post(id, 'allow-change', { change: c }, `allow-change-${i}`, 'allow-change'), { sent: 'allow-change' }),
      armBtn(id, `deny:${i}`, `deny-change-${i}`, () => post(id, 'deny-change', { change: c }, `deny-change-${i}`, 'deny-change'), { sent: 'deny-change' }))))) : none(),
      el('div', { class: 'acts' }, replanBtn(id))];
  } else {
    const key = `${id}:w${k.round}`, d = draftOf(id, `w${k.round}`);
    const box = el('textarea', { id: 'wa', rows: 3, maxLength: 10000, 'data-role': 'work-text', 'aria-describedby': d.errs.text ? 'wa-err' : null, oninput: e => { d.comment = e.target.value; } });
    box.value = d.comment;
    const send = () => {
      if (!d.comment.trim()) {
        d.errs.text = 'Write your answer first.';
        redraw();
        return $('#drawer [data-role="work-text"]')?.focus();
      }
      delete d.errs.text;
      post(id, 'answer', { text: d.comment.trim() }, 'work-answer').then(err => { if (err == null) ui.drafts.delete(key); });
    };
    acts = [el('div', { class: 'field' }, el('label', { for: 'wa' }, 'Your Answer'), box, d.errs.text && el('p', { class: 'err', id: 'wa-err' }, d.errs.text)),
      el('div', { class: 'acts' }, armBtn(id, 'work-answer', 'work-answer', send, { cls: BTN1 }), replanBtn(id),
        !k.lane_of && actBtn(id, 'lavish', () => post(id, 'lavish', {}), { sent: 'lavish' })), // Phase 5: a text ask has a lavish page too (a lane: none)
      errLine(id, 'lavish')];
  }
  return el('section', { class: 'part ask', 'aria-labelledby': 'ak-h' },
    el('h3', { id: 'ak-h' }, ASKS[kind] || 'Question', o.task && el('span', { class: 'count' }, 'task ', vis(o.task))),
    el('p', { class: 'ctext' }, vis(a?.question || a?.reason || o.why || '')),
    a?.notes && el('p', { class: 'ctext' }, 'Notes: ', vis(a.notes)),
    a?.online && el('p', { class: 'hint' }, 'The dependency build needs the network: the CLI allow builds it online.'),
    ...acts,
    errLine(id, 'work-answer', 'replan', 'scope-allow', 'scope-deny', ...changes.flatMap((_, i) => [`allow-change-${i}`, `deny-change-${i}`])));
}

// review / qa / final gate while unbuilt (K1 K2): pass it on or send it back. M5.3: a code final gate is built (its
// end: tb close / tb push; D26's leak_check park is gone, tbd refuses that pass); at waiting close (C13): Close, or send
// it back (tbd refuses that once a child started: its 409 shows)
function stageActs(id, k) {
  const st = k.state, merged = !!k.pr?.merged_at, built = st === 'final_gate' && k.kind === 'code' && !merged, close = built && k.waiting?.reason === 'close';
  const next = st === 'review' && k.kind !== 'brainstorm' ? 'qa' : 'final_gate';
  const d = draftOf(id, 'rw');
  const box = el('textarea', { id: 'rw', rows: 3, maxLength: 65536, 'data-role': 'rework-text', 'aria-describedby': d.errs.rw ? 'rw-err' : null, oninput: e => { d.comment = e.target.value; } });
  box.value = d.comment;
  const back = () => {
    if (!d.comment.trim()) {
      d.errs.rw = 'Write what should change.';
      redraw();
      return $('#drawer [data-role="rework-text"]')?.focus();
    }
    delete d.errs.rw;
    post(id, 'rework', { feedback: d.comment.trim() }, 'rework').then(err => { if (err == null) ui.drafts.delete(`${id}:rw`); });
  };
  return el('section', { class: `part${!merged && (!built || close) ? ' you' : ''}`, 'aria-labelledby': 'sg-h' },
    el('h3', { id: 'sg-h' }, `${stateLabel(st)}: Your Call`),
    !merged && !built && el('p', { class: 'hint' }, 'While this phase is not built you stand in for it: pass the work on, or send it back with feedback.'),
    st !== 'final_gate' && el('div', { class: 'acts' }, armBtn(id, 'pass', 'pass', () => post(id, 'pass', {}, 'pass'), { cls: BTN1, label: `Pass to ${stateLabel(next)}` })),
    built && el('p', { class: 'hint' }, 'tbd runs the final gate: checks, a final review, the squash. Then you close it (tb close) or push it (tb push).'),
    // role close-flow: data-role close is the drawer's own × (refocus). A tag with a push remote: Push and Close (pushView)
    // is the Prominent one (board-terminal-parity 6.8)
    close && el('div', { class: 'acts' }, armBtn(id, 'close', 'close-flow', () => post(id, 'close', {}, 'close-flow', 'close'), { cls: tagDef(k.tag)?.push?.remote ? BTN2 : BTN1, sent: 'close' })),
    st === 'final_gate' && !built && !merged && passForm(id),
    merged && el('p', { class: 'hint' }, 'Passed with ', code(String(k.pr.sha ?? '').slice(0, 12)), ` at ${when(k.pr.merged_at)}.`),
    // a BUILT final gate: tbd refuses a rework there (409) but at waiting close, so the send-back box only then
    !merged && (!built || close) && isObj(k.work) && [el('div', { class: 'field' }, el('label', { for: 'rw' }, 'Send Back to Working'), box,
      el('p', { class: 'hint' }, `Sent back ${k.rework ?? 0} ${k.rework === 1 ? 'time' : 'times'}. A 3rd time blocks it.`),
      d.errs.rw && el('p', { class: 'err', id: 'rw-err' }, d.errs.rw)), el('div', { class: 'acts' }, armBtn(id, 'rework', 'rework', back))],
    errLine(id, 'pass', 'pass-check', 'rework', 'close-flow'));
}

// M5 C14 C20: the tag's ident + push remote, read only (set by the CLI only: tb tag add / tb doctor --tag), and the push
// state. Push: a tag with a push remote, the flow squashed (final gate waiting close, or done); refused (disabled) without
// the tag's ident; two clicks, the confirm names remote, branch and sha12. git's why reaches the DOM as text only.
const tagDef = t => (t && Object.hasOwn(ui.tagDefs, t) ? ui.tagDefs[t] : null);
const identText = d => (d?.ident ? `${d.ident.name} <${d.ident.email}>` : null);
const noIdent = t => ['ident not set: run ', code(`tb doctor --tag ${t} --ident`)];
const pushText = (p, k) => [p.state, `${p.remote ?? ''} ${String(p.ref ?? k.branch ?? '').replace(/^refs\/heads\//, '')}`.trim(), String(p.sha ?? '').slice(0, 12), p.why]
  .filter(Boolean).join(' · ');
function pushView(id, k, tag) {
  const d = tagDef(tag), remote = d?.push?.remote, sha = String(k.final?.sha ?? '');
  const closing = k.state === 'final_gate' && k.waiting?.reason === 'close', off = !d?.ident || !sha || k.push?.state === 'running';
  if (!remote || !(closing || (k.state === 'done' && sha))) return null;
  // one span: .notice is a grid, so loose text nodes + <code> would each take a row
  const ask = then => el('p', { class: 'notice' }, el('span', null, 'Push ', code(sha.slice(0, 12)), ' to ', code(remote), ' as branch ', code(k.branch ?? ''), then));
  return el('section', { class: 'part', 'aria-labelledby': 'pu-h' },
    el('h3', { id: 'pu-h' }, 'Push'),
    el('p', { class: 'hint' }, 'Sends the squash to the tag’s push remote: a leak scan first, then git push with a lease. Never automatic.'),
    !d.ident && el('p', { class: 'err' }, ...noIdent(tag)),
    armed(id, 'push') && ask('?'),
    armed(id, 'push-close') && ask(', then close the flow?'),
    // board-terminal-parity 6.8: at waiting close Push and Close is the Prominent one (POST …/push {close: true}: tbd closes
    // after a green push), Close Flow and Push stay; once done Push is the only action
    el('div', { class: 'acts' },
      closing && armBtn(id, 'push-close', 'push-close', () => post(id, 'push', { close: true }, 'push-close'), { cls: BTN1, disabled: off }),
      armBtn(id, 'push', 'push', () => post(id, 'push'), { cls: k.state === 'done' ? BTN1 : BTN2, disabled: off })),
    isObj(k.push) && el('p', { class: k.push.state === 'failed' ? 'err' : 'hint' }, 'Last push: ', pushText(k.push, k)),
    errLine(id, 'push', 'push-close'));
}

// board-terminal-parity Phase 4: a Task waits for you (waiting you). What it did (task_result: summary, done-when, commit
// message), then Done (POST …/close), Send (…/note: the same session goes on) and Commit and Push (…/push, two clicks;
// tbd commits only the listed files). push_to null: why not (push_why); Git Bridge off: disabled. A 409 "the files
// changed" re-reads the ticket (post): the card then shows tbd's fresh list. Agent text and git's names as text only (vis).
function youCard(id, k) {
  const t = isObj(k.task_result) ? k.task_result : {}, p = isObj(t.push_to) ? t.push_to : null, key = `you:${id}`;
  const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  const files = strs(p?.files), left = strs(p?.left), ahead = Number.isInteger(p?.ahead) ? p.ahead : 0, n = files.length;
  const bridge = ui.cfg?.config?.terminal?.git_bridge === true, can = !!p && bridge && n > 0;
  const box = el('textarea', { id: 'ys', class: 'input', rows: 2, maxLength: 10000, 'data-role': 'send-text', oninput: e => ui.notes.set(key, e.target.value) });
  box.value = ui.notes.get(key) ?? '';
  const send = async () => {
    const text = box.value.trim();
    if (text && !(await post(id, 'note', { text }, 'task-send'))) ui.notes.delete(key);
  };
  const where = p && [code(p.branch ?? ''), p.new_branch === true && ' (a new branch)', ' and push to ', code(p.remote ?? '')];
  return el('section', { class: 'part you', 'aria-labelledby': 'yu-h' },
    el('h3', { id: 'yu-h' }, 'Your Turn'),
    t.summary && el('p', { class: 'summary' }, vis(t.summary)),
    typeof t.done_when_met === 'boolean' && el('p', null, `Done when met: ${t.done_when_met ? 'yes' : 'no'}`),
    t.commit_message && [el('h4', null, 'Commit Message'), el('pre', { class: 'log', tabindex: '0', 'aria-label': 'Commit message' }, vis(t.commit_message))],
    el('div', { class: 'acts' }, actBtn(id, 'task-done', () => post(id, 'close', {}, 'task-done'), { cls: can ? BTN2 : BTN1 }), canHold(k) && holdBtn(id)),
    el('div', { class: 'field' }, el('label', { for: 'ys' }, 'Message to the Agent'), box),
    el('div', { class: 'acts' }, actBtn(id, 'task-send', send)),
    errLine(id, 'task-done', 'task-send', 'hold'),
    p ? [el('h4', null, `Files to Commit · ${n}`),
      n ? el('ul', { class: 'plist' }, ...files.map(f => el('li', null, code(f)))) : none(),
      ahead > 0 && el('p', { class: 'hint' }, `${ahead} ${ahead === 1 ? 'commit was' : 'commits were'} already on this branch: the push sends ${ahead === 1 ? 'it' : 'them'} too.`),
      left.length > 0 && el('p', { class: 'hint' }, 'Not committed (you had changed them before): ', ...sep(left.map(code))),
      !bridge && el('p', { class: 'hint' }, 'Commit and Push needs Git Bridge: turn it on in Settings → Terminal.'),
      armed(id, 'commit-push') && el('p', { class: 'notice' }, el('span', null, `Commit ${n === 1 ? 'this file' : `these ${n} files`} to `, ...where, '?')),
      el('div', { class: 'acts' }, armBtn(id, 'commit-push', 'commit-push', () => post(id, 'push', undefined, 'commit-push'), { cls: can ? BTN1 : BTN2, disabled: !can })),
      errLine(id, 'commit-push')]
      : t.push_why && el('p', { class: 'hint' }, 'No Commit and Push here: ', vis(t.push_why)));
}

// D9: tbd checks the sha (GET …/pass?sha: every M15 check, nothing written); the confirm shows the full sha + its subject
// and wants the short sha typed again.
function passForm(id) {
  if (ui.pass?.id !== id) ui.pass = { id, input: '', typed: '', got: null, err: null };
  const p = ui.pass, short = p.got?.sha.slice(0, 7);
  const sha = el('input', { id: 'ps', class: 'input mono', type: 'text', 'data-role': 'pass-sha', maxLength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'ps-hint',
    oninput: e => { p.input = e.target.value.trim(); if (p.got) { p.got = null; redraw(); } } }); // a new sha: checked again
  sha.value = p.input;
  const check = async () => {
    if (!/^[0-9a-f]{7,40}$/.test(p.input)) {
      p.err = 'Type 7–40 lowercase hex characters: the squash commit on the base branch.';
      return redraw();
    }
    ui.busy.set(id, 'pass-check');
    Object.assign(p, { err: null, got: null, typed: '' });
    redraw();
    try { p.got = await api('GET', `/api/tickets/${enc(id)}/pass?sha=${enc(p.input)}`); } catch (e) { p.err = e.message; }
    ui.busy.delete(id);
    redraw();
  };
  const typed = el('input', { id: 'pt', class: 'input mono', type: 'text', 'data-role': 'pass-typed', maxLength: 40, autocomplete: 'off', spellcheck: 'false',
    oninput: e => { p.typed = e.target.value.trim(); const b = $('#drawer [data-role="pass"]'); if (b) b.disabled = p.typed !== short; } });
  typed.value = p.typed;
  return el('div', { class: 'part passform' },
    el('div', { class: 'field' }, el('label', { for: 'ps' }, 'Squash Commit (SHA)'),
      el('div', { class: 'acts' }, sha, actBtn(id, 'pass-check', check)),
      el('p', { class: 'hint', id: 'ps-hint' }, 'tbd checks it is a commit on the base branch, after base_sha, touching a file the branch changed.'),
      p.err && el('p', { class: 'err' }, p.err)),
    p.got && el('div', { class: 'notice' },
      el('p', null, 'Commit ', code(p.got.sha)), el('p', { class: 'ctext' }, vis(p.got.subject || '(no subject)')),
      el('div', { class: 'field' }, el('label', { for: 'pt' }, `Type ${short} to Confirm`), typed),
      el('div', { class: 'acts' }, actBtn(id, 'pass', () => post(id, 'pass', { sha: p.got.sha }, 'pass').then(err => { if (err == null) ui.pass = null; }),
        { cls: BTN1, label: 'Pass', disabled: p.typed !== short }))));
}

// Tasks (state, attempt, session mode, verified head), the gate state, base checks, unit ms, rework, replan hashes,
// feedback-<n>.md on demand.
function workView(id, k) {
  const w = k.work, tasks = Array.isArray(w.tasks) ? w.tasks : [], g = isObj(w.gate) ? w.gate : null;
  const mode = x => (x.status === 'red' ? (w.tries <= 1 ? 'resume' : 'fresh') : x.status === 'running' ? (x.session ? 'continue' : 'fresh') : x.status === 'pending' ? 'fresh' : DASH);
  const base = isObj(k.base_checks) ? Object.entries(k.base_checks) : [];
  const hashes = Array.isArray(k.plan_hashes) ? k.plan_hashes : [];
  const fb = ui.fb?.id === id ? ui.fb : null;
  return el('section', { class: 'part', 'aria-labelledby': 'wk-h' },
    el('h3', { id: 'wk-h' }, 'Work', el('span', { class: 'count' }, `${tasks.filter(x => x.status === 'done').length}/${tasks.length} tasks done`)),
    // board-terminal-parity Phase 3: tables, hashes, gate facts and the base sha folded (open or closed kept for this drawer: ui.tech)
    el('details', { class: 'tech', open: ui.tech, ontoggle: e => { ui.tech = e.currentTarget.open; } }, el('summary', { 'data-role': 'tech' }, 'Tech Details'),
      tasks.length ? el('table', { class: 'table dtable wtable' }, el('caption', { class: 'sr-only' }, 'Tasks: state, attempt, session mode, verified head'),
        el('thead', null, el('tr', null, ...['Task', 'State', 'Attempt', 'Mode', 'Head'].map(h => el('th', { scope: 'col', class: h === 'Attempt' ? 'num' : null }, h)))),
        el('tbody', null, ...tasks.map(x => el('tr', { class: x.id === w.task ? 'cur' : null, 'aria-current': x.id === w.task ? 'step' : null },
          el('td', null, code(String(x.id))), el('td', null, wordPill(x.status)),
          el('td', { class: 'num' }, String(x.attempt ?? DASH)), el('td', null, mode(x)), el('td', null, x.head ? code(String(x.head).slice(0, 12)) : DASH))))) : none(),
      Array.isArray(k.lanes) && k.lanes.length > 0 && el('table', { class: 'table dtable wtable' }, el('caption', { class: 'sr-only' }, 'Lanes: task, ticket, state, waiting, live, attempt'),
        el('thead', null, el('tr', null, ...['Task', 'Lane', 'State', 'Waiting', 'Live', 'Attempt'].map(h => el('th', { scope: 'col', class: h === 'Attempt' ? 'num' : null }, h)))),
        el('tbody', null, ...k.lanes.filter(isObj).map(x => el('tr', null,
          el('td', null, code(String(x.task))), el('td', null, code(String(x.id))), el('td', null, wordPill(x.state, 'gray', STAGE_HUE[x.state] || 'gray')),
          el('td', null, x.waiting ? vis(`${x.waiting.reason}${x.waiting.why ? `: ${x.waiting.why}` : ''}`) : DASH),
          el('td', null, x.live ? 'yes' : 'no'), el('td', { class: 'num' }, String(x.attempt ?? DASH)))))),
      el('dl', { class: 'facts' },
        fact('Gate', g && dot(g.ok === undefined ? '' : g.ok ? 'ok' : 'bad', `${vis(g.kind)} gate ${g.ok === undefined ? 'running' : g.ok ? 'green' : `red${g.class ? ` (${vis(g.class)})` : ''}`}${g.n ? ` · #${g.n}` : ''}`)),
        fact('Tries', String(w.tries ?? 0)), fact('Unit', w.unit_ms == null ? null : `${w.unit_ms} ms`),
        fact('Base checks', base.length ? base.map(([c, x]) => dot(x?.ok ? 'ok' : 'bad', `${vis(c)} ${x?.ok ? 'ok' : 'red'}${Number.isFinite(x?.ms) ? ` · ${secs(x.ms)}` : ''}`)) : null),
        fact('Rework', String(k.rework ?? 0)),
        fact('Plan hashes', hashes.length ? hashes.map(h => el('span', { class: `hash${h === k.plan_hash ? ' cur' : ''}`, title: h === k.plan_hash ? 'the current plan' : 'replaced' }, String(h).slice(0, 12))) : null),
        fact('Base', k.base_sha?.slice(0, 12)))),
    k.rework > 0 && el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Your feedback:'),
      ...Array.from({ length: Math.min(k.rework, 10) }, (_, i) => el('button', { type: 'button', class: 'link-btn', 'data-role': `fb-${i + 1}`, onclick: () => loadFeedback(id, i + 1) }, `Rework ${i + 1}`))),
    fb && (fb.error ? el('p', { class: 'hint' }, fb.error) : keptPre(`${id}:${fb.n}`, { class: 'log', 'data-role': 'feedback', tabindex: '0', 'aria-label': `Your feedback, rework ${fb.n}` }, vis(fb.text))));
}
async function loadFeedback(id, n) {
  try { ui.fb = { id, n, text: (await api('GET', `/api/tickets/${enc(id)}/feedback/${n}`)).text }; } catch (e) { ui.fb = { id, n, error: e.status === 404 ? `No feedback ${n} kept.` : e.message }; }
  redraw();
}

// GateResults newest first, 5 a page (tbd caps a page at 64 KB): per check result, time, exit, flaky, full log link,
// output tail; fail-first verdict + unproven tests, weakening, scope, schema / API changes, allowed_* used / unused, why.
function gatesView(id) {
  const g = ui.gates?.id === id ? ui.gates : null;
  return el('section', { class: 'part', 'aria-labelledby': 'gt-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'gt-h' }, 'Gates'),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'gates', onclick: () => loadGates(id) }, g ? 'Refresh' : 'Show Gates')),
    g && (g.error ? el('p', { class: 'hint' }, g.error) : g.items.length ? el('div', { class: 'gates' }, ...g.items.map((x, i) => gateItem(id, x, i === 0, x === g.items.find(y => y.gate === 'working')))) : el('p', { class: 'hint' }, 'No gate ran yet.')),
    g?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: 'link-btn', 'data-role': 'gates-more', onclick: () => loadGates(id, g.next) }, 'Older Gates')));
}
async function loadGates(id, n) {
  try {
    const r = await api('GET', `/api/tickets/${enc(id)}/gates?limit=5${n == null ? '' : `&n=${n}`}`);
    ui.gates = { id, items: [...(n != null && ui.gates?.id === id ? ui.gates.items : []), ...r.items], next: r.next };
  } catch (e) { ui.gates = { id, items: [], next: null, error: e.message }; }
  redraw();
}
const refreshGates = debounce(() => { if (ui.open && ui.gates?.id === ui.open) loadGates(ui.open); }, 500);
function onGate(e) {
  let d;
  try { d = JSON.parse(e.data); } catch { return; }
  if (d?.id === ui.open && ui.gates?.id === d.id) refreshGates();
}

function gateItem(id, x, newest, latestWorking) {
  if (x.unreadable) return el('p', { class: 'hint' }, `Gate ${x.n}: unreadable.`);
  const t = isObj(x.tests) ? x.tests : {}, sc = isObj(x.scope) ? x.scope : {}, checks = Array.isArray(x.checks) ? x.checks.filter(isObj) : [];
  const list = (label, xs) => (Array.isArray(xs) && xs.length ? fact(label, xs.map(v => code(typeof v === 'string' ? v : v?.path ?? JSON.stringify(v)))) : null);
  const changes = (label, xs) => (Array.isArray(xs) && xs.length ? [el('h4', null, label), el('ul', { class: 'plist' }, ...xs.filter(isObj).map(c => el('li', null,
    code(`${c.op} ${c.ref}`), c.dir ? ` (${vis(c.dir)})` : '', ' ', dot(c.allowed ? 'ok' : 'bad', c.allowed ? 'allowed' : 'not allowed'))))] : null);
  const unused = new Set(Array.isArray(x.unused_allowed) ? x.unused_allowed : []);
  const allowed = latestWorking && ui.plan ? [...(ui.plan.allowed_schema_changes ?? []), ...(ui.plan.allowed_api_changes ?? [])] : [];
  const ff = String(t.failfirst ?? '');
  return el('details', { class: `gate ${x.ok ? 'ok' : 'red'}`, open: newest },
    el('summary', null, el('span', { class: 'did' }, `#${x.n}`), el('span', null, `${vis(x.gate)} gate`, x.task ? [' · ', code(x.task)] : '', x.attempt ? ` · attempt ${x.attempt}` : ''),
      pill(x.ok ? 'mint' : 'rose', x.ok ? 'Green' : `Red${x.class ? `: ${vis(x.class)}` : ''}`), el('span', { class: 'hint' }, [x.ms != null && secs(x.ms), x.truncated && 'cut to fit'].filter(Boolean).join(' · '))),
    checks.length ? el('table', { class: 'table dtable ctable' }, el('caption', { class: 'sr-only' }, `Gate ${x.n}: checks`),
      el('thead', null, el('tr', null, ...['Check', 'Result', 'Time', 'Exit', 'Log'].map(h => el('th', { scope: 'col', class: h === 'Time' || h === 'Exit' ? 'num' : null }, h)))),
      el('tbody', null, ...checks.map(c => el('tr', null,
        el('td', null, code(c.check ?? '?')),
        el('td', null, pill(c.ok ? 'mint' : 'rose', c.ok ? 'OK' : c.timed_out ? 'Timed Out' : 'Red'), c.flaky && [' ', pill('butter', 'Flaky')]),
        el('td', { class: 'num' }, secs(c.ms)), el('td', { class: 'num' }, c.exit == null ? DASH : String(c.exit)),
        el('td', null, c.log ? el('a', { href: `/api/tickets/${enc(id)}/gates/${enc(x.n)}/log?check=${enc(c.check)}`, target: '_blank', rel: 'noopener' }, 'Full Log') : DASH))))) : null,
    ...checks.filter(c => c.tail).map(c => el('details', { class: 'tail' }, el('summary', null, `${vis(c.check)}: output (first and last part)`),
      el('pre', { class: 'log', tabindex: '0', 'aria-label': `${vis(c.check)} output` }, vis(c.tail)))),
    el('dl', { class: 'facts' },
      ff && ff !== 'n/a' && fact('Fail-first', dot(ff.startsWith('proven') ? 'ok' : 'wait', vis(ff))),
      list(ff.startsWith('unproven') ? 'Unproven tests' : 'Test files', t.files), list('Skips added', t.skips_added), list('Tests deleted', t.deleted),
      list('Count drops', t.count_drops), list('Expects removed', t.expects_removed),
      isObj(t.count) && (t.count.pre || t.count.head) ? fact('Test count', `${t.count.pre} before, ${t.count.head} now`) : null,
      list('Outside scope', sc.outside), list('Protected', sc.protected), sc.deps && fact('Dependencies', 'changed'), list('Bad paths', sc.bad),
      list('Migrations', x.migration), list('Flaky', checks.filter(c => c.flaky).map(c => c.check))),
    changes('Schema changes', x.schema), changes('API changes', x.api),
    allowed.length ? [el('h4', null, 'Allowed in the plan'), el('ul', { class: 'plist' }, ...allowed.map(a => el('li', null, code(a), ' ',
      dot(unused.has(a) ? 'wait' : 'ok', unused.has(a) ? 'unused' : 'used'))))] : null,
    isObj(x.ask) && el('p', { class: 'hint' }, `It asked you: ${vis(x.ask.kind)}.`),
    x.why && el('pre', { class: 'log', tabindex: '0', 'aria-label': `Gate ${x.n}: what it found` }, vis(x.why)));
}

// Older / Newer between the kept results of a report (tb report --n): n - 1 / n + 1. Older is disabled at 1 or once tbd said
// 404 for n - 1; Newer past the newest one seen. `go` loads that n.
const pager = (role, n, r, go) => el('div', { class: 'acts pager' },
  el('button', { type: 'button', class: 'link-btn', 'data-role': `${role}-older`, disabled: !(n > 1) || !!r.noOlder, onclick: () => go(n - 1) }, 'Older'),
  el('button', { type: 'button', class: 'link-btn', 'data-role': `${role}-newer`, disabled: !(n < (r.latest ?? n)), onclick: () => go(n + 1) }, 'Newer'));
// the state after asking for report n: the new data (latest = the newest n seen), or on a 404 for an older one the same data with Older off
const paged = (cur, n, data) => ({ data, latest: n == null || cur?.latest == null ? data.n : cur.latest });

// The review loop (lib/review.js): fix n of FIX_MAX, then the newest review's findings from GET …/report?kind=review. Agent text:
// el() / textContent only, never markup. Open = blocking (tbd's one rule); a closed id carries how it was fixed.
function reviewView(id, k) {
  const r = ui.review?.id === id ? ui.review : null;
  const rows = r?.data ? [...r.data.findings.map(x => [x, x.blocking ? 'open' : 'need review', x.failure_scenario]), ...r.data.closed.map(c => [{ id: c.id }, 'closed', c.how])] : [];
  return el('section', { class: 'part', 'aria-labelledby': 'rv-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'rv-h' }, 'Review', el('span', { class: 'count' }, `fix ${k.fixes ?? 0}/${ui.fixMax}`)),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'review', onclick: () => loadReview(id) }, r ? 'Refresh' : 'Show Review')),
    r?.error && el('p', { class: 'hint' }, r.error),
    r?.data && [el('p', { class: 'hint verdict' }, `Review ${r.data.n} `, wordPill(r.data.verdict, 'rose'), r.data.at ? ` · ${when(r.data.at)}` : '', r.data.truncated ? ' · cut to fit' : ''),
      findingsTable(`Review ${r.data.n}: findings`, rows), pager('review', r.data.n, r, n => loadReview(id, n))]);
}
// Review and Final findings, rows [finding, open | need review | closed, scenario or how fixed]. The drawer is 540 px:
// short fields in one row, the long texts in a full-width row under it.
function findingsTable(caption, rows) {
  return rows.length ? el('table', { class: 'table dtable rtable ftable' }, el('caption', { class: 'sr-only' }, caption),
    el('thead', null, el('tr', null, ...['Id', 'Severity', 'Confidence', 'Where', 'State'].map(h => el('th', { scope: 'col' }, h)))),
    el('tbody', null, ...rows.flatMap(([x, st, why]) => [
      el('tr', { class: st === 'closed' ? 'closed' : null }, el('td', null, code(String(x.id))), el('td', null, vis(x.severity ?? DASH)), el('td', null, vis(x.confidence ?? DASH)),
        el('td', null, x.where ? code(x.where) : DASH),
        el('td', null, st === 'open' ? pill('rose', 'Open') : st === 'closed' ? pill('gray', 'Closed') : pill('butter', 'Need Review'))),
      el('tr', { class: 'rdetail' }, el('td', { colSpan: 5 }, ...(st === 'closed' ? [['How fixed', why]] : [['Problem', x.problem], ['Scenario', why], ['Fix', x.fix]])
        .map(([h, v]) => el('p', null, el('b', null, `${h}: `), vis(v || DASH)))))]))) : el('p', { class: 'hint' }, 'No findings.');
}
async function loadReview(id, n) {
  const cur = ui.review?.id === id ? ui.review : null;
  try { ui.review = { ...paged(cur, n, await api('GET', `/api/tickets/${enc(id)}/report?kind=review${n == null ? '' : `&n=${n}`}`)), id }; } catch (e) {
    ui.review = e.status === 404 && n != null && cur?.data ? { ...cur, noOlder: n < cur.data.n } : { id, error: e.status === 404 ? 'No review kept yet.' : e.message };
  }
  redraw();
}

// M5.3 Final (lib/final.js, C11 C13 C20): GET …/report?kind=final (the newest final review: verdict, findings with tbd's
// blocking rule, the doc paths), ?kind=summary (summary.md: the handoff block) and ?kind=verdict (the verdict doc with
// tbd's evidence), loaded together on demand; md as text in a <pre>, never rendered; the verification doc as a link to
// the docs route (tbd checks the path again). Agent text: el() / textContent only, never markup.
const finalText = f => [f.verdict, f.sha && `squash ${String(f.sha).slice(0, 12)}`, f.tested_sha && `tested ${String(f.tested_sha).slice(0, 12)}`].filter(Boolean).join(' · ') || null;
function finalView(id, k) {
  const v = ui.final?.id === id ? ui.final : null, d = v?.final?.data, ver = d && docUrl(id, d.verification_doc);
  const text = (x, role, label) => (x.text != null ? el('pre', { class: 'log', 'data-role': role, tabindex: '0', 'aria-label': label }, vis(x.text)) : el('p', { class: 'hint' }, x.error));
  return el('section', { class: 'part', 'aria-labelledby': 'fn-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'fn-h' }, 'Final', el('span', { class: 'count' }, `fix ${k.fixes ?? 0}/${ui.fixMax}`)),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'final', onclick: () => loadFinal(id) }, v ? 'Refresh' : 'Show Final')),
    v && [...(d ? [el('p', { class: 'hint verdict' }, `Final review ${d.n} `, wordPill(d.verdict, 'rose'), d.at ? ` · ${when(d.at)}` : '', d.truncated ? ' · cut to fit' : ''),
      findingsTable(`Final review ${d.n}: findings`, d.findings.map(x => [x, x.blocking ? 'open' : 'need review', x.failure_scenario])),
      el('p', { class: 'hint' }, 'Verification doc: ', ver ? el('a', { href: ver, target: '_blank', rel: 'noopener' }, vis(d.verification_doc)) : code(String(d.verification_doc ?? DASH))),
      pager('final', d.n, v, n => loadFinal(id, n))]
      : [el('p', { class: 'hint' }, v.final.error)]),
    el('h4', null, 'Summary'), text(v.summary, 'final-summary', 'Summary, as text'),
    el('h4', null, 'Verdict Doc'), text(v.verdict, 'final-verdict', 'Verdict doc with the evidence tbd captured, as text')]);
}
async function loadFinal(id, n) {
  const cur = ui.final?.id === id ? ui.final : null;
  const get = (kind, none, at) => api('GET', `/api/tickets/${enc(id)}/report?kind=${kind}${at == null ? '' : `&n=${at}`}`).then(data => ({ data, text: data.text }), e => ({ error: e.status === 404 ? none : e.message, missing: e.status === 404 }));
  const [final, summary, verdict] = await Promise.all([get('final', 'No final review kept yet.', n),
    get('summary', 'No summary yet: a passing final review writes it.'), get('verdict', 'No verdict doc yet: it comes with a passing final review.', n)]);
  if (n != null && final.missing && cur?.final?.data) ui.final = { ...cur, noOlder: n < cur.final.data.n };
  else ui.final = { id, final, summary, verdict, latest: n == null || cur?.latest == null ? final.data?.n : cur.latest };
  redraw();
}

// QA (lib/qa.js, M5.2 C5 C20): the newest QA result from GET …/report?kind=qa: each case as a summary row + a full-width
// detail row (as Review), its evidence label (captured by tbd: recs tbd made itself; agent-made: screenshots, notes) and
// the need review lines; the report (md) as text in a <pre> and screenshots as <img> from GET …/docs (tbd checks the
// path again); recs (…/report?kind=rec) as curl + status + headers + body (masked by tbd), a page at a time. Agent text:
// el() / textContent only, never markup.
const DOC_RE = /^docs\/((?:verification|verdicts)\/(?:(?!\.\.?\/)[A-Za-z0-9._-]{1,120}\/){0,6}[A-Za-z0-9._-]{1,120}\.(?:md|png))$/; // the docs route's path, docs/ in front
const docUrl = (id, p) => { const m = DOC_RE.exec(p ?? ''); return m && `/api/tickets/${enc(id)}/docs?path=${enc(m[1])}`; };
function qaView(id, k) {
  const q = ui.qa?.id === id ? ui.qa : null, d = q?.data, rec = ui.rec?.id === id ? ui.rec : null;
  const res = x => wordPill(x, 'butter', /^pass$/i.test(x) ? 'mint' : /^fail$/i.test(x) ? 'rose' : 'butter');
  const para = (h, ...v) => el('p', null, el('b', null, `${h}: `), ...v);
  const list = (h, xs) => (Array.isArray(xs) && xs.length ? para(h, ...xs.flatMap((x, i) => [i ? ' ' : '', code(String(x))])) : null);
  const report = d && docUrl(id, d.report);
  return el('section', { class: 'part', 'aria-labelledby': 'qa-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'qa-h' }, 'QA', el('span', { class: 'count' }, `QA ${k.qa.n ?? DASH}`)),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'qa', onclick: () => loadQa(id) }, q ? 'Refresh' : 'Show QA')),
    q?.error && el('p', { class: 'hint' }, q.error),
    d && [el('p', { class: 'hint verdict' }, `QA ${d.n} `, res(d.verdict), d.at ? ` · ${when(d.at)}` : '', d.truncated ? ' · cut to fit' : ''), pager('qa', d.n, q, n => loadQa(id, n)),
      d.need_review.length ? el('div', { class: 'notice' }, el('p', null, el('strong', null, 'Check by hand: '), 'agent-made evidence can be faked.'),
        el('ul', { class: 'plist' }, ...d.need_review.map(x => el('li', null, vis(x))))) : null,
      d.cases.length ? el('table', { class: 'table dtable rtable' }, el('caption', { class: 'sr-only' }, `QA ${d.n}: cases`),
        el('thead', null, el('tr', null, ...['Case', 'Type', 'Kind', 'Result', 'Evidence'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, ...d.cases.flatMap(c => [
          el('tr', null, el('td', null, code(String(c.id))), el('td', null, vis(c.type)), el('td', null, vis(c.kind)),
            el('td', null, res(c.result), c.cause ? ` ${vis(c.cause)}` : ''),
            el('td', null, dot(c.evidence === 'captured by tbd' ? 'ok' : 'wait', vis(c.evidence ?? DASH)))),
          el('tr', { class: 'rdetail' }, el('td', { colSpan: 5 }, para('Source', code(String(c.source ?? DASH))), list('Acceptance', c.acceptance),
            c.pre ? para('Before', vis(c.pre)) : null, para('Steps', vis((Array.isArray(c.steps) ? c.steps : []).join(' · '))), para('Expect', vis(c.expect ?? DASH)),
            para('Observed', isObj(c.observed) && c.observed.status != null ? `${c.observed.status}: ` : '', vis(isObj(c.observed) ? c.observed.note : DASH)),
            list('Recs', c.recs),
            ...(Array.isArray(c.screenshots) ? c.screenshots : []).map(p => (docUrl(id, p) ? el('img', { class: 'shot', src: docUrl(id, p), alt: `${c.id} screenshot ${p}`, loading: 'lazy' }) : list('Screenshot', [p])))))]))) : none(),
      d.findings.length ? el('div', null, el('h4', null, 'Findings'), el('ul', { class: 'plist' }, ...d.findings.map(x => el('li', null, vis(x))))) : null,
      el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Report: ', code(String(d.report ?? DASH))),
        report && el('button', { type: 'button', class: 'link-btn', 'data-role': 'qa-report', onclick: () => loadQaDoc(id, report) }, q.doc ? 'Refresh Report' : 'Show Report')),
      q.doc && (q.doc.error ? el('p', { class: 'hint' }, q.doc.error) : el('pre', { class: 'log', 'data-role': 'qa-doc', tabindex: '0', 'aria-label': 'QA report, as text' }, vis(q.doc.text)))],
    el('div', { class: 'log-head' }, el('h4', null, 'Recs: HTTP Calls tbd Made'),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'recs', onclick: () => loadRecs(id) }, rec ? 'Refresh' : 'Show Recs')),
    rec?.error && el('p', { class: 'hint' }, rec.error),
    rec?.runs?.length > 1 && el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Run'), el('div', { class: 'seg', role: 'group', 'aria-label': 'Run' }, ...rec.runs.map(n => el('button', { type: 'button',
      'aria-pressed': String(n === rec.run), 'data-role': `recs-${n}`, onclick: () => loadRecs(id, n) }, String(n))))),
    rec?.items && (rec.items.length ? rec.items.map(x => el('div', { class: 'rec' },
      el('p', { class: 'hint' }, code(String(x.n)), ` · ${x.status ?? `no answer: ${vis(x.error)}`} · ${x.ms} ms${x.at ? ` · ${when(x.at)}` : ''}${x.truncated ? ' · cut' : ''}`),
      el('pre', { class: 'log', tabindex: '0', 'aria-label': `rec ${vis(x.n)}: curl` }, vis(x.curl)),
      x.status != null && el('pre', { class: 'log', tabindex: '0', 'aria-label': `rec ${vis(x.n)}: answer` },
        vis([`HTTP ${x.status}`, ...(Array.isArray(x.headers) ? x.headers : []).map(([h, v]) => `${h}: ${v}`), '', x.body ?? ''].join('\n'))))) : none()),
    rec?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: 'link-btn', 'data-role': 'recs-more', onclick: () => loadRecs(id, rec.run, rec.next) }, 'Load More')));
}
async function loadQa(id, n) {
  const cur = ui.qa?.id === id ? ui.qa : null;
  try { ui.qa = { ...paged(cur, n, await api('GET', `/api/tickets/${enc(id)}/report?kind=qa${n == null ? '' : `&n=${n}`}`)), id }; } catch (e) {
    ui.qa = e.status === 404 && n != null && cur?.data ? { ...cur, noOlder: n < cur.data.n } : { id, error: e.status === 404 ? 'No QA result kept yet.' : e.message };
  }
  redraw();
}
async function loadQaDoc(id, url) {
  const doc = await api('GET', url, null, true).then(text => ({ text }), e => ({ error: e.status === 404 ? 'The report was not kept.' : e.message }));
  if (ui.qa?.id === id) ui.qa = { ...ui.qa, doc };
  redraw();
}
async function loadRecs(id, run, cursor) {
  try {
    const r = await api('GET', `/api/tickets/${enc(id)}/report?kind=rec${run == null ? '' : `&run=${run}`}${cursor == null ? '' : `&cursor=${cursor}`}`);
    ui.rec = { ...r, id, items: [...(cursor != null && ui.rec?.id === id && ui.rec.run === r.run ? ui.rec.items : []), ...r.items] };
  } catch (e) { ui.rec = { id, error: e.status === 404 ? 'No recs kept yet.' : e.message }; }
  redraw();
}

// interventions.jsonl, oldest first, 20 a page: time, cli or ui, verb, task
function ivsView(id) {
  const v = ui.ivs?.id === id ? ui.ivs : null;
  return el('section', { class: 'part', 'aria-labelledby': 'iv-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'iv-h' }, 'Your Actions'),
      el('button', { type: 'button', class: 'link-btn', 'data-role': 'ivs', onclick: () => loadIvs(id) }, v ? 'Refresh' : 'Show')),
    v && (v.error ? el('p', { class: 'hint' }, v.error) : v.items.length ? el('table', { class: 'table dtable' }, el('caption', { class: 'sr-only' }, 'Your actions on this flow'),
      el('thead', null, el('tr', null, ...['Time', 'By', 'Action', 'Task'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, ...v.items.filter(isObj).map(x => el('tr', null, el('td', null, when(x.at) ?? DASH), el('td', null, vis(x.actor)), el('td', null, vis(x.verb)), el('td', null, x.task ? code(x.task) : DASH))))) : none()),
    v?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: 'link-btn', 'data-role': 'ivs-more', onclick: () => loadIvs(id, v.next) }, 'Show More')));
}
async function loadIvs(id, after) {
  try {
    const r = await api('GET', `/api/tickets/${enc(id)}/interventions?limit=20${after == null ? '' : `&after=${after}`}`);
    ui.ivs = { id, items: [...(after != null && ui.ivs?.id === id ? ui.ivs.items : []), ...r.items], next: r.next };
  } catch (e) { ui.ivs = { id, items: [], next: null, error: e.message }; }
  redraw();
}

// Clarify: the newest questions round. Answers live in ui.drafts (per ticket + round): re-renders and opening another
// ticket keep them; a sent one is dropped.
const draftOf = (id, n) => {
  const key = `${id}:${n}`;
  if (!ui.drafts.has(key)) ui.drafts.set(key, { a: Object.create(null), errs: Object.create(null), comment: '' }); // ids like "constructor" are plain keys
  return ui.drafts.get(key);
};
const answerOf = (a, x) => (a?.mode === 'pick' ? { pick: x.options[a.i] } : a?.mode === 'text' ? ((a.text ?? '').trim() ? { text: a.text.trim() } : null)
  : a?.mode === 'recommended' || a?.mode === 'you_decide' ? { use: a.mode } : null);
const answered = (d, r) => `${r.questions.filter(x => answerOf(d.a[x.id], x)).length} of ${r.questions.length} answered`;

// Phase 5: an ask's round names its phase (tbd writes it, lib/planning.js askFrom): who decides what is left open and the
// SENT roles of the answer buttons follow it; a planning round keeps the planner's copy
const CALLER = { review: 'reviewer', qa: 'QA agent', final_gate: 'final reviewer' };
// Phase 4: a Task's answers always go back into the asking session (planning or working)
const sentOf = r => (CALLER[r.phase] || ui.ticket?.kind === 'task' ? ['answer-on', 'decide-now'] : ['answer', 'plan-now']);
function clarifyForm(id, r) {
  const d = draftOf(id, r.n), who = CALLER[r.phase] ?? (r.phase === 'working' || ui.ticket?.kind === 'task' ? 'agent' : 'planner'), [ans, now] = sentOf(r);
  return el('section', { class: 'part you', 'aria-labelledby': 'cq-h' },
    el('h3', { id: 'cq-h' }, `Questions · Round ${r.n}`),
    el('p', { class: 'hint' }, `Answer each one, or press ${SENT[now][0]}: what you leave open is the ${who}’s call.`),
    el('div', { class: 'acts' }, actBtn(id, 'lavish', () => post(id, 'lavish', {}), { sent: 'lavish' })),
    errLine(id, 'lavish'),
    ...byTopic(r.questions).flatMap(([topic, qs]) => [topic && el('h4', null, vis(topic)), ...qs.map(([x, i]) => question(d, x, i, who))]),
    d.errs._ && el('p', { class: 'err' }, d.errs._),
    el('div', { class: 'acts' },
      actBtn(id, 'answer', () => sendAnswers(id, r, false), { cls: BTN1, sent: ans }),
      actBtn(id, 'plan-now', () => sendAnswers(id, r, true), { sent: now }),
      el('span', { class: 'answered', 'data-count': '' }, answered(d, r))));
}

// questions under one heading per topic, first-appearance order; each keeps its index i (radio names, focus roles)
function byTopic(qs) {
  const g = new Map();
  qs.forEach((x, i) => g.set(x.topic ?? '', [...(g.get(x.topic ?? '') ?? []), [x, i]]));
  return [...g];
}

function question(d, x, i, who = 'planner') {
  const a = d.a[x.id], name = `q${i}`, opts = Array.isArray(x.options) ? x.options : [];
  const set = v => { d.a[x.id] = { ...d.a[x.id], ...v }; delete d.errs[x.id]; };
  // checkmark rows (DESIGN §8: single choice): the radio draws a trailing check when picked
  const radio = (mode, j, ...label) => el('label', { class: 'opt' },
    el('input', { type: 'radio', name, 'data-role': `${name}-${mode}${j ?? ''}`, checked: a?.mode === mode && (j == null || a.i === j),
      onchange: () => { set({ mode, i: j }); redraw(); } }),
    el('span', null, ...label));
  const own = el('textarea', { class: 'input', name: `${name}-own`, rows: 2, maxLength: 10000, 'data-role': `${name}-own`, 'aria-label': `Your own answer to question ${i + 1}`,
    oninput: e => { // typing picks "My own answer"; no re-render per key
      set({ mode: 'text', text: e.target.value });
      e.target.closest('fieldset').querySelector(`[data-role="${name}-text"]`).checked = true;
      $('#drawer [data-count]').textContent = answered(d, ui.round);
    } });
  own.value = a?.text ?? '';
  return el('fieldset', { class: 'q', 'aria-describedby': [`${name}-why`, d.errs[x.id] && `${name}-err`].filter(Boolean).join(' ') },
    el('legend', null, vis(x.question)),
    el('p', { class: 'why', id: `${name}-why` }, 'Why: ', vis(x.why)),
    ...opts.map((o, j) => radio('pick', j, vis(o), o === x.recommended && el('span', { class: 'rmark' }, 'Recommended'))),
    radio('recommended', null, 'Use Recommended', !opts.includes(x.recommended) && [': ', el('b', null, vis(x.recommended))]),
    radio('you_decide', null, 'You Decide', el('span', { class: 'osub' }, `The ${who}’s call`)),
    radio('text', null, 'My Own Answer'),
    own,
    d.errs[x.id] && el('p', { class: 'err', id: `${name}-err` }, d.errs[x.id]));
}

async function sendAnswers(id, r, planNow) {
  const d = draftOf(id, r.n), answers = Object.create(null), [ans, now] = sentOf(r);
  d.errs = Object.create(null);
  for (const x of r.questions) {
    const v = answerOf(d.a[x.id], x);
    if (v) answers[x.id] = v;
    else if (!planNow) d.errs[x.id] = `Not answered yet. Answer it, or press ${SENT[now][0]}.`;
  }
  const open = r.questions.findIndex(x => d.errs[x.id]);
  if (open >= 0) {
    redraw();
    return $(`#drawer [data-role^="q${open}-"]`)?.focus();
  }
  const err = await post(id, 'answer', { answers, ...(planNow && { plan_now: true }) }, planNow ? 'plan-now' : 'answer', planNow ? now : ans);
  if (err == null) ui.drafts.delete(`${id}:${r.n}`); // only this ticket's draft
  else {
    answerErrors(d, r, err);
    if (ui.err?.id === id) ui.err = null;
    redraw();
  }
}

// tbd's 400 names one question (answer to "Q2" must be …), its 409 the open ones (not answered: "Q1", "Q3": …), each
// as JSON.stringify(id.slice(0, 100)). Shown next to those questions, else above the buttons.
function answerErrors(d, r, msg) {
  const one = /answer to ("(?:[^"\\]|\\.)*")/.exec(msg);
  const quoted = one ? [one[1]] : /not answered: (.*): answer every/.exec(msg)?.[1].match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const ids = new Set(quoted.map(s => safe(() => JSON.parse(s))));
  const hit = r.questions.filter(x => ids.has(String(x.id).slice(0, 100)));
  for (const x of hit) d.errs[x.id] = one ? msg : 'Not answered yet.';
  if (!hit.length) d.errs._ = msg;
}

// Spec §5 "at approval": each decision with its source. Same split as lib/metrics.js sourceOf.
function source(s) {
  const m = /^(answer|reject):(.*)$/.exec(s);
  if (m) return ['you', `your ${m[1]} ${m[2]}`];
  if (s.startsWith('ticket')) return ['ticket', 'ticket'];
  if (/^adr/i.test(s)) return ['adr', `ADR ${s.replace(/^adr[:\s-]*/i, '')}`.trim()];
  return ['planner', 'planner’s call'];
}

function planView(id, k, r) {
  const open = k.state === 'plan_approval';
  const list = (xs, fn) => (Array.isArray(xs) && xs.length ? el('ul', { class: 'plist' }, ...xs.map(x => el('li', null, fn(x)))) : none());
  // J17: Irfan's locked decisions first (the planner may leave them out; the same id shows his text), then the planner's
  const locked = Array.isArray(k.locked_decisions) ? k.locked_decisions : [], mine = new Set(locked.map(x => x.id));
  const decs = [...locked, ...(Array.isArray(r.decisions) ? r.decisions : []).filter(x => !mine.has(x.id))].map(x => [x, source(String(x.source ?? ''))]);
  const count = who => decs.filter(([, s]) => s[0] === who).length;
  const tally = [['you', 'yours'], ['ticket', 'from the ticket'], ['adr', 'from ADRs'], ['planner', 'planner’s call', 'planner’s calls']]
    .map(([who, l, many = l]) => count(who) && `${count(who)} ${count(who) === 1 ? l : many}`).filter(Boolean).join(' · ');
  return el('section', { class: `part plan${open ? ' you' : ''}`, 'aria-labelledby': 'pl-h' },
    el('h3', { id: 'pl-h' }, open ? `Plan to Approve · Round ${r.n}` : 'Approved Plan'),
    el('p', { class: 'summary' }, vis(r.summary)),
    // board-terminal-parity Phase 4: a Task's plan is its steps and when it is done; the rest below is a Code plan's
    k.kind === 'task' ? [el('h4', null, 'Steps'), Array.isArray(r.steps) && r.steps.length ? el('ol', { class: 'steps' }, ...r.steps.map(s => el('li', null, vis(s)))) : none(),
      el('h4', null, 'Done When'), list(r.done_when, vis)] : [
    el('h4', null, 'Acceptance Criteria'),
    list(r.acceptance, a => [el('span', { class: 'did' }, vis(a.id)), ' ', vis(a.text), ' ', el('span', { class: `ac${a.type === 'new' ? ' new' : ''}` }, vis(a.type))]),
    el('h4', null, 'Tasks'),
    Array.isArray(r.tasks) && r.tasks.length ? el('ol', { class: 'tasks' }, ...r.tasks.map(task)) : none(),
    el('h4', null, 'Schema Changes Allowed'), list(r.allowed_schema_changes, vis),
    el('h4', null, 'API Changes Allowed'), list(r.allowed_api_changes, vis),
    el('h4', null, 'Skills for Working'),
    Array.isArray(r.skills) && r.skills.length ? el('p', { class: 'toks' }, ...r.skills.map(code)) : none(),
    r.ui && [el('h4', null, 'UI'), el('p', { class: 'ctext' }, vis(r.ui))],
    el('h4', null, 'Child Tickets'),
    list(r.children, c => [el('strong', null, vis(c.title)), c.blocked_by?.length ? ` · waits for ${c.blocked_by.map(vis).join(', ')}` : '', el('span', { class: 'ctext' }, vis(c.text))])],
    el('h4', null, 'Decisions'),
    decs.length ? [el('p', { class: 'hint' }, tally), el('table', { class: 'table dtable' },
      el('caption', { class: 'sr-only' }, 'Decisions and their source'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Decision'), el('th', { scope: 'col' }, 'Source'))),
      el('tbody', null, ...decs.map(([x, [who, label]]) => el('tr', { class: who },
        el('td', null, el('span', { class: 'did' }, vis(x.id)), ' ', vis(x.text)),
        el('td', null, el('span', { class: `src ${who}`, title: vis(x.source) }, vis(label)))))))] : none(),
    open && k.waiting?.reason !== 'setup' && planActs(id, k, r)); // Reject is refused while setup runs
}

const task = t => el('li', { class: 'task' },
  el('p', null, el('span', { class: 'did' }, vis(t.id)), ' ', el('strong', null, vis(t.title)), t.type && [' ', el('span', { class: 'tt' }, vis(t.type))]),
  el('dl', { class: 'facts' },
    el('dt', null, 'Files'), el('dd', null, ...(t.files?.length ? t.files.map(code) : ['none'])),
    t.modules?.length > 0 && [el('dt', null, 'Modules'), el('dd', null, ...t.modules.map(code))],
    el('dt', null, 'Blocked by'), el('dd', null, t.blocked_by?.length ? t.blocked_by.map(vis).join(', ') : 'nothing'),
    el('dt', null, 'Test'), el('dd', null, t.test_cmd ? code(t.test_cmd) : 'none')),
  t.steps?.length > 0 && el('ol', { class: 'steps' }, ...t.steps.map(s => el('li', null, vis(s)))));

function planActs(id, k, r) {
  const d = draftOf(id, r.n);
  if (!ui.shown.has(`${id}:${r.n}`)) ui.shown.set(`${id}:${r.n}`, Date.now());
  const box = el('textarea', { id: 'rj', name: 'comment', rows: 3, maxLength: 10000, 'data-role': 'comment', 'aria-describedby': d.errs.comment ? 'rj-err' : null,
    oninput: e => { d.comment = e.target.value; } });
  box.value = d.comment;
  return el('div', { class: 'part' },
    el('div', { class: 'field' }, el('label', { for: 'rj' }, 'Comment for Reject or Ask Me More'), box,
      d.errs.comment && el('p', { class: 'err', id: 'rj-err' }, d.errs.comment)),
    el('div', { class: 'acts' },
      k.waiting?.reason !== 'setup_failed' && actBtn(id, 'approve', () => approve(id, r.n), { cls: BTN1 }),
      actBtn(id, 'reject', () => sendReject(id, r, false)),
      actBtn(id, 'ask', () => sendReject(id, r, true))),
    errLine(id, 'approve', 'reject', 'ask'));
}

// board-terminal-parity 6.4: one click (no arm). A double click is one post (ui.busy); a held Enter repeats nothing (the
// drawer's e.repeat block); a click in the first 400 ms after this round's plan showed is ignored (a click meant for
// what was there before it).
function approve(id, n) {
  if (Date.now() - (ui.shown.get(`${id}:${n}`) ?? 0) < 400) return;
  post(id, 'approve', ui.round?.n === undefined ? undefined : { n: ui.round.n }, 'approve', ui.ticket?.kind === 'task' ? 'task-approve' : 'approve'); // L7: the round shown; tbd refuses (409) when a newer one came
}

function sendReject(id, r, ask) {
  const d = draftOf(id, r.n), comment = d.comment.trim();
  if (!comment) {
    d.errs.comment = ask ? 'Write what you want to be asked about.' : 'Write what should change.';
    redraw();
    return $('#drawer [data-role="comment"]')?.focus();
  }
  delete d.errs.comment;
  post(id, 'reject', { comment, ...(ask && { ask: true }) }, ask ? 'ask' : 'reject').then(err => { if (err == null) ui.drafts.delete(`${id}:${r.n}`); });
}

// ---------- toolbar: search (⌘K), New (N) ----------
// flows need a leaf tag that has a path (a tag with children is only a group)
const leafTags = tags => Object.keys(tags).filter(n => tags[n]?.path && !Object.keys(tags).some(o => o.startsWith(`${n}/`))).sort();
const ADD_TAG = '+add-tag'; // the New sheet's Tag list: its last option opens Add Tag, it is never a value
const addTagOpt = () => el('option', { value: ADD_TAG }, 'Add Tag…');
const tagOptions = sel => [el('option', { value: '' }, 'No Tag'), ...ui.tags.map(n => el('option', { value: n, selected: n === sel }, n))];
// board-terminal-parity 6.7: a toast title for a refusal. tbd's own words are the toast text (err.message): the title is
// the action that failed; "Not Available Yet" only for a 409 that came without words
const refused = (err, fallback) => (err.status === 409 && !err.server ? 'Not Available Yet' : fallback);

async function loadTags() {
  if (ui.tagsLoaded) return;
  try {
    ui.tags = leafTags((await api('GET', '/api/tags')).tags || {});
    ui.tagsLoaded = true;
    $('#tag-names')?.replaceChildren(...[...new Set([...ui.tags, ...Object.keys(ui.tagDefs)])].sort().map(n => el('option', { value: n })));
    const ft = $('#sheet select[name="tag"]');
    if (ft) ft.replaceChildren(...tagOptions(ft.value), addTagOpt());
    if (ui.promote) renderReminders();
  } catch (e) { toast(e.message, { title: 'Couldn’t Load Tags' }); }
}

function initToolbar() {
  // lucide icons for the static markup (nav, search, clear, System, New): the CSP allows no icon files
  for (const n of document.querySelectorAll('[data-icon]')) n.prepend(icon(n.dataset.icon, n.closest('.nav') ? 'icon-18' : ''));
  $('#newBtn').addEventListener('click', () => openNew(root.dataset.view === 'flows' ? 'flow' : 'reminder'));
  const q = $('#q');
  const search = () => { ui.q = q.value.trim().toLowerCase(); renderReminders(); };
  q.addEventListener('input', search);
  q.addEventListener('keydown', e => { if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; search(); } });
  $('#qClear').addEventListener('click', () => { q.value = ''; search(); q.focus(); });
}

// N opens the New sheet (not while typing, not over a sheet or the drawer, only where New shows);
// ⌘K / Ctrl+K focuses the Reminders search
const TYPING = 'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"]), textarea, select, [contenteditable]';
document.addEventListener('keydown', e => {
  if (ui.locked || e.repeat || e.isComposing) return;
  const k = String(e.key).toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.altKey && k === 'k' && root.dataset.view === 'reminders' && !sheetOpen()) {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  } else if (k === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target?.matches?.(TYPING)
    && !sheetOpen() && !$('#drawer').open && ADDS.has(root.dataset.view)) {
    e.preventDefault();
    openNew(root.dataset.view === 'flows' ? 'flow' : 'reminder');
  }
});

// one add (send() posts it) from the New sheet → true when tbd took it. A flow sent with Start Now that tbd could not
// assign (started false) stays in Backlog: why it did not start shows as a card (a reason is longer than a capsule)
async function addItem(flow, send) {
  try {
    const r = await send();
    refresh();
    if (r?.started === false) toast(vis(r.why ?? 'tbd gave no reason.'), { kind: 'warn', title: 'Added to Backlog' });
    else if (root.dataset.view !== (flow ? 'flows' : 'reminders')) toast(!flow ? 'The reminder is in Inbox.' : r?.started ? 'The flow is planning.' : 'The flow is in Backlog.', { kind: 'info', title: r?.started ? 'Started' : 'Added' }); // it landed out of sight
    return true;
  } catch (err) {
    toast(err.message, { title: refused(err, `Couldn’t Add ${flow ? 'Flow' : 'Reminder'}`) });
    return false;
  }
}

// ---------- sheets (foundation .scrim > .sheet): the New sheet, the copy-command forms ----------
// Desktop: centered on --canvas, fields a grouped list on --surface, Cancel (Gray) then the action (Prominent) bottom right.
// Phones: a bottom sheet with a grabber (foundation). Esc, Cancel and a click outside close it; while the New sheet holds
// typed text (sheetGuard) they ask first, inline in the action row.
let sheetOpener = null, sheetGuard = null, asking = null, sheetBack = null; // asking: the action row's buttons while the question shows; sheetBack: what runs after this sheet closes (Add Tag from the New sheet → New again)
const sheetOpen = () => $('#sheet').classList.contains('open');
function openSheet(title, sub, fields, actions, first, { head, after = [], inline = false } = {}) { // inline: label leading, control trailing
  const form = $('#sheet .sheet');
  if (!sheetOpen()) sheetOpener = document.activeElement; // a Reminder ↔ Flow switch opens over itself: keep the first opener
  sheetGuard = asking = sheetBack = form.onkeydown = null;
  form.replaceChildren(el('div', { class: 'grabber', 'aria-hidden': 'true' }),
    el('div', { class: 'sheet-head' }, el('div', null, el('h2', { class: 'sheet-title', id: 'sheet-title' }, title), sub && el('p', { class: 'sheet-sub' }, sub)), head),
    el('div', { class: `sheet-fields${inline ? ' inline' : ''}` }, ...fields), ...after, el('div', { class: 'sheet-actions' }, ...actions));
  $('#sheet').classList.add('open');
  $('.shell').inert = true;
  first?.focus();
  return form;
}
function closeSheet(force) { // force === true: no question (added, or Discard); a click handler passes its event
  if (force !== true && sheetGuard?.dirty()) return asking ? undefined : askDiscard();
  $('#sheet').classList.remove('open');
  $('.shell').inert = false;
  sheetGuard = asking = null;
  sheetOpener?.focus();
  const back = sheetBack;
  sheetBack = null;
  back?.();
}
function askDiscard(discard = () => closeSheet(true)) { // discard: what Discard does (close, or a Reminder ↔ Flow switch)
  const row = $('#sheet .sheet-actions');
  asking = [...row.children];
  const keep = el('button', { type: 'button', class: 'btn btn-gray', 'data-role': 'sheet-keep', onclick: keepEditing }, 'Keep Editing');
  row.classList.add('sheet-ask');
  row.replaceChildren(el('p', null, `Discard This ${sheetGuard.what}?`), keep,
    el('button', { type: 'button', class: 'btn btn-danger-fill', 'data-role': 'sheet-discard', onclick: () => discard() }, 'Discard'));
  keep.focus();
}
function keepEditing() {
  const row = $('#sheet .sheet-actions');
  row.classList.remove('sheet-ask');
  row.replaceChildren(...asking);
  asking = null;
  sheetGuard?.first.focus();
}
const cancelBtn = () => el('button', { type: 'button', class: 'btn btn-gray', 'data-role': 'sheet-cancel', onclick: closeSheet }, 'Cancel');
$('#sheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeSheet(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !sheetOpen()) return;
  e.preventDefault();
  if (asking) keepEditing(); else closeSheet();
});

// Labelled fields of a sheet. spec {k, label, kind: text|area|date|select|check, opts [[value, label]], hint, ph, list (a
// datalist id), after (nodes under the control)}; init {k: value}.
// → nodes, vals() (trimmed strings, checkboxes as booleans) and fail(errors) which writes {k: message} under the fields.
let sfn = 0;
function sheetFields(specs, init, onChange) {
  const ctl = {}, errs = {};
  const nodes = specs.map(sp => {
    const id = `sf${++sfn}`, v = init[sp.k] ?? '';
    const c = sp.kind === 'select' ? el('select', { id, name: sp.k, class: 'input', onchange: onChange }, ...sp.opts.map(([val, l]) => el('option', { value: val, selected: val === v }, l)))
      : sp.kind === 'area' ? el('textarea', { id, name: sp.k, class: 'input', rows: 3, oninput: onChange })
      : sp.kind === 'check' ? el('input', { id, name: sp.k, class: 'check', type: 'checkbox', checked: !!v, onchange: onChange })
      : el('input', { id, name: sp.k, class: 'input', type: sp.kind === 'date' ? 'date' : 'text', autocomplete: 'off', spellcheck: 'false', placeholder: sp.ph, list: sp.list, oninput: onChange });
    if (sp.kind !== 'select' && sp.kind !== 'check') c.value = v;
    ctl[sp.k] = c;
    errs[sp.k] = el('p', { class: 'err', id: `${id}-err` });
    c.setAttribute('aria-describedby', `${id}-err${sp.hint ? ` ${id}-hint` : ''}`);
    return el('div', { class: `sf${sp.kind === 'check' ? ' sf-check' : ''}` }, el('label', { for: id }, sp.label), c,
      sp.after && el('div', { class: 'sf-after' }, ...sp.after), sp.hint && el('p', { class: 'hint', id: `${id}-hint` }, sp.hint), errs[sp.k]);
  });
  const vals = () => Object.fromEntries(specs.map(sp => [sp.k, sp.kind === 'check' ? ctl[sp.k].checked : sp.kind === 'select' ? ctl[sp.k].value : ctl[sp.k].value.trim()]));
  const fail = errors => { for (const sp of specs) errs[sp.k].replaceChildren(...(errors[sp.k] ? [errors[sp.k]] : [])); };
  return { nodes, vals, fail, ctl };
}

// flow-form-parallel-terminal Phase 1: `@` at a word start lists the picked tag's files the same way (GET /api/files?tag=&q=,
// asked as the word is typed, 150 ms after the last key, an older answer dropped); a pick inserts `@path `. No chips for files.
// board-terminal-parity 5 (B7): skills in the Goal box. `/` at a word start lists the skills tbd knows for the tag (GET
// /api/skills?tag=, read once per tag while the sheet is open): the textarea is an ARIA combobox over a listbox; ↑ ↓
// move, Enter / Tab insert `/name `, Esc closes, a click picks. The text is the one source: the chips under it mirror its
// /names that name a known skill (× takes that token out); Add Skill opens the list to add at the end. Names and
// descriptions come from SKILL.md files (a tag repo's too): text only, vis(). → {nodes (under the box), wire(textarea, tag select)}
const ASK_RE = /(^|\s)\/([a-z0-9][\w:.-]{0,63})(?=$|[\s,;!?)])/g; // the same in lib/skills.js ASK_RE (the /names tbd reads from the goal): keep both identical
const AT_WORD = /(^|\s)(?:\/([\w:.-]{0,63})|@(\S{0,200}))$/; // the /word (group 2) or @word (group 3) the caret ends, while it is typed
const SKILLS_SHOWN = 50; // ponytail: the first 50 matches render (tbd lists ≤ 500); typing narrows the rest
function skillsBox() {
  const list = el('ul', { id: 'skill-list', role: 'listbox', class: 'popmenu skill-pop', 'aria-label': 'Skills', hidden: true, onmousedown: e => e.preventDefault() }); // a scrollbar click keeps the box focused: the list stays open
  const chips = el('div', { class: 'skill-chips' });
  const add = el('button', { type: 'button', class: 'link-btn', 'data-role': 'add-skill' }, 'Add Skill');
  const cache = new Map(); // tag → its skills (a promise)
  let ta, tagSel, all = [], loading = true, open = false, items = [], at = 0, query = '', from = null, kind = '/', files = [], filesMore = false, filesBusy = false, filesSeq = 0, filesFailed = null; // from: where the /word starts; -1: the end of the text (Add Skill); kind: / skills, @ files

  const mirror = () => {
    const names = new Set(all.map(s => s.name));
    const seen = [...new Set([...ta.value.matchAll(ASK_RE)].map(m => m[2]))].filter(n => names.has(n));
    chips.replaceChildren(...seen.map(n => el('button', { type: 'button', class: 'filter-chip', 'data-role': `skill-chip-${n}`,
      'aria-label': `Remove skill /${vis(n)}`, onclick: () => drop(n) }, `/${vis(n)}`, icon('close'))));
  };
  const drop = n => { // every /n token out of the text, with one space after it
    let out = '', i = 0;
    for (const m of ta.value.matchAll(ASK_RE)) {
      if (m[2] !== n) continue;
      const s = m.index + m[1].length, e = m.index + m[0].length;
      out += ta.value.slice(i, s);
      i = ta.value[e] === ' ' ? e + 1 : e;
    }
    ta.value = out + ta.value.slice(i);
    mirror();
    ta.focus();
  };
  const close = () => {
    from = null;
    open = false;
    list.hidden = true;
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
  };
  const show = () => { // prefix matches first, then the rest that hold the query
    const q = query.toLowerCase(), low = s => String(s.name).toLowerCase();
    items = kind === '@' ? files.map(name => ({ name })) // the server matched them
      : [...all.filter(s => low(s).startsWith(q)), ...all.filter(s => !low(s).startsWith(q) && low(s).includes(q))].slice(0, SKILLS_SHOWN);
    list.setAttribute('aria-label', kind === '@' ? 'Files' : 'Skills');
    at = Math.min(at, Math.max(items.length - 1, 0));
    list.replaceChildren(...(items.length ? items.map((s, i) => el('li', { id: `skill-opt-${i}`, role: 'option', class: 'popmenu-item skill-opt', 'aria-selected': String(i === at),
      onmousedown: e => e.preventDefault(), onclick: () => pick(i) }, // mousedown: the box keeps focus
    el('span', { class: 'skill-name' }, `${kind}${vis(s.name)}`), s.description && el('span', { class: 'skill-desc' }, vis(s.description))))
      : [el('li', { role: 'option', 'aria-disabled': 'true', class: 'skill-none' }, kind === '@' ? (!tagSel.value ? 'Pick a tag to list its files.' : filesBusy ? 'Loading files…' : 'No file matches.')
        : loading ? 'Loading skills…' : all.length ? 'No skill matches.' : 'No skills found.')]).concat(kind === '@' && filesMore && items.length ? [el('li', { role: 'option', 'aria-disabled': 'true', class: 'skill-none' }, 'More files: type more of the name.')] : []));
    open = true;
    list.hidden = false;
    ta.setAttribute('aria-expanded', 'true');
    if (items.length) ta.setAttribute('aria-activedescendant', `skill-opt-${at}`); else ta.removeAttribute('aria-activedescendant');
    $(`#skill-opt-${at}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const fetchFiles = debounce(async () => { // the old list stays until the reply; a closed list reads nothing
    const tag = tagSel.value, q = query, mine = ++filesSeq;
    if (!tag || !open || kind !== '@') return void (filesBusy = false);
    let got = [], more = false;
    try {
      const r = await api('GET', `/api/files?tag=${enc(tag)}&q=${enc(q)}`);
      got = r.files;
      more = r.more === true;
      filesFailed = null;
    } catch (e) {
      if (filesFailed !== tag) toast(e.message, { title: 'Couldn’t Load Files' }); // once per tag, not per word
      filesFailed = tag;
    }
    if (mine !== filesSeq) return; // typed on, or the tag changed: a newer read fills the list
    files = Array.isArray(got) ? got.filter(x => typeof x === 'string') : [];
    filesMore = more;
    filesBusy = false;
    if (open && kind === '@') show();
  }, 150);
  const readFiles = () => { // @: ask tbd for the tag's files that match the word, once typing pauses
    filesBusy = !!tagSel.value;
    fetchFiles();
  };
  const refresh = () => { // the /word or @word at the caret opens, narrows or closes the list (Add Skill's list stays until a pick or Esc)
    if (from === -1) return;
    const end = ta.selectionStart, m = ta.selectionEnd === end && AT_WORD.exec(ta.value.slice(0, end));
    if (!m) return close();
    const k = m[3] === undefined ? '/' : '@', word = m[3] ?? m[2];
    if (word !== query || k !== kind) { at = 0; if (k === '@') readFiles(); }
    from = end - word.length - 1;
    query = word;
    kind = k;
    show();
  };
  const pick = i => {
    const s = items[i], v = ta.value;
    if (!s) return close();
    const ins = kind === '@' && /\s/.test(s.name) ? `@"${s.name}" ` : `${kind}${s.name} `; // a path with a space is quoted: the agent reads @"my file.js"
    let pos;
    if (from === -1) {
      ta.value = `${v}${v && !/\s$/.test(v) ? ' ' : ''}${ins}`;
      pos = ta.value.length;
    } else {
      ta.value = v.slice(0, from) + ins + v.slice(ta.selectionStart);
      pos = from + ins.length;
    }
    close();
    ta.focus();
    ta.setSelectionRange(pos, pos);
    mirror();
  };
  const keys = e => {
    if (!open || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) { at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; show(); }
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!items.length && e.key === 'Tab') return close();
      e.preventDefault();
      e.stopPropagation(); // never the sheet's Enter-to-add while the list is open
      if (items.length) pick(at); else close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // closes the list, not the sheet
      close();
    } else if (e.key === 'Enter') close(); // Shift+Enter: a new line
  };
  const load = async () => {
    const tag = tagSel.value;
    if (!cache.has(tag)) {
      cache.set(tag, api('GET', `/api/skills?tag=${enc(tag)}`).then(r => (Array.isArray(r.skills) ? r.skills.filter(s => isObj(s) && typeof s.name === 'string') : []),
        e => { cache.delete(tag); toast(e.message, { title: 'Couldn’t Load Skills' }); return []; }));
    }
    const got = await cache.get(tag);
    if (tagSel.value !== tag) return; // the tag changed meanwhile: its own read fills the list
    all = got;
    loading = false;
    mirror();
    if (open) show();
  };
  function wire(t, s) {
    ta = t;
    tagSel = s;
    for (const [k, v] of [['role', 'combobox'], ['aria-autocomplete', 'list'], ['aria-expanded', 'false'], ['aria-controls', 'skill-list']]) ta.setAttribute(k, v);
    ta.addEventListener('input', () => { if (from === -1) from = null; refresh(); mirror(); });
    ta.addEventListener('click', refresh);
    ta.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refresh(); });
    ta.addEventListener('keydown', keys);
    ta.addEventListener('blur', close);
    tagSel.addEventListener('change', () => { loading = true; load(); if (kind === '@') { files = []; filesMore = false; filesFailed = null; readFiles(); if (open) show(); } });
    add.addEventListener('click', () => { ta.focus(); from = -1; query = ''; kind = '/'; at = 0; show(); });
    load();
  }
  return { nodes: [list, el('div', { class: 'skill-bar' }, chips, add)], wire };
}

// The New sheet (D-0149 / D-0156 / D-0166 fields, calm plan Q4): a reminder with column, due, project, note and tag, or a
// flow with a goal (skills: skillsBox), short title, kind, tag, locked run and Start Now. mode 'reminder' | 'flow' (the Flows view's empty state calls
// openNew('flow')); typed carries the title / goal across a Reminder ↔ Flow switch (asked first when another field holds
// text: it would be lost). Enter adds; in a note or goal Shift+Enter is a new line.
function openNew(mode = 'reminder', typed = '') { // typed: the title / goal text, or (Add Tag came back) the flow's whole draft {text, title, kind, tag, sandbox, start}
  const flow = mode === 'flow', main = flow ? 'text' : 'title';
  const sk = flow && skillsBox();
  const specs = flow ? [
    { k: 'text', label: 'Goal for the Agent', kind: 'area', after: sk.nodes },
    { k: 'title', label: 'Short Title', kind: 'text', hint: 'Optional. The board shows it instead of the goal.' },
    { k: 'kind', label: 'Kind', kind: 'select', opts: kinds().map(k => [k, kindLabel(k)]) },
    { k: 'tag', label: 'Tag', kind: 'select', opts: [['', 'No Tag'], ...ui.tags.map(n => [n, n]), [ADD_TAG, 'Add Tag…']],
      after: [el('button', { type: 'button', class: 'link-btn', 'data-role': 'add-tag', onclick: () => addTagFrom() }, 'Add Tag…')] },
    { k: 'sandbox', label: 'Locked run: for untrusted text (an issue, a pasted log). Fewer tools, slower.', kind: 'check' },
    // board-terminal-parity 6.1: create and assign in one step (tbd's assign checks); the choice is remembered
    { k: 'start', label: 'Start Now', kind: 'check', hint: 'Planning starts at once. If it can’t, the flow stays in Backlog and says why.' },
  ] : [
    { k: 'title', label: 'Title', kind: 'text' },
    { k: 'status', label: 'Column', kind: 'select', opts: COLS.slice(0, 4) },
    { k: 'due', label: 'Due', kind: 'date' },
    { k: 'project', label: 'Project', kind: 'text' },
    { k: 'note', label: 'Note', kind: 'area' },
    { k: 'tag', label: 'Tag', kind: 'text', ph: 'shop/api' },
  ];
  const f = sheetFields(specs, flow ? { kind: kinds()[0], start: safe(() => localStorage.getItem('tb-start-now')) !== '0', ...(typeof typed === 'string' ? { text: typed } : typed) } : { title: typed, status: 'inbox' }, () => {});
  // Add Tag replaces this sheet; it comes back with every field kept, on the new tag (or the old one after Cancel)
  const addTagFrom = () => {
    const d = { ...f.vals(), text: f.ctl.text.value };
    addTag(async name => {
      if (name) { await loadTags(); if (!ui.tags.includes(name)) ui.tags = [...ui.tags, name].sort(); } // a failed read still shows the new tag
      else ui.tagsLoaded = false; // the copy form may have added it: read again
      openNew('flow', name ? { ...d, tag: name } : d);
    });
  };
  if (flow) {
    loadTags();
    let tagWas = f.ctl.tag.value;
    f.ctl.tag.addEventListener('change', e => { // before the skills box hears it: the sentinel is no tag
      if (e.target.value !== ADD_TAG) return void (tagWas = e.target.value);
      e.stopImmediatePropagation();
      e.target.value = tagWas;
      addTagFrom();
    });
    sk.wire(f.ctl.text, f.ctl.tag);
    f.ctl.start.addEventListener('change', e => safe(() => localStorage.setItem('tb-start-now', e.target.checked ? '1' : '0')));
    // Phase 4 F: a Task never takes a locked run (tbd refuses it): the box hides and clears while Kind is Task
    const lock = f.nodes[specs.findIndex(sp => sp.k === 'sandbox')];
    const lockFor = () => { lock.hidden = f.ctl.kind.value === 'task'; if (lock.hidden) f.ctl.sandbox.checked = false; };
    f.ctl.kind.addEventListener('change', lockFor);
    lockFor();
  }
  const typedIn = sp => sp.kind !== 'select' && sp.kind !== 'check' && f.ctl[sp.k].value.trim();
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Item type' }, ...[['reminder', 'Reminder'], ['flow', 'Flow']].map(([m, l]) =>
    el('button', { type: 'button', value: m, 'aria-pressed': String(flow === (m === 'flow')), onclick: () => {
      if (flow === (m === 'flow') || asking) return;
      const go = () => openNew(m, f.ctl[main].value);
      if (specs.some(sp => sp.k !== main && typedIn(sp))) askDiscard(go); else go();
    } }, l)));
  const add = el('button', { type: 'submit', class: 'btn', 'data-role': 'sheet-add' }, 'Add');
  const form = openSheet(flow ? 'New Flow' : 'New Reminder', null, f.nodes, [cancelBtn(), add], f.ctl[main], { head: seg, inline: true });
  sheetGuard = { what: flow ? 'Flow' : 'Reminder', first: f.ctl[main], dirty: () => specs.some(typedIn) };
  // Add is out of the form while the discard question shows: requestSubmit would throw on it
  form.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.tagName === 'TEXTAREA') { e.preventDefault(); if (!e.repeat && !add.disabled && add.isConnected) form.requestSubmit(add); } };
  const submit = form.onsubmit = async e => {
    e.preventDefault();
    if (add.disabled) return; // one add in flight: a second Enter must not post a second flow (flows have no server dedupe)
    const v = f.vals();
    const bad = !v[main] ? { [main]: flow ? 'Write the goal first.' : 'Type a title first.' }
      : !flow && v.tag && !TAG_RE.test(v.tag) ? { tag: 'Use lowercase letters, digits and -; a/b for a child.' } : null;
    f.fail(bad || {});
    if (bad) return f.ctl[Object.keys(bad)[0]].focus();
    add.disabled = true;
    // empty optional fields are undefined: JSON leaves them out. An Inbox add goes on top (the old composer line's body);
    // another column keeps the server's default, as the old More… sheet posted
    const sent = await addItem(flow, () => (flow ? api('POST', '/api/flows', { text: v.text, title: v.title || undefined, kind: v.kind, tag: v.tag && v.tag !== ADD_TAG ? v.tag : undefined, sandbox: v.sandbox || undefined, start: v.start || undefined })
      : api('POST', '/api/reminders', { title: v.title, status: v.status, pos: v.status === 'inbox' ? 'top' : undefined, due: v.due || undefined, project: v.project || undefined, note: v.note || undefined, tag: v.tag || undefined })));
    if (sent && form.onsubmit === submit && sheetOpen()) closeSheet(true); // a Reminder ↔ Flow switch (or another sheet) since: not this one to close
    add.disabled = false;
  };
}

// ---------- copy-command forms (D-0172): tag-add, doctor, gc, eval ----------
// The page never posts to a CLI-only route (agent wall, D39). Each form builds the exact `tb …` line from labelled fields;
// Copy puts it on the clipboard and Irfan pastes it in Terminal. Every value is quoted by shq() (the only quoting there is);
// the checks are the ones lib/cli.js and lib/tags.js run, and Copy stays off while one fails.
const shq = x => `'${String(x).replaceAll("'", "'\\''")}'`; // always wrapped; ' → '\''
const shpath = x => (x === '~' ? '~' : x.startsWith('~/') ? `~/${shq(x.slice(2))}` : shq(x)); // ~ must stay unquoted for the shell to expand it (tb tag add resolves the path itself)
const flag = (n, v) => (v ? `--${n} ${shq(v)}` : '');
const words = (...p) => p.filter(Boolean).join(' ');
const validName = x => x.length <= 100 && TAG_RE.test(x); // lib/tags.js validName
const portsOk = x => /^\d{1,5}(,\d{1,5}){0,99}$/.test(x) && x.split(',').every(n => +n >= 1 && +n <= 65535); // cli.js CHECK['qa-ports']
const remoteOk = x => /^(?!-)[A-Za-z0-9._-]{1,64}$/.test(x); // lib/tags.js push.remote
const jsonOf = (x, arr) => { try { const j = JSON.parse(x); return arr ? Array.isArray(j) : j !== null && typeof j === 'object' && !Array.isArray(j); } catch { return false; } };
const DB = [['', 'Leave as it is'], ['local', 'local'], ['none', 'none']];
const TAG_FLAGS = [ // tag add and doctor --tag share these: merged into the tag
  { k: 'ident', label: 'Author with my git name and email (--ident)', kind: 'check' },
  { k: 'push-remote', label: 'Push remote', kind: 'text', ph: 'origin', hint: 'A remote name in the repo (https only).' },
  { k: 'qa-ports', label: 'QA ports', kind: 'text', ph: '3000,3001', hint: 'Ports QA may call, 1 to 65535.' },
  { k: 'db', label: 'Local database', kind: 'select', opts: DB },
];
function tagFlags(v, bad) {
  if (v['push-remote'] && !remoteOk(v['push-remote'])) bad('push-remote', 'Use a remote name: letters, digits, . _ - (not starting with -).');
  if (v['qa-ports'] && !portsOk(v['qa-ports'])) bad('qa-ports', 'Use ports from 1 to 65535, e.g. 3000,3001.');
  return [v.ident && '--ident', flag('push-remote', v['push-remote']), flag('qa-ports', v['qa-ports']), flag('db', v.db)];
}
const ONLY = ['golden', 'planner', 'review', 'qa', 'final_gate'];
const CMDS = {
  'tag-add': {
    title: 'Add Tag', sub: 'Builds a tb tag add command. The flags replace the whole tag, except ident, push remote, QA ports, database and skills off alone: those merge into the tag you have.',
    fields: [
      { k: 'name', label: 'Name', kind: 'text', ph: 'shop/api', hint: 'Lowercase letters, digits and -. Use a/b for a child.' },
      { k: 'type', label: 'Type', kind: 'select', opts: [['', 'None (a group)'], ['git', 'git'], ['folder', 'folder']] },
      { k: 'path', label: 'Path', kind: 'text', ph: '~/code/shop-api', hint: 'With a type.' },
      { k: 'base', label: 'Base branch', kind: 'text', ph: 'main', hint: 'git needs one.' },
      { k: 'setup', label: 'Setup command', kind: 'text' },
      { k: 'output', label: 'Output folder', kind: 'text' },
      { k: 'env-files', label: 'Env files', kind: 'text', hint: 'A comma list.' },
      { k: 'context', label: 'Context files', kind: 'text', hint: 'A comma list.' },
      { k: 'skills', label: 'Skills', kind: 'text', hint: 'A comma list.' },
      { k: 'skills-off', label: 'Skills off', kind: 'text', hint: 'Board default skills this tag removes. A comma list.' }, // full-access-runs Phase 8
      { k: 'checks', label: 'Checks', kind: 'text', ph: '{"lint":"npm run lint"}', hint: 'A JSON object.' },
      { k: 'heavy', label: 'Heavy commands', kind: 'text', ph: '["npm ci"]', hint: 'A JSON array of command prefixes.' },
      { k: 'leak-check', label: 'Scan for leaks before a push (--leak-check)', kind: 'check' },
      ...TAG_FLAGS],
    build(v, bad) {
      if (!v.name) bad('name', 'A name is needed.');
      else if (!validName(v.name)) bad('name', 'Use lowercase letters, digits and -; a/b for a child.');
      if (v.type && !v.path) bad('path', 'A type needs a path.');
      if (v.path && !v.type) bad('type', 'A path needs a type.');
      if (v.type === 'git' && !v.base) bad('base', 'A git tag needs a base branch.');
      if (v.checks && !jsonOf(v.checks, false)) bad('checks', 'Use a JSON object, e.g. {"lint":"npm run lint"}.');
      if (v.heavy && !jsonOf(v.heavy, true)) bad('heavy', 'Use a JSON array of command prefixes.');
      if (v['skills-off'] && !/^[\w-][\w.-]*(,[\w-][\w.-]*)*$/.test(v['skills-off'])) bad('skills-off', 'Use plain skill names, comma-separated, e.g. caveman,ponytail.'); // cli.js CHECK['skills-off']
      return words('tb tag add', shq(v.name), flag('type', v.type), v.path && `--path ${shpath(v.path)}`, flag('base', v.base), flag('setup', v.setup), flag('output', v.output),
        flag('env-files', v['env-files']), flag('context', v.context), flag('skills', v.skills), flag('skills-off', v['skills-off']), flag('checks', v.checks), flag('heavy', v.heavy), v['leak-check'] && '--leak-check', ...tagFlags(v, bad));
    },
  },
  doctor: {
    title: 'Check Setup', sub: 'Builds a tb doctor command. With a tag it also checks that tag\'s repo and check commands, which can take minutes.',
    fields: [{ k: 'tag', label: 'Tag', kind: 'text', ph: 'shop/api', hint: 'Leave empty to check Claude, billing and node only.' }, ...TAG_FLAGS],
    build(v, bad) {
      if (v.tag && !validName(v.tag)) bad('tag', 'Use lowercase letters, digits and -; a/b for a child.');
      if (!v.tag) for (const k of ['ident', 'push-remote', 'qa-ports', 'db']) if (v[k]) bad(k, 'This needs a tag.');
      return words('tb doctor', flag('tag', v.tag), ...tagFlags(v, bad));
    },
  },
  gc: {
    title: 'Clean Up', sub: 'Builds a tb gc command. List first, then delete only the ids you read in the list.',
    fields: [
      { k: 'mode', label: 'What to do', kind: 'select', opts: [['list', 'List what can go'], ['delete', 'Delete these ids']] },
      { k: 'limit', label: 'List size', kind: 'text', ph: '20', hint: 'Used when listing.' },
      { k: 'ids', label: 'Ids to delete', kind: 'area', hint: 'One per line, from the list: worktree/t_…, log/…, cache/…, refs/…, branch/….' }],
    build(v, bad) {
      if (v.mode !== 'delete') {
        if (v.limit && !/^[1-9]\d*$/.test(v.limit)) bad('limit', 'Use a number from 1.');
        return words('tb gc', flag('limit', v.limit));
      }
      const ids = v.ids.split(/\s+/).filter(Boolean);
      if (!ids.length) bad('ids', 'Give one or more ids from the list.');
      else if (ids.some(i => !/^(worktree|log|cache|refs|branch)\/\S+$/.test(i))) bad('ids', 'An id looks like worktree/t_…, log/…, cache/…, refs/… or branch/….');
      return words('tb gc --delete', ...ids.map(shq));
    },
  },
  eval: {
    title: 'Run Evals', sub: 'Builds a tb eval command. A real golden run uses your Claude subscription and costs real money. The command prints the estimate and stops; add --yes yourself to run it.',
    fields: [
      { k: 'mode', label: 'What to run', kind: 'select', opts: [['dry', 'Golden tickets, dry run'], ['real', 'Golden tickets, real run'], ['record', 'Record a score file'], ['fake', 'Fake-claude test suite']] },
      { k: 'only', label: 'Only these sources', kind: 'text', ph: 'golden,planner', hint: `Real run. A comma list of ${ONLY.join(', ')}. Empty runs all.` },
      { k: 'file', label: 'Score file', kind: 'text', ph: '~/.taskboard/evals/score.json', hint: 'Record.' }],
    build(v, bad) {
      if (v.mode === 'fake') return 'tb eval fake';
      if (v.mode === 'record') {
        if (!v.file) bad('file', 'A score file is needed.');
        return words('tb eval golden', v.file ? `--record ${shpath(v.file)}` : '--record');
      }
      if (v.mode === 'dry') return 'tb eval golden --dry';
      if (v.only && !v.only.split(',').every(x => ONLY.includes(x))) bad('only', `Use a comma list of ${ONLY.join(', ')}.`);
      return words('tb eval golden --real', flag('only', v.only)); // no --yes: the CLI prints the cost and refuses until it is added
    },
  },
};
// → {cmd, errors: {field: message}}; cmd is built even when a field fails, so the preview shows the quoted literal
function buildCmd(id, v) {
  const errors = {};
  const cmd = CMDS[id].build(v, (k, msg) => { errors[k] ??= msg; });
  return { cmd, errors };
}

async function copyCmd(pre, cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
    toast('Paste it in Terminal.', { kind: 'info', title: 'Copied' });
  } catch { // no clipboard (or refused): select the preview so Cmd+C works
    const r = document.createRange();
    r.selectNodeContents(pre);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    toast('The command is selected. Press Cmd+C.', { kind: 'warn', title: 'Copy by Hand' });
  }
}

// board-terminal-parity 6.6: with Page Tools on, Check Setup and Clean Up also Run here: the form's fields go to tbd as tb
// sends them (lib/cli.js doctor / gc), the reply shows as text. → {lines, next} (next: gc's page cursor)
const sizeOf = b => (b == null ? DASH : fmtBytes(b));
const RUNS = {
  async doctor(v) {
    const body = { tag: v.tag || undefined }; // cli.js tagKeys: --push-remote, --qa-ports, --db (none = drop the key)
    if (v['push-remote']) body.push = { remote: v['push-remote'] };
    if (v['qa-ports']) body.qa_ports = v['qa-ports'].split(',').map(Number);
    if (v.db) body.db = v.db === 'local' ? 'local' : null;
    const r = await api('POST', '/api/doctor', body), checks = Array.isArray(r.checks) ? r.checks.filter(isObj) : [];
    const failed = checks.filter(x => !x.ok).length;
    return { lines: [`doctor: ${failed ? `FAIL (${failed} of ${checks.length} checks)` : 'ok'}`,
      ...checks.map(x => [!x.ok ? 'fail' : x.warn ? 'warn' : 'ok', x.name, x.detail, x.fix && `fix: ${x.fix}`].filter(Boolean).map(vis).join(' · '))] };
  },
  async gc(v, after) {
    if (v.mode === 'delete') {
      const r = await api('POST', '/api/gc', { ids: v.ids.split(/\s+/).filter(Boolean) });
      const lines = [...(r.deleted ?? []).map(d => `deleted ${vis(d.id)} · ${sizeOf(d.bytes)}`), ...(r.skipped ?? []).map(s => `skipped ${vis(s.id)}: ${vis(s.reason)}`)];
      return { lines: lines.length ? lines : ['Nothing deleted.'] };
    }
    const r = await api('GET', `/api/gc?limit=${v.limit || 20}${after ? `&after=${enc(after)}` : ''}`), items = Array.isArray(r.items) ? r.items.filter(isObj) : [];
    return { next: r.next ?? null, lines: [...(after ? [] : [`${r.total ?? items.length} can go`]),
      ...items.map(i => [i.id, i.kind, sizeOf(i.bytes), i.age_days != null && `${i.age_days} days old`, i.reason].filter(Boolean).map(vis).join(' · '))] };
  },
};

function cmdSheet(id, preset = {}) {
  const c = CMDS[id], pre = el('pre', { class: 'cmd', tabindex: '0', 'data-role': 'cmd', 'aria-label': 'Command, as text' });
  let run = pageTools() && RUNS[id], running = false, next = null;
  const copy = el('button', { type: 'submit', class: run ? 'btn btn-gray' : 'btn', 'data-role': 'copy' }, 'Copy Command');
  // Run is the Prominent one; Enter still copies (Run may take minutes, or delete)
  const runBtn = run && el('button', { type: 'button', class: 'btn', 'data-role': 'run', onclick: () => go() });
  const note = run && el('p', { class: 'hint', 'aria-live': 'polite' });
  const out = run && el('pre', { class: 'log', 'data-role': 'run-out', tabindex: '0', 'aria-label': 'Output, as text' });
  const more = run && el('button', { type: 'button', class: 'link-btn', 'data-role': 'run-more', hidden: true, onclick: () => go(next) }, 'List More');
  const outBox = run && el('div', { class: 'cmd-block', hidden: true }, el('p', { class: 'sf-label' }, 'Output'), out, el('p', null, more));
  const f = sheetFields(c.fields, preset, () => update());
  function update() {
    const v = f.vals(), { cmd, errors } = buildCmd(id, v);
    pre.replaceChildren(cmd);
    f.fail(errors);
    copy.disabled = Object.keys(errors).length > 0;
    if (run) { // gc delete arms first: two clicks (arm(), as Cancel)
      const del = id === 'gc' && v.mode === 'delete', sure = del && armed('gc', 'delete'), ident = id === 'doctor' && v.ident;
      runBtn.disabled = copy.disabled || running || ident;
      runBtn.className = sure ? 'btn btn-danger-fill' : 'btn';
      runBtn.replaceChildren(running ? 'Running…' : sure ? 'Confirm Delete' : del ? 'Delete' : 'Run');
      note.replaceChildren(ident ? 'Run can’t read your git name and email: use Copy Command for --ident.' : sure ? 'Press again to delete these for good.' : '');
    }
    return cmd;
  }
  async function go(after) {
    const v = f.vals();
    if (id === 'gc' && v.mode === 'delete') {
      if (!armed('gc', 'delete')) { arm('gc', 'delete'); update(); setTimeout(update, 4000); return; }
      if (early()) return;
      ui.arm = null;
    }
    running = true;
    update();
    try {
      const r = await run(v, after);
      if (after) out.append('\n', r.lines.join('\n')); else out.replaceChildren(r.lines.join('\n'));
      next = r.next ?? null;
      more.hidden = !next;
      if (id === 'doctor') loadHealth(); // the Doctor card shows the new run
    } catch (e) {
      out.replaceChildren(`Refused: ${e.message}`);
      more.hidden = true;
      if (e.cliOnly) { run = null; runBtn.remove(); note.remove(); copy.className = 'btn'; } // Page Tools went off: copy only
    }
    outBox.hidden = false;
    running = false;
    update();
  }
  const cmd = update();
  const form = openSheet(c.title, c.sub, f.nodes, [cancelBtn(), copy, runBtn].filter(Boolean), f.ctl[c.fields[0].k],
    { after: [el('div', { class: 'cmd-block' }, el('p', { class: 'sf-label', id: 'cmd-l' }, 'Command'), pre), note, outBox].filter(Boolean) });
  form.onsubmit = e => {
    e.preventDefault();
    if (!copy.disabled) copyCmd(pre, update());
  };
  return { form, pre, copy, cmd };
}

// board-terminal-parity 4: Add Tag in three fields while Page Tools is on. Folder: typed, picked from the folders your
// terminal used (GET /api/folders/recent) or Choose Folder… (the Mac dialog, POST /api/pick-folder); tbd reads it
// (POST /api/folders/branches: git or a plain folder, its branches) and Add posts /api/tags/quick (tbd checks it all again).
// More Options opens the copy-command form with what was typed. Page Tools off: that form.
function addTag(back) { // back(name): runs when the sheet closes (name: the tag added, else undefined); the New sheet opens again from it
  if (!pageTools()) { cmdSheet('tag-add'); sheetBack = back ? () => back() : null; return; }
  const choose = el('button', { type: 'button', class: 'btn btn-sm btn-gray', 'data-role': 'pick-folder', onclick: () => pickFolder() }, 'Choose Folder…');
  const kind = el('p', { class: 'hint', 'aria-live': 'polite' });
  const folders = el('datalist', { id: 'tag-folders' });
  const f = sheetFields([
    { k: 'name', label: 'Name', kind: 'text', ph: 'shop/api', hint: 'Lowercase letters, digits and -. Use a/b for a child.' },
    { k: 'path', label: 'Folder', kind: 'text', list: 'tag-folders', after: [choose, kind] },
    { k: 'base', label: 'Base', kind: 'select', opts: [], hint: 'The branch flows start from: the current one is picked.' },
  ], {}, () => {});
  const baseRow = f.nodes[2];
  baseRow.hidden = true; // a git folder shows it (with its branches)
  let info = null, why = null, seen = null, reading = null, seq = 0;
  const preset = () => { const v = f.vals(); return { name: v.name, type: info?.type, path: v.path, base: info?.type === 'git' ? v.base : '' }; };
  // the folder's type and branches, read once per folder value (a failed read again next time); → the read in flight
  // (Add waits for it)
  function readFolder() {
    const p = f.ctl.path.value.trim();
    if (p === seen) return reading;
    seen = p;
    info = why = null;
    baseRow.hidden = true;
    kind.replaceChildren();
    f.fail({});
    if (!p) return (reading = null);
    const mine = ++seq;
    return (reading = api('POST', '/api/folders/branches', { path: p }).then(r => {
      if (mine !== seq) return;
      info = r;
      kind.replaceChildren(r.type === 'git' ? 'A git repo.' : 'A plain folder: no base branch.');
      if (r.type !== 'git') return;
      f.ctl.base.replaceChildren(...(Array.isArray(r.branches) ? r.branches : []).map(b => el('option', { value: String(b), selected: b === r.current }, vis(b))));
      baseRow.hidden = false;
    }, e => {
      if (mine !== seq) return;
      why = e.message;
      seen = null;
      f.fail({ path: why });
    }));
  }
  async function pickFolder() {
    choose.disabled = true;
    choose.replaceChildren('Waiting for the Dialog…');
    try {
      const r = await api('POST', '/api/pick-folder', {});
      if (typeof r.path === 'string') { f.ctl.path.value = r.path; readFolder(); }
    } catch (e) { toast(e.message, { title: refused(e, 'Couldn’t Open the Folder Dialog') }); }
    choose.disabled = false;
    choose.replaceChildren('Choose Folder…');
    f.ctl.path.focus();
  }
  f.ctl.path.addEventListener('change', readFolder);
  f.ctl.path.addEventListener('blur', readFolder);
  const add = el('button', { type: 'submit', class: 'btn', 'data-role': 'tag-add' }, 'Add');
  const form = openSheet('Add Tag', 'A tag is a folder flows work in. tbd checks the folder and adds the tag.', f.nodes, [cancelBtn(), add], f.ctl.name, {
    inline: true,
    after: [folders, el('p', null, el('button', { type: 'button', class: 'link-btn', 'data-role': 'tag-more', onclick: () => { const b = sheetBack; cmdSheet('tag-add', preset()); sheetBack = b; } }, 'More Options…'))],
  });
  sheetBack = back ? () => back() : null;
  api('GET', '/api/folders/recent').then(r => folders.replaceChildren(...(Array.isArray(r.folders) ? r.folders.filter(isObj) : []).map(x => el('option', { value: String(x.path) }, vis(x.name)))), () => {});
  const mine = form.onsubmit = async e => {
    e.preventDefault();
    if (add.disabled) return;
    add.disabled = true;
    await readFolder();
    const v = f.vals();
    const bad = !v.name ? { name: 'A name is needed.' } : !validName(v.name) ? { name: 'Use lowercase letters, digits and -; a/b for a child.' }
      : !v.path ? { path: 'Choose or type a folder.' } : !info ? { path: why ?? 'tbd could not read this folder.' } : null;
    if (bad) {
      f.fail(bad);
      add.disabled = false;
      return f.ctl[Object.keys(bad)[0]].focus();
    }
    try {
      const r = await api('POST', '/api/tags/quick', { name: v.name, path: v.path, base: info.type === 'git' ? v.base : undefined });
      if (form.onsubmit !== mine || !sheetOpen()) { ui.tagsLoaded = false; return; } // Cancel (or another sheet) since: back already ran, not this sheet to close
      sheetBack = null;
      closeSheet(true);
      toast(`#${r.tag?.name ?? v.name} is ready for flows.`, { kind: 'info', title: 'Tag Added' });
      ui.tagsLoaded = false; // the New sheet and Promote read the tags again
      loadHealth();
      back?.(r.tag?.name ?? v.name);
    } catch (err) {
      if (err.cliOnly) { cmdSheet('tag-add', preset()); sheetBack = back ? () => back() : null; toast(err.message, { kind: 'warn', title: 'Copy the Command' }); }
      else f.fail({ [err.status === 409 ? 'name' : 'path']: err.message });
    }
    add.disabled = false;
  };
}

// ---------- Health (M7): the §12 targets, doctor, the drill log, the tag list ----------
// GET /api/health?days= (targets as sent: one rule, no client math but the count), GET /api/drills (paged by `before`), GET /api/tags.
// Loads when the view opens and on Refresh; nothing polls. Doctor detail, drill notes and tag paths are text only.
const pct = (x, y) => (y ? `${Math.round((x / y) * 1000) / 10}%` : DASH);
const verdict = ok => (ok === true ? ['mint', 'Pass'] : ok === false ? ['rose', 'Fail'] : ['gray', 'N/A']); // [hue, word]: a pill, never color alone
const OPS_TEXT = { '>=': '≥', '<=': '≤' };
function targetRow(t) {
  const ratio = t.op === '>=' || t.op === '<=';
  const now = [`${t.x} / ${t.y}${t.unit ? ` ${t.unit}` : ''}`, !t.unit && t.y > 0 && pct(t.x, t.y), t.pending > 0 && `${t.pending} pending`, t.no_data > 0 && `${t.no_data} no data`].filter(Boolean).join(' · ');
  const goal = ratio ? `${OPS_TEXT[t.op]} ${t.unit ? `${t.y} ${t.unit}` : `${Math.round(t.threshold * 1000) / 10}%`}` : t.op;
  const notes = [t.key === 'golden' && t.base_at && `Compared with the run of ${when(t.base_at)}.`, t.note].filter(Boolean);
  return el('tr', { 'data-key': t.key },
    el('td', { class: 'hl-label' }, el('span', { class: 'cell-title' }, vis(t.label)), ...notes.map(n => el('span', { class: 'cell-sub' }, vis(n)))),
    el('td', { class: 'hl-result' }, pill(...verdict(t.ok))),
    el('td', { class: 'num hl-now' }, now),
    el('td', { class: 'num hl-goal' }, goal));
}
// a table in a card with no padding; a head is a label or [label, class] ('num': right-aligned like its cells)
const hlTable = (caption, heads, rows, cls = '') => el('div', { class: 'tscroll' }, el('table', { class: `table htable ${cls}`.trim() }, el('caption', { class: 'sr' }, caption),
  el('thead', null, el('tr', null, ...heads.map(h => el('th', { scope: 'col', class: Array.isArray(h) ? h[1] : null }, Array.isArray(h) ? h[0] : h)))), el('tbody', null, ...rows)));

// §10 summary: the hero (targets met, period, Refresh) + its composition (Pass / Fail / N/A), then the tables as cards
function healthView(hl) {
  const h = hl.health, d = h?.doctor, dr = hl.drills, tags = hl.tags;
  const scored = (h?.targets || []).filter(t => t.op !== 'watch'), met = scored.filter(t => t.ok === true).length; // n/a counts as not met, as tb health
  const mix = h ? [['mint', 'Pass'], ['rose', 'Fail'], ['gray', 'N/A']].map(([hue, w]) => [hue, w, h.targets.filter(t => verdict(t.ok)[1] === w).length]).sort((a, b) => b[2] - a[2]) : [];
  const cmdBtn = (label, id, preset) => el('button', { type: 'button', class: 'btn btn-sm btn-gray', 'data-role': `cmd-${id}`, onclick: () => cmdSheet(id, preset) }, label);
  const head = (id, title, action) => el('div', { class: 'card-head' }, el('h3', { id, class: 'card-title' }, title), action);
  const card = (id, title, action, ...kids) => el('section', { class: 'card card-flush', 'aria-labelledby': id }, head(id, title, action), ...kids);
  const pad = (...kids) => el('div', { class: 'card-pad' }, ...kids);
  const days = h?.window_days ?? hl.days ?? 30;
  return el('div', { class: 'hl' },
    el('section', { class: 'card hl-hero', 'aria-labelledby': 'hl-hero-h' },
      el('div', { class: 'hl-lead' },
        el('h3', { id: 'hl-hero-h', class: 'eyebrow' }, `Targets Met · Last ${days} Days`),
        h ? el('p', { class: 'metric' }, `${met} of ${scored.length}`, el('span', { class: 'unit' }, 'targets met'))
          : hl.loading ? el('div', { class: 'skel', role: 'img', 'aria-label': 'Loading' }) : el('p', { class: 'metric' }, DASH),
        h && el('p', { class: 'hint' }, `${h.targets.length - scored.length} watched, no target.${h.cut ? ' The metrics log was read in part: its newest 8 MB.' : ''}`)),
      el('div', { class: 'hl-ctl' },
        hl.loading && h && el('span', { class: 'spin', role: 'img', 'aria-label': 'Loading' }),
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Period', 'data-role': 'hl-days' }, ...[7, 30, 90].map(n =>
          el('button', { type: 'button', value: String(n), 'data-role': `hl-days-${n}`, 'aria-label': `${n} Days`, 'aria-pressed': String(n === (hl.days ?? 30)), onclick: () => { ui.days = n; loadHealth(); } }, `${n}D`))),
        el('button', { type: 'button', class: 'icon-btn', 'data-role': 'hl-refresh', 'aria-label': 'Refresh', 'data-tip': 'Refresh', 'data-tip-pos': 'below', onclick: loadHealth }, icon('refresh')))),
    el('section', { class: 'card hl-mix', 'aria-labelledby': 'hl-mix-h' },
      head('hl-mix-h', 'By Result'),
      h ? el('ul', { class: 'mix' }, ...mix.map(([hue, w, n]) => el('li', null, el('span', { class: `status hue-${hue}` }, w), el('span', { class: 'num' }, String(n)))))
        : el('p', { class: 'hint' }, hl.loading ? 'Loading' : DASH)),
    hl.herr && el('p', { class: 'err', role: 'alert' }, hl.herr),
    h && card('hl-t', 'Targets', null, hlTable('Targets: result, now, goal', ['Target', 'Result', ['Now', 'num'], ['Goal', 'num']], h.targets.map(targetRow), 'hl-targets')),
    card('hl-d', 'Doctor', cmdBtn('Check Setup…', 'doctor'),
      h && pad(!d ? el('p', { class: 'hl-line' }, 'No doctor run kept yet. Check Setup builds the command.')
        : el('p', { class: 'hl-line' }, pill(...verdict(d.ok)), `${when(d.at) ?? DASH} · ${(d.checks || []).filter(x => !x.ok).length} of ${(d.checks || []).length} checks failed`)),
      d && (d.checks || []).some(x => !x.ok) && hlTable('Failed doctor checks', ['Check', 'Detail', 'Fix'],
        d.checks.filter(x => !x.ok).map(x => el('tr', null, el('td', null, vis(x.name)), el('td', { class: 'hl-wrap' }, vis(x.detail ?? DASH)), el('td', { class: 'hl-wrap' }, x.fix ? el('code', null, vis(x.fix)) : DASH))))),
    card('hl-r', 'Drills', null,
      hl.derr ? pad(el('p', { class: 'err' }, hl.derr)) : dr?.items.length ? hlTable('Drill log, newest first', ['At', 'Drill', 'Result', 'Note'],
        dr.items.map(x => el('tr', null, el('td', null, when(x.at) ?? DASH), el('td', null, vis(x.name)), el('td', null, pill(...verdict(x.ok))), el('td', { class: 'hl-wrap' }, vis(x.note ?? '')))))
        : pad(el('p', { class: 'hl-line' }, dr ? 'No drills recorded yet.' : DASH)),
      dr && el('div', { class: 'card-foot' }, el('button', { type: 'button', class: 'btn btn-sm btn-gray', 'data-role': 'drills-older', disabled: dr.next == null, onclick: () => loadDrills(dr.next) }, 'Older'))),
    card('hl-g', 'Tags', el('button', { type: 'button', class: 'btn btn-sm btn-gray', 'data-role': 'cmd-tag-add', onclick: () => addTag() }, 'Add Tag…'),
      hl.terr ? pad(el('p', { class: 'err' }, hl.terr)) : tags && Object.keys(tags).length ? hlTable('Tags', ['Name', 'Type', 'Path', ''],
        Object.entries(tags).map(([name, def]) => el('tr', null, el('td', { class: 'cell-title' }, vis(name)), el('td', null, vis(def?.type ?? DASH)), el('td', { class: 'hl-wrap' }, vis(def?.path ?? DASH)),
          el('td', { class: 'hl-edit' }, el('button', { type: 'button', class: 'link-btn', 'data-role': `tag-edit-${name}`, 'aria-label': `Edit tag ${vis(name)}`, onclick: () => cmdSheet('doctor', { tag: name }) }, 'Edit…')))))
        : pad(el('p', { class: 'hl-line' }, tags ? 'No tags yet.' : DASH))),
    el('section', { class: 'card hl-maint', 'aria-labelledby': 'hl-m' }, head('hl-m', 'Maintenance'),
      el('p', { class: 'hl-line' }, pageTools() ? 'Clean Up runs here or builds the command to copy. Evals run in Terminal.' : 'These run in Terminal, not here. Each button builds the command and copies it.'),
      el('div', { class: 'hl-acts' }, cmdBtn('Clean Up…', 'gc'), cmdBtn('Run Evals…', 'eval'))));
}

let hlSeq = 0;
function renderHealth() { // a re-render replaces the controls: focus stays on the same one (a period, Refresh, Older)
  const a = document.activeElement, role = $('#health').contains(a) ? a?.dataset?.role : null;
  $('#health').replaceChildren(healthView(ui.hl || { days: ui.days, loading: true }));
  if (role) $(`#health [data-role="${CSS.escape(role)}"]`)?.focus();
}
async function loadHealth() {
  if (!trusted || ui.locked) return;
  const mine = ++hlSeq, days = ui.days;
  ui.hl = { ...ui.hl, days, loading: true };
  renderHealth();
  const cp = loadSettings(); // Page Tools: Run in Check Setup and Clean Up, the 3-field Add Tag
  const tp = api('GET', '/api/tags');
  const [h] = await Promise.allSettled([api('GET', `/api/health?days=${days}`)]);
  const [d] = await Promise.allSettled([api('GET', '/api/drills?limit=20')]); // after health: one compute at a time
  const [t] = await Promise.allSettled([tp, cp]);
  if (mine !== hlSeq) return;
  ui.hl = { days, health: h.value, herr: h.reason?.message, drills: d.value && { items: d.value.items || [], next: d.value.next ?? null }, derr: d.reason?.message, tags: t.value && (t.value.tags || {}), terr: t.reason?.message };
  renderHealth();
}
async function loadDrills(before) {
  try {
    const r = await api('GET', `/api/drills?limit=20&before=${encodeURIComponent(before)}`);
    ui.hl = { ...ui.hl, drills: { items: [...ui.hl.drills.items, ...r.items], next: r.next ?? null } };
  } catch (e) { ui.hl = { ...ui.hl, derr: e.message }; }
  renderHealth();
}


// ---------- Settings (full-access-runs Phase 8): GET /api/config, every change saved at once (POST /api/config) ----------
// DESIGN §8 Forms + §11 Settings: grouped rows, label leading, control trailing, saved at once. A nested key goes whole,
// built from what tbd last answered (as tb config set); tbd checks every value, a refusal shows under its control
// (ui.cfgErr) and the view reads tbd's config again. claude_bin is shown, never changed here (tb doctor --pin).
const MODELS = ['opus', 'sonnet', 'fable'], EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// board-terminal-parity (decision 5): Settings → Terminal, config.terminal's switches (all off in code), one line each
const TERM = [
  ['bash_all_steps', 'Bash in Every Step', 'Planning, review and final check may run commands and subagents.'],
  ['folder_mcp', 'Folder MCP', 'Load the MCP servers your terminal uses in that folder.'],
  ['git_bridge', 'Git Bridge', 'Pull, fetch and push with your ssh keys; every push asks you.'],
  ['auto_mode', 'Auto Mode', 'Like your terminal; a blocked action asks you.'],
  ['task_tickets', 'Task Tickets', 'Tickets that work in your real folder.'],
  ['page_tools', 'Page Tools', 'Run Check Setup, Clean Up, Add Tag, Open in Terminal from this page.'],
];
let cfgSeq = 0;
async function loadSettings() {
  if (!trusted || ui.locked) return;
  const mine = ++cfgSeq;
  let r;
  try { r = await api('GET', '/api/config'); } catch (e) { r = { error: e.message }; }
  if (mine !== cfgSeq) return;
  ui.cfg = r;
  renderSettings();
}
async function saveSetting(role, patch) {
  ui.cfgErr = null;
  try {
    ui.cfg = await api('POST', '/api/config', patch);
    toast('The next runs use it.', { kind: 'info', title: 'Saved' });
    renderSettings();
  } catch (e) {
    ui.cfgErr = { role, text: e.message };
    await loadSettings();
  }
}
function renderSettings() { // a re-render keeps focus on the same control
  const box = $('#settings'), a = document.activeElement, role = box.contains(a) ? a?.dataset?.role : null;
  box.replaceChildren(settingsView(ui.cfg));
  if (role) $(`#settings [data-role="${CSS.escape(role)}"]`)?.focus();
}
// board-terminal-parity Phase 2 task 6 (Page Tools): Check Terminal = tb doctor --terminal (free checks); Live Run… =
// --live: a git tag, tbd's cost line on the first click (Check Cost), the run on the second (Run Live Check: one short
// sonnet run, up to 10 min). Page Tools off: the tb line. The lines are tbd's text (a live run's hold agent text):
// textContent + vis only. The body is built apart: tb sends more keys (test/ui-parity reads literal bodies only).
const TC_TONE = { ok: 'ok', warn: 'wait', fail: 'bad' };
const tcSum = res => { const n = res.checks.filter(x => x.status === 'fail').length; return n ? `${n} of ${res.checks.length} checks failed.` : `No check failed (${res.checks.length}).`; };
async function termRun(live) {
  const tc = ui.tc ??= {};
  if (tc.busy || (live && !tc.tag)) return;
  if (live && tc.cost && Date.now() - tc.armedAt < 400) return; // a held Enter repeats the click that armed it
  const body = live ? { terminal: true, live: true, tag: tc.tag } : { terminal: true };
  if (live && tc.cost) body.yes = true;
  tc.busy = live ? 'live' : 'fixed';
  tc.err = null;
  renderSettings();
  try {
    const r = await api('POST', '/api/doctor', body);
    if (r.confirm) { tc.cost = String(r.cost ?? ''); tc.armedAt = Date.now(); } else { tc.res = { checks: Array.isArray(r.checks) ? r.checks.filter(isObj) : [] }; tc.cost = null; }
  } catch (e) { tc.err = e.message; }
  tc.busy = null;
  renderSettings();
  const said = $('#tc-said'); // L-a11y: the one live region for results (outside every view: it speaks while Settings is hidden too)
  if (said && tc.res && !tc.err && !tc.cost) { // emptied first, the words a frame later: the same words twice are read again
    const text = tcSum(tc.res);
    said.textContent = '';
    requestAnimationFrame(() => { said.textContent = text; });
  }
}
async function liveOpen() {
  const tc = ui.tc ??= {};
  Object.assign(tc, { live: true, cost: null, err: null });
  renderSettings();
  try {
    const j = await api('GET', '/api/tags');
    tc.tags = Object.entries(isObj(j.tags) ? j.tags : {}).filter(([, d]) => isObj(d) && d.type === 'git').map(([n]) => n);
    if (!tc.tags.includes(tc.tag)) tc.tag = tc.tags[0];
  } catch (e) { tc.err = e.message; }
  renderSettings();
}
function termCheckRows(row) {
  const tc = ui.tc ?? {};
  const what = 'Free checks of what runs use: git bridge, folder MCP, browser, skills, the wall, claude.';
  if (!pageTools()) return [row('term-check', 'Terminal Check', `${what} Page Tools is off: run it in Terminal.`, el('code', { class: 'set-code' }, 'tb doctor --terminal'))];
  const btn = (role, label, onclick, main = false) => el('button', { type: 'button', class: main ? 'btn btn-sm' : 'btn btn-sm btn-gray', 'data-role': role, 'aria-busy': tc.busy ? 'true' : null, onclick }, label);
  const out = [row('term-check', 'Terminal Check', `${what} Live Run tries them in one short run.`, el('div', { class: 'set-acts' },
    btn('term-check', tc.busy === 'fixed' ? 'Checking…' : 'Check Terminal', () => termRun(false)), btn('term-live', 'Live Run…', () => liveOpen())))];
  if (tc.live) {
    const hint = tc.tags && !tc.tags.length ? 'No git tag yet: add one first.' : tc.cost ? `Costs ${vis(tc.cost)}. Run Live Check starts it.`
      : 'One short sonnet run on a git tag: Bash, a subagent, an MCP tool, the skills and tb-git. It costs usage: Check Cost shows how much first.';
    out.push(row('term-live-tag', 'Live Run', hint, el('div', { class: 'set-acts' },
      el('select', { class: 'input', 'data-role': 'term-live-tag', 'aria-label': 'Git tag for the live run', onchange: e => { tc.tag = e.target.value; tc.cost = null; renderSettings(); } },
        ...(tc.tags ?? []).map(n => el('option', { value: n, selected: n === tc.tag }, vis(n)))),
      btn('term-live-run', tc.busy === 'live' ? 'Running…' : tc.cost ? 'Run Live Check' : 'Check Cost', () => termRun(true), !!tc.cost),
      btn('term-live-cancel', 'Cancel', () => { ui.tc = { res: tc.res, err: tc.err }; renderSettings(); $('#settings [data-role="term-live"]')?.focus(); }))));
  }
  if (tc.err) out.push(el('p', { class: 'err set-sub', role: 'alert' }, vis(tc.err)));
  if (tc.res) {
    out.push(el('div', { class: 'card-pad' }, el('p', { class: 'hint' }, tcSum(tc.res)),
      el('ul', { class: 'tcheck', 'aria-label': 'Terminal check, one line each' }, ...tc.res.checks.map(x => el('li', null, dot(TC_TONE[x.status] ?? '', vis(x.status)), ' ', vis(`${x.name} · ${x.detail}`))))));
  }
  return out;
}
function settingsView(r) {
  const c = r?.config;
  if (!c) return el('div', { class: 'settings' }, r?.error ? el('p', { class: 'err', role: 'alert' }, r.error) : el('p', { class: 'hint' }, 'Loading…'));
  const m = c.models || {}, need = c.memory?.phase_need_gb || {}, sub = c.subagents || {}, on = new Set(c.skills?.defaults || []);
  const err = role => ui.cfgErr?.role === role && el('p', { class: 'err' }, ui.cfgErr.text);
  const select = (role, label, value, opts, save) => el('select', { class: 'input', 'data-role': role, 'aria-label': label, onchange: e => save(e.target.value) },
    !opts.some(o => String(o) === String(value)) && el('option', { value: '', selected: true, disabled: true }, DASH),
    ...opts.map(o => el('option', { value: String(o), selected: String(o) === String(value) }, String(o))));
  const number = (role, label, value, [min, max, step], save) => el('input', { class: 'input num', type: 'number', inputmode: 'decimal', 'data-role': role, 'aria-label': label,
    min: String(min), max: String(max), step: String(step), value: String(value ?? ''), onchange: e => save(Number(e.target.value)) });
  const toggle = (role, label, checked, save) => el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'data-role': role, 'aria-label': label, checked: !!checked, onchange: e => save(e.target.checked) });
  const row = (role, label, hint, ctl) => el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('span', { class: 'set-label' }, label), hint && el('span', { class: 'cell-sub' }, hint), err(role)), ctl);
  const head = (id, title) => el('div', { class: 'card-head' }, el('h3', { id, class: 'card-title' }, title));
  const card = (id, title, hint, ...kids) => el('section', { class: 'card card-flush', 'aria-labelledby': id }, head(id, title), hint && el('p', { class: 'hint set-sub' }, hint), ...kids);
  const model = (p, k) => v => saveSetting(`m-${p}-${k}`, { models: { ...m, [p]: { ...m[p], [k]: v } } });
  const ram = p => v => saveSetting(`ram-${p}`, { memory: { ...c.memory, phase_need_gb: { ...need, [p]: v } } });
  const subs = k => v => saveSetting(`sub-${k}`, { subagents: { ...sub, [k]: v } });
  const skill = n => v => saveSetting(`skill-${n}`, { skills: { ...c.skills, defaults: v ? [...on, n] : [...on].filter(x => x !== n) } });
  const t = c.terminal, term = k => v => saveSetting(`term-${k}`, { terminal: { ...t, [k]: v } }); // the whole object: tbd wants every key
  const phaseErr = AGENT.flatMap(p => [`m-${p}-model`, `m-${p}-effort`, `ram-${p}`]).map(err).find(Boolean);
  return el('div', { class: 'settings' },
    el('p', { class: 'hint' }, 'Changes save at once. A run already going keeps what it started with; the next run uses the new value.'),
    card('set-ph', 'Phases', 'The model and effort each agent phase runs on. Memory: what a run of the phase needs before it may start, used only until a run of it is measured; after that the board uses the measured peaks.',
      el('div', { class: 'tscroll' }, el('table', { class: 'table set-table' }, el('caption', { class: 'sr' }, 'Model, effort and memory need per phase (memory: until a run of the phase is measured)'),
        el('thead', null, el('tr', null, ...['Phase', 'Model', 'Effort', ['Memory (GB)', 'num']].map(h => el('th', { scope: 'col', class: Array.isArray(h) ? h[1] : null }, Array.isArray(h) ? h[0] : h)))),
        el('tbody', null, ...AGENT.map(p => el('tr', { 'data-phase': p },
          el('td', { class: 'cell-title' }, stateLabel(p)),
          el('td', null, select(`m-${p}-model`, `${stateLabel(p)} model`, m[p]?.model, MODELS, model(p, 'model'))),
          el('td', null, select(`m-${p}-effort`, `${stateLabel(p)} effort`, m[p]?.effort, EFFORTS, model(p, 'effort'))),
          el('td', { class: 'num' }, number(`ram-${p}`, `${stateLabel(p)} memory need in GB, until a run is measured`, need[p], [0.2, 4, 0.1], ram(p)))))))),
      phaseErr && el('div', { class: 'card-pad' }, phaseErr)),
    card('set-run', 'Runs', null,
      row('max_concurrent', 'Tickets at once', 'Runs of different tickets at the same time (1 to 3). The memory guard still holds one that does not fit.', select('max_concurrent', 'Tickets at once', c.max_concurrent, [1, 2, 3], v => saveSetting('max_concurrent', { max_concurrent: Number(v) }))),
      row('sub-concurrent', 'Subagents at once', 'Per run (1 to 4).', select('sub-concurrent', 'Subagents at once', sub.concurrent, [1, 2, 3, 4], v => subs('concurrent')(Number(v)))),
      row('sub-per_session_total', 'Subagent budget', 'Subagents one session may start in all (1 to 20).', number('sub-per_session_total', 'Subagent budget per session', sub.per_session_total, [1, 20, 1], subs('per_session_total'))),
      row('final_distinct', 'Final Gate on Another Model', 'The final gate never runs on the review phase’s model.', toggle('final_distinct', 'Final gate on another model', c.final_distinct, v => saveSetting('final_distinct', { final_distinct: v }))),
      row('lanes', 'Parallel Lanes', 'Two working runs of one ticket at once (needs tickets at once 2 or more).', toggle('lanes', 'Parallel lanes', c.lanes?.enabled, v => saveSetting('lanes', { lanes: { ...c.lanes, enabled: v } })))),
    isObj(t) && card('set-term', 'Terminal', 'What makes a run work like your terminal. Each stays off until you turn it on.',
      ...TERM.map(([k, label, hint]) => row(`term-${k}`, label, hint, toggle(`term-${k}`, label, t[k], term(k)))),
      row('term-approve_min', 'Approve Wait', 'Minutes a blocked action waits for your yes, then the answer is No (1 to 60).',
        number('term-approve_min', 'Approve wait in minutes', t.approve_min, [1, 60, 1], term('approve_min'))),
      ...termCheckRows(row)),
    card('set-sk', 'Default Skills', 'Every run names these skills; a tag adds or removes its own.',
      ...(r.skills || []).map(n => row(`skill-${n}`, vis(n), null, el('input', { type: 'checkbox', class: 'check', 'data-role': `skill-${n}`, 'aria-label': `Default skill ${vis(n)}`, checked: on.has(n), onchange: e => skill(n)(e.target.checked) })))),
    card('set-cl', 'Claude', null, row('claude_bin', 'Claude Binary', 'Changed in Terminal only: tb doctor --pin.', el('code', { class: 'set-code' }, vis(c.claude_bin)))));
}

// ---------- boot ----------
function render() {
  if (!state) return;
  ui.dirty = false;
  ui.day = today();
  renderHeader();
  renderToday();
  renderReminders();
  renderFlows();
}

initToolbar();
route();
globalThis.onhashchange = route; // window's handler (the vm test stub has no addEventListener)
document.addEventListener('click', e => { if (ui.tray && !e.target.closest('.tray, .menu')) closeTray(); });
// Escape closes the ⋯ menu with focus on its ⋯ or in it, then focus is on that ⋯ (a sheet or the drawer on top, or the
// search box clearing itself, takes that Escape)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || !ui.tray || sheetOpen() || $('#drawer').open) return;
  const id = ui.tray;
  closeTray();
  $(`.strip[data-id="${CSS.escape(id)}"] [data-role="menu"]`)?.focus();
});
if (uiKey) reconnect(); else lockOut(); // no ui_key (first visit after D39, or storage blocked): tb open once more
// DOM-only refresh of relative times ("in 20 min"); no network. Past midnight the board renders again (the date, due
// pills, Overdue / Due Today); not under a drag or an edit, which render once they end
setInterval(() => {
  if (document.visibilityState !== 'visible' || !state || ui.locked) return;
  if (ui.day === today()) renderSched();
  else if (ui.drag || ui.editing) ui.dirty = true;
  else render();
}, 60000);
// Run times tick in place each second (last activity, elapsed, tool time); no network, no re-render, a node written
// only when its text changed
const put = (e, s) => { if (e.textContent !== s) e.textContent = s; };
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  for (const e of document.querySelectorAll('[data-ago]')) put(e, ago(e.dataset.ago));
  for (const e of document.querySelectorAll('[data-since]')) put(e, span(e.dataset.since));
}, 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
