'use strict';
// board-terminal-parity Phase 2 task 5: bin/tb-git, the git bridge (lib/tbgit.js). Unit: its word check and git's env.
// Integration: a real tbd with terminal.git_bridge on runs a ticket clone (util.cloneAt, the tag's origin copied in) whose
// fake claude calls the real bin/tb-git under the run's real git profile (sandbox-exec) against a local bare remote
// (TB_GIT_FILE_REMOTE: the test-only file protocol); the push waits for the Approve card Irfan answers on the board.
// Security review H1 (contract change: a push only from a code ticket, its own tb/<id>… branch; the card lists the files),
// L2 (approve.ask without the run's ask_token), L9 (a clone target through a planted link). Code review L-tests: L8 (a pull
// whose fetched tip touches .claude/), the run's key polled on tbd.sock instead of a fixed sleep.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, lines, until, reap, pidsOf } = require('./helpers/runs');
const { parse, gitEnv, Refused } = require('../lib/tbgit');
const { cloneAt, cloneConfig } = require('../lib/util');

test('tb-git words: fetch, pull, push, ls-remote in the bridge\'s shapes; an unknown flag, a push without a branch or to the base, clone ext::sh refused; git\'s env from the run file, never the caller\'s', () => {
  const run = { base: 'main', ticket: 't_x00001', kind: 'code', home: '/Users/x', user: 'x', lang: 'en_US.UTF-8', ssh_auth_sock: '/private/tmp/com.apple.launchd.a/Listeners' };
  assert.deepEqual(parse(['fetch', 'origin'], run), { verb: 'fetch', remote: 'origin', branch: null });
  assert.deepEqual(parse(['pull', 'origin', 'feat', '--rebase'], run), { verb: 'pull', remote: 'origin', branch: 'feat', mode: '--rebase' });
  assert.deepEqual(parse(['push', 'origin', 'tb/t_x00001-feat'], run), { verb: 'push', remote: 'origin', branch: 'tb/t_x00001-feat' });
  assert.deepEqual(parse(['ls-remote', 'origin'], run), { verb: 'ls-remote', remote: 'origin' });
  /** @type {[string[], RegExp][]} */
  const refused = [[['fetch', 'origin', '--upload-pack=/bin/sh'], /fetch takes no --upload-pack/], [['push', 'origin'], /usage: tb-git push <remote> <branch>/],
    [['push', 'origin', 'main'], /push to the base branch main is refused/], [['clone', 'ext::sh -c touch% /tmp/x', 'd'], /clone takes an ssh or https URL/]];
  for (const [argv, why] of refused) assert.throws(() => parse(argv, run), why, argv.join(' '));
  // Phase 4: a Task pushes only its own branches (git.json own), never the base
  const task = { ...run, kind: 'task', own: ['feat', 'tb/t_x00001'] };
  assert.deepEqual(parse(['push', 'origin', 'feat'], task), { verb: 'push', remote: 'origin', branch: 'feat' });
  assert.throws(() => parse(['push', 'origin', 'other'], task), /push only this Task's branch feat or tb\/t_x00001, not other/);
  assert.throws(() => parse(['push', 'origin', 'main'], task), /push to the base branch main is refused/);
  const caller = { ...process.env };
  Object.assign(process.env, { GIT_SSH_COMMAND: '/bin/sh -c "touch /tmp/x"', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_CONFIG_COUNT: '1' });
  try {
    assert.deepEqual(gitEnv(run), { HOME: '/Users/x', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', USER: 'x', SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.a/Listeners', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' });
  } finally {
    for (const k of ['GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'GIT_CONFIG_COUNT']) if (caller[k] === undefined) delete process.env[k]; else process.env[k] = caller[k];
  }
});

const GENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();

test('tb-git in a run (real profile, local bare remote): fetch ok; push to the base, to a non-tb/ branch or touching .github/ refused before any card; push of its own branch waits for the Approve card listing its files, lands after Yes; an unknown remote URL → a card first, No refuses; a clone through a planted link, an approve.ask without the ask_token and a pull bringing in .claude/ refused, no card', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-')));
  const tbHome = path.join(root, 'tbhome');
  const remote = path.join(root, 'remote.git'), repo = path.join(root, 'repo'), wt = path.join(tbHome, 'worktrees', 't_git001');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(root, 'init', '-q', '--bare', remote);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  // L8: a remote branch that plants a .claude/ settings file (what tb-git pull would merge in)
  git(repo, 'checkout', '-q', '-b', 'evil');
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'evil');
  git(repo, 'push', '-q', 'origin', 'evil');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', '-q', '-D', 'evil');
  const common = fs.realpathSync(path.join(repo, '.git'));
  const { git_dir } = await cloneAt(common, wt, base, { remote: { url: remote } });
  git(wt, 'checkout', '-q', '-b', 'tb/t_git001-ci');
  fs.mkdirSync(path.join(wt, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.github', 'workflows', 'x.yml'), 'on: push\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'ci');
  git(wt, 'checkout', '-q', '-b', 'tb/t_git001-feat', base);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feat');
  git(wt, 'branch', 'feat'); // the same commit on a branch that is not this ticket's
  const feat = git(wt, 'rev-parse', 'HEAD');
  git(wt, 'config', '--file', path.join(git_dir, 'config'), 'remote.other.url', 'git@example.invalid:x/y.git'); // no board tag's remote
  const clone = await cloneConfig(git_dir); // tbd's pin, after its last write
  const TB_GIT = path.join(REPO, 'bin', 'tb-git');
  // an agent on tbd.sock with its own run key and pid, but not the run file's ask_token
  const forged = `const c=require('net').connect(process.env.TBD_SOCK);c.setEncoding('utf8');c.on('connect',()=>c.write(JSON.stringify({op:'approve.ask',run:process.env.TBX_RUN,pid:process.pid,kind:'push',text:'push forged'})+'\\n'));c.on('data',(d)=>{process.stderr.write(d);process.exit(/"ok":true/.test(d)?0:2)});`;
  // the run's key registered (TBX_RUN) before tb-git asks: tbd.sock answers approve.ask (no pid: refused, no card) with
  // "unknown run key" until then; polled every 100 ms, ≤ 20 s
  const keyed = `const net=require('net');const once=()=>new Promise((r)=>{let b='';const c=net.connect(process.env.TBD_SOCK);c.setEncoding('utf8');c.on('data',(d)=>{b+=d;});c.on('close',()=>r(b));c.on('error',()=>r(''));c.on('connect',()=>c.write(JSON.stringify({op:'approve.ask',run:process.env.TBX_RUN})+'\\n'));});(async()=>{for(let i=0;i<200;i++){const b=await once();if(b&&!/unknown run key/.test(b))process.exit(0);await new Promise((r)=>setTimeout(r,100));}process.exit(1);})();`;
  const scenario = { steps: [{ exec: [process.execPath, '-e', keyed] },
    ...[['fetch', 'origin', 'main'], ['push', 'origin', 'main'], ['push', 'origin', 'feat'], ['push', 'origin', 'tb/t_git001-ci'], ['push', 'origin', 'tb/t_git001-feat'], ['ls-remote', 'other']].map((a) => ({ exec: [TB_GIT, ...a] })),
    { exec: ['/bin/ln', '-s', root, 'out'] }, { exec: [TB_GIT, 'clone', 'https://example.invalid/x.git', 'out/sub'] }, { exec: [process.execPath, '-e', forged] },
    { exec: [TB_GIT, 'pull', 'origin', 'evil'] }, { hang: true }] };
  const phases = path.join(root, 'phases', 'code', 'planning');
  fs.mkdirSync(phases, { recursive: true });
  for (const [f, c] of Object.entries({ 'prompt.md': '# fixture\n', 'settings.json': JSON.stringify({ permissions: { allow: ['Read', 'Glob', 'Grep', 'Bash'] } }), 'result.schema.json': '{"type":"object"}' })) fs.writeFileSync(path.join(phases, f), c);
  const terminal = { bash_all_steps: false, folder_mcp: false, git_bridge: true, auto_mode: false, task_tickets: false, page_tools: false, approve_min: 10 };
  const tbd = await startTbd({ root, files: {
    'config.json': { claude_bin: FAKE, terminal, memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } },
    'tags.json': { acme: {}, 'acme/g': { path: repo, type: 'git', base: 'main' } },
    'tickets/t_git001/ticket.json': ticket('t_git001', { tag: 'acme/g', worktree: wt, git_dir, common_dir: common, clone, base_sha: base }),
    'tickets/t_git001/scenario.json': scenario,
  }, env: { TB_PHASES_DIR: path.join(root, 'phases'), NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: path.join(tbHome, 'tickets', 't_git001', 'scenario.json'), TEST_PRESSURE: 'normal', TB_GIT_FILE_REMOTE: remote } });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  const cards = async () => (await tbd.api('GET', '/api/tickets/t_git001')).json.ticket.approvals ?? [];
  const card = (kind) => until(async () => (await cards()).find((a) => a.kind === kind && a.status === 'pending'), 30_000, `${kind} card`);
  const push = await card('push');
  assert.match(push.input_text, new RegExp(`^push tb/t_git001-feat to origin \\(${remote.replace(/[.]/g, '\\.')}\\): 1 commit\\(s\\), ${feat.slice(0, 12)}; files: b\\.txt$`));
  assert.equal(git(remote, 'branch', '--list', 'tb/t_git001-feat'), '', 'nothing pushed before Yes');
  assert.equal((await tbd.api('POST', `/api/tickets/t_git001/approvals/${push.id}`, { yes: true })).status, 200);
  const other = await card('remote');
  assert.match(other.input_text, /^tb-git ls-remote other: git@example\.invalid:x\/y\.git is no remote of a board tag$/);
  assert.equal((await tbd.api('POST', `/api/tickets/t_git001/approvals/${other.id}`, { yes: false })).status, 200);
  const log = path.join(tbHome, 'tickets', 't_git001', 'runs', '1.jsonl');
  const all = await until(() => { const e = lines(log).filter((l) => l.subtype === 'fake_exec'); return e.length === 11 && e; }, 30_000, 'the key poll + ten calls');
  assert.equal(all[0].status, 0, `the run key polled: ${all[0].stderr}`);
  const execs = all.slice(1);
  assert.deepEqual(execs.map((e) => e.status), [0, 2, 2, 2, 0, 2, 0, 2, 2, 2], JSON.stringify(execs.map((e) => e.stderr)));
  assert.match(execs[1].stderr, /a push to the base branch main is refused/);
  assert.match(execs[2].stderr, /push only this ticket's own branch tb\/t_git001-…, not feat/);
  assert.match(execs[3].stderr, /push touches \.github\/workflows\/x\.yml: push from your terminal/);
  assert.match(execs[5].stderr, /Irfan said no/);
  assert.match(execs[7].stderr, /clone <dir> must be a new dir inside/);
  assert.match(execs[8].stderr, /no matching ask_token/);
  assert.match(execs[9].stderr, /pull touches \.claude\/settings\.json — pull from your terminal/); // L8: nothing merged
  assert.equal(git(wt, 'rev-parse', 'HEAD'), feat, 'HEAD unchanged');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/tb/t_git001-feat'), feat, 'landed after Yes: that sha');
  assert.deepEqual([git(remote, 'branch', '--list', 'feat'), git(remote, 'branch', '--list', 'tb/t_git001-ci')], ['', ''], 'refused pushes pushed nothing');
  assert.deepEqual((await cards()).map((a) => a.kind), ['push', 'remote'], 'the refused pushes, clone and forged ask asked nothing');
});

// Phase 4 Own Worktree, design test 9 (3g): run.clone.tree → fetch and pull refused, GIT_COMMON_DIR in git's env; the
// real bin/tb-git pushes tb/<id> from a real linked worktree (git worktree add --lock, as lib/task.js addTree) to a local
// bare remote (file_remote: what spawn writes from TB_GIT_FILE_REMOTE) under the real profile, built from the worktree
// Task's working wall + the tracking-ref paths spawn adds (extra); the tracking ref in the repo's common dir moves.
// tbd.sock here: a socket that answers every approve.ask yes (the card itself is covered above).
test('tb-git Own Worktree: fetch and pull refused, GIT_COMMON_DIR set; a push of tb/<id> under the real profile lands and updates refs/remotes/origin/tb/<id> in the repo', async (t) => {
  const tree = { base: 'main', ticket: 't_tree09', kind: 'task', own: ['tb/t_tree09'], home: '/Users/x', user: 'x', lang: 'en_US.UTF-8', common_dir: '/u/repo/.git', clone: { real: true, tree: true } };
  for (const argv of [['fetch', 'origin'], ['pull'], ['pull', 'origin', 'main', '--ff-only']]) assert.throws(() => parse(argv, tree), (e) => e instanceof Refused && e.message === 'fetch or pull from your terminal', argv.join(' '));
  assert.deepEqual(parse(['push', 'origin', 'tb/t_tree09'], tree), { verb: 'push', remote: 'origin', branch: 'tb/t_tree09' });
  assert.equal(gitEnv(tree).GIT_COMMON_DIR, '/u/repo/.git');
  assert.equal(gitEnv({ ...tree, clone: { real: true } }).GIT_COMMON_DIR, undefined, 'My Folder: no GIT_COMMON_DIR');
  const net = require('node:net');
  const { render, fullAccess, gitProfile } = require('../lib/phase-settings');
  const { realConfig, realHash } = require('../lib/util');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbt-')));
  const home = path.join(root, 'home'), tbHome = path.join(root, 'tbhome'), td = path.join(tbHome, 'tickets', 't_tree09');
  const remote = path.join(root, 'remote.git'), repo = path.join(root, 'repo'), wt = path.join(tbHome, 'worktrees', 't_tree09');
  for (const d of [home, repo, path.dirname(wt), td]) fs.mkdirSync(d, { recursive: true });
  git(root, 'init', '-q', '--bare', remote);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '--lock', '-B', 'tb/t_tree09', wt, base);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'agent commit');
  const sha = git(wt, 'rev-parse', 'HEAD');
  const common = path.join(repo, '.git'), gitDir = path.join(common, 'worktrees', 't_tree09');
  const realGit = fs.realpathSync(execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).trim());
  const s = fullAccess(render('task', 'working', { WORKTREE: wt, TICKET_DIR: td, OUT_DIR: path.join(td, 'out'), TB_HOME: tbHome, TAG_PATH: wt, SKILLS_DIR: path.join(td, 'skills'),
    TB_CODE: REPO, TB_NODE: process.execPath, TB_PORT: 7777, HEAVY: [], TAG_GIT: common, CLONE: false, TREE: true, TREE_OTHERS: [], NODE_MODULES: false }), { phase: 'working', learning: null, wall: true, worktree: wt });
  const extra = ['refs/remotes', 'logs/refs/remotes'].map((x) => path.join(common, x)); // as lib/spawn.js passes it
  const profile = path.join(root, 'git.sb');
  fs.writeFileSync(profile, gitProfile(s.sandbox, { home, cwd: wt, git: realGit, remote, extra }));
  const sock = path.join(root, 's.sock');
  const asks = [];
  const server = net.createServer((c) => c.on('data', (d) => { asks.push(JSON.parse(String(d)).kind); c.end('{"ok":true,"yes":true}\n'); }));
  await new Promise((r) => server.listen(sock, () => r(null)));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = path.join(root, 'git.json');
  fs.writeFileSync(run, JSON.stringify({ ticket: 't_tree09', kind: 'task', n: 1, ask_token: 'x', repo: wt, git_dir: gitDir, common_dir: common,
    clone: { real: true, tree: true, config: realHash(/** @type {string[]} */ (await realConfig(common))), alternates: null }, base: 'main', base_sha: base,
    remotes: { origin: { url: remote } }, registered: [remote], hooks: '', git: realGit, profile, own: ['tb/t_tree09'], ssh_auth_sock: '', home, user: 'x', lang: 'en_US.UTF-8', sock, file_remote: remote }));
  const tbGit = (...a) => new Promise((r) => { const c = require('node:child_process').spawn(path.join(REPO, 'bin', 'tb-git'), a, { cwd: wt, env: { TB_NODE: process.execPath, TB_GIT_RUN: run, PATH: '/usr/bin:/bin' } });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (status) => r({ status, err })); });
  const f = await tbGit('fetch', 'origin');
  assert.deepEqual([f.status, /fetch or pull from your terminal/.test(f.err)], [2, true], f.err);
  const p = await tbGit('push', 'origin', 'tb/t_tree09');
  assert.equal(p.status, 0, p.err);
  assert.deepEqual(asks, ['push'], 'one approve.ask, for the push');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/tb/t_tree09'), sha, 'landed on the remote');
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/tb/t_tree09'), sha, 'tracking ref updated in the common dir');
});
