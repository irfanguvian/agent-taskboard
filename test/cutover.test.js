'use strict';
// P1 AC11: scripts/cutover, deploy, install-launchd and the cutover rollback, end to end on a temp HOME.
// The v1 world is a temp dev repo + made-up tasks.json; `launchctl` is a stub first in PATH that logs its
// calls and runs the real tbd.js from the rendered plist. Nothing here touches the real launchd, ~/bin,
// ~/taskboard* or ~/.taskboard; the real home is only ever read (guard test).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { request, REPO } = require('./helpers/tbd');

const SCRIPTS = path.join(REPO, 'scripts');
const worlds = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (r) => `${r.stdout}${r.stderr}`;
// connection: close, so no request reuses a pooled socket of a tbd that has since been restarted
const http = (port, method, p, body, headers = {}) => request(port, method, p, body, { connection: 'close', ...headers });

after(async () => {
  for (const w of worlds) {
    const pidFile = path.join(w.lc, 'pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    }
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

const TASKS = [
  { id: 't_aaa111', title: 'water the fern', status: 'now', created: '2026-09-01', project: 'home' },
  { id: 't_bbb222', title: 'file the receipts', status: 'next', created: '2026-09-02', due: '2026-10-15' },
  { id: 't_ccc333', title: 'sketch a logo', status: 'inbox', created: '2026-09-03' },
  { id: 't_ddd444', title: 'read a book', status: 'later', created: '2026-09-04', project: 'fun' },
  { id: 't_eee555', title: 'old chore', status: 'done', created: '2026-08-01', done_at: '2026-08-02' },
  { id: 't_fff666', title: 'call the plumber', status: 'now', created: '2026-09-05', due: '2026-10-09' },
];
const V1_TEXT = JSON.stringify({ tasks: TASKS }, null, 2) + '\n';
const OLD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.taskboard</string>
  <key>ProgramArguments</key><array><string>/usr/bin/true</string><string>/old/server.js</string></array>
</dict>
</plist>
`;

// A script called `name` in the world's stub dir (first in PATH), so it runs instead of the real tool.
const shim = (w, name, body) => fs.writeFileSync(path.join(w.root, 'stub', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const stages = (stderr) => stderr.split('\n').filter((l) => l.startsWith('cutover: step ')).map((l) => l.slice('cutover: step '.length).split(':')[0]);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
    s.close(() => resolve(port));
  });
});

// Temp v1 world: HOME with the ~/taskboard -> dev symlink, v1 tasks.json, old plist, ~/bin links, stub launchctl.
async function world({ port = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-'));
  const home = path.join(root, 'home');
  const dev = path.join(root, 'dev');
  const stub = path.join(root, 'stub');
  const lc = path.join(root, 'lc');
  for (const d of [stub, lc, dev, path.join(home, 'bin'), path.join(home, 'Library', 'LaunchAgents')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'helpers', 'fake-launchctl'), path.join(stub, 'launchctl'));
  fs.chmodSync(path.join(stub, 'launchctl'), 0o755);

  const env = {
    PATH: `${stub}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_LC_DIR: lc,
    TB_NODE: process.execPath,
    TB_PORT: String(port || (await freePort())),
  };
  const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  const git = (dir, ...args) => {
    const r = sh('git', ['-C', dir, ...args]);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  for (const f of ['tbd.js', 'lib', 'bin', 'scripts', 'taskboard-axi', 'package.json', '.gitignore']) sh('cp', ['-R', path.join(REPO, f), dev + path.sep]);
  git(dev, 'init', '-q', '-b', 'main');
  git(dev, 'config', 'user.email', 't@example.invalid');
  git(dev, 'config', 'user.name', 't');
  git(dev, 'config', 'commit.gpgsign', 'false');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');

  const v1Dir = path.join(home, 'taskboard');
  fs.symlinkSync(dev, v1Dir); // like the real ~/taskboard -> dev repo
  fs.writeFileSync(path.join(v1Dir, 'tasks.json'), V1_TEXT);
  fs.symlinkSync(path.join(v1Dir, 'taskboard-axi'), path.join(home, 'bin', 'taskboard-axi'));
  fs.writeFileSync(path.join(home, 'bin', 'other-tool'), 'keep me');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.taskboard.plist');
  fs.writeFileSync(plist, OLD_PLIST);

  const w = {
    root, home, dev, lc, v1Dir, plist, env, git,
    v1: path.join(v1Dir, 'tasks.json'),
    live: path.join(home, 'taskboard-live'),
    tbHome: path.join(home, '.taskboard'),
    port: Number(env.TB_PORT),
    run: (script, ...args) => sh(path.join(dev, 'scripts', script), args),
    log: () => (fs.existsSync(path.join(lc, 'log')) ? fs.readFileSync(path.join(lc, 'log'), 'utf8').split('\n').filter(Boolean) : []),
    ls: (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix)),
  };
  worlds.push(w);
  return w;
}

test('guard: the real home is refused without --yes, a temp home is not', () => {
  const lib = (home, ...args) => spawnSync('sh', ['-c', '. "$1/live-lib.sh"; shift; guard_home "$@"', 'x', SCRIPTS, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  const real = os.userInfo().homedir; // only read by the guard, never written
  const refused = lib(real);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /real home .* pass --yes/);
  assert.equal(lib(real, '--yes').status, 0);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    assert.equal(lib(temp).status, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('guard: cutover and deploy on a home that counts as real do nothing without --yes', async () => {
  const w = await world();
  w.env.TB_REAL_HOME = w.home; // test seam: pretend this temp HOME is the real one
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /pass --yes/);
  assert.equal(w.log().length, 0, 'launchctl never called');
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT);
  assert.equal(fs.existsSync(w.tbHome), false);
  const sha = w.git(w.dev, 'rev-parse', 'HEAD');
  assert.equal(w.run('deploy', sha, '--check').status, 1);
  assert.equal(w.run('deploy', sha, '--check', '--yes').status, 0, 'with --yes the same call passes');
  assert.equal(fs.existsSync(w.live), false, '--check changes nothing');
});

test('same(): equal tasks pass (tbd `type` ignored); reordered or edited tasks fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-'));
  try {
    const put = (name, tasks) => { fs.writeFileSync(path.join(dir, name), JSON.stringify({ tasks })); return path.join(dir, name); };
    const same = (a, b) => spawnSync('sh', ['-c', '. "$1/live-lib.sh"; same "$2" "$3"', 'x', SCRIPTS, a, b], { env: { PATH: process.env.PATH, HOME: dir, TB_NODE: process.execPath }, encoding: 'utf8' }).status;
    const base = put('base.json', TASKS);
    assert.equal(same(base, put('typed.json', TASKS.map((t) => ({ ...t, type: 'reminder' })))), 0);
    assert.equal(same(base, put('swapped.json', [TASKS[1], TASKS[0], ...TASKS.slice(2)])), 1);
    assert.equal(same(base, put('edited.json', [{ ...TASKS[0], title: 'other' }, ...TASKS.slice(1)])), 1);
    assert.equal(same(base, put('short.json', TASKS.slice(1))), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cutover refuses an existing ~/.taskboard/tasks.json before changing anything', async () => {
  const w = await world();
  fs.mkdirSync(w.tbHome);
  fs.writeFileSync(path.join(w.tbHome, 'tasks.json'), '{"tasks":[]}\n');
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /tasks\.json already exists/);
  assert.match(r.stderr, /FAILED at step: preflight/);
  assert.equal(w.log().length, 0, 'v1 job still running: launchctl never called');
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT);
  assert.equal(fs.readFileSync(path.join(w.tbHome, 'tasks.json'), 'utf8'), '{"tasks":[]}\n');
  assert.equal(fs.readlinkSync(path.join(w.home, 'bin', 'taskboard-axi')), path.join(w.v1Dir, 'taskboard-axi'));
  assert.equal(fs.existsSync(w.live), false);
});

test('cutover refuses a commit that lacks tbd.js (uncommitted work) before changing anything', async () => {
  const w = await world();
  w.git(w.dev, 'rm', '-q', 'tbd.js');
  w.git(w.dev, 'commit', '-q', '-m', 'drop tbd');
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /has no tbd\.js/);
  assert.equal(w.log().length, 0);
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT);
});

test('a failing step stops cutover with the rollback command; rollback restores the v1 world', async () => {
  const w = await world();
  w.env.FAKE_LC_FAIL = 'bootstrap';
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /FAILED at step: i: install the plist and bootstrap tbd\. Undo with: scripts\/cutover --rollback/);
  assert.doesNotMatch(r.stdout, /OK: tbd/, 'never reaches verify');
  assert.equal(fs.existsSync(w.v1), false, 'half way: v1 file already renamed');
  assert.match(fs.readFileSync(w.plist, 'utf8'), /tbd\.js/, 'half way: tbd plist already installed');

  delete w.env.FAKE_LC_FAIL;
  const back = w.run('cutover', '--rollback');
  assert.equal(back.status, 0, out(back));
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT);
  assert.equal(fs.readFileSync(w.plist, 'utf8'), OLD_PLIST);
  assert.equal(fs.readlinkSync(path.join(w.home, 'bin', 'taskboard-axi')), path.join(w.v1Dir, 'taskboard-axi'));
  assert.equal(fs.existsSync(path.join(w.home, 'bin', 'tb')), false);
  assert.equal(fs.existsSync(path.join(w.tbHome, 'tasks.json')), false);
  assert.equal(w.log().at(-1)?.startsWith(`print gui/${process.getuid()}/local.taskboard|`), true, 'old job bootstrapped, status printed');
});

test('cutover, deploy, rollback, second cutover on a temp HOME', async (t) => {
  const w = await world();
  const uid = process.getuid();
  const target = `gui/${uid}/local.taskboard`;
  const axiOld = path.join(w.v1Dir, 'taskboard-axi');
  // Records where ~/bin/taskboard-axi points whenever cutover copies a file: observes "unlinked before the backup".
  shim(w, 'cp', 'printf \'%s|axi=%s\\n\' "$*" "$(readlink "$HOME/bin/taskboard-axi")" >> "$FAKE_LC_DIR/cp.log"\nexec /bin/cp "$@"');
  const state = async () => (await http(w.port, 'GET', '/api/state', undefined, { 'x-tb-token': fs.readFileSync(path.join(w.tbHome, 'token'), 'utf8').trim() })).json;
  const readTasks = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map(({ type: _type, ...r }) => r);
  const v1Plist = path.join(w.tbHome, 'backup', 'local.taskboard.plist.v1');
  const sha1 = w.git(w.dev, 'rev-parse', 'HEAD');
  let sha2 = '';

  await t.test('cutover follows P1 AC11 order and verifies against the real tbd', async () => {
    const r = w.run('cutover');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /OK: tbd on :\d+ serves 6 reminders, ids in v1 order/);
    assert.match(r.stdout, /swiftc -O tcal\.swift/);
    assert.match(r.stdout, /claude\.ai-synced taskboard skill/);
    assert.deepEqual(w.log(), [
      `bootout ${target}|axi=${axiOld} v1=1 data=0 live=0 tb=`,
      `bootstrap gui/${uid} ${w.plist}|axi=${w.live}/bin/taskboard-axi v1=0 data=1 live=1 tb=${w.live}/bin/tb`,
    ]);
    assert.deepEqual(stages(r.stderr), ['preflight', 'a', 'b', 'c', 'd+e', 'f', 'g', 'h', 'i', 'j', 'k']);
    const backupCp = fs.readFileSync(path.join(w.lc, 'cp.log'), 'utf8').split('\n').find((l) => l.startsWith(`${w.v1} ${w.tbHome}/backup/tasks-`));
    assert.ok(backupCp, 'the v1 file was backed up with cp');
    assert.ok(backupCp.endsWith('|axi='), `~/bin/taskboard-axi was unlinked before the backup: ${backupCp}`);
  });

  await t.test('backup is byte-identical; migrated data equals v1, same order; tbd serves it', async () => {
    const backups = w.ls(path.join(w.tbHome, 'backup'), 'tasks-');
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^tasks-\d{8}-\d{6}\.json$/);
    assert.equal(fs.readFileSync(path.join(w.tbHome, 'backup', backups[0]), 'utf8'), V1_TEXT);
    assert.deepEqual(readTasks(path.join(w.tbHome, 'tasks.json')), TASKS);
    const s = await state();
    assert.deepEqual(s.reminders.map((x) => x.id), TASKS.map((x) => x.id));
    assert.ok(s.reminders.every((x) => x.type === 'reminder'));
    assert.equal(fs.statSync(w.tbHome).mode & 0o777, 0o700);
  });

  await t.test('v1 file renamed, ~/bin links point to live, other ~/bin files untouched', () => {
    assert.equal(fs.existsSync(w.v1), false);
    const migrated = w.ls(w.dev, 'tasks.json.migrated-');
    assert.equal(migrated.length, 1);
    assert.match(migrated[0], /^tasks\.json\.migrated-\d{4}-\d\d-\d\d$/);
    assert.equal(fs.readFileSync(path.join(w.dev, migrated[0]), 'utf8'), V1_TEXT);
    assert.equal(fs.readlinkSync(path.join(w.home, 'bin', 'tb')), `${w.live}/bin/tb`);
    assert.equal(fs.readlinkSync(path.join(w.home, 'bin', 'taskboard-axi')), `${w.live}/bin/taskboard-axi`);
    assert.equal(fs.readFileSync(path.join(w.home, 'bin', 'other-tool'), 'utf8'), 'keep me');
  });

  await t.test('live worktree sits detached at the deployed sha; deploy.log has the line', () => {
    assert.equal(w.git(w.live, 'rev-parse', 'HEAD'), sha1);
    assert.equal(w.git(w.live, 'status', '--porcelain'), '');
    assert.equal(spawnSync('git', ['-C', w.live, 'symbolic-ref', '-q', 'HEAD']).status, 1, 'detached HEAD');
    const lines = fs.readFileSync(path.join(w.tbHome, 'deploy.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z none -> ${sha1}$`));
  });

  await t.test('plist lints, has no placeholders or personal paths, keeps the v1 plist once', () => {
    assert.equal(spawnSync('plutil', ['-lint', w.plist]).status, 0);
    const text = fs.readFileSync(w.plist, 'utf8');
    assert.doesNotMatch(text, /@[A-Z]+@/);
    for (const want of [`<string>${process.execPath}</string>`, `<string>${w.live}/tbd.js</string>`, `<key>TB_HOME</key><string>${w.tbHome}</string>`, `<key>TB_PORT</key><string>${w.port}</string>`, '<key>KeepAlive</key><true/>', '<key>AbandonProcessGroup</key><true/>']) {
      assert.ok(text.includes(want), `plist lacks ${want}`);
    }
    assert.match(text, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:[^<]*:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
    const tpl = fs.readFileSync(path.join(SCRIPTS, 'local.taskboard.plist.template'), 'utf8');
    assert.doesNotMatch(tpl, /\/Users\//);
    assert.deepEqual(fs.readdirSync(path.dirname(w.plist)), ['local.taskboard.plist'], 'no backup left in LaunchAgents');
    assert.equal(fs.readFileSync(v1Plist, 'utf8'), OLD_PLIST);
    assert.equal(w.run('install-launchd').status, 0, 'install-launchd is re-runnable');
    assert.equal(fs.readFileSync(v1Plist, 'utf8'), OLD_PLIST, 'second install does not replace the v1 backup');
  });

  await t.test('deploy: later sha restarts tbd and prints the rollback sha; dirty or unknown refused', () => {
    fs.writeFileSync(path.join(w.dev, 'VERSION'), '2\n');
    w.git(w.dev, 'add', 'VERSION');
    w.git(w.dev, 'commit', '-q', '-m', 'second');
    sha2 = w.git(w.dev, 'rev-parse', 'HEAD');
    const before = w.log().length;
    const r = w.run('deploy', sha2);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, new RegExp(`rollback: scripts/deploy ${sha1}`));
    assert.match(w.log()[before], new RegExp(`^kickstart -k ${target.replace(/\//g, '\\/')}\\|`));
    assert.equal(w.git(w.live, 'rev-parse', 'HEAD'), sha2);
    assert.match(fs.readFileSync(path.join(w.tbHome, 'deploy.log'), 'utf8').trim().split('\n').pop(), new RegExp(` ${sha1} -> ${sha2}$`));

    fs.appendFileSync(path.join(w.live, 'VERSION'), 'edited in live\n');
    const dirty = w.run('deploy', sha1);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.equal(w.git(w.live, 'rev-parse', 'HEAD'), sha2, 'live untouched');
    w.git(w.live, 'checkout', '-q', '--', 'VERSION');
    const unknown = w.run('deploy', 'deadbeef');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown commit/);
    assert.equal(w.log().length, before + 1, 'refusals never restart');
  });

  let oldPid = 0;
  await t.test('rollback: v1 file gets the reminder added after cutover; v1 plist and links are back', async () => {
    oldPid = Number(fs.readFileSync(path.join(w.lc, 'pid'), 'utf8'));
    const token = fs.readFileSync(path.join(w.tbHome, 'token'), 'utf8').trim();
    const added = await http(w.port, 'POST', '/api/reminders', { title: 'added after cutover' }, { 'x-tb-token': token });
    assert.equal(added.status, 201);
    const before = w.log().length;

    const r = w.run('cutover', '--rollback');
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(w.log().slice(before), [
      `bootout ${target}|axi=${w.live}/bin/taskboard-axi v1=0 data=1 live=1 tb=${w.live}/bin/tb`,
      `bootstrap gui/${uid} ${w.plist}|axi=${axiOld} v1=1 data=0 live=1 tb=`,
      `print ${target}|axi=${axiOld} v1=1 data=0 live=1 tb=`,
    ]);
    const tasks = readTasks(w.v1);
    assert.equal(tasks.length, 7);
    assert.deepEqual(tasks.filter((x) => x.id !== added.json.reminder.id), TASKS, 'the v1 rows keep their order');
    assert.equal(tasks.find((x) => x.id === added.json.reminder.id).title, 'added after cutover');
    assert.equal(fs.readFileSync(w.plist, 'utf8'), OLD_PLIST);
    assert.equal(fs.readlinkSync(path.join(w.home, 'bin', 'taskboard-axi')), axiOld);
    assert.throws(() => fs.lstatSync(path.join(w.home, 'bin', 'tb')), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(path.join(w.home, 'bin', 'other-tool'), 'utf8'), 'keep me');
    assert.equal(fs.existsSync(path.join(w.tbHome, 'tasks.json')), false);
    assert.equal(w.ls(w.tbHome, 'tasks.json.rolled-back-').length, 1, 'live data kept aside, not deleted');
    assert.equal(alive(oldPid), false, 'only the recorded tbd pid was stopped, and it is gone');
    await assert.rejects(http(w.port, 'GET', '/api/state'), { code: 'ECONNREFUSED' });
  });

  await t.test('second cutover after the rollback works and keeps the edit', async () => {
    const r = w.run('cutover');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /serves 7 reminders/);
    assert.equal(w.git(w.live, 'rev-parse', 'HEAD'), sha2);
    assert.equal(fs.existsSync(w.v1), false);
    assert.equal(w.ls(w.dev, 'tasks.json.migrated-').length, 2, 'earlier migrated file kept, not overwritten');
    assert.equal(w.ls(path.join(w.tbHome, 'backup'), 'tasks-').length, 2);
    assert.equal(fs.readFileSync(v1Plist, 'utf8'), OLD_PLIST);
    const titles = (await state()).reminders.map((x) => x.title);
    assert.equal(titles.length, 7);
    assert.ok(titles.includes('added after cutover'));
  });
});

test('rollback refuses a corrupt ~/.taskboard/tasks.json before changing anything', async () => {
  const w = await world();
  fs.mkdirSync(w.tbHome);
  fs.writeFileSync(path.join(w.tbHome, 'tasks.json'), '{"tasks": [{"id": ');
  const r = w.run('cutover', '--rollback');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /tasks\.json has no tasks array.*nothing was changed/);
  assert.equal(w.log().length, 0, 'launchctl never called');
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT, 'the v1 file was not overwritten with the broken one');
  assert.equal(fs.readFileSync(path.join(w.tbHome, 'tasks.json'), 'utf8'), '{"tasks": [{"id": ', 'broken file kept for inspection');
  assert.equal(w.ls(w.tbHome, 'tasks.json.rolled-back-').length, 0);
});

test('copy that differs from the backup: cutover aborts at the deep-equal step, removes the copy, v1 file stays', async () => {
  const w = await world();
  // v1 gets an edit right after the byte-compare of the backup, so the copy no longer equals the backup
  shim(w, 'cmp', '/usr/bin/cmp "$@"; rc=$?\nif [ -n "${FAKE_EDIT:-}" ]; then sed "s/water the fern/water the cactus/" "$FAKE_EDIT" > "$FAKE_EDIT.new" && mv "$FAKE_EDIT.new" "$FAKE_EDIT"; fi\nexit $rc');
  w.env.FAKE_EDIT = w.v1;
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /copied tasks differ from the backup; removed the copy, v1 file untouched/);
  assert.match(r.stderr, /FAILED at step: d\+e/);
  assert.equal(fs.existsSync(path.join(w.tbHome, 'tasks.json')), false, 'partial copy removed');
  assert.match(fs.readFileSync(w.v1, 'utf8'), /water the cactus/, 'v1 file still there, not renamed');
  assert.equal(w.ls(w.dev, 'tasks.json.migrated-').length, 0);
  assert.equal(fs.existsSync(w.live), false, 'never reached deploy');
  assert.deepEqual(w.log().map((l) => l.split(' ')[0]), ['bootout'], 'tbd never bootstrapped');
  assert.equal(fs.readFileSync(path.join(w.tbHome, 'backup', w.ls(path.join(w.tbHome, 'backup'), 'tasks-')[0]), 'utf8'), V1_TEXT, 'backup holds the original');
});

test('a copy that fails half way leaves no partial ~/.taskboard/tasks.json and says so', async () => {
  const w = await world();
  shim(w, 'cat', 'if [ "${1:-}" = "${FAKE_CAT_V1:-}" ]; then head -c 10 "$1"; exit 1; fi\nexec /bin/cat "$@"');
  w.env.FAKE_CAT_V1 = w.v1;
  const r = w.run('cutover');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /copy to .*tasks\.json failed; removed the partial copy, v1 file untouched/);
  assert.doesNotMatch(r.stderr, /appeared meanwhile/);
  assert.equal(fs.existsSync(path.join(w.tbHome, 'tasks.json')), false);
  assert.equal(fs.readFileSync(w.v1, 'utf8'), V1_TEXT);
});

test('step i installs the plist with the deployed copy of install-launchd, not the dev working tree', async () => {
  const w = await world();
  // uncommitted edit in the dev tree: only a dev-tree install-launchd would render it
  const tpl = path.join(w.dev, 'scripts', 'local.taskboard.plist.template');
  fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8').replace('<key>RunAtLoad</key>', '<key>DevOnlyMarker</key><string>1</string>\n  <key>RunAtLoad</key>'));
  const r = w.run('cutover');
  assert.equal(r.status, 0, out(r));
  const text = fs.readFileSync(w.plist, 'utf8');
  assert.match(text, /tbd\.js/);
  assert.doesNotMatch(text, /DevOnlyMarker/);
  assert.doesNotMatch(fs.readFileSync(path.join(w.live, 'scripts', 'local.taskboard.plist.template'), 'utf8'), /DevOnlyMarker/);
});

test('deploy after ~/taskboard-live was deleted by hand: --check says so, the real run prunes and succeeds', async () => {
  const w = await world();
  const sha = w.git(w.dev, 'rev-parse', 'HEAD');
  assert.equal(w.run('deploy', sha, '--no-restart').status, 0);
  fs.rmSync(w.live, { recursive: true });
  const check = w.run('deploy', sha, '--check');
  assert.equal(check.status, 0, out(check));
  assert.match(check.stderr, /registered but missing/);
  assert.equal(fs.existsSync(w.live), false, '--check changes nothing');
  const r = w.run('deploy', sha, '--no-restart');
  assert.equal(r.status, 0, out(r));
  assert.equal(w.git(w.live, 'rev-parse', 'HEAD'), sha);
  assert.equal(w.run('deploy', sha, '--check').stderr, '', 'a healthy live tree is not reported');
});
