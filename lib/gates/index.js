'use strict';
// gates: the gate engine's entry (contract rev 4.1 Interface; the shapes in lib/gates/types.js). tbd.js wires these into
// working.setGates lazily, at the first gate job: nothing under lib/gates/ is required at boot (RAM). Gates report facts
// (GateResult in tickets/<id>/gates/NN.json + t:gate lines), never move the fsm: lib/working.js decides.
//   task.js: runTaskGate, restoreSwap; working.js: runWorkingGate, runBaseChecks, captureOpenapiBase, runDepsSetup;
//   run.js: the one check runner (sandbox profile gate.sb, gate env, output caps, classify, persistence).
const { runTaskGate, restoreSwap } = require('./task');
const { runWorkingGate, runBaseChecks, captureOpenapiBase, runDepsSetup } = require('./working');

module.exports = { runTaskGate, runWorkingGate, runBaseChecks, captureOpenapiBase, restoreSwap, runDepsSetup };
