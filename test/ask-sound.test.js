'use strict';
// P0 AC2: build sound hook plays sound + notification by day, stays silent 22:00-07:00 (D13, D28).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ask-sound.sh');

function run(hhmm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-sound-'));
  tmpDirs.push(dir);
  const log = path.join(dir, 'calls.log');
  const stub = path.join(dir, 'stub');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n`, { mode: 0o755 });
  fs.symlinkSync(stub, path.join(dir, 'afplay'));
  fs.symlinkSync(stub, path.join(dir, 'osascript'));
  const r = spawnSync('/bin/sh', [SCRIPT, 'pick plan'], {
    input: '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}',
    env: { ...process.env, TB_NOW_HHMM: hhmm, AFPLAY_BIN: path.join(dir, 'afplay'), OSASCRIPT_BIN: path.join(dir, 'osascript') },
  });
  // stubs run in background: poll up to 3 s for both, or settle 0.5 s when silence is expected
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const until = Date.now() + 3000;
  while (Date.now() < until && read().split('\n').filter(Boolean).length < 2) spawnSync('/bin/sleep', ['0.1']);
  return { status: r.status, calls: read() };
}

test('daytime: plays sound and posts notification with the title', () => {
  const { status, calls } = run('0930');
  assert.equal(status, 0);
  assert.match(calls, /^afplay .*Glass\.aiff$/m);
  assert.match(calls, /^osascript .*pick plan$/m);
});

test('quiet hours: 22:30 and 06:59 make no sound, still exit 0', () => {
  for (const t of ['2230', '0659']) {
    const { status, calls } = run(t);
    assert.equal(status, 0);
    assert.equal(calls, '', `expected silence at ${t}`);
  }
});

test('boundary: 07:00 and 21:59 are daytime', () => {
  for (const t of ['0700', '2159']) assert.match(run(t).calls, /afplay/);
});
