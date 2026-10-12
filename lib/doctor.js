'use strict';
// doctor: the checks behind `tb doctor` (spec §9, plan AC7, D12, D30) plus the auth re-check timer.
// Subscription only: login must be claude.ai (never an API key or an env OAuth token), runs use a pinned claude copy,
// tag repos may not carry API-key settings. Async only (D31). Paths, env and the tbx binary are injectable for tests.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, minimalEnv, GIT_SAFE, GIT_ENV, claudeEnv, DEFAULT_PIN, copyPlain } = require('./util');
const { NAME_RE, checkRules, checkTimeoutMs: timeoutOf } = require('./tags');

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

const HEAD_BYTES = 1024; // P5 gates: the prompt gets head 1 KB + tail 3 KB of a check's output
const KEEP_RAW = (1 << 20) - (64 << 10); // raw bytes gzipped into a kept log: ≤ 1 MB compressed even when incompressible
const PIPE_GRACE_MS = 2000;
const LINE_MAX = 64 * 1024; // a stream's unfinished line held back at most // after the exit: a leftover holding the pipes is not waited for longer
const firstBytes = (s, n) => Buffer.from(s).subarray(0, n).toString('utf8');
const lastBytes = (s, n) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(-n).toString('utf8'));

// The output of one command: head (1 KB) + tail (4 KB) in memory, optionally gzipped to keep.file (≤ 1 MB: the first
// ~960 KB, then a cut note + the last 3 KB). Each stream goes out in whole lines (the text after its last newline
// waits, ≤ 64 KB), so stdout and stderr never splice mid-line (a summary line stays parseable). redact: env_files
// values, replaced in head, tail and log alike (a value has no newline; a line over 64 KB keeps its last
// (longest secret - 1) chars back, so a secret split across two chunks is still found).
function outputSink(keep, redact) {
  const secrets = [...new Set(redact.filter((s) => typeof s === 'string' && s.length >= 4))];
  const hold = secrets.length ? Math.max(...secrets.map((s) => s.length)) - 1 : 0;
  const streams = new Map(); // fd → {dec, carry}
  let head = '';
  let tail = '';
  let bytes = 0;
  let fed = 0;
  let cut = 0;
  const gz = keep ? zlib.createGzip() : null;
  const tmp = keep ? `${keep.file}.${process.pid}.tmp` : '';
  const done = keep ? fsp.rm(tmp, { force: true }).then(() => new Promise((/** @type {(v?: any) => void} */ resolve, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    out.once('error', reject).once('finish', () => resolve());
    /** @type {zlib.Gzip} */ (gz).pipe(out);
  })) : Promise.resolve();
  done.catch(() => {}); // awaited in end()
  // RAM: a flood of output is many 64 KB chunks; only their ends are copied (the last TAIL_BYTES chars hold at least the
  // last TAIL_BYTES bytes), and a chunk that fits the kept log goes to gzip as is
  const emit = (s) => {
    if (!s) return;
    const n = Buffer.byteLength(s);
    if (bytes < HEAD_BYTES) head += firstBytes(s, HEAD_BYTES - bytes);
    bytes += n;
    tail = lastBytes(tail + s.slice(-TAIL_BYTES), TAIL_BYTES);
    if (!gz) return;
    const room = KEEP_RAW - fed;
    const take = room <= 0 ? '' : n <= room ? s : firstBytes(s, room);
    const t = take === s ? n : Buffer.byteLength(take);
    fed += t;
    cut += n - t;
    if (take) gz.write(take);
  };
  const scrub = (s) => secrets.reduce((x, sec) => x.split(sec).join('[redacted]'), s);
  return {
    write(fd, buf) {
      const st = streams.get(fd) ?? streams.set(fd, { dec: new StringDecoder('utf8'), carry: '' }).get(fd);
      const s = scrub(st.carry + st.dec.write(buf));
      let at = s.lastIndexOf('\n') + 1; // whole lines out; a line over LINE_MAX goes out but for its last `hold` chars
      if (s.length - at > LINE_MAX) at = s.length - hold;
      st.carry = s.slice(at);
      emit(s.slice(0, at));
    },
    async end() {
      for (const st of streams.values()) emit(scrub(st.carry + st.dec.end()));
      streams.clear();
      if (gz) {
        if (cut) gz.write(`\n[tbd: ${cut} bytes cut here; the last 3 KB follow]\n${lastBytes(tail, TAIL_BYTES - HEAD_BYTES)}`);
        gz.end();
        await done;
        await fsp.rename(tmp, keep.file);
      }
      return { head, tail, bytes };
    },
    abandon: () => { gz?.destroy(); return done.catch(() => {}).then(() => fsp.rm(tmp, { force: true })); },
  };
}

// Runs a command with stdout + stderr on pipes, read as they come: a chatty check cannot hit maxBuffer and get killed
// (H3), and a sandboxed node never inherits a file fd it may not fstat (P5 spike: rc 134). Resolves { err, output, head,
// bytes }: err is null on exit 0, else { code: exit code | signal | 'ENOENT', timedOut }; output = the last 4 KB, head =
// the first 1 KB. detached: the child leads its own process group; onSpawn(pid) once it runs; onOut(chunk): its stdout
// as it comes; onExit(): the child exited (gates kill what it left in its group there); the pipes then get
// PIPE_GRACE_MS to close (a leftover holding them is not waited for). keep {file}: the whole output gzipped there
// (≤ 1 MB, atomic). redact: strings replaced by [redacted] everywhere.
/** @param {string} file @param {string[]} args @param {{cwd: string, env: Record<string, string | undefined>, timeout: number, detached?: boolean, onSpawn?: (pid: number) => void, onOut?: (b: Buffer) => void, onExit?: () => void, keep?: {file: string} | null, redact?: string[]}} o */
async function logged(file, args, { cwd, env, timeout, detached = false, onSpawn = (_pid) => {}, onOut, onExit, keep = null, redact = [] }) {
  const sink = outputSink(keep, redact);
  try {
    const err = await new Promise((resolve) => {
      const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached });
      child.once('spawn', () => onSpawn(/** @type {number} */ (child.pid)));
      child.stdout.on('data', (b) => { onOut?.(b); sink.write(1, b); });
      child.stderr.on('data', (b) => sink.write(2, b));
      let timedOut = false;
      let grace;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
      child.once('exit', () => {
        clearTimeout(timer);
        onExit?.();
        grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, PIPE_GRACE_MS);
      });
      child.once('error', (e) => { clearTimeout(timer); resolve({ code: /** @type {any} */ (e).code, timedOut }); });
      child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(grace); resolve(code === 0 ? null : { code: code ?? signal, timedOut }); });
    });
    const { head, tail, bytes } = await sink.end();
    return { err, output: tail, head, bytes };
  } catch (e) {
    await sink.abandon();
    throw e;
  }
}

/** @param {{store: any, env?: Record<string, string | undefined>, home?: string, tbHome?: string, tbx?: string, git?: string, codesign?: string, uid?: number, node?: {path: string, version: string}, underLaunchd?: () => boolean, checkTimeoutMs?: number, intervalMs?: number, now?: () => Date}} deps */
function createDoctor({
  store, env = process.env, home = os.homedir(), tbHome = env.TB_HOME || path.join(home, '.taskboard'),
  tbx = path.join(__dirname, '..', 'bin', 'tbx'), git = '/usr/bin/git', codesign = '/usr/bin/codesign', uid = process.getuid?.() ?? -1,
  node = { path: process.execPath, version: process.version },
  underLaunchd = () => process.ppid === 1, checkTimeoutMs = undefined, intervalMs = 30 * 60_000, now = () => new Date(),
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
  // PATH: tbd's pinned node first, like the gates (D30). The launchd PATH may list another node first (homebrew);
  // its npm links outside its node dir, so a gate run under it can't exec npm.
  const tagEnv = () => ({
    ...minimalEnv(env), PATH: `${path.dirname(node.path)}:${env.PATH ?? '/usr/bin:/bin'}`,
    // TBD_SOCK: for tbx
    TBD_SOCK: env.TBD_SOCK || path.join(tbHome, 'tbd.sock'),
  });
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

  // The static part (path dir, git repo, base ref, .claude settings): what `tb assign` needs (P4 U2); no check command.
  async function tagStatic(name) {
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
    return [pass(id, def.type === 'git' ? `${def.path} (git, base ${def.base})` : def.path), await settingsCheck(name, def.path)];
  }

  async function tagChecks(name) {
    const out = await tagStatic(name);
    if (!out[0].ok) return out;
    const id = `tag:${name}`;
    const def = store.listTags()[name];
    if (def.rules?.length) { // P5 T1: still plain files, ≤ 8 KB in all (they may have changed since tag add)
      out.push(await checkRules(def.rules).then(() => pass(`${id}:rules`, `${def.rules.length} file(s)`), (e) => fail(`${id}:rules`, e.message, 'fix the files, or tb tag add without them')));
    }
    for (const [check, cmd] of Object.entries(def.checks ?? {})) {
      if (typeof cmd !== 'string') continue; // prisma_diff is a flag, not a command
      const ms = checkTimeoutMs ?? timeoutOf(check, def, store.config); // the gates' own timeout (tests may pin one)
      const { err, output } = await logged(tbx, ['heavy', '--', cmd], { cwd: def.path, env: tagEnv(), timeout: ms });
      const n = `${id}:${check}`;
      const c = !err ? pass(n, cmd)
        : err.code === 'ENOENT' ? fail(n, `${tbx} not found`, 'deploy a tbd that ships bin/tbx')
          : fail(n, err.timedOut ? `${cmd}: timed out after ${ms / 60_000} min` : `${cmd}: exit ${err.code}: ${tail({ stdout: output })}`);
      out.push(output ? { ...c, output } : c);
    }
    return out;
  }

  // P4b approve (U9): the tag's setup command in a ticket's worktree, in the heavy slot (tbx heavy: tbd's own child,
  // outside every run), the env of the tag checks. L14: their timeout counts from when the slot is held (tbx --timeout,
  // exit 124 = timed out); the wait for the slot is capped at one max hold on top (slots revoke a holder past it).
  // ponytail: a queue of several long holders can still hit that cap; then it fails "timed out" and approve again works.
  // detached: tbx leads its own group, so a tbd that dies meanwhile (launchd ends its group) leaves it running for the
  // next tbd's lostSetups to end; onSpawn(pid) lets planning save it. → {err, output: the last 4 KB}
  const holdMs = () => {
    const hold = store.config.slots?.max_hold_min;
    return (Number.isFinite(hold) && hold > 0 ? hold : 60) * 60_000;
  };
  async function setup(/** @type {string} */ cwd, /** @type {string} */ cmd, onSpawn = (/** @type {number} */ _pid) => {}) {
    const ms = checkTimeoutMs ?? timeoutOf('setup', {}, store.config); // the gates' setup timeout (15 min unless config says)
    const r = await logged(tbx, ['heavy', '--timeout', String(ms / 1000), '--', cmd], { cwd, env: tagEnv(), timeout: ms + holdMs(), detached: true, onSpawn });
    return r.err?.code === 124 ? { ...r, err: { ...r.err, timedOut: true } } : r;
  }

  // P5 gates (contract K5 K12, Rules output): argv (never a shell of ours) in the heavy slot, inside the gate sandbox:
  // `tbx heavy --timeout S --timer-flag F -- /usr/bin/sandbox-exec -f <profile> -- /bin/sh -c WRAP tbgate argv...`.
  // WRAP runs first, before any agent code: it prints `tbgate <its pid>` (= the command's process group: tbx starts it
  // detached, sandbox-exec and sh exec in place) as stdout's first line, drops tbx's own vars, then execs argv. So
  // the first stdout line is tbd's, never the agent's: it gives the group to kill at the end and when the slot was
  // held (slot_wait_ms; ms counts from there). env: exactly the gate env (+ TBD_SOCK for tbx only). timeoutMs: the
  // check's, counted by tbx once the slot is held; timerFlag: the file tbx creates when it fires (timedOut is read from
  // it, never from exit 124). The wait for the slot is capped at one max hold on top (then the tbx is ended: ran false).
  // signal (AbortSignal): abort → TERM to tbx (it forwards) and the group, KILL 2 s later. At the end the group is
  // SIGKILLed whatever it left (ponytail: by pgid right after its leader exited; its id can't be reused while a member
  // lives). → {exit, signal, spawnErr, ran, timedOut, group, slotWaitMs, ms, head, tail (≤ 4 KB: head 1 KB + tail 3 KB),
  // bytes}. spawnErr: tbx or argv[0] missing ({code: 'ENOENT'}), or the command never ran ({code: 'NOTRUN'}: slot,
  // tbd or sandbox-exec failed before WRAP printed).
  const WRAP = 'printf "tbgate %s\\n" "$$"; unset TBX_LEASE TBD_SOCK; exec "$@"';
  /** @param {string} cwd @param {string[]} argv @param {{timeoutMs: number, onSpawn?: (pid: number) => void, env: Record<string, string>, sandbox?: string | null, signal?: AbortSignal, keep?: {file: string} | null, redact?: string[], timerFlag?: string | null, onGroup?: (pgid: number) => void}} o */
  async function heavy(cwd, argv, { timeoutMs, onSpawn = () => {}, env, sandbox = null, signal = undefined, keep = null, redact = [], timerFlag = null, onGroup = () => {} }) {
    const t0 = Date.now();
    const none = { exit: null, signal: null, ran: false, timedOut: false, group: null, slotWaitMs: 0, ms: 0, head: '', tail: '', bytes: 0 };
    if (path.isAbsolute(argv[0] ?? '') && !(await fsp.access(argv[0], fsp.constants.X_OK).then(() => true, () => false))) {
      return { ...none, spawnErr: { code: 'ENOENT' }, tail: `${argv[0]}: not found` };
    }
    if (timerFlag) await fsp.rm(timerFlag, { force: true });
    const inner = ['/bin/sh', '-c', WRAP, 'tbgate', ...argv];
    const args = ['heavy', '--timeout', String(timeoutMs / 1000), ...(timerFlag ? ['--timer-flag', timerFlag] : []), '--',
      ...(sandbox ? ['/usr/bin/sandbox-exec', '-f', sandbox, '--'] : []), ...inner];
    let pid = 0;
    let group = 0;
    let heldAt = 0;
    let first = '';
    let hard;
    const kill = (sig) => {
      for (const g of [pid, group]) if (g > 1) try { process.kill(-g, sig); } catch { /* gone */ }
    };
    const onAbort = () => {
      kill('SIGTERM');
      clearTimeout(hard);
      hard = setTimeout(() => kill('SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) return { ...none, tail: 'not started: the gate was aborted' };
      const r = await logged(tbx, args, {
        cwd, env: { ...env, TBD_SOCK: tagEnv().TBD_SOCK }, timeout: timeoutMs + holdMs() + 10_000, detached: true, keep, redact,
        onSpawn: (p) => {
          pid = p;
          onSpawn(p);
          if (signal?.aborted) onAbort(); // aborted between the check above and the spawn
        },
        onOut: (b) => {
          if (heldAt || first.length > 64) return;
          first += b.toString('latin1');
          const m = /^tbgate (\d+)\n/.exec(first);
          if (m) {
            heldAt = Date.now();
            group = Number(m[1]);
            onGroup(group);
          }
        },
        onExit: () => { if (group > 1) try { process.kill(-group, 'SIGKILL'); } catch { /* none left */ } },
      });
      const timedOut = timerFlag ? await fsp.access(timerFlag).then(() => true, () => false) : false;
      const strip = (s) => s.replace(/^tbgate \d+\n/, '');
      const head = strip(r.head);
      const text = r.bytes <= TAIL_BYTES ? strip(r.output) : `${head}\n[…]\n${lastBytes(r.output, TAIL_BYTES - HEAD_BYTES - 8)}`;
      const end = Date.now();
      const sig = typeof r.err?.code === 'string' && r.err.code.startsWith('SIG');
      const spawnErr = r.err && typeof r.err.code === 'string' && !sig ? { code: r.err.code } : !heldAt && r.err ? { code: 'NOTRUN' } : null;
      return {
        exit: typeof r.err?.code === 'number' ? r.err.code : r.err ? null : 0, signal: sig ? r.err.code : null,
        spawnErr, ran: !!heldAt, timedOut, group: group || null, slotWaitMs: (heldAt || end) - t0, ms: heldAt ? end - heldAt : 0, head, tail: text, bytes: r.bytes,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(hard);
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
      await copyPlain(src, tmp, 0o755, (st) => { // a plain file of ours that nobody else can write (H7)
        if (st.uid !== uid) throw new Error(`${src} is not owned by uid ${uid}`);
        if (st.mode & 0o022) throw new Error(`${src} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
      });
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

  return { run, start, stop, recheck, tagStatic, settingsCheck, setup, heavy };
}

// The daemon's instance; tests build their own with createDoctor.
const daemon = createDoctor({ store: require('./store') });

module.exports = { createDoctor, run: daemon.run, start: daemon.start, tagStatic: daemon.tagStatic, settingsCheck: daemon.settingsCheck, setup: daemon.setup, heavy: daemon.heavy };
