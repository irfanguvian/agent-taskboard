#!/usr/bin/env node
'use strict';
// ram-guard: dev-session hook for this 8 GB Mac (D-0021; froze 2026-10-08 under 4 claude procs + tests + Chrome).
// Wired in .claude/settings.local.json (local, not committed):
//   PreToolUse Agent|Task → deny when free RAM < MIN_FREE, MAX_AGENTS already run, or a 2nd lacks SECOND_FREE (locked);
//   PreToolUse TeamCreate|Workflow → always deny (many claude processes at once);
//   PreToolUse Bash → deny heavy commands (tests, tsc, real claude, browser) when free RAM < MIN_FREE;
//   SubagentStart → agent file (id + transcript) replaces a reservation; SubagentStop → removes it.
// Free RAM = kern.memorystatus_level (= memory_pressure free %, D-0016). Any hook failure allows (hooks/io.js).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, deny } = require('../hooks/io');

const MIN_FREE = 25; // % free (D-0021); calibration knob
const MAX_AGENTS = 2; // Irfan 2026-10-09 "limit subagent 2 max" (D-0026; D-0025 had 3, D-0023 2, D-0021 1)
const SECOND_FREE = 40; // % free the 2nd parallel agent needs
const DIR = path.join(os.tmpdir(), 'claude-ram-guard'); // TMPDIR is wiped on reboot, so a crash leaves nothing behind
const LOCK = path.join(DIR, '.lock'); // one decision at a time: parallel Agent calls must not both see a free slot
const IDLE_MS = 15 * 60_000; // Bash caps one tool call at 10 min: a live agent writes its transcript at least that often
const RESERVE_MS = 60_000; // taken by PreToolUse but never started (the call failed or was denied elsewhere)
const HEAVY = /\b(npm (run )?test|node --test|tsc|npm run typecheck|chrome-devtools-axi|contain-smoke)\b|\bclaude\b[^|;&]*\s(-p|--print)\b/;

function freePct() {
  const out = execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8', timeout: 2000 }).trim();
  if (!/^\d+$/.test(out)) throw new Error(`sysctl gave "${out}"`);
  return Number(out);
}

// mkdir is atomic; a lock older than 5 s is a crashed hook's. Busy for ~2 s → throw → the hook allows (fail open).
async function locked(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 5000) fs.rmdirSync(LOCK); } catch { /* gone meanwhile */ }
      if (i > 100) throw new Error('lock busy');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try { return fn(); } finally { fs.rmdirSync(LOCK); }
}

// agent-<id> = a started agent (live while its transcript or the file moved in IDLE_MS); res-* = a reservation from
// PreToolUse not started yet (live RESERVE_MS). Stale entries are removed on the way.
function live() {
  const out = { agents: [], res: [] };
  for (const name of fs.readdirSync(DIR)) {
    const p = path.join(DIR, name);
    let last;
    try { last = fs.statSync(p).mtimeMs; } catch { continue; }
    if (name.startsWith('agent-')) {
      try { last = Math.max(last, fs.statSync(JSON.parse(fs.readFileSync(p, 'utf8')).transcript).mtimeMs); } catch { /* not written yet */ }
      if (Date.now() - last < IDLE_MS) out.agents.push(p); else fs.rmSync(p, { force: true });
    } else if (name.startsWith('res-')) {
      if (Date.now() - last < RESERVE_MS) out.res.push(p); else fs.rmSync(p, { force: true });
    }
  }
  return out;
}

const agentFile = (id) => (typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? path.join(DIR, `agent-${id}`) : null);

const lowRam = (pct) => deny(`RAM low (${pct}% free, need ${MIN_FREE}%): close apps (Chrome, Spotify) or wait, then retry`);

run('ram-guard', (input) => {
  const tool = input.tool_name;
  switch (input.hook_event_name) {
    case 'SubagentStart': {
      const file = agentFile(input.agent_id);
      if (!file) return null;
      const transcript = input.agent_transcript_path
        ?? (input.transcript_path && path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents', `agent-${input.agent_id}.jsonl`));
      return locked(() => {
        const { res } = live();
        if (res.length) fs.rmSync(res[0], { force: true }); // this agent's reservation (any one: they are alike)
        fs.writeFileSync(file, JSON.stringify({ transcript }));
        return null;
      });
    }
    case 'SubagentStop': {
      const file = agentFile(input.agent_id);
      if (file) fs.rmSync(file, { force: true });
      return null;
    }
    case 'PreToolUse':
      if (tool === 'TeamCreate' || tool === 'Workflow') return deny('D-0021: no agent teams or workflows on this 8 GB Mac; use one Agent at a time');
      if (tool === 'Bash') {
        if (!HEAVY.test(input.tool_input?.command ?? '')) return null;
        const pct = freePct();
        return pct < MIN_FREE ? lowRam(pct) : null;
      }
      if (tool === 'Agent' || tool === 'Task') {
        const pct = freePct();
        if (pct < MIN_FREE) return lowRam(pct);
        return locked(() => {
          const { agents, res } = live();
          const n = agents.length + res.length;
          if (n >= MAX_AGENTS) return deny(`D-0021: ${n} subagents already run (max ${MAX_AGENTS}); wait or do this yourself (stale? rm -r ${DIR})`);
          if (n >= 1 && pct < SECOND_FREE) return deny(`RAM: parallel subagent #${n + 1} needs ${SECOND_FREE}% free (${pct}% now); wait or do this yourself`);
          fs.writeFileSync(path.join(DIR, `res-${process.pid}-${Date.now()}`), '');
          return null;
        });
      }
      return null;
    default:
      return null;
  }
});
