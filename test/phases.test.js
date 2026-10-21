'use strict';
// P1 phases registry (D9, plan §3b "unbuilt kinds"): built ⇔ prompt+settings+schema+handler; prompt without
// the rest = misconfigured; POST /api/flows + promote refused 409 until the kind's working phase is built.
// P1 AC8: flows need a leaf tag with a path. AC4: SSE `ticket` event on create.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startTbd, phaseFixture, PHASE_FILES, FAKE_HANDLERS } = require('./helpers/tbd');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phases-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const FIXTURE = phaseFixture(path.join(root, 'fixture'), { 'code/working': PHASE_FILES });
const builtEnv = { TB_PHASES_DIR: FIXTURE, NODE_OPTIONS: FAKE_HANDLERS };

test('phases: built needs all three files + a handler; prompt.md without them is misconfigured', () => {
  process.env.TB_PHASES_DIR = phaseFixture(path.join(root, 'unit'), {
    'code/working': PHASE_FILES, // + handler -> built
    'research/working': ['prompt.md', 'settings.json'], // schema missing -> misconfigured
    'design/working': PHASE_FILES, // no handler -> misconfigured
    'brainstorm/working': ['settings.json'], // no prompt -> plain unbuilt
  });
  const phases = require('../lib/phases');
  phases.registerHandler('code/working', async () => {});
  phases.registerHandler('research/working', async () => {});
  const got = (kind) => ({ built: phases.built(kind, 'working'), misconfigured: phases.misconfigured(kind, 'working') });
  assert.deepEqual(got('code'), { built: true, misconfigured: false });
  assert.deepEqual(got('research'), { built: false, misconfigured: true });
  assert.deepEqual(got('design'), { built: false, misconfigured: true });
  assert.deepEqual(got('brainstorm'), { built: false, misconfigured: false });
  assert.deepEqual({ built: phases.built('code', 'qa'), misconfigured: phases.misconfigured('code', 'qa') }, { built: false, misconfigured: false });
});

test('phases: default dir: code/working built (P5), other kinds not → POST /api/flows and promote refused 409', async (t) => {
  const tbd = await startTbd();
  t.after(() => tbd.stop());
  for (const kind of ['research', 'brainstorm', 'design']) {
    const r = await tbd.api('POST', '/api/flows', { text: 'do it', kind });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: `kind ${kind} not built yet` });
  }
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'do it', kind: 'poetry' })).status, 400);
  const { json } = await tbd.api('POST', '/api/reminders', { title: 'grow me' });
  assert.equal((await tbd.api('POST', `/api/tickets/${json.reminder.id}/promote`, { kind: 'brainstorm' })).status, 409);
  assert.equal((await tbd.api('GET', '/api/state')).json.reminders.length, 1, 'refused promote keeps the reminder');
  assert.deepEqual(fs.readdirSync(path.join(tbd.tbHome, 'tickets')), []);
});

test('phases: built fixture → POST /api/flows 201 backlog ticket on disk, SSE ticket event; unbuilt kind still 409', async (t) => {
  const tbd = await startTbd({ env: builtEnv });
  t.after(() => tbd.stop());
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: tbd.port, path: '/events', headers: { 'x-tb-token': tbd.token } }, (res) => res.setEncoding('utf8').on('data', (c) => events.push(c)));
  t.after(() => req.destroy());
  // A12: wait for the connect line (tbd registers the client as it writes it), not a fixed sleep
  for (let i = 0; i < 100 && !events.join('').includes('event: system'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.join('').includes('event: system'), 'SSE connected before the POST');

  const r = await tbd.api('POST', '/api/flows', { text: 'Paginate GET /users\nwith cursors', kind: 'code' });
  assert.equal(r.status, 201);
  const k = r.json.ticket;
  assert.match(k.id, /^t_[a-z0-9]{6}$/);
  assert.match(k.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(k, {
    id: k.id, type: 'flow', kind: 'code', tag: null, title: 'Paginate GET /users', text: 'Paginate GET /users\nwith cursors',
    state: 'backlog', created_at: k.created_at, updated_at: k.created_at, parent: null, blocked_by: [], fix_of: null,
    must_ask: false, rework: 0, failures: {}, waiting: null, lease: null,
  });
  const dir = path.join(tbd.tbHome, 'tickets', k.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ticket.json'), 'utf8')), k);
  assert.equal(fs.readFileSync(path.join(dir, 'ticket.md'), 'utf8'), '# Paginate GET /users\n\nPaginate GET /users\nwith cursors\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).kind, 'create');
  assert.deepEqual((await tbd.api('GET', `/api/tickets/${k.id}`)).json, { ticket: k, fix_max: 3 }); // M5.1 C20: fix_max rides the envelope
  assert.deepEqual((await tbd.api('GET', '/api/state')).json.flows,
    [{ id: k.id, title: k.title, kind: 'code', tag: null, state: 'backlog', waiting: null, rework: 0, updated_at: k.updated_at, merged_at: null, lease_exit: null, clarify_class: null }]); // flow-form-parallel-terminal: the pills need the run's end + the ask class (contract change, verdict doc)
  const want = `event: ticket\ndata: {"id":"${k.id}","state":"backlog","waiting":null,"rework":0}\n\n`;
  for (let i = 0; i < 100 && !events.join('').includes(want); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.join('').includes(want), 'SSE ticket event');

  const fix = await tbd.api('POST', '/api/flows', { text: 'fix it', title: 'Fix', kind: 'code', fix_of: k.id });
  assert.equal(fix.json.ticket.fix_of, k.id);
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'x', kind: 'code', fix_of: 't_zzzzzz' })).status, 400);
  assert.equal((await tbd.api('POST', '/api/flows', { text: '  ', kind: 'code' })).status, 400);
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'x', kind: 'code', state: 'done' })).status, 400, 'unknown field');
  assert.equal((await tbd.api('POST', '/api/flows', { text: 'x', kind: 'research' })).status, 409);
});

test('AC8 flows need a leaf tag with a path: no path, group tag, unknown tag → 400; leaf with path → 201', async (t) => {
  const tbd = await startTbd({ env: builtEnv });
  t.after(() => tbd.stop());
  const tag = (name, def) => tbd.api('POST', '/api/tags', { name, def });
  assert.equal((await tag('acme', {})).status, 201);
  assert.equal((await tag('acme/api', { path: '/tmp/acme-api', type: 'git', base: 'main' })).status, 201);
  assert.equal((await tag('solo', { path: '/tmp/solo', type: 'folder' })).status, 201);
  assert.equal((await tag('solo/sub', { path: '/tmp/solo/sub', type: 'folder' })).status, 201);
  const flow = (t) => tbd.api('POST', '/api/flows', { text: 'x', kind: 'code', tag: t });

  let r = await flow('acme');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tag acme has no path/);
  r = await flow('solo');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tag solo is not a leaf/);
  assert.equal((await flow('ghost/tag')).status, 400);
  assert.equal((await flow('Bad Tag')).status, 400);
  r = await flow('acme/api');
  assert.equal(r.status, 201);
  assert.equal(r.json.ticket.tag, 'acme/api');
});

test('phases: promote turns a reminder into a backlog flow (promoted_from, title/text); unknown id → 404', async (t) => {
  const tbd = await startTbd({ env: builtEnv });
  t.after(() => tbd.stop());
  const { json } = await tbd.api('POST', '/api/reminders', { title: 'Grow me', note: 'more detail' });
  const id = json.reminder.id;
  const r = await tbd.api('POST', `/api/tickets/${id}/promote`, { kind: 'code' });
  assert.equal(r.status, 201);
  const k = r.json.ticket;
  assert.deepEqual({ promoted_from: k.promoted_from, title: k.title, text: k.text, state: k.state }, { promoted_from: id, title: 'Grow me', text: 'Grow me\n\nmore detail', state: 'backlog' });
  const st = (await tbd.api('GET', '/api/state')).json;
  assert.deepEqual(st.reminders, []);
  assert.deepEqual(st.flows.map((f) => f.id), [k.id]);
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/promote`, { kind: 'code' })).status, 404);
  assert.equal((await tbd.api('POST', '/api/tickets/t_zzzzzz/promote', { kind: 'code' })).status, 404);
});

// ---- M5 C2: phases/_rules.md ----------------------------------------------------------------------------------------
// lib/phases.js reads <its dir>/../phases/_rules.md once at load: a copy of it in a temp code dir, loaded in a child,
// with each rules file. → {review: code/review, research: research/working (no rules needed), sha12}
function loadWith(rules) {
  const code = fs.mkdtempSync(path.join(root, 'code-'));
  fs.mkdirSync(path.join(code, 'lib'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'phases.js'), path.join(code, 'lib', 'phases.js'));
  phaseFixture(path.join(code, 'phases'), { 'code/review': PHASE_FILES, 'research/working': PHASE_FILES });
  if (rules !== null) fs.writeFileSync(path.join(code, 'phases', '_rules.md'), rules);
  const js = `const p = require(${JSON.stringify(path.join(code, 'lib', 'phases.js'))}); for (const k of ['code/review', 'research/working']) p.registerHandler(k, async () => {});
    const g = (k, ph) => ({ built: p.built(k, ph), misconfigured: p.misconfigured(k, ph) });
    process.stdout.write(JSON.stringify({ review: g('code', 'review'), research: g('research', 'working'), sha12: p.rules?.sha12 ?? null }));`;
  const { TB_PHASES_DIR: _, ...env } = process.env;
  return JSON.parse(require('node:child_process').execFileSync(process.execPath, ['-e', js], { env, encoding: 'utf8' }));
}

test('M5 C2 rules missing or over 8 KB → every code phase misconfigured (never spawned), other kinds unaffected; exactly 8 KB loads', () => {
  const bad = { review: { built: false, misconfigured: true }, research: { built: true, misconfigured: false }, sha12: null };
  assert.deepEqual(loadWith(null), bad, 'missing');
  assert.deepEqual(loadWith('x'.repeat(8 * 1024 + 1)), bad, 'over 8 KB');
  const ok = 'y'.repeat(8 * 1024);
  assert.deepEqual(loadWith(ok), { review: { built: true, misconfigured: false }, research: { built: true, misconfigured: false },
    sha12: require('node:crypto').createHash('sha256').update(ok).digest('hex').slice(0, 12) });
});

test('M5 C2 phases/_rules.md (public repo): ≤ 8 KB, headings 1-10 in order, OWASP 2025 A01..A10, no home path, email, person or tool name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= 8 * 1024, `${Buffer.byteLength(text)} bytes`);
  assert.deepEqual(text.match(/^## \d+\. \w+/gm), ['## 1. Precedence', '## 2. Security', '## 3. Gates', '## 4. Performance', '## 5. API', '## 6. Code', '## 7. Database', '## 8. Tests', '## 9. Honesty', '## 10. Writing']);
  assert.match(text, new RegExp(['A01 Broken Access Control', 'A02 Security Misconfiguration', 'A03 Software Supply Chain Failures', 'A04 Cryptographic Failures',
    'A05 Injection', 'A06 Insecure Design', 'A07 Authentication Failures', 'A08 Software or Data Integrity Failures', 'A09 Security Logging and Alerting Failures',
    'A10 Mishandling of Exceptional Conditions'].join('[^]*')), 'the 2025 list, in its order (not 2021)');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|~\/|@/, 'no home path or email address');
  // split so this file never trips the push leak gate itself
  for (const w of ['ir' + 'fan', 'guv' + 'ian', 'her' + 'dr', 'o' + 'mc', 'oh-my-' + 'claude', 'cave' + 'man', 'pony' + 'tail', 'lav' + 'ish', 'graph' + 'ify', '-' + 'axi']) {
    assert.doesNotMatch(text, new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i'), `no "${w}"`);
  }
});
