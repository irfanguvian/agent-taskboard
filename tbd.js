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
const { createServer, ready } = require('./lib/http');
const { createNotifier } = require('./lib/notify');
const { createMonitor } = require('./lib/monitor');
const doctor = require('./lib/doctor');
const { createSlots } = require('./lib/slots');

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
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  monitor?.stop();
  server.close();
  server.closeAllConnections();
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
    notifier = createNotifier({ store });
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
  slots.start().then(() => {
    ready(notifier, monitor); // throws on an unreadable session file: caught below, clean stop(1)
    console.log(`tbd listening ${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`);
  }).catch((e) => { console.error(`error: ${e.message}`); stop(1); });
}

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`error: TB_PORT must be 0-65535, got "${process.env.TB_PORT}"`);
  stop(1);
} else {
  server.listen(port, '127.0.0.1', boot);
}
