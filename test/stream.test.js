'use strict';
// P3a AC1 parse edge cases (lib/stream.js): tail from an offset, liveness facts only, outcome from the LAST result
// line, untrusted lines (D31). The run-level outcomes through a real tbd + fake-claude are in runner.test.js.
// P3c AC9: the shown log lines, plain and gzipped (readLog, packLog); through a real tbd: run-control.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTail, outcome, OUTCOMES, readLog, packLog } = require('../lib/stream');

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
