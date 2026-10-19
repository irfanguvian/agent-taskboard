'use strict';
// board-terminal-parity Phase 4 (contract .omc/handoffs/btp-p4-contract.md section 8, Lane A): Task tickets end to end on
// a real tbd (harness temp HOME + TB_HOME) with the real phases + handlers (lib/task.js), test/fake-claude.js as
// claude_bin, a real git temp repo as Irfan's folder (local core.hooksPath=.husky, a second branch `other`).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd } = require('./helpers/tbd');
const { FAKE, RUN_SPY, read, until, reap, pidsOf } = require('./helpers/runs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const TERMINAL = { bash_all_steps: false, folder_mcp: false, git_bridge: false, auto_mode: false, task_tickets: true, page_tools: false, approve_min: 10 };
const CONFIG = {
  claude_bin: FAKE, max_concurrent: 4, terminal: TERMINAL,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
};
const PLAN = { kind: 'plan', summary: 'Add a line to the README', steps: ['edit README.md'], done_when: ['README.md has the line'] };
const DONE = { kind: 'done', summary: 'added the line', done_when_met: true, commit_message: 'docs: add a line' };
const result = (out) => ({ steps: [{ result: { structured_output: out } }] });
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const commit = (cwd, msg) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);

// Irfan's folder: main + other, a husky hooks dir, his identity in the repo config
function repo() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, '.husky'));
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), 'npm test\n');
  git(dir, 'add', '.');
  commit(dir, 'init');
  git(dir, 'branch', 'other');
  git(dir, 'config', 'core.hooksPath', '.husky');
  git(dir, 'config', 'user.name', 'Irfan');
  git(dir, 'config', 'user.email', 'irfan@example.com');
  git(dir, 'remote', 'add', 'origin', path.join(ROOT, 'nowhere.git'));
  return dir;
}
// scenarios: [result per invocation]; terminal: config.terminal override
async function boot(t, scenarios, dir, terminal = TERMINAL) {
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  scenarios.forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const tbd = await startTbd({
    files: { 'config.json': { ...CONFIG, terminal }, 'tags.json': { acme: { type: 'git', path: dir, base: 'main' } } },
    env: { NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn, FAKE_CLAUDE_DUMP_DIR: dumps },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  const dump = (n) => { const f = path.join(dumps, `${n}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  return Object.assign(tbd, { dump });
}
const create = async (tbd) => {
  const r = await tbd.api('POST', '/api/flows', { text: 'Add a line to the README', kind: 'task', tag: 'acme', start: true });
  assert.equal(r.status, 201, r.text);
  return r.json.ticket.id;
};
const settings = (tbd, id, n) => JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tickets', id, 'runs', `${n}.settings.json`), 'utf8'));

test('Task whole path: plan → approve resumes run 1 session → waits for you with task_result → Send resumes it again → Done; run settings (test 3); switch off: kind task refused with today\'s text', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const tbd = await boot(t, [result(PLAN), result(DONE), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  const s1 = tbd.dump(1);
  assert.equal(s1.cwd, p);
  const session = s1.opts['--session-id'];
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\nworld\n'); // the agent's edit (fake claude edits nothing)
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => read(tbd, id).waiting?.reason === 'you', 30_000, 'waiting you');
  const s2 = tbd.dump(2);
  assert.equal(s2.opts['--resume'], session);
  assert.match(s2.prompt, /Irfan approved your plan/);
  const k = read(tbd, id);
  assert.equal(k.state, 'working');
  assert.equal(k.task_result.summary, 'added the line');
  // main is the tag base: the Task's own branch; README.md was clean at the start point
  assert.deepEqual(k.task_result.push_to, { remote: 'origin', branch: `tb/${id}`, new_branch: true, files: ['README.md'], left: [], ahead: 1 });

  await t.test('run settings: working runs in the real folder, its .git commit paths free, nested + worktrees + hooks denied; planning write-denies the folder', () => {
    const s = settings(tbd, id, 2);
    assert.equal(s2.cwd, p);
    for (const r of [`Edit(/${p}/.git/config)`, `Edit(/${p}/.git/hooks/**)`, `Edit(/${p}/.husky/**)`, `Edit(/${p}/.git/worktrees/**)`, `Edit(/${p}/*/**/.git)`]) assert.ok(s.permissions.deny.includes(r), r);
    for (const w of [`${p}/.git/config`, `${p}/.git/hooks`, `${p}/.husky`, `${p}/.git/worktrees`, `${p}/*/**/.git`]) assert.ok(s.sandbox.filesystem.denyWrite.includes(w), w);
    assert.ok(!s.sandbox.filesystem.denyWrite.includes(`${p}/.git`), 'no whole .git write deny (.git/index writable)');
    assert.ok(!s.permissions.deny.includes(`Edit(/${p}/.git/**)`), 'no whole .git Edit deny');
    assert.ok(settings(tbd, id, 1).sandbox.filesystem.denyWrite.includes(p), 'planning: the folder is write-denied');
  });

  const n = await tbd.api('POST', `/api/tickets/${id}/note`, { text: 'also say hi' });
  assert.equal(n.status, 202, n.text);
  await until(() => tbd.dump(3), 30_000, 'run 3');
  const s3 = tbd.dump(3);
  assert.equal(s3.opts['--resume'], session);
  assert.match(s3.prompt, /^Irfan says:\nalso say hi/);
  await until(() => read(tbd, id).waiting?.reason === 'you' && read(tbd, id).lease?.exit === 'result' && read(tbd, id).round > k.round, 30_000, 'waiting you again');
  const c = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.equal(c.status, 200, c.text);
  assert.equal(read(tbd, id).state, 'done');

  const off = await boot(t, [], repo(), { ...TERMINAL, task_tickets: false });
  const r = await off.api('POST', '/api/flows', { text: 'x', kind: 'task', tag: 'acme' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'kind must be one of code, research, brainstorm, design');
  assert.ok(!(await off.api('GET', '/api/state')).json.system.kinds.includes('task'));
});

test('Task lock: a second Task on the same folder waits folder_busy with no run while the first holds it; it starts once the first is cancelled', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(PLAN)], dir);
  const a = await create(tbd);
  await until(() => read(tbd, a).state === 'plan_approval', 30_000, 'A plan_approval');
  const b = await create(tbd);
  await until(() => read(tbd, b).waiting?.reason === 'folder_busy', 30_000, 'B folder_busy');
  assert.equal(read(tbd, b).state, 'planning');
  assert.equal(tbd.dump(2), null, 'no run for B');
  assert.equal((await tbd.api('POST', `/api/tickets/${a}/cancel`, {})).status, 202);
  await until(() => tbd.dump(2), 30_000, 'B run 1');
  assert.equal(tbd.dump(2).cwd, fs.realpathSync(dir));
});

test('Task S1: Claude config committed while it waits in plan_approval → approve → Blocked task_changed, no run 2, no run secrets', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers": {}}\n');
  git(dir, 'add', '.mcp.json');
  commit(dir, 'mcp');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => read(tbd, id).state === 'blocked', 30_000, 'blocked');
  const k = read(tbd, id);
  assert.equal(k.waiting?.reason, 'task_changed');
  assert.match(k.lease.error, /\.mcp\.json/);
  assert.equal(tbd.dump(2), null, 'no run 2');
  assert.ok(!fs.existsSync(path.join(tbd.tbHome, 'run-secrets', `${id}-2`)));
});

test('Task S1 on Done: another branch moved to a commit adding .claude/settings.json while it waits for you → close 409, Blocked, why names the ref and its undo', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await until(() => read(tbd, id).waiting?.reason === 'you', 30_000, 'waiting you');
  const old = git(dir, 'rev-parse', 'other');
  // a commit on `other` without touching the work tree (a temp index)
  const idx = path.join(ROOT, `idx-${id}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...a) => execFileSync('/usr/bin/git', ['-C', dir, ...a], { encoding: 'utf8', env, input: '{"hooks": {}}\n' }).trim();
  g('read-tree', 'other');
  g('update-index', '--add', '--cacheinfo', `100644,${g('hash-object', '-w', '--stdin')},.claude/settings.json`);
  git(dir, 'update-ref', 'refs/heads/other', g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', g('write-tree'), '-p', old, '-m', 'plant'));
  const c = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.equal(c.status, 409, c.text);
  const k = read(tbd, id);
  assert.equal(k.state, 'blocked');
  assert.equal(k.waiting?.reason, 'task_changed');
  assert.match(k.waiting.why, /refs\/heads\/other/);
  assert.ok(k.waiting.why.includes(`git update-ref refs/heads/other ${old}`), k.waiting.why);
});

test('unclone never removes a folder that is not TB_HOME/worktrees/<id> (a Task\'s worktree is Irfan\'s folder)', async () => {
  process.env.TB_HOME = fs.mkdtempSync(path.join(ROOT, 'tbhome-'));
  const dir = repo();
  await assert.rejects(require('../lib/planning').unclone('t_abc123', dir, path.join(dir, '.git')), /not a board clone/);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
});
