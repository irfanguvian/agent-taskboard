'use strict';
// LESSONS 2026-10-09 promoted gate: scripts/hidden-chars.js refuses a raw bidi char, passes clean text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'hidden-chars.js');

test('hidden-chars: raw U+202E fails with file:line:col, clean file passes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dirty = path.join(dir, 'a.js');
  const clean = path.join(dir, 'b.js');
  fs.writeFileSync(dirty, `const ok = 1;\nconst x = 'cmd${String.fromCodePoint(0x202e)}sj.txt';\n`);
  fs.writeFileSync(clean, "const re = /[\\u202E]/; // an escape is fine\n");
  const bad = spawnSync(process.execPath, [SCRIPT, dirty, clean], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /a\.js:2:15 U\+202E/);
  assert.doesNotMatch(bad.stderr, /b\.js/);
  assert.strictEqual(spawnSync(process.execPath, [SCRIPT, clean], { encoding: 'utf8' }).status, 0);
});
