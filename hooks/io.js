'use strict';
// Shared plumbing for the Claude Code hook scripts (code.claude.com/docs/en/hooks): hook JSON on stdin,
// optional {"hookSpecificOutput": {...}} on stdout, exit 0. A hook's own failure never blocks work:
// bad input, a throw, or 5 s without stdin → allow + a note on stderr.
function run(name, fn) {
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
    try { input = JSON.parse(text); } catch { return allow('hook input is not JSON'); }
    try {
      const out = await fn(input ?? {});
      if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, ...out } }) + '\n');
    } catch (e) {
      allow(e.message);
    }
  });
}

const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

module.exports = { run, deny };
