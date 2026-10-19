'use strict';
// board-terminal-parity Phase 4 Lane B (contract section 5 grantOk): every Task push from tb-git is leak-scanned first;
// Commit and Push's grant lets exactly one push through with no card, for exactly its run gen, remote, branch and files;
// anything else is a card (Irfan decides) or, when the folder changed or the scan fails, refused. In-process: the store
// on a temp TB_HOME, a real git repo with the Task's real pin; the folder check and the leak scan stubbed by property
// (grantOk calls them so), their own tests live in test/task.test.js and test/push.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tact-')));
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
process.env.TB_HOME = home; // before any lib/ module loads the store

test('Phase 4 grantOk: another gen, branch or a file outside the grant → card; a failed leak scan or a changed folder → refused; the grant → allow once, then a card; every push scanned', async () => {
  const repo = path.join(home, 'shop');
  fs.mkdirSync(repo);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (/** @type {string[]} */ ...a) => execFileSync('/usr/bin/git', ['-C', repo, ...a], { env, encoding: 'utf8' }).trim();
  const commit = (/** @type {string} */ file, /** @type {string} */ msg) => {
    fs.writeFileSync(path.join(repo, file), msg);
    git('add', file);
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://example.invalid/shop.git');
  const head = commit('cart.js', 'base');
  const sha = commit('cart.js', 'the task change');
  const more = commit('price.js', 'not the task');
  const util = require('../lib/util');
  const g = path.join(repo, '.git');
  const id = 't_tact01';
  fs.mkdirSync(path.join(home, 'tickets', id), { recursive: true });
  fs.writeFileSync(path.join(home, 'tickets', id, 'ticket.json'), JSON.stringify({
    id, type: 'ticket', kind: 'task', state: 'working', title: 'x', text: 'x', worktree: repo, git_dir: g, common_dir: g, base_sha: head,
    clone: { real: true, config: util.realHash(/** @type {string[]} */ (await util.realConfig(g))), alternates: null },
    push_grant: { remote: 'origin', branch: 'feat', at: '2026-10-19T00:00:00.000Z', gen: 3, head, files: ['cart.js'] },
  }));
  const store = require('../lib/store');
  store.init();
  const task = require('../lib/task'), push = require('../lib/push');
  /** @type {string[]} */ let changed = [];
  let scan = /** @type {any} */ ({ ok: true }), scans = 0;
  Object.assign(task, { check: async () => changed, block: async () => ({}), why: (/** @type {string[]} */ r) => r.join('; ') });
  push.leakScan = async () => { scans++; return scan; };
  const { grantOk } = require('../lib/task-actions');
  const ask = (/** @type {object} */ o) => grantOk(store.getTicket(id), { gen: 3, remote: 'origin', branch: 'feat', sha, ...o });

  assert.equal(await ask({ gen: 4 }), 'card', 'another run of the ticket');
  assert.equal(await ask({ branch: 'other' }), 'card', 'another branch');
  git('update-ref', 'refs/remotes/origin/x', more); // security re-check HIGH: a remote-tracking ref the agent wrote is not the remote
  assert.equal(await ask({ sha: more }), 'card', 'the push also carries price.js: not the Task\'s file');
  scan = { ok: false, why: 'leak', msg: 'a denylisted word' };
  assert.deepEqual(await ask({}), { deny: 'leak: a denylisted word' }, 'the scan comes before the grant');
  scan = { ok: true };
  changed = ['.mcp.json changed since the Task started'];
  assert.deepEqual(await ask({}), { deny: '.mcp.json changed since the Task started' }, 'the folder check first');
  changed = [];
  assert.equal(await ask({}), 'allow', 'exactly the grant: no card');
  assert.equal(store.getTicket(id).push_grant, undefined, 'the grant is taken');
  assert.equal(await ask({}), 'card', 'single use: the same push again is a card');
  assert.equal(scans, 6, 'every push that got past the folder check was leak-scanned');
});
