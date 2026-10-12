'use strict';
// gates/working: the working gate, the base checks, the OpenAPI base and the RO2 deps setup (contract rev 4.1 N3 K8+M8
// K9+M7 K10 RO2 M9+N8 K13, Rules M1 D34 plan_hash; design §3).
// runWorkingGate: task.js's cleanTree first (ignored files gone), then GATES.code.working (run.js). The logic part
// (integrity, plan, history from base_sha, D34 trailer over base..HEAD, protected/deps vs base_sha with every allow,
// scope over base..HEAD = the union of every plan task's files and modules + generated + every allow (an @fix commit is
// judged here, never by a task gate), the tests weakening scan over base..HEAD) stops at the first red; then every
// heavy + policy check runs (one fix session sees every red): generate, lint, typecheck, build, unit (always; flaky
// rerun), prisma, openapi.
//   prisma (K8+M8): every *.prisma under tag prisma.schema + every file under prisma.migrations at base and HEAD, sizes
//     from `ls-tree -l` first (texts ≤ 1 MB a side, never read beyond), written by git into files (R.blobsTo: tbd
//     never holds them); old migrations go in as their blob sha (compared, never read) → prisma.diff in a child
//     (R.child: `node --max-old-space-size=64 lib/gates/prisma.js <input dir>`, 30 s; it fails → work "schema scan
//     failed") → K10 changes marked by plan-rules.markAllowed (allowed_*, rename needs the new field added);
//     migration[] (edited / deleted / drift) and unreadable schema or SQL → work, never policy;
//   openapi (K9+M7): the tag's cmd (sandboxed) writes the spec; the diff runs in a child (`node
//     --max-old-space-size=128 lib/gates/openapi.js <base> <head> <worktree>`, 30 s): exit 3 missing, 5 a link or
//     outside the worktree, 6 not JSON / not OpenAPI → work; 1, 2, 4 (> 5 MB), a signal or a timeout → infra.
//   Class: interrupted > infra > policy (a not-allowed schema/API change: ask {kind policy, changes}, clarify first;
//   the why keeps only the non-policy reds) > work. unused_allowed lists allowed_* entries no change used (review).
// The setup profile lets node_modules exec native code (dependency builds): runBaseChecks and captureOpenapiBase run
// only at HEAD = base_sha on a clean tree; runDepsSetup only on a clean tree whose package.json non-dependency fields
// (scripts included, every package.json) and .npmrc files equal base_sha or a blob Irfan allowed (t.work.scope), else
// refused "protected: …" before npm runs (verifier HIGH: root lifecycle scripts and a planted .npmrc would run there);
// over 1 MB (one) or 2 MB (all) they are refused unread (task.js tooBig).
// npm gets --registry (config gates.registry, default the public one) and --userconfig <empty file> on its argv.
// runBaseChecks (N3, at approve and at boot init): generate, typecheck, unit, lint, build (those the tag sets) at
// HEAD = base_sha under the setup profile, stop at the first red → {ok, checks: {check: {ok, ms}}, why?} + gates/NN.json
// (gate base). captureOpenapiBase: the tag's cmd at base_sha (setup profile), its file (lstat: no link; realpath inside
// the worktree; ≤ 5 MB) copied to tickets/<id>/openapi.base.json. runDepsSetup (RO2): step 1 under setupnet (443: SBPL
// can't filter by domain, only npm runs, never a script): `npm install --ignore-scripts --no-audit --no-fund -- <packages>`
// for the deps ask's `name@range` list (updates package.json + lockfile + node_modules; each spec checked first: an npm
// name, optionally scoped, @ a semver range: no space, no leading -, no URL / file: / git / dist-tag; ≤ 20), else
// `npm ci --ignore-scripts`; step 2 `npm rebuild <names>` (rebuildNames: installed registry packages with an install
// script, never the root's own scripts; none → no step 2; one off-registry install script → refused) under setup (no
// network) or, online (Irfan's per-ticket allow), setupnet; the offline step red → {ok:false, needs_online:true}. The
// caller takes the tripwire baseline again.
const fsp = require('node:fs/promises');
const path = require('node:path');
const R = require('./run');
const T = require('./task');
const rules = require('../plan-rules');
const store = require('../store');
const tagsLib = require('../tags');
const spawn = require('../spawn');
const { copyPlain, within } = require('../util');

const OPENAPI_JS = path.join(__dirname, 'openapi.js');
const PRISMA_JS = path.join(__dirname, 'prisma.js');
const SPEC_MAX = 5 * 1024 * 1024;
const PRISMA_MAX = 1 << 20;
const WORK_EXITS = [3, 5, 6]; // openapi.js: missing, a link / outside, not JSON or not OpenAPI 3
const PACKAGES_MAX = 20;
// an npm name (optionally @scope/): never a leading - (npm would read a flag); name@range adds a semver range (a digit
// in it, or * / x)
const NAME = String.raw`(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,100}`;
const NAME_RE = new RegExp(`^${NAME}$`);
const PACKAGE_RE = new RegExp(String.raw`^${NAME}@(?:[*xX]|[\^~<>=|]*\d[0-9A-Za-z.^~<>=|*+-]{0,63})$`);
const LOCK_MAX = 4 << 20; // node_modules/.package-lock.json parsed in tbd for the rebuild list (a big app's: ~0.3 MB); over → refused
const REGISTRY = 'https://registry.npmjs.org/';
const baseSpec = (t) => path.join(store.ticketDir(t.id), 'openapi.base.json');
const { red, list, heavyWhy } = T;

async function prismaCheck(ctx, st, o) {
  const p = ctx.gt.prisma;
  if (!p) return null;
  const mig = `${p.migrations.replace(/\/+$/, '')}/`;
  const dir = `${p.schema.replace(/\/+$/, '')}/`;
  const isMig = (f) => f.startsWith(mig);
  const isSchema = (f) => (p.schema.endsWith('.prisma') ? f === p.schema : f.startsWith(dir) && f.endsWith('.prisma') && !isMig(f));
  const side = async (sha) => String((await R.git(ctx, ['ls-tree', '-r', '-z', '-l', '--full-tree', sha, '--', p.schema, p.migrations])).stdout)
    .split('\0').filter(Boolean).map((l) => {
      const [mode, type, blob, size] = l.slice(0, l.indexOf('\t')).split(/\s+/);
      return { mode, type, blob, size: Number(size), path: l.slice(l.indexOf('\t') + 1) };
    }).filter((e) => e.type === 'blob' && (isSchema(e.path) || isMig(e.path)));
  const [b, h] = await Promise.all([side(ctx.t.base_sha), side(ctx.head)]);
  const atBase = new Set(b.map((e) => e.path));
  const reads = [b.filter((e) => !isMig(e.path)), h.filter((e) => !isMig(e.path) || !atBase.has(e.path))];
  const big = reads.map((x) => x.reduce((n, e) => n + e.size, 0)).find((n) => n > PRISMA_MAX);
  const lossy = [...b, ...h].find((e) => e.path.includes('\uFFFD')); // read lossily as UTF-8: two such paths can read as one
  let why = lossy ? `prisma: a path that is not UTF-8: ${JSON.stringify(lossy.path).slice(0, 100)}` : big ? `prisma: schema + new migrations are ${big} bytes, at most ${PRISMA_MAX}` : '';
  let cls = 'work';
  let d = null;
  if (!why) {
    const read = (e) => ({ blob: e.blob }); // the child reads the text; a plain sha is compared only
    const manifest = {
      base: R.keyed(b.map((e) => [e.path, isMig(e.path) ? e.blob : read(e)])),
      head: R.keyed(h.map((e) => [e.path, isMig(e.path) && atBase.has(e.path) ? e.blob : read(e)])),
      schema: p.schema, migrations: p.migrations,
    };
    const r = await R.child(ctx, PRISMA_JS, [], { cls: () => 'work', input: { manifest, shas: reads.flat().map((e) => e.blob) } });
    d = r.out ?? null;
    if (!d) [cls, why] = [r.cls, `schema scan failed: ${r.why}`];
    else if (!d.ok) why = d.why;
  }
  if (!d?.ok) {
    await R.logic(ctx, 'prisma', false, cls, why);
    return red(cls, why);
  }
  const m = rules.markAllowed(d.changes, rules.parseAllowed(o.plan?.allowed_schema_changes ?? [], 'schema').entries, d.added);
  st.schema = m.changes;
  st.migration = d.migration;
  st.unused_allowed.push(...m.unused);
  const not = m.changes.filter((c) => !c.allowed).map((c) => `${c.op} ${c.ref}`);
  if (d.migration.length) {
    const w = `prisma migrations: ${list(d.migration)}: an applied migration is never edited or deleted, and a schema change needs a new migration`;
    await R.logic(ctx, 'prisma', false, 'work', w);
    return red('work', w);
  }
  if (!not.length) return null;
  const w = `schema changes not in the plan's allowed_schema_changes: ${list(not)}`;
  await R.logic(ctx, 'prisma', false, 'policy', w);
  return red('policy', w);
}

// the diff child: its changes, or {cls, why}; the gate's abort ends it (interrupted)
async function apiDiff(ctx, base, head) {
  const r = await R.child(ctx, OPENAPI_JS, [base, head, ctx.wtReal], { heap: 128, cls: (code) => (code === null || WORK_EXITS.includes(code) ? 'work' : 'infra') }); // null: killed (heap OOM, 30 s) on an agent's spec
  if (Array.isArray(r.out?.changes)) return { changes: r.out.changes };
  return { cls: r.cls ?? 'infra', why: `openapi diff: ${r.why ?? 'no result line'}` };
}

async function openapiCheck(ctx, st, o) {
  const api = ctx.gt.openapi;
  if (!api) return null;
  const c = await R.run(ctx, { check: 'openapi', cmd: api.cmd });
  if (!c.ok) return red(c.class, heavyWhy(c));
  const d = await apiDiff(ctx, baseSpec(ctx.t), path.join(ctx.wt, api.file));
  if (!d.changes) {
    await R.logic(ctx, 'api', false, d.cls, d.why);
    return red(d.cls, d.why);
  }
  const m = rules.markAllowed(d.changes, rules.parseAllowed(o.plan?.allowed_api_changes ?? [], 'api').entries);
  st.api = m.changes;
  st.unused_allowed.push(...m.unused);
  const not = m.changes.filter((x) => !x.allowed).map((x) => `${x.op} ${x.ref}`);
  if (!not.length) return null;
  const w = `API changes not in the plan's allowed_api_changes: ${list(not)}`;
  await R.logic(ctx, 'api', false, 'policy', w);
  return red('policy', w);
}

// every plan task's files + modules: the scope of base..HEAD (allows and generated globs are added by scope())
const union = (plan) => ({ files: [...new Set((plan?.tasks ?? []).flatMap((x) => x.files ?? []))], modules: [...new Set((plan?.tasks ?? []).flatMap((x) => x.modules ?? []))] });
const WORKING = {
  integrity: (ctx, st, o) => T.integrity(ctx, o),
  plan: (ctx, st, o) => T.plan(ctx, o),
  history: (ctx) => T.history(ctx, ctx.pre),
  trailer: (ctx) => T.trailer(ctx, ctx.pre),
  protected: (ctx, st, o) => T.protectedCheck(ctx, st, o.allow ?? []),
  scope: (ctx, st, o) => T.scope(ctx, st, { ...o, task: union(o.plan) }),
  tests: (ctx, st) => T.testsCheck(ctx, st),
  generate: (ctx) => T.tagCheck(ctx, 'generate'),
  lint: (ctx) => T.tagCheck(ctx, 'lint'),
  typecheck: (ctx) => T.tagCheck(ctx, 'typecheck'),
  build: (ctx) => T.tagCheck(ctx, 'build'),
  unit: (ctx) => T.tagCheck(ctx, 'unit'),
  prisma: prismaCheck,
  openapi: openapiCheck,
};

/** contract Interface: runWorkingGate({t, wt, base, head, plan, tag, allow, baseChecks, integrity, save, onSpawn, signal}) */
async function runWorkingGate(o) {
  const cur = o.t.work?.task;
  const ctx = await R.open({ ...o, gate: 'working', pre: o.base, task: cur ? { id: cur } : null });
  const st = R.EMPTY();
  const names = R.GATES.code.working;
  try {
    return await T.guard(ctx, st, async () => {
      await T.cleanTree(ctx);
      const first = await T.firstRed(ctx, st, names.filter((n) => R.LOGIC.has(n)), WORKING, o);
      if (first) return first;
      const reds = [];
      for (const name of names.filter((n) => !R.LOGIC.has(n))) {
        if (ctx.signal.aborted) break;
        const r = await WORKING[name](ctx, st, o);
        if (r) reds.push(r);
      }
      const policy = [...st.schema, ...st.api].filter((c) => !c.allowed).map((c) => `${c.op} ${c.ref}`);
      const has = (c) => reds.some((r) => r.class === c);
      const cls = ctx.signal.aborted || has('interrupted') ? 'interrupted' : has('infra') ? 'infra' : policy.length ? 'policy' : reds.length ? 'work' : null;
      if (!cls) return R.finish(ctx, { ...st, ok: true });
      const why = reds.filter((r) => r.class !== 'policy').map((r) => r.why).join('\n\n') || reds.map((r) => r.why).join('\n\n');
      const ask = cls === 'policy' ? { kind: 'policy', changes: policy, reason: `changes the plan does not allow: ${list(policy)}. Allow each (tb answer --allow-change) or deny it (--deny-change)` } : null;
      return R.finish(ctx, { ...st, ok: false, class: cls, why: cls === 'policy' ? ask.reason : why, ask });
    });
  } finally {
    await R.close(ctx);
  }
}

const headOf = async (ctx) => (await R.git(ctx, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
// the tree a setup-profile run may start on → null, or why not (see the header)
async function vouch(ctx, { atBase }) {
  ctx.head = await headOf(ctx);
  if (atBase && ctx.head !== ctx.t.base_sha) return `HEAD ${ctx.head.slice(0, 12)} is not base_sha ${String(ctx.t.base_sha).slice(0, 12)}`;
  const env = ctx.tag.env_files ?? [];
  const dirty = (await spawn.dirtyPaths({ ...ctx.t, worktree: ctx.wt })).filter((l) => !env.includes(l.slice(3)));
  if (dirty.length) return `protected: the worktree has uncommitted changes: ${list(dirty.map((l) => l.slice(3)))}`;
  if (atBase) return null;
  const allow = Object.values(ctx.t.work?.scope ?? {}).flat();
  const files = (await R.diffRaw(ctx, ctx.t.base_sha, ctx.head)).filter((e) => ['package.json', '.npmrc'].includes(path.posix.basename(e.path).toLowerCase()) // APFS: .NPMRC is .npmrc
    && !allow.some((a) => a?.path === e.path && a.blob && a.blob === e.nsha));
  const big = await T.tooBig(ctx, files); // over 1 MB (one) or 2 MB (all): refused, never read
  if (big.length) return list(big);
  const pkgs = files.filter((e) => path.posix.basename(e.path).toLowerCase() === 'package.json'); // an .npmrc is refused unread
  const b = await R.blobs(ctx, pkgs.flatMap((e) => [e.osha, e.nsha]).filter((x) => x !== T.ZERO));
  const read = (sha) => T.json(sha === T.ZERO ? null : b.get(sha));
  const bad = files.filter((e) => path.posix.basename(e.path).toLowerCase() === '.npmrc' || [read(e.osha), read(e.nsha)].includes(undefined) || T.nonDeps(read(e.osha)) !== T.nonDeps(read(e.nsha)));
  return bad.length ? `protected: ${list(bad.map((e) => e.path))} changed since base (beyond dependencies) and not allowed` : null;
}
// config gates.registry (an http(s) URL), else the public registry
function registry() {
  const r = store.config.gates?.registry;
  try { return typeof r === 'string' && /^https?:$/.test(new URL(r).protocol) ? r : REGISTRY; } catch { return REGISTRY; }
}

// RO2 step 2's names (verifier HIGH): a plain `npm rebuild` also runs the ROOT package's lifecycle scripts, and a base
// script may run a file the agent wrote (postinstall: node post.js), in the setup profile. So only installed registry
// packages with an install script are rebuilt, by name: `npm rebuild <names>` (npm 11.6.2: a plain `npm rebuild` runs the
// root's scripts; `npm rebuild <names>` never did in our tests). The code passes no `--`; the name grammar keeps a
// leading - out. Read from node_modules/.package-lock.json
// (lstat: a plain file): step 1's npm just wrote it, so it lists exactly what is installed (package-lock.json may list
// packages this OS skipped). Every entry with hasInstallScript but the root "" (rebuild by name never runs it) must be a
// tarball under the registry npm was given (or the public one) + an integrity, else step 2 is REFUSED whole (verifier
// MED, fail closed): `npm rebuild a` rebuilds every installed `a`, so a registry copy on the list would also rebuild an
// off-registry copy of the same name (file:, git+, a link, another host: code the lockfile's author picked; step 1
// installs it, never runs it, and refuses none of them). Name = after the last node_modules/ (@scope/name kept),
// NAME_RE else refused; deduped. Then any off-registry entry, flagged or not, whose name is on the list → refused too
// (verifier LOW: whether npm rebuilds an unflagged copy is npm's business; never rely on it). → {names} | {why} (why
// starts "deps: ")
async function rebuildNames(wt) {
  const f = path.join(wt, 'node_modules', '.package-lock.json');
  const st = await fsp.lstat(f).catch(() => null);
  if (!st) return { names: [] }; // no dependency installed
  if (!st.isFile() || st.size > LOCK_MAX) return { why: `deps: ${f} is not a plain file ≤ ${LOCK_MAX} bytes` };
  let lock;
  try { lock = JSON.parse(await fsp.readFile(f, 'utf8')); } catch (e) { return { why: `deps: ${f}: ${e.message}` }; }
  const roots = [...new Set([registry(), REGISTRY].map((r) => new URL(r).href).map((r) => (r.endsWith('/') ? r : `${r}/`)))];
  const fromRegistry = (e) => typeof e?.resolved === 'string' && roots.some((r) => e.resolved.startsWith(r)) && typeof e.integrity === 'string' && !!e.integrity;
  const nameOf = (key) => (key.includes('node_modules/') ? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length) : null);
  const entries = Object.entries(lock?.packages ?? {}).filter(([key]) => key !== '');
  const names = new Set();
  for (const [key, e] of entries) {
    if (!e?.hasInstallScript) continue;
    if (!fromRegistry(e)) {
      return { why: `deps: ${JSON.stringify(key.slice(0, 200))} has an install script and is not from the registry (${String(e.resolved ?? 'no resolved').slice(0, 200)}): step 2 refused, nothing rebuilt` };
    }
    const name = nameOf(key);
    if (!name || !NAME_RE.test(name)) return { why: `deps: ${JSON.stringify(key.slice(0, 200))} in ${f} is not an npm package name` };
    names.add(name);
  }
  const twin = entries.find(([key, e]) => !fromRegistry(e) && names.has(nameOf(key) ?? ''));
  if (twin) return { why: `deps: ${JSON.stringify(twin[0].slice(0, 200))} shares the name ${nameOf(twin[0])} with a rebuilt package and is not from the registry: step 2 refused, nothing rebuilt` };
  return { names: [...names] };
}

/** contract Interface: runBaseChecks({t, wt, tag, save, onSpawn, signal}) → {ok, checks: {check: {ok, ms}}, why?} */
async function runBaseChecks(o) {
  const ctx = await R.open({ ...o, gate: 'base' });
  const st = R.EMPTY();
  const checks = {};
  try {
    const no = await vouch(ctx, { atBase: true });
    if (no) return { ok: false, checks, why: `base checks refused: ${no}` };
    const res = await T.guard(ctx, st, async () => {
      for (const name of R.GATES.code.base) {
        const cmd = ctx.gt.checks?.[name];
        if (typeof cmd !== 'string' || !cmd) continue;
        const c = await R.test(ctx, { check: name, cmd, mode: 'setup' });
        checks[name] = { ok: c.ok, ms: c.ms };
        if (!c.ok) return R.finish(ctx, { ...st, ok: false, class: c.class, why: heavyWhy(c) });
      }
      return R.finish(ctx, { ...st, ok: true });
    });
    return { ok: res.ok, checks, ...(!res.ok && { why: res.why }) };
  } catch (e) {
    return { ok: false, checks, why: `base checks failed: ${e.message}` };
  } finally {
    await R.close(ctx);
  }
}

/** contract Interface: captureOpenapiBase({t, wt, tag, onSpawn, signal}) → {ok: true} | {ok: false, why} */
async function captureOpenapiBase(o) {
  const api = tagsLib.gateTag(o.tag ?? {}).openapi;
  if (!api) return { ok: true };
  const ctx = await R.open({ ...o, gate: 'base' });
  try {
    const no = await vouch(ctx, { atBase: true });
    if (no) return { ok: false, why: `openapi base refused: ${no}` };
    const c = await R.run(ctx, { check: 'openapi', cmd: api.cmd, mode: 'setup' });
    if (!c.ok) return { ok: false, why: heavyWhy(c) };
    const src = path.join(o.wt, api.file);
    const real = await fsp.realpath(src).catch(() => null);
    if (!real) return { ok: false, why: `${api.file}: not there after ${api.cmd}` };
    if (!within(real, ctx.wtReal)) return { ok: false, why: `${api.file}: leads outside the worktree` };
    await copyPlain(src, baseSpec(o.t), 0o600, (st) => {
      if (st.size > SPEC_MAX) throw new Error(`${api.file}: ${st.size} bytes, at most ${SPEC_MAX}`);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `openapi base: ${e.message}` };
  } finally {
    await R.close(ctx);
  }
}

/**
 * contract Interface: runDepsSetup({t, wt, tag, packages, online, onSpawn, signal}) → {ok, why?, needs_online?} (RO2)
 * @param {{t: any, wt: string, tag: any, packages?: string[], online?: boolean, onSpawn?: (pid: number) => void, signal?: AbortSignal}} o
 * @returns {Promise<{ok: boolean, why?: string, needs_online?: boolean}>}
 */
async function runDepsSetup(o) {
  const packages = o.packages ?? [];
  const bad = !Array.isArray(packages) || packages.length > PACKAGES_MAX ? [`at most ${PACKAGES_MAX} packages, as a list`]
    : packages.filter((p) => typeof p !== 'string' || !PACKAGE_RE.test(p)).map((p) => JSON.stringify(String(p).slice(0, 100)));
  if (bad.length) return { ok: false, why: `packages: ${list(bad)}: each must be name@range (an npm name, @, a semver range; no spaces, URLs, paths or tags)` };
  const ctx = await R.open({ ...o, gate: 'base', quiet: true });
  // npm <cmd> --registry <r> --userconfig <empty> <rest>: the flags before any `--` (after it they would be package names)
  const step = (cmd, rest, mode) => R.run(ctx, { check: 'setup', argv: [R.NPM, cmd, '--registry', registry(), '--userconfig', ctx.npmrc, ...rest], mode, key: 'setup' });
  try {
    const no = await vouch(ctx, { atBase: false });
    if (no) return { ok: false, why: `deps setup refused: ${no}` };
    const cmd = packages.length ? 'install' : 'ci';
    const a = await step(cmd, packages.length ? ['--ignore-scripts', '--no-audit', '--no-fund', '--', ...packages] : ['--ignore-scripts'], 'setupnet');
    if (!a.ok) return { ok: false, why: R.cut(`npm ${cmd} --ignore-scripts: ${heavyWhy(a)}`) };
    const list = await rebuildNames(o.wt);
    if ('why' in list) return { ok: false, why: R.cut(list.why) };
    if (!list.names.length) return { ok: true }; // nothing to build: no step 2
    const b = await step('rebuild', list.names, o.online ? 'setupnet' : 'setup');
    if (b.ok) return { ok: true };
    return { ok: false, why: R.cut(`npm rebuild (${o.online ? 'online' : 'offline'}): ${heavyWhy(b)}`), ...(!o.online && b.class === 'work' && { needs_online: true }) };
  } catch (e) {
    return { ok: false, why: `deps setup failed: ${e.message}` };
  } finally {
    await R.close(ctx);
  }
}

module.exports = { runWorkingGate, runBaseChecks, captureOpenapiBase, runDepsSetup };
