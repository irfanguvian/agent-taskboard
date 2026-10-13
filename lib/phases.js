'use strict';
// phases: which <kind>/<phase> the running code can execute (D9). Files are scanned once at load:
// deploy restarts tbd, so a restart is the only moment "built" can change. Runner modules call
// registerHandler at startup (P4: lib/planning.js for code/planning; tests preload test/helpers/fake-handlers.js).
// First registration wins: a test preload's fixture handler stays in place when tbd.js loads the real one. A handler
// may bring a seed: the prompt of a fresh session of that phase (P4 U6), else the runner sends ticket.md.
// P5 (contract Interface): and a next hook, next(t, api): what follows in that phase without a live run (a gate job, the
// session mode: lib/working.js); runner.consider + decide and the recovery's rerunGate call it.
// M5 C2 (D-0085): phases/_rules.md is read here once too (startup) → rules {text, sha12}; lib/spawn.js appends it to
// every code run's system prompt. Missing or over 8 KB → null, and every code phase is misconfigured (Blocked, never
// spawned). It is the repo's own file, never TB_PHASES_DIR's: a fixture phase dir holds phase files only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.TB_PHASES_DIR || path.join(__dirname, '..', 'phases');
const FILES = ['prompt.md', 'settings.json', 'result.schema.json'];
const RULES_MAX = 8 * 1024;
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

function loadRules() {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md')); // startup
    return buf.length > RULES_MAX ? null : { text: buf.toString('utf8'), sha12: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12) };
  } catch {
    return null;
  }
}
const rules = loadRules();

const files = (kind, phase) => present.get(`${kind}/${phase}`) || [];
const built = (kind, phase) => files(kind, phase).length === FILES.length && handlers.has(`${kind}/${phase}`) && (kind !== 'code' || !!rules);
// prompt.md landed but the phase can't run: a config error (Blocked, never spawned), not "unbuilt".
const misconfigured = (kind, phase) => files(kind, phase).includes('prompt.md') && !built(kind, phase);
/** @param {string} key @param {Function} fn @param {Function} [seed] @param {Function} [next] */
const registerHandler = (key, fn, seed = undefined, next = undefined) => void (handlers.has(key) || handlers.set(key, { fn, seed, next }));

const handler = (kind, phase) => handlers.get(`${kind}/${phase}`)?.fn;
const seed = (kind, phase) => handlers.get(`${kind}/${phase}`)?.seed;
const next = (kind, phase) => handlers.get(`${kind}/${phase}`)?.next;

module.exports = { DIR, rules, built, misconfigured, registerHandler, handler, seed, next };
