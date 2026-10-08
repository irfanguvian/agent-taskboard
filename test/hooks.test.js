'use strict';
// P2 AC3 bash-guard (heavy rewrite, worker pins, quoting proven by running the rewrite through real tbx + tbd),
// D35 deny table + near misses, path-guard, subagent-count (AC5 via the hook, socket-down fallback).
// Hook I/O schema: code.claude.com/docs/en/hooks (PreToolUse hookSpecificOutput permissionDecision / updatedInput).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startTbd, isolatedEnv, SLOT_ROOT, REPO } = require('./helpers/tbd');
const { call } = require('../lib/slots');
const { guard } = require('../hooks/bash-guard');
const { check } = require('../hooks/path-guard');

const HOOKS = path.join(REPO, 'hooks');
let tbd;
let sock;
let tmp;
before(async () => {
  tbd = await startTbd({ env: { NODE_OPTIONS: SLOT_ROOT } }); // F2: tbx run from this test process may hold the slot
  sock = path.join(tbd.tbHome, 'tbd.sock');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-'));
  fs.symlinkSync(path.join(REPO, 'bin', 'tbx'), path.join(tmp, 'tbx'));
});
after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await tbd.stop();
});

// Runs a hook script with JSON on stdin → {code, out (parsed stdout or ''), stderr, ms}.
function hook(name, input, extra = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(HOOKS, name)], { env: { ...isolatedEnv(tbd), TBD_SOCK: sock, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  return new Promise((r) => child.on('close', (code) => r({ code, out: stdout ? JSON.parse(stdout) : '', stderr, ms: Date.now() - t0 })));
}
function sh(command, extra = {}) {
  const child = spawn('/bin/sh', ['-c', command], { env: { ...isolatedEnv(tbd), TBD_SOCK: sock, PATH: `${tmp}:${process.env.PATH}`, ...extra }, cwd: tmp });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  return new Promise((r) => child.on('close', (code) => r({ code, stdout })));
}

const HEAVY = { TB_HEAVY: JSON.stringify(['npm run build', 'npm test', 'docker build', 'npx jest']) };
const wrap = (c) => `tbx heavy -- sh -c '${c}'`;

test('AC3 bash-guard rewrites heavy commands whole, pins jest/playwright workers, leaves the rest alone', () => {
  const cases = [
    ['cd x && npm run build', wrap('cd x && npm run build')],
    ['NODE_ENV=test npm test -- --watch=false', wrap('NODE_ENV=test npm test -- --watch=false')],
    ['docker build -t app .', wrap('docker build -t app .')],
    ['docker ps', null],
    ['npm run lint && npm run build:prod', null], // leading words must equal a prefix's words
    ['npx jest --maxWorkers=4 src', wrap('npx jest --maxWorkers=2 src')],
    ['jest --maxWorkers 50% src', 'jest --maxWorkers=2 src'],
    ['./node_modules/.bin/jest src', './node_modules/.bin/jest --maxWorkers=2 src'],
    ['cd a && npx jest -w 8', wrap('cd a && npx jest --maxWorkers=2')],
    ['npx playwright test --workers=4 e2e', 'npx playwright test --workers=1 e2e'],
    ['npx playwright test', 'npx playwright test --workers=1'],
    ['npx playwright show-report', null],
  ];
  for (const [cmd, want] of cases) {
    const r = guard(cmd, HEAVY);
    assert.deepEqual(r, want === null ? null : { command: want }, cmd);
    if (want) assert.ok((want.match(/--maxWorkers|--workers/g) ?? []).length <= 1, `not doubled: ${want}`);
  }
  assert.equal(guard('npm test', {}), null, 'no TB_HEAVY → no wrap');
});

test("AC3 quoting survives the rewrite: ' \" $() backticks newlines run the same through real tbx + tbd", async () => {
  const env = { TB_HEAVY: JSON.stringify(['echo', 'printf', 'cd']) };
  const cmds = [
    'echo "it\'s $(echo sub) `echo bt`"; printf \'%s|\' \'a"b\' "c\'d" \'$HOME\'',
    "echo one\necho 'two  spaced'\nprintf '%s\\n' \"$((1+2))\" '\\\\'",
    'cd / && echo "$PWD" && echo \'single \'"\'"\' mixed\'',
  ];
  for (const cmd of cmds) {
    const r = guard(cmd, env);
    assert.ok(r?.command.startsWith("tbx heavy -- sh -c '"), cmd);
    const [want, got] = await Promise.all([sh(cmd), sh(r.command)]);
    assert.equal(want.code, 0);
    assert.deepEqual(got, want, `rewrite of ${JSON.stringify(cmd)}`);
  }
  assert.deepEqual((await call(sock, { op: 'status' })).slots.heavy.held, [], 'slot released after each');
});

test('D35 bash-guard deny table: every contract pattern denied with a what-to-do reason; near misses allowed', () => {
  const env = { TBD_SOCK: '/opt/tbh/tbd.sock' };
  /** @type {[string, RegExp][]} */
  const denied = [
    ['tbx heavy -- npm test', /run the plain command/],
    ['TBX_LEASE=abc npm test', /TBX_LEASE belongs to tbx/],
    ['echo $TBX_LEASE', /TBX_LEASE/],
    ['cat ~/.taskboard/token', /tbx status/],
    ['cat /Users/me/.taskboard/session', /tbx status/],
    ['cat /opt/tbh/token', /tbx status/], // live TB_HOME taken from TBD_SOCK
    ['nc -U ~/.taskboard/tbd.sock', /only through tbx/],
    ['curl -s http://127.0.0.1:7777/api/state', /tbx status/],
    ['curl localhost:7777/api/tasks -X POST', /tbx status/],
    ['curl 0.0.0.0:7777', /tbx status/],
    ['nc localhost 7777', /tbx status/],
    ['pkill -f tbd.js', /by pid/],
    ['killall node', /by pid/],
    ['git push origin main', /pipeline pushes/],
    ['git -C ../repo push', /pipeline pushes/],
    ['git --no-pager push --force', /pipeline pushes/],
    ['tb done t_abc123', /pipeline/],
    ['~/bin/tb add "buy milk"', /pipeline/],
    ['taskboard-axi move x now', /pipeline/],
    ['cd a && tb notify-test', /pipeline/],
  ];
  for (const [cmd, why] of denied) {
    const r = guard(cmd, env);
    assert.ok(r?.deny, `should deny: ${cmd}`);
    assert.match(r.deny, /^bash-guard: /);
    assert.match(r.deny, why, cmd);
  }
  assert.ok(guard('curl 127.0.0.1:8123', { TB_PORT: '8123' })?.deny, 'TB_PORT honoured');
  const allowed = [
    'grep token README.md', 'ls ~/.taskboard', 'tbx status', 'tb --help', 'tb list', 'curl localhost:3000',
    'curl localhost:77770', 'git commit -m "push fix"', 'git log --grep=push', 'kill 12345', 'echo stb add', 'npm run tb:add',
  ];
  for (const cmd of allowed) assert.equal(guard(cmd, env), null, `should allow: ${cmd}`);
});

test('bash-guard hook I/O: deny and rewrite JSON per hooks docs, other tool_input fields kept, bad input allowed', async () => {
  const input = (command) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd', timeout: 1000 } });
  const d = await hook('bash-guard.js', input('pkill node'));
  assert.equal(d.code, 0);
  assert.deepEqual(Object.keys(d.out.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  assert.equal(d.out.hookSpecificOutput.permissionDecision, 'deny');
  const w = await hook('bash-guard.js', input('npm test'), HEAVY);
  assert.deepEqual(w.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: wrap('npm test'), description: 'd', timeout: 1000 } } });
  const ok = await hook('bash-guard.js', input('ls'), HEAVY);
  assert.deepEqual([ok.code, ok.out], [0, '']);
  const bad = await hook('bash-guard.js', 'not json');
  assert.deepEqual([bad.code, bad.out], [0, '']);
  assert.match(bad.stderr, /bash-guard: hook input is not JSON; allowing/);
});

test('path-guard: writes inside TB_WRITE_ROOTS allowed; outside, ../ escapes and symlinks out denied', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'wt-'));
  const out = fs.mkdtempSync(path.join(tmp, 'out-'));
  fs.symlinkSync(out, path.join(root, 'link'));
  fs.symlinkSync(path.join(out, 'nope.txt'), path.join(root, 'dangling'));
  const env = { TB_WRITE_ROOTS: JSON.stringify([root]) };
  const edit = (file_path, cwd = root) => check({ cwd, tool_name: 'Write', tool_input: { file_path } }, env);
  assert.equal(edit(path.join(root, 'src', 'new', 'a.js')), null);
  assert.equal(edit('src/a.js'), null, 'relative to cwd');
  for (const p of [path.join(out, 'a.js'), path.join(root, '..', 'x.js'), path.join(root, 'link', 'a.js'), path.join(root, 'dangling'), '/etc/hosts']) {
    const r = edit(p);
    assert.equal(r?.permissionDecision, 'deny', p);
    assert.match(r.permissionDecisionReason, /^path-guard: .* is outside this run's writable roots .*; write only inside them$/);
  }
  assert.equal(check({ cwd: root, tool_input: { notebook_path: path.join(out, 'n.ipynb') } }, env)?.permissionDecision, 'deny');
  assert.equal(check({ cwd: root, tool_input: { file_path: '/etc/hosts' } }, {}), null, 'unset roots → allow');
});

test('AC5 subagent-count hook: 4th Agent spawn in a session denied with the spec message; Start/Stop drive the live count', async () => {
  const pre = (tool_name, session_id = 'hook-s') => hook('subagent-count.js', { session_id, hook_event_name: 'PreToolUse', tool_name, tool_input: { prompt: 'p' } });
  for (let i = 0; i < 3; i++) assert.deepEqual((await pre('Agent')).out, '');
  assert.deepEqual((await pre('Bash')).out, '', 'other tools ignored');
  const fourth = await pre('Agent');
  assert.deepEqual(fourth.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent budget used (3/3); do the rest yourself' } });
  assert.equal((await pre('Task', 'hook-other')).out, '', 'legacy Task name counted, other session independent');
  for (const ev of ['SubagentStart', 'SubagentStart', 'SubagentStop']) {
    assert.equal((await hook('subagent-count.js', { session_id: 'hook-s', hook_event_name: ev, agent_id: 'a', agent_type: 'Explore' })).out, '');
  }
  const s = JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'slots.json'), 'utf8')).subagents; // F3: status has totals only
  assert.deepEqual([s['test:hook-s'], s['test:hook-other']].map(({ alive, spawned }) => ({ alive, spawned })), [{ alive: 1, spawned: 3 }, { alive: 0, spawned: 1 }]); // N5: per run
});

// N5
test('N5 subagent-count sends TBX_RUN: the same session id in another run (or none) has its own budget; a wrong key is denied', async () => {
  const pre = (session_id, extra) => hook('subagent-count.js', { session_id, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }, extra);
  for (let i = 0; i < 3; i++) assert.equal((await pre('n5-s')).out, '');
  assert.equal((await pre('n5-s')).out.hookSpecificOutput.permissionDecision, 'deny', 'budget of this run spent');
  assert.equal((await pre('n5-s', { TBX_RUN: '' })).out, '', 'no run key: a separate tbd: session');
  const wrong = await pre('n5-s', { TBX_RUN: 'b'.repeat(32) });
  assert.deepEqual(wrong.out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'tbd refused (unknown run key (wrong, or the run ended)); do it yourself' });
});

// F6
test('F6 subagent-count: tbd down or silent → Agent request denied (fail closed) within the 2 s timeout; Start/Stop allowed with a note', async (t) => {
  const input = { session_id: 'x', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} };
  const denied = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'tbd unreachable; do it yourself' } };
  const none = path.join(tmp, 'none.sock');
  const down = await hook('subagent-count.js', input, { TBD_SOCK: none });
  assert.deepEqual([down.code, down.out], [0, denied]);
  for (const ev of ['SubagentStart', 'SubagentStop']) {
    const r = await hook('subagent-count.js', { session_id: 'x', hook_event_name: ev, agent_id: 'a' }, { TBD_SOCK: none });
    assert.deepEqual([r.code, r.out], [0, '']);
    assert.match(r.stderr, /^subagent-count: tbd not reachable \(.*\); allowing$/m);
  }
  const silent = path.join(tmp, 'silent.sock');
  const server = net.createServer(() => {}); // accepts, never answers
  t.after(() => server.close());
  await new Promise((r) => server.listen(silent, () => r(undefined)));
  const hang = await hook('subagent-count.js', input, { TBD_SOCK: silent });
  assert.deepEqual([hang.code, hang.out], [0, denied]);
  assert.ok(hang.ms >= 1900 && hang.ms < 4000, `answered after ${hang.ms} ms`);
});
