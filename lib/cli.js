'use strict';
// tb: AXI CLI over the tbd HTTP API (never touches data files). Zero dependencies.
// TOON on stdout. Exit codes: 0 ok (incl. no-op), 1 error, 2 usage.
// bin/tb and bin/taskboard-axi (v1 shim) are one-line launchers: main(argv, binName).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { STATUSES, ROW, plain, cell, table, addPos, bySection, withPos, posOf, line, warnings } = require('./toon');
const { KINDS, STATES: FLOW_STATES, AGENT } = require('./fsm');
const { isDate, TBD_RE } = require('./store');
const { NAME_RE } = require('./tags');
const { DRILLS } = require('./metrics');
const golden = require('./evalscore');
const { isObj, shq } = require('./util');
const sh = require('./sh');
const { resumes } = require('./approvals'); // review M2: a blocked action's Allow, as the page decides it
const { MUTATING } = require('./verbs'); // full-access-runs Phase 3: tb in a board run (TBX_RUN) refuses these

const HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const PORT = process.env.TB_PORT || '7777';
const TZ = process.env.TB_TZ || 'Asia/Jakarta';
const TIMEOUT_MS = 5000;
const ASSIGN_TIMEOUT_MS = 200_000; // tbd checks the tag (git, ≤ 60 s) and cuts the worktree (≤ 120 s) before it answers
const ANSWERS_MAX = 256 * 1024; // tb answer --file
const GC_TIMEOUT_MS = 600_000; // sizing and removing big worktrees takes a while
const SCOPE_TIMEOUT_MS = 1_200_000; // a deps allow builds the dependencies (npm ci + rebuild) before tbd answers
const PUSH_POLL_MS = 2000; // tb push: a read of the ticket every 2 s, at most PUSH_WAIT_MS (tbd's own push timeouts: 120 s)
const PUSH_WAIT_MS = 150_000;
const HOLD_WAIT_MS = 30_000; // tb hold: the run's tree dies (SIGINT, then SIGKILL after 10 s) before the resume line prints
const FEEDBACK_MAX = 64 * 1024; // tb rework --feedback-file (tbd takes the text, ≤ 64 KB)
const WORK_HELP = { // tb answer <id> on a working ask: how to answer each kind
  scope: 'tb scope {id} --allow | --deny, or tb answer {id} --replan',
  policy: 'tb answer {id} --allow-change "<change>" | --deny-change "<change>" | --replan',
  other: 'tb answer {id} "<your answer>" | --replan',
};
const KICK = 'launchctl kickstart -k gui/$(id -u)/local.taskboard';
const FLOW_CLOSED = ['done', 'cancelled'];
const FLOW_ROW = ['id', 'kind', 'tag', 'state', 'waiting', 'title'];
const REPORT_KINDS = ['review', 'qa', 'rec', 'final', 'summary', 'verdict'];
const TRUNCATE = 500;
const FOLLOW_MS = 1000; // tb logs -f: a read per second
const MIN = 60_000;
const DRILL_MS = 15 * MIN; // tb eval chaos: a run not healthy this long after the drill failed it
const LABEL = process.env.TB_LABEL || 'local.taskboard'; // the launchd job tb eval chaos kickstarts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GB = 1024 ** 3;
const CODE = path.join(__dirname, '..'); // this checkout: tb eval golden runs its harnesses and prompts, never writes in it (X14)
const EVALS = path.join(HOME, 'evals'); // tb eval golden's evidence + score files
const EVAL_MAX = 64 * 1024; // tb eval golden --record (tbd takes ≤ 64 KB)
const HARNESS_MS = { dry: 60 * MIN, real: 10 * 60 * MIN }; // one harness, at most (then SIGINT: it cancels its run, cleans up)
let BIN = 'tb'; // ponytail: module state, one CLI run per process

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const clock = at => (Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '--:--'); // HH:MM in TZ
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
// which needs the token. Once per process, like BIN, until a call finds tbd gone (api()). 503 starting = tbd bound its port but is not ready yet (D39):
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
    if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code)) identified = undefined; // tbd gone or restarting: the next call proves the port is tbd again
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
// D-0081: what a flow waits on, as text: the reason (children: done/total); none → undefined (an empty cell)
const waitOf = w => (w?.reason === 'children' ? `children ${w.done}/${w.total}` : w?.reason);
// M5.5: what the lane waits mean (ui/app.js WAIT has the same three)
const LANE_WAIT = { merge: 'merging a finished lane into the branch', lanes: 'waits for its lanes to finish', lane_setup: 'setting up the lane clones; nothing to approve' };
const posValue = v => (v === 'top' || v === 'bottom' ? v : Number(v));

const CHECK = {
  'qa-ports': v => (/^\d{1,5}(,\d{1,5}){0,99}$/.test(v) && v.split(',').every(n => +n >= 1 && +n <= 65535)) || '--qa-ports must be ports from 1 to 65535, e.g. 3000,3001',
  db: v => v === 'local' || v === 'none' || '--db must be local or none',
  // skill names reach a run's system prompt: plain names only (copySkills' rule)
  'skills-off': v => /^([\w-][\w.-]*(,[\w-][\w.-]*)*)?$/.test(v) || '--skills-off must be plain skill names, comma-separated, e.g. caveman,ponytail',
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
  phase: v => AGENT.includes(v) || `--phase must be one of ${AGENT.join(', ')}`,
  min: v => /^[1-9]\d{0,2}$/.test(v) || '--min must be a number of minutes from 1',
  sha: v => /^[0-9a-f]{7,40}$/.test(v) || '--sha must be 7-40 lowercase hex characters (a commit id)', // tbd checks the same
  n: v => /^[1-9]\d{0,8}$/.test(v) || '--n must be a whole number from 1 (a gate, review, QA or final review number)',
  kind: v => REPORT_KINDS.includes(v) || `--kind must be ${REPORT_KINDS.join(', ')}`,
  run: v => /^[1-9]\d{0,8}$/.test(v) || '--run must be a run number from 1',
  cursor: v => /^\d{1,9}$/.test(v) || '--cursor must be a whole number (the help line names the next one)',
  task: v => /^\S{1,64}$/.test(v) || '--task must be a task id, e.g. T2',
  'allow-change': v => (v.trim() !== '' && v.length <= 300) || '--allow-change needs the change as the gate named it, e.g. "drop User.nickname"',
  'deny-change': v => (v.trim() !== '' && v.length <= 300) || '--deny-change needs the change as the gate named it, e.g. "drop User.nickname"',
  feedback: v => v.trim() !== '' || '--feedback cannot be empty',
  days: v => (/^[1-9]\d{0,2}$/.test(v) && +v <= 365) || '--days must be a whole number from 1 to 365',
  'max-gb': v => (/^[1-9]\d?$/.test(v) && +v <= 40) || '--max-gb must be a whole number of GB from 1 to 40',
  only: v => v.split(',').every(s => Object.hasOwn(HARNESS, s)) || `--only must be a comma list of ${Object.keys(HARNESS).join(', ')}`,
};
const CHECK_OF = { health: { cursor: v => golden.isIso(v) || '--cursor must be the time the help line names (ISO-8601 UTC)' } }; // a flag that means another thing here

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

// A file read here, on the CLI's own machine, for tbd (≤ max bytes; tbd only ever gets the text): its text, else exit 1
function readText(file, max) {
  try {
    if (fs.statSync(file).size > max) throw fail(`${file} is over ${max / 1024} KB`);
    return fs.readFileSync(file, 'utf8'); // client: not daemon request path
  } catch (e) {
    if (e instanceof Exit) throw e;
    throw fail(`cannot read ${file}: ${e.code ?? e.message}`);
  }
}

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
  get: ['usage: {bin} get <id|title words>', 'shows every field of one reminder or flow; alias show; --full = whole flow text, plus its waiting Approve cards and open blocked actions (their ids)', 'example:', '  {bin} get t_k3x9qa'],
  add: ['usage: {bin} add "<title>" [--project <p>] [--status inbox] [--due YYYY-MM-DD] [--note "<text>"] [--pos bottom]',
    'defaults: status inbox, pos bottom (top for done); same open title twice = no-op; also: --tag <t>', 'examples:',
    '  {bin} add "Review billing PR" --project Acme --status now --pos 1 --due 2026-09-25',
    '  {bin} add "Read DDIA ch.5" --project Learning --status later'],
  new: ['usage: {bin} new "<text>" [-f code|research|brainstorm|design|task] [-t <tag>] [--title "<short>"] [--fix-of <id>] [--sandbox] [--where worktree|folder] [--start] [reminder flags]',
    'without -f: a reminder (same flags as add); with -f: a flow in backlog (only -t, --title, --fix-of, --sandbox, --where, --start)',
    '-f task (Settings → Terminal → Task tickets on): the agent works like your terminal and leaves its changes uncommitted; no --sandbox',
    '--where (-f task only): worktree = Own Worktree (its own locked worktree of the repo on branch tb/<id>; git tags only), folder = My Folder (the tag\'s real folder); default: worktree on a git tag (changed: it used to be the real folder), folder on a plain one',
    '--sandbox: its runs are locked (seatbelt on, project settings only, no user skills, rules or MCP); default: full access',
    '--start: assign it at once (the tb assign checks); refused: it stays in backlog and the line says why; /name in the text asks for that skill', 'examples:',
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
    '  [--env-files a,b] [--context a,b] [--skills a,b] [--skills-off a,b] [--checks \'{"lint":"npm run lint"}\'] [--heavy \'["npm ci"]\'] [--leak-check] [--ident] [--push-remote <remote>] [--qa-ports 3000,3001] [--db local|none]',
    'name is hierarchical (a/b); --type and --path go together (git needs --base); a name alone makes a group; flow tags need a leaf with a path',
    '--ident: your git user.name + user.email (git config --global) author the squash; --push-remote: the git remote tb push sends to (https only)',
    '--qa-ports: the ports QA may call on the app it starts; --db local: gates + QA may reach the local postgres (none: drop it)',
    '--skills: skills the tag adds to the board defaults; --skills-off: board default skills the tag removes',
    'the flags replace the whole tag, except --ident / --push-remote / --qa-ports / --db / --skills-off alone: those are merged into the existing tag',
    'examples:', '  {bin} tag add acme/api --type git --path ~/code/acme-api --base main', '  {bin} tag add acme/api --ident --push-remote origin'],
  'tag list': ['usage: {bin} tag list', 'example:', '  {bin} tag list'],
  'notify-test': ['usage: {bin} notify-test', 'sends the "Do now" notification right away'],
  'eval fake': ['usage: {bin} eval fake', 'runs the fake-claude test suite of this checkout (no tbd needed)'],
  'eval chaos': ['usage: {bin} eval chaos kill-tbd|kill-claude|restart|freeze|wifi|lid|reboot [<id>] [--min 10] [--after]',
    'also: {bin} eval chaos disk [<id>] [--max-gb 20] [--min 3] | memory [<id>] [--min 2]',
    'acts on the one live run (or <id>), watches it until healthy (running again with events, or ended result) or blocked (15 min max), records a t:drill line; exit 1 = drill failed',
    'kill-tbd: kill -9 tbd + launchctl kickstart (TB_LABEL, default local.taskboard); kill-claude: SIGKILL the run\'s claude; restart: both + the run\'s whole group',
    'freeze: SIGSTOP tbd + the run\'s group, SIGCONT after --min (default 10) = lid closed; wifi, lid, reboot: prints the steps for you, then watches (reboot: run again with --after once logged in)',
    'restart and freeze hit claude\'s own group only: its Bash calls run in groups of their own, so restart leaves them alive (like a crash) and freeze leaves them running; tbd kills them at run end when it saw them',
    'every pid is checked with ps first (tbd.js, or config claude_bin + the run\'s session); anything else is refused, no signal',
    'disk: one file, unlinked at once (its space comes back on any exit, kill -9 too), fills the disk to 1 GB under config disk.stop_gb (default 8), at most --max-gb (default 20, max 40: size it from df -g ~); tbd must stop new runs and alert; then the run\'s claude is SIGKILLed and for --min (default 3, max 10) no run may start; refused, nothing written, when free space is under stop_gb, the fill is over --max-gb or stop_gb − 1 is under 6 GB',
    'memory: memory_pressure -S -l critical (simulated, no memory taken) for --min (default 2, max 10); tbd must pause the run, the level go back to normal and the run come back; when it needs root, prints the sudo step for you, then watches',
    'examples:', '  {bin} eval chaos kill-claude', '  {bin} eval chaos freeze t_k3x9qa --min 10', '  {bin} eval chaos reboot t_k3x9qa --after', '  {bin} eval chaos disk --max-gb 18'],
  'eval golden': ['usage: {bin} eval golden --dry | --real --yes [--only golden,planner,review,qa,final_gate] | --record <score.json>',
    '--dry: every eval harness on fake claude, one at a time (golden-working, eval-planner, eval-phase review, qa, final_gate); exit 0 when all exit 0; records nothing',
    '--real: the same on real claude (costs usage, printed first); refused while tbd has a live run; a case worse than its base (the last recorded run that was not worse) runs once more and that run counts; records the score (t:golden); exit 1 when the verdict is worse or a harness failed',
    '--record: records a golden score JSON v1 file (scripts/harness.js scoreJson; blind scores come only this way); exit 1 when the verdict is worse',
    'evidence + score files go to ~/.taskboard/evals/ (never into the code checkout)', 'examples:',
    '  {bin} eval golden --dry', '  {bin} eval golden --real --yes --only review,qa', '  {bin} eval golden --record docs/verification/2026-10-18-m5-goldens.json'],
  health: ['usage: {bin} health [--days 30] | {bin} health --drills [--limit 20] [--cursor <next>]',
    'the spec §12 targets over the last --days (1-365): x / y, %, goal and PASS, FAIL or n/a (no data yet, or watch only); tbd RSS; the golden base; doctor\'s last record',
    '--drills: the drill log (tb eval chaos), newest first, a page at a time', 'examples:', '  {bin} health', '  {bin} health --days 7', '  {bin} health --drills'],
  doctor: ['usage: {bin} doctor [--tag <name> [--ident] [--push-remote <remote>] [--qa-ports 3000] [--db local|none]] [--pin [--version 2.1.292]]',
    '   or: {bin} doctor --terminal [--live --tag <git tag> [--yes]]',
    'checks the Claude login (subscription, not an API key), the pinned claude copy, Fable billing and node; exit 1 when any check fails',
    '--tag: also that tag\'s repo, its .claude settings and its check commands (can take minutes)',
    '--ident / --push-remote / --qa-ports / --db: merged into the tag first, like tag add (a push remote needs your ident: assign refuses without it)',
    '--pin: copy ~/.local/share/claude/versions/<version> to ~/.taskboard/bin/claude-<version> and use it',
    '--terminal: free checks of what runs use like your terminal (tb-git ls-remote per git tag, folder MCP servers, tb-chrome, skills, the wall runs node, claude has auto mode, the switches); one line each: ok|warn|fail · name · detail; exit 1 when one fails',
    '--live --tag: one short sonnet run on that git tag that tries Bash, a subagent, an MCP tool, the skills and tb-git; costs usage (printed first), so it needs --yes', 'examples:',
    '  {bin} doctor', '  {bin} doctor --tag acme/api', '  {bin} doctor --tag acme/api --ident', '  {bin} doctor --pin', '  {bin} doctor --terminal', '  {bin} doctor --terminal --live --tag acme/api --yes'],
  gc: ['usage: {bin} gc [--limit 20] [--after <id>]    or    {bin} gc --delete <id>...',
    'lists worktrees of done / cancelled / missing tickets, run logs older than 30 days and cache entries, with sizes',
    '--delete: removes only the ids given (checked against a fresh list); exit 1 when one is refused', 'example:', '  {bin} gc --delete worktree/t_k3x9qa'],
  logs: ['usage: {bin} logs <id|title words> [-f] [--plain]', 'the last 200 lines of the flow\'s current or last run log; -f/--follow: then new lines as they come, until the run ends',
    '--plain: the activity feed instead (HH:MM  what it did, in plain words, with the state moves and your actions), as the board\'s Activity tab',
    'examples:', '  {bin} logs t_k3x9qa', '  {bin} logs t_k3x9qa -f', '  {bin} logs t_k3x9qa --plain -f'],
  resume: ['usage: {bin} resume <id|title words> [--phase planning|working|review|qa]',
    'resumes the ended run (same session); from blocked: the phase it blocked in, or --phase an earlier one; refused while the run is live',
    'answers once tbd took it (the run may still wait for memory or the network): see {bin} show <id>', 'example:', '  {bin} resume t_k3x9qa'],
  restart: ['usage: {bin} restart <id|title words>', 'a fresh session in the same phase (from blocked: where it blocked); a live run is stopped first',
    'example:', '  {bin} restart t_k3x9qa'],
  assign: ['usage: {bin} assign <id|title words>',
    'backlog → planning: the tag must pass doctor (repo, base, .claude settings; no check commands) and every blocker be merged (code) or done',
    'a git tag gets its own clone at its base commit (~/.taskboard/worktrees/<id>), where planning reads the code', 'example:', '  {bin} assign t_k3x9qa'],
  answer: ['usage: {bin} answer <id|title words> --file answers.json [--plan-now]',
    'clarify → planning: answers.json maps each question id to {"pick": "<option>"}, {"text": "..."}, {"use": "recommended"} or {"use": "you_decide"}',
    'every question needs an answer; --plan-now: the unanswered ones are the planner\'s call; with neither flag: prints the open questions (exit 1)',
    'also, a question from working: {bin} answer <id> "<text>" (the same session goes on) | --replan (a new plan) | --allow-change "<change>" | --deny-change "<change>" (a policy item the gate named); with none: prints the ask (exit 1)',
    'examples:', '  {bin} answer t_k3x9qa', '  {bin} answer t_k3x9qa --file answers.json', '  {bin} answer t_k3x9qa --plan-now',
    '  {bin} answer t_k3x9qa "keep the old route"', '  {bin} answer t_k3x9qa --allow-change "drop User.nickname"'],
  scope: ['usage: {bin} scope <id|title words> --allow|--deny [--task <task id>]',
    'a working ask for files outside the task (scope), a protected file, package scripts or dependencies: --allow widens THIS task only, --deny tells the agent to stay in scope; the same session goes on',
    'protected / scripts / deps allows bind to the file at HEAD (a later change asks again) and only the CLI may give them; a deps allow builds the dependencies first; --task: refused unless the ask is on that task',
    'examples:', '  {bin} scope t_k3x9qa --allow', '  {bin} scope t_k3x9qa --deny --task T2'],
  rework: ['usage: {bin} rework <id|title words> --feedback "<text>" | --feedback-file <path>',
    'review / qa / final gate (while unbuilt) → working: your feedback (≤ 64 KB; a file is read here, tbd gets its text) becomes one fix task; a 3rd rework blocks the flow (Resume resets the count)',
    'also at close (final gate passed, waiting close) while no child ticket has started: the squash is undone by the next one',
    'examples:', '  {bin} rework t_k3x9qa --feedback "the list must stay sorted by name"', '  {bin} rework t_k3x9qa --feedback-file review.md'],
  push: ['usage: {bin} push <id|title words> [--close]',
    'sends the flow\'s squash (final gate passed: waiting close, or done) to its tag\'s push remote as branch tb/<id>-<slug>: leak scan first, then git push with a lease; waits for the outcome (up to 150 s)',
    'the tag needs a push remote (https only) and your git ident: {bin} tag add <tag> --push-remote <r> --ident',
    '--close: after a green push, close the flow ({bin} close checks); a red push leaves it waiting close',
    'a Task waiting for you: Commit and Push — the same session commits only the files the Task changed and pushes its branch once (leak scan first; no --close)',
    'example:', '  {bin} push t_k3x9qa --close'],
  close: ['usage: {bin} close <id|title words>',
    'final gate passed (waiting close: the squash is made) → done, once every child ticket is done or cancelled; never pushes ({bin} push does); the worktree stays until {bin} gc',
    'a Task waiting for you: Done (the folder is checked first; its changes stay as they are)',
    'example:', '  {bin} close t_k3x9qa'],
  lavish: ['usage: {bin} lavish <id|title words>', 'planning questions open: reopens their page in your browser (Lavish) and prints its url', 'example:', '  {bin} lavish t_k3x9qa'],
  pass: ['usage: {bin} pass <id|title words> [--sha <commit>]',
    'you stand in for an unbuilt phase: review → qa → final gate; at the final gate --sha = the squash commit on the base branch (it must come after base_sha and touch a file the branch changed) → done with merged_at, or waiting children until every child ticket is done or cancelled',
    'a built final gate is never passed: {bin} close / {bin} push', 'examples:', '  {bin} pass t_k3x9qa', '  {bin} pass t_k3x9qa --sha 1a2b3c4'],
  gates: ['usage: {bin} gates <id|title words> [--n <gate number>] [--limit 20]',
    'gate results newest first (from --n down): result, each check (ok, exit, ms, flaky, log file), then the newest one\'s checks, fail-first verdict, why and ask; full logs: the browser drawer',
    'example:', '  {bin} gates t_k3x9qa'],
  report: ['usage: {bin} report <id|title words> --kind review|qa|final|verdict [--n <number>] | --kind summary | --kind rec [--run <run number>] [--cursor <n>]',
    'a stored report of the flow: --kind review = the review loop\'s findings (sev, conf, where, problem, scenario, fix, open or need review), the newest review or --n; fix n/3 = fix sessions used of 3 per flow (shown for the newest review only: older ones omit it)',
    '--kind qa = a QA result: verdict, report file, each case (result, cause, evidence: captured by tbd = a rec tbd recorded, agent-made = screenshots and notes only), need review lines; the newest QA or --n',
    '--kind rec = the HTTP calls tbd made for a QA run, as curl + status + headers + body (secrets masked), the newest run or --run, a page at a time (--cursor)',
    '--kind final = the final review: verdict, findings (as review), its verdict and verification doc paths; the newest or --n',
    '--kind summary = the handoff summary (title, description, what was worked on, blocker, need review, verdict); --kind verdict = the verdict doc as text, with the evidence tbd captured, of the newest passing final review or --n',
    'examples:', '  {bin} report t_k3x9qa --kind review', '  {bin} report t_k3x9qa --kind qa', '  {bin} report t_k3x9qa --kind rec --run 7', '  {bin} report t_k3x9qa --kind final',
    '  {bin} report t_k3x9qa --kind summary', '  {bin} report t_k3x9qa --kind verdict'],
  interventions: ['usage: {bin} interventions <id|title words> [--limit 20] [--cursor <n>]',
    'what you did on the flow, oldest first: answer, replan, scope, allow / deny-change, rework, pass, close, push, each with its time and cli or ui',
    'example:', '  {bin} interventions t_k3x9qa'],
  approve: ['usage: {bin} approve <id|title words>',
    'plan_approval → working: freezes the plan, then tbd sets the worktree up (branch tb/<id>-<slug>, env files, skills, the tag\'s setup in the heavy slot, child tickets)',
    'answers once tbd took it; a failed setup leaves it in plan_approval (waiting setup_failed, see {bin} show <id>): approve again once fixed', 'example:', '  {bin} approve t_k3x9qa'],
  reject: ['usage: {bin} reject <id|title words> "<comment>" [--ask]',
    'plan_approval → planning with your comment (the planner must keep it); --ask: the planner must ask you questions before the next plan',
    'example:', '  {bin} reject t_k3x9qa "keep GET /users/all working" --ask'],
  cancel: ['usage: {bin} cancel <id|title words>', 'stops the run (its process tree) and cancels the flow; the worktree stays until {bin} gc',
    'example:', '  {bin} cancel t_k3x9qa'],
  // full-access-runs Phase 8: Settings (the page's Settings view) and the Sandbox switch of a backlog flow
  config: ['usage: {bin} config | {bin} config set <dotted.key> <json> | {bin} config skills add|rm <name>',
    'shows the Settings keys, one dotted key a row (the board\'s Settings view shows the same); claude_bin is shown only: {bin} doctor --pin changes it',
    'set: the value is JSON (a string in quotes); a nested object goes whole to tbd, built from the live config; tbd checks every value',
    'keys: max_concurrent 1-3, subagents.concurrent 1-4, subagents.per_session_total 1-20, final_distinct, lanes.enabled, models.<phase>.model opus|sonnet|fable, models.<phase>.effort low|medium|high|xhigh, memory.phase_need_gb.<phase> 0.2-4 (GB), skills.defaults',
    'skills add|rm: one name in or out of the board default skills (installed in ~/.claude/skills, or one of the default list)',
    'examples:', "  {bin} config", "  {bin} config set models.review.effort '\"high\"'", '  {bin} config set max_concurrent 2', '  {bin} config skills rm frontend-design'],
  'set-sandbox': ['usage: {bin} set-sandbox <id|title words> on|off',
    'a backlog flow only: on = its runs are locked (seatbelt on, project settings only, no user skills, rules or MCP); off = full access again (the board page can only turn it on)',
    'example:', '  {bin} set-sandbox t_k3x9qa on'],
  // full-access-runs Phase 9: steering
  note: ['usage: {bin} note <id> "<text>"',
    'a live run stops and the same session goes on with "Irfan says: <text>" first; no live run: the next run of the flow starts with it (at most 10 wait)',
    'a Task waiting for you: Send — the same session goes on with it at once',
    'example:', '  {bin} note t_k3x9qa "use the existing retry helper"'],
  hold: ['usage: {bin} hold <id|title words>',
    'Pause and Copy: stops the run (its turn ends; a tool call in flight finishes or dies with it), waits until it is gone, then prints the line that resumes its session in your terminal; tbd starts nothing on the flow until {bin} handback',
    'use that exact line (tbd cannot see claude -c) and /exit the session before {bin} handback',
    'example:', '  {bin} hold t_k3x9qa'],
  handback: ['usage: {bin} handback <id|title words>', 'after {bin} hold: the board resumes the same session; refused while claude --resume <session> still runs (close it first)',
    'example:', '  {bin} handback t_k3x9qa'],
  // board-terminal-parity Phase 2 task 4: the Approve cards and auto mode's blocks (ids from {bin} get <id> --full)
  'approve-action': ['usage: {bin} approve-action <id> <approval id> yes|no',
    'answers an Approve card of a run: yes = that one action, exactly as the card shows it; no = refused (no answer in terminal.approve_min minutes counts as no)',
    'the card ids: {bin} get <id> --full (approvals)', 'example:', '  {bin} approve-action t_k3x9qa a_1f2e3d yes'],
  'allow-blocked': ['usage: {bin} allow-blocked <id> <blocked id> [--dismiss]',
    'auto mode blocked an action: allow exactly that action once, and the same session goes on, told to retry that one call; only while the blocked run can go on (else refused: run it from your terminal, or --dismiss)',
    '--dismiss: drop the card instead (the action stays blocked); the ids: {bin} get <id> --full (blocked)',
    'example:', '  {bin} allow-blocked t_k3x9qa b_4c5d6e'],
  open: ['usage: {bin} open [--print]', 'unlocks the board UI in your default browser with a one-time link (single use, 60 s)',
    '--print: print the link instead of opening it', 'example:', '  {bin} open'],
};
const FLAGS = {
  list: ['status', 'project', 'limit', 'flows', 'reminders'], grep: ['status', 'project', 'limit'], get: ['full'], show: ['full'],
  add: ['project', 'tag', 'status', 'due', 'note', 'pos'],
  new: ['project', 'tag', 'status', 'due', 'note', 'pos', 'flow', 'title', 'fix-of', 'sandbox', 'where', 'start'],
  set: ['title', 'project', 'tag', 'status', 'due', 'note', 'pos'], move: ['pos'], done: [], rm: [], promote: ['flow', 'tag'],
  'tag add': ['type', 'path', 'base', 'setup', 'output', 'env-files', 'context', 'skills', 'skills-off', 'checks', 'heavy', 'leak-check', 'ident', 'push-remote', 'qa-ports', 'db'],
  'tag list': [], 'notify-test': [], 'eval fake': [], 'eval chaos': ['min', 'after', 'max-gb'], 'eval golden': ['dry', 'real', 'yes', 'only', 'record'], open: ['print'],
  doctor: ['tag', 'pin', 'version', 'ident', 'push-remote', 'qa-ports', 'db', 'terminal', 'live', 'yes'], gc: ['delete', 'limit', 'after'],
  logs: ['follow', 'plain'], resume: ['phase'], restart: [], cancel: [], assign: [], answer: ['file', 'plan-now', 'replan', 'allow-change', 'deny-change'], approve: [], reject: ['ask'],
  scope: ['allow', 'deny', 'task'], rework: ['feedback', 'feedback-file'], pass: ['sha'], push: ['close'], close: [], lavish: [], gates: ['n', 'limit'], report: ['kind', 'n', 'run', 'cursor'], interventions: ['limit', 'cursor'],
  health: ['days', 'drills', 'limit', 'cursor'],
  config: [], 'set-sandbox': [], note: [], hold: [], handback: [], 'approve-action': [], 'allow-blocked': ['dismiss'],
};
const BOOL = ['terminal', 'live', 'dismiss', 'sandbox', 'start', 'close', 'flows', 'reminders', 'full', 'leak-check', 'ident', 'print', 'pin', 'delete', 'follow', 'plain', 'after', 'plan-now', 'ask', 'replan', 'allow', 'deny', 'drills', 'dry', 'real', 'yes'];
const SHORT = { '-f': 'flow', '-t': 'tag' };
const SHORT_OF = { logs: { '-f': 'follow' } }; // -f is --flow everywhere else
const VALUE_OF = { gc: ['after'] }; // --after: a switch for eval chaos, gc's page cursor (a value)
const GROUPS = { tag: ['add', 'list'], eval: ['fake', 'chaos', 'golden'] };
HELP.show = HELP.get;

const help = key => HELP[key].map(l => l.replaceAll('{bin}', BIN));

async function create(args, f, key) {
  const title = args.join(' ').trim();
  if (!title) throw usage(`${key} needs a title`, help(key)[0]);
  if (f.flow) {
    const bad = ['status', 'pos', 'due', 'note', 'project'].find(k => f[k] !== undefined);
    if (bad) throw usage(`--${bad} is for reminders; a flow takes -t, --title, --fix-of, --sandbox, --where and --start`, help('new')[0]);
    const r = await api('POST', '/api/flows', { text: title, title: f.title, kind: f.flow, tag: f.tag, fix_of: f['fix-of'], sandbox: f.sandbox, where: f.where, ...(f.start && { start: true }) }, f.start ? ASSIGN_TIMEOUT_MS : TIMEOUT_MS);
    const k = r.ticket;
    return [[`added: ${k.id} → ${k.state}`, k.kind, k.tag, k.title].filter(Boolean).join(' · '), ...(r.started === false ? [`not started: ${cell(r.why)}`] : [])];
  }
  if (f.title !== undefined || f['fix-of'] !== undefined || f.sandbox || f.start || f.where !== undefined) throw usage('--title, --fix-of, --where, --start and --sandbox need -f <kind>', help('new')[0]);
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

// board-terminal-parity Phase 2 task 6: tb doctor --terminal (the free checks) and --live --tag <t> --yes (one short run:
// its cost printed first; without --yes only that, exit 2). tbd answers one line each: ok|warn|fail · name · detail.
const TERMINAL_MS = 300_000; // the fixed checks: one 20 s ls-remote per git tag, Chrome's start
const LIVE_MS = 900_000; // the live run: its clone + a run of at most 10 min
async function terminalCheck(f) {
  if (!f.terminal) throw usage('--live and --yes go with --terminal', help('doctor')[0]);
  const other = ['pin', 'version', 'ident', 'push-remote', 'qa-ports', 'db'].find(k => f[k] !== undefined);
  if (other) throw usage(`--${other} does not go with --terminal`, help('doctor')[0]);
  if (f.yes && !f.live) throw usage('--yes goes with --live', help('doctor')[0]);
  if (f.tag !== undefined && !f.live) throw usage('--tag goes with --live (the free checks cover every tag)', help('doctor')[0]);
  if (f.live && f.tag === undefined) throw usage('--live needs --tag <git tag>', help('doctor')[0]);
  const lines = r => {
    const failed = r.checks.filter(c => c.status === 'fail').length;
    if (failed) process.exitCode = 1;
    return [`terminal: ${failed ? `FAIL (${failed} of ${r.checks.length} checks)` : 'ok'}`, ...r.checks.map(c => plain([c.status, c.name, c.detail].join(' · ')))];
  };
  if (!f.live) return lines(await api('POST', '/api/doctor', { terminal: true }, TERMINAL_MS));
  const { cost } = await api('POST', '/api/doctor', { terminal: true, live: true, tag: f.tag }); // tbd checks the tag, answers the cost
  if (!f.yes) throw usage(`--live costs usage: ${plain(cost)}; add --yes to run it`, help('doctor')[0]);
  console.log(`cost: ${plain(cost)}`);
  return lines(await api('POST', '/api/doctor', { terminal: true, live: true, tag: f.tag, yes: true }, LIVE_MS));
}

const CMDS = {
  async list(args, f) {
    if (args.length) throw usage(`list takes no arguments, got "${args[0]}"`, `${BIN} grep "${args[0]}"`);
    if (f.flows && f.reminders) throw usage('--flows and --reminders cannot be combined', help('list')[0]);
    if (f.flows && f.project) throw usage('flows have no project; list them with --flows --status <state>', help('list')[0]);
    const flowSt = f.flows ? statusFilter(f.status, FLOW_STATES, FLOW_CLOSED) : null;
    const st = f.flows ? null : statusFilter(f.status), pr = projectIs(f.project);
    const s = await state();
    const flows = s.flows.map(x => ({ ...x, waiting: waitOf(x.waiting) }));
    if (f.flows) {
      return listOut('flows', flows.filter(x => flowSt(x.state)), f, `${BIN} new "<text>" -f <kind> -t <tag>`, FLOW_ROW);
    }
    const out = listOut('tasks', withPos(s.reminders).filter(t => st(t.status) && pr(t)), f, `${BIN} add "<title>" --status <s>`);
    const open = flows.filter(x => !FLOW_CLOSED.includes(x.state));
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
    out.push(next ? `next up: ${next.id} · ${plain(next.title)}` : `next up: nothing in now; ${BIN} list --status next`);
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
    return [`promoted: ${t.id} → ${k.id} · ${k.state} · ${k.kind} · ${k.tag} · ${plain(k.title)}`];
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
    // D-0104: --ident / --push-remote alone are merged into the stored tag (a def replaces it whole)
    const keys = await tagKeys(f), merge = !Object.keys(def).length && Object.keys(keys).length > 0;
    if (merge) {
      const { tags } = await api('GET', '/api/tags');
      if (!Object.hasOwn(tags, args[0])) throw fail(`no tag ${args[0]}`, `${BIN} tag list`);
      Object.assign(def, tags[args[0]]);
    }
    Object.assign(def, keys);
    for (const [k, v] of Object.entries(keys)) if (v === null) delete def[k]; // --db none
    await api('POST', '/api/tags', { name: args[0], def });
    return [[`${merge ? 'updated' : 'added'}: tag ${args[0]}`, def.type, def.path && tilde(def.path), def.ident && `ident ${plain(def.ident.name)} <${plain(def.ident.email)}>`,
      def.push && `push ${plain(def.push.remote)}`, def.qa_ports && `qa ports ${def.qa_ports.join(',')}`, def.db && `db ${def.db}`,
      def.skills_off?.length && `skills off ${plain(def.skills_off.join(','))}`].filter(Boolean).join(' · ')];
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
    if (f.terminal || f.live || f.yes) return terminalCheck(f);
    if (f.version && !f.pin) throw usage('--version needs --pin', help('doctor')[0]);
    if (!f.tag && (f.ident || ['push-remote', 'qa-ports', 'db'].some(k => f[k] !== undefined))) throw usage('--ident, --push-remote, --qa-ports and --db need --tag', help('doctor')[0]);
    const r = await api('POST', '/api/doctor', { tag: f.tag, pin: f.pin, version: f.version, ...await tagKeys(f) }, f.tag ? 3_600_000 : 120_000); // tag checks run the tag's commands
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
  async logs(args, f) {
    if (args.length !== 1) throw usage('logs needs one flow id or title', help('logs')[0]);
    const t = await flowOf(args[0]);
    // --plain (board-terminal-parity Phase 3): the activity feed (GET …/activity), its steps merged by time as the page
    // does (steps first on a tie); the follow reads go on from its cursor
    const read = f.plain ? q => api('GET', `/api/tickets/${t.id}/activity?${q}`) : q => api('GET', `/api/tickets/${t.id}/log?${q}`);
    let last = null; // --plain: a row without a time shows the last one
    const show = f.plain ? x => `  ${clock(last = x?.at ?? last)}  ${plain(x?.text)}` : l => `  ${plain(l)}`; // lines from the port: escapes out even if it is not tbd's
    const ms = x => Date.parse(x?.at) || 0;
    let r = await read(f.plain ? 'limit=200' : 'tail=200');
    const rows = f.plain ? [...(r.steps ?? []), ...r.lines].sort((a, b) => ms(a) - ms(b)) : r.lines;
    const head = `log: ${t.id} run ${r.run} · ${rows.length} lines${r.ended ? ' · run ended' : ''}`;
    const out = [head, ...rows.map(show)];
    if (!f.follow || r.ended) return out;
    console.log(out.join('\n'));
    while (!r.ended) { // ends with the run (its log packed), on ctrl-c, or on an error (exit 1)
      await new Promise(ok => setTimeout(ok, FOLLOW_MS));
      r = await read(`run=${r.run}&after=${f.plain ? r.cursor : r.offset}`);
      if (r.lines.length) console.log(r.lines.map(show).join('\n'));
    }
    return [`log: run ${r.run} ended`, `help: ${BIN} show ${t.id}`];
  },
  resume: (args, f) => control('resume', args, f.phase ? { phase: f.phase } : {}),
  restart: args => control('restart', args),
  cancel: args => control('cancel', args),
  async assign(args) {
    if (args.length !== 1) throw usage('assign needs one flow id or title', help('assign')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/assign`, undefined, ASSIGN_TIMEOUT_MS);
    return [`assign: ok · ${k.id} · ${k.state} · ${plain(k.title)}`, ...(k.worktree ? [`worktree: ${cell(k.worktree)} · base_sha ${cell(k.base_sha)}`] : []),
      `help: ${BIN} logs ${k.id} -f to follow planning`];
  },
  // U8: no --file and no --plan-now → the open questions, exit 1. The file is read here (the CLI's own machine), sent as
  // the answers map; tbd checks it (unknown question, bad shape, a pick not among the options: 400, exit 1).
  async answer(args, f) {
    if (!args.length) throw usage('answer needs one flow id or title', help('answer')[0]);
    const text = args.slice(1).join(' ').trim();
    // the words after the ref are the answer: the ref must then be the flow's id, never title words
    if (text && !/^t_[a-z0-9]{6}$/.test(args[0])) throw usage(`answer with text needs the flow id first: ${BIN} answer t_xxxxxx "<text>"`, help('answer')[0]);
    const work = [text && '"<text>"', f.replan && '--replan', f['allow-change'] !== undefined && '--allow-change', f['deny-change'] !== undefined && '--deny-change'].filter(Boolean);
    if (work.length && (f.file || f['plan-now'])) throw usage(`${work[0]} answers a question from working; --file and --plan-now answer planning questions`, help('answer')[0]);
    if (work.length > 1) throw usage(`give one of "<text>", --replan, --allow-change, --deny-change (got ${work.join(', ')})`, help('answer')[0]);
    const t = await flowOf(args[0]);
    const { round: r, ticket: cur, ask } = await api('GET', `/api/tickets/${t.id}`);
    const working = cur.state === 'clarify' && cur.clarify_origin?.phase === 'working' && cur.kind !== 'task'; // a Task's asks are planning-style (Phase 4)
    if (working && (f.file || f['plan-now'])) throw usage(`${t.id} asks a question from working; --file and --plan-now answer planning questions. Answer with "<text>", --replan, --allow-change or --deny-change`, help('answer')[0]);
    if (!f.file && !f['plan-now']) {
      if (working) return workAnswer(t, f, text, work.length > 0, ask);
      // Phase 5: an ask's round names its phase (review, qa, final_gate); a planning round names none
      const from = r?.phase ? r.phase.replace('_', ' ') : 'planning';
      if (work.length) throw usage(`${work[0]} answers a question from working; ${t.id} has ${cur.state === 'clarify' ? `${from} questions` : `none (state ${cur.state})`}`, help('answer')[0]);
      if (r?.kind !== 'questions' || t.state !== 'clarify') throw fail(`${t.id} has no open questions (state ${t.state})`);
      const rows = r.questions.map(x => ({ ...x, options: x.options.join(' | ') })); // cell() strips terminal escapes (agent text)
      const topics = [...new Set(rows.map(x => x.topic ?? ''))];
      rows.sort((a, b) => topics.indexOf(a.topic ?? '') - topics.indexOf(b.topic ?? '')); // group by topic, first appearance (stable)
      throw new Exit(1, [`error: answer every question with --file, or --plan-now${r.phase ? ` (the ${from} session decides what you leave open)` : ''}`, ...table('questions', rows, topics.length > 1 || topics[0] ? ['topic', 'id', 'question', 'options', 'recommended'] : ['id', 'question', 'options', 'recommended']),
        `help: ${BIN} answer ${t.id} --file answers.json   ({"<id>": {"pick": "<option>"} | {"text": "..."} | {"use": "recommended"} | {"use": "you_decide"}})`]);
    }
    let answers = {};
    if (f.file) {
      const text = readText(f.file, ANSWERS_MAX);
      try { answers = JSON.parse(text); } catch { throw fail(`${f.file} is not valid JSON`); }
    }
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/answer`, { answers, plan_now: !!f['plan-now'] });
    return [`answer: ok · ${k.id} · ${k.state} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow ${k.state === 'planning' ? 'the next planning round' : 'the same session'}`]; // Phase 5: review / qa / final asks resume
  },
  // K3: one flag of --allow / --deny; tbd checks the open ask (a deps allow builds first: long timeout)
  async scope(args, f) {
    if (args.length !== 1) throw usage('scope needs one flow id or title', help('scope')[0]);
    if (!f.allow === !f.deny) throw usage('scope needs one of --allow or --deny', help('scope')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/scope`, { allow: !!f.allow, ...(f.task !== undefined && { task: f.task }) }, SCOPE_TIMEOUT_MS);
    return [`scope: ${f.allow ? 'allowed' : 'denied'} · ${k.id} · ${k.state} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow the session`];
  },
  // K1: --feedback-file is read here (the CLI's own machine); tbd only ever gets the text.
  async rework(args, f) {
    if (args.length !== 1) throw usage('rework needs one flow id or title', help('rework')[0]);
    if ((f.feedback === undefined) === (f['feedback-file'] === undefined)) throw usage('rework needs one of --feedback "<text>" or --feedback-file <path>', help('rework')[0]);
    const feedback = f['feedback-file'] === undefined ? f.feedback : readText(f['feedback-file'], FEEDBACK_MAX);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/rework`, { feedback });
    return [`rework: ok · ${k.id} · ${k.state} · rework ${k.rework} · ${plain(k.title)}`, `help: ${BIN} show ${k.id}`];
  },
  async pass(args, f) {
    if (args.length !== 1) throw usage('pass needs one flow id or title', help('pass')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/pass`, f.sha === undefined ? {} : { sha: f.sha });
    const w = k.waiting?.reason === 'children' ? ` · waiting ${waitOf(k.waiting)}` : '';
    return [`pass: ok · ${k.id} · ${k.state}${w} · ${plain(k.title)}`, ...(k.pr?.sha ? [`merged: ${k.pr.sha} · ${k.pr.merged_at}`] : [])];
  },
  // M5 C14: tbd answers 202 once the push is recorded running; the outcome is the ticket's push.state (exit 1: failed,
  // or still running after PUSH_WAIT_MS)
  async push(args, f) {
    if (args.length !== 1) throw usage('push needs one flow id or title', help('push')[0]);
    const t = await flowOf(args[0]);
    const r = await api('POST', `/api/tickets/${t.id}/push`, f.close ? { close: true } : undefined);
    // Phase 4: a Task's Commit and Push goes to its own session (no squash push to wait for)
    if (r?.task) return [`push: sent · ${t.id} · commit ${Array.isArray(r.files) ? r.files.length : '?'} files to ${plain(r.branch)}, push to ${plain(r.remote)} · the same session does it`];
    for (const end = Date.now() + PUSH_WAIT_MS; Date.now() < end;) {
      await new Promise(ok => setTimeout(ok, PUSH_POLL_MS));
      const k = (await api('GET', `/api/tickets/${t.id}`)).ticket, p = k.push;
      // --close: tbd closes before it records the push ok (lib/push.js), so the state read here is the close's outcome
      const closed = f.close ? [k.state === 'done' ? 'closed' : `not closed: ${BIN} close ${t.id} says why`] : [];
      if (p?.state === 'ok') return [[`push: ok · ${t.id} · ${plain(String(p.sha).slice(0, 12))} → ${plain(p.remote)} ${plain(String(p.ref).replace(/^refs\/heads\//, ''))}`, ...closed].join(' · ')];
      if (p?.state !== 'running') throw fail(`push failed · ${t.id} · ${cell(p?.why ?? 'no push recorded')}`, `${BIN} show ${t.id}`);
    }
    throw fail(`push still running after ${PUSH_WAIT_MS / 1000} s · ${t.id}`, `${BIN} show ${t.id} for the outcome`);
  },
  // M5 C13: final gate (waiting close) → done; refusals (not squashed, children open) are tbd's 409 text, exit 1
  async close(args) {
    if (args.length !== 1) throw usage('close needs one flow id or title', help('close')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/close`, {});
    return [`close: ok · ${k.id} · ${k.state} · ${plain(k.title)}`, ...(k.final?.sha ? [`squash: ${k.final.sha}`] : [])];
  },
  async lavish(args) {
    if (args.length !== 1) throw usage('lavish needs one flow id or title', help('lavish')[0]);
    const t = await flowOf(args[0]);
    const { url } = await api('POST', `/api/tickets/${t.id}/lavish`, {});
    return [`lavish: ok · ${t.id} · ${cell(url)}`];
  },
  async gates(args, f) {
    if (args.length !== 1) throw usage('gates needs one flow id or title', help('gates')[0]);
    const t = await flowOf(args[0]);
    const q = new URLSearchParams(Object.entries({ n: f.n, limit: f.limit }).filter(([, v]) => v !== undefined));
    const r = await api('GET', `/api/tickets/${t.id}/gates${q.size ? `?${q}` : ''}`);
    if (!r.items.length) return [`gates: ${t.id} · none yet`];
    const rows = r.items.map(g => ({ ...g, task: g.task ?? '-', result: g.unreadable ? 'unreadable' : g.ok ? 'green' : `red ${g.class ?? ''}`.trim(),
      checks: (g.checks ?? []).map(c => `${c.check} ${c.ok ? 'ok' : 'red'}`).join(' ') }));
    const top = r.items[0];
    const out = [`gates: ${t.id} · ${rows.length} shown`, ...table('gates', rows, ['n', 'gate', 'task', 'attempt', 'result', 'ms', 'checks']),
      `gate ${top.n}:`, ...table('checks', top.checks ?? [], ['check', 'ok', 'exit', 'ms', 'flaky', 'timed_out', 'log'])];
    if (top.tests?.failfirst && top.tests.failfirst !== 'n/a') out.push(`  failfirst: ${cell(top.tests.failfirst)}`);
    if (top.why) out.push(`  why: ${cell(top.why)}`);
    if (top.ask) out.push(`  ask: ${cell(`${top.ask.kind}: ${[...(top.ask.files ?? []), ...(top.ask.changes ?? [])].join(', ')}`)}`);
    if (r.next !== null) out.push(`help: ${BIN} gates ${t.id} --n ${r.next} for older ones`);
    return out;
  },
  async report(args, f) {
    if (args.length !== 1) throw usage('report needs one flow id or title', help('report')[0]);
    if (f.kind === undefined) throw usage(`report needs --kind ${REPORT_KINDS.join(', ')}`, help('report')[0]);
    if (f.kind === 'rec' ? f.n !== undefined : f.run !== undefined || f.cursor !== undefined || (f.kind === 'summary' && f.n !== undefined)) {
      throw usage('--n goes with --kind review, qa, final or verdict, --run and --cursor with --kind rec', help('report')[0]);
    }
    const t = await flowOf(args[0]);
    const q = new URLSearchParams(Object.entries({ kind: f.kind, n: f.n, run: f.run, cursor: f.cursor }).filter(([, v]) => v !== undefined));
    const r = await api('GET', `/api/tickets/${t.id}/report?${q}`);
    const text = s => plain(s).split(/\r?\n|\r/).map(l => `  ${l}`); // agent text, a line at a time (a bare \r would overwrite one)
    if (f.kind === 'summary') return [`summary: ${t.id}`, ...text(r.text.trimEnd())];
    if (f.kind === 'verdict') return [`verdict: ${t.id} · final ${r.n} · ${plain(r.path)}`, ...text(r.text.trimEnd())];
    if (f.kind === 'final') {
      const rows = r.findings.map(x => ({ ...x, scenario: x.failure_scenario, status: x.blocking ? 'open' : 'need review' }));
      return [`report: ${t.id} · final ${r.n} · ${r.verdict} · tested ${plain(String(r.tested_sha ?? '').slice(0, 12))} · ${plain(r.at)}`,
        `  verdict_doc: ${cell(r.verdict_doc)}`, `  verification_doc: ${cell(r.verification_doc)}`,
        ...table('findings', rows, ['id', 'severity', 'confidence', 'where', 'problem', 'scenario', 'fix', 'status']), ...(r.truncated ? ['  (cut to fit: more findings in the file)'] : []),
        `help: ${BIN} report ${t.id} --kind summary | --kind verdict`];
    }
    if (f.kind === 'qa') {
      const rows = r.cases.map(c => ({ ...c, recs: c.recs?.join(' ') }));
      const list = (name, xs) => [`${name}[${xs.length}]:${xs.length ? '' : ' none'}`, ...xs.map(x => `  ${cell(x)}`)];
      return [`report: ${t.id} · qa ${r.n} · ${r.verdict} · head ${plain(String(r.head ?? '').slice(0, 12))} · ${plain(r.at)}`, `  file: ${cell(r.report)}`,
        ...table('cases', rows, ['id', 'type', 'kind', 'result', 'cause', 'evidence', 'source', 'recs']),
        ...list('need_review', r.need_review), ...list('findings', r.findings),
        ...(r.truncated ? ['  (cut to fit: more cases in the file)'] : [])];
    }
    if (f.kind === 'rec') {
      const lines = s => plain(s).split(/\r?\n|\r/).map(l => `    ${l}`); // a bare \r would overwrite the line on screen
      return [`recs: ${t.id} · run ${r.run} · ${r.items.length} shown${r.runs.length > 1 ? ` · runs ${r.runs.join(', ')}` : ''}`,
        ...r.items.flatMap(x => [`rec ${plain(x.n)} · ${x.status ?? `no answer: ${plain(x.error)}`} · ${x.ms} ms · ${plain(x.at)}${x.truncated ? ' · cut' : ''}`,
          ...lines(`$ ${x.curl}`), ...(x.status == null ? [] : lines([`HTTP ${x.status}`, ...x.headers.map(([k, v]) => `${k}: ${v}`), '', x.body].join('\n')))]),
        ...(r.next !== null ? [`help: ${BIN} report ${t.id} --kind rec --run ${r.run} --cursor ${r.next} for more`] : [])];
    }
    const rows = r.findings.map(x => ({ ...x, scenario: x.failure_scenario, status: x.blocking ? 'open' : 'need review' }));
    return [`report: ${t.id} · review ${r.n} · ${r.verdict}${r.fixes === undefined ? '' : ` · fix ${r.fixes}/${r.fix_max}`} · head ${plain(String(r.head ?? '').slice(0, 12))} · ${plain(r.at)}`,
      ...table('findings', rows, ['id', 'severity', 'confidence', 'where', 'problem', 'scenario', 'fix', 'status']),
      ...table('closed', r.closed, ['id', 'how']), ...(r.truncated ? [`  (cut to fit: more findings in the file)`] : [])];
  },
  async interventions(args, f) {
    if (args.length !== 1) throw usage('interventions needs one flow id or title', help('interventions')[0]);
    const t = await flowOf(args[0]);
    const q = new URLSearchParams(Object.entries({ limit: f.limit, after: f.cursor }).filter(([, v]) => v !== undefined));
    const r = await api('GET', `/api/tickets/${t.id}/interventions${q.size ? `?${q}` : ''}`);
    return [...table('interventions', r.items, ['at', 'actor', 'verb', 'task']), ...(r.next !== null ? [`help: ${BIN} interventions ${t.id} --cursor ${r.next}`] : [])];
  },
  approve: args => control('approve', args),
  // full-access-runs Phase 8: tb config [set <key> <json> | skills add|rm <name>]: tbd checks every value (the store's
  // validators); a nested key sends its whole top object, built from the live config (ponytail: read then write, last
  // write wins, as the page's Settings view)
  async config(args) {
    const [sub, ...rest] = args;
    if (sub !== undefined && sub !== 'set' && sub !== 'skills') throw usage(`config takes set or skills, got "${sub}"`, help('config')[0]);
    const { config: c } = await api('GET', '/api/config');
    if (sub === undefined) return configOut(c);
    if (sub === 'skills') {
      const [op, name, more] = rest;
      if (!['add', 'rm'].includes(op) || !name || more !== undefined) throw usage('config skills needs add or rm and one skill name', help('config')[0]);
      if (!/^[\w-][\w.-]*$/.test(name)) throw usage(`"${name}" is not a plain skill name`, help('config')[0]);
      const cur = c.skills?.defaults ?? [];
      if (cur.includes(name) === (op === 'add')) return [`config: noop (${name} is ${op === 'add' ? 'already' : 'not'} a board default skill)`];
      const defaults = op === 'add' ? [...cur, name] : cur.filter(n => n !== name);
      await api('POST', '/api/config', { skills: { ...c.skills, defaults } });
      return [`config: skills.defaults ${op === 'add' ? 'added' : 'removed'} ${name} · ${defaults.length} skills`];
    }
    if (rest.length !== 2) throw usage('config set needs a dotted key and a JSON value', help('config')[0]);
    const [key, raw] = rest;
    let v;
    try { v = JSON.parse(raw); } catch { throw usage(`config set: ${raw} is not JSON (a string needs quotes, e.g. '"high"')`, help('config')[0]); }
    const [top, ...sub2] = key.split('.');
    if (top === 'claude_bin') throw usage('claude_bin is changed by tb doctor --pin only', `${BIN} doctor --pin`);
    if (!Object.hasOwn(c, top) || !key.split('.').every(k => /^[a-z][a-z0-9_]*$/.test(k))) throw usage(`config set: no Settings key ${key}`, `${BIN} config lists them`);
    let whole = v;
    if (sub2.length) { // the whole top object, the one leaf changed (an inner object must exist)
      whole = structuredClone(c[top]);
      let o = whole;
      for (const k of sub2.slice(0, -1)) {
        if (!isObj(o) || !Object.hasOwn(o, k)) throw usage(`config set: no Settings key ${key}`, `${BIN} config lists them`);
        o = o[k];
      }
      if (!isObj(o)) throw usage(`config set: no Settings key ${key}`, `${BIN} config lists them`);
      o[sub2.at(-1)] = v;
    }
    await api('POST', '/api/config', { [top]: whole });
    return [`config: set ${key} = ${JSON.stringify(v)}`];
  },
  async 'set-sandbox'(args) {
    if (args.length !== 2 || !['on', 'off'].includes(args[1])) throw usage('set-sandbox needs a flow id or title and on or off', help('set-sandbox')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/sandbox`, { on: args[1] === 'on' });
    return [`sandbox: ${k.sandbox ? 'on' : 'off'} · ${k.id} · ${k.state} · ${plain(k.title)}`];
  },
  // full-access-runs Phase 9: the note text goes to tbd as JSON (its prompt file), never into a shell
  async note(args) {
    if (args.length < 2 || !/^t_[a-z0-9]{6}$/.test(args[0])) throw usage(`note needs the flow id, then the text: ${BIN} note t_xxxxxx "<text>"`, help('note')[0]);
    const t = await flowOf(args[0]);
    const r = await api('POST', `/api/tickets/${t.id}/note`, { text: args.slice(1).join(' ') });
    return [`note: ${r.live ? 'sent · the live run stops and its session goes on with it' : r.resumed ? 'sent · the same session goes on with it' : 'queued · the next run of the flow starts with it'} · ${t.id} · ${plain(t.title)}`];
  },
  // the resume line only once the old run is dead (never two writers of one session): the worktree through shq(), the
  // session only when it is a uuid (UUID_RE)
  async hold(args) {
    if (args.length !== 1) throw usage('hold needs one flow id or title', help('hold')[0]);
    const t = await flowOf(args[0]);
    await api('POST', `/api/tickets/${t.id}/hold`);
    let k;
    for (const end = Date.now() + HOLD_WAIT_MS; ;) {
      k = (await api('GET', `/api/tickets/${t.id}`)).ticket;
      if (k.lease?.exit === 'held' && !k.lease.pending) break;
      if (Date.now() >= end) throw fail(`hold: ${t.id} is still stopping after ${HOLD_WAIT_MS / 1000} s`, `${BIN} show ${t.id} until its run line says "ended held"; the resume line is then on the board page (Activity)`);
      await new Promise(ok => setTimeout(ok, PUSH_POLL_MS / 4));
    }
    const s = k.lease.session, line = UUID_RE.test(s ?? '') && typeof k.worktree === 'string' ? `cd ${shq(k.worktree)} && claude --resume ${s}` : null;
    return [`hold: held · ${t.id} · ${k.state} · ${plain(k.title)}`,
      ...(line ? ['in your terminal (this exact line: tbd cannot see claude -c):', `  ${line}`] : []),
      `help: /exit that claude session, then ${BIN} handback ${t.id}`];
  },
  handback: args => control('handback', args),
  // Phase 2 task 4: an Approve card's answer; Allow and retry of a blocked action (the ids go into the URL encoded)
  async 'approve-action'(args) {
    if (args.length !== 3 || !/^t_[a-z0-9]{6}$/.test(args[0]) || !['yes', 'no'].includes(args[2])) throw usage('approve-action needs the flow id, the approval id and yes or no', help('approve-action')[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${args[0]}/approvals/${encodeURIComponent(args[1])}`, { yes: args[2] === 'yes' });
    return [`approve-action: ${args[2]} · ${k.id} · ${plain(args[1])} · ${plain(k.title)}`];
  },
  async 'allow-blocked'(args, f) {
    if (args.length !== 2 || !/^t_[a-z0-9]{6}$/.test(args[0])) throw usage('allow-blocked needs the flow id and the blocked action id', help('allow-blocked')[0]);
    if (f.dismiss) {
      await api('POST', `/api/tickets/${args[0]}/blocked/${encodeURIComponent(args[1])}/dismiss`);
      return [`allow-blocked: dismissed · ${args[0]} · ${plain(args[1])}`];
    }
    const r = await api('POST', `/api/tickets/${args[0]}/blocked/${encodeURIComponent(args[1])}/allow`);
    return [`allow-blocked: allowed once · ${args[0]} · ${plain(args[1])} · ${r.live ? 'the live run stops and its session retries it' : 'the next run of the flow starts with it'}`];
  },
  async reject(args, f) {
    if (args.length < 2) throw usage('reject needs a flow id or title and a comment', help('reject')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/reject`, { comment: args.slice(1).join(' '), ask: !!f.ask });
    return [`reject: ok · ${k.id} · ${k.state}${k.must_ask ? ' · must_ask' : ''} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow the next planning round`];
  },
  // M7: the §12 targets as tbd sends them (GET /api/health renders the same list the UI does: parity by construction)
  async health(args, f) {
    if (args.length) throw usage(`health takes no arguments, got "${args[0]}"`, help('health')[0]);
    if (f.drills ? f.days !== undefined : f.limit !== undefined || f.cursor !== undefined) throw usage('--days is for the targets; --limit and --cursor go with --drills', help('health')[0]);
    if (f.drills) {
      const q = new URLSearchParams(Object.entries({ limit: f.limit, before: f.cursor }).filter(([, v]) => v !== undefined));
      const r = await api('GET', `/api/drills${q.size ? `?${q}` : ''}`);
      return [...table('drills', r.items, ['at', 'name', 'ok', 'note']), ...(r.next ? [`help: ${BIN} health --drills${f.limit ? ` --limit ${f.limit}` : ''} --cursor ${plain(r.next)}`] : [])];
    }
    const h = await api('GET', `/api/health${f.days ? `?days=${f.days}` : ''}`);
    const pct = v => `${Math.round(v * 100)}%`;
    const rows = h.targets.map(t => ({
      key: t.key, target: t.label, x: t.unit ? `${t.x} ${t.unit}` : t.x, y: t.unit ? `${t.y} ${t.unit}` : t.y, pct: t.unit || !t.y ? '-' : pct(t.x / t.y),
      goal: t.threshold == null ? t.op : `${t.op} ${t.unit ? `${t.threshold} ${t.unit}` : pct(t.threshold)}`, result: t.ok === true ? 'PASS' : t.ok === false ? 'FAIL' : 'n/a',
      note: [t.pending && `pending ${t.pending}`, t.no_data && `no data ${t.no_data}`, t.base_at !== undefined && `base ${t.base_at ?? 'none'}`, t.note].filter(Boolean).join(' · '),
    }));
    const met = h.targets.filter(t => t.ok === true).length, goals = h.targets.filter(t => t.op !== 'watch').length;
    const d = h.doctor;
    return [`health: ${met} of ${goals} targets met · last ${h.window_days} days (${plain(h.from)} → ${plain(h.to)})${h.cut ? ' · older lines cut (8 MB read cap)' : ''}`,
      ...table('targets', rows, ['key', 'target', 'x', 'y', 'pct', 'goal', 'result', 'note']),
      !d ? `doctor: never run · help: ${BIN} doctor` : `doctor: ${d.ok ? 'ok' : `FAIL (${plain(d.checks.filter(c => !c.ok).map(c => c.name).join(', '))})`} · ${plain(d.at)}`];
  },
  'eval fake'() {
    const code = path.join(__dirname, '..');
    // client: not daemon request path
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(code, 'test', '*.test.js')], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
    return [];
  },
  async 'eval chaos'(args, f) {
    const [name, ref, extra] = args;
    if (!DRILLS.includes(name) || extra !== undefined) throw usage(`eval chaos needs one drill of ${DRILLS.join(', ')} and at most one id`, help('eval chaos')[0]);
    if (f.min !== undefined && !['freeze', 'disk', 'memory'].includes(name)) throw usage('--min is for freeze, disk and memory', help('eval chaos')[0]);
    if (Number(f.min) > 10 && name !== 'freeze') throw usage(`--min for ${name} must be 1 to 10`, help('eval chaos')[0]);
    if (f['max-gb'] !== undefined && name !== 'disk') throw usage('--max-gb is for disk', help('eval chaos')[0]);
    if (f.after && name !== 'reboot') throw usage('--after is for reboot', help('eval chaos')[0]);
    if (f.after && !ref) throw usage('reboot --after needs the id the reboot steps printed', `${BIN} eval chaos reboot <id> --after`);
    let k, since, note = '', gen = 0, failed = null;
    if (f.after) {
      k = (await api('GET', `/api/tickets/${(await flowOf(ref)).id}`)).ticket;
      since = Date.now();
    } else {
      k = await liveRun(ref);
      const steps = GUIDE[name]?.steps.map((l, i) => `  ${i + 1}. ${l.replaceAll('{bin}', BIN).replaceAll('{id}', k.id)}`);
      if (name === 'reboot') return [`drill: reboot · ${k.id} · run ${k.lease.gen} live`, 'steps:', ...steps];
      if (steps) console.log([`drill: ${name} · ${k.id} · run ${k.lease.gen} live`, 'steps:', ...steps].join('\n'));
      const a = steps ? '' : await ACT[name](k, f); // a note, or (disk, memory) {note, gen: the run it hit, failed: why}
      ({ note, gen = 0, failed = null } = typeof a === 'string' ? { note: a } : a);
      since = Date.now() + (GUIDE[name]?.ms ?? 0);
    }
    const r = failed ? { ok: false, note: failed } : await healthy(k.id, since, ['kill-claude', 'restart'].includes(name) ? k.lease.gen : gen);
    const d = { name, ok: r.ok, note: plain(`${note}${r.note}`).slice(0, 200) };
    let lost = null;
    await api('POST', '/api/drills', d).catch(e => { lost = e.lines?.[0] ?? e.message; });
    if (!d.ok || lost) process.exitCode = 1;
    return [`drill: ${name}`, `ok: ${d.ok}`, `note: ${cell(d.note)}`, ...(lost ? [`warn: drill not recorded (${lost})`] : [])];
  },
  // M7 (spec §12 golden): the eval harnesses, one at a time (RAM), evidence + scores in ~/.taskboard/evals. --real: each case
  // against its base (golden.jsonl, read here), a worse one run once more (that run counts, rerun: true), then recorded:
  // tbd's verdict is the one printed.
  async 'eval golden'(args, f) {
    if (args.length) throw usage(`eval golden takes no arguments, got "${args[0]}"`, help('eval golden')[0]);
    if ([f.dry, f.real, f.record !== undefined].filter(Boolean).length !== 1) throw usage('eval golden needs one of --dry, --real or --record <file>', help('eval golden')[0]);
    if (f.yes && !f.real) throw usage('--yes goes with --real', help('eval golden')[0]);
    if (f.record !== undefined) {
      if (f.only !== undefined) throw usage('--only goes with --dry or --real', help('eval golden')[0]);
      let score;
      try { score = JSON.parse(readText(f.record, EVAL_MAX)); } catch (e) { if (e instanceof Exit) throw e; }
      if (!isObj(score)) throw fail(`${f.record} is not a golden score JSON v1 object`);
      if (score.run_id !== undefined) return post(score); // its own run_id (tbd checks it is a uuid): a repeat is a 409
      const runId = crypto.randomUUID();
      console.log(`run_id: ${runId} (made here: ${f.record} has none)`);
      return post({ ...score, run_id: runId });
    }
    const sources = Object.keys(HARNESS).filter(s => !f.only || f.only.split(',').includes(s));
    const date = today();
    const cols = ['source', 'exit', 'evidence'];
    if (f.dry) {
      const rows = await harnesses(sources, 'dry', claudeBin(), date);
      const bad = rows.filter(r => r.exit !== 0).length;
      if (bad) process.exitCode = 1;
      return [...table('evals', rows, cols), `dry: ${bad ? `FAIL (${bad} of ${rows.length} exit non-zero)` : `PASS (${rows.length} of ${rows.length} exit 0)`}`];
    }
    const [typ, worst] = [0, 1].map(i => sources.reduce((s, x) => s + HARNESS[x].cost[i], 0) / 1e6);
    const cost = `~$${typ} typical, ~$${worst} worst for ${sources.join(', ')} (subscription usage; a rerun adds its harness's share)`;
    if (!f.yes) throw usage(`--real costs usage: ${cost}; add --yes to run it`, help('eval golden')[0]);
    console.log(`cost: ${cost}`);
    const live = (await state()).system?.runs ?? 0;
    if (live > 0) throw fail(`refused: tbd has ${live} live run(s); real evals wait for an idle board (RAM)`, `${BIN} list --flows`);
    const bin = claudeBin();
    if (!bin) throw fail('config.json has no claude_bin', `${BIN} doctor --pin`);
    const rows = await harnesses(sources, 'real', bin, date);
    const out = [], scores = [];
    for (const r of rows) {
      const s = readJson(r.json);
      const why = s ? golden.checkScore(s) : 'no score file';
      if (why) out.push(`warn: ${r.source}: score not used: ${why}`);
      else {
        scores.push(s);
        r.ids = s.cases.map(c => c.id);
      }
    }
    if (!scores.length) throw new Exit(1, [...table('evals', rows, cols), ...out, 'error: no harness wrote a score; nothing recorded']);
    const cases = scores.flatMap(s => s.cases);
    const score = { v: 1, kind: 'golden-score', at: new Date().toISOString(), commit: scores[0].commit, sandbox_base: scores[0].sandbox_base, mode: 'real',
      sources: [...new Set(scores.flatMap(s => s.sources))], cases, pass: passOf(cases) };
    const runId = crypto.randomUUID();
    const base = golden.baseOf(goldenLines(), cases.map(c => c.id));
    const worse = new Set(golden.goldenVerdict(base, golden.lineOf(score, runId)).worse.map(w => w.id));
    const fixed = new Set(); // worse cases whose rerun exited 0
    for (const id of worse) { // once each: the rerun's result is the one recorded, also when it is lower
      const [source, key] = id.split(':'); // checkScore: <harness>:<1-16 letters, digits or ->
      const r = await harness(source, 'real', bin, date, key);
      rows.push({ ...r, source: `${source} rerun ${key}`, rerun: true });
      const s = readJson(r.json);
      const again = s && !golden.checkScore(s) ? s.cases.find(c => c.id === id) : null;
      if (again) score.cases = score.cases.map(c => (c.id === id ? { ...again, rerun: true } : c));
      if (again && r.exit === 0) fixed.add(id);
      else if (!again) out.push(`warn: the rerun of ${id} wrote no score: its first run counts`);
    }
    score.pass = passOf(score.cases);
    // D-0177: a failed harness run is covered (the RERUN counts, m7-build) when it wrote a score, each of its worse cases ran
    // once more with exit 0 and is worse no more, and every other case of it passed. Not covered (a crash, no results, a
    // failure that is not worse) → exit 1; so is a worse verdict (recorded()).
    const still = new Set(golden.goldenVerdict(base, golden.lineOf(score, runId)).worse.map(w => w.id));
    const now = new Map(score.cases.map(c => [c.id, c]));
    const covered = r => !!r.ids?.some(id => worse.has(id)) && r.ids.every(id => (worse.has(id) ? fixed.has(id) && !still.has(id) : passOf([now.get(id)])));
    if (rows.some(r => r.exit !== 0 && !r.rerun && !covered(r))) process.exitCode = 1;
    const body = { ...score, run_id: runId };
    const file = keep(body, date);
    try {
      return [...table('evals', rows, cols), ...out, `score: ${tilde(file)}`, ...await post(body, file)];
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      throw new Exit(e.code, [...table('evals', rows, cols), ...out, ...e.lines]); // the evidence paths stay on screen
    }
  },
};

// ---- chaos drills (P3d T9 T10) -----------------------------------------------
// Every ps, signal and launchctl call goes through sys: tests swap it in a preload (contract T4), so npm test never
// signals a foreign pid or runs launchctl.
const sys = {
  kill: (pid, sig) => void process.kill(pid, sig),
  exec: (file, args) => sh(file, args, { timeout: 10_000 }),
  // M7: tb eval golden's harnesses → exit code. Output on this terminal; its own process group, so past ms SIGINT (it
  // cancels its run and cleans up), then grace later SIGKILL to its whole group (the harness + its dev tbd). ctrl-c or a
  // closed terminal reaches tb only: passed on as SIGINT, then tb exits 130 once the harness is gone.
  // TMPDIR /tmp: golden-working refuses the macOS default (/var/folders/...: tsx's gate socket path > 103 bytes)
  run: (file, args, ms, grace = 60_000) => new Promise(ok => {
    const c = spawn(file, args, { stdio: 'inherit', detached: true, env: { ...process.env, TMPDIR: '/tmp' } });
    const group = sig => { try { sys.kill(-c.pid, sig); } catch { /* gone */ } };
    let quit = false, hard;
    const end = () => { group('SIGINT'); hard ??= setTimeout(() => group('SIGKILL'), grace); }; // SIGKILL once, grace after the first SIGINT
    const stop = () => { quit = true; end(); };
    const soft = setTimeout(end, ms);
    process.on('SIGINT', stop).on('SIGTERM', stop).on('SIGHUP', stop);
    const done = code => {
      clearTimeout(soft);
      clearTimeout(hard);
      process.off('SIGINT', stop).off('SIGTERM', stop).off('SIGHUP', stop);
      if (quit) process.exit(130);
      ok(code);
    };
    c.on('error', () => done(1));
    c.on('close', code => done(code ?? 1));
  }),
  // M7 memory drill: a child in its own group → {pid, done: Promise<{code, out: its last 4 KB of output}>}
  spawn: (file, args) => {
    const c = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = d => { out = (out + d).slice(-4096); };
    c.stdout.on('data', add);
    c.stderr.on('data', add);
    return { pid: c.pid, done: new Promise(ok => { c.on('error', e => ok({ code: null, out: e.message })); c.on('close', code => ok({ code, out })); }) };
  },
  // M7 disk drill: the volume's space and the fill file
  statfs: p => fs.promises.statfs(p),
  open: (file, flags, mode) => fs.promises.open(file, flags, mode),
  unlink: file => fs.promises.unlink(file),
  sleep: ms => new Promise(ok => setTimeout(ok, ms)),
};
const GUIDE = { // drills you do by hand; ms: how long until the watch may call the run healthy
  wifi: { ms: 5 * MIN, steps: ['Turn Wi-Fi off now.', 'Turn it back on after 5 minutes.', 'Keep this window open: it watches the run until it is healthy.'] },
  lid: { ms: 10 * MIN, steps: ['Close the lid now.', 'Open it after 10 minutes and log in.', 'Keep this window open: it watches the run once the Mac is awake.'] },
  reboot: { steps: ['Restart the Mac now (Apple menu > Restart) while the run is live.', 'Log in again.', 'Run: {bin} eval chaos reboot {id} --after'] },
};

// A run live now: pid known, no exit, not ended, no recovery pending, the ticket waits on nothing (runbook: never drill
// a ticket with no live run; a pid still alive past its run's end is an orphan, not the run). whyNot: what it is instead.
const isLive = k => !!k?.lease && Number.isInteger(k.lease.pid) && !k.lease.exit && !k.lease.ended_at && !k.lease.pending && !k.waiting;
const whyNot = k => k?.waiting?.reason ?? k?.lease?.exit ?? (k?.lease?.pending ? 'recovering' : k?.lease ? 'run ended' : 'no run yet');

// The run a drill acts on: that flow's, else the one live run.
async function liveRun(ref) {
  const rows = ref ? [await flowOf(ref)] : (await state()).flows.filter(x => AGENT.includes(x.state));
  // ponytail: one GET per flow in an agent phase, in parallel; few (at most max_concurrent run)
  const all = (await Promise.all(rows.map(x => api('GET', `/api/tickets/${x.id}`)))).map(r => r.ticket);
  const live = all.filter(isLive);
  if (live.length === 1) return live[0];
  if (!live.length) throw fail(ref ? `no live run on ${rows[0].id}: ${plain(whyNot(all[0]))}` : 'no live run to drill', `${BIN} list --flows`);
  throw usage(`${live.length} live runs: name one`, `${BIN} eval chaos <drill> <id>  (live: ${live.map(k => k.id).join(', ')})`);
}

// T10: a pid that came from tbd gets a signal only once ps here shows it is what tbd says it is. Anything else (a
// reused pid, a wrong tbd.pid or ticket.json) is refused before any signal.
async function checked(pid, isIt, what) {
  const r = Number.isInteger(pid) && pid > 1 ? await sys.exec('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)]) : { err: true, stdout: '' };
  const args = r.err ? '' : r.stdout.trim();
  if (!isIt(args)) throw fail(`refused: pid ${pid} is not ${what} (ps: ${plain(args).slice(0, 120) || 'no such process'}); no signal sent`);
  return pid;
}
const tbdPid = () => checked(Number(fs.readFileSync(path.join(HOME, 'tbd.pid'), 'utf8')), a => TBD_RE.test(a), 'tbd'); // client: not daemon request path
// The run's claude: config claude_bin (read here, not from tbd) with the lease's session. group: its pgid, which a
// run leads (spawned detached), for the drills that hit the run's whole process group.
function leader(k, group = false) {
  const bin = conf().claude_bin;
  const { pid, pgid, session } = k.lease;
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) throw fail('config.json has no claude_bin', `${BIN} doctor --pin`);
  const isIt = a => UUID_RE.test(session) && a.includes(bin) && (a.includes(` --session-id ${session}`) || a.includes(` --resume ${session}`))
    && (!group || pgid === pid);
  return checked(pid, isIt, `${k.id}'s ${bin} run${group ? ' leading its own group' : ''}`);
}
const kick = async () => ((await sys.exec('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`])).err ? 'kickstart failed; ' : '');
const freeOf = async () => { const s = await sys.statfs(os.homedir()); return s.bavail * s.bsize; }; // the volume tbd's monitor reads
const gb = b => (b / GB).toFixed(1);
const ticketOf = id => api('GET', `/api/tickets/${id}`).then(r => r.ticket, () => null); // tbd down or restarting: null, asked again
// The text f gained after byte at (its last 64 KB at most; tbd.log under launchd), '' when unreadable
function gained(f, at) {
  try {
    const fd = fs.openSync(f, 'r'); // client: not daemon request path
    try {
      const end = fs.fstatSync(fd).size, from = Math.max(at, end - 64 * 1024), b = Buffer.alloc(Math.max(0, end - from));
      fs.readSync(fd, b, 0, b.length, from);
      return b.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } }; // client: not daemon request path

// Every target is checked before the first signal goes out.
const ACT = {
  async 'kill-tbd'() {
    sys.kill(await tbdPid(), 'SIGKILL');
    return kick();
  },
  async 'kill-claude'(k) {
    sys.kill(await leader(k), 'SIGKILL');
    return '';
  },
  async restart(k) { // reboot / app restart: tbd and the whole run gone at once
    const [t, g] = [await tbdPid(), await leader(k, true)];
    sys.kill(t, 'SIGKILL');
    sys.kill(-g, 'SIGKILL');
    return kick();
  },
  async freeze(k, f) { // lid closed: everything stopped, the clock runs on
    const min = Number(f.min ?? 10);
    const pids = [await tbdPid(), -(await leader(k, true))];
    const thaw = () => pids.forEach(p => { try { sys.kill(p, 'SIGCONT'); } catch { /* gone */ } });
    const quit = () => { thaw(); process.exit(130); }; // ctrl-c or a closed terminal never leaves tbd stopped
    process.once('SIGINT', quit).once('SIGTERM', quit).once('SIGHUP', quit);
    try {
      for (const p of pids) sys.kill(p, 'SIGSTOP');
      await new Promise(ok => setTimeout(ok, min * MIN));
    } finally {
      process.off('SIGINT', quit).off('SIGTERM', quit).off('SIGHUP', quit);
      thaw();
    }
    return `frozen ${min} min; `;
  },
  // M7 disk (spec §7, MAJOR fix 3): fill to 1 GB under stop_gb → tbd stops new runs + alerts → the run's claude killed →
  // for --min the recovery waits on disk and no run starts → fd closed (the space back) → healthy (the caller)
  async disk(k, f) {
    const stop = Number(conf().disk?.stop_gb ?? 8), cap = Number(f['max-gb'] ?? 20) * GB, min = Number(f.min ?? 3);
    const free = await freeOf(), target = (stop - 1) * GB, fill = free - target;
    if (free < stop * GB) throw fail(`refused: ${gb(free)} GB free is under disk.stop_gb ${stop} GB already; nothing written`);
    if (fill > cap) throw fail(`refused: filling to ${stop - 1} GB free takes ${gb(fill)} GB, over --max-gb ${cap / GB}; nothing written`, `size it from df -g ~: --max-gb <avail − ${stop - 1} + 2> (40 at most)`);
    if (target < 6 * GB) throw fail(`refused: ${stop - 1} GB free (disk.stop_gb − 1) is under 6 GB, too close to swap on this Mac; nothing written`);
    await leader(k); // the run's claude, checked before anything is written (killed after the fill)
    const log = path.join(HOME, 'tbd.log'), logAt = sizeOf(log); // the alert must come after this
    const file = path.join(HOME, `chaos-fill-${process.pid}.bin`);
    const h = await sys.open(file, 'wx', 0o600);
    await sys.unlink(file); // at once: only the fd holds the space, so any exit (kill -9 too) gives it back
    const quit = () => void h.close().finally(() => process.exit(130)); // ctrl-c or a closed terminal never leaves the disk full
    process.once('SIGINT', quit).once('SIGTERM', quit).once('SIGHUP', quit);
    let written = 0;
    try {
      console.log(`drill: disk · ${k.id} · run ${k.lease.gen} live · filling ${gb(Math.min(fill, cap))} GB to ${stop - 1} GB free`);
      const buf = Buffer.alloc(8 * 1024 * 1024); // one zero chunk, reused
      for (let left = Math.min(fill, cap), part = 0; left > 0;) {
        const n = Math.min(buf.length, left);
        await h.write(buf, 0, n);
        written += n;
        left -= n;
        part += n;
        if (part >= GB && left > 0) { // macOS may give space back (local snapshots purged): never past --max-gb
          part = 0;
          left = Math.min(cap - written, (await freeOf()) - target);
        }
      }
      const note = `filled ${gb(written)} GB; `;
      let seen = false, alerted = false;
      for (let i = 0; i < 30 && !(seen && alerted); i++) { // ≤ 60 s
        if (i) await sys.sleep(2000);
        const s = (await state().catch(() => null))?.system;
        seen ||= !!s && s.disk_free < stop * GB && s.disk_warn === true;
        alerted ||= gained(log, logAt).includes('tbd: alert: Disk almost full: new runs stopped');
      }
      if (!seen || !alerted) return { note, failed: `within 60 s: ${[!seen && 'tbd did not report the disk full (system.disk_free, disk_warn)', !alerted && 'no "tbd: alert: Disk almost full: new runs stopped" in tbd.log'].filter(Boolean).join('; ')}` };
      const cur = await ticketOf(k.id); // the fill took a while: still the same live run?
      if (!isLive(cur) || cur.lease.gen !== k.lease.gen) return { note, failed: `the run ended before the kill: ${plain(whyNot(cur))}` };
      await ACT['kill-claude'](k);
      let waited = false;
      for (let i = 0; i < min * 12; i++) { // a read every 5 s
        await sys.sleep(5000);
        const t = await ticketOf(k.id), l = t?.lease;
        waited ||= t?.waiting?.reason === 'disk';
        if (l && l.gen > k.lease.gen && !l.pending && l.started_at !== k.lease.started_at) return { note, failed: `a run started on a full disk (run ${l.gen})` };
      }
      if (!waited) return { note, failed: `the recovery never waited on disk in ${min} min` };
      return { note: `${note}held ${min} min; `, gen: k.lease.gen };
    } finally {
      process.off('SIGINT', quit).off('SIGTERM', quit).off('SIGHUP', quit);
      await h.close().catch(() => {});
    }
  },
  // M7 memory (spec §7, fix 4): memory_pressure -S simulates the level (no memory taken; never real pressure, D-0021). S2:
  // it needs root here → the sudo step for Irfan. tbd must see critical and pause the run; the level must go back to 1.
  async memory(k, f) {
    const secs = Number(f.min ?? 2) * 60;
    const c = sys.spawn('/usr/bin/memory_pressure', ['-S', '-l', 'critical', '-s', String(secs)]);
    let alive = true; // its group is signalled only while it lives (a dead child's pid may lead another group by now)
    c.done.then(() => { alive = false; });
    const end = () => { if (!alive) return; alive = false; try { sys.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } };
    const quit = () => { end(); process.exit(130); };
    process.once('SIGINT', quit).once('SIGTERM', quit).once('SIGHUP', quit);
    try {
      const early = await Promise.race([c.done, sys.sleep(3000).then(() => null)]);
      const guide = !!early && /Operation not permitted/.test(early.out);
      if (early && !guide) throw fail(`memory_pressure exited ${early.code}: ${plain(early.out).trim().slice(0, 200)}`);
      if (guide) console.log([`drill: memory · ${k.id} · run ${k.lease.gen} live`, 'steps:', `  1. memory_pressure needs root on this Mac: run \`sudo memory_pressure -S -l critical -s ${secs}\` in another Terminal now.`,
        '  2. Keep this window open: it watches tbd pause the run, the level go back to normal and the run come back.'].join('\n'));
      let crit = false, paused = null;
      for (let i = 0; i < (guide ? 150 : 30) && !(crit && paused); i++) { // ≤ 60 s (by hand: 5 min)
        if (i) await sys.sleep(2000);
        crit ||= (await state().catch(() => null))?.system?.pressure === 'critical';
        const l = (await ticketOf(k.id))?.lease;
        if (l && l.gen > k.lease.gen && (l.exit === 'paused' || l.pending)) paused ??= l;
      }
      const why = !crit ? 'tbd never saw critical pressure' : !paused ? 'tbd did not pause the run' : null;
      if (!why && !guide) await Promise.race([c.done, sys.sleep((secs + 30) * 1000)]); // it ends after secs
      end();
      let level = NaN;
      for (let i = 0; i < (guide && !why ? secs / 2 + 30 : 30) && level !== 1; i++) { // ≤ 60 s (by hand: until the sudo run ends)
        if (i) await sys.sleep(2000);
        level = Number((await sys.exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).stdout.trim());
      }
      const note = `memory_pressure ${guide ? 'by hand (sudo)' : 'here'} ${secs} s; `;
      if (level !== 1) {
        console.log([`alert: memory pressure level stuck at ${level} after the drill`, 'recovery:',
          '  1. a memory_pressure still running: ps -ax -o pid=,args= | grep \'memory_pressure -S\', then kill <pid> (sudo kill if it runs as root)',
          '  2. wait 60 s, then: sysctl -n kern.memorystatus_vm_pressure_level (1 = normal)', `  3. still not 1: tell Irfan: pressure level stuck at ${level}`].join('\n'));
        return { note, failed: `pressure level stuck at ${level} after the drill` };
      }
      if (why) return { note, failed: `${why} within ${guide ? 5 : 1} min` };
      return { note: `${note}paused run ${paused.gen}; `, gen: paused.gen };
    } finally {
      process.off('SIGINT', quit).off('SIGTERM', quit).off('SIGHUP', quit);
      end();
    }
  },
};

// Watches the ticket through tbd (down, starting or stopped meanwhile: asked again) until its run is healthy after
// `since`: ended result, or running with events after since (and after its own start); gen: a run newer than that
// gen (the drill killed that one). Blocked or DRILL_MS → failed.
async function healthy(id, since, gen) {
  const start = Date.now();
  const secs = () => `${Math.round((Date.now() - start) / 1000)}s`;
  for (;;) {
    const k = await api('GET', `/api/tickets/${id}`).then(r => r.ticket, () => null);
    const l = k?.lease;
    if (k?.state === 'blocked') return { ok: false, note: `blocked after ${secs()}: ${l?.error ?? l?.exit ?? 'see tb show'}` };
    const events = l && !l.exit && Date.parse(l.last_event_at) > Math.max(since, Date.parse(l.started_at));
    if (l && l.gen > gen && (l.exit === 'result' || events)) return { ok: true, note: `healthy after ${secs()}: run ${l.gen} ${l.exit ?? 'running'}` };
    if (Date.now() - Math.max(start, since) > DRILL_MS) return { ok: false, note: `not healthy after ${secs()}: run ${l?.gen ?? '?'} ${l?.exit ?? (l ? 'silent' : 'tbd not answering')}` };
    await new Promise(ok => setTimeout(ok, FOLLOW_MS));
  }
}

// ---- eval golden (M7) -----------------------------------------------------------------------------------------------
// The harnesses, in run order: args per mode; set: the cases a mode runs (golden: B and C once, as the R box base; else
// the harness default); one: the flag that runs a single case (a rerun); prompt: the phase prompt it is pinned to (fix
// 7); cost: [typical, worst] integer micro-USD (r-build cost table + the last real eval runs: planner $3.73, review $2.04,
// qa $3.16). --real: the harness test tbds' RAM gate relieved (D-0126, D-0141, D-0174: golden --no-docker-reserve,
// eval-phase --no-ram-wait; eval-planner has no such flag); the live tbd's gate is never touched.
const HARNESS = {
  golden: { script: 'golden-working.js', prompt: 'working', dry: ['--dry', '--runs', '1', '--stop', 'close'], real: ['--real', '--runs', '1', '--stop', 'close', '--no-docker-reserve'],
    set: { dry: 'B,C,C-empty', real: 'B,C' }, one: '--only', cost: [6_000_000, 16_000_000] },
  planner: { script: 'eval-planner.js', prompt: 'planning', dry: ['--fake'], real: [], one: '--cases', cost: [4_000_000, 8_000_000] }, // real = its default
  review: { script: 'eval-phase.js', prompt: 'review', dry: ['--fake', '--phase', 'review'], real: ['--real', '--phase', 'review', '--no-ram-wait'], one: '--cases', cost: [2_000_000, 3_000_000] },
  qa: { script: 'eval-phase.js', prompt: 'qa', dry: ['--fake', '--phase', 'qa'], real: ['--real', '--phase', 'qa', '--no-ram-wait'], one: '--cases', cost: [3_000_000, 6_000_000] },
  final_gate: { script: 'eval-phase.js', prompt: 'final_gate', dry: ['--fake', '--phase', 'final_gate'], real: ['--real', '--phase', 'final_gate', '--no-ram-wait'], one: '--cases', cost: [2_000_000, 4_000_000] },
};
const conf = () => JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); // client: not daemon request path
// config claude_bin (an absolute path), else null. Every harness gets it: their default pin path can vanish after a claude self-update.
const claudeBin = () => { try { const b = conf().claude_bin; return typeof b === 'string' && path.isAbsolute(b) ? b : null; } catch { return null; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }; // client: not daemon request path
const passOf = cases => cases.length > 0 && cases.every(c => c.checks.pass === c.checks.total && !c.contaminated && (!c.blind || c.blind.pass)); // harness scoreJson's rule
// TB_HOME/evals/golden.jsonl (small, never rotated): every recorded t:golden line, oldest first; a torn line is skipped
function goldenLines() {
  let text = '';
  try { text = fs.readFileSync(path.join(EVALS, 'golden.jsonl'), 'utf8'); } catch { /* none recorded yet */ } // client: not daemon request path
  return text.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// One harness run (one = a single case: a rerun). → {source, exit, evidence, json: the score file (real)}
async function harness(source, mode, bin, date, one = null) {
  const h = HARNESS[source];
  const base = path.join(EVALS, `${date}-${source}${one ? `-rerun-${one}` : ''}${mode === 'dry' ? '-dry' : ''}`);
  const json = mode === 'real' ? `${base}.json` : null;
  if (json) fs.rmSync(json, { force: true }); // an older run's score is never read as this one's
  const set = one ?? h.set?.[mode];
  const args = [path.join(CODE, 'scripts', h.script), ...h[mode], ...(set ? [h.one, set] : []), '--prompt', path.join(CODE, 'phases', 'code', h.prompt, 'prompt.md'),
    ...(bin ? ['--claude', bin] : []), ...(json ? ['--json', json] : []), '--out', `${base}.md`];
  return { source, exit: await sys.run(process.execPath, args, HARNESS_MS[mode]), evidence: tilde(`${base}.md`), json };
}
async function harnesses(sources, mode, bin, date) {
  fs.mkdirSync(EVALS, { recursive: true, mode: 0o700 }); // client: not daemon request path
  const rows = [];
  for (const s of sources) rows.push(await harness(s, mode, bin, date)); // one at a time: RAM
  return rows;
}

// The score as it is posted, kept first in TB_HOME/evals (0600, never overwritten: -2, -3, ...): the retry when the post fails
function keep(body, date) {
  for (let n = 1; ; n++) {
    const f = path.join(EVALS, `${date}-golden-score${n > 1 ? `-${n}` : ''}.json`);
    try {
      fs.writeFileSync(f, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); // client: not daemon request path
      return f;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// POST /api/evals → recorded() lines. Its run_id there already (409) → already recorded; any other failure (tbd down, a
// timeout, an error answer) names the kept file to post again
async function post(body, file = null) {
  try {
    return recorded(await api('POST', '/api/evals', body));
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (/** @type {any} */ (e).status === 409) throw new Exit(1, [`error: already recorded: run_id ${plain(body.run_id)}`]);
    throw new Exit(1, [...e.lines, ...(file ? [`help: ${BIN} eval golden --record ${file}`] : [])]);
  }
}

// tbd's answer to POST /api/evals (its verdict is the one that counts) as lines; exit 1 when it is worse
function recorded({ line: l, base_at: base, verdict: v }) {
  if (v.ok === false) process.exitCode = 1;
  return [`recorded: ${plain(l.run_id)} · ${l.cases.length} cases · score ${l.pass ? 'pass' : 'fail'}`,
    `verdict: ${v.ok === null ? 'baseline (nothing to compare yet)' : v.ok ? 'PASS' : 'FAIL'} · ${v.x}/${v.y} compared not worse · base ${plain(base ?? 'none')}`,
    ...(v.worse.length ? table('worse', v.worse, ['id', 'why']) : []), ...(v.changed.length ? [`changed: ${plain(v.changed.join(', '))} (total moved: not compared)`] : [])];
}

// full-access-runs Phase 8 + 9: the config rows, one dotted key each (shq: lib/util.js, as the page's)
const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (isObj(v) ? flat(v, `${pre}${k}.`) : [{ key: `${pre}${k}`, value: Array.isArray(v) ? v.join(',') : k === 'claude_bin' ? tilde(String(v)) : v }]));
const configOut = c => [...table('config', flat(c), ['key', 'value']), `help: ${BIN} config set <key> <json>, e.g. ${BIN} config set models.review.effort '"high"'`];

async function flowOf(ref) {
  return find((await state()).flows.map(flowRow), ref);
}

// M5 C12 C14 (D-0104): the tag keys `tag add` / `doctor --tag` set. --ident = Irfan's own git ident, read here in his shell
// from his global git config (never the tag repo's: agents work in it; tbd's git reads no config); tbd checks both keys.
async function tagKeys(f) {
  const keys = {};
  if (f['push-remote'] !== undefined) keys.push = { remote: f['push-remote'] };
  if (f['qa-ports'] !== undefined) keys.qa_ports = f['qa-ports'].split(',').map(Number);
  if (f['skills-off'] !== undefined) keys.skills_off = f['skills-off'].split(',').filter(Boolean); // full-access-runs Phase 4
  if (f.db !== undefined) keys.db = f.db === 'local' ? 'local' : null; // none: drop the key
  if (f.ident) {
    const get = async k => (await sh('/usr/bin/git', ['config', '--global', '--get', k], { cwd: os.homedir(), timeout: 5000 })).stdout.trim();
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    const miss = [['user.name', name], ['user.email', email]].find(([, v]) => !v)?.[0];
    if (miss) throw usage(`--ident: git ${miss} is not set`, `git config --global ${miss} "<your ${miss.slice(5)}>"`);
    keys.ident = { name, email };
  }
  return keys;
}

// M12: a question from working. No answer given → the ask (agent text through cell(): escapes out), exit 1.
async function workAnswer(t, f, text, given, ask) {
  if (!given) {
    const items = [...(ask?.files ?? []).map(x => ({ kind: 'file', item: x })), ...(ask?.changes ?? []).map(x => ({ kind: 'change', item: x }))];
    const how = ['scope', 'protected', 'deps'].includes(ask?.kind) ? 'scope' : ask?.kind === 'policy' ? 'policy' : 'other';
    throw new Exit(1, [`error: ${t.id} asks (${cell(ask?.kind ?? '?')}${ask?.task ? `, task ${cell(ask.task)}` : ''}): answer it`,
      `reason: ${cell(ask?.question || ask?.reason || '')}`, ...(ask?.notes ? [`notes: ${cell(ask.notes)}`] : []), ...(items.length ? table('items', items, ['kind', 'item']) : []),
      `help: ${WORK_HELP[how].replaceAll('tb ', `${BIN} `).replaceAll('{id}', t.id)}`]);
  }
  const [route, body] = f['allow-change'] !== undefined ? ['allow-change', { change: f['allow-change'] }] : f['deny-change'] !== undefined ? ['deny-change', { change: f['deny-change'] }]
    : f.replan ? ['answer', { replan: true }] : ['answer', { text }];
  const { ticket: k } = await api('POST', `/api/tickets/${t.id}/${route}`, body);
  return [`answer: ok · ${k.id} · ${k.state} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow it`];
}

// Run control: tbd answers 202 once it took the request (refusals: 409, exit 1); the outcome comes later (tb show).
async function control(op, args, body = undefined) {
  if (args.length !== 1) throw usage(`${op} needs one flow id or title`, help(op)[0]);
  const t = await flowOf(args[0]);
  await api('POST', `/api/tickets/${t.id}/${op}`, body);
  return [`${op}: accepted · ${t.id} · ${t.state} · ${plain(t.title)}`, `help: ${BIN} show ${t.id} for the outcome, ${BIN} logs ${t.id} -f to follow the run`];
}

// Detail view of one flow: truncated text, --full for all of it.
async function flowDetail(id, f) {
  // ponytail: one GET /api/tags per show for the tag's ident + push key (C20 parity with the drawer's facts)
  const [{ ticket: k, fix_max, lanes }, { tags }] = await Promise.all([api('GET', `/api/tickets/${id}`), api('GET', '/api/tags')]);
  const d = k.tag && Object.hasOwn(tags, k.tag) ? tags[k.tag] : null;
  // the drawer's Push + Ident facts, same text (ui/app.js pushText, identText, noIdent)
  const p = k.push;
  k.push = p ? [p.state, `${p.remote ?? ''} ${String(p.ref ?? k.branch ?? '').replace(/^refs\/heads\//, '')}`.trim(), String(p.sha ?? '').slice(0, 12), p.why].filter(Boolean).join(' · ') : null;
  k.ident = d?.ident ? `${d.ident.name} <${d.ident.email}>` : d?.push ? `not set: run ${BIN} doctor --tag ${k.tag} --ident` : null;
  if (k.fixes > 0) k.fix = `${k.fixes}/${fix_max}`;
  k.qa = k.qa?.verdict ? `${k.qa.verdict} · pass ${k.qa.pass} · fail ${k.qa.fail} · blocked ${k.qa.blocked} · qa ${k.qa.n}` : null;
  // M5.3 C20: the final gate (tested_sha from its start; verdict + n with a pass; sha once squashed)
  const s12 = v => (v ? String(v).slice(0, 12) : null);
  k.final = k.final ? [k.final.verdict, k.final.n && `final ${k.final.n}`, s12(k.final.sha) && `squash ${s12(k.final.sha)}`, s12(k.final.tested_sha) && `tested ${s12(k.final.tested_sha)}`].filter(Boolean).join(' · ') || null : null;
  if (k.waiting?.reason === 'close') k.waiting = `waits for close: ${BIN} close, ${BIN} push or ${BIN} rework`;
  if (LANE_WAIT[k.waiting?.reason]) k.waiting = LANE_WAIT[k.waiting.reason];
  const text = k.text || '';
  const fields = ['id', 'title', 'kind', 'tag', 'state', 'waiting', 'rework', 'fix', 'qa', 'final', 'push', 'ident', 'fix_of', 'promoted_from', 'blocked_by', 'created_at', 'updated_at']
    .filter(x => k[x] != null && !(Array.isArray(k[x]) && !k[x].length));
  // the reason, then every other key (why, blocker, error, ...): a Blocked ticket keeps its fix steps (no info lost vs the old JSON)
  const waitFull = w => [waitOf(w), ...Object.entries(w).filter(([key]) => !['reason', 'done', 'total'].includes(key))
    .map(([key, v]) => `${key}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)].join(' · ');
  const show = x => (x === 'waiting' && k.waiting?.reason ? waitFull(k.waiting) : x === 'blocked_by' && Array.isArray(k.blocked_by) ? k.blocked_by.join(', ') : typeof k[x] === 'object' ? JSON.stringify(k[x]) : k[x]);
  const out = ['flow:', ...fields.map(x => `  ${x}: ${cell(show(x))}`)];
  const l = k.lease;
  if (l) out.push(`  run: ${cell(`${l.log ?? 'none'} · ${l.pending ? `recovering (${l.pending.after})` : l.exit ? `ended ${l.exit}` : 'live'}`)}`);
  if (l?.error) out.push(`  run_error: ${cell(l.error)}`); // R17: e.g. the agent-planted file to remove
  if (lanes?.length) out.push(...table('lanes', lanes.map(x => ({ ...x, waiting: waitOf(x.waiting), live: x.live ? 'yes' : 'no' })), ['task', 'id', 'state', 'waiting', 'live', 'attempt']));
  // Phase 4: a Task's result (the Waits-for-you card): summary, done-when, commit message, what Commit and Push would send
  const tr = k.kind === 'task' && k.task_result && typeof k.task_result === 'object' ? k.task_result : null;
  if (Number.isInteger(k.task?.base?.dirty)) out.push(`  uncommitted_at_start: ${k.task.base.dirty}`);
  if (tr) {
    const p2 = tr.push_to;
    out.push(`  result: ${cell(tr.summary ?? '')}`, `  done_when_met: ${tr.done_when_met ? 'yes' : 'no'}`, `  commit_message: ${cell(tr.commit_message ?? '')}`,
      p2 ? `  push_to: ${cell(`${p2.branch} → ${p2.remote}${p2.new_branch ? ' (new branch)' : ''}${p2.ahead > 0 ? ` · ${p2.ahead} commits already on it` : ''}`)}` : `  push_to: none · ${cell(tr.push_why ?? '')}`);
    if (p2) out.push(`  files: ${cell((p2.files ?? []).join(', '))}`, ...(p2.left?.length ? [`  left_uncommitted: ${cell(p2.left.join(', '))}`] : []));
  }
  if (f.full) { // review M2: the page's Needs Your OK cards (approve-action, allow-blocked take these ids)
    const objs = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
    const asks = objs(k.approvals).filter(a => a.status === 'pending').map(a => ({ ...a, input: a.too_long ? 'too long: only no' : a.hidden ? `only no (a carriage return, long blank run or tall input can hide part of it): ${a.input_text}` : a.input_text, reason: a.reason ?? '' }));
    const blocks = objs(k.blocked_actions).filter(b => b.status === 'open').map(b => ({ ...b, input: b.input_text, rule: b.rule && resumes(k, b) ? b.rule : 'dismiss only' }));
    if (asks.length) out.push(...table('approvals', asks, ['id', 'tool', 'input', 'reason']));
    if (blocks.length) out.push(...table('blocked', blocks, ['id', 'tool', 'input', 'rule']));
  }
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
    else if ((SHORT_OF[key] ?? SHORT)[a]) k = (SHORT_OF[key] ?? SHORT)[a];
    else { args.push(a); continue; }
    if (!FLAGS[key].includes(k)) {
      throw usage(`unknown flag ${a.startsWith('--') ? '--' + k : a} for \`${key}\``,
        FLAGS[key].length ? `valid flags: ${FLAGS[key].map(x => '--' + x).join(', ')}` : `\`${key}\` takes no flags`);
    }
    if (BOOL.includes(k) && !VALUE_OF[key]?.includes(k)) { f[k] = true; continue; }
    if (v === undefined) {
      v = rest[++i];
      if (v === undefined) throw usage(`--${k} needs a value`, help(key)[0]);
    }
    // list/grep --status also takes "all" and comma lists; statusFilter checks those.
    const check = CHECK_OF[key]?.[k] ?? CHECK[k];
    const ok = check && !(k === 'status' && (key === 'list' || key === 'grep')) ? check(v) : true;
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
  if (process.env.TBX_RUN && MUTATING.includes(cmd)) throw new Exit(2, ['error: tb runs inside a board run: the board decides, not the agent']);
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

module.exports = { main, sys };
