'use strict';
// P1 AC1 + AC9 (+ D31 timeout): every tb verb against a real tbd on a temp HOME + TB_HOME (harness); never ~/.taskboard.
// Each test traces to a verb in plan 3b/4b or a skill command (test/fixtures/skill-commands.txt).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startTbd, runTb, request, isolatedEnv, phaseFixture, PHASE_FILES, FAKE_HANDLERS } = require('./helpers/tbd');

const ROOT = path.join(__dirname, '..');
const TB = path.join(ROOT, 'bin', 'tb');
const SEED = [
  { id: 't_k3x9qa', title: 'Reply to recruiter', status: 'now', project: 'Acme', due: '2026-09-25', created: '2026-09-23' },
  { id: 't_m4n5p6', title: 'Review billing PR', status: 'now', project: 'Acme', created: '2026-09-23' },
  { id: 't_u1v2w3', title: 'Waiting on keys', status: 'next', project: 'Acme', created: '2026-09-23' },
  { id: 't_q7r8s9', title: 'Read DDIA ch.5', status: 'later', project: 'Learning', created: '2026-09-23' },
  { id: 't_x4y5z6', title: 'Inbox idea', status: 'inbox', created: '2026-09-23' },
  { id: 't_d1d2d3', title: 'Old chore', status: 'done', created: '2026-09-20', done_at: '2026-09-21' },
];

// One tbd per test: tests stay independent. fn gets the tbd handle and tb(...args).
async function withBoard(fn) {
  const t = await startTbd({ files: { 'tasks.json': { tasks: SEED } } });
  try { await fn(t, (...args) => runTb(args, t)); } finally { await t.stop(); }
}

// Reads the board straight from tbd, not through tb.
const state = async t => (await t.api('GET', '/api/state')).json;
const stored = async t => (await state(t)).reminders;
const titles = (rows, status) => rows.filter(r => r.status === status).map(r => r.title);

test('read verbs: dashboard, list, grep, get, show', () => withBoard(async (_t, tb) => {
  const home = await tb();
  assert.equal(home.code, 0, home.stdout);
  assert.match(home.stdout, /^counts: inbox 1 · now 2 · next 1 · later 1 · done 1 · overdue 1$/m);
  assert.match(home.stdout, /^ {2}t_k3x9qa,now,1,Acme,2026-09-25,Reply to recruiter$/m);

  assert.match((await tb('list')).stdout, /^tasks\[5\]\{id,status,pos,project,due,title\}:$/m);
  assert.doesNotMatch((await tb('list')).stdout, /Old chore/);
  assert.match((await tb('list', '--status', 'all')).stdout, /^tasks\[6\]/m);
  assert.match((await tb('list', '--project', 'acme', '--status', 'now')).stdout, /^tasks\[2\]/m);
  assert.match((await tb('list', '--flows')).stdout, /^flows\[0\]: none$/m);
  const badStatus = await tb('list', '--status', 'soon');
  assert.equal(badStatus.code, 2);
  assert.match(badStatus.stdout, /^error: unknown status "soon"$/m);

  assert.match((await tb('grep', 'BILLING|ddia')).stdout, /^matches\[2\]/m);
  const none = await tb('grep', 'nothing-here');
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^matches\[0\]: none$/m);
  assert.equal((await tb('grep')).code, 2);

  const get = await tb('get', 't_k3x9qa');
  assert.match(get.stdout, /^ {2}status: now \(#1 of 2\)$/m);
  assert.match(get.stdout, /^ {2}due: "?2026-09-25"?$/m);
  assert.match((await tb('show', 'billing')).stdout, /^ {2}id: t_m4n5p6$/m);

  const ambiguous = await tb('get', 're'); // Reply, Review, Read, Old chore: 3 open, so no unique open match
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stdout, /^error: "re" matches 4 tasks; use an id$/m);
  assert.match(ambiguous.stdout, /^matches\[4\]/m);
  const unknown = await tb('get', 'zzz');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stdout, /^error: no task matches "zzz"$/m);
}));

test('add: fields, positions, now-limit warning, no-op on the same open title', () => withBoard(async (t, tb) => {
  const first = await tb('add', 'Fresh task', '--status', 'now', '--pos', '1', '--project', 'Acme', '--due', '2030-02-03', '--note', 'hello, world');
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /^added: t_[a-z0-9]{6} → now #1 · Acme · due 2030-02-03 · Fresh task$/m);
  assert.doesNotMatch(first.stdout, /warn:/); // 3 in now = at the limit, not over
  let rows = await stored(t);
  assert.equal(rows.find(r => r.title === 'Fresh task').note, 'hello, world');

  const second = await tb('add', 'Second task', '--status', 'now', '--pos', '2');
  assert.match(second.stdout, /^added: t_[a-z0-9]{6} → now #2 · Second task$/m);
  assert.match(second.stdout, /^warn: now has 4 tasks \(limit 3\); move the lowest to next$/m);
  const last = await tb('add', 'Last task', '--status', 'now');
  assert.match(last.stdout, /→ now #5 · Last task$/m);
  rows = await stored(t);
  assert.deepEqual(titles(rows, 'now'), ['Fresh task', 'Second task', 'Reply to recruiter', 'Review billing PR', 'Last task']);

  const dup = await tb('add', 'fresh TASK');
  assert.equal(dup.code, 0);
  assert.match(dup.stdout, /^noop \(already exists\): t_[a-z0-9]{6} → now #1/m);
  assert.equal((await stored(t)).length, rows.length);

  for (const bad of [[], ['x', '--status', 'soon'], ['x', '--due', '2026-13-45'], ['x', '--pos', '0'], ['x', '--nope', '1']]) {
    const r = await tb('add', ...bad);
    assert.equal(r.code, 2, `add ${bad.join(' ')}: ${r.stdout}`);
  }
  assert.equal((await stored(t)).length, rows.length);
}));

test('set and move: --due none clears, --pos places, same value is a no-op', () => withBoard(async (t, tb) => {
  const clear = await tb('set', 't_k3x9qa', '--due', 'none');
  assert.equal(clear.code, 0);
  assert.match(clear.stdout, /^updated: t_k3x9qa → now #1 · Acme · Reply to recruiter$/m);
  assert.equal((await stored(t)).find(r => r.id === 't_k3x9qa').due, undefined);
  assert.match((await tb('set', 't_k3x9qa', '--due', 'none')).stdout, /^noop \(no change\): t_k3x9qa/m);

  await tb('set', 't_k3x9qa', '--title', '  Reply today ');
  assert.equal((await stored(t)).find(r => r.id === 't_k3x9qa').title, 'Reply today');

  const place = await tb('set', 't_m4n5p6', '--status', 'next', '--pos', '1');
  assert.match(place.stdout, /→ next #1 · Acme · Review billing PR$/m);
  assert.deepEqual(titles(await stored(t), 'next'), ['Review billing PR', 'Waiting on keys']);

  const move = await tb('move', 't_q7r8s9', 'now');
  assert.match(move.stdout, /^updated: t_q7r8s9 → now #2 /m);
  assert.deepEqual(titles(await stored(t), 'now'), ['Reply today', 'Read DDIA ch.5']);

  assert.equal((await tb('set', 't_x4y5z6')).code, 2);
  assert.equal((await tb('move', 't_q7r8s9', 'soon')).code, 2);
  const ambiguous = await tb('set', 're', '--due', '2030-01-01');
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stdout, /^matches\[/m);
}));

test('done and rm: next up, idempotent done, removed rows, unknown ref', () => withBoard(async (t, tb) => {
  const done = await tb('done', 'Review billing');
  assert.equal(done.code, 0, done.stdout);
  assert.match(done.stdout, /^done: t_m4n5p6 → done #1 · Acme · Review billing PR$/m);
  assert.match(done.stdout, /^next up: t_k3x9qa · Reply to recruiter$/m);
  const row = (await stored(t)).find(r => r.id === 't_m4n5p6');
  assert.equal(row.status, 'done');
  assert.match(row.done_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(titles(await stored(t), 'done')[0], 'Review billing PR');

  assert.match((await tb('done', 'Review billing')).stdout, /^noop \(already done\): t_m4n5p6/m);
  const both = await tb('done', 't_k3x9qa', 't_x4y5z6');
  assert.equal(both.stdout.match(/^done: /gm).length, 2);
  assert.equal((await tb('done', 'nothing-here')).code, 1);
  const partial = await tb('done', 't_u1v2w3', 'nothing-here'); // one bad ref: nothing is done
  assert.equal(partial.code, 1);
  assert.equal((await stored(t)).find(r => r.id === 't_u1v2w3').status, 'next');

  const rm = await tb('rm', 't_d1d2d3');
  assert.equal(rm.code, 0);
  assert.match(rm.stdout, /^removed\[1\]\{id,status,pos,project,due,title\}:$/m);
  assert.equal((await stored(t)).some(r => r.id === 't_d1d2d3'), false);
  const again = await tb('rm', 't_d1d2d3');
  assert.equal(again.code, 1);
  assert.match(again.stdout, /^error: no task matches "t_d1d2d3"$/m);
  assert.equal((await tb('rm')).code, 2);
}));

test('rm: a DELETE failing midway still prints the rows already removed (fix B5)', async () => {
  const rows = [{ id: 't_aaaaa1', title: 'One', status: 'now' }, { id: 't_aaaaa2', title: 'Two', status: 'now' }];
  const deleted = [];
  const fake = http.createServer((req, res) => { // tbd stand-in: the second DELETE fails
    if (req.url.startsWith('/api/whoami')) return res.end(JSON.stringify({ mac: crypto.createHmac('sha256', 'x').update(new URL(req.url, 'http://x').searchParams.get('n')).digest('hex') })); // H9: proves it knows the token 'x'
    if (req.method === 'GET') return res.end(JSON.stringify({ reminders: rows, flows: [] }));
    const id = req.url.split('/').pop();
    if (id === 't_aaaaa2') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'internal error' })); }
    deleted.push(id);
    res.end(JSON.stringify({ deleted: id }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', () => resolve(undefined)));
  const tbHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rm-'));
  fs.writeFileSync(path.join(tbHome, 'token'), 'x');
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (fake.address()).port;
    const r = await runTb(['rm', 'One', 'Two'], { tbHome, port, home: tbHome });
    assert.equal(r.code, 1);
    assert.deepEqual(deleted, ['t_aaaaa1']);
    assert.equal(r.stdout, 'removed[1]{id,status,pos,project,due,title}:\n  t_aaaaa1,now,1,"","",One\nerror: internal error\n');
  } finally {
    fake.close();
    fs.rmSync(tbHome, { recursive: true, force: true });
  }
});

test('--due takes real calendar dates only: 2026-02-30 is a usage error (fix B6)', () => withBoard(async (t, tb) => {
  for (const args of [['add', 'x', '--due', '2026-02-30'], ['set', 't_k3x9qa', '--due', '2026-02-30'], ['add', 'x', '--due', '2026-2-3']]) {
    const r = await tb(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stdout, /^error: --due must be YYYY-MM-DD or none$/m);
  }
  assert.equal((await stored(t)).find(r => r.id === 't_k3x9qa').due, '2026-09-25');
  assert.equal((await tb('add', 'Leap', '--due', '2028-02-29')).code, 0);
}));

test('--tag is checked client-side with the tbd tag-name regex (fix B10)', () => withBoard(async (t, tb) => {
  for (const args of [['set', 't_k3x9qa', '--tag', 'Bad_Tag'], ['add', 'x', '--tag', 'a//b'], ['new', 'x', '-t', 'Acme']]) {
    const r = await tb(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stdout, /^error: --tag must look like a or a\/b \(lowercase letters, digits, -\)$/m);
  }
  assert.equal((await stored(t)).find(r => r.id === 't_k3x9qa').tag, undefined);
  assert.equal((await tb('set', 't_k3x9qa', '--tag', 'acme/api')).code, 0);
  assert.equal((await stored(t)).find(r => r.id === 't_k3x9qa').tag, 'acme/api');
}));

test('open --print: a one-time unlock URL that sets the session cookie once (fix B3)', () => withBoard(async (t, tb) => {
  const r = await tb('open', '--print');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, new RegExp(`^http://127\\.0\\.0\\.1:${t.port}/unlock\\?code=[0-9a-f]{64}\n$`));
  const u = new URL(r.stdout.trim());
  const first = await request(t.port, 'GET', u.pathname + u.search);
  assert.equal(first.status, 302);
  assert.match(String(first.headers['set-cookie']), /^tb_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict;/);
  assert.equal((await request(t.port, 'GET', u.pathname + u.search)).status, 403, 'single use');
  assert.equal((await tb('open', 'now')).code, 2);
}));

test('tag add/list round trip; new -f and promote surface the "not built yet" refusal', () => withBoard(async (t, tb) => {
  assert.match((await tb('tag', 'list')).stdout, /^tags\[0\]: none$/m);
  const add = await tb('tag', 'add', 'acme/api', '--type', 'folder', '--path', t.tbHome);
  assert.equal(add.code, 0, add.stdout);
  const list = await tb('tag', 'list');
  assert.match(list.stdout, /^tags\[1\]\{name,type,path\}:$/m);
  assert.match(list.stdout, /^ {2}acme\/api,folder,/m);
  assert.equal((await tb('tag', 'add', 'x', '--type', 'nope')).code, 2);
  const badName = await tb('tag', 'add', 'Bad_Name', '--type', 'folder', '--path', t.tbHome);
  assert.equal(badName.code, 1);
  assert.match(badName.stdout, /^error: tag name must look like/m);

  const flow = await tb('new', 'Add retry to the sync job', '-f', 'code', '-t', 'acme/api');
  assert.equal(flow.code, 1);
  assert.match(flow.stdout, /^error: kind code not built yet$/m);
  assert.equal((await state(t)).flows.length, 0);

  const promote = await tb('promote', 't_q7r8s9', '-f', 'code', '-t', 'acme/api');
  assert.equal(promote.code, 1);
  assert.match(promote.stdout, /not built yet/);
  assert.ok((await stored(t)).some(r => r.id === 't_q7r8s9'), 'a refused promote must keep the reminder');

  assert.equal((await tb('promote', 't_q7r8s9', '-f', 'code')).code, 2); // -t missing
  assert.equal((await tb('new', 'x', '-f', 'nope')).code, 2);
  assert.equal((await tb('new', 'x', '-f', 'code', '--due', '2030-01-01')).code, 2); // reminder flag on a flow
  assert.equal((await tb('new', 'x', '--fix-of', 't_q7r8s9')).code, 2); // --fix-of needs -f
}));

test('new -f and promote create a flow once the kind is built; list --flows and show read it', async () => {
  const phases = phaseFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-phases-')), { 'code/working': PHASE_FILES });
  const t = await startTbd({ files: { 'tasks.json': { tasks: SEED } }, env: { TB_PHASES_DIR: phases, NODE_OPTIONS: FAKE_HANDLERS } });
  const tb = (...args) => runTb(args, t);
  try {
    assert.equal((await tb('tag', 'add', 'acme/api', '--type', 'folder', '--path', t.tbHome)).code, 0);
    const text = `Add retry to the sync job\n${'detail '.repeat(100)}`;
    const made = await tb('new', text, '-f', 'code', '-t', 'acme/api');
    assert.equal(made.code, 0, made.stdout);
    const id = /^added: (t_[a-z0-9]{6}) → backlog · code · acme\/api · Add retry to the sync job$/m.exec(made.stdout)?.[1];
    assert.ok(id, made.stdout);
    assert.equal((await state(t)).flows.length, 1);

    const flows = await tb('list', '--flows');
    assert.match(flows.stdout, /^flows\[1\]\{id,kind,tag,state,waiting,title\}:$/m);
    assert.ok(flows.stdout.includes(`  ${id},code,acme/api,backlog,"",Add retry to the sync job`), flows.stdout);
    assert.match((await tb('list')).stdout, /^flows\[1\]/m); // no filter: open flows ride along
    assert.doesNotMatch((await tb('list', '--status', 'all')).stdout, /^flows\[/m);
    assert.match((await tb('list', '--flows', '--status', 'working')).stdout, /^flows\[0\]: none$/m);
    assert.equal((await tb('list', '--flows', '--status', 'now')).code, 2); // a reminder status, not a flow state
    assert.equal((await tb('list', '--flows', '--project', 'Acme')).code, 2);

    const show = await tb('show', 'retry');
    assert.match(show.stdout, /^flow:$/m);
    assert.match(show.stdout, /^ {2}state: backlog$/m);
    assert.match(show.stdout, new RegExp(`\\(truncated, ${text.trim().length} chars total\\)`));
    assert.ok(show.stdout.includes(`help: tb show ${id} --full`), show.stdout);
    assert.doesNotMatch((await tb('show', id, '--full')).stdout, /truncated/);

    const fix = await tb('new', 'Fix the retry', '--title', 'Retry fix', '-f', 'code', '-t', 'acme/api', '--fix-of', id);
    assert.match(fix.stdout, /· Retry fix$/m);
    assert.ok((await tb('show', 'Retry fix')).stdout.includes(`  fix_of: ${id}`));
    assert.equal((await tb('new', 'x', '-f', 'code', '-t', 'acme/api', '--fix-of', 't_nope00')).code, 1); // not a ticket

    const promoted = await tb('promote', 'Read DDIA', '-f', 'code', '-t', 'acme/api');
    assert.equal(promoted.code, 0, promoted.stdout);
    assert.match(promoted.stdout, /^promoted: t_q7r8s9 → t_[a-z0-9]{6} · backlog · code · acme\/api · Read DDIA ch\.5$/m);
    assert.equal((await stored(t)).some(r => r.id === 't_q7r8s9'), false);
    assert.match((await tb('show', 'Read DDIA')).stdout, /^ {2}promoted_from: t_q7r8s9$/m);
  } finally {
    await t.stop();
    fs.rmSync(phases, { recursive: true, force: true });
  }
});

test('usage errors exit 2 with a hint', () => withBoard(async (_t, tb) => {
  const unknown = await tb('frob');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout, /^error: unknown command "frob"$/m);
  const flag = await tb('list', '--stat', 'now');
  assert.equal(flag.code, 2);
  assert.match(flag.stdout, /^error: unknown flag --stat for `list`$/m);
  assert.match(flag.stdout, /^help: valid flags: --status, --project, --limit, --flows, --reminders$/m);
  assert.equal((await tb('tag')).code, 2);
  assert.equal((await tb('add', 'x', '--status')).code, 2); // value missing
}));

test('tbd not running: exit 1 with the restart command', () => withBoard(async (t) => {
  const refused = await runTb(['list'], { ...t, port: 1 }); // token readable, nothing listens on port 1
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^error: tbd not running$/m);
  assert.match(refused.stdout, /^help: launchctl kickstart -k gui\/\$\(id -u\)\/local\.taskboard$/m);
  const noToken = await runTb(['add', 'x'], { ...t, tbHome: path.join(t.tbHome, 'missing') });
  assert.equal(noToken.code, 1);
  assert.match(noToken.stdout, /^error: tbd not running$/m);
}));

test('a tbd that never answers times out after 5 s (D31); long-timeout verbs report the 5 s whoami, not their own', async () => {
  const hung = http.createServer(() => {}); // accepts, never replies
  await new Promise(resolve => hung.listen(0, '127.0.0.1', () => resolve(undefined)));
  const tbHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hung-'));
  fs.writeFileSync(path.join(tbHome, 'token'), 'x');
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (hung.address()).port;
    const run = verb => new Promise(resolve => execFile(process.execPath, [TB, verb], {
      env: isolatedEnv({ home: tbHome, tbHome, port }),
    }, (err, out) => resolve({ code: err ? err.code : 0, stdout: out })));
    for (const { code, stdout } of await Promise.all([run('list'), run('gc')])) { // gc waits 600 s, but its whoami 5 s
      assert.equal(code, 1);
      assert.match(stdout, /^error: tbd did not answer within 5s$/m);
    }
  } finally {
    hung.closeAllConnections();
    hung.close();
    fs.rmSync(tbHome, { recursive: true, force: true });
  }
});

test('eval fake runs the test dir next to bin/tb and returns its exit code (AC9)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.copyFileSync(TB, path.join(root, 'bin', 'tb'));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true }); // cli shares STATUSES/KINDS/isDate with store + fsm
    fs.writeFileSync(path.join(root, 'test', 'a.test.js'), "require('node:test').test('green', () => {});\n");
    // a nested node --test must not think it is a test file of the outer run
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
    const run = () => spawnSync(process.execPath, [path.join(root, 'bin', 'tb'), 'eval', 'fake'], { encoding: 'utf8', env });

    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /pass 1/);

    fs.writeFileSync(path.join(root, 'test', 'b.test.js'), "require('node:test').test('red', () => { throw new Error('boom'); });\n");
    const red = run();
    assert.equal(red.status, 1);
    assert.match(red.stdout, /fail 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bin/tb and bin/taskboard-axi are executable node scripts', () => {
  for (const f of ['tb', 'taskboard-axi']) {
    const file = path.join(ROOT, 'bin', f);
    fs.accessSync(file, fs.constants.X_OK);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  }
});

// AC1: every command in the skills (tb syntax) exits as documented against a seeded tbd.
describe('skill commands (test/fixtures/skill-commands.txt)', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'skill-commands.txt'), 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#')).map(l => /^(\d) \| (.+?)(?: => (.+))?$/.exec(l));
  let board, binDir;
  before(async () => {
    board = await startTbd({ files: { 'tasks.json': { tasks: SEED } } });
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bin-'));
    fs.symlinkSync(TB, path.join(binDir, 'tb'));
  });
  after(async () => {
    await board.stop();
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test('fixture parses', () => assert.ok(lines.length > 40 && lines.every(Boolean)));
  for (const m of lines.filter(Boolean)) {
    test(m[2], () => {
      const env = { ...isolatedEnv(board), PATH: `${binDir}:${process.env.PATH}` };
      const r = spawnSync('sh', ['-c', m[2]], { encoding: 'utf8', env });
      assert.equal(r.status, Number(m[1]), r.stdout + r.stderr);
      assert.ok(r.stdout.trim(), 'no output');
      if (m[1] === '0') assert.doesNotMatch(r.stdout, /^error:/m);
      if (m[3]) assert.match(r.stdout, new RegExp(m[3]));
    });
  }
});
