'use strict';
// tbx: agent-side CLI over tbd's unix socket (spec §7, App B). Zero dependencies. TOON on stdout.
// Exit codes: 0 ok, 1 error, 2 usage; `tbx heavy` exits with its command's code.
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { call, sockPath } = require('./slots');
const { cell, table } = require('./toon');

const HELP = [
  'usage: tbx <command>',
  'commands[2]:',
  '  status                                     system now: heavy slot, locks, subagents, memory, disk',
  '  heavy [--wait-tbd <s>] -- <cmd> [args...]  run in the heavy slot at nice 10; one arg runs via /bin/sh -c',
  'heavy waits for the slot, sets TBX_LEASE for the command, releases on exit; a child holding the inherited',
  'lease re-enters without waiting. --wait-tbd: seconds to retry while tbd is unreachable (default 30).',
  'socket: $TBD_SOCK, else ${TB_HOME:-~/.taskboard}/tbd.sock; a run\'s key: $TBX_RUN (set by the runner)',
];

class Exit extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const down = (sock) => new Exit(1, `error: tbd not reachable (socket ${sock})`);
const DOWN = ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']; // EPIPE/ECONNRESET: closed unanswered (restart, connection cap)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries while tbd is down (also after a restart dropped a waiting acquire); gives up waitS after the first miss.
async function persistent(sock, msg, waitS) {
  let until = 0;
  for (;;) {
    try {
      return await call(sock, msg);
    } catch (e) {
      if (!DOWN.includes(e.code)) throw new Exit(1, `error: ${e.message}`);
      until ||= Date.now() + waitS * 1000;
      if (Date.now() >= until) throw down(sock);
      await sleep(500);
    }
  }
}

async function heavy(args) {
  let waitS = 30;
  while (args.length && args[0] !== '--') {
    const [flag, value] = args.splice(0, 2);
    if (flag !== '--wait-tbd' || !/^\d+(\.\d+)?$/.test(value ?? '')) throw new Exit(2, `error: bad option "${flag}"\nhelp: tbx heavy [--wait-tbd <s>] -- <cmd...>`);
    waitS = Number(value);
  }
  const argv = args.slice(1);
  if (!argv.length) throw new Exit(2, 'error: missing command\nhelp: tbx heavy [--wait-tbd <s>] -- <cmd...>');
  const sock = sockPath();
  const inherited = process.env.TBX_LEASE;
  // The nonce proves a retry (e.g. after a tbd restart) is this tbx, not another process naming its pid.
  const nonce = crypto.randomBytes(16).toString('hex');
  const runKey = process.env.TBX_RUN; // the run this tbx belongs to (N2); unset outside runs (doctor, gates)
  const res = await persistent(sock, { op: 'slot.acquire', pid: process.pid, nonce, cmd: argv.join(' ').slice(0, 500), ...(inherited && { lease: inherited }), ...(runKey && { run: runKey }) }, waitS);
  if (!res.ok) throw new Exit(1, `error: ${res.error}`);
  const run = argv.length === 1 ? ['/bin/sh', '-c', argv[0]] : argv;
  // nice 10, inherited by the command. A sandbox denies setpriority: then it runs as is and tbd renices it.
  try { os.setPriority(10); } catch { /* EPERM/EACCES: tbd renices the command group */ }
  // detached: the command leads its own process group, so a forwarded signal (or tbd's max-hold revoke)
  // reaches everything it started, not just its first process.
  const child = spawn(run[0], run.slice(1), { stdio: 'inherit', detached: true, env: { ...process.env, TBX_LEASE: res.lease } });
  for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(sig, () => { try { process.kill(-child.pid, sig); } catch { /* group already gone */ } });
  }
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { console.error(`error: ${e.message}`); resolve(127); });
    child.on('close', (c, sig) => resolve(c ?? 128 + (os.constants.signals[sig] ?? 0)));
  });
  if (!res.reentrant) { // a re-entrant child shares its ancestor's lease: the ancestor releases it
    await call(sock, { op: 'slot.release', lease: res.lease, nonce }, { timeoutMs: 2000 }) // N11: the nonce proves it is the acquirer
      .catch((e) => console.error(`warn: slot not released (${e.message}); tbd frees it when this pid exits`));
  }
  return code;
}

const gb = (b) => (typeof b === 'number' ? Math.round(b / 2 ** 30 * 10) / 10 : null);
const short = (s) => (s.length > 80 ? s.slice(0, 79) + '…' : s);

function view(s) {
  const sys = s.system;
  const h = s.slots?.heavy ?? { capacity: 0, held: [], waiting: [] };
  const rows = (list) => list.map((x) => ({ ...x, cmd: short(x.cmd ?? '') }));
  return [
    ...(sys ? table('system', [{
      pressure: sys.pressure, avail_gb: gb(sys.avail), ram_used_gb: gb(sys.ram_used), ram_total_gb: gb(sys.ram_total),
      disk_free_gb: gb(sys.disk_free), claude_rss_gb: gb(sys.claude_rss),
      net: sys.net == null ? null : sys.net ? 'up' : 'down', power: sys.power, docker: sys.docker == null ? null : sys.docker ? 'running' : 'off',
    }], ['pressure', 'avail_gb', 'ram_used_gb', 'ram_total_gb', 'disk_free_gb', 'claude_rss_gb', 'net', 'power', 'docker'])
      : ['system: unavailable (monitor not sampled yet)']),
    `heavy: ${h.held.length}/${h.capacity} held, ${h.waiting.length} waiting`,
    ...table('held', rows(h.held), ['pid', 'since', 'cmd']),
    ...table('waiting', rows(h.waiting), ['pid', 'since', 'cmd']),
    ...table('locks', s.locks ?? [], ['name', 'pid', 'since', 'waiting']),
    `subagents: ${s.subagents?.sessions ?? 0} sessions, ${s.subagents?.alive_total ?? 0} alive`,
    ...table('runs', s.runs ?? [], Object.keys(s.runs?.[0] ?? {})),
  ];
}

async function status() {
  const sock = sockPath();
  const s = await call(sock, { op: 'status' }, { timeoutMs: 5000 }).catch((e) => {
    throw DOWN.includes(e.code) ? down(sock) : new Exit(1, `error: ${e.message}`);
  });
  if (!s.ok) throw new Exit(1, `error: ${s.error}`);
  console.log(view(s).join('\n'));
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  let code;
  try {
    if (cmd === 'status' && !rest.length) code = await status();
    else if (cmd === 'heavy') code = await heavy(rest);
    else if (cmd === undefined || cmd === '--help' || cmd === '-h') { console.log(HELP.join('\n')); code = 0; }
    else throw new Exit(2, `error: unknown command ${cell(cmd)}\n${HELP[0]}`);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    console.error(e.message);
    code = e.code;
  }
  process.exit(code);
}

module.exports = { main };
