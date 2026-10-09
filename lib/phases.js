'use strict';
// phases: which <kind>/<phase> the running code can execute (D9). Files are scanned once at load:
// deploy restarts tbd, so a restart is the only moment "built" can change. Runner modules call
// registerHandler at startup (none in P1; tests preload test/helpers/fake-handlers.js).
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.TB_PHASES_DIR || path.join(__dirname, '..', 'phases');
const FILES = ['prompt.md', 'settings.json', 'result.schema.json'];
const handlers = new Map();
const present = new Map(); // '<kind>/<phase>' -> FILES found in that dir

function dirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); // startup
  } catch {
    return [];
  }
}

for (const kind of dirs(DIR)) {
  for (const phase of dirs(path.join(DIR, kind))) {
    present.set(`${kind}/${phase}`, FILES.filter((f) => fs.existsSync(path.join(DIR, kind, phase, f)))); // startup
  }
}

const files = (kind, phase) => present.get(`${kind}/${phase}`) || [];
const built = (kind, phase) => files(kind, phase).length === FILES.length && handlers.has(`${kind}/${phase}`);
// prompt.md landed but the phase can't run: a config error (Blocked, never spawned), not "unbuilt".
const misconfigured = (kind, phase) => files(kind, phase).includes('prompt.md') && !built(kind, phase);
const registerHandler = (key, fn) => void handlers.set(key, fn);

const handler = (kind, phase) => handlers.get(`${kind}/${phase}`);

module.exports = { DIR, built, misconfigured, registerHandler, handler };
