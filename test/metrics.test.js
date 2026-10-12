'use strict';
// P3c AC10 (contract T5): the t:run `exit` value. The t:run line itself, through a real tbd: run-control.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-')); // before lib/metrics loads (AC10: never the real home)
const { exitOf, gate, GATE_FIELDS } = require('../lib/metrics');
const { EXITS } = require('../lib/stream');

test('P5 t:gate: every contract field present (null when not given), detail cut to 200 chars, the line appended as returned', async () => {
  const line = await gate({ ticket: 't_x', task: 'T1', gate: 'task', check: 'unit', ok: false, exit: 1, class: 'work', ms: 5, detail: 'x'.repeat(300) });
  assert.deepEqual(Object.keys(line), ['t', 'at', ...GATE_FIELDS]);
  assert.deepEqual([line.peak_rss_mb, line.slot_wait_ms, line.detail.length], [null, null, 200]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME, 'metrics.jsonl'), 'utf8').trim().split('\n').at(-1)), line);
});

test('t:run exit: every run end the runner records (App C enum + refusal, cancelled) as is; anything else → interrupted', () => {
  assert.deepEqual(EXITS.map(exitOf), ['result', 'schema_fail', 'max_turns', 'usage', 'refusal', 'crash', 'interrupted', 'stalled', 'paused', 'wall_cap', 'cancelled']);
  for (const x of [undefined, null, '', 'killed', 'toString']) assert.equal(exitOf(x), 'interrupted', String(x));
  fs.rmSync(process.env.TB_HOME, { recursive: true, force: true });
});
