'use strict';
// admission: may a run start, which run to pause, may a paused run resume (spec §7, plan D2 + §3b deltas).
// Pure: inputs are a monitor snapshot (bytes), config and run data; no clock, no I/O.
const GB = 1024 ** 3;
const memory = Object.freeze({ ok: false, reason: 'memory' });

/**
 * Order (P2 contract): no data → disk < stop_gb → runs ≥ max_concurrent → critical → warn with runs (D2) →
 * avail < min_free + need (+ docker_reserved when Docker runs). runs = count of active runs.
 * @param {{snap: any, runs: number, phase: string, config: any, needGb?: number}} a
 */
function admit({ snap, runs, phase, config, needGb: need = config.memory.phase_need_gb[phase] }) {
  const m = config.memory;
  if (!snap || snap.pressure == null) return memory; // monitor has no reading yet: never start blind
  if (!(snap.disk_free >= config.disk.stop_gb * GB)) return { ok: false, reason: 'disk' };
  if (runs >= config.max_concurrent) return { ok: false, reason: 'slot' };
  if (snap.pressure === 'critical') return memory;
  if (snap.pressure === 'warn' && (runs > 0 || !m.start_at_warn_when_idle)) return memory;
  if (!(snap.avail >= (m.min_free_gb + need + (snap.docker ? m.docker_reserved_gb : 0)) * GB)) return memory;
  return { ok: true };
}

/**
 * Critical pressure → pause the most recently started run (not a failure). runs = [{id, started_at (ISO)}].
 * @param {{snap: any, runs: {id: string, started_at: string}[]}} a
 */
function decide({ snap, runs }) {
  if (snap?.pressure !== 'critical' || !runs.length) return [];
  const newest = runs.reduce((a, b) => (b.started_at > a.started_at ? b : a));
  return [{ type: 'pause', runId: newest.id }];
}

// D2 delta (spec L377 says normal): pressure ≤ warn AND avail ≥ min_free + need. run = {phase, need_gb?}.
function canResume({ snap, run, config }) {
  const need = run.need_gb ?? config.memory.phase_need_gb[run.phase];
  return (snap?.pressure === 'normal' || snap?.pressure === 'warn') && snap.avail >= (config.memory.min_free_gb + need) * GB;
}

// Expected need in GB: median peak_rss_mb of the phase's last 10 `t:run` metrics lines, else the config default.
function needGb(phase, metricsLines, config) {
  const peaks = [];
  for (const line of metricsLines) {
    let r;
    try {
      r = typeof line === 'string' ? JSON.parse(line) : line;
    } catch {
      continue; // a torn last line in metrics.jsonl
    }
    if (r?.t === 'run' && r.phase === phase && Number.isFinite(r.peak_rss_mb)) peaks.push(r.peak_rss_mb);
  }
  const last = peaks.slice(-10).sort((a, b) => a - b);
  if (!last.length) return config.memory.phase_need_gb[phase];
  const mid = last.length >> 1;
  return (last.length % 2 ? last[mid] : (last[mid - 1] + last[mid]) / 2) / 1024;
}

module.exports = { admit, decide, canResume, needGb };
