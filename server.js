#!/usr/bin/env node
// taskboard: tiny local server for your task board. Zero dependencies.
// - serves index.html + a small JSON API over tasks.json
// - sends a macOS notification with your top task at REMIND_AT times (weekdays)
// Listens on 127.0.0.1 only. Run by launchd (label: local.taskboard).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DIR = process.env.TASKBOARD_DIR || path.join(os.homedir(), 'taskboard');
const TASKS = path.join(DIR, 'tasks.json');
const CAL = path.join(DIR, 'calendar.json');
const HTML = path.join(DIR, 'index.html');
const PORT = Number(process.env.PORT) || 7777;
const REMIND_AT = (process.env.REMIND_AT || '09:00,13:00,16:30').split(',').map(s => s.trim());
const STATUSES = ['inbox', 'now', 'next', 'later', 'done'];

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function readTasks() {
  const data = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
  return { mtime: fs.statSync(TASKS).mtimeMs, data };
}

function writeTasks(data) {
  const tmp = TASKS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, TASKS); // atomic: readers never see half a file
  return fs.statSync(TASKS).mtimeMs;
}

function valid(tasks) {
  return Array.isArray(tasks) && tasks.every(t =>
    t && typeof t.id === 'string' && typeof t.title === 'string' && STATUSES.includes(t.status));
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'forbidden' });

  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, fs.readFileSync(HTML), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && req.url === '/api/tasks') {
      const { mtime, data } = readTasks();
      return send(res, 200, { mtime, tasks: data.tasks });
    }
    if (req.method === 'GET' && req.url === '/api/calendar') {
      if (!fs.existsSync(CAL)) return send(res, 200, { updated: null, events: [] });
      return send(res, 200, JSON.parse(fs.readFileSync(CAL, 'utf8')));
    }
    if (req.method === 'PUT' && req.url === '/api/tasks') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const current = readTasks();
          // File changed since the page loaded it (Claude edited it) -> reject, page reloads.
          if (incoming.mtime !== current.mtime) {
            return send(res, 409, { mtime: current.mtime, tasks: current.data.tasks });
          }
          if (!valid(incoming.tasks)) return send(res, 400, { error: 'invalid tasks' });
          const mtime = writeTasks({ ...current.data, tasks: incoming.tasks });
          send(res, 200, { mtime });
        } catch (e) {
          send(res, 400, { error: e.message });
        }
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// ---- reminders -------------------------------------------------------------
function notify(title, message, subtitle = '') {
  // Pass text as argv so quotes in task titles can't break the AppleScript.
  execFile('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)',
    '-e', 'end run',
    title, message, subtitle,
  ], () => {});
}

function summary() {
  const tasks = readTasks().data.tasks.filter(t => t.status !== 'done');
  const today = localDate();
  const now = tasks.filter(t => t.status === 'now');
  const overdue = tasks.filter(t => t.due && t.due < today).length;
  const inbox = tasks.filter(t => t.status === 'inbox').length;
  const top = now[0] ? now[0].title : 'Nothing in Now. Pick one from Next.';
  const extra = [
    `${now.length} in Now`,
    overdue ? `${overdue} overdue` : '',
    inbox ? `${inbox} in Inbox` : '',
  ].filter(Boolean).join(' · ');
  return { top, extra };
}

let lastFired = '';
function tick() {
  const d = new Date();
  if (d.getDay() === 0 || d.getDay() === 6) return; // weekdays only
  const hhmm = d.toTimeString().slice(0, 5);
  const key = localDate(d) + ' ' + hhmm;
  if (!REMIND_AT.includes(hhmm) || key === lastFired) return;
  lastFired = key;
  try {
    const { top, extra } = summary();
    notify('Do now', top, extra);
  } catch (e) {
    console.error('reminder failed:', e.message);
  }
}

// ---- start -----------------------------------------------------------------
if (!fs.existsSync(TASKS)) writeTasks({ tasks: [] });

if (process.argv.includes('--notify-test')) {
  const { top, extra } = summary();
  notify('Do now', top, extra);
  console.log('sent:', top, '|', extra);
  setTimeout(() => process.exit(0), 500);
} else {
  setInterval(tick, 20 * 1000);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`taskboard on http://localhost:${PORT}  (reminders: ${REMIND_AT.join(', ')} weekdays)`);
  });
}
