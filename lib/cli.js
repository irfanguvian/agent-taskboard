'use strict';
// tb: AXI CLI over the tbd HTTP API (never touches data files). Zero dependencies.
// TOON on stdout. Exit codes: 0 ok (incl. no-op), 1 error, 2 usage.
// bin/tb and bin/taskboard-axi (v1 shim) are one-line launchers: main(argv, binName).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { STATUSES, ROW, cell, table, addPos, bySection, withPos, posOf, line, warnings } = require('./toon');
const { KINDS, STATES: FLOW_STATES } = require('./fsm');
const { isDate } = require('./store');
const { NAME_RE } = require('./tags');

const HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const PORT = process.env.TB_PORT || '7777';
const TZ = process.env.TB_TZ || 'Asia/Jakarta';
const TIMEOUT_MS = 5000;
const GC_TIMEOUT_MS = 600_000; // sizing and removing big worktrees takes a while
const KICK = 'launchctl kickstart -k gui/$(id -u)/local.taskboard';
const FLOW_CLOSED = ['done', 'cancelled'];
const FLOW_ROW = ['id', 'kind', 'tag', 'state', 'waiting', 'title'];
const TRUNCATE = 500;
let BIN = 'tb'; // ponytail: module state, one CLI run per process

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const tilde = p => p.replace(os.homedir(), '~');
const human = n => (n == null ? '?' : n < 1024 ** 2 ? `${Math.ceil(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

class Exit extends Error {
  constructor(code, lines) { super(lines[0]); this.code = code; this.lines = lines; }
}
const usage = (msg, help) => new Exit(2, [`error: ${msg}`, ...(help ? [`help: ${help}`] : [])]);
const fail = (msg, help) => new Exit(1, [`error: ${msg}`, ...(help ? [`help: ${help}`] : [])]);

// ---- HTTP -------------------------------------------------------------------
const readToken = () => fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim(); // client: not daemon request path

function request(method, route, body, timeoutMs = TIMEOUT_MS, token = '') {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method, agent: false, timeout: timeoutMs,
      headers: { ...(token && { 'X-TB-Token': token }), ...(data && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { /* non-JSON body: json stays undefined */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', ms: timeoutMs })));
    req.on('error', reject);
    req.end(data);
  });
}

// The token only goes to a port that proves it is tbd: GET /api/whoami?n=<nonce> must answer HMAC-SHA256(token, nonce),
// which needs the token. Once per process, like BIN. 503 starting = tbd bound its port but is not ready yet (D39):
// asked again every 250 ms for up to 5 s.
let identified;
function identify(token) {
  identified ??= (async () => {
    const n = crypto.randomBytes(16).toString('hex');
    const want = Buffer.from(crypto.createHmac('sha256', token).update(n).digest('hex'));
    const starting = r => r.status === 503 && r.json?.error === 'starting';
    let r = await request('GET', `/api/whoami?n=${n}`);
    for (const end = Date.now() + 5000; starting(r) && Date.now() < end;) {
      await new Promise(ok => setTimeout(ok, 250));
      r = await request('GET', `/api/whoami?n=${n}`);
    }
    if (starting(r)) throw fail('tbd is starting; try again', `still starting after 5 s? see ${tilde(path.join(HOME, 'tbd.log'))}`);
    const got = Buffer.from(typeof r.json?.mac === 'string' ? r.json.mac : '');
    if (r.status !== 200 || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      throw fail(`port ${PORT} is not tbd (identity check failed)`, `the token was not sent; check ${tilde(path.join(HOME, 'token'))} belongs to this tbd, or find what else uses port ${PORT}`);
    }
  })();
  return identified;
}

async function api(method, route, body, timeoutMs = TIMEOUT_MS) {
  let r;
  try {
    const token = readToken();
    await identify(token);
    r = await request(method, route, body, timeoutMs, token);
  } catch (e) {
    if (e instanceof Exit) throw e;
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') throw fail('tbd not running', KICK);
    if (e.code === 'ETIMEDOUT') throw fail(`tbd did not answer within ${e.ms / 1000}s`, KICK); // e.ms: whoami may time out, not the call itself
    throw fail(e.message);
  }
  if (r.status === 401) throw fail('tbd rejected the token', `check ${tilde(path.join(HOME, 'token'))}`);
  if (r.status >= 400) throw Object.assign(fail(r.json?.error || `tbd answered ${r.status}`), { status: r.status });
  return r.json;
}

const state = () => api('GET', '/api/state');

// ---- helpers ----------------------------------------------------------------
// ref = exact id, exact title, or a title substring that matches one row (open rows win).
function find(rows, ref) {
  const q = ref.toLowerCase();
  const exact = rows.find(t => t.id === ref) || rows.find(t => t.title.toLowerCase() === q);
  if (exact) return exact;
  let hits = rows.filter(t => t.title.toLowerCase().includes(q));
  if (hits.length > 1) {
    const open = hits.filter(t => t.status !== 'done' && t.status !== 'cancelled');
    if (open.length === 1) hits = open;
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw fail(`no task matches "${ref}"`, `${BIN} grep "<words>"`);
  throw new Exit(1, [`error: "${ref}" matches ${hits.length} tasks; use an id`, ...table('matches', bySection(hits))]);
}

const flowRow = f => ({ ...f, status: f.state, project: f.tag });
const posValue = v => (v === 'top' || v === 'bottom' ? v : Number(v));

const CHECK = {
  status: v => STATUSES.includes(v) || `--status must be one of ${STATUSES.join(', ')}`,
  due: v => v === 'none' || isDate(v) || '--due must be YYYY-MM-DD or none', // same check as tbd: 2026-02-30 is refused
  pos: v => /^(top|bottom|[1-9]\d*)$/.test(v) || '--pos must be top, bottom or a number from 1',
  limit: v => /^[1-9]\d*$/.test(v) || '--limit must be a number from 1',
  title: v => v.trim() !== '' || '--title cannot be empty',
  tag: v => clears(v) || NAME_RE.test(v) || '--tag must look like a or a/b (lowercase letters, digits, -)', // same regex as tbd
  flow: v => KINDS.includes(v) || `-f/--flow must be one of ${KINDS.join(', ')}`,
  type: v => v === 'git' || v === 'folder' || '--type must be git or folder',
  checks: v => isJson(v, 'object') || '--checks must be a JSON object, e.g. \'{"lint":"npm run lint"}\'',
  heavy: v => isJson(v, 'array') || '--heavy must be a JSON array of command prefixes',
  version: v => /^\d+\.\d+\.\d+$/.test(v) || '--version must look like 2.1.292',
};

function isJson(v, kind) {
  try {
    const x = JSON.parse(v);
    return kind === 'array' ? Array.isArray(x) : x !== null && typeof x === 'object' && !Array.isArray(x);
  } catch { return false; }
}

// "none" or empty clears an optional field (null in a PATCH, left out of a POST).
const clears = v => v === 'none' || v === '';

function statusFilter(v, allowed = STATUSES, closed = ['done']) {
  if (v === undefined) return s => !closed.includes(s);
  if (v === 'all') return () => true;
  const want = v.split(',');
  const bad = want.find(s => !allowed.includes(s));
  if (bad) throw usage(`unknown status "${bad}"`, `use ${allowed.join(', ')}, a comma list, or all`);
  return s => want.includes(s);
}

const projectIs = p => t => p === undefined || (t.project || '').toLowerCase() === p.toLowerCase();

function listOut(name, rows, f, hint, fields = ROW) {
  const limit = Number(f.limit || 100);
  const out = rows.length > limit ? [`count: ${limit} of ${rows.length}`] : [];
  out.push(...table(name, rows.slice(0, limit), fields));
  if (rows.length > limit) out.push(`help: add --limit ${rows.length} to see all`);
  if (!rows.length && hint) out.push(`help: ${hint}`);
  return out;
}

// ---- commands ---------------------------------------------------------------
// {bin} is replaced with the launcher name.
const HELP = {
  // line 0 of the v1 verbs stays byte-equal to v1 (usage errors print it); tb-only flags go on an "also:" line
  list: ['usage: {bin} list [--status now|next|later|inbox|done|all|a,b] [--project <p>] [--limit 100]',
    'default: every status except done, plus open flows when no filter is given',
    'also: --flows (flows only; --status is then a flow state), --reminders (no flows)', 'examples:', '  {bin} list --status now,next', '  {bin} list --project Acme --status all', '  {bin} list --flows'],
  grep: ['usage: {bin} grep "<regex>" [--status ...] [--project <p>] [--limit 100]',
    'case-insensitive; searches title, note, project and id; default: all statuses incl. done', 'examples:',
    '  {bin} grep invoice', '  {bin} grep "api|workflow" --status later'],
  get: ['usage: {bin} get <id|title words>', 'shows every field of one reminder or flow; alias show; --full = whole flow text', 'example:', '  {bin} get t_k3x9qa'],
  add: ['usage: {bin} add "<title>" [--project <p>] [--status inbox] [--due YYYY-MM-DD] [--note "<text>"] [--pos bottom]',
    'defaults: status inbox, pos bottom (top for done); same open title twice = no-op; also: --tag <t>', 'examples:',
    '  {bin} add "Review billing PR" --project Acme --status now --pos 1 --due 2026-09-25',
    '  {bin} add "Read DDIA ch.5" --project Learning --status later'],
  new: ['usage: {bin} new "<text>" [-f code|research|brainstorm|design] [-t <tag>] [--title "<short>"] [--fix-of <id>] [reminder flags]',
    'without -f: a reminder (same flags as add); with -f: a flow in backlog (only -t, --title, --fix-of)', 'examples:',
    '  {bin} new "Add retry to the sync job" -f code -t acme/api', '  {bin} new "Call the bank" --status next'],
  set: ['usage: {bin} set <id|title words> [--title] [--project] [--status] [--due] [--note] [--pos top|bottom|N]',
    '"none" clears project, due or note; a status change without --pos goes to the bottom (top for done); also: --tag <t>', 'examples:',
    '  {bin} set t_k3x9qa --status now --pos 1', '  {bin} set invoice --due 2026-09-30 --note "waiting on keys"'],
  move: ['usage: {bin} move <id|title words> <status> [--pos top|bottom|N]', 'same as set --status; bottom of the new column by default', 'example:',
    '  {bin} move t_k3x9qa now --pos 1'],
  done: ['usage: {bin} done <id|title words> [...more]', 'sets done + done_at today, moves to top of done', 'example:', '  {bin} done t_k3x9qa'],
  rm: ['usage: {bin} rm <id|title words> [...more]', 'deletes reminders for good; prints them so they can be re-added', 'example:', '  {bin} rm t_k3x9qa'],
  promote: ['usage: {bin} promote <id|title words> -f <kind> -t <tag>', 'turns a reminder into a flow ticket (reminder is removed)', 'example:',
    '  {bin} promote t_k3x9qa -f code -t acme/api'],
  'tag add': ['usage: {bin} tag add <name> [--type git|folder --path <dir>] [--base main] [--setup "<cmd>"] [--output <dir>]',
    '  [--env-files a,b] [--context a,b] [--skills a,b] [--checks \'{"lint":"npm run lint"}\'] [--heavy \'["npm ci"]\'] [--leak-check]',
    'name is hierarchical (a/b); --type and --path go together (git needs --base); a name alone makes a group; flow tags need a leaf with a path',
    'example:', '  {bin} tag add acme/api --type git --path ~/code/acme-api --base main'],
  'tag list': ['usage: {bin} tag list', 'example:', '  {bin} tag list'],
  'notify-test': ['usage: {bin} notify-test', 'sends the "Do now" notification right away'],
  'eval fake': ['usage: {bin} eval fake', 'runs the fake-claude test suite of this checkout (no tbd needed)'],
  doctor: ['usage: {bin} doctor [--tag <name>] [--pin [--version 2.1.292]]',
    'checks the Claude login (subscription, not an API key), the pinned claude copy, Fable billing and node; exit 1 when any check fails',
    '--tag: also that tag\'s repo, its .claude settings and its check commands (can take minutes)',
    '--pin: copy ~/.local/share/claude/versions/<version> to ~/.taskboard/bin/claude-<version> and use it', 'examples:',
    '  {bin} doctor', '  {bin} doctor --tag acme/api', '  {bin} doctor --pin'],
  gc: ['usage: {bin} gc [--limit 20] [--after <id>]    or    {bin} gc --delete <id>...',
    'lists worktrees of done / cancelled / missing tickets, run logs older than 30 days and cache entries, with sizes',
    '--delete: removes only the ids given (checked against a fresh list); exit 1 when one is refused', 'example:', '  {bin} gc --delete worktree/t_k3x9qa'],
  open: ['usage: {bin} open [--print]', 'unlocks the board UI in your default browser with a one-time link (single use, 60 s)',
    '--print: print the link instead of opening it', 'example:', '  {bin} open'],
};
const FLAGS = {
  list: ['status', 'project', 'limit', 'flows', 'reminders'], grep: ['status', 'project', 'limit'], get: ['full'], show: ['full'],
  add: ['project', 'tag', 'status', 'due', 'note', 'pos'],
  new: ['project', 'tag', 'status', 'due', 'note', 'pos', 'flow', 'title', 'fix-of'],
  set: ['title', 'project', 'tag', 'status', 'due', 'note', 'pos'], move: ['pos'], done: [], rm: [], promote: ['flow', 'tag'],
  'tag add': ['type', 'path', 'base', 'setup', 'output', 'env-files', 'context', 'skills', 'checks', 'heavy', 'leak-check'],
  'tag list': [], 'notify-test': [], 'eval fake': [], open: ['print'],
  doctor: ['tag', 'pin', 'version'], gc: ['delete', 'limit', 'after'],
};
const BOOL = ['flows', 'reminders', 'full', 'leak-check', 'print', 'pin', 'delete'];
const SHORT = { '-f': 'flow', '-t': 'tag' };
const GROUPS = { tag: ['add', 'list'], eval: ['fake'] };
HELP.show = HELP.get;

const help = key => HELP[key].map(l => l.replaceAll('{bin}', BIN));

async function create(args, f, key) {
  const title = args.join(' ').trim();
  if (!title) throw usage(`${key} needs a title`, help(key)[0]);
  if (f.flow) {
    const bad = ['status', 'pos', 'due', 'note', 'project'].find(k => f[k] !== undefined);
    if (bad) throw usage(`--${bad} is for reminders; a flow takes -t, --title and --fix-of`, help('new')[0]);
    const { ticket: k } = await api('POST', '/api/flows', { text: title, title: f.title, kind: f.flow, tag: f.tag, fix_of: f['fix-of'] });
    return [[`added: ${k.id} → ${k.state}`, k.kind, k.tag, k.title].filter(Boolean).join(' · ')];
  }
  if (f.title !== undefined || f['fix-of'] !== undefined) throw usage('--title and --fix-of need -f <kind>', help('new')[0]);
  const status = f.status || 'inbox';
  const body = { title, status, pos: f.pos ? posValue(f.pos) : status === 'done' ? 'top' : 'bottom' };
  for (const k of ['project', 'tag', 'due', 'note']) if (f[k] !== undefined && !clears(f[k])) body[k] = f[k];
  const { reminder, noop } = await api('POST', '/api/reminders', body); // tbd answers noop for the same open title
  const after = (await state()).reminders;
  return [line(noop ? 'noop (already exists)' : 'added', reminder, posOf(after, reminder)), ...(noop ? [] : warnings(after))];
}

async function update(ref, f) {
  const { reminders } = await state();
  const t = find(addPos(reminders), ref);
  const patch = {};
  if (f.title !== undefined) patch.title = f.title.trim();
  for (const k of ['project', 'tag', 'due', 'note']) if (f[k] !== undefined) patch[k] = clears(f[k]) ? null : f[k];
  if (f.status) patch.status = f.status;
  if (f.pos || (f.status && f.status !== t.status)) {
    patch.pos = f.pos ? posValue(f.pos) : (f.status || t.status) === 'done' ? 'top' : 'bottom';
  }
  const { noop } = await api('PATCH', `/api/reminders/${t.id}`, patch); // tbd answers noop when nothing changed
  const after = (await state()).reminders;
  const now = after.find(x => x.id === t.id);
  return [line(noop ? 'noop (no change)' : 'updated', now, posOf(after, now)), ...(noop ? [] : warnings(after))];
}

const CMDS = {
  async list(args, f) {
    if (args.length) throw usage(`list takes no arguments, got "${args[0]}"`, `${BIN} grep "${args[0]}"`);
    if (f.flows && f.reminders) throw usage('--flows and --reminders cannot be combined', help('list')[0]);
    if (f.flows && f.project) throw usage('flows have no project; list them with --flows --status <state>', help('list')[0]);
    const flowSt = f.flows ? statusFilter(f.status, FLOW_STATES, FLOW_CLOSED) : null;
    const st = f.flows ? null : statusFilter(f.status), pr = projectIs(f.project);
    const s = await state();
    if (f.flows) {
      return listOut('flows', s.flows.filter(x => flowSt(x.state)), f, `${BIN} new "<text>" -f <kind> -t <tag>`, FLOW_ROW);
    }
    const out = listOut('tasks', withPos(s.reminders).filter(t => st(t.status) && pr(t)), f, `${BIN} add "<title>" --status <s>`);
    const open = s.flows.filter(x => !FLOW_CLOSED.includes(x.state));
    if (!f.reminders && f.status === undefined && f.project === undefined && open.length) out.push(...table('flows', open, FLOW_ROW));
    return out;
  },
  async grep(args, f) {
    if (!args.length) throw usage('grep needs a pattern', help('grep')[0]);
    const src = args.join(' ');
    let re;
    try { re = new RegExp(src, 'i'); } catch { re = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const st = statusFilter(f.status || 'all'), pr = projectIs(f.project);
    const hit = t => st(t.status) && pr(t) && [t.title, t.note, t.project, t.id].some(v => v && re.test(v));
    const rows = withPos((await state()).reminders).filter(hit);
    return listOut('matches', rows, f, `nothing matches /${src}/i; try ${BIN} list --status all`);
  },
  async get(args, f) {
    if (args.length !== 1) throw usage('get needs one id or title', help('get')[0]);
    const { reminders, flows } = await state();
    const t = find([...addPos(reminders), ...flows.map(flowRow)], args[0]);
    if (t.kind) return flowDetail(t.id, f);
    const col = reminders.filter(x => x.status === t.status);
    return ['task:', ...['id', 'title', 'status', 'project', 'tag', 'due', 'note', 'created', 'done_at']
      .filter(k => t[k] !== undefined)
      .map(k => `  ${k}: ${k === 'status' ? `${t.status} (#${col.findIndex(x => x.id === t.id) + 1} of ${col.length})` : cell(t[k])}`)];
  },
  show: (args, f) => CMDS.get(args, f),
  add: (args, f) => create(args, f, 'add'),
  new: (args, f) => create(args, f, 'new'),
  set(args, f) {
    if (args.length !== 1) throw usage('set needs one id or title (quote multi-word titles)', help('set')[0]);
    if (!Object.keys(f).length) throw usage('set needs at least one flag', help('set')[0]);
    return update(args[0], f);
  },
  move(args, f) {
    if (args.length !== 2) throw usage('move needs an id or title and a status', help('move')[0]);
    const ok = CHECK.status(args[1]);
    if (ok !== true) throw usage(ok, help('move')[0]);
    return update(args[0], { ...f, status: args[1] });
  },
  async done(args) {
    if (!args.length) throw usage('done needs an id or title', help('done')[0]);
    const { reminders } = await state();
    const rows = addPos(reminders);
    const out = [], finished = new Set();
    for (const t of args.map(ref => find(rows, ref))) { // resolve every ref first: a bad one changes nothing
      if (t.status === 'done' || finished.has(t.id)) { out.push(line('noop (already done)', t, posOf(reminders, t))); continue; }
      await api('PATCH', `/api/reminders/${t.id}`, { status: 'done', pos: 'top' });
      finished.add(t.id);
      out.push(line('done', { ...t, status: 'done' }, 1)); // done always lands on top of the done column
    }
    const after = finished.size ? (await state()).reminders : reminders;
    const next = after.find(t => t.status === 'now');
    out.push(next ? `next up: ${next.id} · ${next.title}` : `next up: nothing in now; ${BIN} list --status next`);
    return [...out, ...(finished.size ? warnings(after) : [])];
  },
  async rm(args) {
    if (!args.length) throw usage('rm needs an id or title', help('rm')[0]);
    const { reminders } = await state();
    const rows = addPos(reminders);
    const ids = new Set(args.map(ref => find(rows, ref).id)); // resolve every ref first: a bad one removes nothing
    const gone = [];
    for (const r of withPos(reminders).filter(x => ids.has(x.id))) {
      try { await api('DELETE', `/api/reminders/${r.id}`); } catch (e) {
        if (!(e instanceof Exit) || !gone.length) throw e;
        throw new Exit(e.code, [...table('removed', gone), ...e.lines]); // rows already gone stay re-addable
      }
      gone.push(r);
    }
    return [...table('removed', gone), ...warnings(reminders.filter(t => !ids.has(t.id)))];
  },
  async promote(args, f) {
    if (args.length !== 1) throw usage('promote needs one id or title', help('promote')[0]);
    if (!f.flow || !f.tag) throw usage('promote needs -f <kind> and -t <tag>', help('promote')[0]);
    const t = find(addPos((await state()).reminders), args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/promote`, { kind: f.flow, tag: f.tag });
    return [`promoted: ${t.id} → ${k.id} · ${k.state} · ${k.kind} · ${k.tag} · ${k.title}`];
  },
  async 'tag add'(args, f) {
    if (args.length !== 1) throw usage('tag add needs one name', help('tag add')[0]);
    const def = {};
    if (f.type !== undefined) def.type = f.type;
    if (f.path !== undefined) def.path = path.resolve(f.path);
    for (const k of ['base', 'setup', 'output']) if (f[k] !== undefined) def[k] = f[k];
    if (f['leak-check']) def.leak_check = true;
    for (const k of ['env-files', 'context', 'skills']) if (f[k] !== undefined) def[k.replace('-', '_')] = f[k].split(',').filter(Boolean);
    for (const k of ['checks', 'heavy']) if (f[k] !== undefined) def[k] = JSON.parse(f[k]);
    await api('POST', '/api/tags', { name: args[0], def });
    return [[`added: tag ${args[0]}`, def.type, def.path && tilde(def.path)].filter(Boolean).join(' · ')];
  },
  async 'tag list'() {
    const r = await api('GET', '/api/tags');
    const tags = r.tags || r;
    return table('tags', Object.entries(tags).map(([name, d]) => ({ name, ...d })), ['name', 'type', 'path']);
  },
  async 'notify-test'() {
    const r = await api('POST', '/api/notify-test', {});
    return [r.sent ? ['notify: sent', r.top].filter(Boolean).join(' · ') : 'notify: not sent (notifications are off or it is quiet hours)'];
  },
  async open(args, f) {
    if (args.length) throw usage(`open takes no arguments, got "${args[0]}"`, help('open')[0]);
    const { url } = await api('POST', '/api/session/code');
    if (f.print) return [url];
    await new Promise((resolve, reject) => execFile('/usr/bin/open', [url], e => (e ? reject(fail(`could not open the browser: ${e.message}`, `${BIN} open --print`)) : resolve(undefined))));
    return [`opened: http://127.0.0.1:${PORT}/ in your default browser (link is single use)`];
  },
  async doctor(args, f) {
    if (args.length) throw usage(`doctor takes no arguments, got "${args[0]}"`, help('doctor')[0]);
    if (f.version && !f.pin) throw usage('--version needs --pin', help('doctor')[0]);
    const r = await api('POST', '/api/doctor', { tag: f.tag, pin: f.pin, version: f.version }, f.tag ? 3_600_000 : 120_000); // tag checks run the tag's commands
    const failed = r.checks.filter(c => !c.ok).length;
    if (failed) process.exitCode = 1;
    const rows = r.checks.map(c => ({ ...c, status: !c.ok ? 'fail' : c.warn ? 'warn' : 'ok' }));
    return [`doctor: ${failed ? `FAIL (${failed} of ${r.checks.length} checks)` : 'ok'}`, ...table('checks', rows, ['name', 'status', 'detail', 'fix'])];
  },
  async gc(args, f) {
    if (!f.delete) {
      if (args.length) throw usage(`gc takes no ids without --delete, got "${args[0]}"`, help('gc')[0]);
      const q = new URLSearchParams(Object.entries({ limit: f.limit, after: f.after }).filter(([, v]) => v !== undefined));
      const r = await api('GET', `/api/gc${q.size ? `?${q}` : ''}`, undefined, GC_TIMEOUT_MS);
      const rows = r.items.map(i => ({ ...i, size: human(i.bytes) }));
      return [...(r.total > rows.length ? [`count: ${rows.length} of ${r.total}`] : []), ...table('gc', rows, ['id', 'kind', 'size', 'age_days', 'reason']),
        ...(r.next ? [`help: ${BIN} gc --after ${r.next}`] : []), ...(rows.length ? [`help: ${BIN} gc --delete <id>... removes for good`] : [])];
    }
    if (!args.length) throw usage('gc --delete needs one or more ids from `gc`', help('gc')[0]);
    if (f.limit !== undefined || f.after !== undefined) throw usage('--limit and --after are for listing', help('gc')[0]);
    const r = await api('POST', '/api/gc', { ids: args }, GC_TIMEOUT_MS);
    if (r.skipped.length) process.exitCode = 1;
    return [...table('deleted', r.deleted.map(d => ({ ...d, size: human(d.bytes) })), ['id', 'size']), ...(r.skipped.length ? table('skipped', r.skipped, ['id', 'reason']) : [])];
  },
  'eval fake'() {
    const code = path.join(__dirname, '..');
    // client: not daemon request path
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(code, 'test', '*.test.js')], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
    return [];
  },
};

// Detail view of one flow: truncated text, --full for all of it.
async function flowDetail(id, f) {
  const { ticket: k } = await api('GET', `/api/tickets/${id}`);
  const text = k.text || '';
  const fields = ['id', 'title', 'kind', 'tag', 'state', 'waiting', 'rework', 'fix_of', 'promoted_from', 'blocked_by', 'created_at', 'updated_at']
    .filter(x => k[x] != null && !(Array.isArray(k[x]) && !k[x].length));
  const out = ['flow:', ...fields.map(x => `  ${x}: ${cell(typeof k[x] === 'object' ? JSON.stringify(k[x]) : k[x])}`)];
  if (!text) return out;
  const cut = !f.full && text.length > TRUNCATE;
  out.push(`  text: ${cell(cut ? text.slice(0, TRUNCATE) : text)}`);
  if (cut) out.push(`  (truncated, ${text.length} chars total)`, `help: ${BIN} show ${k.id} --full`);
  return out;
}

async function home() {
  const tasks = (await state()).reminders;
  const d = today();
  const count = s => tasks.filter(t => t.status === s).length;
  const overdue = tasks.filter(t => t.status !== 'done' && t.due && t.due < d);
  const rows = withPos(tasks);
  const out = [
    `bin: ${tilde(process.argv[1])}`,
    `description: Bridge to the local task board (tbd http://127.0.0.1:${PORT}; data ${tilde(HOME)})`,
    `today: ${d}`,
    `counts: ${STATUSES.map(s => `${s} ${count(s)}`).join(' · ')} · overdue ${overdue.length}`,
    ...table('now', rows.filter(r => r.status === 'now')),
    ...table('next', rows.filter(r => r.status === 'next')),
  ];
  const ids = new Set(overdue.filter(t => t.status !== 'now' && t.status !== 'next').map(t => t.id));
  if (ids.size) out.push(...table('overdue', rows.filter(r => ids.has(r.id))));
  out.push('help[4]:',
    `  Run \`${BIN} grep "<words>"\` to search every task`,
    `  Run \`${BIN} list --status later\` to see later / inbox / done`,
    `  Run \`${BIN} add "<title>" --project <p> --status <s>\` to add`,
    `  Run \`${BIN} done <id|words>\` or \`${BIN} set <id> --status <s>\` to update`);
  return out;
}

// Splits argv into positional args and checked flags for command `key`.
function parse(key, rest) {
  const args = [], f = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') return { help: true };
    let k, v;
    if (a.startsWith('--')) [k, v] = a.slice(2).split(/=(.*)/s);
    else if (SHORT[a]) k = SHORT[a];
    else { args.push(a); continue; }
    if (!FLAGS[key].includes(k)) {
      throw usage(`unknown flag ${a.startsWith('--') ? '--' + k : a} for \`${key}\``,
        FLAGS[key].length ? `valid flags: ${FLAGS[key].map(x => '--' + x).join(', ')}` : `\`${key}\` takes no flags`);
    }
    if (BOOL.includes(k)) { f[k] = true; continue; }
    if (v === undefined) {
      v = rest[++i];
      if (v === undefined) throw usage(`--${k} needs a value`, help(key)[0]);
    }
    // list/grep --status also takes "all" and comma lists; statusFilter checks those.
    const ok = CHECK[k] && !(k === 'status' && (key === 'list' || key === 'grep')) ? CHECK[k](v) : true;
    if (ok !== true) throw usage(ok, help(key)[0]);
    f[k] = v;
  }
  return { args, f };
}

async function run(argv) {
  const [cmd, ...more] = argv;
  if (!cmd) return home();
  const verbs = [...Object.keys(CMDS).filter(k => !k.includes(' ')), ...Object.keys(GROUPS)];
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return [`usage: ${BIN} [command]  (no command = dashboard)`, `commands: ${verbs.join(', ')}`,
      `run \`${BIN} <command> --help\` for flags and examples`];
  }
  let key = cmd, rest = more;
  if (GROUPS[cmd]) {
    if (!GROUPS[cmd].includes(rest[0])) {
      if (rest[0] === '--help' || rest[0] === '-h') return GROUPS[cmd].flatMap(s => help(`${cmd} ${s}`));
      throw usage(`${cmd} needs one of: ${GROUPS[cmd].join(', ')}`, `${BIN} ${cmd} ${GROUPS[cmd][0]}`);
    }
    key = `${cmd} ${rest[0]}`;
    rest = rest.slice(1);
  } else if (!CMDS[cmd]) {
    throw usage(`unknown command "${cmd}"`, `commands: ${verbs.join(', ')}`);
  }
  const p = parse(key, rest);
  if (p.help) return help(key);
  return CMDS[key](p.args, p.f);
}

async function main(argv, bin = 'tb') {
  BIN = bin;
  try {
    const out = await run(argv);
    if (out.length) console.log(out.join('\n'));
  } catch (e) {
    const x = e instanceof Exit ? e : new Exit(1, [`error: ${e.message}`]);
    console.log(x.lines.join('\n'));
    process.exitCode = x.code;
  }
}

module.exports = { main };
