'use strict';
// Shared plumbing for the Claude Code hook scripts (code.claude.com/docs/en/hooks): hook JSON on stdin,
// optional {"hookSpecificOutput": {...}} on stdout, exit 0. A hook's own failure never blocks work:
// bad input, a throw, or 5 s without stdin → allow + a note on stderr.
// opts.deadline (ms) + opts.late (reason), S3: fn's sync work stops at the deadline (vm watchdog: a timer can't cut a
// busy regex or loop) and the call is denied with `late` (bash-guard fails closed). Without them a stuck hook waits
// for Claude's own hook timeout, which allows.
const vm = require('node:vm');

function run(name, fn, { deadline = 0, late = '' } = {}) {
  const allow = (why) => {
    console.error(`${name}: ${why}; allowing`);
    process.exit(0);
  };
  const timer = setTimeout(() => allow('no hook input within 5 s'), 5000);
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (text += c));
  process.stdin.on('end', async () => {
    clearTimeout(timer);
    let input;
    try { input = JSON.parse(text) ?? {}; } catch { return allow('hook input is not JSON'); }
    let out;
    try {
      out = await (deadline ? vm.runInNewContext('fn(input)', { fn, input }, { timeout: deadline }) : fn(input));
    } catch (e) {
      if (!deadline || e?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') return allow(e?.message);
      console.error(`${name}: no answer within ${deadline} ms; denying`);
      out = deny(late);
    }
    if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, ...out } }) + '\n');
  });
}

const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

module.exports = { run, deny };
