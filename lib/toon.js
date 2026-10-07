'use strict';
// TOON output helpers shared by bin/tb and bin/taskboard-axi (copied from the v1 taskboard-axi).
const { STATUSES } = require('./store'); // one source of truth with tbd
const SHOW_ORDER = ['now', 'next', 'inbox', 'later', 'done'];
const NOW_LIMIT = 3;
const ROW = ['id', 'status', 'pos', 'project', 'due', 'title'];

function cell(v) {
  if (typeof v === 'number') return String(v);
  const s = v == null ? '' : String(v);
  const quote = s === '' || /^\s|\s$/.test(s) || /[,:"\\[\]{}#\n\r\t]/.test(s) || s.startsWith('-') ||
    /^(true|false|null)$/.test(s) || /^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s);
  return quote ? JSON.stringify(s) : s;
}

function table(name, rows, fields = ROW) {
  if (!rows.length) return [`${name}[0]: none`];
  return [`${name}[${rows.length}]{${fields.join(',')}}:`,
    ...rows.map(r => '  ' + fields.map(f => cell(r[f])).join(','))];
}

// Adds pos (1-based place inside its status column), keeps array order.
function addPos(tasks) {
  const n = {};
  return tasks.map(t => ({ ...t, pos: (n[t.status] = (n[t.status] || 0) + 1) }));
}

// Rows grouped in SHOW_ORDER; a status outside SHOW_ORDER (flow states) goes last.
function bySection(rows) {
  const at = s => SHOW_ORDER.includes(s) ? SHOW_ORDER.indexOf(s) : SHOW_ORDER.length;
  return rows.sort((a, b) => at(a.status) - at(b.status) || a.pos - b.pos);
}

const withPos = tasks => bySection(addPos(tasks));

// 1-based place of t inside its status column.
const posOf = (tasks, t) => tasks.filter(x => x.status === t.status).findIndex(x => x.id === t.id) + 1;

function line(verb, t, pos) {
  return [`${verb}: ${t.id} → ${t.status} #${pos}`, t.project, t.due && `due ${t.due}`, t.title]
    .filter(Boolean).join(' · ');
}

function warnings(tasks) {
  const now = tasks.filter(t => t.status === 'now').length;
  return now > NOW_LIMIT ? [`warn: now has ${now} tasks (limit ${NOW_LIMIT}); move the lowest to next`] : [];
}

module.exports = { STATUSES, SHOW_ORDER, NOW_LIMIT, ROW, cell, table, addPos, bySection, withPos, posOf, line, warnings };
