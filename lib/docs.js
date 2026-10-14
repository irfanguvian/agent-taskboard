'use strict';
// docs (M5 C8, D-0088): the QA agent writes its report + screenshots to the worktree's docs/verification/, the final
// review its verdict + verification doc to docs/verdicts/ + docs/verification/. tbd never commits nor gitignores them,
// and the rules are about changes, not presence (a repo may track files there). D-0097: only reports and screenshots
// are docs (*.md, *.png under a docs dir: isDocKeep): any other file there could steer a check (a .d.ts tsc loads, a
// __mocks__ file). D-0101: a kept md / png is runnable too (CJS require), so the docs live in the worktree only during
// qa / final: the task + working gates keep none (untracked = dirty, cleaned) and qa.handle takes them out at the
// visit's end (clean). A commit that changes any path under a docs dir is red (isDoc: task.js scope, task + working
// gate). mirror(t), after each QA and final result: a copy of the docs under tickets/<id>/docs/ that outlives the
// worktree (tb gc removes worktrees only).
// The files are an agent's (a trust boundary, A01): the walk never follows a link (dirent types, a dir's realpath
// inside the worktree before it is read), regular files with one link only, each one's realpath inside the worktree,
// copied by util.copyPlain (lstat + O_NOFOLLOW + same inode) to 0600. Caps: 200 entries looked at (files and dirs
// alike: a dir bomb costs nothing), 5 MB a file, 20 MB in all. ponytail: path checks, so a process of the agent still
// alive could swap a dir for a link between the realpath and the open (a file that grows while copyPlain reads it is
// refused: it reads st.size + 1 bytes at most); the run's process group is gone by then (only an escaped child
// could), an fd-relative walk (openat) if ever needed.
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const { copyPlain, within, isFile, git } = require('./util');

const DOC_DIRS = ['docs/verification/', 'docs/verdicts/'];
const MAX_ENTRIES = 200;
const FILE_MAX = 5 * 1024 * 1024;
const TOTAL_MAX = 20 * 1024 * 1024;

/** p: a worktree-relative git path → is it under a docs dir */
const isDoc = (/** @type {string} */ p) => DOC_DIRS.some((d) => p.startsWith(d));
// D-0097: a report or a screenshot. Case-insensitive like git's own -e match on an APFS repo (core.ignorecase true):
// what clean keeps, the dirty checks skip (a lower-case-only test would call a kept A.MD dirty)
const isDocKeep = (/** @type {string} */ p) => isDoc(p) && /\.(md|png)$/i.test(p);
// git clean -e args keeping exactly those: per docs dir and extension a pattern, then its dir form negated, so a dir
// named x.md is walked into and what it holds judged by its own name. ponytail: used by the final gate in M5.3
const CLEAN_KEEP = DOC_DIRS.flatMap((d) => ['md', 'png'].flatMap((x) => ['-e', `/${d}**/*.${x}`, '-e', `!/${d}**/*.${x}/`]));
/** spawn.dirtyPaths lines of worktree wt minus the kept docs that are plain files (a link named x.md is not: a check
 * could walk through it) */
async function dropDocs(/** @type {string} */ wt, /** @type {string[]} */ lines) {
  const kept = await Promise.all(lines.map((l) => isDocKeep(l.slice(3)) && isFile(path.join(wt, l.slice(3)))));
  return lines.filter((_, i) => !kept[i]);
}

/** The kept docs (isDocKeep) of t's worktree → tickets/<id>/docs/<verification|verdicts>/... (0600). → {copied, skipped}; throws only
 * when t has no worktree (none set, or gone). */
async function mirror(/** @type {any} */ t) {
  const root = await fsp.realpath(t.worktree);
  const out = store.ticketDir(t.id);
  const r = { copied: 0, skipped: 0 };
  let seen = 0;
  let bytes = 0;
  const copy = async (/** @type {string} */ rel) => {
    try {
      const src = path.join(root, rel);
      if (!within(await fsp.realpath(src), root)) return false;
      const dest = path.join(out, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      let size = 0;
      await copyPlain(src, dest, 0o600, (st) => {
        if (st.nlink > 1) throw new Error('a hard link'); // its other name may be any file the agent could link
        if (st.size > FILE_MAX || bytes + st.size > TOTAL_MAX) throw new Error('over the size caps');
        size = st.size;
      });
      bytes += size;
      return true;
    } catch {
      return false;
    }
  };
  const walk = async (/** @type {string} */ rel) => {
    const dir = path.join(root, rel);
    const d = within(await fsp.realpath(dir).catch(() => ''), root) ? await fsp.opendir(dir).catch(() => null) : null;
    if (!d) return void r.skipped++;
    for await (const e of d) {
      if (++seen > MAX_ENTRIES) return void r.skipped++;
      if (e.isDirectory()) await walk(path.join(rel, e.name));
      else if (e.isFile() && isDocKeep(path.join(rel, e.name)) && (await copy(path.join(rel, e.name)))) r.copied++;
      else r.skipped++; // a link, a socket, not an md / png, a file over a cap or gone meanwhile
    }
  };
  for (const d of DOC_DIRS.map((x) => x.slice(0, -1))) { // no trailing / : lstat would follow a link there
    const st = await fsp.lstat(path.join(root, d)).catch(() => null);
    if (st?.isDirectory()) await walk(d);
    else if (st) r.skipped++; // a link in place of the dir
  }
  return r;
}

/** D-0101: the untracked files under DOC_DIRS (ignored ones, nested repos too; a link goes as a link, never followed)
 * out of t's worktree; tracked files there stay. Run after mirror(t). Throws when git fails. */
async function clean(/** @type {any} */ t) {
  const r = await git(t.worktree, ['clean', '-ffdxq', '--', ...DOC_DIRS.map((d) => d.slice(0, -1))], { dirs: t });
  if (r.err) throw new Error(`git clean of the docs dirs in ${t.worktree}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`);
}

module.exports = { DOC_DIRS, CLEAN_KEEP, isDoc, isDocKeep, dropDocs, mirror, clean };
