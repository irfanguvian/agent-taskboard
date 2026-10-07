'use strict';
// P0 AC7: fake-claude replays scenarios, honors --session-id/--resume, dumps argv+env, writes result line,
// supports crash/hang/refusal/usage-limit modes. Spawned as a real child like spec §8 (prompt file in, files out).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake-claude.js');
const REAL = path.join(__dirname, 'fixtures/stream/real-sonnet-sample.jsonl');
const SID = '11111111-1111-4111-8111-111111111111';

// Every flag on the spec §9 spawn line, values shaped like production.
const SPAWN_ARGS = ['-p', '--session-id', SID, '--setting-sources', 'project', '--settings', 'settings.json',
  '--append-system-prompt-file', 'prompt.md', '--add-dir', 'skills', '--add-dir', 'tagdir', '--strict-mcp-config',
  '--mcp-config', 'mcp.json', '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Agent', '--permission-mode', 'dontAsk',
  '--permission-prompts', 'none', '--model', 'opus', '--effort', 'xhigh', '--fallback-model', 'opus', '--max-turns', '40',
  '--json-schema', 'result.schema.json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

// Spawn the fake by its shebang (as runner's claude_bin will), isolated HOME, prompt on stdin, stdout/stderr to files.
function start(dir, { args = SPAWN_ARGS, env = {}, prompt = 'do the task', name = 'run' } = {}) {
  const promptFile = path.join(dir, `${name}.prompt`);
  fs.writeFileSync(promptFile, prompt);
  const out = path.join(dir, `${name}.jsonl`);
  const err = path.join(dir, `${name}.err`);
  const fds = [fs.openSync(promptFile, 'r'), fs.openSync(out, 'w'), fs.openSync(err, 'w')];
  const child = spawn(FAKE, args, {
    stdio: fds,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(dir, 'home'), ...env },
  });
  fds.forEach((fd) => fs.closeSync(fd));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const read = () => ({
    lines: fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    err: fs.readFileSync(err, 'utf8'),
  });
  return { child, exited, read };
}

async function run(dir, opts) {
  const r = start(dir, opts);
  return { ...(await r.exited), ...r.read() };
}

test('happy path: init then result with structured_output, session id from --session-id', async (t) => {
  const dir = tmp(t);
  const scenario = writeJson(path.join(dir, 's.json'), { steps: [{ result: { structured_output: { answer: 'ok' } } }] });
  const r = await run(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario } });
  assert.equal(r.code, 0);
  assert.equal(r.err, '', 'every §9 flag accepted without warning');
  assert.deepEqual(r.lines.map((l) => `${l.type}/${l.subtype}`), ['system/init', 'result/success']);
  assert.ok(r.lines.every((l) => l.session_id === SID));
  const res = r.lines.at(-1);
  assert.deepEqual(res.structured_output, { answer: 'ok' });
  assert.equal(res.result, '{"answer":"ok"}');
  assert.equal(res.is_error, false);
});

test('result line carries every field of the real claude result line', async (t) => {
  const dir = tmp(t);
  const real = fs.readFileSync(REAL, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  const scenario = writeJson(path.join(dir, 's.json'), { steps: [{ result: { structured_output: { answer: 'ok' } } }] });
  const fake = (await run(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario } })).lines.at(-1);
  assert.equal(real.type, 'result');
  assert.deepEqual(Object.keys(real).filter((k) => !(k in fake)), []);
});

test('unknown flag warns on stderr but the run still completes', async (t) => {
  const dir = tmp(t);
  const r = await run(dir, { args: [...SPAWN_ARGS, '--brand-new-flag'] });
  assert.equal(r.code, 0);
  assert.match(r.err, /unknown flag --brand-new-flag/);
  assert.equal(r.lines.at(-1).type, 'result');
});

test('dump: argv, selected env with secrets redacted, cwd and prompt', async (t) => {
  const dir = tmp(t);
  const dump = path.join(dir, 'dump');
  fs.mkdirSync(dump);
  const env = { FAKE_CLAUDE_DUMP_DIR: dump, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', GIT_CONFIG_COUNT: '2',
    DISABLE_AUTOUPDATER: '1', TBD_SOCK: '/tmp/tbd.sock', GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-secret',
    UNRELATED_VAR: 'x' };
  await run(dir, { env, prompt: 'Your previous run was interrupted.' });
  const d = JSON.parse(fs.readFileSync(path.join(dump, '1.json'), 'utf8'));
  assert.deepEqual(d.argv, SPAWN_ARGS);
  assert.deepEqual(d.opts['--add-dir'], ['skills', 'tagdir']);
  assert.equal(d.opts['--model'], 'opus');
  assert.equal(d.prompt, 'Your previous run was interrupted.');
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(process.cwd()));
  assert.equal(d.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '3');
  assert.equal(d.env.GIT_CONFIG_COUNT, '2');
  assert.equal(d.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(d.env.TBD_SOCK, '/tmp/tbd.sock');
  assert.equal(d.env.GH_TOKEN, '<redacted>');
  assert.equal(d.env.ANTHROPIC_API_KEY, '<redacted>');
  assert.equal('UNRELATED_VAR' in d.env, false);
  assert.equal('SSH_AUTH_SOCK' in d.env, false, 'unset keys stay absent');
  assert.doesNotMatch(fs.readFileSync(path.join(dump, '1.json'), 'utf8'), /secret/);
});

test('crash: exits with the scripted code and no result line', async (t) => {
  const dir = tmp(t);
  const scenario = writeJson(path.join(dir, 's.json'),
    { steps: [{ emit: { type: 'assistant', message: { role: 'assistant', content: [] } } }, { crash: 3 }, { result: {} }] });
  const r = await run(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario } });
  assert.equal(r.code, 3);
  assert.deepEqual(r.lines.map((l) => l.type), ['system', 'assistant']);
});

test('hang: flushes events, stays alive, dies only to SIGKILL without a result line', { timeout: 10000 }, async (t) => {
  const dir = tmp(t);
  const scenario = writeJson(path.join(dir, 's.json'), { steps: [{ emit: { type: 'system', subtype: 'status' } }, { hang: true }] });
  const r = start(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario } });
  while (r.read().lines.length < 2) await new Promise((res) => setTimeout(res, 20));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.child.exitCode, null, 'still running after its last event');
  r.child.kill('SIGKILL');
  assert.deepEqual(await r.exited, { code: null, signal: 'SIGKILL' });
  assert.equal(r.read().lines.some((l) => l.type === 'result'), false);
});

test('scenario dir: run 1 crashes, resume run 2 succeeds on same session, run 3 unscripted fails', async (t) => {
  const dir = tmp(t);
  const sdir = path.join(dir, 'scen');
  fs.mkdirSync(sdir);
  writeJson(path.join(sdir, '1.json'), { steps: [{ crash: 1 }] });
  writeJson(path.join(sdir, '2.json'), { steps: [{ result: { structured_output: { answer: 'resumed' } } }] });
  const env = { FAKE_CLAUDE_SCENARIO_DIR: sdir };

  const r1 = await run(dir, { env, name: 'r1' });
  assert.equal(r1.code, 1);
  assert.equal(r1.lines.some((l) => l.type === 'result'), false);

  const resumeArgs = SPAWN_ARGS.filter((a, i) => a !== '--session-id' && SPAWN_ARGS[i - 1] !== '--session-id');
  const r2 = await run(dir, { env, name: 'r2', args: ['--resume', SID, ...resumeArgs] });
  assert.equal(r2.code, 0);
  assert.ok(r2.lines.every((l) => l.session_id === SID));
  assert.deepEqual(r2.lines.at(-1).structured_output, { answer: 'resumed' });

  const r3 = await run(dir, { env, name: 'r3' });
  assert.equal(r3.code, 2);
  assert.match(r3.err, /cannot load scenario .*3\.json/);
  assert.deepEqual(r3.lines, []);
});

test('usage_limit: rate_limit_event rejected with reset time, then an error result', async (t) => {
  const dir = tmp(t);
  const scenario = writeJson(path.join(dir, 's.json'), { steps: ['usage_limit'] });
  const r = await run(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario } });
  const ev = r.lines.find((l) => l.type === 'rate_limit_event');
  assert.equal(ev.rate_limit_info.status, 'rejected');
  assert.ok(ev.rate_limit_info.resetsAt > Date.now() / 1000);
  const res = r.lines.at(-1);
  assert.equal(res.type, 'result');
  assert.equal(res.is_error, true);
  assert.equal(res.api_error_status, 429);
  assert.equal(r.code, 1);
});

test('mode shortcuts produce the real result subtypes and events', async (t) => {
  const dir = tmp(t);
  const cases = {
    max_turns: (ls) => assert.deepEqual([ls.at(-1).subtype, ls.at(-1).is_error, 'result' in ls.at(-1)], ['error_max_turns', true, false]),
    schema_fail: (ls) => assert.equal(ls.at(-1).subtype, 'error_max_structured_output_retries'),
    refusal: (ls) => assert.deepEqual([ls.at(-2).message.stop_reason, ls.at(-1).stop_reason, 'structured_output' in ls.at(-1)], ['refusal', 'refusal', false]),
    invalid_json: (ls) => assert.equal(typeof ls.at(-1).structured_output, 'string'),
    api_retry: (ls) => assert.deepEqual([ls[1].subtype, ls[1].attempt, ls[1].error_status], ['api_retry', 1, 529]),
  };
  for (const [name, check] of Object.entries(cases)) {
    const steps = name === 'api_retry' ? [name, { result: {} }] : [name]; // api_retry is an event, not an ending
    const scenario = writeJson(path.join(dir, `${name}.json`), { steps });
    const r = await run(dir, { env: { FAKE_CLAUDE_SCENARIO: scenario }, name });
    check(r.lines);
  }
  const bad = writeJson(path.join(dir, 'bad.json'), { steps: ['no_such_mode'] });
  const r = await run(dir, { env: { FAKE_CLAUDE_SCENARIO: bad }, name: 'bad' });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown shortcut no_such_mode/);
});
