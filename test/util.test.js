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

// security review round 1 HIGH (CRITICAL 1 belt): fetchHead fetches into the tag repo's common dir; a planted
// <common>/.git (a gitfile to a repo whose config maps the source to ssh and names a core.sshCommand) is never its repo
test('security review round 1: fetchHead with a planted <common>/.git never runs the planted config (no sshCommand, no insteadOf) and still fetches into the real repo', async () => {
  const { repo, t } = await ticket('t_util9');
  const sha = commit(t.worktree, 'b.txt', 'agent\n');
  const root = path.dirname(repo), evil = path.join(root, 'evil'), marker = path.join(root, 'PWNED');
  git(root, ['init', '-q', evil]);
  git(evil, ['config', 'core.sshCommand', `touch ${marker}; false`]);
  git(evil, ['config', `url.ssh://evil.invalid${t.git_dir}.insteadOf`, t.git_dir]);
  fs.writeFileSync(path.join(t.common_dir, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
  await util.fetchHead(t, sha);
  assert.equal(fs.existsSync(marker), false, 'the planted sshCommand never ran');
  assert.equal(git(repo, ['rev-parse', `refs/tb/${t.id}/head`]), sha, 'fetched into the real tag repo');
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

// M7: eachLine reads in 64 KB pieces (no readline): lines across a piece edge, CRLF, a last line with no \n, an open
// FileHandle left open, from (its cut first line skipped), pre; a link is never read (as before)
test('M7 eachLine: lines across a 64 KB edge whole, CRLF and a last line without \\n; an open FileHandle stays open; from skips the cut line; pre counts unparsed lines; a link → nothing', async () => {
  const f = path.join(ROOT, 'lines.jsonl');
  const big = { t: 'x', pad: 'é'.repeat(50_000) }; // 100 KB of UTF-8: crosses the first edge
  fs.writeFileSync(f, `${JSON.stringify({ t: 'a', n: 1 })}\n\n${JSON.stringify(big)}\r\n{"t":"torn"\n${JSON.stringify({ t: 'b', n: 2 })}`);
  const seen = [];
  await util.eachLine(f, (v, n) => void seen.push([n, v?.t, v?.pad?.length]));
  assert.deepEqual(seen, [[1, 'a', undefined], [2, 'x', 50_000], [3, undefined, undefined], [4, 'b', undefined]], 'empty line not counted; a torn one counted, undefined');
  const fh = await fs.promises.open(f, 'r');
  const from = [];
  await util.eachLine(fh, (v) => void from.push(v?.t), ['"t":"b"'], { from: 5 });
  assert.deepEqual(from, [undefined, undefined, 'b'], 'from 5: the cut first line skipped; pre: only "b" parsed');
  assert.equal((await fh.stat()).size > 0, true, 'the caller\'s handle is still open');
  await fh.close();
  fs.symlinkSync(f, path.join(ROOT, 'link.jsonl'));
  const none = [];
  await util.eachLine(path.join(ROOT, 'link.jsonl'), (v) => void none.push(v));
  assert.deepEqual(none, []);
});

// Phase 4 Own Worktree (design 3f, 3h): a worktree tbd made (git worktree add --lock -B tb/<id>, as lib/task.js addTree),
// its ticket pin {worktree, git_dir, common_dir, clone: {real, tree, config, alternates}} as the start point takes it
async function tree(id) {
  const root = fs.mkdtempSync(path.join(ROOT, 'tree-'));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'tbhome', 'worktrees', id);
  fs.mkdirSync(repo);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  const base_sha = commit(repo, 'a.txt', 'a\n');
  git(repo, ['worktree', 'add', '-q', '--lock', '-B', `tb/${id}`, wt, base_sha]);
  const common_dir = path.join(repo, '.git'), git_dir = path.join(common_dir, 'worktrees', id);
  const clone = { real: true, tree: true, config: util.realHash(/** @type {string[]} */ (await util.realConfig(common_dir))), alternates: null };
  return { root, repo, wt, git_dir, common_dir, t: { id, worktree: wt, git_dir, common_dir, base_sha, clone } };
}

test('Phase 4 treeLinks + cloneRefused tree branch: a fresh worktree is clean and pinned git runs in it with GIT_COMMON_DIR; a rewritten gitfile, commondir or gitdir file, the git folder moved, linked or replaced, a hard-linked gitfile, a config edit through a hard link and config.worktree switched on are each refused', async () => {
  const fresh = await tree('t_tree01');
  assert.equal(await util.treeLinks(fresh.t), null);
  assert.equal(await util.cloneRefused(fresh.t), null);
  assert.equal(util.cfgDir(fresh.t), fresh.common_dir, 'an Own Worktree Task\'s config lives in the common dir');
  const r = await util.git(fresh.wt, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'], { dirs: fresh.t });
  assert.deepEqual([r.err, r.stdout.trim().split('\n')], [null, [fresh.git_dir, fresh.common_dir, 'tb/t_tree01']]);
  // a fake git folder an agent made: what a rewritten link would point Irfan's git at
  const fake = (root) => { const d = path.join(root, 'fake.git'); fs.mkdirSync(path.join(d, 'refs'), { recursive: true }); fs.writeFileSync(path.join(d, 'HEAD'), 'ref: refs/heads/main\n'); return d; };
  /** @type {[string, (x: any) => void, RegExp][]} */
  const cases = [
    ['gitfile rewritten', (x) => fs.writeFileSync(path.join(x.wt, '.git'), `gitdir: ${fake(x.root)}\n`), /\.git does not lead to /],
    ['commondir rewritten', (x) => fs.writeFileSync(path.join(x.git_dir, 'commondir'), `${path.dirname(fake(x.root))}\n`), /commondir does not lead to /],
    ['gitdir file rewritten', (x) => fs.writeFileSync(path.join(x.git_dir, 'gitdir'), `${path.join(x.root, 'elsewhere', '.git')}\n`), /gitdir does not name /],
    ['git folder moved away', (x) => fs.renameSync(x.git_dir, `${x.git_dir}.x`), /is not a real folder in /],
    ['git folder a link', (x) => { fs.renameSync(x.git_dir, `${x.git_dir}.x`); fs.symlinkSync(`${x.git_dir}.x`, x.git_dir); }, /is not a real folder in /],
    ['git folder replaced (no commondir: git would read its own config)', (x) => {
      fs.renameSync(x.git_dir, `${x.git_dir}.x`);
      fs.mkdirSync(x.git_dir);
      for (const f of ['HEAD', 'gitdir']) fs.copyFileSync(path.join(`${x.git_dir}.x`, f), path.join(x.git_dir, f));
      fs.writeFileSync(path.join(x.git_dir, 'config'), '[core]\n\tfsmonitor = /tmp/x\n');
    }, /commondir does not lead to /],
    ['gitfile hard-linked', (x) => fs.linkSync(path.join(x.wt, '.git'), path.join(x.wt, 'gf')), /is not a plain file with one link/],
    ['config edited through a hard link', (x) => { fs.linkSync(path.join(x.common_dir, 'config'), path.join(x.wt, 'cfg')); fs.appendFileSync(path.join(x.wt, 'cfg'), '[core]\n\tfsmonitor = /tmp/x\n'); }, /config changed since the Task started/],
    ['commondir planted in the common dir (git would read refs and config from where it points)', (x) => fs.writeFileSync(path.join(x.common_dir, 'commondir'), `${path.dirname(fake(x.root))}\n`), /\.git\/commondir exists/],
    ['config.worktree switched on', (x) => { fs.writeFileSync(path.join(x.git_dir, 'config.worktree'), '[core]\n\tfsmonitor = /tmp/x\n'); git(x.repo, ['config', 'extensions.worktreeConfig', 'true']); }, /config changed since the Task started/],
  ];
  for (const [name, harm, why] of cases) {
    const x = await tree('t_tree02');
    harm(x);
    assert.match(String(await util.cloneRefused(x.t)), why, name);
    const g = await util.git(x.wt, ['rev-parse', 'HEAD'], { dirs: x.t });
    assert.deepEqual([g.err?.code, g.stdout], ['PLANTED', ''], `${name}: pinned git refused, nothing run`);
  }
  // design 3f: config.worktree alone is inert (git reads it only with extensions.worktreeConfig, which the pin watches)
  const inert = await tree('t_tree03');
  fs.writeFileSync(path.join(inert.git_dir, 'config.worktree'), '[core]\n\tfsmonitor = /tmp/x\n');
  assert.equal(await util.cloneRefused(inert.t), null);
});

// Phase 4 security review CRITICAL 1: a planted <common>/.git (the repo of any git run in <common> without GIT_DIR)
test('security review CRITICAL 1: cloneRefused refuses an Own Worktree Task when <common>/.git exists (file, folder or link), not when absent; git with bare pins GIT_DIR = cwd, so a planted .git/.git is never read', async () => {
  const clean = await tree('t_nest01');
  assert.equal(await util.cloneRefused(clean.t), null, 'absent: not refused');
  /** @type {[string, (p: string, x: any) => void][]} */
  const plants = [['a gitfile', (p, x) => fs.writeFileSync(p, `gitdir: ${x.root}\n`)], ['a folder', (p) => fs.mkdirSync(p)], ['a link', (p, x) => fs.symlinkSync(x.root, p)]];
  for (const [name, plant] of plants) {
    const x = await tree('t_nest02');
    plant(path.join(x.common_dir, '.git'), x);
    assert.equal(await util.cloneRefused(x.t), `${x.common_dir}/.git exists`, name);
  }
  // the review's proof: git -C <repo>/.git reads a planted .git/.git's config; the bare pin reads the real one
  const x = await tree('t_nest03');
  git(x.repo, ['config', 'probe.where', 'main']);
  const evil = path.join(x.root, 'evil');
  git(x.root, ['init', '-q', evil]);
  git(evil, ['config', 'probe.where', 'PLANTED']);
  fs.writeFileSync(path.join(x.common_dir, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
  const get = (o) => util.git(x.common_dir, ['config', '--get', 'probe.where'], o).then((r) => r.stdout.trim());
  assert.equal(await get({}), 'PLANTED', 'unpinned: the planted repo (the attack)');
  assert.equal(await get({ bare: true }), 'main', 'bare: the real repo');
});

// Phase 4 security review HIGH 2: links in <common>/worktrees, which git worktree prune follows and empties
test('security review HIGH 2: plantedLinks unlinks a link entry and a gitdir link in <common>/worktrees (their targets untouched) and returns their names; real worktree entries stay; no worktrees folder → []', async () => {
  const x = await tree('t_plnk01');
  const target = path.join(x.root, 'precious');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x\n');
  const wts = path.join(x.common_dir, 'worktrees');
  fs.symlinkSync(target, path.join(wts, 'evil'));
  fs.mkdirSync(path.join(wts, 'fake'));
  fs.symlinkSync(path.join(target, 'keep'), path.join(wts, 'fake', 'gitdir'));
  assert.deepEqual((await util.plantedLinks(x.common_dir)).sort(), ['worktrees/evil', 'worktrees/fake/gitdir']);
  assert.deepEqual([fs.existsSync(path.join(wts, 'evil')), fs.existsSync(path.join(wts, 'fake', 'gitdir'))], [false, false], 'the links are gone');
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x\n', 'their target stays');
  // negative: the Task's own entry is a real folder with a real gitdir file
  const y = await tree('t_plnk02');
  assert.deepEqual(await util.plantedLinks(y.common_dir), []);
  assert.equal(await util.treeLinks(y.t), null, 'its own entry untouched');
  assert.deepEqual(await util.plantedLinks(path.join(x.root, 'nowhere')), []);
});
