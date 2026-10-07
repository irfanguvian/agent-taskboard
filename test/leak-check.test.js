'use strict';
// P0 AC4: leak gate refuses fake AWS key and denylist words (file, commit message, branch name); clean range passes (D18).
// Every case runs the real scripts in a temp git repo with temp HOME and temp denylist. Pushes go to a local bare repo only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const WORD = 'zebracorp';
// split so this file itself never trips the gate; gitleaks aws-access-token shape, not an AWS doc example
const FAKE_KEY = 'AK' + 'IAZ7FXQ3JDPW2KLM4N';

// Temp world: HOME, denylist, one git repo on main with a clean first commit.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    TB_DENYLIST: path.join(root, 'denylist.txt'),
  };
  fs.writeFileSync(env.TB_DENYLIST, `# made-up word\n${WORD}\n`);
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' });
  const git = (...args) => {
    const r = run('git', args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  const commit = (file, text, msg = 'change') => {
    fs.writeFileSync(path.join(repo, file), text);
    git('add', file);
    git('commit', '-q', '-m', msg);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  commit('README.md', 'hello\n', 'init');
  const check = (...args) => run(path.join(SCRIPTS, 'leak-check'), args);
  return { root, home, repo, env, run, git, commit, check };
}

const out = (r) => r.stdout + r.stderr;

test('clean range passes', () => {
  const w = world();
  w.commit('a.txt', 'nothing secret\n');
  const r = w.check('HEAD~1..HEAD', '--branch', 'feature/ok');
  assert.equal(r.status, 0, out(r));
});

test('fake AWS key is refused and never printed', () => {
  const w = world();
  w.commit('conf.txt', `aws_access_key_id = ${FAKE_KEY}\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /gitleaks aws-access-token conf\.txt:1/);
  assert.ok(!out(r).includes(FAKE_KEY));
});

test('denylist word in a file is refused, case-insensitive, word not printed', () => {
  const w = world();
  w.commit('notes.txt', `client is ${WORD.toUpperCase()}\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /notes\.txt:1: denylist entry #1/);
  assert.ok(!out(r).toLowerCase().includes(WORD));
});

test('denylist word added then removed inside the range is still refused', () => {
  const w = world();
  w.commit('notes.txt', `${WORD}\n`);
  w.commit('notes.txt', 'clean now\n');
  const r = w.check('HEAD~2..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /notes\.txt:1: denylist entry #1/);
});

test('denylist word only in a commit message is refused', () => {
  const w = world();
  w.commit('a.txt', 'clean\n', `work for ${WORD}`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /commit message [0-9a-f]+: denylist entry #1/);
  assert.ok(!out(r).includes(WORD));
});

test('denylist word only in a branch name is refused', () => {
  const w = world();
  w.commit('a.txt', 'clean\n');
  const r = w.check('HEAD~1..HEAD', '--branch', `feat/${WORD}-x`);
  assert.equal(r.status, 1);
  assert.match(out(r), /branch name: denylist entry #1/);
  assert.ok(!out(r).includes(WORD));
});

test('denylist word in a PR body file is refused', () => {
  const w = world();
  w.commit('a.txt', 'clean\n');
  const body = path.join(w.root, 'pr.md');
  fs.writeFileSync(body, `line one\nfor ${WORD}\n`);
  const r = w.check('HEAD~1..HEAD', '--file', body);
  assert.equal(r.status, 1);
  assert.match(out(r), /pr\.md:2: denylist entry #1/);
});

test('missing denylist fails closed with exit 2', () => {
  const w = world();
  fs.rmSync(w.env.TB_DENYLIST);
  const r = w.check('HEAD~0..HEAD');
  assert.equal(r.status, 2);
  assert.match(out(r), /denylist missing/);
});

test('pre-push hook blocks leaks and lets clean pushes through (local bare remote)', () => {
  const w = world();
  const remote = path.join(w.root, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: w.env }).status, 0);
  w.git('remote', 'add', 'origin', remote);
  // plan m2: hook prefers $HOME/taskboard-live/scripts/leak-check
  fs.mkdirSync(path.join(w.home, 'taskboard-live', 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(SCRIPTS, 'leak-check'), path.join(w.home, 'taskboard-live', 'scripts', 'leak-check'));
  const inst = w.run(path.join(SCRIPTS, 'install-git-hooks'), []);
  assert.equal(inst.status, 0, out(inst));
  const remoteHas = (ref) => spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', ref], { env: w.env }).status === 0;

  // new ref, clean
  assert.equal(w.run('git', ['push', '-q', 'origin', 'main']).status, 0);
  assert.ok(remoteHas('refs/heads/main'));
  // existing ref, leaking commit
  w.commit('notes.txt', `${WORD}\n`);
  let r = w.run('git', ['push', 'origin', 'main']);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /leak gate refused/);
  w.git('reset', '-q', '--hard', 'HEAD~1');
  // new ref, leaking commit
  w.git('checkout', '-q', '-b', 'leaky');
  w.commit('notes.txt', `${WORD}\n`);
  r = w.run('git', ['push', 'origin', 'leaky']);
  assert.notEqual(r.status, 0);
  assert.ok(!remoteHas('refs/heads/leaky'));
  // new ref, clean commit but leaking branch name
  w.git('checkout', '-q', 'main');
  w.git('checkout', '-q', '-b', `clean-${WORD}`);
  w.commit('b.txt', 'clean\n');
  r = w.run('git', ['push', 'origin', `clean-${WORD}`]);
  assert.notEqual(r.status, 0);
  assert.ok(!remoteHas(`refs/heads/clean-${WORD}`));
  // new ref, clean
  w.git('checkout', '-q', 'main');
  w.git('checkout', '-q', '-b', 'fine');
  w.commit('c.txt', 'clean\n');
  r = w.run('git', ['push', '-q', 'origin', 'fine']);
  assert.equal(r.status, 0, out(r));
  assert.ok(remoteHas('refs/heads/fine'));
});
