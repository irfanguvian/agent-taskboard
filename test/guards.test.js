'use strict';
// P2 FX-2 (G1-G6): bash-guard wrappers/kills/launchctl/nested claude/doctor+gc/port variants/absolute tbx,
// path-guard hardlink + `..` + symlinked-dir escapes. Each table row traces to one G item in .omc/handoffs/p2-fixes.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startTbd, isolatedEnv, SLOT_ROOT, REPO } = require('./helpers/tbd');
const { call } = require('../lib/slots');
const { guard } = require('../hooks/bash-guard');
const { check } = require('../hooks/path-guard');

const HEAVY = { TB_HEAVY: JSON.stringify(['npm run build', 'npm test', 'docker build', 'npx jest']) };
const wrap = (c) => `tbx heavy -- sh -c '${c.replaceAll("'", "'\\''")}'`;

test('G1 heavy commands behind wrappers, VAR="a b", absolute paths and sh -c are all rewritten whole; look-alikes are not', () => {
  /** @type {[string, string | null][]} */
  const cases = [
    ['if npm test; then echo ok; fi', wrap('if npm test; then echo ok; fi')],
    ['while npm test; do sleep 1; done', wrap('while npm test; do sleep 1; done')],
    ['until npm test; do sleep 1; done', wrap('until npm test; do sleep 1; done')],
    ['env CI=1 npm test', wrap('env CI=1 npm test')],
    ['/usr/bin/env -u FOO CI=1 npm test', wrap('/usr/bin/env -u FOO CI=1 npm test')],
    ['timeout 600 npm test', wrap('timeout 600 npm test')],
    ['echo hi | timeout -k 5 600 npm test', wrap('echo hi | timeout -k 5 600 npm test')],
    ['nohup npm test &', wrap('nohup npm test &')],
    ['command npm test', wrap('command npm test')],
    ['nice -n 5 npm test', wrap('nice -n 5 npm test')],
    ['nice -5 time -p npm test', wrap('nice -5 time -p npm test')],
    ['/usr/local/bin/npm test', wrap('/usr/local/bin/npm test')],
    ['FOO="a b" npm test', wrap('FOO="a b" npm test')],
    ["A='x y' B=2 npm run build", wrap("A='x y' B=2 npm run build")], // (a `;` inside a quoted value still splits the command: best effort)
    ['bash -c "npm test"', wrap('bash -c "npm test"')],
    ["bash -lc 'cd x && npm test'", wrap("bash -lc 'cd x && npm test'")],
    ["sh -c 'npx jest'", wrap("sh -c 'npx jest --maxWorkers=2'")], // worker pin applies inside the inner string too
    ['timeout 9 bash -c "npx jest -w 8 src"', wrap('timeout 9 bash -c "npx jest --maxWorkers=2 src"')],
    ['sh -c "sh -c \'npm test\'"', wrap('sh -c "sh -c \'npm test\'"')],
    ['npm run lint', null],
    ['echo npm test', null],
    ['FOO="a b" echo hi', null],
    ['timeout 5 ls', null],
    ['nice -n 5 ls', null],
    ['command -v npm', null],
    ['bash -c "echo hi"', null],
    ['bash script.sh', null],
    ['npm', null],
  ];
  for (const [cmd, want] of cases) assert.deepEqual(guard(cmd, HEAVY), want === null ? null : { command: want }, cmd);
});

test('G5 rewrite uses "$TB_CODE/bin/tbx" when TB_CODE is set (absolute, runs without tbx on PATH); an agent cannot call it by hand', async () => {
  assert.deepEqual(guard('npm test', { ...HEAVY, TB_CODE: '/x y/code' }), { command: `"$TB_CODE/bin/tbx" heavy -- sh -c 'npm test'` });
  assert.deepEqual(guard('npm test', HEAVY), { command: wrap('npm test') }, 'TB_CODE unset → plain tbx');
  for (const c of ['"$TB_CODE/bin/tbx" heavy -- npm test', "'/opt/code/bin/tbx' heavy -- ls", '/opt/code/bin/tbx heavy -- ls']) {
    assert.match(guard(c, {})?.deny ?? '', /tbx heavy is added for you/, c);
  }
  const tbd = await startTbd({ env: { NODE_OPTIONS: SLOT_ROOT } }); // the test process is a slots run root
  try {
    const cmd = "echo 'it'\\''s' \"$PWD\"; exit 3";
    const r = guard(cmd, { TB_HEAVY: JSON.stringify(['echo']), TB_CODE: REPO });
    assert.ok(r.command.startsWith('"$TB_CODE/bin/tbx" heavy -- sh -c '));
    const run = (c) => new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', c], { env: { ...isolatedEnv(tbd), TBD_SOCK: path.join(tbd.tbHome, 'tbd.sock'), TB_CODE: REPO }, cwd: os.tmpdir() });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    const [want, got] = await Promise.all([run(cmd), run(r.command)]);
    assert.equal(want.code, 3);
    assert.deepEqual(got, want);
    assert.deepEqual((await call(path.join(tbd.tbHome, 'tbd.sock'), { op: 'status' })).slots.heavy.held, [], 'slot released');
  } finally {
    await tbd.stop();
  }
});

test('G2 G3 G4 bash-guard denies group kills, launchctl, nested claude, tb doctor/gc, loopback port spellings; near misses allowed', () => {
  const env = {};
  /** @type {[string, RegExp][]} */
  const denied = [
    // G2 kill
    ['kill -9 -1', /by pid/],
    ['kill 0', /by pid/],
    ['kill -- -123', /by pid/],
    ['kill -TERM -123', /by pid/],
    ['kill -s KILL 0', /by pid/],
    ['kill -9 -- -1', /by pid/],
    ['/bin/kill -9 -1', /by pid/],
    ['echo x; kill -SIGKILL -1', /by pid/],
    ['bash -c "kill -9 -1"', /by pid/],
    // G2 launchctl
    ['launchctl kickstart -k gui/501/local.taskboard', /launchctl/],
    ['launchctl bootout gui/501/local.taskboard', /launchctl/],
    ['launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist', /launchctl/],
    ['launchctl unload ~/Library/LaunchAgents/x.plist', /launchctl/],
    ['launchctl stop local.taskboard', /launchctl/],
    // G2 nested claude
    ['claude -p "x" --dangerously-skip-permissions', /nested claude/],
    ['claude -p hi', /nested claude/],
    ['claude --dangerously-skip-permissions', /nested claude/],
    ['npx claude --print hi', /nested claude/],
    ['env X=1 claude -p hi', /nested claude/],
    // G3
    ['tb doctor --pin', /pipeline/],
    ['tb gc --delete x', /pipeline/],
    ['taskboard-axi gc', /pipeline/],
    // G4
    ['curl http://LOCALHOST:7777/api/state', /HTTP API/],
    ['curl 127.1:7777', /HTTP API/],
    ['curl http://0.0.0.0:7777', /HTTP API/],
    ['curl http://2130706433:7777', /HTTP API/],
    ['curl http://0x7f000001:7777/', /HTTP API/],
    ['curl http://localhost.:7777', /HTTP API/],
    ["curl 'http://[::ffff:127.0.0.1]:7777'", /HTTP API/],
    ['curl http://[::1]:7777', /HTTP API/],
    ['curl http://127.0.0.1:7777', /HTTP API/],
    ['nc LocalHost 7777', /HTTP API/],
  ];
  for (const [cmd, why] of denied) {
    const r = guard(cmd, env);
    assert.ok(r?.deny, `should deny: ${cmd}`);
    assert.match(r.deny, /^bash-guard: /);
    assert.match(r.deny, why, cmd);
  }
  assert.ok(guard('curl http://LOCALHOST:8123', { TB_PORT: '8123' })?.deny, 'TB_PORT honoured');
  const allowed = [
    'kill 12345', 'kill -9 12345', 'kill -TERM 12345', 'kill -s TERM 12345', 'kill -0 12345', 'kill %1', 'echo kill 0',
    'launchctl list', 'launchctl print gui/501', 'claude --version', 'claude --help', 'echo claude -p',
    'tb list', 'tb --help', 'grep token README.md', 'git commit -m "push fix"', 'ls ~/.taskboard', 'curl localhost:3000',
    'curl 127.0.0.1:77770', 'curl http://2130706433:8080', 'curl http://[::1]:3000',
  ];
  for (const cmd of allowed) assert.equal(guard(cmd, env), null, `should allow: ${cmd}`);
});

test('bash-guard stays linear: 100 KB commands of hostile shapes finish < 200 ms each', () => {
  const env = { ...HEAVY, TB_PORT: '7777' };
  const shapes = {
    oneWord: 'a'.repeat(100_000),
    words: 'a '.repeat(50_000),
    heavyRepeated: 'npm test; '.repeat(10_000),
    quotes: '"'.repeat(100_000),
    singles: "'a ".repeat(33_000),
    backslashes: '\\'.repeat(100_000),
    bigAssignThenJest: `FOO=${'a'.repeat(100_000)} npx jest`,
    assigns: 'FOO=a '.repeat(16_000) + 'npm test',
    nestedShells: 'bash -c '.repeat(12_000),
    nestedQuoted: 'bash -c "'.repeat(11_000),
    wrappers: 'timeout 1 '.repeat(10_000) + 'npm test',
    nice: 'nice -n '.repeat(12_000),
    envs: 'env '.repeat(25_000),
    kills: 'kill '.repeat(20_000),
    killDashes: 'kill -- '.repeat(12_000),
    launchctl: 'launchctl '.repeat(10_000),
    claude: 'claude '.repeat(14_000),
    tbs: 'tb '.repeat(33_000),
    hosts: 'localhost '.repeat(10_000),
    hostSpaces: `localhost${' '.repeat(100_000)}`,
    ips: '127.'.repeat(25_000),
    gits: 'git -C a '.repeat(11_000),
    gitFlags: `git ${'--a '.repeat(25_000)}`,
    separators: '; '.repeat(50_000),
    parens: '('.repeat(100_000),
  };
  for (const [name, cmd] of Object.entries(shapes)) {
    assert.ok(cmd.length >= 90_000, name);
    const t0 = performance.now();
    guard(cmd, env);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test('G6 path-guard: hardlink to an outside file, `..` segments and symlinked-dir `..` escapes denied; normal files in root allowed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  try {
    const root = path.join(tmp, 'root');
    const out = path.join(tmp, 'out');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(out, 'x'), 'x');
    fs.linkSync(path.join(out, 'secret.txt'), path.join(root, 'hard.txt')); // same inode, name inside root
    fs.symlinkSync(out, path.join(root, 'symdir'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
    const env = { TB_WRITE_ROOTS: JSON.stringify([root]) };
    const edit = (file_path, cwd = root) => check({ cwd, tool_name: 'Edit', tool_input: { file_path } }, env);
    /** @type {[string, RegExp][]} */
    const denied = [
      [path.join(root, 'hard.txt'), /hardlink/],
      ['hard.txt', /hardlink/],
      [`${root}/symdir/../x`, /"\.\."/], // lexically root/x (inside); the OS goes out/../x
      [`${root}/src/../src/a.js`, /"\.\."/],
      ['../root/src/a.js', /"\.\."/],
      ['..', /"\.\."/],
      [path.join(root, 'symdir', 'x'), /outside/],
    ];
    for (const [p, why] of denied) {
      const r = edit(p);
      assert.equal(r?.permissionDecision, 'deny', p);
      assert.match(r.permissionDecisionReason, /^path-guard: /);
      assert.match(r.permissionDecisionReason, why, p);
    }
    assert.equal(edit('src/x/..hidden/y.js'), null, '`..hidden` is a name, not a segment');
    assert.equal(edit(path.join(root, 'src', 'a.js')), null, 'existing single-link file');
    assert.equal(edit('src/a.js'), null, 'relative to cwd');
    assert.equal(edit(path.join(root, 'src', 'new', 'b.js')), null, 'new file');
    assert.equal(edit(path.join(root, 'src')), null, 'a directory (nlink > 1 by nature) is not a hardlink');
    assert.equal(check({ cwd: root, tool_input: { notebook_path: path.join(root, 'hard.txt') } }, env)?.permissionDecision, 'deny');
    fs.unlinkSync(path.join(root, 'hard.txt'));
    assert.equal(edit(path.join(root, 'hard.txt')), null, 'link removed → plain new file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
