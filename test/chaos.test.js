'use strict';
// P3d (plan P3 AC11; contract T9 T10 T11 T12): `tb eval chaos` through a real tbd (harness temp HOME + TB_HOME),
// test/fake-claude.js as claude_bin, test/helpers/run-spy.js in tbd and test/helpers/chaos-spy.js in tb (signals reach
// only this test's fake-claude processes, launchctl never runs); POST /api/drills; scripts/chaos.js with an injected
// launchctl (plutil runs for real). The drills on a real launchd job and real claude: the orchestrator's P3d run.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startTbd, runTb, isolatedEnv, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, lines, spyLog, until, alive, reap, pidsOf } = require('./helpers/runs');
const chaos = require('../scripts/chaos');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
fs.mkdirSync(path.join(PHASES, 'code/planning'), { recursive: true });
for (const [f, c] of Object.entries({ 'prompt.md': '# planning fixture\n', 'settings.json': '{"permissions":{"allow":["Read"]}}', 'result.schema.json': '{"type":"object"}' })) {
  fs.writeFileSync(path.join(PHASES, 'code/planning', f), c);
}
const CONFIG = { // admission always yes from config, unless critical pressure
  claude_bin: FAKE,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const CHAOS_SPY = `--require ${path.join(__dirname, 'helpers', 'chaos-spy.js')}`;
const tb = (tbd, ...args) => runTb(['eval', 'chaos', ...args], tbd, { NODE_OPTIONS: CHAOS_SPY });
const drills = (tbd) => lines(path.join(tbd.tbHome, 'metrics.jsonl')).filter((l) => l.t === 'drill');

// One ticket in planning; its runs follow scenario (fake-claude, read from <ticket dir>/scenario.json).
async function boot(t, id, scenario) {
  const tbd = await startTbd({
    files: { 'config.json': CONFIG, [`tickets/${id}/ticket.json`]: ticket(id), [`tickets/${id}/scenario.json`]: scenario },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: 'scenario.json' },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return tbd;
}

test('T11 POST /api/drills: a valid drill → 201 + its t:drill line in metrics.jsonl; bad bodies → 400, the UI cookie → 401 (CLI only), no line. T9 usage: no live run → exit 1, unknown drill → exit 2', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  const r = await tbd.api('POST', '/api/drills', { name: 'kill-tbd', ok: true, note: 'back in 12s' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json, { t: 'drill', at: r.json.at, name: 'kill-tbd', ok: true, note: 'back in 12s' });
  assert.equal(new Date(r.json.at).toISOString(), r.json.at, 'at: ISO-8601 UTC');
  assert.deepEqual(drills(tbd), [r.json]);
  for (const b of [{ name: 'wifi_off_5min', ok: true }, { name: 'lid', ok: 'yes' }, { name: 'lid', ok: false, note: 'x'.repeat(201) }, { name: 'lid', ok: false, extra: 1 }, ['lid'], null]) {
    const bad = await tbd.api('POST', '/api/drills', b);
    assert.equal(bad.status, 400, JSON.stringify(b));
    assert.match(bad.json.error, /^body must be \{"name": "kill-tbd\|/);
  }
  const ui = await tbd.api('POST', '/api/drills', { name: 'lid', ok: true }, { 'x-tb-token': undefined, cookie: await tbd.unlock(), 'sec-fetch-site': 'same-origin' });
  assert.deepEqual([ui.status, ui.json], [401, { error: 'CLI only: use tb' }]);
  assert.deepEqual(drills(tbd), [r.json], 'only the valid drill wrote a line');

  const none = await tb(tbd, 'kill-claude');
  assert.deepEqual([none.code, none.stdout], [1, 'error: no live run to drill\nhelp: tb list --flows\n']);
  const bad = await tb(tbd, 'kill-all');
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /^error: eval chaos needs one drill of kill-tbd, kill-claude, restart, freeze, wifi, lid, reboot/);
  // M7 CH3: disk + memory joined DRILLS
  for (const name of ['disk', 'memory']) assert.equal((await tbd.api('POST', '/api/drills', { name, ok: true, note: 'x' })).status, 201, name);
});

test('T9 kill-claude end to end: the run\'s claude SIGKILLed (pid checked first) → tbd recovers it (--resume, run 2 ends result) → healthy → one t:drill line, exit 0', async (t) => {
  const say = { emit: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'back' }] } } };
  const tbd = await boot(t, 't_kill01', { steps: [{ sleep_ms: 60_000 }], resume_steps: [say, { sleep_ms: 500 }, { result: { structured_output: { answer: 'resumed' } } }] });
  const l1 = await until(() => read(tbd, 't_kill01').lease?.pid && read(tbd, 't_kill01').lease, 15_000, 'run 1 live');
  const r = await tb(tbd, 'kill-claude');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^drill: kill-claude\nok: true\nnote: "healthy after \d+s: run 2 result"\n$/);
  assert.deepEqual(spyLog(tbd, 'test-cli-kills.jsonl'), [{ pid: l1.pid, sig: 'SIGKILL', ok: true }]);
  assert.equal(alive(l1.pid), false);
  const l2 = read(tbd, 't_kill01').lease;
  assert.deepEqual([l2.gen, l2.exit, l2.resumed, l2.session], [2, 'result', true, l1.session]);
  const [d] = drills(tbd);
  assert.match(d.note, /^healthy after \d+s: run 2 result$/);
  assert.deepEqual(drills(tbd), [{ t: 'drill', at: d.at, name: 'kill-claude', ok: true, note: d.note }]);
  assert.deepEqual(spyLog(tbd, 'test-cli-exec.jsonl'), [], 'kill-claude needs no launchctl');
});

test('T10 pids from tbd are signalled only when ps shows what tbd says: a run not of config claude_bin, a tbd.pid naming another program → refused, exit 1; no signal, no launchctl, no drill line', async (t) => {
  const tbd = await boot(t, 't_refu01', { steps: [{ hang: true }] });
  const l = await until(() => read(tbd, 't_refu01').lease?.pid && read(tbd, 't_refu01').lease, 15_000, 'run live');
  // tbd read its config at start: the run is still the fake; tb reads config.json now
  fs.writeFileSync(path.join(tbd.tbHome, 'config.json'), JSON.stringify({ ...CONFIG, claude_bin: '/opt/nowhere/claude-9.9.9' }));
  const r = await tb(tbd, 'kill-claude');
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`^error: refused: pid ${l.pid} is not t_refu01's /opt/nowhere/claude-9\\.9\\.9 run \\(ps: .*fake-claude\\.js .*\\); no signal sent\\n$`));

  const decoy = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  t.after(() => decoy.kill('SIGKILL'));
  fs.writeFileSync(path.join(tbd.tbHome, 'tbd.pid'), String(decoy.pid));
  const k = await tb(tbd, 'kill-tbd');
  assert.equal(k.code, 1, k.stdout);
  assert.match(k.stdout, new RegExp(`^error: refused: pid ${decoy.pid} is not tbd \\(ps: /bin/sleep 60\\); no signal sent\\n$`));

  assert.deepEqual(spyLog(tbd, 'test-cli-kills.jsonl'), [], 'no signal sent');
  assert.deepEqual(spyLog(tbd, 'test-cli-exec.jsonl'), [], 'no launchctl');
  assert.ok(alive(l.pid) && alive(decoy.pid), 'both untouched');
  assert.deepEqual(drills(tbd), []);
});

test('T12 chaos.js: a label other than local.taskboard.chaos → refused before anything; up renders a plist plutil accepts and bootstraps it; seed + kickstart; down twice = bootout, plist gone, checked gone; still loaded or a chaos.json naming the live label → refused', async (t) => {
  const calls = [];
  let loaded = false;
  const launchctl = (args) => {
    calls.push(args);
    const was = loaded;
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return { status: ['bootout', 'print'].includes(args[0]) && !was ? 3 : 0 }; // 3: not loaded
  };
  await assert.rejects(chaos.up({ env: { TB_LABEL: 'local.taskboard' }, launchctl }), /refusing label "local\.taskboard"/);
  assert.deepEqual(calls, [], 'no launchctl call');

  const s = await chaos.up({ env: {}, launchctl, claudeBin: '/opt/x/claude-2.1.295' });
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const dom = `gui/${process.getuid()}`;
  const plist = path.join(s.home, 'local.taskboard.chaos.plist');
  const get = (k) => execFileSync('/usr/bin/plutil', ['-extract', k, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.deepEqual(['Label', 'ProgramArguments.1', 'EnvironmentVariables.TB_HOME', 'EnvironmentVariables.TB_PORT', 'EnvironmentVariables.TB_PHASES_DIR', 'EnvironmentVariables.TB_LABEL'].map(get),
    ['local.taskboard.chaos', path.join(REPO, 'tbd.js'), s.home, String(s.port), path.join(s.home, 'phases'), 'local.taskboard.chaos']);
  assert.match(get('EnvironmentVariables.NODE_OPTIONS'), /^--require ".*\/test\/helpers\/fake-handlers\.js"$/);
  assert.doesNotMatch(fs.readFileSync(plist, 'utf8'), /@[A-Z]+@/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).claude_bin, '/opt/x/claude-2.1.295');
  assert.deepEqual(calls, [['bootstrap', dom, plist]]);

  const p = chaos.seed('planted', { home: s.home, launchctl });
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'ticket.json'), 'utf8')).state, 'planning');
  assert.ok(JSON.parse(fs.readFileSync(path.join(p.dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart);
  assert.deepEqual(calls.at(-1), ['kickstart', '-k', `${dom}/local.taskboard.chaos`]);

  calls.length = 0;
  assert.deepEqual(chaos.down({ home: s.home, launchctl }).live, []);
  assert.equal(fs.existsSync(plist), false);
  chaos.down({ home: s.home, launchctl }); // already gone: fine
  assert.deepEqual(calls, [['bootout', `${dom}/local.taskboard.chaos`], ['print', `${dom}/local.taskboard.chaos`], ['bootout', `${dom}/local.taskboard.chaos`], ['print', `${dom}/local.taskboard.chaos`]]);

  assert.throws(() => chaos.down({ home: s.home, launchctl: () => ({ status: 0 }) }), /local\.taskboard\.chaos is still loaded after bootout/);
  fs.writeFileSync(path.join(s.home, 'chaos.json'), JSON.stringify({ label: 'local.taskboard', port: s.port }));
  calls.length = 0;
  assert.throws(() => chaos.down({ home: s.home, launchctl }), /refusing label "local\.taskboard"/);
  assert.deepEqual(calls, [], 'the live label is never booted out');
});

// M7 CH1 CH2 (m7-build.md lane M-B): the disk and memory drills. A real tbd cannot see a disk the test never fills, so a
// tbd stand-in answers (token x: whoami, the one live flow, its ticket + system as the drill moves on, POST /api/drills
// kept) and every statfs, file, signal, ps, sysctl, sleep and spawn of tb goes through this preload (sys swap):
// TB_HOME/sys.json scripts them, TB_HOME/sys.jsonl logs them in order. No byte is written, no signal sent, no
// memory_pressure runs.
const SYS_SPY = path.join(ROOT, 'sys-spy.js');
fs.writeFileSync(SYS_SPY, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sys } = require(${JSON.stringify(path.join(REPO, 'lib', 'cli'))});
const home = process.env.TB_HOME;
const S = JSON.parse(fs.readFileSync(path.join(home, 'sys.json'), 'utf8'));
const log = (o) => fs.appendFileSync(path.join(home, 'sys.jsonl'), JSON.stringify(o) + '\\n');
let bytes = 0, calls = 0, reads = 0;
sys.statfs = async () => { const free = S.free - bytes + (S.back ?? 0) * calls++; log({ op: 'statfs', free }); return { bavail: free, bsize: 1 }; };
sys.open = async (file, flags, mode) => {
  log({ op: 'open', file, flags, mode });
  return { write: async (b, o, n) => { if (!bytes) log({ op: 'write' }); bytes += n; return { bytesWritten: n }; }, close: async () => log({ op: 'close', bytes }) };
};
sys.unlink = async (file) => log({ op: 'unlink', file });
sys.kill = (pid, sig) => log({ op: 'kill', pid, sig });
sys.exec = async (file, args) => {
  if (file === '/bin/ps') return { err: null, stdout: S.ps + '\\n', stderr: '' };
  const level = S.levels[Math.min(reads++, S.levels.length - 1)];
  log({ op: 'sysctl', file, args, level });
  return { err: null, stdout: level + '\\n', stderr: '' };
};
sys.sleep = () => new Promise((ok) => setTimeout(ok, S.sleep_ms ?? 0));
sys.spawn = (file, args) => {
  log({ op: 'spawn', file, args });
  return { pid: 4242, done: S.eperm ? Promise.resolve({ code: 255, out: 'sysctl: kern.memorypressure_manual_trigger failed : Operation not permitted\\n' }) : new Promise(() => {}) };
};
`);
const GB = 1024 ** 3;
const ID = 't_drll01';
const BIN = '/opt/x/claude-2.1.296';
const SESSION = '11111111-2222-4333-8444-555555555555';
const [A, B] = ['2026-10-18T01:00:00.000Z', '2026-10-18T01:30:00.000Z'];
const LIVE = { gen: 1, pid: 31337, pgid: 31337, session: SESSION, phase: 'working', started_at: A, last_event_at: A };
const ALERT = 'tbd: alert: Disk almost full: new runs stopped\n';
const sysLog = (home) => {
  const f = path.join(home, 'sys.jsonl');
  return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); // a line half written: next read
};

// A TB_HOME (token x, config: BIN + disk.stop_gb, sys.json) and its tbd stand-in. system(ops) / ticket(ops): what tbd
// answers once the spy logged ops. → {home, port, drills, tb(...args), ops()}
async function drillBoard(t, { stop = 10, spy, system, ticket, log = '' }) {
  const home = fs.mkdtempSync(path.join(ROOT, 'd-'));
  fs.writeFileSync(path.join(home, 'token'), 'x');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude_bin: BIN, disk: { warn_gb: stop + 5, stop_gb: stop } }));
  fs.writeFileSync(path.join(home, 'sys.json'), JSON.stringify({ ps: `${BIN} -p --session-id ${SESSION} --output-format stream-json`, levels: [1], ...spy }));
  fs.writeFileSync(path.join(home, 'tbd.log'), log);
  const drills = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const ops = sysLog(home).map((x) => x.op);
    if (u.pathname === '/api/whoami') return send({ mac: crypto.createHmac('sha256', 'x').update(String(u.searchParams.get('n'))).digest('hex') });
    if (u.pathname === '/api/state') return send({ reminders: [], flows: [{ id: ID, kind: 'code', tag: 'shop', state: 'working', title: 'drill', waiting: null }], system: { runs: 1, ...system(ops) } });
    if (u.pathname === `/api/tickets/${ID}`) return send({ ticket: { id: ID, kind: 'code', state: 'working', waiting: null, ...ticket(ops) } });
    if (req.method === 'POST' && u.pathname === '/api/drills') {
      let b = '';
      req.on('data', (c) => (b += c));
      return void req.on('end', () => { drills.push(JSON.parse(b)); send({}, 201); });
    }
    send({ error: 'not found' }, 404);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(undefined)));
  t.after(() => server.close());
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const env = { NODE_OPTIONS: `--require ${SYS_SPY}` };
  return { home, port, drills, env, tb: (...args) => runTb(['eval', 'chaos', ...args], { tbHome: home, port, home }, env), ops: () => sysLog(home) };
}
const opsOf = (b) => b.ops().map((x) => x.op);

// The disk drill's tbd: full once the spy wrote (the alert line then lands in tbd.log, once); the run's claude killed →
// the recovery waits on disk; the fd closed → run 2 ended result. started: the recovery starts run 2 at once instead.
function diskTbd(home, { alert = true, started = false } = {}) {
  let said = false;
  return {
    system: (ops) => {
      if (!ops.includes('write')) return { disk_free: 12 * GB, disk_warn: false };
      if (alert && !said) fs.appendFileSync(path.join(home(), 'tbd.log'), ALERT);
      said = true;
      return { disk_free: 9 * GB, disk_warn: true };
    },
    ticket: (ops) => (!ops.includes('kill') ? { lease: LIVE }
      : started ? { lease: { ...LIVE, gen: 2, started_at: B, last_event_at: B } }
        : !ops.includes('close') ? { lease: { ...LIVE, gen: 2, exit: 'crash', pending: { after: 'resume' } }, waiting: { reason: 'disk', since: B } }
          : { lease: { ...LIVE, gen: 2, started_at: B, last_event_at: B, exit: 'result' } }),
  };
}

test('CH1 disk (+): the fill file is unlinked before the first write; bytes = free − (stop_gb − 1); tbd full + its alert → the run\'s claude SIGKILLed → disk wait, no run → fd closed → healthy → one t:drill, exit 0', async (t) => {
  let home = '';
  const b = await drillBoard(t, { spy: { free: 12 * GB }, ...diskTbd(() => home) });
  home = b.home;
  const r = await b.tb('disk', '--min', '1');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\ndrill: disk\nok: true\nnote: "filled 3\.0 GB; held 1 min; healthy after \d+s: run 2 result"\n$/);
  const ops = b.ops();
  const at = (op) => ops.findIndex((x) => x.op === op);
  assert.deepEqual([ops[at('open')].flags, ops[at('open')].mode, path.dirname(ops[at('open')].file)], ['wx', 0o600, b.home]);
  assert.match(path.basename(ops[at('open')].file), /^chaos-fill-\d+\.bin$/);
  assert.deepEqual([at('unlink'), at('write')], [at('open') + 1, at('open') + 2], 'unlinked at once, before the first byte');
  assert.equal(ops[at('unlink')].file, ops[at('open')].file);
  assert.deepEqual(ops.filter((x) => x.op === 'kill'), [{ op: 'kill', pid: 31337, sig: 'SIGKILL' }]);
  assert.ok(at('kill') > at('write') && at('close') > at('kill'), 'claude killed on the full disk, the fd closed after the hold');
  assert.deepEqual(ops.filter((x) => x.op === 'close'), [{ op: 'close', bytes: 3 * GB }], '12 GB free − 9 GB target');
  assert.equal(b.drills.length, 1);
  assert.deepEqual([b.drills[0].name, b.drills[0].ok], ['disk', true]);
  assert.match(b.drills[0].note, /^filled 3\.0 GB; held 1 min; healthy after \d+s: run 2 result$/);
});

test('CH1 disk (+): a statfs that shows space coming back still stops at --max-gb; SIGINT during the hold closes the fd, exit 130, no drill line', async (t) => {
  let home = '';
  const b = await drillBoard(t, { spy: { free: 12 * GB, back: 2 * GB, sleep_ms: 300 }, ...diskTbd(() => home) });
  home = b.home;
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'tb'), 'eval', 'chaos', 'disk', '--max-gb', '4', '--min', '1'],
    { env: isolatedEnv({ home: b.home, tbHome: b.home, port: b.port }, b.env), stdio: 'ignore' });
  const code = new Promise((ok) => child.on('close', (c) => ok(c)));
  await until(() => opsOf(b).includes('kill'), 15_000, 'claude killed: the hold began');
  child.kill('SIGINT');
  assert.equal(await code, 130);
  assert.deepEqual(b.ops().filter((x) => x.op === 'close'), [{ op: 'close', bytes: 4 * GB }], 'the cap, though statfs kept showing room');
  assert.deepEqual(b.drills, []);
});

test('CH1 disk (−): a fill over --max-gb, free space already under stop_gb, or stop_gb − 1 under 6 GB → refused, exit 1: no file, 0 bytes, no signal, no drill line', async (t) => {
  for (const [stop, free, why] of /** @type {[number, number, RegExp][]} */ ([
    [10, 40 * GB, /^error: refused: filling to 9 GB free takes 31\.0 GB, over --max-gb 20; nothing written$/m],
    [10, 9 * GB, /^error: refused: 9\.0 GB free is under disk\.stop_gb 10 GB already; nothing written$/m],
    [6, 8 * GB, /^error: refused: 5 GB free \(disk\.stop_gb − 1\) is under 6 GB, too close to swap on this Mac; nothing written$/m]])) {
    let home = '';
    const b = await drillBoard(t, { stop, spy: { free }, ...diskTbd(() => home) });
    home = b.home;
    const r = await b.tb('disk');
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, why);
    assert.deepEqual(opsOf(b), ['statfs'], `${stop} GB stop, ${free / GB} GB free: nothing opened, written or signalled`);
    assert.deepEqual(b.drills, []);
  }
});

test('CH1 disk (−): a run started while the disk is full, or only an alert from before the fill in tbd.log → ok false (named), the fd closed, exit 1', async (t) => {
  let home = '';
  const b = await drillBoard(t, { spy: { free: 12 * GB }, ...diskTbd(() => home, { started: true }) });
  home = b.home;
  const r = await b.tb('disk', '--min', '1');
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(b.drills, [{ name: 'disk', ok: false, note: 'filled 3.0 GB; a run started on a full disk (run 2)' }]);
  assert.deepEqual(b.ops().filter((x) => x.op === 'close'), [{ op: 'close', bytes: 3 * GB }]);

  let home2 = '';
  const old = await drillBoard(t, { spy: { free: 12 * GB }, log: ALERT, ...diskTbd(() => home2, { alert: false }) });
  home2 = old.home;
  const r2 = await old.tb('disk');
  assert.equal(r2.code, 1, r2.stdout);
  assert.deepEqual(old.drills, [{ name: 'disk', ok: false, note: 'filled 3.0 GB; within 60 s: no "tbd: alert: Disk almost full: new runs stopped" in tbd.log' }]);
  assert.equal(opsOf(old).includes('kill'), false, 'no kill once the drill failed');
  assert.deepEqual(old.ops().filter((x) => x.op === 'close'), [{ op: 'close', bytes: 3 * GB }]);
});

// The memory drill's tbd: critical once memory_pressure was spawned (here or by hand), the run paused (run 2); once the
// level was read back (the simulation over) → run 3 ended result.
const memTbd = {
  system: (ops) => ({ pressure: ops.includes('spawn') ? 'critical' : 'normal' }),
  ticket: (ops) => ({ lease: ops.includes('sysctl') ? { ...LIVE, gen: 3, started_at: B, last_event_at: B, exit: 'result' } : ops.includes('spawn') ? { ...LIVE, gen: 2, exit: 'paused' } : LIVE }),
};

test('CH2 memory (+): memory_pressure -S -l critical -s 120 in its own group, tbd critical + the run paused, the child\'s group killed at the end, the level polled until 1 → healthy, exit 0', async (t) => {
  const b = await drillBoard(t, { spy: { levels: [4, 1] }, ...memTbd });
  const r = await b.tb('memory');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const ops = b.ops();
  assert.deepEqual(ops.filter((x) => x.op === 'spawn'), [{ op: 'spawn', file: '/usr/bin/memory_pressure', args: ['-S', '-l', 'critical', '-s', '120'] }]);
  assert.deepEqual(ops.filter((x) => x.op === 'kill'), [{ op: 'kill', pid: -4242, sig: 'SIGTERM' }]);
  assert.deepEqual(ops.filter((x) => x.op === 'sysctl').map((x) => [x.file, ...x.args, x.level]), [['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 4], ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 1]]);
  assert.ok(ops.findIndex((x) => x.op === 'kill') < ops.findIndex((x) => x.op === 'sysctl'), 'the child ends before the level check');
  assert.equal(b.drills.length, 1);
  assert.match(b.drills[0].note, /^memory_pressure here 120 s; paused run 2; healthy after \d+s: run 3 result$/);
  assert.equal(b.drills[0].ok, true);
});

test('CH2 memory (−): memory_pressure needs root (EPERM) → the sudo step printed, then watched as the same drill; a level stuck at 4 → ok false + the recovery steps, exit 1', async (t) => {
  const b = await drillBoard(t, { spy: { eperm: true }, ...memTbd });
  const r = await b.tb('memory');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('  1. memory_pressure needs root on this Mac: run `sudo memory_pressure -S -l critical -s 120` in another Terminal now.\n'), r.stdout);
  assert.equal(opsOf(b).includes('kill'), false, 'a dead child\'s group is never signalled');
  assert.match(b.drills[0].note, /^memory_pressure by hand \(sudo\) 120 s; paused run 2; healthy after \d+s: run 3 result$/);

  const stuck = await drillBoard(t, { spy: { levels: [4] }, ...memTbd });
  const s = await stuck.tb('memory', '--min', '1');
  assert.equal(s.code, 1, s.stdout);
  assert.ok(s.stdout.includes('alert: memory pressure level stuck at 4 after the drill\nrecovery:\n'), s.stdout);
  assert.ok(s.stdout.includes('  3. still not 1: tell Irfan: pressure level stuck at 4\n'), s.stdout);
  assert.deepEqual(stuck.ops().find((x) => x.op === 'spawn').args, ['-S', '-l', 'critical', '-s', '60']);
  assert.deepEqual(stuck.drills, [{ name: 'memory', ok: false, note: 'memory_pressure here 60 s; pressure level stuck at 4 after the drill' }]);
});

// E2E gap: a drill target is a LIVE run (pid, no exit, not ended, no recovery pending, the ticket waiting on nothing): a
// lease that ended while its pid (an orphan) still lives is refused before any signal, by id or by the auto-pick; a disk
// drill whose run ends during the fill never kills.
test('a drill target must be a live run: a lease with exit + ended_at whose pid still lives → refused (named), no signal, no drill line; the run ending during the disk fill → ok false, no kill', async (t) => {
  const ended = { lease: { ...LIVE, exit: 'interrupted', ended_at: B }, waiting: { reason: 'slot', since: B } };
  const b = await drillBoard(t, { spy: {}, system: () => ({}), ticket: () => ended });
  const byId = await b.tb('kill-claude', ID);
  assert.deepEqual([byId.code, byId.stdout], [1, `error: no live run on ${ID}: slot\nhelp: tb list --flows\n`]);
  const auto = await b.tb('kill-claude');
  assert.deepEqual([auto.code, auto.stdout], [1, 'error: no live run to drill\nhelp: tb list --flows\n']);
  assert.deepEqual([opsOf(b), b.drills], [[], []], 'no ps-checked signal, nothing recorded');

  let home = '';
  const tbd = diskTbd(() => home);
  const gone = await drillBoard(t, { spy: { free: 12 * GB }, system: tbd.system, ticket: (ops) => (ops.includes('write') ? { lease: { ...LIVE, exit: 'crash', ended_at: B } } : { lease: LIVE }) });
  home = gone.home;
  const r = await gone.tb('disk');
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(gone.drills, [{ name: 'disk', ok: false, note: 'filled 3.0 GB; the run ended before the kill: crash' }]);
  assert.equal(opsOf(gone).includes('kill'), false, 'the orphan pid is never signalled');
  assert.deepEqual(gone.ops().filter((x) => x.op === 'close'), [{ op: 'close', bytes: 3 * GB }]);
});
