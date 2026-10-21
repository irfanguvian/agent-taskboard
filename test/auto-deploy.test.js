'use strict';
// Auto deploy after a push of main (D-0242): scripts/reference-transaction (hook body) + scripts/auto-deploy, end to end
// on a temp HOME. The world: a bare "origin", a dev repo whose package.json gate scripts are tiny (gate.js: red when a
// RED-<step> file is in the commit), a live worktree made by the real scripts/deploy. launchctl, free memory and the
// Mac notification are fakes; deploy and deploy-guard are the real ones (no tbd token: the guard passes offline).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO } = require('./helpers/tbd');

const SCRIPTS = path.join(REPO, 'scripts');
const ZERO = '0'.repeat(40);
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (r) => `${r.stdout}${r.stderr}`;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
async function until(fn, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return;
  assert.fail(`not met in ${ms} ms`);
}

// gate.js <step>: red when RED-<step> is in the export. test + NEWER_SHA: push NEWER_SHA as main from DEV (the real hook
// fires) and wait until auto-deploy.want holds it: a newer push lands while this gate runs.
const GATE_JS = `const fs = require('fs'), { execFileSync } = require('child_process');
const step = process.argv[2];
if (fs.existsSync('RED-' + step)) process.exit(1);
// MOVE_TO: GitHub main is force-pushed to it while the gate runs (no hook here)
if (step === 'test' && process.env.MOVE_TO) execFileSync('git', ['-C', process.env.DEV, 'push', '-qf', 'origin', process.env.MOVE_TO + ':refs/heads/main']);
const { NEWER_SHA: n, DEV: dev, HOME: home } = process.env;
const want = home + '/.taskboard/auto-deploy.want';
const now = () => { try { return fs.readFileSync(want, 'utf8').trim(); } catch { return ''; } };
if (step === 'test' && n && now() !== n) {
  execFileSync('git', ['-C', dev, 'update-ref', 'refs/heads/main', n]);
  execFileSync('git', ['-C', dev, 'push', '-q', 'origin', 'main']);
  const end = Date.now() + 20000;
  while (now() !== n) { if (Date.now() > end) process.exit(1); execFileSync('sleep', ['0.1']); }
}
`;
const PKG = JSON.stringify({ name: 'w', private: true, scripts: { lint: 'node gate.js lint', typecheck: 'node gate.js typecheck', test: 'node gate.js test' } });

function world({ node = process.execPath } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-deploy-'));
  roots.push(root);
  const home = path.join(root, 'home'), dev = path.join(root, 'dev'), origin = path.join(root, 'origin.git');
  const stub = path.join(root, 'stub'), lc = path.join(root, 'lc');
  for (const d of [home, stub, lc, path.join(dev, 'scripts'), path.join(dev, 'node_modules')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'helpers', 'fake-launchctl'), path.join(stub, 'launchctl'));
  fs.chmodSync(path.join(stub, 'launchctl'), 0o755);
  fs.writeFileSync(path.join(stub, 'notify'), `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "${root}/notify.log"\n`, { mode: 0o755 });
  const env = {
    PATH: `${stub}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: '1', FAKE_LC_DIR: lc, TB_NODE: node,
    TB_RAM_CMD: 'echo 50', TB_NOTIFY_CMD: path.join(stub, 'notify'), TB_RETRY_S: '0', DEV: dev,
  };
  const sh = (cmd, args, extra = {}) => spawnSync(cmd, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
  const git = (...args) => {
    const r = sh('git', ['-C', dev, ...args]);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  for (const f of ['deploy', 'deploy-guard.js', 'live-lib.sh', 'auto-deploy', 'reference-transaction', 'install-git-hooks']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dev, 'scripts', f));
  fs.writeFileSync(path.join(dev, 'gate.js'), GATE_JS);
  fs.writeFileSync(path.join(dev, 'package.json'), PKG);
  fs.writeFileSync(path.join(dev, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dev, '.gitignore'), 'node_modules/\n');
  assert.equal(sh('git', ['init', '-q', '--bare', '-b', 'main', origin]).status, 0);
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.invalid'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git('config', k, v);
  git('remote', 'add', 'origin', origin);
  const commit = (file, text = 'x\n') => {
    fs.writeFileSync(path.join(dev, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const sha1 = commit('VERSION', '1\n');
  git('push', '-q', 'origin', 'main');
  const first = sh(path.join(dev, 'scripts', 'deploy'), [sha1, '--yes', '--no-restart']);
  assert.equal(first.status, 0, out(first));
  const live = path.join(home, 'taskboard-live'), tbHome = path.join(home, '.taskboard');
  return {
    root, home, dev, live, tbHome, sha1, git, commit, sh,
    run: (sha, extra) => sh(path.join(live, 'scripts', 'auto-deploy'), [sha], extra),
    head: () => spawnSync('git', ['-C', live, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    notes: () => lines(path.join(root, 'notify.log')),
    kicks: () => lines(path.join(lc, 'log')).filter((l) => l.startsWith('kickstart')),
    log: () => fs.readFileSync(path.join(tbHome, 'auto-deploy.log'), 'utf8'),
    deploys: () => lines(path.join(tbHome, 'deploy.log')),
    installHook: () => fs.copyFileSync(path.join(SCRIPTS, 'reference-transaction'), path.join(dev, '.git', 'hooks', 'reference-transaction')),
  };
}

test('hook: a committed origin/main move starts the live auto-deploy with the new sha; other refs, prepared, a zero sha do not; exit 0 always', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hook-'));
  roots.push(root);
  const home = path.join(root, 'home'), called = path.join(root, 'called');
  const hook = (phase, input, h = home) => spawnSync(path.join(SCRIPTS, 'reference-transaction'), [phase], { input, env: { PATH: process.env.PATH, HOME: h }, encoding: 'utf8' });
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  // no live copy yet: nothing to start, still 0
  assert.equal(hook('committed', `${A} ${B} refs/remotes/origin/main\n`).status, 0);
  fs.mkdirSync(path.join(home, 'taskboard-live', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'taskboard-live', 'scripts', 'auto-deploy'), `#!/bin/sh\necho "$1" >> "${called}"\n`, { mode: 0o755 });
  for (const [phase, input] of [
    ['committed', `${A} ${B} refs/remotes/origin/tb/x\n${A} ${B} refs/heads/main\n`],
    ['prepared', `${A} ${B} refs/remotes/origin/main\n`],
    ['aborted', `${A} ${B} refs/remotes/origin/main\n`],
    ['committed', `${A} ${ZERO} refs/remotes/origin/main\n`],
  ]) assert.deepEqual([phase, hook(phase, input).status], [phase, 0]);
  const r = hook('committed', `${A} ${B} refs/heads/main\n${A} ${C} refs/remotes/origin/main\n`);
  assert.equal(r.status, 0, out(r));
  await until(() => lines(called).length > 0);
  await sleep(300); // a wrong start from an earlier case would have landed by now
  assert.deepEqual(lines(called), [C], 'started once, with the new origin/main sha only');

  // real git: install-git-hooks puts both hooks in; a push of main fires it with the pushed sha
  const w = world();
  fs.mkdirSync(path.join(w.live, 'scripts'), { recursive: true });
  fs.rmSync(path.join(w.live, 'scripts', 'auto-deploy'));
  fs.writeFileSync(path.join(w.live, 'scripts', 'auto-deploy'), `#!/bin/sh\necho "$1" >> "${w.root}/called"\n`, { mode: 0o755 });
  const inst = spawnSync(path.join(SCRIPTS, 'install-git-hooks'), [], { cwd: w.dev, env: { PATH: process.env.PATH, HOME: w.home }, encoding: 'utf8' });
  assert.equal(inst.status, 0, out(inst));
  for (const h of ['pre-push', 'reference-transaction']) assert.equal(fs.statSync(path.join(w.dev, '.git', 'hooks', h)).mode & 0o777, 0o755, h);
  fs.rmSync(path.join(w.dev, '.git', 'hooks', 'pre-push')); // the leak gate has its own tests (no denylist here)
  const sha2 = w.commit('two');
  w.git('push', '-q', 'origin', 'main');
  await until(() => lines(path.join(w.root, 'called')).length > 0);
  assert.deepEqual(lines(path.join(w.root, 'called')), [sha2]);
});

test('belt: a bad sha, a sha already live, GitHub main != sha, local main != sha (a commit made elsewhere) → no deploy', () => {
  const w = world();
  const bad = w.run('xyz');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: auto-deploy <40-hex sha>/);
  assert.equal(w.run(w.sha1).status, 0);
  assert.match(w.log(), new RegExp(`${w.sha1.slice(0, 7)}: already live`));
  const sha2 = w.commit('two'); // committed, not pushed
  assert.equal(w.run(sha2).status, 0);
  assert.match(w.log(), new RegExp(`${sha2.slice(0, 7)}: GitHub main is ${w.sha1.slice(0, 7)}, not this sha: no deploy`));
  w.git('push', '-q', 'origin', 'main');
  w.git('update-ref', 'refs/heads/main', w.sha1); // GitHub main = sha2, local main is not
  assert.equal(w.run(sha2).status, 0);
  assert.match(w.log(), new RegExp(`${sha2.slice(0, 7)}: local main is not this sha \\(a commit made elsewhere\\): no deploy`));
  assert.equal(w.head(), w.sha1);
  assert.deepEqual([w.kicks(), w.notes(), w.deploys().length], [[], [], 1]);
  assert.equal(fs.existsSync(path.join(w.tbHome, 'auto-deploy.want')), false, 'refused before it is wanted');
});

test('gate red (failing lint, typecheck or test in the sha) → no deploy, one notification each', () => {
  const w = world();
  for (const step of ['lint', 'typecheck', 'test']) {
    const sha = w.commit(`RED-${step}`);
    w.git('push', '-q', 'origin', 'main');
    const r = w.run(sha);
    assert.equal(r.status, 0, out(r));
    assert.equal(w.head(), w.sha1, step);
    assert.equal(w.notes().at(-1), `Auto deploy: gate failed|${sha.slice(0, 7)} not deployed: npm run ${step} failed`);
    assert.match(w.log(), new RegExp(`gate failed: npm run ${step}; last lines:`));
    w.git('rm', '-q', `RED-${step}`); // the next step's sha is red only by its own file
    w.git('commit', '-q', '-m', `green ${step}`);
  }
  assert.deepEqual([w.kicks(), w.notes().length], [[], 3]);
  assert.doesNotMatch(w.log(), /deployed/);
});

test('gate green → deploy of the sha + notification with the rollback sha; the hook\'s GIT_DIR is dropped; gate export gone, dev node_modules kept', () => {
  const w = world();
  const sha2 = w.commit('two');
  w.git('push', '-q', 'origin', 'main');
  const r = w.run(sha2, { GIT_DIR: path.join(w.root, 'nowhere'), GIT_WORK_TREE: w.root });
  assert.equal(r.status, 0, out(r));
  assert.equal(w.head(), sha2);
  assert.equal(w.kicks().length, 1, 'tbd restarted once');
  assert.deepEqual(w.notes(), [`Auto deploy: deployed ${sha2.slice(0, 7)}|scripts/deploy ${w.sha1}`]);
  assert.match(w.deploys().at(-1), new RegExp(` ${w.sha1} -> ${sha2}$`));
  assert.ok(fs.statSync(path.join(w.dev, 'node_modules')).isDirectory(), 'the linked node_modules survives the cleanup');
  assert.deepEqual(fs.readdirSync(w.tbHome).filter((f) => f.startsWith('auto-deploy-gate') || f === 'auto-deploy.lock'), []);
  assert.deepEqual(fs.readdirSync(path.join(w.dev, '.git', 'worktrees')), ['taskboard-live'], 'the gate made no .git/worktrees entry');
  assert.equal(fs.statSync(path.join(w.tbHome, 'auto-deploy.log')).mode & 0o777, 0o600);
});

test('GitHub main force-pushed away during the gate → the gated sha is not deployed', () => {
  const w = world();
  const sha2 = w.commit('two');
  w.git('push', '-q', 'origin', 'main');
  const r = w.run(sha2, { MOVE_TO: w.sha1 });
  assert.equal(r.status, 0, out(r));
  assert.equal(w.head(), w.sha1);
  assert.match(w.log(), new RegExp(`${sha2.slice(0, 7)}: gate green\\n.*${sha2.slice(0, 7)}: GitHub main is ${w.sha1.slice(0, 7)}, not this sha: no deploy`));
  assert.deepEqual([w.kicks(), w.notes()], [[], []]);
});

test('deploy-guard refuses twice, then passes → deployed on the third try', () => {
  // TB_NODE wrapper: deploy-guard.js "refuses" (exit 1, like flows at work) the first 2 calls, else the real node
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-node-'));
  roots.push(dir);
  const count = path.join(dir, 'count');
  fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh
case \${1:-} in *deploy-guard.js)
  n=$(cat "${count}" 2>/dev/null || echo 0)
  if [ "$n" -lt 2 ]; then echo $((n + 1)) > "${count}"; echo "deploy-guard: flows at work: t_rev001 (review)" >&2; exit 1; fi ;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(count, '2'); // the world's own first deploy goes through the wrapper too: let it pass
  const w = world({ node: path.join(dir, 'node') });
  fs.rmSync(count);
  const sha2 = w.commit('two');
  w.git('push', '-q', 'origin', 'main');
  const r = w.run(sha2);
  assert.equal(r.status, 0, out(r));
  assert.equal(w.head(), sha2);
  assert.equal(w.log().match(/deploy-guard refused \(flows at work\): retry in 0 s/g)?.length, 2);
  assert.deepEqual(w.notes(), [`Auto deploy: deployed ${sha2.slice(0, 7)}|scripts/deploy ${w.sha1}`]);
});

test('a newer pushed sha arriving during the gate wins: it is deployed, the older one never', () => {
  const w = world();
  const sha2 = w.commit('two');
  const sha3 = w.commit('three');
  w.git('update-ref', 'refs/heads/main', sha2);
  w.git('push', '-q', 'origin', 'main');
  w.installHook(); // from now on a push of main starts the live auto-deploy, like on Irfan's Mac
  const r = w.run(sha2, { NEWER_SHA: sha3 });
  assert.equal(r.status, 0, out(r));
  assert.equal(w.head(), sha3);
  assert.ok(w.deploys().every((l) => !l.endsWith(`-> ${sha2}`)), w.deploys().join('\n'));
  assert.match(w.deploys().at(-1), new RegExp(` ${w.sha1} -> ${sha3}$`));
  assert.match(w.log(), new RegExp(`${sha2.slice(0, 7)}: a newer sha is wanted: skipping this one`));
  assert.match(w.log(), new RegExp(`${sha3.slice(0, 7)}: another auto-deploy runs: it takes this sha next`));
  assert.deepEqual(w.notes(), [`Auto deploy: deployed ${sha3.slice(0, 7)}|scripts/deploy ${w.sha1}`]);
});
