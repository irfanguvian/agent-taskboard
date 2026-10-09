'use strict';
// doctor: the checks behind `tb doctor` (spec §9, plan AC7, D12, D30) plus the auth re-check timer.
// Subscription only: login must be claude.ai (never an API key or an env OAuth token), runs use a pinned claude copy,
// tag repos may not carry API-key settings. Async only (D31). Paths, env and the tbx binary are injectable for tests.
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, minimalEnv, GIT_SAFE, GIT_ENV, claudeEnv, DEFAULT_PIN } = require('./util');
const { NAME_RE } = require('./tags');

const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const AUTH_OK = ['claude.ai']; // oauth_token can't pass: claudeEnv never hands a run CLAUDE_CODE_OAUTH_TOKEN (S2)
const FABLE_BILLING = ['plan', 'credits_ok', 'credits_no'];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const BAD_ENV_RE = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/;
const D30_NODE = ['.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'node'];
const BODY_KEYS = ['tag', 'pin', 'version'];
const TAIL_BYTES = 4096; // of a check command's output kept in doctor.json (H3)
const TEAM_ID_RE = /^TeamIdentifier=([A-Z0-9]{10})$/m;
const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW'; // Developer ID Application: Anthropic PBC (verified on claude 2.1.292); expected until config says else (N8)

const bad = (msg) => new TbError(400, msg);
const pass = (name, detail, extra) => ({ name, ok: true, detail, ...extra });
const fail = (name, detail, fix) => ({ name, ok: false, detail, ...(fix && { fix }) });
const tail = (r) => String(r.stderr || r.stdout || r.err?.message || '').trim().split('\n').pop().slice(0, 200);

function parse(input) {
  const b = input ?? {};
  if (!isObj(b)) throw bad('body must be a JSON object');
  const unknown = Object.keys(b).find((k) => !BODY_KEYS.includes(k));
  if (unknown) throw bad(`unknown field "${unknown}"`);
  const { tag, pin, version } = b;
  if (tag !== undefined && (typeof tag !== 'string' || !NAME_RE.test(tag))) throw bad('tag must look like a or a/b');
  if (pin !== undefined && typeof pin !== 'boolean') throw bad('pin must be true or false');
  if (version !== undefined && (!pin || typeof version !== 'string' || !VERSION_RE.test(version))) throw bad('version must look like 2.1.292 and needs pin: true');
  return { tag, pin: Boolean(pin), version: version ?? DEFAULT_PIN };
}

// Runs a command with stdout + stderr in a temp file, not a pipe: a chatty check cannot hit maxBuffer and get killed (H3).
// Resolves { err, output }: err is null on exit 0, else { code: exit code | 'ENOENT', timedOut }; output = the last 4 KB.
async function logged(file, args, { cwd, env, timeout }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tb-doctor-'));
  try {
    const fh = await fsp.open(path.join(dir, 'out.log'), 'w+', 0o600);
    try {
      const err = await new Promise((resolve) => {
        const child = spawn(file, args, { cwd, env, stdio: ['ignore', fh.fd, fh.fd] });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
        child.once('error', (e) => { clearTimeout(timer); resolve({ code: /** @type {any} */ (e).code, timedOut }); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve(code === 0 ? null : { code: code ?? signal, timedOut }); });
      });
      const { size } = await fh.stat();
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      await fh.read(buf, 0, buf.length, size - buf.length);
      return { err, output: buf.toString('utf8') };
    } finally {
      await fh.close();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** @param {{store: any, env?: Record<string, string | undefined>, home?: string, tbHome?: string, tbx?: string, git?: string, codesign?: string, uid?: number, node?: {path: string, version: string}, underLaunchd?: () => boolean, checkTimeoutMs?: number, intervalMs?: number, now?: () => Date}} deps */
function createDoctor({
  store, env = process.env, home = os.homedir(), tbHome = env.TB_HOME || path.join(home, '.taskboard'),
  tbx = path.join(__dirname, '..', 'bin', 'tbx'), git = '/usr/bin/git', codesign = '/usr/bin/codesign', uid = process.getuid?.() ?? -1,
  node = { path: process.execPath, version: process.version },
  underLaunchd = () => process.ppid === 1, checkTimeoutMs = 600_000, intervalMs = 30 * 60_000, now = () => new Date(),
}) {
  const file = path.join(tbHome, 'doctor.json');
  let queue = Promise.resolve();
  let last = null; // last saved { at, ok, checks }
  let authWasOk = true; // a failing re-check notifies on the way down only, not every 30 min
  let notifier;
  let timer;
  let stopped = false;

  // The claude child gets the env runs get (util.claudeEnv): allowlist, no key or token, no self-update (spec §9).
  const childEnv = () => claudeEnv(env);

  // A tag's check commands run the repo's own code: no keys, no tokens, only what a shell needs (H8).
  const tagEnv = () => ({ ...minimalEnv(env), TBD_SOCK: env.TBD_SOCK || path.join(tbHome, 'tbd.sock') }); // TBD_SOCK: for tbx
  const gitEnv = () => ({ ...tagEnv(), ...GIT_ENV });

  async function auth() {
    const key = KEY_VARS.find((k) => env[k]);
    if (key) return fail('auth', `${key} is set in the tbd environment: runs would bill the API`, 'remove it from the plist / shell profile and restart tbd');
    const bin = store.config.claude_bin;
    const r = await sh(bin, ['auth', 'status'], { env: childEnv(), cwd: os.tmpdir(), timeout: 20_000 });
    let s;
    try {
      s = JSON.parse(r.stdout);
    } catch {
      return r.err?.code === 'ENOENT'
        ? fail('auth', `claude_bin missing: ${bin}`, 'tb doctor --pin')
        : fail('auth', `claude auth status gave no JSON: ${tail(r)}`, 'claude auth login');
    }
    if (s?.loggedIn === false) return fail('auth', 'not logged in', 'claude auth login (claude.ai account)');
    if (!AUTH_OK.includes(s?.authMethod)) return fail('auth', `authMethod ${s?.authMethod}: runs must use the claude.ai subscription`, 'claude auth logout, then claude auth login with your claude.ai account');
    return pass('auth', s.authMethod);
  }

  async function claudeBin() {
    const bin = store.config.claude_bin;
    const want = /^claude-(\d+\.\d+\.\d+)$/.exec(path.basename(bin))?.[1];
    if (!want) return fail('claude_bin', `${bin}: file name must be claude-<version> (a pinned copy)`, 'tb doctor --pin');
    const r = await fsp.access(bin, fsp.constants.X_OK).then(() => sh(bin, ['--version'], { env: childEnv(), cwd: os.tmpdir(), timeout: 20_000 }), () => null);
    if (!r) return fail('claude_bin', `${bin} is missing or not executable`, 'tb doctor --pin');
    const got = /^(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
    if (got !== want) return fail('claude_bin', `--version says ${got ?? tail(r)}, file name says ${want}`, 'tb doctor --pin');
    return pass('claude_bin', `${bin} ${want}`);
  }

  function fableBilling() {
    const v = store.config.fable_billing;
    return FABLE_BILLING.includes(v)
      ? pass('fable_billing', v)
      : fail('fable_billing', `"${v}" is not one of ${FABLE_BILLING.join(', ')}`, 'set fable_billing in config.json (plan = Fable draws on the subscription, D12)');
  }

  async function nodeCheck() {
    const want = path.join(home, ...D30_NODE);
    const exists = await fsp.access(want, fsp.constants.X_OK).then(() => true, () => false);
    const detail = `${node.path} ${node.version}`;
    if (!exists) return fail('node', `${detail}; D30 node ${want} is missing`, 'install node v24.13.0 with nvm');
    if (underLaunchd() && node.path !== want) return fail('node', `${detail}; the plist must run ${want} (D30)`, 'scripts/install-launchd, then restart tbd');
    return pass('node', detail);
  }

  // Repo settings that would move runs off the subscription (spec §9) or run code at start (hooks: warn).
  async function settingsCheck(name, dir) {
    const refuse = [];
    const warn = [];
    for (const f of ['settings.json', 'settings.local.json']) {
      let s;
      try {
        s = JSON.parse(await fsp.readFile(path.join(dir, '.claude', f), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') refuse.push(`${f}: ${e.message}`);
        continue;
      }
      if (!isObj(s)) continue;
      if (s.apiKeyHelper) refuse.push(`${f} sets apiKeyHelper`);
      for (const k of isObj(s.env) ? Object.keys(s.env) : []) if (BAD_ENV_RE.test(k)) refuse.push(`${f} sets env ${k}`);
      if (isObj(s.hooks) && Object.keys(s.hooks).length) warn.push(`${f} has hooks`);
    }
    const id = `tag:${name}:settings`;
    if (refuse.length) return fail(id, refuse.join('; '), 'remove them from the repo .claude settings: runs must use the subscription');
    return pass(id, warn.join('; ') || 'no apiKeyHelper, no API env, no hooks', warn.length ? { warn: true } : undefined);
  }

  async function tagChecks(name) {
    const id = `tag:${name}`;
    const tags = store.listTags();
    const def = Object.hasOwn(tags, name) ? tags[name] : null;
    if (!def) return [fail(id, `no tag ${name}`, 'tb tag list')];
    if (!def.path) return [fail(id, `tag ${name} has no path`, 'tb tag add with --type and --path')];
    if (!(await fsp.stat(def.path).then((s) => s.isDirectory(), () => false))) return [fail(id, `${def.path} is not a directory`, 'fix the tag path')];
    if (def.type === 'git') {
      const repo = await sh(git, [...GIT_SAFE, '-C', def.path, 'rev-parse', '--git-dir'], { env: gitEnv(), timeout: 20_000 });
      if (repo.err) return [fail(id, `${def.path} is not a git repo`, 'fix the tag path')];
      if (def.base.startsWith('-') || (await sh(git, [...GIT_SAFE, '-C', def.path, 'rev-parse', '--verify', '--quiet', `${def.base}^{commit}`], { env: gitEnv(), timeout: 20_000 })).err) {
        return [fail(id, `base branch ${def.base} not found in ${def.path}`, 'fix the tag base')];
      }
    }
    const out = [pass(id, def.type === 'git' ? `${def.path} (git, base ${def.base})` : def.path), await settingsCheck(name, def.path)];
    for (const [check, cmd] of Object.entries(def.checks ?? {})) {
      if (typeof cmd !== 'string') continue; // prisma_diff is a flag, not a command
      const { err, output } = await logged(tbx, ['heavy', '--', cmd], { cwd: def.path, env: tagEnv(), timeout: checkTimeoutMs });
      const n = `${id}:${check}`;
      const c = !err ? pass(n, cmd)
        : err.code === 'ENOENT' ? fail(n, `${tbx} not found`, 'deploy a tbd that ships bin/tbx')
          : fail(n, err.timedOut ? `${cmd}: timed out after ${checkTimeoutMs / 60_000} min` : `${cmd}: exit ${err.code}: ${tail({ stdout: output })}`);
      out.push(output ? { ...c, output } : c);
    }
    return out;
  }

  // Copies src to tmp (0755) if src is a plain file of ours that nobody else can write; O_NOFOLLOW and the inode check
  // close the gap between the lstat and the open (H7).
  async function copyPlain(src, tmp) {
    const st = await fsp.lstat(src);
    if (!st.isFile()) throw new Error(`${src} is not a plain file (symlinks are refused)`);
    if (st.uid !== uid) throw new Error(`${src} is not owned by uid ${uid}`);
    if (st.mode & 0o022) throw new Error(`${src} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    const from = await fsp.open(src, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
    try {
      const opened = await from.stat();
      if (opened.ino !== st.ino || opened.dev !== st.dev) throw new Error(`${src} changed while it was being pinned`);
      await fsp.rm(tmp, { force: true });
      const to = await fsp.open(tmp, 'wx', 0o755); // wx: never writes through a planted file or link
      try {
        const buf = Buffer.allocUnsafe(1 << 20);
        for (let n = 1; n > 0;) {
          n = (await from.read(buf, 0, buf.length, null)).bytesRead;
          if (n) await to.writeFile(buf.subarray(0, n));
        }
        await to.chmod(0o755);
      } finally {
        await to.close();
      }
    } finally {
      await from.close();
    }
  }

  // Real copy (not a link) so the interactive claude updating itself cannot change the pipeline (spec §9). The copy must
  // pass codesign and carry config.claude_team_id (default Anthropic's, recorded by the first pin) before it is ever run (H7, N8).
  async function pin(version) {
    const src = path.join(home, '.local', 'share', 'claude', 'versions', version);
    const dest = path.join(tbHome, 'bin', `claude-${version}`);
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await copyPlain(src, tmp);
      const sig = await sh(codesign, ['--verify', '--strict', tmp], { timeout: 120_000 });
      if (sig.err) throw new Error(`codesign rejects the copy: ${tail(sig)}`);
      const team = TEAM_ID_RE.exec((await sh(codesign, ['-dv', tmp], { timeout: 60_000 })).stderr)?.[1];
      if (!team) throw new Error('the copy has no Team ID (unsigned or ad-hoc signed)');
      const known = store.config.claude_team_id;
      const want = known || ANTHROPIC_TEAM_ID;
      if (team !== want) throw new Error(`Team ID ${team} is not the expected ${want}; if the signer really changed, edit claude_team_id in config.json`);
      const r = await sh(tmp, ['--version'], { env: childEnv(), cwd: os.tmpdir(), timeout: 20_000 });
      if (!r.stdout.startsWith(version)) throw new Error(`the copy says "${tail(r)}", expected ${version}`);
      await fsp.rename(tmp, dest);
      await store.updateConfig({ claude_bin: dest, ...(!known && { claude_team_id: team }) });
      return pass('pin', `${src} copied to ${dest} (Team ID ${team})`);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      return fail('pin', e.code === 'ENOENT' ? `${src} not found` : e.message, 'ls ~/.local/share/claude/versions');
    }
  }

  // One writer at a time: store.writeAtomic names its tmp file after the pid.
  function save(checks) {
    const rec = { at: now().toISOString(), ok: checks.every((c) => c.ok), checks };
    last = rec;
    const text = JSON.stringify(rec, null, 2) + '\n';
    queue = queue.catch(() => {}).then(() => store.writeAtomic(file, text));
    return queue.then(() => rec); // this call's own record: a concurrent run may have moved `last` (H5)
  }

  async function run(input) {
    const { tag, pin: doPin, version } = parse(input);
    const checks = doPin ? [await pin(version)] : [];
    checks.push(...(await Promise.all([auth(), claudeBin(), fableBilling(), nodeCheck()])));
    authWasOk = checks.find((c) => c.name === 'auth').ok;
    if (tag) checks.push(...(await tagChecks(tag)));
    const { ok } = await save(checks);
    return { checks, ok };
  }

  // Timer + wake: only the login can rot while tbd runs, so only it is re-checked.
  async function recheck() {
    if (stopped) return;
    const a = await auth();
    if (!a.ok && authWasOk) notifier?.alert({ title: 'Taskboard', message: 'Claude login problem: run tb doctor' });
    authWasOk = a.ok;
    const rest = last?.checks ?? [];
    await save(rest.some((c) => c.name === 'auth') ? rest.map((c) => (c.name === 'auth' ? a : c)) : [a, ...rest]);
  }

  /** @param {{notifier?: any, monitor?: any}} deps */
  function start(deps) {
    notifier = deps.notifier;
    const tick = () => recheck().catch((e) => console.error(`tbd: doctor re-check failed: ${e.message}`));
    timer = setInterval(tick, intervalMs);
    timer.unref();
    deps.monitor?.on('wake', tick);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return { run, start, stop, recheck };
}

// The daemon's instance; tests build their own with createDoctor.
const daemon = createDoctor({ store: require('./store') });

module.exports = { createDoctor, run: daemon.run, start: daemon.start };
