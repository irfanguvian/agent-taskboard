#!/usr/bin/env node
'use strict';
// plan-check: PreToolUse hook on StructuredOutput, wired only in phases/code/planning/settings.json (contract J15,
// spike D-0038: claude -p --json-schema runs it on the result call; a deny's reason reaches the model, which fixes the
// result and calls again in the same session). Rules: lib/plan-rules.js, the same check the runner repeats after the
// run. Ctx: runs/<n>.plan-ctx.json, written by tbd before the spawn (TB_PLAN_CTX; the agent can't write runs/).
// Fail open: a missing or garbled ctx, bad input or a git error → allow + one stderr line (io.run): the runner is
// authoritative. Runs outside the sandbox: paths in the result reach only git's batch check, never the file system.
// L1: TB_PLAN_CTX unset or relative, or a ctx for another dir than the hook input's cwd (when it names one) → allow
// + stderr too.
const fs = require('node:fs');
const path = require('node:path');
const { run, deny } = require('./io');
const { check } = require('../lib/plan-rules');

const CAP = 4000; // characters of reasons in one deny

if (require.main === module) {
  run('plan-check', async ({ tool_input: out, cwd }) => {
    if (out === null || typeof out !== 'object' || Array.isArray(out)) throw new Error('tool_input is not an object'); // bad input → allow (runner judges)
    const file = process.env.TB_PLAN_CTX;
    if (!file || !path.isAbsolute(file)) throw new Error('TB_PLAN_CTX is not an absolute path'); // never <cwd>/undefined
    const ctx = JSON.parse(fs.readFileSync(file, 'utf8')); // own process: sync is fine
    if (typeof cwd === 'string') { // the session's cwd: the worktree, or a dir in it after a Bash `cd`
      if (typeof ctx.cwd !== 'string') throw new Error('ctx has no cwd');
      const root = fs.realpathSync(ctx.cwd); // a temp TB_HOME sits under /var → /private/var; a missing dir throws → allow
      const here = fs.realpathSync(cwd);
      if (here !== root && !here.startsWith(root + path.sep)) throw new Error(`ctx is for ${JSON.stringify(ctx.cwd)}, not this run's cwd ${JSON.stringify(cwd)}`);
    }
    const why = (await check(out, ctx)).join('\n');
    if (!why) return null;
    return deny(`${why.length > CAP ? `${why.slice(0, CAP)}...` : why}\nfix these and call StructuredOutput again`);
  });
}
