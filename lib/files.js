'use strict';
// files: the Goal box's @ list (GET /api/files?tag=&q=&limit=): the tag folder's files, relative POSIX paths. A git tag
// lists what git tracks (ignored and untracked files stay out); a plain folder is walked (no dot-folders, no node_modules).
// One read serves 30 s; the match runs per call.
const fsp = require('node:fs/promises');
const { git } = require('./util');

const GIT_MAX = 50_000; // entries kept from ls-files
const WALK_MAX = 20_000; // entries a plain-folder walk looks at
const FILES_MS = 30_000;

async function walk(/** @type {string} */ root) {
  const out = [], queue = [''];
  let seen = 0;
  for (let i = 0; i < queue.length && seen < WALK_MAX; i++) { // an index, not shift(): O(1) per folder
    const rel = queue[i];
    for (const d of await fsp.readdir(`${root}/${rel}`, { withFileTypes: true }).catch(() => [])) {
      if (++seen > WALK_MAX) break;
      if (d.name.startsWith('.')) continue; // no dot-folders, no dot-files (.env, .npmrc)
      if (d.isDirectory()) { if (d.name !== 'node_modules') queue.push(`${rel}${d.name}/`); }
      else if (d.isFile()) out.push(rel + d.name);
    }
  }
  return out;
}

async function readFiles(/** @type {any} */ tag) {
  if (tag.type !== 'git') return walk(tag.path);
  const r = await git(tag.path, ['ls-files', '-z'], { maxBuffer: 32 << 20 });
  if (r.err) throw r.err; // listFiles answers [] and keeps nothing
  return r.stdout.split('\0').filter(Boolean).slice(0, GIT_MAX);
}

/** @type {{key: string, at: number, p: Promise<string[]>} | null} */
let memo = null; // ONE entry (the last tag), no growing cache; a failed read is not kept
function tagFiles(/** @type {any} */ tag) {
  const key = `${tag.type}:${tag.path}`;
  if (!memo || memo.key !== key || Date.now() - memo.at > FILES_MS) {
    const p = readFiles(tag);
    memo = { key, at: Date.now(), p };
    p.catch(() => { if (memo?.p === p) memo = null; });
    setTimeout(() => { if (memo?.p === p) memo = null; }, FILES_MS).unref(); // freed after 30 s: 50k paths do not idle in the heap
  }
  return memo.p;
}

// → {files: [path] ≤ limit, more}: a path or one of its folders / its file name starts with q first, then paths that hold q.
// No cursor: typing narrows the list (a list route's page limit still applies: default 20, max 100).
async function listFiles(/** @type {any} */ tag, /** @type {string} */ q, /** @type {number} */ limit) {
  if (typeof tag?.path !== 'string') return { files: [], more: false };
  const all = await tagFiles(tag).catch(() => /** @type {string[]} */ ([])), low = q.toLowerCase();
  const first = [], rest = [];
  for (const f of all) {
    const l = f.toLowerCase();
    if (l.startsWith(low) || l.includes(`/${low}`)) first.push(f);
    else if (l.includes(low)) rest.push(f);
  }
  const hits = first.concat(rest);
  return { files: hits.slice(0, limit), more: hits.length > limit };
}

module.exports = { listFiles };
