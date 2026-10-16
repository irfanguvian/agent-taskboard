'use strict';
// H (lane A1) lib/util.js on real temp git repos: fetchHead / fetchCommit (H2.4, C1 D-0152) with the trusted pin (H2.2),
// cloneAt from a parent clone (H2.6 lanes), GIT_SAFE's no-gc flags (H2.2, spike S4 data loss) and envBlock (H3 D-0153).
// The clone pin's own refusals (PLANTED) are in spawn.test.js, through dirtyPaths.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const util = require('../lib/util');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'util-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const GENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, input = undefined) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { env: GENV, encoding: 'utf8', input }).trim();
const has = (cwd, ...args) => { try { git(cwd, args); return true; } catch { return false; } };
const AS = ['-c', 'user.name=a', '-c', 'user.email=a@example.invalid'];
function commit(cwd, file, text) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, ['add', '--', file]);
  git(cwd, [...AS, 'commit', '-qm', file]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A tag repo (one commit, its base pin refs/tb/<id>/base as assign makes it) and the ticket's clone: {repo, t}
async function ticket(id) {
  const root = fs.mkdtempSync(path.join(ROOT, 'tag-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  const base_sha = commit(repo, 'a.txt', 'a\n');
  git(repo, ['update-ref', `refs/tb/${id}/base`, base_sha]);
  const common_dir = path.join(repo, '.git');
  const wt = path.join(root, 'wt');
  return { repo, t: { id, worktree: wt, base_sha, common_dir, ...(await util.cloneAt(common_dir, wt, base_sha)) } };
}

test('H2.4 C1 fetchHead: an agent commit (only in its clone) is not seen by a trusted read (tag objects only) until fetched; then tag refs/tb/<id>/head = it and the trusted read sees it; a later head moves the ref', async () => {
  const { repo, t } = await ticket('t_util1');
  const sha = commit(t.worktree, 'b.txt', 'agent\n');
  const show = async (o) => ((r) => ({ ok: !r.err, out: r.stdout }))(await util.git(t.worktree, ['cat-file', '-p', `${sha}:b.txt`], { dirs: t, ...o }));
  assert.deepEqual(await show({}), { ok: true, out: 'agent\n' }, 'untrusted: the clone reads its own objects');
  assert.deepEqual(await show({ dirs: { ...t, trusted: true } }), { ok: false, out: '' }, 'trusted: tag objects only, fail closed');
  await util.fetchHead(t, sha);
  assert.equal(git(repo, ['rev-parse', `refs/tb/${t.id}/head`]), sha);
  assert.deepEqual(await show({ trusted: true }), { ok: true, out: 'agent\n' });
  const next = commit(t.worktree, 'c.txt', 'more\n');
  await util.fetchHead(t, next);
  assert.equal(git(repo, ['rev-parse', `refs/tb/${t.id}/head`]), next, 're-gate: the ref is forced to the new head');
});

test('H2.4 fetchHead refuses: a blob whose loose file holds other content (index-pack), a tree entry .GIT (fsck), a source clone whose config changed (PLANTED); nothing lands in the tag repo', async () => {
  const { repo, t } = await ticket('t_util2');
  const ref = `refs/tb/${t.id}/head`;
  const forged = commit(t.worktree, 'c.txt', 'claimed\n');
  const blob = path.join(t.git_dir, 'objects', ...((b) => [b.slice(0, 2), b.slice(2)])(git(t.worktree, ['rev-parse', 'HEAD:c.txt'])));
  fs.chmodSync(blob, 0o644);
  fs.writeFileSync(blob, zlib.deflateSync(Buffer.from('blob 13\0evil content\n')));
  await assert.rejects(util.fetchHead(t, forged), /did not receive expected object/);
  const dotgit = git(t.worktree, [...AS, 'commit-tree', git(t.worktree, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'],
    Buffer.concat([Buffer.from('100644 .GIT\0'), Buffer.from(git(t.worktree, ['hash-object', '-w', '--stdin'], 'x'), 'hex')])), '-m', 'dotgit']);
  await assert.rejects(util.fetchHead(t, dotgit), /hasDotgit/);
  assert.deepEqual([has(repo, 'rev-parse', '--verify', '-q', ref), has(repo, 'cat-file', '-e', forged), has(repo, 'cat-file', '-e', dotgit)], [false, false, false]);
  fs.appendFileSync(path.join(t.git_dir, 'config'), '[uploadpack]\n\tallowAnySHA1InWant = true\n');
  await assert.rejects(util.fetchHead(t, t.base_sha), (/** @type {any} */ e) => e.code === 'PLANTED' && /config is not the one tbd wrote/.test(e.message));
  assert.equal(has(repo, 'rev-parse', '--verify', '-q', ref), false);
});

test('H2.6 cloneAt from a parent clone: at the parent base, no checkout, then the parent commit (only in the parent clone) fetched and checked out detached, no refs; a sha the parent lacks or no commit name → throws', async () => {
  const { t } = await ticket('t_util3');
  const pre = commit(t.worktree, 'p.txt', 'parent\n');
  const lane = path.join(path.dirname(t.worktree), 'lane');
  const l = await util.cloneAt(t.common_dir, lane, pre, { from: t, alt: `refs/tb/${t.id}/` });
  assert.deepEqual([git(lane, ['rev-parse', 'HEAD']), git(lane, ['for-each-ref']), fs.readFileSync(path.join(lane, 'p.txt'), 'utf8')], [pre, '', 'parent\n']);
  assert.equal(l.git_dir, path.join(lane, '.git'));
  await assert.rejects(util.cloneAt(t.common_dir, `${lane}2`, 'f'.repeat(40), { from: t }), /not a commit in/);
  await assert.rejects(util.cloneAt(t.common_dir, `${lane}3`, 'HEAD'), /not a commit name/);
});

test('H2.2 GIT_SAFE: a repo config with gc.auto=1 + gc.pruneExpire=now never makes git tbd runs gc (an unreachable object stays)', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'gc-'));
  git(dir, ['init', '-q']);
  const orphan = git(dir, ['hash-object', '-w', '--stdin'], 'orphan\n');
  fs.appendFileSync(path.join(dir, '.git/config'), '[gc]\n\tauto = 1\n\tpruneExpire = now\n\tautoDetach = false\n');
  fs.mkdirSync(path.join(dir, '.git/objects/17'), { recursive: true });
  for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(dir, '.git/objects/17', String(n).repeat(38)), 'x'); // past gc.auto's loose count
  const r = await util.git(dir, [...AS, 'commit', '-q', '--allow-empty', '-m', 'x']);
  assert.equal(r.err, null, r.stderr);
  assert.equal(has(dir, 'cat-file', '-e', orphan), true, 'the unreachable object is still there');
});

test('H3 envBlock: a SECRET-named value of 4+ that is no boolean, digits or password-less URL; every URL password (raw + decoded) under any key; longest first; an env file it cannot read → throws', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'env-'));
  fs.writeFileSync(path.join(dir, '.env'), [
    'API_TOKEN=s3cr3tvalue1', 'AUTH_TRUST_HOST=true', 'SESSION_TTL=3600', 'NODE_ENV=development', 'X_KEY=abc',
    'AUTH_URL=https://example.com/auth', 'DB_PASSWORD_URL=mysql://u:pw12345@h/db',
    'DATABASE_URL=postgres://u:p%40ss@localhost/db', 'REDIS=redis://:longpass1@h:6379 # cache', 'ODD=postgres://u:%E0%A4%A@h/db',
    'GH_TOKEN_URL=https://ghp_abc123@github.com/r', 'RAW_URL=postgres://u:pa/ss@h/db', // S-L2: a token as the user name; a URL WHATWG refuses
  ].join('\n'));
  assert.deepEqual(await util.envBlock({ path: dir, env_files: ['.env'] }),
    ['https://ghp_abc123@github.com/r', 'mysql://u:pw12345@h/db', 's3cr3tvalue1', 'longpass1', '%E0%A4%A', 'pw12345', 'p%40ss', 'pa/ss', 'p@ss']);
  await assert.rejects(util.envBlock({ path: dir, env_files: ['missing.env'] }), /not a plain file/);
});
