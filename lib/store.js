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
const { DEFAULT_PIN } = require('./util');
const { isDeepStrictEqual } = require('node:util');
const { DEFAULT_SKILLS, skillSources } = require('./skills');
const { KINDS } = require('./fsm'); // board-terminal-parity Phase 1: one KINDS list

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
const NOW_LIMIT = 3;
const ID_RE = /^t_[a-z0-9]{6}$/;

// spec App A config + plan D2 (8 GB numbers), D3, D12, D28, §3b.
const DEFAULTS = {
  claude_bin: path.join(HOME, 'bin', `claude-${DEFAULT_PIN}`),
  max_concurrent: 3, // full-access-runs Phase 4: 3 tickets at once (the RAM guard still holds a run that does not fit)
  memory: {
    min_free_gb: 0.5, // D-0100 (was 1): fewer, shorter memory waits on the 8 GB Mac
    // D36: measured peaks + headroom; D-0100 qa 1.5 → 1.0 (real opus QA run + app peak 1014 MB); M5 C10 final_gate = review's
    // (read-only agent); full-access-runs Phase 1: read-only + 2 subagents peak 352 MB, full access + 2 subagents 415 MB → 0.6
    phase_need_gb: { planning: 0.6, review: 0.6, working: 1.0, qa: 1.0, final_gate: 0.6 },
    docker_reserved_gb: 2,
    start_at_warn_when_idle: true,
  },
  disk: { warn_gb: 15, stop_gb: 8 },
  liveness: { quiet_min: 5, stall_min: 15, wake_grace_min: 6, wall_min: { planning: 30, working_task: 45, review: 30, qa: 60, final_gate: 30 } },
  recovery: { max_failures_per_phase: 3 },
  // full-access-runs Phase 4: 2 at once per run; per_session_total is a lifetime spawn count per session (lib/slots.js)
  subagents: { concurrent: 2, per_session_total: 8, depth: 1 },
  slots: { max_hold_min: 75 }, // M5 C9: a slot lease's max hold (lib/slots.js; was its implicit 60) > the qa wall (60)
  models: {
    planning: { model: 'opus', effort: 'xhigh' }, // full-access-runs Phase 4 (decision 7): opus xhigh, every agent phase
    review: { model: 'opus', effort: 'xhigh' },
    working: { model: 'opus', effort: 'xhigh' },
    qa: { model: 'opus', effort: 'xhigh' },
    final_gate: { model: 'opus', effort: 'xhigh' },
    pr: { model: 'sonnet' },
    context: { model: 'sonnet' },
  },
  final_distinct: false, // true: the final gate never runs on review's model (M5 C11 G9, lib/spawn.js finalModel)
  full_access_wall: true, // full-access runs keep a widened seatbelt (lib/phase-settings.js fullAccessSandbox); false: off
  skills: { defaults: DEFAULT_SKILLS }, // board default skills; a tag adds (skills) or removes (skills_off)
  lanes: { enabled: false }, // parallel lanes of one ticket: own switch (open question 6), and only at max_concurrent >= 2
  // board-terminal-parity (decision 5): every new power is a switch, off here; Irfan's config.json turns each on.
  // page_tools: page routes that run programs (lib/http.js PAGE_TOOLS); approve_min: an Approve request's wait (C1)
  terminal: { bash_all_steps: false, folder_mcp: false, git_bridge: false, auto_mode: false, task_tickets: false, page_tools: false, approve_min: 10 },
  fable_billing: 'plan',
  max_turns: { planning: 60, working_task: 80, review: 40, qa: 80, final_gate: 40, pr: 10 },
  // P5 (contract K12 K13 timeouts): per-check timeout (tag may override), unit in a task gate only while its last time is
  // under unit_task_max_ms, a gate job's RAM need (lib/gates/types.js GatesConfig)
  // registry: what a sandboxed dependency setup installs from (RO2; a test points it at a local one)
  gates: { timeout_min: { typecheck: 10, unit: 20, test_cmd: 20, build: 15, openapi: 15, lint: 10, generate: 5 }, unit_task_max_ms: 60_000, need_gb: 1.0, registry: 'https://registry.npmjs.org/' },
  caffeinate: 'ac_only',
  http: { port: 7777 },
  // M5.4 C18: Clarify rounds on a lavish-axi page (lib/interview.js). port: NOT lavish's own 4387 (Irfan's sessions);
  // idle_min: the lavish server stops itself after it; poll_min: tbd's poll cycle (lavish's poll has no timeout, S5)
  interview: { lavish: true, port: 7781, idle_min: 30, poll_min: 10 },
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
const TBD_RE = /(^|[\s/])tbd\.js(\s|$)/; // a tbd's ps command line (tb eval chaos re-checks with it too)
function isTbd(pid) {
  if (!alive(pid)) return false;
  const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); // startup
  return Boolean(ps.error) || TBD_RE.test(ps.stdout); // ps unusable: assume tbd, refuse
}

const readPid = () => {
  const n = Number(fs.readFileSync(FILE.pid, 'utf8')); // startup
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// Single instance: tbd.pid naming a live tbd refuses the start. Stale (replaced): written before this boot,
// or its pid is dead or runs another program. Empty or garbage = a tbd between create and write: re-read
// once after 50 ms, then refuse; never remove a file another tbd may be writing. No uptime (a board run's sandbox:
// uv_uptime EPERM): boot = 0, so every tbd.pid gets the live-tbd check (fail closed).
function claimPid() {
  let boot = 0;
  try { boot = Date.now() - os.uptime() * 1000; } catch { /* boot stays 0 */ }
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
  // D-0080: config.json holds overrides only. First boot writes the machine key claude_bin (its path follows TB_HOME;
  // tb reads it from the file), never the defaults: a copied default would shadow every later change to it.
  configFile = file || { claude_bin: DEFAULTS.claude_bin };
  config = { ...DEFAULTS, ...configFile };
  if (!file) fs.writeFileSync(FILE.config, JSON.stringify(configFile, null, 2) + '\n', { mode: 0o600 }); // startup
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
// removes its tmp file (best effort) before rethrowing. The tmp name is predictable and a run's cwd can be the ticket
// dir (S8): whatever sits at it goes first, and 'wx' (O_EXCL) refuses a link planted after that, never writes through.
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.rm(tmp, { force: true });
  const fh = await fsp.open(tmp, 'wx', 0o600);
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
// The event log trails a saved write: a failed append is logged, never undoes or fails that write. NOFOLLOW: a link
// planted at a ticket's events.jsonl is never appended through (S10).
const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const appendEvent = (file, ev) => fsp.appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n', { mode: 0o600, flag: APPEND })
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

// ticket.md: markdown of title, text and Irfan's answers as Q/A; seeds the agent prompt (plan §3b, P4 U6).
// answers: [{id, question, answer, recommended?}] in the order given (P4b `tb answer`); answer as in U8: {pick},
// {text}, {use: "recommended"} (shown with the question's recommended answer) or {use: "you_decide"}.
const USE = { recommended: 'use your recommended answer', you_decide: "you decide (planner's call)" };
const answerText = (a) => (typeof a === 'string' ? a : a?.pick ?? a?.text ?? USE[a?.use] ?? JSON.stringify(a));
function renderMd(t) {
  const qa = Array.isArray(t.answers) && t.answers.length
    ? `\n## Answers\n\n${t.answers.map((x) => `Q (${x.id}): ${x.question}\nA: ${answerText(x.answer)}${x.answer?.use === 'recommended' && x.recommended ? ` (${x.recommended})` : ''}\n`).join('\n')}`
    : '';
  return `# ${t.title}\n\n${t.text}\n${qa}`;
}

async function writeTicket(t) {
  await writeJson(path.join(ticketDir(t.id), 'ticket.json'), t);
  await writeAtomic(path.join(ticketDir(t.id), 'ticket.md'), renderMd(t));
}

function emitTicket(t) {
  emitter.emit('ticket', { id: t.id, state: t.state, waiting: t.waiting, rework: t.rework });
}

const FLOW_KEYS = ['text', 'title', 'kind', 'tag', 'fix_of', 'sandbox', 'where']; // sandbox: true = locked runs (full-access-runs Phase 3)
const WHERE = ['worktree', 'folder']; // a Task's Where (Phase 4 design section 1): Own Worktree | My Folder

// Runs inside the queue. A kind is accepted only once its working phase is built (plan §3b, D9); a plan's child
// (extra.parent: its approved parent's kind) needs no such check. extra: tbd's own fields (promoted_from; a child's id,
// parent, blocked_by, auto_assign), never request input.
const TASK_LOCKED = 'a Task runs in your real folder; a locked run is for untrusted text: use a Code ticket';
async function newFlow(input, extra = {}) {
  if (!isObj(input)) throw bad('body must be a JSON object');
  const unknown = Object.keys(input).find((k) => !FLOW_KEYS.includes(k));
  if (unknown) throw bad(`unknown field "${unknown}"`);
  const { text, title, kind, tag, fix_of, sandbox, where } = input;
  if (typeof text !== 'string' || !text.trim()) throw bad('text is required');
  if (text.length > 100_000) throw bad('text must be at most 100000 characters');
  if (title !== undefined && CHECK.title(title)) throw bad(CHECK.title(title));
  // board-terminal-parity Phase 4: task only with terminal.task_tickets on (off: today's text); never a locked run (F)
  const kinds = KINDS.filter((k) => k !== 'task' || config.terminal?.task_tickets === true);
  if (!kinds.includes(kind)) throw bad(`kind must be one of ${kinds.join(', ')}`);
  if (kind === 'task' && sandbox === true) throw bad(TASK_LOCKED);
  if (tag !== undefined && tag !== null) tagsLib.assertFlowTag(tagMap, tag);
  if (fix_of !== undefined && fix_of !== null && !(typeof fix_of === 'string' && tickets.has(fix_of))) throw bad(`fix_of ${fix_of} is not a ticket`);
  if (sandbox !== undefined && typeof sandbox !== 'boolean') throw bad('sandbox must be true or false');
  // Phase 4 design section 1: left out → mode null (assign picks); a plain folder never gets Own Worktree
  if (where !== undefined && !WHERE.includes(where)) throw bad(`where must be one of ${WHERE.join(', ')}`);
  if (where !== undefined && kind !== 'task') throw bad('where is only for kind task');
  if (where === 'worktree' && tag != null && tagMap[tag]?.type !== 'git') throw bad('a plain folder has no git: use My Folder');
  if (!extra.parent && !phases.built(kind, 'working')) throw new TbError(409, `kind ${kind} not built yet`);
  const now = new Date().toISOString();
  const t = {
    id: extra.id ?? uid(), type: 'flow', kind, tag: tag ?? null,
    title: title === undefined ? text.trim().split('\n')[0].slice(0, 100) : title.trim(), text,
    state: 'backlog', created_at: now, updated_at: now,
    parent: null, blocked_by: [], fix_of: fix_of ?? null, must_ask: false,
    rework: 0, failures: {}, waiting: null, lease: null, ...(sandbox === true && { sandbox: true }), ...(kind === 'task' && { task: { mode: where ?? null } }), ...extra,
  };
  await fsp.mkdir(ticketDir(t.id), { recursive: true, mode: 0o700 });
  await writeTicket(t);
  tickets.set(t.id, t);
  await appendEvent(path.join(ticketDir(t.id), 'events.jsonl'), { kind: 'create', id: t.id, state: t.state });
  emitTicket(t);
  return t;
}

// extra: tbd's own fields (http: skills_asked, read from the text against the known skill names)
const createFlow = (input, extra = {}) => serial(() => newFlow(input, extra));

// Reminder -> flow: ticket written first, then the reminder removed (a crash between leaves both, never neither).
function promote(id, input) {
  return serial(async () => {
    const r = data.tasks[findReminder(id)];
    if (!isObj(input)) throw bad('body must be a JSON object');
    const unknown = Object.keys(input).find((k) => k !== 'kind' && k !== 'tag' && k !== 'where');
    if (unknown) throw bad(`unknown field "${unknown}"`);
    const text = r.note ? `${r.title}\n\n${r.note}` : r.title;
    const t = await newFlow({ text, title: r.title.slice(0, 500), kind: input.kind, tag: input.tag, where: input.where }, { promoted_from: r.id });
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
// M5 C15: the tickets built on id's squash: its children (parent) and the tickets it blocks (blocked_by); fsm close_rework.
// ponytail: an O(n) scan of every ticket, an index by blocker if there are many.
const dependentsOf = (/** @type {string} */ id) => listTickets().filter((k) => k.parent === id || (k.blocked_by ?? []).includes(id));

// Inside the queue: next replaces cur on disk, then in memory, then its event. A state change also emits `transition`
// (next, from) after the event is logged (P4 AC8: the t:ticket line reads the ticket's events).
async function save(cur, next, note = undefined) {
  const { id } = cur;
  next.updated_at = new Date().toISOString();
  await writeTicket(next);
  tickets.set(id, next);
  const ev = cur.state === next.state ? { kind: 'update', id, state: next.state } : { kind: 'transition', id, from: cur.state, to: next.state };
  await appendEvent(path.join(ticketDir(id), 'events.jsonl'), note ? { ...ev, note } : ev);
  emitTicket(next);
  if (cur.state !== next.state) emitter.emit('transition', next, cur.state);
  return next;
}

// fn gets a copy and returns the new ticket (may throw to refuse); saved atomically under the queue. note: a line for
// the ticket's events.jsonl entry of this write (P4 U7 fallback).
function updateTicket(id, fn, note = undefined) {
  return serial(async () => {
    const cur = getTicket(id);
    return save(cur, await fn(structuredClone(cur)), note);
  });
}

// P4b approve (J3 J5): a plan's children as Backlog flows of the parent's kind + tag (parent, blocked_by from the plan's
// local ids: "parent" → the parent, a sibling → its new id), then the parent's next version fn(copy), one queue job:
// nothing else writes between. fn runs first (a refused move writes nothing). The parent keeps the children's ids before
// any child is made, so a re-approve after a crash in between makes only the missing ones, same ids (a reject drops
// them: planning.reject). L4: a child is made with auto_assign false and gets true only after the parent's save (a crash
// before it never lets a child of an unapproved plan start; one after it leaves the child for Irfan's tb assign).
// ponytail: one ticket file per child, written in turn (no multi-file atomic write); the ids make it resumable. J16: each
// child inherits the parent's locked decisions (its planner sees them locked), ids prefixed with the parent's
// (`<parent>.R1Q1`): the child's own rounds count from R1.
function createChildren(id, specs, fn) {
  return serial(async () => {
    let cur = getTicket(id);
    const next = await fn(structuredClone(cur));
    const have = cur.children ?? [];
    if (have.length < specs.length) {
      const ids = [...have];
      while (ids.length < specs.length) { const u = uid(); if (!ids.includes(u)) ids.push(u); }
      cur = await save(cur, { ...cur, children: ids });
    }
    const of = new Map(specs.map((c, i) => [c.id, cur.children[i]]));
    for (const [i, c] of specs.entries()) {
      if (tickets.has(cur.children[i])) continue;
      const mapped = c.blocked_by.map((b) => (b === 'parent' ? id : of.get(b)));
      // C15 (D-0091): a code child always waits on its parent (starts on its final commit, never beside it on the tag
      // base); other kinds as planned (an implicit parent there would deadlock once M6 lands)
      const blocked = cur.kind === 'code' ? [...new Set([...mapped, id])] : mapped;
      const locked = (cur.locked_decisions ?? []).map((d) => ({ ...d, id: `${id}.${d.id}` }));
      await newFlow({ text: c.text, title: c.title, kind: cur.kind, tag: cur.tag }, { id: cur.children[i], parent: id, blocked_by: blocked, auto_assign: false, locked_decisions: locked });
    }
    const children = (cur.children ?? []).filter((c, i) => i < specs.length || tickets.has(c));
    const parent = await save(cur, { ...next, ...((children.length || cur.children) && { children }) });
    for (const c of children.slice(0, specs.length)) if (tickets.get(c)?.auto_assign === false) await save(tickets.get(c), { ...tickets.get(c), auto_assign: true });
    return parent;
  });
}

// M5.5 X6 (C19): the lane ticket `id` of parent p's plan task `task` (lib/lanes.js setup job: p's work.lanes names id
// first). A flow of p's kind, tag, text, plan and base (base_sha = p's: the planted-config check diffs against it, C#1),
// p's answers + reject comment + locked decisions (its seed), lane_of {id, task}; in working from the start with no work
// cursor yet (waiting lane_setup until the setup's last write). No parent / blocked_by: dependentsOf and the children
// watcher never see it.
function createLane(p, task, id) {
  return serial(async () => {
    if (tickets.has(id)) throw new TbError(409, `${id}: a ticket with this id exists`);
    return newFlow({ text: p.text, title: `${p.title} · ${task}`.slice(0, 500), kind: p.kind, tag: p.tag }, {
      id, lane_of: { id: p.id, task }, state: 'working', round: 1, plan_file: p.plan_file, plan_hash: p.plan_hash, plan_hashes: p.plan_hashes,
      base_sha: p.base_sha, base_checks: p.base_checks, openapi_base: p.openapi_base, rules_sha: p.rules_sha, answers: p.answers,
      reject_comment: p.reject_comment, locked_decisions: p.locked_decisions, skills: p.skills, sandbox: p.sandbox, subagents: p.subagents, work: null, waiting: { reason: 'lane_setup', since: new Date().toISOString() },
    });
  });
}

// P5 (contract persistence, AC8): one line per Irfan intervention (answer, scope, allow/deny-change, rework, pass, approve) in
// tickets/<id>/interventions.jsonl {at, actor: cli|ui, verb, task, payload_sha256} (the payload's hash only: no agent or
// Irfan text kept twice) and t.interventions + 1 (t:ticket reads it), in the same queued write as fn(k), the verb's own
// change (a refusal there writes neither). The line goes first: a save failing after it leaves one line too many,
// never a count without its line. M5.4 (D-0117): actor lavish = an answer sent from the Clarify page.
const ACTORS = ['cli', 'ui', 'lavish'];
function intervention(id, { actor, verb, task = null, payload = null }, fn = (/** @type {any} */ k) => k) {
  if (!ACTORS.includes(actor) || typeof verb !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(verb)) throw bad('intervention needs actor cli|ui|lavish and a verb');
  return updateTicket(id, async (k) => {
    const next = await fn(k);
    const line = { at: new Date().toISOString(), actor, verb, task, payload_sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    await fsp.appendFile(path.join(ticketDir(id), 'interventions.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600, flag: APPEND });
    return { ...next, interventions: (k.interventions ?? 0) + 1 };
  });
}

// full-access-runs Phase 8: a backlog flow's Sandbox switch (t.sandbox true = locked runs; off = no field, full access).
// After assign the run mode is part of the ticket's history: 409.
function setSandbox(id, on) {
  if (typeof on !== 'boolean') throw bad('on must be true or false');
  return updateTicket(id, (k) => {
    if (k.state !== 'backlog') throw new TbError(409, `${id}: the Sandbox switch works in backlog only (now ${k.state})`);
    if (on && k.kind === 'task') throw bad(TASK_LOCKED); // Phase 4 F
    const next = { ...k, sandbox: true };
    if (!on) delete next.sandbox;
    return next;
  });
}

// Phase 3 (parallel view): "Subagents for This Ticket": 1-4 at once for its next runs (null: the board's default again).
// Same range as config.subagents.concurrent. One CAS + an interventions row.
function setSubagents(id, concurrent, actor) {
  if (concurrent !== null && !int(concurrent, 1, 4)) throw bad('concurrent must be a whole number 1-4, or null for the default');
  return intervention(id, { actor, verb: 'subagents', payload: { concurrent } }, (k) => {
    if (k.state === 'done' || k.state === 'cancelled') throw new TbError(409, `${id}: Subagents works in an open ticket only (now ${k.state})`);
    const { subagents: _, ...rest } = k;
    return concurrent === null ? rest : { ...rest, subagents: { concurrent } };
  });
}

// ---- config ------------------------------------------------------------------------
// M5.4 X4: config.interview key by key over its defaults (the shallow merge would drop a partial object's other keys).
// A value that fails its check gets the default (doctor's config check lists it: ≠ default). port: an integer
// 1024-65535, never tbd's own (as the gate profile reads it); idle_min, poll_min: a number > 0. The one reader for
// interview.js, the gate profile, the recorder and doctor: the port they use and deny is always the same.
function interviewConfig(/** @type {any} */ cfg) {
  const d = DEFAULTS.interview;
  const c = isObj(cfg?.interview) ? cfg.interview : {};
  const tbd = Number(process.env.TB_PORT) || cfg?.http?.port || 7777;
  const min = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  /** @type {Record<string, (v: any) => boolean>} */
  const ok = { lavish: (v) => typeof v === 'boolean', port: (v) => Number.isInteger(v) && v >= 1024 && v <= 65535 && v !== tbd, idle_min: min, poll_min: min };
  return /** @type {typeof d} */ (Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Object.hasOwn(c, k) && ok[k](c[k]) ? c[k] : v])));
}

// Keys that may change at runtime, each with its check. Everything else is edited in config.json by hand.
// full-access-runs Phase 8: the Settings keys (SETTINGS: POST /api/config, tb config set). A nested object is replaced
// whole (config.json holds overrides only; tb and the page build it from the live config). memory: only phase_need_gb
// may change here, its other keys must stay as they are. skills.defaults: names ~/.claude/skills holds, or the board
// default list (its plugin skills live outside it, as plan-rules knows them).
const AGENT_PHASES = ['planning', 'working', 'review', 'qa', 'final_gate'];
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const keysIn = (v, allowed, need = []) => isObj(v) && Object.keys(v).every((k) => allowed.includes(k)) && need.every((k) => Object.hasOwn(v, k));
const modelOk = (v) => keysIn(v, ['model', 'effort'], ['model']) && ['opus', 'sonnet', 'fable'].includes(v.model) && (v.effort === undefined || ['low', 'medium', 'high', 'xhigh'].includes(v.effort));
const TERMINAL = Object.keys(DEFAULTS.terminal); // all required: a nested object is replaced whole
/** @type {Record<string, (v: any, ctx: {known?: Set<string>}) => boolean>} */
const CONFIG_KEYS = {
  claude_bin: (v) => typeof v === 'string' && path.isAbsolute(v) && path.resolve(v) === v,
  claude_team_id: (v) => typeof v === 'string' && /^[A-Z0-9]{10}$/.test(v), // Apple Team ID of the first pinned claude (H7)
  max_concurrent: (v) => int(v, 1, 3),
  subagents: (v) => keysIn(v, ['concurrent', 'per_session_total', 'depth'], ['concurrent', 'per_session_total']) && int(v.concurrent, 1, 4) && int(v.per_session_total, 1, 20) && (v.depth === undefined || v.depth === 1),
  models: (v) => keysIn(v, Object.keys(DEFAULTS.models), AGENT_PHASES) && Object.values(v).every(modelOk),
  final_distinct: (v) => typeof v === 'boolean',
  skills: (v, { known }) => keysIn(v, ['defaults'], ['defaults']) && Array.isArray(v.defaults) && new Set(v.defaults).size === v.defaults.length && v.defaults.every((n) => known?.has(n)),
  lanes: (v) => keysIn(v, ['enabled'], ['enabled']) && typeof v.enabled === 'boolean',
  terminal: (v) => keysIn(v, TERMINAL, TERMINAL) && TERMINAL.every((k) => (k === 'approve_min' ? int(v[k], 1, 60) : typeof v[k] === 'boolean')),
  memory: (v) => keysIn(v, Object.keys(DEFAULTS.memory), ['phase_need_gb']) && keysIn(v.phase_need_gb, AGENT_PHASES, AGENT_PHASES)
    && Object.values(v.phase_need_gb).every((n) => typeof n === 'number' && n >= 0.2 && n <= 4)
    && Object.keys(DEFAULTS.memory).every((k) => k === 'phase_need_gb' || isDeepStrictEqual(v[k], config.memory?.[k])),
};
const SETTINGS = ['max_concurrent', 'subagents', 'models', 'final_distinct', 'skills', 'lanes', 'memory', 'terminal'];
const RULES = { // the refusal names the rule
  max_concurrent: 'a whole number 1-3', subagents: '{concurrent 1-4, per_session_total 1-20, depth 1}', final_distinct: 'true or false', lanes: '{enabled: true|false}',
  models: `every phase of ${AGENT_PHASES.join(', ')}: {model opus|sonnet|fable, effort low|medium|high|xhigh}`,
  skills: '{defaults: [installed skill names, no repeats]}', memory: 'only phase_need_gb changes here: 0.2-4 GB for each agent phase',
  terminal: `all ${TERMINAL.length} keys: ${TERMINAL.filter((k) => k !== 'approve_min').join(', ')} true|false, approve_min a whole number 1-60`,
};

// Merges into what config.json holds (defaults stay unwritten); memory changes only after the disk did. A key set back
// to its default leaves config.json (overrides only, D-0080).
function updateConfig(patch) {
  return serial(async () => {
    if (!isObj(patch) || !Object.keys(patch).length) throw bad('config patch must be a non-empty JSON object');
    const known = patch.skills ? new Set([...DEFAULT_SKILLS, ...Object.keys((await skillSources()).skills)]) : undefined;
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(CONFIG_KEYS, k)) throw bad(`config key "${k}" cannot be changed here`);
      if (!CONFIG_KEYS[k](v, { known })) throw bad(`bad value for config key "${k}"${RULES[k] ? `: ${RULES[k]}` : ''}`);
    }
    const next = { ...configFile, ...patch };
    for (const k of Object.keys(patch)) if (SETTINGS.includes(k) && isDeepStrictEqual(next[k], DEFAULTS[k])) delete next[k]; // claude_bin stays: tb reads it from the file
    await writeJson(FILE.config, next);
    configFile = next;
    config = { ...DEFAULTS, ...next };
    return config;
  });
}

// ---- tags, calendar ----------------------------------------------------------------
const listTags = () => tagMap;

// fresh (POST /api/tags/quick): an existing name is a 409, checked inside the queue (two adds of one name: one wins)
function putTag(name, def, { fresh = false } = {}) {
  return serial(async () => {
    tagsLib.validate(name, def);
    if (fresh && Object.hasOwn(tagMap, name)) throw new TbError(409, `tag ${name} exists`);
    await tagsLib.checkRules(def.rules); // P5 T1: plain files, ≤ 8 KB in all (refused, never cut)
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
  STATUSES, TBD_RE, DEFAULTS, SETTINGS, APPEND, isDate, init, releasePid, writeAtomic, interviewConfig, flush: () => queue,
  get config() { return config; },
  // D-0080: what config.json holds (doctor's config check)
  get configFile() { return configFile; },
  get token() { return token; },
  get tz() { return tz(); },
  on: (event, cb) => void emitter.on(event, cb),
  listReminders, addReminder, updateReminder, removeReminder,
  createFlow, promote, getTicket, listTickets, dependentsOf, updateTicket, createChildren, createLane, uid, ticketDir, renderMd, intervention, setSandbox, setSubagents,
  listTags, putTag, readCalendar, updateConfig,
};
