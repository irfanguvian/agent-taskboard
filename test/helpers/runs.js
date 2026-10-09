'use strict';
// Shared by the runner tests with real processes (test/runner.test.js P3a, test/recovery-tbd.test.js P3b): a flow
// ticket fixture, ticket + spy-log readers, polling, and reaping that only ever reaches this repo's test processes.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const TEST = path.join(__dirname, '..');
const FAKE = path.join(TEST, 'fake-claude.js');
const RUN_SPY = `--require ${path.join(__dirname, 'run-spy.js')}`;
const NOW = new Date().toISOString();
const ticket = (id, over = {}) => ({
  id, type: 'flow', kind: 'code', tag: null, title: `run ${id}`, text: 'do the thing', state: 'planning', created_at: NOW, updated_at: NOW,
  parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null, ...over,
});

const read = (tbd, id) => JSON.parse(fs.readFileSync(path.join(tbd.tbHome, 'tickets', id, 'ticket.json'), 'utf8'));
// A run log's events, plain or (P3c: once its run ended) gzipped beside it as <file>.gz.
function lines(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.existsSync(`${file}.gz`) ? zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8') : '';
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// Run n of the ticket has a log (plain while it runs, .gz once it ended): it was spawned.
const hasRun = (tbd, id, n) => ['', '.gz'].some((x) => fs.existsSync(path.join(tbd.tbHome, 'tickets', id, 'runs', `${n}.jsonl${x}`)));
const spyLog = (tbd, name) => lines(path.join(tbd.tbHome, name));
async function until(fn, ms = 30_000, what = 'condition') {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`${what} not met in ${ms} ms`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const command = (pid) => { try { return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; } };
// SIGKILL only processes that run this repo's test code (fake-claude), never anything else.
const reap = (pids) => pids.forEach((p) => { if (Number.isInteger(p) && p > 1 && command(p).includes(TEST + path.sep)) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } });
// pids of every lease + every fake_child under this tbd's tickets
function pidsOf(tbd) {
  const dir = path.join(tbd.tbHome, 'tickets');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((id) => {
    const runs = path.join(dir, id, 'runs');
    const logs = fs.existsSync(runs) ? fs.readdirSync(runs).filter((f) => /\.jsonl(\.gz)?$/.test(f)).flatMap((f) => lines(path.join(runs, f.replace(/\.gz$/, '')))) : [];
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(path.join(dir, id, 'ticket.json'), 'utf8')).lease; } catch { /* none */ }
    return [lease?.pid, ...logs.filter((l) => l.subtype === 'fake_child').map((l) => l.pid)];
  });
}

// claudeEnv is an allowlist (S3): patched so the fake claude_bin still gets its FAKE_CLAUDE_* scenario vars. Call it
// before lib/spawn loads (spawn keeps its own reference).
function passFakeEnv() {
  const util = require('../../lib/util');
  const { claudeEnv } = util;
  util.claudeEnv = (env) => ({ ...claudeEnv(env), ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('FAKE_CLAUDE_'))) });
}

module.exports = { FAKE, RUN_SPY, NOW, ticket, read, lines, hasRun, spyLog, until, alive, command, reap, pidsOf, passFakeEnv };
