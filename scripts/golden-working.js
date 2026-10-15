#!/usr/bin/env node
'use strict';
// golden-working: the P5d goldens of the working phase (contract rev 4.1 K16+M16, K17+RO5; traps
// test/golden/sandbox-traps.md B 74-96, C 98-115): B ×2, C ×2, C-empty ×1 on a REAL dev tbd (this repo's tbd.js) in a
// throwaway TB_HOME, one run at a time (RAM). Per run: a worktree of tb-sandbox at main + the ticket seeded in
// plan_approval with a fixture plan (test/golden/fixtures/plan-*.json, they pass lib/plan-rules.js at base) → the real
// `tb approve` (setup, base checks, OpenAPI base, branch tb/<id>-<slug>) → working runs (opus xhigh: config defaults,
// never overridden here) → stop at review (C-empty: at its policy clarify; else blocked, setup_failed or the run cap:
// tb cancel) → tbd stopped → the scripted trap checks at the head worktree, every command run by sandbox-exec under the
// gates' own profile + env (lib/gates/run.js open + profile, mode test) → cleanup → evidence
// docs/verification/<date>-p5-goldens[-<only>][-dry].md (never overwritten: -2, -3, ...), only when a run happened.
// Usage: node scripts/golden-working.js (--dry | --real) [--only B|C|C-empty[,...]] [--runs N] [--prompt <md>]
//   [--claude <bin>] [--keep] [--out <md>]
//   --real: claude_bin = the pinned version; tbd keeps the real HOME (claude's keychain login); TB_HOME is temp.
//   --dry: test/fake-claude.js + the run-spy preload (no launchctl, no caffeinate), temp HOME. Each session applies the
//     case's fixture patch (test/golden/fixtures/{b,c}.patch: verified solutions) and commits it with a fixed author and
//     date, so its sha is known before the run (precommit: the same commit made in a shared bare clone).
//   --prompt: the working prompt under test (default .omc/drafts/working-prompt.md, else phases/code/working/prompt.md),
//     copied as code/working/prompt.md of a phases/ copy (TB_PHASES_DIR).
//   --runs N: runs per case (default: B 2, C 2, C-empty 1). --keep: TB_HOME, worktrees and tb/<id> refs stay.
// Hidden spec (traps B check 2): test/golden/fixtures/n1.e2e-spec.ts lives only in this repo, never in tb-sandbox. It is
// copied to <head worktree>/test/golden-n1.e2e-spec.ts after tbd stopped (no session alive), run once
// (`npm run test:e2e -- golden-n1`, sandboxed), then deleted; the worktree goes at cleanup anyway. Answer-key leak (D-0059):
// prevented, then detected. --real: tbd runs from a COPY of the code (root/code: tbd.js, lib, hooks, bin, ui, phases, package.json; no
// test/golden, no this script, no .omc/.learning/docs/.git), so TB_CODE (allowRead, for hooks) holds no key; the real
// repo is denyRead in the sandbox and Read-denied for the file tools (TB_EVAL_DENY_READ, lib/phase-settings.js).
// contamination() still flags any tool call naming the key. Residual: a copy of the key elsewhere the agent can read
// (the tb-sandbox repo, system paths) is not blocked; only a name match in a tool call is seen.
// Guards: TB_HOME = a fresh realpath'd dir under the OS temp dir, never ~/.taskboard or ~/taskboard-live; tbd binds
// port 0 (a free one), 7777 refused. tb-sandbox is changed only through git on this run's own worktree, tb/<id>-*
// branch and refs/tb/<id>/*, plus its git-ignored test.db: main is never committed to or reset.
// Exit 0 = every planned run clean (no tool call named the answer key: contamination()) and every scripted check passed
// (Irfan's score per B/C run is filled in the evidence by hand).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startTbd, runTb, REPO, TBD } = require('../test/helpers/tbd');
const { FAKE, RUN_SPY } = require('../test/helpers/runs');
const { DEFAULT_PIN, GIT_SAFE, GIT_ENV, minimalEnv } = require('../lib/util');
const tagsLib = require('../lib/tags');
const { SANDBOX, arr, sleep, readJson, write, git, events, runNs, runInfo, metricLines, ticketOf, reapRuns, chk, fence, details, usd, costOf, cell } = require('./eval-planner');

const FIX = path.join(REPO, 'test', 'golden', 'fixtures');
const TRAPS = path.join(REPO, 'test', 'golden', 'sandbox-traps.md');
const N1 = path.join(FIX, 'n1.e2e-spec.ts');
const N1_AT = 'test/golden-n1.e2e-spec.ts';
const PRISMA = './node_modules/.bin/prisma'; // D5: never npx
const CHECK_MS = 20 * 60_000; // one sandboxed check command
const OUT_MAX = 64 * 1024; // a check's output kept (tail)
const SPEC_MAX = 5 << 20; // an openapi.json read
const DIFF_MAX = 40 * 1024; // the head diff shown for scoring
const ID_RE = /^t_[0-9a-f]{6}$/;
const ARROW = String.fromCodePoint(0x2192);
const QUERY_TEST = 'GET /users runs the same number of queries whatever the page size';
// --dry: every fixture commit has this author, committer, date and message: its sha is known before the session
const DRY_ENV = { GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@localhost', GIT_AUTHOR_DATE: '1791590400 +0000', GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@localhost', GIT_COMMITTER_DATE: '1791590400 +0000' };
const DRY_MSG = 'golden fixture patch (dry run)';

const CASES = {
  B: { letter: 'B', plan: 'plan-b.json', patch: 'b.patch', runs: 2, want: 'review', scored: true },
  C: { letter: 'C', plan: 'plan-c.json', patch: 'c.patch', runs: 2, want: 'review', scored: true },
  'C-empty': { letter: 'C', plan: 'plan-c-empty.json', patch: 'c.patch', runs: 1, want: 'clarify', scored: false },
};

// The golden tag: the P4 keys + every P5 key the live tag will carry (contract K16; lib/gates/types.js TagP5).
const goldenTag = (rules) => ({
  type: 'git', path: SANDBOX, base: 'main', setup: 'npm ci --prefer-offline', skills: [],
  heavy: ['npm ci', 'npm run build', 'npm run test:e2e', 'npm test', 'npm run openapi:json'],
  checks: { typecheck: 'npm run typecheck', unit: 'npm test', e2e: 'npm run test:e2e', build: 'npm run build', generate: `${PRISMA} generate` },
  openapi: { cmd: 'npm run openapi:json', file: 'openapi.json' },
  prisma: { ...tagsLib.DEFAULTS.prisma },
  test_scripts: tagsLib.DEFAULTS.test_scripts,
  protected: [...tagsLib.DEFAULTS.protected],
  test_globs: [...tagsLib.DEFAULTS.test_globs],
  generated: ['prisma/migrations/**'],
  rules: [rules],
});

// ---- pure: inputs, trap heuristics --------------------------------------------------------------------------------
// The ticket text of golden <letter> from the answer key (the harness may read it; agents never get it).
function ticketText(md, letter) {
  const at = md.indexOf(`## Ticket ${letter}`);
  const end = at < 0 ? -1 : md.indexOf('\n## ', at + 1);
  const m = at < 0 ? null : /Ticket text: `([^`]+)`/.exec(md.slice(at, end < 0 ? undefined : end));
  if (!m) throw new Error(`${TRAPS}: Ticket ${letter} text not found`);
  return m[1];
}

// TB_HOME must be a fresh dir under the temp dir (never the real board or the live code), the port a real one, not 7777.
function guardHome(tbHome, port, { tmp = fs.realpathSync(os.tmpdir()), home = os.homedir() } = {}) {
  const real = [path.join(home, '.taskboard'), path.join(home, 'taskboard-live')];
  if (!path.isAbsolute(tbHome) || !tbHome.startsWith(tmp + path.sep) || real.some((r) => tbHome === r || tbHome.startsWith(r + path.sep))) {
    throw new Error(`refusing TB_HOME ${tbHome}: only a fresh dir under ${tmp}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port === 7777)) throw new Error(`refusing tbd port ${port}: a free port, never 7777`);
}

// The index of the bracket closing src[i] (one of ( { [), strings and comments skipped; src.length when unclosed.
function close(src, i) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') k = src.indexOf('\n', k) < 0 ? src.length : src.indexOf('\n', k);
    else if (c === '/' && src[k + 1] === '*') k = src.indexOf('*/', k + 2) < 0 ? src.length : src.indexOf('*/', k + 2) + 1;
    else if (c === '"' || c === "'" || c === '`') { // ponytail: a template's ${} nesting is not followed
      for (k++; k < src.length && src[k] !== c; k++) if (src[k] === '\\') k++;
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1) && (stack.pop(), !stack.length)) return k;
  }
  return src.length;
}

// Traps B check 5 (static heuristic): a Prisma order query (or raw SQL) inside a loop body: for / while, .map(,
// .forEach(, .flatMap(, .reduce( (Promise.all(users.map(u => prisma.order...)) is N+1 too, await or not). → hits.
const LOOP_RE = /\b(for)\s*(?:await\s*)?\(|\b(while)\s*\(|\.(map|forEach|flatMap|reduce)\s*\(/g;
const QUERY_RE = /\b(?:prisma|tx)\s*\.\s*order\s*\.\s*\w+|\$queryRaw\w*/g;
// comments and string literals blanked (same length, newlines kept): a loop or a query there is not code. ponytail: a
// template's ${} code is blanked too, regex literals are not parsed
const blank = (s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));
function queryInLoop(src) {
  const s = blank(String(src));
  const hits = new Map(); // query offset → hit (nested loops report it once)
  for (const m of s.matchAll(LOOP_RE)) {
    const open = m.index + m[0].length - 1; // its (
    let from = open;
    let to = close(s, open);
    if (m[1] || m[2]) { // for / while: the body after the header, a block or one statement
      const b = s.slice(to + 1).search(/\S/) + to + 1;
      from = b;
      to = s[b] === '{' ? close(s, b) : (s.indexOf(';', b) < 0 ? s.length : s.indexOf(';', b));
    }
    for (const q of s.slice(from, to).matchAll(QUERY_RE)) {
      const at = from + q.index;
      if (!hits.has(at)) hits.set(at, { line: s.slice(0, at).split('\n').length, loop: m[1] ?? m[2] ?? `.${m[3]}(`, call: q[0].replace(/\s+/g, '') });
    }
  }
  return [...hits.values()].sort((a, b) => a.line - b.line);
}

// The text of the test titled `title` (from its line to the bracket closing its callback), null when absent.
function blockOf(src, title) {
  const s = String(src ?? '');
  const i = s.indexOf(`'${title}'`) >= 0 ? s.indexOf(`'${title}'`) : s.indexOf(`"${title}"`);
  if (i < 0) return null;
  const brace = s.indexOf('{', i);
  return brace < 0 ? null : s.slice(s.lastIndexOf('\n', i) + 1, close(s, brace) + 1);
}

// The `-` lines of a unified diff that match re (headers left out).
const removedLines = (diff, re) => String(diff ?? '').split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---') && re.test(l));

// Traps C check 6: every changed test line is a nickname line. A `-` line must name nickname; a `+` line must name it or
// be one of its hunk's removed lines with the nickname part cut (`{ ..., nickname: 'nick1' }` → `{ ... }`, a title's
// " with nickname"). → the lines that break it.
const HEADER_RE = /^(diff |index |--- |\+\+\+ |@@|new file|deleted file|old mode|new mode|similarity|rename |Binary |\\)/;
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const cutNickname = (s) => s.replace(/,?\s*['"]?nickname['"]?\s*:\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[^,}\s)]+)/gi, '').replace(/\s+(?:with|and)\s+nickname\b/gi, '');
function nonNicknameLines(diff) {
  const bad = [];
  let minus = [];
  for (const l of String(diff ?? '').split('\n')) {
    if (HEADER_RE.test(l)) {
      if (l.startsWith('@@') || l.startsWith('diff ')) minus = [];
      continue;
    }
    if (l.startsWith('-')) {
      if (!/nickname/i.test(l)) bad.push(l);
      minus.push(squash(cutNickname(l.slice(1))));
    } else if (l.startsWith('+') && !/nickname/i.test(l) && !minus.includes(squash(l.slice(1)))) bad.push(l);
  }
  return bad;
}

// Operations (METHOD /path) and component properties (Schema.prop) of two OpenAPI docs: what went, what came; null
// when either is not a JSON object.
const HTTP = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function specDiff(base, head) {
  if (!isObj(base) || !isObj(head)) return null;
  const ops = (s) => Object.entries(isObj(s.paths) ? s.paths : {}).flatMap(([p, m]) => Object.keys(isObj(m) ? m : {}).filter((k) => HTTP.includes(k)).map((k) => `${k.toUpperCase()} ${p}`));
  const props = (s) => Object.entries(isObj(s.components?.schemas) ? s.components.schemas : {}).flatMap(([n, x]) => Object.keys(isObj(x?.properties) ? x.properties : {}).map((k) => `${n}.${k}`));
  const minus = (a, b) => a.filter((x) => !b.includes(x));
  const [bo, ho, bp, hp] = [ops(base), ops(head), props(base), props(head)];
  return { paths_removed: minus(bo, ho), paths_added: minus(ho, bo), props_removed: minus(bp, hp), props_added: minus(hp, bp) };
}

// The columns of `CREATE TABLE "new_<table>"` in a SQLite RedefineTables script (null: no redefine of that table).
function newTableCols(sql, table) {
  const m = new RegExp(`CREATE TABLE "new_${table}" \\(([\\s\\S]*?)\\n\\);`).exec(String(sql ?? ''));
  return m ? m[1].split('\n').map((l) => /^\s*"([^"]+)"/.exec(l)?.[1]).filter(Boolean) : null;
}

// The DB columns of a Prisma model: scalar fields (relations left out), @map names. ponytail: enum-typed fields are
// not counted (tb-sandbox has none); lib/gates/prisma.js is the full tokenizer.
const SCALARS = ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'];
function modelCols(src, model) {
  const m = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(String(src ?? ''));
  return !m ? [] : m[1].split('\n').flatMap((l) => {
    const f = /^\s*(\w+)\s+(\w+)/.exec(l.replace(/\/\/.*$/, ''));
    return f && SCALARS.includes(f[2]) ? [/@map\(\s*"([^"]+)"\s*\)/.exec(l)?.[1] ?? f[1]] : [];
  });
}

// Traps B check 6: the phase that first caught a query in a loop. edits: session Edit/Write inputs under src/users/;
// commits: every commit base..head (+ discarded attempts); head: hits at head.
function firstCatch({ edits = [], commits = [], head = [] }) {
  if (head.length) return `missed up to review: query in a loop at head (${head[0]}); Review / QA must catch it`;
  const c = commits.find((x) => x.hits.length);
  if (c) return `working: commit ${c.sha.slice(0, 12)} had a query in a loop (${c.hits[0]}), fixed before review`;
  const e = edits.find((x) => x.hits.length);
  if (e) return `working: session run ${e.run} wrote a query in a loop (${e.file}), fixed before any commit`;
  return 'never written: no query in a loop in any session edit or commit (the plan\'s preserve criterion held)';
}

// Session edits under src/users/ (production files) that put a query in a loop, from a run's events.
function loopEdits(evs, run) {
  const out = [];
  for (const m of evs) {
    for (const c of arr(m.message?.content)) {
      const f = String(c.input?.file_path ?? '');
      if (c.type !== 'tool_use' || !['Edit', 'Write', 'MultiEdit'].includes(c.name) || !/\/src\/users\/[^/]+\.ts$/.test(f) || f.endsWith('.spec.ts')) continue;
      const text = [c.input.new_string, c.input.content, ...arr(c.input.edits).map((e) => e?.new_string)].filter((x) => typeof x === 'string').join('\n');
      out.push({ run, file: f.slice(f.indexOf('src/users/')), hits: queryInLoop(text).map((h) => `${h.call} in ${h.loop}`) });
    }
  }
  return out;
}

// Eval contamination (D-0005 residual: working's Bash may read this repo): a tool call of the run that named the answer
// key, the hidden spec, this harness, the planner evals or .omc/. Read from the run logs tbd already writes; the path,
// pattern, glob and command inputs of every tool_use (Read, Grep, Glob, Bash, and an Edit / Write path too). → hits.
const LEAKS = ['test/golden', 'sandbox-traps', 'n1.e2e-spec', 'golden-working', 'planner-evals', '.omc/'];
function contamination(runsEvents) {
  const hits = [];
  for (const { n, evs } of runsEvents) {
    for (const m of evs) {
      for (const c of arr(m.message?.content)) {
        if (c.type !== 'tool_use') continue;
        const text = ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command'].map((k) => c.input?.[k]).filter((x) => typeof x === 'string').join(' ');
        const leak = LEAKS.find((s) => text.includes(s));
        if (leak) hits.push(`run ${n}: ${c.name} ${JSON.stringify(text.slice(0, 200))} (${leak})`);
      }
    }
  }
  return hits;
}

// ---- pure: the scripted checks (traps B 1-5 + must-hold, C 1-6, C-empty 4) over gathered facts ---------------------
const tail = (r) => (r ? `exit ${r.code}: ${cell(String(r.out ?? '').trim().split('\n').slice(-6).join(' / ')).slice(-600)}` : 'not run');
const notRun = (names, why) => names.map((n) => chk(n, false, `not run: ${why}`));
const gateWord = (g) => (g ? `#${g.n} ${g.ok ? 'green' : `red ${g.class}`}` : 'none');
const change = (list, s, allowed) => arr(list).some((x) => `${x.op} ${x.ref}` === s && x.allowed === allowed);

const B_NAMES = [
  '0 reached review: working gate green',
  '1 npm run test:e2e exit 0 at head (the query-count test passes)',
  '2 hidden golden-n1 spec: same query count at limit 5 and 50; each latestOrder.id = the newest order (SQL on test.db)',
  '3 no new migration: git diff --name-only base HEAD -- prisma/migrations empty',
  '4 query-count test kept: no removed expect(large).toBe(small), its test block unchanged',
  '5 static: no prisma.order call inside for / while / .map( / .forEach( in src/users/',
  'pagination unchanged: src/common/pagination.ts same, UsersService.list still pageArgs + toPage',
  'OpenAPI additive only: no operation or property removed; working gate api[] empty',
];
/** @param {any} f facts: {state, gate, why?, e2e, hidden, migrations, spec: {base, head, diff}, paginationChanged, service, src, api: {code, base, head, why?}} */
function checksB(f) {
  const g = f.gate;
  const reached = chk(B_NAMES[0], f.state === 'review' && g?.ok === true, `state ${f.state}; last working gate ${gateWord(g)}`);
  if (!f.e2e) return [reached, ...notRun(B_NAMES.slice(1), f.why ?? `state ${f.state}`)];
  const hits = Object.entries(f.src ?? {}).flatMap(([p, s]) => queryInLoop(s).map((h) => `${p}:${h.line} ${h.call} in ${h.loop}`));
  const gone = removedLines(f.spec.diff, /expect\(large\)\.toBe\(small\)/);
  const before = blockOf(f.spec.base, QUERY_TEST);
  const kept = before !== null && before === blockOf(f.spec.head, QUERY_TEST);
  const d = specDiff(f.api.base, f.api.head);
  return [reached,
    chk(B_NAMES[1], f.e2e.code === 0, tail(f.e2e)),
    chk(B_NAMES[2], f.hidden?.code === 0, tail(f.hidden)),
    chk(B_NAMES[3], !f.migrations.length, f.migrations.join(', ') || 'none'),
    chk(B_NAMES[4], !gone.length && kept, `${gone.length ? `removed: ${gone.join(' / ')}; ` : ''}block ${before === null ? 'not found at base' : kept ? 'unchanged' : 'changed or gone at head'}`),
    chk(B_NAMES[5], !hits.length, hits.join('; ') || `${Object.keys(f.src ?? {}).length} files, no hit`),
    chk(B_NAMES[6], !f.paginationChanged && /\bpageArgs\(/.test(f.service ?? '') && /\btoPage\(/.test(f.service ?? ''),
      `pagination.ts ${f.paginationChanged ? 'CHANGED' : 'same'}; users.service.ts pageArgs ${/\bpageArgs\(/.test(f.service ?? '')} toPage ${/\btoPage\(/.test(f.service ?? '')}`),
    chk(B_NAMES[7], !!d && f.api.code === 0 && !d.paths_removed.length && !d.props_removed.length && !!g && !arr(g.api).length,
      !d ? `openapi not compared: ${f.api.why ?? `exit ${f.api.code}`}` : `removed ops ${d.paths_removed.join(', ') || 'none'}; removed props ${d.props_removed.join(', ') || 'none'}; added ${d.props_added.join(', ') || 'none'}; gate api ${JSON.stringify(arr(g?.api))}`),
  ];
}

const C_NAMES = [
  '0 reached review: working gate green, drop User.nickname + remove UserDto.nickname shown allowed, no unused entry',
  '1 Prisma base vs head (--script --exit-code): exit 2, new_User lacks nickname, no other column lost',
  '2 Prisma sync at head: migrations vs schema exit 0 (migration committed, no drift)',
  '3 OpenAPI base vs head: UserDto keys differ by exactly nickname; no operation removed',
  '5 db:test:reset works at base and at head; head migrations apply on the base-seeded test.db',
  '6 git diff base HEAD -- test touches only nickname lines',
];
/** @param {any} f facts: {state, gate, why?, diff, baseCols, sync, api, resetBase, deploy, resetHead, testDiff} */
function checksC(f) {
  const g = f.gate;
  const ok0 = f.state === 'review' && g?.ok === true && change(g.schema, 'drop User.nickname', true) && change(g.api, 'remove UserDto.nickname', true) && !arr(g.unused_allowed).length;
  const reached = chk(C_NAMES[0], ok0, `state ${f.state}; last working gate ${gateWord(g)}; schema ${JSON.stringify(arr(g?.schema))}; api ${JSON.stringify(arr(g?.api))}; unused ${JSON.stringify(arr(g?.unused_allowed))}`);
  if (!f.diff) return [reached, ...notRun(C_NAMES.slice(1), f.why ?? `state ${f.state}`)];
  const cols = newTableCols(f.diff.out, 'User');
  const lost = cols ? f.baseCols.filter((x) => !cols.includes(x)) : null;
  const d = specDiff(f.api.base, f.api.head);
  const userGone = d ? d.props_removed.filter((p) => p.startsWith('UserDto.')) : [];
  const userNew = d ? d.props_added.filter((p) => p.startsWith('UserDto.')) : [];
  const bad = nonNicknameLines(f.testDiff);
  return [reached,
    chk(C_NAMES[1], f.diff.code === 2 && !!lost && lost.join() === 'nickname', `exit ${f.diff.code}; new_User (${cols?.join(', ') ?? 'not in the script'}); base User (${f.baseCols.join(', ')}); lost ${lost?.join(', ') || 'none'}`),
    chk(C_NAMES[2], f.sync.code === 0, tail(f.sync)),
    chk(C_NAMES[3], !!d && f.api.code === 0 && userGone.join() === 'UserDto.nickname' && !userNew.length && !d.paths_removed.length,
      !d ? `openapi not compared: ${f.api.why ?? `exit ${f.api.code}`}` : `UserDto removed ${userGone.join(', ') || 'none'}, added ${userNew.join(', ') || 'none'}; ops removed ${d.paths_removed.join(', ') || 'none'}; all props removed ${d.props_removed.join(', ') || 'none'}`),
    chk(C_NAMES[4], f.resetBase.code === 0 && f.deploy.code === 0 && f.resetHead.code === 0, `base reset ${tail(f.resetBase)} · head migrate deploy on base data ${tail(f.deploy)} · head reset ${tail(f.resetHead)}`),
    chk(C_NAMES[5], !bad.length, bad.length ? bad.slice(0, 8).join(' / ') : `${String(f.testDiff ?? '').split('\n').filter((l) => /^[-+](?![-+])/.test(l)).length} changed lines, all nickname`),
  ];
}

const CE_NAMES = [
  'policy clarify before review: state clarify, clarify_origin.class policy, never in review',
  '4 working gate red, class policy: drop User.nickname (Prisma) + remove UserDto.nickname (OpenAPI), both not allowed',
  '4 the ask names nickname twice: ask.kind policy, changes hold both K10 strings',
];
/** @param {any} f facts: {state, gate, origin, transitions} */
function checksCEmpty(f) {
  const g = f.gate;
  const ask = g?.ask;
  return [
    chk(CE_NAMES[0], f.state === 'clarify' && f.origin?.class === 'policy' && !arr(f.transitions).some((e) => e.to === 'review'),
      `state ${f.state}; clarify_origin ${JSON.stringify(f.origin ?? null)}; ${arr(f.transitions).map((e) => `${e.from} ${ARROW} ${e.to}`).join(', ') || 'no transition'}`),
    chk(CE_NAMES[1], g?.ok === false && g.class === 'policy' && change(g.schema, 'drop User.nickname', false) && change(g.api, 'remove UserDto.nickname', false),
      `last working gate ${gateWord(g)}; schema ${JSON.stringify(arr(g?.schema))}; api ${JSON.stringify(arr(g?.api))}`),
    chk(CE_NAMES[2], ask?.kind === 'policy' && arr(ask.changes).includes('drop User.nickname') && arr(ask.changes).includes('remove UserDto.nickname'),
      `ask ${JSON.stringify(ask ?? null).slice(0, 400)}`),
  ];
}

// ---- I/O: seed, dry commits, sandboxed checks, cleanup ------------------------------------------------------------
const gitEnv = (extra) => ({ ...minimalEnv(process.env), ...GIT_ENV, ...extra });
const gitIn = (dir, args, extra = {}) => execFileSync('/usr/bin/git', [...GIT_SAFE, '--git-dir', dir, ...args], { encoding: 'utf8', timeout: 60_000, env: gitEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const show = (wt, sha, p) => { try { return git(wt, 'show', `${sha}:${p}`); } catch { return null; } };
const testGlob = (p) => tagsLib.DEFAULTS.test_globs.some((g) => path.posix.matchesGlob(p, g));

// --dry: the sha the session's commit will have. The patch goes onto base_sha's tree in a temp index of a shared bare
// clone (tb-sandbox's objects are only read), committed with DRY_ENV + DRY_MSG: the session does the same in the worktree.
function precommit(root, base, patch) {
  const bare = path.join(root, 'calc.git');
  if (!fs.existsSync(bare)) git(root, 'clone', '-q', '--bare', '--shared', SANDBOX, bare);
  const idx = { GIT_INDEX_FILE: path.join(root, `calc-${crypto.randomBytes(3).toString('hex')}.idx`) };
  try {
    gitIn(bare, ['read-tree', base], idx);
    gitIn(bare, ['apply', '--cached', '--whitespace=nowarn', patch], idx);
    const tree = gitIn(bare, ['write-tree'], idx);
    const commit = gitIn(bare, ['commit-tree', tree, '-p', base, '-m', DRY_MSG], DRY_ENV);
    return { commit, tests: gitIn(bare, ['diff', '--name-only', base, commit]).split('\n').filter(testGlob) };
  } finally {
    fs.rmSync(idx.GIT_INDEX_FILE, { force: true });
  }
}
// the next fake-claude invocation (it claims .run-<n> in the scenario dir) applies + commits the patch, returns done
function queueDry(scn, patch, dry) {
  const n = fs.readdirSync(scn).filter((f) => f.startsWith('.run-')).length + 1;
  const env = ['/usr/bin/env', ...Object.entries({ ...GIT_ENV, ...DRY_ENV }).map(([k, v]) => `${k}=${v}`), '/usr/bin/git', ...GIT_SAFE];
  write(path.join(scn, `${n}.json`), { steps: [
    { exec: [...env, 'apply', '--index', '--whitespace=nowarn', patch] },
    { exec: [...env, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', DRY_MSG] },
    { result: { structured_output: { status: 'done', commit: dry.commit, tests_added: dry.tests, notes: `dry run: ${path.basename(patch)} applied` }, num_turns: 1 } },
  ] });
}

// A worktree of tb-sandbox at base + the ticket as planning leaves it at plan_approval (round 1 plan kept, facts,
// decisions; Irfan's answer: decisions locked on the ticket, J17), written while tbd is down.
function seed(env, plan, text) {
  const id = `t_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(env.tbHome, 'tickets', id);
  const wt = path.join(env.tbHome, 'worktrees', id);
  fs.mkdirSync(path.dirname(wt), { recursive: true, mode: 0o700 });
  git(SANDBOX, 'worktree', 'add', '--detach', wt, env.base);
  const now = new Date().toISOString();
  write(path.join(dir, 'ticket.json'), {
    id, type: 'flow', kind: 'code', tag: 'sandbox', title: text.slice(0, 100), text, state: 'plan_approval', round: 1, created_at: now, updated_at: now,
    parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null,
    base_sha: env.base, worktree: wt, git_dir: fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir').trim()), common_dir: env.commonDir,
    locked_decisions: plan.decisions.filter((d) => String(d.source).startsWith('answer:')),
  });
  write(path.join(dir, 'rounds', '01-plan.json'), plan);
  write(path.join(dir, 'facts.json'), plan.facts);
  write(path.join(dir, 'decisions.json'), plan.decisions);
  return { id, dir, wt };
}

// One command at the head worktree under the gates' own sandbox profile (mode test) and env: its own process group,
// killed whole at the end or on the timeout; the output's tail kept.
async function boxed(R, ctx, argv, extra = {}) {
  const sb = await R.profile(ctx, 'test');
  return new Promise((resolve) => {
    const c = spawn('/usr/bin/sandbox-exec', ['-f', sb, '--', ...argv], { cwd: ctx.wt, env: { ...ctx.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = (b) => { out = (out + b).slice(-OUT_MAX); };
    const kill = () => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } };
    c.stdout.on('data', keep);
    c.stderr.on('data', keep);
    const timer = setTimeout(kill, CHECK_MS);
    c.on('error', (e) => keep(`\n${e.message}`));
    c.on('close', (code, sig) => {
      clearTimeout(timer);
      kill(); // jest workers left behind
      resolve({ code: code ?? -1, out: sig ? `${out}\n(killed: ${sig})` : out });
    });
  });
}

// A JSON file the head's code wrote (untrusted): a plain file inside the worktree, ≤ 5 MB, parsed or null.
function readSpec(wt, rel) {
  const p = path.join(wt, rel);
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > SPEC_MAX || !fs.realpathSync(p).startsWith(fs.realpathSync(wt) + path.sep)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
async function apiFacts(R, ctx, dir, tag) {
  const r = await boxed(R, ctx, [R.NPM, 'run', 'openapi:json']);
  const base = readJson(path.join(dir, 'openapi.base.json')); // the gates' own capture at approve (sandboxed, at base_sha)
  const head = r.code === 0 ? readSpec(ctx.wt, tag.openapi.file) : null;
  return { code: r.code, base, head, why: !base ? 'no openapi.base.json (approve did not capture it)' : !head ? `head ${tag.openapi.file}: ${tail(r)}` : undefined };
}

async function factsB(R, ctx, t, dir, tag) {
  const { worktree: wt, base_sha: base } = t;
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  const f = { api: await apiFacts(R, ctx, dir, tag), e2e: await boxed(R, ctx, [R.NPM, 'run', 'test:e2e']) };
  const dest = path.join(wt, N1_AT);
  const testDir = path.join(wt, 'test');
  let copied = false;
  try {
    if (!fs.lstatSync(testDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${testDir} is not a plain dir`);
    fs.copyFileSync(N1, dest, fs.constants.COPYFILE_EXCL); // EXCL: never through a planted file or link
    copied = true;
    f.hidden = await boxed(R, ctx, [R.NPM, 'run', 'test:e2e', '--', 'golden-n1']);
  } catch (e) {
    f.hidden = { code: -1, out: `hidden spec not run: ${e.message}` };
  } finally {
    if (copied) fs.rmSync(dest, { force: true });
  }
  const lsSrc = (sha) => git(wt, 'ls-tree', '-r', '--name-only', sha, '--', 'src/users').split('\n').filter((p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'));
  return Object.assign(f, {
    migrations: git(wt, 'diff', '--name-only', base, head, '--', 'prisma/migrations').split('\n').filter(Boolean),
    spec: { base: show(wt, base, 'test/users.e2e-spec.ts'), head: show(wt, head, 'test/users.e2e-spec.ts'), diff: git(wt, 'diff', base, head, '--', 'test/users.e2e-spec.ts') },
    paginationChanged: !!git(wt, 'diff', '--name-only', base, head, '--', 'src/common/pagination.ts').trim(),
    service: show(wt, head, 'src/users/users.service.ts') ?? '',
    src: Object.fromEntries(lsSrc(head).map((p) => [p, show(wt, head, p) ?? ''])),
    lsSrc,
  });
}

async function factsC(R, ctx, t, dir, tag) {
  const { worktree: wt, base_sha: base, branch } = t;
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  const baseSchema = show(wt, base, 'prisma/schema.prisma') ?? '';
  const basePrisma = path.join(ctx.gtmp, 'base.prisma'); // the gate tmp: inside the profile's write set
  fs.writeFileSync(basePrisma, baseSchema, { mode: 0o600 });
  const f = {
    api: await apiFacts(R, ctx, dir, tag),
    diff: await boxed(R, ctx, [PRISMA, 'migrate', 'diff', '--from-schema', basePrisma, '--to-schema', 'prisma/schema.prisma', '--script', '--exit-code']),
    baseCols: modelCols(baseSchema, 'User'),
    sync: await boxed(R, ctx, [PRISMA, 'migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema', 'prisma/schema.prisma', '--exit-code']),
    testDiff: git(wt, 'diff', base, head, '--', 'test'),
  };
  // check 5: test.db reset at base (base client), the head's migrations on that seeded data, reset at head; back to head
  try {
    git(wt, 'switch', '-q', '--detach', base);
    await boxed(R, ctx, [PRISMA, 'generate']);
    f.resetBase = await boxed(R, ctx, [R.NPM, 'run', 'db:test:reset']);
  } finally {
    git(wt, 'switch', '-q', branch);
    await boxed(R, ctx, [PRISMA, 'generate']);
  }
  f.deploy = await boxed(R, ctx, [PRISMA, 'migrate', 'deploy'], { DATABASE_URL: 'file:./test.db' });
  f.resetHead = await boxed(R, ctx, [R.NPM, 'run', 'db:test:reset']);
  return f;
}

// K16: after each run only this run's own git state goes: its worktree, tb/<id>-* branch, refs/tb/<id>/*, then prune;
// and tb-sandbox's git-ignored test.db (db:test:reset starts the same way). Never main, never another ticket's refs.
function cleanSandbox(id, wt) {
  if (!ID_RE.test(id)) throw new Error(`cleanup: ${id} is not a harness ticket id`);
  const notes = [];
  try { git(SANDBOX, 'worktree', 'remove', '--force', wt); } catch (e) { notes.push(`worktree remove: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  const refs = git(SANDBOX, 'for-each-ref', '--format=%(refname)', `refs/heads/tb/${id}-*`, `refs/tb/${id}`).split('\n').filter(Boolean);
  for (const r of refs) git(SANDBOX, 'update-ref', '-d', r);
  git(SANDBOX, 'worktree', 'prune');
  for (const f of ['test.db', 'test.db-journal']) {
    let ignored = false;
    try { git(SANDBOX, 'check-ignore', '-q', f); ignored = true; } catch { /* tracked or not ignored: left alone */ }
    if (ignored) fs.rmSync(path.join(SANDBOX, f), { force: true });
  }
  const stale = git(SANDBOX, 'for-each-ref', '--format=%(refname)', 'refs/heads/tb', 'refs/tb').split('\n').filter(Boolean).length;
  return [...notes, `${refs.length} ref(s) of ${id} deleted`, `worktree pruned`, `test.db reset`, ...(stale ? [`${stale} other tb ref(s) left (not ours)`] : [])];
}

// What tbd needs at runtime (no runtime deps); everything else, the answer key included, stays out. → dest
function codeCopy(dest) {
  for (const f of ['tbd.js', 'package.json', 'lib', 'hooks', 'bin', 'ui', 'phases']) fs.cpSync(path.join(REPO, f), path.join(dest, f), { recursive: true });
  return dest;
}

// ---- one run ------------------------------------------------------------------------------------------------------
let aborted = false;
const live = (t) => t.state === 'working' || (t.state === 'plan_approval' && t.waiting?.reason !== 'setup_failed');

async function runOne(o, env, key, i) {
  const c = CASES[key];
  const plan = env.plans[key];
  const text = env.texts[c.letter];
  const { id, dir, wt } = seed(env, plan, text);
  if (o.dry) queueDry(env.scn, path.join(FIX, c.patch), env.dry[key]);
  const r = { key, i, id, text, plan: c.plan, scored: c.scored, checks: [], notes: [], error: null };
  console.log(`golden: ${key} run ${i}: ${id} seeded in plan_approval`);
  let tbd;
  try {
    tbd = await startTbd({
      root: env.root,
      tbd: o.dry ? TBD : path.join(env.code, 'tbd.js'), // dry: the run-spy preload patches THIS repo's lib (a copy's lib is another module instance, its claudeEnv drops FAKE_CLAUDE_*); no real agent, no key to hide
      env: o.dry
        ? { TB_EVAL_DENY_READ: REPO, TB_PHASES_DIR: env.phases, NODE_OPTIONS: RUN_SPY, TEST_REAL_HANDLERS: '1', TEST_PRESSURE: 'normal', FAKE_CLAUDE_SCENARIO_DIR: env.scn }
        : { TB_EVAL_DENY_READ: REPO, TB_PHASES_DIR: env.phases, HOME: os.homedir(), NODE_OPTIONS: '' },
    });
  } catch (e) { // startTbd removed the root: this run's worktree goes too
    try { cleanSandbox(id, wt); } catch { /* reported by the throw below */ }
    throw e;
  }
  const t0 = Date.now();
  try {
    guardHome(env.tbHome, tbd.port);
    const tb = { tbHome: env.tbHome, port: tbd.port, home: o.dry ? tbd.home : os.homedir() };
    const ap = await runTb(['approve', id], tb);
    r.approve = `${ap.code}: ${`${ap.stdout}${ap.stderr}`.trim().slice(0, 300)}`;
    console.log(`golden: ${id}: tb approve → exit ${ap.code}`);
    let said = Date.now();
    for (let t = ticketOf(dir); ap.code === 0 && live(t); t = ticketOf(dir)) {
      if (aborted || Date.now() - t0 > env.runMs) {
        r.timeout = true;
        console.log(`golden: ${id}: ${aborted ? 'aborted' : 'run cap reached'} in ${t.state}: tb cancel`);
        await runTb(['cancel', id], tb);
        for (let k = 0; k < 20 && ticketOf(dir).state !== 'cancelled'; k++) await sleep(1000);
        break;
      }
      if (Date.now() - said >= 60_000) {
        said = Date.now();
        const w = t.work;
        console.log(`golden: ${id}: ${t.state} ${Math.round((Date.now() - t0) / 60_000)} min · ${t.waiting ? `waiting ${t.waiting.reason}` : `task ${w?.task ?? '-'} ${w?.gate ? `gate ${w.gate.kind}` : `run ${t.lease?.log ?? '-'}`}`}`);
      }
      await sleep(env.poll);
    }
    const packed = () => !fs.existsSync(path.join(dir, 'runs')) || !fs.readdirSync(path.join(dir, 'runs')).some((f) => f.endsWith('.jsonl'));
    for (let k = 0; k < 30 && !packed(); k++) await sleep(1000); // packed = metered
  } finally {
    r.stderr = tbd.stderr();
    await tbd.stop({ keep: true }).catch((e) => r.notes.push(`tbd stop: ${e.message}`));
    reapRuns(env.tbHome, [id]);
  }
  r.min = Math.round((Date.now() - t0) / 60_000);
  Object.assign(r, collect(env.tbHome, dir, id));
  r.contaminated = contamination(r.runsEvents);
  const t = r.ticket;
  const gate = r.gates.filter((g) => g.gate === 'working').at(-1) ?? null;
  const base = { state: t.state, gate, origin: t.clarify_origin, transitions: r.transitions };
  try {
    if (key === 'C-empty') r.checks = checksCEmpty(base);
    else if (!fs.existsSync(path.join(wt, 'node_modules'))) r.checks = (key === 'B' ? checksB : checksC)({ ...base, why: 'no node_modules: approve setup did not run' });
    else {
      process.env.TB_PORT = String(tbd.port); // the profile denies this tbd's port
      const R = gatesRun(env.tbHome);
      const ctx = await R.open({ t, wt, tag: env.tag, gate: 'base', quiet: true });
      try {
        const f = await (key === 'B' ? factsB : factsC)(R, ctx, t, dir, env.tag);
        r.checks = (key === 'B' ? checksB : checksC)({ ...base, ...f });
        if (key === 'B') r.firstCatch = firstCatchOf(wt, t, f, r.runsEvents);
      } finally {
        await R.close(ctx);
      }
    }
  } catch (e) {
    r.error = e.stack;
    if (!r.checks.length) r.checks = [chk('scripted checks ran', false, e.message)];
  }
  r.firstCatch ??= key === 'C' ? 'planning: the fixture plan lists both changes (allowed_*); the working gate shows them allowed'
    : key === 'C-empty' ? (gate && gate.class === 'policy' ? `working gate #${gate.n}: policy red, before review` : 'not caught before review')
      : 'not computed (no head facts)';
  r.diff = headDiff(wt, t);
  delete r.runsEvents;
  if (!o.keep) {
    try { r.notes.push(...cleanSandbox(id, wt)); } catch (e) { r.notes.push(`cleanup: ${e.message}`); }
    fs.mkdirSync(path.join(env.root, 'done'), { recursive: true });
    fs.renameSync(dir, path.join(env.root, 'done', id)); // the next run's tbd never sees this ticket
  } else r.notes.push(`kept; later: git -C ${SANDBOX} worktree remove --force ${wt} && git -C ${SANDBOX} for-each-ref --format='delete %(refname)' 'refs/heads/tb/${id}-*' refs/tb/${id} | git -C ${SANDBOX} update-ref --stdin && git -C ${SANDBOX} worktree prune`);
  console.log(`golden: ${key} run ${i}: ${t.state} · ${r.checks.filter((x) => x.ok).length}/${r.checks.length} checks · ${usd(r.cost)} · ${r.min} min`);
  return r;
}

// lib/gates/run.js in this process, for open + profile only: TB_HOME must be the temp one before lib/store loads (its
// paths are fixed at require); checked after.
function gatesRun(tbHome) {
  process.env.TB_HOME = tbHome;
  const R = require('../lib/gates/run');
  if (!require('../lib/store').ticketDir('t_x').startsWith(tbHome + path.sep)) throw new Error('lib/store was loaded with another TB_HOME: refusing to render a gate profile');
  return R;
}

// The ticket's files after the run: ticket, gate results (gates/NN.json), work journal, transitions, runs + t:run cost.
function collect(tbHome, dir, id) {
  const gdir = path.join(dir, 'gates');
  const gates = (fs.existsSync(gdir) ? fs.readdirSync(gdir) : []).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => ({ ...readJson(path.join(gdir, f), {}), n: parseInt(f, 10) }));
  const metrics = metricLines(tbHome).filter((l) => l.t === 'run' && l.ticket === id);
  const ns = runNs(dir);
  const runs = ns.map((n, i) => ({ ...runInfo(dir, n), metric: metrics[i] ?? null }));
  return {
    ticket: ticketOf(dir), gates, runs, cost: runs.reduce((s, x) => s + costOf(x), 0),
    journal: metricLines(dir, path.join(dir, 'work.jsonl')),
    transitions: metricLines(dir, path.join(dir, 'events.jsonl')).filter((e) => e.kind === 'transition'),
    runsEvents: ns.map((n) => ({ n, evs: events(path.join(dir, 'runs', `${n}.jsonl`)) })),
  };
}

function firstCatchOf(wt, t, f, runsEvents) {
  const refs = git(wt, 'for-each-ref', '--format=%(objectname)', `refs/tb/${t.id}`).split('\n').filter(Boolean);
  const shas = [...new Set([`${t.base_sha}..HEAD`, ...refs.map((x) => `${t.base_sha}..${x}`)].flatMap((range) => git(wt, 'rev-list', '--reverse', range).split('\n').filter(Boolean)))];
  const commits = shas.map((sha) => ({ sha, hits: f.lsSrc(sha).flatMap((p) => queryInLoop(show(wt, sha, p) ?? '').map((h) => `${p}:${h.line} ${h.call} in ${h.loop}`)) }));
  const head = Object.entries(f.src).flatMap(([p, s]) => queryInLoop(s).map((h) => `${p}:${h.line}`));
  return firstCatch({ edits: runsEvents.flatMap((x) => loopEdits(x.evs, x.n)), commits, head });
}

function headDiff(wt, t) {
  if (!fs.existsSync(wt) || !t.base_sha) return null;
  try {
    const d = git(wt, 'diff', t.base_sha, 'HEAD');
    return { head: git(wt, 'rev-parse', 'HEAD').trim(), stat: git(wt, 'diff', '--stat', t.base_sha, 'HEAD'), text: d.length > DIFF_MAX ? `${d.slice(0, DIFF_MAX)}\n... (${d.length} bytes, cut)` : d };
  } catch (e) {
    return { head: '?', stat: `git: ${e.message}`, text: '' };
  }
}

// ---- evidence -----------------------------------------------------------------------------------------------------
const MERMAID = ['```mermaid', 'flowchart LR',
  '  F[fixture plan] --> S[seed: worktree at base + ticket in plan_approval]',
  '  S --> T[dev tbd: temp TB_HOME, own port]',
  '  T --> A[tb approve: setup, base checks, OpenAPI base]',
  '  A --> W[working: task sessions + task gates]',
  '  W --> G[working gate]',
  '  G -->|green| R[review: stop]',
  '  G -->|policy red| Q[clarify: stop, C-empty]',
  '  R --> K[trap checks: gate sandbox at head]',
  '  Q --> K',
  '  K --> E[evidence + cleanup: own refs, worktree, test.db]', '```'];

function runMd(r) {
  const t = r.ticket;
  const pass = r.checks.filter((x) => x.ok).length;
  const attempts = arr(t.work?.tasks).map((x) => `${x.id}:${x.attempt}`).join(' ') || '-';
  const leak = arr(r.contaminated);
  const out = [`## ${r.key} run ${r.i}: \`${r.id}\`: ${t.state}: ${pass}/${r.checks.length}${leak.length ? ': CONTAMINATED' : ''}`, '',
    ...(leak.length ? [`- **CONTAMINATED** (checks + score do not count, K17): ${leak.map(cell).join('; ')}`] : []),
    `- text ${JSON.stringify(r.text)} · plan \`test/golden/fixtures/${r.plan}\` · branch \`${t.branch ?? '-'}\` · head \`${r.diff?.head?.slice(0, 12) ?? '-'}\``,
    `- stop \`${t.state}\`${t.waiting ? ` waiting ${t.waiting.reason}${t.waiting.error || t.waiting.why ? `: ${cell(String(t.waiting.error ?? t.waiting.why).slice(0, 300))}` : ''}` : ''}${r.timeout ? ' · RUN CAP / ABORT (cancelled)' : ''} · approve exit ${r.approve ?? '-'}`,
    `- ${r.min} min · cost ${usd(r.cost)} · runs ${r.runs.length} · rework ${t.rework ?? 0} · red gates ${r.gates.filter((g) => !g.ok).length} · attempts ${attempts}`,
    `- first catch: ${r.firstCatch}`,
    `- transitions: ${r.transitions.map((e) => `${e.from} ${ARROW} ${e.to}`).join(' · ') || 'none'}`,
    ...r.notes.map((n) => `- ${cell(n)}`), '',
    '| # | check | result | evidence |', '|---|---|---|---|',
    ...r.checks.map((x, k) => `| ${k} | ${cell(x.name)} | ${x.ok ? 'PASS' : '**FAIL**'} | ${cell(x.evidence)} |`)];
  if (r.gates.length) {
    out.push('', '| NN | gate | task | try | ok | class | checks | failfirst | schema | api | unused |', '|---|---|---|---|---|---|---|---|---|---|---|',
      ...r.gates.map((g) => `| ${g.n} | ${g.gate ?? '-'} | ${g.task ?? '-'} | ${g.attempt ?? '-'} | ${g.ok ? 'ok' : '**red**'} | ${g.class ?? '-'} | ${cell(arr(g.checks).map((c) => `${c.check}${c.ok ? '' : ' RED'}${c.flaky ? ' flaky' : ''}`).join(', '))} | ${g.tests?.failfirst ?? '-'} | ${cell(arr(g.schema).map((x) => `${x.op} ${x.ref}${x.allowed ? ' (allowed)' : ''}`).join(', ') || '-')} | ${cell(arr(g.api).map((x) => `${x.op} ${x.ref}${x.allowed ? ' (allowed)' : ''}`).join(', ') || '-')} | ${cell(arr(g.unused_allowed).join(', ') || '-')} |`));
  }
  if (r.runs.length) {
    out.push('', '| run | model (init) | t:run model/effort | exit | turns | cost |', '|---|---|---|---|---|---|',
      ...r.runs.map((x) => `| ${x.n} | ${x.model ?? '-'} | ${x.metric ? `${x.metric.model}/${x.metric.effort ?? '-'}` : '-'} | ${x.metric?.exit ?? x.result?.subtype ?? '-'} | ${x.result?.turns ?? '-'} | ${usd(costOf(x))} |`));
  }
  for (const g of r.gates.filter((x) => !x.ok && x.why)) out.push('', details(`gate ${g.n} why`, fence('text', String(g.why).slice(0, 4096))));
  if (r.diff) out.push('', details(`diff base..head (${r.diff.head?.slice(0, 12)})`, `${fence('text', r.diff.stat)}\n\n${fence('diff', r.diff.text)}`));
  if (r.journal.length) out.push('', details('work.jsonl', fence('json', r.journal.map((l) => JSON.stringify(l).slice(0, 2000)).join('\n'))));
  if (r.error) out.push('', details('harness error', fence('text', r.error)));
  if (r.stderr?.trim()) out.push('', details('tbd stderr (tail)', fence('text', r.stderr.slice(-3000))));
  if (r.scored) out.push('', leak.length ? 'Irfan score: not counted (CONTAMINATED)' : 'Irfan score _/5 (pass = 4 or more, K17): ____');
  return out.join('\n');
}

function report(o, env, results) {
  const clean = results.filter((r) => !arr(r.contaminated).length); // K17 counts clean runs only
  const all = clean.flatMap((r) => r.checks);
  const pass = all.filter((c) => c.ok).length;
  const out = [`# P5 goldens: working phase, ${o.dry ? 'dry (fake claude + fixture patches)' : 'real (opus xhigh)'} (${env.date})`, '',
    `Verdict (scripted): ${pass === all.length && clean.length === env.planned ? 'PASS' : 'FAIL'}, ${pass}/${all.length} checks, ${clean.length}/${env.planned} clean runs, ${results.length - clean.length} contaminated. Irfan score per clean B/C run: below (pass = 4+, K17).`, '',
    `- cmd \`node scripts/golden-working.js ${process.argv.slice(2).join(' ')}\``,
    `- claude_bin \`${env.claude}\` · working model: config default (opus xhigh), not overridden · one run at a time`,
    `- prompt \`${o.prompt}\` (sha256 ${env.promptSha}) as code/working/prompt.md`,
    `- tbd dev, own port per run · TB_HOME \`${env.tbHome}\` (${o.keep ? 'kept' : 'removed'}) · HOME ${o.dry ? 'temp' : 'real (keychain login)'}`,
    `- sandbox \`${SANDBOX}\` base \`${env.base.slice(0, 12)}\` · checks: sandbox-exec, gate profile (mode test) + gate env`,
    `- total cost ${usd(results.reduce((s, r) => s + r.cost, 0))}`, '', ...MERMAID, '',
    '| run | ticket | stop | checks | contaminated | red gates | rework | first catch | cost | min |', '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.key} ${r.i} | \`${r.id}\` | ${r.ticket.state} | ${r.checks.filter((x) => x.ok).length}/${r.checks.length} | ${arr(r.contaminated).length ? `**${arr(r.contaminated).length} call(s)**` : 'no'} | ${r.gates.filter((g) => !g.ok).length} | ${r.ticket.rework ?? 0} | ${cell(r.firstCatch)} | ${usd(r.cost)} | ${r.min} |`)];
  for (const r of results) out.push('', runMd(r));
  return out.join('\n').replaceAll(os.homedir(), '~') + '\n';
}

// a new file each time: <base>.md, else <base>-2.md, -3, ... (two invocations on one day keep both)
function freshPath(file) {
  for (let n = 1; ; n++) {
    const p = n === 1 ? file : file.replace(/\.md$/, `-${n}.md`);
    if (!fs.existsSync(p)) return p;
  }
}

// ---- main ---------------------------------------------------------------------------------------------------------
const USAGE = `usage: node scripts/golden-working.js (--dry | --real) [--only ${Object.keys(CASES).join('|')}[,...]] [--runs N] [--prompt <md>] [--claude <bin>] [--keep] [--out <md>]`;
function parse(argv) {
  const o = { dry: null, only: Object.keys(CASES), runs: null, prompt: null, claude: null, keep: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '--real') {
      if (o.dry !== null && o.dry !== (a === '--dry')) throw new Error(`--dry and --real together\n${USAGE}`);
      o.dry = a === '--dry';
    } else if (a === '--only') o.only = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--runs') o.runs = Number(argv[++i]);
    else if (a === '--prompt') o.prompt = argv[++i];
    else if (a === '--claude') o.claude = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (o.dry === null) throw new Error(`pick --dry (fake claude) or --real (opus xhigh, costs money)\n${USAGE}`);
  if (!o.only.length || o.only.some((k) => !Object.hasOwn(CASES, k))) throw new Error(`--only: pick from ${Object.keys(CASES).join(',')}`);
  if (o.runs !== null && (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 5)) throw new Error('--runs: 1 to 5');
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const date = new Date().toLocaleDateString('en-CA');
  const only = o.only.length === Object.keys(CASES).length ? '' : `-${o.only.join('-')}`;
  o.out = path.resolve(o.out ?? path.join(REPO, 'docs', 'verification', `${date}-p5-goldens${only}${o.dry ? '-dry' : ''}.md`));
  const draft = path.join(REPO, '.omc', 'drafts', 'working-prompt.md');
  o.prompt = path.resolve(o.prompt ?? (fs.existsSync(draft) ? draft : path.join(REPO, 'phases', 'code', 'working', 'prompt.md')));
  const promptText = fs.readFileSync(o.prompt, 'utf8'); // throws: no working prompt yet
  const claude = o.dry ? FAKE : path.resolve(o.claude ?? path.join(os.homedir(), '.local', 'share', 'claude', 'versions', DEFAULT_PIN));
  fs.accessSync(claude, fs.constants.X_OK);
  const base = git(SANDBOX, 'rev-parse', '--verify', '--quiet', 'main^{commit}').trim(); // throws: no sandbox repo / main
  const md = fs.readFileSync(TRAPS, 'utf8');
  const plans = Object.fromEntries(o.only.map((k) => [k, JSON.parse(fs.readFileSync(path.join(FIX, CASES[k].plan), 'utf8'))]));
  const texts = { B: ticketText(md, 'B'), C: ticketText(md, 'C') };

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbg-'))); // realpath: sandbox rules see /private/var
  const tbHome = path.join(root, 'tbhome');
  guardHome(tbHome);
  // the gates' tmp is TB_HOME/g/x<6>/t: tsx (prisma seed) listens on a unix socket there, ≤ 103 bytes (spike)
  const sock = path.join(tbHome, 'g', 'xXXXXXX', 't', `tsx-${process.getuid?.() ?? 501}`, '99999.pipe');
  if (Buffer.byteLength(sock) > 103) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`temp dir too long for tsx's socket in the gate tmp (${Buffer.byteLength(sock)} > 103 bytes): run with TMPDIR=/tmp`);
  }
  const phases = path.join(root, 'phases');
  const code = codeCopy(path.join(root, 'code'));
  const scn = path.join(root, 'scn');
  fs.cpSync(path.join(REPO, 'phases'), phases, { recursive: true });
  write(path.join(phases, 'code', 'working', 'prompt.md'), promptText);
  // M5.1 built code/review; these goldens score working only and end where they always did: review unbuilt (waiting
  // manual), no review run spawned. The review phase has its own evals (scripts/eval-phase.js).
  fs.rmSync(path.join(phases, 'code', 'review', 'prompt.md'), { force: true });
  const rules = path.join(root, 'rules', 'FUNDAMENTALS.md'); // T1: the owner's rules, copied (~/.claude is never written)
  write(rules, fs.readFileSync(path.join(os.homedir(), '.claude', 'FUNDAMENTALS.md'), 'utf8'));
  const tag = goldenTag(rules);
  tagsLib.validate('sandbox', tag);
  write(path.join(tbHome, 'tags.json'), { sandbox: tag });
  write(path.join(tbHome, 'config.json'), { // models, wall caps, max turns: repo defaults (working = opus xhigh)
    claude_bin: claude,
    interview: { lavish: false }, // M5.4: harness tbds never start a real lavish page or browser tab
    ...(o.dry && { memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } }),
  });
  if (o.dry) fs.mkdirSync(scn);
  const env = {
    root, tbHome, code, phases, scn, base, tag, plans, texts, date, claude,
    commonDir: fs.realpathSync(git(SANDBOX, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()),
    dry: o.dry ? Object.fromEntries(o.only.map((k) => [k, precommit(root, base, path.join(FIX, CASES[k].patch))])) : null,
    runMs: o.dry ? 15 * 60_000 : 150 * 60_000, poll: o.dry ? 1000 : 10_000,
    planned: o.only.reduce((n, k) => n + (o.runs ?? CASES[k].runs), 0),
    promptSha: crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 12),
  };
  console.log(`golden: ${o.dry ? 'DRY (fake claude)' : 'REAL (opus xhigh)'} · ${o.only.map((k) => `${k} ×${o.runs ?? CASES[k].runs}`).join(', ')} · root ${root}`);
  process.on('SIGINT', () => { aborted = true; console.log('golden: SIGINT: cancelling the live run, then cleanup'); });

  const results = [];
  let failed = null;
  try {
    for (const key of o.only) for (let i = 1; i <= (o.runs ?? CASES[key].runs) && !aborted; i++) results.push(await runOne(o, env, key, i));
  } catch (e) {
    failed = e;
    console.log(`golden: error: ${e.stack}`);
  } finally {
    if (results.length) {
      const file = freshPath(o.out);
      try {
        write(file, report(o, env, results));
        console.log(`golden: evidence ${file}`);
      } catch (e) { // never lose a paid run's results to a report bug: the raw results go next to it
        write(file.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2));
        console.log(`golden: report failed (${e.message}): raw results in ${file.replace(/\.md$/, '.json')}`);
      }
    }
    if (o.keep) console.log(`golden: kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
  const clean = results.filter((r) => !arr(r.contaminated).length);
  const all = clean.flatMap((r) => r.checks);
  const ok = !failed && !aborted && clean.length === env.planned && all.every((x) => x.ok);
  console.log(`golden: ${ok ? 'PASS' : 'FAIL'} · ${all.filter((x) => x.ok).length}/${all.length} scripted checks · ${clean.length}/${env.planned} clean runs · ${results.length - clean.length} contaminated`);
  process.exitCode = ok ? 0 : 1;
}

module.exports = { codeCopy, freshPath, CASES, goldenTag, ticketText, guardHome, gatesRun, factsB, factsC, precommit, queueDry, report, DRY_MSG, queryInLoop, blockOf, removedLines, nonNicknameLines, specDiff, newTableCols, modelCols, firstCatch, loopEdits, contamination, checksB, checksC, checksCEmpty, B_NAMES, C_NAMES, CE_NAMES, parse };

if (require.main === module) {
  main().catch((e) => {
    console.log(`golden: error: ${e.message}`);
    process.exitCode = 1;
  });
}
