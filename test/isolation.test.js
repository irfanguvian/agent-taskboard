'use strict';
// P1 AC10 [CRIT]: every path from TB_HOME; the harness ignores an inherited TB_HOME; nothing lands in
// <tmp>/home/.taskboard (homedir fallback). Single instance via tbd.pid; SIGTERM exits 0 and frees it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, isolatedEnv, TBD } = require('./helpers/tbd');

const waitDead = async (pid) => {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pid ${pid} still alive`);
};

test('AC10 inherited TB_HOME is ignored: tbd writes only to the harness temp dir', async (t) => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-'));
  const saved = process.env.TB_HOME;
  process.env.TB_HOME = other; // stands in for `TB_HOME=~/.taskboard npm test`
  t.after(() => {
    if (saved === undefined) delete process.env.TB_HOME;
    else process.env.TB_HOME = saved;
    fs.rmSync(other, { recursive: true, force: true });
  });
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  assert.notEqual(tbd.tbHome, other);
  await tbd.api('POST', '/api/reminders', { title: 'isolated' });
  assert.deepEqual(fs.readdirSync(other), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tasks.json'), 'utf8')).tasks[0].title, 'isolated');
});

test('AC10 a full run writes only under TB_HOME; <tmp>/home/.taskboard never exists', async (t) => {
  const tbd = await startTbd();
  let stopped = false;
  t.after(() => (stopped ? undefined : tbd.stop())); // a failed assert must not leave tbd running (hangs the suite)
  const { json } = await tbd.api('POST', '/api/reminders', { title: 'a' });
  await tbd.api('PATCH', `/api/reminders/${json.reminder.id}`, { status: 'done' });
  await tbd.api('POST', '/api/tags', { name: 'x/y', def: { path: '/tmp/x', type: 'folder' } });
  await tbd.api('POST', '/api/flows', { text: 'refused', kind: 'code' });
  await tbd.api('GET', '/api/state');
  assert.equal(fs.existsSync(path.join(tbd.home, '.taskboard')), false);
  assert.deepEqual(fs.readdirSync(tbd.home), [], 'nothing written to HOME at all');
  const allowed = new Set(['config.json', 'events.jsonl', 'session', 'tags.json', 'tasks.json', 'tbd.pid', 'tickets', 'token']);
  const unexpected = fs.readdirSync(tbd.tbHome).filter(f => !allowed.has(f));
  assert.deepEqual(unexpected, [], 'only known files under TB_HOME');
  const config = JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'config.json'), 'utf8'));
  assert.ok(config.claude_bin.startsWith(tbd.tbHome), 'config paths derive from TB_HOME');
  stopped = true;
  assert.deepEqual(await tbd.stop(), { code: 0, signal: null }); // stop() also asserts home/.taskboard absent
});

test('AC10 second tbd on the same TB_HOME refuses to start; a stale pid file does not block', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  const pidFile = path.join(tbd.tbHome, 'tbd.pid');
  const firstPid = fs.readFileSync(pidFile, 'utf8');
  const env = isolatedEnv({ home: tbd.home, tbHome: tbd.tbHome, port: 0 });
  const second = spawnSync(process.execPath, [TBD], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(second.status, 1);
  assert.equal(second.stderr, `error: tbd already running (pid ${firstPid})\n`);
  assert.equal((await tbd.api('GET', '/api/state')).status, 200, 'first tbd unharmed');
  assert.equal(fs.readFileSync(pidFile, 'utf8'), firstPid, 'refused start leaves the pid file alone');

  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => gone.on('exit', r));
  const stale = await startTbd({ files: { 'tbd.pid': String(gone.pid) } });
  t.after(() => stale.stop());
  assert.notEqual(fs.readFileSync(path.join(stale.tbHome, 'tbd.pid'), 'utf8'), String(gone.pid), 'stale pid replaced');
});

test('AC10 SIGTERM: tbd exits 0 and removes its pid file', async () => {
  const tbd = await startTbd();
  const pidFile = path.join(tbd.tbHome, 'tbd.pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(pid, 'SIGTERM');
  await waitDead(pid);
  assert.equal(fs.existsSync(pidFile), false);
  assert.deepEqual(await tbd.stop(), { code: 0, signal: null });
});
