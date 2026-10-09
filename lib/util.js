'use strict';
// util: helpers shared by more than one module.
const fsp = require('node:fs/promises');
const path = require('node:path');
const sh = require('./sh');

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// p is root or inside it (both real paths)
const within = (/** @type {string} */ p, /** @type {string} */ root) => p === root || p.startsWith(root + path.sep);
// a plain file (lstat): a link is never read through
const isFile = (/** @type {string} */ p) => fsp.lstat(p).then((s) => s.isFile(), () => false);
// a ticket's planning rounds: rounds/NN-questions.json, rounds/NN-plan.json (NN = the round, 2+ digits; P4 U5)
const ROUND_RE = /^(\d{2,})-(questions|plan)\.json$/;

// The claude version new installs pin (spec §9). AC12 upgrade (README): fake suite, real smoke, then this default
// (Irfan 2026-10-09). One place: doctor, store's default claude_bin, scripts/chaos.js and scripts/contain-smoke.js.
const DEFAULT_PIN = '2.1.295';

// What a child process gets when it may run repo code: a shell's basics and nothing else (H8).
const MINIMAL_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const pick = (/** @type {string[]} */ keys, /** @type {Record<string, string | undefined>} */ env) =>
  Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const minimalEnv = (/** @type {Record<string, string | undefined>} */ env) => pick(MINIMAL_ENV, env);

// git in a repo or worktree an agent could have written to: its config must never run code in tbd (H11).
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']; // before -C / --git-dir
// GIT_NO_REPLACE_OBJECTS: a refs/replace ref (shared refs an agent may write) never swaps the content git checks out
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const GIT = '/usr/bin/git';

// Every git tbd runs (D31, D35d): argv only, GIT_SAFE + GIT_ENV, a minimal env (picked from env), a timeout; sh-shaped
// (never rejects). dirs (S1): a ticket's git_dir + common_dir, recorded at assign right after `worktree add`, pinned in
// the env with cwd as the work tree, so git never reads the worktree's .git file (the agent's to rewrite: a planted
// config's filter would run in tbd as Irfan). git 2.50 still reads refs through <git_dir>/commondir (a plain file, also
// writable by an agent that writes .git): it must resolve to common_dir, else git is refused (err, nothing run). No
// git_dir (a ticket from before the fix): git finds them itself, as before. ceiling: GIT_CEILING_DIRECTORIES. exec: an
// sh-shaped fake (tests).
async function commonOf(/** @type {string} */ gitDir) {
  const f = path.join(gitDir, 'commondir');
  if (!(await fsp.lstat(f).then((st) => st.isFile(), () => false))) return null; // a link is never followed
  // git strips only the trailing newline (`../.. ` with a space is another dir): never trim more than git does. No
  // path.resolve: it folds `..` before links are followed, git follows them first (`L/../../..` with L a link)
  const d = (await fsp.readFile(f, 'utf8')).replace(/[\r\n]+$/, '');
  return fsp.realpath(path.isAbsolute(d) ? d : `${gitDir}/${d}`).catch(() => null);
}
async function git(/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{timeout?: number, input?: string, maxBuffer?: number, dirs?: any, env?: Record<string, string | undefined>, ceiling?: string, exec?: Function}} */ o = {}) {
  const { timeout = 20_000, input, maxBuffer, dirs, env = process.env, ceiling, exec = sh } = o;
  const pin = dirs?.git_dir ? { GIT_DIR: dirs.git_dir, GIT_COMMON_DIR: dirs.common_dir, GIT_WORK_TREE: cwd, GIT_NO_LAZY_FETCH: '1' } : {};
  if (dirs?.git_dir) {
    const cd = await commonOf(dirs.git_dir);
    if (cd !== dirs.common_dir) {
      const msg = `${dirs.git_dir}/commondir leads to ${cd ?? '(not a plain file)'}, not ${dirs.common_dir}: git refused in ${cwd}`;
      return { err: Object.assign(new Error(msg), { code: 'PLANTED' }), stdout: '', stderr: msg }; // runner: Blocked at once, not crash retries
    }
  }
  return exec(GIT, [...GIT_SAFE, '-C', cwd, ...args], {
    env: { ...minimalEnv(env), ...GIT_ENV, ...pin, ...(ceiling && { GIT_CEILING_DIRECTORIES: ceiling }) },
    timeout, ...(input !== undefined && { input }), ...(maxBuffer && { maxBuffer }),
  });
}

// The env of every claude child: runs (lib/spawn.js adds the run's own vars) and doctor's checks of the same binary,
// so doctor checks exactly what runs get (spec §9). Allowlist (S2/S3, D-0024): a shell's basics, nothing else of
// whatever started tbd, so no API key, OAuth token, ANTHROPIC_* / CLAUDE* override, push credential, TB_* var or
// NODE_OPTIONS can reach a run. Login: the claude.ai keychain entry (needs HOME only).
const CLAUDE_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
const claudeEnv = (/** @type {Record<string, string | undefined>} */ env) => ({ ...pick(CLAUDE_ENV, env), DISABLE_AUTOUPDATER: '1' });

// src, a plain file (lstat; check(st) may refuse more), copied to a new dest at mode: doctor's pin (H7), approve's env
// files (P4b U9). O_NOFOLLOW + the same inode close the gap between the lstat and the open; 'wx' after the rm: never
// written through a planted file or link.
async function copyPlain(/** @type {string} */ src, /** @type {string} */ dest, /** @type {number} */ mode, check = (/** @type {import('node:fs').Stats} */ _st) => {}) {
  const st = await fsp.lstat(src);
  if (!st.isFile()) throw new Error(`${src} is not a plain file (symlinks are refused)`);
  check(st);
  const from = await fsp.open(src, fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
  try {
    const opened = await from.stat();
    if (opened.ino !== st.ino || opened.dev !== st.dev) throw new Error(`${src} changed while it was being copied`);
    await fsp.rm(dest, { force: true });
    const to = await fsp.open(dest, 'wx', mode);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n = 1; n > 0;) {
        n = (await from.read(buf, 0, buf.length, null)).bytesRead;
        if (n) await to.writeFile(buf.subarray(0, n));
      }
      await to.chmod(mode);
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

module.exports = { isObj, within, isFile, ROUND_RE, minimalEnv, GIT, GIT_SAFE, GIT_ENV, git, claudeEnv, DEFAULT_PIN, copyPlain };
