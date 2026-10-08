#!/usr/bin/env node
'use strict';
// bash-guard: PreToolUse hook for Bash (spec §7, plan D35, §3b). Denies agent commands that reach for tbd
// (token, session, socket, HTTP port), broad kills (pkill, kill 0/-1/-pgid), launchctl, nested claude, git push,
// tb mutations, or drive the heavy slot by hand.
// Rewrites (updatedInput) a command whose simple commands start with a TB_HEAVY prefix (JSON array, matched
// by leading words, after keywords/VAR=value/env/timeout/nice/nohup/command wrappers, by basename, also inside
// `sh -c '…'`) to `tbx heavy -- sh -c '<whole command>'`; pins jest --maxWorkers=2, playwright --workers=1.
// No permissionDecision on a rewrite: the phase's permission rules still judge the rewritten command.
// Best effort, split on shell operators without parsing quotes: the sandbox is the real wall (D35).
const path = require('node:path');
const { run, deny } = require('./io');

const VERBS = 'new|add|set|done|move|rm|promote|assign|answer|approve|reject|scope|pass|resume|restart|cancel|tag|open|notify-test|doctor|gc';
const STATUS = 'use `tbx status` for read-only system state';
const SEP = /(&&|\|\||[;&|\n()`])/; // captured: split + join gives the command back unchanged
// Words that run the next command (keywords, env/nice/timeout...), skipped with their options to find the command word.
const WRAP = new Set(['time', 'exec', '!', '{', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', 'env', 'command', 'nohup', 'timeout', 'nice']);
const OPT_ARG = new Set(['-u', '-k', '-s', '-n']); // wrapper options with a separate value (env -u, timeout -k/-s, nice -n)
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const LAUNCHCTL = new Set(['kickstart', 'bootout', 'bootstrap', 'unload', 'load', 'stop', 'start', 'remove', 'kill', 'submit', 'enable', 'disable']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = (s) => s.slice(s.lastIndexOf('/') + 1);

/** @returns {[RegExp, string][]} */
function rules(env) {
  const port = /^\d{1,5}$/.test(env.TB_PORT ?? '') ? env.TB_PORT : '7777';
  const home = env.TBD_SOCK ? `|${esc(path.dirname(env.TBD_SOCK))}/(token|session)\\b` : ''; // live TB_HOME
  // loopback spellings: localhost[.], 127.x (short, octal-padded), 0.0.0.0, decimal/hex 127.0.0.1, [::1], [::ffff:127.0.0.1]
  const host = String.raw`\b(localhost\.?|0*127(\.\d{1,3}){1,3}|0\.0\.0\.0|2130706433|0x7f000001)|\[(::1?|::ffff:(127(\.\d{1,3}){3}|7f00:1))\]`;
  return [
    [/\btbx["']?\s+heavy\b/, 'tbx heavy is added for you on heavy commands; run the plain command (e.g. `npm test`)'],
    [/\bTBX_LEASE\b/, 'TBX_LEASE belongs to tbx; do not read or set it'],
    [new RegExp(`\\.taskboard/(token|session)\\b${home}`), `the taskboard token and session are private to tb; ${STATUS}`],
    [/\btbd\.sock\b/, `talk to tbd only through tbx; ${STATUS}`],
    [new RegExp(`(${host})(:|\\s+)${port}\\b`, 'i'), `tbd's HTTP API is off limits to agents; ${STATUS}`],
    [/\b(pkill|killall)\b/, 'broad kills hit other runs; stop only processes you started, by pid'],
    [/\bgit(\s+-[Cc]\s+\S+|\s+--[\w-]+(=\S+)?)*\s+push\b/, 'agents never push; commit your work, the pipeline pushes after the final gate'],
    [new RegExp(`(^|[^\\w.-])(tb|taskboard-axi)\\s+(${VERBS})(?![\\w-])`), `the board changes only through the pipeline, not agent commands; ${STATUS}`],
  ];
}

// Tokens of one simple command: text without quotes/backslashes, from/to offsets in seg. An open quote runs to the end.
function tokens(seg) {
  const re = /(?:[^\s'"\\]|\\.?|'[^']*(?:'|$)|"(?:[^"\\]|\\.?)*(?:"|$))+/g;
  return Array.from(seg.matchAll(re), (m) => ({ text: m[0].replace(/["'\\]/g, ''), from: m.index, to: m.index + m[0].length }));
}

// Index of the command word: past keywords, VAR=value (quoted values are one token) and wrappers with their options.
function head(t) {
  let i = 0;
  while (i < t.length) {
    const b = base(t[i].text);
    if (/^\w+=/.test(t[i].text)) i++;
    else if (WRAP.has(b)) {
      i++;
      while (t[i]?.text.startsWith('-')) i += OPT_ARG.has(t[i].text) ? 2 : 1;
      if (b === 'timeout' && /^[\d.]+[smhd]?$/.test(t[i]?.text ?? '')) i++; // duration
    } else break;
  }
  return i;
}

// Index of `name` as the command word (direct, by path, or via npx/yarn/pnpm/bunx), else -1.
function at(w, name) {
  const i = ['npx', 'yarn', 'pnpm', 'bunx'].includes(base(w[0] ?? '')) ? 1 : 0;
  return w[i] && base(w[i]) === name ? i : -1;
}

// kill targets that hit more than one process: 0 (own group), -1 (everything), -pgid (a group).
function killsGroup(args) {
  let sig = false;
  let tail = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!tail && a === '--') tail = true;
    else if (!tail && (a === '-s' || a === '-n')) { i++; sig = true; }
    else if (!tail && !sig && /^-[A-Za-z0-9]/.test(a)) sig = true; // the signal, e.g. -9, -TERM
    else if (/^-?\d+$/.test(a) && Number(a) <= 0) return true;
  }
  return false;
}

// Why a simple command (words after the wrappers) is off limits, else null.
function denyWhy(w) {
  const b = base(w[0] ?? '');
  if (b === 'kill' && killsGroup(w.slice(1))) return 'kill 0, -1 and process groups hit other runs; stop only processes you started, by pid';
  if (b === 'launchctl' && w.some((x) => LAUNCHCTL.has(x))) return 'launchctl would change the live services; leave launchd alone and note the need in your report';
  if (at(w, 'claude') >= 0 && w.some((x) => x === '-p' || x === '--print' || x === '--dangerously-skip-permissions')) return 'agents do not start nested claude sessions; use the subagent tool for delegated work';
  return null;
}

// Pins worker flags to `want` (replaces every `flag` match) or, with none, inserts it after the token at offset `to`.
const pin = (seg, flag, want, to) => (seg.match(flag) ? seg.replace(flag, want) : `${seg.slice(0, to)} ${want}${seg.slice(to)}`);

// Walks the simple commands of cmd (and one level of `sh -c '…'` text per depth) → {heavy, deny, out: cmd with worker pins}.
function scan(cmd, heavy, depth = 0) {
  let isHeavy = false;
  let why = null;
  const out = cmd.split(SEP).map((seg, i) => {
    if (i % 2) return seg;
    const t = tokens(seg);
    const h = head(t);
    const w = t.slice(h).map((x) => x.text);
    if (heavy.some((p) => base(w[0] ?? '') === base(p[0]) && p.every((x, j) => !j || w[j] === x))) isHeavy = true;
    why ??= denyWhy(w);
    if (depth < 3 && SHELLS.has(base(w[0] ?? ''))) {
      const c = w.findIndex((x, j) => j && /^-[a-z]*c[a-z]*$/i.test(x));
      const inner = c > 0 ? t[h + c + 1] : null;
      if (!inner) return seg;
      const raw = seg.slice(inner.from, inner.to);
      const q = /^['"]/.test(raw) ? 1 : 0;
      const end = q && raw.length > 1 && raw.endsWith(raw[0]) ? raw.length - 1 : raw.length;
      const r = scan(raw.slice(q, end), heavy, depth + 1);
      isHeavy ||= r.heavy;
      why ??= r.deny;
      return seg.slice(0, inner.from + q) + r.out + seg.slice(inner.from + end);
    }
    if (at(w, 'jest') >= 0) return pin(seg, /--maxWorkers(=|\s+)\S+|(?<=\s)-w\s+\S+/g, '--maxWorkers=2', t[h + at(w, 'jest')].to);
    const p = at(w, 'playwright');
    if (p >= 0 && w[p + 1] === 'test') return pin(seg, /--workers(=|\s+)\S+|(?<=\s)-j\s+\S+/g, '--workers=1', t[h + p + 1].to);
    return seg;
  }).join('');
  return { heavy: isHeavy, deny: why, out };
}

function heavyList(env) {
  if (!env.TB_HEAVY) return [];
  try {
    const list = JSON.parse(env.TB_HEAVY);
    if (Array.isArray(list) && list.every((p) => typeof p === 'string' && p.trim())) return list.map((p) => p.trim().split(/\s+/));
  } catch { /* reported below */ }
  console.error('bash-guard: TB_HEAVY must be a JSON array of command prefixes; no heavy rewrite');
  return [];
}

// → {deny: reason} | {command: rewritten} | null (allow unchanged)
function guard(command, env = process.env) {
  for (const [re, why] of rules(env)) if (re.test(command)) return { deny: `bash-guard: ${why}` };
  const r = scan(command, heavyList(env));
  if (r.deny) return { deny: `bash-guard: ${r.deny}` };
  // $TB_CODE is expanded by the agent's shell (the runner sets it), so a PATH-shadowed tbx cannot take the slot's place
  const out = r.heavy ? `${env.TB_CODE ? '"$TB_CODE/bin/tbx"' : 'tbx'} heavy -- sh -c '${r.out.replaceAll("'", "'\\''")}'` : r.out;
  return out === command ? null : { command: out };
}

if (require.main === module) {
  run('bash-guard', ({ tool_input: input }) => {
    if (typeof input?.command !== 'string') return null;
    const r = guard(input.command);
    if (!r) return null;
    return r.deny ? deny(r.deny) : { updatedInput: { ...input, command: r.command } };
  });
}

module.exports = { guard };
