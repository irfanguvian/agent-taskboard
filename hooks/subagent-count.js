#!/usr/bin/env node
'use strict';
// subagent-count: per-session subagent budget (spec §6). Wire it to three events:
//   PreToolUse matcher "Agent" (claude 2.1.292's subagent tool; "Task" is its legacy alias) → subagent.request,
//   denied once the session spent config.subagents.per_session_total;
//   SubagentStart / SubagentStop → subagent.start / subagent.stop (live n/3 on the card).
// tbd unreachable (2 s timeout) or refusing: subagent.request is denied (the budget can't be checked, so fail
// closed); start/stop are allowed with a stderr note (a lost live count never blocks the agent's work).
const { run, deny } = require('./io');
const { call, sockPath } = require('../lib/slots');

const OPS = { PreToolUse: 'subagent.request', SubagentStart: 'subagent.start', SubagentStop: 'subagent.stop' };

run('subagent-count', async (input) => {
  const op = OPS[input.hook_event_name];
  if (!op || typeof input.session_id !== 'string') return null;
  if (op === 'subagent.request' && input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;
  let res;
  try {
    res = await call(sockPath(), { op, session: input.session_id, ...(process.env.TBX_RUN && { run: process.env.TBX_RUN }) }, { timeoutMs: 2000 }); // run key: sessions are per run
  } catch (e) {
    if (op === 'subagent.request') return deny('tbd unreachable; do it yourself');
    console.error(`subagent-count: tbd not reachable (${e.message}); allowing`);
    return null;
  }
  return op === 'subagent.request' && !res.ok ? deny(res.message ?? `tbd refused (${res.error}); do it yourself`) : null;
});
