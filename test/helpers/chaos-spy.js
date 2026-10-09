'use strict';
// Test preload for `tb eval chaos` (P3d T10, contract T4): NODE_OPTIONS=--require <this> in the tb process. Production
// never loads this file. Every signal tb sends is logged to TB_HOME/test-cli-kills.jsonl and reaches only processes
// running this repo's test code (fake-claude); launchctl is logged to TB_HOME/test-cli-exec.jsonl and never runs; ps
// runs for real (read-only).
const fs = require('node:fs');
const path = require('node:path');
const sh = require('../../lib/sh');
const { sys } = require('../../lib/cli');
const { command } = require('./runs');

const TEST = path.join(__dirname, '..') + path.sep;
const log = (name, o) => fs.appendFileSync(path.join(process.env.TB_HOME, name), JSON.stringify(o) + '\n');

sys.kill = (pid, sig) => {
  const ok = Number.isInteger(pid) && pid > 1 && pid !== process.ppid && command(pid).includes(TEST); // never the test itself
  log('test-cli-kills.jsonl', { pid, sig, ok });
  if (ok) process.kill(pid, sig);
};
sys.exec = async (file, args) => {
  if (file === '/bin/ps') return sh(file, args, { timeout: 5000 });
  log('test-cli-exec.jsonl', { file, args });
  return { err: null, stdout: '', stderr: '' };
};
