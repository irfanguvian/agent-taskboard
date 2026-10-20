'use strict';
// Phase 4 design (.omc/plans/2026-10-20-phase4-one-kind-design.md, revision 6) test 6, last case: a Cancel while an Own
// Worktree Task waits tree_wait, and a Cancel right after its add, before the add's write → no folder, no git folder, no
// branch left. In-process: the real store (temp TB_HOME, set before lib/ loads), the real assign and planning hook
// (lib/task.js planNext), a real git repo; the runner's api is the one seam (setWaiting writes the wait). Its own file: a
// fresh process, so lib/store reads this TB_HOME.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-tree-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const dir = path.join(ROOT, 'repo');
fs.mkdirSync(dir);
git(dir, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
git(dir, 'add', '.');
git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
const home = path.join(ROOT, 'tbhome');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ terminal: { task_tickets: true } }));
// hooks: a repo whose tracked `a` is a link out of the folder while Irfan's checkout has a real a/hooks there (typechange)
const out = path.join(ROOT, 'outside');
fs.mkdirSync(out);
const dir2 = path.join(ROOT, 'repo2');
fs.mkdirSync(dir2);
git(dir2, 'init', '-q', '-b', 'main');
fs.symlinkSync(out, path.join(dir2, 'a'));
git(dir2, 'add', 'a');
git(dir2, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'link');
fs.unlinkSync(path.join(dir2, 'a'));
fs.mkdirSync(path.join(dir2, 'a', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(dir2, 'a', 'hooks', 'pre-commit'), 'echo\n');
git(dir2, 'config', 'core.hooksPath', 'a/hooks');
// build step 2 part B (tests 4, 5, 16): a repo with Irfan's identity, an origin and a tracked config file of the main checkout
const dir3 = path.join(ROOT, 'repo3');
fs.mkdirSync(dir3);
git(dir3, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(dir3, 'README.md'), 'hello\n');
git(dir3, 'add', '.');
git(dir3, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
fs.writeFileSync(path.join(dir3, 'extra.cfg'), '[x]\n\ty = 1\n');
git(dir3, 'add', '.');
git(dir3, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'extra');
git(dir3, 'config', 'user.name', 'Irfan');
git(dir3, 'config', 'user.email', 'irfan@example.com');
git(dir3, 'remote', 'add', 'origin', path.join(ROOT, 'nowhere.git'));
fs.writeFileSync(path.join(home, 'tags.json'), JSON.stringify({ acme: { type: 'git', path: dir, base: 'main' }, hooks: { type: 'git', path: dir2, base: 'main' }, pin: { type: 'git', path: dir3, base: 'main' } }));
process.env.TB_HOME = home;
const store = require('../lib/store');
store.init();
const task = require('../lib/task'); // registers task/planning
const planning = require('../lib/planning');
const phases = require('../lib/phases');
const fsm = require('../lib/fsm');

const api = (id) => ({ setWaiting: (reason) => store.updateTicket(id, (k) => ({ ...k, waiting: { reason, since: new Date().toISOString() } })) });
const tick = (id) => phases.next('task', 'planning')(structuredClone(store.getTicket(id)), api(id));
const assigned = async (tag = 'acme') => {
  const t = await store.createFlow({ text: 'Add a line', kind: 'task', tag, where: 'worktree' });
  await planning.assign(t.id);
  return t.id;
};
const nothingLeft = (id) => {
  assert.equal(fs.existsSync(path.join(home, 'worktrees', id)), false, 'no worktree folder');
  assert.equal(fs.existsSync(path.join(dir, '.git', 'worktrees', id)), false, 'no worktree git folder');
  assert.equal(git(dir, 'branch', '--list', `tb/${id}`), '', 'no branch');
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').split('\n\n').length, 1, 'the main checkout only');
  assert.equal(store.getTicket(id).git_dir, undefined);
};

test('Own Worktree tree wait (design test 6): B waits tree_wait while A\'s working run is live, makes nothing, and a Cancel leaves nothing; a Cancel right after C\'s add, before its write → the add is undone', async () => {
  const a = await assigned();
  await store.updateTicket(a, (k) => ({ ...k, state: 'working', lease: { gen: 1, phase: 'working', round: k.round, pid: null } })); // A's live working run
  const b = await assigned();
  await tick(b);
  assert.equal(store.getTicket(b).waiting?.reason, 'tree_wait');
  nothingLeft(b);
  await fsm.transition(store, b, 'cancelled', 'you');

  const c = await assigned();
  await store.updateTicket(a, (k) => ({ ...k, lease: { ...k.lease, exit: 'result' } })); // A's run ended
  const seen = structuredClone(store.getTicket(c)); // the tick's copy, still in planning
  await fsm.transition(store, c, 'cancelled', 'you'); // the Cancel lands while the add runs
  await phases.next('task', 'planning')(seen, api(c));
  assert.equal(store.getTicket(c).state, 'cancelled');
  nothingLeft(c);

  const d = await assigned(); // positive control: the same tick with no Cancel saves the worktree
  await tick(d);
  assert.equal(store.getTicket(d).git_dir, path.join(dir, '.git', 'worktrees', d));
  assert.equal(git(dir, 'rev-parse', `tb/${d}`), git(dir, 'rev-parse', 'HEAD'));
});

test('untree refuses what is not exactly this Task\'s (a link at <common>/worktrees/<id>, a folder outside <TB_HOME>/worktrees), and the add refuses to copy hooks through a link out of the worktree', async () => {
  const id = 't_link01';
  const target = path.join(ROOT, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x\n');
  fs.mkdirSync(path.join(dir, '.git', 'worktrees'), { recursive: true });
  const link = path.join(dir, '.git', 'worktrees', id);
  fs.symlinkSync(target, link);
  const common = path.join(dir, '.git');
  await assert.rejects(task.untree({ id, task: { repo: dir }, git_dir: link, common_dir: common }), /not this Task's worktree git folder/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link stays');
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x\n', 'its target stays');
  fs.unlinkSync(link);
  const elsewhere = path.join(ROOT, 'elsewhere', id);
  fs.mkdirSync(elsewhere, { recursive: true });
  await assert.rejects(task.untree({ id, task: { repo: dir }, worktree: elsewhere }), /refusing to remove .*: not .*\/worktrees\/t_link01/);
  assert.equal(fs.existsSync(elsewhere), true, 'the folder stays');

  const h = await assigned('hooks');
  await tick(h);
  const k = store.getTicket(h);
  assert.equal(k.state, 'blocked');
  assert.match(k.waiting.why, /^making the worktree failed: the hooks folder in the worktree leads outside it \(a link\): Cancel and start a new Task$/);
  assert.deepEqual(fs.readdirSync(out), [], 'nothing written through the link');
  assert.equal(fs.existsSync(path.join(home, 'worktrees', h)), false, 'the add undone');
  assert.equal(git(dir2, 'branch', '--list', `tb/${h}`), '');
});

// ---- build step 2 part B (design revision 6 tests 4, 5, 16) ----
const pageTools = require('../lib/page-tools');
const CFG_WORDS = 'your git config changed since the Task started (git remote add, git maintenance): look at it, then Resume';
const added = async () => { // an Own Worktree Task on repo3 with its worktree (the add), no start point yet
  const id = await assigned('pin');
  await tick(id);
  assert.ok(store.getTicket(id).git_dir, store.getTicket(id).waiting?.why);
  return id;
};
const startedAt = async () => { // ... and its start point
  const id = await added();
  await tick(id);
  const k = store.getTicket(id);
  assert.ok(k.task.base, k.waiting?.why);
  return id;
};

test('queued-Task belt (design test 4): the start point after the add takes the pin from the repo (clean); tb/<id> moved before it → "tb/<id> moved before the Task started"', async () => {
  const id = await added();
  const ok = /** @type {any} */ (await task.baseline(store.getTicket(id)));
  assert.equal(ok.reasons, undefined, JSON.stringify(ok.reasons));
  assert.deepEqual([ok.patch.clone.tree, typeof ok.patch.clone.config, ok.base.head_ref], [true, 'string', `refs/heads/tb/${id}`]);
  git(dir3, 'update-ref', `refs/heads/tb/${id}`, git(dir3, 'rev-parse', 'HEAD~1'));
  const r = await task.baseline(store.getTicket(id));
  assert.deepEqual(r.reasons, [`tb/${id} moved before the Task started: Cancel and start a new Task`]);
});

test('worktree pin negatives (design test 5): config, commondir, gitfile and HEAD changes each give a check() reason; an include or hooks folder the agent can write is refused at the start point; core.hooksPath=.git/hooks is fine with no hooks rule', async () => {
  const cfgCase = await startedAt();
  assert.deepEqual(await task.check(store.getTicket(cfgCase)), [], 'clean right after the start point');
  git(dir3, 'config', 'foo.bar', 'baz');
  assert.deepEqual(await task.check(store.getTicket(cfgCase)), [CFG_WORDS]);
  git(dir3, 'config', '--unset', 'foo.bar');

  const cd = await startedAt();
  const k = store.getTicket(cd);
  const f = path.join(k.git_dir, 'commondir');
  const was = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, `${path.join(dir, '.git')}\n`);
  assert.match((await task.check(k)).join('\n'), /commondir does not lead to/);
  fs.writeFileSync(f, was);

  const gf = await startedAt();
  const kg = store.getTicket(gf);
  const gitfile = path.join(kg.worktree, '.git');
  const wasG = fs.readFileSync(gitfile, 'utf8');
  fs.writeFileSync(gitfile, `gitdir: ${path.join(dir, '.git')}\n`);
  assert.match((await task.check(kg)).join('\n'), new RegExp(`${gitfile} does not lead to`));
  fs.writeFileSync(gitfile, wasG);

  const hd = await startedAt();
  git(store.getTicket(hd).worktree, 'switch', '-q', '-c', `y-${hd}`);
  assert.match((await task.check(store.getTicket(hd))).join('\n'), new RegExp(`HEAD moved to y-${hd}: undo: git switch tb/${hd}`));

  const refusedAt = async (key, value, re) => { // a fresh Task's start point Blocks with the words
    git(dir3, 'config', key, value);
    const id = await added();
    await tick(id);
    const t = store.getTicket(id);
    git(dir3, 'config', '--unset', key);
    assert.equal(t.state, 'blocked');
    assert.match(t.waiting.why, re);
  };
  await refusedAt('include.path', path.join(dir3, 'extra.cfg'), new RegExp(`your git config includes ${path.join(dir3, 'extra.cfg')}, a file the agent can write: move it out of the folder`));
  // review HIGH: a relative include resolves from the config file's folder (<repo>/.git), not from tbd's cwd
  await refusedAt('include.path', '../extra.cfg', new RegExp(`your git config includes ${path.join(dir3, 'extra.cfg')}, a file the agent can write: move it out of the folder`));
  await refusedAt('core.hooksPath', path.join(dir3, 'githooks'), /your hooks folder .*\/githooks is one the agent can write: set a relative core.hooksPath/);
  await refusedAt('core.hooksPath', '.git/myhooks', /your hooks folder .*\/\.git\/myhooks is inside \.git, where the agent can write: use \.git\/hooks or a folder in the repo/);
  git(dir3, 'config', 'core.hooksPath', '.git/hooks');
  const ok = await startedAt();
  git(dir3, 'config', '--unset', 'core.hooksPath');
  assert.equal(store.getTicket(ok).task.base.hooks, null, 'no hooks rule: the <common>/hooks row covers it');
  assert.equal(fs.lstatSync(path.join(store.getTicket(ok).worktree, '.git')).isFile(), true, 'nothing copied into the gitfile');
});

test('git link belts (design test 16): a swapped worktree git folder → Continue in Terminal 409 and push_why with the plain words, no push target', async () => {
  const id = await startedAt();
  const tag = store.listTags().pin;
  const before = await task.pushTo(store.getTicket(id), tag);
  assert.equal(before.push_why, 'no changed files to commit', 'clean links: today\'s line');
  await store.updateTicket(id, (k) => ({ ...k, state: 'working', lease: { gen: 1, phase: 'working', round: k.round, pid: 1, exit: 'held', session: '11111111-2222-4333-8444-555555555555' } }));
  const k = store.getTicket(id);
  fs.renameSync(k.git_dir, `${k.git_dir}.aside`);
  fs.mkdirSync(k.git_dir);
  fs.writeFileSync(path.join(k.git_dir, 'gitdir'), `${k.worktree}/.git\n`);
  const words = `the worktree's git links changed: do not open a terminal in ${k.worktree}: Cancel`;
  await assert.rejects(pageTools.openTerminal(id, {}), (/** @type {any} */ e) => e.status === 409 && e.message === `${id}: ${words}`);
  assert.deepEqual(await task.pushTo(k, tag), { push_to: null, push_why: words });
});

test('My Folder start point refuses a relative include the agent can write (review HIGH: include.path=../.gitconfig resolved from tbd\'s cwd before)', async () => {
  git(dir3, 'config', 'include.path', '../.gitconfig');
  try {
    const r = await task.baseline({ id: 't_fold01', tag: 'pin', worktree: dir3, task: { mode: 'folder', real: dir3 } });
    assert.deepEqual(r.reasons, [`your git config includes ${path.join(dir3, '.gitconfig')}, a file the agent can write: move it out of the folder`]);
  } finally {
    git(dir3, 'config', '--unset', 'include.path');
  }
});

test('a Task mid-add (design section 4, the adding set): its new tb/<x> is no reason in another Task\'s check, even on a commit with Claude config; once the add is over with no base_sha it Blocks', async () => {
  const t = await startedAt();
  const x = await assigned('pin'); // assigned, its add not saved: no common_dir, no base_sha yet
  const env = { ...process.env, GIT_INDEX_FILE: path.join(ROOT, `idx-${x}`), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const g = (/** @type {string[]} */ ...a) => execFileSync('/usr/bin/git', ['-C', dir3, ...a], { encoding: 'utf8', env, input: '{"hooks": {}}\n' }).trim();
  g('read-tree', 'HEAD');
  g('update-index', '--add', '--cacheinfo', `100644,${g('hash-object', '-w', '--stdin')},.claude/settings.json`);
  git(dir3, 'update-ref', `refs/heads/tb/${x}`, g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', g('write-tree'), '-p', 'HEAD', '-m', 'mid-add'));
  task.adding.add(x);
  try {
    assert.deepEqual(await task.check(store.getTicket(t)), []);
  } finally {
    task.adding.delete(x);
  }
  assert.match((await task.check(store.getTicket(t))).join('\n'), new RegExp(`refs/heads/tb/${x} has new commits that touch \\.claude/settings\\.json`));
  git(dir3, 'update-ref', '-d', `refs/heads/tb/${x}`);
  await fsm.transition(store, x, 'cancelled', 'you');
});

// ---- build step 3 (design revision 6 tests 2, 10, 12, 15) ----
const actions = require('../lib/task-actions');
const { createGc } = require('../lib/gc');
const gc = createGc({ store, tbHome: home });
const yours = (id) => store.updateTicket(id, (k) => ({ ...k, state: 'working', waiting: { reason: 'you', since: new Date().toISOString() }, lease: { gen: 1, phase: 'working', round: k.round, pid: 1, exit: 'result' } }));
const agentCommit = (wt, file) => {
  fs.writeFileSync(path.join(wt, file), `${file}\n`);
  git(wt, 'add', file);
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file);
};

test('unpushed line (design test 12): an Own Worktree whose agent committed during work → no push target, push_why names the count, origin and the Terminal hint; the same on a My Folder Task → "no changed files to commit"', async () => {
  const id = await startedAt();
  agentCommit(store.getTicket(id).worktree, `a-${id}.txt`);
  assert.deepEqual(await task.pushTo(store.getTicket(id), store.listTags().pin),
    { push_to: null, push_why: `tb/${id} has 1 commit not on origin: push from Terminal (\`git push origin tb/${id}\` in the worktree)` });

  git(dir, 'config', 'user.name', 'Irfan');
  git(dir, 'config', 'user.email', 'irfan@example.com');
  git(dir, 'remote', 'add', 'origin', path.join(ROOT, 'nowhere.git'));
  const mine = { id: 't_fold02', tag: 'acme', worktree: dir, task: { mode: 'folder', real: dir } };
  const b = /** @type {any} */ (await task.baseline(mine));
  assert.equal(b.reasons, undefined, JSON.stringify(b.reasons));
  agentCommit(dir, 'b.txt');
  assert.deepEqual(await task.pushTo({ ...mine, ...b.patch, task: { ...mine.task, base: b.base } }, store.listTags().acme), { push_to: null, push_why: 'no changed files to commit' });
});

test('Done keeps a dirty worktree (design test 2) and tb gc then lists and removes it (design test 10): task.kept = 1, folder there; the row says "1 file not committed", no clone count; delete removes the exact git folder, a stale entry stays (no prune), the branch stays; a live run → refused', async () => {
  const id = await startedAt();
  const k = store.getTicket(id);
  fs.writeFileSync(path.join(k.worktree, 'left.txt'), 'x\n');
  await yours(id);
  const d = await actions.done(id, 'ui');
  assert.deepEqual([d.state, d.task.kept], ['done', 1]);
  assert.ok(fs.existsSync(path.join(k.worktree, 'left.txt')) && fs.existsSync(k.git_dir), 'the folder and its git folder stay');

  const row = (await gc.list({ limit: 100 })).items.find((i) => i.id === `worktree/${id}`);
  assert.equal(row.reason, 'ticket done · 1 file not committed');
  assert.equal(row.clone_only, undefined, 'no clone-only count for a worktree');
  await store.updateTicket(id, (x) => ({ ...x, lease: { ...x.lease, exit: undefined } })); // item 3: a run still live
  assert.deepEqual((await gc.remove({ ids: [`worktree/${id}`] })).skipped, [{ id: `worktree/${id}`, reason: 'its run is still live: try again once it ended' }]);
  assert.ok(fs.existsSync(k.git_dir));
  await store.updateTicket(id, (x) => ({ ...x, lease: { ...x.lease, exit: 'result' } }));
  const stale = path.join(dir3, '.git', 'worktrees', 'stale1');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'gitdir'), `${path.join(ROOT, 'gone', '.git')}\n`);
  const r = await gc.remove({ ids: [`worktree/${id}`] });
  assert.deepEqual([r.deleted.map((x) => x.id), r.skipped], [[`worktree/${id}`], []]);
  assert.equal(fs.existsSync(k.worktree), false);
  assert.equal(fs.existsSync(k.git_dir), false, 'its exact git folder is gone');
  assert.ok(fs.existsSync(path.join(stale, 'gitdir')), 'a stale entry stays: no git worktree prune');
  fs.rmSync(stale, { recursive: true });
  assert.equal(git(dir3, 'rev-parse', `tb/${id}`), k.base_sha, 'the branch stays');
});

test('branch deletes (design test 15, D-0238): tb gc deleting a done Task\'s tb/<C> Blocks no open Task and writes one record line; Irfan deleting tb/<B> Blocks A; an unreadable record → no skip; a branch moved forward then deleted by gc → no Block; one reset to an older commit → Block', async () => {
  const [b, c, dd, e, f] = [await startedAt(), await startedAt(), await startedAt(), await startedAt(), await startedAt()];
  const a = await startedAt(); // last: the others' tb/<x> are in A's start record
  for (const id of [c, dd, e, f]) await store.updateTicket(id, (k) => ({ ...k, state: 'done' }));
  const rec = path.join(home, 'gc-branches.jsonl');
  fs.rmSync(rec, { force: true });
  const reasons = async () => (await task.check(store.getTicket(a))).join('\n');
  const gcDel = async (id) => {
    const ids = [`worktree/${id}`, `branch/tb/${id}`];
    const listed = (await gc.list({ limit: 100 })).items.filter((i) => ids.includes(i.id));
    assert.equal(listed.length, 2, JSON.stringify(listed));
    const r = await gc.remove({ ids });
    assert.deepEqual(r.deleted.map((x) => x.id), ids, JSON.stringify(r.skipped));
    assert.equal(git(dir3, 'branch', '--list', `tb/${id}`), '');
  };

  await gcDel(c);
  assert.equal(await reasons(), '');
  assert.deepEqual(await task.check(store.getTicket(b)), []);
  const line = JSON.parse(fs.readFileSync(rec, 'utf8'));
  assert.deepEqual(line, { common: `${dir3}/.git`, ref: `refs/heads/tb/${c}`, sha: store.getTicket(c).base_sha });

  const bSha = git(dir3, 'rev-parse', `tb/${b}`);
  git(dir3, 'update-ref', '-d', `refs/heads/tb/${b}`); // Irfan's terminal
  assert.match(await reasons(), new RegExp(`deleted refs/heads/tb/${b}: undo`));
  git(dir3, 'update-ref', `refs/heads/tb/${b}`, bSha);

  fs.chmodSync(rec, 0o000);
  try {
    assert.match(await reasons(), new RegExp(`deleted refs/heads/tb/${c}: undo`), 'no readable record: no skip');
  } finally {
    fs.chmodSync(rec, 0o600);
  }

  agentCommit(store.getTicket(dd).worktree, `d-${dd}.txt`); // D's own Commit and Push moved it on after A started
  await gcDel(dd);
  assert.equal(await reasons(), '');

  // round 1 review: gc's delete of tb/<F> refused (it had moved) → a later line with no sha cancels the first; a delete
  // by hand afterwards Blocks
  const fRef = `refs/heads/tb/${f}`;
  fs.appendFileSync(rec, `${JSON.stringify({ common: `${dir3}/.git`, ref: fRef, sha: store.getTicket(f).base_sha })}\n${JSON.stringify({ common: `${dir3}/.git`, ref: fRef, sha: null })}\n`);
  git(dir3, 'update-ref', '-d', fRef);
  assert.match(await reasons(), new RegExp(`deleted refs/heads/tb/${f}: undo`));
  git(dir3, 'update-ref', fRef, store.getTicket(f).base_sha);
  assert.equal(await reasons(), '');

  git(dir3, 'update-ref', `refs/heads/tb/${e}`, git(dir3, 'rev-parse', 'HEAD~1')); // not a descendant of A's start record
  await gcDel(e);
  assert.match(await reasons(), new RegExp(`deleted refs/heads/tb/${e}: undo`));
  for (const id of [a, b]) await fsm.transition(store, id, 'cancelled', 'you');
});

test('Done after review round 1: a remove that fails (a folder it cannot empty) → task.tree_left, the folder stays; a held lease ends as cancelled (no Continue in Terminal into it); a file new since the check → kept, not removed; his terminal still on the session → tree_left', async () => {
  const id = await added();
  const wt = store.getTicket(id).worktree;
  fs.mkdirSync(path.join(wt, 'locked'));
  fs.writeFileSync(path.join(wt, 'locked', 'f'), 'x\n');
  await tick(id); // the start point: locked/ is dirty there already, so it is no file the Task left
  assert.ok(store.getTicket(id).task.base, store.getTicket(id).waiting?.why);
  fs.chmodSync(path.join(wt, 'locked'), 0o555);
  try {
    await yours(id);
    const d = await actions.done(id, 'ui');
    assert.deepEqual([d.state, d.task.tree_left, d.task.kept], ['done', true, undefined]);
    assert.ok(fs.existsSync(path.join(wt, 'locked', 'f')), 'the folder stays');
  } finally {
    fs.chmodSync(path.join(wt, 'locked'), 0o755);
  }

  const session = '11111111-2222-4333-8444-555555555555';
  const held = async () => {
    const x = await startedAt();
    await store.updateTicket(x, (k) => ({ ...k, state: 'working', waiting: { reason: 'you', since: new Date().toISOString() }, lease: { gen: 1, phase: 'working', round: k.round, pid: 1, exit: 'held', session } }));
    return x;
  };
  const late = await held();
  const asked = [];
  const d2 = await actions.done(late, 'ui', { free: async (i, l) => { asked.push([i, l.exit, l.session]); fs.writeFileSync(path.join(store.getTicket(late).worktree, 'late.txt'), 'x\n'); } });
  assert.deepEqual(asked, [[late, 'held', session]], 'his terminal asked again with the held lease');
  assert.deepEqual([d2.state, d2.lease.exit, d2.task.kept, d2.task.tree_left], ['done', 'cancelled', 1, undefined]);
  assert.ok(fs.existsSync(path.join(d2.worktree, 'late.txt')), 'kept: a file new since the check');
  await assert.rejects(pageTools.openTerminal(late, {}), (/** @type {any} */ e) => e.status === 409 && /not held/.test(e.message));

  const busy = await held();
  const d3 = await actions.done(busy, 'ui', { free: async () => { throw new Error('claude --resume still runs'); } });
  assert.deepEqual([d3.state, d3.task.tree_left], ['done', true]);
  assert.ok(fs.existsSync(d3.worktree) && fs.existsSync(d3.git_dir), 'the folder and its git folder stay');
});
