'use strict';
// P0 AC4: leak gate refuses fake AWS key and denylist words (file, commit message, branch name); clean range passes (D18).
// Every case runs the real scripts in a temp git repo with temp HOME and temp denylist. Pushes go to a local bare repo only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const WORD = 'zebracorp';
// split so this file itself never trips the gate; gitleaks aws-access-token shape, not an AWS doc example
const FAKE_KEY = 'AK' + 'IAZ7FXQ3JDPW2KLM4N';
// same trick; gitleaks github-pat shape
const FAKE_PAT = 'gh' + 'p_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hI6';
// same trick; a Claude OAuth token shape (S3: gitleaks 8.30 defaults miss it)
const FAKE_OAT = 'sk-' + 'ant-' + 'oat01-' + 'Zq3xV8mN2pL7kR4tW9yB1cD6fH0jK5sA3eG8iU2oQ7wE4rT1yP6aS9dF2gH5jK8lZ3x';

// Temp world: HOME, denylist, one git repo on main with a clean first commit.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-'));
  tmpDirs.push(root);
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
  const run = (cmd, args, extraEnv = {}) => spawnSync(cmd, args, { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
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
  const checkWith = (extraEnv, ...args) => run(path.join(SCRIPTS, 'leak-check'), args, extraEnv);
  return { root, home, repo, env, run, git, commit, check, checkWith };
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

test('S3 a Claude OAuth token (sk-ant-oat01-) is refused and never printed; sk-ant- with a short tail is not a token', () => {
  const w = world();
  w.commit('env.txt', `CLAUDE_CODE_OAUTH_TOKEN=${FAKE_OAT}\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /gitleaks anthropic-token env\.txt:1/);
  assert.ok(!out(r).includes(FAKE_OAT.slice(14)));
  w.commit('doc.txt', 'keys start with sk-ant-api03- or sk-ant-oat01-\n');
  assert.equal(w.check('HEAD~1..HEAD').status, 0, 'prefix only: no token');
});

test('denylist word in a file is refused, case-insensitive, word not printed', () => {
  const w = world();
  w.commit('notes.txt', `client is ${WORD.toUpperCase()}\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /notes\.txt:1: denylist entry #1/);
  assert.ok(!out(r).toLowerCase().includes(WORD));
});

test('text file whose path holds a denylist word: hit reported, path word masked, never printed', () => {
  const w = world();
  w.commit(`${WORD}-notes.txt`, `client is ${WORD}\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.match(out(r), /\*\*\*-notes\.txt:1: denylist entry #1/);
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

// ---- P1 fix-C: the gate must not be blindable (SR2 SR3 SR4 SR5) ----

test('a non-UTF-8 byte before a denylist word does not blind the scan (UTF-8 locale)', () => {
  const w = world();
  w.commit('latin1.txt', Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(`\n${WORD}\n`)]));
  const r = w.checkWith({ LC_ALL: 'en_US.UTF-8' }, 'HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /latin1\.txt:2: denylist entry #1/);
  assert.doesNotMatch(out(r), /towc/);
});

test('a scanner stage that crashes fails closed with exit 2, never 0', () => {
  const w = world();
  w.commit('a.txt', 'clean\n');
  const stub = path.join(w.root, 'stub');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'awk'), '#!/bin/sh\ncat > /dev/null\nexit 2\n', { mode: 0o755 });
  const r = w.checkWith({ PATH: `${stub}:${process.env.PATH}` }, 'HEAD~1..HEAD');
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /scan failed/);
});

test('a repo .gitleaksignore cannot hide a secret', () => {
  const w = world();
  w.commit('pat.txt', `token=${FAKE_PAT}\n`);
  const sha = w.git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(w.repo, '.gitleaksignore'), `${sha}:pat.txt:github-pat:1\npat.txt:github-pat:1\n`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /gitleaks github-pat pat\.txt:1/);
  assert.ok(!out(r).includes(FAKE_PAT));
});

test('.gitattributes -diff / binary cannot blind the denylist scan or gitleaks', () => {
  const w = world();
  w.commit('.gitattributes', '*.dat -diff\n*.bin binary\n');
  w.commit('word.dat', `${WORD}\n`); // only the denylist scan can see this one
  let r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /word\.dat:1: denylist entry #1/);
  // gitleaks runs on the git dir, where work-tree attributes do not apply; info/attributes does, so --text must hold it
  fs.appendFileSync(path.join(w.repo, '.git', 'info', 'attributes'), '*.dat -diff\n');
  w.commit('key.dat', `token=${FAKE_PAT}\n`); // only gitleaks can see this one
  r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /gitleaks github-pat key\.dat:1/);
});

test('denylist word in a binary file path or a pure rename is refused, path not printed', () => {
  const w = world();
  w.commit('plain.txt', 'x\n');
  w.git('mv', 'plain.txt', `${WORD}.txt`); // 100% rename: no hunk, no "+++" line
  w.git('commit', '-q', '-m', 'rename');
  let r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /[0-9a-f]+ path: denylist entry #1/);
  assert.ok(!out(r).includes(WORD));
  w.commit(`${WORD}.bin`, Buffer.from([0, 1, 2, 0, 255]));
  r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.ok(!out(r).includes(WORD));
});

test('annotated tag message in the range is refused; a clean one passes', () => {
  const w = world();
  w.commit('a.txt', 'clean\n');
  w.git('tag', '-a', 'v1', '-m', 'fine release');
  assert.equal(w.check('HEAD~1..HEAD').status, 0);
  w.git('tag', '-a', 'v2', '-m', `release for ${WORD}`);
  const r = w.check('HEAD~1..HEAD');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /tag message [0-9a-f]+: denylist entry #1/);
  assert.ok(!out(r).includes(WORD));
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
