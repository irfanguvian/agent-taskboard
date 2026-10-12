'use strict';
// gates/classify: why one gate check went red (contract K12+RO3+M10), pure. Agent code runs inside the check, so its
// exit code and output are untrusted: a test can `process.exit(124)` or print a fake error. Facts tbd owns pick infra:
// the spawn of the top argv failing (ENOENT etc.: the command never ran), the tbx timer flag file, the job's AbortSignal.
// Residual (K12 asks for it): step 5 reads the agent-written tail, so agent output (`EADDRINUSE`, the lockfile error)
// can turn a work red into infra → Blocked with no try used; Irfan sees it on the Blocked notice. Order:
//   1 signal aborted (tbd killed it: memory, cancel, shutdown) → interrupted (rerun, no try used);
//   2 spawn error → infra;
//   3 timer fired → work when the same check at base ran in budget (base_ms ≤ budget), infra when it was over budget,
//     or no base number for a tag check; a test_cmd with no base number → work (its own tests are the agent's);
//   4 exit 0 → null (green);
//   5 tail `EADDRINUSE`, or npm's missing-lockfile error → infra;
//   6 any other exit (127 from sh, a self-exit 124, a signal tbd did not send) → work.
// infra → Blocked + notify, no try counted (working.js decides). budgetMs is required (the check's timeout in ms): a
// caller that forgets it throws here, never classifies a timeout by accident.

const EADDRINUSE = /\bEADDRINUSE\b/;
const NO_LOCKFILE = /\bENOLOCK\b|can only install with an existing package-lock\.json/;

/**
 * @param {{spawnErr?: {code?: string} | null, exit?: number | null, signalAborted?: boolean, abortReason?: string,
 *   timerFired?: boolean, tail?: string, check?: string, baseMs?: number | null, budgetMs: number, isTestCmd?: boolean}} o
 * @returns {'work' | 'infra' | 'interrupted' | null}
 */
function classify(o) {
  if (typeof o.budgetMs !== 'number' || !(o.budgetMs > 0)) throw new TypeError('classify: budgetMs (the check timeout, ms) is required');
  if (o.signalAborted) return 'interrupted';
  if (o.spawnErr) return 'infra';
  if (o.timerFired) {
    const base = typeof o.baseMs === 'number' ? o.baseMs : null;
    if (base === null) return (o.isTestCmd ?? o.check === 'test_cmd') ? 'work' : 'infra';
    return base <= o.budgetMs ? 'work' : 'infra';
  }
  if (o.exit === 0) return null;
  if (EADDRINUSE.test(o.tail ?? '') || NO_LOCKFILE.test(o.tail ?? '')) return 'infra';
  return 'work';
}

module.exports = { classify };
