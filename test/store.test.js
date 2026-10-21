'use strict';
// P1 AC2: store = single writer (queue + tmp/rename + events.jsonl). v1 tasks.json loads unchanged;
// reminder writes follow v1 taskboard-axi semantics (place(), setStatus done_at, add defaults, now limit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startTbd, isolatedEnv, phaseFixture, PHASE_FILES, FAKE_HANDLERS, TBD } = require('./helpers/tbd');
const { DEFAULT_PIN } = require('../lib/util');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const builtEnv = { TB_PHASES_DIR: phaseFixture(path.join(root, 'phases'), { 'code/working': PHASE_FILES }), NODE_OPTIONS: FAKE_HANDLERS };

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
// v1 shape: no type. Columns: now 1,3,6 · next 2,5 · done 4.
const V1 = {
  tasks: [
    { id: 't_aaaaa1', title: 'one', status: 'now', created: '2026-09-01' },
    { id: 't_aaaaa2', title: 'two', status: 'next', created: '2026-09-01', project: 'P' },
    { id: 't_aaaaa3', title: 'three', status: 'now', created: '2026-09-02', due: '2026-10-01' },
    { id: 't_aaaaa4', title: 'four', status: 'done', created: '2026-09-01', done_at: '2026-09-05' },
    { id: 't_aaaaa5', title: 'five', status: 'next', created: '2026-09-03', note: 'n' },
    { id: 't_aaaaa6', title: 'six', status: 'now', created: '2026-09-03' },
  ],
};
const readFile = (tbd, name) => fs.readFileSync(path.join(tbd.tbHome, name), 'utf8');
const fileTasks = (tbd) => JSON.parse(readFile(tbd, 'tasks.json')).tasks;
const order = (tbd) => fileTasks(tbd).map((t) => Number(t.id.at(-1)));
const eventLines = (tbd) => readFile(tbd, 'events.jsonl').trim().split('\n').map((l) => JSON.parse(l));

test('AC2 20 concurrent creates: 20 rows, unique ids, valid tasks.json, one event each', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => tbd.api('POST', '/api/reminders', { title: `task ${i}` })));
  assert.deepEqual(res.map((r) => r.status), Array(20).fill(201));
  const rows = fileTasks(tbd);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.id)).size, 20);
  assert.ok(rows.every((r) => /^t_[a-z0-9]{6}$/.test(r.id) && r.type === 'reminder' && r.status === 'inbox' && r.created === today()));
  assert.deepEqual(new Set(rows.map((r) => r.title)), new Set(res.map((r) => r.json.reminder.title)));
  assert.equal(eventLines(tbd).filter((e) => e.kind === 'add').length, 20);
  assert.deepEqual((await tbd.api('GET', '/api/state')).json.reminders, rows);
});

test('AC2 same open title sent 5x concurrently: one row, the rest are no-ops (v1 add)', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  const res = await Promise.all(Array.from({ length: 5 }, () => tbd.api('POST', '/api/reminders', { title: 'Same Title' })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.ok(res.filter((r) => r.status === 200).every((r) => r.json.noop === true));
  assert.equal(fileTasks(tbd).length, 1);
});

test('AC2 v1 tasks.json loads in order and gains type on first write, nothing reordered', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  const loaded = (await tbd.api('GET', '/api/state')).json.reminders;
  assert.deepEqual(loaded.map((r) => r.id), V1.tasks.map((r) => r.id));
  assert.ok(loaded.every((r) => r.type === 'reminder'));
  assert.equal((await tbd.api('POST', '/api/reminders', { title: 'seven' })).status, 201);
  const saved = fileTasks(tbd);
  assert.deepEqual(saved.slice(0, 6).map(({ type: _type, ...r }) => r), V1.tasks, 'v1 rows deep-equal after stripping type');
  assert.ok(saved.every((r) => r.type === 'reminder'));
  assert.equal(saved[6].title, 'seven');
});

test('AC2 tbd refuses to start on an invalid tasks.json and leaves the file untouched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tbHome = path.join(root, 'tbhome');
  fs.mkdirSync(tbHome);
  fs.mkdirSync(path.join(root, 'home'));
  const bad = JSON.stringify({ tasks: [{ id: 't_aaaaa1', title: 'x', status: 'bogus' }] });
  fs.writeFileSync(path.join(tbHome, 'tasks.json'), bad);
  const r = spawnSync(process.execPath, [TBD], { env: isolatedEnv({ home: path.join(root, 'home'), tbHome, port: 0 }), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid "tasks" array/);
  assert.equal(fs.readFileSync(path.join(tbHome, 'tasks.json'), 'utf8'), bad);
});

test('AC2 PATCH pos/status reorders exactly like v1 place(); now-limit warning past 3', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  const patch = (n, body) => tbd.api('PATCH', `/api/reminders/t_aaaaa${n}`, body);

  let r = await patch(6, { pos: 1 }); // top of now
  assert.deepEqual(r.json.warnings, []);
  assert.deepEqual(order(tbd), [6, 1, 2, 3, 4, 5]);
  await patch(1, { pos: 'bottom' });
  assert.deepEqual(order(tbd), [6, 2, 3, 1, 4, 5]);
  await patch(3, { pos: 99 }); // past the end = bottom of its column
  assert.deepEqual(order(tbd), [6, 2, 1, 3, 4, 5]);
  r = await patch(2, { status: 'now' }); // status change, no pos -> bottom of now
  assert.equal(r.status, 200);
  assert.deepEqual(order(tbd), [6, 1, 3, 2, 4, 5]);
  assert.deepEqual(r.json.warnings, ['now has 4 tasks (limit 3); move the lowest to next']);
  r = await patch(5, { status: 'now', pos: 2 });
  assert.deepEqual(order(tbd), [6, 5, 1, 3, 2, 4]);
  assert.deepEqual(r.json.warnings, ['now has 5 tasks (limit 3); move the lowest to next']);

  for (const pos of [0, -1, 1.5, 'middle', true, [2]]) assert.equal((await patch(1, { pos })).status, 400, `pos ${JSON.stringify(pos)}`);
  const before = eventLines(tbd).length;
  r = await patch(1, { status: 'now' }); // already there: no-op, no write
  assert.equal(r.json.noop, true);
  assert.equal(eventLines(tbd).length, before);
});

test('AC2 done sets done_at + top of done; leaving done clears done_at (v1 setStatus)', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  let r = await tbd.api('PATCH', '/api/reminders/t_aaaaa5', { status: 'done' });
  assert.equal(r.json.reminder.done_at, today());
  assert.deepEqual(order(tbd), [1, 2, 3, 5, 4, 6], '5 lands before 4 = top of done');
  r = await tbd.api('PATCH', '/api/reminders/t_aaaaa4', { status: 'next' });
  assert.equal(r.json.reminder.done_at, undefined);
  assert.equal(fileTasks(tbd).find((x) => x.id === 't_aaaaa4').done_at, undefined);
  assert.deepEqual(order(tbd), [1, 2, 4, 3, 5, 6], '4 = bottom of next (right after 2)');
  r = await tbd.api('POST', '/api/reminders', { title: 'already done', status: 'done' });
  assert.equal(r.json.reminder.done_at, today());
  assert.equal(fileTasks(tbd).filter((x) => x.status === 'done')[0].title, 'already done', 'add as done = top of done');
});

test('AC2 PATCH edits and clears fields; bad values are rejected; DELETE removes', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  let r = await tbd.api('PATCH', '/api/reminders/t_aaaaa3', { title: '  renamed  ', due: null, note: 'hi', project: 'X', tag: 'acme/api' });
  assert.equal(r.status, 200);
  const want = { id: 't_aaaaa3', title: 'renamed', status: 'now', created: '2026-09-02', type: 'reminder', note: 'hi', project: 'X', tag: 'acme/api' };
  assert.deepEqual(r.json.reminder, want, 'title trimmed, due cleared, fields set');
  r = await tbd.api('PATCH', '/api/reminders/t_aaaaa3', { note: '', project: null });
  assert.equal(r.json.reminder.note, undefined);
  assert.equal(r.json.reminder.project, undefined);

  for (const body of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(501) }, { due: '2026-02-30' }, { due: 'tomorrow' },
    { status: null }, { tag: 'Bad Tag' }, { color: 'red' }, {}]) {
    assert.equal((await tbd.api('PATCH', '/api/reminders/t_aaaaa3', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await tbd.api('POST', '/api/reminders', { status: 'now' })).status, 400, 'title required');

  r = await tbd.api('DELETE', '/api/reminders/t_aaaaa3');
  assert.deepEqual(r.json, { deleted: 't_aaaaa3' });
  assert.ok(!fileTasks(tbd).some((x) => x.id === 't_aaaaa3'));
  assert.equal(eventLines(tbd).at(-1).kind, 'remove');
  assert.equal((await tbd.api('DELETE', '/api/reminders/t_aaaaa3')).status, 404);
});

// Boots tbd (fresh temp TB_HOME unless given) with tbd.pid = pid (mtime optional, env: extra vars). Resolves
// { started, err, pidLeft }: a started tbd is SIGTERMed at once; pidLeft = tbd.pid text after exit or null.
/** @param {{ pid?: string, mtime?: Date, tbHome?: string, home?: string, env?: Record<string, string> }} [opts] */
function boot({ pid, mtime, tbHome, home, env = {} } = {}) {
  const dir = tbHome ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-pid-'));
  if (dir) {
    tbHome = path.join(dir, 'tbhome');
    home = path.join(dir, 'home');
    fs.mkdirSync(tbHome);
    fs.mkdirSync(home);
  }
  const pidFile = path.join(tbHome, 'tbd.pid');
  if (pid !== undefined) fs.writeFileSync(pidFile, pid);
  if (mtime) fs.utimesSync(pidFile, mtime, mtime);
  const child = spawn(process.execPath, [TBD], { env: isolatedEnv({ home, tbHome, port: 0 }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; if (out.includes('tbd listening')) child.kill('SIGTERM'); });
  child.stderr.on('data', (c) => (err += c));
  return new Promise((resolve) => child.on('close', () => {
    const pidLeft = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    resolve({ started: out.includes('tbd listening'), err, pidLeft });
  }));
}

const waitFor = async (fn, what) => {
  for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fn(), what);
};

// A1
test('A1 stale tbd.pid (written before boot, or its pid now runs another program) does not block; a live tbd does', async (t) => {
  const live = await startTbd();
  t.after(() => live.stop());
  const livePid = readFile(live, 'tbd.pid');
  const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 3_600_000);
  assert.equal((await boot({ pid: livePid, mtime: beforeBoot })).started, true, 'older than boot = stale, even if the pid runs tbd.js now');
  assert.equal((await boot({ pid: '1' })).started, true, 'pid 1 = launchd: alive, not tbd.js');
  const same = await boot({ tbHome: live.tbHome, home: live.home });
  assert.deepEqual(same, { started: false, err: `error: tbd already running (pid ${livePid})\n`, pidLeft: livePid });
});

// A2
test('A2 empty or garbage tbd.pid written since boot: refused after one re-read, file left alone', async () => {
  for (const pid of ['', 'garbage']) {
    const r = await boot({ pid });
    assert.equal(r.started, false, JSON.stringify(pid));
    assert.match(r.err, /tbd\.pid holds no pid/);
    assert.equal(r.pidLeft, pid, 'never removes a file another tbd may be writing');
  }
  const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 3_600_000);
  assert.equal((await boot({ pid: '', mtime: beforeBoot })).started, true, 'empty but older than boot = stale');
});

// uv_uptime: os.uptime throws inside a board run's sandbox. No boot time = every tbd.pid gets the live-tbd check.
test('A2b os.uptime throws: a live tbd\'s tbd.pid (even an old one) still refuses the start; a dead pid\'s is replaced', async (t) => {
  const NO_UPTIME = { NODE_OPTIONS: `--require ${path.join(__dirname, 'helpers', 'no-uptime.js')}` };
  const old = new Date('2000-01-01T00:00:00Z');
  const live = await startTbd();
  t.after(() => live.stop());
  const livePid = readFile(live, 'tbd.pid');
  fs.utimesSync(path.join(live.tbHome, 'tbd.pid'), old, old);
  const same = await boot({ tbHome: live.tbHome, home: live.home, env: NO_UPTIME });
  assert.deepEqual(same, { started: false, err: `error: tbd already running (pid ${livePid})\n`, pidLeft: livePid });
  const dead = String(spawnSync(process.execPath, ['-e', '']).pid);
  assert.equal((await boot({ pid: dead, mtime: old, env: NO_UPTIME })).started, true, 'dead pid = stale, replaced');
});

// A3 A4
test('A3 A4 TB_HOME is chmod 0700 even if it exists; data files 0600 at start; atomic writes land 0600', async (t) => {
  const tbd = await startTbd({ env: builtEnv, files: { 'tasks.json': V1, 'tags.json': {} } }); // harness: dir 0755, files 0644
  t.after(() => tbd.stop());
  const mode = (...p) => fs.statSync(path.join(tbd.tbHome, ...p)).mode & 0o777;
  assert.equal(mode(), 0o700, 'A4 existing TB_HOME tightened');
  for (const f of ['tasks.json', 'tags.json', 'config.json']) assert.equal(mode(f), 0o600, `A4 ${f} at start`);
  await tbd.api('POST', '/api/reminders', { title: 'mode check' });
  await tbd.api('POST', '/api/tags', { name: 'm', def: {} });
  const { json } = await tbd.api('POST', '/api/flows', { text: 'mode check', kind: 'code' });
  const id = json.ticket.id;
  assert.equal(mode('tickets', id), 0o700);
  for (const p of [['tasks.json'], ['tags.json'], ['events.jsonl'], ['tickets', id, 'ticket.json'], ['tickets', id, 'ticket.md'], ['tickets', id, 'events.jsonl']]) {
    assert.equal(mode(...p), 0o600, `A3 ${p.join('/')} after a write`);
  }
});

// A5
test('A5 remove and promote events carry the full reminder row', async (t) => {
  const tbd = await startTbd({ env: builtEnv, files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  assert.equal((await tbd.api('DELETE', '/api/reminders/t_aaaaa2')).status, 200);
  assert.deepEqual(eventLines(tbd).at(-1).reminder, { ...V1.tasks[1], type: 'reminder' });
  const r = await tbd.api('POST', '/api/tickets/t_aaaaa5/promote', { kind: 'code' });
  const { kind, id, ticket, reminder } = eventLines(tbd).at(-1);
  assert.deepEqual({ kind, id, ticket, reminder }, { kind: 'promote', id: 't_aaaaa5', ticket: r.json.ticket.id, reminder: { ...V1.tasks[4], type: 'reminder' } });
});

// A6
test('A6 events.jsonl append fails: write still 201 + saved, SSE reminder event still sent, error logged', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  fs.mkdirSync(path.join(tbd.tbHome, 'events.jsonl')); // a directory: every append fails (EISDIR)
  let text = '';
  const req = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { 'x-tb-token': tbd.token } }, (res) => res.setEncoding('utf8').on('data', (c) => (text += c)));
  t.after(() => req.destroy());
  await waitFor(() => text.includes('event: system'), 'SSE connected');
  const r = await tbd.api('POST', '/api/reminders', { title: 'no log' });
  assert.equal(r.status, 201);
  assert.equal(fileTasks(tbd)[0].title, 'no log');
  await waitFor(() => text.includes(`event: reminder\ndata: {"id":"${r.json.reminder.id}"`), 'SSE reminder event');
  await waitFor(() => /events\.jsonl.*EISDIR/.test(tbd.stderr()), `error logged: ${tbd.stderr()}`);
});

// A7
test('A7 caps: note 10 000, project 200, tag 200, flow text 100 000 chars; one more → 400', async (t) => {
  const tbd = await startTbd({ env: builtEnv, files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  for (const [k, max] of Object.entries({ note: 10_000, project: 200, tag: 200 })) {
    assert.equal((await tbd.api('PATCH', '/api/reminders/t_aaaaa1', { [k]: 'a'.repeat(max) })).status, 200, `${k} ${max}`);
    assert.equal((await tbd.api('PATCH', '/api/reminders/t_aaaaa1', { [k]: 'a'.repeat(max + 1) })).status, 400, `PATCH ${k} ${max + 1}`);
    assert.equal((await tbd.api('POST', '/api/reminders', { title: `cap ${k}`, [k]: 'a'.repeat(max + 1) })).status, 400, `POST ${k} ${max + 1}`);
  }
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'a'.repeat(100_001), kind: 'code' })).status, 400);
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'a'.repeat(100_000), kind: 'code' })).status, 201);
});

// A11
test('A11 write fails (TB_HOME read-only): 500, memory + tasks.json unchanged, no *.tmp; next write after restore OK', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  const before = (await tbd.api('GET', '/api/state')).json.reminders;
  const disk = readFile(tbd, 'tasks.json');
  fs.chmodSync(tbd.tbHome, 0o500); // a-w: no tmp file can be created; tasks.json itself stays writable
  let r;
  try {
    r = await tbd.api('POST', '/api/reminders', { title: 'cannot save' });
  } finally {
    fs.chmodSync(tbd.tbHome, 0o700);
  }
  assert.equal(r.status, 500, 'a direct write to tasks.json would succeed here: tmp + rename is what fails');
  assert.deepEqual((await tbd.api('GET', '/api/state')).json.reminders, before, 'memory changes only after the disk did');
  assert.equal(readFile(tbd, 'tasks.json'), disk);
  assert.deepEqual(fs.readdirSync(tbd.tbHome).filter((f) => f.endsWith('.tmp')), []);
  assert.equal((await tbd.api('POST', '/api/reminders', { title: 'saved now' })).status, 201);
  assert.deepEqual(fileTasks(tbd).map((x) => x.title), [...V1.tasks.map((x) => x.title), 'saved now']);
});

// A11b
test('A11b rename fails (tasks.json is a directory): 500, tmp file removed; next write after restore OK', async (t) => {
  const tbd = await startTbd({ files: { 'tasks.json': V1 } });
  t.after(() => tbd.stop());
  const target = path.join(tbd.tbHome, 'tasks.json');
  fs.rmSync(target);
  fs.mkdirSync(path.join(target, 'x'), { recursive: true }); // tmp is written, then rename onto a dir fails
  assert.equal((await tbd.api('POST', '/api/reminders', { title: 'cannot rename' })).status, 500);
  assert.deepEqual(fs.readdirSync(tbd.tbHome).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(target, { recursive: true });
  assert.equal((await tbd.api('POST', '/api/reminders', { title: 'saved now' })).status, 201);
  assert.deepEqual(fileTasks(tbd).map((x) => x.title), [...V1.tasks.map((x) => x.title), 'saved now']);
});

// S8: the tmp name is predictable and a run's cwd can be the ticket dir. In process: a real fs, fsp.rm wrapped once
// so the agent wins the race between the rm and the open.
test('S8 writeAtomic never writes through a link at its tmp path: planted before (removed, the write lands) or after the rm (wx refuses)', async (t) => {
  const fsp = require('node:fs/promises');
  const { writeAtomic } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(root, 's8-'));
  const [victim, file] = [path.join(dir, 'victim'), path.join(dir, 'ticket.json')];
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(victim, 'mine');
  fs.symlinkSync(victim, tmp);
  await writeAtomic(file, 'new');
  assert.deepEqual([fs.readFileSync(victim, 'utf8'), fs.readFileSync(file, 'utf8')], ['mine', 'new'], 'link target unchanged, write landed');
  const rm = fsp.rm;
  t.after(() => { fsp.rm = rm; });
  fsp.rm = async (...a) => { await rm(...a); fsp.rm = rm; fs.symlinkSync(victim, tmp); };
  await assert.rejects(writeAtomic(file, 'newer'), { code: 'EEXIST' });
  assert.deepEqual([fs.readFileSync(victim, 'utf8'), fs.readFileSync(file, 'utf8')], ['mine', 'new'], 'link target unchanged, nothing written');
});

// D-0080: store.init() in a child on a TB_HOME (the store reads TB_HOME at require) → its merged config
const STORE = path.join(__dirname, '..', 'lib', 'store.js');
function merged(tbHome) {
  const r = spawnSync(process.execPath, ['-e', `const s = require(${JSON.stringify(STORE)}); s.init(); process.stdout.write(JSON.stringify(s.config))`],
    { env: isolatedEnv({ home: path.join(root, 'home'), tbHome, port: 0 }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// M5 C10 (contract change; was no final_gate key): phase_need_gb gains final_gate 0.4. full-access-runs Phase 1 + 4
// (contract change): planning / review / final_gate 0.4 → 0.6 (read-only + 2 subagents peak 352 MB)
test('D36 D-0080 fresh config.json holds only the machine key claude_bin; the 8 GB RAM defaults (planning/review/final_gate 0.6, working 1.0, qa 1.0, min_free 0.5; D-0100 was qa 1.5, min_free 1) come from code', () => {
  const tbHome = path.join(root, 'd80-fresh');
  const config = merged(tbHome);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tbHome, 'config.json'), 'utf8')), { claude_bin: path.join(tbHome, 'bin', `claude-${DEFAULT_PIN}`) }, 'no defaults written');
  assert.deepEqual(config.memory.phase_need_gb, { planning: 0.6, review: 0.6, working: 1.0, qa: 1.0, final_gate: 0.6 });
  assert.equal(config.memory.min_free_gb, 0.5);
  assert.equal(config.claude_bin, path.join(tbHome, 'bin', `claude-${DEFAULT_PIN}`));
});

test('D-0080 a config.json already there is never rewritten; its keys beat the code defaults, the rest stay defaults', () => {
  const tbHome = path.join(root, 'd80-own');
  fs.mkdirSync(tbHome);
  const text = '{ "max_concurrent": 2 }\n';
  fs.writeFileSync(path.join(tbHome, 'config.json'), text);
  const config = merged(tbHome);
  assert.equal(fs.readFileSync(path.join(tbHome, 'config.json'), 'utf8'), text);
  assert.equal(config.max_concurrent, 2);
  assert.deepEqual(config.memory.phase_need_gb, { planning: 0.6, review: 0.6, working: 1.0, qa: 1.0, final_gate: 0.6 });
});

// M5 C10: a missing key would throw at spawn (models, max_turns, wall_min) or make admission compare against NaN (never ok)
test('M5 C10 fresh config: final_gate has a RAM need (0.6 GB, full-access-runs Phase 4; was 0.4), a wall (30 min), a turn cap (40) and a model (opus xhigh); its admission is ok with room, memory without', () => {
  const config = merged(path.join(root, 'm53-final'));
  assert.deepEqual([config.memory.phase_need_gb.final_gate, config.liveness.wall_min.final_gate, config.max_turns.final_gate, config.models.final_gate],
    [0.6, 30, 40, { model: 'opus', effort: 'xhigh' }]);
  const admission = require('../lib/admission');
  const snap = (gb) => ({ pressure: 'normal', disk_free: 100 * 2 ** 30, avail: gb * 2 ** 30, docker: false });
  const admit = (gb) => admission.admit({ snap: snap(gb), runs: 0, phase: 'final_gate', config, needGb: admission.needGb('final_gate', [], config) });
  assert.deepEqual([admit(1.2), admit(1)], [{ ok: true }, { ok: false, reason: 'memory' }]); // min_free 0.5 + 0.6
});

test('M5 C9 fresh config: a slot lease holds up to 75 min (slots.max_hold_min, was the implicit 60), longer than a qa run\'s wall (60)', () => {
  const config = merged(path.join(root, 'm5-hold'));
  assert.equal(config.slots.max_hold_min, 75);
  assert.ok(config.slots.max_hold_min > config.liveness.wall_min.qa);
});

// full-access-runs Phase 8: the Settings keys at the store, the check behind POST /api/config and tb config set (plan
// limits: max_concurrent 1-3, subagents concurrent 1-4 / per_session_total 1-20 / depth 1, model opus|sonnet|fable,
// effort low..xhigh, skills installed or board defaults, memory.phase_need_gb 0.2-4 and no other memory key)
test('Phase 8 updateConfig: each Settings key is accepted and written whole (one set back to its default leaves config.json); a bad model, a 5th subagent, an unknown skill, another memory key, 0.1 GB → 400, nothing written', () => {
  const tbHome = path.join(root, 'p8-settings');
  const file = path.join(tbHome, 'config.json');
  const script = `
    const fs = require('node:fs');
    const s = require(${JSON.stringify(STORE)});
    s.init();
    const d = s.DEFAULTS, mem = d.memory;
    const tries = {
      max: { max_concurrent: 2 },
      subagents: { subagents: { concurrent: 1, per_session_total: 5, depth: 1 } },
      models: { models: { ...d.models, review: { model: 'sonnet', effort: 'high' } } },
      final: { final_distinct: true },
      skills: { skills: { defaults: ['learning', 'caveman'] } },
      lanes: { lanes: { enabled: true } },
      memory: { memory: { ...mem, phase_need_gb: { ...mem.phase_need_gb, working: 1.5 } } },
      bad_model: { models: { ...d.models, qa: { model: 'gpt-5', effort: 'high' } } },
      fifth: { subagents: { concurrent: 5, per_session_total: 8, depth: 1 } },
      unknown_skill: { skills: { defaults: ['learning', 'no-such-skill'] } },
      other_memory: { memory: { ...mem, min_free_gb: 0.1 } },
      low_ram: { memory: { ...mem, phase_need_gb: { ...mem.phase_need_gb, qa: 0.1 } } },
    };
    (async () => {
      const out = {};
      for (const [k, p] of Object.entries(tries)) out[k] = await s.updateConfig(p).then(() => 'ok', (e) => e.status);
      const file1 = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
      await s.updateConfig({ lanes: { enabled: false } });
      const file2 = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
      console.log(JSON.stringify({ out, file1, file2, review: s.config.models.review }));
      await s.flush();
      process.exit(0);
    })();`;
  const r = spawnSync(process.execPath, ['-e', script], { env: isolatedEnv({ home: path.join(root, 'home'), tbHome, port: 0 }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { out, file1, file2, review } = JSON.parse(r.stdout);
  assert.deepEqual(out, { max: 'ok', subagents: 'ok', models: 'ok', final: 'ok', skills: 'ok', lanes: 'ok', memory: 'ok', bad_model: 400, fifth: 400, unknown_skill: 400, other_memory: 400, low_ram: 400 });
  assert.deepEqual(Object.keys(file1).sort(), ['claude_bin', 'final_distinct', 'lanes', 'max_concurrent', 'memory', 'models', 'skills', 'subagents']);
  assert.deepEqual([file1.max_concurrent, file1.subagents, file1.models.review, file1.models.qa, file1.skills, file1.memory.phase_need_gb.working, file1.memory.phase_need_gb.qa],
    [2, { concurrent: 1, per_session_total: 5, depth: 1 }, { model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'xhigh' }, { defaults: ['learning', 'caveman'] }, 1.5, 1.0], 'refused patches wrote nothing');
  assert.equal('lanes' in file2, false, 'lanes back at its default: gone from config.json (overrides only)');
  assert.deepEqual(review, { model: 'sonnet', effort: 'high' }, 'the live config has it at once');
});
