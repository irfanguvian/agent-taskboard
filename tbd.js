#!/usr/bin/env node
'use strict';
// tbd: the taskboard daemon. One process: store + fsm + http on 127.0.0.1 (spec §2).
// Env: TB_HOME (data dir, default ~/.taskboard), TB_PORT (default config http.port 7777; 0 = any free port).
// D39: the port is bound first, so nothing else can take it while tbd starts; http answers 503 starting until the
// store, monitor and slots are up. "tbd listening <port>" = ready.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./lib/store');
const { createServer, ready, onCheck } = require('./lib/http');
const { createNotifier } = require('./lib/notify');
const { createMonitor } = require('./lib/monitor');
const doctor = require('./lib/doctor');
const { createSlots } = require('./lib/slots');
const { createRunner } = require('./lib/runner');
const planning = require('./lib/planning'); // registers the code/planning handler + seed (P4)
const working = require('./lib/working'); // registers the code/working handler, seed + next hook (P5)
require('./lib/review'); // registers the code/review handler, seed + next hook (M5 C3)
require('./lib/qa'); // registers the code/qa handler, seed + next hook (M5 C5)
require('./lib/final'); // registers the code/final_gate handler, seed + next hook, tells working.js a final gate's result (M5 C10-C13)
const pass = require('./lib/pass');
const interview = require('./lib/interview'); // M5.4 C18: Clarify rounds on a lavish page
const metrics = require('./lib/metrics');

// P5 Wire: lib/gates loads with the first gate job, never at boot (RAM). First wins: a test preload's fakes stay.
// Each finished gate check → SSE `gate` {id, task, check, ok}; the gates never require http.
let gatesLib;
const G = () => (gatesLib ??= require('./lib/gates'));
const live = (o) => ({ ...o, onCheck: onCheck(o) });
working.setGates({
  runTaskGate: (o) => G().runTaskGate(live(o)),
  runWorkingGate: (o) => G().runWorkingGate(live(o)),
  runBaseChecks: (o) => G().runBaseChecks(o),
  captureOpenapiBase: (o) => G().captureOpenapiBase(o),
  restoreSwap: (t, wt) => G().restoreSwap(t, wt),
  runDepsSetup: (o) => G().runDepsSetup(o),
});

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// The port is needed before store.init, which reads config.json again (and reports a broken one).
function configPort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'config.json'), 'utf8')).http?.port; // startup
  } catch {
    return undefined;
  }
}

const port = process.env.TB_PORT ? Number(process.env.TB_PORT) : configPort() ?? 7777;
const server = createServer();
let notifier;
let monitor;
let slots;
let runner;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  monitor?.stop();
  interview.stop(); // its polls end; the next tbd polls again
  server.close();
  server.closeAllConnections();
  await working.stop(); // gate jobs aborted (shutdown) + killed: their gates run again after the restart
  await runner?.stop(); // runs keep going: the next tbd re-attaches them
  await slots?.stop();
  await store.flush();
  await store.releasePid();
  process.exit(code);
}

server.on('error', (e) => {
  console.error(`error: ${e.message}`);
  stop(1);
});
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());

function boot() {
  try {
    store.init();
    notifier = createNotifier({ store, system: () => monitor?.snapshot() ?? null }); // D-0079: RAM free in a memory wait's banner
    store.on('transition', (t) => metrics.ticket(t, store.ticketDir(t.id))); // AC8: t:ticket on done, blocked, cancelled
    store.on('transition', interview.onTransition); // M5.4 X5: a planning clarify round opens its page; leaving it ends it
  } catch (e) {
    die(e.message);
  }
  monitor = createMonitor({ config: store.config });
  monitor.on('disk', notifier.disk);
  slots = createSlots({ config: store.config, system: () => monitor?.snapshot() ?? null, alert: notifier.alert }); // TB_HOME/tbd.sock; slots.registerRoot for P3 runs
  notifier.start();
  monitor.start();
  doctor.start({ notifier, monitor }); // login re-check every 30 min and after a wake
  // socket before "tbd listening": tbx and hooks can talk once it is printed
  // gates and children deny tbd's own port: the bound one (TB_PORT=0 picks any free port)
  process.env.TB_PORT = String(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
  slots.start().then(async () => {
    runner = createRunner({
      store, slots, tbHome: process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
      system: () => monitor?.snapshot() ?? null, alert: notifier.alert, probe: () => monitor.probeNet(), // D31: timeout + breaker
      autoAssign: planning.autoAssign, // J5: approval-made children, once their blockers are merged / done
    });
    planning.lostSetups(runner.alert); // an approve's setup dies with its tbd: waiting setup → setup_failed (J12)
    await interview.boot({ alert: runner.alert }).catch((e) => console.error(`tbd: lavish boot: ${e.message}`)); // orphan polls, leftover sends (D-0119), open rounds polled again; before runs start (no round opens meanwhile)
    monitor.on('wake', (e) => runner.wake(e)); // §8 sleep: the OS wake carries the slept time; a wall jump alone is a hint
    await working.boot(); // P5: pre-P5 working tickets get a work cursor; a swap left by a killed tbd is restored first
    pass.watch({ alert: runner.alert }); // parents waiting on children: one alert per newly blocked child
    await pass.boot().catch((e) => console.error(`tbd: children recount: ${e.message}`)); // a finish lost to a stop
    await require('./lib/push').boot({ alert: runner.alert }); // M5 C14: a push a dead tbd left running → failed
    runner.start(); // re-attaches live leases, then starts runs (after the socket: TBX_RUN keys work from the first second)
    ready(notifier, monitor, runner); // throws on an unreadable session file: caught below, clean stop(1)
    console.log(`tbd listening ${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`);
  }).catch((e) => { console.error(`error: ${e.message}`); stop(1); });
}

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`error: TB_PORT must be 0-65535, got "${process.env.TB_PORT}"`);
  stop(1);
} else {
  server.listen(port, '127.0.0.1', boot);
}
