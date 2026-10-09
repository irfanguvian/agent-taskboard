'use strict';
// phases: which <kind>/<phase> the running code can execute (D9). Files are scanned once at load:
// deploy restarts tbd, so a restart is the only moment "built" can change. Runner modules call
// registerHandler at startup (P4: lib/planning.js for code/planning; tests preload test/helpers/fake-handlers.js).
// First registration wins: a test preload's fixture handler stays in place when tbd.js loads the real one. A handler
// may bring a seed: the prompt of a fresh session of that phase (P4 U6), else the runner sends ticket.md.
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
/** @param {string} key @param {Function} fn @param {Function} [seed] */
const registerHandler = (key, fn, seed = undefined) => void (handlers.has(key) || handlers.set(key, { fn, seed }));

const handler = (kind, phase) => handlers.get(`${kind}/${phase}`)?.fn;
const seed = (kind, phase) => handlers.get(`${kind}/${phase}`)?.seed;

module.exports = { DIR, built, misconfigured, registerHandler, handler, seed };
