'use strict';
// P3d (plan P3 AC11; contract T9 T10 T11 T12): `tb eval chaos` through a real tbd (harness temp HOME + TB_HOME),
// test/fake-claude.js as claude_bin, test/helpers/run-spy.js in tbd and test/helpers/chaos-spy.js in tb (signals reach
// only this test's fake-claude processes, launchctl never runs); POST /api/drills; scripts/chaos.js with an injected
// launchctl (plutil runs for real). The drills on a real launchd job and real claude: the orchestrator's P3d run.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startTbd, runTb, REPO } = require('./helpers/tbd');
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
