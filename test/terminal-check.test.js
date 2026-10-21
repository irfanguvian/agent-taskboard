'use strict';
// board-terminal-parity Phase 2 task 6: tb doctor --terminal (lib/terminal-check.js) on a real tbd (temp HOME + TB_HOME).
// Fixed checks: two git tags, one whose origin (a local bare repo, TB_GIT_FILE_REMOTE: the bridge profile's test-only
// file remote) answers ls-remote through the git bridge's profile, one whose origin is a missing path (fail + the fix
// hint). `tb doctor --terminal --live` without --yes: the cost, exit 2, no claude started. A live run on fake claude: the
// stream holds Bash `echo ok` and its result (ok) and no subagent (fail), on sonnet with at most 8 turns; its clone goes.
// Security review T1: what a live check a dead tbd left (temp dir, clone, base pin) goes at boot; nothing else does.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd, runTb } = require('./helpers/tbd');
const { FAKE, RUN_SPY, reap, pidsOf } = require('./helpers/runs');

const GENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();

let tbd, dumps;
before(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-')));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  for (const [name, origin] of [['ok', remote], ['bad', path.join(root, 'missing.git')]]) {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', origin);
  }
  git(path.join(root, 'ok'), 'push', '-q', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'); // the remote lists 2 refs: HEAD + refs/heads/main
  for (const id of ['tcheck-crash1', 't_keep01']) git(path.join(root, 'ok'), 'update-ref', `refs/tb/${id}/base`, 'HEAD'); // a dead check's pin; a ticket's
  dumps = path.join(root, 'dumps');
  fs.mkdirSync(dumps);
  const bash = { type: 'tool_use', id: 'toolu_tc1', name: 'Bash', input: { command: 'echo ok' } };
  const scenario = { steps: [
    { emit: { type: 'assistant', message: { type: 'message', role: 'assistant', model: 'sonnet', content: [bash] } } },
    { emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_tc1', content: 'ok' }] } } },
    { result: { structured_output: { status: 'done', commit: null, tests_added: [], notes: 'terminal check' } } }] };
  const terminal = { bash_all_steps: false, folder_mcp: false, git_bridge: false, auto_mode: false, task_tickets: false, page_tools: false, approve_min: 10 };
  tbd = await startTbd({ root, files: {
    'config.json': { claude_bin: FAKE, terminal, memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } },
    'tags.json': { shop: {}, 'shop/ok': { path: path.join(root, 'ok'), type: 'git', base: 'main' }, 'shop/bad': { path: path.join(root, 'bad'), type: 'git', base: 'main' } },
    'scenario.json': scenario,
    'tcheck-crash1/runs/1.jsonl': '{}\n', 'worktrees/tcheck-crash1/a.txt': 'a\n', 'worktrees/tcheck-crash2/a.txt': 'a\n', 'tcheck-notes.txt': 'kept\n',
  }, env: { NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: path.join(root, 'tbhome', 'scenario.json'), FAKE_CLAUDE_DUMP_DIR: dumps, TEST_PRESSURE: 'normal',
    TB_GIT_FILE_REMOTE: remote, TB_CHROME_APP: path.join(root, 'no-chrome.app') } });
});
after(async () => { if (tbd) { reap(pidsOf(tbd)); await tbd.stop(); } });

const byName = (r) => Object.fromEntries(r.json.checks.map((c) => [c.name, c]));

test('boot sweep: a dead live check\'s temp dir, clones (pinned or not) and base pin are gone; a ticket\'s pin and other names stay', () => {
  const h = tbd.tbHome;
  assert.deepEqual([fs.existsSync(path.join(h, 'tcheck-crash1')), fs.readdirSync(path.join(h, 'worktrees')), fs.existsSync(path.join(h, 'tcheck-notes.txt'))], [false, [], true]);
  assert.equal(git(path.join(path.dirname(h), 'ok'), 'for-each-ref', '--format=%(refname)', 'refs/tb/'), 'refs/tb/t_keep01/base');
});
// the fake claude's dumps: one per start, {opts, prompt}; --help (the fixed checks) is one too
const runs = () => fs.readdirSync(dumps).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dumps, f), 'utf8'))).filter((d) => d.opts['--max-turns']);

test('fixed checks: tb-git ls-remote through the bridge profile ok where origin answers, fail with the fix hint where origin is a missing path', async () => {
  const r = await tbd.api('POST', '/api/doctor', { terminal: true });
  assert.equal(r.status, 200, r.text);
  const c = byName(r);
  assert.equal(c['tb-git:shop/ok'].status, 'ok', c['tb-git:shop/ok'].detail);
  assert.match(c['tb-git:shop/ok'].detail, /^ls-remote origin answered \(2 refs\)/);
  assert.equal(c['tb-git:shop/bad'].status, 'fail', c['tb-git:shop/bad'].detail);
  assert.match(c['tb-git:shop/bad'].detail, /fix: ssh key not loaded \/ remote unreachable/);
  assert.equal(r.json.ok, false);
});

test('tb doctor --terminal --live without --yes: prints the cost, exits 2, starts no run', async () => {
  const r = await runTb(['doctor', '--terminal', '--live', '--tag', 'shop/ok'], tbd);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /--live costs usage: ~\$0\.30 typical, ~\$1 worst .*; add --yes to run it/);
  assert.equal(runs().length, 0, 'no claude run started');
});

test('live run on fake claude: Bash echo ok with its result in the stream → ok, no subagent tried → fail; sonnet, at most 8 turns; its clone is gone after', async () => {
  const r = await tbd.api('POST', '/api/doctor', { terminal: true, live: true, tag: 'shop/ok', yes: true });
  assert.equal(r.status, 200, r.text);
  const c = byName(r);
  assert.equal(c['live:bash'].status, 'ok', c['live:bash'].detail);
  assert.equal(c['live:subagent'].status, 'fail', c['live:subagent'].detail);
  assert.match(c['live:subagent'].detail, /not tried in the run/);
  const [d] = runs();
  assert.equal(d.opts['--model'], 'sonnet');
  assert.equal(d.opts['--max-turns'], '8');
  assert.deepEqual(fs.readdirSync(path.join(tbd.tbHome, 'worktrees')), []);
});
