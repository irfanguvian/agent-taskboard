'use strict';
// P5b-run integration (contract rev 4.1 K5 K7 K8 K9 K12 M1 M5 M6 M11 R2 RO2 N3 D34, Rules t:gate / output /
// persistence): lib/gates against the real /usr/bin/sandbox-exec (the v2 profile), a real in-process slot server +
// bin/tbx heavy, real git worktrees in a temp TB_HOME. package.json scripts are node one-liners (no npm install).
// HOME and TB_HOME are temp dirs, set before any lib/ module loads: never the real home, ~/.taskboard or port 7777.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

for (const k of ['TBD_SOCK', 'TBX_LEASE', 'TBX_RUN', 'TB_PORT']) delete process.env[k];
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-')));
process.env.HOME = path.join(ROOT, 'h');
process.env.TB_HOME = path.join(ROOT, 'tb');
fs.mkdirSync(path.join(ROOT, 'h', '.npm', '_logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'h', '.ssh'));
fs.writeFileSync(path.join(ROOT, 'h', '.ssh', 'id_test'), 'FAKE-SSH-KEY\n');
fs.mkdirSync(process.env.TB_HOME);
fs.writeFileSync(path.join(process.env.TB_HOME, 'token'), 'FAKE-TBD-TOKEN\n');

const store = require('../lib/store');
const { createSlots } = require('../lib/slots');
const { createMonitor } = require('../lib/monitor');
const planning = require('../lib/planning');
const gates = require('../lib/gates');
const R = require('../lib/gates/run');
const { GATE_FIELDS } = require('../lib/metrics');

const TB = process.env.TB_HOME;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { encoding: 'utf8', env: GIT_ENV }).trim();
const sha = (plan) => crypto.createHash('sha256').update(planning.canon(plan)).digest('hex');
const ask = () => new AbortController().signal;
let slots;
before(async () => {
  store.init();
  slots = createSlots({ tbHome: TB, config: {}, kill: () => {}, exec: async () => ({ err: null, stdout: '', stderr: '' }) }); // "tbd" = this process
  await slots.start();
});
after(async () => {
  await slots.stop();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const timeouts = (o) => { store.config.gates = { ...store.config.gates, timeout_min: { ...store.config.gates.timeout_min, ...o } }; };

function put(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    if (c === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    }
  }
}
function commit(cwd, msg = 'change') {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}
const PKG = { name: 'fx', version: '1.0.0', scripts: { test: 'node --test', 'test:fake': 'node fake.js' } };
const SUM = 'module.exports = (a, b) => 0;\n';
const SUM_OK = 'module.exports = (a, b) => a + b;\n';
const SUM_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst sum = require('../lib/sum.js');\ntest('adds', () => assert.equal(sum(1, 2), 3));\n";
// fake.js: a test runner printing out.txt, exiting with code.txt (a jest-shaped output at will)
const FAKE = "const fs = require('node:fs'); process.stdout.write(fs.readFileSync('out.txt', 'utf8')); process.exitCode = Number(fs.readFileSync('code.txt', 'utf8'));\n";
// FLIP: as FAKE, but exit 0 from its 2nd run in this gate on (TMPDIR is the gate's)
const FLIP = "const fs = require('node:fs'); const f = require('node:path').join(process.env.TMPDIR, 'flip'); process.stdout.write(fs.readFileSync('out.txt', 'utf8')); process.exitCode = fs.existsSync(f) ? 0 : Number(fs.readFileSync('code.txt', 'utf8')); fs.writeFileSync(f, '');\n";

let seq = 0;
// A repo (main = base) + a ticket worktree on tb/<id>-x under TB_HOME/worktrees. task: plan task T1.
function world({ files = {}, tag = {}, task = {}, plan: planExtra = {} } = {}) {
  const id = `t_${String(++seq).padStart(6, '0')}`;
  const repo = path.join(ROOT, `repo-${seq}`);
  put(repo, { 'package.json': JSON.stringify(PKG), 'lib/sum.js': SUM, 'fake.js': FAKE, 'out.txt': 'Tests:       1 passed, 1 total\n', 'code.txt': '0', '.gitignore': 'openapi.json\nignored.txt\nprobe/\nnode_modules/\n', ...files });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'base');
  const wt = path.join(TB, 'worktrees', id);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `tb/${id}-x`, wt, 'main');
  const base = git(wt, 'rev-parse', 'HEAD');
  const T1 = { id: 'T1', title: 't', type: 'preserve', files: ['lib/sum.js', 'test/sum.test.js', 'out.txt', 'code.txt'], modules: [], test_cmd: 'npm test', acceptance: [], steps: [], ...task };
  const plan = { summary: 's', acceptance: [], tasks: [T1], allowed_schema_changes: [], allowed_api_changes: [], skills: [], ui: false, children: [], ...planExtra };
  const t = { id, tag: `acme/w${seq}`, worktree: wt, base_sha: base, branch: `tb/${id}-x`, plan_hash: sha(plan),
    work: { task: 'T1', tasks: [{ id: 'T1', status: 'gating', attempt: 1, pre: base, head: null, commit: null, session: null }], tries: 0, gate: null } };
  fs.mkdirSync(store.ticketDir(id), { recursive: true });
  const def = { path: repo, type: 'git', base: 'main', ...tag };
  const saves = [];
  const w = {
    id, repo, wt, base, t, tag: def, plan, saves,
    head: () => git(wt, 'rev-parse', 'HEAD'),
    commit: (f, msg) => { put(wt, f); return commit(wt, msg); },
    read: (f) => fs.readFileSync(path.join(wt, f), 'utf8'),
    save: async (p) => { saves.push({ ...p, sum: fs.readFileSync(path.join(wt, 'lib/sum.js'), 'utf8') }); return true; },
    gatesDir: () => path.join(store.ticketDir(id), 'gates'),
    json: () => (fs.existsSync(w.gatesDir()) ? fs.readdirSync(w.gatesDir()).filter((f) => /^\d+\.json$/.test(f)).sort() : []),
    task: (o = {}) => gates.runTaskGate({
      t, task: plan.tasks[0], wt, pre: base, head: w.head(), plan, tag: def, out: { commit: w.head(), tests: [] }, allow: [], unitMs: null,
      baseChecks: {}, integrity: { ok: true }, save: w.save, onSpawn: () => {}, signal: ask(), ...o,
    }),
    working: (o = {}) => gates.runWorkingGate({ t: { ...t, work: { ...t.work, task: null } }, wt, base, head: w.head(), plan, tag: def, allow: [], baseChecks: {}, integrity: { ok: true }, save: w.save, onSpawn: () => {}, signal: ask(), ...o }),
  };
  return w;
}
const metricLines = (id) => fs.readFileSync(path.join(TB, 'metrics.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === 'gate' && l.ticket === id);

// ---- task gate: green path, persistence, t:gate ----------------------------------------------------------------------
test('task gate green (preserve): sandboxed test_cmd + unit pass; gates/01.json written atomically; one t:gate line per check with every contract field', async () => {
  const w = world({ tag: { checks: { typecheck: 'node -e "process.exit(0)"', unit: 'node -e "console.log(\'unit ok\')"' } } });
  w.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const seen = [];
  const r = await w.task({ onCheck: (e) => seen.push(e) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.class, r.n], [null, 1]);
  assert.deepEqual(r.checks.map((c) => [c.check, c.ok]), [['typecheck', true], ['test_cmd', true], ['unit', true]]);
  assert.deepEqual(seen, r.checks.map((c) => ({ check: c.check, ok: c.ok })), 'onCheck (the SSE gate event) once per finished check, in order');
  assert.equal(r.tests.failfirst, 'n/a');
  assert.deepEqual(r.tests.files, ['test/sum.test.js']);
  assert.deepEqual(w.json(), ['01.json']);
  const saved = JSON.parse(fs.readFileSync(path.join(w.gatesDir(), '01.json'), 'utf8'));
  assert.deepEqual([saved.v, saved.gate, saved.task, saved.head, saved.pre, saved.plan_hash], [1, 'task', 'T1', w.head(), w.base, w.t.plan_hash]);
  assert.ok(fs.existsSync(path.join(store.ticketDir(w.id), saved.checks[1].log)), 'the test_cmd log is kept');
  assert.match(zlib.gunzipSync(fs.readFileSync(path.join(store.ticketDir(w.id), saved.checks[1].log))).toString(), /ℹ pass 1/);
  assert.ok(w.saves.some((s) => Number.isInteger(s.proc?.pid) && s.proc.lstart), 'proc {pid, lstart} saved for each check');
  const lines = metricLines(w.id);
  assert.deepEqual(lines.map((l) => l.check), ['typecheck', 'test_cmd', 'unit']);
  for (const l of lines) assert.deepEqual(Object.keys(l), ['t', 'at', ...GATE_FIELDS]);
  assert.deepEqual([lines[1].gate, lines[1].task, lines[1].ok, lines[1].exit, lines[1].class, lines[1].head, lines[1].attempt, lines[1].flaky], ['task', 'T1', true, 0, null, w.head(), 1, false]);
  assert.ok(lines.every((l) => Number.isInteger(l.ms) && Number.isInteger(l.slot_wait_ms)));
  const thrown = await w.task({ onCheck: () => { throw new Error('ui down'); } });
  assert.deepEqual([thrown.ok, thrown.class, thrown.checks.map((c) => [c.check, c.ok])], [r.ok, r.class, r.checks.map((c) => [c.check, c.ok])], 'a throwing onCheck changes nothing');
});

test('t:gate peak_rss_mb comes from the monitor sample of the check\'s process tree (no timer of the gate\'s own)', async () => {
  const mon = createMonitor({ config: store.config, connect: async () => false, intervalMs: 100 });
  mon.start();
  try {
    const w = world({ tag: { checks: { unit: 'node -e "setTimeout(() => {}, 1500)"' } } });
    w.commit({ 'lib/sum.js': SUM_OK });
    assert.equal((await w.task()).ok, true);
    const unit = metricLines(w.id).find((l) => l.check === 'unit');
    assert.ok(Number.isInteger(unit.peak_rss_mb) && unit.peak_rss_mb > 0, `peak_rss_mb ${unit.peak_rss_mb}`);
  } finally {
    mon.stop();
  }
});

// ---- the sandbox is really applied -------------------------------------------------------------------------------------
test('K5 sandbox: a check reading a fake secret (HOME/.ssh, the tbd token) or writing outside is denied; worktree writes and the control port work; tag deny_ports blocked', async () => {
  const srv = (await Promise.all([0, 0].map(() => new Promise((res) => { const s = net.createServer((c) => c.end()).listen(0, '127.0.0.1', () => res(s)); }))));
  const [denied, open] = srv.map((s) => s.address().port);
  const connect = (p) => `node -e "require('net').connect(${p}, '127.0.0.1').on('connect', () => { console.log('C${p}'); process.exit(0); }).on('error', (e) => { console.log('E${p}', e.code); process.exit(0); })"`;
  const probe = [
    `cat "${process.env.HOME}/.ssh/id_test" || echo SSH-DENIED`, `cat "${TB}/token" || echo TOKEN-DENIED`,
    `touch "${ROOT}/outside.txt" || echo OUTSIDE-DENIED`, 'echo in > ignored.txt && cat ignored.txt', connect(denied), connect(open),
    "mkdir -p probe && printf '#!/bin/sh\\necho SHEBANG-RAN\\n' > probe/x.sh && chmod +x probe/x.sh; probe/x.sh; echo \"shebang rc=$?\"",
  ].join('; ');
  try {
    const w = world({ tag: { checks: { unit: probe }, deny_ports: [denied] } });
    w.commit({ 'lib/sum.js': SUM_OK });
    const r = await w.task();
    const out = r.checks.find((c) => c.check === 'unit').tail;
    assert.match(out, /SSH-DENIED/);
    assert.match(out, /TOKEN-DENIED/);
    assert.match(out, /OUTSIDE-DENIED/);
    assert.doesNotMatch(out, /FAKE-SSH-KEY|FAKE-TBD-TOKEN/);
    assert.equal(fs.existsSync(path.join(ROOT, 'outside.txt')), false);
    assert.match(out, /^in$/m);
    assert.match(out, new RegExp(`E${denied} EPERM`));
    assert.match(out, /shebang rc=126/, 'no exec from the worktree (only its node_modules)');
    assert.doesNotMatch(out, /SHEBANG-RAN/);
    assert.match(out, new RegExp(`C${open}`));
  } finally {
    srv.forEach((s) => s.close());
  }
});

// ---- output caps + redaction -------------------------------------------------------------------------------------------
test('output: 5 MB of output → tail ≤ 4 KB (head 1 KB + tail 3 KB), log .gz ≤ 1 MB ending with the tail; env_files values redacted, also split across writes', async () => {
  const big = "node -e \"process.stdout.write(require('crypto').randomBytes(3900000).toString('base64')); process.stdout.write('\\nSECRETV'); setTimeout(() => { process.stdout.write('ALUE-123 end\\n'); process.exitCode = 1; }, 200)\"";
  const w = world({ files: { '.env.test': 'API_TOKEN="SECRETVALUE-123"\nexport OTHER=x\n' }, tag: { env_files: ['.env.test'], checks: { typecheck: big } } });
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.task();
  const c = r.checks.find((x) => x.check === 'typecheck');
  assert.equal(c.ok, false);
  assert.ok(Buffer.byteLength(c.tail) <= 4096, `tail ${Buffer.byteLength(c.tail)} bytes`);
  assert.match(c.tail, /\[…\]/, 'head + tail, cut in the middle');
  assert.match(c.tail, /\[redacted\] end/);
  assert.doesNotMatch(c.tail + r.why, /SECRETVALUE/);
  const gz = fs.readFileSync(path.join(store.ticketDir(w.id), c.log));
  assert.ok(gz.length <= 1 << 20, `log ${gz.length} bytes`);
  const text = zlib.gunzipSync(gz).toString();
  assert.match(text, /bytes cut here; the last 3 KB follow/);
  assert.match(text, /\[redacted\] end\n$/);
  assert.doesNotMatch(text, /SECRETVALUE/);
});

// ---- classification (K12) -----------------------------------------------------------------------------------------------
test('K12 classify: timer timeout with base_ms in budget → work; no base number for a tag check → infra; test_cmd timeout → work; self exit 124 and sh 127 → work', async () => {
  timeouts({ unit: 0.02, test_cmd: 0.02 }); // 1.2 s
  try {
    const w = world({ tag: { checks: { unit: 'sleep 20' } } });
    w.commit({ 'lib/sum.js': SUM_OK });
    const t0 = Date.now();
    const inBudget = await w.task({ baseChecks: { unit: { ok: true, ms: 100 } } });
    assert.ok(Date.now() - t0 < 15_000, 'the timer ended it');
    assert.deepEqual([inBudget.class, inBudget.checks.at(-1).timed_out], ['work', true]);
    const noBase = await w.task();
    assert.equal(noBase.class, 'infra');
    timeouts({ unit: 20 });
    const w1 = world({ tag: { checks: { unit: 'sleep 20' }, timeout_min: { unit: 0.02 } } });
    w1.commit({ 'lib/sum.js': SUM_OK });
    const byTag = await w1.task({ baseChecks: { unit: { ok: true, ms: 100 } } });
    assert.deepEqual([byTag.class, byTag.checks.at(-1).timed_out], ['work', true], 'the tag\'s timeout_min wins over config');
    const w2 = world({ files: { 'package.json': JSON.stringify({ ...PKG, scripts: { ...PKG.scripts, 'test:slow': 'sleep 20' } }) }, task: { test_cmd: 'npm run test:slow' } });
    w2.commit({ 'lib/sum.js': SUM_OK });
    const slow = await w2.task();
    assert.deepEqual([slow.class, slow.checks.at(-1).check, slow.checks.at(-1).timed_out], ['work', 'test_cmd', true]);
  } finally {
    timeouts({ unit: 20, test_cmd: 20 });
  }
  const w3 = world({ tag: { checks: { unit: 'exit 124' } } });
  w3.commit({ 'lib/sum.js': SUM_OK });
  const self = await w3.task();
  assert.deepEqual([self.class, self.checks.at(-1).exit, self.checks.at(-1).timed_out], ['work', 124, false], 'a test exiting 124 is no timeout');
  const w4 = world({ tag: { checks: { typecheck: 'no-such-command-xyz' } } });
  w4.commit({ 'lib/sum.js': SUM_OK });
  const sh127 = await w4.task();
  assert.deepEqual([sh127.class, sh127.checks[0].exit], ['work', 127], 'exit 127 from sh is the agent\'s');
});

test('K12 classify: the top argv missing (spawn ENOENT) → infra, without running anything', async () => {
  const w = world();
  const ctx = await R.open({ t: w.t, wt: w.wt, tag: w.tag, gate: 'task', task: { id: 'T1' }, head: w.base });
  try {
    const c = await R.run(ctx, { check: 'unit', argv: [path.join(ROOT, 'no', 'such', 'binary')] });
    assert.deepEqual([c.ok, c.class, c.log], [false, 'infra', null]);
  } finally {
    await R.close(ctx);
  }
});

test('K12 interrupted: abort (memory) kills the running check at once → class interrupted, GateResult kept; abort (cancel) → nothing written', async () => {
  for (const reason of ['memory', 'cancel']) {
    const w = world({ tag: { checks: { unit: 'sleep 30' } }, task: { test_cmd: null } }); // unit alone: the abort hits it running
    w.commit({ 'lib/sum.js': SUM_OK });
    const ac = new AbortController();
    const started = new Promise((res) => { w.save = async (p) => { if (p.proc) setTimeout(res, 800); return true; }; });
    const t0 = Date.now();
    const p = w.task({ signal: ac.signal, save: (x) => w.save(x) });
    await started;
    ac.abort(reason);
    const r = await p;
    assert.ok(Date.now() - t0 < 8000, `ended ${Date.now() - t0} ms after start`);
    assert.deepEqual([r.ok, r.class, r.checks.map((c) => c.check)], [false, 'interrupted', ['unit']], reason);
    assert.notEqual(r.checks[0].exit, 0, 'the running check was killed');
    assert.deepEqual(w.json(), reason === 'cancel' ? [] : ['01.json'], reason);
    assert.deepEqual(metricLines(w.id).map((l) => [l.check, l.class]), reason === 'cancel' ? [] : [['unit', 'interrupted']], 'the check itself is interrupted (signal first), its t:gate line says so; a cancel writes none');
  }
});

test('M1 integrity passthrough: integrity {ok:false} → class integrity before any command (no heavy check, no t:gate heavy line)', async () => {
  const w = world({ tag: { checks: { unit: 'echo should-not-run' } } });
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.task({ integrity: { ok: false, why: 'node_modules/.bin links changed since setup' } });
  assert.deepEqual([r.ok, r.class], [false, 'integrity']);
  assert.match(r.why, /\.bin links changed/);
  assert.deepEqual(r.checks.map((c) => c.check), ['integrity']);
  const good = await w.task();
  assert.equal(good.ok, true, 'positive: the same tree with integrity ok passes');
});

test('plan_hash mismatch → config; D34 AI trailer in pre..HEAD → work red', async () => {
  const w = world();
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.task({ plan: { ...w.plan, summary: 'edited after approval' } });
  assert.deepEqual([r.class, r.checks[0].check], ['config', 'plan']);
  w.commit({ 'out.txt': 'Tests:       2 passed, 2 total\n' }, 'more\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const tr = await w.task();
  assert.deepEqual([tr.class, tr.checks.at(-1).check], ['work', 'trailer']);
  assert.match(tr.why, /AI attribution/);
});

// ---- flaky (M11) -------------------------------------------------------------------------------------------------------
test('M11 flaky: a red unit passing on its one rerun → ok, flaky:true; the same flip on typecheck stays red (no rerun)', async () => {
  const flip = 'f="$TMPDIR/flip-$0"; if [ -e "$f" ]; then exit 0; fi; : > "$f"; echo first red; exit 1';
  const w = world({ tag: { checks: { unit: `sh -c '${flip}' u` } } });
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.task();
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.checks.filter((c) => c.check === 'unit').map((c) => [c.ok, c.flaky]), [[true, true]]);
  assert.deepEqual(metricLines(w.id).filter((l) => l.check === 'unit').map((l) => [l.ok, l.flaky]), [[false, false], [true, true]]);
  const w2 = world({ tag: { checks: { typecheck: `sh -c '${flip}' t` } } });
  w2.commit({ 'lib/sum.js': SUM_OK });
  const tc = await w2.task();
  assert.deepEqual([tc.ok, tc.class, tc.checks.filter((c) => c.check === 'typecheck').length], [false, 'work', 1]);
});

// ---- scope + protected + deps (M6, R2, RO2) ------------------------------------------------------------------------------
test('M6 scope: a file outside files/modules → ask scope; modules match by path segment (src/users ≠ src/users-admin); an allow widens; generated globs pass', async () => {
  const w = world({ task: { modules: ['src/users'] }, tag: { generated: ['gen/**'] } });
  w.commit({ 'lib/sum.js': SUM_OK, 'src/users/a.js': '1\n', 'gen/x/y.js': '1\n' });
  assert.equal((await w.task()).ok, true, 'module + generated in scope');
  w.commit({ 'src/users-admin/b.js': '1\n', 'README.md': 'x\n' });
  const r = await w.task();
  assert.deepEqual([r.ok, r.class, r.ask?.kind, r.ask?.files], [false, 'scope', 'scope', ['README.md', 'src/users-admin/b.js']]);
  assert.deepEqual(r.scope.outside, ['README.md', 'src/users-admin/b.js']);
  assert.equal(r.checks.some((c) => c.check === 'test_cmd'), false, 'no command ran');
  const ok = await w.task({ allow: [{ path: 'README.md' }, { path: 'src/users-admin/b.js' }] });
  assert.equal(ok.ok, true, ok.why);
});

test('M6 bad: a symlink, a force-added ignored file, a path that is not UTF-8, a deleted file outside scope; history rewrite (pre not an ancestor) and a branch switch → work', async () => {
  const w = world();
  fs.symlinkSync('/etc/hosts', path.join(w.wt, 'lib', 'link'));
  put(w.wt, { 'ignored.txt': 'x\n' });
  git(w.wt, 'add', '-f', 'ignored.txt', 'lib/link');
  git(w.wt, 'update-index', '--add', '--cacheinfo', `160000,${w.base},vendor/sub`); // a gitlink: no add -A after it
  const notUtf8 = Buffer.concat([Buffer.from(`100644 ${git(w.wt, 'rev-parse', 'HEAD:lib/sum.js')}\ttest/a`), Buffer.from([0xfe]), Buffer.from('.test.js\n')]);
  execFileSync('/usr/bin/git', ['-C', w.wt, 'update-index', '--add', '--index-info'], { input: notUtf8, env: GIT_ENV }); // APFS refuses the name; git keeps it
  git(w.wt, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'bad entries');
  const head = w.head();
  const r = await w.task({ task: { ...w.plan.tasks[0], files: ['lib/link', 'ignored.txt', 'vendor/sub'] }, head, out: { commit: head, tests: [] } });
  assert.deepEqual([r.class, r.scope.bad.sort()], ['work', ['a path that is not UTF-8: "test/a\uFFFD.test.js"', 'gitlink (submodule): vendor/sub', 'ignored file force-added: ignored.txt', 'symlink: lib/link']]);
  const w2 = world();
  w2.commit({ 'fake.js': null });
  const del = await w2.task();
  assert.deepEqual([del.class, del.ask?.files], ['scope', ['fake.js']], 'a deletion is a change too');
  const w3 = world();
  w3.commit({ 'lib/sum.js': SUM_OK });
  git(w3.wt, 'checkout', '-q', '--orphan', 'other');
  const orphan = commit(w3.wt, 'rewritten');
  git(w3.wt, 'branch', '-q', '-f', `tb/${w3.id}-x`, orphan);
  git(w3.wt, 'checkout', '-q', `tb/${w3.id}-x`);
  const hist = await w3.task();
  assert.deepEqual([hist.class, hist.checks.at(-1).check], ['work', 'history']);
  assert.match(hist.why, /not an ancestor of HEAD/);
  const w4 = world();
  w4.commit({ 'lib/sum.js': SUM_OK });
  git(w4.wt, 'checkout', '-q', '-b', 'elsewhere');
  const sw = await w4.task();
  assert.match(sw.why, /not branch tb\//);
  const w5 = world({ tag: { env_files: ['.env.test'] }, task: { files: ['lib/sum.js', '.env.test'] } });
  put(w5.wt, { '.env.test': 'K=secret-value\n' });
  git(w5.wt, 'add', '-f', '.env.test');
  w5.commit({ 'lib/sum.js': SUM_OK });
  assert.deepEqual((await w5.task()).scope.bad, ['env file in a commit (a secret): .env.test']);
});

test('R2 + RO2: package.json scripts changed → ask protected before any command; a dependency or lockfile → ask deps; a blob-bound allow passes, a later change asks again', async () => {
  const w = world({ tag: { checks: { unit: 'echo should-not-run' } } });
  w.commit({ 'package.json': JSON.stringify({ ...PKG, scripts: { ...PKG.scripts, test: 'node -e 0' } }) });
  const r = await w.task();
  assert.deepEqual([r.class, r.ask?.kind, r.ask?.files, r.scope.deps], ['protected', 'protected', ['package.json'], false]);
  assert.equal(r.checks.some((c) => !['protected'].includes(c.check)), false, 'no heavy check before the ask');
  assert.equal(metricLines(w.id).some((l) => l.check === 'unit'), false);
  const blob = git(w.wt, 'rev-parse', 'HEAD:package.json');
  const allowed = await w.task({ allow: [{ path: 'package.json', blob }] });
  assert.deepEqual([allowed.ok, allowed.scope.protected], [true, []], allowed.why);
  w.commit({ 'package.json': JSON.stringify({ ...PKG, scripts: { ...PKG.scripts, test: 'node -e 1' } }) });
  assert.equal((await w.task({ allow: [{ path: 'package.json', blob }] })).class, 'protected', 'a newer blob asks again');
  const w2 = world();
  w2.commit({ 'package.json': JSON.stringify({ ...PKG, dependencies: { 'left-pad': '1.3.0' } }) });
  const d = await w2.task();
  assert.deepEqual([d.class, d.ask?.kind, d.scope.deps], ['deps', 'deps', true]);
  const w3 = world({ files: { 'package-lock.json': '{}\n' } });
  w3.commit({ 'package-lock.json': '{"lockfileVersion":3}\n' });
  assert.equal((await w3.task()).ask?.kind, 'deps');
});

test('R2 scripts (every package.json, whatever the tag protects): a pretest, a nested posttest, deps + scripts in one commit → one ask naming "scripts changed"', async () => {
  const pk = (s, extra = {}) => JSON.stringify({ ...PKG, scripts: { ...PKG.scripts, ...s }, ...extra });
  const w = world({ tag: { protected: ['test/helpers/**'] }, task: { files: ['lib/sum.js', 'package.json'] } });
  w.commit({ 'package.json': pk({ pretest: 'echo PRETEST-RAN' }) });
  const r = await w.task();
  assert.deepEqual([r.class, r.ask?.kind], ['protected', 'protected']);
  assert.match(r.why, /scripts changed: package\.json \(pretest\)/);
  assert.doesNotMatch(r.checks.map((c) => c.tail).join(''), /PRETEST-RAN/, 'asked before any command');
  const w2 = world({ files: { 'pkg/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'echo a' } }) }, task: { files: ['lib/sum.js', 'pkg/a/package.json'] } });
  w2.commit({ 'pkg/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'echo a', posttest: 'echo POST' } }) });
  assert.match((await w2.task()).ask?.reason ?? '', /scripts changed: pkg\/a\/package\.json \(posttest\)/);
  const w3 = world({ task: { files: ['lib/sum.js', 'package.json'] } });
  w3.commit({ 'package.json': pk({ pretest: 'echo SNEAKY', install: 'echo ROOT' }, { dependencies: { 'left-pad': '1.3.0' } }) });
  const both = await w3.task();
  assert.deepEqual([both.class, both.ask?.kind, both.scope.deps], ['deps', 'deps', true]);
  assert.match(both.ask?.reason ?? '', /dependency change: package\.json[\s\S]*scripts changed: package\.json \(install, pretest\)/);
});

test('R2 config files (owner 2026-10-10): a NEW .npmrc or jest.config.js → protected even when the task lists it; a new test/helpers file stays allowed', async () => {
  const w = world({ task: { files: ['lib/sum.js', '.npmrc'] } });
  w.commit({ 'lib/sum.js': SUM_OK, '.npmrc': 'registry=https://evil.invalid/\n' });
  assert.deepEqual([(await w.task()).class], ['protected']);
  const w2 = world({ task: { files: ['lib/sum.js', 'jest.config.js'] } });
  w2.commit({ 'lib/sum.js': SUM_OK, 'jest.config.js': 'module.exports = { passWithNoTests: true };\n' });
  assert.deepEqual((await w2.task()).ask?.files, ['jest.config.js']);
  const w3 = world({ task: { files: ['lib/sum.js', 'test/helpers/util.js'] } });
  w3.commit({ 'lib/sum.js': SUM_OK, 'test/helpers/util.js': 'module.exports = 1;\n' });
  assert.equal((await w3.task()).ok, true, 'a new helper file is no change to an existing one');
});

// ---- test weakening (M5+N7) ----------------------------------------------------------------------------------------------
test('M5 weakening: an added .skip, a deleted test file, a static test count drop → work red "TEST_DISPUTES_SPEC"; removed expects only listed', async () => {
  const two = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('a', () => assert.ok(1));\ntest('b', () => assert.ok(1));\n";
  const files = { 'test/a.test.js': two, 'test/b.test.js': two };
  const task = { files: ['lib/sum.js', 'test/a.test.js', 'test/b.test.js'] };
  const w = world({ files, task });
  w.commit({ 'test/a.test.js': two.replace("test('b'", "test.skip('b'") });
  const skip = await w.task();
  assert.deepEqual([skip.class, skip.tests.skips_added], ['work', ['test/a.test.js: .skip']]);
  assert.match(skip.why, /TEST_DISPUTES_SPEC/);
  const w2 = world({ files, task });
  w2.commit({ 'test/b.test.js': null });
  assert.deepEqual((await w2.task()).tests.deleted, ['test/b.test.js']);
  const w3 = world({ files, task });
  w3.commit({ 'test/a.test.js': "const test = require('node:test');\ntest('a', () => {});\n" });
  const drop = await w3.task();
  assert.deepEqual([drop.class, drop.tests.count_drops.length], ['work', 1]);
  assert.match(drop.tests.count_drops[0], /^test\/a\.test\.js: 2 /);
  const withExpect = "const test = require('node:test');\nconst expect = (x) => ({ toBe: () => x });\ntest('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n";
  const w4 = world({ files: { 'test/a.test.js': withExpect }, task });
  w4.commit({ 'test/a.test.js': withExpect.replace('  expect(2).toBe(2);\n', '') + "test('c', () => {});\n" });
  const more = await w4.task();
  assert.deepEqual([more.ok, more.tests.expects_removed], [true, ['test/a.test.js: expect(2).toBe(2);']], 'more tests is fine; a removed expect is listed, not red');
});

test('M5 parser child fails closed: a hostile 5 MB test blob blows the scan child\'s 96 MB heap (in tbd: +365 MB RSS) → work red "test scan failed"', async () => {
  const w = world({ task: { files: ['lib/sum.js', 'test/big.test.js'] } });
  w.commit({ 'test/big.test.js': "'',".repeat(1_747_000) }); // ≤ 5 MB (the scope cap): 1.7M string literals
  const r = await w.task();
  assert.deepEqual([r.ok, r.class, r.checks.at(-1)?.check], [false, 'work', 'tests']);
  assert.match(r.why, /^test scan failed: exit SIGABRT: FATAL ERROR: .*heap out of memory/);
});

// ---- pre-gate clean (security review 2a) ------------------------------------------------------------------------------
test('SR 2a: forged ignored files (a .tsbuildinfo, node_modules/.cache) are gone before the first check of a task and a working gate; node_modules and the env file stay', async () => {
  const FORGED = ['probe/x.tsbuildinfo', 'node_modules/.cache/babel/x.json'];
  const probe = `node -e "process.exit([${FORGED.map((f) => `'${f}'`)}].some((f) => require('fs').existsSync(f)) ? 1 : 0)"`; // red while a forged file is there
  const w = world({ tag: { env_files: ['.env.local'], checks: { typecheck: probe } } });
  w.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const plant = () => put(w.wt, { ...Object.fromEntries(FORGED.map((f) => [f, '{}'])), 'node_modules/dep/index.js': '1\n', '.env.local': 'K=v\n' });
  for (const gate of [() => w.task(), () => w.working()]) {
    plant();
    const r = await gate();
    assert.equal(r.ok, true, r.why);
    assert.deepEqual([...FORGED, 'node_modules/dep/index.js', '.env.local'].map((f) => fs.existsSync(path.join(w.wt, f))), [false, false, true, true]);
  }
});

// ---- fail-first (K7) -----------------------------------------------------------------------------------------------------
const NEW = { type: 'new' };
test('K7 proven: marker {pre, head} saved BEFORE the swap (tree still at HEAD), red twice at pre, tree back at HEAD, marker cleared', async () => {
  const w = world({ task: NEW });
  const head = w.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const r = await w.task({ out: { commit: head, tests: ['test/sum.test.js'] } });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.tests.failfirst, 'proven');
  const swaps = w.saves.filter((s) => 'swap' in s);
  assert.deepEqual(swaps.map((s) => s.swap && [s.swap.pre, s.swap.head]), [[w.base, head], null]);
  assert.equal(swaps[0].sum, SUM_OK, 'the marker went out before the tree changed');
  assert.deepEqual(r.checks.filter((c) => c.check.startsWith('failfirst')).map((c) => [c.check, c.ok]), [['failfirst:pre', false], ['failfirst:pre2', false], ['failfirst', true]]);
  assert.equal(w.read('lib/sum.js'), SUM_OK);
  assert.equal(git(w.wt, 'status', '--porcelain'), '');
  assert.equal(metricLines(w.id).find((l) => l.check === 'failfirst').failfirst, 'proven');
});

test('K7 vacuous (passes at pre → red), 0 test files → red, tests_added naming a file the task did not change → red', async () => {
  const w = world({ task: NEW });
  w.commit({ 'lib/sum.js': SUM_OK + '// refactor\n', 'test/sum.test.js': SUM_TEST.replace('sum(1, 2), 3', '1, 1') });
  const v = await w.task();
  assert.deepEqual([v.ok, v.class, v.tests.failfirst], [false, 'work', 'vacuous']);
  const w2 = world({ task: NEW });
  w2.commit({ 'lib/sum.js': SUM_OK });
  const none = await w2.task();
  assert.deepEqual([none.ok, none.tests.failfirst], [false, 'unproven_no_tests']);
  const w3 = world({ task: NEW });
  const h = w3.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const lie = await w3.task({ out: { commit: h, tests: ['test/other.test.js'] } });
  assert.match(lie.why, /tests_added names test\/other\.test\.js/);
});

test('K7 proven_missing: at pre only "Cannot find module" of a module the task adds, green at HEAD → proven_missing', async () => {
  const t = "const test = require('node:test');\nconst assert = require('node:assert');\nconst twice = require('../lib/twice.js');\ntest('twice', () => assert.equal(twice(2), 4));\n";
  const w = world({ task: { ...NEW, files: ['lib/twice.js', 'test/twice.test.js'] } });
  w.commit({ 'lib/twice.js': 'module.exports = (x) => x * 2;\n', 'test/twice.test.js': t });
  const r = await w.task();
  assert.equal(r.ok, true, r.why);
  assert.equal(r.tests.failfirst, 'proven_missing');
});

test('K7 addedNames in the child: a hostile non-test diff (160 KB unclosed template, 8.7 s in-process before) never stalls tbd; the added identifier still proves', async () => {
  const t = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { brandNewFn } = require('../lib/sum.js');\ntest('new', () => assert.equal(brandNewFn(), 1));\n";
  const w = world({ task: { ...NEW, files: ['lib/sum.js', 'lib/blob.txt', 'test/new.test.js'] } });
  w.commit({ 'lib/sum.js': `${SUM_OK}module.exports.brandNewFn = () => 1;\n`, 'lib/blob.txt': `\`${'\\`'.repeat(80_000)}\n`, 'test/new.test.js': t });
  let lag = 0;
  let last = Date.now();
  const iv = setInterval(() => { lag = Math.max(lag, Date.now() - last); last = Date.now(); }, 10);
  const r = await w.task();
  clearInterval(iv);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.tests.failfirst, 'proven_missing');
  assert.ok(lag < 1000, `main thread stalled ${lag} ms`);
});

test('K7 adapter verdicts through the real swap (jest-shaped runner): proven, red only once → vacuous, unproven_compile / no_tests / unparsed (green, listed)', async () => {
  const cases = [
    ['proven', 'Tests:       1 failed, 1 total\n'],
    ['vacuous', 'Tests:       1 failed, 1 total\n', FLIP], // red at pre once, green the 2nd time: not red twice
    ['unproven_compile', '  ● Test suite failed to run\n\n    src/a.ts:1:63 - error TS1005: \';\' expected.\n\nTests:       0 total\n'],
    ['unproven_compile', "  ● Test suite failed to run\n\n    Cannot find module './nothere' from 'x.test.js'\n\nTests:       0 total\n"], // a missing name the diff does not add: no proven_missing
    ['unproven_no_tests', 'No tests found, exiting with code 1\nPattern: x.test.js - 0 matches\n'],
    ['unproven_unparsed', 'Segmentation fault\n'],
  ];
  for (const [want, out, runner = FAKE] of cases) {
    const w = world({ files: { 'out.txt': out, 'code.txt': '1', 'fake.js': runner }, task: { ...NEW, test_cmd: 'npm run test:fake', files: ['out.txt', 'code.txt', 'fake.js', 'x.test.js'] } });
    w.commit({ 'out.txt': 'Tests:       1 passed, 1 total\n', 'code.txt': '0', 'fake.js': FAKE, 'x.test.js': '// t\n' });
    const r = await w.task();
    assert.deepEqual([r.ok, r.tests.failfirst], [want !== 'vacuous', want], `${want}: ${r.why}`);
  }
});

test('K7 abort during the 2nd run at pre → interrupted, never proven; the tree back at HEAD; the result kept (memory)', async () => {
  const SLOW = "const fs = require('node:fs'); const f = require('node:path').join(process.env.TMPDIR, 'ran'); if (fs.existsSync(f)) setTimeout(() => {}, 20000); fs.writeFileSync(f, ''); process.stdout.write('Tests:       1 failed, 1 total\\n'); process.exitCode = 1;\n";
  const w = world({ files: { 'fake.js': SLOW }, task: { ...NEW, test_cmd: 'npm run test:fake', files: ['fake.js', 'x.test.js'] } });
  const head = w.commit({ 'fake.js': FAKE, 'x.test.js': '// t\n' });
  const ac = new AbortController();
  let n = 0;
  const r = await w.task({ signal: ac.signal, out: { commit: head, tests: [] }, onSpawn: () => { if (++n === 3) setTimeout(() => ac.abort('memory'), 1500); } });
  assert.deepEqual([n, r.ok, r.class, r.tests.failfirst], [3, false, 'interrupted', 'n/a']);
  assert.equal(w.read('fake.js'), FAKE, 'back at HEAD');
  assert.deepEqual(w.json(), ['01.json']);
});

test('K7 abort during the fail-first run: the tree is restored before the gate settles; a cancel writes no GateResult', async () => {
  const slowAtPre = "const test = require('node:test');\nconst sum = require('../lib/sum.js');\ntest('s', async () => { if (sum(1, 2) !== 3) await new Promise((r) => setTimeout(r, 30000)); });\n";
  const w = world({ task: NEW });
  w.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': slowAtPre });
  const ac = new AbortController();
  const save = async (p) => {
    w.saves.push(p);
    if (p.swap) setTimeout(() => ac.abort('cancel'), 1500);
    return true;
  };
  const r = await w.task({ signal: ac.signal, save });
  assert.deepEqual([r.ok, r.class], [false, 'interrupted']);
  assert.equal(w.read('lib/sum.js'), SUM_OK, 'back at HEAD');
  assert.equal(git(w.wt, 'status', '--porcelain'), '');
  assert.deepEqual(w.json(), []);
  assert.equal(w.saves.at(-1).swap, null, 'marker cleared after the restore');
});

test('output lines: stdout and stderr never splice mid-line (env_files redaction on): a jest summary followed by an npm error stays parseable → proven', async () => {
  const RED = "process.stdout.write('PASS foo\\nTests:       1 failed, 1 total\\n'); setTimeout(() => { process.stderr.write('npm error code 1\\n'); process.exitCode = 1; }, 100);\n";
  const w = world({ files: { 'fake.js': RED, '.env.t': 'K=0123456789abcdef\n' }, tag: { env_files: ['.env.t'] }, task: { ...NEW, test_cmd: 'npm run test:fake', files: ['fake.js', 'x.test.js'] } });
  const head = w.commit({ 'fake.js': FAKE, 'x.test.js': '// t\n' });
  const r = await w.task({ out: { commit: head, tests: [] } });
  assert.deepEqual([r.ok, r.tests.failfirst], [true, 'proven'], r.checks.find((c) => c.check === 'failfirst:pre')?.tail);
  assert.match(r.checks.find((c) => c.check === 'failfirst:pre')?.tail ?? '', /^Tests: {7}1 failed, 1 total$/m);
});

test('a check\'s process that left its group (setsid) is found by its TBGATE mark and killed when the check ends; a check leaving the tree dirty → integrity', async () => {
  // the scripts are tracked at base: the gate's first step (cleanTree) removes ignored files planted before it
  const w = world({
    files: {
      'bin/loop.js': "require('fs').mkdirSync('probe', { recursive: true }); require('fs').writeFileSync('probe/loop.pid', String(process.pid)); setInterval(() => {}, 200);\n",
      'bin/setsid.js': "require('child_process').spawn(process.execPath, ['bin/loop.js'], { detached: true, stdio: 'ignore' }).unref();\n",
    },
    tag: { checks: { unit: 'node bin/setsid.js; sleep 1; echo started' } },
  });
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.task({ task: { ...w.plan.tasks[0], test_cmd: null } });
  assert.equal(r.ok, true, r.why);
  const pid = Number(w.read('probe/loop.pid'));
  assert.ok(pid > 1, 'the setsid child ran');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'and is gone');
  const w2 = world({ tag: { checks: { unit: 'echo x > stray.txt' } } });
  w2.commit({ 'lib/sum.js': SUM_OK });
  const dirty = await w2.task();
  assert.deepEqual([dirty.ok, dirty.class], [false, 'integrity']);
  assert.match(dirty.why, /left the worktree dirty: \?\? stray\.txt/);
});

test('restoreSwap (a killed tbd left the marker): tree back at the marker head, clean, twice in a row (idempotent); no marker → no-op', async () => {
  const w = world({ task: NEW });
  const head = w.commit({ 'lib/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST, 'lib/new.js': '1\n' });
  git(w.wt, 'checkout', '-q', '--no-overlay', w.base, '--', 'lib/sum.js', 'lib/new.js');
  put(w.wt, { 'stray.txt': 'left by the run at pre\n' });
  await store.putTag(w.t.tag, w.tag);
  const t = { ...w.t, work: { ...w.t.work, gate: { gen: 1, kind: 'task', swap: { pre: w.base, head, pid: 0, lstart: '' } } } };
  for (let i = 0; i < 2; i++) {
    await gates.restoreSwap(t, w.wt);
    assert.deepEqual([w.read('lib/sum.js'), w.read('lib/new.js'), fs.existsSync(path.join(w.wt, 'stray.txt')), git(w.wt, 'status', '--porcelain')], [SUM_OK, '1\n', false, '']);
  }
  put(w.wt, { 'stray2.txt': 'x\n' });
  await gates.restoreSwap({ ...t, work: { ...t.work, gate: { gen: 1, kind: 'task' } } }, w.wt);
  assert.equal(fs.existsSync(path.join(w.wt, 'stray2.txt')), true, 'no marker: the tree is not touched');
});

// ---- working gate: policy, migrations, OpenAPI (K8 K9 K10) -----------------------------------------------------------------
const SCHEMA = 'model User {\n  id       Int    @id\n  email    String\n  nickname String\n}\n';
const MIG1 = 'CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY, "email" TEXT NOT NULL, "nickname" TEXT NOT NULL);\n';
const PRISMA_FILES = { 'prisma/schema.prisma': SCHEMA, 'prisma/migrations/0001_init/migration.sql': MIG1 };
test('K8 working gate: a not-allowed `drop User.nickname` → policy ask alone; allowed → green with unused entries listed; an edited migration → work (never policy)', async () => {
  const drop = { 'prisma/schema.prisma': SCHEMA.replace('  nickname String\n', ''), 'prisma/migrations/0002_drop/migration.sql': 'ALTER TABLE "User" DROP COLUMN "nickname";\n' };
  const w = world({ files: PRISMA_FILES, tag: { prisma: {} }, task: { modules: ['prisma'] } });
  w.commit(drop);
  const r = await w.working();
  assert.deepEqual([r.ok, r.class, r.ask?.kind, r.ask?.changes], [false, 'policy', 'policy', ['drop User.nickname']]);
  assert.deepEqual(r.schema, [{ op: 'drop', ref: 'User.nickname', allowed: false }]);
  const w2 = world({ files: PRISMA_FILES, tag: { prisma: {} }, task: { modules: ['prisma'] }, plan: { allowed_schema_changes: ['drop User.nickname', 'drop User.email'] } });
  w2.commit(drop);
  const ok = await w2.working();
  assert.deepEqual([ok.ok, ok.class, ok.unused_allowed], [true, null, ['drop User.email']]);
  const w3 = world({ files: PRISMA_FILES, tag: { prisma: {} }, task: { modules: ['prisma'] }, plan: { allowed_schema_changes: ['drop User.nickname'] } });
  w3.commit({ ...drop, 'prisma/migrations/0001_init/migration.sql': MIG1.replace('"email" TEXT NOT NULL, ', '') });
  const mig = await w3.working();
  assert.deepEqual([mig.ok, mig.class, mig.migration], [false, 'work', ['edited prisma/migrations/0001_init/migration.sql']]);
});

test('K9 OpenAPI: base captured at approve (sandboxed, copied to the ticket dir); a removed response property → policy; a link as the spec → refused', async () => {
  const spec = (props) => JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: { '/u': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserDto' } } } } } } } },
    components: { schemas: { UserDto: { type: 'object', properties: props, required: ['id'] } } } });
  const files = { 'spec.src.json': spec({ id: { type: 'integer' }, nickname: { type: 'string' } }), 'gen.js': "require('node:fs').copyFileSync('spec.src.json', 'openapi.json');\n" };
  const w = world({ files, tag: { openapi: { cmd: 'node gen.js', file: 'openapi.json' } }, task: { files: ['spec.src.json'] } });
  assert.deepEqual(await gates.captureOpenapiBase({ t: w.t, wt: w.wt, tag: w.tag, onSpawn: () => {}, signal: ask() }), { ok: true });
  assert.match(fs.readFileSync(path.join(store.ticketDir(w.id), 'openapi.base.json'), 'utf8'), /nickname/);
  w.commit({ 'spec.src.json': spec({ id: { type: 'integer' } }) });
  const r = await w.working();
  assert.deepEqual([r.class, r.ask?.changes], ['policy', ['remove UserDto.nickname']]);
  const w2 = world({ files: { ...files, 'gen.js': "require('node:fs').symlinkSync('/etc/hosts', 'openapi.json');\n" }, tag: { openapi: { cmd: 'node gen.js', file: 'openapi.json' } } });
  const link = await gates.captureOpenapiBase({ t: w2.t, wt: w2.wt, tag: w2.tag, onSpawn: () => {}, signal: ask() });
  assert.equal(link.ok, false);
  assert.match(link.why, /not a plain file|outside/);
});

test('working gate runs every heavy check and reports all reds (lint + unit), class work', async () => {
  const w = world({ tag: { checks: { lint: 'echo lint-broken; exit 2', typecheck: 'true', unit: 'echo unit-broken; exit 1' } } });
  w.commit({ 'lib/sum.js': SUM_OK });
  const r = await w.working();
  assert.deepEqual([r.ok, r.class], [false, 'work']);
  assert.deepEqual(r.checks.map((c) => [c.check, c.ok]), [['lint', false], ['typecheck', true], ['unit', false]]);
  assert.match(r.why, /lint-broken[\s\S]*unit-broken/);
});

test('working gate (an @fix commit is judged here): the union scope of every plan task + allows over base..HEAD, and the tests weakening scan', async () => {
  const two = "const test = require('node:test');\ntest('a', () => {});\ntest('b', () => {});\n";
  const w = world({ files: { 'test/a.test.js': two }, task: { files: ['lib/sum.js', 'test/a.test.js'] } });
  w.commit({ 'lib/sum.js': SUM_OK, 'README.md': 'x\n' });
  const out = await w.working();
  assert.deepEqual([out.class, out.ask?.files], ['scope', ['README.md']]);
  assert.equal((await w.working({ allow: [{ path: 'README.md' }] })).ok, true, 'an allow widens the union');
  w.commit({ 'test/a.test.js': two.replace("test('b'", "test.skip('b'") });
  const skip = await w.working({ allow: [{ path: 'README.md' }] });
  assert.deepEqual([skip.class, skip.tests.skips_added], ['work', ['test/a.test.js: .skip']]);
});

// ---- base checks (N3) + deps two-step (RO2) ----------------------------------------------------------------------------------
test('N3 base checks: green → {ok, checks {check: {ok, ms}}} + gates/NN.json gate base; red → {ok:false, why}', async () => {
  const w = world({ tag: { checks: { typecheck: 'true', unit: 'node -e 0' } } });
  const ok = await gates.runBaseChecks({ t: w.t, wt: w.wt, tag: w.tag, save: w.save, onSpawn: () => {}, signal: ask() });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.checks), ['typecheck', 'unit']);
  assert.ok(Object.values(ok.checks).every((c) => c.ok && Number.isInteger(c.ms)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.gatesDir(), '01.json'), 'utf8')).gate, 'base');
  const w2 = world({ tag: { checks: { typecheck: 'echo base-broken; exit 3', unit: 'true' } } });
  const bad = await gates.runBaseChecks({ t: w2.t, wt: w2.wt, tag: w2.tag, save: w2.save, onSpawn: () => {}, signal: ask() });
  assert.deepEqual([bad.ok, Object.keys(bad.checks), bad.checks.typecheck.ok], [false, ['typecheck'], false]);
  assert.match(bad.why, /base-broken/);
});

// A local npm registry on 127.0.0.1 (localhost is open in every profile; config gates.registry is npm's --registry):
// pkgs {name: {scripts?, files?, deps?}} → name@1.0.0 as a packument + a tarball. entry(name): its lockfile entry.
async function localRegistry(pkgs) {
  const tgz = {};
  for (const [name, p] of Object.entries(pkgs)) {
    const dir = fs.mkdtempSync(path.join(ROOT, 'reg-'));
    put(path.join(dir, 'package'), { 'package.json': JSON.stringify({ name, version: '1.0.0', scripts: p.scripts ?? {}, dependencies: p.deps ?? {} }), ...p.files });
    tgz[name] = execFileSync('/usr/bin/tar', ['-czf', '-', '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  }
  const integrity = (name) => `sha512-${crypto.createHash('sha512').update(tgz[name]).digest('base64')}`;
  const srv = http.createServer((req, res) => {
    const m = /^\/([a-z0-9-]+)(\/-\/[a-z0-9-]+-1\.0\.0\.tgz)?$/.exec(req.url ?? '');
    if (!m || !tgz[m[1]]) return void res.writeHead(404).end('{}');
    if (m[2]) return void res.end(tgz[m[1]]);
    res.end(JSON.stringify({ name: m[1], 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: m[1], version: '1.0.0', dist: { tarball: `${url}${m[1]}/-/${m[1]}-1.0.0.tgz`, integrity: integrity(m[1]) } } } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const url = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/`;
  store.config.gates = { ...store.config.gates, registry: url };
  return {
    entry: (name) => ({ version: '1.0.0', resolved: `${url}${name}/-/${name}-1.0.0.tgz`, integrity: integrity(name), ...(pkgs[name].scripts?.install && { hasInstallScript: true }) }),
    close: () => { srv.close(); delete store.config.gates.registry; },
  };
}
const lockOf = (packages) => JSON.stringify({ name: 'fx', version: '1.0.0', lockfileVersion: 3, requires: true, packages });
const deps = (w, online = false) => gates.runDepsSetup({ t: w.t, wt: w.wt, tag: w.tag, online, onSpawn: () => {}, signal: ask() });

test('RO2 deps setup: npm ci --ignore-scripts (setupnet), then `npm rebuild <dep>` offline; a dep install script needing the network → needs_online; online → ok', async () => {
  const net = "const s = require('node:net').connect(443, '192.0.2.1'); s.setTimeout(1000, () => process.exit(0));\ns.on('connect', () => process.exit(0)); s.on('error', (e) => { console.log('net', e.code); process.exit(e.code === 'EPERM' ? 1 : 0); });\n";
  const reg = await localRegistry({ netty: { scripts: { install: 'node net.js' }, files: { 'net.js': net } } });
  try {
    const w = world({ files: { 'package.json': JSON.stringify({ ...PKG, dependencies: { netty: '1.0.0' } }),
      'package-lock.json': lockOf({ '': { name: 'fx', version: '1.0.0', dependencies: { netty: '1.0.0' } }, 'node_modules/netty': reg.entry('netty') }) } });
    const off = await deps(w);
    assert.deepEqual([off.ok, off.needs_online], [false, true]);
    assert.match(off.why ?? '', /net EPERM/);
    assert.deepEqual(await deps(w, true), { ok: true });
  } finally {
    reg.close();
  }
});

const mark = (f) => `node -e "require('fs').writeFileSync('${f}', 'x')"`;
test('RO2 step 2 rebuilds registry deps by name only: a registry dep\'s install script runs; the root\'s postinstall (running an agent-written file) does not', async () => {
  const reg = await localRegistry({ tiny2: { scripts: { install: mark('built.txt') } } });
  try {
    const pkg = { ...PKG, scripts: { ...PKG.scripts, postinstall: 'node post.js' }, dependencies: { tiny2: '1.0.0' } };
    const w = world({
      files: {
        'package.json': JSON.stringify(pkg), 'post.js': "console.log('base post');\n",
        'package-lock.json': lockOf({ '': { name: 'fx', version: '1.0.0', dependencies: pkg.dependencies, hasInstallScript: true }, 'node_modules/tiny2': reg.entry('tiny2') }),
      },
      task: { files: ['post.js'] },
    });
    w.commit({ 'post.js': `${mark('agent-post-ran.txt').replace(/^node -e "|"$/g, '')};\n` });
    assert.deepEqual(await deps(w), { ok: true });
    assert.ok(fs.existsSync(path.join(w.wt, 'node_modules', 'tiny2', 'built.txt')), 'the registry dep was rebuilt');
    assert.equal(fs.existsSync(path.join(w.wt, 'agent-post-ran.txt')), false, 'the root postinstall did not run');
  } finally {
    reg.close();
  }
});

test('RO2 step 2 refused whole when an off-registry `a` (top) sits beside a registry `a` (nested, rebuilt): with an install script, or with none (no flag) → nothing rebuilt', async () => {
  const reg = await localRegistry({ a: { scripts: { install: mark('../../../../a1.txt') } }, x: { deps: { a: '1.0.0' } } });
  try {
    /** @type {{scripts: Record<string, string>, want: RegExp}[]} */
    const rows = [{ scripts: { install: mark('../../evil.txt') }, want: /^deps: "node_modules\/a" has an install script and is not from the registry/ },
      { scripts: {}, want: /^deps: "node_modules\/a" shares the name a with a rebuilt package and is not from the registry/ }];
    for (const { scripts, want } of rows) {
      const dir = fs.mkdtempSync(path.join(ROOT, 'evil-'));
      put(path.join(dir, 'package'), { 'package.json': JSON.stringify({ name: 'a', version: '2.0.0', scripts }) });
      const tgz = execFileSync('/usr/bin/tar', ['-czf', '-', '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const dependencies = { a: 'file:a-2.0.0.tgz', x: '1.0.0' };
      const w = world({
        files: {
          'package.json': JSON.stringify({ ...PKG, dependencies }), 'a-2.0.0.tgz': tgz,
          'package-lock.json': lockOf({ '': { name: 'fx', version: '1.0.0', dependencies },
            'node_modules/a': { version: '2.0.0', resolved: 'file:a-2.0.0.tgz', integrity: `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`, ...(scripts.install && { hasInstallScript: true }) },
            'node_modules/x': { ...reg.entry('x'), dependencies: { a: '1.0.0' } }, 'node_modules/x/node_modules/a': reg.entry('a') }),
        },
      });
      const r = await deps(w);
      assert.equal(r.ok, false);
      assert.match(r.why ?? '', want);
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.wt, 'node_modules', 'a', 'package.json'), 'utf8')).version, '2.0.0', 'step 1 installed the off-registry a at the top');
      assert.deepEqual([fs.existsSync(path.join(w.wt, 'evil.txt')), fs.existsSync(path.join(w.wt, 'a1.txt'))], [false, false], 'no install script ran');
    }
  } finally {
    reg.close();
  }
});

test('RO2 deps setup with packages: `npm install --ignore-scripts -- name@range` (here from a local registry) updates package.json, lockfile, node_modules; a bad spec is refused before npm runs', async () => {
  const reg = await localRegistry({ tiny: {} });
  try {
    const w = world();
    const run = (packages) => gates.runDepsSetup({ t: w.t, wt: w.wt, tag: w.tag, packages, online: false, onSpawn: () => {}, signal: ask() });
    for (const bad of [['tiny@file:../x'], ['-tiny@1'], ['tiny@latest'], ['tiny @1'], ['tiny@git+https://x.invalid/t'], Array(21).fill('tiny@1')]) {
      const r = await run(bad);
      assert.deepEqual([r.ok, (r.why ?? '').startsWith('packages: ')], [false, true], JSON.stringify(bad));
    }
    assert.equal(fs.existsSync(path.join(w.wt, 'node_modules')), false, 'refused before npm ran');
    assert.deepEqual(await run(['tiny@^1.0.0']), { ok: true });
    assert.equal(JSON.parse(w.read('package.json')).dependencies.tiny, '^1.0.0');
    assert.equal(JSON.parse(w.read('package-lock.json')).packages['node_modules/tiny'].version, '1.0.0');
    assert.ok(fs.existsSync(path.join(w.wt, 'node_modules', 'tiny', 'package.json')));
  } finally {
    reg.close();
  }
});

test('setup-profile runs only on a tree tbd vouches for: deps setup refuses a dirty tree, a committed script or .npmrc change not allowed (a blob allow passes); base checks + OpenAPI base refuse HEAD ≠ base_sha', async () => {
  const lock = JSON.stringify({ name: 'fx', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fx', version: '1.0.0' } } });
  const deps = (w, t = w.t) => gates.runDepsSetup({ t, wt: w.wt, tag: w.tag, online: false, onSpawn: () => {}, signal: ask() });
  const w = world({ files: { 'package-lock.json': lock } });
  put(w.wt, { 'package.json': JSON.stringify({ ...PKG, scripts: { ...PKG.scripts, install: 'echo ROOT > root-install.txt' } }) });
  const dirty = await deps(w);
  assert.deepEqual([dirty.ok, /protected: the worktree has uncommitted changes: package\.json/.test(dirty.why ?? '')], [false, true], dirty.why);
  assert.equal(fs.existsSync(path.join(w.wt, 'node_modules')), false, 'npm never ran');
  const head = commit(w.wt);
  const edited = await deps(w);
  assert.match(edited.why ?? '', /protected: package\.json changed since base/);
  const blob = git(w.wt, 'rev-parse', 'HEAD:package.json');
  assert.equal(fs.existsSync(path.join(w.wt, 'root-install.txt')), false, 'refused: no npm, no root lifecycle script');
  const allowed = await deps(w, { ...w.t, work: { ...w.t.work, scope: { T1: [{ path: 'package.json', blob }] } } });
  assert.deepEqual(allowed, { ok: true }, 'Irfan allowed that exact blob (its root install script then runs in npm rebuild)');
  const w2 = world({ files: { 'package-lock.json': lock } });
  w2.commit({ '.npmrc': 'registry=https://evil.invalid/\n' });
  assert.match((await deps(w2)).why ?? '', /protected: \.npmrc changed/);
  const base = await gates.runBaseChecks({ t: w.t, wt: w.wt, tag: { ...w.tag, checks: { unit: 'true' } }, save: w.save, onSpawn: () => {}, signal: ask() });
  assert.match(base.why ?? '', new RegExp(`HEAD ${head.slice(0, 12)} is not base_sha`));
  assert.match((await gates.captureOpenapiBase({ t: w.t, wt: w.wt, tag: { ...w.tag, openapi: { cmd: 'true', file: 'x.json' } }, onSpawn: () => {}, signal: ask() })).why ?? '', /is not base_sha/);
});
