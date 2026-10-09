'use strict';
// P2 AC7: tb doctor (lib/doctor.js). Unit tests drive createDoctor against a fake claude (a tiny script printing canned
// `auth status` JSON / `--version`), a fake HOME with a fake versions dir, temp git repos and a fake tbx. The e2e
// block runs the real tbd + tb on a temp HOME + TB_HOME (harness). Never the real ~/.taskboard, ~/.local or claude.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDoctor } = require('../lib/doctor');
const { GIT_SAFE, claudeEnv } = require('../lib/util');
const realStore = require('../lib/store');
const { startTbd, runTb } = require('./helpers/tbd');

const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const is400 = (e) => e?.status === 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const AUTH = {
  ok: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' },
  oauth: { loggedIn: true, authMethod: 'oauth_token' },
  apiKey: { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
  out: { loggedIn: false },
};

// Fake claude: --version prints the version its file name carries (or `lie`); `auth status` cats a canned file.
/** @param {string} file @param {{authFile?: string, lie?: string}} [opts] */
function fakeClaude(file, { authFile, lie } = {}) {
  const v = lie ?? /claude-(.+)$|^(\d+\.\d+\.\d+)$/.exec(path.basename(file)).slice(1).find(Boolean);
  const body = `#!/bin/sh
case "$1" in
  --version) echo "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" >> "${file}.sawkey"; echo "${v} (Claude Code)" ;;
  auth) echo "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" >> "${file}.sawkey"; ${authFile ? `cat "${authFile}"` : 'echo "{}"'} ;;
esac
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

// Fake codesign: `--verify --strict <f>` exits with the code in <file>.verify, `-dv <f>` prints Identifier / TeamIdentifier
// on stderr like the real one (Team ID from <file>.team). Every call is logged to <file>.calls.
function fakeCodesign(file) {
  const put = (k, v) => fs.writeFileSync(`${file}.${k}`, String(v));
  fs.writeFileSync(file, `#!/bin/sh
echo "$*" >> "${file}.calls"
case "$1" in
  --verify) code=$(cat "${file}.verify"); [ "$code" = 0 ] || echo "$3: invalid signature" >&2; exit "$code" ;;
  -dv) echo "Identifier=com.example.claude" >&2; echo "TeamIdentifier=$(cat "${file}.team")" >&2 ;;
esac
`, { mode: 0o755 });
  put('verify', 0);
  put('team', 'Q6L2SF6YDW'); // Anthropic's: the expected Team ID when config has none (N8)
  return {
    path: file,
    verify: (code) => put('verify', code),
    team: (id) => put('team', id),
    calls: () => (fs.existsSync(`${file}.calls`) ? fs.readFileSync(`${file}.calls`, 'utf8').split('\n').filter(Boolean) : []),
  };
}

// Fake store: the pieces doctor reads, plus the real writeAtomic so doctor.json gets its real mode.
function fakeStore(claudeBin, tags = {}) {
  const s = {
    config: { claude_bin: claudeBin, fable_billing: 'plan' },
    tags,
    listTags: () => s.tags,
    updates: [],
    async updateConfig(patch) { s.updates.push(patch); Object.assign(s.config, patch); },
    writeAtomic: realStore.writeAtomic,
  };
  return s;
}

// Temp world: fake HOME (with the D30 node and a fake claude 2.1.295 in the versions dir), TB_HOME, auth file, store.
function world(auth = AUTH.ok) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const tbHome = path.join(root, 'tbhome');
  const authFile = path.join(root, 'auth.json');
  const bin = path.join(tbHome, 'bin', 'claude-2.1.295');
  const node = path.join(home, '.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  fakeClaude(path.join(home, '.local', 'share', 'claude', 'versions', '2.1.295'), { authFile });
  fakeClaude(bin, { authFile });
  fs.writeFileSync(authFile, JSON.stringify(auth));
  const codesign = fakeCodesign(path.join(root, 'codesign'));
  const w = {
    root, home, tbHome, authFile, bin, node, codesign,
    versions: path.join(home, '.local', 'share', 'claude', 'versions'),
    setAuth: (a) => fs.writeFileSync(authFile, JSON.stringify(a)),
    store: fakeStore(bin),
    make: (extra = {}) => createDoctor({ store: w.store, env: { PATH: process.env.PATH }, home, tbHome, codesign: codesign.path, ...extra }),
    check: (res, name) => res.checks.find((c) => c.name === name),
  };
  return w;
}

describe('auth', () => {
  test('claude.ai passes; oauth_token (S2: runs never get the token), apiKey, logged out, missing binary and an API key in the env fail', async () => {
    const w = world();
    const d = w.make();
    assert.deepEqual(w.check(await d.run({}), 'auth'), { name: 'auth', ok: true, detail: 'claude.ai' });
    w.setAuth(AUTH.oauth);
    assert.match(w.check(await d.run({}), 'auth').detail, /authMethod oauth_token: runs must use the claude\.ai subscription/);
    w.setAuth(AUTH.apiKey);
    const bad = w.check(await d.run({}), 'auth');
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /authMethod apiKey: runs must use the claude\.ai subscription/);
    assert.ok(bad.fix);
    w.setAuth(AUTH.out);
    assert.match(w.check(await d.run({}), 'auth').detail, /not logged in/);
    fs.rmSync(w.bin);
    assert.match(w.check(await d.run({}), 'auth').detail, /claude_bin missing/);
  });

  test('an API key or auth token in the tbd env fails before `auth status` runs, and never reaches a claude child', async () => {
    const w = world();
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      const res = await w.make({ env: { PATH: process.env.PATH, [key]: 'not-a-real-key' } }).run({});
      assert.equal(res.ok, false);
      assert.match(w.check(res, 'auth').detail, new RegExp(`${key} is set in the tbd environment`));
    }
    // the claude_bin check still ran `--version` (once per loop pass): with the key stripped from its env
    assert.deepEqual(fs.readFileSync(`${w.bin}.sawkey`, 'utf8').split('\n').slice(0, -1), ['', '']);
  });

  test('the `auth status` child gets the env runs get (util.claudeEnv): allowlist only (S3), OAuth token dropped (S2)', async () => {
    const w = world();
    const dump = `${w.bin}.env`;
    fs.writeFileSync(w.bin, `#!/bin/sh\n[ "$1" = auth ] && env > "${dump}"\n[ "$1" = auth ] && cat "${w.authFile}" || echo "2.1.295 (Claude Code)"\n`, { mode: 0o755 });
    const kept = { PATH: process.env.PATH, HOME: w.home, LANG: 'en_US.UTF-8', USER: 'irfan', TERM: 'xterm' };
    const env = { ...kept, CLAUDE_CODE_OAUTH_TOKEN: 'tok-test', NODE_OPTIONS: '--require /x.js', TB_HOME: w.tbHome, AWS_SECRET_ACCESS_KEY: 'aws', OPENAI_API_KEY: 'o', SOME_VAR: '1' };
    assert.equal(w.check(await w.make({ env }).run({}), 'auth').ok, true);
    const seen = Object.fromEntries(fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const k of ['PWD', 'SHLVL', '_', 'OLDPWD']) delete seen[k]; // set by sh itself
    assert.deepEqual(seen, { ...kept, DISABLE_AUTOUPDATER: '1' });
    assert.deepEqual(claudeEnv(env), seen);
  });
});

describe('claude_bin, fable_billing, node', () => {
  test('claude_bin: pinned name + matching --version passes; mismatch, unpinned name and missing file fail', async () => {
    const w = world();
    const d = w.make();
    assert.equal(w.check(await d.run({}), 'claude_bin').detail, `${w.bin} 2.1.295`);
    fakeClaude(w.bin, { authFile: w.authFile, lie: '2.1.999' });
    assert.match(w.check(await d.run({}), 'claude_bin').detail, /--version says 2\.1\.999, file name says 2\.1\.295/);
    const plain = path.join(w.tbHome, 'bin', 'claude');
    fakeClaude(plain, { authFile: w.authFile, lie: '2.1.295' });
    w.store.config.claude_bin = plain;
    assert.match(w.check(await d.run({}), 'claude_bin').detail, /file name must be claude-<version>/);
    w.store.config.claude_bin = path.join(w.tbHome, 'bin', 'claude-2.1.111');
    assert.match(w.check(await d.run({}), 'claude_bin').detail, /missing or not executable/);
    fs.writeFileSync(w.store.config.claude_bin, '#!/bin/sh\n', { mode: 0o644 });
    assert.match(w.check(await d.run({}), 'claude_bin').detail, /missing or not executable/, 'not executable');
  });

  test('fable_billing: plan / credits_ok / credits_no are reported, anything else fails', async () => {
    const w = world();
    const d = w.make();
    for (const v of ['plan', 'credits_ok', 'credits_no']) {
      w.store.config.fable_billing = v;
      assert.deepEqual(w.check(await d.run({}), 'fable_billing'), { name: 'fable_billing', ok: true, detail: v });
    }
    w.store.config.fable_billing = 'free';
    assert.equal(w.check(await d.run({}), 'fable_billing').ok, false);
  });

  test('node: path + version reported; D30 node must exist, and under launchd it must be the one running', async () => {
    const w = world();
    const node = { path: '/some/node', version: 'v24.13.0' };
    assert.deepEqual(w.check(await w.make({ node }).run({}), 'node'), { name: 'node', ok: true, detail: '/some/node v24.13.0' });
    const launchd = w.make({ node, underLaunchd: () => true });
    const bad = w.check(await launchd.run({}), 'node');
    assert.equal(bad.ok, false);
    assert.match(bad.detail, new RegExp(`the plist must run ${w.node.replace(/\./g, '\\.')}`));
    assert.equal(w.check(await w.make({ node: { path: w.node, version: 'v24.13.0' }, underLaunchd: () => true }).run({}), 'node').ok, true);
    fs.rmSync(w.node);
    assert.match(w.check(await w.make({ node }).run({}), 'node').detail, /D30 node .* is missing/);
  });
});

describe('pin', () => {
  test('copies (not links) the version to TB_HOME/bin/claude-<v> with 0755, checks --version, sets config.claude_bin', async () => {
    const w = world();
    fs.rmSync(path.join(w.tbHome, 'bin'), { recursive: true });
    const res = await w.make().run({ pin: true });
    assert.equal(res.ok, true, JSON.stringify(res.checks));
    assert.deepEqual(w.store.updates, [{ claude_bin: w.bin, claude_team_id: 'Q6L2SF6YDW' }], 'the first pin also records the Team ID (H7)');
    const st = fs.lstatSync(w.bin);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'a real file');
    assert.equal(st.mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(w.bin, 'utf8'), fs.readFileSync(path.join(w.home, '.local', 'share', 'claude', 'versions', '2.1.295'), 'utf8'));
    assert.equal(spawnSync(w.bin, ['--version'], { encoding: 'utf8' }).stdout.trim(), '2.1.295 (Claude Code)');
    assert.deepEqual(fs.readdirSync(path.dirname(w.bin)), ['claude-2.1.295'], 'no tmp file left');
    assert.equal(res.checks[0].name, 'pin', 'pin runs first: the later checks use the new binary');
  });

  test('--version picks another version; a copy that reports another version, a missing version and bad input are refused', async () => {
    const w = world();
    const versions = path.join(w.home, '.local', 'share', 'claude', 'versions');
    fakeClaude(path.join(versions, '2.1.293'), { authFile: w.authFile });
    const ok = await w.make().run({ pin: true, version: '2.1.293' });
    assert.equal(w.check(ok, 'pin').ok, true);
    assert.deepEqual(w.store.updates, [{ claude_bin: path.join(w.tbHome, 'bin', 'claude-2.1.293'), claude_team_id: 'Q6L2SF6YDW' }]);

    fakeClaude(path.join(versions, '2.1.294'), { authFile: w.authFile, lie: '2.1.200' });
    const lie = w.check(await w.make().run({ pin: true, version: '2.1.294' }), 'pin');
    assert.equal(lie.ok, false);
    assert.match(lie.detail, /the copy says "2\.1\.200 \(Claude Code\)", expected 2\.1\.294/);
    assert.equal(fs.existsSync(path.join(w.tbHome, 'bin', 'claude-2.1.294')), false);
    assert.deepEqual(fs.readdirSync(path.join(w.tbHome, 'bin')).sort(), ['claude-2.1.293', 'claude-2.1.295'], 'no tmp file left');

    const gone = w.check(await w.make().run({ pin: true, version: '9.9.9' }), 'pin');
    assert.match(gone.detail, /versions\/9\.9\.9 not found/);
    assert.equal(w.store.updates.length, 1, 'a failed pin changes no config');

    for (const body of [{ pin: true, version: '../../etc/x' }, { pin: true, version: '1.2' }, { version: '2.1.295' }, { pin: 'yes' }, { tag: '../x' }, { extra: 1 }, []]) {
      await assert.rejects(() => w.make().run(body), is400, JSON.stringify(body));
    }
  });
});

describe('pin hardening (H7)', () => {
  const pinned = async (w, extra, body = { pin: true }) => w.check(await w.make(extra).run(body), 'pin');
  const untouched = (w) => {
    assert.deepEqual(w.store.updates, [], 'a refused pin changes no config');
    assert.equal(fs.existsSync(path.join(w.tbHome, 'bin', 'claude-2.1.295')), false, 'nothing pinned');
    assert.deepEqual(fs.readdirSync(path.join(w.tbHome, 'bin')), [], 'no tmp file left');
    assert.equal(fs.existsSync(`${w.versions}/2.1.295.sawkey`), false, 'the refused copy was never run');
  };
  const fresh = () => {
    const w = world();
    fs.mkdirSync(path.join(w.tbHome, 'bin'), { recursive: true });
    fs.rmSync(w.bin);
    return w;
  };

  test('H7 a source that is a symlink, a directory, owned by another uid or writable by group / others is refused before any copy', async () => {
    const src = (w) => path.join(w.versions, '2.1.295');
    let w = fresh();
    fs.renameSync(src(w), path.join(w.root, 'real-claude'));
    fs.symlinkSync(path.join(w.root, 'real-claude'), src(w));
    assert.match((await pinned(w)).detail, /not a plain file \(symlinks are refused\)/);
    untouched(w);

    w = fresh();
    fs.rmSync(src(w));
    fs.mkdirSync(src(w));
    assert.match((await pinned(w)).detail, /not a plain file/);
    untouched(w);

    w = fresh();
    assert.match((await pinned(w, { uid: process.getuid() + 1 })).detail, /not owned by uid/);
    untouched(w);

    for (const mode of [0o775, 0o757, 0o777]) {
      w = fresh();
      fs.chmodSync(src(w), mode);
      assert.match((await pinned(w)).detail, new RegExp(`writable by group or others \\(mode ${mode.toString(8)}\\)`), mode.toString(8));
      untouched(w);
    }
    assert.deepEqual(w.codesign.calls(), [], 'codesign never saw a refused source');
  });

  test('H7 codesign --verify --strict runs on the COPY before it is executed; a bad signature or no Team ID refuses the pin', async () => {
    let w = fresh();
    w.codesign.verify(3);
    const bad = await pinned(w);
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /codesign rejects the copy: .*invalid signature/);
    untouched(w);
    const calls = w.codesign.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], new RegExp(`^--verify --strict ${w.tbHome.replace(/[.]/g, '\\.')}/bin/claude-2\\.1\\.295\\.\\d+\\.tmp$`), 'on the copy, never the source');

    for (const none of ['not set', '']) {
      w = fresh();
      w.codesign.team(none);
      assert.match((await pinned(w)).detail, /no Team ID/, JSON.stringify(none));
      untouched(w);
    }

    w = fresh();
    assert.equal((await pinned(w)).ok, true);
    assert.match(w.codesign.calls()[1], /^-dv .*claude-2\.1\.295\.\d+\.tmp$/, 'Team ID read from the copy');
    assert.equal(fs.existsSync(`${w.versions}/2.1.295.sawkey`), true, 'after a good signature the copy runs --version');
  });

  test('H7 the first pin records the Team ID in config; later pins must carry the same one or are refused without touching the pinned copy', async () => {
    const w = fresh();
    const d = w.make();
    assert.equal(w.check(await d.run({ pin: true }), 'pin').ok, true);
    assert.deepEqual(w.store.updates, [{ claude_bin: w.bin, claude_team_id: 'Q6L2SF6YDW' }]);
    const before = fs.readFileSync(w.bin, 'utf8');

    fakeClaude(path.join(w.versions, '2.1.293'), { authFile: w.authFile });
    assert.equal(w.check(await d.run({ pin: true, version: '2.1.293' }), 'pin').ok, true, 'same Team ID');
    assert.deepEqual(w.store.updates.at(-1), { claude_bin: path.join(w.tbHome, 'bin', 'claude-2.1.293') }, 'recorded once, not rewritten');

    w.codesign.team('ZZZZZ99999');
    fs.writeFileSync(path.join(w.versions, '2.1.295'), fs.readFileSync(path.join(w.versions, '2.1.295'), 'utf8') + '# changed\n', { mode: 0o755 });
    const mismatch = w.check(await d.run({ pin: true }), 'pin');
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.detail, /Team ID ZZZZZ99999 is not the expected Q6L2SF6YDW/);
    assert.equal(w.store.updates.length, 2, 'no config change');
    assert.equal(fs.readFileSync(w.bin, 'utf8'), before, 'the pinned copy is untouched');
    assert.deepEqual(fs.readdirSync(path.join(w.tbHome, 'bin')).sort(), ['claude-2.1.293', 'claude-2.1.295']);
  });
});

describe('expected Team ID (N8)', () => {
  test('N8 with no claude_team_id in config only Anthropic (Q6L2SF6YDW) is accepted; an edited claude_team_id replaces it', async () => {
    const w = world();
    fs.rmSync(w.bin);
    w.codesign.team('ABCDE12345');
    const refused = w.check(await w.make().run({ pin: true }), 'pin');
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /Team ID ABCDE12345 is not the expected Q6L2SF6YDW; if the signer really changed, edit claude_team_id in config\.json/);
    assert.deepEqual(w.store.updates, [], 'no config change');
    assert.deepEqual(fs.readdirSync(path.join(w.tbHome, 'bin')), [], 'nothing pinned, no tmp file');

    w.store.config.claude_team_id = 'ABCDE12345'; // Irfan edited config.json
    assert.equal(w.check(await w.make().run({ pin: true }), 'pin').ok, true);
    assert.deepEqual(w.store.updates, [{ claude_bin: w.bin }], 'a configured Team ID is not rewritten');
  });
});

describe('store: claude_team_id (H7)', () => {
  test('H7 updateConfig accepts claude_team_id as exactly 10 uppercase letters / digits and nothing else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-store-'));
    roots.push(root);
    const script = `
      const store = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
      store.init();
      (async () => {
        const out = {};
        for (const v of ['Q6L2SF6YDW', 'q6l2sf6ydw', 'SHORT', 'ABCDE123456', 'ABCDE-2345', 10, null]) {
          out[String(v)] = await store.updateConfig({ claude_team_id: v }).then(() => 'ok', (e) => e.status);
        }
        console.log(JSON.stringify({ out, id: store.config.claude_team_id }));
        await store.flush();
        process.exit(0);
      })();`;
    fs.mkdirSync(path.join(root, 'home'));
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TB_HOME: path.join(root, 'tbhome'), TB_NOTIFY: '0' } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      out: { Q6L2SF6YDW: 'ok', q6l2sf6ydw: 400, SHORT: 400, ABCDE123456: 400, 'ABCDE-2345': 400, 10: 400, null: 400 },
      id: 'Q6L2SF6YDW',
    });
  });
});

describe('tag checks', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  // Temp git repo on branch main, optional .claude settings files. Fake tbx runs the command like `tbx heavy -- <cmd>` and logs it.
  function repoWorld(settings = {}, { withGit = true } = {}) {
    const w = world();
    const repo = path.join(w.root, 'repo');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README'), 'x\n');
    for (const [f, v] of Object.entries(settings)) fs.writeFileSync(path.join(repo, '.claude', f), typeof v === 'string' ? v : JSON.stringify(v));
    if (withGit) {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '-A');
      git(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    }
    const log = path.join(w.root, 'tbx.log');
    const tbx = path.join(w.root, 'tbx');
    fs.writeFileSync(tbx, `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> "${log}"\n[ "$1" = heavy ] && [ "$2" = -- ] || exit 64\nshift 2\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
    w.repo = repo;
    w.runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
    w.tag = (def) => { w.store.tags = { 'acme/api': { ...(withGit ? { type: 'git', base: 'main' } : { type: 'folder' }), path: repo, ...def } }; };
    w.doctor = (extra) => w.make({ tbx, ...extra });
    w.tagChecks = async (extra) => (await w.doctor(extra).run({ tag: 'acme/api' })).checks.filter((c) => c.name.startsWith('tag:'));
    return w;
  }

  test('clean repo: tag, settings and every check command pass; each command runs once through tbx heavy in the repo', async () => {
    const w = repoWorld({ 'settings.json': { env: { FOO: '1' }, permissions: { allow: [] } } });
    w.tag({ checks: { lint: 'true', unit: 'echo ok', prisma_diff: true } });
    const checks = await w.tagChecks();
    assert.deepEqual(checks.map((c) => [c.name, c.ok]), [['tag:acme/api', true], ['tag:acme/api:settings', true], ['tag:acme/api:lint', true], ['tag:acme/api:unit', true]]);
    assert.equal(checks[0].detail, `${w.repo} (git, base main)`);
    const real = fs.realpathSync(w.repo);
    assert.deepEqual(w.runs(), [`${real}|heavy -- true`, `${real}|heavy -- echo ok`]);
  });

  test('a failing check command fails the run with its exit code and last output line; a hung one times out', async () => {
    const w = repoWorld({}, { withGit: false });
    w.tag({ checks: { lint: 'echo boom >&2; exit 3' } });
    const res = await w.doctor().run({ tag: 'acme/api' });
    assert.equal(res.ok, false);
    assert.match(w.check(res, 'tag:acme/api:lint').detail, /exit 3: boom/);
    assert.equal(w.check(res, 'tag:acme/api:settings').ok, true);
    w.tag({ checks: { e2e: 'exec sleep 30' } });
    const hung = await w.doctor({ checkTimeoutMs: 1500 }).run({ tag: 'acme/api' });
    assert.match(w.check(hung, 'tag:acme/api:e2e').detail, /timed out after/);
  });

  test('a missing tbx is a failed check, not a crash', async () => {
    const w = repoWorld();
    w.tag({ checks: { lint: 'true' } });
    const c = (await w.tagChecks({ tbx: path.join(w.root, 'nope') })).find((x) => x.name.endsWith(':lint'));
    assert.equal(c.ok, false);
    assert.match(c.detail, /nope not found/);
  });

  test('H3 a check that prints 3 MB (or 20 MB and fails) is judged by its exit code, not killed on maxBuffer; doctor.json keeps only the last 4 KB', async () => {
    const w = repoWorld({}, { withGit: false });
    const tmp = fs.mkdtempSync(path.join(w.root, 'tmp-'));
    const was = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      w.tag({ checks: { big: 'yes 0123456789abcdef | head -c 3000000; echo END-MARKER', loud: 'yes x | head -c 20000000 >&2; echo LAST-LINE >&2; exit 3', quiet: 'true' } });
      const res = await w.doctor().run({ tag: 'acme/api' });
      const big = w.check(res, 'tag:acme/api:big');
      assert.equal(big.ok, true, JSON.stringify({ ...big, output: undefined }));
      assert.ok(big.output.length <= 4096 && big.output.endsWith('END-MARKER\n'), 'the tail, not the head');
      const loud = w.check(res, 'tag:acme/api:loud');
      assert.equal(loud.ok, false);
      assert.match(loud.detail, /exit 3: LAST-LINE$/);
      assert.ok(loud.output.endsWith('LAST-LINE\n') && loud.output.length <= 4096);
      assert.equal('output' in w.check(res, 'tag:acme/api:quiet'), false, 'no output, no field');
      const text = fs.readFileSync(path.join(w.tbHome, 'doctor.json'), 'utf8');
      assert.ok(text.length < 20_000, `doctor.json is ${text.length} bytes`);
      assert.deepEqual(JSON.parse(text).checks.find((c) => c.name === 'tag:acme/api:big').output, big.output);
      assert.deepEqual(fs.readdirSync(tmp), [], 'the temp log is gone');
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  });

  test('H8 tag checks get PATH, HOME, TMPDIR, LANG and TBD_SOCK only; no key, token or other variable of the daemon', async () => {
    const w = repoWorld({}, { withGit: false });
    const dump = path.join(w.root, 'env.txt');
    const tbx = path.join(w.root, 'tbx-env');
    fs.writeFileSync(tbx, `#!/bin/sh\n/usr/bin/env > "${dump}"\n`, { mode: 0o755 });
    w.tag({ checks: { lint: 'true' } });
    const daemon = { PATH: process.env.PATH, HOME: w.home, TMPDIR: '/tmp/x', LANG: 'en_US.UTF-8', LC_ALL: 'C', TB_HOME: w.tbHome, GITHUB_TOKEN: 'gh-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', ANTHROPIC_BASE_URL: 'https://x.invalid' };
    const seen = () => Object.fromEntries(fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const shellAdds = ['PWD', 'SHLVL', '_', 'OLDPWD'];
    const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !shellAdds.includes(k)));

    await w.doctor({ tbx, env: daemon }).run({ tag: 'acme/api' });
    assert.deepEqual(strip(seen()), { PATH: daemon.PATH, HOME: w.home, TMPDIR: '/tmp/x', LANG: 'en_US.UTF-8', TBD_SOCK: path.join(w.tbHome, 'tbd.sock') });

    await w.doctor({ tbx, env: { ...daemon, TBD_SOCK: '/run/x.sock' } }).run({ tag: 'acme/api' });
    assert.equal(seen().TBD_SOCK, '/run/x.sock', 'an explicit TBD_SOCK is kept');
  });

  test('H11 doctor git calls: -c core.fsmonitor=false -c core.hooksPath=/dev/null first, GIT_CONFIG_GLOBAL / SYSTEM off, minimal env; a repo config naming scripts runs none', async () => {
    const w = repoWorld();
    w.tag({});
    const marker = path.join(w.root, 'marker');
    const script = path.join(w.root, 'run-me');
    fs.writeFileSync(script, `#!/bin/sh\necho "$0" >> "${marker}"\nprintf '\\0'\n`, { mode: 0o755 });
    git(w.repo, 'config', 'core.fsmonitor', script);
    git(w.repo, 'config', 'core.hooksPath', script);
    fs.rmSync(marker, { force: true });
    const log = path.join(w.root, 'git-calls');
    const rec = path.join(w.root, 'git-rec');
    fs.writeFileSync(rec, `#!/bin/sh\n{ echo "ARGV $*"; /usr/bin/env | sed 's/^/ENV /'; } >> "${log}"\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const res = await w.doctor({ git: rec, env: { PATH: process.env.PATH, HOME: w.home, GITHUB_TOKEN: 'gh-secret' } }).run({ tag: 'acme/api' });
    assert.equal(w.check(res, 'tag:acme/api').ok, true);
    const calls = fs.readFileSync(log, 'utf8').split('ARGV ').slice(1);
    assert.equal(calls.length, 2, 'rev-parse --git-dir, rev-parse --verify <base>');
    for (const c of calls) {
      const [argv, ...env] = c.split('\n').filter(Boolean);
      assert.ok(argv.startsWith(`${GIT_SAFE.join(' ')} -C ${w.repo} `), argv);
      const keys = env.map((l) => l.slice(4, l.indexOf('=')));
      assert.deepEqual(keys.filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'PATH', 'TBD_SOCK'], 'no GITHUB_TOKEN or other daemon variable');
      assert.ok(env.includes('ENV GIT_CONFIG_GLOBAL=/dev/null') && env.includes('ENV GIT_CONFIG_NOSYSTEM=1'));
    }
    assert.equal(fs.existsSync(marker), false, 'no script named by the repo config ran');
  });

  test('H8 git runs as /usr/bin/git: a git earlier on PATH is never executed', async () => {
    const w = repoWorld();
    w.tag({});
    const bin = path.join(w.root, 'evil-bin');
    const ran = path.join(w.root, 'evil-ran');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    try {
      const res = await w.doctor({ env: { PATH: process.env.PATH } }).run({ tag: 'acme/api' });
      assert.equal(w.check(res, 'tag:acme/api').ok, true, 'the real git found the repo and its base branch');
    } finally {
      process.env.PATH = was;
    }
    assert.equal(fs.existsSync(ran), false, 'the PATH git did not run');
  });

  test('repo .claude settings with apiKeyHelper, ANTHROPIC_* or CLAUDE_CODE_USE_* env are refused (both files); hooks only warn', async () => {
    const cases = /** @type {[object, RegExp][]} */ ([
      [{ 'settings.json': { apiKeyHelper: '/bin/key.sh' } }, /settings\.json sets apiKeyHelper/],
      [{ 'settings.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' } } }, /settings\.json sets env ANTHROPIC_BASE_URL/],
      [{ 'settings.json': { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } }, /settings\.json sets env CLAUDE_CODE_USE_BEDROCK/],
      [{ 'settings.local.json': { apiKeyHelper: 'x' } }, /settings\.local\.json sets apiKeyHelper/],
      [{ 'settings.json': '{ not json' }, /settings\.json: /],
    ]);
    for (const [files, want] of cases) {
      const w = repoWorld(files, { withGit: false });
      w.tag({ checks: { lint: 'true' } });
      const checks = await w.tagChecks();
      const s = checks.find((c) => c.name === 'tag:acme/api:settings');
      assert.equal(s.ok, false, JSON.stringify(files));
      assert.match(s.detail, want);
      assert.ok(s.fix);
    }
    const w = repoWorld({ 'settings.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } } }, { withGit: false });
    w.tag({});
    const s = (await w.tagChecks()).find((c) => c.name.endsWith(':settings'));
    assert.deepEqual([s.ok, s.warn], [true, true]);
    assert.match(s.detail, /settings\.json has hooks/);
  });

  test('a bad tag fails its check and runs nothing: unknown, group, missing path, not a repo, missing base branch', async () => {
    const w = repoWorld();
    w.tag({ checks: { lint: 'true' } });
    const first = async (extra) => (await w.doctor(extra).run({ tag: 'acme/api' })).checks.find((c) => c.name.startsWith('tag:'));
    w.store.tags = {};
    assert.match((await first()).detail, /no tag acme\/api/);
    assert.match((await w.doctor().run({ tag: 'constructor' })).checks.find((c) => c.name.startsWith('tag:')).detail, /no tag constructor/, 'Object.prototype is not a tag');
    w.store.tags = { 'acme/api': {} };
    assert.match((await first()).detail, /has no path/);
    w.tag({ path: path.join(w.root, 'nowhere'), checks: { lint: 'true' } });
    assert.match((await first()).detail, /is not a directory/);
    w.tag({ path: w.root, checks: { lint: 'true' } });
    assert.match((await first()).detail, /is not a git repo/);
    w.tag({ base: 'develop', checks: { lint: 'true' } });
    assert.match((await first()).detail, /base branch develop not found/);
    w.tag({ base: '--help', checks: { lint: 'true' } });
    assert.match((await first()).detail, /base branch --help not found/);
    assert.deepEqual(w.runs(), [], 'no check command ran');
    w.tag({ type: 'folder', base: undefined, path: w.repo, checks: { lint: 'true' } });
    assert.equal((await first()).ok, true, 'a folder tag needs no git');
  });
});

describe('run: doctor.json', () => {
  test('result is saved to TB_HOME/doctor.json with mode 0600 and returned; ok is false when any check fails', async () => {
    const w = world();
    fs.mkdirSync(w.tbHome, { recursive: true });
    const d = w.make({ now: () => new Date('2026-10-08T00:00:00Z') });
    const res = await d.run({});
    assert.equal(res.ok, true);
    assert.deepEqual(res.checks.map((c) => c.name), ['auth', 'claude_bin', 'fable_billing', 'node']);
    const file = path.join(w.tbHome, 'doctor.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-08T00:00:00.000Z', ok: true, checks: res.checks });
    w.setAuth(AUTH.apiKey);
    assert.equal((await d.run({})).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ok, false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('concurrent runs (H5)', () => {
  test('H5 two overlapping runs each return their own record, not the last one saved', async () => {
    const w = world();
    fs.mkdirSync(w.tbHome, { recursive: true });
    w.store.writeAtomic = async (...a) => { await sleep(150); return realStore.writeAtomic(...a); }; // both runs finish while the first write is pending
    const d = w.make();
    w.store.config.fable_billing = 'plan';
    const good = d.run({}); // fable_billing is read synchronously when a run starts
    w.store.config.fable_billing = 'free';
    const broken = d.run({});
    const [a, b] = await Promise.all([good, broken]);
    assert.equal(a.ok, true, 'the run that started healthy says so');
    assert.equal(b.ok, false);
    assert.equal(w.check(a, 'fable_billing').ok, true);
    assert.equal(w.check(b, 'fable_billing').ok, false);
    assert.ok([a, b].some((r) => JSON.stringify(JSON.parse(fs.readFileSync(path.join(w.tbHome, 'doctor.json'), 'utf8')).checks) === JSON.stringify(r.checks)), 'doctor.json holds one run\'s record, whole');
  });
});

describe('util (H10)', () => {
  test('H10 isObj: plain objects only, shared by doctor and gc', () => {
    const { isObj } = require('../lib/util');
    assert.deepEqual([{}, { a: 1 }, [], null, undefined, 'x', 1].map(isObj), [true, true, false, false, false, false, false]);
  });
});

describe('re-check', () => {
  test('H4 every 30 min (fake clock) and on a monitor wake; alerts (quiet-hours-held) once when the login goes bad, again after it recovered', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const w = world();
    fs.mkdirSync(w.tbHome, { recursive: true });
    const notifier = { calls: [], alert(n) { this.calls.push(n); } }; // H4: quiet-hours-held alert, not notify
    const monitor = new EventEmitter();
    const d = w.make();
    d.start({ notifier, monitor });
    const saved = () => {
      try { return JSON.parse(fs.readFileSync(path.join(w.tbHome, 'doctor.json'), 'utf8')).checks.find((c) => c.name === 'auth').detail; } catch { return ''; }
    };

    t.mock.timers.tick(29 * 60_000);
    await sleep(100);
    assert.equal(saved(), '', 'nothing ran before 30 min');

    t.mock.timers.tick(60_000); // 30 min: still fine
    await until(() => saved() === 'claude.ai', 'first re-check');
    assert.equal(notifier.calls.length, 0);

    w.setAuth(AUTH.apiKey);
    t.mock.timers.tick(30 * 60_000);
    await until(() => /apiKey/.test(saved()), 're-check after the API key login');
    assert.deepEqual(notifier.calls, [{ title: 'Taskboard', message: 'Claude login problem: run tb doctor' }]);

    w.setAuth(AUTH.out); // still broken, different symptom: no second banner
    monitor.emit('wake');
    await until(() => /not logged in/.test(saved()), 're-check on wake');
    assert.equal(notifier.calls.length, 1);

    w.setAuth(AUTH.ok);
    monitor.emit('wake');
    await until(() => saved() === 'claude.ai', 'recovery');
    w.setAuth(AUTH.apiKey);
    t.mock.timers.tick(30 * 60_000);
    await until(() => /apiKey/.test(saved()), 'second failure');
    assert.equal(notifier.calls.length, 2, 'a new failure after recovery notifies again');

    d.stop();
    w.setAuth(AUTH.ok);
    t.mock.timers.tick(30 * 60_000);
    monitor.emit('wake');
    await sleep(150);
    assert.match(saved(), /apiKey/, 'a stopped doctor checks nothing');
  });
});

// ---- real tbd + tb ------------------------------------------------------------------------------------------------
describe('e2e: POST /api/doctor and tb doctor on a real tbd', () => {
  let t;
  const tb = (...args) => runTb(args, t);
  const setup = (authObj) => {
    const authFile = path.join(t.tbHome, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify(authObj));
    fakeClaude(path.join(t.tbHome, 'bin', 'claude-2.1.295'), { authFile }); // the default config.claude_bin
    fakeClaude(path.join(t.home, '.local', 'share', 'claude', 'versions', '2.1.295'), { authFile });
    const node = path.join(t.home, '.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
    return authFile;
  };

  before(async () => { t = await startTbd(); });
  after(() => t.stop());

  test('needs the token; a bad body is a 400; tbd health is reported with doctor.json at 0600', async () => {
    const authFile = setup(AUTH.ok);
    assert.equal((await t.api('POST', '/api/doctor', {}, { 'x-tb-token': undefined })).status, 401);
    assert.equal((await t.api('POST', '/api/doctor', { pin: 'yes' })).status, 400);
    assert.equal((await t.api('POST', '/api/doctor', { version: '2.1.295' })).status, 400);
    const r = await t.api('POST', '/api/doctor', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.checks.map((c) => [c.name, c.ok]), [['auth', true], ['claude_bin', true], ['fable_billing', true], ['node', true]]);
    assert.equal(r.json.ok, true);
    assert.equal(fs.statSync(path.join(t.tbHome, 'doctor.json')).mode & 0o777, 0o600);

    fs.writeFileSync(authFile, JSON.stringify(AUTH.apiKey));
    assert.equal((await t.api('POST', '/api/doctor', {})).json.ok, false);
  });

  test('tb doctor: exit 1 and a fail row on API-key login; exit 0 once it is the subscription', async () => {
    const authFile = path.join(t.tbHome, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify(AUTH.apiKey));
    const bad = await tb('doctor');
    assert.equal(bad.code, 1, bad.stdout);
    assert.match(bad.stdout, /^doctor: FAIL \(1 of 4 checks\)$/m);
    assert.match(bad.stdout, /^ {2}auth,fail,"authMethod apiKey: runs must use the claude\.ai subscription",/m);
    fs.writeFileSync(authFile, JSON.stringify(AUTH.ok));
    const good = await tb('doctor');
    assert.equal(good.code, 0, good.stdout);
    assert.match(good.stdout, /^doctor: ok$/m);
    assert.match(good.stdout, /^checks\[4\]\{name,status,detail,fix\}:$/m);
    assert.match(good.stdout, /^ {2}fable_billing,ok,plan,""$/m);
  });

  test('tb doctor --pin --version: a copy that real codesign does not accept is refused (exit 1) and changes no config; usage errors exit 2', async () => {
    const authFile = path.join(t.tbHome, 'auth.json');
    fakeClaude(path.join(t.home, '.local', 'share', 'claude', 'versions', '2.1.293'), { authFile });
    const before = fs.readFileSync(path.join(t.tbHome, 'config.json'), 'utf8');
    const r = await tb('doctor', '--pin', '--version', '2.1.293');
    assert.equal(r.code, 1, r.stdout); // a shell script has no signature: the success path is the unit tests' (injected codesign)
    assert.match(r.stdout, /^ {2}pin,fail,.*codesign rejects the copy/m);
    assert.equal(fs.readFileSync(path.join(t.tbHome, 'config.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(t.tbHome, 'bin', 'claude-2.1.293')), false);
    assert.deepEqual(fs.readdirSync(path.join(t.tbHome, 'bin')).filter((n) => n.endsWith('.tmp')), [], 'no tmp file left');

    const noPin = await tb('doctor', '--version', '2.1.293');
    assert.equal(noPin.code, 2);
    assert.match(noPin.stdout, /^error: --version needs --pin$/m);
    assert.equal((await tb('doctor', '--pin', '--version', '2.1')).code, 2);
    assert.equal((await tb('doctor', 'extra')).code, 2);
  });

  test('tb doctor --tag: checks a folder tag authored through the API', async () => {
    const dir = path.join(t.tbHome, '..', 'proj');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    assert.equal((await t.api('POST', '/api/tags', { name: 'proj/one', def: { type: 'folder', path: fs.realpathSync(dir) } })).status, 201);
    const r = await tb('doctor', '--tag', 'proj/one');
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^ {2}"tag:proj\/one",ok,/m);
    assert.match(r.stdout, /^ {2}"tag:proj\/one:settings",fail,settings\.json sets apiKeyHelper,/m);
    assert.match((await tb('doctor', '--tag', 'proj/none')).stdout, /no tag proj\/none/);
  });

  test('tag check commands run through the real tbx heavy slot of this tbd: exit 0 passes, a failing one reports its exit code', async () => {
    const dir = path.join(t.tbHome, '..', 'heavy-proj');
    fs.mkdirSync(dir, { recursive: true });
    const def = { type: 'folder', path: fs.realpathSync(dir), checks: { lint: 'pwd -P > ran.txt', unit: 'echo nope >&2; exit 3' } };
    assert.equal((await t.api('POST', '/api/tags', { name: 'proj/heavy', def })).status, 201);
    const r = await t.api('POST', '/api/doctor', { tag: 'proj/heavy' });
    assert.equal(r.status, 200, r.text);
    const byName = Object.fromEntries(r.json.checks.map((c) => [c.name, c]));
    assert.equal(byName['tag:proj/heavy:lint'].ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'ran.txt'), 'utf8').trim(), fs.realpathSync(dir), 'ran in the tag path');
    assert.equal(byName['tag:proj/heavy:unit'].ok, false);
    assert.match(byName['tag:proj/heavy:unit'].detail, /exit 3: nope/);
    assert.equal(r.json.ok, false);
  });
});
