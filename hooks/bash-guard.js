#!/usr/bin/env node
'use strict';
// bash-guard: PreToolUse hook for Bash (spec §7, plan D35, §3b). Denies agent commands that reach for tbd
// (token, session, socket, HTTP port), broad kills (pkill, kill 0/-1/-pgid), launchctl, nested claude, git push,
// tb mutations, Claude config (.claude, CLAUDE.md: S1), or drive the heavy slot by hand. J8 (P4): a CLAUDE.md
// name passes only where every simple command naming it just reads (cat, head, git log/show/diff…) and nothing
// redirects into it; .claude/ stays off limits whole. J16 (P4e): in planning (TB_PHASE), git only reads: no option
// that writes a file, leaves the repo, runs a program or a pager, no VAR=value in front, and no redirect into a file
// (S2 belt). S3: no RegExp is built from agent text; main() denies a check that runs past 3 s (fail closed, io.run).
// P5 (D5, RO2): in working, no npx / npm exec / pnpm dlx / yarn dlx: they fetch and run a package outside the lockfile
// (a dependency is Irfan's call: NEEDS_SCOPE with packages); local tools run as ./node_modules/.bin/<tool> or npm scripts.
// D-0107 (SEC-6) + H1: every read-only phase (RO: planning, final_gate, review, context) gets planning's rules whole:
// J16's git rules (`git log --output=x` wrote a file in a phase that only reads; --ext-diff / --textconv / -c ran
// programs), the redirect rule and the export / GIT_* rule (guard()).
// M5 C7 (D-0087): in qa and final_gate, no dropdb, no DROP DATABASE / SCHEMA (SQL /*…*/ and -- comments read as space),
// no psql TRUNCATE and no postgres-irfan-axi with --yes (its confirmed writes), case-insensitive, read with quotes and
// backslashes taken out (`--y''es`). A line naming a DB tool with a shell expansion ($x, ${…}, $(…), $'…', `…`, an
// unquoted glob or {a,b}), or whose command word the shell builds next to -axi / psql text, is refused whole.
// Rewrites (updatedInput) a command whose simple commands start with a TB_HEAVY prefix (JSON array, matched
// by leading words, after keywords/VAR=value/env/timeout/nice/nohup/command wrappers, by basename, also inside
// `sh -c '…'`) to `tbx heavy -- sh -c '<whole command>'`; pins jest --maxWorkers=2, playwright --workers=1.
// No permissionDecision on a rewrite: the phase's permission rules still judge the rewritten command.
// Best effort, split on shell operators without parsing quotes (redirects: outside quotes, D-0093): the sandbox is the
// real wall (D35).
const path = require('node:path');
const { run, deny } = require('./io');

const VERBS = 'new|add|set|done|move|rm|promote|assign|answer|approve|reject|scope|pass|resume|restart|cancel|tag|open|notify-test|doctor|gc';
const STATUS = 'use `tbx status` for read-only system state';
const SEP = /(&&|\|\||[;&|\n()`])/; // captured: split + join gives the command back unchanged
const SEP_AT = new RegExp(SEP.source, 'y');
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
// H1: the read-only phases (J16 git rules, no export / GIT_*=, no file redirect); WHO names the phase in the message.
const WHO = { planning: 'planning', final_gate: 'the final gate', review: 'review', context: 'context' };
const RO = Object.keys(WHO);
const PLAN_REDIRECT = (who) => `${who} only reads: no redirect into a file (only > /dev/null, 2>&1); read the output directly`;
const FETCH_RUN = 'npx, npm exec, pnpm dlx and yarn dlx fetch and run packages outside the lockfile; run ./node_modules/.bin/<tool> or an npm script, or return NEEDS_SCOPE with the package';
// the command words fetch a package and run it: npx, pnpx, bunx; <pm> [-flags] exec | x | dlx | init | create (npm init <x>
// and create fetch too; plain `npm init` is harmless, denied anyway: fail closed)
const FETCHERS = { npm: ['exec', 'x', 'init', 'create'], pnpm: ['dlx', 'create'], yarn: ['dlx', 'create'], bun: ['x', 'create'] };
const fetchRun = (w) => ['npx', 'pnpx', 'bunx'].includes(base(w[0] ?? '')) || !!(Object.hasOwn(FETCHERS, base(w[0] ?? '')) && FETCHERS[base(w[0])].includes(w.slice(1).find((x) => !x.startsWith('-'))));
const DB_PHASES = ['qa', 'final_gate'];
const DB_WHY = 'qa and final review never drop a database or schema (dropdb, DROP DATABASE / SCHEMA, psql TRUNCATE), confirm a postgres-irfan-axi write (--yes) or build a DB command with shell expansion ($x, ${…}, $(…), `…`, globs, {a,b}); read with its query command and literal words, name the write you need in your result';
const DB_TOOL = /postgres-irfan|psql|dropdb|\bpg_[a-z]/i;
const EXPAND = /`|(?<!\$)\$[\w'"({[@*#?!-]/; // $name, ${, $(, $', $", $[, $@ and the other specials, a backtick; not SQL's $$
const GLOB = /[*?]|\[[^\s\]]*\]|\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/; // outside quotes: *, ?, [x], {a,b}, {1..3}
function dbBad(cmd) {
  const c = cmd.replace(/["'\\]/g, ''); // as the shell reads it: `--y''es` and `-\-yes` are --yes
  const sql = c.replace(/\/\*[\s\S]*\*\//g, ' '); // first /* to last */: nested comments too
  if (/\bdropdb\b|\bdrop(?:\s|--[^\n]*\n)+(?:database|schema)\b/i.test(sql) || (/\bpsql\b/i.test(c) && /\btruncate\b/i.test(sql))) return true;
  if (/postgres-irfan-axi/i.test(c) && /--yes\b/i.test(c)) return true;
  if (DB_TOOL.test(c) && (EXPAND.test(cmd) || GLOB.test(cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '')))) return true;
  // a command word the shell builds (`$a$b`, `${p}-axi`) on a line with -axi / psql text in it
  return /-axi|psql/i.test(c) && cmd.split(SEP).some((seg, i) => {
    const t = i % 2 ? [] : tokens(seg);
    const w = t[head(t)];
    return !!w && /[$`]/.test(seg.slice(w.from, w.to));
  });
}
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

// D-0093: cmd.split(SEP), but cut only outside quotes, so a quoted `()=>{x}` or `a>b` stays one word. null where this
// reading of the quotes could part from the shell's (the caller then cuts at every SEP, as before: fail closed): an
// open quote, a comment, a heredoc, $'…', a backtick, or $( ${ $[ inside "…" (bash honours '…' in "${x#'"'}").
function cut(cmd) {
  const out = [];
  let from = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') i++;
    else if (c === "'") {
      i = cmd.indexOf("'", i + 1);
      if (i < 0) return null;
    } else if (c === '"') {
      for (i++; cmd[i] !== '"'; i++) {
        if (i >= cmd.length || cmd[i] === '`' || (cmd[i] === '$' && '({['.includes(cmd[i + 1] ?? '-'))) return null;
        if (cmd[i] === '\\') i++;
      }
    } else if (c === '#' || c === '`' || cmd.startsWith('<<', i) || cmd.startsWith("$'", i)) return null;
    else {
      SEP_AT.lastIndex = i;
      const m = SEP_AT.exec(cmd);
      if (m) {
        out.push(cmd.slice(from, i), m[0]);
        from = i + m[0].length;
        i = from - 1;
      }
    }
  }
  out.push(cmd.slice(from));
  return out;
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
function redirectWhy(t, all, k, planning) { // planning: the phase name of a read-only phase, else ''
  const raw = all[k];
  const next = all[k + 1];
  for (let i = 0; i < t.length; i++) {
    const bare = raw.slice(t[i].from, t[i].to).replace(/\\.|'[^']*'?|"(?:[^"\\]|\\.)*"?/g, '');
    if (!bare.includes('>')) continue;
    const target = t[i].text.slice(t[i].text.lastIndexOf('>') + 1) || t[i + 1]?.text || '';
    if (MD.test(target)) return CONFIG;
    if (planning && target !== '/dev/null' && !(!target && next === '&' && /^\s*(\d+|-)(\s|$)/.test(all[k + 2] ?? ''))) return PLAN_REDIRECT(WHO[planning] ?? planning);
    if (/[{$`]/.test(target) || (!target && next === '`')) return DYNAMIC;
    if (!/[*?[]/.test(target)) continue;
    if (target.length > 200 || target.includes('[')) return CONFIG; // a glob we don't read: refused
    const g = base(target).toLowerCase();
    if (MD_NAMES.some((n) => globHit(g, n))) return CONFIG;
  }
  return null;
}

// D-0093: redirectWhy over cut(cmd) (a `>` inside quotes is no redirect) and over the scripts a shell (`sh -c`, also
// behind xargs / find -exec / sudo / setsid) or eval runs: every word after -c or eval, plain quotes off; a word quoted
// in parts or with a backslash loses every quote and backslash (fail closed).
function redirects(cmd, planning, depth = 0) {
  const all = cut(cmd) ?? cmd.split(SEP);
  for (let k = 0; k < all.length; k += 2) {
    const t = tokens(all[k]);
    const why = redirectWhy(t, all, k, planning);
    if (why) return why;
    const h = head(t);
    const s = t.findIndex((x, j) => j >= h && (SHELLS.has(base(x.text)) || x.text === 'eval'));
    if (depth >= 3 || s < 0) continue;
    const c = t[s].text === 'eval' ? s : t.findIndex((x, j) => j > s && /^-[a-z]*c[a-z]*$/i.test(x.text));
    for (const x of c >= 0 ? t.slice(c + 1) : []) {
      const raw = all[k].slice(x.from, x.to);
      const r = redirects(/^('[^']*'|"[^"\\]*")$/.test(raw) ? raw.slice(1, -1) : x.text, planning, depth + 1);
      if (r) return r;
    }
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

// J16: why a read-only phase's (RO) simple command may not run (git with a write/exec option, or env vars in front), else
// null. ro: the phase.
function planGitWhy(w, env, ro) {
  if (base(w[0] ?? '') !== 'git') return null;
  const who = WHO[ro];
  if (env) return `${who} runs git with no VAR=value in front (GIT_PAGER, GIT_EXTERNAL_DIFF, GIT_CONFIG_* run programs)`;
  let i = 1;
  while (w[i]?.startsWith('-')) i += GIT_ARG.has(w[i]) ? 2 : 1;
  const bad = w.slice(1, i).find((x) => PLAN_GIT_TOP.test(x)) ?? w.slice(1).find((x) => gitBad(x, PLAN_BAD));
  return bad ? `${who} only reads: git ${JSON.stringify(bad.slice(0, 40))} could write files, read outside the repo or run programs; use plain git log/show/diff` : null;
}

// Pins worker flags to `want` (replaces every `flag` match) or, with none, inserts it after the token at offset `to`.
const pin = (seg, flag, want, to) => (seg.match(flag) ? seg.replace(flag, want) : `${seg.slice(0, to)} ${want}${seg.slice(to)}`);

// Walks the simple commands of cmd (and one level of `sh -c '…'` text per depth) → {heavy, deny, out: cmd with worker pins}.
// ro (a read-only phase, RO): J16's git rules apply too. Redirects (and the S2 redirect rule): redirects().
function scan(cmd, heavy, depth = 0, ro = '', working = false) {
  let isHeavy = false;
  let why = null;
  const out = cmd.split(SEP).map((seg, i) => {
    if (i % 2) return seg;
    const t = tokens(seg);
    const h = head(t);
    const w = t.slice(h).map((x) => x.text);
    if (heavy.some((p) => base(w[0] ?? '') === base(p[0]) && p.every((x, j) => !j || w[j] === x))) isHeavy = true;
    const env = t.slice(0, h).some((x) => /^\w+=/.test(x.text));
    why ??= denyWhy(w, env) ?? (ro ? planGitWhy(w, env, ro) : null) ?? (working && fetchRun(w) ? FETCH_RUN : null);
    if (depth < 3 && SHELLS.has(base(w[0] ?? ''))) {
      const c = w.findIndex((x, j) => j && /^-[a-z]*c[a-z]*$/i.test(x));
      const inner = c > 0 ? t[h + c + 1] : null;
      if (!inner) return seg;
      const raw = seg.slice(inner.from, inner.to);
      const q = /^['"]/.test(raw) ? 1 : 0;
      const end = q && raw.length > 1 && raw.endsWith(raw[0]) ? raw.length - 1 : raw.length;
      const r = scan(raw.slice(q, end), heavy, depth + 1, ro, working);
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
  if (DB_PHASES.includes(env.TB_PHASE ?? '') && dbBad(command)) return { deny: `bash-guard: ${DB_WHY}` };
  // read-only phases (J16, H1): an env var set by `export GIT_PAGER=…; git log` sits outside git's own words
  const ro = RO.includes(env.TB_PHASE ?? '') ? env.TB_PHASE : '';
  if (ro && /(^|[\s;&|(`])(export|declare|typeset|readonly)\b|\bGIT_\w*=/.test(command)) {
    return { deny: `bash-guard: ${WHO[ro]} only reads: no export/declare or GIT_* variables (they make git run programs)` };
  }
  const r = scan(command, heavyList(env), 0, ro, env.TB_PHASE === 'working');
  const why = r.deny ?? redirects(command, ro);
  if (why) return { deny: `bash-guard: ${why}` };
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
