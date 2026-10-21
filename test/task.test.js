'use strict';
// board-terminal-parity Phase 4 (contract .omc/handoffs/btp-p4-contract.md section 8, Lane A): Task tickets end to end on
// a real tbd (harness temp HOME + TB_HOME) with the real phases + handlers (lib/task.js), test/fake-claude.js as
// claude_bin, a real git temp repo as Irfan's folder (local core.hooksPath=.husky, a second branch `other`).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { startTbd } = require('./helpers/tbd');
const { FAKE, RUN_SPY, read, lines, until, alive, reap, pidsOf, hasRun } = require('./helpers/runs');

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
// scenarios: [result per invocation]; terminal: config.terminal override; tag: more tag fields; env: more tbd env
async function boot(t, scenarios, dir, terminal = TERMINAL, { tag = {}, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(ROOT, 'tbd-'));
  const scn = fs.mkdtempSync(path.join(ROOT, 'scn-'));
  scenarios.forEach((s, i) => fs.writeFileSync(path.join(scn, `${i + 1}.json`), JSON.stringify(s)));
  const dumps = fs.mkdtempSync(path.join(ROOT, 'dump-'));
  const tbd = await startTbd({
    root,
    files: { 'config.json': { ...CONFIG, terminal }, 'tags.json': { acme: { type: 'git', path: dir, base: 'main', ...tag } } },
    env: { NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', FAKE_CLAUDE_SCENARIO_DIR: scn, FAKE_CLAUDE_DUMP_DIR: dumps, ...env },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  const dump = (n) => { const f = path.join(dumps, `${n}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  return Object.assign(tbd, { dump });
}
const create = async (tbd) => {
  // Phase 4 D-0233: a Task made without `where` on a git tag is Own Worktree now; these tests are My Folder's
  const r = await tbd.api('POST', '/api/flows', { text: 'Add a line to the README', kind: 'task', tag: 'acme', where: 'folder', start: true });
  assert.equal(r.status, 201, r.text);
  return r.json.ticket.id;
};
const settings = (tbd, id, n) => JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tickets', id, 'runs', `${n}.settings.json`), 'utf8'));

test('Task whole path: plan → approve resumes run 1 session → waits for you with task_result → Send resumes it again → Done; run settings (test 3); switch off: kind task refused with today\'s text', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const tbd = await boot(t, [result(PLAN), result(DONE), result(DONE), result(DONE)], dir, { ...TERMINAL, git_bridge: true });
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  const s1 = tbd.dump(1);
  assert.equal(s1.cwd, p);
  const session = s1.opts['--session-id'];
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\nworld\n'); // the agent's edit (fake claude edits nothing)
  await approve(tbd, id);
  await tbdSees(tbd, id, (q) => q.waiting?.reason === 'you' && q.lease?.exit === 'result', 'waiting you, run ended');
  const s2 = tbd.dump(2);
  assert.equal(s2.opts['--resume'], session);
  assert.match(s2.prompt, /Irfan approved your plan/);
  // gap 2026-10-20: a Task's approve is Irfan's step-in too (one row, same write as the move)
  assert.deepEqual(lines(path.join(tbd.tbHome, 'tickets', id, 'interventions.jsonl')).map((l) => [l.actor, l.verb, l.task]), [['cli', 'approve', null]]);
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
  await waitsYou(tbd, id, k.round);
  // Commit and Push (code review MED): the Task's own branch made, the same session told to commit exactly its files, the
  // grant bound to that run's gen at its start
  const cp = await tbd.api('POST', `/api/tickets/${id}/push`);
  assert.equal(cp.status, 202, cp.text);
  assert.deepEqual([cp.json.task, cp.json.branch, cp.json.remote, cp.json.files], [true, `tb/${id}`, 'origin', ['README.md']]);
  await until(() => tbd.dump(4), 30_000, 'run 4');
  assert.equal(tbd.dump(4).opts['--resume'], session);
  assert.match(tbd.dump(4).prompt, new RegExp(`Commit exactly these files to tb/${id}: .*README\\.md`));
  const g = read(tbd, id);
  assert.equal(g.push_grant?.gen, g.lease.gen, 'the grant is bound to the run that commits');
  assert.equal(g.push_grant.branch, `tb/${id}`);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), `tb/${id}`, 'the folder is on the Task\'s branch, README.md still uncommitted');
  await tbdSees(tbd, id, (q) => ranToYou(q, g.round - 1) && q.lease.gen === g.lease.gen, 'waiting you after the commit run');
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

// 2026-10-20 live t_1njc0c: claude makes <cwd>/.claude/.cc-writes in any subfolder it runs Bash in; in a git folder that
// Blocked the Task. A real config file in that nested .claude still Blocks.
test('git-folder Task S1: a nested apps/x/.claude holding only .cc-writes is not a change; apps/x/.claude/settings.json is', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  fs.mkdirSync(path.join(dir, 'apps', 'x', '.claude', '.cc-writes'), { recursive: true });
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await tbdSees(tbd, id, (q) => q.waiting?.reason === 'you' && q.lease?.exit === 'result', 'waiting you, run ended');
  assert.notEqual(read(tbd, id).state, 'blocked');
  fs.writeFileSync(path.join(dir, 'apps', 'x', '.claude', 'settings.json'), '{"hooks":{}}');
  const c = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.equal(c.status, 409, c.text);
  const k = read(tbd, id);
  assert.equal(k.waiting?.reason, 'task_changed');
  assert.match(k.waiting.why, /apps\/x\/\.claude/);
});

test('Task S1 on Done: another branch moved to a commit adding .claude/settings.json while it waits for you → close 409, Blocked, why names the ref and its undo', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await tbdSees(tbd, id, (q) => q.waiting?.reason === 'you' && q.lease?.exit === 'result', 'waiting you, run ended');
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

// code review HIGH: claude makes <cwd>/.claude/.cc-writes on every sandboxed Bash (D-0031); in a plain folder that must
// not read as planted config, while a real .claude/settings.json still does
test('plain-folder Task S1: claude\'s own .claude/.cc-writes is not a change; a .claude/settings.json is', async () => {
  process.env.TB_HOME = fs.mkdtempSync(path.join(ROOT, 'tbhome-')); // never the real ~/.taskboard
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'plain-')));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x\n');
  const task = require('../lib/task');
  const t = { id: 't_plain1', worktree: dir };
  const { base } = await task.baseline(t);
  fs.mkdirSync(path.join(dir, '.claude', '.cc-writes'), { recursive: true });
  assert.deepEqual(await task.check({ ...t, task: { base } }), []);
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"hooks":{}}');
  assert.equal((await task.check({ ...t, task: { base } })).length, 1, 'a real .claude config is a change');
});

test('Task assign refuses a token header in .git/config: the plain http.extraheader key too (design 4: shared EXTRAHEADER), never echoing it', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [], dir);
  for (const key of ['http.extraheader', 'http.https://h.example/.extraheader']) {
    git(dir, 'config', key, 'Authorization: Bearer SECRET123');
    const r = await tbd.api('POST', '/api/flows', { text: 'Add a line to the README', kind: 'task', tag: 'acme', start: true });
    assert.deepEqual([r.status, r.json.started, r.json.ticket.state], [201, false, 'backlog'], `${key}: ${r.text}`); // create + start: a refused assign stays in backlog
    assert.match(r.json.why, /a token in .*\/\.git\/config would be readable by the agent: move it to your credential helper$/);
    assert.ok(!r.text.includes('SECRET123'), `${key}: the token never reaches the answer`);
    git(dir, 'config', '--unset', key);
  }
});

test('unclone never removes a folder that is not TB_HOME/worktrees/<id> (a Task\'s worktree is Irfan\'s folder)', async () => {
  process.env.TB_HOME = fs.mkdtempSync(path.join(ROOT, 'tbhome-'));
  const dir = repo();
  await assert.rejects(require('../lib/planning').unclone('t_abc123', dir, path.join(dir, '.git')), /not a board clone/);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
});

test('Continue in Terminal on a Task waiting for you: held, Done → 409 while claude --resume <session> runs in his terminal, Done → 200 once it is closed', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const id = await create(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/approve`, {})).status, 202);
  await tbdSees(tbd, id, (q) => q.waiting?.reason === 'you' && q.lease?.exit === 'result', 'waiting you, run ended');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/hold`)).status, 202);
  await until(() => read(tbd, id).lease.exit === 'held' && !read(tbd, id).lease.pending, 30_000, 'held');
  const { session } = read(tbd, id).lease;
  const term = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', '--resume', session], { stdio: 'ignore' });
  t.after(() => term.kill('SIGKILL'));
  const busy = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.deepEqual([busy.status, busy.json], [409, { error: `${id}: claude --resume ${session} still runs: close your terminal session first` }]);
  assert.equal(read(tbd, id).state, 'working', 'not closed');
  term.kill('SIGKILL');
  await until(() => !alive(term.pid), 10_000, 'the terminal session closed');
  const done = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.equal(done.status, 200, done.text);
  assert.equal(read(tbd, id).state, 'done');
});

// ---- Phase 4 Own Worktree (design .omc/plans/2026-10-20-phase4-one-kind-design.md, revision 6), build step 1 ----
const flowAt = (tbd, where, extra = {}) => tbd.api('POST', '/api/flows', { text: 'Add a line to the README', kind: 'task', tag: 'acme', where, ...extra });
const trees = (dir) => git(dir, 'worktree', 'list', '--porcelain').split('\n\n');
const branch = (dir, id) => git(dir, 'branch', '--list', `tb/${id}`);

test('Own Worktree assign (design test 6): a repo with submodules, then one with Git LFS → 409 "use My Folder", the ticket stays in backlog, no folder, git folder or branch', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [], dir);
  for (const [file, text, why] of /** @type {[string, string, RegExp][]} */ ([['.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ../x.git\n', /submodules/], ['assets/.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n', /Git LFS/]])) {
    if (file !== '.gitmodules') git(dir, 'rm', '-q', '.gitmodules');
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '-A');
    commit(dir, file);
    const r = await flowAt(tbd, 'worktree', { start: true });
    assert.deepEqual([r.status, r.json.started, r.json.ticket.state], [201, false, 'backlog'], r.text);
    assert.match(r.json.why, why);
    assert.match(r.json.why, /: use My Folder$/);
    const id = r.json.ticket.id;
    assert.equal(fs.existsSync(path.join(tbd.tbHome, 'worktrees', id)), false, 'no worktree folder');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'worktrees', id)), false, 'no worktree git folder');
    assert.equal(branch(dir, id), '', 'no branch');
    assert.equal(trees(dir).length, 1, 'git worktree list: the main checkout only');
  }
});

test('Own Worktree add after a crash (design test 6): a locked worktree + tb/<id> left at that path, the ticket with no git_dir → the add works: locked worktree on tb/<id> at the new HEAD, the exact git folder, the fields saved, untracked hook files copied', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const tbd = await boot(t, [], dir);
  const r = await flowAt(tbd, 'worktree');
  const id = r.json.ticket.id;
  const wt = path.join(fs.realpathSync(tbd.tbHome), 'worktrees', id);
  git(dir, 'worktree', 'add', '-q', '--lock', '-b', `tb/${id}`, wt, 'HEAD'); // the crash's leftover
  fs.writeFileSync(path.join(wt, 'stale.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\nagain\n');
  git(dir, 'add', 'README.md');
  commit(dir, 'again');
  const head = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, '.husky', 'local-hook'), 'echo hi\n'); // untracked (husky's .husky/_ is)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Irfan\'s open change\n');
  assert.equal((await tbd.api('POST', `/api/tickets/${id}/assign`)).status, 200);
  await until(() => read(tbd, id).git_dir, 30_000, 'the add saved');
  const k = read(tbd, id);
  assert.deepEqual([k.worktree, k.git_dir, k.common_dir, k.base_sha, k.clone], [wt, `${p}/.git/worktrees/${id}`, `${p}/.git`, head, { real: true, tree: true }]);
  assert.deepEqual([k.task.mode, k.task.repo, k.task.real, k.task.from], ['worktree', p, wt, 'main']);
  assert.ok(trees(dir).includes(`worktree ${wt}\nHEAD ${head}\nbranch refs/heads/tb/${id}\nlocked taskboard ${id}`), trees(dir).join('\n---\n'));
  assert.equal(trees(dir).length, 2);
  assert.equal(git(dir, 'rev-parse', `tb/${id}`), head, '-B reset the leftover branch');
  assert.equal(fs.existsSync(path.join(wt, 'stale.txt')), false, 'the leftover folder went first');
  assert.equal(fs.readFileSync(path.join(wt, '.husky', 'local-hook'), 'utf8'), 'echo hi\n');
  assert.equal(fs.readFileSync(path.join(wt, '.husky', 'pre-commit'), 'utf8'), 'npm test\n', 'the tracked hook as checked out');
  assert.equal(fs.existsSync(path.join(wt, 'notes.txt')), false, 'Irfan\'s open change stays in his repo');
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('Task lock by area (design test 4): two Own Worktree Tasks on one repo both get their worktree; then a My Folder Task there waits folder_busy with no run, and a Code ticket assign → 409 naming the repo', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const tbd = await boot(t, [], dir);
  const ids = [];
  for (const n of [1, 2]) {
    const r = await flowAt(tbd, 'worktree', { start: true });
    assert.equal(r.json.started, true, r.text);
    ids.push(r.json.ticket.id);
    await until(() => read(tbd, r.json.ticket.id).git_dir, 30_000, `worktree Task ${n} has its worktree`);
  }
  assert.equal(trees(dir).length, 3);
  const b = await flowAt(tbd, 'folder', { start: true });
  assert.equal(b.json.started, true, b.text);
  await until(() => read(tbd, b.json.ticket.id).waiting?.reason === 'folder_busy', 30_000, 'My Folder Task folder_busy');
  assert.equal(read(tbd, b.json.ticket.id).state, 'planning');
  // build step 2: the two worktree Tasks now take their start point and run (step 1 had them Blocked there), so "no
  // run" is the My Folder Task's own
  assert.equal(hasRun(tbd, b.json.ticket.id, 1), false, 'no run for the My Folder Task');
  const code = await tbd.api('POST', '/api/flows', { text: 'x', kind: 'code', tag: 'acme', start: true });
  assert.deepEqual([code.status, code.json.started], [201, false], code.text);
  assert.ok(ids.some((id) => code.json.why.endsWith(`a Task works in ${p} (${id}): assign this once it ends`)), code.json.why);
});

// ---- Phase 4 Own Worktree, build step 2 part B (design revision 6 tests 3, 13, 14, 16) ----
const started = async (tbd, extra = {}) => {
  const r = await flowAt(tbd, 'worktree', { start: true, ...extra });
  assert.equal(r.json.started, true, r.text);
  return r.json.ticket.id;
};
// store.save writes ticket.json before tbd's in-memory copy (store.js save): a state read from the file can be one beat
// ahead of what approve sees, so ask again while tbd still says planning
// the same beat for any state: wait until tbd's own answer (not the file) shows it; memory set ⇒ the file is too
const tbdSees = (tbd, id, ok, what) => until(async () => ok((await tbd.api('GET', `/api/tickets/${id}`)).json?.ticket ?? {}), 30_000, `${id} ${what} in tbd`);
const tbdState = (tbd, id, state) => tbdSees(tbd, id, (k) => k.state === state, state);
const ranToYou = (k, round = 0) => k.waiting?.reason === 'you' && k.lease?.exit === 'result' && k.round > round;
const waitsYou = (tbd, id, round = 0) => tbdSees(tbd, id, (k) => ranToYou(k, round), 'waits for you');
const CFG_WORDS = 'your git config changed since the Task started (git remote add, git maintenance): look at it, then Resume';
const approve = async (tbd, id) => {
  let r;
  await until(async () => { r = await tbd.api('POST', `/api/tickets/${id}/approve`, {}); return !String(r.json?.error ?? '').endsWith('can be approved, not planning'); }, 10_000, `${id} approve`);
  assert.equal(r.status, 202, r.text);
};

test('Own Worktree parallel (design test 3): two Tasks run with no folder_busy; a plain commit on main and a new Task branch made from `other` Block neither; a Claude config commit on tb/<B> Blocks A naming it; one on main Blocks both naming main', async (t) => {
  const dir = repo();
  git(dir, 'switch', '-q', 'other'); // `other` differs from main in .claude/settings.json (before any Task starts)
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"x": 1}\n');
  git(dir, 'add', '.claude');
  commit(dir, 'other config');
  git(dir, 'switch', '-q', 'main');
  const tbd = await boot(t, [result(PLAN), result(PLAN), result(DONE), result(DONE), result(DONE), result(DONE)], dir);
  const a = await started(tbd);
  await until(() => read(tbd, a).state === 'plan_approval', 30_000, 'A plan_approval');
  git(dir, 'switch', '-q', 'other'); // Irfan's main checkout moves; B's worktree starts from there
  const b = await started(tbd);
  await until(() => read(tbd, b).state === 'plan_approval', 30_000, 'B plan_approval');
  assert.equal(read(tbd, b).base_sha, git(dir, 'rev-parse', 'other'));
  assert.deepEqual([tbd.dump(1).cwd, tbd.dump(2).cwd], [read(tbd, a).worktree, read(tbd, b).worktree], 'both planning runs ran, each in its own worktree');
  git(dir, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x\n');
  git(dir, 'add', 'notes.md');
  commit(dir, 'plain'); // Irfan's terminal: a plain file on main
  for (const id of [a, b]) {
    await approve(tbd, id);
    await waitsYou(tbd, id); // its working run passed the safety check (no Block on tb/<B>, nor on main's plain commit)
  }
  assert.deepEqual([read(tbd, a).state, read(tbd, b).state], ['working', 'working']);

  // B's agent commits a Claude config change on tb/<B> → A's next check Blocks, naming tb/<B>, not main
  const wb = read(tbd, b).worktree;
  fs.writeFileSync(path.join(wb, '.claude', 'settings.json'), '{"x": 2}\n');
  git(wb, 'add', '.claude/settings.json');
  commit(wb, 'agent config');
  const ra = read(tbd, a).round;
  assert.equal((await tbd.api('POST', `/api/tickets/${a}/note`, { text: 'go on' })).status, 202);
  await until(() => read(tbd, a).state === 'blocked', 30_000, 'A blocked');
  assert.match(read(tbd, a).lease.error, new RegExp(`refs/heads/tb/${b} has new commits that touch \\.claude/settings\\.json`));
  assert.doesNotMatch(read(tbd, a).lease.error, /refs\/heads\/main/);
  assert.ok(read(tbd, a).round > ra);

  // Irfan's terminal commits Claude config on main → both Block at their next check, naming main (D-0237)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
  git(dir, 'add', 'CLAUDE.md');
  commit(dir, 'claude md');
  const c = await tbd.api('POST', `/api/tickets/${b}/close`, {});
  assert.equal(c.status, 409, c.text);
  assert.equal(read(tbd, b).state, 'blocked');
  assert.match(read(tbd, b).waiting.why, /refs\/heads\/main has new commits that touch CLAUDE\.md/);
  assert.equal((await tbd.api('POST', `/api/tickets/${a}/resume`, {})).status, 202);
  await until(() => /refs\/heads\/main has new commits that touch CLAUDE\.md/.test(read(tbd, a).lease.error ?? ''), 30_000, 'A blocked again, naming main');
  assert.equal(read(tbd, a).state, 'blocked');
});

test('Own Worktree config-pin Resume (design test 13, D-0235): git remote add → Blocked with the config words → Resume re-pins and the run starts; a hooksPath change, a token URL and a plain extraheader → 409, still Blocked, no run, pin kept, no token in the body', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [result(PLAN), result(DONE), result(DONE)], dir);
  const id = await started(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  const old = read(tbd, id).clone.config;
  git(dir, 'remote', 'add', 'x', path.join(ROOT, 'x.git'));
  await approve(tbd, id);
  await until(() => read(tbd, id).state === 'blocked', 30_000, 'blocked');
  await tbdState(tbd, id, 'blocked');
  assert.ok(read(tbd, id).lease.error.includes(CFG_WORDS), read(tbd, id).lease.error);
  assert.equal(tbd.dump(2), null, 'no working run');
  const ok = await tbd.api('POST', `/api/tickets/${id}/resume`, {});
  assert.equal(ok.status, 202, ok.text);
  await until(() => tbd.dump(2), 30_000, 'the working run started');
  assert.equal(tbd.dump(2).cwd, read(tbd, id).worktree);
  const pin = read(tbd, id).clone.config;
  assert.notEqual(pin, old, 'the config pin was taken again');
  await waitsYou(tbd, id);

  // each change below: Blocked at the next check, then Resume → 409, the ticket stays Blocked with its pin, no run
  const blockNow = async () => {
    assert.equal((await tbd.api('POST', `/api/tickets/${id}/note`, { text: 'go on' })).status, 202);
    await until(() => read(tbd, id).state === 'blocked', 30_000, 'blocked again');
    await tbdState(tbd, id, 'blocked');
  };
  const refused = async (re) => {
    const r = await tbd.api('POST', `/api/tickets/${id}/resume`, {});
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, re);
    assert.ok(!r.text.includes('SECRET'), 'no token in the body');
    await new Promise((res) => setTimeout(res, 1500)); // a tick or so: nothing starts
    const k = read(tbd, id);
    assert.deepEqual([k.state, k.clone.config], ['blocked', pin]);
    assert.equal(tbd.dump(3), null, 'no run');
  };
  git(dir, 'config', 'core.hooksPath', '.githooks');
  await blockNow();
  await refused(/this git config change \(core\.hookspath\) changes what the agent can reach: undo it, or Cancel and start a new Task$/);
  git(dir, 'config', 'core.hooksPath', '.husky');
  git(dir, 'remote', 'add', 'y', 'https://u:SECRET@h.example/r.git');
  await refused(/a token in the git config would be readable by the agent: move it to your credential helper$/);
  git(dir, 'remote', 'remove', 'y');
  git(dir, 'config', 'http.extraheader', 'Authorization: Bearer SECRET');
  await refused(/a token in the git config would be readable by the agent: move it to your credential helper$/);
  const rs = await tbd.api('POST', `/api/tickets/${id}/restart`, {}); // no second re-pin path (design section 4)
  assert.deepEqual([rs.status, rs.json.error], [409, `${id}: use Resume: it checks the config change first`]);
  assert.equal(read(tbd, id).state, 'blocked');
});

test('Own Worktree tree wait (design test 14): B waits tree_wait while A\'s working run is live and makes nothing; C\'s Send waits too; A\'s run ends → B gets its worktree and start point, then C runs; A\'s next run denies B\'s git folder', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const slow = { steps: [{ sleep_ms: 8000 }, { result: { structured_output: DONE } }] };
  const tbd = await boot(t, [result(PLAN), result(DONE), result(PLAN), slow, result(DONE), result(PLAN), result(DONE)], dir);
  const c = await started(tbd);
  await until(() => read(tbd, c).state === 'plan_approval', 30_000, 'C plan_approval');
  await approve(tbd, c);
  await waitsYou(tbd, c);
  const a = await started(tbd);
  await until(() => read(tbd, a).state === 'plan_approval', 30_000, 'A plan_approval');
  await approve(tbd, a);
  await until(() => tbd.dump(4) && read(tbd, a).lease?.phase === 'working' && !read(tbd, a).lease.exit, 30_000, 'A\'s working run live');
  const b = await started(tbd);
  await until(() => read(tbd, b).waiting?.reason === 'tree_wait', 30_000, 'B tree_wait');
  assert.equal(fs.existsSync(path.join(p, '.git', 'worktrees', b)), false, 'no git folder for B');
  assert.equal(branch(dir, b), '', 'no tb/<B>');
  assert.equal(read(tbd, b).worktree, undefined);
  assert.equal((await tbd.api('POST', `/api/tickets/${c}/note`, { text: 'go on' })).status, 202);
  await until(() => read(tbd, c).waiting?.reason === 'tree_wait', 30_000, 'C tree_wait');
  assert.equal(tbd.dump(5), null, 'C\'s run did not start');
  assert.ok(!read(tbd, a).lease.exit, 'A still runs');

  await waitsYou(tbd, a); // A's run ends
  await until(() => read(tbd, b).task?.base && tbd.dump(6), 30_000, 'B got its worktree, start point and planning run');
  assert.equal(read(tbd, b).git_dir, `${p}/.git/worktrees/${b}`);
  assert.equal(tbd.dump(5).cwd, read(tbd, c).worktree, 'then C\'s run started');
  assert.match(tbd.dump(5).prompt, /^Irfan says:\ngo on/);
  const ra = read(tbd, a).round;
  assert.equal((await tbd.api('POST', `/api/tickets/${a}/note`, { text: 'more' })).status, 202);
  await waitsYou(tbd, a, ra);
  const s = settings(tbd, a, read(tbd, a).lease.log.match(/runs\/(\d+)\./)[1]);
  assert.ok(s.sandbox.filesystem.denyWrite.includes(`${p}/.git/worktrees/${b}`), 'A\'s next run walls B\'s git folder (sibling row)');
});

test('Own Worktree tree wait counts live working runs only (design test 14, step 0b planning case): B gets its worktree while A\'s planning run is live', async (t) => {
  const dir = repo();
  const tbd = await boot(t, [{ steps: [{ sleep_ms: 6000 }, { result: { structured_output: PLAN } }] }, result(PLAN)], dir);
  const a = await started(tbd);
  await until(() => tbd.dump(1) && read(tbd, a).lease?.phase === 'planning' && !read(tbd, a).lease.exit, 30_000, 'A\'s planning run live');
  const b = await started(tbd);
  await until(() => read(tbd, b).git_dir || read(tbd, b).waiting?.reason === 'tree_wait', 30_000, 'B decided');
  assert.equal(read(tbd, b).waiting?.reason ?? null, null, 'B did not wait');
  assert.ok(read(tbd, b).git_dir, 'B has its worktree');
  assert.ok(!read(tbd, a).lease.exit, 'while A\'s planning run is still live');
});

test('Own Worktree git link check every tick (design test 16, D-0239): Irfan\'s normal git in the worktree never Blocks across ticks; a swapped worktree git folder Blocks at the next tick with plain words, and its planted fsmonitor never runs', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const tbd = await boot(t, [result(PLAN), result(DONE)], dir);
  const a = await started(tbd);
  await until(() => read(tbd, a).state === 'plan_approval', 30_000, 'plan_approval');
  await approve(tbd, a);
  await waitsYou(tbd, a);
  const wt = read(tbd, a).worktree;
  fs.writeFileSync(path.join(wt, 'mine.txt'), 'x\n'); // Irfan's terminal in the worktree
  git(wt, 'add', 'mine.txt');
  commit(wt, 'mine');
  git(wt, 'switch', '-q', '-c', 'x');
  git(wt, 'switch', '-q', `tb/${a}`);
  fs.writeFileSync(path.join(wt, 'README.md'), 'hello\nwip\n');
  git(wt, 'stash', '-q');
  git(wt, 'stash', 'pop', '-q');
  git(dir, 'worktree', 'add', '-q', path.join(ROOT, `sib-${a}`), '-b', `sib-${a}`);
  git(dir, 'worktree', 'lock', path.join(ROOT, `sib-${a}`));
  await new Promise((r) => setTimeout(r, 3500)); // three ticks
  assert.deepEqual([read(tbd, a).state, read(tbd, a).waiting?.reason], ['working', 'you'], 'no Block on his normal git');

  const g = path.join(p, '.git', 'worktrees', a);
  const marker = path.join(ROOT, `fsmonitor-${a}`);
  fs.renameSync(g, `${g}.aside`);
  fs.mkdirSync(g);
  fs.writeFileSync(path.join(g, 'gitdir'), `${wt}/.git\n`);
  fs.writeFileSync(path.join(g, 'HEAD'), `ref: refs/heads/tb/${a}\n`);
  fs.writeFileSync(path.join(g, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch ${marker}\n`);
  await until(() => read(tbd, a).state === 'blocked', 10_000, 'blocked at the next tick');
  assert.equal(read(tbd, a).waiting.why, `the worktree's git links changed: do not open a terminal in ${wt}: Cancel`);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(fs.existsSync(marker), false, 'tbd ran no git in the swapped folder');
});

// ---- Phase 4 Own Worktree, build step 3 (design revision 6 test 1) ----
// the run key registered (TBX_RUN) before tb-git asks (as test/tb-git.test.js): polled on tbd.sock every 100 ms, ≤ 20 s
const KEYED = `const net=require('net');const once=()=>new Promise((r)=>{let b='';const c=net.connect(process.env.TBD_SOCK);c.setEncoding('utf8');c.on('data',(d)=>{b+=d;});c.on('close',()=>r(b));c.on('error',()=>r(''));c.on('connect',()=>c.write(JSON.stringify({op:'approve.ask',run:process.env.TBX_RUN})+'\\n'));});(async()=>{for(let i=0;i<200;i++){const b=await once();if(b&&!/unknown run key/.test(b))process.exit(0);await new Promise((r)=>setTimeout(r,100));}process.exit(1);})();`;

test('Own Worktree whole path (design test 1): the add (locked, tb/<id> at HEAD, node_modules, env file, untracked husky hook), planning walls <common>, working writes it with the sibling walled; Commit and Push → the agent commits with Irfan\'s repo hook and pushes tb/<id> through tb-git with no card; Done removes the folder and its exact git folder, a stale entry and the branch stay', async (t) => {
  const dir = repo();
  const p = fs.realpathSync(dir);
  const common = `${p}/.git`;
  const remote = path.join(ROOT, `remote-${path.basename(dir)}.git`);
  git(ROOT, 'init', '-q', '--bare', remote);
  git(dir, 'remote', 'set-url', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const marker = path.join(ROOT, `hook-ran-${path.basename(dir)}`);
  fs.mkdirSync(path.join(dir, '.husky', '_'));
  fs.writeFileSync(path.join(dir, '.husky', '_', 'pre-commit'), `#!/bin/sh\npwd > ${marker}\n`, { mode: 0o755 }); // husky v9: untracked
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Irfan\'s open change\n');
  const sib = path.join(ROOT, `sib-${path.basename(dir)}`);
  git(dir, 'worktree', 'add', '-q', sib, '-b', `sib-${path.basename(dir)}`); // Irfan's own linked worktree
  const stale = path.join(common, 'worktrees', 'stale1'); // an entry no tbd code may prune
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'gitdir'), `${path.join(ROOT, 'gone', '.git')}\n`);
  const deny = path.join(ROOT, `deny-${path.basename(dir)}.txt`);
  fs.writeFileSync(deny, 'zebracorp\n');
  const sh = (cmd) => ({ exec: ['/bin/sh', '-c', cmd] });
  const work = { steps: [sh('printf "hello\\nworld\\n" > README.md'), { result: { structured_output: DONE } }] };
  const commitRun = { steps: [{ exec: [process.execPath, '-e', KEYED] },
    sh('git add -- README.md && git commit -q -m "docs: add a line" -- README.md && tb-git push origin "$(git symbolic-ref --short HEAD)"'), { result: { structured_output: DONE } }] };
  const tbd = await boot(t, [result(PLAN), work, commitRun], dir, { ...TERMINAL, git_bridge: true },
    { tag: { env_files: ['.env'] }, env: { TB_GIT_FILE_REMOTE: remote, TB_PUSH_FILE_OK: '1', TB_DENYLIST: deny } });
  const id = await started(tbd);
  await until(() => read(tbd, id).state === 'plan_approval', 30_000, 'plan_approval');
  const k = read(tbd, id);
  const wt = path.join(fs.realpathSync(tbd.tbHome), 'worktrees', id);
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.deepEqual([k.worktree, k.git_dir, git(dir, 'rev-parse', `tb/${id}`)], [wt, `${common}/worktrees/${id}`, head]);
  assert.ok(trees(dir).includes(`worktree ${wt}\nHEAD ${head}\nbranch refs/heads/tb/${id}\nlocked taskboard ${id}`), trees(dir).join('\n---\n'));
  assert.equal(fs.existsSync(path.join(wt, 'notes.txt')), false, 'Irfan\'s open change stays in his repo');
  assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(path.join(wt, '.husky', '_', 'pre-commit'), 'utf8'), `#!/bin/sh\npwd > ${marker}\n`);
  assert.ok(settings(tbd, id, 1).sandbox.filesystem.denyWrite.includes(common), 'planning: <common> write-denied whole');

  await approve(tbd, id);
  await waitsYou(tbd, id);
  const w = settings(tbd, id, 2).sandbox.filesystem;
  assert.ok(w.allowWrite.includes(common), 'working: <common> writable');
  assert.ok(!w.denyWrite.includes(common), 'no whole <common> deny');
  for (const row of [`${common}/config`, `${common}/HEAD`, `${common}/index`, `${common}/worktrees/${path.basename(sib)}`, `${wt}/.git`]) assert.ok(w.denyWrite.includes(row), row);
  const r1 = read(tbd, id).task_result;
  assert.deepEqual([r1.push_to?.branch, r1.push_to?.new_branch, r1.push_to?.files], [`tb/${id}`, false, ['README.md']], JSON.stringify(r1));

  const cp = await tbd.api('POST', `/api/tickets/${id}/push`);
  assert.equal(cp.status, 202, cp.text);
  const g = read(tbd, id);
  await until(() => { const x = read(tbd, id); return x.waiting?.reason === 'you' && x.lease?.exit === 'result' && x.lease.gen > g.lease.gen; }, 60_000, 'the commit run ended');
  const log = path.join(tbd.tbHome, 'tickets', id, 'runs', '3.jsonl');
  const execs = lines(log).filter((l) => l.subtype === 'fake_exec');
  assert.deepEqual(execs.map((e) => e.status), [0, 0], JSON.stringify(execs.map((e) => e.stderr)));
  const sha = git(dir, 'rev-parse', `tb/${id}`);
  assert.notEqual(sha, head, 'the agent committed on tb/<id>');
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', sha), 'Irfan <irfan@example.com>|Irfan <irfan@example.com>|docs: add a line');
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main', 'Irfan\'s main checkout did not move');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), wt, 'his repo hook ran on the agent\'s commit, in the worktree (tbd\'s copy)');
  assert.equal(git(remote, 'rev-parse', `refs/heads/tb/${id}`), sha, 'tb-git pushed tb/<id>');
  assert.deepEqual((await tbd.api('GET', `/api/tickets/${id}`)).json.ticket.approvals ?? [], [], 'no card: the grant was used');
  assert.equal(read(tbd, id).push_grant, undefined);

  const c = await tbd.api('POST', `/api/tickets/${id}/close`, {});
  assert.equal(c.status, 200, c.text);
  assert.deepEqual([read(tbd, id).state, read(tbd, id).task.kept], ['done', undefined]);
  assert.equal(fs.existsSync(wt), false, 'the worktree folder is gone');
  assert.equal(fs.existsSync(`${common}/worktrees/${id}`), false, 'its exact git folder is gone');
  assert.equal(fs.readFileSync(path.join(stale, 'gitdir'), 'utf8'), `${path.join(ROOT, 'gone', '.git')}\n`, 'a stale entry stays: no repo-wide prune');
  assert.equal(git(dir, 'rev-parse', `tb/${id}`), sha, 'the branch stays');
  assert.ok(fs.existsSync(path.join(sib, 'README.md')), 'Irfan\'s own worktree stays');
});
