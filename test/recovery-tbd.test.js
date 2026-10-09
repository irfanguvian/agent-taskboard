'use strict';
// P3b (plan P3 AC1 AC5; spec §8) with real processes: lib/runner.js + lib/recovery.js inside a real tbd (harness temp
// HOME + TB_HOME), test/fake-claude.js as claude_bin (resume_steps when run with --resume), test/helpers/run-spy.js
// (kills reach only this test's fake-claude processes; real read-only `git status`; net probe and caffeinate spied).
// liveness.stall_min is 0.05 (3 s) here; every timing rule on a fake clock: test/recovery.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTbd } = require('./helpers/tbd');
const { FAKE, RUN_SPY, ticket, read, hasRun, spyLog, until, alive, reap, pidsOf } = require('./helpers/runs');
const { RESUME_PROMPT } = require('../lib/spawn');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-tbd-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
fs.mkdirSync(path.join(PHASES, 'code/planning'), { recursive: true });
for (const [f, c] of Object.entries({ 'prompt.md': '# planning fixture\n', 'settings.json': '{"permissions":{"allow":["Read"]}}', 'result.schema.json': '{"type":"object"}' })) {
  fs.writeFileSync(path.join(PHASES, 'code/planning', f), c);
}
const CONFIG = { // admission always yes (unless critical pressure); a run silent 3 s is stalled
  claude_bin: FAKE,
  memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true },
  disk: { warn_gb: 0, stop_gb: 0 },
  liveness: { quiet_min: 0.02, stall_min: 0.05, wake_grace_min: 6, wall_min: { planning: 30, working_task: 45, review: 30, qa: 60 } },
};
const dump = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));

// One ticket in planning; its runs follow scenario (fake-claude), dumping argv/env/prompt to <ROOT>/<id>-dump/<n>.json.
async function boot(t, id, scenario, over = {}) {
  const [file, dir] = [path.join(ROOT, `${id}.json`), path.join(ROOT, `${id}-dump`)];
  fs.writeFileSync(file, JSON.stringify(scenario));
  fs.mkdirSync(dir);
  const tbd = await startTbd({
    files: { 'config.json': CONFIG, [`tickets/${id}/ticket.json`]: ticket(id, over) },
    env: { TB_PHASES_DIR: PHASES, NODE_OPTIONS: RUN_SPY, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_DUMP_DIR: dir },
  });
  t.after(async () => { reap(pidsOf(tbd)); await tbd.stop(); });
  return { tbd, dir };
}

test('AC5 stall: the hang ignores SIGINT → SIGKILL after 10 s, kill(pid, 0) finds it gone; resumed with --resume <session> (no --session-id, no new env var), the §8 prompt + dirty-tree note; 1 failure', async (t) => {
  const repo = path.join(ROOT, 'wt');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
  fs.mkdirSync(repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  const scenario = { steps: [{ hang: 'ignore_sigint' }], resume_steps: [{ result: { structured_output: { answer: 'resumed' } } }] };
  const base_sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); // S1: a worktree run needs its base
  const { tbd, dir } = await boot(t, 't_stall1', scenario, { worktree: repo, base_sha });
  const l1 = await until(() => read(tbd, 't_stall1').lease?.lstart && read(tbd, 't_stall1').lease, 15_000, 'run 1 live');
  const int = await until(() => spyLog(tbd, 'test-kills.jsonl').find((k) => k.pid === l1.pid && k.sig === 'SIGINT'), 20_000, 'SIGINT after the stall');
  const sent = Date.now();
  await until(() => !alive(l1.pid), 20_000, 'run 1 gone');
  assert.ok(Date.now() - sent >= 9_500, `SIGKILL only after the 10 s grace (gone ${Date.now() - sent} ms after SIGINT)`);
  const l2 = await until(() => read(tbd, 't_stall1').lease?.exit === 'result' && read(tbd, 't_stall1').lease, 20_000, 'resumed run ended');
  assert.deepEqual(spyLog(tbd, 'test-kills.jsonl').filter((k) => k.pid === l1.pid).map((k) => [k.sig, k.ok]), [['SIGINT', true], ['SIGKILL', true]]);
  assert.equal(int.who, 'runner');
  const [d1, d2] = [dump(dir, 1), dump(dir, 2)];
  assert.deepEqual([d1.opts['--session-id'], d1.opts['--resume']], [l1.session, undefined]);
  assert.deepEqual([d2.opts['--resume'], d2.argv.includes('--session-id')], [l1.session, false]);
  assert.deepEqual(Object.keys(d2.env).sort(), Object.keys(d1.env).sort(), 'no resume env var');
  assert.equal(d2.prompt, `${RESUME_PROMPT}\n\nThe working tree has uncommitted changes (git status --porcelain):\n M a.txt\n?? new.txt\n`);
  assert.equal(fs.realpathSync(d2.cwd), fs.realpathSync(repo));
  const k = read(tbd, 't_stall1');
  assert.deepEqual([l2.gen, l2.log, l2.resumed, k.failures, k.state], [2, 'runs/2.jsonl', true, { planning: 1 }, 'planning']);
  assert.deepEqual(spyLog(tbd, 'test-handled.jsonl').map((h) => h.output), [{ answer: 'resumed' }]);
});

test('AC5 step 6: a run that crashes every time is resumed (--resume, same session) 3 times; the 4th failure → Blocked, no 5th run', async (t) => {
  const { tbd, dir } = await boot(t, 't_crash4', { steps: [{ crash: 3 }] });
  await until(() => read(tbd, 't_crash4').state === 'blocked', 30_000, 'blocked');
  const k = read(tbd, 't_crash4');
  assert.deepEqual([k.failures, k.blocked_from, k.lease.exit], [{ planning: 4 }, 'planning', 'crash']);
  await new Promise((r) => setTimeout(r, 1500));
  const runs = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  assert.equal(runs.length, 4, 'no 5th run');
  const s = dump(dir, 1).opts['--session-id'];
  assert.deepEqual([1, 2, 3, 4].map((n) => [dump(dir, n).opts['--session-id'] ?? null, dump(dir, n).opts['--resume'] ?? null]), [[s, null], [null, s], [null, s], [null, s]]);
});

test('AC1 usage limit: a run ending on the limit → exit usage + resets_at from its rate_limit_event, waiting usage; resumed after the reset, not counted', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 8;
  const steps = [
    { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' } } },
    { result: { is_error: true, api_error_status: 429, stop_reason: null, result: `Claude AI usage limit reached|${reset}` } },
  ];
  const { tbd } = await boot(t, 't_usage2', { steps, resume_steps: [{ result: { structured_output: { answer: 'after reset' } } }] });
  const l1 = await until(() => read(tbd, 't_usage2').lease?.exit === 'usage' && read(tbd, 't_usage2').lease, 15_000, 'paused on the limit');
  assert.equal(l1.resets_at, new Date(reset * 1000).toISOString());
  await until(() => read(tbd, 't_usage2').waiting?.reason === 'usage', 5000, 'waiting usage');
  assert.ok(Date.now() < reset * 1000 && !hasRun(tbd, 't_usage2', 2), 'no resume before the reset');
  const l2 = await until(() => read(tbd, 't_usage2').lease?.exit === 'result' && read(tbd, 't_usage2').lease, 20_000, 'resumed after the reset');
  assert.ok(Date.parse(l2.started_at) >= reset * 1000, 'not before the reset');
  assert.deepEqual([l2.resumed, l2.session, read(tbd, 't_usage2').failures], [true, l1.session, {}]);
  assert.deepEqual(spyLog(tbd, 'test-handled.jsonl').map((h) => h.output), [{ answer: 'after reset' }]);
});
