'use strict';
// verbs: every tb command word (lib/cli.js CMDS + GROUPS: test/hooks.test.js checks them against `tb help`) and the
// read-only ones. A leaf, no require (full-access-runs Phase 3 security review): hooks/bash-guard.js loads it on every
// Bash call, and a throw at its load would exit the hook before io.run's fail-closed path (Bash unguarded).
// MUTATING (speed bump, critic C): every verb but the reads, so a new verb is refused until it is listed as a read. tb
// refuses them when TBX_RUN (a board run's key) is in its env; bash-guard denies them by name. Bumps, not walls: a
// scripted curl with the token still works (plan Risk 1).
const VERBS = ['list', 'grep', 'get', 'show', 'add', 'new', 'set', 'move', 'done', 'rm', 'promote', 'notify-test', 'open', 'doctor', 'gc', 'logs',
  'resume', 'restart', 'cancel', 'assign', 'answer', 'scope', 'rework', 'pass', 'push', 'close', 'lavish', 'gates', 'report', 'interventions',
  'approve', 'reject', 'health', 'tag', 'eval', 'config', 'set-sandbox', 'note', 'hold', 'handback'];
const READ_VERBS = ['list', 'grep', 'get', 'show', 'logs', 'gates', 'report', 'interventions', 'health'];
const MUTATING = VERBS.filter((v) => !READ_VERBS.includes(v));

module.exports = { VERBS, READ_VERBS, MUTATING };
