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
const { ticket, FAKE, until } = require('./helpers/runs');

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

test('tag add/list round trip; new -f and promote of an unbuilt kind surface the "not built yet" refusal', () => withBoard(async (t, tb) => {
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

  const flow = await tb('new', 'Add retry to the sync job', '-f', 'brainstorm', '-t', 'acme/api');
  assert.equal(flow.code, 1);
  assert.match(flow.stdout, /^error: kind brainstorm not built yet$/m);
  assert.equal((await state(t)).flows.length, 0);

  const promote = await tb('promote', 't_q7r8s9', '-f', 'brainstorm', '-t', 'acme/api');
  assert.equal(promote.code, 1);
  assert.match(promote.stdout, /not built yet/);
  assert.ok((await stored(t)).some(r => r.id === 't_q7r8s9'), 'a refused promote must keep the reminder');

  assert.equal((await tb('promote', 't_q7r8s9', '-f', 'brainstorm')).code, 2); // -t missing
  assert.equal((await tb('new', 'x', '-f', 'nope')).code, 2);
  assert.equal((await tb('new', 'x', '-f', 'brainstorm', '--due', '2030-01-01')).code, 2); // reminder flag on a flow
  assert.equal((await tb('new', 'x', '--fix-of', 't_q7r8s9')).code, 2); // --fix-of needs -f
}));

test('M5 D-0104 tag add / doctor --tag with --ident --push-remote: merged into the stored tag (ident from your global git config); git ident missing or no --tag → usage error, unknown tag → error, nothing stored', () => withBoard(async (t, tb) => {
  const cfg = path.join(t.home, 'my.gitconfig');
  fs.writeFileSync(cfg, '[user]\n\tname = Irfan G\n\temail = irfan@example.com\n');
  const as = (gitCfg, ...args) => runTb(args, t, { GIT_CONFIG_GLOBAL: gitCfg });
  const tags = async () => (await t.api('GET', '/api/tags')).json.tags;
  assert.equal((await tb('tag', 'add', 'acme/api', '--type', 'folder', '--path', t.tbHome)).code, 0);
  const add = await as(cfg, 'tag', 'add', 'acme/api', '--ident', '--push-remote', 'mirror');
  assert.equal(add.code, 0, add.stdout);
  assert.match(add.stdout, /^updated: tag acme\/api · folder · .+ · ident Irfan G <irfan@example\.com> · push mirror$/m);
  const ident = { name: 'Irfan G', email: 'irfan@example.com' };
  assert.deepEqual((await tags())['acme/api'], { type: 'folder', path: path.resolve(t.tbHome), push: { remote: 'mirror' }, ident });
  // doctor --tag merges too (its checks fail here: no claude in this board; the merge comes first)
  await as(cfg, 'doctor', '--tag', 'acme/api', '--push-remote', 'origin');
  assert.deepEqual((await tags())['acme/api'], { type: 'folder', path: path.resolve(t.tbHome), push: { remote: 'origin' }, ident });
  // H live E2E gap: QA needs qa_ports, onboarding needs db: both merge like --ident; --db none drops the key
  const qa = await tb('tag', 'add', 'acme/api', '--qa-ports', '3000,3001', '--db', 'local');
  assert.equal(qa.code, 0, qa.stdout);
  assert.deepEqual((await tags())['acme/api'], { type: 'folder', path: path.resolve(t.tbHome), push: { remote: 'origin' }, ident, qa_ports: [3000, 3001], db: 'local' });
  await as(cfg, 'doctor', '--tag', 'acme/api', '--db', 'none');
  assert.deepEqual((await tags())['acme/api'], { type: 'folder', path: path.resolve(t.tbHome), push: { remote: 'origin' }, ident, qa_ports: [3000, 3001] });
  assert.equal((await tb('tag', 'add', 'acme/api', '--qa-ports', '70000')).code, 2, 'port out of range → usage');
  assert.equal((await tb('tag', 'add', 'acme/api', '--db', 'remote')).code, 2, 'db must be local or none');

  const before = await tags();
  const none = await as('/dev/null', 'tag', 'add', 'acme/api', '--ident');
  assert.deepEqual([none.code, none.stdout], [2, 'error: --ident: git user.name is not set\nhelp: git config --global user.name "<your name>"\n']);
  assert.equal((await as(cfg, 'doctor', '--ident')).code, 2, '--ident needs --tag');
  const unknown = await as(cfg, 'tag', 'add', 'acme/nope', '--push-remote', 'mirror');
  assert.deepEqual([unknown.code, /^error: no tag acme\/nope$/m.test(unknown.stdout)], [1, true], unknown.stdout);
  assert.deepEqual(await tags(), before);
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

// D-0081: tbd sends waiting as an object; the flows table printed [object Object]
test('list: a flow\'s waiting column is its reason (children done/total), empty when none, never [object Object]', async () => {
  const since = '2026-10-12T00:00:00.000Z';
  const files = Object.fromEntries([
    // a D9 parent: its own pass recorded (pr.merged_at), as lib/pass.js leaves it; M5.3: a code final gate without one is
    // the runner's (final checks), which would move this fixture
    ticket('t_wait01', { state: 'final_gate', pr: { sha: 'a'.repeat(40), merged_at: since }, waiting: { reason: 'children', done: 1, total: 2, blocked: 0, since } }),
    ticket('t_wait02', { state: 'clarify', waiting: { reason: 'manual', since } }),
    ticket('t_wait03', { state: 'clarify' }),
    // H review C-M2: a Blocked ticket's show keeps the why (its fix steps), as text, not raw JSON
    ticket('t_wait04', { state: 'blocked', waiting: { reason: 'config', why: 'tag branch tb/x moved outside tbd: delete it or move it back', since } }),
  ].map(k => [`tickets/${k.id}/ticket.json`, k]));
  const t = await startTbd({ files });
  try {
    for (const args of [['list', '--flows'], ['list']]) {
      const out = (await runTb(args, t)).stdout;
      for (const row of ['t_wait01,code,"",final_gate,children 1/2,run t_wait01', 't_wait02,code,"",clarify,manual,run t_wait02', 't_wait03,code,"",clarify,"",run t_wait03']) {
        assert.ok(out.includes(`  ${row}\n`), `${args.join(' ')}: ${row}\n${out}`);
      }
      assert.doesNotMatch(out, /object Object/);
    }
    const shown = (await runTb(['show', 't_wait04'], t)).stdout;
    assert.match(shown, /^ {2}waiting: "config · why: tag branch tb\/x moved outside tbd: delete it or move it back · since: /m); // TOON quotes a value holding ':'
    assert.doesNotMatch(shown, /\{"reason"/);
  } finally {
    await t.stop();
  }
});

// M5.3 C13 C20: tb close, tb rework at close, the final gate in tb show / list --flows. A final gate waiting close is
// left alone by the runner (lib/final.js next), so these fixtures stay put without a worktree.
test('M5.3 tb close: waiting close + squash → done (squash line); refused 409 → exit 1 with tbd\'s why (not squashed, already done); tb rework at close with a started dependent → "cancel children first"; show + list --flows name the wait; show has the push line + the tag ident (or the hint on a push tag without one)', async () => {
  const since = '2026-10-14T00:00:00.000Z', tested = 'b'.repeat(40), sq = 'c'.repeat(40);
  const atClose = (id, over = {}) => ticket(id, { state: 'final_gate', round: 6, fixes: 2, waiting: { reason: 'close', since },
    final: { n: 1, tested_sha: tested, verdict: 'pass', sha: sq, at: since }, ...over });
  const push = { remote: 'mirror' }, def = { type: 'git', path: '/nonexistent/acme', base: 'main', push };
  /** @type {Record<string, any>} */
  const files = Object.fromEntries([
    atClose('t_cls001', { tag: 'acme/api', push: { state: 'failed', remote: 'mirror', ref: 'refs/heads/tb/t_cls001-x', sha: sq, why: 'rejected\u202e' } }),
    atClose('t_cls002', { tag: 'acme/noid', final: { n: 1, tested_sha: tested, verdict: 'pass' } }), atClose('t_cls003'),
    ticket('t_dep003', { state: 'clarify', blocked_by: ['t_cls003'] }),
  ].map(k => [`tickets/${k.id}/ticket.json`, k]));
  files['tags.json'] = { acme: {}, 'acme/api': { ...def, ident: { name: 'Irfan G', email: 'i@example.com' } }, 'acme/noid': def };
  const t = await startTbd({ files });
  try {
    assert.ok((await runTb(['list', '--flows'], t)).stdout.includes('  t_cls001,code,acme/api,final_gate,close,run t_cls001\n'));
    const show = (await runTb(['show', 't_cls001'], t)).stdout;
    for (const line of ['  waiting: "waits for close: tb close, tb push or tb rework"', '  fix: 2/3', '  final: pass · final 1 · squash cccccccccccc · tested bbbbbbbbbbbb',
      '  push: failed · mirror tb/t_cls001-x · cccccccccccc · rejected', '  ident: Irfan G <i@example.com>']) {
      assert.ok(show.includes(`${line}\n`), `${line}\n${show}`);
    }
    const noid = (await runTb(['show', 't_cls002'], t)).stdout;
    assert.ok(noid.includes('  ident: "not set: run tb doctor --tag acme/noid --ident"\n') && !noid.includes('  push:'), noid);
    const ok = await runTb(['close', 't_cls001'], t);
    assert.deepEqual([ok.code, ok.stdout], [0, `close: ok · t_cls001 · done · run t_cls001\nsquash: ${sq}\n`]);
    assert.equal((await t.api('GET', '/api/tickets/t_cls001')).json.ticket.state, 'done');
    for (const [args, why] of /** @type {[string[], RegExp][]} */ ([[['close', 't_cls001'], /^error: t_cls001: done → done is not allowed for you$/],
      [['close', 't_cls002'], /^error: t_cls002: .*not ready to close: the final gate has not passed$/]])) {
      const r = await runTb(args, t);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stdout.split('\n')[0], why);
    }
    const rw = await runTb(['rework', 't_cls003', '--feedback', 'rename byId'], t);
    assert.equal(rw.code, 1);
    assert.match(rw.stdout, /^error: t_cls003: .*cancel children first\n/);
    for (const id of ['t_cls002', 't_cls003']) assert.equal((await t.api('GET', `/api/tickets/${id}`)).json.ticket.waiting?.reason, 'close', `${id} stays at close`);
    assert.equal((await runTb(['close'], t)).code, 2);
  } finally {
    await t.stop();
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

// M7 TH1 (m7-build.md lane M-B): tb health renders GET /api/health as tbd sends it, from a tbd seeded with
// test/fixtures/health.json (its expected x / y come from the §12 rules): each target's label, x / y, %, goal, PASS / FAIL /
// n/a with pending, no data and the golden base; tbd RSS; the doctor line. --drills pages the drill log.
const FIX = require('./fixtures/health.json');
const NOW = Date.now();
const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const when = v => (typeof v === 'string' && /^@([+-]\d+[dhms])+$/.test(v)
  ? new Date(NOW + v.slice(1).match(/[+-]\d+[dhms]/g).reduce((n, x) => n + Number(x.slice(0, -1)) * UNIT[x.at(-1)], 0)).toISOString() : v);
const jsonl = rows => rows.map(l => `${JSON.stringify(l)}\n`).join('');

test('TH1 tb health: the 10 targets as tbd sends them (x / y, %, goal, PASS / FAIL / n/a, pending, no data, golden base), tbd RSS, doctor; --drills a page + the cursor help; --days 0, a bad --cursor, --limit without --drills → usage', async (t) => {
  const SEED = JSON.parse(JSON.stringify(FIX.seed, (_k, v) => when(v)));
  const phases = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-th1-')); // empty: no phase built, so nothing moves the seeded numbers
  const tbd = await startTbd({ env: { TB_PHASES_DIR: phases }, files: {
    'metrics.1.jsonl': jsonl(SEED['metrics.1.jsonl']), 'metrics.jsonl': jsonl(SEED['metrics.jsonl']), 'evals/golden.jsonl': jsonl(SEED['evals/golden.jsonl']),
    'doctor.json': SEED['doctor.json'], ...Object.fromEntries(Object.entries(SEED.tickets).map(([id, over]) => [`tickets/${id}/ticket.json`, ticket(id, over)])),
  } });
  t.after(async () => { await tbd.stop(); fs.rmSync(phases, { recursive: true, force: true }); });
  const tb = (...args) => runTb(args, tbd);
  const r = await tb('health');
  assert.equal(r.code, 0, r.stdout);
  const [head, cols, ...rows] = r.stdout.trimEnd().split('\n');
  assert.match(head, /^health: 4 of 9 targets met · last 30 days \(\d{4}-\d\d-\d\dT[\d:.]+Z → \d{4}-\d\d-\d\dT[\d:.]+Z\)$/);
  assert.equal(cols, 'targets[10]{key,target,x,y,pct,goal,result,note}:');
  const base = SEED['evals/golden.jsonl'][0].at; // the -10d line: the -6d one is ok false (fixture _comment)
  const want = [
    '  recovered,Interruptions recovered without you,2,4,50%,>= 95%,FAIL,pending 1',
    '  resume_restart,Runs you had to Resume or Restart,2,10,20%,<= 5%,FAIL,""',
    '  infra,Gate failures classified infra,2,4,50%,<= 5%,FAIL,""',
    '  false_stall,False stall alerts (the run produced events within 6 min),1,5,20%,<= 20%,PASS,""',
    '  rework,Code tickets done with ≤ 1 rework,4,5,80%,>= 70%,PASS,""',
    '  hands_off,Hands-off after approve,2,4,50%,>= 60%,FAIL,no data 1',
    '  fix_of,fix_of tickets within 14 days of done,2,5,40%,<= 10%,FAIL,""', // fixture _comment: t_fix011 + t_fix014 in range
    `  golden,"Golden-ticket score: no regression vs last run",2,2,100%,all,PASS,${JSON.stringify(`base ${base} · changed (total moved, not compared): golden:E`)}`, // TOON quotes a value holding : or ,
    /^ {2}rss,tbd RSS,\d+(\.\d+)? MB,80 MB,"-",<= 80 MB,PASS,""$/,
    '  planner_call,"Decisions marked \\"planner\'s call\\"",4,9,44%,watch,n/a,""',
    `doctor: FAIL (tag shop) · ${SEED['doctor.json'].at}`,
  ];
  assert.equal(rows.length, want.length, r.stdout);
  want.forEach((w, i) => (w instanceof RegExp ? assert.match(rows[i], w) : assert.equal(rows[i], w)));

  const page = await tb('health', '--drills', '--limit', '2');
  assert.equal(page.stdout, ['drills[2]{at,name,ok,note}:', `  "${when('@-1d')}",kill-tbd,"true",tbd back in 3 s`, `  "${when('@-3d')}",restart,"false",run not resumed in 10 min`,
    `help: tb health --drills --limit 2 --cursor ${when('@-3d')}`, ''].join('\n'), 'the next page keeps the page size given');
  const last = await tb('health', '--drills', '--limit', '2', '--cursor', when('@-3d'));
  assert.equal(last.stdout, ['drills[2]{at,name,ok,note}:', `  "${when('@-12d')}",kill-claude,"true",run resumed in 40 s`, `  "${when('@-40d')}",kill-tbd,"true",tbd back in 4 s`, ''].join('\n'), 'the last page: no cursor help');
  for (const [args, msg] of /** @type {[string[], string][]} */ ([[['--days', '0'], 'error: --days must be a whole number from 1 to 365'], [['--drills', '--cursor', 'yesterday'], 'error: --cursor must be the time the help line names (ISO-8601 UTC)'],
    [['--limit', '2'], 'error: --days is for the targets; --limit and --cursor go with --drills']])) {
    const bad = await tb('health', ...args);
    assert.deepEqual([bad.code, bad.stdout.split('\n')[0]], [2, msg], args.join(' '));
  }
});

// M7 EG1: tb eval golden's harness spawns (sys.run) go through this preload: TB_HOME/spawn.json = [{exit, score?}] in run
// order; each call is logged to TB_HOME/spawn.jsonl; the --out evidence and (score) the --json file are written. No
// harness ever runs.
const SPY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-spy-'));
after(() => fs.rmSync(SPY_DIR, { recursive: true, force: true }));
const RUN_SPY = `--require ${path.join(SPY_DIR, 'run-spy.js')}`;
fs.writeFileSync(path.join(SPY_DIR, 'run-spy.js'), `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sys } = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli'))});
const home = process.env.TB_HOME;
const steps = JSON.parse(fs.readFileSync(path.join(home, 'spawn.json'), 'utf8'));
let n = 0;
sys.run = async (file, args, ms) => {
  fs.appendFileSync(path.join(home, 'spawn.jsonl'), JSON.stringify({ file, args, ms }) + '\\n');
  const s = steps[n++] ?? { exit: 9 };
  const at = (f) => args[args.indexOf(f) + 1];
  fs.writeFileSync(at('--out'), '# fake evidence\\n');
  if (s.score) fs.writeFileSync(at('--json'), JSON.stringify(s.score));
  return s.exit;
};
`);
const spawned = home => (fs.existsSync(path.join(home, 'spawn.jsonl')) ? fs.readFileSync(path.join(home, 'spawn.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const flagOf = (args, f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // tb's TB_TZ default
const BIN_296 = '/opt/x/claude-2.1.296';

test('EG1 eval golden --dry: golden-working, eval-planner, eval-phase review / qa / final_gate one at a time on fake claude, each pinned to its phase prompt, config claude_bin passed, evidence in TB_HOME/evals (0700), exit 0; one harness exit 1 → exit 1, its row shows it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eg1-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude_bin: BIN_296 }));
    const run = exits => {
      fs.writeFileSync(path.join(home, 'spawn.json'), JSON.stringify(exits.map(exit => ({ exit }))));
      fs.rmSync(path.join(home, 'spawn.jsonl'), { force: true });
      return runTb(['eval', 'golden', '--dry'], { tbHome: home, port: 1, home }, { NODE_OPTIONS: RUN_SPY }); // no tbd: --dry records nothing
    };
    const ok = await run([0, 0, 0, 0, 0]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    // m7-build.md M-B --dry: golden-working --dry --only B,C,C-empty --runs 1 (+ --stop close, fix 7), eval-planner --fake,
    // eval-phase --fake --phase review|qa|final_gate; --prompt <checkout>/phases/code/<phase>/prompt.md; --out under TB_HOME/evals
    const prompt = p => path.join(ROOT, 'phases', 'code', p, 'prompt.md');
    const out = s => path.join(home, 'evals', `${today()}-${s}-dry.md`);
    const phase = p => ['eval-phase.js', { '--fake': true, '--phase': p, '--prompt': prompt(p), '--out': out(p) }];
    const want = [['golden-working.js', { '--dry': true, '--only': 'B,C,C-empty', '--runs': '1', '--stop': 'close', '--prompt': prompt('working'), '--out': out('golden') }],
      ['eval-planner.js', { '--fake': true, '--prompt': prompt('planning'), '--out': out('planner') }], phase('review'), phase('qa'), phase('final_gate')];
    const runs = spawned(home);
    assert.equal(runs.length, 5);
    runs.forEach((x, i) => {
      const [script, flags] = /** @type {[string, Record<string, string | boolean>]} */ (want[i]);
      assert.deepEqual([x.file, x.args[0]], [process.execPath, path.join(ROOT, 'scripts', script)]);
      for (const [f, v] of Object.entries(flags)) assert.equal(v === true ? x.args.includes(f) : flagOf(x.args, f), v, `${script} ${f}`);
      assert.equal(flagOf(x.args, '--claude'), BIN_296, 'config claude_bin, never the harness default pin path');
      assert.equal(x.args.includes('--json'), false, 'dry: no score');
      assert.ok(x.ms > 0, 'a timeout');
    });
    assert.equal(fs.statSync(path.join(home, 'evals')).mode & 0o777, 0o700);
    assert.match(ok.stdout, /^evals\[5\]\{source,exit,evidence\}:$/m);
    assert.match(ok.stdout, /^dry: PASS \(5 of 5 exit 0\)$/m);
    const red = await run([0, 1, 0, 0, 0]);
    assert.equal(red.code, 1, red.stdout);
    assert.ok(red.stdout.includes(`  planner,1,~/evals/${today()}-planner-dry.md\n`), red.stdout);
    assert.match(red.stdout, /^dry: FAIL \(1 of 5 exit non-zero\)$/m);
    assert.equal(spawned(home).length, 5, 'a red harness does not stop the others');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('EG1 eval golden --real: without --yes → usage naming the cost, nothing spawned; --real --yes while tbd has a live run → the cost first, refused, exit 1, nothing spawned', async () => {
  const fake = http.createServer((req, res) => { // tbd stand-in (token x): one live run
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/whoami') return res.end(JSON.stringify({ mac: crypto.createHmac('sha256', 'x').update(String(u.searchParams.get('n'))).digest('hex') }));
    res.end(JSON.stringify({ reminders: [], flows: [], system: { runs: 1 } }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', () => resolve(undefined)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eg1r-'));
  try {
    for (const [f, v] of [['token', 'x'], ['config.json', JSON.stringify({ claude_bin: BIN_296 })], ['spawn.json', '[]']]) fs.writeFileSync(path.join(home, f), v);
    const port = /** @type {import('node:net').AddressInfo} */ (fake.address()).port;
    const tb = (...args) => runTb(['eval', 'golden', ...args], { tbHome: home, port, home }, { NODE_OPTIONS: RUN_SPY });
    const noYes = await tb('--real');
    assert.equal(noYes.code, 2, noYes.stdout);
    assert.match(noYes.stdout, /^error: --real costs usage: ~\$\d+ typical, ~\$\d+ worst for golden, planner, review, qa, final_gate .*; add --yes to run it$/m);
    const live = await tb('--real', '--yes');
    assert.equal(live.code, 1, live.stdout);
    assert.match(live.stdout, /^cost: ~\$\d+ typical, ~\$\d+ worst for golden, planner, review, qa, final_gate /);
    assert.match(live.stdout, /^error: refused: tbd has 1 live run\(s\); real evals wait for an idle board \(RAM\)$/m);
    assert.deepEqual(spawned(home), [], 'nothing spawned');
  } finally {
    fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('EG1 eval golden --real --yes: a case worse than its base runs once more with its --only; the rerun is recorded (rerun: true) even when lower; still worse → exit 1. --record posts a score file and prints tbd\'s verdict; worse → exit 1', async (t) => {
  const BASE = { t: 'golden', at: '2026-10-17T00:00:00.000Z', run_id: '11111111-1111-4111-8111-111111111111', commit: 'a'.repeat(40), mode: 'real',
    cases: [{ id: 'golden:B', pass: 8, total: 8, contaminated: false, blind: null }], pass: true, ok: null };
  const tbd = await startTbd({ files: { 'config.json': { claude_bin: FAKE }, 'evals/golden.jsonl': `${JSON.stringify(BASE)}\n` } });
  t.after(() => tbd.stop());
  // a score JSON v1 as scripts/harness.js scoreJson writes it (r-build.md frozen shape), one case golden:B with pass of 8 checks
  const score = pass => ({ v: 1, kind: 'golden-score', at: '2026-10-18T01:00:00.000Z', commit: 'c'.repeat(40), sandbox_base: 'b'.repeat(40), mode: 'real', sources: ['golden-working'],
    cases: [{ id: 'golden:B', run: 1, stop: 'final_gate:close', checks: { pass, total: 8 }, contaminated: false, fix_rounds: 0, rework: 0, cost_micro: 3_000_000, min: 20, blind: null }], pass: pass === 8 });
  const recordedLines = () => fs.readFileSync(path.join(tbd.tbHome, 'evals', 'golden.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  fs.writeFileSync(path.join(tbd.tbHome, 'spawn.json'), JSON.stringify([{ exit: 1, score: score(7) }, { exit: 1, score: score(6) }]));
  const r = await runTb(['eval', 'golden', '--real', '--yes', '--only', 'golden'], tbd, { NODE_OPTIONS: RUN_SPY });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const runs = spawned(tbd.tbHome);
  assert.equal(runs.length, 2, 'the worse case once more, not again');
  const ev = f => path.join(tbd.tbHome, 'evals', f);
  // m7-build.md M-B --real: --real --json <TB_HOME>/evals/<date>-<source>.json --out …md, its pinned prompt, config claude_bin
  assert.ok(runs[0].args.includes('--real') && runs[0].args.includes('--no-docker-reserve'), 'D-0174: the harness test tbd skips the Docker reserve');
  for (const [f, v] of Object.entries({ '--only': 'B,C', '--runs': '1', '--stop': 'close', '--claude': FAKE, '--prompt': path.join(ROOT, 'phases', 'code', 'working', 'prompt.md'),
    '--json': ev(`${today()}-golden.json`), '--out': ev(`${today()}-golden.md`) })) assert.equal(flagOf(runs[0].args, f), v, f);
  assert.deepEqual([flagOf(runs[1].args, '--only'), flagOf(runs[1].args, '--json')], ['B', ev(`${today()}-golden-rerun-B.json`)]);
  const line = recordedLines().at(-1);
  assert.deepEqual([line.cases, line.ok], [[{ id: 'golden:B', pass: 6, total: 8, contaminated: false, blind: null, rerun: true }], false], 'the rerun (6/8, lower than the first 7/8) is what counts');
  assert.match(r.stdout, /^verdict: FAIL · 0\/1 compared not worse · base 2026-10-17T00:00:00\.000Z\nworse\[1\]\{id,why\}:\n {2}"golden:B",fewer checks pass$/m);

  const file = path.join(tbd.tbHome, 'score.json');
  fs.writeFileSync(file, JSON.stringify(score(8)));
  const ok = await runTb(['eval', 'golden', '--record', file], tbd);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /^run_id: ([0-9a-f]{8}-[0-9a-f-]{27}) \(made here: .+score\.json has none\)\nrecorded: \1 · 1 cases · score pass\nverdict: PASS · 1\/1 compared not worse · base 2026-10-17T00:00:00\.000Z\n$/);
  assert.deepEqual(recordedLines().at(-1).cases, [{ id: 'golden:B', pass: 8, total: 8, contaminated: false, blind: null }]);
  fs.writeFileSync(file, JSON.stringify(score(7)));
  const worse = await runTb(['eval', 'golden', '--record', file], tbd);
  assert.equal(worse.code, 1, worse.stdout);
  assert.match(worse.stdout, /^verdict: FAIL · 0\/1 compared not worse · base /m);
});

// Review fix (MED): --real keeps the score + its run_id in TB_HOME/evals before the post (0600, never overwritten); a
// failed post names it for --record; --record keeps a file's run_id, so a repeat is tbd's 409 → "already recorded".
test('EG1 eval golden --real: the post fails → the score kept with its run_id (0600; a 2nd run -2) + help --record <file>, exit 1; --record of that file → 201, same run_id; again → 409 "already recorded", exit 1', async (t) => {
  const down = http.createServer((req, res) => { // tbd stand-in (token x): idle, POST /api/evals fails
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/whoami') return res.end(JSON.stringify({ mac: crypto.createHmac('sha256', 'x').update(String(u.searchParams.get('n'))).digest('hex') }));
    if (req.method === 'POST') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'internal error' })); }
    res.end(JSON.stringify({ reminders: [], flows: [], system: { runs: 0 } }));
  });
  await new Promise(resolve => down.listen(0, '127.0.0.1', () => resolve(undefined)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eg1p-'));
  t.after(() => { down.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const score = { v: 1, kind: 'golden-score', at: '2026-10-18T03:00:00.000Z', commit: 'c'.repeat(40), sandbox_base: 'b'.repeat(40), mode: 'real', sources: ['golden-working'],
    cases: [{ id: 'golden:B', run: 1, stop: 'final_gate:close', checks: { pass: 8, total: 8 }, contaminated: false, fix_rounds: 0, rework: 0, cost_micro: 3_000_000, min: 20, blind: null }], pass: true };
  for (const [f, v] of [['token', 'x'], ['config.json', JSON.stringify({ claude_bin: BIN_296 })], ['spawn.json', JSON.stringify([{ exit: 0, score }])]]) fs.writeFileSync(path.join(home, f), v);
  const port = /** @type {import('node:net').AddressInfo} */ (down.address()).port;
  const real = () => runTb(['eval', 'golden', '--real', '--yes', '--only', 'golden'], { tbHome: home, port, home }, { NODE_OPTIONS: RUN_SPY });
  const kept = path.join(home, 'evals', `${today()}-golden-score.json`);
  const r = await real();
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`\nerror: internal error\nhelp: tb eval golden --record ${kept.replace(/[.]/g, '\\.')}\n$`));
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  const body = JSON.parse(fs.readFileSync(kept, 'utf8'));
  assert.match(body.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([body.cases, body.mode, body.pass], [score.cases, 'real', true], 'the score as it was posted');
  fs.rmSync(path.join(home, 'spawn.jsonl'), { force: true });
  const again = await real();
  assert.ok(again.stdout.includes(`help: tb eval golden --record ${kept.replace(/\.json$/, '-2.json')}\n`), again.stdout);
  assert.notEqual(JSON.parse(fs.readFileSync(kept, 'utf8')).run_id, undefined, 'the first file kept as it was');
  assert.equal(JSON.parse(fs.readFileSync(kept, 'utf8')).run_id, body.run_id);

  const tbd = await startTbd();
  t.after(() => tbd.stop());
  const rec = await runTb(['eval', 'golden', '--record', kept], tbd);
  assert.equal(rec.code, 0, rec.stdout);
  assert.match(rec.stdout, new RegExp(`^recorded: ${body.run_id} · 1 cases · score pass\nverdict: baseline \\(nothing to compare yet\\)`), 'the file\'s own run_id, no new one');
  const dup = await runTb(['eval', 'golden', '--record', kept], tbd);
  assert.deepEqual([dup.code, dup.stdout], [1, `error: already recorded: run_id ${body.run_id}\n`]);
});

// Review fix: a harness past its time gets SIGINT, then (grace later) SIGKILL to its whole process group; a SIGINT
// ignorer and its child are gone when run() answers.
test('sys.run: past ms the harness gets SIGINT, grace later its whole group SIGKILL (a child of it too); exit 1', async (t) => {
  const { sys } = require('../lib/cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mark = path.join(dir, 'mark');
  const kid = path.join(dir, 'kid');
  const code = `const fs = require('node:fs'); const k = require('node:child_process').spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(kid)}, String(k.pid)); process.on('SIGINT', () => fs.appendFileSync(${JSON.stringify(mark)}, 'int\\n')); setInterval(() => {}, 1000);`;
  const exit = await sys.run(process.execPath, ['-e', code], 300, 300);
  assert.equal(exit, 1);
  assert.equal(fs.readFileSync(mark, 'utf8'), 'int\n', 'SIGINT first, once');
  const pid = Number(fs.readFileSync(kid, 'utf8'));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000, 'its child killed with the group');
});

// D-0177 (orchestrator, m7-build "the RERUN result is what gets recorded"): a harness exit ≠ 0 is covered when each of its
// worse cases was rerun with exit 0 and is worse no more; a crash (no score) is never covered. --real relieves the
// harness test tbds' RAM gate (D-0126, D-0141, D-0174): golden-working --no-docker-reserve, eval-phase --no-ram-wait.
test('EG1 eval golden --real --yes: a worse case whose rerun passes covers its harness\'s exit 1 → exit 0, recorded rerun: true; a harness that crashed (no score) → exit 1 with nothing to rerun; golden --no-docker-reserve, eval-phase --no-ram-wait', async (t) => {
  const BASE = { t: 'golden', at: '2026-10-17T00:00:00.000Z', run_id: '22222222-2222-4222-8222-222222222222', commit: 'a'.repeat(40), mode: 'real',
    cases: [{ id: 'golden:B', pass: 8, total: 8, contaminated: false, blind: null }], pass: true, ok: null };
  const tbd = await startTbd({ files: { 'config.json': { claude_bin: FAKE }, 'evals/golden.jsonl': `${JSON.stringify(BASE)}\n` } });
  t.after(() => tbd.stop());
  const one = (id, pass, total, source) => ({ v: 1, kind: 'golden-score', at: '2026-10-18T02:00:00.000Z', commit: 'c'.repeat(40), sandbox_base: 'b'.repeat(40), mode: 'real', sources: [source],
    cases: [{ id, run: 1, stop: 'qa', checks: { pass, total }, contaminated: false, fix_rounds: null, rework: null, cost_micro: 500_000, min: 4, blind: null }], pass: pass === total });
  const run = steps => {
    fs.writeFileSync(path.join(tbd.tbHome, 'spawn.json'), JSON.stringify(steps));
    fs.rmSync(path.join(tbd.tbHome, 'spawn.jsonl'), { force: true });
    return runTb(['eval', 'golden', '--real', '--yes', '--only', 'golden,review'], tbd, { NODE_OPTIONS: RUN_SPY });
  };
  const last = () => JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'evals', 'golden.jsonl'), 'utf8').trim().split('\n').at(-1));
  const golden = pass => one('golden:B', pass, 8, 'golden-working');
  const review = one('review:E1', 3, 3, 'eval-phase');

  const ok = await run([{ exit: 1, score: golden(7) }, { exit: 0, score: review }, { exit: 0, score: golden(8) }]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const runs = spawned(tbd.tbHome);
  assert.deepEqual(runs.map(x => [path.basename(x.args[0]), flagOf(x.args, '--only'), flagOf(x.args, '--phase')]), [['golden-working.js', 'B,C', undefined], ['eval-phase.js', undefined, 'review'], ['golden-working.js', 'B', undefined]]);
  assert.ok(runs[0].args.includes('--no-docker-reserve') && runs[2].args.includes('--no-docker-reserve'), 'golden-working: no Docker reserve, rerun too');
  assert.ok(runs[1].args.includes('--real') && runs[1].args.includes('--no-ram-wait'), 'eval-phase: no RAM wait');
  assert.deepEqual([last().cases, last().ok], [[{ id: 'golden:B', pass: 8, total: 8, contaminated: false, blind: null, rerun: true }, { id: 'review:E1', pass: 3, total: 3, contaminated: false, blind: null }], true]);
  assert.match(ok.stdout, /^ {2}golden,1,.+\n {2}review,0,.+\n {2}golden rerun B,0,/m, 'the first exit 1 stays on screen');
  assert.match(ok.stdout, /^verdict: PASS · 1\/1 compared not worse · base 2026-10-17T00:00:00\.000Z$/m);

  const crash = await run([{ exit: 0, score: golden(8) }, { exit: 1 }]);
  assert.equal(crash.code, 1, crash.stdout);
  assert.equal(spawned(tbd.tbHome).length, 2, 'nothing worse: no rerun');
  assert.match(crash.stdout, /^warn: review: score not used: no score file$/m);
  assert.match(crash.stdout, /^verdict: PASS · 1\/1 compared not worse · /m, 'the verdict alone passes; the crash makes exit 1');
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
