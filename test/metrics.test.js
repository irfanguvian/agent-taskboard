'use strict';
// P3c AC10 (contract T5): the t:run `exit` value. The t:run line itself, through a real tbd: run-control.test.js.
// M7 (MT1 MT2): t:ticket's approve + hands-on fields (D-0148), metrics.jsonl rotation at 32 MB (O3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-')); // before lib/metrics loads (AC10: never the real home)
const { exitOf, gate, ticket, GATE_FIELDS, append, load, runs } = require('../lib/metrics');
const { EXITS } = require('../lib/stream');

test('P5 t:gate: every contract field present (null when not given), detail cut to 200 chars, the line appended as returned', async () => {
  const line = await gate({ ticket: 't_x', task: 'T1', gate: 'task', check: 'unit', ok: false, exit: 1, class: 'work', ms: 5, detail: 'x'.repeat(300) });
  assert.deepEqual(Object.keys(line), ['t', 'at', ...GATE_FIELDS]);
  assert.deepEqual([line.peak_rss_mb, line.slot_wait_ms, line.detail.length], [null, null, 200]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME, 'metrics.jsonl'), 'utf8').trim().split('\n').at(-1)), line);
});

test('M5.3 t:ticket phase_minutes: the final gate counts like any agent phase; a wait state (clarify) does not', async () => {
  const dir = path.join(process.env.TB_HOME, 't_fin001');
  fs.mkdirSync(dir);
  const at = (min) => new Date(Date.parse('2026-10-14T00:00:00Z') + min * 60_000).toISOString();
  const moves = [['qa', 'clarify', 10], ['clarify', 'qa', 30], ['qa', 'final_gate', 35], ['final_gate', 'done', 50]];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), moves.map(([from, to, min]) => JSON.stringify({ t: at(min), kind: 'transition', id: 't_fin001', from, to })).join('\n'));
  const line = await ticket({ id: 't_fin001', kind: 'code', state: 'done', created_at: at(0) }, dir);
  assert.deepEqual(line.phase_minutes, { qa: 15, final_gate: 15 });
});

test('M7 MT1 t:ticket: at, created_at, approved_at = the first plan_approval → working, hands_on = cli / ui rows after it but close + push; rows before it and lavish ones never count; never approved → null', async () => {
  const at = (min) => new Date(Date.parse('2026-10-16T00:00:00Z') + min * 60_000).toISOString();
  const seed = (id, moves, rows) => {
    const dir = path.join(process.env.TB_HOME, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), moves.map(([from, to, min]) => JSON.stringify({ t: at(min), kind: 'transition', id, from, to })).join('\n'));
    fs.writeFileSync(path.join(dir, 'interventions.jsonl'), rows.map(([actor, verb, min]) => `${JSON.stringify({ at: at(min), actor, verb, task: null, payload_sha256: 'x' })}\n`).join(''));
    return dir;
  };
  const rows = [['cli', 'answer', 2], ['cli', 'rework', 12], ['ui', 'scope', 13], ['lavish', 'answer', 14], ['cli', 'close', 15], ['ui', 'push', 16], ['ui', 'resume', 17]];
  const moves = [['planning', 'plan_approval', 5], ['plan_approval', 'working', 10], ['working', 'planning', 20], ['planning', 'plan_approval', 25], ['plan_approval', 'working', 30], ['working', 'done', 40]];
  const t0 = Date.now();
  const line = await ticket({ id: 't_hand01', kind: 'code', state: 'done', created_at: at(0) }, seed('t_hand01', moves, rows));
  assert.deepEqual([line.created_at, line.approved_at, line.hands_on], [at(0), at(10), 3], 'rework, scope, resume after the first approve');
  assert.ok(Date.parse(line.at) >= t0 && Date.parse(line.at) <= Date.now(), line.at);
  const never = await ticket({ id: 't_hand02', kind: 'code', state: 'cancelled', created_at: at(0) }, seed('t_hand02', [['planning', 'cancelled', 5]], rows));
  assert.deepEqual([never.approved_at, never.hands_on], [null, null]);
});

test('M7 MT2 rotation: a small metrics.jsonl never rotates; over 32 MB the next append renames it to metrics.1.jsonl and starts anew (load() tops up from its tail); 2 appends at once → 1 rename', async () => {
  const M = path.join(process.env.TB_HOME, 'metrics.jsonl');
  const M1 = path.join(process.env.TB_HOME, 'metrics.1.jsonl');
  const linesOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const drill = (note) => ({ t: 'drill', at: new Date().toISOString(), name: 'disk', ok: true, note });
  await append(drill('small'));
  assert.ok(fs.statSync(M).size < 8 * 1024 && !fs.existsSync(M1), `a ${fs.statSync(M).size} B file: no metrics.1.jsonl`);

  fs.truncateSync(M, 33 << 20); // sparse: no 33 MB written
  fs.appendFileSync(M, `\n${JSON.stringify({ t: 'run', ticket: 't_rot001', phase: 'working', peak_rss_mb: 700 })}\n`); // a line after the zeros
  const old = fs.statSync(M).size;
  const a = drill('a');
  await append(a);
  assert.deepEqual([fs.statSync(M1).size, linesOf(M)], [old, [a]], 'metrics.1.jsonl = the old file; metrics.jsonl holds the one new line');
  await load();
  assert.ok(runs().some((r) => r.ticket === 't_rot001'), 'admission keeps the t:run lines of metrics.1.jsonl\'s tail');

  fs.truncateSync(M, 33 << 20);
  const old2 = fs.statSync(M).size;
  const [b, c] = [drill('b'), drill('c')];
  await Promise.all([append(b), append(c)]);
  assert.deepEqual([fs.statSync(M1).size, linesOf(M)], [old2, [b, c]], 'one rename: the second append saw the new file');
});

test('t:run exit: every run end the runner records (App C enum + refusal, cancelled) as is; anything else → interrupted', () => {
  assert.deepEqual(EXITS.map(exitOf), ['result', 'schema_fail', 'max_turns', 'usage', 'refusal', 'crash', 'interrupted', 'stalled', 'paused', 'wall_cap', 'cancelled']);
  for (const x of [undefined, null, '', 'killed', 'toString']) assert.equal(exitOf(x), 'interrupted', String(x));
  fs.rmSync(process.env.TB_HOME, { recursive: true, force: true });
});
