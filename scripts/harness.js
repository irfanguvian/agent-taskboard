'use strict';
// harness: the pieces the eval harnesses share (scripts/eval-phase.js, scripts/golden-working.js; build doc
// .omc/handoffs/r-build.md R-B): a free port, the memory level, a port holder, the process reaper, a ticket's cleanup,
// the --fake QA app and docs steps, the answer-key names, the D-0069 blind packet and the golden score JSON v1. It
// requires only node and lib/, never a script: the scripts require it, so no require cycle.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { GIT_SAFE, GIT_ENV, minimalEnv } = require('../lib/util');

// ponytail: the same four as scripts/eval-planner.js (a script: harness never requires one)
const SANDBOX = path.join(os.homedir(), 'Documents', 'tb-sandbox');
const arr = (v) => (Array.isArray(v) ? v : []);
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', [...GIT_SAFE, '-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...minimalEnv(process.env), ...GIT_ENV } });

const memLevel = () => Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).trim());
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => resolve(port)); });
});

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

// --fake final_gate: the agent's tool work as one exec step: the case's two docs written where its example says
function fakeDocs(env, c) {
  const f = (k) => path.join(env.root, `fake-${c.key}-${k}.md`);
  write(f('verdict'), c.docs.verdict);
  write(f('verification'), c.docs.verification);
  const { verdict_doc: v, verification_doc: w } = c.example;
  return { exec: ['/bin/sh', '-c', `mkdir -p '${path.dirname(v)}' '${path.dirname(w)}' && cp '${f('verdict')}' '${v}' && cp '${f('verification')}' '${w}'`] };
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

// only our own worktree goes (review, qa: detached; final_gate: + its branch tb/<id>-eval and refs/tb/<id>/*, the
// squash's final-pre-<n>); never main, never another ticket's
function cleanup(wt, branch = null, id = null) {
  const say = (what, e) => console.log(`eval: ${what}: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch (e) { say(`remove ${wt}`, e); } // a clone (H2), not a linked worktree
  if (!branch) return;
  if (git(SANDBOX, 'branch', '--list', branch).trim()) try { git(SANDBOX, 'branch', '-D', branch); } catch (e) { say(`branch -D ${branch}`, e); }
  for (const ref of git(SANDBOX, 'for-each-ref', '--format=%(refname)', `refs/tb/${id}/`).split('\n').filter(Boolean)) {
    try { git(SANDBOX, 'update-ref', '-d', ref); } catch (e) { say(`update-ref -d ${ref}`, e); }
  }
}

// The answer-key names (D-0059): golden-working contamination() looks for them in a run's tool calls, blindPacket in
// every packet file.
const LEAKS = ['test/golden', 'sandbox-traps', 'n1.e2e-spec', 'golden-working', 'planner-evals', '.omc/'];
const TMP = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])];
const TICKET_RE = /\bt_[0-9a-f]{6}\b/g; // word-bounded: get_feedback is never hit
// harness-written text only (README, labels, file names): agent-made text may say "expect" or "PASS"
const WORDS = [/golden|trap|fixture|expect|verdict|opus|sonnet|fable|haiku/i, /\b(?:PASS|FAIL)\b/];
const leakIn = (text, words) => LEAKS.find((s) => text.includes(s)) ?? TMP.find((s) => text.includes(s)) ?? text.match(TICKET_RE)?.[0]
  ?? words.map((re) => text.match(re)?.[0]).find(Boolean);
const ITEM_MAX = 1024 * 1024;

// D-0069 blind packet. items [{key, files: {name: text | JSON value}}] → dir/README.md (neutral 1-5, the 7 lenses, the
// repo at base) + one folder per item under a shuffled neutral label (<prefix>-a, -b, ...); labelsFile (outside dir,
// never scanned) gets {key: label}. Each item file: anon first (root → <tmp>, home → ~, ticket ids → <ticket>), then the
// leak scan: agent-made text (diff, transcript, results, ticket) for harness-identity tokens (LEAKS, a temp path, a
// ticket id); harness-written text (README, labels, file names) for those + the WORDS + a whole-word case key. A hit,
// labelsFile inside dir, a file over 1 MB: throw before the first write, so nothing is written (a dir that was already
// there is left as it was, never removed). → {key: label}
function blindPacket(dir, items, { base, archive = './repo-at-base/', labelsFile = null, root = null, prefix = 'item',
  intro = 'Each folder holds one change: the ticket (`ticket.md`) and the change (`change.diff`).' }) {
  dir = path.resolve(dir);
  const rel = labelsFile ? path.relative(dir, path.resolve(labelsFile)) : '..';
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) throw new Error(`blind packet: the labels file must lie outside ${dir}`);
  const anon = (s) => (root ? s.replaceAll(root, '<tmp>') : s).replaceAll(os.homedir(), '~').replace(TICKET_RE, '<ticket>');
  const order = items.map((x) => [crypto.randomInt(2 ** 32), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); // shuffled
  const labels = {};
  const files = [];
  order.forEach((it, i) => {
    labels[it.key] = `${prefix}-${String.fromCharCode(97 + i)}`; // ponytail: a-z, a packet holds a handful of items
    for (const [name, v] of Object.entries(it.files)) {
      if (!/^\w[\w.-]*$/.test(name)) throw new Error(`blind packet: ${it.key}: file name ${JSON.stringify(name)} is not a plain name`);
      const text = anon(typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');
      if (Buffer.byteLength(text) > ITEM_MAX) throw new Error(`blind packet: ${it.key} ${name}: diff too big for blind scoring (${Buffer.byteLength(text)} bytes > 1 MB)`);
      const hit = leakIn(text, []);
      if (hit) throw new Error(`blind packet: ${it.key} ${name} holds ${JSON.stringify(hit)}`);
      files.push([path.join(dir, labels[it.key], name), text]);
    }
  });
  const readme = ['# Scoring packet', '', intro, '', `The repo before the change: \`${archive}\` at commit \`${base}\`.`, '',
    'Score each folder 1-5 (1 lowest, 5 highest), from its files and the repo only, through these lenses:',
    'correctness, security, performance, API and data, code, tests, honesty.', 'Write per folder: the score and one line why.', ''].join('\n');
  const own = [readme, ...Object.values(labels), ...files.map(([f]) => path.basename(f))].join('\n');
  const words = new Set(own.split(/[^\w-]+/));
  const hit = leakIn(own, WORDS) ?? items.map((x) => x.key).find((k) => words.has(k));
  if (hit) throw new Error(`blind packet: harness text holds ${JSON.stringify(hit)}`);
  for (const [f, text] of files) write(f, text);
  write(path.join(dir, 'README.md'), readme);
  if (labelsFile) write(labelsFile, labels);
  return labels;
}

// Golden score JSON v1 (frozen; M7 `tb eval golden --record` reads it). results [{id: '<source>:<case>', run, stop,
// checks: [{ok}], contaminated: hits[] or bool, fix_rounds, rework, cost_micro (integer micro-USD), min, blind: null or
// {scores: 2 or 3 reviewer scores 1-5}}]; meta {commit, sandbox_base (40 hex), mode real|dry, sources, at?}. blind.score =
// the lower of 2 (a spread ≥ 2 needs a 3rd reviewer: refused), the median of 3; pass = score ≥ 4. Top pass: 1+ case and
// every case: all checks pass, not contaminated, blind null or pass. Throws on a bad meta, cost or score.
function scoreJson(results, meta) {
  const sha = /^[0-9a-f]{40}$/;
  if (!sha.test(meta.commit) || !sha.test(meta.sandbox_base) || !['real', 'dry'].includes(meta.mode)) throw new Error('score json: commit and sandbox_base 40 hex, mode real or dry');
  const blind = (b) => {
    if (b == null) return null;
    const s = arr(b.scores);
    const [lo, mid] = [...s].sort((x, y) => x - y);
    if (![2, 3].includes(s.length) || !s.every((x) => Number.isInteger(x) && x >= 1 && x <= 5)) throw new Error(`score json: blind scores must be 2 or 3 integers 1-5, got ${JSON.stringify(b.scores)}`);
    if (s.length === 2 && Math.abs(s[0] - s[1]) >= 2) throw new Error(`score json: blind scores ${s.join(', ')}: a spread of 2 or more needs a 3rd reviewer`);
    const score = s.length === 2 ? lo : mid;
    return { scores: s, score, pass: score >= 4 };
  };
  const cases = results.map((r) => {
    if (!Number.isInteger(r.cost_micro) || r.cost_micro < 0) throw new Error(`score json: ${r.id}: cost_micro must be an integer (micro-USD), got ${r.cost_micro}`);
    return { id: r.id, run: r.run, stop: r.stop, checks: { pass: arr(r.checks).filter((x) => x.ok).length, total: arr(r.checks).length },
      contaminated: r.contaminated === true || arr(r.contaminated).length > 0, fix_rounds: r.fix_rounds, rework: r.rework, cost_micro: r.cost_micro, min: r.min, blind: blind(r.blind) };
  });
  return { v: 1, kind: 'golden-score', at: meta.at ?? new Date().toISOString(), commit: meta.commit, sandbox_base: meta.sandbox_base, mode: meta.mode, sources: meta.sources,
    cases, pass: cases.length > 0 && cases.every((c) => c.checks.pass === c.checks.total && !c.contaminated && (!c.blind || c.blind.pass)) };
}

module.exports = { memLevel, freePort, FAKE_APP, fakeExec, fakeDocs, hold, killIn, cleanup, LEAKS, blindPacket, scoreJson };
