#!/usr/bin/env node
'use strict';
// eval-planner: the planner evals E1-E3 (.omc/drafts/planner-evals.md) and golden ticket A (test/golden/sandbox-traps.md)
// against a REAL dev tbd in a throwaway TB_HOME: seed, assign, wait, collect, deterministic checks, evidence report
// (plan P4 AC1 AC9; contract J10 J11 J15-J18 U5 U8). One run at a time (RAM).
// Usage: node scripts/eval-planner.js [--cases e1,e2,e3,golden-a] [--claude <bin>] [--prompt <md>] [--fake [--fake-bad]]
//   [--keep] [--out <md>]
//   real (default): claude_bin = the pinned version (~/.local/share/claude/versions/<DEFAULT_PIN>), planning on fable
//     high (J10). tbd keeps the real HOME (claude's keychain login: spawn passes tbd's HOME on); TB_HOME is temp.
//   --fake: test/fake-claude.js with canned results (dry run, zero usage), temp HOME, the run-spy preload (passes the
//     scenario env, kills only its own runs, no launchctl or caffeinate). --fake-bad: E2's canned plan breaks 2 checks.
//   --prompt: the prompt under test (default .omc/drafts/planner-prompt.md, else phases/code/planning/prompt.md).
// Setup: $TMPDIR/tbe-*/ (realpath: sandbox rules see /private/var; short: tbd.sock < 104 bytes) holds tbhome (config,
// tags, tickets), phases (a copy of the repo's phases/ + the prompt as code/planning/prompt.md: TB_PHASES_DIR) and, fake,
// home + scn. Tickets are seeded as ticket.json in backlog before tbd starts (`tb new -f code` is refused while
// code/working is unbuilt, D9), E3 with Irfan's round-1 answers already in; then the real `tb assign` (doctor, base_sha,
// worktree) and, golden A, `tb answer --file` with the canned answers. Tag sandbox = ~/Documents/tb-sandbox: assign adds
// worktrees to its .git; cleanup removes exactly ours.
// Cleanup: tb cancel on a timed-out round, tbd SIGTERM, a run still alive whose argv names our TB_HOME SIGKILLed (its
// own group), our worktrees removed, the temp dir removed (unless --keep). Never ~/.taskboard, port 7777, launchd.
// Exit 0 = every deterministic check passed (the rubric and Irfan's score are filled in the report by hand).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { startTbd, runTb, REPO } = require('../test/helpers/tbd');
const { FAKE, RUN_SPY } = require('../test/helpers/runs');
const { dirtyPaths } = require('../lib/spawn');
const { DEFAULT_PIN, GIT_SAFE, GIT_ENV, minimalEnv } = require('../lib/util');
const { PLAN: PLAN_KEYS, SOURCE_RE, scriptsOf } = require('../lib/plan-rules');

const SANDBOX = path.join(os.homedir(), 'Documents', 'tb-sandbox');
const GOLDEN = path.join(REPO, 'test', 'golden', 'sandbox-traps.md');
const GOLDEN_ROUNDS = 4; // golden A: round 1 + at most 3 answered rounds
const ARROW = String.fromCodePoint(0x2192);
const arr = (v) => (Array.isArray(v) ? v : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', [...GIT_SAFE, '-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...minimalEnv(process.env), ...GIT_ENV } });
let aborted = false;

// ---- cases -------------------------------------------------------------------------------------------------------
// E3: Irfan answered round 1 (as lib/planning.js answer() records it: answers rows, locked decisions R1Q<n> with
// "question → value" and source answer:R1Q<n>), the round-1 questions file the handler would have kept.
const E3_QS = [
  { id: 'Q1', question: 'Query param name', why: 'The query name is API contract; Order already has a status column.', options: ['status', 'state (not status)'], recommended: 'status' },
  { id: 'Q2', question: 'Unknown state value', why: 'ListOrdersQueryDto validates with class-validator; a bad value can be refused or ignored.', options: ['400 Bad Request', 'ignore the filter'], recommended: '400 Bad Request' },
];
const E3_PICK = { Q1: 'state (not status)', Q2: '400 Bad Request' };
const E3_SEED = {
  extra: {
    round: 2,
    answers: E3_QS.map((x) => ({ id: `R1${x.id}`, question: x.question, answer: { pick: E3_PICK[x.id] } })),
    locked_decisions: E3_QS.map((x) => ({ id: `R1${x.id}`, text: `${x.question} ${ARROW} ${E3_PICK[x.id]}`, source: `answer:R1${x.id}` })),
  },
  files: {
    'rounds/01-questions.json': { kind: 'questions', round: 1, questions: E3_QS, facts: ['src/orders/orders.dto.ts: ListOrdersQueryDto takes userId and the page query'], decisions: [] },
    'facts.json': ['src/orders/orders.dto.ts: ListOrdersQueryDto takes userId and the page query'],
  },
};

const CASES = {
  e1: { title: 'E1 vague goal: questions', text: 'Make user accounts easier to manage.',
    rubric: 'questions are decisions (which operations: edit, delete, search; soft vs hard delete; who may do it; API only vs schema change), each tied to code read; none answerable from the repo; sane recommendations.' },
  e2: { title: 'E2 clear goal: plan', text: 'Add GET /orders/:id that returns one order in the same shape as the list items. 404 when it does not exist.',
    rubric: 'one or two right-sized tasks, test-first steps with real test names/paths, 404 covered by a test at an existing seam (e2e or service spec), no extra scope.' },
  e3: { title: 'E3 locked decisions kept', text: 'Let GET /orders filter by order status.', seed: E3_SEED,
    rubric: 'plan follows both decisions everywhere (DTO validation, tests, docs), no re-asking settled points.' },
  'golden-a': { title: 'Golden A vague goal (AC9)', text: null, golden: true,
    rubric: 'round 1: questions about decisions (what "better" means, API vs schema, money rule, backfill), facts from the repo, nothing invented; round 2: plan follows the canned answers.' },
};

// Golden A from the answer key (the harness may read it; planner runs never can): ticket text + canned round-2 answers.
function golden() {
  const md = fs.readFileSync(GOLDEN, 'utf8');
  const a = md.slice(md.indexOf('## Ticket A'), md.indexOf('## Ticket B'));
  const text = /Ticket text: `([^`]+)`/.exec(a)?.[1];
  const canned = /canned answers \(for example: "([^"]+)"\)/.exec(a)?.[1]?.split(', ') ?? [];
  if (!text || canned.length !== 4) throw new Error(`${GOLDEN}: Ticket A text or its 4 canned round-2 answers not found`);
  return { text, canned }; // [goal, api/schema, money, backfill]
}

// The canned answers mapped to the planner's own question ids by keyword (most specific topic first): pick the option
// that says it; else "use recommended" (a canned text sent to an off-topic question, e.g. "returning-customer discount"
// for "how many prior orders?", reads as nonsense and only makes the planner ask again: first real run, 2026-10-09).
const TOPICS = [
  { topic: 'backfill', q: /backfill|existing (orders|customers|users|data)|past orders|retroactive/i, pick: /\bno\b|skip|only new|going forward/i, i: 3 },
  { topic: 'money', q: /money|round|minor unit|\bcents?\b|amount|price|percent|currency/i, pick: /minor|integer|\bcents?\b/i, i: 2 },
  { topic: 'api/schema', q: /schema|migration|database|column|table|persist|\bstore|\bapi\b/i, pick: /api.only|no schema|without (a )?(schema|migration)|\bcompute|derived|no (new )?(column|migration)/i, i: 1 },
  { topic: 'goal', q: /better|repeat|returning|feature|goal|mean|loyal|discount|reorder|scope/i, pick: /^(?!.*\bno\b).*discount/i, i: 0 },
];
function mapAnswers(questions, canned) {
  const answers = {};
  const rows = [];
  for (const x of questions) {
    const rule = TOPICS.find((r) => r.q.test(String(x.question)));
    const opt = rule && arr(x.options).find((o) => rule.pick.test(o));
    const a = opt ? { pick: opt } : { use: 'recommended' };
    answers[x.id] = a;
    rows.push({ id: x.id, question: x.question, topic: rule?.topic ?? '(none)', canned: rule ? canned[rule.i] : '', answer: a });
  }
  return { answers, rows };
}

// ---- fake results (--fake) -----------------------------------------------------------------------------------------
// Shaped to pass phases/code/planning/result.schema.json + lib/plan-rules.js at the tb-sandbox base (paths exist, npm
// scripts in package.json, acceptance covered, no placeholder words). E3 adds one StructuredOutput deny before its result
// (the hook-denial count). bad: E2 lists no API change and no preserve criterion (checks 4 and 5 go red).
function fakeResults(bad) {
  const test = 'npm run test:e2e -- orders';
  const red = (name, fails) => `In test/orders.e2e-spec.ts add the test "${name}": ${fails}`;
  const e2Acc = [{ id: 'A1', text: 'GET /orders/:id returns the order in the list item shape', type: 'new' }, { id: 'A2', text: 'GET /orders/:id answers 404 for an unknown id', type: 'new' }];
  if (!bad) e2Acc.push({ id: 'A3', text: 'GET /orders?userId= answers as before', type: 'preserve' });
  return {
    e1: [{ kind: 'questions', round: 1, questions: [
      { id: 'Q1', question: 'Which account operations are in scope?', why: 'src/users/users.controller.ts serves only GET /users and GET /users/:id: every write is a new endpoint.', options: ['edit name and nickname', 'soft delete', 'both'], recommended: 'edit name and nickname' },
      { id: 'Q2', question: 'Who may manage an account?', why: 'src/main.ts sets up no auth guard: any caller could change any user.', options: ['the user only', 'an admin only'], recommended: 'an admin only' }],
    facts: ['src/users/users.controller.ts: GET /users and GET /users/:id only', 'prisma/schema.prisma: User has id, email, name, nickname, createdAt'], decisions: [] }],
    e2: [{ kind: 'plan', summary: 'Add GET /orders/:id returning one order in the list item shape; 404 when it does not exist.', acceptance: e2Acc,
      tasks: [{ id: 'T1', title: 'GET /orders/:id with 404', files: ['src/orders/orders.controller.ts', 'src/orders/orders.service.ts', 'test/orders.e2e-spec.ts'], modules: ['src/orders'],
        blocked_by: [], acceptance: e2Acc.map((a) => a.id), type: 'new', test_cmd: test,
        steps: [red('GET /orders/:id returns one order', 'expect(res.status).toBe(200) fails with 404'), `Run ${test}: red`,
          'Add OrdersService.get(id: number): Promise<OrderDto | null> and OrdersController @Get(":id") that throws NotFoundException on null', `Run ${test}: green`] }],
      allowed_schema_changes: [], allowed_api_changes: bad ? [] : ['GET /orders/:id: new endpoint'], skills: [], ui: null, children: [],
      facts: ['src/orders/orders.controller.ts: GET /orders lists one user\'s orders, POST /orders creates one'], decisions: [{ id: 'D1', text: '404 through NotFoundException', source: 'planner' }] }],
    e3: [{ kind: 'plan', round: 2, summary: 'GET /orders takes an optional state query; an unknown value answers 400.',
      acceptance: [{ id: 'A1', text: 'GET /orders?userId=1&state=paid returns only paid orders', type: 'new' }, { id: 'A2', text: 'GET /orders?userId=1&state=bogus answers 400', type: 'new' },
        { id: 'A3', text: 'GET /orders?userId=1 without state answers as before', type: 'preserve' }],
      tasks: [{ id: 'T1', title: 'state filter on GET /orders', files: ['src/orders/orders.dto.ts', 'src/orders/orders.service.ts', 'test/orders.e2e-spec.ts'], modules: ['src/orders'],
        blocked_by: [], acceptance: ['A1', 'A2', 'A3'], type: 'new', test_cmd: test,
        steps: [red('unknown state answers 400', 'expect(res.status).toBe(400) fails with 200'), `Run ${test}: red`,
          'Add an optional state (IsIn pending, paid) to ListOrdersQueryDto; OrdersService.list adds it to the where clause', `Run ${test}: green`] }],
      allowed_schema_changes: [], allowed_api_changes: ['GET /orders: add optional state query'], skills: [], ui: null, children: [],
      facts: ['src/orders/orders.dto.ts: ListOrdersQueryDto takes userId and the page query'],
      decisions: [E3_SEED.extra.locked_decisions[0], { id: 'D1', text: 'state validated with class-validator IsIn', source: 'planner' }] }],
    'golden-a': [{ kind: 'questions', round: 1, questions: [
      { id: 'Q1', question: 'What should "better for repeat customers" mean in this ticket?', why: 'Nothing in src/ tracks repeat customers; each meaning is a different feature.', options: ['Returning-customer discount', 'Order history view', 'Reorder endpoint'], recommended: 'Order history view' },
      { id: 'Q2', question: 'API only, or a schema change?', why: 'prisma/schema.prisma has no customer flag; a flag needs a migration.', options: ['API only, computed from orders', 'New column on User'], recommended: 'API only, computed from orders' },
      { id: 'Q3', question: 'How are discount amounts rounded?', why: 'Order.totalMinor is integer minor units.', options: ['Integer minor units, round down', 'Round half up to whole minor units'], recommended: 'Integer minor units, round down' },
      { id: 'Q4', question: 'Backfill existing customers?', why: 'prisma/seed.ts makes 5 orders per user.', options: ['No backfill', 'Backfill all past orders'], recommended: 'No backfill' }],
    facts: ['prisma/schema.prisma: Order.totalMinor is an integer', 'src/orders/orders.controller.ts: GET /orders and POST /orders'], decisions: [] },
    { kind: 'plan', round: 2, summary: 'POST /orders gives a returning customer a discount, computed in the API, in integer minor units, no backfill.',
      acceptance: [{ id: 'A1', text: 'POST /orders for a user with an earlier order stores the discounted totalMinor', type: 'new' }, { id: 'A2', text: 'GET /orders?userId= answers as before', type: 'preserve' }],
      tasks: [{ id: 'T1', title: 'returning-customer discount in OrdersService.create', files: ['src/orders/orders.service.ts', 'test/orders.e2e-spec.ts'], modules: ['src/orders'],
        blocked_by: [], acceptance: ['A1', 'A2'], type: 'new', test_cmd: test,
        steps: [red('returning customer gets the discount', 'expect(order.totalMinor).toBe(900) fails with 1000'), `Run ${test}: red`,
          'In OrdersService.create count the user\'s earlier orders; when > 0 take 10% off totalMinor, rounded down', `Run ${test}: green`] }],
      allowed_schema_changes: [], allowed_api_changes: ['POST /orders: totalMinor includes the returning-customer discount'], skills: [], ui: null, children: [],
      facts: ['prisma/schema.prisma: Order.totalMinor is an integer'], decisions: [{ id: 'D1', text: 'discount 10%, rounded down to whole minor units', source: 'planner' }] }],
  };
}
const deny = (id) => [
  { emit: { type: 'assistant', message: { type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id, name: 'StructuredOutput', input: {} }] } } },
  { emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'plan-check (fake): tasks[0].test_cmd: npm script "e2e" is not in package.json at base\nfix these and call StructuredOutput again' }] } } },
];
// The next fake-claude invocation (it claims .run-<n> in the scenario dir) gets this result.
function queueFake(scn, out, denials = 0) {
  const n = fs.readdirSync(scn).filter((f) => f.startsWith('.run-')).length + 1;
  const steps = [...Array.from({ length: denials }, (_, i) => deny(`toolu_fake${n}_${i}`)).flat(), { result: { structured_output: out, num_turns: 1 + 2 * denials } }];
  write(path.join(scn, `${n}.json`), { steps });
}

// ---- run artifacts -------------------------------------------------------------------------------------------------
// A run log's events, plain or gzipped once its run ended (lib/stream.js packLog); torn lines skipped.
function events(file) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file) : fs.existsSync(`${file}.gz`) ? zlib.gunzipSync(fs.readFileSync(`${file}.gz`)) : Buffer.alloc(0);
  return raw.toString('utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
}
// In-run plan gate denials: StructuredOutput calls answered with an error (hooks/plan-check.js deny, or claude's own
// schema retry), with their reasons.
function denials(evs) {
  const calls = new Set();
  const out = [];
  for (const m of evs) {
    for (const c of arr(m.message?.content)) {
      if (c.type === 'tool_use' && c.name === 'StructuredOutput') calls.add(c.id);
      if (c.type === 'tool_result' && c.is_error && calls.has(c.tool_use_id)) out.push((Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '')).slice(0, 600));
    }
  }
  return out;
}
const runNs = (dir) => (fs.existsSync(path.join(dir, 'runs')) ? fs.readdirSync(path.join(dir, 'runs')) : [])
  .map((f) => /^(\d+)\.prompt$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
function runInfo(dir, n) {
  const f = (ext) => path.join(dir, 'runs', `${n}.${ext}`);
  const evs = events(f('jsonl'));
  const res = evs.findLast((m) => m.type === 'result');
  const prompt = fs.existsSync(f('prompt')) ? fs.readFileSync(f('prompt'), 'utf8') : '';
  const err = fs.existsSync(f('err')) ? fs.readFileSync(f('err'), 'utf8') : '';
  return {
    n, model: evs.find((m) => m.type === 'system' && m.subtype === 'init')?.model ?? null, denials: denials(evs),
    result: res ? { subtype: res.subtype, is_error: res.is_error, turns: res.num_turns, cost_usd: res.total_cost_usd } : null,
    prompt: prompt.slice(0, 2048) + (prompt.length > 2048 ? `\n... (${prompt.length} chars)` : ''), err: err.slice(-1500),
  };
}
// JSON lines of TB_HOME/metrics.jsonl (or of file: a ticket's events.jsonl), torn lines skipped
const metricLines = (tbHome, file = path.join(tbHome, 'metrics.jsonl')) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  .split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
const ticketOf = (dir) => readJson(path.join(dir, 'ticket.json'), {});
const roundFiles = (dir) => (fs.existsSync(path.join(dir, 'rounds')) ? fs.readdirSync(path.join(dir, 'rounds')) : []).filter((f) => /^\d{2,}-(questions|plan)\.json$/.test(f)).sort();

// One planning round: the tb command that starts it (assign / answer), then every POLL until the ticket leaves planning
// (clarify, plan_approval, blocked, ...) or ROUND_MS (≈ the planning wall cap + slot wait); a timed-out round is
// cancelled. Then its logs are packed (= metered) and everything it left is collected.
async function round(env, id, tbArgs) {
  const dir = path.join(env.tbHome, 'tickets', id);
  const evFile = path.join(dir, 'events.jsonl');
  const seen = { rounds: new Set(roundFiles(dir)), runs: runNs(dir).length, metrics: metricLines(env.tbHome).length, events: metricLines(dir, evFile).length };
  const t0 = Date.now();
  const cmd = await runTb(tbArgs, env.tb);
  const r = { cmd: `tb ${tbArgs.join(' ')}`, tbOut: `${cmd.stdout}${cmd.stderr}`.trim(), ok: cmd.code === 0, timeout: false };
  console.log(`eval: ${id}: ${r.cmd} → exit ${cmd.code}`);
  if (r.ok) {
    let said = 0;
    for (let t = ticketOf(dir); t.state === 'planning'; t = ticketOf(dir)) {
      if (aborted || Date.now() - t0 > env.roundMs) {
        r.timeout = true;
        console.log(`eval: ${id}: ${aborted ? 'aborted' : 'timed out'} in planning: tb cancel`);
        await runTb(['cancel', id], env.tb);
        for (let i = 0; i < 20 && !ticketOf(dir).lease?.exit; i++) await sleep(1000);
        break;
      }
      if (Date.now() - said >= 60_000) {
        said = Date.now();
        const l = t.lease ?? {};
        console.log(`eval: ${id}: planning ${Math.round((Date.now() - t0) / 60_000)} min · ${t.waiting ? `waiting ${t.waiting.reason}` : `run ${l.log ?? '-'} ${l.exit ?? 'live'}${l.tool ? ` tool ${l.tool}` : ''}`}`);
      }
      await sleep(env.poll);
    }
    const live = () => fs.existsSync(path.join(dir, 'runs')) && fs.readdirSync(path.join(dir, 'runs')).some((f) => f.endsWith('.jsonl'));
    for (let i = 0; i < 30 && live(); i++) await sleep(1000); // packed = metered
  }
  const t = ticketOf(dir);
  const file = roundFiles(dir).filter((f) => !seen.rounds.has(f)).at(-1) ?? null;
  const metrics = metricLines(env.tbHome).slice(seen.metrics).filter((l) => l.t === 'run' && l.ticket === id); // run-end order = run order
  Object.assign(r, {
    secs: Math.round((Date.now() - t0) / 1000), ticket: t, file, result: file ? readJson(path.join(dir, 'rounds', file)) : null,
    runs: runNs(dir).slice(seen.runs).map((n, i) => ({ ...runInfo(dir, n), metric: metrics[i] ?? null })), metrics,
    facts: readJson(path.join(dir, 'facts.json')), decisions: readJson(path.join(dir, 'decisions.json')),
    events: metricLines(dir, evFile).slice(seen.events).filter((e) => e.kind !== 'update'), // transitions, notes (U7 fallback)
    dirty: t.worktree ? await dirtyPaths(t).catch((e) => [`(git status failed: ${e.message})`]) : ['(no worktree)'],
  });
  console.log(`eval: ${id}: ${t.state}${t.waiting ? ` (waiting ${t.waiting.reason})` : ''} · ${file ?? 'no round file'} · ${r.runs.length} run(s) · ${r.secs} s`);
  return r;
}

// ---- deterministic checks (planner-evals.md, sandbox-traps.md Ticket A) -------------------------------------------
const chk = (name, ok, evidence) => ({ name, ok: !!ok, evidence: String(evidence) });
const schemaFails = (r) => r.metrics.filter((l) => l.exit === 'schema_fail').length;
const exits = (r) => r.metrics.map((l) => l.exit).join(', ') || 'no t:run line';
// The <path> of a "<path>: <fact>" fact (trailing / dropped), or null.
const factPath = (f) => /^([^\s:]+):/.exec(String(f))?.[1]?.replace(/\/+$/, '') ?? null;
function atBase(t, p) {
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return false;
  try { git(t.worktree, 'cat-file', '-e', `${t.base_sha}:${p}`); return true; } catch { return false; }
}
function factsAtBase(r) {
  const bad = arr(r.result?.facts).filter((f) => !atBase(r.ticket, factPath(f)));
  return chk('every path named in facts exists at base_sha (git cat-file -e)', r.result && !bad.length,
    !r.result ? 'no result' : bad.length ? `missing: ${bad.map((f) => JSON.stringify(f)).join('; ')}` : `${arr(r.result.facts).length} facts, all paths at ${String(r.ticket.base_sha).slice(0, 12)}`);
}
const clean = (r, name = 'worktree clean (git status --porcelain, claude .cc-writes staging left out)') => chk(name, !r.dirty.length, r.dirty.length ? r.dirty.slice(0, 10).join('; ') : 'clean');

function questionChecks(r, maxOptions, planKeys) {
  const res = r.result;
  const qs = arr(res?.questions);
  const badQ = qs.filter((x) => !String(x.why ?? '').trim() || arr(x.options).length < 2 || arr(x.options).length > maxOptions || !arr(x.options).includes(x.recommended));
  const plan = planKeys.filter((k) => res && k in res);
  return [
    chk('rounds/01-questions.json: kind questions, ≥ 2 questions', r.file === '01-questions.json' && res?.kind === 'questions' && qs.length >= 2,
      `state ${r.ticket.state}, file ${r.file ?? 'none'}, kind ${res?.kind ?? '-'}, ${qs.length} questions`),
    chk(`each question: why, ${maxOptions === 4 ? '2-4' : '≥ 2'} options, recommended is one of them`, qs.length && !badQ.length,
      badQ.length ? `bad: ${badQ.map((x) => x.id).join(', ')}` : `${qs.length} ok`),
    chk(`no plan fields (${planKeys.join(', ')})`, res && !plan.length, !res ? 'no result' : plan.length ? `has ${plan.join(', ')}` : 'none'),
    factsAtBase(r),
  ];
}

function npmScripts(t) {
  try { return JSON.parse(git(t.worktree, 'show', `${t.base_sha}:package.json`)).scripts ?? {}; } catch { return {}; }
}
function testCmds(r) {
  const have = npmScripts(r.ticket);
  const bad = arr(r.result?.tasks).filter((x) => {
    const used = scriptsOf(x.test_cmd);
    return !used.length || used.some((s) => !Object.hasOwn(have, s));
  });
  return chk('every test_cmd runs the repo\'s own npm script (in package.json at base)', r.result && !bad.length,
    bad.length ? `bad: ${bad.map((x) => `${x.id} ${JSON.stringify(x.test_cmd)}`).join('; ')}` : arr(r.result?.tasks).map((x) => `${x.id}: ${x.test_cmd}`).join('; ') || 'no tasks');
}
const sourcesOk = (r, name) => {
  const bad = arr(r.decisions).filter((d) => !SOURCE_RE.test(String(d.source)));
  return chk(name, Array.isArray(r.decisions) && r.result && !bad.length,
    bad.length ? `bad: ${bad.map((d) => `${d.id} ${JSON.stringify(d.source)}`).join('; ')}` : `${arr(r.decisions).length} decisions: ${arr(r.decisions).map((d) => `${d.id}=${d.source}`).join(', ')}`);
};

const CHECKS = {
  e1: ([r]) => [...questionChecks(r, 4, ['tasks', 'summary', 'acceptance']), clean(r)],
  e2: ([r]) => {
    const p = r.result ?? {};
    const tasks = arr(p.tasks);
    const files = [...new Set(tasks.flatMap((x) => arr(x.files)))];
    const steps = tasks.flatMap((x) => arr(x.steps)).join('\n');
    const created = files.filter((f) => !atBase(r.ticket, f));
    const missing = created.filter((f) => !steps.includes(f) && !steps.includes(path.basename(f)));
    const need = ['src/orders/orders.controller.ts', 'src/orders/orders.service.ts'].filter((f) => !files.includes(f));
    return [
      chk('rounds/01-plan.json: kind plan, plan_approval, no schema_fail retry', r.file === '01-plan.json' && p.kind === 'plan' && r.ticket.state === 'plan_approval' && !schemaFails(r),
        `state ${r.ticket.state}, file ${r.file ?? 'none'}, kind ${p.kind ?? '-'}, t:run exits: ${exits(r)}`),
      chk('task files include orders.controller.ts + orders.service.ts; each path at base or created by a step', tasks.length && !need.length && !missing.length,
        `${need.length ? `not named: ${need.join(', ')}; ` : ''}${missing.length ? `missing (not at base, no step names it): ${missing.join(', ')}; ` : ''}files: ${files.join(', ') || 'none'}${created.length ? ` (new: ${created.join(', ')})` : ''}`),
      testCmds(r),
      chk('allowed_schema_changes == []; allowed_api_changes names GET /orders/:id', Array.isArray(p.allowed_schema_changes) && !p.allowed_schema_changes.length && arr(p.allowed_api_changes).some((s) => String(s).includes('GET /orders/:id')),
        `schema ${JSON.stringify(p.allowed_schema_changes ?? null)}; api ${JSON.stringify(p.allowed_api_changes ?? null)}`),
      chk('acceptance has ≥ 1 preserve item', arr(p.acceptance).some((a) => a.type === 'preserve'),
        arr(p.acceptance).map((a) => `${a.id} ${a.type}: ${a.text}`).join('; ') || 'no acceptance'),
      sourcesOk(r, 'every decision (decisions.json) has a source from the allowed set'),
    ];
  },
  e3: ([r]) => {
    const p = r.result ?? {};
    const locked = arr(r.ticket.locked_decisions);
    const merged = new Map(arr(r.decisions).map((d) => [d.id, d]));
    const lost = locked.filter((l) => { const d = merged.get(l.id); return !d || d.text !== l.text || d.source !== l.source; });
    const changed = arr(p.decisions).filter((d) => locked.some((l) => l.id === d.id && l.text !== d.text));
    const api = arr(p.allowed_api_changes).find((s) => /GET \/orders(?![\w/])/.test(s) && /\bstate\b/.test(s) && /optional/i.test(s));
    const status = /\?status=|status query/i.exec(JSON.stringify({ acceptance: p.acceptance, tasks: p.tasks }));
    const four = arr(p.tasks).filter((x) => /\b400\b/.test(`${x.title} ${arr(x.steps).join(' ')}`));
    const denied = r.runs.reduce((n, x) => n + x.denials.length, 0);
    return [
      chk('result accepted, no runner refusal (in-run hook denials allowed)', r.ticket.state === 'plan_approval' && !schemaFails(r),
        `state ${r.ticket.state}, t:run exits: ${exits(r)}, hook denials ${denied}`),
      chk('decisions.json holds R1Q1 + R1Q2 unchanged; no same-id decision with other text', locked.length === 2 && !lost.length && !changed.length,
        `${lost.length ? `lost/changed in decisions.json: ${lost.map((l) => l.id).join(', ')}; ` : ''}${changed.length ? `result changes: ${changed.map((d) => `${d.id} ${JSON.stringify(d.text)}`).join('; ')}; ` : ''}locked ${locked.map((l) => l.id).join(', ')}`),
      chk('kind plan; allowed_api_changes names an optional state query on GET /orders; no ?status= / status query', p.kind === 'plan' && api && !status,
        `kind ${p.kind ?? '-'}; api ${JSON.stringify(p.allowed_api_changes ?? null)}${status ? `; found ${JSON.stringify(status[0])}` : ''}`),
      chk('a task\'s test covers the 400 for an unknown value', four.length, four.length ? `tasks ${four.map((x) => x.id).join(', ')}` : 'no task names 400'),
    ];
  },
  'golden-a': (rs) => {
    const [r1] = rs;
    const r2 = rs.length > 1 ? rs.at(-1) : null; // the last answered round
    const q = questionChecks(r1, Infinity, PLAN_KEYS);
    return [q[0], q[1], q[3], q[2], clean(r1, 'round 1: zero writes in the worktree (git status --porcelain)'),
      chk(`a plan within ${GOLDEN_ROUNDS} rounds (canned answers by keyword, else recommended): kind plan, each decision has a source, no runner refusal`, r2 && r2.result?.kind === 'plan' && r2.ticket.state === 'plan_approval' && !schemaFails(r2) && sourcesOk(r2, '').ok,
        !r2 ? 'round 2 not run (round 1 gave no questions)' : `state ${r2.ticket.state}, kind ${r2.result?.kind ?? '-'}, t:run exits: ${exits(r2)}; ${sourcesOk(r2, '').evidence}`)];
  },
};
// planner-evals.md / sandbox-traps.md numbering (golden A: 1-4 round 1, 5 round 2)
const NUMS = { 'golden-a': ['1', '2', '3', '4a', '4b', '5'] };

// ---- report -------------------------------------------------------------------------------------------------------
const fence = (lang, v) => `\`\`\`\`${lang}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\`\`\`\``;
const details = (summary, body) => `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(2)}` : '?');
// a run's own cost: t:run cost_delta (a --resume's total minus the session's earlier total), else its result total
const costOf = (x) => (Number.isInteger(x.metric?.cost_delta) ? x.metric.cost_delta / 1e6 : x.result?.cost_usd ?? 0);
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function roundMd(label, r) {
  const t = r.ticket;
  const lines = [`### ${label}`, '',
    `- \`${r.cmd}\` → ${r.ok ? 'ok' : `FAILED: ${cell(r.tbOut.slice(0, 300))}`}${r.timeout ? ' · TIMED OUT (cancelled)' : ''} · ${r.secs} s`,
    `- after: state \`${t.state}\`${t.waiting ? ` (waiting ${t.waiting.reason})` : ''} · round file \`${r.file ?? 'none'}\`${t.lease?.error ? ` · lease error: ${cell(String(t.lease.error).slice(0, 300))}` : ''}`,
    `- lease: exit \`${t.lease?.exit ?? '-'}\` · model \`${t.lease?.model ?? '-'}\` · cost_total ${Number.isInteger(t.lease?.cost_total) ? usd(t.lease.cost_total / 1e6) : '?'}`];
  if (r.runs.length) {
    lines.push('', '| run | model (init) | t:run model/effort | exit | turns | cost | hook denials |', '|---|---|---|---|---|---|---|');
    for (const x of r.runs) {
      const m = x.metric;
      lines.push(`| ${x.n} | ${x.model ?? '-'} | ${m ? `${m.model}/${m.effort ?? '-'}` : '-'} | ${m?.exit ?? x.result?.subtype ?? '-'} | ${x.result?.turns ?? '-'} | ${usd(costOf(x))} | ${x.denials.length} |`);
    }
    for (const x of r.runs.filter((y) => y.denials.length)) lines.push('', `Run ${x.n} hook denials:`, ...x.denials.map((d) => `- ${cell(d.slice(0, 300))}`));
  }
  if (r.events.length) lines.push('', `- ticket events: ${r.events.map((e) => e.kind === 'transition' ? `${e.from} ${ARROW} ${e.to}` : cell(JSON.stringify(e).slice(0, 200))).join(' · ')}`);
  if (r.result) lines.push('', details(`rounds/${r.file}`, fence('json', r.result)));
  if (r.facts) lines.push('', details('facts.json', fence('json', r.facts)));
  if (r.decisions) lines.push('', details('decisions.json (runner-merged)', fence('json', r.decisions)));
  for (const x of r.runs) {
    lines.push('', details(`runs/${x.n}.prompt (first 2 KB)`, fence('md', x.prompt)));
    if (x.err.trim()) lines.push('', details(`runs/${x.n}.err (tail)`, fence('text', x.err)));
  }
  if (r.metrics.length) lines.push('', details('t:run lines', fence('json', r.metrics.map((l) => JSON.stringify(l)).join('\n'))));
  return lines.join('\n');
}

function report(o, env, results) {
  const all = results.flatMap((c) => c.checks);
  const pass = all.filter((c) => c.ok).length;
  const cost = results.flatMap((c) => c.rounds).flatMap((r) => r.runs).reduce((s, x) => s + costOf(x), 0);
  const out = [`# P4 planner evals: ${o.fake ? 'fake dry run' : 'real fable'} (${env.date})`, '',
    `Verdict (deterministic): ${pass === all.length ? 'PASS' : 'FAIL'}, ${pass}/${all.length} checks. Rubric (orchestrator) + Irfan score: fill below.`, '',
    `- run: \`node scripts/eval-planner.js ${process.argv.slice(2).join(' ')}\``,
    `- claude_bin: \`${env.claude}\` · planning: fable high (fable_billing plan) · one run at a time`,
    `- prompt: \`${o.prompt}\` (${env.words} words, sha256 ${env.promptSha}) as code/planning/prompt.md`,
    `- tbd: dev, port ${env.port} · TB_HOME \`${env.tbHome}\` (${o.keep ? 'kept' : 'removed'}) · HOME ${o.fake ? 'temp' : 'real (keychain login)'}`,
    `- tag sandbox: \`${SANDBOX}\` (git, base main) · total cost ${usd(cost)}`, '',
    '```mermaid', 'flowchart LR',
    '  P[temp TB_HOME + phases copy + prompt.md] --> T[dev tbd, own port]',
    '  T --> S[seed ticket.json backlog]', '  S --> A[tb assign: worktree at base_sha]', '  A --> R[planning run]',
    '  R --> W{state}', '  W -->|clarify, golden A| N[tb answer canned] --> R', '  W -->|clarify / plan_approval / blocked| C[collect + deterministic checks]',
    '  C --> O[report + exit code]', '```', '',
    '| case | ticket | rounds | checks | hook denials | runs | cost |', '|---|---|---|---|---|---|---|'];
  for (const c of results) {
    const runs = c.rounds.flatMap((r) => r.runs);
    out.push(`| ${c.key} | \`${c.id}\` | ${c.rounds.map((r) => r.ticket.state).join(' → ')} | ${c.checks.filter((x) => x.ok).length}/${c.checks.length} | ${runs.reduce((n, x) => n + x.denials.length, 0)} | ${runs.length} | ${usd(runs.reduce((s, x) => s + costOf(x), 0))} |`);
  }
  for (const c of results) {
    const t = c.rounds[0]?.ticket ?? {};
    out.push('', `## ${c.title}`, '', `- ticket \`${c.id}\`: ${JSON.stringify(c.text)}`, `- worktree \`${t.worktree ?? '-'}\` · base_sha \`${t.base_sha ?? '-'}\``);
    if (c.seed) out.push(`- seed (round 1 answered): ${c.seed.extra.locked_decisions.map((d) => `\`${d.id}\` ${d.text} (${d.source})`).join('; ')}`);
    out.push('', '| # | check | result | evidence |', '|---|---|---|---|',
      ...c.checks.map((x, i) => `| ${NUMS[c.key]?.[i] ?? i + 1} | ${cell(x.name)} | ${x.ok ? 'PASS' : '**FAIL**'} | ${cell(x.evidence)} |`));
    if (c.mapping) {
      out.push('', `Answers sent (canned: ${c.canned.map((a) => `"${a}"`).join(', ')}) mapped by keyword, else recommended:`, '', '| qid | question | topic | answer sent |', '|---|---|---|---|',
        ...c.mapping.map((m) => `| R${m.round} ${m.id} | ${cell(m.question)} | ${m.topic} | \`${cell(JSON.stringify(m.answer))}\` |`));
    }
    c.rounds.forEach((r, i) => out.push('', roundMd(c.rounds.length > 1 ? `Round ${i + 1}` : 'Round', r)));
    out.push('', `Rubric (orchestrator) _/5: ${c.rubric}`);
    if (c.key === 'golden-a') out.push('', 'Irfan score _/5 (pass = 4 or more, P4 AC9)');
  }
  if (env.stderr.trim()) out.push('', details('tbd stderr (tail: refused results, run errors)', fence('text', env.stderr.slice(-4000))));
  return out.join('\n').replaceAll(os.homedir(), '~') + '\n';
}

// ---- main ----------------------------------------------------------------------------------------------------------
function parse(argv) {
  const o = { cases: Object.keys(CASES), claude: null, prompt: null, fake: false, bad: false, keep: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cases') o.cases = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--claude') o.claude = argv[++i];
    else if (a === '--prompt') o.prompt = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--fake') o.fake = true;
    else if (a === '--fake-bad') o.fake = o.bad = true;
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown argument ${a}\nusage: node scripts/eval-planner.js [--cases ${Object.keys(CASES).join(',')}] [--claude <bin>] [--prompt <md>] [--fake [--fake-bad]] [--keep] [--out <md>]`);
  }
  const unknown = o.cases.filter((c) => !Object.hasOwn(CASES, c));
  if (!o.cases.length || unknown.length) throw new Error(`--cases: pick from ${Object.keys(CASES).join(',')}`);
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const date = new Date().toLocaleDateString('en-CA');
  o.out = path.resolve(o.out ?? path.join(REPO, 'docs', 'verification', `${date}-p4-planner-evals${o.fake ? '-fake' : ''}.md`));
  const draft = path.join(REPO, '.omc', 'drafts', 'planner-prompt.md');
  o.prompt = path.resolve(o.prompt ?? (fs.existsSync(draft) ? draft : path.join(REPO, 'phases', 'code', 'planning', 'prompt.md')));
  const claude = o.fake ? FAKE : path.resolve(o.claude ?? path.join(os.homedir(), '.local', 'share', 'claude', 'versions', DEFAULT_PIN));
  fs.accessSync(claude, fs.constants.X_OK); // throws: not there / not executable
  const promptText = fs.readFileSync(o.prompt, 'utf8');
  git(SANDBOX, 'rev-parse', '--verify', '--quiet', 'main^{commit}'); // throws: no sandbox repo / no main
  const gold = o.cases.includes('golden-a') ? golden() : null;
  if (gold) CASES['golden-a'].text = gold.text;

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbe-')));
  const tbHome = path.join(root, 'tbhome');
  const phases = path.join(root, 'phases');
  const scn = path.join(root, 'scn');
  fs.cpSync(path.join(REPO, 'phases'), phases, { recursive: true });
  write(path.join(phases, 'code', 'planning', 'prompt.md'), promptText);
  write(path.join(tbHome, 'config.json'), {
    claude_bin: claude, models: { planning: { model: 'fable', effort: 'high' } }, fable_billing: 'plan', // max_turns, wall cap: repo defaults
    ...(o.fake && { memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } }),
  });
  write(path.join(tbHome, 'tags.json'), { sandbox: { type: 'git', path: SANDBOX, base: 'main', checks: { typecheck: 'npm run typecheck', unit: 'npm test', e2e: 'npm run test:e2e' }, skills: [] } });
  const ids = {};
  for (const key of o.cases) {
    const c = CASES[key];
    const id = `t_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(tbHome, 'tickets', id);
    const now = new Date().toISOString();
    write(path.join(dir, 'ticket.json'), { // store.newFlow's shape
      id, type: 'flow', kind: 'code', tag: 'sandbox', title: c.text.trim().split('\n')[0].slice(0, 100), text: c.text, state: 'backlog', created_at: now, updated_at: now,
      parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null, ...c.seed?.extra,
    });
    for (const [f, v] of Object.entries(c.seed?.files ?? {})) write(path.join(dir, f), v);
    ids[key] = id;
  }
  if (o.fake) fs.mkdirSync(scn);
  const fakes = o.fake ? fakeResults(o.bad) : null;

  console.log(`eval: ${o.fake ? 'FAKE dry run' : 'REAL runs (fable high)'} · cases ${o.cases.join(',')} · root ${root}`);
  process.on('SIGINT', () => { aborted = true; console.log('eval: SIGINT: cancelling the live round, then cleanup'); });
  const tbd = await startTbd({
    root,
    env: o.fake
      ? { TB_PHASES_DIR: phases, NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', TEST_PRESSURE: 'normal', FAKE_CLAUDE_SCENARIO_DIR: scn }
      : { TB_PHASES_DIR: phases, HOME: os.homedir(), NODE_OPTIONS: '' },
  });
  const home = o.fake ? tbd.home : os.homedir();
  const env = { tbHome, port: tbd.port, tb: { tbHome, port: tbd.port, home }, roundMs: o.fake ? 60_000 : 40 * 60_000, poll: o.fake ? 1000 : 5000 };
  console.log(`eval: tbd up · port ${tbd.port} · TB_HOME ${tbHome}`);

  const results = [];
  let failed = null;
  try {
    for (const key of o.cases) {
      if (aborted) break;
      const c = CASES[key];
      const id = ids[key];
      const fake = fakes?.[key] ?? [];
      if (o.fake) queueFake(scn, fake[0], key === 'e3' ? 1 : 0);
      const rounds = [await round(env, id, ['assign', id])];
      const res = { key, id, title: c.title, text: c.text, rubric: c.rubric, seed: c.seed, rounds, mapping: null, canned: null, checks: [] };
      // golden A: answer each questions round (canned by keyword, else recommended) until a plan, at most GOLDEN_ROUNDS
      // rounds: the spec has no clarify-round limit and the planner asks the frontier a round at a time
      if (c.golden) Object.assign(res, { mapping: [], canned: gold.canned });
      for (let n = 1; c.golden && n < GOLDEN_ROUNDS && !aborted; n++) {
        const last = rounds.at(-1);
        if (last.ticket.state !== 'clarify' || last.result?.kind !== 'questions') break;
        const m = mapAnswers(last.result.questions, gold.canned);
        res.mapping.push(...m.rows.map((x) => ({ ...x, round: n })));
        const file = path.join(root, `answers-${id}-r${n}.json`);
        write(file, m.answers);
        if (o.fake) queueFake(scn, fake[n]);
        rounds.push(await round(env, id, ['answer', id, '--file', file]));
      }
      res.checks = CHECKS[key](rounds);
      console.log(`eval: ${key}: ${res.checks.filter((x) => x.ok).length}/${res.checks.length} checks pass`);
      results.push(res);
    }
  } catch (e) {
    failed = e;
    console.log(`eval: error: ${e.stack}`);
  } finally {
    const env2 = { date, port: tbd.port, tbHome, claude, stderr: tbd.stderr(), words: promptText.split(/\s+/).filter(Boolean).length, promptSha: crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 12) };
    if (results.length) {
      write(o.out, report(o, env2, results));
      console.log(`eval: report ${o.out}`);
    }
    await tbd.stop({ keep: true }).catch((e) => console.log(`eval: tbd stop: ${e.message}`));
    // runs tbd leaves alive (a tbd stop never kills runs): only a process whose argv names our TB_HOME, its own group
    for (const id of Object.values(ids)) {
      const l = ticketOf(path.join(tbHome, 'tickets', id)).lease;
      if (!l?.pid || l.exit) continue;
      let cmd = '';
      try { cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(l.pid)], { encoding: 'utf8', timeout: 5000 }); } catch { /* gone */ }
      if (cmd.includes(tbHome)) {
        console.log(`eval: ${id}: run pid ${l.pid} still alive: SIGKILL its group`);
        try { process.kill(-(l.pgid ?? l.pid), 'SIGKILL'); } catch { /* gone */ }
      }
    }
    const wts = Object.values(ids).map((id) => ticketOf(path.join(tbHome, 'tickets', id)).worktree).filter((w) => typeof w === 'string' && w.startsWith(root + path.sep));
    if (o.keep) {
      console.log(`eval: kept ${root}${wts.length ? `; later: ${wts.map((w) => `git -C ${SANDBOX} worktree remove --force ${w}`).join(' && ')} && rm -rf ${root}` : ''}`);
    } else {
      for (const w of wts) try { git(SANDBOX, 'worktree', 'remove', '--force', w); } catch (e) { console.log(`eval: worktree remove ${w}: ${String(e.stderr || e.message).trim()}`); }
      fs.rmSync(root, { recursive: true, force: true });
      console.log(`eval: removed ${root} + ${wts.length} worktree(s) of ${SANDBOX}`);
    }
  }
  const all = results.flatMap((c) => c.checks);
  const ok = !failed && !aborted && results.length === o.cases.length && all.every((x) => x.ok);
  console.log(`eval: ${ok ? 'PASS' : 'FAIL'} · ${all.filter((x) => x.ok).length}/${all.length} deterministic checks`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(`eval: error: ${e.message}`);
  process.exitCode = 1;
});
