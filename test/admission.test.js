'use strict';
// P2 AC2 admission table (spec §7, plan D2 + §3b deltas, P2 contract lib/admission.js). Pure: no processes,
// no clock. Config here is a fixed table fixture (D2 numbers) independent of store DEFAULTS; D36 runtime
// defaults are pinned in test/store.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admit, decide, canResume, needGb } = require('../lib/admission');

const GB = 1024 ** 3;
const config = {
  max_concurrent: 1,
  memory: { min_free_gb: 1, phase_need_gb: { planning: 0.7, review: 0.7, working: 1.5, qa: 2.5 }, docker_reserved_gb: 2, start_at_warn_when_idle: true },
  disk: { warn_gb: 15, stop_gb: 8 },
};
const two = { ...config, max_concurrent: 2 }; // so the slot rule does not hide the memory rules
const snap = (o = {}) => ({ pressure: 'normal', avail: 3 * GB, disk_free: 30 * GB, docker: false, ...o });
const OK = { ok: true };
const memory = { ok: false, reason: 'memory' };
const disk = { ok: false, reason: 'disk' };
const slot = { ok: false, reason: 'slot' };

test('AC2 admit table: reasons and their order (disk → slot → critical → warn+runs → avail)', () => {
  /** @type {[string, object, number, string, object, object, number?][]} */
  const rows = [
    ['warn + 1 running → memory (one by one)', snap({ pressure: 'warn' }), 1, 'planning', two, memory],
    ['warn + 0 running → ok (D2: 8 GB baseline is warn)', snap({ pressure: 'warn' }), 0, 'planning', config, OK],
    ['warn + 0, start_at_warn_when_idle off → memory', snap({ pressure: 'warn' }), 0, 'planning', { ...config, memory: { ...config.memory, start_at_warn_when_idle: false } }, memory],
    ['critical + 0 running → memory', snap({ pressure: 'critical' }), 0, 'planning', config, memory],
    ['normal, avail 1.6 < 1 + 0.7 → memory', snap({ avail: 1.6 * GB }), 0, 'planning', config, memory],
    ['normal, avail exactly 1 + 0.7 → ok', snap({ avail: 1.7 * GB }), 0, 'planning', config, OK],
    ['phase need: working 1 + 1.5 > 2.4 → memory', snap({ avail: 2.4 * GB }), 0, 'working', config, memory],
    ['Docker running adds docker_reserved_gb: 1 + 0.7 + 2 > 2.5 → memory', snap({ avail: 2.5 * GB, docker: true }), 0, 'planning', config, memory],
    ['same avail without Docker → ok', snap({ avail: 2.5 * GB }), 0, 'planning', config, OK],
    ['needGb from metrics overrides the phase default: 1 + 2 > 2.5 → memory', snap({ avail: 2.5 * GB }), 0, 'planning', config, memory, 2],
    ['disk 7.9 GB < 8 → disk', snap({ disk_free: 7.9 * GB }), 0, 'planning', config, disk],
    ['disk beats slot', snap({ disk_free: 7 * GB }), 1, 'planning', config, disk],
    ['runs ≥ max_concurrent → slot', snap(), 1, 'planning', config, slot],
    ['slot beats critical', snap({ pressure: 'critical' }), 1, 'planning', config, slot],
    ['no monitor reading yet → memory (never start blind)', null, 0, 'planning', config, memory],
    ['unknown pressure → memory', snap({ pressure: null }), 0, 'planning', config, memory],
    ['statfs failed (disk_free null) → disk', snap({ disk_free: null }), 0, 'planning', config, disk],
  ];
  for (const [name, s, runs, phase, cfg, want, need] of rows) {
    assert.deepEqual(admit({ snap: s, runs, phase, config: cfg, needGb: need }), want, name);
  }
});

test('AC2 decide: critical + 2 runs → pause the newest only; warn or no runs → nothing', () => {
  const runs = [
    { id: 'r_old', started_at: '2026-10-08T01:00:00.000Z' },
    { id: 'r_new', started_at: '2026-10-08T02:00:00.000Z' },
  ];
  assert.deepEqual(decide({ snap: snap({ pressure: 'critical' }), runs }), [{ type: 'pause', runId: 'r_new' }]);
  assert.deepEqual(decide({ snap: snap({ pressure: 'critical' }), runs: [...runs].reverse() }), [{ type: 'pause', runId: 'r_new' }], 'input order does not matter');
  assert.deepEqual(decide({ snap: snap({ pressure: 'warn' }), runs }), []);
  assert.deepEqual(decide({ snap: snap({ pressure: 'critical' }), runs: [] }), []);
});

test('AC2 canResume (D2 delta): true at warn when avail ≥ min_free + need; false at critical or low avail', () => {
  const run = { phase: 'planning' };
  assert.equal(canResume({ snap: snap({ pressure: 'warn', avail: 1.7 * GB }), run, config }), true, 'spec says normal; D2 allows warn');
  assert.equal(canResume({ snap: snap({ pressure: 'normal', avail: 1.7 * GB }), run, config }), true);
  assert.equal(canResume({ snap: snap({ pressure: 'critical', avail: 6 * GB }), run, config }), false);
  assert.equal(canResume({ snap: snap({ pressure: 'warn', avail: 1.6 * GB }), run, config }), false);
  assert.equal(canResume({ snap: snap({ avail: 2.5 * GB }), run: { phase: 'planning', need_gb: 2 }, config }), false, 'run need_gb beats the phase default');
});

test('AC2 needGb: median peak of the phase\'s last 10 t:run lines, else the config default', () => {
  const runLine = (phase, mb) => JSON.stringify({ t: 'run', phase, peak_rss_mb: mb });
  const lines = [
    ...Array.from({ length: 12 }, (_, i) => runLine('planning', (i + 1) * 100)), // last 10 = 300..1200 MB
    runLine('working', 9000),
    JSON.stringify({ t: 'drill', phase: 'planning', peak_rss_mb: 9000 }),
    '{"t":"run","phase":"planning","peak', // torn last line
  ];
  assert.equal(needGb('planning', lines, config), 750 / 1024, 'even count: mean of 700 and 800 MB');
  assert.equal(needGb('qa', [runLine('qa', 500), runLine('qa', 1500), runLine('qa', 900)], config), 900 / 1024, 'odd count: middle');
  assert.equal(needGb('review', lines, config), 0.7, 'no t:run lines → config default');
});
