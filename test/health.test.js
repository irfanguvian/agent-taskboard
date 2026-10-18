'use strict';
// M7 (m7-build.md lane M-A: HL1 HL2 HL4 DR1 EV1 GV1 GJ1): GET /api/health, GET /api/drills and POST /api/evals through a
// real tbd (harness temp HOME + TB_HOME) seeded from test/fixtures/health.json, whose expected x / y come from the §12
// rules (its _comment), never from a run of the code; lib/evalscore.js's verdict rules in-process. No phase is built
// (empty TB_PHASES_DIR): no run starts, no ticket moves, so nothing the tbd writes changes the seeded numbers.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd } = require('./helpers/tbd');
const { ticket } = require('./helpers/runs');
const golden = require('../lib/evalscore');
const FIX = require('./fixtures/health.json');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases'); // empty: nothing built
fs.mkdirSync(PHASES);

// The fixture's '@-5d+1m' times → ISO, relative to NOW (one clock for the whole file)
const NOW = Date.now();
const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const when = (v) => (typeof v === 'string' && /^@([+-]\d+[dhms])+$/.test(v)
  ? new Date(NOW + v.slice(1).match(/[+-]\d+[dhms]/g).reduce((s, x) => s + Number(x.slice(0, -1)) * UNIT[x.at(-1)], 0)).toISOString() : v);
const SEED = JSON.parse(JSON.stringify(FIX.seed, (_k, v) => when(v)));
const jsonl = (lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');
const fileLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const KEYS = ['key', 'label', 'x', 'y', 'op', 'threshold', 'ok', 'pending', 'no_data', 'unit', 'note'];
const pick = (t) => Object.fromEntries(KEYS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));

async function boot(t, files = {}) {
  const tbd = await startTbd({ files, env: { TB_PHASES_DIR: PHASES } });
  t.after(() => tbd.stop());
  return tbd;
}
const cookieOf = async (tbd) => ({ 'x-tb-token': undefined, cookie: await tbd.unlock(), 'sec-fetch-site': 'same-origin' });

test('GV1 golden verdict: equal or better is not worse, a changed total is changed (not compared); fewer checks, newly contaminated or a blind under 4 is worse; a lower blind alone is not', () => {
  const c = (id, pass, total, o = {}) => ({ id, pass, total, contaminated: false, blind: null, ...o });
  const base = golden.baseOf([{ t: 'golden', mode: 'real', at: 'A', ok: null, cases: [c('golden:B', 7, 8), c('golden:C', 6, 6, { blind: 5 }), c('golden:E', 5, 5), c('qa:E1', 3, 3), c('review:E2', 4, 4)] }], ['golden:B', 'golden:C', 'golden:E', 'qa:E1', 'review:E2', 'golden:D']);
  const ok = { t: 'golden', pass: true, cases: [c('golden:B', 8, 8), c('golden:C', 6, 6, { blind: 4 }), c('golden:E', 6, 6), c('golden:D', 1, 1)] };
  assert.deepEqual(golden.goldenVerdict(base, ok), { ok: true, x: 2, y: 2, worse: [], changed: ['golden:E'] });
  const bad = { t: 'golden', pass: false, cases: [c('golden:B', 6, 8), c('qa:E1', 3, 3, { contaminated: true }), c('review:E2', 4, 4, { blind: 3 })] };
  assert.deepEqual(golden.goldenVerdict(base, bad), {
    ok: false, x: 0, y: 3, changed: [],
    worse: [{ id: 'golden:B', why: 'fewer checks pass' }, { id: 'qa:E1', why: 'contaminated' }, { id: 'review:E2', why: 'blind score under 4' }],
  });
  assert.deepEqual(golden.goldenVerdict({}, ok), { ok: null, x: 0, y: 0, worse: [], changed: [] }, 'no base: a baseline, ok null');
});

test('HL1 HL2 DR1 seeded TB_HOME: every §12 target x / y / ok as the fixture\'s rules say, each line of both metrics files once; doctor creds masked; days 400; cookie ok, no auth 401; drill log paged newest first', async (t) => {
  const files = {
    'metrics.1.jsonl': jsonl(SEED['metrics.1.jsonl']),
    'metrics.jsonl': jsonl(SEED['metrics.jsonl']) + SEED['metrics.jsonl torn tail'],
    'evals/golden.jsonl': jsonl(SEED['evals/golden.jsonl']),
    'doctor.json': SEED['doctor.json'],
    ...Object.fromEntries(Object.entries(SEED.tickets).map(([id, over]) => [`tickets/${id}/ticket.json`, ticket(id, over)])),
  };
  const tbd = await boot(t, files);
  const size = (f) => fs.statSync(path.join(tbd.tbHome, f)).size;
  const r = await tbd.api('GET', '/api/health');
  assert.equal(r.status, 200, r.text);
  const h = r.json;
  assert.deepEqual([h.window_days, h.cut, h.bytes_read], [30, false, size('metrics.1.jsonl') + size('metrics.jsonl')], 'both files read whole');
  assert.deepEqual([Date.parse(h.to) - Date.parse(h.from), Number.isInteger(h.ms)], [30 * 86_400_000, true]);
  const rss = h.targets.find((x) => x.key === 'rss');
  assert.ok(rss.x > 0 && rss.x <= 80, `tbd RSS ${rss.x} MB`);
  const want = FIX.targets.map((x) => pick(x.key === 'rss' ? { ...x, x: rss.x } : x));
  assert.deepEqual(h.targets.map(pick), want);
  assert.equal(h.targets.find((x) => x.key === 'golden').base_at, SEED['evals/golden.jsonl'][0].at, 'base = the -10d line (the -6d one is ok false)');
  assert.deepEqual(h.doctor, { ...FIX.doctor, at: SEED['doctor.json'].at });
  assert.doesNotMatch(r.text, /u:p@/, 'no credential anywhere in the answer');

  for (const d of ['0', '366', 'x', '1.5']) assert.deepEqual(await tbd.api('GET', `/api/health?days=${d}`).then((x) => [x.status, x.json]), [400, { error: 'days must be a whole number from 1 to 365' }], d);
  const week = (await tbd.api('GET', '/api/health?days=7')).json;
  assert.deepEqual([week.window_days, pick(week.targets.find((x) => x.key === 'infra'))], [7, { ...pick(FIX.targets.find((x) => x.key === 'infra')), x: 1, y: 2 }], '7 days: G1-G3 (-15..-13d) out; G4 (infra) + G5 (work) at -6d in');
  const ui = await cookieOf(tbd);
  assert.equal((await tbd.api('GET', '/api/health', undefined, ui)).status, 200, 'the page reads it with its cookie');
  assert.equal((await tbd.api('GET', '/api/health', undefined, { 'x-tb-token': undefined })).status, 401);

  const d1 = await tbd.api('GET', '/api/drills?limit=2', undefined, ui);
  const drill = (at, name, ok, note) => ({ at: when(at), name, ok, note });
  assert.deepEqual(d1.json, { items: [drill('@-1d', 'kill-tbd', true, 'tbd back in 3 s'), drill('@-3d', 'restart', false, 'run not resumed in 10 min')], next: when('@-3d') });
  const d2 = await tbd.api('GET', `/api/drills?limit=2&before=${encodeURIComponent(d1.json.next)}`, undefined, ui);
  assert.deepEqual(d2.json, { items: [drill('@-12d', 'kill-claude', true, 'run resumed in 40 s'), drill('@-40d', 'kill-tbd', true, 'tbd back in 4 s')], next: null }, 'no window: the -40d drill too');
  for (const q of ['limit=0', 'limit=101']) assert.deepEqual(await tbd.api('GET', `/api/drills?${q}`).then((x) => [x.status, x.json]), [400, { error: 'limit must be a number from 1 to 100' }], q);
  for (const b of ['yesterday', '2026-10-18', '2026-13-01T00:00:00Z']) assert.equal((await tbd.api('GET', `/api/drills?before=${b}`)).status, 400, b);
});

// A golden score JSON v1 as the R box writes it (scripts/harness.js scoreJson; docs/verification/2026-10-18-m5-goldens.json)
const SCORE = {
  v: 1, kind: 'golden-score', at: '2026-10-18T04:35:31.856Z', commit: 'b7c1a1ca07f940acba84eebcb84e1d5daadc0e1f', sandbox_base: '3002bbd155f91de6c0f6cbbe3548d4c3b6095de3', mode: 'real', sources: ['golden-working'],
  cases: [
    { id: 'golden:B', run: 1, stop: 'final_gate:close', checks: { pass: 8, total: 8 }, contaminated: false, fix_rounds: 0, rework: 0, cost_micro: 3273110, min: 14, blind: { scores: [4, 4], score: 4, pass: true } },
    { id: 'golden:C', run: 1, stop: 'final_gate:close', checks: { pass: 6, total: 6 }, contaminated: false, fix_rounds: 0, rework: 0, cost_micro: 2428301, min: 11, blind: { scores: [5, 4], score: 4, pass: true } },
  ],
  pass: true,
};
const RUN = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const scoreAt = (at, b = {}, pass = true) => ({ ...SCORE, at, pass, cases: [{ ...SCORE.cases[0], ...b }, SCORE.cases[1]] });

test('HL2 EV1 GJ1 no metrics files → every y 0, ok null but rss; POST /api/evals: baseline, a regression, a regressed base skipped, strict 400s, cookie 401, run_id 409; the base from golden.jsonl after metrics.jsonl is gone', async (t) => {
  const tbd = await boot(t);
  const empty = (await tbd.api('GET', '/api/health')).json;
  assert.deepEqual(empty.targets.map((x) => [x.key, x.y, x.ok]), FIX.targets.map((x) => [x.key, x.key === 'rss' ? 80 : 0, x.key === 'rss' ? true : null]));
  assert.deepEqual([empty.bytes_read, empty.cut, empty.doctor], [0, false, null]);

  const M = path.join(tbd.tbHome, 'metrics.jsonl');
  const G = path.join(tbd.tbHome, 'evals', 'golden.jsonl');
  const post = (b, h = {}) => tbd.api('POST', '/api/evals', b, h);
  const line = (s, runId, ok) => ({ t: 'golden', at: s.at, run_id: runId, commit: s.commit, mode: 'real', cases: s.cases.map((c) => ({ id: c.id, pass: c.checks.pass, total: c.checks.total, contaminated: c.contaminated, blind: c.blind?.score ?? null })), pass: s.pass, ok });

  const s1 = scoreAt('2026-10-18T04:35:31.856Z');
  const r1 = await post({ ...s1, run_id: RUN(1) });
  assert.deepEqual([r1.status, r1.json], [201, { line: line(s1, RUN(1), null), base_at: null, verdict: { ok: null, x: 0, y: 0, worse: [], changed: [] } }], 'the first run is the baseline');
  assert.deepEqual([fileLines(G), fileLines(M)], [[r1.json.line], [r1.json.line]], 'GJ1: the same line in golden.jsonl and metrics.jsonl');
  assert.deepEqual([fs.statSync(path.dirname(G)).mode & 0o777, fs.statSync(G).mode & 0o777], [0o700, 0o600]);

  const s2 = scoreAt('2026-10-18T05:00:00.000Z', { checks: { pass: 7, total: 8 }, blind: null }, false);
  const r2 = await post({ ...s2, run_id: RUN(2) });
  assert.deepEqual([r2.status, r2.json.base_at, r2.json.verdict], [201, s1.at, { ok: false, x: 1, y: 2, worse: [{ id: 'golden:B', why: 'fewer checks pass' }], changed: [] }]);
  assert.equal(r2.json.line.ok, false);
  const s3 = scoreAt('2026-10-18T06:00:00.000Z');
  const r3 = await post({ ...s3, run_id: RUN(3) });
  assert.deepEqual([r3.status, r3.json.base_at, r3.json.verdict.ok, r3.json.verdict.x], [201, s1.at, true, 2], 'the regressed run (ok false) is never a base: s1 is');

  /** @type {[any, string][]} */
  const bad = [
    [{ ...s3, run_id: RUN(4), cases: [{ ...s3.cases[0], cost_micro: 3.5 }, s3.cases[1]] }, 'case 1: cost_micro must be a whole number ≥ 0 (micro-USD)'],
    [{ ...s3, run_id: RUN(4), extra: 1 }, `a score must have exactly the keys ${['v', 'kind', 'at', 'commit', 'sandbox_base', 'mode', 'sources', 'cases', 'pass'].join(', ')}`],
    [{ ...s3, run_id: RUN(4), mode: 'dry' }, 'mode must be real: a dry run is never recorded'],
    [{ ...s3, run_id: 'not-a-uuid' }, 'run_id must be a uuid (lower-case hex)'],
    [{ ...s3, run_id: RUN(4), cases: [{ ...s3.cases[0], blind: { scores: [4, 4], score: 5, pass: true } }, s3.cases[1]] }, 'case 1: blind must be null or {scores: 2-3 whole numbers 1-5 (2 at most 1 apart), score, pass} as the harness derives them'],
    [{ ...s3, run_id: RUN(4), pass: false, cases: [{ ...s3.cases[0], blind: { scores: [5, 3], score: 3, pass: false } }, s3.cases[1]] }, 'case 1: blind must be null or {scores: 2-3 whole numbers 1-5 (2 at most 1 apart), score, pass} as the harness derives them'],
  ];
  for (const [b, error] of bad) assert.deepEqual(await post(b).then((x) => [x.status, x.json]), [400, { error }], error);
  assert.deepEqual(await post({ ...s3, run_id: RUN(4) }, await cookieOf(tbd)).then((x) => [x.status, x.json]), [401, { error: 'CLI only: use tb' }]);
  assert.deepEqual(await post({ ...s3, run_id: RUN(1) }).then((x) => [x.status, x.json]), [409, { error: `run_id ${RUN(1)} is recorded already` }]);
  assert.deepEqual([fileLines(G).length, fileLines(M).length], [3, 3], 'no refused body wrote a line');

  fs.renameSync(M, path.join(ROOT, 'metrics-away.jsonl')); // as if rotated twice: no t:golden left in either metrics file
  const s4 = scoreAt('2026-10-18T07:00:00.000Z');
  const r4 = await post({ ...s4, run_id: RUN(5) });
  assert.deepEqual([r4.status, r4.json.base_at, r4.json.verdict.ok], [201, s3.at, true], 'GJ1: the base comes from golden.jsonl');
  assert.deepEqual(fileLines(M), [r4.json.line]);
  assert.deepEqual(await post({ ...s4, run_id: RUN(2) }).then((x) => x.status), 409, 'GJ1: a run_id only golden.jsonl still holds');
});

test('RAM base (D-0176): lib/health.js and lib/evalscore.js load on the first Health open, never with what tbd requires at boot', () => {
  const env = { ...process.env, TB_HOME: path.join(ROOT, 'no-home') };
  const loaded = (pre) => execFileSync(process.execPath, ['-e', `${pre}; process.stdout.write(JSON.stringify(['health', 'evalscore'].map((m) => require.resolve('./lib/' + m) in require.cache)))`], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  const boot = ['store', 'http', 'notify', 'monitor', 'doctor', 'slots', 'runner', 'planning', 'working', 'review', 'qa', 'final', 'pass', 'interview', 'lanes', 'metrics', 'push', 'recovery', 'spawn', 'tbx'];
  assert.equal(loaded(`for (const m of ${JSON.stringify(boot)}) require('./lib/' + m)`), '[false,false]');
  assert.equal(loaded("require('./lib/health')"), '[true,true]', 'positive control');
});

// HL4 (D-0178: the live setup, no V8 flag; temporary peaks accepted): the contract is "no growing cache" (m7-build RAM
// budget), not an absolute RSS (macOS compresses idle pages, V8 grows its young space under load and keeps it). After
// one warm-up GET, two batches of 100 sequential GETs: young-space growth plateaus in batch 1, a cache or leak grows again
// in batch 2. RSS per batch = the median of 5 reads 1 s apart. The 5 MB is shaped as live data: t:run (1 in 100
// interrupted) + t:gate over 25 days.
test('HL4 RAM: 5 MB metrics, warm-up GET, then 2 batches of 100 sequential GET /api/health → RSS after batch 2 ≤ after batch 1 + 4 MB (no growing cache)', async (t) => {
  const at = (i) => new Date(NOW - 25 * 86_400_000 + i * 60_000).toISOString();
  const head = (i) => String(i % 16).repeat(40).slice(0, 40).replace(/1[0-5]/g, 'a');
  const line = (i) => (i % 3 === 2
    ? { t: 'gate', at: at(i), ticket: `t_r${String(i % 500).padStart(4, '0')}`, task: 'T1', gate: 'task', check: 'unit', ok: i % 9 !== 2, exit: 0, class: null, ms: 4000, slot_wait_ms: 0, head: head(i), attempt: 1, flaky: false, failfirst: null, detail: null, peak_rss_mb: 120 }
    : { t: 'run', ticket: `t_r${String(i % 500).padStart(4, '0')}`, phase: 'working', task: 'T1', model: 'opus', effort: 'xhigh', started: at(i - 20), ended: at(i), exit: i % 100 ? 'result' : 'crash', turns: 9, cost_delta: 1000, peak_rss_mb: 300, subagents_peak: 0, slot_wait_ms: 0, resumed: false });
  let text = '';
  for (let i = 20; text.length < 5 << 20; i++) text += `${JSON.stringify(line(i))}\n`;
  const tbd = await boot(t, { 'metrics.jsonl': text });
  const pid = fs.readFileSync(path.join(tbd.tbHome, 'tbd.pid'), 'utf8').trim();
  const rss = () => Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim()) / 1024;
  const batch = async () => {
    for (let i = 0; i < 100; i++) assert.equal((await tbd.api('GET', '/api/health')).status, 200);
    const reads = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      reads.push(rss());
    }
    return reads.sort((a, b) => a - b)[2];
  };
  assert.equal((await tbd.api('GET', '/api/health')).status, 200);
  const r1 = await batch();
  const r2 = await batch();
  assert.ok(r2 <= r1 + 4, `RSS batch 1 ${r1.toFixed(1)} MB → batch 2 ${r2.toFixed(1)} MB`);
});
