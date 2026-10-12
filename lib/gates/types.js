'use strict';
// gates/types: the frozen seam between the working loop (lib/working.js, P5a) and the gate engine (lib/gates/*, P5b).
// Contract .omc/handoffs/p5-contract.md rev 4.1 "Interface". Change only by a contract edit: both lanes code against it.
// Gates report facts (GateResult), never move the fsm; lib/working.js decides. Loaded lazily with the rest of
// lib/gates/ (RAM: nothing under lib/gates/ is required before the first gate job).

/** Why a gate result is red; null when green. */
const CLASSES = Object.freeze(['work', 'infra', 'policy', 'protected', 'scope', 'deps', 'integrity', 'interrupted', 'config']);
/** Asks that send the ticket to clarify instead of an agent session. */
const ASK_KINDS = Object.freeze(['scope', 'protected', 'deps', 'policy']);
/** signal.reason of every tbd-initiated gate kill (set BEFORE kill(-pgid); classify → interrupted). */
const ABORT_REASONS = Object.freeze(['memory', 'cancel', 'shutdown']);
/** Fail-first verdicts of a `new` task (K7). */
const FAILFIRST = Object.freeze(['proven', 'proven_missing', 'unproven_compile', 'unproven_no_tests', 'unproven_unparsed', 'vacuous', 'n/a']);
/** Task states in t.work.tasks (M13). */
const TASK_STATES = Object.freeze(['pending', 'running', 'gating', 'red', 'done']);
/** Session modes (N6): continue = same session, no reset; resume = after 1st work red; fresh = reset to pre. */
const MODES = Object.freeze(['continue', 'resume', 'fresh']);

/**
 * @typedef {{check: string, ok: boolean, exit: number|null, timed_out: boolean, ms: number, flaky: boolean,
 *   log: string|null, tail: string}} CheckResult  tail ≤ 4 KB (head 1 KB + tail 3 KB); log = gates/NN-<task>-<check>.log.gz
 * @typedef {{kind: 'scope'|'protected'|'deps'|'policy', files?: string[], changes?: string[], reason: string}} Ask
 * @typedef {{op: string, ref: string, allowed: boolean}} SchemaChange  K10 string = `${op} ${ref}`
 * @typedef {{op: string, ref: string, dir: 'request'|'response'|'both'|'operation', allowed: boolean}} ApiChange
 * @typedef {{v: 1, gate: 'base'|'task'|'working', ticket: string, task: string|null, attempt: number,
 *   pre: string|null, head: string, plan_hash: string|null, at: string, ms: number, slot_wait_ms: number, ok: boolean,
 *   class: 'work'|'infra'|'policy'|'protected'|'scope'|'deps'|'integrity'|'interrupted'|'config'|null,
 *   checks: CheckResult[],
 *   scope: {outside: string[], protected: {path: string, blob: string}[], deps: boolean, bad: string[]},
 *   tests: {failfirst: string, files: string[], skips_added: string[], deleted: string[], expects_removed: string[], count_drops: string[], count: {pre: number, head: number}},
 *   schema: SchemaChange[], api: ApiChange[], migration: string[], unused_allowed: string[], ask: Ask|null, why: string, n?: number,
 *   dirty?: boolean}} GateResult  dirty: set by working.js (not lib/gates) when the tree had uncommitted changes (I4)
 *   Persisted atomically as tickets/<id>/gates/NN.json; ticket.json keeps {n, ok, class} only. why ≤ 4 KB (resume text).
 * @typedef {{proc?: {pid: number, lstart: string}|null, swap?: {pre: string, head: string, pid: number, lstart: string}|null}} GatePatch
 *   The ONLY fields a gate may save; working.js maps them into t.work.gate under the lease-gen CAS.
 * @typedef {(patch: GatePatch) => Promise<boolean>} Save  false = stale gen → the gate aborts, writes nothing more
 * @typedef {(pid: number) => void} OnSpawn
 * @typedef {{path: string, blob?: string|null, granted_at_head?: string}} Allow  scope widen (no blob) or protected/deps allow bound to
 *   a blob (K3); a protected allow given before the agent's edit: blob null + granted_at_head until the first gate binds it
 * @typedef {{ok: boolean, why?: string}} Integrity  env_files re-copied + .bin/.package-lock tripwire (working.js, M1)
 * @typedef {{[check: string]: {ok: boolean, ms: number}}} BaseChecks  N3, from the approve-time base run
 * @typedef {{id: string, status: 'pending'|'running'|'gating'|'red'|'done', attempt: number, pre: string|null,
 *   head: string|null, commit?: string|null, session?: string|null, dirty?: number}} WorkTask  a done task drops commit + session (F5)
 * @typedef {{task: string|null, tasks: WorkTask[], tries: number, unit_ms: number|null, deps_blob?: string|null,
 *   scope: {[task: string]: Allow[]|number}, denied: {[task: string]: string[]|number}, gate: null|{gen: number, kind: 'base'|'task'|'working',
 *   n?: number, ok?: boolean, class?: string|null, proc?: GatePatch['proc'], swap?: GatePatch['swap']}}} Work  t.work, ≤ 16 KB with the ticket.
 *   scope/denied: ticket.json holds counts only; the lists live in tickets/<id>/scope.json (F5). A gate gets the lists:
 *   working.withScope(t, scope.json) puts them back before any gates.* call. deps_blob: the lockfile blob node_modules was last
 *   built from (approve setup, every runDepsSetup ok); a replan skips setup only when it matches + the tripwire holds (D-0055).
 * @typedef {{do: 'spawn'|'gate'|'clarify'|'review'|'blocked', task: string|null, mode: 'continue'|'resume'|'fresh'|null, why: string}} Decision
 *
 * Tag keys P5 adds (lib/tags.js validates; old shapes mapped at read time, no file rewrite):
 * @typedef {{generated?: string[], rules?: string[], protected?: string[], test_globs?: string[], test_scripts?: string,
 *   deny_ports?: number[], openapi?: {cmd: string, file: string}, prisma?: {schema: string, migrations: string},
 *   checks?: {lint?: string, typecheck?: string, unit?: string, e2e?: string, build?: string, generate?: string},
 *   timeout_min?: {[check: string]: number}}} TagP5
 * Config knobs (store.js defaults):
 * @typedef {{timeout_min: {[check: string]: number}, unit_task_max_ms: number, need_gb: number, registry?: string}} GatesConfig
 */

// Signatures (lib/gates/index.js implements; tests preload test/helpers/fake-gates.js instead):
//   runTaskGate({t, task, wt, pre, head, plan, tag, out:{commit, tests}, allow, unitMs, baseChecks, integrity, save, onSpawn, onCheck?, signal}) → Promise<GateResult>
//   runWorkingGate({t, wt, base, head, plan, tag, allow, baseChecks, integrity, save, onSpawn, onCheck?, signal}) → Promise<GateResult>
//     onCheck({check, ok}): sync, once per finished check (tbd.js → SSE `gate`); a throw is ignored, never fails the gate
//   runBaseChecks({t, wt, tag, save, onSpawn, signal}) → Promise<{ok, checks: BaseChecks, why?}>
//   captureOpenapiBase({t, wt, tag, onSpawn, signal}) → Promise<{ok: true}|{ok: false, why}>
//   restoreSwap(t, wt) → Promise<void>          only after working.js saw t.work.gate.swap (no gates require before)
//   runDepsSetup({t, wt, tag, packages, online, onSpawn, signal}) → Promise<{ok, why?, needs_online?}>  RO2: step 1 with 443 and
//     --ignore-scripts: `npm install --ignore-scripts --no-audit --no-fund -- <packages>` when packages (the deps ask's
//     `name@range` list: updates package.json + lockfile + node_modules) else `npm ci --ignore-scripts`; step 2 npm rebuild under the gate profile offline; offline fails → {ok:false, needs_online:true} (clarify); online = Irfan's
//     per-ticket allow → step 2 with 443. Then the caller re-takes the tripwire baseline. Used after a deps allow and on replan.
// Seams owned by P5a: working.decide(t, plan, last: GateResult|null) → Decision; phases.registerHandler(key, fn, seed, next);
//   phaseSettings.denyPaths(ctx) → {read: string[], write: string[]} (abs; the one deny source for the gate profile);
//   store.intervention(id, {actor, verb, task, payload}). Never wired → {ok:false, class:'infra', why:'gates not wired'}.

module.exports = { CLASSES, ASK_KINDS, ABORT_REASONS, FAILFIRST, TASK_STATES, MODES };
