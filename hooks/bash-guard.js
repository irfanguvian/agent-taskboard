#!/usr/bin/env node
'use strict';
// bash-guard: PreToolUse hook for Bash (spec §7, plan D35, §3b). Denies agent commands that reach for tbd
// (token, session, socket, HTTP port), broad kills (pkill, kill 0/-1/-pgid), launchctl, nested claude, git push,
// tb mutations, Claude config (.claude, CLAUDE.md: S1), or drive the heavy slot by hand. J8 (P4): a CLAUDE.md
// name passes only where every simple command naming it just reads (cat, head, git log/show/diff…) and nothing
// redirects into it; .claude/ stays off limits whole. J16 (P4e): in planning (TB_PHASE), git only reads: no option
// that writes a file, leaves the repo, runs a program or a pager, no VAR=value in front, and no redirect into a file
// (S2 belt). S3: no RegExp is built from agent text; main() denies a check that runs past 3 s (fail closed, io.run).
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
// J8: commands that only read the files they name (no pager: LESSOPEN runs a command). git: these subcommands, with -C /
// --no-pager only before them.
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'diff', 'ls', 'stat', 'file']);
const GIT_READ = new Set(['log', 'show', 'diff', 'blame', 'status', 'ls-files', 'ls-tree', 'cat-file', 'grep']);
const MD = /(^|[^\w.-])claude(\.local)?\.md(?![\w.-])/i;
const MD_NAMES = ['claude.md', 'claude.local.md'];
const CONFIG = 'Claude config (.claude/, CLAUDE.md) is off limits to Bash; read it with the Read tool, never write it';
const DYNAMIC = 'a redirect target the shell builds ($VAR, ${...}, `...`, {a,b}) could name Claude config; redirect to a literal file name';
const LAUNCHCTL = new Set(['kickstart', 'bootout', 'bootstrap', 'unload', 'load', 'stop', 'start', 'remove', 'kill', 'submit', 'enable', 'disable']);
// git options a reader (J8) may not use: write a file, run a program or a pager (and -O). J16 planning, anywhere, also:
// read outside the repo (--no-index), textconv, set config (--config-env, --exec-path); before the subcommand -c, -p.
const READ_BAD = ['output', 'ext-diff', 'open-files-in-pager'];
const PLAN_BAD = [...READ_BAD, 'no-index', 'textconv', 'config-env', 'exec-path'];
const PLAN_GIT_TOP = /^(-c|-p$|--paginate$)/;
const PLAN_REDIRECT = 'planning only reads: no redirect into a file (only > /dev/null, 2>&1); read the output directly';
const GIT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']); // global options taking the next word
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
    // S1 belt (by name; the sandbox write-deny is the wall): the next run would load what is written there. .claude/:
    // reads too. CLAUDE.md: a redirect into it here; a command naming it that is no reader: scan()
    [/(^|[^\w.-])\.claude(?![\w.-])/i, CONFIG],
    [/(>|<>)[>|]?\s*["']?[^\s;&|<>"']*claude(\.local)?\.md(?![\w.-])/i, CONFIG],
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

// L2: git takes any unique prefix of a long option (`--outp=x` is `--output=x`): a --name of 2+ characters that starts
// one of `bad` is that option (an exact name wins in git: `--text` is diff -a, not --textconv).
function gitBad(x, bad) {
  const m = /^--([\w-]{2,})/.exec(x);
  return x.startsWith('-O') || (!!m && m[1] !== 'text' && bad.some((o) => o.startsWith(m[1])));
}

// S3: does glob g (`*` any run, `?` one character; lower case, no `[`) match name? One pass with one backtrack point
// (the last `*`): O(glob x name), name <= 15 characters. A RegExp built from the glob took 15 s+ on 22 stars.
function globHit(g, name) {
  let i = 0;
  let j = 0;
  let star = -1;
  let from = 0;
  while (j < name.length) {
    if (g[i] === '?' || (g[i] !== '*' && g[i] === name[j])) { i++; j++; }
    else if (g[i] === '*') { star = i++; from = j; }
    else if (star >= 0) { i = star + 1; j = ++from; }
    else return false;
  }
  while (g[i] === '*') i++;
  return i === g.length;
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

// J8: the simple command only reads (a reader, or git with a read subcommand and no file output, external diff or
// pager that opens files: `git grep -O`).
function reads(w) {
  const b = base(w[0] ?? '');
  if (READERS.has(b)) return true;
  if (b !== 'git') return false;
  let i = 1;
  while (w[i] === '-C' || w[i] === '--no-pager') i += w[i] === '-C' ? 2 : 1;
  return GIT_READ.has(w[i]) && !w.some((x) => gitBad(x, READ_BAD));
}

// J8: a redirect into CLAUDE.md however it is spelled: the target is the token after an unquoted `>` (or the rest of a
// token holding one), its quotes and backslashes gone (`> "CLAUDE".md`, `> CLAUDE\.md`), or a glob that could match it
// (`> C*.md`, `> CLAU?E.md`: globHit) → CONFIG; a glob over 200 characters or with `[` → CONFIG unread. A target the
// shell builds ($, {, a backtick: SEP cut it, `next` is that separator) → DYNAMIC. Planning (S2 belt): no redirect into
// any file but /dev/null; fd copies (`2>&1`, `>&2`: `next` is `&`, the part after it a number) pass.
// t: tokens(all[k]); all: the split command; k: this segment's index. → why, or null.
function redirectWhy(t, all, k, planning) {
  const raw = all[k];
  const next = all[k + 1];
  for (let i = 0; i < t.length; i++) {
    const bare = raw.slice(t[i].from, t[i].to).replace(/\\.|'[^']*'?|"(?:[^"\\]|\\.)*"?/g, '');
    if (!bare.includes('>')) continue;
    const target = t[i].text.slice(t[i].text.lastIndexOf('>') + 1) || t[i + 1]?.text || '';
    if (MD.test(target)) return CONFIG;
    if (planning && target !== '/dev/null' && !(!target && next === '&' && /^\s*(\d+|-)(\s|$)/.test(all[k + 2] ?? ''))) return PLAN_REDIRECT;
    if (/[{$`]/.test(target) || (!target && next === '`')) return DYNAMIC;
    if (!/[*?[]/.test(target)) continue;
    if (target.length > 200 || target.includes('[')) return CONFIG; // a glob we don't read: refused
    const g = base(target).toLowerCase();
    if (MD_NAMES.some((n) => globHit(g, n))) return CONFIG;
  }
  return null;
}

// Why a simple command (words after the wrappers; env: it had VAR=value before them) is off limits, else null. A reader
// with env vars in front (GIT_EXTERNAL_DIFF, GIT_CONFIG_*, LESSOPEN) can run a command: no reader then.
function denyWhy(w, env = false) {
  const b = base(w[0] ?? '');
  if (w.some((x) => MD.test(x)) && (env || !reads(w))) return CONFIG;
  if (b === 'kill' && killsGroup(w.slice(1))) return 'kill 0, -1 and process groups hit other runs; stop only processes you started, by pid';
  if (b === 'launchctl' && w.some((x) => LAUNCHCTL.has(x))) return 'launchctl would change the live services; leave launchd alone and note the need in your report';
  if (at(w, 'claude') >= 0 && w.some((x) => x === '-p' || x === '--print' || x === '--dangerously-skip-permissions')) return 'agents do not start nested claude sessions; use the subagent tool for delegated work';
  return null;
}

// J16: why a planning run's simple command may not run (git with a write/exec option, or env vars in front), else null.
function planGitWhy(w, env) {
  if (base(w[0] ?? '') !== 'git') return null;
  if (env) return 'planning runs git with no VAR=value in front (GIT_PAGER, GIT_EXTERNAL_DIFF, GIT_CONFIG_* run programs)';
  let i = 1;
  while (w[i]?.startsWith('-')) i += GIT_ARG.has(w[i]) ? 2 : 1;
  const bad = w.slice(1, i).find((x) => PLAN_GIT_TOP.test(x)) ?? w.slice(1).find((x) => gitBad(x, PLAN_BAD));
  return bad ? `planning only reads: git ${JSON.stringify(bad.slice(0, 40))} could write files, read outside the repo or run programs; use plain git log/show/diff` : null;
}

// Pins worker flags to `want` (replaces every `flag` match) or, with none, inserts it after the token at offset `to`.
const pin = (seg, flag, want, to) => (seg.match(flag) ? seg.replace(flag, want) : `${seg.slice(0, to)} ${want}${seg.slice(to)}`);

// Walks the simple commands of cmd (and one level of `sh -c '…'` text per depth) → {heavy, deny, out: cmd with worker pins}.
// planning: J16's git rules and the S2 redirect rule apply too.
function scan(cmd, heavy, depth = 0, planning = false) {
  let isHeavy = false;
  let why = null;
  const out = cmd.split(SEP).map((seg, i, all) => {
    if (i % 2) return seg;
    const t = tokens(seg);
    const h = head(t);
    const w = t.slice(h).map((x) => x.text);
    if (heavy.some((p) => base(w[0] ?? '') === base(p[0]) && p.every((x, j) => !j || w[j] === x))) isHeavy = true;
    const env = t.slice(0, h).some((x) => /^\w+=/.test(x.text));
    why ??= denyWhy(w, env) ?? (planning ? planGitWhy(w, env) : null) ?? redirectWhy(t, all, i, planning);
    if (depth < 3 && SHELLS.has(base(w[0] ?? ''))) {
      const c = w.findIndex((x, j) => j && /^-[a-z]*c[a-z]*$/i.test(x));
      const inner = c > 0 ? t[h + c + 1] : null;
      if (!inner) return seg;
      const raw = seg.slice(inner.from, inner.to);
      const q = /^['"]/.test(raw) ? 1 : 0;
      const end = q && raw.length > 1 && raw.endsWith(raw[0]) ? raw.length - 1 : raw.length;
      const r = scan(raw.slice(q, end), heavy, depth + 1, planning);
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
  // planning (J16): an env var set by `export GIT_PAGER=…; git log` sits outside git's own words
  if (env.TB_PHASE === 'planning' && /(^|[\s;&|(`])(export|declare|typeset|readonly)\b|\bGIT_\w*=/.test(command)) {
    return { deny: 'bash-guard: planning only reads: no export/declare or GIT_* variables (they make git run programs)' };
  }
  const r = scan(command, heavyList(env), 0, env.TB_PHASE === 'planning');
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
  }, { deadline: 3000, late: 'bash-guard: took too long; command refused' }); // S3: fail closed
}

module.exports = { guard };
