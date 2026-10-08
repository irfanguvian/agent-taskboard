'use strict';
// Shared harness (P1 contract): every tbd / tb child runs on its own temp HOME + TB_HOME, never the real
// ~/.taskboard (AC10). Inherited TB_* vars are dropped; stop() fails if anything wrote <tmp>/home/.taskboard.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REPO = path.join(__dirname, '..', '..');
const TBD = path.join(REPO, 'tbd.js');
const TB = path.join(REPO, 'bin', 'tb');
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));

// Inherited env minus every TB_* / TBX_* var, plus the isolated paths and the tbd's test run key (SLOT_ROOT).
function isolatedEnv({ home, tbHome, port, runKey = undefined }, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TBX?_/.test(k)));
  return { ...env, HOME: home, TB_HOME: tbHome, TB_PORT: String(port), TB_NOTIFY: '0', ...(runKey && { TBX_RUN: runKey }), ...extra };
}

// Raw HTTP so tests control every header (fetch refuses to set Host). agent: false = a fresh socket each time: tbd
// closes idle keep-alive sockets after 2 s (N3), and a pooled one may already be closed while spawnSync blocks the loop.
function request(port, method, p, body, headers = {}) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const hdrs = Object.fromEntries(Object.entries({
    ...(data !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
    ...headers,
  }).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: hdrs, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// files: { 'tasks.json': {...} | 'raw text' } seeded into tbHome. tbd: alternate tbd.js path (code-dir copies).
async function startTbd({ env = {}, files = {}, tbd = TBD } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbd-'));
  const home = path.join(root, 'home');
  const tbHome = path.join(root, 'tbhome');
  fs.mkdirSync(home);
  fs.mkdirSync(tbHome);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tbHome, name)), { recursive: true });
    fs.writeFileSync(path.join(tbHome, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const child = spawn(process.execPath, [tbd], { env: isolatedEnv({ home, tbHome, port: 0 }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal }))); // close: stderr fully read
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tbd did not start in 10 s: ${err}`)), 10_000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /tbd listening (\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`tbd exited ${code}: ${err}`)); });
  }).catch((e) => {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true }); // failed start leaves no temp dir
    throw e;
  });
  const token = fs.readFileSync(path.join(tbHome, 'token'), 'utf8').trim(); // written by store.init before listen
  for (let i = 0; (await request(port, 'GET', '/api/state', undefined, { 'x-tb-token': token }).catch(() => ({ status: 0 }))).status !== 200; i++) {
    if (i > 50) throw new Error('tbd /api/state never answered 200');
    await new Promise((r) => setTimeout(r, 100));
  }
  const keyFile = path.join(tbHome, 'test-run.key'); // the test process's run key, from the slot-root preload
  const runKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : undefined;
  return {
    port, home, tbHome, token, runKey, url: `http://127.0.0.1:${port}`, stderr: () => err,
    // api(method, path, body?, headers?) sends the token unless headers override it ({ 'x-tb-token': undefined } omits).
    api: (method, p, body, headers = {}) => request(port, method, p, body, { 'x-tb-token': token, ...headers }),
    // unlock() runs the `tb open` flow (code → /unlock → 302 /#k=<ui_key>) and returns the Cookie header value 'tb_session=…'.
    async unlock() {
      const { json } = await request(port, 'POST', '/api/session/code', undefined, { 'x-tb-token': token });
      const r = await request(port, 'GET', new URL(json.url).pathname + new URL(json.url).search);
      if (!/^\/#k=[0-9a-f]{64}$/.test(r.headers.location)) throw new Error(`unlock: no ui_key fragment in Location ${r.headers.location}`);
      return String(r.headers['set-cookie']).split(';')[0];
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const res = await exited;
      clearTimeout(timer);
      children.delete(child);
      const leaked = fs.existsSync(path.join(home, '.taskboard'));
      fs.rmSync(root, { recursive: true, force: true });
      if (leaked) throw new Error('AC10: something wrote <tmp>/home/.taskboard (homedir fallback)');
      return res;
    },
  };
}

function runTb(args, { tbHome, port, home }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TB, ...args], { env: isolatedEnv({ home, tbHome, port }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const PHASE_FILES = ['prompt.md', 'settings.json', 'result.schema.json'];

// Phase fixture for TB_PHASES_DIR: { 'code/working': PHASE_FILES, ... } written under dir.
function phaseFixture(dir, spec) {
  for (const [key, files] of Object.entries(spec)) {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, key, f), f.endsWith('.json') ? '{}' : '# fixture\n');
  }
  return dir;
}

const FAKE_HANDLERS = `--require ${path.join(__dirname, 'fake-handlers.js')}`;
const SLOT_ROOT = `--require ${path.join(__dirname, 'slot-root.js')}`; // test process may take slot leases

module.exports = { startTbd, runTb, request, isolatedEnv, phaseFixture, PHASE_FILES, FAKE_HANDLERS, SLOT_ROOT, REPO, TBD };
