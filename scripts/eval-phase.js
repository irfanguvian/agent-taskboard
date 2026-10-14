#!/usr/bin/env node
'use strict';
// eval-phase: the review evals E1-E3 (contract .omc/handoffs/m5-contract.md rev 4, M5.1; D-0085) on a REAL dev tbd in a
// throwaway TB_HOME, one case at a time (RAM; pattern scripts/eval-planner.js). A case is test/golden/m5/review/E<n>/case.json:
// ticket text, plan, the commits (patches on tb-sandbox main) and, round 2, the earlier review; its expect block is
// what the scripted checks hold the result to (example: an ideal result, the --fake answer).
// Per case: a worktree of tb-sandbox at main + the case's commits + the ticket seeded in review (round 2: review/01.json
// and t.review at the first commit) → tbd starts → the real code/review run (lib/review.js seed + handler) → stop when
// the ticket leaves review (qa or Blocked; working waits manual: code/working/prompt.md is dropped from the phases copy,
// so a blocking result never starts a fix session) → collect → scripted checks → cleanup (only our worktree).
// Usage: node scripts/eval-phase.js (--fake | --real) [--cases E1,E2,E3] [--model <m> [--effort <e>]] [--prompt <md>]
//   [--claude <bin>] [--keep] [--out <md>] [--packet <dir>] [--no-ram-wait]
//   --real: claude_bin = the pinned version; tbd keeps the real HOME (claude's keychain login); TB_HOME is temp. Model =
//     config default models.review (production) unless --model. --fake: test/fake-claude.js answers each case's example.
//   --no-ram-wait (--real; Irfan 2026-10-13): this eval's temp TB_HOME admits every run at once, as --fake does (no
//     min_free, no phase need, no docker reserve). Every real run is cancelled when kern.memorystatus_level < 15.
//   --prompt: the review prompt under test (default phases/code/review/prompt.md), copied as code/review/prompt.md.
//   --packet: the anonymised blind-scoring packet (D-0069): ticket, plan, diffs, the review result + transcript per case
//     under a neutral label, no expectations, no scripted verdicts, no model name.
// Leak (D-0059): --real runs tbd from a code copy without test/golden (scripts/golden-working.js codeCopy) and the repo is
// denyRead (TB_EVAL_DENY_READ); contamination() still flags a tool call naming the goldens or .omc/.
// --phase qa: the QA evals E1-E3 (M5.2; cases test/golden/m5/qa/E<n>/case.json): the ticket seeded in qa after review,
// the tag with qa_ports = one free port; --real runs the tag's setup (npm ci --prefer-offline) in the worktree first, as
// approve does; port_held: a process the run did not start holds the port (the app cannot start there, tbx req refuses
// it). --fake: one exec step plays the agent (a fixture app on the port answers the case's fake routes, tbx req each in
// order: rec 1.1, 1.2, ...; the report written). Stop when the ticket leaves qa (final_gate; working: fix task opened,
// waits manual; blocked). Checks read qa/01.json, the ticket and runs/<n>.rec.jsonl, never the agent's claim. Then every
// process with its cwd in the worktree (the app) is killed. No --packet (the review's blind score only).
// Exit 0 = every case clean and every scripted check passed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { startTbd, runTb, REPO, TBD } = require('../test/helpers/tbd');
const { FAKE, RUN_SPY } = require('../test/helpers/runs');
const { DEFAULT_PIN } = require('../lib/util');
const { SANDBOX, arr, sleep, readJson, write, git, events, runNs, runInfo, metricLines, ticketOf, reapRuns, chk, fence, details, usd, costOf, cell } = require('./eval-planner');
const { codeCopy, freshPath, guardHome, contamination } = require('./golden-working');
const { configBaseline } = require('../lib/spawn');

const PHASES = ['review', 'qa'];
const CASES = ['E1', 'E2', 'E3'];
const ARROW = String.fromCodePoint(0x2192);
const DIFF_MAX = 64 * 1024;
const SETUP = ['ci', '--prefer-offline']; // the golden tag's setup (scripts/golden-working.js goldenTag)
const iso = () => new Date().toISOString();
const memLevel = () => Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).trim());

// a phase's case.json with its plan + patch paths resolved (relative to the case dir)
function caseOf(phase, key) {
  const dir = path.join(REPO, 'test', 'golden', 'm5', phase, key);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  return { ...c, key, plan: JSON.parse(fs.readFileSync(path.join(dir, c.plan), 'utf8')), commits: c.commits.map((p) => path.join(dir, p)) };
}
const loadCase = (key) => caseOf('review', key);

// ---- pure: scoring ------------------------------------------------------------------------------------------------
// "path:lo[-hi]" → {path, lo, hi}, else null
function parseWhere(w) {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(String(w ?? ''));
  return m ? { path: m[1], lo: Number(m[2]), hi: Number(m[3] ?? m[2]) } : null;
}
const fText = (f) => `${f.id} ${f.severity} (${f.confidence}) ${f.where}`;
// The scripted checks of one case: r = {accepted, why, result}. expect: verdict; findings [{severity: [..], confidence?,
// path, lines: [lo, hi] (the where range must overlap), new? (an id the earlier review did not have)}], each open (not
// in closed); closed: ids closed and not kept in findings; max_findings.
function score(c, r) {
  const e = c.expect;
  const out = r.result ?? {};
  const found = arr(out.findings);
  const closed = arr(out.closed).map((x) => x.id);
  const prior = new Set(arr(c.prior?.review?.findings).map((f) => f.id));
  const list = found.map(fText).join('; ') || 'none';
  const checks = [chk('result accepted by lib/review.js: review/NN.json written, no refusal', r.accepted, r.why)];
  if (e.verdict) checks.push(chk(`verdict ${e.verdict}`, out.verdict === e.verdict, `verdict ${out.verdict ?? '-'}`));
  for (const want of arr(e.findings)) {
    const hit = found.find((f) => {
      const w = parseWhere(f.where);
      return w && want.severity.includes(f.severity) && (!want.confidence || f.confidence === want.confidence) && w.path === want.path
        && w.lo <= want.lines[1] && w.hi >= want.lines[0] && !(want.new && prior.has(f.id)) && !closed.includes(f.id);
    });
    checks.push(chk(`${want.new ? 'a new' : 'an'} open ${want.severity.join('/')}${want.confidence ? ` ${want.confidence}-confidence` : ''} finding at ${want.path}:${want.lines.join('-')}`,
      hit, hit ? fText(hit) : `findings: ${list}`));
  }
  for (const id of arr(e.closed)) checks.push(chk(`${id} closed, not kept open`, closed.includes(id) && !found.some((f) => f.id === id), `closed: ${closed.join(', ') || 'none'}; findings: ${list}`));
  if (Number.isInteger(e.max_findings)) checks.push(chk(`at most ${e.max_findings} finding(s)`, found.length <= e.max_findings, `${found.length}: ${list}`));
  return checks;
}

const urlPath = (u) => { try { return new URL(u).pathname; } catch { return null; } };
const qText = (x) => `${x.id} ${x.kind} ${x.result}${x.cause ? `/${x.cause}` : ''} ${x.source} [${arr(x.recs).join(',')}]`;
// The scripted checks of one QA case, from what tbd kept: r = {accepted, why, result (qa/01.json, else the last output),
// ticket, recs (the lines of this ticket's runs/<n>.rec.jsonl), lines (changed path → its line count at HEAD)}. Always:
// accepted, verdict, stop state, sources, every cited rec recorded with the status claimed. expect: kinds (1+ positive and
// 1+ negative), file_source (1+ source a changed path:line), rec {result, cause?, method, path, status, body?} (a case
// with that result cites such a rec), no_pass (every case BLOCKED or ASSISTED, BLOCKED ones cause env), fix (task id).
function scoreQa(c, r) {
  const e = c.expect;
  const out = r.result ?? {};
  const cases = arr(out.cases);
  const t = r.ticket ?? {};
  const recs = new Map(arr(r.recs).map((x) => [x.n, x]));
  const acc = new Set(arr(c.plan.acceptance).map((a) => a.id));
  const list = cases.map(qText).join('; ') || 'none';
  const inDiff = (s) => { const w = parseWhere(s); return !!w && w.hi <= (r.lines?.[w.path] ?? 0); };
  const checks = [chk('result accepted by lib/qa.js: qa/01.json written, no refusal', r.accepted, r.why),
    chk(`verdict ${e.verdict}`, out.verdict === e.verdict, `verdict ${out.verdict ?? '-'}`),
    chk(`ticket stops in ${e.state}${e.waiting ? ` waiting ${e.waiting}` : ''}`, t.state === e.state && (!e.waiting || t.waiting?.reason === e.waiting),
      `${t.state ?? '-'}${t.waiting ? ` (waiting ${t.waiting.reason})` : ''}`)];
  const stray = cases.filter((x) => !acc.has(x.source) && !inDiff(x.source));
  checks.push(chk('every source is a plan acceptance id or a changed path:line inside the file at HEAD', cases.length && !stray.length, stray.length ? stray.map(qText).join('; ') : list));
  const forged = cases.flatMap((x) => {
    const lost = arr(x.recs).filter((id) => !recs.has(id));
    if (lost.length) return [`${x.id}: ${lost.join(', ')} in no rec file`];
    const last = recs.get(arr(x.recs).at(-1));
    return last && ['PASS', 'FAIL'].includes(x.result) && x.observed?.status !== last.res?.status ? [`${x.id}: status ${x.observed?.status ?? '-'}, rec ${last.n} ${last.res?.status ?? '-'}`] : [];
  });
  checks.push(chk('every cited rec is a call tbd recorded for this ticket; a PASS/FAIL case\'s status = its last rec', !forged.length, forged.join('; ') || `${recs.size} rec(s) recorded`));
  if (e.kinds) checks.push(chk('1+ positive and 1+ negative case', cases.some((x) => x.kind === 'positive') && cases.some((x) => x.kind === 'negative'), list));
  if (e.file_source) checks.push(chk('1+ case source is a changed path:line', cases.some((x) => inDiff(x.source)), list));
  if (e.rec) {
    const w = e.rec;
    const hit = cases.find((x) => x.result === w.result && (!w.cause || x.cause === w.cause) && arr(x.recs).some((id) => {
      const l = recs.get(id);
      return l && l.method === w.method && urlPath(l.url) === w.path && l.res?.status === w.status && (!w.body || String(l.res.body ?? '').includes(w.body));
    }));
    checks.push(chk(`a ${w.result}${w.cause ? ` cause ${w.cause}` : ''} case cites a recorded ${w.method} ${w.path} ${w.status}${w.body ? ` with ${w.body} in the body` : ''}`, hit,
      hit ? qText(hit) : `cases: ${list}; recs: ${[...recs.values()].map((l) => `${l.n} ${l.method} ${l.url} ${l.res?.status ?? l.error}`).join(', ') || 'none'}`));
  }
  if (e.no_pass) checks.push(chk('no PASS: every case BLOCKED or ASSISTED, a BLOCKED one cause env', cases.length && cases.every((x) => x.result === 'ASSISTED' || (x.result === 'BLOCKED' && x.cause === 'env')), list));
  if (e.fix) checks.push(chk(`fix task ${e.fix} opened (fix 1)`, arr(t.work?.tasks).some((x) => x.id === e.fix) && t.fixes === 1, `tasks ${arr(t.work?.tasks).map((x) => x.id).join(', ') || 'none'}; fixes ${t.fixes ?? '-'}`));
  return checks;
}

// ---- one case -----------------------------------------------------------------------------------------------------
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => resolve(port)); });
});
const gitc = (wt, ...args) => git(wt, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', ...args);

// A worktree of tb-sandbox at base + the case's commits (messages as the sessions would write them) + the ticket as
// the working gate leaves it in review (qa: as a pass of review leaves it in qa); round 2: the earlier review's file
// and t.review at its head. qa --real: the tag's setup, then config_baseline as approve saves it (planning.js; a package
// may ship a .claude dir: @nestjs/swagger does). Written while tbd is down.
async function seed(env, c) {
  const id = `t_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(env.tbHome, 'tickets', id);
  const wt = path.join(env.tbHome, 'worktrees', id);
  fs.mkdirSync(path.dirname(wt), { recursive: true, mode: 0o700 });
  git(SANDBOX, 'worktree', 'add', '--detach', wt, env.base);
  let heads;
  let gitDir;
  let baseline = null;
  try {
    heads = c.commits.map((p, i) => {
      gitc(wt, 'apply', '--index', '--whitespace=nowarn', p);
      gitc(wt, 'commit', '-q', '--no-verify', '-m', i === 0 ? `T1: ${c.plan.tasks[0].title}` : `@rv${i}: fix the review ${i} findings`);
      return git(wt, 'rev-parse', 'HEAD').trim();
    });
    gitDir = fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir').trim());
    if (env.phase === 'qa' && !env.fake) {
      execFileSync('npm', SETUP, { cwd: wt, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15 * 60_000 }); // approve's setup (D-0072: 15 min)
      baseline = await configBaseline({ base_sha: env.base, git_dir: gitDir, common_dir: env.commonDir }, wt);
    }
  } catch (e) {
    cleanup(wt);
    throw e;
  }
  const p = c.prior;
  const priorHead = p ? heads[p.commit - 1] : null;
  const now = iso();
  write(path.join(dir, 'ticket.json'), {
    id, type: 'flow', kind: 'code', tag: 'sandbox', title: c.ticket.slice(0, 100), text: c.ticket, state: env.phase, round: 1, created_at: now, updated_at: now,
    parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null,
    base_sha: env.base, worktree: wt, git_dir: gitDir, common_dir: env.commonDir,
    work: { task: null, tries: 0, unit_ms: null, scope: {}, denied: {}, gate: null,
      tasks: [{ id: 'T1', status: 'done', attempt: 1, pre: env.base, head: heads[0] }, ...(p ? [{ id: '@rv1', status: 'done', attempt: 1, pre: priorHead, head: heads.at(-1) }] : [])] },
    fixes: p?.fixes ?? 0,
    ...(p && { review: { n: 1, head: priorHead, open: p.open } }),
    ...(env.phase === 'qa' && { review: { n: 1, head: heads.at(-1), open: [] } }),
    ...(baseline && { config_baseline: baseline }),
  });
  write(path.join(dir, 'plan.json'), c.plan);
  if (p) write(path.join(dir, 'review', '01.json'), { n: 1, at: now, round: 1, head: priorHead, ...p.review });
  return { id, dir, wt, heads, priorHead };
}

// a run's last structured output (its result event), refused or not
const outputOf = (evs) => evs.findLast((m) => m.type === 'result')?.structured_output ?? null;

// --fake qa: the agent's tool work as one exec step (pattern test/qa.test.js qaExec): the report written where the example
// says; then, when the case has fake routes, the fixture app on the qa port (a child of the step's shell: under the run
// root) answers them, tbx req calls each in order (rec 1.1, 1.2, ...; the first retried while tbd does not know the run
// key yet), the app stops.
const FAKE_APP = `const fs = require('node:fs');
const [port, routes, ready] = process.argv.slice(2);
const map = new Map(JSON.parse(fs.readFileSync(routes, 'utf8')).map(([u, s, b]) => [u, [s, b]]));
require('node:http').createServer((q, r) => { const [s, b] = map.get(q.url) ?? [404, { message: 'not found' }]; r.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b)); })
  .listen(Number(port), '127.0.0.1', () => fs.writeFileSync(ready, ''));
`;
function fakeExec(env, c) {
  const f = (ext) => path.join(env.root, `fake-${c.key}.${ext}`);
  write(f('json'), arr(c.fake));
  write(f('md'), `# QA ${c.key} (fake)\n\n\`\`\`mermaid\nflowchart LR\n  A[cases] --> B[tbx req]\n\`\`\`\n\n**Verdict:** ${String(c.example.verdict).toUpperCase()}\n`);
  const req = (u) => `tbx req GET 'http://127.0.0.1:${env.port}${u}'`;
  const [first, ...rest] = arr(c.fake).map(([u]) => u);
  write(f('sh'), [`mkdir -p '${path.dirname(c.example.report)}'`, `cp '${f('md')}' '${c.example.report}'`, ...(first ? [
    `ready='${f('ready')}'; out='${f('out')}'`,
    `'${process.execPath}' '${env.app}' ${env.port} '${f('json')}' "$ready" & srv=$!`,
    'i=0; while [ ! -f "$ready" ] && [ $i -lt 200 ]; do i=$((i+1)); sleep 0.05; done',
    `i=0; while ! ${req(first)} > "$out" 2>&1 && grep -q 'unknown run key' "$out" && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done`,
    ...rest.map((u) => `${req(u)} >> "$out" 2>&1`), 'kill $srv'] : [])].join('\n') + '\n');
  return { exec: ['/bin/sh', f('sh')] };
}

// a listener on port that no run started (port_held): the app cannot bind there and tbx req refuses it
function hold(port) {
  const p = spawn(process.execPath, ['-e', `require('node:net').createServer((s) => s.destroy()).listen(${port}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    p.stdout.once('data', () => resolve(p));
    p.once('exit', (code) => reject(new Error(`port holder on ${port} exited ${code}`)));
  });
}

// Processes left with their cwd in dir (the app a QA run started in the background, its npm or tsx): SIGKILL. lsof lists
// every process's cwd; only ours lie in the temp worktree. → the pids
function killIn(dir) {
  let out = '';
  try { out = execFileSync('/usr/sbin/lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { out = String(e.stdout ?? ''); } // exit 1: some pids unreadable
  const hit = [];
  let pid = 0;
  for (const l of out.split('\n')) {
    if (l[0] === 'p') pid = Number(l.slice(1));
    else if (l[0] === 'n' && (l.slice(1) === dir || l.startsWith(`n${dir}${path.sep}`)) && pid !== process.pid) hit.push(pid);
  }
  for (const p of hit) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  return hit;
}

// rec lines of the ticket's QA runs (runs/<n>.rec.jsonl whose meta line names this ticket and phase qa)
const recsOf = (dir, id) => (fs.existsSync(path.join(dir, 'runs')) ? fs.readdirSync(path.join(dir, 'runs')) : []).filter((f) => /^\d+\.rec\.jsonl$/.test(f))
  .flatMap((f) => { const [meta, ...ls] = metricLines(dir, path.join(dir, 'runs', f)); return meta?.meta === true && meta.ticket === id && meta.phase === 'qa' ? ls : []; });

async function runCase(o, env, c) {
  const { id, dir, wt, heads, priorHead } = await seed(env, c);
  const scn = path.join(env.root, `scn-${c.key}`);
  if (o.fake) write(path.join(scn, '1.json'), { steps: [...(env.phase === 'qa' ? [fakeExec(env, c)] : []), { result: { structured_output: c.example, num_turns: 1 } }] });
  console.log(`eval: ${c.key}: ${id} seeded in ${env.phase} (${heads.length} commit(s))${c.port_held ? `, port ${env.port} held` : ''}`);
  const r = { key: c.key, title: c.title, id, text: c.ticket, phase: env.phase, notes: [], error: null };
  let tbd;
  let holder = null;
  try {
    if (c.port_held) holder = await hold(env.port);
    tbd = await startTbd({
      root: env.root,
      tbd: o.fake ? TBD : path.join(env.code, 'tbd.js'), // fake: the run-spy preload patches THIS repo's lib (golden-working --dry note)
      env: o.fake
        ? { TB_EVAL_DENY_READ: REPO, TB_PHASES_DIR: env.phases, NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', TEST_PRESSURE: 'normal', FAKE_CLAUDE_SCENARIO_DIR: scn }
        : { TB_EVAL_DENY_READ: REPO, TB_PHASES_DIR: env.phases, HOME: os.homedir(), NODE_OPTIONS: '' },
    });
  } catch (e) { // startTbd removed the root: our worktree goes too
    holder?.kill('SIGKILL');
    cleanup(wt);
    throw e;
  }
  const t0 = Date.now();
  try {
    guardHome(env.tbHome, tbd.port);
    let said = Date.now();
    for (let t = ticketOf(dir); t.state === env.phase && t.waiting?.reason !== 'manual'; t = ticketOf(dir)) {
      const low = !o.fake && memLevel() < 15; // the freeze guard
      if (env.aborted || low || Date.now() - t0 > env.runMs) {
        r.timeout = true;
        if (low) r.notes.push('kern.memorystatus_level < 15: cancelled');
        console.log(`eval: ${id}: ${env.aborted ? 'aborted' : low ? 'memory level under 15' : 'run cap reached'}: tb cancel`);
        await runTb(['cancel', id], { tbHome: env.tbHome, port: tbd.port, home: o.fake ? tbd.home : os.homedir() });
        for (let k = 0; k < 20 && ticketOf(dir).state !== 'cancelled'; k++) await sleep(1000);
        break;
      }
      if (Date.now() - said >= 60_000) {
        said = Date.now();
        console.log(`eval: ${id}: ${env.phase} ${Math.round((Date.now() - t0) / 60_000)} min · ${t.waiting ? `waiting ${t.waiting.reason}` : `run ${t.lease?.log ?? '-'} ${t.lease?.exit ?? 'live'}`}`);
      }
      await sleep(env.poll);
    }
    const packed = () => !fs.existsSync(path.join(dir, 'runs')) || !fs.readdirSync(path.join(dir, 'runs')).some((f) => /^\d+\.jsonl$/.test(f));
    for (let k = 0; k < 30 && !packed(); k++) await sleep(1000); // packed = metered
  } finally {
    r.stderr = tbd.stderr();
    await tbd.stop({ keep: true }).catch((e) => r.notes.push(`tbd stop: ${e.message}`));
    reapRuns(env.tbHome, [id]);
    if (env.phase === 'qa') {
      const left = killIn(wt);
      if (left.length) r.notes.push(`killed ${left.length} process(es) left with their cwd in the worktree: pids ${left.join(', ')}`);
    }
    if (holder) {
      r.notes.push(holder.exitCode === null && !holder.signalCode ? `port ${env.port} holder still ran at the end` : `port ${env.port} holder gone (${holder.signalCode ?? holder.exitCode}): the run stopped a process it did not start`);
      holder.kill('SIGKILL');
    }
  }
  r.min = Math.round((Date.now() - t0) / 60_000);
  try {
    const t = ticketOf(dir);
    const want = c.prior ? 2 : 1; // the review/NN.json (qa: qa/01.json) this run writes
    const file = path.join(dir, env.phase, `${String(want).padStart(2, '0')}.json`);
    const ns = runNs(dir);
    const metrics = metricLines(env.tbHome).filter((l) => l.t === 'run' && l.ticket === id);
    const runsEvents = ns.map((n) => ({ n, evs: events(path.join(dir, 'runs', `${n}.jsonl`)) }));
    const saved = readJson(file);
    const exits = metrics.map((l) => l.exit);
    Object.assign(r, {
      ticket: t, metrics, contaminated: contamination(runsEvents),
      runs: ns.map((n, i) => ({ ...runInfo(dir, n), metric: metrics[i] ?? null, output: outputOf(runsEvents[i].evs), evs: runsEvents[i].evs })),
      transitions: metricLines(dir, path.join(dir, 'events.jsonl')).filter((e) => e.kind === 'transition'),
      accepted: !!saved && !exits.includes('schema_fail'),
      why: `state ${t.state}${t.waiting ? ` (waiting ${t.waiting.reason})` : ''}; ${path.relative(dir, file)} ${saved ? 'written' : 'missing'}; t:run exits: ${exits.join(', ') || 'none'}`,
    });
    const diff = (from) => { const d = git(wt, 'diff', from, 'HEAD'); return d.length > DIFF_MAX ? `${d.slice(0, DIFF_MAX)}\n... (${d.length} bytes, cut)` : d; };
    r.diff = diff(env.base);
    r.delta = priorHead ? diff(priorHead) : null;
    if (env.phase === 'qa') {
      r.result = saved ?? r.runs.findLast((x) => x.output)?.output ?? null;
      r.recs = recsOf(dir, id);
      r.lines = Object.fromEntries(git(wt, 'diff', '--name-only', env.base, 'HEAD').split('\n').filter(Boolean).flatMap((p) => {
        try { return [[p, git(wt, 'show', `HEAD:${p}`).split('\n').length]]; } catch { return []; } // deleted
      }));
      const rp = typeof r.result?.report === 'string' && !r.result.report.split('/').includes('..') ? path.join(dir, r.result.report) : null; // the docs mirror
      r.report = rp && fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8').slice(0, 8192) : null;
      r.checks = scoreQa(c, r);
    } else {
      r.result = saved ? { verdict: saved.verdict, findings: saved.findings, closed: saved.closed, notes: saved.notes, declined: saved.declined } : r.runs.findLast((x) => x.output)?.output ?? null;
      r.checks = score(c, r);
    }
  } catch (e) {
    r.error = e.stack;
    r.checks ??= [chk('scripted checks ran', false, e.message)];
  }
  if (!o.keep) cleanup(wt);
  else r.notes.push(`kept; later: git -C ${SANDBOX} worktree remove --force ${wt} && git -C ${SANDBOX} worktree prune`);
  console.log(`eval: ${c.key}: ${r.ticket?.state ?? '?'} · ${r.checks.filter((x) => x.ok).length}/${r.checks.length} checks${arr(r.contaminated).length ? ' · CONTAMINATED' : ''} · ${usd(arr(r.runs).reduce((s, x) => s + costOf(x), 0))} · ${r.min} min`);
  return r;
}

// only our own worktree (detached: no branch, no ref) goes; never main, never another ticket's
function cleanup(wt) {
  try { git(SANDBOX, 'worktree', 'remove', '--force', wt); } catch (e) { console.log(`eval: worktree remove ${wt}: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  git(SANDBOX, 'worktree', 'prune');
}

// ---- report + blind packet ----------------------------------------------------------------------------------------
const MERMAID = {
  review: ['```mermaid', 'flowchart LR',
    '  C[case.json: ticket, plan, patches] --> S[seed: worktree at main + commits, ticket in review]',
    '  S --> T[dev tbd: temp TB_HOME, code copy, own port]',
    '  T --> R[real review run: lib/review.js seed + handler]',
    '  R --> M{handler}',
    '  M -->|pass| Q[qa: stop]', '  M -->|block| W[working: waits manual, stop]', '  M -->|refused twice| B[blocked: stop]',
    '  Q --> K[scripted checks vs expect]', '  W --> K', '  B --> K', '  K --> E[run log + blind packet]', '```'],
  qa: ['```mermaid', 'flowchart LR',
    '  C[case.json: ticket, plan, patches] --> S[seed: worktree at main + commits + npm ci, ticket in qa]',
    '  S --> T[dev tbd: temp TB_HOME, code copy, qa_ports = 1 free port]',
    '  T --> R[real QA run: starts the app, tbx req, report]',
    '  R --> M{lib/qa.js handler}',
    '  M -->|all PASS| F[final_gate: stop]', '  M -->|FAIL cause code| W[working @qa1: waits manual, stop]', '  M -->|BLOCKED or refused twice| B[blocked: stop]',
    '  F --> K[scripted checks: qa/01.json, ticket, rec files]', '  W --> K', '  B --> K', '  K --> E[run log]', '```'],
};

// a run's tool calls, one line each (Bash: its command, background or not; else the path / pattern)
const toolLines = (evs) => evs.flatMap((m) => (m.type === 'assistant' ? arr(m.message?.content) : []).filter((c) => c.type === 'tool_use')
  .map((c) => `${c.name}${c.input?.run_in_background ? ' (background)' : ''}: ${String(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? JSON.stringify(c.input ?? {})).replace(/\s+/g, ' ').slice(0, 240)}`));

function caseMd(r) {
  const pass = r.checks.filter((x) => x.ok).length;
  const leak = arr(r.contaminated);
  const out = [`## ${r.title}: \`${r.id}\`: ${r.ticket?.state ?? '?'}: ${pass}/${r.checks.length}${leak.length ? ': CONTAMINATED' : ''}`, '',
    ...(leak.length ? [`- **CONTAMINATED** (does not count): ${leak.map(cell).join('; ')}`] : []),
    `- ticket ${JSON.stringify(r.text)} · ${r.min} min · cost ${usd(arr(r.runs).reduce((s, x) => s + costOf(x), 0))}${r.timeout ? ' · RUN CAP / ABORT (cancelled)' : ''}`,
    `- transitions: ${arr(r.transitions).map((e) => `${e.from} ${ARROW} ${e.to}`).join(' · ') || 'none'}`,
    ...r.notes.map((n) => `- ${cell(n)}`), '',
    '| # | check | result | evidence |', '|---|---|---|---|',
    ...r.checks.map((x, k) => `| ${k + 1} | ${cell(x.name)} | ${x.ok ? 'PASS' : '**FAIL**'} | ${cell(x.evidence)} |`)];
  if (arr(r.runs).length) {
    out.push('', '| run | model (init) | t:run model/effort | exit | turns | cost | peak RSS MB |', '|---|---|---|---|---|---|---|',
      ...r.runs.map((x) => `| ${x.n} | ${x.model ?? '-'} | ${x.metric ? `${x.metric.model}/${x.metric.effort ?? '-'}` : '-'} | ${x.metric?.exit ?? x.result?.subtype ?? '-'} | ${x.result?.turns ?? '-'} | ${usd(costOf(x))} | ${x.metric?.peak_rss_mb ?? '-'} |`));
  }
  if (arr(r.recs).length) {
    out.push('', '| rec | method | url | status | ms |', '|---|---|---|---|---|', ...r.recs.map((l) => `| ${l.n} | ${l.method} | ${cell(l.url)} | ${l.res?.status ?? cell(l.error ?? '-')} | ${l.ms ?? '-'} |`));
  }
  if (r.result) out.push('', details(`${r.phase} result`, fence('json', r.result)));
  if (r.report) out.push('', details('report (docs mirror, first 8 KB)', fence('md', r.report)));
  for (const x of arr(r.runs).filter((y) => y.output && y.output !== r.result)) out.push('', details(`run ${x.n} structured output`, fence('json', x.output)));
  for (const x of arr(r.runs)) {
    out.push('', details(`runs/${x.n}.prompt (first 2 KB)`, fence('md', x.prompt)));
    if (r.phase === 'qa') out.push('', details(`runs/${x.n} tool calls`, fence('text', toolLines(x.evs).join('\n') || 'none')));
    if (x.err.trim()) out.push('', details(`runs/${x.n}.err (tail)`, fence('text', x.err)));
  }
  if (r.diff) out.push('', details('diff base..HEAD', fence('diff', r.diff)));
  if (r.error) out.push('', details('harness error', fence('text', r.error)));
  if (r.stderr?.trim()) out.push('', details('tbd stderr (tail)', fence('text', r.stderr.slice(-3000))));
  return out.join('\n');
}

function report(o, env, results) {
  const clean = results.filter((r) => !arr(r.contaminated).length);
  const all = clean.flatMap((r) => r.checks);
  const pass = all.filter((x) => x.ok).length;
  const green = clean.filter((r) => r.checks.every((x) => x.ok)).length;
  const out = [`# M5.${env.phase === 'qa' ? 2 : 1} ${env.phase} evals: ${o.fake ? 'fake dry run' : 'real'} (${env.date})`, '',
    `Verdict (scripted): ${green === env.planned ? 'PASS' : 'FAIL'}, ${green}/${env.planned} cases, ${pass}/${all.length} checks, ${results.length - clean.length} contaminated.${env.phase === 'review' ? ' Blind score: separate packet (D-0069).' : ''}`, '',
    `- cmd \`node scripts/eval-phase.js ${process.argv.slice(2).join(' ')}\``,
    `- claude_bin \`${env.claude}\` · ${env.phase} model: ${o.model ? `${o.model}/${o.effort} (--model)` : `config default models.${env.phase} (production)`} · one run at a time${o.noRamWait ? ' · --no-ram-wait: eval TB_HOME admits at once (no min_free, no phase need, no docker reserve); cancel at memory level < 15' : ''}`,
    `- prompt \`${o.prompt}\` (${env.words} words, sha256 ${env.promptSha}) as code/${env.phase}/prompt.md${env.port ? ` · qa_ports [${env.port}]` : ''}`,
    `- tbd ${o.fake ? 'this repo' : 'code copy (no test/golden)'}, own port per case · TB_HOME \`${env.tbHome}\` (${o.keep ? 'kept' : 'removed'}) · HOME ${o.fake ? 'temp' : 'real (keychain login)'}`,
    `- sandbox \`${SANDBOX}\` base \`${env.base.slice(0, 12)}\` · total cost ${usd(results.flatMap((r) => arr(r.runs)).reduce((s, x) => s + costOf(x), 0))}`,
    ...(env.labels ? [`- blind packet \`${o.packet}\`: ${Object.entries(env.labels).map(([k, v]) => `${v} = ${k}`).join(', ')}`] : []), '', ...MERMAID[env.phase], '',
    '| case | ticket | stop | checks | contaminated | runs | cost | min |', '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.key} | \`${r.id}\` | ${r.ticket?.state ?? '?'} | ${r.checks.filter((x) => x.ok).length}/${r.checks.length} | ${arr(r.contaminated).length ? 'yes' : 'no'} | ${arr(r.runs).length} | ${usd(arr(r.runs).reduce((s, x) => s + costOf(x), 0))} | ${r.min} |`)];
  for (const r of results) out.push('', caseMd(r));
  return out.join('\n').replaceAll(os.homedir(), '~') + '\n';
}

// The run's conversation as text: assistant text, tool calls (name + main input), tool results (cut), the final output.
function transcript(evs) {
  const out = [];
  const text = (c) => (Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : String(c ?? ''));
  for (const m of evs) {
    for (const c of (m.type === 'assistant' || m.type === 'user') ? arr(m.message?.content) : []) {
      if (c.type === 'text' && c.text.trim()) out.push(`**reviewer:** ${c.text.trim()}`);
      if (c.type === 'tool_use') out.push(`**tool ${c.name}:** \`${cell(JSON.stringify(c.input)).slice(0, 400)}\``);
      if (c.type === 'tool_result') out.push(`<details><summary>result</summary>\n\n${fence('text', text(c.content).slice(0, 1500))}\n\n</details>`);
    }
  }
  return out.join('\n\n');
}

// D-0069 blind input: ticket + plan + diff (+ round 2: the earlier review and the delta) + the review and its run, under
// shuffled neutral labels; no case names, expectations, scripted checks or model. → {E<n>: label}
function writePacket(dir, env, results) {
  const labels = {};
  const order = results.map((r) => [crypto.randomInt(2 ** 32), r.key]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); // shuffled
  const anon = (s) => String(s).replaceAll(env.root, '<tmp>').replaceAll(os.homedir(), '~');
  order.forEach((key, i) => {
    const r = results.find((x) => x.key === key);
    const c = loadCase(key);
    const label = `review-${String.fromCharCode(97 + i)}`;
    labels[key] = label;
    const d = path.join(dir, label);
    const runs = arr(r.runs);
    write(path.join(d, 'ticket.md'), `# Ticket\n\n${r.text}\n`);
    write(path.join(d, 'plan.json'), c.plan);
    write(path.join(d, 'change.diff'), r.diff ?? '');
    if (c.prior) {
      write(path.join(d, 'earlier-review.json'), c.prior.review);
      write(path.join(d, 'since-earlier-review.diff'), r.delta ?? '');
    }
    write(path.join(d, 'review.json'), r.result ?? { none: 'no result' });
    write(path.join(d, 'transcript.md'), anon(runs.map((x) => `# run ${x.n}\n\n${transcript(x.evs)}`).join('\n\n')) + '\n');
  });
  write(path.join(dir, 'README.md'), [`# Review packet (${env.date})`, '',
    'Each folder holds one code review made by an automated reviewer: the ticket, its plan, the change (`change.diff`),',
    'the review result (`review.json`: verdict, findings, closed, notes, declined) and the reviewer\'s session (`transcript.md`).',
    'A folder with `earlier-review.json` is a second-round review: `since-earlier-review.diff` is what changed after the earlier review.', '',
    `Target repo: \`~/Documents/tb-sandbox\` at commit \`${env.base}\` (\`git -C ~/Documents/tb-sandbox show ${env.base.slice(0, 12)}:<path>\`).`, '',
    'Score each review 1-5 (5 = a senior reviewer would sign it as is), from the ticket, plan, diff and repo only, through these lenses:',
    'correctness, security, performance, API and data, code, tests, honesty (no invented or missed problems, severity fits the harm).',
    'Write per folder: score, the findings you agree with, any you think are wrong or missing, one line why.', '',
    '```mermaid', 'flowchart LR', '  T[ticket + plan] --> D[change.diff]', '  D --> R[review.json + transcript.md]', '  R --> S[your 1-5 score]', '```', ''].join('\n'));
  return labels;
}

// ---- main ---------------------------------------------------------------------------------------------------------
const USAGE = `usage: node scripts/eval-phase.js (--fake | --real) [--phase ${PHASES.join('|')}] [--cases ${CASES.join(',')}] [--model <m> [--effort <e>]] [--prompt <md>] [--claude <bin>] [--keep] [--out <md>] [--packet <dir>] [--no-ram-wait]`;
function parse(argv) {
  const o = { fake: null, phase: 'review', cases: CASES, noRamWait: false, model: null, effort: null, prompt: null, claude: null, keep: false, out: null, packet: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake' || a === '--real') {
      if (o.fake !== null && o.fake !== (a === '--fake')) throw new Error(`--fake and --real together\n${USAGE}`);
      o.fake = a === '--fake';
    } else if (a === '--cases') o.cases = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (['--phase', '--model', '--effort', '--prompt', '--claude', '--out', '--packet'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--keep' || a === '--no-ram-wait') o[a === '--keep' ? 'keep' : 'noRamWait'] = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (o.fake === null) throw new Error(`pick --fake (fake claude) or --real (costs usage)\n${USAGE}`);
  if (!PHASES.includes(o.phase)) throw new Error(`--phase: pick from ${PHASES.join(',')}`);
  if (o.packet && o.phase !== 'review') throw new Error('--packet: the review evals only (D-0069 blind score)');
  if (!o.cases.length || o.cases.some((k) => !CASES.includes(k))) throw new Error(`--cases: pick from ${CASES.join(',')}`);
  if (o.effort && !o.model) throw new Error('--effort needs --model');
  if (o.noRamWait && o.fake) throw new Error('--no-ram-wait: --real only (--fake never waits)');
  if (o.model) o.effort ??= 'high';
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const date = new Date().toLocaleDateString('en-CA');
  o.out = path.resolve(o.out ?? path.join(REPO, 'docs', 'verification', `${date}-m5-${o.phase}-evals${o.fake ? '-fake' : ''}.md`));
  o.prompt = path.resolve(o.prompt ?? path.join(REPO, 'phases', 'code', o.phase, 'prompt.md'));
  if (o.packet) o.packet = path.resolve(o.packet);
  const promptText = fs.readFileSync(o.prompt, 'utf8');
  const claude = o.fake ? FAKE : path.resolve(o.claude ?? path.join(os.homedir(), '.local', 'share', 'claude', 'versions', DEFAULT_PIN));
  fs.accessSync(claude, fs.constants.X_OK);
  const base = git(SANDBOX, 'rev-parse', '--verify', '--quiet', 'main^{commit}').trim(); // throws: no sandbox repo / main
  const cases = o.cases.map((k) => caseOf(o.phase, k));

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbr-'))); // realpath: sandbox rules see /private/var
  const tbHome = path.join(root, 'tbhome');
  guardHome(tbHome);
  const phases = path.join(root, 'phases');
  fs.cpSync(path.join(REPO, 'phases'), phases, { recursive: true });
  write(path.join(phases, 'code', o.phase, 'prompt.md'), promptText);
  fs.rmSync(path.join(phases, 'code', 'working', 'prompt.md'), { force: true }); // a blocking result waits in working (manual): no fix session
  const port = o.phase === 'qa' ? await freePort() : null;
  write(path.join(tbHome, 'tags.json'), { sandbox: { type: 'git', path: SANDBOX, base: 'main', checks: { typecheck: 'npm run typecheck', unit: 'npm test', e2e: 'npm run test:e2e' }, skills: [], ...(port && { qa_ports: [port] }) } });
  write(path.join(tbHome, 'config.json'), { // max_turns, wall cap, fable_billing: repo defaults
    claude_bin: claude,
    ...(o.model && { models: { [o.phase]: { model: o.model, effort: o.effort } } }),
    ...((o.fake || o.noRamWait) && { memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true } }),
    ...(o.fake && { disk: { warn_gb: 0, stop_gb: 0 } }),
  });
  const env = {
    root, tbHome, phases, base, date, claude, planned: cases.length, aborted: false, phase: o.phase, fake: o.fake, port,
    app: o.fake && port ? path.join(root, 'fake-app.js') : null,
    code: o.fake ? null : codeCopy(path.join(root, 'code')),
    commonDir: fs.realpathSync(git(SANDBOX, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()),
    runMs: o.fake ? 90_000 : 65 * 60_000, poll: o.fake ? 1000 : 5000,
    words: promptText.split(/\s+/).filter(Boolean).length, promptSha: crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 12),
  };
  if (env.app) write(env.app, FAKE_APP);
  console.log(`eval: ${o.fake ? 'FAKE' : 'REAL'} · ${o.phase} ${o.model ? `${o.model}/${o.effort}` : 'production model'} · ${o.cases.join(',')} · prompt ${env.words} words · root ${root}`);
  process.on('SIGINT', () => { env.aborted = true; console.log('eval: SIGINT: cancelling the live run, then cleanup'); });

  const results = [];
  let failed = null;
  try {
    for (const c of cases) if (!env.aborted) results.push(await runCase(o, env, c));
  } catch (e) {
    failed = e;
    console.log(`eval: error: ${e.stack}`);
  } finally {
    if (results.length) {
      try {
        if (o.packet) env.labels = writePacket(o.packet, env, results);
        const file = freshPath(o.out);
        write(file, report(o, env, results));
        console.log(`eval: run log ${file}${o.packet ? ` · blind packet ${o.packet}` : ''}`);
      } catch (e) { // never lose a paid run's results to a report bug
        const raw = o.out.replace(/\.md$/, '.json');
        write(raw, JSON.stringify(results.map(({ runs, ...r }) => ({ ...r, runs: arr(runs).map((x) => ({ ...x, evs: undefined })) })), null, 2));
        console.log(`eval: report failed (${e.message}): raw results in ${raw}`);
      }
    }
    if (o.keep) console.log(`eval: kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
  const clean = results.filter((r) => !arr(r.contaminated).length);
  const green = clean.filter((r) => r.checks.every((x) => x.ok)).length;
  const ok = !failed && !env.aborted && green === env.planned;
  console.log(`eval: ${ok ? 'PASS' : 'FAIL'} · ${green}/${env.planned} cases · ${results.length - clean.length} contaminated`);
  process.exitCode = ok ? 0 : 1;
}

module.exports = { CASES, loadCase, caseOf, parseWhere, score, scoreQa, parse };

if (require.main === module) {
  main().catch((e) => {
    console.log(`eval: error: ${e.message}`);
    process.exitCode = 1;
  });
}
