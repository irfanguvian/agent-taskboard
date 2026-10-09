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
const AGENT = ['planning', 'working', 'review', 'qa']; // phases with agent runs (fsm.AGENT)
const NOW_LIMIT = 3, DONE_SHOWN = 15, GB = 2 ** 30, MB = 2 ** 20, DASH = '—';

let state = null; // { reminders, flows, system, calendar } after first load
let es = null; // the one EventSource
let trusted = false; // tbd proved itself and the stream has not dropped since: only then do requests carry the cookie
let wait = 1000; // reconnect backoff, ms (max 30 s)
const ui = { drag: null, editing: null, tray: null, promote: null, pick: { kind: KINDS[0], tag: '' }, dirty: false, tags: [], tagsLoaded: false, locked: false,
  runs: new Map(), open: null, ticket: null, log: null, act: null, arm: null, // runs: id → `run` event; open: the drawer's flow id + its ticket, log tail, last action, Cancel / Approve armed
  round: null, plan: null, drafts: new Map(), busy: new Map(), err: null }; // the open ticket's newest planning round and frozen plan, Clarify / Reject drafts (`${id}:${n}` → draft), planning action in flight (id → role), its refusal

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const day = v => { const d = new Date(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const today = () => day(Date.now());
const hhmm = v => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = v => (v ? `${day(v)} ${hhmm(v)}` : null); // one time format everywhere: local, 24 h
// teal..magenta only: orange, red and green are reserved for meaning
const hue = s => 170 + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 140, 7);
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
const safe = fn => { try { return fn(); } catch { return undefined; /* storage blocked */ } };

// ---------- theme ----------
const root = document.documentElement;
const savedTheme = safe(() => localStorage.getItem('tb-theme'));
if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function syncThemeBtn() {
  const b = $('#theme');
  b.textContent = isDark() ? 'Light' : 'Dark';
  b.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
}
$('#theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  root.dataset.theme = next;
  safe(() => localStorage.setItem('tb-theme', next));
  syncThemeBtn();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeBtn);

// ---------- api + toasts ----------
// 401 = no valid session cookie: swap the board for the same hint the server's locked page shows. Nothing runs after.
function lockOut(title = 'This browser is locked.', hint = ['Run ', el('code', null, 'tb open'), ' in Terminal.']) {
  ui.locked = true;
  es?.close();
  document.body.replaceChildren(el('main', { class: 'locked' }, el('h1', null, title), el('p', null, ...hint)));
}

function toast(msg, { kind = 'error', title } = {}) {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}` },
    el('p', null, title && el('strong', null, title), msg),
    el('button', { type: 'button', class: 'ghost', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.remove(), kind === 'error' ? 10000 : 7000);
}

async function api(method, path, body) {
  if (!trusted) throw Object.assign(new Error('tbd is not reachable.'), { status: 0 });
  const init = { method, headers: {} };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('tbd is not reachable.'), { status: 0 });
  }
  if (r.status === 401) { lockOut(); return new Promise(() => {}); } // page is gone: callers never resume
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

function chips(t) {
  const out = [];
  if (t.project) out.push(el('span', { class: 'chip proj', style: `--h:${hue(t.project)}` }, t.project));
  if (t.tag) out.push(el('span', { class: 'chip tag', style: `--h:${hue(t.tag)}` }, t.tag));
  if (t.due && t.status !== 'done') {
    const d = dueInfo(t.due);
    out.push(el('span', { class: `chip due ${d.cls}`, title: t.due }, d.text));
  }
  return out;
}

function renderFocus() {
  const top = colOf('now')[0];
  $('#focusTitle').textContent = top ? top.title : 'Nothing in Now. Pull one up from Next.';
  $('#focusMeta').replaceChildren(...(top ? [...chips(top), top.note && el('span', { class: 'focus-note' }, top.note)] : []).filter(Boolean));
  const b = $('#focusDone');
  b.hidden = !top;
  b.onclick = top ? () => move(top.id, 'done', 0) : null;
  renderSched();
}

function renderSched() {
  const s = $('#sched'), c = state?.calendar || {};
  const hint = 'Ask Claude to "sync calendar".';
  s.replaceChildren();
  if (!c.updated) return s.append(el('p', null, `Calendar not synced yet. ${hint}`));
  const upd = new Date(c.updated), now = new Date();
  if (upd.toDateString() !== now.toDateString()) return s.append(el('p', null, `Calendar last synced ${upd.toDateString()}. ${hint}`));
  const left = (c.events || []).filter(e => !e.allDay && new Date(e.end) > now && new Date(e.start).toDateString() === now.toDateString());
  if (!left.length) return s.append(el('p', null, `No more meetings today. Synced ${hhmm(c.updated)}.`));
  s.append(el('h3', null, 'Today'), el('ul', null, ...left.map((e, i) => {
    const mins = Math.round((new Date(e.start) - now) / 60000);
    const when = i === 0 && mins > 0 && mins <= 120 ? `in ${mins} min` : i === 0 && mins <= 0 ? 'now' : '';
    return el('li', null, el('time', null, hhmm(e.start)), el('b', null, e.title), when && el('span', null, when));
  })), el('p', { class: 'synced' }, `Synced ${hhmm(c.updated)}`));
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
  const key = t.project || t.tag;
  const s = el('li', {
    class: `strip${done ? ' done' : ''}${isTop ? ' top' : ''}${key ? '' : ' nohue'}`, draggable: !editing, 'data-id': t.id,
    style: `--h:${key ? hue(key) : 0};--i:${Math.min(i, 8)}`,
  });
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
      type: 'button', class: 'ghost menu', 'data-role': 'menu', 'aria-expanded': String(open), 'aria-label': `Actions for ${t.title}`,
      onclick: () => { ui.tray = open ? null : t.id; renderReminders(); },
    }, '⋯'),
    ...(open ? [tray(t, i, total)] : []));
  return s;
}

function tray(t, i, total) {
  const btn = (label, fn, extra) => el('button', { type: 'button', class: 'ghost', onclick: fn, ...extra }, label);
  const del = btn('Delete', () => {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.textContent = 'Confirm delete?';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete'; }, 4000);
    } else remove(t.id);
  }, { 'data-role': 'del' });
  return el('div', { class: 'tray' },
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
    el('button', { type: 'submit', class: 'primary' }, 'Promote to flow'),
    el('button', { type: 'button', class: 'ghost', onclick: () => { ui.promote = null; renderReminders(); } }, 'Cancel'));
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

// Spec §8 liveness: an icon and a word. Dots are CSS; the others are text glyphs (\uFE0E: never emoji).
const LIVE = {
  thinking: ['', 'Thinking'], tool: ['\u2699\uFE0E', 'Tool'], waiting: ['\u29D7', 'Waiting'], quiet: ['', 'Quiet'],
  stalled: ['', 'Stalled'], offline: ['\u21AF', 'Offline'], paused: ['\u2016', 'Paused'], interrupted: ['\u2715', 'Interrupted'],
};
const liveTag = r => {
  const [icon, word] = LIVE[r.liveness] || ['', String(r.liveness)];
  return el('span', { class: `lv ${r.liveness}` }, el('i', { 'aria-hidden': 'true' }, icon),
    r.liveness === 'tool' && r.tool ? [r.tool, r.tool_at && el('span', { 'data-since': r.tool_at }, span(r.tool_at))] : word);
};

// Card stats of a run (`run` event): liveness, last activity, elapsed, subagents, RSS. Times tick in place (ticker).
function runStats(r) {
  const stat = (label, value, attrs) => el('span', { class: 'stat' }, el('span', null, label), el('span', attrs, value));
  return el('span', { class: 'fstats' }, liveTag(r),
    stat('last activity', r.last_event_at ? ago(r.last_event_at) : DASH, r.last_event_at && { 'data-ago': r.last_event_at }),
    r.live && stat('elapsed', span(r.started_at), { 'data-since': r.started_at }),
    r.live && stat('agents', String(r.subagents_alive ?? 0)),
    r.live && stat('RSS', `${r.rss_mb ?? 0} MB`));
}

function flowCard(f) {
  const wait = f.waiting?.reason;
  const run = ui.runs.get(f.id);
  return el('li', null, el('button', { type: 'button', class: 'fcard', 'data-id': f.id, onclick: () => openTicket(f.id) },
    el('span', { class: 'ftitle' }, vis(f.title)),
    el('span', { class: 'frow' },
      el('span', { class: 'chip kind' }, f.kind || DASH),
      f.tag && el('span', { class: 'chip tag', style: `--h:${hue(f.tag)}` }, f.tag),
      f.rework > 0 && el('span', { class: 'chip rework' }, `rework ${f.rework}`)),
    wait && el('span', { class: 'chip wait' }, `waiting: ${wait}`),
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

function renderFlows() {
  const by = Object.groupBy(state.flows, f => f.state);
  $('#rail').replaceChildren(...FLOW_COLS.map(([key, label]) => {
    const items = by[key] || [];
    return el('section', { class: `fcol st-${STAGE[key] || 'auto'}${items.length ? '' : ' empty'}`, 'aria-labelledby': `fh-${key}` },
      el('h3', { id: `fh-${key}` }, label, el('span', { class: 'count' }, String(items.length))),
      YOU.has(key) && el('p', { class: 'you' }, 'needs you'),
      el('ul', { class: 'flist' }, ...items.map(flowCard)));
  }));
  $('#flows-empty').hidden = state.flows.length > 0;
  const gone = by.cancelled || [];
  $('#cancelled').hidden = !gone.length;
  $('#cancelled summary').textContent = `Cancelled (${gone.length})`;
  $('#cancelledList').replaceChildren(...gone.map(flowCard));
}

const stateLabel = s => FLOW_COLS.find(([k]) => k === s)?.[1] || s;
const flowOf = id => state.flows.find(x => x.id === id) || { id };
const OPS = { resume: 'Resume', restart: 'Restart phase', cancel: 'Cancel' };
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
  const w = (ticket ? k.waiting : f.waiting)?.reason;
  // L7: once frozen (plan_hash) the plan shown is the one approve froze (GET's plan), never a newer round file
  const r = ticket ? (k.plan_hash && ui.plan ? { ...ui.plan, n: ui.round?.n } : ui.round) : null, st = k.state;
  const plan = r?.kind === 'plan' && (st === 'plan_approval' || k.plan_hash) ? planView(f.id, k, r) : null; // a rejected plan (hash cleared) is not shown
  $('#drawer').replaceChildren(el('div', { class: 'sheet' },
    el('div', { class: 'sheet-head' },
      el('h2', null, vis(f.title || f.id)),
      el('button', { type: 'button', class: 'ghost', 'data-role': 'close', 'aria-label': 'Close details', onclick: () => $('#drawer').close() }, '×')),
    el('dl', { class: 'facts' },
      dd('Kind', f.kind), dd('Tag', f.tag), dd('State', stateLabel(st || f.state)), dd('Waiting', w), dd('Rework', k.rework ?? f.rework),
      dd('Branch', k.branch), dd('Base', k.base_sha?.slice(0, 12)),
      dd('Created', when(k.created_at)), dd('Updated', when(k.updated_at || f.updated_at)), dd('Id', f.id)),
    ticket && [
      notice(f.id, k.waiting),
      st === 'backlog' && el('section', { class: 'part', 'aria-labelledby': 'as-h' },
        el('h3', { id: 'as-h' }, 'Assign'),
        el('p', { class: 'hint' }, 'Assign starts planning: the planner reads the code, then asks you questions or writes a plan.'),
        el('div', { class: 'acts' }, actBtn(f.id, 'assign', () => post(f.id, 'assign'), { cls: 'primary' })),
        errLine(f.id, 'assign')),
      st === 'planning' && k.reject_comment && el('p', { class: 'hint' }, 'Your comment on the last plan: ', el('q', null, k.reject_comment)),
      st === 'planning' && k.must_ask && el('p', { class: 'hint' }, 'You asked for more: the planner asks you questions before it plans.'),
      st === 'clarify' && (r?.kind === 'questions' && Array.isArray(r.questions) ? clarifyForm(f.id, r) : el('p', { class: 'hint' }, 'No open questions found.')),
      st === 'plan_approval' && (plan || el('p', { class: 'hint' }, 'No plan found.')),
      family(k),
    ],
    el('section', { id: 'runbox', class: 'runbox', 'aria-labelledby': 'run-h' }, ...runBox(f.id, ticket)),
    el('h3', null, 'Request'),
    el('p', { class: 'ticket-text' }, error || (ticket ? vis(ticket.text) || 'No text.' : 'Loading')),
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
  const btn = (op, extra) => el('button', { type: 'button', class: `ghost${op === 'cancel' && sure ? ' armed' : ''}`, 'data-role': op,
    onclick: () => runAction(id, op), ...extra }, op === 'cancel' && sure ? 'Confirm cancel?' : OPS[op]);
  const acts = [
    can && btn('resume', { disabled: live, title: live ? 'The run is live. Resume works once it ended.' : null }),
    can && btn('restart'),
    st && st !== 'done' && st !== 'cancelled' && btn('cancel'),
  ].filter(Boolean);
  if (acts.length) out.push(el('div', { class: 'run-actions' }, ...acts));
  out.push(el('p', { class: 'hint', 'aria-live': 'polite' }, outcome(id, k, running)));
  const shown = ui.log?.id === id;
  out.push(el('div', { class: 'log-head' }, el('h3', null, 'Log tail'),
    l?.log && el('button', { type: 'button', class: 'ghost', 'data-role': 'log', onclick: () => loadLog(id) }, shown ? 'Refresh' : 'Show last 200 lines')));
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
    await api('POST', `/api/tickets/${encodeURIComponent(id)}/${op}`, op === 'resume' ? {} : undefined);
    ui.act.state = 'accepted';
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
      drawerBody(flowOf(id), ui.ticket = j.ticket);
    }
  } catch (e) {
    if (mine === openSeq && ui.open === id && !ui.ticket) drawerBody(flowOf(id), null, e.message); // else the next read tries again
  }
}
const reloadOpen = debounce(readOpen, 200);

async function openTicket(id) {
  const d = $('#drawer');
  if (ui.open !== id) Object.assign(ui, { log: null, ticket: null, round: null, plan: null, arm: null, err: null });
  ui.open = id;
  drawerBody(flowOf(id), ui.ticket);
  if (!d.open) d.showModal();
  else { d.scrollTop = 0; $('#drawer [data-role="close"]').focus(); } // moved to a parent, child or blocker inside the drawer
  await readOpen();
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
};
const WAIT = {
  setup: 'Setting up the approved plan: branch, env files, skills, the setup command, child tickets.',
  setup_failed: 'Setup failed. The plan stays as approved. Fix the cause, then approve again.',
  assign_failed: 'Auto-assign failed. Fix the cause, then assign it.',
  blocker_cancelled: 'A ticket this one waits for was cancelled. Assign it to go on without it, or cancel this ticket.',
};
const code = s => el('code', null, vis(s));
const none = () => el('p', { class: 'hint' }, 'None.');

// While a request runs its buttons are aria-disabled, not disabled: keyboard focus stays on them across re-renders.
function actBtn(id, role, onclick, { cls = 'ghost', label = SENT[role][0] } = {}) {
  const busy = ui.busy.get(id); // one request per ticket; other tickets stay usable
  return el('button', { type: 'button', class: cls, 'data-role': role, 'aria-disabled': busy ? 'true' : null, onclick: () => { if (!ui.busy.has(id)) onclick(); } },
    busy === role ? SENT[role][1] : label);
}
const errLine = (id, ...roles) => ui.err?.id === id && roles.includes(ui.err.role) && el('p', { class: 'err' }, ui.err.text);

// A refusal shows inline (ui.err) and as a toast: the toast region is the one that speaks it. → null when tbd took it,
// else the refusal text (ui.err may be gone by then: a click elsewhere during the re-read resets it).
async function post(id, op, body, role = op) {
  ui.busy.set(id, role);
  ui.err = null;
  redraw();
  try {
    await api('POST', `/api/tickets/${encodeURIComponent(id)}/${op}`, body);
    toast(SENT[role][3], { kind: 'info', title: SENT[role][2] });
    return null;
  } catch (e) {
    ui.err = { id, role, text: e.message };
    toast(e.message, { title: `${SENT[role][0]} refused` });
    return e.message;
  } finally {
    await readOpen(); // the fresh ticket first: with the old one the same buttons would work again (a 2nd click → 409)
    ui.busy.delete(id);
    redraw();
  }
}

// waiting reasons the drawer explains (manual, usage, memory…: the Waiting fact says enough)
function notice(id, w) {
  const text = WAIT[w?.reason];
  if (!text) return null;
  return el('div', { class: `notice${w.reason.endsWith('_failed') ? ' bad' : ''}` },
    el('p', null, w.reason === 'setup' && el('span', { class: 'spin', 'aria-hidden': 'true' }), text),
    w.error && el('pre', { class: 'log', 'data-role': 'wait-error', tabindex: '0', 'aria-label': 'Error output, last part' }, vis(w.error)),
    w.reason === 'setup_failed' && el('div', { class: 'acts' }, actBtn(id, 'approve', () => approve(id, true), { cls: 'primary', label: 'Approve again' })));
}

// Parent, blockers and children from the board's flow list: no request per ticket.
function family(k) {
  const row = id => {
    const c = state.flows.find(x => x.id === id);
    return el('li', null, el('button', { type: 'button', class: 'kin', 'data-role': `kin-${id}`, onclick: () => openTicket(id) },
      el('span', { class: 'ftitle' }, vis(c?.title || id)),
      el('span', { class: 'frow' }, el('span', { class: 'chip' }, c ? stateLabel(c.state) : 'not found'),
        c?.waiting?.reason && el('span', { class: 'chip wait' }, `waiting: ${c.waiting.reason}`))));
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
  return el('section', { class: 'part', 'aria-labelledby': 'cq-h' },
    el('h3', { id: 'cq-h' }, `Questions · round ${r.n}`),
    el('p', { class: 'hint' }, "Answer each one, or press Enough, plan now: what you leave open is the planner's call."),
    ...r.questions.map((x, i) => question(d, x, i)),
    d.errs._ && el('p', { class: 'err' }, d.errs._),
    el('div', { class: 'acts' },
      actBtn(id, 'answer', () => sendAnswers(id, r, false), { cls: 'primary' }),
      actBtn(id, 'plan-now', () => sendAnswers(id, r, true)),
      el('span', { class: 'hint', 'data-count': '' }, answered(d, r))));
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
    ...opts.map((o, j) => radio('pick', j, vis(o), o === x.recommended && el('span', { class: 'chip rec' }, 'Recommended'))),
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
  return el('section', { class: 'part plan', 'aria-labelledby': 'pl-h' },
    el('h3', { id: 'pl-h' }, open ? `Plan to approve · round ${r.n}` : 'Approved plan'),
    el('p', { class: 'summary' }, vis(r.summary)),
    el('h4', null, 'Acceptance criteria'),
    list(r.acceptance, a => [el('span', { class: `chip ac ${a.type === 'new' ? 'new' : ''}` }, vis(a.type)), ' ', el('span', { class: 'did' }, vis(a.id)), ' ', vis(a.text)]),
    el('h4', null, 'Tasks'),
    Array.isArray(r.tasks) && r.tasks.length ? el('ol', { class: 'tasks' }, ...r.tasks.map(task)) : none(),
    el('h4', null, 'Schema changes allowed'), list(r.allowed_schema_changes, vis),
    el('h4', null, 'API changes allowed'), list(r.allowed_api_changes, vis),
    el('h4', null, 'Skills for Working'),
    Array.isArray(r.skills) && r.skills.length ? el('p', { class: 'frow' }, ...r.skills.map(s => el('span', { class: 'chip' }, vis(s)))) : none(),
    r.ui && [el('h4', null, 'UI'), el('p', { class: 'ctext' }, vis(r.ui))],
    el('h4', null, 'Child tickets'),
    list(r.children, c => [el('strong', null, vis(c.title)), c.blocked_by?.length ? ` · waits for ${c.blocked_by.map(vis).join(', ')}` : '', el('span', { class: 'ctext' }, vis(c.text))]),
    el('h4', null, 'Decisions'),
    decs.length ? [el('p', { class: 'hint' }, tally), el('table', { class: 'dtable' },
      el('caption', { class: 'sr' }, 'Decisions and their source'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Decision'), el('th', { scope: 'col' }, 'Source'))),
      el('tbody', null, ...decs.map(([x, [who, label]]) => el('tr', { class: who },
        el('td', null, el('span', { class: 'did' }, vis(x.id)), ' ', vis(x.text)),
        el('td', null, el('span', { class: `src ${who}`, title: vis(x.source) }, vis(label)))))))] : none(),
    open && k.waiting?.reason !== 'setup' && planActs(id, k, r)); // Reject is refused while setup runs
}

const task = t => el('li', { class: 'task' },
  el('p', null, el('span', { class: 'did' }, vis(t.id)), ' ', el('strong', null, vis(t.title)), t.type && [' ', el('span', { class: 'chip' }, vis(t.type))]),
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
      k.waiting?.reason !== 'setup_failed' && actBtn(id, 'approve', () => approve(id), { cls: `primary${sure ? ' armed' : ''}`, label: sure ? 'Confirm approve?' : 'Approve' }),
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
const mode = () => $('#composer input[name="mode"]:checked').value;

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
  $('#composer').addEventListener('change', e => {
    if (e.target.name !== 'mode') return;
    const flow = mode() === 'flow';
    $('#flowKind').hidden = $('#flowTag').hidden = !flow;
    $('#newTitle').placeholder = flow ? 'Describe the goal for an agent.' : 'Add a reminder. It lands in Inbox.';
    if (flow) loadTags();
  });
  $('#composer').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#newTitle'), v = input.value.trim(), flow = mode() === 'flow', btn = $('.primary', e.target);
    if (!v) return;
    btn.disabled = true;
    try {
      if (flow) await api('POST', '/api/flows', { text: v, kind: $('#flowKind').value, tag: $('#flowTag').value || undefined });
      else await api('POST', '/api/reminders', { title: v, status: 'inbox', pos: 'top' });
      input.value = '';
      refresh();
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

syncThemeBtn();
initComposer();
document.body.classList.add('boot');
setTimeout(() => document.body.classList.remove('boot'), 1500);
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
