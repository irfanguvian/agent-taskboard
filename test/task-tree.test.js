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
fs.writeFileSync(path.join(home, 'tags.json'), JSON.stringify({ acme: { type: 'git', path: dir, base: 'main' }, hooks: { type: 'git', path: dir2, base: 'main' } }));
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
