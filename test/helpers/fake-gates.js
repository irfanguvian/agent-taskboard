'use strict';
// Test preload (NODE_OPTIONS=--require <this>, after run-spy.js) for the P5a working tests. Production never loads it;
// lib/gates is never required here (the RAM test reads require.cache through it).
// 1. lib/working.js gets scripted gates (setGates, first wins): each call takes the next step of
//    TB_HOME/fake-gates/<ticket>.json {task: [step], working: [step], final: [step], base: [step], openapi: [step]} (missing → green);
//    the step count per kind is kept in <ticket>.<kind>.n, so a restarted tbd goes on. M5.5: a lane ticket (its id is made
//    at run time) takes its parent's script under `lane:<task>`. A step is merged into a whole
//    GateResult (head = the worktree's real HEAD) and saved as tickets/<id>/gates/NN.json, as lib/gates does. Like the real
//    gate: integrity.ok false → class integrity; step.allow: [paths] → a scope ask unless the call's allow covers them.
//    step.sleep_ms: waits; an aborted signal → class interrupted (step.ignore_abort: waits the full time and answers
//    green anyway, as a gate that missed the signal). step.swap: a real fail-first swap (save swap {pre, head, pid,
//    lstart} of a detached `sleep` = the gate's process, then `git checkout <pre> -- <step.swap>`), then waits.
//    step.child: a detached `sleep` saved as the gate's proc {pid, lstart}. step.protect: [paths] checked as the real
//    protected check (changed since base → needs an allow bound to its blob at HEAD, else a protected ask). Every gate also checks the tag's env files in
//    the worktree are the tag's own (M1: copied fresh before it) → else red "env file not fresh".
//    runDepsSetup: step of `deps` ({needs_online: true} → needs the network unless called online; sleep_ms: waits first);
//    ok writes a new node_modules/.package-lock.json (the tripwire moves: the caller must take its baseline again) and, with packages,
//    adds them to package.json + writes package-lock.json (uncommitted, as npm install does).
//    restoreSwap: reset --hard <head> + clean -fdq (the marker's head), as the real one; script.restore_ms makes the first one slow,
//    script.restore_fail makes it throw (as a red checks.generate), the tree left swapped. Every call is logged to
//    TB_HOME/fake-gates.jsonl {fn, ticket, trusted (H2.5: o.t.trusted), gates_loaded: a lib/gates module is in require.cache}.
// 2. The runner's monitor pressure: TB_HOME/test-pressure when that file exists (the memory drill). (working.boot() before
//    the runner starts is tbd.js's own since the P5 Wire.)
// 3. A file RPC for the working verbs (no route before P5c; + `merged`: pr.merged_at as a D9 pass sets it): TB_HOME/test-rpc/<n>.json {fn, args} → <n>.out.json
//    {ok, value} | {ok: false, status, error}.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const working = require('../../lib/working');
const runner = require('../../lib/runner');
const { procs } = require('../../lib/slots');

const HOME = process.env.TB_HOME;
const log = (o) => fsp.appendFile(path.join(HOME, 'fake-gates.jsonl'), JSON.stringify({ at: Date.now(), ...o, gates_loaded: Object.keys(require.cache).some((k) => k.includes(`${path.sep}lib${path.sep}gates${path.sep}`)) }) + '\n');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

async function step(id, kind, lane = null) {
  const dir = path.join(HOME, 'fake-gates');
  if (lane) kind = `lane:${lane.task}`;
  let script = {};
  try { script = JSON.parse(await fsp.readFile(path.join(dir, `${lane?.id ?? id}.json`), 'utf8')); } catch { /* none: green */ }
  const nFile = path.join(dir, `${id}.${kind}.n`);
  const n = Number(await fsp.readFile(nFile, 'utf8').catch(() => '0'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(nFile, String(n + 1));
  return script[kind]?.[n] ?? {};
}
const wait = (ms, signal) => new Promise((/** @type {(v?: any) => void} */ res) => {
  if (signal?.aborted) return res(); // aborted before we got here: no 'abort' event will come
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

async function gate(kind, o) {
  const id = o.t.id;
  const s = await step(id, kind, o.t.lane_of);
  await log({ fn: kind, ticket: id, task: o.task?.id ?? null, type: o.task?.type ?? null, pre: o.pre ?? null, integrity: o.integrity, allow: o.allow, unitMs: o.unitMs ?? null, trusted: o.t.trusted === true }); // H2.5: the gate's t reads the tag's objects only
  const head = git(o.wt, 'rev-parse', 'HEAD');
  const stale = (o.tag.env_files ?? []).find((f) => fs.readFileSync(path.join(o.wt, f), 'utf8') !== fs.readFileSync(path.join(o.tag.path, f), 'utf8'));
  if (s.child) {
    const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    child.unref();
    o.onSpawn?.(child.pid);
    let lstart;
    for (let i = 0; i < 20 && !lstart; i++) lstart = (await procs(true))?.get(child.pid)?.lstart;
    await o.save({ proc: { pid: child.pid, lstart } });
  }
  if (s.swap) {
    const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    child.unref();
    o.onSpawn?.(child.pid);
    let lstart;
    for (let i = 0; i < 20 && !lstart; i++) lstart = (await procs(true))?.get(child.pid)?.lstart;
    await o.save({ swap: { pre: o.pre, head, pid: child.pid, lstart } });
    git(o.wt, 'checkout', '--no-overlay', o.pre, '--', s.swap);
  }
  if (s.sleep_ms) await wait(s.sleep_ms, s.ignore_abort ? undefined : o.signal);
  const { swap: _s, sleep_ms: _m, allow: need, ignore_abort: ign, child: _c, protect, ...over } = s;
  // as lib/gates/task.js protectedCheck: a protected path changed since base passes only with an allow bound to its blob at HEAD
  const changed = protect ? git(o.wt, 'diff', '--name-only', o.t.base_sha, head, '--', ...protect).split('\n').filter(Boolean) : [];
  const unallowed = changed.filter((p) => !(o.allow ?? []).some((a) => a.path === p && a.blob && a.blob === git(o.wt, 'rev-parse', `${head}:${p}`)));
  const res = {
    v: 1, gate: kind, ticket: id, task: o.task?.id ?? null, attempt: 1, pre: o.pre ?? null, head, plan_hash: o.t.plan_hash ?? null,
    at: new Date().toISOString(), ms: 5, slot_wait_ms: 0, ok: true, class: null,
    checks: [{ check: 'unit', ok: true, exit: 0, timed_out: false, ms: 1234, flaky: false, log: null, tail: '' }],
    scope: { outside: [], protected: [], deps: false, bad: [] },
    tests: { failfirst: kind === 'task' ? 'proven' : 'n/a', files: [], skips_added: [], deleted: [], expects_removed: [], count: { pre: 0, head: 0 } },
    schema: [], api: [], unused_allowed: [], ask: null, why: '', ...over,
  };
  if (o.signal?.aborted && !ign) Object.assign(res, { ok: false, class: 'interrupted', why: `aborted: ${o.signal.reason}` });
  else if (stale) Object.assign(res, { ok: false, class: 'work', why: `env file not fresh: ${stale}` });
  else if (!o.integrity?.ok) Object.assign(res, { ok: false, class: 'integrity', why: o.integrity?.why });
  else if (need && !need.every((p) => (o.allow ?? []).some((a) => a.path === p))) Object.assign(res, { ok: false, class: 'scope', ask: { kind: 'scope', files: need, reason: 'outside the task' }, why: `outside: ${need.join(', ')}` });
  else if (unallowed.length) Object.assign(res, { ok: false, class: 'protected', ask: { kind: 'protected', files: unallowed, reason: `protected files changed: ${unallowed.join(', ')}` }, why: 'protected' });
  require('../../lib/http').onCheck(o)({ check: 'unit', ok: res.ok }); // as tbd.js's live(): the SSE `gate` event
  const gdir = path.join(HOME, 'tickets', id, 'gates');
  await fsp.mkdir(gdir, { recursive: true });
  const nn = (await fsp.readdir(gdir)).filter((f) => /^\d+\.json$/.test(f)).length + 1;
  await fsp.writeFile(path.join(gdir, `${String(nn).padStart(2, '0')}.json`), JSON.stringify(res));
  return res;
}

const restored = new Set(); // tickets whose swap was restored once (restore_ms slows only that one)
working.setGates({
  runTaskGate: (o) => gate('task', o),
  runWorkingGate: (o) => gate(o.kind === 'final' ? 'final' : 'working', o), // M5 C10: the final checks' steps under `final`
  runBaseChecks: async (o) => {
    const s = await step(o.t.id, 'base');
    await log({ fn: 'base', ticket: o.t.id });
    return { ok: true, checks: { unit: { ok: true, ms: 4321 } }, ...s };
  },
  captureOpenapiBase: async (o) => {
    const s = await step(o.t.id, 'openapi');
    await log({ fn: 'openapi', ticket: o.t.id });
    return { ok: true, ...s };
  },
  runDepsSetup: async (o) => {
    const s = await step(o.t.id, 'deps');
    // as lib/gates/working.js vouch: t.work.scope must hold Allow[] lists (a count there would allow nothing)
    const lists = Object.values(o.t.work?.scope ?? {}).every((v) => Array.isArray(v));
    await log({ fn: 'deps', ticket: o.t.id, online: o.online });
    if (s.sleep_ms) await wait(s.sleep_ms, o.signal);
    if (!lists) return { ok: false, why: 'deps setup refused: t.work.scope holds no allow lists' };
    if (s.needs_online && !o.online) return { ok: false, needs_online: true, why: 'a native build needs the network' };
    if (s.ok === false) return { ok: false, why: s.why };
    fs.mkdirSync(path.join(o.wt, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(o.wt, 'node_modules', '.package-lock.json'), `{"built": ${Date.now()}}\n`);
    if (o.packages?.length) { // as `npm install --ignore-scripts -- <packages>`: package.json + lockfile updated, not committed
      const pkg = JSON.parse(fs.readFileSync(path.join(o.wt, 'package.json'), 'utf8'));
      pkg.dependencies = { ...pkg.dependencies, ...Object.fromEntries(o.packages.map((x) => [x.slice(0, x.lastIndexOf('@')), x.slice(x.lastIndexOf('@') + 1)])) };
      fs.writeFileSync(path.join(o.wt, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      fs.writeFileSync(path.join(o.wt, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: pkg.dependencies }, null, 2) + '\n');
    }
    return { ok: true };
  },
  restoreSwap: async (t, wt) => {
    await log({ fn: 'restoreSwap', ticket: t.id });
    let script = {};
    try { script = JSON.parse(fs.readFileSync(path.join(HOME, 'fake-gates', `${t.id}.json`), 'utf8')); } catch { /* none */ }
    const first = !restored.has(t.id);
    restored.add(t.id);
    if (script.restore_ms && first) await wait(script.restore_ms); // the 1st restore is slow: runner ticks pass meanwhile
    if (script.restore_fail && first) throw new Error('checks.generate failed: the tree is still swapped');
    git(wt, 'reset', '-q', '--hard', t.work.gate.swap.head);
    git(wt, 'clean', '-fdq');
  },
});

// 2. pressure override
const createRunner = runner.createRunner;
runner.createRunner = (deps) => createRunner({
  ...deps,
  system: () => {
    const s = deps.system?.();
    let p = null;
    try { p = fs.readFileSync(path.join(HOME, 'test-pressure'), 'utf8').trim(); } catch { /* none */ }
    return s && p ? { ...s, pressure: p, at: Date.now() } : s;
  },
});

// 3. file RPC
const rpc = path.join(HOME, 'test-rpc');
const busy = new Set();
setInterval(() => {
  let names = [];
  try { names = fs.readdirSync(rpc).filter((f) => /^\d+\.json$/.test(f)); } catch { return; }
  for (const f of names) {
    if (busy.has(f) || fs.existsSync(path.join(rpc, f.replace('.json', '.out.json')))) continue;
    busy.add(f);
    const { fn, args } = JSON.parse(fs.readFileSync(path.join(rpc, f), 'utf8'));
    const store = require('../../lib/store');
    const verbs = { ...working, merged: (id, at) => store.updateTicket(id, (k) => ({ ...k, pr: { ...k.pr, merged_at: at } })).then(() => true) }; // as P5c's pass (D9)
    Promise.resolve().then(() => verbs[fn](...args)).then((value) => ({ ok: true, value }), (e) => ({ ok: false, status: e.status ?? 500, error: e.message }))
      .then((out) => fs.writeFileSync(path.join(rpc, f.replace('.json', '.out.json')), JSON.stringify(out)));
  }
}, 100).unref();
