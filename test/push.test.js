'use strict';
// M5.3 C14 F5 `tb push` (lib/push.js): real git, the real scripts/leak-check (temp denylist: TB_DENYLIST), a temp bare
// repo per tag as its file:// push remote (TB_PUSH_FILE_OK=1, read at load). Each squash is a real commit made with the
// tag ident (commit-tree; lane A's squash is not needed). In-process on a real store (temp TB_HOME, no runner: a ticket
// at waiting close stays there); the route + `tb push` through a real tbd at the end.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ticket, lines, until } = require('./helpers/runs');
const { startTbd, runTb } = require('./helpers/tbd');

// Env before any lib require: store + metrics read TB_HOME at load, push reads TB_PUSH_FILE_OK at load.
const ROOT = fs.realpathSync(fs.mkdtempSync('/private/tmp/tbe-push-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const TB_HOME = path.join(ROOT, 'tbhome');
const DENY = path.join(ROOT, 'deny.txt');
Object.assign(process.env, { HOME: path.join(ROOT, 'home'), TB_HOME, TB_PUSH_FILE_OK: '1', TB_DENYLIST: DENY });
fs.mkdirSync(process.env.HOME);
fs.mkdirSync(path.join(TB_HOME, 'tickets'), { recursive: true });
const WORD = 'zebracorp'; // a made-up denylist word
fs.writeFileSync(DENY, `# test\n${WORD}\n`);

const IDENT = { name: 'Pat Dev', email: 'pat@example.invalid' };
const AGENT = { name: 'Some Agent', email: 'agent@example.invalid' };
const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, who = IDENT) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...gitEnv, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
}).trim();

// A tag repo: base on main, pushed to a bare repo, remote `mirror` = file://<bare>. squash(w, msg, parent) = one commit.
function world(name) {
  const repo = path.join(ROOT, name), bare = path.join(ROOT, `${name}.git`);
  git(ROOT, ['init', '-q', '--bare', bare]);
  git(ROOT, ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['remote', 'add', 'mirror', `file://${bare}`]);
  git(repo, ['push', '-q', 'mirror', 'main']);
  return { name, repo, bare, common_dir: fs.realpathSync(path.join(repo, '.git')) };
}
const squash = (w, msg, parent = 'main', who = IDENT) => git(w.repo, ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', msg], who);
const BR = (id) => `tb/${id}-push`;
const remoteAt = (w, id) => { try { return git(w.bare, ['rev-parse', '--verify', '-q', `refs/heads/${BR(id)}`]); } catch { return null; } };
const NOW = new Date().toISOString();
const tagDef = (w, over = {}) => ({ type: 'git', path: w.repo, base: 'main', ident: IDENT, push: { remote: 'mirror' }, ...over });
// a ticket whose final gate passed: waiting close, final {sha} = the squash
const T = (id, w, sha, over = {}) => ticket(id, {
  tag: `acme/${w.name}`, state: 'final_gate', waiting: { reason: 'close', since: NOW }, round: 5, branch: BR(id), common_dir: w.common_dir,
  final: { n: 1, tested_sha: sha, sha, at: NOW, verdict: 'pass' }, ...over,
});

// ---- fixtures, seeded before store.init (it loads tickets once) ----
const W = Object.fromEntries(['ok', 'leak', 'nodeny', 'kids', 'refuse', 'dead', 'boot', 'lease', 'probe', 'deadls', 'env', 'ev1', 'ev2', 'ev3', 'ev4'].map((n) => [n, world(n)]));
const S = {
  ok: squash(W.ok, 'feat: one'),
  leak: squash(W.leak, `feat: ${WORD} support`),
  nodeny: squash(W.nodeny, 'feat: clean'),
  parent: squash(W.kids, `feat: parent for ${WORD}`),
  refuse: squash(W.refuse, 'feat: refused'),
  agent: squash(W.refuse, 'feat: agent ident', 'main', AGENT),
  dead: squash(W.dead, 'feat: dead remote'),
  boot: squash(W.boot, 'feat: landed before'),
  lease1: squash(W.lease, 'feat: first'),
};
S.child = squash(W.kids, 'feat: child', S.parent);
// SEC-1 probe: an unpushed parent squash with the word, a clean child on it; refs/remotes/mirror/x and a packed-refs
// line (an agent may write both) name the parent; the fetch URL (another repo) has it too: only the push URL counts
S.pparent = squash(W.probe, `feat: parent for ${WORD}`);
S.pchild = squash(W.probe, 'feat: child', S.pparent);
const upstream = path.join(ROOT, 'probe-up.git');
git(ROOT, ['clone', '-q', '--bare', W.probe.bare, upstream]);
git(W.probe.repo, ['push', '-q', `file://${upstream}`, `${S.pparent}:refs/heads/parent`]);
git(W.probe.repo, ['remote', 'set-url', 'mirror', `file://${upstream}`]);
git(W.probe.repo, ['remote', 'set-url', '--push', 'mirror', `file://${W.probe.bare}`]);
git(W.probe.repo, ['update-ref', 'refs/remotes/mirror/x', S.pparent]);
fs.appendFileSync(path.join(W.probe.common_dir, 'packed-refs'), `${S.pparent} refs/remotes/mirror/y\n`);
S.deadls = squash(W.deadls, 'feat: clean');
git(W.deadls.repo, ['remote', 'set-url', 'mirror', `file://${path.join(ROOT, 'gone.git')}`]);
// D-0108: the tag's env file (untracked) holds a DB password; the squash commits it as a literal
const PW = 'pw-' + 'Xq7vR2mK9t';
fs.writeFileSync(path.join(W.env.repo, '.env'), `PORT=3000\nDB_PASSWORD=${PW}\n`);
fs.writeFileSync(path.join(W.env.repo, 'db.js'), `module.exports = { db: '${PW}' }; // no key word: gitleaks alone misses it\n`);
git(W.env.repo, ['add', 'db.js']);
S.env = git(W.env.repo, ['commit-tree', git(W.env.repo, ['write-tree']), '-p', 'main', '-m', 'feat: db']);
// H3 (D-0151): env files that must / must not block a push; each squash commits `lit` as a literal
const EV = {
  ev1: ['AUTH_TRUST_HOST=true', 'true'], // boolean value under a SECRET-named key: no block
  ev2: ['NODE_ENV=development', 'development'], // not SECRET-named: no block
  ev3: ['API_TOKEN=s3cr3tvalue1', 's3cr3tvalue1'], // SECRET-named value: block
  ev4: ['DATABASE_URL=postgres://u:p%40ss@localhost/db', 'p@ss'], // URL password, decoded form: block
};
for (const [n, [line, lit]] of Object.entries(EV)) {
  fs.writeFileSync(path.join(W[n].repo, '.env'), `${line}\n`);
  fs.writeFileSync(path.join(W[n].repo, 'cfg.js'), `module.exports = { v: '${lit}' };\n`);
  git(W[n].repo, ['add', 'cfg.js']);
  S[n] = git(W[n].repo, ['commit-tree', git(W[n].repo, ['write-tree']), '-p', 'main', '-m', 'feat: cfg']);
}
git(W.refuse.repo, ['remote', 'add', 'evil', `ext::sh -c touch% ${path.join(ROOT, 'ext-ran')}`]);
git(W.refuse.repo, ['remote', 'add', 'multi', 'https://example.invalid/a.git']);
git(W.refuse.repo, ['remote', 'set-url', '--add', '--push', 'multi', 'https://example.invalid/a.git']);
git(W.refuse.repo, ['remote', 'set-url', '--add', '--push', 'multi', 'git@example.invalid:a.git']);
git(W.dead.repo, ['remote', 'set-url', 'mirror', `file://${path.join(ROOT, 'nope.git')}`]);
git(W.boot.repo, ['push', '-q', 'mirror', `${S.boot}:refs/heads/${BR('t_boot01')}`]); // landed; the tbd died before its CAS

const TAGS = {
  acme: {},
  ...Object.fromEntries(Object.values(W).map((w) => [`acme/${w.name}`, tagDef(w)])),
  'acme/nokey': tagDef(W.refuse, { push: undefined }),
  'acme/ext': tagDef(W.refuse, { push: { remote: 'evil' } }),
  'acme/multi': tagDef(W.refuse, { push: { remote: 'multi' } }),
  'acme/env': tagDef(W.env, { env_files: ['.env'] }),
  ...Object.fromEntries(Object.keys(EV).map((n) => [`acme/${n}`, tagDef(W[n], { env_files: ['.env'] })])),
};
const TICKETS = [
  T('t_ok0001', W.ok, S.ok),
  T('t_leak01', W.leak, S.leak),
  T('t_nodny1', W.nodeny, S.nodeny),
  T('t_kid001', W.kids, S.child, { state: 'done', waiting: null }),
  T('t_nokey1', W.refuse, S.refuse, { tag: 'acme/nokey' }),
  T('t_work01', W.refuse, S.refuse, { state: 'working', waiting: null }),
  T('t_wait01', W.refuse, S.refuse, { waiting: { reason: 'manual', since: NOW } }),
  T('t_ext001', W.refuse, S.refuse, { tag: 'acme/ext' }),
  T('t_mult01', W.refuse, S.refuse, { tag: 'acme/multi' }),
  T('t_agnt01', W.refuse, S.agent),
  T('t_dead01', W.dead, S.dead),
  T('t_boot01', W.boot, S.boot, { push: { state: 'running', remote: 'mirror', ref: `refs/heads/${BR('t_boot01')}`, sha: S.boot, ok_sha: null, at: NOW } }),
  T('t_live01', W.boot, S.boot, { branch: BR('t_live01') }),
  T('t_lease1', W.lease, S.lease1, { state: 'done', waiting: null }),
  T('t_prob01', W.probe, S.pchild, { state: 'done', waiting: null }),
  T('t_dels01', W.deadls, S.deadls),
  T('t_env001', W.env, S.env),
  ...Object.keys(EV).map((n, i) => T(`t_ev${i + 1}000`, W[n], S[n])),
];
fs.writeFileSync(path.join(TB_HOME, 'tags.json'), JSON.stringify(TAGS));
for (const t of TICKETS) {
  fs.mkdirSync(path.join(TB_HOME, 'tickets', t.id));
  fs.writeFileSync(path.join(TB_HOME, 'tickets', t.id, 'ticket.json'), JSON.stringify(t));
}

const store = require('../lib/store');
const push = require('../lib/push');
store.init();
const alerts = [];
const ready = push.boot({ alert: (a) => alerts.push(a) });
const k = (id) => store.getTicket(id);
const alertsOf = (id) => alerts.filter((a) => a.message.startsWith(`${id}:`));
const settled = (id) => until(() => k(id).push?.state !== 'running' && k(id), 30_000, `${id} push settled`);
const pushLines = (id) => lines(path.join(TB_HOME, 'metrics.jsonl')).filter((l) => l.t === 'push' && l.ticket === id);
const ivs = (id) => lines(path.join(TB_HOME, 'tickets', id, 'interventions.jsonl')).map((l) => [l.actor, l.verb]);

test('F5 push: the squash lands on the remote branch, ok_sha = sha, one intervention + one t:push line; a second push meanwhile → 409', async () => {
  await ready;
  assert.deepEqual(await push.start('t_ok0001', 'cli'), { id: 't_ok0001', state: 'running' });
  await assert.rejects(push.start('t_ok0001', 'ui'), { status: 409, message: 't_ok0001: a push is running' });
  const { push: p, state, waiting } = await settled('t_ok0001');
  assert.deepEqual({ ...p, at: typeof p.at }, { state: 'ok', remote: 'mirror', ref: `refs/heads/${BR('t_ok0001')}`, sha: S.ok, ok_sha: S.ok, at: 'string' });
  assert.deepEqual([state, waiting.reason], ['final_gate', 'close'], 'push never moves the ticket');
  assert.equal(remoteAt(W.ok, 't_ok0001'), S.ok);
  assert.deepEqual(ivs('t_ok0001'), [['cli', 'push']]);
  const [line, ...more] = pushLines('t_ok0001');
  assert.deepEqual([{ ...line, at: typeof line.at, ms: typeof line.ms }, more.length], [{ t: 'push', at: 'string', ticket: 't_ok0001', remote: 'mirror', ok: true, ms: 'number' }, 0]);
  assert.deepEqual(alertsOf('t_ok0001'), []);
});

test('F5 leak scan (A21): a denylist word in the squash title → failed leak + 1 alert; leak-check exit 2 → failed leak-check error; nothing pushed, the ticket stays at close', async () => {
  await ready;
  await push.start('t_leak01', 'cli');
  const t = await settled('t_leak01');
  assert.deepEqual([t.push.state, t.push.why, t.push.ok_sha, t.state, t.waiting.reason], ['failed', 'leak', null, 'final_gate', 'close']);
  assert.equal(remoteAt(W.leak, 't_leak01'), null);
  assert.deepEqual(alertsOf('t_leak01').map((a) => a.title), ['Push refused: leak']);
  assert.doesNotMatch(alertsOf('t_leak01')[0].message, new RegExp(WORD), 'leak-check names where, never the word');
  assert.deepEqual(pushLines('t_leak01').map((l) => [l.ok, l.why]), [[false, 'leak']]);

  process.env.TB_DENYLIST = path.join(ROOT, 'missing-denylist.txt'); // leak-check: "denylist missing", exit 2
  try {
    await push.start('t_nodny1', 'cli');
    const n = await settled('t_nodny1');
    assert.deepEqual([n.push.state, n.push.why], ['failed', 'leak-check error']);
  } finally {
    process.env.TB_DENYLIST = DENY;
  }
  assert.equal(remoteAt(W.nodeny, 't_nodny1'), null);
});

test('F5 the scan covers what the remote lacks (--not --remotes): a child pushed on its unpushed parent squash is refused for the parent title', async () => {
  await ready;
  await push.start('t_kid001', 'cli');
  const t = await settled('t_kid001');
  assert.deepEqual([t.push.state, t.push.why, remoteAt(W.kids, 't_kid001')], ['failed', 'leak', null]);
  assert.doesNotMatch(git(W.kids.repo, ['log', '-1', '--format=%B', S.child]), new RegExp(WORD), 'the child commit itself is clean');
});

test('SEC-1 the scan skips only what every push URL has now (ls-remote): a parent named by planted refs/remotes + packed-refs, or held by the fetch URL, is still scanned; ls-remote failing → leak-check error, nothing pushed', async () => {
  await ready;
  await push.start('t_prob01', 'cli');
  const t = await settled('t_prob01');
  assert.deepEqual([t.push.state, t.push.why, remoteAt(W.probe, 't_prob01')], ['failed', 'leak', null]);

  await push.start('t_dels01', 'cli');
  const d = await settled('t_dels01');
  assert.deepEqual([d.push.state, d.push.why, remoteAt(W.deadls, 't_dels01')], ['failed', 'leak-check error', null]);
  assert.match(alertsOf('t_dels01')[0]?.message ?? '', /leak-check error: ls-remote: /);
});

test('D-0108 SEC-5 a tag env secret value committed as a literal → failed leak (temp denylist, removed after); the value is never in an alert', async () => {
  await ready;
  await push.start('t_env001', 'cli');
  const t = await settled('t_env001');
  assert.deepEqual([t.push.state, t.push.why, remoteAt(W.env, 't_env001')], ['failed', 'leak', null]);
  assert.ok(!alertsOf('t_env001').some((a) => a.message.includes(PW)), 'the value is never in an alert');
  assert.deepEqual(fs.readdirSync(TB_HOME).filter((f) => f.startsWith('push-')), [], 'the temp denylist dir is gone');
});

test('H3 envBlock: a boolean under a SECRET-named key and a plain NODE_ENV do not block (push ok); a SECRET-named value and a decoded URL password still refuse leak', async () => {
  await ready;
  for (const [i, n] of Object.keys(EV).entries()) {
    const id = `t_ev${i + 1}000`;
    await push.start(id, 'cli');
    const t = await settled(id);
    assert.deepEqual([t.push.state, t.push.state === 'failed' ? t.push.why : null, remoteAt(W[n], id) !== null], i < 2 ? ['ok', null, true] : ['failed', 'leak', false], n);
  }
});

test('push clean(): a URL\'s userinfo masked whole, a / or @ in the password too', () => {
  assert.equal(push.clean("fatal: 'https://me:pa/ss@ex.com/r.git/' denied"), "fatal: 'https://***@ex.com/r.git/' denied");
  assert.equal(push.clean('https://me:p@ss@ex.com/r'), 'https://***@ex.com/r');
  assert.equal(push.clean('https://ex.com/r.git'), 'https://ex.com/r.git');
});

test('F5 refused before anything is written (409): no push key, not at close / done, ext:: or one non-https push URL of several, squash by another ident', async () => {
  await ready;
  const cases = /** @type {[string, RegExp][]} */ ([
    ['t_nokey1', /^t_nokey1: tag acme\/nokey has no push remote/],
    ['t_work01', /^t_work01: push needs the final gate passed \(waiting close\) or done with a squash; it is working$/],
    ['t_wait01', /it is final_gate waiting manual$/],
    ['t_ext001', /^t_ext001: every push URL of evil must start with https:\/\/$/],
    ['t_mult01', /^t_mult01: every push URL of multi must start with https:\/\/$/],
    ['t_agnt01', /^t_agnt01: squash made with another ident: tb rework to re-squash \(or cancel the children first\)$/],
  ]);
  for (const [id, message] of cases) {
    await assert.rejects(push.start(id, 'cli'), (/** @type {any} */ e) => e.status === 409 && message.test(e.message), id);
    assert.equal(k(id).push, undefined, `${id}: no push recorded`);
    assert.equal(fs.existsSync(path.join(TB_HOME, 'tickets', id, 'interventions.jsonl')), false, `${id}: no intervention`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'ext-ran')), false, 'the ext:: command never ran');
  await assert.rejects(push.start('t_zzzzzz', 'cli'), { status: 404 });
});

test('F5 breaker: 3 failed pushes to an unreachable remote → the 4th call 409 until <ISO> (+ one alert per failure)', async () => {
  await ready;
  for (let i = 1; i <= 3; i++) {
    await push.start('t_dead01', 'cli');
    const t = await settled('t_dead01');
    assert.equal(t.push.state, 'failed', `try ${i}`);
    assert.ok(t.push.why && t.push.why !== 'leak', t.push.why);
  }
  assert.deepEqual(pushLines('t_dead01').map((l) => l.ok), [false, false, false]);
  await assert.rejects(push.start('t_dead01', 'cli'), (/** @type {any} */ e) => e.status === 409 && /^push breaker open until \d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.message));
  assert.equal(alertsOf('t_dead01').filter((a) => a.title === 'Push failed').length, 3);
});

test('F5 boot: a push a dead tbd left running → failed tbd restarted (a live one stays); the re-push finds the branch at sha (ls-remote) → ok', async () => {
  await ready;
  // t_boot01 was seeded running (the dead tbd's): the boot at this file's start reset it
  assert.deepEqual([k('t_boot01').push.state, k('t_boot01').push.why], ['failed', 'tbd restarted']);
  await push.start('t_live01', 'cli');
  await push.boot({ alert: (a) => alerts.push(a) });
  assert.equal(k('t_live01').push.state, 'running', 'its job runs in this tbd: not reset');
  assert.equal((await settled('t_live01')).push.state, 'ok');

  await push.start('t_boot01', 'cli'); // lease "must not exist" fails: the branch is there, at this sha
  const t = await settled('t_boot01');
  assert.deepEqual([t.push.state, t.push.ok_sha, t.push.why], ['ok', S.boot, undefined]);
});

test('F5 lease on ok_sha: a new squash after rework replaces the pushed one; a deleted remote branch → one retry as new → ok; a branch moved by someone else → refused', async () => {
  await ready;
  const pushOf = async (sha) => {
    if (sha !== k('t_lease1').final.sha) await store.updateTicket('t_lease1', (x) => ({ ...x, final: { ...x.final, tested_sha: sha, sha } }));
    await push.start('t_lease1', 'cli');
    return (await settled('t_lease1')).push;
  };
  assert.equal((await pushOf(S.lease1)).ok_sha, S.lease1);
  const s2 = squash(W.lease, 'feat: second'); // the re-squash: a sibling of the pushed one, not on top of it
  assert.deepEqual([(await pushOf(s2)).state, remoteAt(W.lease, 't_lease1')], ['ok', s2]);

  git(W.lease.bare, ['update-ref', '-d', `refs/heads/${BR('t_lease1')}`]); // merged + deleted upstream
  const s3 = squash(W.lease, 'feat: third');
  const p3 = await pushOf(s3);
  assert.deepEqual([p3.state, p3.ok_sha, remoteAt(W.lease, 't_lease1')], ['ok', s3, s3]);

  const other = squash(W.lease, 'someone else');
  git(W.lease.repo, ['push', '-q', '--force', 'mirror', `${other}:refs/heads/${BR('t_lease1')}`]);
  const p4 = await pushOf(squash(W.lease, 'feat: fourth'));
  assert.deepEqual([p4.state, p4.ok_sha, remoteAt(W.lease, 't_lease1')], ['failed', s3, other], 'never a blind force');
  assert.match(p4.why, /stale info/);
});

test('F5 POST /api/tickets/:id/push 202 + tb push: ok line (exit 0); refused 409 or failed push → exit 1 with why', async (t) => {
  const w = world('cli');
  const ok = squash(w, 'feat: cli'), bad = squash(w, `feat: ${WORD}`);
  const C = (id, sha, over = {}) => T(id, w, sha, { state: 'done', waiting: null, ...over });
  const tbd = await startTbd({
    env: { TB_PUSH_FILE_OK: '1', TB_DENYLIST: DENY },
    files: {
      'tags.json': { acme: {}, 'acme/cli': tagDef(w), 'acme/nokey': tagDef(w, { push: undefined }) },
      'tickets/t_cli001/ticket.json': C('t_cli001', ok),
      'tickets/t_cli002/ticket.json': C('t_cli002', ok, { tag: 'acme/nokey' }),
      'tickets/t_cli003/ticket.json': C('t_cli003', bad),
    },
  });
  t.after(() => tbd.stop());
  const r = await runTb(['push', 't_cli001'], tbd);
  assert.deepEqual([r.code, r.stdout.trim()], [0, `push: ok · t_cli001 · ${ok.slice(0, 12)} → mirror ${BR('t_cli001')}`]);
  const no = await runTb(['push', 't_cli002'], tbd);
  assert.equal(no.code, 1);
  assert.match(no.stdout, /^error: t_cli002: tag acme\/nokey has no push remote/);
  const leak = await runTb(['push', 't_cli003'], tbd);
  assert.deepEqual([leak.code, leak.stdout.split('\n')[0]], [1, 'error: push failed · t_cli003 · leak']);
  assert.equal((await tbd.api('POST', '/api/tickets/t_cli002/push')).status, 409);
  const again = await tbd.api('POST', '/api/tickets/t_cli001/push'); // the same squash once more: already there → ok
  assert.deepEqual([again.status, again.json], [202, { id: 't_cli001', state: 'running' }]);
  const done = await until(async () => { const p = (await tbd.api('GET', '/api/tickets/t_cli001')).json.ticket.push; return p.state !== 'running' && p; });
  assert.deepEqual([done.state, done.ok_sha], ['ok', ok]);
});
