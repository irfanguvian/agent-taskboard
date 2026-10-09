'use strict';
// util: helpers shared by more than one module.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

// The env of every claude child: runs (lib/spawn.js adds the run's own vars) and doctor's checks of the same binary,
// so doctor checks exactly what runs get (spec §9). Allowlist (S2/S3, D-0024): a shell's basics, nothing else of
// whatever started tbd, so no API key, OAuth token, ANTHROPIC_* / CLAUDE* override, push credential, TB_* var or
// NODE_OPTIONS can reach a run. Login: the claude.ai keychain entry (needs HOME only).
const CLAUDE_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
const claudeEnv = (/** @type {Record<string, string | undefined>} */ env) => ({ ...pick(CLAUDE_ENV, env), DISABLE_AUTOUPDATER: '1' });

module.exports = { isObj, minimalEnv, GIT_SAFE, GIT_ENV, claudeEnv, DEFAULT_PIN };
