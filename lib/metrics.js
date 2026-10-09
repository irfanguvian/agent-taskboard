'use strict';
// metrics: TB_HOME/metrics.jsonl, one JSON line per run end, gate, finished ticket and chaos drill (spec App C, plan P3
// AC10). Append only (mode 0600); a failed append is logged, never fails the caller. The last t:run lines stay in
// memory: admission takes the median peak RSS of a phase's last 10 runs from them (admission.needGb).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EXITS } = require('./stream');

const FILE = path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'metrics.jsonl');
const KEEP = 200; // t:run lines in memory: 10 per phase with room to spare
const LOAD_BYTES = 1 << 20; // load() reads the file's tail only
let recent = [];

// t:run `exit` (App C enum + refusal + cancelled, T5 note in stream.js): every stream.EXITS value as is; anything else
// a lease could hold (none, or written by older code) counts as a lost run.
const exitOf = (x) => (EXITS.includes(x) ? x : 'interrupted');

function keep(lines) {
  recent.push(...lines.filter((l) => l?.t === 'run'));
  if (recent.length > KEEP) recent = recent.slice(-KEEP);
}

function append(line) {
  keep([line]);
  return fsp.appendFile(FILE, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    .catch((e) => console.error(`tbd: metric not written to ${FILE}: ${e.message}`));
}

// Once at tbd start: the t:run lines of the file's last LOAD_BYTES, before any appended since.
async function load() {
  let fh;
  try {
    fh = await fsp.open(FILE, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, LOAD_BYTES));
    await fh.read(buf, 0, buf.length, size - buf.length);
    const lines = buf.toString('utf8').split('\n').slice(size > buf.length ? 1 : 0); // a cut first line goes
    const parsed = [];
    for (const l of lines) {
      try { parsed.push(JSON.parse(l)); } catch { /* a torn line */ }
    }
    const since = recent;
    recent = [];
    keep([...parsed, ...since]);
  } finally {
    await fh.close();
  }
}

// P3d chaos drills (spec §12, `tb eval chaos`): {name, ok, note} + at (ISO-8601 UTC, when recorded). Resolves the line once appended (POST /api/drills
// answers with it).
const DRILLS = ['kill-tbd', 'kill-claude', 'restart', 'freeze', 'wifi', 'lid', 'reboot'];
async function drill({ name, ok, note = null }) {
  const line = { t: 'drill', at: new Date().toISOString(), name, ok: ok === true, note };
  await append(line);
  return line;
}

module.exports = { append, load, drill, DRILLS, exitOf, runs: () => recent };
