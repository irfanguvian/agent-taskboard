'use strict';
// gates/task: the task gate + restoreSwap (contract rev 4.1 M1 M6 D34 R2+M2 RO2 M5+N7 K6+M3 RO4 K13 K7+C1+M4, Rules
// plan_hash). First, before any check (cleanTree, the working gate too): ignored files go, node_modules (minus
// node_modules/.cache) and the env files stay. Order = GATES.code.task (run.js), cheapest first, stop at the first red:
//   integrity (passed in by working.js: env files re-copied + node_modules tripwire) → class integrity;
//   plan: the frozen plan's hash ≠ t.plan_hash → class config;
//   history: HEAD still the head given, on t.branch (symbolic-ref), <pre> an ancestor, result.commit = HEAD → work;
//   trailer (D34): a commit message in pre..HEAD with `Co-Authored-By: …Claude|Anthropic` or `Generated with` → work
//     (git log → a file, read by the tests.js child: the messages are the agent's);
//   protected (R2+M2, RO2): vs base_sha (or the blob Irfan allowed): every package.json's dependency fields or a lockfile
//     → deps; its scripts (pre/post too) and other fields → protected; config files (package.json, .npmrc, jest/vitest/
//     babel config, tsconfig*.json, .swcrc, nest-cli.json, prisma.config.ts) new or changed, tag protected globs changed
//     or deleted → protected; one ask names it all (protectedCheck);
//   scope (M6): `diff --raw --no-renames pre HEAD` ⊆ files ∪ modules/ (by path segment) ∪ tag generated ∪ allowed paths,
//     else ask scope; bad (work): a symlink, a gitlink, a blob > 5 MB, a force-added ignored file, a control char, a tag
//     env_files path (a secret in a commit);
//   tests (M5+N7): test files (test_globs minus protected) of pre..HEAD written by git into files (R.blobsTo: tbd
//     never holds them) → tests.scan in a child (R.child: `node --max-old-space-size=96 lib/gates/tests.js <input
//     dir>`, 30 s; none changed → no child): a skip/only/todo added, a test file deleted, a file's static test count
//     down → work ("return TEST_DISPUTES_SPEC"); the child fails (heap, timeout, exit) → work "test scan failed";
//     expects_removed listed only;
//   generate, typecheck (tag), test_cmd (K6: re-parsed now by plan-rules.testArgv, its npm script in package.json at
//     base_sha (RO4) else config, each path arg at HEAD else work), unit (K13: while the last unit_ms < unit_task_max_ms);
//     test checks rerun once when red (M11 flaky);
//   failfirst (K7, type new only): the task's test files (0 → red; tests_added must be among them) run at pre: marker
//     swap {pre, head} saved BEFORE the swap (pid 0: no process yet; the run's own tbx is the proc marker), then
//     `checkout --no-overlay <pre> -- <changed non-test paths>`, the task's npm script + `--` + the test files, twice
//     (exit 0 either time → vacuous: red); the verdict from the 1st output (adapters: jest, node:test, vitest; ANSI
//     stripped): no summary → unproven_unparsed, no tests ran (or a file outside the script's config) → unproven_no_tests,
//     only missing names (tests.missingNames) that the non-test diff adds and the tests green at HEAD → proven_missing,
//     other missing names or a suite that failed to run → unproven_compile, failed tests → proven. Restore in finally
//     (an abort too): reset --hard <head>, clean -fdq (no -x; .claude/.cc-writes and env files kept), HEAD == head and
//     a clean tree asserted, checks.generate again; the marker is cleared only when all of that passed (else
//     working.js's restoreSwap does it again). Unproven verdicts pass (working.js lists them for review).
// restoreSwap(t, wt): the same restore for the marker left by a killed tbd (working.js calls it after killing the
// marker's processes); idempotent. Needs the slot server up (checks.generate runs through tbx heavy).
const fsp = require('node:fs/promises');
const path = require('node:path');
const R = require('./run');
const tests = require('./tests');
const rules = require('../plan-rules');
const planning = require('../planning');
const spawn = require('../spawn');
const store = require('../store');

const ZERO = '0'.repeat(40);
const TESTS_JS = path.join(__dirname, 'tests.js');
const BLOB_MAX = 5 * 1024 * 1024;
const PKG_MAX = 1 << 20; // a package.json / .npmrc tbd reads and parses itself (a legit one is well under 100 KB)
const PKG_TOTAL = 2 << 20; // all of them in one check
const { CONFIG_GLOBS: CONFIG, LOCKS } = require('../tags'); // one list each, shared with tags.js (R2, K11)
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides'];
const ctrl = (p) => [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const list = (a, n = 20) => `${a.slice(0, n).join(', ')}${a.length > n ? ` (+${a.length - n} more)` : ''}`;
const red = (cls, why, extra = {}) => ({ class: cls, why: R.cut(why), ...extra });
const heavyWhy = (c) => `${c.check}: ${c.class === 'interrupted' ? 'interrupted' : c.timed_out ? 'timed out' : c.exit === null ? 'did not run' : `exit ${c.exit}`}\n${c.tail}`;

// ---- logic checks shared with the working gate ----------------------------------------------------------------------
async function integrity(ctx, o) {
  if (o.integrity?.ok === true) return null;
  const why = `integrity: ${o.integrity?.why ?? 'not checked'}`;
  await R.logic(ctx, 'integrity', false, 'integrity', why);
  return red('integrity', why);
}

async function plan(ctx, o) {
  if (o.plan && R.sha256(planning.canon(o.plan)) === ctx.t.plan_hash) return null;
  const why = `the frozen plan does not match plan_hash ${String(ctx.t.plan_hash).slice(0, 12)}`;
  await R.logic(ctx, 'plan', false, 'config', why);
  return red('config', why);
}

// from: the range start (task: pre; working: base_sha); commit: result.commit (task only)
async function history(ctx, from, commit) {
  const why = [];
  const now = (await R.git(ctx, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (now !== ctx.head) why.push(`HEAD moved during the gate (${now.slice(0, 12)}, expected ${ctx.head.slice(0, 12)})`);
  if (ctx.t.branch) {
    const br = (await R.git(ctx, ['symbolic-ref', '-q', 'HEAD'], { ok: () => true })).stdout.trim();
    if (br !== `refs/heads/${ctx.t.branch}`) why.push(`HEAD is ${br || 'detached'}, not branch ${ctx.t.branch}: work on the ticket's branch`);
  }
  const anc = await R.git(ctx, ['merge-base', '--is-ancestor', from, ctx.head], { ok: (r) => r.err?.code === 1 });
  if (anc.err) why.push(`${from.slice(0, 12)} is not an ancestor of HEAD: history was rewritten below the task's start`);
  if (commit !== undefined && commit !== ctx.head) why.push(`result.commit ${String(commit).slice(0, 12)} is not HEAD ${ctx.head.slice(0, 12)}`);
  if (!why.length) return null;
  await R.logic(ctx, 'history', false, 'work', why.join('; '));
  return red('work', why.join('; '));
}

// the messages are the agent's: git log → a file (gitTo, ≤ 16 MB), read by the tests.js child (tests.trailers)
async function trailer(ctx, from) {
  const r = await R.child(ctx, TESTS_JS, [], { heap: 96, cls: () => 'work', input: { manifest: { mode: 'trailers' }, git: { log: ['log', '--format=%H %B%x00', `${from}..${ctx.head}`] } } });
  if (!r.out) {
    const why = `trailer check failed: ${r.why}`;
    await R.logic(ctx, 'trailer', false, r.cls, why);
    return red(r.cls, why);
  }
  const hits = r.out.hits;
  if (!hits.length) return null;
  const why = `commit ${list(hits)} carries an AI attribution (Co-Authored-By Claude/Anthropic or "Generated with"): reword it without the trailer`;
  await R.logic(ctx, 'trailer', false, 'work', why);
  return red('work', why);
}

const depsOf = (j) => JSON.stringify(DEP_KEYS.map((k) => j?.[k] ?? null));
const restOf = (j) => JSON.stringify(Object.entries(j ?? {}).filter(([k]) => !DEP_KEYS.includes(k) && k !== 'scripts').sort(([a], [b]) => (a < b ? -1 : 1)));
const scriptsOf = (j) => (j?.scripts !== null && typeof j?.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : {});
// the npm scripts (pre/post hooks too) whose text differs
const scriptsDiff = (x, y) => [...new Set([...Object.keys(scriptsOf(x)), ...Object.keys(scriptsOf(y))])].filter((k) => scriptsOf(x)[k] !== scriptsOf(y)[k]).sort();
const json = (b) => {
  try { return b ? JSON.parse(b.toString('utf8')) : {}; } catch { return undefined; }
};
// Config files steer how tests and installs run: new, changed or deleted → protected wherever they sit (owner
// 2026-10-10, contract R2). The tag's protected globs (helper dirs: test/utils/**, test/helpers/**): changed or
// deleted only (a new helper file is fine). tags.js DEFAULTS stay as they are.
const CONFIG_M = tests.globs(CONFIG);
const isConfig = (p) => CONFIG_M(path.posix.basename(p));
// lower-cased basename: APFS reads Package.json / .NPMRC / Yarn.lock as the real ones (review 2b r3)
const base = (p) => path.posix.basename(p).toLowerCase();
// a gate's tag globs, compiled once per gate (ctx): tests.globs / tests.testFiles
const protOf = (ctx) => (ctx.protM ??= tests.globs(ctx.gt.protected));
const isTest = (ctx) => (ctx.testM ??= tests.testFiles(ctx.gt.test_globs, ctx.gt.protected));
// diff entries whose blob (either side) is over PKG_MAX → `<path>: N bytes, at most 1 MB`, or all of them over PKG_TOTAL
// → one line; sizes from one cat-file --batch-check, so nothing over a cap is ever read into tbd (fail closed: the caller
// goes red / refuses)
async function tooBig(ctx, entries) {
  const shas = [...new Set(entries.flatMap((e) => [e.osha, e.nsha]).filter((x) => x !== ZERO))];
  if (!shas.length) return [];
  const r = await R.git(ctx, ['cat-file', '--batch-check'], { input: shas.join('\n') + '\n' });
  const size = new Map(String(r.stdout).split('\n').map((l, i) => [shas[i], Number(l.split(' ')[2]) || 0]));
  const big = entries.flatMap((e) => [e.osha, e.nsha].filter((x) => size.get(x) > PKG_MAX).map((x) => `${e.path}: ${size.get(x)} bytes, at most 1 MB`));
  const total = shas.reduce((n, x) => n + (size.get(x) ?? 0), 0);
  return big.length || total <= PKG_TOTAL ? big : [`${entries.length} package.json / .npmrc files: ${total} bytes in all, at most 2 MB`];
}
// R2+M2 + RO2, vs base_sha. Every package.json in the tree (root and nested) compared in three parts: dependency fields
// → deps; scripts (pre/post hooks too) → "scripts changed", always, whatever the tag's protected list; the rest →
// protected. A lockfile → deps. One ask names all of it (kind deps when a dependency changed, so setup runs again);
// a blob-bound allow (ZERO = deleted) covers that exact blob at HEAD, i.e. exactly what the ask named. A package.json
// over PKG_MAX → work, never read (tooBig).
async function protectedCheck(ctx, st, allow) {
  const entries = await R.diffRaw(ctx, ctx.t.base_sha, ctx.head);
  const ok = (e) => allow.some((a) => a?.path === e.path && a.blob && a.blob === e.nsha);
  const pkgs = entries.filter((e) => base(e.path) === 'package.json' && !ok(e));
  const big = await tooBig(ctx, pkgs);
  if (big.length) {
    await R.logic(ctx, 'protected', false, 'work', list(big));
    return red('work', list(big));
  }
  const b = await R.blobs(ctx, pkgs.flatMap((e) => [e.osha, e.nsha]).filter((x) => x !== ZERO));
  const deps = [];
  const prot = [];
  const scripts = [];
  for (const e of entries) {
    if (ok(e)) continue;
    const name = base(e.path);
    if (name === 'package.json') {
      const [x, y] = [json(e.osha === ZERO ? null : b.get(e.osha)), json(e.nsha === ZERO ? null : b.get(e.nsha))];
      if (x === undefined || y === undefined) {
        deps.push(e);
        prot.push(e);
        scripts.push(`${e.path} (unreadable JSON)`);
        continue;
      }
      if (depsOf(x) !== depsOf(y)) deps.push(e);
      const s = scriptsDiff(x, y);
      if (s.length) scripts.push(`${e.path} (${s.join(', ')})`);
      if (s.length || restOf(x) !== restOf(y)) prot.push(e);
    } else if (LOCKS.includes(name)) deps.push(e);
    else if (isConfig(e.path) || (e.status !== 'A' && protOf(ctx)(e.path))) prot.push(e);
  }
  const all = [...new Map([...deps, ...prot].map((e) => [e.path, e])).values()];
  st.scope.protected = all.map((e) => ({ path: e.path, blob: e.nsha }));
  st.scope.deps = deps.length > 0;
  if (!all.length) return null;
  const kind = deps.length ? 'deps' : 'protected';
  const parts = [deps.length && `dependency change: ${list([...new Set(deps.map((e) => e.path))])} (Irfan allows it, then tbd sets the dependencies up again)`,
    scripts.length && `scripts changed: ${list(scripts)}`,
    prot.filter((e) => !scripts.some((x) => x.startsWith(`${e.path} (`))).length && `protected files changed: ${list(prot.filter((e) => !scripts.some((x) => x.startsWith(`${e.path} (`))).map((e) => e.path))} (config, test helpers and package.json are Irfan's)`];
  const reason = parts.filter(Boolean).join('; ');
  await R.logic(ctx, 'protected', false, kind, reason);
  return red(kind, reason, { ask: { kind, files: all.map((e) => e.path), reason } });
}

// ---- task-only logic checks -----------------------------------------------------------------------------------------
async function scope(ctx, st, o) {
  const entries = ctx.diff ??= await R.diffRaw(ctx, ctx.pre, ctx.head);
  const task = o.task ?? {};
  const files = new Set(task.files ?? []);
  const mods = (task.modules ?? []).map((m) => `${String(m).replace(/\/+$/, '')}/`);
  const allowed = new Set((o.allow ?? []).map((a) => a?.path));
  const gen = tests.globs(ctx.gt.generated, false); // widens scope: exact case only
  const inScope = (p) => files.has(p) || allowed.has(p) || mods.some((m) => p.startsWith(m)) || (!LOCKS.includes(base(p)) && gen(p)); // K11: never a lockfile
  const bad = [];
  const live = entries.filter((e) => e.status !== 'D');
  const envs = new Set(ctx.tag.env_files ?? []);
  for (const e of entries) if (envs.has(e.path)) bad.push(`env file in a commit (a secret): ${e.path}`);
  for (const e of entries) if (e.path.includes('\uFFFD')) bad.push(`a path that is not UTF-8: ${JSON.stringify(e.path).slice(0, 100)}`); // git → JS read it lossily: two such paths can read as one
  for (const e of entries) if (ctrl(e.path)) bad.push(`control character in a path: ${JSON.stringify(e.path).slice(0, 100)}`);
  for (const e of live) if (e.nmode === '120000' || e.nmode === '160000') bad.push(`${e.nmode === '120000' ? 'symlink' : 'gitlink (submodule)'}: ${e.path}`);
  const blobs = live.filter((e) => e.nmode !== '160000' && !ctrl(e.path));
  if (blobs.length) {
    const r = await R.git(ctx, ['cat-file', '--batch-check'], { input: blobs.map((e) => e.nsha).join('\n') + '\n' });
    const sizes = String(r.stdout).split('\n');
    blobs.forEach((e, i) => { if (Number(sizes[i]?.split(' ')[2]) > BLOB_MAX) bad.push(`blob over 5 MB: ${e.path}`); });
    const ign = await R.git(ctx, ['check-ignore', '--no-index', '-z', '--stdin'], { input: blobs.map((e) => e.path).join('\0') + '\0', ok: (x) => x.err?.code === 1 });
    for (const p of String(ign.stdout).split('\0').filter(Boolean)) bad.push(`ignored file force-added: ${p}`);
  }
  const outside = entries.map((e) => e.path).filter((p) => !inScope(p));
  st.scope.outside = outside;
  st.scope.bad = bad;
  if (bad.length) {
    const why = `not allowed in a commit: ${list(bad)}`;
    await R.logic(ctx, 'scope', false, 'work', why);
    return red('work', why);
  }
  if (!outside.length) return null;
  const reason = `changed outside the task's files and modules: ${list(outside)}`;
  await R.logic(ctx, 'scope', false, 'scope', reason);
  return red('scope', reason, { ask: { kind: 'scope', files: outside, reason } });
}

const testsOf = (ctx) => (ctx.diff ?? []).filter((e) => isTest(ctx)(e.path));
async function testsCheck(ctx, st) {
  const T = testsOf(ctx);
  if (!T.length) return null;
  const shas = T.flatMap((e) => [e.osha, e.nsha]).filter((x) => x !== ZERO); // git writes them to the child's dir
  const manifest = { // path → blob sha: the child reads the texts
    pre: R.keyed(T.filter((e) => e.status !== 'A').map((e) => [e.path, e.osha])),
    head: R.keyed(T.filter((e) => e.status !== 'D').map((e) => [e.path, e.nsha])),
    deleted: T.filter((e) => e.status === 'D').map((e) => e.path),
  };
  const r = await R.child(ctx, TESTS_JS, [], { heap: 96, cls: () => 'work', input: { manifest, shas } });
  if (!r.out) {
    const why = `test scan failed: ${r.why}`;
    await R.logic(ctx, 'tests', false, r.cls, why);
    return red(r.cls, why);
  }
  const s = r.out;
  st.tests = { ...st.tests, files: T.filter((e) => e.status !== 'D').map((e) => e.path), skips_added: s.skips_added, deleted: s.deleted,
    expects_removed: s.expects_removed, count_drops: s.count_drops, count: s.count };
  const found = [...s.skips_added.map((x) => `skip/only added: ${x}`), ...s.deleted.map((x) => `test file deleted: ${x}`), ...s.count_drops.map((x) => `fewer tests: ${x}`)];
  if (!found.length) return null;
  const why = `tests weakened: ${list(found)}. Put them back; if the spec really changed, return TEST_DISPUTES_SPEC with your question`;
  await R.logic(ctx, 'tests', false, 'work', why);
  return red('work', why);
}

// ---- heavy checks ---------------------------------------------------------------------------------------------------
async function tagCheck(ctx, name, o = {}) {
  const cmd = ctx.gt.checks?.[name];
  if (typeof cmd !== 'string' || !cmd) return null;
  const c = await R.test(ctx, { check: name, cmd, ...o }); // R.test reruns test checks only (M11)
  return c.ok ? null : red(c.class, heavyWhy(c));
}

// K6 RO4: the task's test_cmd → argv, re-checked now (the plan is frozen, the tree is not)
async function testCmd(ctx, task) {
  const r = rules.testArgv(task?.test_cmd, { test_scripts: ctx.gt.test_scripts, npm: R.NPM });
  if ('why' in r) return { why: `test_cmd ${JSON.stringify(String(task?.test_cmd).slice(0, 100))}: ${r.why}`, cls: 'config' };
  const pkg = (await R.blobs(ctx, [`${ctx.t.base_sha}:package.json`])).get(`${ctx.t.base_sha}:package.json`);
  const scripts = json(pkg)?.scripts;
  if (!scripts || typeof scripts !== 'object' || !Object.hasOwn(scripts, r.script)) return { why: `test_cmd: npm script ${JSON.stringify(r.script)} is not in package.json at base`, cls: 'config' };
  if (r.paths.length) {
    const got = await R.git(ctx, ['cat-file', '--batch-check'], { input: r.paths.map((p) => `${ctx.head}:${p}`).join('\n') + '\n' });
    const missing = r.paths.filter((p, i) => (String(got.stdout).split('\n')[i] ?? ' missing').endsWith(' missing'));
    if (missing.length) return { why: `test_cmd names ${list(missing)}: not in the tree at HEAD`, cls: 'work' };
  }
  return r;
}

async function testCmdCheck(ctx, task) {
  if (!task?.test_cmd) return null;
  const r = await testCmd(ctx, task);
  if ('why' in r) {
    await R.logic(ctx, 'test_cmd', false, r.cls, r.why);
    return red(r.cls, r.why);
  }
  const c = await R.test(ctx, { check: 'test_cmd', argv: r.argv, isTestCmd: true });
  return c.ok ? null : red(c.class, heavyWhy(c));
}

async function unitCheck(ctx, o) {
  const max = store.config.gates?.unit_task_max_ms ?? 60_000;
  if (Number.isFinite(o.unitMs) && o.unitMs >= max) return null; // K13: too slow for every task; the working gate runs it
  return tagCheck(ctx, 'unit');
}

// ---- fail-first (K7) ------------------------------------------------------------------------------------------------
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
// jest, vitest, node:test summaries → {noTests} | {total, failed, compile} | null
function summary(out) {
  const s = String(out).replace(ANSI, '');
  if (/^No tests found, exiting with code 1/m.test(s) || /Your test suite must contain at least one test/.test(s) || /No test files found, exiting with code 1/.test(s)) return { noTests: true };
  const jest = /^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(?:\d+ passed, )?(\d+) total/m.exec(s);
  if (jest) return { total: Number(jest[2]), failed: Number(jest[1] ?? 0), compile: /^\s*● Test suite failed to run/m.test(s) };
  const vi = /^\s*Tests\s+(.+?)\s*$/m.exec(s);
  if (vi && /^\s*Test Files\s/m.test(s)) {
    if (/no tests/.test(vi[1])) return /^\s*Test Files\s+\d+ failed/m.test(s) ? { total: 0, failed: 0, compile: true } : { noTests: true };
    return { total: Number(/\((\d+)\)/.exec(vi[1])?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(vi[1])?.[1] ?? 0), compile: false };
  }
  const nt = /^[#ℹ] tests (\d+)$/m.exec(s);
  const nf = /^[#ℹ] fail (\d+)$/m.exec(s);
  if (nt && nf) return Number(nt[1]) === 0 ? { noTests: true } : { total: Number(nt[1]), failed: Number(nf[1]), compile: /\bSyntaxError\b/.test(s) };
  return null;
}

// names the task's non-test diff adds: a module name ↔ an added file (same stem), an identifier ↔ an added line (string
// contents dropped: `import x from 'lodash'` does not add lodash; tests.added in the child: the diff is the agent's,
// git diff → a file, ≤ 16 MB). The child fails (heap, timeout, git) → no identifier added: never proven_missing.
async function addedNames(ctx, nonTest, names) {
  const stem = (p) => path.posix.basename(p).replace(/\.(m|c)?(j|t)sx?$|\.json$/, '');
  const files = new Set(nonTest.filter((e) => e.status === 'A').map((e) => stem(e.path)));
  const ids = names.filter((n) => !/[/.]/.test(n));
  const diff = ['diff', '-U0', '--no-ext-diff', '--no-textconv', '--no-color', ctx.pre, ctx.head, '--', ...nonTest.map((e) => e.path)];
  const r = ids.length && nonTest.length ? await R.child(ctx, TESTS_JS, [], { heap: 96, input: { manifest: { mode: 'added', names: ids }, git: { diff } } }).catch(() => null) : null;
  const found = new Set(r?.out?.found ?? []);
  return (name) => (/[/.]/.test(name) ? files.has(stem(name)) : found.has(name));
}

async function restoreTree(ctx, head) {
  await R.git(ctx, ['reset', '-q', '--hard', head]);
  const env = ctx.tag.env_files ?? [];
  await R.git(ctx, ['clean', '-fdq', '-e', '/.claude/.cc-writes', ...env.flatMap((f) => ['-e', `/${f}`])]);
  const now = (await R.git(ctx, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (now !== head) throw new Error(`fail-first restore: HEAD is ${now.slice(0, 12)}, not ${head.slice(0, 12)}`);
  const dirty = (await spawn.dirtyPaths({ ...ctx.t, worktree: ctx.wt })).filter((l) => !env.includes(l.slice(3)));
  if (dirty.length) throw new Error(`fail-first restore: the tree is not clean: ${list(dirty, 10)}`);
}
// restore + checks.generate; → true when all of it passed (the marker may go)
async function restoreAll(ctx, head) {
  await restoreTree(ctx, head);
  const cmd = ctx.gt.checks?.generate;
  if (typeof cmd !== 'string' || !cmd) return true;
  const g = await R.run(ctx, { check: 'generate', cmd, suffix: '.restore' });
  if (g.class === 'interrupted') return false;
  if (!g.ok) throw new Error(`fail-first restore: checks.generate failed (${heavyWhy(g).slice(0, 300)})`);
  return true;
}

async function failfirst(ctx, st, o) {
  const task = o.task ?? {};
  if (task.type !== 'new') return null;
  const verdict = async (v, ok, cls, why) => {
    st.tests.failfirst = v;
    await R.logic(ctx, 'failfirst', ok, cls, why, { failfirst: v });
    return ok ? null : red(cls, why);
  };
  const T = testsOf(ctx).filter((e) => e.status !== 'D');
  const files = T.map((e) => e.path);
  if (!files.length) return verdict('unproven_no_tests', false, 'work', `a new task needs a test that fails without the change: no test file changed (test_globs ${ctx.gt.test_globs.join(', ')})`);
  const lie = (o.out?.tests ?? []).filter((p) => !files.includes(p));
  if (lie.length) return verdict('n/a', false, 'work', `tests_added names ${list(lie)}: not a test file this task changed`);
  const bad = files.filter((p) => /\s/.test(p) || 'why' in rules.testArgv(`npm test -- ${p}`));
  if (bad.length) return verdict('n/a', false, 'work', `test file name ${list(bad)}: letters, digits and ._@+/- only`);
  const cmd = await testCmd(ctx, task);
  if ('why' in cmd) return verdict('n/a', false, cmd.cls, cmd.why);
  const dash = cmd.argv.indexOf('--');
  const argv = [...(dash < 0 ? cmd.argv : cmd.argv.slice(0, dash)), '--', ...files];
  const nonTest = ctx.diff.filter((e) => !T.includes(e) && !isTest(ctx)(e.path));
  if (!(await ctx.save?.({ swap: { pre: ctx.pre, head: ctx.head, pid: 0, lstart: '' } }) ?? true)) {
    ctx.stale = true;
    throw new R.Stale();
  }
  let runs = [];
  let restored = false;
  try {
    if (nonTest.length) await R.git(ctx, ['checkout', '-q', '--no-overlay', ctx.pre, '--', ...nonTest.map((e) => e.path)]);
    const r1 = await R.run(ctx, { check: 'failfirst:pre', argv, key: 'test_cmd', isTestCmd: true });
    runs = [r1];
    if (!r1.ok && r1.class === 'work' && !r1.timed_out) runs.push(await R.run(ctx, { check: 'failfirst:pre2', argv, key: 'test_cmd', isTestCmd: true }));
  } finally {
    restored = await restoreAll(ctx, ctx.head);
    if (restored) await ctx.save?.({ swap: null });
  }
  const r1 = runs[0];
  const hard = runs.find((r) => r.class && r.class !== 'work'); // the 2nd run may be the one aborted
  if (hard || ctx.signal.aborted) return verdict('n/a', false, hard?.class ?? 'interrupted', hard ? heavyWhy(hard) : `aborted (${ctx.signal.reason})`);
  if (runs.some((r) => r.ok)) return verdict('vacuous', false, 'work', `fail-first: the new tests pass at pre (${ctx.pre.slice(0, 12)}) with this task's other changes reverted: they don't test the change. Make them fail without it.`);
  if (r1.timed_out) return verdict('unproven_unparsed', true, null, 'the tests timed out at pre');
  const p = summary(r1.tail);
  let v = !p ? 'unproven_unparsed' : p.noTests ? 'unproven_no_tests' : null;
  if (!v) {
    const names = tests.missingNames(r1.tail);
    const adds = names.length ? await addedNames(ctx, nonTest, names) : null;
    v = names.length ? (names.every(adds) ? 'proven_missing' : 'unproven_compile') : p.compile ? 'unproven_compile' : p.failed > 0 ? 'proven' : 'unproven_unparsed';
  }
  // proven_missing also needs the tests green at HEAD: test_cmd ran them already unless its args name other files
  if (v === 'proven_missing' && cmd.paths.length && !files.every((f) => cmd.paths.includes(f))) {
    const h = await R.run(ctx, { check: 'failfirst:head', argv, key: 'test_cmd', isTestCmd: true });
    if (!h.ok) return verdict('n/a', false, h.class, `the new tests fail at HEAD: ${heavyWhy(h)}`);
  }
  return verdict(v, true, null, v);
}

// ---- the gate -------------------------------------------------------------------------------------------------------
const TASK = {
  integrity: (ctx, st, o) => integrity(ctx, o),
  plan: (ctx, st, o) => plan(ctx, o),
  history: (ctx, st, o) => history(ctx, ctx.pre, o.out?.commit ?? null),
  trailer: (ctx) => trailer(ctx, ctx.pre),
  protected: (ctx, st, o) => protectedCheck(ctx, st, o.allow ?? []),
  scope,
  tests: (ctx, st) => testsCheck(ctx, st),
  generate: (ctx) => tagCheck(ctx, 'generate'),
  typecheck: (ctx) => tagCheck(ctx, 'typecheck'),
  test_cmd: (ctx, st, o) => testCmdCheck(ctx, o.task),
  unit: (ctx, st, o) => unitCheck(ctx, o),
  failfirst,
};

// Security review 2a: an ignored file is the agent's to forge and a check may trust it (a dist/*.tsbuildinfo makes `tsc
// --noEmit` exit 0 over a type error; .eslintcache, babel/swc caches alike). So every task and working gate starts from
// what git tracks + node_modules + the env files (+ claude's .claude/.cc-writes staging, as restoreTree): `git clean
// -ffdxq` (nested repos too), then node_modules/.cache, when there, removed by `/bin/rm -rf` as a check under the gate
// profile (writes only inside the worktree: a leftover process swapping in a link can't steer it outside; a red one →
// throw → infra). working.js ran the dirty check (dirty → no gate) and the integrity tripwire before the gate; this runs
// before the gate's first check, so before checks.generate and the fail-first swap.
async function cleanTree(ctx) {
  const env = ctx.tag.env_files ?? [];
  await R.git(ctx, ['clean', '-ffdxq', '-e', '/node_modules', '-e', '/.claude/.cc-writes', ...env.flatMap((f) => ['-e', `/${f}`]), '--']);
  if (!(await fsp.lstat(path.join(ctx.wt, 'node_modules', '.cache')).catch(() => null))) return;
  const c = await R.run(ctx, { check: 'clean', argv: ['/bin/rm', '-rf', '--', 'node_modules/.cache'] });
  if (!c.ok) throw new Error(`node_modules/.cache not removed: ${heavyWhy(c).slice(0, 300)}`);
}

// fn's GateResult, or on an unexpected error an infra one (fail closed); a stale save → interrupted, nothing written
async function guard(ctx, st, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof R.Stale || ctx.stale) return R.finish(ctx, { ...st, ok: false, class: 'interrupted', why: 'stale: the ticket moved on' });
    return R.finish(ctx, { ...st, ok: false, class: ctx.signal.aborted ? 'interrupted' : 'infra', why: `gate failed: ${e.message}` });
  }
}
// the checks in order, stop at the first red → its GateResult, or null (all green)
async function firstRed(ctx, st, names, CHECKS, o) {
  for (const name of names) {
    const r = await CHECKS[name](ctx, st, o);
    if (r) return R.finish(ctx, { ...st, ...r, ok: false });
  }
  return null;
}

/** contract Interface: runTaskGate({t, task, wt, pre, head, plan, tag, out, allow, unitMs, baseChecks, integrity, save, onSpawn, signal}) */
async function runTaskGate(o) {
  const ctx = await R.open({ ...o, gate: 'task' });
  const st = R.EMPTY();
  try {
    return await guard(ctx, st, async () => {
      await cleanTree(ctx);
      return (await firstRed(ctx, st, R.GATES.code.task, TASK, o)) ?? R.finish(ctx, { ...st, ok: true });
    });
  } finally {
    await R.close(ctx);
  }
}

/** contract Interface: restoreSwap(t, wt) — the marker's restore after a killed tbd; idempotent */
async function restoreSwap(t, wt) {
  const swap = t.work?.gate?.swap;
  if (!swap?.head) return;
  const ctx = await R.open({ t, wt, tag: store.listTags()[t.tag] ?? {}, gate: 'task', quiet: true });
  try {
    if (!(await restoreAll(ctx, swap.head))) throw new Error('fail-first restore: checks.generate was interrupted');
  } finally {
    await R.close(ctx);
  }
}

// a package.json's fields that are not dependencies (scripts included), comparable
const nonDeps = (j) => `${restOf(j)}\n${JSON.stringify(Object.entries(scriptsOf(j)).sort(([a], [b]) => (a < b ? -1 : 1)))}`;

module.exports = { runTaskGate, restoreSwap, guard, cleanTree, tooBig, firstRed, integrity, plan, history, trailer, protectedCheck, scope, testsCheck, tagCheck, summary, heavyWhy, red, list, json, nonDeps, ZERO };
