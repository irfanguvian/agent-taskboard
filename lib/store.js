'use strict';
// store: the only writer of reminders, tickets, tags and config under TB_HOME (spec §2).
// init() loads everything once (sync, startup only); reads are served from memory. Every write runs
// through one promise queue as tmp file + rename, and memory changes only after the disk did.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { TbError } = require('./errors');
const tagsLib = require('./tags');
const phases = require('./phases');

const HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const FILE = {
  tasks: path.join(HOME, 'tasks.json'),
  tags: path.join(HOME, 'tags.json'),
  config: path.join(HOME, 'config.json'),
  events: path.join(HOME, 'events.jsonl'),
  token: path.join(HOME, 'token'),
  pid: path.join(HOME, 'tbd.pid'),
  calendar: path.join(HOME, 'calendar.json'),
  tickets: path.join(HOME, 'tickets'),
  log: path.join(HOME, 'tbd.log'),
};
const STATUSES = ['inbox', 'now', 'next', 'later', 'done'];
const KINDS = ['code', 'research', 'brainstorm', 'design'];
const NOW_LIMIT = 3;
const ID_RE = /^t_[a-z0-9]{6}$/;

// spec App A config + plan D2 (8 GB numbers), D3, D12, D28, §3b.
const DEFAULTS = {
  claude_bin: path.join(HOME, 'bin', 'claude-2.1.292'),
  max_concurrent: 1,
  memory: {
    min_free_gb: 1,
    phase_need_gb: { planning: 0.4, review: 0.4, working: 1.0, qa: 1.5 }, // D36: measured sonnet peaks + headroom; real medians replace them
    docker_reserved_gb: 2,
    start_at_warn_when_idle: true,
  },
  disk: { warn_gb: 15, stop_gb: 8 },
  liveness: { quiet_min: 5, stall_min: 15, wake_grace_min: 6, wall_min: { planning: 30, working_task: 45, review: 30, qa: 60 } },
  recovery: { max_failures_per_phase: 3 },
  subagents: { concurrent: 3, per_session_total: 3, depth: 1 },
  models: {
    planning: { model: 'fable', effort: 'high' },
    review: { model: 'fable', effort: 'high' },
    working: { model: 'opus', effort: 'xhigh' },
    qa: { model: 'opus', effort: 'xhigh' },
    pr: { model: 'sonnet' },
    context: { model: 'sonnet' },
  },
  fable_billing: 'plan',
  max_turns: { planning: 60, working_task: 80, review: 40, qa: 80, pr: 10 },
  caffeinate: 'ac_only',
  http: { port: 7777 },
  notify: { reping_min: 30, quiet: '22:00-07:00' },
  tz: 'Asia/Jakarta',
  remind_at: ['09:00', '13:00', '16:30'],
};

const emitter = new EventEmitter();
let data = { tasks: [] }; // tasks.json; data.tasks = reminders in board order
let tagMap = {};
let config = DEFAULTS;
let configFile = DEFAULTS; // what config.json holds; updateConfig changes only this
let token = '';
const tickets = new Map();
const skipped = new Set(); // unreadable ticket dirs: their ids stay taken
/** @type {Promise<any>} */
let queue = Promise.resolve();

const bad = (msg) => new TbError(400, msg);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tz = () => process.env.TB_TZ || config.tz;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: tz() });

// ---- startup ------------------------------------------------------------------
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8'); // startup
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new TbError(500, `${file} is not valid JSON (${e.message}); fix or move it, then restart`);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// After a crash the pid may belong to another program now: ask ps for its command line.
function isTbd(pid) {
  if (!alive(pid)) return false;
  const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); // startup
  return Boolean(ps.error) || /(^|[\s/])tbd\.js(\s|$)/.test(ps.stdout); // ps unusable: assume tbd, refuse
}

const readPid = () => {
  const n = Number(fs.readFileSync(FILE.pid, 'utf8')); // startup
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// Single instance: tbd.pid naming a live tbd refuses the start. Stale (replaced): written before this boot,
// or its pid is dead or runs another program. Empty or garbage = a tbd between create and write: re-read
// once after 50 ms, then refuse; never remove a file another tbd may be writing.
function claimPid() {
  const boot = Date.now() - os.uptime() * 1000;
  for (let i = 0; i < 2; i++) {
    try {
      return fs.writeFileSync(FILE.pid, String(process.pid), { flag: 'wx', mode: 0o600 }); // startup
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (fs.statSync(FILE.pid).mtimeMs >= boot) { // startup
      let pid = readPid();
      if (!pid) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // startup: sync 50 ms sleep
        pid = readPid();
      }
      if (!pid) throw new TbError(409, `${FILE.pid} holds no pid; if no tbd is running, delete it`);
      if (pid !== process.pid && isTbd(pid)) throw new TbError(409, `tbd already running (pid ${pid})`);
    }
    fs.rmSync(FILE.pid, { force: true }); // startup
  }
  throw new TbError(409, 'could not claim tbd.pid');
}

function loadToken() {
  let t = '';
  try {
    t = fs.readFileSync(FILE.token, 'utf8').trim(); // startup
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!/^[0-9a-f]{64}$/.test(t)) {
    t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(FILE.token, t, { mode: 0o600 }); // startup
  }
  fs.chmodSync(FILE.token, 0o600); // startup: mode above only applies when the file is created
  return t;
}

function validTask(t) {
  return isObj(t) && typeof t.id === 'string' && typeof t.title === 'string' && STATUSES.includes(t.status);
}

function init() {
  fs.mkdirSync(FILE.tickets, { recursive: true, mode: 0o700 }); // startup
  fs.chmodSync(HOME, 0o700); // startup: mode above only applies when the dir is created
  for (const f of [FILE.tasks, FILE.tags, FILE.config, FILE.events, FILE.log]) {
    try {
      fs.chmodSync(f, 0o600); // startup: files left by v1 or older code, and tbd.log (launchd creates it)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  claimPid();
  token = loadToken();
  const file = readJson(FILE.config, null);
  // ponytail: shallow merge; a nested object in config.json replaces the default one whole.
  config = { ...DEFAULTS, ...file };
  configFile = file || DEFAULTS;
  if (!file) fs.writeFileSync(FILE.config, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 }); // startup
  tagMap = readJson(FILE.tags, {});
  if (!isObj(tagMap)) throw new TbError(500, `${FILE.tags} must hold a JSON object; fix it, then restart`);
  data = readJson(FILE.tasks, { tasks: [] });
  if (!isObj(data) || !Array.isArray(data.tasks) || !data.tasks.every(validTask)) {
    throw new TbError(500, `${FILE.tasks} has an invalid "tasks" array; fix it, then restart`);
  }
  // v1 rows have no type: add it in memory, the next write saves it. Order untouched.
  data.tasks = data.tasks.map((t) => (t.type ? t : { ...t, type: 'reminder' }));
  for (const id of fs.readdirSync(FILE.tickets)) { // startup
    try {
      tickets.set(id, JSON.parse(fs.readFileSync(path.join(FILE.tickets, id, 'ticket.json'), 'utf8'))); // startup
    } catch (e) {
      skipped.add(id);
      console.error(`tbd: skipped ticket ${id}: ${e.message}`);
    }
  }
  today(); // fail fast on a bad TB_TZ / config.tz
}

async function releasePid() {
  const pid = await fsp.readFile(FILE.pid, 'utf8').catch(() => '');
  if (pid === String(process.pid)) await fsp.rm(FILE.pid, { force: true });
}

// ---- write path -----------------------------------------------------------------
// ponytail: one global queue for every file; per-file queues if write throughput ever matters.
/** @template T @param {() => T | Promise<T>} fn @returns {Promise<T>} */
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

// fsync before rename: a crash leaves the old file or the new one, never an empty one. A failed write
// removes its tmp file (best effort) before rethrowing.
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, file);
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');
// The event log trails a saved write: a failed append is logged, never undoes or fails that write.
const appendEvent = (file, ev) => fsp.appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n', { mode: 0o600 })
  .catch((e) => console.error(`tbd: event not logged to ${file}: ${e.message}`));

function uid() {
  for (;;) {
    const id = 't_' + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    if (!tickets.has(id) && !skipped.has(id) && !data.tasks.some((t) => t.id === id)) return id;
  }
}

// ---- reminders (v1 taskboard-axi semantics) --------------------------------------
const CLEARABLE = ['project', 'tag', 'due', 'note'];
const ADD_KEYS = ['title', 'status', 'pos', ...CLEARABLE];
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);
const CHECK = {
  title: (v) => (typeof v === 'string' && v.trim() && v.trim().length <= 500 ? '' : 'title must be 1-500 characters'),
  status: (v) => (STATUSES.includes(v) ? '' : `status must be one of ${STATUSES.join(', ')}`),
  pos: (v) => (v === 'top' || v === 'bottom' || ((typeof v === 'number' || typeof v === 'string') && /^[1-9]\d*$/.test(String(v))) ? '' : 'pos must be top, bottom or a number from 1'),
  due: (v) => (isDate(v) ? '' : 'due must be YYYY-MM-DD'),
  project: (v) => (typeof v === 'string' && v.length <= 200 ? '' : 'project must be a string of at most 200 characters'),
  note: (v) => (typeof v === 'string' && v.length <= 10_000 ? '' : 'note must be a string of at most 10000 characters'),
  tag: (v) => (typeof v === 'string' && v.length <= 200 && tagsLib.NAME_RE.test(v) ? '' : 'tag must look like a or a/b (at most 200 characters)'),
};

// Validates a reminder body at the trust boundary; null or "" clears an optional field.
function fields(input, keys) {
  if (!isObj(input)) throw bad('body must be a JSON object');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!keys.includes(k)) throw bad(`unknown field "${k}"`);
    if (v === null || v === '') {
      if (!CLEARABLE.includes(k)) throw bad(`${k} cannot be empty`);
      out[k] = null;
      continue;
    }
    const err = CHECK[k](v);
    if (err) throw bad(err);
    out[k] = k === 'title' ? v.trim() : k === 'pos' && v !== 'top' && v !== 'bottom' ? Number(v) : v;
  }
  return out;
}

function applyFields(t, f) {
  if (f.title !== undefined) t.title = f.title;
  for (const k of CLEARABLE) {
    if (f[k] === undefined) continue;
    if (f[k] === null) delete t[k];
    else t[k] = f[k];
  }
}

function setStatus(t, status) {
  if (t.status === status) return;
  t.status = status;
  if (status === 'done') t.done_at = today();
  else delete t.done_at;
}

// Moves t to place pos ('top' | 'bottom' | 1-based number) inside its status column.
function place(tasks, t, pos) {
  const i = tasks.indexOf(t);
  if (i >= 0) tasks.splice(i, 1);
  const col = tasks.filter((x) => x.status === t.status);
  const k = pos === 'top' ? 0 : pos === 'bottom' ? col.length : Math.min(pos - 1, col.length);
  const at = k < col.length ? tasks.indexOf(col[k]) : col.length ? tasks.indexOf(col[col.length - 1]) + 1 : tasks.length;
  tasks.splice(at, 0, t);
}

function warnings(tasks) {
  const now = tasks.filter((t) => t.status === 'now').length;
  return now > NOW_LIMIT ? [`now has ${now} tasks (limit ${NOW_LIMIT}); move the lowest to next`] : [];
}

function findReminder(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('id must look like t_xxxxxx');
  const i = data.tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new TbError(404, `no reminder ${id}`);
  return i;
}

async function saveReminders(tasks, ev) {
  await writeJson(FILE.tasks, { ...data, tasks });
  data = { ...data, tasks };
  await appendEvent(FILE.events, ev);
  emitter.emit('reminder', { id: ev.id, status: ev.status ?? null });
}

const listReminders = () => data.tasks;

// v1 add: default inbox, pos bottom (top for done); the same open title twice is a no-op.
function addReminder(input) {
  return serial(async () => {
    const f = fields(input, ADD_KEYS);
    if (!f.title) throw bad('title is required');
    const dup = data.tasks.find((t) => t.status !== 'done' && t.title.toLowerCase() === f.title.toLowerCase());
    if (dup) return { reminder: dup, warnings: [], noop: true };
    const tasks = data.tasks.slice();
    const t = { id: uid(), type: 'reminder', title: f.title, status: 'inbox', created: today() };
    applyFields(t, f);
    setStatus(t, f.status || 'inbox');
    place(tasks, t, f.pos ?? (t.status === 'done' ? 'top' : 'bottom'));
    await saveReminders(tasks, { kind: 'add', id: t.id, status: t.status });
    return { reminder: t, warnings: warnings(tasks) };
  });
}

// v1 set: a status change without pos goes to the bottom (top for done); done sets done_at.
function updateReminder(id, patch) {
  return serial(async () => {
    const i = findReminder(id);
    const f = fields(patch, ADD_KEYS);
    if (!Object.keys(f).length) throw bad('nothing to update');
    const tasks = data.tasks.slice();
    const t = (tasks[i] = { ...tasks[i] });
    const moved = f.status !== undefined && f.status !== t.status;
    applyFields(t, f);
    if (f.status) setStatus(t, f.status);
    if (f.pos !== undefined || moved) place(tasks, t, f.pos ?? (t.status === 'done' ? 'top' : 'bottom'));
    if (JSON.stringify(tasks) === JSON.stringify(data.tasks)) return { reminder: data.tasks[i], warnings: [], noop: true };
    await saveReminders(tasks, { kind: 'update', id, status: t.status });
    return { reminder: t, warnings: warnings(tasks) };
  });
}

function removeReminder(id) {
  return serial(async () => {
    const r = data.tasks[findReminder(id)];
    await saveReminders(data.tasks.filter((t) => t !== r), { kind: 'remove', id, reminder: r });
    return r;
  });
}

// ---- flow tickets --------------------------------------------------------------
const ticketDir = (id) => path.join(FILE.tickets, id);

// ticket.md: markdown of title, text and answers; seeds the agent prompt (plan §3b).
function renderMd(t) {
  // ponytail: answers shape lands with P4 clarify; dumped as JSON until then.
  const answers = t.answers ? `\n## Answers\n\n\`\`\`json\n${JSON.stringify(t.answers, null, 2)}\n\`\`\`\n` : '';
  return `# ${t.title}\n\n${t.text}\n${answers}`;
}

async function writeTicket(t) {
  await writeJson(path.join(ticketDir(t.id), 'ticket.json'), t);
  await writeAtomic(path.join(ticketDir(t.id), 'ticket.md'), renderMd(t));
}

function emitTicket(t) {
  emitter.emit('ticket', { id: t.id, state: t.state, waiting: t.waiting, rework: t.rework });
}

const FLOW_KEYS = ['text', 'title', 'kind', 'tag', 'fix_of'];

// Runs inside the queue. A kind is accepted only once its working phase is built (plan §3b, D9).
async function newFlow(input, promotedFrom) {
  if (!isObj(input)) throw bad('body must be a JSON object');
  const unknown = Object.keys(input).find((k) => !FLOW_KEYS.includes(k));
  if (unknown) throw bad(`unknown field "${unknown}"`);
  const { text, title, kind, tag, fix_of } = input;
  if (typeof text !== 'string' || !text.trim()) throw bad('text is required');
  if (text.length > 100_000) throw bad('text must be at most 100000 characters');
  if (title !== undefined && CHECK.title(title)) throw bad(CHECK.title(title));
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  if (tag !== undefined && tag !== null) tagsLib.assertFlowTag(tagMap, tag);
  if (fix_of !== undefined && fix_of !== null && !(typeof fix_of === 'string' && tickets.has(fix_of))) throw bad(`fix_of ${fix_of} is not a ticket`);
  if (!phases.built(kind, 'working')) throw new TbError(409, `kind ${kind} not built yet`);
  const now = new Date().toISOString();
  const t = {
    id: uid(), type: 'flow', kind, tag: tag ?? null,
    title: title === undefined ? text.trim().split('\n')[0].slice(0, 100) : title.trim(), text,
    state: 'backlog', created_at: now, updated_at: now,
    parent: null, blocked_by: [], fix_of: fix_of ?? null, must_ask: false,
    rework: 0, failures: {}, waiting: null, lease: null,
    ...(promotedFrom && { promoted_from: promotedFrom }),
  };
  await fsp.mkdir(ticketDir(t.id), { recursive: true, mode: 0o700 });
  await writeTicket(t);
  tickets.set(t.id, t);
  await appendEvent(path.join(ticketDir(t.id), 'events.jsonl'), { kind: 'create', id: t.id, state: t.state });
  emitTicket(t);
  return t;
}

const createFlow = (input) => serial(() => newFlow(input));

// Reminder -> flow: ticket written first, then the reminder removed (a crash between leaves both, never neither).
function promote(id, input) {
  return serial(async () => {
    const r = data.tasks[findReminder(id)];
    if (!isObj(input)) throw bad('body must be a JSON object');
    const unknown = Object.keys(input).find((k) => k !== 'kind' && k !== 'tag');
    if (unknown) throw bad(`unknown field "${unknown}"`);
    const text = r.note ? `${r.title}\n\n${r.note}` : r.title;
    const t = await newFlow({ text, title: r.title.slice(0, 500), kind: input.kind, tag: input.tag }, r.id);
    await saveReminders(data.tasks.filter((x) => x !== r), { kind: 'promote', id: r.id, ticket: t.id, reminder: r });
    return t;
  });
}

function getTicket(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('id must look like t_xxxxxx');
  const t = tickets.get(id);
  if (!t) throw new TbError(404, `no ticket ${id}`);
  return t;
}

const listTickets = () => [...tickets.values()];

// fn gets a copy and returns the new ticket (may throw to refuse); saved atomically under the queue.
function updateTicket(id, fn) {
  return serial(async () => {
    const cur = getTicket(id);
    const next = await fn(structuredClone(cur));
    next.updated_at = new Date().toISOString();
    await writeTicket(next);
    tickets.set(id, next);
    const ev = cur.state === next.state ? { kind: 'update', id, state: next.state } : { kind: 'transition', id, from: cur.state, to: next.state };
    await appendEvent(path.join(ticketDir(id), 'events.jsonl'), ev);
    emitTicket(next);
    return next;
  });
}

// ---- config ------------------------------------------------------------------------
// Keys that may change at runtime, each with its check. Everything else is edited in config.json by hand.
const CONFIG_KEYS = {
  claude_bin: (v) => typeof v === 'string' && path.isAbsolute(v) && path.resolve(v) === v,
  claude_team_id: (v) => typeof v === 'string' && /^[A-Z0-9]{10}$/.test(v), // Apple Team ID of the first pinned claude (H7)
};

// Merges into what config.json holds (defaults stay unwritten); memory changes only after the disk did.
function updateConfig(patch) {
  return serial(async () => {
    if (!isObj(patch) || !Object.keys(patch).length) throw bad('config patch must be a non-empty JSON object');
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(CONFIG_KEYS, k)) throw bad(`config key "${k}" cannot be changed here`);
      if (!CONFIG_KEYS[k](v)) throw bad(`bad value for config key "${k}"`);
    }
    const next = { ...configFile, ...patch };
    await writeJson(FILE.config, next);
    configFile = next;
    config = { ...DEFAULTS, ...next };
    return config;
  });
}

// ---- tags, calendar ----------------------------------------------------------------
const listTags = () => tagMap;

function putTag(name, def) {
  return serial(async () => {
    tagsLib.validate(name, def);
    const next = { ...tagMap, [name]: def };
    await writeJson(FILE.tags, next);
    tagMap = next;
    return def;
  });
}

// calendar.json is written by tcal, outside the store: read fresh each time.
async function readCalendar() {
  try {
    return JSON.parse(await fsp.readFile(FILE.calendar, 'utf8'));
  } catch {
    return { updated: null, events: [] };
  }
}

module.exports = {
  STATUSES, isDate, init, releasePid, writeAtomic, flush: () => queue,
  get config() { return config; },
  get token() { return token; },
  get tz() { return tz(); },
  on: (event, cb) => void emitter.on(event, cb),
  listReminders, addReminder, updateReminder, removeReminder,
  createFlow, promote, getTicket, listTickets, updateTicket,
  listTags, putTag, readCalendar, updateConfig,
};
