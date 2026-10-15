'use strict';
// M5.4 C18: a fake tools/lavish install for tests (TB_LAVISH_DIR): package.json with the real pin and
// node_modules/lavish-axi at that version. Made once per test process; removed on exit.
// dist/cli.mjs stands in for lavish-axi (F2). tbd runs it under lib/lavish.sb with a minimal env (util.minimalEnv +
// LAVISH_AXI_*), so no TB_LAVISH_* var reaches it and it may write only in LAVISH_AXI_STATE_DIR (= TB_HOME/lavish, its
// cwd): its files live there, one set per tbd. Each call: {at, pid, argv, env, jailed} appended to
// TB_HOME/lavish/fake-lavish.jsonl (jailed: reading TB_HOME/tickets is refused, as lib/lavish.sb does). Verb = argv[0]
// (poll | end | stop | reply), else open (argv[0] = the html). Scripted steps: TB_HOME/lavish/fake-lavish.json
// {open|poll|end|stop: [step]}, the n-th call of a verb takes step n (claimed O_EXCL under TB_HOME/lavish/fake-claims/,
// so a restarted tbd goes on). Step = {out: stdout text ({{NONCE}} = the tb-nonce of the html it was given), code: exit
// (default 0), delay_ms, ignore_term: SIGTERM ignored (else exit 143 as lavish, cli.mjs:13067), hang: true (waits for
// SIGTERM)}. No step (N7): open prints a session url (a 16-hex key from the html path, as lavish's own), exit 0; poll
// hangs until SIGTERM (143); end / stop print their status, exit 0. A hang self-exits after 120 s (an orphan never
// outlives a test).
// dist/server.mjs `server --port <p>`: listens on 127.0.0.1:<p> (the F5 "our own server" argv), self-exits after 120 s.
// OPENER (NODE_OPTIONS --require): tbd's browser opener (interview.opener) records the url in TB_HOME/lavish-opened.jsonl
// instead (set after tbd.js loaded: setImmediate).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIN = require('../../tools/lavish/package.json').dependencies['lavish-axi'];
let dir;

const CLI = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const argv = process.argv.slice(2);
const state = process.env.LAVISH_AXI_STATE_DIR;
if (!state) process.exit(2);
let jailed = false;
try { fs.readdirSync(path.join(path.dirname(state), 'tickets')); } catch (e) { jailed = e.code === 'EPERM'; }
fs.appendFileSync(path.join(state, 'fake-lavish.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, argv, env: process.env, jailed }) + '\\n');
const verb = ['poll', 'end', 'stop', 'reply'].includes(argv[0]) ? argv[0] : 'open';
const html = verb === 'open' ? argv[0] : argv[1];
let steps = [];
try { steps = JSON.parse(fs.readFileSync(path.join(state, 'fake-lavish.json'), 'utf8'))[verb] ?? []; } catch { /* none */ }
fs.mkdirSync(path.join(state, 'fake-claims'), { recursive: true });
let n = 0;
for (;;) { try { fs.closeSync(fs.openSync(path.join(state, 'fake-claims', verb + '.' + n), 'wx')); break; } catch { n++; } }
const key = crypto.createHash('sha256').update(String(html)).digest('hex').slice(0, 16);
const DEFAULT = {
  open: { out: 'session:\\n  file: ' + html + '\\n  url: "http://localhost:' + process.env.LAVISH_AXI_PORT + '/session/' + key + '"\\n  status: opened\\n' },
  poll: { hang: true },
  end: { out: 'session:\\n  file: ' + html + '\\n  status: ended\\n' },
  stop: { out: 'server:\\n  status: stopped\\n' },
  reply: { out: 'reply:\\n  status: accepted\\n' },
};
const step = steps[n] ?? DEFAULT[verb];
process.on('SIGTERM', () => { if (!step.ignore_term) process.exit(143); });
setTimeout(() => process.exit(0), 120_000);
const nonce = () => { try { return /name="tb-nonce" content="([0-9a-f]+)"/.exec(fs.readFileSync(html, 'utf8'))?.[1] ?? ''; } catch { return ''; } };
if (!step.hang) setTimeout(() => { process.stdout.write((step.out ?? '').replaceAll('{{NONCE}}', nonce())); process.exit(step.code ?? 0); }, step.delay_ms ?? 0);
`;

const SERVER = `import net from 'node:net';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
net.createServer((c) => c.destroy()).listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 120_000);
`;

const OPENER_JS = `setImmediate(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'interview.js'))}).opener = async (url) => {
    fs.appendFileSync(path.join(process.env.TB_HOME, 'lavish-opened.jsonl'), JSON.stringify({ at: Date.now(), url }) + '\\n');
    return { err: null };
  };
});
`;

function lavishDir() {
  if (dir) return dir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lavish-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const mod = path.join(dir, 'node_modules', 'lavish-axi');
  fs.mkdirSync(path.join(mod, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'lavish-axi': PIN } }));
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'lavish-axi', version: PIN }));
  fs.writeFileSync(path.join(mod, 'dist', 'cli.mjs'), CLI);
  fs.writeFileSync(path.join(mod, 'dist', 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(dir, 'opener.cjs'), OPENER_JS);
  return dir;
}

const jsonl = (/** @type {string} */ f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// the fake's calls under a tbd's TB_HOME, oldest first
const calls = (/** @type {string} */ tbHome) => jsonl(path.join(tbHome, 'lavish', 'fake-lavish.jsonl'));
// the urls tbd opened in the browser (needs OPENER in the tbd's NODE_OPTIONS)
const opened = (/** @type {string} */ tbHome) => jsonl(path.join(tbHome, 'lavish-opened.jsonl'));
const OPENER = `--require ${path.join(lavishDir(), 'opener.cjs')}`;

module.exports = { lavishDir, PIN, calls, opened, OPENER };
