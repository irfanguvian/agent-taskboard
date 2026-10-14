'use strict';
// M5.2 C8 Q7 (contract .omc/handoffs/m5-contract.md rev 4; D-0088, D-0097): lib/docs.js mirror(t) copies the *.md and
// *.png under the worktree's docs/verification + docs/verdicts to tickets/<id>/docs/ (0600) and never reads through a
// link (file, dir, a docs dir itself, a hard link), inside its caps. Real files under a temp TB_HOME; no tbd.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
process.env.TB_HOME = path.join(ROOT, 'tb');
const { mirror } = require('../lib/docs');

let seq = 0;
// a worktree holding files (string → a file, {link} → a symlink, {hard} → a hard link, {size} → a sparse file)
function world(files) {
  const id = `t_doc${String(++seq).padStart(3, '0')}`;
  const wt = path.join(ROOT, `wt-${seq}`);
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(wt, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof c === 'string') fs.writeFileSync(p, c);
    else if (c.link) fs.symlinkSync(c.link, p);
    else if (c.hard) fs.linkSync(c.hard, p);
    else {
      fs.writeFileSync(p, '');
      fs.truncateSync(p, c.size);
    }
  }
  const out = path.join(ROOT, 'tb', 'tickets', id);
  const mirrored = () => (fs.existsSync(path.join(out, 'docs')) ? fs.readdirSync(path.join(out, 'docs'), { recursive: true, encoding: 'utf8' }).filter((f) => fs.lstatSync(path.join(out, 'docs', f)).isFile()).sort() : []);
  return { t: { id, worktree: wt }, wt, out, mirrored };
}
// outside the worktree: what a link could aim at
fs.mkdirSync(path.join(ROOT, 'outside', 'verification'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'outside', 'secret.txt'), 'SECRET\n');
fs.writeFileSync(path.join(ROOT, 'outside', 'verification', 'x.md'), 'OUTSIDE\n');

test('C8 mirror: the md + png of both docs dirs (nested too) copied to tickets/<id>/docs/<rel> at 0600; another file there or another path not (D-0097); a second mirror takes the new text', async () => {
  const w = world({
    'docs/verification/2026-10-13-t-qa.md': '# QA\n**Verdict:** PASS\n', 'docs/verification/screenshots/a.png': '\x89PNG fake',
    'docs/verdicts/2026-10-13-t.md': '# verdict\n', 'docs/verification/x.d.ts': 'declare const x: 1;\n', 'docs/notes.md': 'not a docs dir\n', 'src/a.js': 'x\n',
  });
  assert.deepEqual(await mirror(w.t), { copied: 3, skipped: 1 });
  assert.deepEqual(w.mirrored(), ['verdicts/2026-10-13-t.md', 'verification/2026-10-13-t-qa.md', 'verification/screenshots/a.png']);
  const qa = path.join(w.out, 'docs/verification/2026-10-13-t-qa.md');
  assert.equal(fs.readFileSync(qa, 'utf8'), '# QA\n**Verdict:** PASS\n');
  assert.equal(fs.statSync(qa).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(w.wt, 'docs/verification/2026-10-13-t-qa.md'), '# QA round 2\n');
  await mirror(w.t);
  assert.equal(fs.readFileSync(qa, 'utf8'), '# QA round 2\n', 'the next QA result mirrors again');
});

test('C8 mirror A01: a symlinked doc, a symlinked sub dir, a symlinked docs dir, a hard link and a symlinked docs/ are skipped; nothing from outside lands in the mirror', async () => {
  const w = world({
    'docs/verification/ok.md': 'ok\n',
    'docs/verification/leak.md': { link: path.join(ROOT, 'outside', 'secret.txt') },
    'docs/verification/sub': { link: path.join(ROOT, 'outside', 'verification') },
    'docs/verification/hard.md': { hard: path.join(ROOT, 'outside', 'secret.txt') },
    'docs/verdicts': { link: path.join(ROOT, 'outside', 'verification') },
  });
  assert.deepEqual(await mirror(w.t), { copied: 1, skipped: 4 });
  assert.deepEqual(w.mirrored(), ['verification/ok.md']);
  const up = world({ docs: { link: path.join(ROOT, 'outside') } }); // docs/verification resolves outside through docs/
  assert.deepEqual(await mirror(up.t), { copied: 0, skipped: 1 });
  assert.deepEqual(up.mirrored(), []);
});

test('C8 mirror caps: a file over 5 MB, past 20 MB in all, past 200 entries → skipped, the rest copied', async () => {
  const MB = 1024 * 1024; // 5 files of exactly 5 MB: 4 fit the 20 MB (readdir order decides which), the 5th does not
  const big = world({ ...Object.fromEntries('abcde'.split('').map((x) => [`docs/verification/${x}.png`, { size: 5 * MB }])), 'docs/verdicts/huge.md': { size: 5 * MB + 1 } });
  assert.deepEqual(await mirror(big.t), { copied: 4, skipped: 2 });
  assert.equal(big.mirrored().filter((f) => f.startsWith('verification/')).length, 4);
  const many = world(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`docs/verification/${String(i).padStart(3, '0')}.md`, 'x'])));
  assert.deepEqual(await mirror(many.t), { copied: 200, skipped: 1 }); // the 201st entry ends the walk
  assert.equal(many.mirrored().length, 200);
});
