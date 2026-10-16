'use strict';
// Agent forgeries in a worktree (H1, C1 D-0152), for the gate / judge tests:
// index(wt, rel, text): rel's content changed, its index entry's stat refreshed (git add) then pointed back at HEAD's blob
//   (SEC-2): `git status` clean, `ls-files -v` H, the file not HEAD's.
// blob(wt, rel, text): the loose file of HEAD:rel's blob rewritten to hold other content under the same name: a fetch of
//   that commit must fail (index-pack re-hashes every object).
// pack(wt, items [{oid, type, body}]): a pack + idx (v2) put in wt's own object store whose idx CLAIMS each oid while
//   its bytes are body (C1 TEST METHOD, spike S4 forgepack.py): git hashes no packed object it reads, and reads packs
//   before loose objects and alternates, so an untrusted read of that oid gets body; the tag repo's objects stay real.
// As a CLI (a fake-claude exec step, cwd = the worktree): node forge.js index|blob <rel> <text>
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function index(wt, rel, text) {
  const old = Buffer.from(git(wt, 'rev-parse', `HEAD:${rel}`), 'hex');
  const f = path.join(wt, rel);
  fs.writeFileSync(f, text);
  const past = new Date(Date.now() - 60_000); // older than the index: never racily clean (git would hash it)
  fs.utimesSync(f, past, past);
  git(wt, 'add', rel);
  const idx = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index'));
  const buf = fs.readFileSync(idx);
  const at = buf.indexOf(Buffer.from(git(wt, 'rev-parse', `:${rel}`), 'hex'));
  if (at <= 0) throw new Error('forge index: the new blob is not in the index');
  old.copy(buf, at);
  crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest().copy(buf, buf.length - 20);
  fs.writeFileSync(idx, buf);
}

function blob(wt, rel, text) {
  const oid = git(wt, 'rev-parse', `HEAD:${rel}`);
  const f = path.resolve(wt, git(wt, 'rev-parse', '--git-path', `objects/${oid.slice(0, 2)}/${oid.slice(2)}`));
  fs.chmodSync(f, 0o644);
  fs.writeFileSync(f, zlib.deflateSync(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)])));
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
function pack(wt, items) {
  const TY = { commit: 1, tree: 2, blob: 3 };
  const parts = [Buffer.from('PACK'), u32(2), u32(items.length)];
  let off = 12;
  const ents = [];
  for (const { oid, type, body } of items) {
    let n = body.length;
    let b = (TY[type] << 4) | (n & 15);
    n >>= 4;
    const hdr = [];
    while (n) { hdr.push(b | 0x80); b = n & 0x7f; n >>= 7; }
    hdr.push(b);
    const data = Buffer.concat([Buffer.from(hdr), zlib.deflateSync(body)]);
    ents.push({ oid: Buffer.from(oid, 'hex'), crc: zlib.crc32(data), off });
    parts.push(data);
    off += data.length;
  }
  const body = Buffer.concat(parts);
  const sum = crypto.createHash('sha1').update(body).digest();
  ents.sort((x, y) => Buffer.compare(x.oid, y.oid));
  const fan = Array.from({ length: 256 }, () => 0);
  for (const e of ents) fan[e.oid[0]]++;
  for (let i = 1; i < 256; i++) fan[i] += fan[i - 1];
  const idx = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63]), u32(2), ...fan.map(u32), ...ents.map((e) => e.oid), ...ents.map((e) => u32(e.crc)), ...ents.map((e) => u32(e.off)), sum]);
  const dir = path.join(path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'objects')), 'pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `pack-${sum.toString('hex')}.pack`), Buffer.concat([body, sum]));
  fs.writeFileSync(path.join(dir, `pack-${sum.toString('hex')}.idx`), Buffer.concat([idx, crypto.createHash('sha1').update(idx).digest()]));
}

if (require.main === module) ({ index, blob })[process.argv[2]](process.cwd(), process.argv[3], process.argv[4]);
module.exports = { index, blob, pack };
