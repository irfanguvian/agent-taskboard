#!/usr/bin/env node
'use strict';
// path-guard: PreToolUse hook for Edit|Write|NotebookEdit|MultiEdit (plan P2 contract). Denies a write whose
// target (symlinks resolved) is outside every root in env TB_WRITE_ROOTS (JSON array of absolute dirs), has a
// `..` segment (resolved lexically it could dodge a symlinked dir), is agent-planted config (S1: a `.claude` dir or a
// CLAUDE.md / CLAUDE.local.md at any depth under the root, any case: APFS ignores it), or is a hardlinked file (nlink > 1).
// Early warning only: the runner's scope diff is the proof. Unset TB_WRITE_ROOTS → allow everything.
const fs = require('node:fs');
const path = require('node:path');
const { run, deny } = require('./io');

// Real path of p; for a path that does not exist yet, the real path of its deepest existing ancestor + the rest.
// A dangling symlink resolves to where it points, since a write follows it.
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try { return real(path.resolve(path.dirname(p), fs.readlinkSync(p))); } catch { /* not a symlink */ }
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const dotdot = (p) => /(^|\/)\.\.(\/|$)/.test(p);

// rel: a path relative to its write root. The next run in that root would load it (.claude hooks run unsandboxed).
const planted = (rel) => {
  const seg = rel.toLowerCase().split(path.sep);
  return seg.includes('.claude') || ['claude.md', 'claude.local.md'].includes(seg.at(-1) ?? '');
};

// Hardlinked file: the name is inside a root but the inode may be shared with a file outside.
function hardlinked(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false; // does not exist yet
  }
}

function check(input, env = process.env) {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof target !== 'string' || !env.TB_WRITE_ROOTS) return null;
  const roots = JSON.parse(env.TB_WRITE_ROOTS); // a throw allows (io.run), with a stderr note
  if (!Array.isArray(roots)) throw new Error('TB_WRITE_ROOTS must be a JSON array');
  const cwd = input.cwd || process.cwd();
  if (dotdot(target) || dotdot(cwd)) return deny(`path-guard: ${target} has a ".." segment; write to a path inside the writable roots (${roots.join(', ')}) without ".."`);
  const lexical = path.resolve(cwd, target);
  const file = real(lexical);
  const root = roots.find((r) => typeof r === 'string' && path.isAbsolute(r) && inside(real(r), file));
  if (!root) return deny(`path-guard: ${target} is outside this run's writable roots (${roots.join(', ')}); write only inside them`);
  // both spellings: a symlink named .claude points elsewhere, a symlink elsewhere points into .claude
  if (planted(path.relative(real(root), file)) || planted(path.relative(root, lexical))) {
    return deny(`path-guard: ${target} is Claude config (.claude/, CLAUDE.md); agents never write it, the next run would load it`);
  }
  if (hardlinked(file)) return deny(`path-guard: ${target} is a hardlink (its inode may be shared with a file outside this run); copy it (cp f f.new && mv f.new f) and edit the copy`);
  return null;
}

if (require.main === module) run('path-guard', (input) => check(input));

module.exports = { check };
