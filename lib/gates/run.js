'use strict';
// gates/run: the one check runner of every gate (contract rev 4.1 K5+RO1 K12+RO3+M10 M11 K13, Rules: gate env,
// timeouts, output, persistence, t:gate, gate composition as data). Loaded with the first gate job only (RAM: no
// module-level cache or timer here, only the one-time sweep of a killed tbd's gate dirs; tbd.js wires lib/gates lazily).
// open(o) → a gate context: the gate's own dir TB_HOME/g/<rand> (0700, removed at close; leftovers at the first open): t/ = the gate tmp (short:
// tsx's unix socket path ≤ 104 B, spike), npmrc = the empty NPM_CONFIG_USERCONFIG, <mode>.sb = the rendered profile,
// timer-<k> = tbx's timer flags (outside t/: a check can't fake one). The next gate number NN (gates/NN.json).
// profile(ctx, mode): lib/gates/gate.sb (the spike v2 text) with every path real (realpath: the kernel checks real
// paths; a /var → /private/var link would make a deny miss), the deny lists from phase-settings denyPaths (the one
// deny source; globs → SBPL regex), other worktrees, tag deny_ports. mode test (checks), setup (base checks, OpenAPI
// base, RO2 step 2: node_modules + _cacache writable), setupnet (RO2 step 1: + 443 and DNS).
// run(ctx, spec): doctor.heavy = `tbx heavy --timeout --timer-flag -- sandbox-exec -f <profile> -- argv`, stdio pipes,
// head 1 KB + tail 3 KB kept, the full log gzipped to gates/NN-<task>-<check>.log.gz (≤ 1 MB), env_files values
// redacted; proc {pid, lstart} saved at spawn (save false = stale gen: the gate stops, writes nothing more); class by
// classify (signal first: every tbd kill aborts the signal before it kills; then spawn error, the timer flag vs the
// base time, exit, tail) → CheckResult + one t:gate line + o.onCheck({check, ok}) (the SSE gate event; peak_rss_mb: monitor.watchTree on the check's group).
// test(ctx, spec): run, and a red test check (unit, test_cmd, e2e; never lint/typecheck/build) once more at the same
// head: green the 2nd time → flaky:true, passes (listed for review, M11).
// finish(ctx, fields) → GateResult, written atomically as tickets/<id>/gates/NN.json; a cancel or a stale save writes
// nothing (contract K12: cancel writes no result).
// Gate env (exact): PATH=<D30 node bin>:/usr/bin:/bin, HOME, CI=1, NO_COLOR=1, TZ=UTC, LANG=en_US.UTF-8,
// NPM_CONFIG_USERCONFIG=<empty file>, TMPDIR=<gate tmp> (spike: the default TMPDIR is outside the profile),
// GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1 (D-0077: git runs, never reads ~/.gitconfig), tag env
// (a prisma tag: CHECKPOINT_DISABLE=1, + PRISMA_SCHEMA_ENGINE_BINARY when the engine of the installed
// @prisma/engines-version sits in ~/.cache/prisma: after an RO2 two-step setup it is not in node_modules). stdin ignored.
// git: util.git (argv, GIT_SAFE, the ticket's pinned dirs); blobs through one `cat-file --batch` as Buffers (tbd's own
// reads), or git → file (blobsTo: the parser children's input, agent-sized: tbd never holds it).
// child(ctx, script, args, o): the parser children (openapi.js, tests.js, prisma.js): what an agent wrote is parsed in a
// capped node process of its own, never on tbd's thread (a hostile blob grew tbd +248 MB / froze it for minutes).
const cp = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('../store');
const doctor = require('../doctor');
const metrics = require('../metrics');
const monitor = require('../monitor');
const phaseSettings = require('../phase-settings');
const tagsLib = require('../tags');
const sh = require('../sh');
const { procs } = require('../slots');
const spawn = require('../spawn');
const { git: gitIn, isFile, readPlain, envPairs } = require('../util');
const { classify } = require('./classify');

const TEMPLATE = path.join(__dirname, 'gate.sb');
const TB_CODE = path.join(__dirname, '..', '..');
const NODE_BIN = path.dirname(process.execPath); // D30: tbd runs on the pinned node; gates use its npm
const NPM = path.join(NODE_BIN, 'npm');
// D-0077: /usr/bin/git is the xcode-select shim: it reads this link, then runs git from the developer dir it names
// (read per profile, no module cache: `xcode-select -s` takes effect at the next gate). A dev dir that is or holds a
// gate root would make that root executable: then an empty root-owned dir stands in (git fails, the gate stays tight).
const XCODE_LINK = '/private/var/db/xcode_select_link';
async function developerDir(/** @type {string[]} */ roots) {
  const d = await fsp.readlink(XCODE_LINK).then((t) => real(path.resolve(path.dirname(XCODE_LINK), t)), () => '/Library/Developer/CommandLineTools');
  const overlaps = d === '/' || roots.some((r) => r === d || r.startsWith(`${d}/`) || d.startsWith(`${r}/`));
  return overlaps ? '/private/var/empty' : d;
}
const WHY_MAX = 4096;
const TESTS = ['unit', 'test_cmd', 'e2e']; // M11: the only checks a red reruns once
const MODES = ['test', 'setup', 'setupnet'];
const GLOB_RE = /[*?[]/;
const SAFE_SB = /^\/[^\0\n"\\]*$/; // a path inside an SBPL string: never a quote or a backslash
const OUT_MAX = 16 << 20; // a git output written to a file for a parser child (gitTo)
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const cut = (s, n = WHY_MAX) => String(s ?? '').slice(0, n);
const tbHome = () => process.env.TB_HOME || path.join(os.homedir(), '.taskboard');

// Gate composition as data (contract Rules): the checks of each gate, in order. task + the logic part of working stop
// at the first red; working's heavy + policy checks all run (one fix session sees every red). M5 C10 (D-0089): the final
// gate = the working gate + the tag's e2e (D24: skipped without checks.e2e).
const WORKING = ['integrity', 'plan', 'history', 'trailer', 'protected', 'scope', 'tests', 'generate', 'lint', 'typecheck', 'build', 'unit', 'prisma', 'openapi'];
const GATES = Object.freeze({
  code: Object.freeze({
    base: Object.freeze(['generate', 'typecheck', 'unit', 'lint', 'build']),
    task: Object.freeze(['integrity', 'plan', 'history', 'trailer', 'protected', 'scope', 'tests', 'generate', 'typecheck', 'test_cmd', 'unit', 'failfirst']),
    working: Object.freeze(WORKING),
    final: Object.freeze([...WORKING, 'e2e']),
  }),
});
const LOGIC = new Set(['integrity', 'plan', 'history', 'trailer', 'protected', 'scope', 'tests']);

class Stale extends Error {} // save() said the gen moved on: the gate writes nothing more
// the first open of this process (lib/gates loads at the first gate job after boot) removes the gate dirs a killed tbd
// left in TB_HOME/g (blob copies, gate tmp); every open waits for it, so it never takes a dir made after it started
let leftDirs = null;

// a path the kernel will see: realpath of its longest existing part (a glob part and what follows stay as they are)
async function real(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    const d = path.dirname(p);
    return d === p ? p : path.join(await real(d), path.basename(p));
  }
}
async function realish(p) {
  const i = p.search(GLOB_RE);
  if (i < 0) return real(p);
  const at = p.lastIndexOf('/', i);
  return path.join(await real(p.slice(0, at) || '/'), p.slice(at + 1));
}
const sbStr = (p) => {
  if (!SAFE_SB.test(p)) throw new Error(`gate profile: unsafe path ${JSON.stringify(p.slice(0, 200))}`);
  return `"${p}"`;
};
// a phase-settings glob (`*` one part, `**` any depth, [class]) → an SBPL regex body; what is below a match matches too
function globRe(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += g[i + 2] === '/' ? '(.*/)?' : '.*';
      i += g[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const j = g.indexOf(']', i + 1);
      if (j < 0) throw new Error(`gate profile: unclosed [ in ${JSON.stringify(g)}`);
      out += g.slice(i, j + 1);
      i = j;
    } else out += /[.+^$|(){}]/.test(c) ? `\\${c}` : c;
  }
  return out;
}
const filter = (p) => (GLOB_RE.test(p) ? (sbStr(p), `(regex #"^${globRe(p)}(/.*)?$")`) : `(subpath ${sbStr(p)})`);

// env_files KEY=value lines → the values (≥ 4 chars), read from the tag's own files (util.envPairs: a link is never followed)
const secrets = async (tag) => (await envPairs(tag)).map(([, v]) => v).filter((v) => v.length >= 4);

// the schema engine of the installed @prisma/engines-version, if ~/.cache/prisma holds it (spike RO2 note)
async function prismaEngine(wt, home) {
  const raw = await readPlain(path.join(wt, 'node_modules', '@prisma', 'engines-version', 'package.json'), 64 << 10); // setup-mode code can write it
  let v;
  try { v = JSON.parse(raw ?? '').version; } catch { return null; }
  const hash = typeof v === 'string' ? v.split('.').pop() : '';
  if (!/^[0-9a-f]{20,64}$/.test(hash)) return null;
  const bin = path.join(home, '.cache', 'prisma', 'master', hash, `darwin${process.arch === 'arm64' ? '-arm64' : ''}`, 'schema-engine');
  return (await isFile(bin)) ? bin : null;
}

// a check's timeout: tags.checkTimeoutMs (tag timeout_min, else config, else the default; under the max hold), the same
// resolver `tb doctor --tag` uses
const timeoutMs = (key, tag = {}) => tagsLib.checkTimeoutMs(key, tag, store.config);

/**
 * @param {{t: any, wt: string, tag: any, gate: 'base'|'task'|'working'|'final', task?: any, pre?: string|null, head?: string,
 *   save?: (p: any) => Promise<boolean>, onSpawn?: (pid: number) => void, signal?: AbortSignal, baseChecks?: any,
 *   onCheck?: (e: {check: string, ok: boolean}) => void, quiet?: boolean}} o quiet: no gate number, no logs, no t:gate
 *   (restoreSwap, deps setup); onCheck: each finished check (the SSE gate event)
 */
async function open(o) {
  const home = await real(os.homedir());
  const tb = await real(tbHome());
  const g = path.join(tb, 'g');
  await fsp.mkdir(g, { recursive: true, mode: 0o700 });
  await (leftDirs ??= fsp.readdir(g).then((l) => Promise.all(l.filter((x) => /^x[A-Za-z0-9]{6}$/.test(x)).map((x) => fsp.rm(path.join(g, x), { recursive: true, force: true })))));
  const dir = await fsp.mkdtemp(path.join(g, 'x')); // ponytail: mkdtemp's 6 random chars; the path stays short
  const gtmp = path.join(dir, 't');
  await fsp.mkdir(gtmp, { mode: 0o700 });
  const npmrc = path.join(dir, 'npmrc');
  await fsp.writeFile(npmrc, '', { mode: 0o600, flag: 'wx' });
  const gt = tagsLib.gateTag(o.tag ?? {});
  const env = {
    PATH: `${NODE_BIN}:/usr/bin:/bin`, HOME: home, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'en_US.UTF-8', NPM_CONFIG_USERCONFIG: npmrc, TMPDIR: gtmp,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  if (gt.prisma) {
    env.CHECKPOINT_DISABLE = '1';
    const eng = await prismaEngine(o.wt, home);
    if (eng) env.PRISMA_SCHEMA_ENGINE_BINARY = eng;
  }
  const gdir = path.join(store.ticketDir(o.t.id), 'gates');
  let n = null;
  if (!o.quiet) {
    await fsp.mkdir(gdir, { recursive: true, mode: 0o700 });
    const ns = (await fsp.readdir(gdir)).map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
    n = (ns.length ? Math.max(...ns) : 0) + 1;
  }
  const ac = new AbortController(); // ours: a stale save stops the gate
  const work = o.t.work?.tasks?.find((x) => x.id === o.task?.id);
  const env0 = o.tag?.env_files ?? [];
  // the tree's state before any check: finish() blames the checks only for what they added (working.js gates a clean tree)
  const dirty0 = o.quiet ? [] : (await spawn.dirtyPaths({ ...o.t, worktree: o.wt })).filter((l) => !env0.includes(l.slice(3)));
  return {
    dirty0,
    t: o.t, wt: o.wt, wtReal: await real(o.wt), tag: o.tag ?? {}, gt, gate: o.gate, task: o.task ?? null, pre: o.pre ?? null, head: o.head ?? '',
    attempt: work?.attempt ?? 0, save: o.save, onSpawn: o.onSpawn ?? (() => {}), onCheck: o.onCheck ?? (() => {}), outer: o.signal,
    signal: o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal, ac, stale: false, quiet: !!o.quiet,
    baseChecks: o.baseChecks ?? {}, home, tb, dir, gtmp, npmrc, env, redact: await secrets(o.tag), gdir, n, k: 0, t0: Date.now(), slotWait: 0,
    profiles: {}, checks: /** @type {any[]} */ ([]), lines: /** @type {any[]} */ ([]),
  };
}

const close = (ctx) => fsp.rm(ctx.dir, { recursive: true, force: true }).catch((e) => console.error(`tbd: gate dir ${ctx.dir} not removed: ${e.message}`));

/** @param {any} ctx @param {'test'|'setup'|'setupnet'} mode @returns {Promise<string>} the rendered profile file */
async function profile(ctx, mode) {
  if (!MODES.includes(mode)) throw new Error(`gate profile: no mode ${mode}`);
  if (ctx.profiles[mode]) return ctx.profiles[mode];
  const T = ctx.t;
  const tag = ctx.tag;
  const tagPath = typeof tag.path === 'string' ? await real(tag.path) : path.join(ctx.tb, 'no-tag');
  const port = Number(process.env.TB_PORT) || store.config.http?.port || 7777;
  const deny = phaseSettings.denyPaths({
    WORKTREE: ctx.wtReal, TICKET_DIR: path.join(ctx.tb, 'tickets', T.id), OUT_DIR: path.join(ctx.tb, 'tickets', T.id, 'out'), TB_HOME: ctx.tb,
    TAG_PATH: tagPath, SKILLS_DIR: path.join(ctx.tb, 'tickets', T.id, 'skills'), TB_CODE: await real(TB_CODE), TB_NODE: process.execPath,
    TB_PORT: port, HEAVY: tag.heavy ?? [], ENV_FILES: tag.env_files ?? [],
  });
  const reals = async (list) => [...new Set(await Promise.all(list.map(realish)))];
  const read = await reals(deny.read);
  // setup variants write node_modules (npm rebuild): the agent's node_modules denies stay out of them
  const write = (await reals(deny.write)).filter((p) => mode === 'test' || !(p === `${ctx.wtReal}/node_modules` || p.startsWith(`${ctx.wtReal}/node_modules/`)));
  const others = (await fsp.readdir(path.join(ctx.tb, 'worktrees')).catch(() => [])).filter((x) => path.join(ctx.tb, 'worktrees', x) !== ctx.wtReal);
  const vals = {
    WT: ctx.wtReal, GTMP: ctx.gtmp, TB_HOME: ctx.tb, NODE_HOME: await real(path.dirname(NODE_BIN)), HOME: ctx.home, EMPTY_NPMRC: ctx.npmrc,
    TBD_PORT: String(port), DEV_DIR: await developerDir([ctx.wtReal, ctx.gtmp, ctx.tb, ctx.home]),
    DENY_PORTS: (ctx.gt.deny_ports ?? []).map((p) => `(deny network-outbound (remote ip "localhost:${Number(p)}"))`).join('\n'),
    DENY_READ: read.length ? `(deny file-read* file-write*\n  ${read.map(filter).join('\n  ')}\n)` : '',
    OTHER_WORKTREES: others.map((x) => filter(path.join(ctx.tb, 'worktrees', x))).join(' '),
    DENY_WRITE: write.length ? `(deny file-write*\n  ${write.map(filter).join('\n  ')}\n)` : '',
  };
  for (const k of ['WT', 'GTMP', 'TB_HOME', 'NODE_HOME', 'HOME', 'EMPTY_NPMRC', 'DEV_DIR']) sbStr(vals[k]);
  // M5 C7: `; @pg` (the 5432 deny) goes only for the checks (test mode) of a tag with db: "local" (S3: loopback ok, any
  // other host stays denied); setup's install scripts (npm rebuild) never reach postgres (sec F5)
  const keep = (l) => (l.endsWith('; @test') ? mode === 'test' : l.endsWith('; @setup') ? mode !== 'test' : l.endsWith('; @net') ? mode === 'setupnet'
    : l.endsWith('; @pg') ? !(tag.db === 'local' && mode === 'test') : true);
  const text = (await fsp.readFile(TEMPLATE, 'utf8')).split('\n').filter(keep).join('\n')
    .replace(/\$\{([A-Z_]+)\}/g, (all, k) => {
      if (!Object.hasOwn(vals, k)) throw new Error(`gate profile: unknown placeholder ${all}`);
      return vals[k];
    });
  const file = path.join(ctx.dir, `${mode}.sb`);
  await fsp.writeFile(file, text, { mode: 0o600, flag: 'wx' });
  ctx.profiles[mode] = file;
  return file;
}

// A check's processes that left its group (setsid, double fork) still carry TBGATE=<id>: ps -E shows the env of
// own-uid processes (read line by line, only the matches kept); each one found is SIGKILLed after the check. ponytail: platform binaries (/bin/sleep) hide their
// env from ps, and a process can unset the mark: both stay sandboxed, only the RAM leaks (residual).
async function sweep(id) {
  const c = cp.spawn('/bin/ps', ['-E', '-ww', '-x', '-U', String(process.getuid?.() ?? 0), '-o', 'pid=,command='], { timeout: 10_000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise((res) => {
    c.on('error', (e) => res(e.message));
    c.on('close', (code, sig) => res(code ?? sig));
  });
  const mark = new RegExp(`\\sTBGATE=${id}(\\s|$)`);
  const pids = [];
  try {
    for await (const l of readline.createInterface({ input: c.stdout, crlfDelay: Infinity })) { // line by line: an env can be MBs
      const pid = Number(/^\s*(\d+)\s/.exec(l)?.[1]);
      if (pid > 1 && pid !== process.pid && mark.test(l)) pids.push(pid);
    }
  } catch { /* the exit says why */ }
  const code = await done;
  if (code !== 0) return void console.error(`tbd: gate sweep: ps failed (${code}): processes of check ${id} may live on`);
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

// proc {pid, lstart} of a check's tbx, saved before anything else of it is waited for; false → stale: stop the gate
async function saveProc(ctx, pid) {
  if (!ctx.save) return;
  const lstart = (await procs(true))?.get(pid)?.lstart;
  if (!lstart) return; // gone already: nothing a later tbd could kill
  if (!(await ctx.save({ proc: { pid, lstart } }))) {
    ctx.stale = true;
    ctx.ac.abort('cancel');
  }
}

const slug = (s) => String(s ?? '').replace(/[^\w@.-]/g, '_').slice(0, 60);
const logName = (ctx, check, suffix = '') => `${String(ctx.n).padStart(2, '0')}-${slug(ctx.task?.id ?? ctx.gate)}-${slug(check)}${suffix}.log.gz`;

// one t:gate line (contract fields); none for a quiet ctx, a cancel or a stale gate
async function line(ctx, c, extra = {}) {
  if (ctx.quiet || ctx.stale || ctx.outer?.reason === 'cancel') return;
  await metrics.gate({
    ticket: ctx.t.id, task: ctx.task?.id ?? null, gate: ctx.gate, check: c.check, ok: c.ok, exit: c.exit, class: c.class ?? null, ms: c.ms,
    slot_wait_ms: c.slot_wait_ms ?? 0, head: ctx.head || null, attempt: ctx.attempt, flaky: !!c.flaky, failfirst: extra.failfirst ?? null,
    detail: extra.detail ?? (c.ok ? null : c.timed_out ? 'timed out' : c.exit === null ? 'no exit code' : `exit ${c.exit}`), peak_rss_mb: c.peak_rss_mb ?? null,
  });
  // the contract's SSE `gate` event (tbd.js wires onCheck; gates never require http): sync, and a UI error never fails or
  // slows a gate. A flaky rerun's 1st run emits too (ok:false, then ok:true): a live view.
  try { ctx.onCheck({ check: c.check, ok: c.ok }); } catch { /* the view's problem */ }
}

/**
 * One heavy check. spec: {check, argv | cmd (a tags.json command: sh -c, trusted D35d, still sandboxed), mode?, key?
 * (its timeout and base-time name, default check), isTestCmd?, suffix? (log name), rerun? (M11: green → flaky)}. → CheckResult + class, slot_wait_ms,
 * peak_rss_mb (finish strips them).
 */
async function run(ctx, spec) {
  const { check, mode = 'test', key = check, isTestCmd = false, suffix = '', rerun = false } = spec;
  const argv = spec.argv ?? ['/bin/sh', '-c', spec.cmd];
  const budgetMs = timeoutMs(key, ctx.tag);
  const base = { check, flaky: false, log: null, slot_wait_ms: 0, peak_rss_mb: null };
  if (ctx.signal.aborted) {
    if (ctx.stale) throw new Stale();
    const c = { ...base, ok: false, exit: null, timed_out: false, ms: 0, tail: `not run: the gate was aborted (${ctx.signal.reason})`, class: 'interrupted' };
    ctx.checks.push(c);
    return c;
  }
  const log = ctx.quiet ? null : logName(ctx, check, suffix);
  const flag = path.join(ctx.dir, `timer-${++ctx.k}`);
  const id = `${path.basename(ctx.dir)}-${ctx.k}`; // TBGATE: this check's mark in the env of everything it starts
  let stop = null;
  let saving = Promise.resolve();
  let peak = null;
  let r;
  try {
    r = await doctor.heavy(ctx.wt, argv, {
    timeoutMs: budgetMs, env: { ...ctx.env, TBGATE: id }, sandbox: await profile(ctx, mode), signal: ctx.signal, redact: ctx.redact, timerFlag: flag,
    keep: log ? { file: path.join(ctx.gdir, log) } : null,
    onSpawn: (pid) => {
      ctx.onSpawn(pid);
      saving = saveProc(ctx, pid);
      saving.catch(() => {}); // awaited only once heavy() is back (minutes): never an unhandled rejection meanwhile (A10)
    },
    onGroup: (g) => { stop = monitor.watchTree(g); },
    });
    await sweep(id);
    await saving;
  } finally {
    peak = stop?.() ?? null; // the monitor forgets the group whatever happened
  }
  if (ctx.stale) throw new Stale();
  const cls = classify({
    signalAborted: ctx.signal.aborted, abortReason: ctx.signal.reason, spawnErr: r.spawnErr, timerFired: r.timedOut, exit: r.exit, tail: r.tail,
    check: key, baseMs: ctx.baseChecks?.[key]?.ms ?? null, budgetMs, isTestCmd,
  });
  ctx.slotWait += r.slotWaitMs;
  const c = {
    ...base, ok: cls === null, flaky: rerun && cls === null, exit: r.exit, timed_out: r.timedOut, ms: r.ms, log: log && !r.spawnErr ? `gates/${log}` : null,
    tail: r.spawnErr && !r.tail ? `${argv[0]}: ${r.spawnErr.code}` : r.tail, class: cls, slot_wait_ms: r.slotWaitMs, peak_rss_mb: peak,
  };
  ctx.checks.push(c);
  await line(ctx, c);
  return c;
}

// M11: every gate check goes through here; only a red test check (unit, test_cmd, e2e; work, not a timeout) runs once
// more at the same head; green then → flaky, passes
async function test(ctx, spec) {
  const c = await run(ctx, spec);
  if (c.ok || c.class !== 'work' || c.timed_out || ctx.signal.aborted || !TESTS.includes(spec.key ?? spec.check)) return c;
  ctx.checks.splice(ctx.checks.indexOf(c), 1); // the GateResult keeps the 2nd run (the 1st: its t:gate line + log)
  return run(ctx, { ...spec, suffix: '.2', rerun: true });
}

// a logic check (no process): its CheckResult + t:gate line (extra: {failfirst, detail})
async function logic(ctx, check, ok, cls, detail, extra = {}) {
  const c = { check, ok, exit: null, timed_out: false, ms: 0, flaky: false, log: null, tail: cut(detail, WHY_MAX), class: ok ? null : cls, slot_wait_ms: 0, peak_rss_mb: null };
  ctx.checks.push(c);
  await line(ctx, c, { detail: ok ? null : cut(detail, 200), ...extra });
  return c;
}

const EMPTY = () => ({
  scope: { outside: [], protected: [], deps: false, bad: [] },
  tests: { failfirst: 'n/a', files: [], skips_added: [], deleted: [], expects_removed: [], count_drops: [], count: { pre: 0, head: 0 } },
  schema: [], api: [], migration: [], unused_allowed: [], ask: null,
});

// MED (verifier): the checks must leave the tree as they found it (git status, ignored files and env files aside)
async function leftovers(ctx) {
  const env = ctx.tag.env_files ?? [];
  return (await spawn.dirtyPaths({ ...ctx.t, worktree: ctx.wt })).filter((l) => !env.includes(l.slice(3)));
}

/** @returns {Promise<import('./types').GateResult>} written to gates/NN.json unless cancelled or stale. An aborted gate
 * is never green (interrupted: the checks after the abort did not run); a gate whose checks left the tree dirty is
 * class integrity (what a check wrote is not the agent's commit). */
async function finish(ctx, f) {
  const st = { ...EMPTY(), ...f };
  if (ctx.signal.aborted && !ctx.quiet) Object.assign(st, { ok: false, class: 'interrupted', why: st.why || `aborted (${ctx.signal.reason})` });
  else if (!ctx.quiet && !ctx.stale && st.class !== 'interrupted') {
    const left = await leftovers(ctx).then((l) => l.filter((x) => !ctx.dirty0.includes(x)), (e) => e);
    if (left instanceof Error) Object.assign(st, { ok: false, class: 'infra', why: cut(`git status after the checks failed: ${left.message}${st.why ? `\n\n${st.why}` : ''}`) });
    else if (left.length) Object.assign(st, { ok: false, class: 'integrity', why: cut(`the gate's checks left the worktree dirty: ${left.slice(0, 20).join(', ')}${st.why ? `\n\n${st.why}` : ''}`) });
  }
  const res = {
    n: ctx.n,
    v: /** @type {1} */ (1), gate: ctx.gate, ticket: ctx.t.id, task: ctx.task?.id ?? null, attempt: ctx.attempt, pre: ctx.pre, head: ctx.head, plan_hash: ctx.t.plan_hash ?? null,
    at: iso(ctx.t0), ms: Date.now() - ctx.t0, slot_wait_ms: ctx.slotWait, ok: !!st.ok, class: st.ok ? null : st.class ?? 'work',
    checks: ctx.checks.map(({ check, ok, exit, timed_out, ms, flaky, log, tail }) => ({ check, ok, exit, timed_out, ms, flaky, log, tail: cut(tail) })),
    scope: st.scope, tests: st.tests, schema: st.schema, api: st.api, migration: st.migration, unused_allowed: st.unused_allowed, ask: st.ask, why: cut(st.why ?? ''),
  };
  if (ctx.quiet || ctx.stale || ctx.outer?.reason === 'cancel') return res;
  await store.writeAtomic(path.join(ctx.gdir, `${String(ctx.n).padStart(2, '0')}.json`), JSON.stringify(res, null, 2) + '\n');
  return res;
}

// ---- git -----------------------------------------------------------------------------------------------------------
const bufExec = (f, a, o) => sh(f, a, { ...o, encoding: 'buffer' });
/** @returns {Promise<any>} sh-shaped; throws on a git failure unless ok(r) says the exit is fine */
async function git(ctx, args, o = {}) {
  const r = await gitIn(ctx.wt, args, { timeout: 120_000, dirs: ctx.t.git_dir ? ctx.t : undefined, ...o });
  if (r.err && !(o.ok?.(r))) throw new Error(`git ${args[0]} in ${ctx.wt}: ${cut(String(r.stderr || r.err.message).trim(), 300)}`);
  return r;
}
// specs (<sha> or <rev>:<path>, no newline) → Map spec → Buffer | null (missing), one cat-file --batch
async function blobs(ctx, specs) {
  const out = new Map();
  const list = [...new Set(specs)];
  if (!list.length) return out;
  if (list.some((s) => /[\0\n]/.test(s))) throw new Error('cat-file: a spec with a newline');
  const r = await git(ctx, ['cat-file', '--batch'], { input: list.join('\n') + '\n', maxBuffer: 64 << 20, exec: bufExec });
  const b = /** @type {Buffer} */ (r.stdout);
  let i = 0;
  for (const s of list) {
    const nl = b.indexOf(10, i);
    if (nl < 0) throw new Error('cat-file: short output');
    const hdr = b.subarray(i, nl).toString();
    i = nl + 1;
    if (/ (missing|ambiguous)$/.test(hdr)) {
      out.set(s, null);
      continue;
    }
    const size = Number(hdr.split(' ')[2]);
    out.set(s, b.subarray(i, i + size));
    i += size + 1;
  }
  return out;
}
// git args → file (0600, new): git's stdout opened on that file, so the bytes go from git to the disk, never through tbd
// (RAM contract: peak ≤ idle + 20 MB; a stream through tbd still kept ~1× the bytes in stream chunks until a GC,
// measured), at most OUT_MAX bytes (ulimit -f: over → SIGXFSZ, git dies → throw). The gate's abort kills git.
async function gitTo(ctx, args, file) {
  const fh = await fsp.open(file, 'wx', 0o600);
  try {
    await git(ctx, args, { exec: (f, a, o) => toFd(f, a, o, fh.fd, ctx.signal) });
  } finally {
    await fh.close();
  }
}
// shas → <dir>/<sha> each: `git cat-file blob <sha>` (gitTo), one git per blob, in turn; a missing blob fails git (→ throw)
async function blobsTo(ctx, shas, dir) {
  for (const sha of new Set(shas)) {
    if (ctx.signal.aborted) throw new Error(`aborted (${ctx.signal.reason})`);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`cat-file: ${JSON.stringify(String(sha).slice(0, 80))} is not a blob sha`);
    await gitTo(ctx, ['cat-file', 'blob', sha], path.join(dir, sha));
  }
}
// util.git's exec for gitTo: git under `ulimit -f` (KB on macOS /bin/sh; "$0" "$@": argv, no shell parsing) with its
// stdout on fd; sh-shaped result, stdout ''
const toFd = (file, args, o, fd, signal) => new Promise((res) => {
  const c = cp.spawn('/bin/sh', ['-c', `ulimit -f ${OUT_MAX >> 10}; exec "$0" "$@"`, file, ...args], { env: o.env, timeout: o.timeout, signal, stdio: ['ignore', fd, 'pipe'] });
  let stderr = '';
  c.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
  c.on('error', (err) => res({ err, stdout: '', stderr }));
  c.on('close', (code, sig) => res({ err: code === 0 ? null : Object.assign(new Error(sig === 'SIGXFSZ' ? `output over ${OUT_MAX} bytes` : `exit ${code ?? sig}`), { code, signal: sig }), stdout: '', stderr }));
});
// `git diff --raw -z --no-renames a b` → [{omode, nmode, osha, nsha, status, path}]
async function diffRaw(ctx, a, b) {
  const r = await git(ctx, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', a, b]);
  const parts = String(r.stdout).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
    if (!m) throw new Error(`git diff --raw: can't read ${JSON.stringify(parts[i].slice(0, 80))}`);
    out.push({ omode: m[1], nmode: m[2], osha: m[3], nsha: m[4], status: m[5], path: parts[i + 1] });
  }
  return out;
}

// ---- parser children ------------------------------------------------------------------------------------------------
// `node --max-old-space-size=<heap MB> <script> [<input dir>] ...args`, cwd the gate dir, env PATH only, timeout ms; the
// gate's abort ends it. input {manifest, shas?, git?: {name: git args}}: each blob written by git to <input dir>/<sha>
// (blobsTo), each git output to <input dir>/<name> (gitTo: tbd never holds either) + manifest.json, 0600, in a fresh dir
// under ctx.dir (the gate dir: removed at close).
// → {out: the last stdout line, parsed} | {cls, why}: interrupted when the gate aborted; infra when node could not start
// (a string code: EAGAIN, ENOMEM; host trouble, not the agent's); else cls(exit code) (fail closed) for an exit ≠ 0, a
// signal (heap OOM, the timeout) or no JSON line.
/** @param {any} ctx @param {string} script @param {string[]} args @param {{heap?: number, timeout?: number,
 *   cls?: (code: any) => string, input?: {manifest: any, shas?: string[], git?: Record<string, string[]>}|null}} [o] */
async function child(ctx, script, args, o = {}) {
  const { heap = 64, timeout = 30_000, cls = () => 'infra', input = null } = o;
  if (input) {
    const dir = await fsp.mkdtemp(path.join(ctx.dir, 'in'));
    await blobsTo(ctx, input.shas ?? [], dir);
    for (const [name, a] of Object.entries(input.git ?? {})) await gitTo(ctx, a, path.join(dir, name));
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(input.manifest), { mode: 0o600, flag: 'wx' });
    args = [dir, ...args];
  }
  const r = await sh(process.execPath, [`--max-old-space-size=${heap}`, script, ...args], { cwd: ctx.dir, env: { PATH: '/usr/bin:/bin' }, timeout, maxBuffer: 8 << 20, signal: ctx.signal }); // ponytail: tbd's own JSON, not agent output
  if (ctx.signal.aborted) return { cls: 'interrupted', why: `aborted (${ctx.signal.reason})` };
  const err = String(r.stderr ?? '');
  const why = (/FATAL ERROR: .*/.exec(err)?.[0] ?? err).trim().slice(0, 1000); // a heap OOM: its line, not V8's GC trace
  if (r.err) return { cls: typeof r.err.code === 'string' && !r.err.killed ? 'infra' : cls(r.err.code), why: `${r.err.killed ? `timed out (${timeout / 1000} s)` : `exit ${r.err.code ?? r.err.signal}`}${why && `: ${why}`}` };
  try {
    return { out: JSON.parse(String(r.stdout).trim().split('\n').pop() ?? '') };
  } catch {
    return { cls: cls(0), why: 'no result line' };
  }
}

// [key, value] pairs → an object; a key twice → throw (git paths are read as UTF-8: two paths that are not can read as
// one string, and a manifest would keep only the last)
function keyed(pairs) {
  const o = {};
  for (const [k, v] of pairs) {
    if (Object.hasOwn(o, k)) throw new Error(`two paths read as ${JSON.stringify(String(k).slice(0, 200))} (not UTF-8)`);
    o[k] = v;
  }
  return o;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { GATES, LOGIC, TESTS, NPM, Stale, open, close, profile, run, test, logic, finish, git, blobs, blobsTo, diffRaw, child, keyed, sha256, cut, timeoutMs, globRe, EMPTY };
