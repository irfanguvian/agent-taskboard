'use strict';
// P3a AC1 parse edge cases (lib/stream.js): tail from an offset, liveness facts only, outcome from the LAST result
// line, untrusted lines (D31). The run-level outcomes through a real tbd + fake-claude are in runner.test.js.
// P3c AC9: the shown log lines, plain and gzipped (readLog, packLog); through a real tbd: run-control.test.js.
// board-terminal-parity Phase 3: the Now card's run facts (tail) and the activity feed rows (brief); the route: run-control.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTail, outcome, OUTCOMES, readLog, packLog, brief } = require('../lib/stream');

const REAL = path.join(__dirname, 'fixtures/stream/real-sonnet-sample.jsonl');
const SID = '00000000-0000-4000-8000-000000000000'; // the fixture's session
const line = (o) => JSON.stringify({ session_id: SID, ...o }) + '\n';
const result = (o) => line({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, ...o });

function log(t, text = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '1.jsonl');
  fs.writeFileSync(file, text);
  return { file, add: (s) => fs.appendFileSync(file, s) };
}

test('real sonnet log: result with structured_output, tool opened and closed, last event = file mtime, no text kept', async (t) => {
  const { file } = log(t, fs.readFileSync(REAL, 'utf8'));
  const tail = createTail(file);
  const s = await tail.read({ final: true });
  assert.deepEqual(outcome(s, { session: SID }), { exit: 'result', output: { answer: 'ok' } });
  assert.deepEqual([s.events, s.tool_uses, s.tool, s.bad_lines, s.rate_limit?.status], [14, 1, null, 0, 'allowed']);
  assert.equal(s.last_event_at, fs.statSync(file).mtime.toISOString());
  assert.equal(s.offset, fs.statSync(file).size);
  assert.doesNotMatch(JSON.stringify(s), /Structured output provided|msg_PLACEHOLDER/, 'no message text in the state');
  assert.deepEqual(outcome(s, { session: 'other-session' }), { exit: 'crash' }, 'a result of another session is not this run');
});

test('tail reads only what was appended; a half line waits for its newline; tool name tracked until its result', async (t) => {
  const { file, add } = log(t);
  const tail = createTail(file);
  assert.equal((await tail.read()).events, 0, 'empty log');
  const use = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'secret-cmd' } }] } });
  add(use.slice(0, 20));
  let s = await tail.read();
  assert.deepEqual([s.events, s.tool, s.offset], [0, null, 20]);
  add(use.slice(20));
  s = await tail.read();
  assert.deepEqual([s.events, s.tool], [1, 'Bash']);
  assert.doesNotMatch(JSON.stringify(s), /secret-cmd/);
  add(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'evil\u001b[31m name' }] } }));
  assert.equal((await tail.read()).tool, 'tool', 'an odd tool name is not echoed');
  add(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2' }, { type: 'tool_result', tool_use_id: 'tu1' }] } }));
  assert.equal((await tail.read()).tool, null);
});

test('invalid JSON lines are counted and skipped; the outcome still comes from the last valid result line', async (t) => {
  const { file, add } = log(t, 'not json\n[1,2]\n"str"\n{"no_type":1}\n');
  const tail = createTail(file);
  add(result({ structured_output: { n: 1 } }));
  add(result({ subtype: 'error_max_turns', is_error: true })); // the LAST result decides
  add('{"type":"result","subtype":"succ'); // torn final line: no newline
  let s = await tail.read();
  assert.equal(s.bad_lines, 4);
  assert.deepEqual(outcome(s, { session: SID }), { exit: 'max_turns' });
  s = await tail.read({ final: true }); // writer gone: the torn line is read, still not JSON
  assert.equal(s.bad_lines, 5);
  assert.deepEqual(outcome(s, { session: SID }), { exit: 'max_turns' });
});

test('outcome table: each ending → its exit; envelope checked field by field', async (t) => {
  const R = (o) => ({ type: 'result', subtype: 'success', is_error: false, session_id: SID, ...o });
  const RESET = { resetsAt: 1791393600 }; // 2026-10-07T17:20:00Z
  /** @type {[any[], any][]} */
  const cases = [
    [[R({ structured_output: { a: 1 } })], { exit: 'result', output: { a: 1 } }],
    [[R({ structured_output: 'not an object', result: '"not an object"' })], { exit: 'schema_fail' }], // fake invalid_json
    [[R({})], { exit: 'schema_fail' }], // success without structured_output
    [[R({ subtype: 'error_max_structured_output_retries', is_error: true })], { exit: 'schema_fail' }],
    [[R({ subtype: 'error_max_turns', is_error: true })], { exit: 'max_turns' }],
    [[R({ is_error: true, stop_reason: 'refusal', result: "I can't help with that." })], { exit: 'refusal' }],
    [[R({ stop_reason: 'refusal', structured_output: { a: 1 } })], { exit: 'refusal' }], // refusal wins over a success shape
    [[R({ is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached|1791393600' })], { exit: 'usage', resets_at: '2026-10-07T17:20:00.000Z' }],
    [[{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...RESET } }], { exit: 'usage', resets_at: '2026-10-07T17:20:00.000Z' }], // ended on the limit
    [[{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', ...RESET } }, R({ structured_output: {} })], { exit: 'result', output: {} }], // banner only
    [[R({ subtype: 'error_during_execution', is_error: true })], { exit: 'crash' }],
    [[R({ is_error: 'false', structured_output: {} })], { exit: 'crash' }], // is_error not a boolean
    [[R({ total_cost_usd: 'NaN', structured_output: {} })], { exit: 'crash' }],
    [[R({ session_id: 42, structured_output: {} })], { exit: 'crash' }],
  ];
  for (const [lines, want] of cases) {
    const { file } = log(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.deepEqual(outcome(await createTail(file).read({ final: true }), { session: SID }), want, JSON.stringify(lines));
  }
  assert.deepEqual([...new Set(cases.map(([, w]) => w.exit))].sort(), OUTCOMES.filter((e) => e !== 'interrupted').sort(), 'every outcome but interrupted covered above');
  const none = { result: null, rejected: null };
  assert.deepEqual(outcome(none, { code: 3, session: SID }), { exit: 'crash' }, 'exit code seen, no result');
  assert.deepEqual(outcome(none, { code: null, session: SID }), { exit: 'interrupted' }, 'gone, exit unknown (re-attach) or a signal');
  assert.deepEqual(outcome(none, { code: 0, session: SID }), { exit: 'interrupted' });
});

test('P3b liveness facts: tool_since = the mtime when that tool_use id appeared (a 2nd Bash restarts it), cleared with its result; retrying only while the last event is system/api_retry', async (t) => {
  const { file, add } = log(t);
  const tail = createTail(file);
  const at = (sec) => fs.utimesSync(file, sec, sec);
  add(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash' }] } }));
  at(1_000_000);
  let s = await tail.read();
  assert.deepEqual([s.tool, s.tool_since, s.retrying], ['Bash', new Date(1e9).toISOString(), false]);
  add(line({ type: 'system', subtype: 'status' }));
  at(1_000_060);
  s = await tail.read();
  assert.deepEqual([s.tool, s.tool_since], ['Bash', new Date(1e9).toISOString()], 'same tool: since unchanged');
  add(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }));
  add(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash' }] } }));
  at(1_000_120);
  s = await tail.read();
  assert.deepEqual([s.tool, s.tool_since], ['Bash', new Date(1_000_120_000).toISOString()], 'another Bash: its own start');
  add(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2' }] } }));
  add(line({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' }));
  s = await tail.read();
  assert.deepEqual([s.tool, s.tool_since, s.retrying], [null, null, true]);
  add(line({ type: 'stream_event', event: { type: 'message_start' } }));
  assert.equal((await tail.read()).retrying, false, 'the retry went through');
});

test('P3c AC9 readLog: shown lines of a live log (no partial-message deltas, one line each, no control characters), an after cursor, the same lines from the .gz once packed (0600); no log → null', async (t) => {
  const { file, add } = log(t, fs.readFileSync(REAL, 'utf8'));
  const shown = ['init · model claude-sonnet-5-5 · claude 2.1.292', 'tool StructuredOutput: {"answer":"ok"}', 'tool result: Structured output provided successfully',
    'rate limit allowed · resets 2026-10-07T17:20:00.000Z', 'result success · turns 2 · $0.02']; // of 14 events
  const first = await readLog(file);
  assert.deepEqual(first, { lines: shown, offset: fs.statSync(file).size, ended: false });
  assert.deepEqual((await readLog(file, { tail: 2 })).lines, shown.slice(-2));
  add(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'two\nlines \u001b[31mred' }] } }));
  add('{"type":"assistant","message":{"content":[{"type":"text","text":"torn'); // no newline yet: not shown
  const next = await readLog(file, { after: first.offset });
  assert.deepEqual(next.lines, ['assistant: two lines [31mred'], 'one line, the escape character gone');
  add('"}]}}\n');
  const size = fs.statSync(file).size;
  assert.equal(await packLog(file), true);
  assert.deepEqual([fs.existsSync(file), fs.statSync(`${file}.gz`).mode & 0o777], [false, 0o600]);
  assert.deepEqual(await readLog(file, { after: next.offset }), { lines: ['assistant: torn'], offset: size, ended: true }, 'the cursor goes on in the .gz');
  assert.deepEqual((await readLog(file)).lines, [...shown, 'assistant: two lines [31mred', 'assistant: torn']);
  assert.equal(await packLog(file), false, 'packed once');
  assert.equal(await readLog(path.join(path.dirname(file), '9.jsonl')), null);
});

// board-terminal-parity Phase 3, expected values from .omc/handoffs/btp-p3-server.md contract A
test('Phase 3 run facts: model from init, ctx_tokens of the main session only, 2 subagents start → completed (a background Bash is none), one denial, doing = the open tool + its input in short', async (t) => {
  const sys = (o) => line({ type: 'system', ...o });
  const usage = (n) => ({ input_tokens: n, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 });
  const { file } = log(t, [
    sys({ subtype: 'init', model: 'claude-sandbox-1' }),
    line({ type: 'assistant', parent_tool_use_id: null, message: { usage: usage(10), content: [{ type: 'text', text: 'checking the shop' }] } }),
    sys({ subtype: 'task_started', task_id: 'sub1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Map the shop routes' }),
    sys({ subtype: 'task_started', task_id: 'sub2', task_type: 'local_agent', subagent_type: 'Plan', description: 'Plan the cart fix' }),
    sys({ subtype: 'task_started', task_id: 'bash1', task_type: 'local_bash', description: 'Start the shop app' }),
    sys({ subtype: 'task_progress', task_id: 'sub1', last_tool_name: 'Grep', usage: { total_tokens: 2048 } }),
    line({ type: 'assistant', parent_tool_use_id: 'toolu_task1', message: { usage: usage(90000), content: [] } }), // a subagent's context
    sys({ subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu9', decision_reason_type: 'mode' }),
    sys({ subtype: 'task_notification', task_id: 'sub1', status: 'completed' }),
    sys({ subtype: 'task_updated', task_id: 'sub2', patch: { status: 'completed' } }),
    line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test --\nshop' } }] } }),
  ].join(''));
  const tail = createTail(file);
  const s = await tail.read();
  assert.deepEqual([s.model, s.ctx_tokens, s.denied, tail.doing()], ['claude-sandbox-1', 1110, 1, { tool: 'Bash', text: 'npm test -- shop' }]);
  assert.deepEqual(s.subs, [
    { id: 'sub1', desc: 'Map the shop routes', type: 'Explore', tool: 'Grep', tokens: 2048, status: 'completed' },
    { id: 'sub2', desc: 'Plan the cart fix', type: 'Plan', tool: null, tokens: null, status: 'completed' },
  ]);
});

// contract C: one row per kind, a subagent's line → none
test('Phase 3 brief(): Read, Ran, Failed, Started subagent, Refused, Said (control + bidi characters out); a subagent line → no row', () => {
  const T = '2026-10-19T02:06:22.258Z';
  const use = (name, input, o = {}) => ({ type: 'assistant', parent_tool_use_id: null, timestamp: T, message: { content: [{ type: 'tool_use', id: 'tu1', name, input }] }, ...o });
  /** @type {[object, object[]][]} */
  const cases = [
    [use('Read', { file_path: 'shop/cart.js' }), [{ at: T, text: 'Read shop/cart.js', tone: 'info' }]],
    [use('Bash', { command: 'npm test' }), [{ at: T, text: 'Ran npm test', tone: 'info' }]],
    [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Exit code 1\nshop test failed' }] } },
      [{ at: null, text: 'Failed: Exit code 1 shop test failed', tone: 'bad' }]],
    [{ type: 'system', subtype: 'task_started', task_id: 'sub1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Map the shop' },
      [{ at: null, text: 'Started subagent Map the shop (Explore)', tone: 'info' }]],
    [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu1' }, [{ at: null, text: 'Refused Bash', tone: 'warn' }]],
    [{ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: 'cart \u001b[31mfixed\u202e ok' }] } }, [{ at: T, text: 'Said: cart [31mfixed ok', tone: 'info' }]],
    [use('Read', { file_path: 'shop/cart.js' }, { parent_tool_use_id: 'toolu_task1' }), []],
  ];
  for (const [ev, want] of cases) assert.deepEqual(brief(JSON.stringify(ev)), want, JSON.stringify(ev));
  // live sample: a subagent's task_notification summary is claude's handback note; its name comes from its start
  const seen = { at: null };
  brief(JSON.stringify(cases[3][0]), seen);
  assert.deepEqual(brief(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'sub1', status: 'completed', summary: `This agent's report was delivered to you as a message from "a1" (its SubagentHandback call). Read it there.` }), seen),
    [{ at: null, text: 'Finished subagent Map the shop (completed)', tone: 'ok' }]);
});
