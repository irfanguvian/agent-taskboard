#!/usr/bin/env node
'use strict';
// tbd: the taskboard daemon. One process: store + fsm + http on 127.0.0.1 (spec §2).
// Env: TB_HOME (data dir, default ~/.taskboard), TB_PORT (default config http.port 7777; 0 = any free port).
const store = require('./lib/store');
const { createServer } = require('./lib/http');
const { createNotifier } = require('./lib/notify');

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

let notifier;
try {
  store.init();
  notifier = createNotifier({ store });
} catch (e) {
  die(e.message);
}

const port = process.env.TB_PORT ? Number(process.env.TB_PORT) : store.config.http?.port ?? 7777;
const server = createServer(notifier);
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
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

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`error: TB_PORT must be 0-65535, got "${process.env.TB_PORT}"`);
  stop(1);
} else {
  notifier.start();
  server.listen(port, '127.0.0.1', () => console.log(`tbd listening ${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`));
}
