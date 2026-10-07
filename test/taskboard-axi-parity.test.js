'use strict';
// P1 AC1 + D6: bin/taskboard-axi (shim: tb over tbd) must print the same stdout and exit code as the v1 root
// taskboard-axi (the oracle, file based) for every v1 verb the skills use, and leave the same tasks behind.
// Both sides get the same seed and the same command list. Only generated ids and the two lines that name the
// binary and the data location (`bin:`, `description:`) are normalised.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTbd, isolatedEnv } = require('./helpers/tbd');

const ROOT = path.join(__dirname, '..');
const V1 = path.join(ROOT, 'taskboard-axi');
const SHIM = path.join(ROOT, 'bin', 'taskboard-axi');

const SEED = [
  { id: 't_a1a1a1', title: 'Reply to recruiter', status: 'now', project: 'Acme', due: '2020-01-01', created: '2026-09-01' },
  { id: 't_b2b2b2', title: 'Review billing PR', status: 'now', project: 'Acme', note: 'ask for the "new" report, today', created: '2026-09-01' },
  { id: 't_c3c3c3', title: 'Review roadmap', status: 'now', created: '2026-09-02' },
  { id: 't_d4d4d4', title: 'Draft: weekly update', status: 'next', project: 'Acme', due: '2020-02-02', created: '2026-09-03' },
  { id: 't_e5e5e5', title: 'Pay rent', status: 'done', created: '2026-09-01', done_at: '2026-09-02' },
  { id: 't_f6f6f6', title: 'Pay rent again', status: 'next', created: '2026-09-04' },
  { id: 't_g7g7g7', title: 'Read DDIA ch.5', status: 'later', project: 'Learning', created: '2026-09-04' },
  { id: 't_h8h8h8', title: 'Sort the garage', status: 'later', created: '2026-09-05' },
  { id: 't_i9i9i9', title: 'Inbox idea', status: 'inbox', created: '2026-09-05' },
  { id: 't_j0j0j0', title: 'Old chore', status: 'done', created: '2026-09-01', done_at: '2026-09-03' },
];
const SEED_IDS = new Set(SEED.map(t => t.id));

// The commands. head: unknown flag / unknown command errors list what is valid (the shim has more than v1), so only the first line is compared.
const SEQ = [
  { args: [] },
  { args: ['list'] }, { args: ['list', '--status', 'all'] }, { args: ['list', '--status', 'now,next'] },
  { args: ['list', '--status', 'done'] }, { args: ['list', '--project', 'acme', '--status', 'all'] }, { args: ['list', '--limit', '2'] },
  { args: ['list', '--status', 'soon'] }, { args: ['list', 'extra'] }, { args: ['list', '--stat', 'now'], head: true },
  { args: ['grep', 'review|ddia'] }, { args: ['grep', 'garage', '--status', 'later'] }, { args: ['grep', 'zzz'] },
  { args: ['grep', '(unclosed'] }, { args: ['grep'] }, { args: ['grep', 'pay', '--limit', '1'] },
  { args: ['get', 't_a1a1a1'] }, { args: ['get', 'billing'] }, { args: ['get', 'review'] }, { args: ['get', 'pay'] },
  { args: ['get', 'pay rent'] }, { args: ['get', 'zzz'] }, { args: ['get'] },
  { args: ['add', 'Alpha task', '--status', 'now', '--pos', '1', '--project', 'Acme', '--due', '2030-02-03', '--note', 'n, with: comma'] },
  { args: ['add', 'alpha TASK'] },
  { args: ['add', 'Beta task', '--status', 'later'] }, { args: ['add', 'Gamma task', '--status', 'now'] },
  { args: ['add', 'Delta task', '--status', 'now'] }, { args: ['add', 'Done thing', '--status', 'done'] },
  { args: ['add', 'Bottom task', '--pos', 'bottom'] }, { args: ['add', 'Mid task', '--status', 'next', '--pos', '2'] },
  { args: ['add', 'Top task', '--status', 'next', '--pos', 'top'] }, { args: ['add', 'Far task', '--status', 'later', '--pos', '99'] },
  { args: ['add'] }, { args: ['add', 'x', '--status', 'soon'] }, { args: ['add', 'x', '--due', '2026-13-45'] },
  { args: ['add', 'x', '--pos', '0'] }, { args: ['add', 'x', '--limit', '3'], head: true },
  { args: ['set', 'Alpha task', '--status', 'next', '--pos', 'top'] }, { args: ['set', 'Alpha task', '--status', 'next', '--pos', 'top'] },
  { args: ['set', 'Beta task', '--due', '2031-01-01', '--note', 'later note', '--project', 'Acme'] },
  { args: ['set', 'Beta task', '--due', 'none', '--note', 'none', '--project', 'none'] },
  { args: ['set', 'Beta task', '--title', '  Beta renamed '] }, { args: ['set', 't_i9i9i9', '--status', 'now'] },
  { args: ['set', 't_g7g7g7', '--pos', 'bottom'] }, { args: ['set', 't_h8h8h8', '--status', 'done'] },
  { args: ['set', 't_h8h8h8', '--status', 'later'] }, { args: ['set', 't_i9i9i9'] }, { args: ['set', 'review', '--due', '2030-01-01'] },
  { args: ['set', 't_i9i9i9', '--title', ' '] }, { args: ['set', 'zzz', '--status', 'now'] },
  { args: ['done', 'Gamma task'] }, { args: ['done', 'Gamma task'] }, { args: ['done', 'Delta task', 'Mid task'] },
  { args: ['done', 'zzz'] }, { args: ['done'] },
  { args: ['rm', 'Bottom task'] }, { args: ['rm', 'Done thing', 'Beta renamed'] }, { args: ['rm', 'zzz'] }, { args: ['rm'] },
  { args: [] }, { args: ['list', '--status', 'all'] }, { args: ['frob'], head: true },
];

const stripBinLines = out => out.split('\n').filter(l => !/^(bin|description):/.test(l)).join('\n');

// Generated ids (not in the seed) become t_NEW1, t_NEW2 ... in order of first appearance.
function idNormaliser() {
  const seen = new Map();
  return s => stripBinLines(s).replace(/\bt_[a-z0-9]{6}\b/g, id => {
    if (SEED_IDS.has(id)) return id;
    if (!seen.has(id)) seen.set(id, `t_NEW${seen.size + 1}`);
    return seen.get(id);
  });
}

test('taskboard-axi shim output, exit codes and resulting tasks equal v1 for the skill verbs', async () => {
  const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-v1-'));
  fs.writeFileSync(path.join(v1Dir, 'tasks.json'), JSON.stringify({ tasks: SEED }));
  const board = await startTbd({ files: { 'tasks.json': { tasks: SEED } } });
  const runV1 = args => spawnSync(process.execPath, [V1, ...args], { encoding: 'utf8', env: { ...process.env, TASKBOARD_DIR: v1Dir, HOME: v1Dir } });
  const runShim = args => spawnSync(process.execPath, [SHIM, ...args], { encoding: 'utf8', env: isolatedEnv(board) });
  try {
    const normV1 = idNormaliser(), normShim = idNormaliser();
    for (const { args, head } of SEQ) {
      const want = runV1(args), got = runShim(args);
      const cut = s => (head ? s.split('\n')[0] : s);
      assert.deepEqual(
        { code: got.status, stdout: cut(normShim(got.stdout)) },
        { code: want.status, stdout: cut(normV1(want.stdout)) },
        `taskboard-axi ${args.join(' ')}`,
      );
    }

    // same tasks left behind (v1 has no `type`; generated ids compared by place in the array)
    const fromV1 = JSON.parse(fs.readFileSync(path.join(v1Dir, 'tasks.json'), 'utf8')).tasks;
    const fromTbd = (await board.api('GET', '/api/state')).json.reminders.map(t => { const r = { ...t }; delete r.type; return r; });
    const byPlace = rows => rows.map((t, i) => (SEED_IDS.has(t.id) ? t : { ...t, id: `NEW@${i}` }));
    assert.deepEqual(byPlace(fromTbd), byPlace(fromV1));
    assert.ok(fromV1.length > SEED.length - 2, 'the sequence must leave a non-trivial board behind');
  } finally {
    await board.stop();
    fs.rmSync(v1Dir, { recursive: true, force: true });
  }
});

test('the shim names itself taskboard-axi in help and hints', async () => {
  const board = await startTbd({ files: { 'tasks.json': { tasks: SEED } } });
  try {
    const run = args => spawnSync(process.execPath, [SHIM, ...args], { encoding: 'utf8', env: isolatedEnv(board) });
    assert.match(run(['add', '--help']).stdout, /^usage: taskboard-axi add /m);
    assert.match(run(['--help']).stdout, /^usage: taskboard-axi \[command\]/m);
    assert.match(run([]).stdout, /Run `taskboard-axi grep "<words>"`/);
  } finally {
    await board.stop();
  }
});
