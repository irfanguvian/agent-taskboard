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
  ['backlog', 'Backlog'], ['planning', 'Planning'], ['clarify', 'Clarify'], ['plan_approval', 'Plan approval'],
  ['working', 'Working'], ['review', 'Review'], ['qa', 'QA'], ['final_gate', 'Final gate'],
  ['done', 'Done'], ['blocked', 'Blocked'],
];
const YOU = new Set(['clarify', 'plan_approval', 'blocked']); // states that wait on Irfan
const STAGE = { backlog: 'idle', done: 'done', blocked: 'blocked', clarify: 'you', plan_approval: 'you' };
const KINDS = ['code', 'research', 'brainstorm', 'design'];
const AGENT = ['planning', 'working', 'review', 'qa', 'final_gate']; // phases with agent runs (fsm.AGENT)
const NOW_LIMIT = 3, DONE_SHOWN = 15, GB = 2 ** 30, MB = 2 ** 20, DASH = '—';

let state = null; // { reminders, flows, system, calendar } after first load
let es = null; // the one EventSource
let trusted = false; // tbd proved itself and the stream has not dropped since: only then do requests carry the cookie
let wait = 1000; // reconnect backoff, ms (max 30 s)
const ui = { drag: null, editing: null, tray: null, promote: null, pick: { kind: KINDS[0], tag: '' }, dirty: false, tags: [], tagDefs: {}, tagsLoaded: false, locked: false,
  runs: new Map(), open: null, ticket: null, log: null, act: null, arm: null, // runs: id → `run` event; open: the drawer's flow id + its ticket, log tail, last action, Cancel / Approve armed
  round: null, plan: null, drafts: new Map(), busy: new Map(), err: null, // the open ticket's newest planning round and frozen plan, Clarify / Reject drafts (`${id}:${n}` → draft), planning action in flight (id → role), its refusal
  csrf: null, ask: null, gates: null, ivs: null, fb: null, pass: null, phase: new Map() }; // P5: synchronizer token, the open working ask, gate / intervention pages + a feedback file (on demand), the pass check, Resume's phase pick (id → phase)

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
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
}
// Bidi controls and zero-width chars in agent text: stripped (run errors) or shown as [U+202E] (plan, questions,
// titles), never applied or hidden, so a file name or test_cmd reads the way it runs.
const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const vis = s => String(s ?? '').replace(BIDI, c => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safe = fn => { try { return fn(); } catch { return undefined; /* storage blocked */ } };

// a segmented control (.seg of buttons): the one whose value matches is pressed
const press = (group, value) => { for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === value)); };

// ---------- theme: Auto follows the system (foundation.css), Light / Dark pin it ----------
const root = document.documentElement;
const THEMES = ['auto', 'light', 'dark'];
function setTheme(t) {
  root.dataset.theme = t;
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

// ---------- views: one per hash (#today #reminders #flows, #system on phones), so back / forward work ----------
const VIEWS = { today: 'Today', reminders: 'Reminders', flows: 'Flows', system: 'System' };
const PHONE = matchMedia('(max-width: 734px)');
const phone = () => PHONE.matches;
PHONE.addEventListener('change', e => { if (!e.matches && root.dataset.view === 'system') location.replace('#today'); }); // System is a phone view: widening leaves it
function route() {
  if (ui.locked) return; // lockOut replaced the body: no views left to show
  const h = location.hash.slice(1);
  const v = Object.hasOwn(VIEWS, h) && (h !== 'system' || phone()) ? h : root.dataset.view || 'today'; // own keys only (#constructor is no view); any other hash (#main: skip link) keeps the view
  if (v === root.dataset.view) return;
  root.dataset.view = v;
  $('#viewTitle').textContent = VIEWS[v];
  document.title = `${VIEWS[v]} · Taskboard`;
  for (const s of document.querySelectorAll('main > .view')) s.hidden = s.dataset.view !== v;
  for (const a of document.querySelectorAll('a[data-view]')) a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false');
  root.scrollTop = 0;
}

// ---------- api + toasts ----------
// 401 = no valid session cookie: swap the board for the same hint the server's locked page shows. Nothing runs after.
function lockOut(title = 'This browser is locked.', hint = ['Run ', el('code', null, 'tb open'), ' in Terminal.']) {
  ui.locked = true;
  es?.close();
  document.title = 'Taskboard locked';
  document.body.replaceChildren(el('main', { class: 'locked' }, el('h1', null, title), el('p', null, ...hint)));
}

function toast(msg, { kind = 'error', title } = {}) {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}` },
    el('p', null, title && el('strong', null, title), msg),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.remove(), kind === 'error' ? 10000 : 7000);
}

// P5: every change sends the session's synchronizer token (X-TB-CSRF), read once per trusted connection.
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
  if (r.status === 401) { lockOut(); return new Promise(() => {}); } // page is gone: callers never resume
  if (text && r.ok) return r.text();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status}).`), { status: r.status });
  for (const w of j.warnings || []) toast(w, { kind: 'warn', title: 'Heads up' });
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
    if ($('#live').dataset.live === 'on') toast('Could not load the board.', { title: 'Load failed' });
  }
}
const refresh = debounce(load, 150);

function setLive(on) {
  const p = $('#live');
  p.dataset.live = on ? 'on' : 'off';
  $('span', p).textContent = on ? 'Live' : 'Disconnected, retrying';
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

// ---------- focus strip + calendar ----------
function dueInfo(due) {
  const [y, m, d] = due.split('-').map(Number);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(y, m - 1, d) - midnight) / 864e5);
  if (n < 0) return { cls: 'late', text: `Overdue ${-n} ${n === -1 ? 'day' : 'days'}` };
  if (n === 0) return { cls: 'today', text: 'Due today' };
  if (n === 1) return { cls: '', text: 'Due tomorrow' };
  return { cls: '', text: `Due ${new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}` };
}

// due first, then project and tag: plain gray text, joined by a dot in CSS
function chips(t) {
  const out = [];
  if (t.due && t.status !== 'done') {
    const d = dueInfo(t.due);
    out.push(el('span', { class: `chip due ${d.cls}`, title: t.due }, d.text));
  }
  if (t.project) out.push(el('span', { class: 'chip proj' }, t.project));
  if (t.tag) out.push(el('span', { class: 'chip tag' }, t.tag));
  return out;
}

function renderFocus() {
  const top = colOf('now')[0];
  $('#focusTitle').textContent = top ? top.title : 'Nothing in Now.';
  $('#focusMeta').replaceChildren(...(top ? chips(top) : [el('span', null, 'Pull one up from Next.')]));
  const note = $('#focusNote');
  note.textContent = top?.note || '';
  note.hidden = !top?.note;
  const b = $('#focusDone');
  b.hidden = !top;
  b.onclick = top ? () => move(top.id, 'done', 0) : null;
  $('#focusEmpty').hidden = !!top;
  renderSched();
}

function renderSched() {
  const s = $('#sched'), c = state?.calendar || {};
  const line = text => s.append(el('p', { class: 'hint' }, text));
  const hint = 'Ask Claude to "sync calendar".';
  s.replaceChildren(el('h3', null, 'Calendar'));
  if (!c.updated) return line(`Not synced yet. ${hint}`);
  const upd = new Date(c.updated), now = new Date();
  if (upd.toDateString() !== now.toDateString()) return line(`Last synced ${upd.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}. ${hint}`);
  const left = (c.events || []).filter(e => !e.allDay && new Date(e.end) > now && new Date(e.start).toDateString() === now.toDateString());
  if (!left.length) return line(`No more meetings today. Synced ${hhmm(c.updated)}.`);
  s.append(el('ul', null, ...left.map((e, i) => {
    const mins = Math.round((new Date(e.start) - now) / 60000);
    const soon = i === 0 && mins > 0 && mins <= 120 ? `in ${mins} min` : i === 0 && mins <= 0 ? 'now' : '';
    return el('li', null, el('time', null, hhmm(e.start)), el('span', { class: 'ev' }, e.title), soon && el('span', { class: 'soon' }, soon));
  })));
  line(`Synced ${hhmm(c.updated)}`);
}

// ---------- reminders board ----------
function rememberFocus() {
  const a = document.activeElement, s = a?.closest?.('.strip');
  return s && $('#board').contains(a) ? { id: s.dataset.id, role: a.dataset.role === 'edit' ? 'menu' : a.dataset.role } : null;
}
function restoreFocus(f) {
  if (f) $(`.strip[data-id="${CSS.escape(f.id)}"] [data-role="${f.role || 'menu'}"]`)?.focus();
}

function renderReminders() {
  const f = rememberFocus();
  $('#board').replaceChildren(...COLS.map(([key, label]) => bay(key, label)));
  const ed = $('.strip input.edit');
  if (ed) { ed.focus(); ed.select(); } else restoreFocus(f);
}

function bay(key, label) {
  const items = colOf(key);
  const shown = key === 'done' ? items.slice(0, DONE_SHOWN) : items;
  const over = key === 'now' && items.length > NOW_LIMIT;
  const count = key === 'now' ? `${items.length} / ${NOW_LIMIT}` : String(items.length);
  const list = el('ul', { class: 'list', 'aria-labelledby': `bh-${key}` },
    ...shown.map((t, i) => strip(t, i, items.length, key === 'now' && i === 0)),
    !shown.length && el('li', { class: 'empty' }, EMPTY[key]),
    items.length > shown.length && el('li', { class: 'empty' }, `${items.length - shown.length} older not shown`));
  const b = el('section', { class: `bay${over ? ' over' : ''}`, 'data-col': key },
    el('h3', { id: `bh-${key}` }, label, el('span', { class: 'count' }, count, over && el('span', null, ' over limit'))), list);
  b.addEventListener('dragover', e => dragOver(e, b, list, key));
  b.addEventListener('dragleave', e => { if (!b.contains(e.relatedTarget)) clearDrop(); });
  b.addEventListener('drop', e => drop(e, list, key));
  return b;
}

function strip(t, i, total, isTop) {
  const done = t.status === 'done';
  const editing = ui.editing === t.id;
  const open = ui.tray === t.id;
  const s = el('li', { class: `strip${done ? ' done' : ''}${isTop ? ' top' : ''}`, draggable: !editing, 'data-id': t.id });
  s.addEventListener('dragstart', e => {
    ui.drag = t.id;
    s.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
  });
  s.addEventListener('dragend', endDrag);

  const title = editing
    ? editInput(t)
    : el('span', { class: 'title', title: 'Double-click to edit', ondblclick: () => startEdit(t.id) }, t.title);
  const note = t.note && !editing ? el('span', { class: 'note' }, t.note) : null;
  const meta = chips(t);
  s.append(
    el('span', { class: 'grip', 'aria-hidden': 'true' }),
    el('input', {
      type: 'checkbox', name: 'check', checked: done, 'data-role': 'check', 'aria-label': `${done ? 'Reopen' : 'Mark done'}: ${t.title}`,
      onchange: ev => move(t.id, ev.target.checked ? 'done' : 'next', 0),
    }),
    el('div', { class: 'body' }, isTop && el('span', { class: 'chip now' }, 'Do this now'), title, meta.length ? el('div', { class: 'meta' }, meta) : null, note),
    el('button', {
      type: 'button', class: 'icon-btn menu', 'data-role': 'menu', 'aria-expanded': String(open), 'aria-label': `Actions for ${t.title}`,
      onclick: () => { ui.tray = open ? null : t.id; renderReminders(); },
    }, '⋯'),
    ...(open ? [tray(t, i, total)] : []));
  return s;
}

const closeTray = () => { ui.tray = ui.promote = null; renderReminders(); };

// the ⋯ menu: floats under its button; Escape or a click outside closes it (boot)
function tray(t, i, total) {
  const btn = (label, fn, extra) => el('button', { type: 'button', class: 'item', onclick: fn, ...extra }, label);
  const del = btn('Delete', () => {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.textContent = 'Confirm delete?';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete'; }, 4000);
    } else remove(t.id);
  }, { 'data-role': 'del', class: 'item del' });
  return el('div', { class: 'tray', role: 'group', 'aria-label': `Actions for ${t.title}`, onkeydown: e => { if (e.key === 'Escape') closeTray(); } },
    btn('Edit', () => startEdit(t.id)),
    btn('Move up', () => move(t.id, t.status, i - 1), { disabled: i === 0 }),
    btn('Move down', () => move(t.id, t.status, i + 1), { disabled: i >= total - 1 }),
    el('label', null, 'Move to',
      el('select', { name: 'move-to', onchange: ev => move(t.id, ev.target.value, 0) },
        ...COLS.map(([k, l]) => el('option', { value: k, selected: k === t.status }, l)))),
    btn('Promote', () => {
      ui.promote = ui.promote === t.id ? null : t.id;
      loadTags();
      renderReminders();
      $('[data-role="promote-kind"]')?.focus();
    }, { 'data-role': 'promote', 'aria-expanded': String(ui.promote === t.id) }),
    del,
    ui.promote === t.id && promoteForm(t));
}

function promoteForm(t) {
  const pick = (name, opts) => el('label', null, name,
    el('select', { name: `promote-${name.toLowerCase()}`, 'data-role': `promote-${name.toLowerCase()}`, onchange: ev => { ui.pick[name.toLowerCase()] = ev.target.value; } }, ...opts));
  return el('form', { class: 'promote', 'aria-label': 'Promote to flow', onsubmit: ev => { ev.preventDefault(); promote(t); } },
    pick('Kind', KINDS.map(k => el('option', { value: k, selected: k === ui.pick.kind }, k))),
    pick('Tag', tagOptions(ui.pick.tag)),
    el('button', { type: 'submit', class: 'btn btn-sm' }, 'Promote to flow'),
    el('button', { type: 'button', class: 'btn btn-sm btn-gray', onclick: () => { ui.promote = null; renderReminders(); } }, 'Cancel'));
}

async function promote(t) {
  try {
    await api('POST', `/api/tickets/${encodeURIComponent(t.id)}/promote`, { kind: ui.pick.kind, tag: ui.pick.tag || undefined });
    state.reminders = state.reminders.filter(r => r.id !== t.id);
    ui.tray = ui.promote = null;
    render();
    refresh();
    toast(`"${t.title}" is now a ${ui.pick.kind} flow.`, { kind: 'info', title: 'Promoted' });
  } catch (e) { toast(e.message, { title: refused(e, 'Could not promote') }); }
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
    catch (e) { toast(e.message, { title: 'Could not save change' }); }
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
  state.reminders = state.reminders.filter(r => r.id !== id);
  ui.tray = null;
  render();
  try { await api('DELETE', `/api/reminders/${encodeURIComponent(id)}`); }
  catch (e) { toast(e.message, { title: 'Could not delete' }); load(); }
}

function startEdit(id) { ui.editing = id; ui.tray = null; renderReminders(); }

function editInput(t) {
  const input = el('input', { type: 'text', name: 'edit', class: 'edit', 'data-role': 'edit', 'aria-label': 'Edit title', maxLength: 200, value: t.title });
  input.value = t.title;
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    ui.editing = null;
    const v = input.value.trim();
    if (save && v && v !== t.title) { t.title = v; patch(t.id, () => ({ title: v })); }
    render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  return input;
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
  document.querySelectorAll('.strip.dragging').forEach(s => s.classList.remove('dragging'));
  if (ui.dirty) render();
}

// ---------- keyboard: alt+arrows move, e edits, arrows walk the column ----------
$('#board').addEventListener('keydown', e => {
  const s = e.target.closest('.strip');
  if (!s || e.target.matches('input[type="text"], select')) return;
  const t = byId(s.dataset.id);
  if (!t) return;
  const ci = COLS.findIndex(c => c[0] === t.status), i = colOf(t.status).indexOf(t);
  const colMove = d => COLS[ci + d] && move(t.id, COLS[ci + d][0], 0);
  const moves = { ArrowUp: () => move(t.id, t.status, i - 1), ArrowDown: () => move(t.id, t.status, i + 1), ArrowLeft: () => colMove(-1), ArrowRight: () => colMove(1) };
  if (e.altKey && moves[e.key]) { e.preventDefault(); moves[e.key](); }
  else if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'e' || e.key === 'F2')) { e.preventDefault(); startEdit(t.id); }
  else if (!e.altKey && e.target.dataset.role === 'check' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const checks = [...s.parentNode.querySelectorAll('[data-role="check"]')];
    const next = checks[checks.indexOf(e.target) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) { e.preventDefault(); next.focus(); }
  }
});

// ---------- flows ----------
const span = v => {
  const s = Math.max(0, Math.round((Date.now() - new Date(v)) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const ago = v => `${span(v)} ago`;

// Spec §8 liveness: a status dot and a word (green: working, orange: held or quiet, red: stuck or gone).
const LIVE = {
  thinking: ['ok', 'Thinking'], tool: ['ok', 'Tool'], waiting: ['wait', 'Waiting'], quiet: ['wait', 'Quiet'],
  stalled: ['bad', 'Stalled'], offline: ['bad', 'Offline'], paused: ['wait', 'Paused'], interrupted: ['bad', 'Interrupted'],
};
const liveTag = r => {
  const [tone, word] = LIVE[r.liveness] || ['', String(r.liveness)];
  return el('span', { class: `status lv ${tone}` },
    r.liveness === 'tool' && r.tool ? [r.tool, r.tool_at && el('span', { 'data-since': r.tool_at }, span(r.tool_at))] : word);
};

// Card stats of a run (`run` event): liveness, last activity, elapsed, subagents, RSS. Times tick in place (ticker).
function runStats(r) {
  const stat = (value, attrs, after) => el('span', { class: 'stat' }, el('span', attrs, value), after);
  const n = r.subagents_alive ?? 0;
  return el('span', { class: 'fstats' }, liveTag(r),
    r.last_event_at && stat(ago(r.last_event_at), { 'data-ago': r.last_event_at, title: 'Last activity' }),
    r.live && stat(span(r.started_at), { 'data-since': r.started_at }, ' elapsed'),
    r.live && stat(String(n), null, n === 1 ? ' agent' : ' agents'),
    r.live && stat(`${r.rss_mb ?? 0} MB`, { title: 'Memory (RSS)' }));
}
// a status word with its dot: tone ok green, wait orange, bad red, '' gray
const dot = (tone, ...text) => el('span', { class: `status${tone ? ` ${tone}` : ''}` }, ...text);
const TONE = Object.assign(Object.create(null), { done: 'ok', merged: 'ok', red: 'bad', blocked: 'bad', failed: 'bad' }); // a task's or lane's state (agent-set: no prototype keys)

// what a flow waits on, as card and drawer name it: qa:<tag> while another ticket of its tag holds QA (C9)
const waitLabel = (w, tag) => (w?.reason === 'qa_lock' ? `qa:${tag}` : w?.reason);
function flowCard(f) {
  const wait = f.waiting?.reason;
  const run = ui.runs.get(f.id);
  return el('li', null, el('button', { type: 'button', class: 'fcard', 'data-id': f.id, onclick: () => openTicket(f.id) },
    el('span', { class: 'ftitle' }, vis(f.title)),
    el('span', { class: 'fmeta' },
      el('span', null, f.kind || DASH),
      f.tag && el('span', null, f.tag),
      f.rework > 0 && dot('bad', `rework ${f.rework}`),
      wait && dot('wait', `waiting: ${waitLabel(f.waiting, f.tag)}${wait === 'children' ? ` ${f.waiting.done ?? '?'}/${f.waiting.total ?? '?'}` : ''}`)),
    run && runStats(run)));
}

// A `run` event: that card's stats (and the open drawer's run box) change in place; liveness null = the run left the view.
function onRun(e) {
  let r;
  try { r = JSON.parse(e.data); } catch { return; }
  if (typeof r?.id !== 'string') return;
  if (r.liveness == null) ui.runs.delete(r.id);
  else ui.runs.set(r.id, { ...r, tool_at: r.tool_s == null ? null : new Date(Date.now() - r.tool_s * 1000).toISOString() });
  const run = ui.runs.get(r.id);
  for (const card of document.querySelectorAll(`.fcard[data-id="${CSS.escape(r.id)}"]`)) {
    card.querySelector('.fstats')?.remove();
    if (run) card.append(runStats(run));
  }
  if (ui.open === r.id) {
    renderRunBox();
    reloadOpen(); // the run moved: the lease changed too
  }
}

// Rail order: what waits on Irfan first (by position and a dot, not color fills), then the pipeline. Empty stages fold
// into one line at the end.
const RAIL = ['clarify', 'plan_approval', 'blocked', 'backlog', 'planning', 'working', 'review', 'qa', 'final_gate', 'done'];
const orList = new Intl.ListFormat('en', { type: 'disjunction' });
function renderFlows() {
  const by = Object.groupBy(state.flows, f => f.state);
  const full = RAIL.filter(k => by[k]?.length), idle = RAIL.filter(k => !by[k]?.length);
  const any = full.length > 0;
  $('#rail').replaceChildren(...[
    any && !full.some(k => YOU.has(k)) && el('p', { class: 'rail-note' }, 'Nothing needs you right now.'),
    ...full.map(key => {
      const items = by[key];
      return el('section', { class: `fcol st-${STAGE[key] || 'auto'}`, 'aria-labelledby': `fh-${key}` }, // st-you, st-blocked: a dot before the heading
        el('div', { class: 'fhead' },
          el('h3', { id: `fh-${key}` }, stateLabel(key), el('span', { class: 'count' }, String(items.length))),
          YOU.has(key) && el('p', { class: 'you' }, 'Needs you')),
        el('ul', { class: 'flist' }, ...items.map(flowCard)));
    }),
    any && idle.length > 0 && el('p', { class: 'rail-note' }, `Nothing in ${orList.format(idle.map(stateLabel))}.`),
  ].filter(Boolean));
  $('#flows-empty').hidden = state.flows.length > 0;
  const gone = by.cancelled || [];
  $('#cancelled').hidden = !gone.length;
  $('#cancelled summary').textContent = `Cancelled (${gone.length})`;
  $('#cancelledList').replaceChildren(...gone.map(flowCard));
}

const stateLabel = s => FLOW_COLS.find(([k]) => k === s)?.[1] || s;
const flowOf = id => state.flows.find(x => x.id === id) || { id };
const OPS = { resume: 'Resume', restart: 'Restart phase', cancel: 'Cancel' };
const BTN1 = 'btn btn-sm', BTN2 = 'btn btn-sm btn-gray'; // foundation pills: the one filled action of a drawer state, the rest gray
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

// Order: what waits on Irfan first (waiting notice, Assign, Clarify form, plan to approve), related tickets, the run,
// the request, then an approved plan (read only: long, and the run matters more once it works).
function drawerBody(f, ticket, error) {
  const foc = drawerFocus(), scroll = logScroll();
  const dd = (k, v) => v == null || v === '' ? null : [el('dt', null, k), el('dd', null, String(v))];
  const k = ticket || {};
  const w = waitLabel(ticket ? k.waiting : f.waiting, f.tag || k.tag), tg = f.tag || k.tag, td = tagDef(tg);
  // L7: once frozen (plan_hash) the plan shown is the one approve froze (GET's plan), never a newer round file
  const r = ticket ? (k.plan_hash && ui.plan ? { ...ui.plan, n: ui.round?.n } : ui.round) : null, st = k.state;
  const plan = r?.kind === 'plan' && (st === 'plan_approval' || k.plan_hash) ? planView(f.id, k, r) : null; // a rejected plan (hash cleared) is not shown
  $('#drawer').replaceChildren(el('div', { class: 'insp' },
    el('div', { class: 'insp-head' },
      el('h2', null, vis(f.title || f.id)),
      el('button', { type: 'button', class: 'insp-close', 'data-role': 'close', 'aria-label': 'Close details', onclick: () => $('#drawer').close() }, '×')),
    el('dl', { class: 'facts' },
      dd('Kind', f.kind), dd('Tag', f.tag), dd('State', stateLabel(st || f.state)), dd('Waiting', w), dd('Rework', k.rework ?? f.rework), dd('Fix', k.fixes > 0 ? `${k.fixes}/${ui.fixMax}` : null),
      dd('QA', k.qa?.verdict ? `${k.qa.verdict} · ${k.qa.pass} pass · ${k.qa.fail} fail · ${k.qa.blocked} blocked` : null),
      dd('Final', isObj(k.final) ? finalText(k.final) : null),
      dd('Branch', k.branch), dd('Base', k.base_sha?.slice(0, 12)), dd('Push', isObj(k.push) ? pushText(k.push, k) : null),
      fact('Ident', identText(td) ?? (td?.push ? noIdent(tg) : null)),
      dd('Created', when(k.created_at)), dd('Updated', when(k.updated_at || f.updated_at)), dd('Id', f.id)),
    ticket && [
      notice(f.id, k.waiting),
      st === 'backlog' && el('section', { class: 'part', 'aria-labelledby': 'as-h' },
        el('h3', { id: 'as-h' }, 'Assign'),
        el('p', { class: 'hint' }, 'Assign starts planning: the planner reads the code, then asks you questions or writes a plan.'),
        el('div', { class: 'acts' }, actBtn(f.id, 'assign', () => post(f.id, 'assign'), { cls: BTN1 })),
        errLine(f.id, 'assign')),
      st === 'planning' && k.reject_comment && el('p', { class: 'hint' }, 'Your comment on the last plan: ', el('q', null, k.reject_comment)),
      st === 'planning' && k.must_ask && el('p', { class: 'hint' }, 'You asked for more: the planner asks you questions before it plans.'),
      st === 'clarify' && (k.clarify_origin?.phase === 'working' ? askPanel(f.id, k, ui.ask)
        : r?.kind === 'questions' && Array.isArray(r.questions) ? clarifyForm(f.id, r) : el('p', { class: 'hint' }, 'No open questions found.')),
      st === 'plan_approval' && (plan || el('p', { class: 'hint' }, 'No plan found.')),
      ['review', 'qa', 'final_gate'].includes(st) && stageActs(f.id, k),
      pushView(f.id, k, tg),
      isObj(k.final) && finalView(f.id, k),
      isObj(k.work) && workView(f.id, k),
      isObj(k.work) && gatesView(f.id),
      isObj(k.review) && reviewView(f.id, k),
      isObj(k.qa) && qaView(f.id, k),
      k.interventions > 0 && ivsView(f.id),
      family(k),
    ],
    el('section', { id: 'runbox', class: 'runbox', 'aria-labelledby': 'run-h' }, ...runBox(f.id, ticket)),
    el('section', { class: 'part', 'aria-labelledby': 'rq-h' }, el('h3', { id: 'rq-h' }, 'Request'),
      el('p', { class: 'ticket-text' }, error || (ticket ? vis(ticket.text) || 'No text.' : 'Loading'))),
    st !== 'plan_approval' && plan));
  refocus(foc);
  rescroll(scroll);
}

// Run section of the drawer (spec §10 card detail): run line, refused-run error (R17), Resume / Restart / Cancel,
// the outcome of the last click, log tail on demand.
function runBox(id, k) {
  const r = ui.runs.get(id), l = k?.lease, st = k?.state;
  const running = !!r?.live || (!!l && !l.exit);
  const live = running || !!l?.pending; // Resume is refused for both
  const n = /^runs\/(\d+)\.jsonl$/.exec(l?.log || '')?.[1];
  const out = [el('h3', { id: 'run-h' }, 'Run')];
  out.push(!l ? el('p', { class: 'hint' }, k ? 'No run yet.' : 'Loading') : el('p', { class: 'run-line' }, r && liveTag(r),
    el('span', null, [l.phase && stateLabel(l.phase), n && `run ${n}`, l.started_at && `started ${hhmm(l.started_at)}`,
      l.pending ? `recovering (${l.pending.why || l.pending.after})` : l.exit ? `ended: ${l.exit}` : 'live'].filter(Boolean).join(' · '))));
  if (l?.error && !l.pending) out.push(el('p', { class: 'warnbox' }, el('strong', null, 'Run refused. '), l.error.replace(BIDI, ''))); // names agent-made files: no bidi reordering
  const can = AGENT.includes(st) || st === 'blocked';
  const sure = armed(id, 'cancel'); // Cancel's confirm click
  const btn = (op, extra) => el('button', { type: 'button', class: `${BTN2}${op === 'cancel' && sure ? ' armed' : ''}`, 'data-role': op,
    onclick: () => runAction(id, op), ...extra }, op === 'cancel' && sure ? 'Confirm cancel?' : OPS[op]);
  // from blocked: the phase it blocked in, or an earlier one (tb resume --phase)
  const at = s => FLOW_COLS.findIndex(([c]) => c === s);
  const back = st === 'blocked' ? AGENT.filter(p => at(p) <= at(k.blocked_from) && !(p === 'qa' && k.kind === 'brainstorm')) : [];
  const acts = [
    back.length > 1 && el('label', { class: 'pick' }, 'Resume in ',
      el('select', { 'data-role': 'resume-phase', onchange: e => ui.phase.set(id, e.target.value) },
        ...back.map(p => el('option', { value: p, selected: (ui.phase.get(id) ?? k.blocked_from) === p }, stateLabel(p))))),
    can && btn('resume', { disabled: live, title: live ? 'The run is live. Resume works once it ended.' : null }),
    can && btn('restart'),
    st && st !== 'done' && st !== 'cancelled' && btn('cancel'),
  ].filter(Boolean);
  if (acts.length) out.push(el('div', { class: 'run-actions' }, ...acts));
  out.push(el('p', { class: 'hint', 'aria-live': 'polite' }, outcome(id, k, running)));
  const shown = ui.log?.id === id;
  if (l?.log || shown) out.push(el('div', { class: 'log-head' }, el('h4', null, 'Log tail'),
    l?.log && el('button', { type: 'button', class: 'tlink', 'data-role': 'log', onclick: () => loadLog(id) }, shown ? 'Refresh' : 'Show last 200 lines')));
  if (shown) out.push(ui.log.error ? el('p', { class: 'hint' }, ui.log.error)
    : el('pre', { class: 'log', 'data-role': 'log-tail', tabindex: '0', 'aria-label': 'Run log, last lines' }, ui.log.lines.join('\n') || 'Empty so far.'));
  return out;
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
  box.replaceChildren(...runBox(ui.open, ui.ticket));
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
    toast(e.message, { title: `${OPS[op]} refused` });
  }
  renderRunBox();
  reloadOpen();
}

async function loadLog(id) {
  try {
    ui.log = { id, lines: (await api('GET', `/api/tickets/${encodeURIComponent(id)}/log?tail=200`)).lines };
  } catch (e) {
    ui.log = { id, lines: [], error: e.status === 404 ? 'No run log yet.' : e.message };
  }
  renderRunBox();
  const pre = $('#runbox pre.log');
  if (pre) pre.scrollTop = pre.scrollHeight;
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
      drawerBody(flowOf(id), ui.ticket = j.lanes ? { ...j.ticket, lanes: j.lanes } : j.ticket); // M5.5: a parent's lanes ride on its ticket
    }
  } catch (e) {
    if (mine === openSeq && ui.open === id && !ui.ticket) drawerBody(flowOf(id), null, e.message); // else the next read tries again
  }
}
const reloadOpen = debounce(readOpen, 200);

async function openTicket(id) {
  const d = $('#drawer');
  if (ui.open !== id) Object.assign(ui, { log: null, ticket: null, round: null, plan: null, arm: null, err: null, ask: null, gates: null, ivs: null, fb: null, pass: null, qa: null, rec: null, final: null });
  ui.open = id;
  drawerBody(flowOf(id), ui.ticket);
  if (!d.open) d.showModal();
  else { d.scrollTop = 0; $('#drawer [data-role="close"]').focus(); } // moved to a parent, child or blocker inside the drawer
  // M5 C20: the tag's ident + push remote for the drawer, read per open (set by the CLI only; none read = no Push button)
  await Promise.all([readOpen(), api('GET', '/api/tags').then(j => { ui.tagDefs = j.tags || {}; redraw(); }, () => {})]);
}
// A held Enter repeats clicks on the refocused button: the first repeat after 400 ms would confirm Approve or Cancel.
$('#drawer').addEventListener('keydown', e => { if (e.repeat && e.key === 'Enter' && e.target.closest?.('button')) e.preventDefault(); });
$('#drawer').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#drawer').addEventListener('close', () => { if (!$('#drawer').open) ui.open = null; }); // a late close event never ends a newer open

// ---------- planning in the drawer (P4 AC5): Assign, Clarify form, plan + decision sources, Approve / Reject, children ----------
// POST /api/tickets/:id/{assign,answer,approve,reject}, same guards as tb. Agent text (questions, plan) is shown via vis().
const SENT = { // button role → [label, label while sending, toast title, toast text]
  assign: ['Assign', 'Assigning…', 'Assigned', 'Planning starts when a run slot is free.'],
  answer: ['Send answers', 'Sending…', 'Answers sent', 'The planner plans the next round with them.'],
  'plan-now': ['Enough, plan now', 'Sending…', 'Plan now', "What you left open is the planner's call."],
  approve: ['Approve', 'Approving…', 'Approved', 'Setting up: branch, skills, setup command, child tickets.'],
  reject: ['Reject', 'Sending…', 'Rejected', 'The planner plans again with your comment.'],
  ask: ['Ask me more', 'Sending…', 'Asked for more', 'The planner asks you questions first.'],
  // P5 (working): every one is a two-click action (armed first)
  'work-answer': ['Send answer', 'Sending…', 'Answer sent', 'The same session goes on with it.'],
  replan: ['Replan', 'Sending…', 'Replanning', 'The planner makes a new plan; done tasks it keeps stay done.'],
  'scope-allow': ['Allow files', 'Sending…', 'Allowed', 'This task may touch them now; the same session goes on.'],
  'scope-deny': ['Deny files', 'Sending…', 'Denied', 'The agent stays in scope or asks you again.'],
  'allow-change': ['Allow change', 'Sending…', 'Change allowed', 'The working gate runs again with it allowed.'],
  'deny-change': ['Deny change', 'Sending…', 'Change denied', 'A fix session reverts it.'],
  rework: ['Send back', 'Sending…', 'Sent back', 'A fix task works on your feedback.'],
  pass: ['Pass', 'Passing…', 'Passed', 'tbd recorded your pass.'],
  push: ['Push', 'Pushing…', 'Push started', 'Leak scan first, then git push. The outcome shows in the drawer.'],
  close: ['Close', 'Closing…', 'Closed', 'The flow is done. Nothing was pushed; the worktree stays until tb gc.'],
  lavish: ['Open in Lavish', 'Opening…', 'Lavish', 'The questions page opens in your browser.'],
  'pass-check': ['Check sha', 'Checking…', '', ''],
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
  work: 'Blocked: the gate stayed red after a resume and a fresh try. Read the gate below, then Resume or Restart.',
  scope: 'Blocked: the agent asked again for files you denied. Replan or Resume.',
  rework: 'Blocked: sent back more than twice. Resume resets the count.',
  // M5.2: QA not proven (a BLOCKED or ASSISTED case, or a 4th fix), the DB guard (a database URL not on this Mac)
  qa: 'Blocked: QA did not prove the change (or a 4th fix was needed). Read the QA below, then Resume.',
  db: 'Blocked: the DB guard refused an env file (a database not on this Mac). Fix the tag\'s env file, then Resume.',
  // M5.5: lanes (parallel tasks, each a ticket of its own; act on the parent)
  merge: 'Merging a finished lane into the branch. It goes on by itself.',
  lanes: 'Waiting for its lanes to finish. It goes on by itself.',
  lane_setup: 'Setting up the lane clones. Nothing to approve; it goes on by itself.',
  // M5.3 C12 C13: squashed, waiting on Irfan
  close: 'Waits for close: the final gate passed and the squash is made. Close it, push it, or send it back below.',
};
const BLOCKS = ['infra', 'integrity', 'config', 'work', 'scope', 'rework', 'qa', 'db'];
const code = s => el('code', null, vis(s));
const none = () => el('p', { class: 'hint' }, 'None.');

// While a request runs its buttons are aria-disabled, not disabled: keyboard focus stays on them across re-renders.
function actBtn(id, role, onclick, { cls = BTN2, label = undefined, sent = role, disabled = false } = {}) {
  const busy = ui.busy.get(id); // one request per ticket; other tickets stay usable
  return el('button', { type: 'button', class: cls, 'data-role': role, disabled, 'aria-disabled': busy ? 'true' : null, onclick: () => { if (!ui.busy.has(id)) onclick(); } },
    busy === role ? SENT[sent][1] : label ?? SENT[sent][0]);
}
const errLine = (id, ...roles) => ui.err?.id === id && roles.includes(ui.err.role) && el('p', { class: 'err' }, ui.err.text);

// A refusal shows inline (ui.err) and as a toast: the toast region is the one that speaks it. → null when tbd took it,
// else the refusal text (ui.err may be gone by then: a click elsewhere during the re-read resets it).
async function post(id, op, body, role = op, sent = role) {
  ui.busy.set(id, role);
  ui.err = null;
  redraw();
  try {
    await api('POST', `/api/tickets/${encodeURIComponent(id)}/${op}`, body);
    toast(SENT[sent][3], { kind: 'info', title: SENT[sent][2] });
    return null;
  } catch (e) {
    ui.err = { id, role, text: e.message };
    toast(e.message, { title: `${SENT[sent][0]} refused` });
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
    w.reason === 'setup_failed' && el('div', { class: 'acts' }, actBtn(id, 'approve', () => approve(id, true), { cls: BTN1, label: 'Approve again' })));
}

// Parent, blockers and children from the board's flow list: no request per ticket.
function family(k) {
  const row = id => {
    const c = state.flows.find(x => x.id === id);
    return el('li', null, el('button', { type: 'button', class: 'kin', 'data-role': `kin-${id}`, onclick: () => openTicket(id) },
      el('span', { class: 'ftitle' }, vis(c?.title || id)),
      el('span', { class: 'fmeta' }, el('span', null, c ? stateLabel(c.state) : 'not found'),
        c?.waiting?.reason && dot('wait', `waiting: ${c.waiting.reason}`))));
  };
  const kids = Array.isArray(k.children) ? k.children : [];
  const done = kids.filter(id => ['done', 'cancelled'].includes(state.flows.find(x => x.id === id)?.state)).length; // J4
  const parts = [
    k.parent && [el('h3', null, 'Part of'), el('ul', { class: 'kids' }, row(k.parent))],
    k.blocked_by?.length && [el('h3', null, 'Waits for'), el('ul', { class: 'kids' }, ...k.blocked_by.map(row))],
    kids.length && [el('h3', null, 'Child tickets', el('span', { class: 'count' }, `${done}/${kids.length} finished`)), el('ul', { class: 'kids' }, ...kids.map(row))],
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
  return actBtn(id, role, () => twoStep(id, op, send), { cls: `${cls}${sure ? ' armed' : ''}`, label: sure ? `Confirm: ${label.toLowerCase()}?` : label, sent, disabled });
}
const replanBtn = id => armBtn(id, 'replan', 'replan', () => post(id, 'answer', { replan: true }, 'replan'));

const ASKS = {
  scope: 'Files outside the task', protected: 'A protected file changed', deps: 'Dependencies changed', policy: 'A change the plan does not allow',
  NEEDS_CONTEXT: 'The agent needs context', TEST_DISPUTES_SPEC: 'A test disputes the spec', noop: 'Done without a change',
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
    acts = [el('label', { for: 'wa' }, 'Your answer'), box, d.errs.text && el('p', { class: 'err', id: 'wa-err' }, d.errs.text),
      el('div', { class: 'acts' }, armBtn(id, 'work-answer', 'work-answer', send, { cls: BTN1 }), replanBtn(id))];
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
    el('h3', { id: 'sg-h' }, `${stateLabel(st)}: your call`),
    !merged && !built && el('p', { class: 'hint' }, 'While this phase is not built you stand in for it: pass the work on, or send it back with feedback.'),
    st !== 'final_gate' && el('div', { class: 'acts' }, armBtn(id, 'pass', 'pass', () => post(id, 'pass', {}, 'pass'), { cls: BTN1, label: `Pass to ${stateLabel(next)}` })),
    built && el('p', { class: 'hint' }, 'tbd runs the final gate: checks, a final review, the squash. Then you close it (tb close) or push it (tb push).'),
    // role close-flow: data-role close is the drawer's own × (refocus)
    close && el('div', { class: 'acts' }, armBtn(id, 'close', 'close-flow', () => post(id, 'close', {}, 'close-flow', 'close'), { cls: BTN1, sent: 'close' })),
    st === 'final_gate' && !built && !merged && passForm(id),
    merged && el('p', { class: 'hint' }, 'Passed with ', code(String(k.pr.sha ?? '').slice(0, 12)), ` at ${when(k.pr.merged_at)}.`),
    // a BUILT final gate: tbd refuses a rework there (409) but at waiting close, so the send-back box only then
    !merged && (!built || close) && isObj(k.work) && [el('label', { for: 'rw' }, `Send back to working (sent back ${k.rework ?? 0} times; a 3rd time blocks it)`), box,
      d.errs.rw && el('p', { class: 'err', id: 'rw-err' }, d.errs.rw), el('div', { class: 'acts' }, armBtn(id, 'rework', 'rework', back))],
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
  if (!remote || !((k.state === 'final_gate' && k.waiting?.reason === 'close') || (k.state === 'done' && sha))) return null;
  return el('section', { class: 'part', 'aria-labelledby': 'pu-h' },
    el('h3', { id: 'pu-h' }, 'Push'),
    el('p', { class: 'hint' }, 'Sends the squash to the tag\'s push remote: a leak scan first, then git push with a lease. Never automatic.'),
    !d.ident && el('p', { class: 'err' }, ...noIdent(tag)),
    // one span: .notice is a grid, so loose text nodes + <code> would each take a row
    armed(id, 'push') && el('p', { class: 'notice' }, el('span', null, 'Push ', code(sha.slice(0, 12)), ' to ', code(remote), ' as branch ', code(k.branch ?? ''), '?')),
    // at waiting close Close is the filled one (the usual end); once done Push is the only action
    el('div', { class: 'acts' }, armBtn(id, 'push', 'push', () => post(id, 'push'), { cls: k.state === 'done' ? BTN1 : 'btn btn-sm btn-outline', disabled: !d.ident || !sha || k.push?.state === 'running' })),
    isObj(k.push) && el('p', { class: k.push.state === 'failed' ? 'err' : 'hint' }, 'Last push: ', pushText(k.push, k)),
    errLine(id, 'push'));
}

// D9: tbd checks the sha (GET …/pass?sha: every M15 check, nothing written); the confirm shows the full sha + its subject
// and wants the short sha typed again.
function passForm(id) {
  if (ui.pass?.id !== id) ui.pass = { id, input: '', typed: '', got: null, err: null };
  const p = ui.pass, short = p.got?.sha.slice(0, 7);
  const sha = el('input', { id: 'ps', type: 'text', 'data-role': 'pass-sha', maxLength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'ps-hint',
    oninput: e => { p.input = e.target.value.trim(); if (p.got) { p.got = null; redraw(); } } }); // a new sha: checked again
  sha.value = p.input;
  const check = async () => {
    if (!/^[0-9a-f]{7,40}$/.test(p.input)) {
      p.err = 'Type 7-40 lowercase hex characters: the squash commit on the base branch.';
      return redraw();
    }
    ui.busy.set(id, 'pass-check');
    Object.assign(p, { err: null, got: null, typed: '' });
    redraw();
    try { p.got = await api('GET', `/api/tickets/${enc(id)}/pass?sha=${enc(p.input)}`); } catch (e) { p.err = e.message; }
    ui.busy.delete(id);
    redraw();
  };
  const typed = el('input', { id: 'pt', type: 'text', 'data-role': 'pass-typed', maxLength: 40, autocomplete: 'off', spellcheck: 'false',
    oninput: e => { p.typed = e.target.value.trim(); const b = $('#drawer [data-role="pass"]'); if (b) b.disabled = p.typed !== short; } });
  typed.value = p.typed;
  return el('div', { class: 'part passform' },
    el('label', { for: 'ps' }, 'Squash commit (sha)'),
    el('div', { class: 'acts' }, sha, actBtn(id, 'pass-check', check, { label: 'Check sha' })),
    el('p', { class: 'hint', id: 'ps-hint' }, 'tbd checks it is a commit on the base branch, after base_sha, touching a file the branch changed.'),
    p.err && el('p', { class: 'err' }, p.err),
    p.got && el('div', { class: 'notice' },
      el('p', null, 'Commit ', code(p.got.sha)), el('p', { class: 'ctext' }, vis(p.got.subject || '(no subject)')),
      el('label', { for: 'pt' }, `Type ${short} to confirm`), typed,
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
    tasks.length ? el('table', { class: 'table dtable wtable' }, el('caption', { class: 'sr' }, 'Tasks: state, attempt, session mode, verified head'),
      el('thead', null, el('tr', null, ...['Task', 'State', 'Attempt', 'Mode', 'Head'].map(h => el('th', { scope: 'col', class: h === 'Attempt' ? 'num' : null }, h)))),
      el('tbody', null, ...tasks.map(x => el('tr', { class: x.id === w.task ? 'cur' : null, 'aria-current': x.id === w.task ? 'step' : null },
        el('td', null, code(String(x.id))), el('td', null, dot(TONE[x.status], vis(x.status))),
        el('td', { class: 'num' }, String(x.attempt ?? DASH)), el('td', null, mode(x)), el('td', null, x.head ? code(String(x.head).slice(0, 12)) : DASH))))) : none(),
    Array.isArray(k.lanes) && k.lanes.length > 0 && el('table', { class: 'table dtable wtable' }, el('caption', { class: 'sr' }, 'Lanes: task, ticket, state, waiting, live, attempt'),
      el('thead', null, el('tr', null, ...['Task', 'Lane', 'State', 'Waiting', 'Live', 'Attempt'].map(h => el('th', { scope: 'col', class: h === 'Attempt' ? 'num' : null }, h)))),
      el('tbody', null, ...k.lanes.filter(isObj).map(x => el('tr', null,
        el('td', null, code(String(x.task))), el('td', null, code(String(x.id))), el('td', null, dot(TONE[x.state], vis(x.state))),
        el('td', null, x.waiting ? vis(`${x.waiting.reason}${x.waiting.why ? `: ${x.waiting.why}` : ''}`) : DASH),
        el('td', null, x.live ? 'yes' : 'no'), el('td', { class: 'num' }, String(x.attempt ?? DASH)))))),
    el('dl', { class: 'facts' },
      fact('Gate', g && dot(g.ok === undefined ? '' : g.ok ? 'ok' : 'bad', `${vis(g.kind)} gate ${g.ok === undefined ? 'running' : g.ok ? 'green' : `red${g.class ? ` (${vis(g.class)})` : ''}`}${g.n ? ` · #${g.n}` : ''}`)),
      fact('Tries', String(w.tries ?? 0)), fact('Unit', w.unit_ms == null ? null : `${w.unit_ms} ms`),
      fact('Base checks', base.length ? base.map(([c, x]) => dot(x?.ok ? 'ok' : 'bad', `${vis(c)} ${x?.ok ? 'ok' : 'red'}${Number.isFinite(x?.ms) ? ` · ${secs(x.ms)}` : ''}`)) : null),
      fact('Rework', String(k.rework ?? 0)),
      fact('Plan hashes', hashes.length ? hashes.map(h => el('span', { class: `hash${h === k.plan_hash ? ' cur' : ''}`, title: h === k.plan_hash ? 'the current plan' : 'replaced' }, String(h).slice(0, 12))) : null)),
    k.rework > 0 && el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Your feedback:'),
      ...Array.from({ length: Math.min(k.rework, 10) }, (_, i) => el('button', { type: 'button', class: BTN2, 'data-role': `fb-${i + 1}`, onclick: () => loadFeedback(id, i + 1) }, `rework ${i + 1}`))),
    fb && (fb.error ? el('p', { class: 'hint' }, fb.error) : el('pre', { class: 'log', 'data-role': 'feedback', tabindex: '0', 'aria-label': `Your feedback, rework ${fb.n}` }, vis(fb.text))));
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
      el('button', { type: 'button', class: 'tlink', 'data-role': 'gates', onclick: () => loadGates(id) }, g ? 'Refresh' : 'Show gates')),
    g && (g.error ? el('p', { class: 'hint' }, g.error) : g.items.length ? el('div', null, ...g.items.map((x, i) => gateItem(id, x, i === 0, x === g.items.find(y => y.gate === 'working')))) : el('p', { class: 'hint' }, 'No gate ran yet.')),
    g?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: BTN2, 'data-role': 'gates-more', onclick: () => loadGates(id, g.next) }, 'Older gates')));
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
      dot(x.ok ? 'ok' : 'bad', x.ok ? 'green' : `red${x.class ? `: ${vis(x.class)}` : ''}`), el('span', { class: 'hint' }, [x.ms != null && secs(x.ms), x.truncated && 'cut to fit'].filter(Boolean).join(' · '))),
    checks.length ? el('table', { class: 'table dtable ctable' }, el('caption', { class: 'sr' }, `Gate ${x.n}: checks`),
      el('thead', null, el('tr', null, ...['Check', 'Result', 'Time', 'Exit', 'Log'].map(h => el('th', { scope: 'col', class: h === 'Time' || h === 'Exit' ? 'num' : null }, h)))),
      el('tbody', null, ...checks.map(c => el('tr', null,
        el('td', null, code(c.check ?? '?')),
        el('td', null, dot(c.ok ? 'ok' : 'bad', c.ok ? 'ok' : c.timed_out ? 'timed out' : 'red'), c.flaky && [' ', dot('wait', 'flaky')]),
        el('td', { class: 'num' }, secs(c.ms)), el('td', { class: 'num' }, c.exit == null ? DASH : String(c.exit)),
        el('td', null, c.log ? el('a', { href: `/api/tickets/${enc(id)}/gates/${enc(x.n)}/log?check=${enc(c.check)}`, target: '_blank', rel: 'noopener' }, 'full log') : DASH))))) : null,
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

// The review loop (lib/review.js): fix n of FIX_MAX, then the newest review's findings from GET …/report?kind=review. Agent text:
// el() / textContent only, never markup. Open = blocking (tbd's one rule); a closed id carries how it was fixed.
function reviewView(id, k) {
  const r = ui.review?.id === id ? ui.review : null;
  const rows = r?.data ? [...r.data.findings.map(x => [x, x.blocking ? 'open' : 'need review', x.failure_scenario]), ...r.data.closed.map(c => [{ id: c.id }, 'closed', c.how])] : [];
  return el('section', { class: 'part', 'aria-labelledby': 'rv-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'rv-h' }, 'Review', el('span', { class: 'count' }, `fix ${k.fixes ?? 0}/${ui.fixMax}`)),
      el('button', { type: 'button', class: 'tlink', 'data-role': 'review', onclick: () => loadReview(id) }, r ? 'Refresh' : 'Show review')),
    r?.error && el('p', { class: 'hint' }, r.error),
    r?.data && [el('p', { class: 'hint' }, `Review ${r.data.n}: `, dot(r.data.verdict === 'pass' ? 'ok' : 'bad', vis(r.data.verdict)), r.data.at ? ` · ${when(r.data.at)}` : '', r.data.truncated ? ' · cut to fit' : ''),
      findingsTable(`Review ${r.data.n}: findings`, rows)]);
}
// Review and Final findings, rows [finding, open | need review | closed, scenario or how fixed]. The drawer is 540 px:
// short fields in one row, the long texts in a full-width row under it.
function findingsTable(caption, rows) {
  return rows.length ? el('table', { class: 'table dtable rtable ftable' }, el('caption', { class: 'sr' }, caption),
    el('thead', null, el('tr', null, ...['Id', 'Severity', 'Confidence', 'Where', 'State'].map(h => el('th', { scope: 'col' }, h)))),
    el('tbody', null, ...rows.flatMap(([x, st, why]) => [
      el('tr', { class: st === 'closed' ? 'closed' : null }, el('td', null, code(String(x.id))), el('td', null, vis(x.severity ?? DASH)), el('td', null, vis(x.confidence ?? DASH)),
        el('td', null, x.where ? code(x.where) : DASH),
        el('td', null, dot(st === 'open' ? 'bad' : st === 'closed' ? 'ok' : 'wait', st))),
      el('tr', { class: 'rdetail' }, el('td', { colSpan: 5 }, ...(st === 'closed' ? [['How fixed', why]] : [['Problem', x.problem], ['Scenario', why], ['Fix', x.fix]])
        .map(([h, v]) => el('p', null, el('b', null, `${h}: `), vis(v || DASH)))))]))) : el('p', { class: 'hint' }, 'No findings.');
}
async function loadReview(id) {
  try { ui.review = { id, data: await api('GET', `/api/tickets/${enc(id)}/report?kind=review`) }; } catch (e) { ui.review = { id, error: e.status === 404 ? 'No review kept yet.' : e.message }; }
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
      el('button', { type: 'button', class: 'tlink', 'data-role': 'final', onclick: () => loadFinal(id) }, v ? 'Refresh' : 'Show final')),
    v && [...(d ? [el('p', { class: 'hint' }, `Final review ${d.n}: `, dot(d.verdict === 'pass' ? 'ok' : 'bad', vis(d.verdict)), d.at ? ` · ${when(d.at)}` : '', d.truncated ? ' · cut to fit' : ''),
      findingsTable(`Final review ${d.n}: findings`, d.findings.map(x => [x, x.blocking ? 'open' : 'need review', x.failure_scenario])),
      el('p', { class: 'hint' }, 'Verification doc: ', ver ? el('a', { href: ver, target: '_blank', rel: 'noopener' }, vis(d.verification_doc)) : code(String(d.verification_doc ?? DASH)))]
      : [el('p', { class: 'hint' }, v.final.error)]),
    el('h4', null, 'Summary'), text(v.summary, 'final-summary', 'Summary, as text'),
    el('h4', null, 'Verdict doc'), text(v.verdict, 'final-verdict', 'Verdict doc with the evidence tbd captured, as text')]);
}
async function loadFinal(id) {
  const get = (kind, none) => api('GET', `/api/tickets/${enc(id)}/report?kind=${kind}`).then(data => ({ data, text: data.text }), e => ({ error: e.status === 404 ? none : e.message }));
  const [final, summary, verdict] = await Promise.all([get('final', 'No final review kept yet.'),
    get('summary', 'No summary yet: a passing final review writes it.'), get('verdict', 'No verdict doc yet: it comes with a passing final review.')]);
  ui.final = { id, final, summary, verdict };
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
  const res = x => dot(/^pass$/i.test(x) ? 'ok' : /^fail$/i.test(x) ? 'bad' : 'wait', vis(x));
  const para = (h, ...v) => el('p', null, el('b', null, `${h}: `), ...v);
  const list = (h, xs) => (Array.isArray(xs) && xs.length ? para(h, ...xs.flatMap((x, i) => [i ? ' ' : '', code(String(x))])) : null);
  const report = d && docUrl(id, d.report);
  return el('section', { class: 'part', 'aria-labelledby': 'qa-h' },
    el('div', { class: 'log-head' }, el('h3', { id: 'qa-h' }, 'QA', el('span', { class: 'count' }, `QA ${k.qa.n ?? DASH}`)),
      el('button', { type: 'button', class: 'tlink', 'data-role': 'qa', onclick: () => loadQa(id) }, q ? 'Refresh' : 'Show QA')),
    q?.error && el('p', { class: 'hint' }, q.error),
    d && [el('p', { class: 'hint' }, `QA ${d.n}: `, res(d.verdict), d.at ? ` · ${when(d.at)}` : '', d.truncated ? ' · cut to fit' : ''),
      d.need_review.length ? el('div', { class: 'notice' }, el('p', null, el('strong', null, 'Check by hand: '), 'agent-made evidence can be faked.'),
        el('ul', { class: 'plist' }, ...d.need_review.map(x => el('li', null, vis(x))))) : null,
      d.cases.length ? el('table', { class: 'table dtable rtable' }, el('caption', { class: 'sr' }, `QA ${d.n}: cases`),
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
        report && el('button', { type: 'button', class: 'tlink', 'data-role': 'qa-report', onclick: () => loadQaDoc(id, report) }, q.doc ? 'Refresh report' : 'Show report')),
      q.doc && (q.doc.error ? el('p', { class: 'hint' }, q.doc.error) : el('pre', { class: 'log', 'data-role': 'qa-doc', tabindex: '0', 'aria-label': 'QA report, as text' }, vis(q.doc.text)))],
    el('div', { class: 'log-head' }, el('h4', null, 'Recs: the HTTP calls tbd made'),
      el('button', { type: 'button', class: 'tlink', 'data-role': 'recs', onclick: () => loadRecs(id) }, rec ? 'Refresh' : 'Show recs')),
    rec?.error && el('p', { class: 'hint' }, rec.error),
    rec?.runs?.length > 1 && el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Run'), el('div', { class: 'seg', role: 'group', 'aria-label': 'Run' }, ...rec.runs.map(n => el('button', { type: 'button',
      'aria-pressed': String(n === rec.run), 'data-role': `recs-${n}`, onclick: () => loadRecs(id, n) }, String(n))))),
    rec?.items && (rec.items.length ? rec.items.map(x => el('div', { class: 'rec' },
      el('p', { class: 'hint' }, code(String(x.n)), ` · ${x.status ?? `no answer: ${vis(x.error)}`} · ${x.ms} ms${x.at ? ` · ${when(x.at)}` : ''}${x.truncated ? ' · cut' : ''}`),
      el('pre', { class: 'log', tabindex: '0', 'aria-label': `rec ${vis(x.n)}: curl` }, vis(x.curl)),
      x.status != null && el('pre', { class: 'log', tabindex: '0', 'aria-label': `rec ${vis(x.n)}: answer` },
        vis([`HTTP ${x.status}`, ...(Array.isArray(x.headers) ? x.headers : []).map(([h, v]) => `${h}: ${v}`), '', x.body ?? ''].join('\n'))))) : none()),
    rec?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: BTN2, 'data-role': 'recs-more', onclick: () => loadRecs(id, rec.run, rec.next) }, 'Load more')));
}
async function loadQa(id) {
  try { ui.qa = { id, data: await api('GET', `/api/tickets/${enc(id)}/report?kind=qa`) }; } catch (e) { ui.qa = { id, error: e.status === 404 ? 'No QA result kept yet.' : e.message }; }
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
    el('div', { class: 'log-head' }, el('h3', { id: 'iv-h' }, 'Your actions'),
      el('button', { type: 'button', class: 'tlink', 'data-role': 'ivs', onclick: () => loadIvs(id) }, v ? 'Refresh' : 'Show')),
    v && (v.error ? el('p', { class: 'hint' }, v.error) : v.items.length ? el('table', { class: 'table dtable' }, el('caption', { class: 'sr' }, 'Your actions on this flow'),
      el('thead', null, el('tr', null, ...['Time', 'By', 'Action', 'Task'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, ...v.items.filter(isObj).map(x => el('tr', null, el('td', null, when(x.at) ?? DASH), el('td', null, vis(x.actor)), el('td', null, vis(x.verb)), el('td', null, x.task ? code(x.task) : DASH))))) : none()),
    v?.next != null && el('div', { class: 'acts' }, el('button', { type: 'button', class: BTN2, 'data-role': 'ivs-more', onclick: () => loadIvs(id, v.next) }, 'More')));
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

function clarifyForm(id, r) {
  const d = draftOf(id, r.n);
  return el('section', { class: 'part you', 'aria-labelledby': 'cq-h' },
    el('h3', { id: 'cq-h' }, `Questions · round ${r.n}`),
    el('p', { class: 'hint' }, "Answer each one, or press Enough, plan now: what you leave open is the planner's call."),
    el('div', { class: 'acts' }, actBtn(id, 'lavish', () => post(id, 'lavish', {}), { sent: 'lavish' })),
    errLine(id, 'lavish'),
    ...byTopic(r.questions).flatMap(([topic, qs]) => [topic && el('h4', null, vis(topic)), ...qs.map(([x, i]) => question(d, x, i))]),
    d.errs._ && el('p', { class: 'err' }, d.errs._),
    el('div', { class: 'acts' },
      actBtn(id, 'answer', () => sendAnswers(id, r, false), { cls: BTN1 }),
      actBtn(id, 'plan-now', () => sendAnswers(id, r, true)),
      el('span', { class: 'hint', 'data-count': '' }, answered(d, r))));
}

// questions under one heading per topic, first-appearance order; each keeps its index i (radio names, focus roles)
function byTopic(qs) {
  const g = new Map();
  qs.forEach((x, i) => g.set(x.topic ?? '', [...(g.get(x.topic ?? '') ?? []), [x, i]]));
  return [...g];
}

function question(d, x, i) {
  const a = d.a[x.id], name = `q${i}`, opts = Array.isArray(x.options) ? x.options : [];
  const set = v => { d.a[x.id] = { ...d.a[x.id], ...v }; delete d.errs[x.id]; };
  const radio = (mode, j, ...label) => el('label', null,
    el('input', { type: 'radio', name, 'data-role': `${name}-${mode}${j ?? ''}`, checked: a?.mode === mode && (j == null || a.i === j),
      onchange: () => { set({ mode, i: j }); redraw(); } }),
    el('span', null, ...label));
  const own = el('textarea', { name: `${name}-own`, rows: 2, maxLength: 10000, 'data-role': `${name}-own`, 'aria-label': `Your own answer to question ${i + 1}`,
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
    radio('recommended', null, 'Use recommended', !opts.includes(x.recommended) && [': ', el('b', null, vis(x.recommended))]),
    radio('you_decide', null, "You decide (planner's call)"),
    radio('text', null, 'My own answer'),
    own,
    d.errs[x.id] && el('p', { class: 'err', id: `${name}-err` }, d.errs[x.id]));
}

async function sendAnswers(id, r, planNow) {
  const d = draftOf(id, r.n), answers = Object.create(null);
  d.errs = Object.create(null);
  for (const x of r.questions) {
    const v = answerOf(d.a[x.id], x);
    if (v) answers[x.id] = v;
    else if (!planNow) d.errs[x.id] = 'Not answered yet. Answer it, or press Enough, plan now.';
  }
  const open = r.questions.findIndex(x => d.errs[x.id]);
  if (open >= 0) {
    redraw();
    return $(`#drawer [data-role^="q${open}-"]`)?.focus();
  }
  const err = await post(id, 'answer', { answers, ...(planNow && { plan_now: true }) }, planNow ? 'plan-now' : 'answer');
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
  return ['planner', "planner's call"];
}

function planView(id, k, r) {
  const open = k.state === 'plan_approval';
  const list = (xs, fn) => (Array.isArray(xs) && xs.length ? el('ul', { class: 'plist' }, ...xs.map(x => el('li', null, fn(x)))) : none());
  // J17: Irfan's locked decisions first (the planner may leave them out; the same id shows his text), then the planner's
  const locked = Array.isArray(k.locked_decisions) ? k.locked_decisions : [], mine = new Set(locked.map(x => x.id));
  const decs = [...locked, ...(Array.isArray(r.decisions) ? r.decisions : []).filter(x => !mine.has(x.id))].map(x => [x, source(String(x.source ?? ''))]);
  const count = who => decs.filter(([, s]) => s[0] === who).length;
  const tally = [['you', 'yours'], ['ticket', 'from the ticket'], ['adr', 'from ADRs'], ['planner', "planner's calls"]]
    .map(([who, l]) => count(who) && `${count(who)} ${l}`).filter(Boolean).join(' · ');
  return el('section', { class: `part plan${open ? ' you' : ''}`, 'aria-labelledby': 'pl-h' },
    el('h3', { id: 'pl-h' }, open ? `Plan to approve · round ${r.n}` : 'Approved plan'),
    el('p', { class: 'summary' }, vis(r.summary)),
    el('h4', null, 'Acceptance criteria'),
    list(r.acceptance, a => [el('span', { class: 'did' }, vis(a.id)), ' ', vis(a.text), ' ', el('span', { class: `ac${a.type === 'new' ? ' new' : ''}` }, vis(a.type))]),
    el('h4', null, 'Tasks'),
    Array.isArray(r.tasks) && r.tasks.length ? el('ol', { class: 'tasks' }, ...r.tasks.map(task)) : none(),
    el('h4', null, 'Schema changes allowed'), list(r.allowed_schema_changes, vis),
    el('h4', null, 'API changes allowed'), list(r.allowed_api_changes, vis),
    el('h4', null, 'Skills for Working'),
    Array.isArray(r.skills) && r.skills.length ? el('p', { class: 'toks' }, ...r.skills.map(code)) : none(),
    r.ui && [el('h4', null, 'UI'), el('p', { class: 'ctext' }, vis(r.ui))],
    el('h4', null, 'Child tickets'),
    list(r.children, c => [el('strong', null, vis(c.title)), c.blocked_by?.length ? ` · waits for ${c.blocked_by.map(vis).join(', ')}` : '', el('span', { class: 'ctext' }, vis(c.text))]),
    el('h4', null, 'Decisions'),
    decs.length ? [el('p', { class: 'hint' }, tally), el('table', { class: 'table dtable' },
      el('caption', { class: 'sr' }, 'Decisions and their source'),
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
  const d = draftOf(id, r.n), sure = armed(id, 'approve');
  const box = el('textarea', { id: 'rj', name: 'comment', rows: 3, maxLength: 10000, 'data-role': 'comment', 'aria-describedby': d.errs.comment ? 'rj-err' : null,
    oninput: e => { d.comment = e.target.value; } });
  box.value = d.comment;
  return el('div', { class: 'part' },
    el('label', { for: 'rj' }, 'Comment for Reject or Ask me more'),
    box,
    d.errs.comment && el('p', { class: 'err', id: 'rj-err' }, d.errs.comment),
    el('div', { class: 'acts' },
      k.waiting?.reason !== 'setup_failed' && actBtn(id, 'approve', () => approve(id), { cls: `${BTN1}${sure ? ' armed' : ''}`, label: sure ? 'Confirm approve?' : 'Approve' }),
      actBtn(id, 'reject', () => sendReject(id, r, false)),
      actBtn(id, 'ask', () => sendReject(id, r, true))),
    sure && el('p', { class: 'hint' }, 'Press again to approve. The plan is frozen and setup starts.'),
    errLine(id, 'approve', 'reject', 'ask'));
}

function approve(id, again = false) {
  if (!again && !armed(id, 'approve')) { // freezes the plan and starts setup: one more click to confirm
    arm(id, 'approve');
    redraw();
    setTimeout(redraw, 4000);
    return;
  }
  if (!again && early()) return;
  ui.arm = null;
  post(id, 'approve', ui.round?.n === undefined ? undefined : { n: ui.round.n }); // L7: the round shown; tbd refuses (409) when a newer one came
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

// ---------- composer ----------
const mode = () => $('#composer .seg [aria-pressed="true"]').value;

// flows need a leaf tag that has a path (a tag with children is only a group)
const leafTags = tags => Object.keys(tags).filter(n => tags[n]?.path && !Object.keys(tags).some(o => o.startsWith(`${n}/`))).sort();
const tagOptions = sel => [el('option', { value: '' }, 'No tag'), ...ui.tags.map(n => el('option', { value: n, selected: n === sel }, n))];
const refused = (err, fallback) => (err.status === 409 ? 'Not available yet' : fallback);

async function loadTags() {
  if (ui.tagsLoaded) return;
  try {
    ui.tags = leafTags((await api('GET', '/api/tags')).tags || {});
    ui.tagsLoaded = true;
    $('#flowTag').replaceChildren(...tagOptions());
    if (ui.promote) renderReminders();
  } catch (e) { toast(e.message, { title: 'Could not load tags' }); }
}

function initComposer() {
  $('#flowKind').replaceChildren(...KINDS.map(k => el('option', { value: k }, k)));
  $('#flowTag').replaceChildren(...tagOptions());
  $('#composer .seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    press($('#composer .seg'), b.value);
    const flow = mode() === 'flow';
    $('#flowKind').hidden = $('#flowTag').hidden = !flow;
    $('#newTitle').placeholder = flow ? 'Describe the goal for an agent.' : 'Add a reminder. It lands in Inbox.';
    if (flow) loadTags();
  });
  $('#composer').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#newTitle'), v = input.value.trim(), flow = mode() === 'flow', btn = $('button[type="submit"]', e.target);
    if (!v) return;
    btn.disabled = true;
    try {
      if (flow) await api('POST', '/api/flows', { text: v, kind: $('#flowKind').value, tag: $('#flowTag').value || undefined });
      else await api('POST', '/api/reminders', { title: v, status: 'inbox', pos: 'top' });
      input.value = '';
      refresh();
      if (root.dataset.view !== (flow ? 'flows' : 'reminders')) toast(flow ? 'The flow is in Backlog.' : 'The reminder is in Inbox.', { kind: 'info', title: 'Added' }); // it landed out of sight
    } catch (err) {
      toast(err.message, { title: refused(err, `Could not add ${flow ? 'flow' : 'reminder'}`) });
    }
    btn.disabled = false;
    input.focus();
  });
}

// ---------- boot ----------
function render() {
  if (!state) return;
  ui.dirty = false;
  renderHeader();
  renderFocus();
  renderReminders();
  renderFlows();
}

route();
globalThis.onhashchange = route; // window's handler (the vm test stub has no addEventListener)
document.addEventListener('click', e => { if (ui.tray && !e.target.closest('.tray, .menu')) closeTray(); });
initComposer();
if (uiKey) reconnect(); else lockOut(); // no ui_key (first visit after D39, or storage blocked): tb open once more
// DOM-only refresh of relative times ("in 20 min"); no network
setInterval(() => { if (document.visibilityState === 'visible' && state && !ui.locked) renderSched(); }, 60000);
// Run times tick in place each second (last activity, elapsed, tool time); no network, no re-render
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  for (const e of document.querySelectorAll('[data-ago]')) e.textContent = ago(e.dataset.ago);
  for (const e of document.querySelectorAll('[data-since]')) e.textContent = span(e.dataset.since);
}, 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
