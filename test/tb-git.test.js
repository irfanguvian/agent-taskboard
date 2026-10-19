'use strict';
// board-terminal-parity Phase 2 task 5: bin/tb-git, the git bridge (lib/tbgit.js). Unit: its word check and git's env.
// Integration: a real tbd with terminal.git_bridge on runs a ticket clone (util.cloneAt, the tag's origin copied in) whose
// fake claude calls the real bin/tb-git under the run's real git profile (sandbox-exec) against a local bare remote
// (TB_GIT_FILE_REMOTE: the test-only file protocol); the push waits for the Approve card Irfan answers on the board.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, REPO } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, lines, until, reap, pidsOf } = require('./helpers/runs');
const { parse, gitEnv } = require('../lib/tbgit');
const { cloneAt, cloneConfig } = require('../lib/util');

test('tb-git words: fetch, pull, push, ls-remote in the bridge\'s shapes; an unknown flag, a push without a branch or to the base, clone ext::sh refused; git\'s env from the run file, never the caller\'s', () => {
  const run = { base: 'main', home: '/Users/x', user: 'x', lang: 'en_US.UTF-8', ssh_auth_sock: '/private/tmp/com.apple.launchd.a/Listeners' };
  assert.deepEqual(parse(['fetch', 'origin'], run), { verb: 'fetch', remote: 'origin', branch: null });
  assert.deepEqual(parse(['pull', 'origin', 'feat', '--rebase'], run), { verb: 'pull', remote: 'origin', branch: 'feat', mode: '--rebase' });
  assert.deepEqual(parse(['push', 'origin', 'feat'], run), { verb: 'push', remote: 'origin', branch: 'feat' });
  assert.deepEqual(parse(['ls-remote', 'origin'], run), { verb: 'ls-remote', remote: 'origin' });
  /** @type {[string[], RegExp][]} */
  const refused = [[['fetch', 'origin', '--upload-pack=/bin/sh'], /fetch takes no --upload-pack/], [['push', 'origin'], /usage: tb-git push <remote> <branch>/],
    [['push', 'origin', 'main'], /push to the base branch main is refused/], [['clone', 'ext::sh -c touch% /tmp/x', 'd'], /clone takes an ssh or https URL/]];
  for (const [argv, why] of refused) assert.throws(() => parse(argv, run), why, argv.join(' '));
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

test('tb-git in a run (real profile, local bare remote): fetch ok; push to the base refused before any card; push feat waits for the Approve card, lands after Yes; an unknown remote URL → a card first, No refuses', async (t) => {
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
  const common = fs.realpathSync(path.join(repo, '.git'));
  const { git_dir } = await cloneAt(common, wt, base, { remote: { url: remote } });
  git(wt, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feat');
  const feat = git(wt, 'rev-parse', 'HEAD');
  git(wt, 'config', '--file', path.join(git_dir, 'config'), 'remote.other.url', 'git@example.invalid:x/y.git'); // no board tag's remote
  const clone = await cloneConfig(git_dir); // tbd's pin, after its last write
  const TB_GIT = path.join(REPO, 'bin', 'tb-git');
  const scenario = { steps: [{ sleep_ms: 3000 }, // the run's key registered (TBX_RUN) before tb-git asks
    ...[['fetch', 'origin', 'main'], ['push', 'origin', 'main'], ['push', 'origin', 'feat'], ['ls-remote', 'other']].map((a) => ({ exec: [TB_GIT, ...a] })), { hang: true }] };
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
  assert.match(push.input_text, new RegExp(`^push feat to origin \\(${remote.replace(/[.]/g, '\\.')}\\): 1 commit\\(s\\), ${feat.slice(0, 12)}$`));
  assert.equal(git(remote, 'branch', '--list', 'feat'), '', 'nothing pushed before Yes');
  assert.equal((await tbd.api('POST', `/api/tickets/t_git001/approvals/${push.id}`, { yes: true })).status, 200);
  const other = await card('remote');
  assert.match(other.input_text, /^tb-git ls-remote other: git@example\.invalid:x\/y\.git is no remote of a board tag$/);
  assert.equal((await tbd.api('POST', `/api/tickets/t_git001/approvals/${other.id}`, { yes: false })).status, 200);
  const log = path.join(tbHome, 'tickets', 't_git001', 'runs', '1.jsonl');
  const execs = await until(() => { const e = lines(log).filter((l) => l.subtype === 'fake_exec'); return e.length === 4 && e; }, 30_000, 'four tb-git calls');
  assert.deepEqual(execs.map((e) => e.status), [0, 2, 0, 2], JSON.stringify(execs.map((e) => e.stderr)));
  assert.match(execs[1].stderr, /a push to the base branch main is refused/);
  assert.match(execs[3].stderr, /Irfan said no/);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/feat'), feat, 'landed after Yes: that sha');
  assert.deepEqual((await cards()).map((a) => a.kind), ['push', 'remote'], 'the base push asked nothing');
});
