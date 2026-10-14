#!/usr/bin/env node
'use strict';
// deploy-guard (C16; D-0091 D-0092 A5 G6): scripts/deploy runs it before the checkout. A restart ends every run, so a
// flow at work in review, qa or final_gate (not waiting on Irfan: close, manual, children) → exit 1 listing them;
// --force lists them and passes. The flows come from the live tbd (GET /api/state with X-TB-Token, sent only after
// /api/whoami proved the port is tbd, like tb: lib/cli.js identify), one 5 s budget for both calls. This tbd down
// (refused, reset, no answer in 5 s, no token file yet, or the port held by something else: D39 tbd binds first, so it
// is not running there) → a warning, exit 0: no run to lose. Anything else (503 starting, 401, 5xx, a body without
// flows) → exit 1: fail closed, --force still passes.
// TB_HOME (scripts/deploy passes its own) else ~/.taskboard; port TB_PORT, else config.json http.port, else 7777 (tbd.js).
// Zero-dep (D5).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const BUSY = ['review', 'qa', 'final_gate'];
const IRFAN = ['close', 'manual', 'children']; // waits only Irfan ends: no run in flight
const force = process.argv.includes('--force');
const deadline = AbortSignal.timeout(5000);
const say = (msg) => console.error(`deploy-guard: ${msg}`);

function port() {
  if (process.env.TB_PORT) return process.env.TB_PORT;
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).http?.port ?? 7777;
  } catch {
    return 7777; // no config or a broken one: tbd.js falls back the same way
  }
}
const PORT = port();

// GET on 127.0.0.1 → {status, text}; null = tbd is down (refused, reset, or the 5 s are up)
async function get(route, headers = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { headers, signal: deadline });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    if (e.name === 'TimeoutError' || ['ECONNREFUSED', 'ECONNRESET'].includes(e.cause?.code)) return null;
    throw e;
  }
}

async function main() {
  const down = (why) => say(`warning: ${why}: no flow to protect, deploying`);
  let token;
  try {
    token = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return down(`no ${path.join(HOME, 'token')} (tbd never ran here)`);
    throw e;
  }
  const n = crypto.randomBytes(16).toString('hex');
  const who = await get(`/api/whoami?n=${n}`);
  if (!who) return down(`tbd not answering on port ${PORT}`);
  if (who.status === 503) throw new Error('tbd is starting: retry in a few seconds, or pass --force');
  let mac;
  try {
    mac = JSON.parse(who.text).mac;
  } catch { /* not tbd: mac stays undefined */ }
  if (who.status !== 200 || mac !== crypto.createHmac('sha256', token).update(n).digest('hex')) {
    return down(`port ${PORT} answers, but not as this tbd (identity check failed; the token was not sent)`);
  }
  const st = await get('/api/state', { 'X-TB-Token': token });
  if (!st) return down(`tbd stopped answering on port ${PORT}`);
  if (st.status !== 200) throw new Error(`tbd answered ${st.status} to GET /api/state`);
  const flows = JSON.parse(st.text).flows;
  if (!Array.isArray(flows)) throw new Error('GET /api/state has no flows list');
  const busy = flows.filter((f) => BUSY.includes(f?.state) && !IRFAN.includes(f?.waiting?.reason));
  if (!busy.length) return;
  const list = busy.map((f) => `${f.id} (${f.state}${f.waiting?.reason ? `, waiting ${f.waiting.reason}` : ''})`).join(', ');
  if (force) return say(`--force: deploying over flows at work: ${list}`);
  say(`flows at work: ${list}: a deploy restarts tbd and ends their runs; wait for them, or pass --force`);
  process.exitCode = 1;
}

main().catch((e) => {
  if (force) return say(`--force: ${e.message}`);
  say(`${e.message} (fail closed: pass --force to deploy anyway)`);
  process.exitCode = 1;
});
