#!/usr/bin/env node
'use strict';
// hidden-chars: lint gate (promoted from docs/LESSONS.md 2026-10-09, hits 3). Fails on raw bidi controls and zero-width
// chars in repo text files: they make code read differently than it runs. Escapes in source are fine; raw code points
// are not. Args: files to scan; none → every tracked + untracked (not ignored) text file (any name: bin/tb, scripts/deploy;
// a NUL in the first 8 KB = binary, skipped). Exit 1 lists file:line:col U+XXXX.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { GIT, GIT_SAFE, GIT_ENV, minimalEnv } = require('../lib/util');

const bad = (c) => c === 0x061c || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || c === 0x2060 || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;

const files = process.argv.length > 2 ? process.argv.slice(2)
  : execFileSync(GIT, [...GIT_SAFE, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', timeout: 20_000, env: { ...minimalEnv(process.env), ...GIT_ENV } })
    .split('\0').filter(Boolean); // -z: names unquoted (café.js); lint run, not a request path
const hits = [];
for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; } // deleted in the work tree, or a dir (submodule)
  if (buf.subarray(0, 8192).includes(0)) continue; // binary (tcal)
  const text = buf.toString('utf8');
  text.split('\n').forEach((line, i) => {
    let col = 0;
    for (const ch of line) {
      col++;
      const c = ch.codePointAt(0);
      if (bad(c)) hits.push(`${f}:${i + 1}:${col} U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  });
}
if (hits.length) {
  console.error(`hidden-chars: ${hits.length} raw bidi/zero-width char(s); write them as escapes:\n${hits.join('\n')}`);
  process.exit(1);
}
