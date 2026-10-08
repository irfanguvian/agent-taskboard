'use strict';
// util: helpers shared by more than one module.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What a child process gets when it may run repo code: a shell's basics and nothing else (H8).
const MINIMAL_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const minimalEnv = (/** @type {Record<string, string | undefined>} */ env) =>
  Object.fromEntries(MINIMAL_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

// git in a repo or worktree an agent could have written to: its config must never run code in tbd (H11).
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']; // before -C / --git-dir
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

module.exports = { isObj, minimalEnv, GIT_SAFE, GIT_ENV };
