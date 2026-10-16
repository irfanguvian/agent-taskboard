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
const { STATUSES, ROW, plain, cell, table, addPos, bySection, withPos, posOf, line, warnings } = require('./toon');
const { KINDS, STATES: FLOW_STATES, AGENT } = require('./fsm');
const { isDate, TBD_RE } = require('./store');
const { NAME_RE } = require('./tags');
const { DRILLS } = require('./metrics');
const sh = require('./sh');

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
    '  [--env-files a,b] [--context a,b] [--skills a,b] [--checks \'{"lint":"npm run lint"}\'] [--heavy \'["npm ci"]\'] [--leak-check] [--ident] [--push-remote <remote>]',
    'name is hierarchical (a/b); --type and --path go together (git needs --base); a name alone makes a group; flow tags need a leaf with a path',
    '--ident: your git user.name + user.email (git config --global) author the squash; --push-remote: the git remote tb push sends to (https only)',
    'the flags replace the whole tag, except --ident / --push-remote alone: those are merged into the existing tag',
    'examples:', '  {bin} tag add acme/api --type git --path ~/code/acme-api --base main', '  {bin} tag add acme/api --ident --push-remote origin'],
  'tag list': ['usage: {bin} tag list', 'example:', '  {bin} tag list'],
  'notify-test': ['usage: {bin} notify-test', 'sends the "Do now" notification right away'],
  'eval fake': ['usage: {bin} eval fake', 'runs the fake-claude test suite of this checkout (no tbd needed)'],
  'eval chaos': ['usage: {bin} eval chaos kill-tbd|kill-claude|restart|freeze|wifi|lid|reboot [<id>] [--min 10] [--after]',
    'acts on the one live run (or <id>), watches it until healthy (running again with events, or ended result) or blocked (15 min max), records a t:drill line; exit 1 = drill failed',
    'kill-tbd: kill -9 tbd + launchctl kickstart (TB_LABEL, default local.taskboard); kill-claude: SIGKILL the run\'s claude; restart: both + the run\'s whole group',
    'freeze: SIGSTOP tbd + the run\'s group, SIGCONT after --min (default 10) = lid closed; wifi, lid, reboot: prints the steps for you, then watches (reboot: run again with --after once logged in)',
    'restart and freeze hit claude\'s own group only: its Bash calls run in groups of their own, so restart leaves them alive (like a crash) and freeze leaves them running; tbd kills them at run end when it saw them',
    'every pid is checked with ps first (tbd.js, or config claude_bin + the run\'s session); anything else is refused, no signal', 'examples:',
    '  {bin} eval chaos kill-claude', '  {bin} eval chaos freeze t_k3x9qa --min 10', '  {bin} eval chaos reboot t_k3x9qa --after'],
  doctor: ['usage: {bin} doctor [--tag <name> [--ident] [--push-remote <remote>]] [--pin [--version 2.1.292]]',
    'checks the Claude login (subscription, not an API key), the pinned claude copy, Fable billing and node; exit 1 when any check fails',
    '--tag: also that tag\'s repo, its .claude settings and its check commands (can take minutes)',
    '--ident / --push-remote: merged into the tag first, like tag add (a push remote needs your ident: assign refuses without it)',
    '--pin: copy ~/.local/share/claude/versions/<version> to ~/.taskboard/bin/claude-<version> and use it', 'examples:',
    '  {bin} doctor', '  {bin} doctor --tag acme/api', '  {bin} doctor --tag acme/api --ident', '  {bin} doctor --pin'],
  gc: ['usage: {bin} gc [--limit 20] [--after <id>]    or    {bin} gc --delete <id>...',
    'lists worktrees of done / cancelled / missing tickets, run logs older than 30 days and cache entries, with sizes',
    '--delete: removes only the ids given (checked against a fresh list); exit 1 when one is refused', 'example:', '  {bin} gc --delete worktree/t_k3x9qa'],
  logs: ['usage: {bin} logs <id|title words> [-f]', 'the last 200 lines of the flow\'s current or last run log; -f/--follow: then new lines as they come, until the run ends',
    'examples:', '  {bin} logs t_k3x9qa', '  {bin} logs t_k3x9qa -f'],
  resume: ['usage: {bin} resume <id|title words> [--phase planning|working|review|qa]',
    'resumes the ended run (same session); from blocked: the phase it blocked in, or --phase an earlier one; refused while the run is live',
    'answers once tbd took it (the run may still wait for memory or the network): see {bin} show <id>', 'example:', '  {bin} resume t_k3x9qa'],
  restart: ['usage: {bin} restart <id|title words>', 'a fresh session in the same phase (from blocked: where it blocked); a live run is stopped first',
    'example:', '  {bin} restart t_k3x9qa'],
  assign: ['usage: {bin} assign <id|title words>',
    'backlog → planning: the tag must pass doctor (repo, base, .claude settings; no check commands) and every blocker be merged (code) or done',
    'a git tag gets a detached worktree at its base commit (~/.taskboard/worktrees/<id>), where planning reads the code', 'example:', '  {bin} assign t_k3x9qa'],
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
  push: ['usage: {bin} push <id|title words>',
    'sends the flow\'s squash (final gate passed: waiting close, or done) to its tag\'s push remote as branch tb/<id>-<slug>: leak scan first, then git push with a lease; waits for the outcome (up to 150 s)',
    'the tag needs a push remote (https only) and your git ident: {bin} tag add <tag> --push-remote <r> --ident', 'example:', '  {bin} push t_k3x9qa'],
  close: ['usage: {bin} close <id|title words>',
    'final gate passed (waiting close: the squash is made) → done, once every child ticket is done or cancelled; never pushes ({bin} push does); the worktree stays until {bin} gc',
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
  open: ['usage: {bin} open [--print]', 'unlocks the board UI in your default browser with a one-time link (single use, 60 s)',
    '--print: print the link instead of opening it', 'example:', '  {bin} open'],
};
const FLAGS = {
  list: ['status', 'project', 'limit', 'flows', 'reminders'], grep: ['status', 'project', 'limit'], get: ['full'], show: ['full'],
  add: ['project', 'tag', 'status', 'due', 'note', 'pos'],
  new: ['project', 'tag', 'status', 'due', 'note', 'pos', 'flow', 'title', 'fix-of'],
  set: ['title', 'project', 'tag', 'status', 'due', 'note', 'pos'], move: ['pos'], done: [], rm: [], promote: ['flow', 'tag'],
  'tag add': ['type', 'path', 'base', 'setup', 'output', 'env-files', 'context', 'skills', 'checks', 'heavy', 'leak-check', 'ident', 'push-remote'],
  'tag list': [], 'notify-test': [], 'eval fake': [], 'eval chaos': ['min', 'after'], open: ['print'],
  doctor: ['tag', 'pin', 'version', 'ident', 'push-remote'], gc: ['delete', 'limit', 'after'],
  logs: ['follow'], resume: ['phase'], restart: [], cancel: [], assign: [], answer: ['file', 'plan-now', 'replan', 'allow-change', 'deny-change'], approve: [], reject: ['ask'],
  scope: ['allow', 'deny', 'task'], rework: ['feedback', 'feedback-file'], pass: ['sha'], push: [], close: [], lavish: [], gates: ['n', 'limit'], report: ['kind', 'n', 'run', 'cursor'], interventions: ['limit', 'cursor'],
};
const BOOL = ['flows', 'reminders', 'full', 'leak-check', 'ident', 'print', 'pin', 'delete', 'follow', 'after', 'plan-now', 'ask', 'replan', 'allow', 'deny'];
const SHORT = { '-f': 'flow', '-t': 'tag' };
const SHORT_OF = { logs: { '-f': 'follow' } }; // -f is --flow everywhere else
const VALUE_OF = { gc: ['after'] }; // --after: a switch for eval chaos, gc's page cursor (a value)
const GROUPS = { tag: ['add', 'list'], eval: ['fake', 'chaos'] };
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
    await api('POST', '/api/tags', { name: args[0], def });
    return [[`${merge ? 'updated' : 'added'}: tag ${args[0]}`, def.type, def.path && tilde(def.path), def.ident && `ident ${plain(def.ident.name)} <${plain(def.ident.email)}>`,
      def.push && `push ${plain(def.push.remote)}`].filter(Boolean).join(' · ')];
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
    if (!f.tag && (f.ident || f['push-remote'] !== undefined)) throw usage('--ident and --push-remote need --tag', help('doctor')[0]);
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
    const read = q => api('GET', `/api/tickets/${t.id}/log?${q}`);
    let r = await read('tail=200');
    const head = `log: ${t.id} run ${r.run} · ${r.lines.length} lines${r.ended ? ' · run ended' : ''}`;
    const out = [head, ...r.lines.map(l => `  ${plain(l)}`)]; // lines from the port: escapes out even if it is not tbd's
    if (!f.follow || r.ended) return out;
    console.log(out.join('\n'));
    while (!r.ended) { // ends with the run (its log packed), on ctrl-c, or on an error (exit 1)
      await new Promise(ok => setTimeout(ok, FOLLOW_MS));
      r = await read(`run=${r.run}&after=${r.offset}`);
      if (r.lines.length) console.log(r.lines.map(l => `  ${plain(l)}`).join('\n'));
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
    const working = cur.state === 'clarify' && cur.clarify_origin?.phase === 'working';
    if (working && (f.file || f['plan-now'])) throw usage(`${t.id} asks a question from working; --file and --plan-now answer planning questions. Answer with "<text>", --replan, --allow-change or --deny-change`, help('answer')[0]);
    if (!f.file && !f['plan-now']) {
      if (working) return workAnswer(t, f, text, work.length > 0, ask);
      if (work.length) throw usage(`${work[0]} answers a question from working; ${t.id} has ${cur.state === 'clarify' ? 'planning questions' : `none (state ${cur.state})`}`, help('answer')[0]);
      if (r?.kind !== 'questions' || t.state !== 'clarify') throw fail(`${t.id} has no open questions (state ${t.state})`);
      const rows = r.questions.map(x => ({ ...x, options: x.options.join(' | ') })); // cell() strips terminal escapes (agent text)
      const topics = [...new Set(rows.map(x => x.topic ?? ''))];
      rows.sort((a, b) => topics.indexOf(a.topic ?? '') - topics.indexOf(b.topic ?? '')); // group by topic, first appearance (stable)
      throw new Exit(1, [`error: answer every question with --file, or --plan-now`, ...table('questions', rows, topics.length > 1 || topics[0] ? ['topic', 'id', 'question', 'options', 'recommended'] : ['id', 'question', 'options', 'recommended']),
        `help: ${BIN} answer ${t.id} --file answers.json   ({"<id>": {"pick": "<option>"} | {"text": "..."} | {"use": "recommended"} | {"use": "you_decide"}})`]);
    }
    let answers = {};
    if (f.file) {
      let text;
      try {
        if (fs.statSync(f.file).size > ANSWERS_MAX) throw fail(`${f.file} is over ${ANSWERS_MAX / 1024} KB`);
        text = fs.readFileSync(f.file, 'utf8'); // client: not daemon request path
      } catch (e) {
        if (e instanceof Exit) throw e;
        throw fail(`cannot read ${f.file}: ${e.code ?? e.message}`);
      }
      try { answers = JSON.parse(text); } catch { throw fail(`${f.file} is not valid JSON`); }
    }
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/answer`, { answers, plan_now: !!f['plan-now'] });
    return [`answer: ok · ${k.id} · ${k.state} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow the next planning round`];
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
    let feedback = f.feedback;
    if (f['feedback-file'] !== undefined) {
      try {
        if (fs.statSync(f['feedback-file']).size > FEEDBACK_MAX) throw fail(`${f['feedback-file']} is over ${FEEDBACK_MAX / 1024} KB`);
        feedback = fs.readFileSync(f['feedback-file'], 'utf8'); // client: not daemon request path
      } catch (e) {
        if (e instanceof Exit) throw e;
        throw fail(`cannot read ${f['feedback-file']}: ${e.code ?? e.message}`);
      }
    }
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
  async push(args) {
    if (args.length !== 1) throw usage('push needs one flow id or title', help('push')[0]);
    const t = await flowOf(args[0]);
    await api('POST', `/api/tickets/${t.id}/push`);
    for (const end = Date.now() + PUSH_WAIT_MS; Date.now() < end;) {
      await new Promise(ok => setTimeout(ok, PUSH_POLL_MS));
      const p = (await api('GET', `/api/tickets/${t.id}`)).ticket.push;
      if (p?.state === 'ok') return [`push: ok · ${t.id} · ${plain(String(p.sha).slice(0, 12))} → ${plain(p.remote)} ${plain(String(p.ref).replace(/^refs\/heads\//, ''))}`];
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
  async reject(args, f) {
    if (args.length < 2) throw usage('reject needs a flow id or title and a comment', help('reject')[0]);
    const t = await flowOf(args[0]);
    const { ticket: k } = await api('POST', `/api/tickets/${t.id}/reject`, { comment: args.slice(1).join(' '), ask: !!f.ask });
    return [`reject: ok · ${k.id} · ${k.state}${k.must_ask ? ' · must_ask' : ''} · ${plain(k.title)}`, `help: ${BIN} logs ${k.id} -f to follow the next planning round`];
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
    if (f.min !== undefined && name !== 'freeze') throw usage('--min is for freeze', help('eval chaos')[0]);
    if (f.after && name !== 'reboot') throw usage('--after is for reboot', help('eval chaos')[0]);
    if (f.after && !ref) throw usage('reboot --after needs the id the reboot steps printed', `${BIN} eval chaos reboot <id> --after`);
    let k, since, note = '';
    if (f.after) {
      k = (await api('GET', `/api/tickets/${(await flowOf(ref)).id}`)).ticket;
      since = Date.now();
    } else {
      k = await liveRun(ref);
      const steps = GUIDE[name]?.steps.map((l, i) => `  ${i + 1}. ${l.replaceAll('{bin}', BIN).replaceAll('{id}', k.id)}`);
      if (name === 'reboot') return [`drill: reboot · ${k.id} · run ${k.lease.gen} live`, 'steps:', ...steps];
      if (steps) console.log([`drill: ${name} · ${k.id} · run ${k.lease.gen} live`, 'steps:', ...steps].join('\n'));
      note = steps ? '' : await ACT[name](k, f);
      since = Date.now() + (GUIDE[name]?.ms ?? 0);
    }
    const r = await healthy(k.id, since, ['kill-claude', 'restart'].includes(name) ? k.lease.gen : 0);
    const d = { name, ok: r.ok, note: plain(`${note}${r.note}`).slice(0, 200) };
    let lost = null;
    await api('POST', '/api/drills', d).catch(e => { lost = e.lines?.[0] ?? e.message; });
    if (!d.ok || lost) process.exitCode = 1;
    return [`drill: ${name}`, `ok: ${d.ok}`, `note: ${cell(d.note)}`, ...(lost ? [`warn: drill not recorded (${lost})`] : [])];
  },
};

// ---- chaos drills (P3d T9 T10) -----------------------------------------------
// Every ps, signal and launchctl call goes through sys: tests swap it in a preload (contract T4), so npm test never
// signals a foreign pid or runs launchctl.
const sys = {
  kill: (pid, sig) => void process.kill(pid, sig),
  exec: (file, args) => sh(file, args, { timeout: 10_000 }),
};
const GUIDE = { // drills you do by hand; ms: how long until the watch may call the run healthy
  wifi: { ms: 5 * MIN, steps: ['Turn Wi-Fi off now.', 'Turn it back on after 5 minutes.', 'Keep this window open: it watches the run until it is healthy.'] },
  lid: { ms: 10 * MIN, steps: ['Close the lid now.', 'Open it after 10 minutes and log in.', 'Keep this window open: it watches the run once the Mac is awake.'] },
  reboot: { steps: ['Restart the Mac now (Apple menu > Restart) while the run is live.', 'Log in again.', 'Run: {bin} eval chaos reboot {id} --after'] },
};

// The run a drill acts on: that flow's, else the one live run (pid known, no exit).
async function liveRun(ref) {
  const rows = ref ? [await flowOf(ref)] : (await state()).flows.filter(x => AGENT.includes(x.state));
  // ponytail: one GET per flow in an agent phase, in parallel; few (at most max_concurrent run)
  const live = (await Promise.all(rows.map(x => api('GET', `/api/tickets/${x.id}`)))).map(r => r.ticket)
    .filter(k => k.lease && !k.lease.exit && Number.isInteger(k.lease.pid));
  if (live.length === 1) return live[0];
  if (!live.length) throw fail(ref ? `${rows[0].id} has no live run` : 'no live run to drill', `${BIN} list --flows`);
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
  const bin = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).claude_bin; // client: not daemon request path
  const { pid, pgid, session } = k.lease;
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) throw fail('config.json has no claude_bin', `${BIN} doctor --pin`);
  const isIt = a => UUID_RE.test(session) && a.includes(bin) && (a.includes(` --session-id ${session}`) || a.includes(` --resume ${session}`))
    && (!group || pgid === pid);
  return checked(pid, isIt, `${k.id}'s ${bin} run${group ? ' leading its own group' : ''}`);
}
const kick = async () => ((await sys.exec('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`])).err ? 'kickstart failed; ' : '');

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

async function flowOf(ref) {
  return find((await state()).flows.map(flowRow), ref);
}

// M5 C12 C14 (D-0104): the tag keys `tag add` / `doctor --tag` set. --ident = Irfan's own git ident, read here in his shell
// from his global git config (never the tag repo's: agents work in it; tbd's git reads no config); tbd checks both keys.
async function tagKeys(f) {
  const keys = {};
  if (f['push-remote'] !== undefined) keys.push = { remote: f['push-remote'] };
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

module.exports = { main, sys };
