'use strict';
// P1 AC3: fsm table = spec §4 + plan §3b rows; every other (from, to, actor) refused; brainstorm skips qa;
// `tb pass` rows refused while the phase is built. In-process (pure check + real store on a temp TB_HOME).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { phaseFixture, PHASE_FILES } = require('./helpers/tbd');

// Env before any lib require: phases scans at load, store reads TB_HOME at load (AC10: never the real home).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-'));
process.env.HOME = path.join(root, 'home');
process.env.TB_HOME = path.join(root, 'tbhome');
process.env.TB_PHASES_DIR = phaseFixture(path.join(root, 'phases'), {
  'code/working': PHASE_FILES, 'code/review': PHASE_FILES, 'code/final_gate': PHASE_FILES,
});
fs.mkdirSync(process.env.HOME);
const phases = require('../lib/phases');
for (const key of ['code/working', 'code/review', 'code/final_gate']) phases.registerHandler(key, async () => {});
const fsm = require('../lib/fsm');
const store = require('../lib/store');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const KINDS = ['code', 'research', 'brainstorm', 'design'];
const ACTIVE = ['backlog', 'planning', 'clarify', 'plan_approval', 'working', 'review', 'qa', 'final_gate'];
const PHASES = ['planning', 'working', 'review', 'qa', 'final_gate'];
// Spec §4 + plan §3b written out by hand (not derived from fsm.TABLE). Value: '*' every kind,
// 'qa' every kind but brainstorm, 'bs' brainstorm only.
const SPEC = {
  'backlog>planning:you': '*',
  'planning>clarify:runner': '*',
  'clarify>planning:you': '*',
  'planning>plan_approval:runner': '*',
  'plan_approval>working:you': '*',
  'plan_approval>planning:you': '*',
  'working>clarify:runner': '*',
  'clarify>working:you': '*',
  // full-access-runs Phase 5 (contract change): review, qa and final_gate ask; the answer resumes the asking session
  'review>clarify:runner': '*',
  'qa>clarify:runner': 'qa',
  'final_gate>clarify:runner': '*',
  'clarify>review:you': '*',
  'clarify>qa:you': 'qa',
  'clarify>final_gate:you': '*',
  'working>review:runner': '*',
  'review>qa:runner': 'qa',
  'review>final_gate:runner': 'bs',
  'qa>final_gate:runner': 'qa',
  'final_gate>done:runner': '*',
  'review>working:runner': '*',
  'qa>working:runner': 'qa',
  'final_gate>working:runner': '*',
  'review>qa:you': 'qa',
  'review>final_gate:you': 'bs',
  'qa>final_gate:you': 'qa',
  'final_gate>done:you': '*',
  // P5 K1 (contract change, §3b delta): `tb rework` while review / qa / final_gate is unbuilt
  'review>working:you': '*',
  'qa>working:you': 'qa',
  'final_gate>working:you': '*',
  // M5.5 X11 (C19): a lane ticket ends by the runner (guard lane; done also lane_merged)
  'working>done:runner': '*',
  'working>cancelled:runner': '*',
  'clarify>cancelled:runner': '*',
  'blocked>cancelled:runner': '*',
};
for (const s of ACTIVE) SPEC[`${s}>blocked:runner`] = '*';
for (const p of PHASES) SPEC[`blocked>${p}:you`] = p === 'qa' ? 'qa' : '*';
for (const s of [...ACTIVE, 'blocked']) SPEC[`${s}>cancelled:you`] = '*';
const allows = (key, kind) => SPEC[key] === '*' || (SPEC[key] === 'qa' && kind !== 'brainstorm') || (SPEC[key] === 'bs' && kind === 'brainstorm');

const guardsOf = (row) => [].concat(row.guard ?? []);
const yes = Object.fromEntries(fsm.TABLE.flatMap(guardsOf).map((g) => [g, () => true]));
const ticket = (state, kind = 'code', extra = {}) => ({ id: 't_test01', state, kind, blocked_from: 'final_gate', ...extra });

test('AC3 every table row is allowed when its guards pass, refused when one fails or is missing', () => {
  for (const r of fsm.TABLE) {
    const key = `${r.from}>${r.to}:${r.by}`;
    for (const kind of r.kinds ?? KINDS) {
      assert.ok(allows(key, kind), `row ${key} (${kind}) is not in spec §4/§3b`);
      const ok = Object.fromEntries(guardsOf(r).map((g) => [g, () => true]));
      assert.deepEqual(fsm.check(ticket(r.from, kind), r.to, r.by, ok), { ok: true }, `${key} ${kind}`);
      for (const g of guardsOf(r)) {
        // clarify → planning has two rows (OR): the other row's guard is absent here, so match, not equal
        const nope = fsm.check(ticket(r.from, kind), r.to, r.by, { ...ok, [g]: () => 'nope' });
        assert.equal(nope.ok, false);
        assert.match(nope.reason, /(^|; )nope(;|$)/);
        assert.equal(fsm.check(ticket(r.from, kind), r.to, r.by, { ...ok, [g]: () => false }).ok, false);
        const { [g]: _, ...missing } = ok;
        assert.match(fsm.check(ticket(r.from, kind), r.to, r.by, missing).reason, new RegExp(`guard ${g} unavailable`));
      }
    }
  }
});

test('AC3 every (from, to, actor, kind) outside the spec is refused; every one inside is allowed', () => {
  let allowed = 0;
  for (const from of fsm.STATES) for (const to of fsm.STATES) for (const by of ['you', 'runner']) for (const kind of KINDS) {
    const res = fsm.check(ticket(from, kind), to, by, yes);
    assert.equal(res.ok, allows(`${from}>${to}:${by}`, kind), `${from} → ${to} by ${by} (${kind}): ${res.reason}`);
    if (res.ok) allowed++;
    else if (!SPEC[`${from}>${to}:${by}`]) assert.match(res.reason, /is not allowed for/);
  }
  assert.ok(allowed > 100, 'sanity: the spec rows were exercised');
});

test('AC3 brainstorm skips qa: review → final_gate allowed, review → qa refused', () => {
  assert.deepEqual(fsm.check(ticket('review', 'brainstorm'), 'final_gate', 'runner', yes), { ok: true });
  assert.equal(fsm.check(ticket('review', 'brainstorm'), 'qa', 'runner', yes).ok, false);
  assert.equal(fsm.check(ticket('review', 'brainstorm'), 'qa', 'you', yes).ok, false);
  assert.equal(fsm.check(ticket('blocked', 'brainstorm'), 'qa', 'you', yes).ok, false);
  assert.equal(fsm.check(ticket('review', 'code'), 'final_gate', 'runner', yes).ok, false, 'code still needs qa');
});

test('AC3 tb pass rows: refused while the phase is built, allowed while unbuilt (real phases registry)', () => {
  const g = fsm.GUARDS;
  assert.match(fsm.check(ticket('review', 'code'), 'qa', 'you', g).reason, /code\/review is built/);
  assert.deepEqual(fsm.check(ticket('review', 'research'), 'qa', 'you', g), { ok: true });
  assert.deepEqual(fsm.check(ticket('qa', 'code'), 'final_gate', 'you', g), { ok: true });
  assert.deepEqual(fsm.check(ticket('review', 'brainstorm'), 'final_gate', 'you', g), { ok: true });
  // final pass also needs --sha on main (P5 injects sha_on_main): missing guard denies
  assert.equal(fsm.check(ticket('final_gate', 'research'), 'done', 'you', g).reason, 'guard sha_on_main unavailable');
  assert.deepEqual(fsm.check(ticket('final_gate', 'research'), 'done', 'you', { ...g, sha_on_main: () => true }), { ok: true });
  assert.match(fsm.check(ticket('final_gate', 'code'), 'done', 'you', { ...g, sha_on_main: () => true }).reason, /^not ready to close/);
});

// M5 C13: tb close (close_ok + children_done) and rework at close (close_rework G7 + rework_ok); code/final_gate is built
// in this fixture, so the D9 rows (phase_unbuilt) refuse beside them
test('M5 C13 close: waiting close + final.sha + children done; rework at close: waiting close + every child (ticketOf) and dependent (dependentsOf) in backlog or cancelled', () => {
  const kids = { t_kid001: 'backlog', t_kid002: 'cancelled', t_kid003: 'planning', t_kid004: 'done' };
  const deps = (...list) => () => list; // ctx.dependentsOf(id) → tickets
  const ctx = { ...fsm.GUARDS, ticketOf: (id) => (kids[id] ? { state: kids[id] } : null), dependentsOf: deps(), rework_ok: () => true };
  const close = (extra = {}) => ticket('final_gate', 'code', { waiting: { reason: 'close' }, final: { sha: 'a'.repeat(40) }, ...extra });
  assert.deepEqual(fsm.check(close({ children: ['t_kid002', 't_kid004'] }), 'done', 'you', ctx), { ok: true });
  assert.match(fsm.check(close({ final: {} }), 'done', 'you', ctx).reason, /not ready to close/);
  assert.match(fsm.check(close({ waiting: null }), 'done', 'you', ctx).reason, /not ready to close/);
  assert.match(fsm.check(close({ children: ['t_kid001'] }), 'done', 'you', ctx).reason, /waits for its children: 0\/1/);
  assert.deepEqual(fsm.check(close({ children: ['t_kid001', 't_kid002'] }), 'working', 'you', { ...ctx, dependentsOf: deps({ state: 'cancelled' }) }), { ok: true });
  for (const c of ['t_kid003', 't_kid004', 't_gone01']) assert.match(fsm.check(close({ children: ['t_kid001', c] }), 'working', 'you', ctx).reason, /cancel children first/, c);
  assert.match(fsm.check(close(), 'working', 'you', { ...ctx, dependentsOf: deps({ state: 'backlog' }, { state: 'working' }) }).reason, /cancel children first/);
  assert.match(fsm.check(close(), 'working', 'you', { ...ctx, dependentsOf: undefined }).reason, /cancel children first/, 'no dependentsOf: refused');
  assert.match(fsm.check(close({ waiting: null }), 'working', 'you', ctx).reason, /only while it waits for close/);
  assert.match(fsm.check(close(), 'working', 'you', { ...ctx, rework_ok: () => 'rework > 2' }).reason, /rework > 2/);
  // the D9 pass of a non-code final gate is untouched (the close rows are code only)
  assert.equal(fsm.check(ticket('final_gate', 'research', { waiting: { reason: 'close' }, final: { sha: 'a'.repeat(40) } }), 'done', 'you', fsm.GUARDS).reason, 'guard sha_on_main unavailable');
});

// M5.5 X11 P8: a lane's end is the runner's row: cancelled from working / clarify / blocked, done once the parent's task
// is done (ctx.ticketOf); never for a ticket that is not a lane
test('M5.5 X11 P8 lane rows: runner cancels a lane from working, clarify, blocked; done needs its task done in the parent; a non-lane gets neither', () => {
  const lane = (state) => ticket(state, 'code', { lane_of: { id: 't_par001', task: 'T2' } });
  const parent = (status) => ({ t_par001: { work: { tasks: [{ id: 'T1', status: 'done' }, { id: 'T2', status }] } } });
  const ctx = (status) => ({ ...fsm.GUARDS, ticketOf: (id) => parent(status)[id] ?? null });
  for (const s of ['working', 'clarify', 'blocked']) {
    assert.deepEqual(fsm.check(lane(s), 'cancelled', 'runner', fsm.GUARDS), { ok: true }, s);
    assert.equal(fsm.check(ticket(s), 'cancelled', 'runner', fsm.GUARDS).reason, 'not a lane', s);
  }
  assert.deepEqual(fsm.check(lane('working'), 'done', 'runner', ctx('done')), { ok: true });
  assert.match(fsm.check(lane('working'), 'done', 'runner', ctx('pending')).reason, /T2 is not merged into t_par001/);
  assert.match(fsm.check(lane('working'), 'done', 'runner', { ...fsm.GUARDS, ticketOf: () => null }).reason, /not merged/, 'parent missing: open');
  assert.equal(fsm.check(ticket('working'), 'done', 'runner', ctx('done')).reason, 'not a lane');
});

test('AC3 resume goes only to phases up to where the ticket blocked', () => {
  const g = fsm.GUARDS;
  assert.deepEqual(fsm.check(ticket('blocked', 'code', { blocked_from: 'working' }), 'planning', 'you', g), { ok: true });
  assert.deepEqual(fsm.check(ticket('blocked', 'code', { blocked_from: 'working' }), 'working', 'you', g), { ok: true });
  assert.equal(fsm.check(ticket('blocked', 'code', { blocked_from: 'working' }), 'review', 'you', g).reason, 'resume only up to working');
  assert.deepEqual(fsm.check(ticket('blocked', 'code', { blocked_from: 'clarify' }), 'planning', 'you', g), { ok: true });
  assert.equal(fsm.check(ticket('blocked', 'code', { blocked_from: 'clarify' }), 'working', 'you', g).ok, false);
});

test('AC3 transition() saves via store: state + event line + blocked_from; a refusal changes nothing', async () => {
  store.init();
  const t = await store.createFlow({ text: 'fsm transition test', kind: 'code' });
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME, 'tickets', t.id, 'ticket.json'), 'utf8'));
  const lastEvent = () => JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME, 'tickets', t.id, 'events.jsonl'), 'utf8').trim().split('\n').at(-1));

  assert.equal((await fsm.transition(store, t.id, 'planning', 'you', { assign: () => true })).state, 'planning');
  assert.equal(onDisk().state, 'planning');
  assert.deepEqual({ ...lastEvent(), t: undefined }, { t: undefined, kind: 'transition', id: t.id, from: 'backlog', to: 'planning' });

  await assert.rejects(fsm.transition(store, t.id, 'review', 'runner'), { status: 409, message: 'planning → review is not allowed for runner' });
  await assert.rejects(fsm.transition(store, t.id, 'plan_approval', 'runner'), { status: 409, message: 'guard plan_valid unavailable' });
  assert.equal(onDisk().state, 'planning');
  assert.equal(store.getTicket(t.id).state, 'planning');

  assert.equal((await fsm.transition(store, t.id, 'blocked', 'runner')).blocked_from, 'planning');
  await assert.rejects(fsm.transition(store, t.id, 'working', 'you'), { status: 409, message: 'resume only up to planning' });
  assert.equal((await fsm.transition(store, t.id, 'planning', 'you')).state, 'planning');
  assert.equal(onDisk().state, 'planning');
});

// P3a: the runner sets ticket.waiting (D9 manual, admission reasons); a wait belongs to its state
test('P3a a state change clears waiting (a cancelled ticket never re-pings a stale wait); an update in place keeps it', async () => {
  const t = await store.createFlow({ text: 'stale wait', kind: 'code' });
  const w = { reason: 'manual', since: '2026-10-08T00:00:00.000Z' };
  await store.updateTicket(t.id, (k) => ({ ...k, state: 'review', waiting: w }));
  assert.deepEqual((await store.updateTicket(t.id, (k) => ({ ...k, title: 'renamed' }))).waiting, w);
  assert.equal((await fsm.transition(store, t.id, 'cancelled', 'you')).waiting, null);
});

// M5 C15: store.dependentsOf(id) = the tickets built on id's squash (parent or blocked_by), what close_rework reads
test('M5 C13 C15 rework at close with the store\'s dependentsOf: a cancelled ticket blocked by it → allowed; once one blocked by it started → cancel children first', async () => {
  const p = await store.createFlow({ text: 'close rework parent', kind: 'code' });
  const b = await store.createFlow({ text: 'blocked by the parent', kind: 'code' });
  await store.createFlow({ text: 'unrelated, started', kind: 'code' }).then((o) => store.updateTicket(o.id, (k) => ({ ...k, state: 'working' })));
  await store.updateTicket(b.id, (k) => ({ ...k, state: 'cancelled', blocked_by: [p.id] }));
  const at = await store.updateTicket(p.id, (k) => ({ ...k, state: 'final_gate', waiting: { reason: 'close' }, final: { sha: 'a'.repeat(40) } }));
  const ctx = { ...fsm.GUARDS, ticketOf: store.getTicket, dependentsOf: store.dependentsOf, rework_ok: () => true };
  assert.deepEqual(store.dependentsOf(p.id).map((k) => k.id), [b.id]);
  assert.deepEqual(fsm.check(at, 'working', 'you', ctx), { ok: true });
  await store.updateTicket(b.id, (k) => ({ ...k, state: 'working' }));
  assert.match(fsm.check(at, 'working', 'you', ctx).reason, /cancel children first/);
});

// A10; M5 C4 (contract change: Resume also resets the fix counter) + C1 (a replan drops the review rounds)
test('A10 + M5 C4 resume from blocked resets rework and fixes to 0 and clears blocked_from; blocking alone keeps both; a move to planning drops review', async () => {
  const t = await store.createFlow({ text: 'resume resets rework', kind: 'code' });
  const review = { n: 2, head: 'a'.repeat(40), open: ['F1'] };
  await store.updateTicket(t.id, (k) => ({ ...k, state: 'working', rework: 2, fixes: 3, review }));
  const blocked = await fsm.transition(store, t.id, 'blocked', 'runner');
  assert.deepEqual([blocked.rework, blocked.fixes, blocked.blocked_from], [2, 3, 'working']);
  const resumed = await fsm.transition(store, t.id, 'working', 'you');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME, 'tickets', t.id, 'ticket.json'), 'utf8'));
  for (const k of [resumed, onDisk]) assert.deepEqual([k.state, k.rework, k.fixes, 'blocked_from' in k, k.review], ['working', 0, 0, false, review]);
  await fsm.transition(store, t.id, 'blocked', 'runner');
  assert.equal('review' in (await fsm.transition(store, t.id, 'planning', 'you')), false, 'a replan starts its review rounds afresh');
  await store.releasePid();
});

// full-access-runs Phase 5: t.asks counts per phase visit; t.continue (the answers for the asking session) lives through
// clarify → its phase and a Blocked between, never into another phase. Review of f1814d1 (contract change; was: a phase
// left for anything but clarify drops its count): a visit starts when the phase is entered from anything but clarify,
// and a clarify that leaves for any state but its origin ends the origin's visit
test('Phase 5 move: asks kept through ask + answer, reset when the phase is entered from elsewhere (Resume too) or its clarify leaves elsewhere; t.continue kept to its phase and Blocked, dropped elsewhere', () => {
  const g = { questions: () => true, no_blocking: () => true, answer_added: () => true, working_gate: () => true };
  const t = ticket('review', 'code', { asks: { review: 2, qa: 1 } });
  assert.deepEqual(fsm.move(t, 'clarify', 'runner', g).asks, { review: 2, qa: 1 });
  const q = ticket('clarify', 'code', { asks: { review: 2, qa: 1 }, clarify_origin: { phase: 'review' } });
  assert.deepEqual(fsm.move(q, 'review', 'you', g).asks, { review: 2, qa: 1 }, 'the answer: the same visit');
  assert.deepEqual(fsm.move(q, 'blocked', 'runner').asks, { qa: 1 }, 'its clarify left elsewhere: the visit ended');
  assert.deepEqual(fsm.move(t, 'qa', 'runner', g).asks, { review: 2 }, 'qa entered from review: a new qa visit');
  assert.deepEqual(fsm.move({ ...t, state: 'blocked', blocked_from: 'review' }, 'review', 'you', fsm.GUARDS).asks, { qa: 1 }, 'a Resume starts a new visit');
  assert.deepEqual(fsm.move({ ...t, state: 'working' }, 'review', 'runner', g).asks, { qa: 1 });
  const cont = { phase: 'review', session: 's', round: 2, gen: 3 };
  const c = ticket('clarify', 'code', { continue: cont });
  assert.deepEqual(fsm.move(c, 'review', 'you', g).continue, cont);
  assert.deepEqual(fsm.move({ ...c, state: 'review' }, 'blocked', 'runner').continue, cont);
  assert.deepEqual(fsm.move({ ...c, state: 'blocked', blocked_from: 'review' }, 'review', 'you', fsm.GUARDS).continue, cont);
  assert.equal(fsm.move({ ...c, state: 'review' }, 'qa', 'runner', g).continue, undefined);
  assert.equal(fsm.move({ ...c, state: 'blocked', blocked_from: 'review' }, 'working', 'you', fsm.GUARDS).continue, undefined, 'a Resume to an earlier phase drops it');
});
