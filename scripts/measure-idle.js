#!/usr/bin/env node
'use strict';
// P1 AC5 idle probe: tbd on a temp TB_HOME with 200 reminders + 1 SSE client; samples RSS + cputime
// every --every s (default 10) for --minutes N (default 10). Target: peak RSS < 80 MB, cputime delta < 6 s.
// steady_max_rss_mb = max RSS from 70 s on (the start-up spike over; .omc/handoffs/p5-ram.js method).
// --ram50: 50 tickets instead of the reminders (the ram50 part of .omc/handoffs/p5-seed.js); any tbd stderr line → exit 1.
// --tbd <dir>: run <dir>/tbd.js (base: mkdir <tmp> && git archive 266a62b | tar -x -C <tmp>); no tbd.js there → exit 2.
// --modules: no RSS samples; prints the files tbd loaded once booted (test/helpers/mods-dump.js preload), one per line,
// relative to the tbd dir: diff two runs for base vs head.
// Usage: node scripts/measure-idle.js [--minutes 10] [--every 10] [--ram50] [--tbd <dir>] [--modules]
const { execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startTbd } = require('../test/helpers/tbd');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const minutes = Number(arg('--minutes', 10));
if (!(minutes > 0)) {
  console.error('error: --minutes must be a number > 0');
  process.exit(2);
}
const every = Number(arg('--every', 10));
if (!(every > 0)) {
  console.error('error: --every must be a number > 0');
  process.exit(2);
}
const dir = arg('--tbd', path.join(__dirname, '..'));
if (!fs.existsSync(path.join(dir, 'tbd.js'))) {
  console.error(`error: no tbd.js in ${dir}`);
  process.exit(2);
}
const DIR = fs.realpathSync(dir);
const RAM50 = process.argv.includes('--ram50');
const MODULES = process.argv.includes('--modules');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ps time= is [[dd-]hh:]mm:ss.cc
const seconds = (t) => t.split(/[-:]/).reduce((acc, p) => acc * 60 + Number(p), 0);
const sample = (pid) => new Promise((resolve, reject) => {
  execFile('ps', ['-o', 'rss=,time=', '-p', String(pid)], (err, out) => {
    if (err) return reject(err);
    const [rss, time] = out.trim().split(/\s+/);
    resolve({ rss_mb: Number(rss) / 1024, cpu_s: seconds(time) });
  });
});

// The ram50 part of p5-seed.js: 20 done tickets x 10 tasks x 30 gates, 30 more in mixed states (clarify, review, final
// gate, blocked). No checkout (no worktree / clone fields); the phases dir holds planning + working only, so no run starts.
function ram50() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-')));
  const tb = path.join(root, 'tbhome');
  const repo = path.join(root, 'repo');
  const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); };
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  w(path.join(repo, 'README.md'), 'users api\n');
  w(path.join(repo, 'src/users/users.service.js'), 'module.exports = { list: () => [] };\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const sha = git('rev-parse', 'main');
  for (const ph of ['planning', 'working']) for (const f of ['settings.json', 'result.schema.json', 'prompt.md']) w(path.join(root, 'phases', 'code', ph, f), fs.readFileSync(path.join(DIR, 'phases', 'code', ph, f), 'utf8'));
  w(path.join(tb, 'config.json'), {
    claude_bin: path.join(__dirname, '..', 'test', 'fake-claude.js'), max_concurrent: 3,
    memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
    disk: { warn_gb: 0, stop_gb: 0 },
  });
  w(path.join(tb, 'tags.json'), { acme: {}, 'acme/api': { type: 'git', path: repo, base: 'main', leak_check: true } });

  const NOW = new Date().toISOString();
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
  const PLAN = {
    kind: 'plan', round: 2, summary: 'Paginate GET /users with a cursor; drop the nickname field.',
    acceptance: [{ id: 'A1', text: 'GET /users returns 20 per page with nextCursor', type: 'new' }],
    tasks: ['T1', 'T2', 'T3'].map((id, i) => ({ id, title: `task ${id}`, files: [`src/users/part${i}.js`], modules: ['src/users'], blocked_by: [], type: 'new', test_cmd: 'npm test', steps: [] })),
    allowed_schema_changes: ['drop Session.token', 'rename User.name User.fullName'], allowed_api_changes: ['remove GET /legacy'], skills: [], ui: null, children: [],
    facts: [], decisions: [],
  };
  const phash = crypto.createHash('sha256').update(canon(PLAN)).digest('hex');
  const SHA = (n) => crypto.createHash('sha1').update(`h${n}`).digest('hex');
  const put = (id, over) => {
    w(path.join(tb, 'tickets', id, 'ticket.json'), {
      id, type: 'flow', kind: 'code', tag: 'acme/api', title: `Seed ${id}`, text: 'Paginate GET /users with cursors.', state: 'backlog', created_at: NOW, updated_at: NOW,
      parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null, round: 3,
      base_sha: sha, plan_file: `plan-${phash}.json`, plan_hash: phash, plan_hashes: [phash], ...over,
    });
    w(path.join(tb, 'tickets', id, `plan-${phash}.json`), PLAN);
  };
  const CHECKS = [
    { check: 'typecheck', ok: true, exit: 0, timed_out: false, ms: 9100, flaky: false, log: null, tail: '' },
    { check: 'unit', ok: true, exit: 0, timed_out: false, ms: 21400, flaky: true, log: null, tail: 'PASS src/users/users.spec.js\nTests: 12 passed' },
    { check: 'lint', ok: true, exit: 0, timed_out: false, ms: 3000, flaky: false, log: null, tail: '' },
  ];
  const putGate = (id, n, over = {}) => w(path.join(tb, 'tickets', id, 'gates', `${String(n).padStart(2, '0')}.json`), {
    v: 1, gate: 'task', ticket: id, task: 'T1', attempt: 1, pre: SHA(0), head: SHA(1), plan_hash: phash, at: NOW, ms: 34000 + n, slot_wait_ms: 0, ok: true, class: null,
    checks: CHECKS, scope: { outside: [], protected: [], deps: false, bad: [] },
    tests: { failfirst: 'proven', files: ['src/users/users.spec.js'], skips_added: [], deleted: [], expects_removed: [], count_drops: [], count: { pre: 10, head: 12 } },
    schema: [], api: [], unused_allowed: [], migration: [], ask: null, why: '', ...over,
  });
  const ten = (n) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, status: 'done', attempt: 1, pre: SHA(i), head: SHA(i + 1), commit: null, session: null }));
  for (let i = 0; i < 20; i++) {
    const id = `t_ram${String(i).padStart(3, '0')}`;
    put(id, { title: `RAM done ${i}`, state: 'done', work: { task: null, tasks: ten(10), tries: 0, unit_ms: 41000, scope: {}, denied: {}, gate: { kind: 'working', n: 30, ok: true } }, interventions: 2 });
    for (let n = 1; n <= 30; n++) putGate(id, n, { task: `T${((n - 1) % 10) + 1}`, gate: n % 10 === 0 ? 'working' : 'task' });
  }
  const mix = [
    { state: 'clarify', clarify_origin: { phase: 'working', task: 'T1', why: 'files outside the task', class: 'scope' } },
    { state: 'review' }, { state: 'final_gate' }, { state: 'blocked', blocked_from: 'working', waiting: { reason: 'infra', why: 'gate timed out', since: NOW } },
    { state: 'clarify', clarify_origin: { phase: 'working', task: null, why: 'drop User.nickname', class: 'policy' } },
  ];
  for (let i = 0; i < 30; i++) {
    const id = `t_ram${String(20 + i).padStart(3, '0')}`;
    const over = mix[i % mix.length];
    put(id, { title: `RAM ${over.state} ${i}`, work: { task: 'T2', tasks: ten(3), tries: 0, unit_ms: 41000, scope: {}, denied: {}, gate: { kind: 'task', n: 3, ok: false, class: 'scope' } }, ...over });
    for (let n = 1; n <= 3; n++) putGate(id, n);
  }
  return root;
}

async function main() {
  const tasks = Array.from({ length: 200 }, (_, n) => ({
    id: `t_${String(n).padStart(6, '0')}`, type: 'reminder', title: `idle reminder ${n}`,
    status: ['inbox', 'now', 'next', 'later', 'done'][n % 5], created: '2026-10-01',
  }));
  const root = RAM50 ? ram50() : undefined;
  const env = {
    ...(RAM50 && { TB_PHASES_DIR: path.join(root, 'phases') }),
    ...(MODULES && { NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'test', 'helpers', 'mods-dump.js')}` }),
  };
  const tbd = await startTbd({ root, env, files: RAM50 ? {} : { 'tasks.json': { tasks } }, tbd: path.join(DIR, 'tbd.js') });
  const pid = Number(fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8'));
  const sse = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { 'x-tb-token': tbd.token } }, (res) => res.resume());
  // ram50 self-check: a seed tbd cannot read logs an error; no numbers then
  const check = () => {
    const line = RAM50 && tbd.stderr().split('\n').find((l) => l.trim());
    if (line) throw new Error(`tbd stderr: ${line}`);
  };
  let samples;
  try {
    if (MODULES) {
      await sleep(1000);
      const from = tbd.stderr().length;
      process.kill(pid, 'SIGUSR2');
      let m;
      for (let n = 0; n < 50 && !(m = /^mods-dump (.*)\n/m.exec(tbd.stderr().slice(from))); n++) await sleep(100);
      if (!m) throw new Error('no mods-dump line from tbd in 5 s');
      console.log(JSON.parse(m[1]).filter((k) => !k.endsWith('mods-dump.js')).map((k) => path.relative(DIR, k)).sort().join('\n'));
      return;
    }
    samples = [{ t: 0, ...(await sample(pid)) }];
    check();
    console.log(`tbd pid ${pid}, ${minutes} min, sampling every ${every} s`);
    console.log(`t=0s rss=${samples[0].rss_mb.toFixed(1)}MB cpu=${samples[0].cpu_s.toFixed(2)}s`);
    for (let s = every; s <= minutes * 60; s += every) {
      await sleep(every * 1000);
      const x = { t: s, ...(await sample(pid)) };
      check();
      samples.push(x);
      console.log(`t=${s}s rss=${x.rss_mb.toFixed(1)}MB cpu=${x.cpu_s.toFixed(2)}s`);
    }
  } finally {
    sse.destroy();
    await tbd.stop();
  }
  const peak = Math.max(...samples.map((x) => x.rss_mb));
  const cpu = samples.at(-1).cpu_s - samples[0].cpu_s;
  const steady = samples.filter((x) => x.t >= 70).map((x) => x.rss_mb);
  console.log(JSON.stringify({
    minutes, peak_rss_mb: Number(peak.toFixed(1)), cputime_delta_s: Number(cpu.toFixed(2)), rss_ok: peak < 80, cpu_ok: cpu < 6,
    steady_max_rss_mb: steady.length ? Number(Math.max(...steady).toFixed(1)) : null,
  }));
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
