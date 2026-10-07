// Taskboard UI: vanilla, no deps. Same-origin only: /api/* and one EventSource on /events.
// Auth is the HttpOnly tb_session cookie from `tb open` (fetch sends it same-origin); the page holds no token.
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
const NOW_LIMIT = 3, DONE_SHOWN = 15, GB = 2 ** 30, MB = 2 ** 20, DASH = '—';

let state = null; // { reminders, flows, system, calendar } after first load
const ui = { drag: null, editing: null, tray: null, promote: null, pick: { kind: KINDS[0], tag: '' }, dirty: false, tags: [], tagsLoaded: false, locked: false };

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hhmm = v => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
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
// 401 = no valid session cookie: swap the board for the same hint the server's locked page shows.
function lockOut() {
  ui.locked = true;
  document.body.replaceChildren(el('main', { class: 'locked' },
    el('h1', null, 'This browser is locked.'), el('p', null, 'Run ', el('code', null, 'tb open'), ' in Terminal.')));
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
  if (saving.n || ui.locked) return; // the save chain reloads once it drains
  const mine = ++loadSeq;
  try {
    const r = await fetch('/api/state');
    if (r.status === 401) return lockOut();
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (mine !== loadSeq) return; // a newer load is in flight
    state = { reminders: j.reminders || [], flows: j.flows || [], system: j.system || {}, calendar: j.calendar || {} };
    if (ui.drag || ui.editing) ui.dirty = true; else render();
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

function connect() {
  const es = new EventSource('/events');
  let wasDown = false;
  es.onopen = () => { setLive(true); if (wasDown) load(); wasDown = false; }; // reload after a reconnect: events may have been missed
  es.onerror = () => {
    wasDown = true;
    setLive(false);
    if (es.readyState === EventSource.CLOSED) { // browser gave up (e.g. 401); load() spots a lock, else retry
      setTimeout(async () => { await load(); if (!ui.locked) connect(); }, 3000);
    }
  };
  es.addEventListener('reminder', refresh);
  es.addEventListener('ticket', refresh);
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

  const p = $('#paused');
  p.hidden = !s.paused_until;
  if (s.paused_until) {
    const d = new Date(s.paused_until);
    const when = d.toDateString() === new Date().toDateString() ? hhmm(d) : d.toLocaleString();
    p.textContent = `Agent runs are paused until ${when}.${PAUSE[s.paused_reason] ? ` ${PAUSE[s.paused_reason]}` : ''}`;
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
      type: 'checkbox', checked: done, 'data-role': 'check', 'aria-label': `${done ? 'Reopen' : 'Mark done'}: ${t.title}`,
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
      el('select', { onchange: ev => move(t.id, ev.target.value, 0) },
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
    el('select', { 'data-role': `promote-${name.toLowerCase()}`, onchange: ev => { ui.pick[name.toLowerCase()] = ev.target.value; } }, ...opts));
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
  const input = el('input', { type: 'text', class: 'edit', 'data-role': 'edit', 'aria-label': 'Edit title', maxLength: 200, value: t.title });
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
const ago = v => {
  const s = Math.max(0, Math.round((Date.now() - new Date(v)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function flowCard(f) {
  const wait = f.waiting?.reason;
  const live = f.liveness || 'unknown'; // placeholder fields arrive with P3
  const stat = (label, value) => el('span', { class: 'stat' }, el('span', null, label), value);
  return el('li', null, el('button', { type: 'button', class: 'fcard', 'data-id': f.id, onclick: () => openTicket(f.id) },
    el('span', { class: 'ftitle' }, f.title),
    el('span', { class: 'frow' },
      el('span', { class: 'chip kind' }, f.kind || DASH),
      f.tag && el('span', { class: 'chip tag', style: `--h:${hue(f.tag)}` }, f.tag),
      f.rework > 0 && el('span', { class: 'chip rework' }, `rework ${f.rework}`)),
    wait && el('span', { class: 'chip wait' }, `waiting: ${wait}`),
    el('span', { class: 'fstats' },
      el('span', { class: 'stat' }, el('i', { class: `live-dot ${live}`, 'aria-hidden': 'true' }), el('span', { class: 'sr' }, `Liveness: ${live}`)),
      stat('last activity', f.last_activity ? ago(f.last_activity) : DASH),
      stat('agents', `${f.subagents ?? DASH}/3`),
      stat('RSS', f.rss == null ? DASH : fmtBytes(f.rss)))));
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

const when = v => (v ? new Date(v).toLocaleString() : null);

function drawerBody(f, ticket, error) {
  const dd = (k, v) => v == null || v === '' ? null : [el('dt', null, k), el('dd', null, String(v))];
  const w = f.waiting?.reason;
  $('#drawer').replaceChildren(el('div', { class: 'sheet' },
    el('div', { class: 'sheet-head' },
      el('h2', null, f.title || f.id),
      el('button', { type: 'button', class: 'ghost', 'aria-label': 'Close details', onclick: () => $('#drawer').close() }, '×')),
    el('dl', { class: 'facts' },
      dd('Kind', f.kind), dd('Tag', f.tag), dd('State', f.state), dd('Waiting', w), dd('Rework', f.rework),
      dd('Created', when(ticket?.created_at)), dd('Updated', when(f.updated_at)), dd('Id', f.id)),
    el('h3', null, 'Request'),
    el('p', { class: 'ticket-text' }, error || (ticket ? ticket.text || 'No text.' : 'Loading')),
    el('p', { class: 'hint' }, 'Plan, questions, tasks and run logs show up here as agents are built.')));
}

async function openTicket(id) {
  const f = state.flows.find(x => x.id === id) || { id };
  drawerBody(f, null);
  $('#drawer').showModal();
  try { drawerBody(f, (await api('GET', `/api/tickets/${encodeURIComponent(id)}`)).ticket); }
  catch (e) { drawerBody(f, null, e.message); }
}
$('#drawer').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

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
load();
connect();
// DOM-only refresh of relative times ("in 20 min"); no network
setInterval(() => { if (document.visibilityState === 'visible' && state && !ui.locked) renderSched(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
