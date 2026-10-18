#!/usr/bin/env node
'use strict';
// golden-working: the P5d goldens of the working phase (contract rev 4.1 K16+M16, K17+RO5; traps
// test/golden/sandbox-traps.md B 74-96, C 98-115): B ×2, C ×2, C-empty ×1 on a REAL dev tbd (this repo's tbd.js) in a
// throwaway TB_HOME, one run at a time (RAM). Per run: a clone (H2) of tb-sandbox at main + the ticket seeded in
// plan_approval with a fixture plan (test/golden/fixtures/plan-*.json, they pass lib/plan-rules.js at base) → the real
// `tb approve` (setup, base checks, OpenAPI base, branch tb/<id>-<slug>) → working runs (opus xhigh: config defaults,
// never overridden here) → stop at review (C-empty: at its policy clarify; else blocked, setup_failed or the run cap:
// tb cancel) → tbd stopped → the scripted trap checks at the head worktree, every command run by sandbox-exec under the
// gates' own profile + env (lib/gates/run.js open + profile, mode test) → cleanup → evidence
// docs/verification/<date>-p5-goldens[-<only>][-dry].md (never overwritten: -2, -3, ...), only when a run happened.
// Usage: node scripts/golden-working.js (--dry | --real) [--only B|C|C-empty[,...]] [--runs N] [--prompt <md>]
//   [--claude <bin>] [--keep] [--out <md>] [--stop review|close] [--cap-min N] [--packet <dir> [--labels <file>]] [--json <file>]
//   node scripts/golden-working.js --blind <packet-dir> --labels <file> --scores <in.json> --json <out.json> [--reviewers 2|3]
//   [--run-root <dir>] [--claude <bin>]
//   --stop close (R box; default review = the stop above): every phase prompt kept, the loop runs review, QA (the tag's
//     qa_ports = one free port) and the final gate to final_gate waiting close (squashed); check 0 = reached that; tbd
//     stopped, every process with its cwd in the clone (the QA app) is killed. --dry: test/golden/fixtures/dry-loop.json
//     plays review, QA and final after the patch session. Run cap: real 150 min (review) / 240 (close), dry 15; --cap-min.
//     A real run is cancelled when kern.memorystatus_level < 15 (freeze guard).
//   --packet <dir> (--stop close; D-0069 blind packet, scripts/harness.js blindPacket): one item per clean B/C run, its
//     ticket text + the whole change (git diff base..squash in tb-sandbox), nothing else; labels → --labels (default
//     <dir>.labels.json, outside dir). --json: the golden score JSON v1 (blind null). Paths as given.
//   --blind (no golden run): per reviewer, one at a time, a sandboxed claude -p (spawn's isolation flags, the review
//     template's settings, TB_EVAL_DENY_READ = this repo, the labels' and scores' dirs, the packet, --run-root) in a fresh
//     temp dir holding the packet + tb-sandbox at sandbox_base (./repo-at-base/); a run naming the answer key is
//     discarded and run once more; scores mapped back by label (lower of 2; a spread of 2+ gets a 3rd, median) → --json.
//   --real: claude_bin = the pinned version; tbd keeps the real HOME (claude's keychain login); TB_HOME is temp.
//   --no-docker-reserve (--real; Irfan D-0126, D-0141): the temp TB_HOME's RAM gate drops the Docker Desktop reserve
//     (memory.docker_reserved_gb 0, other memory keys = defaults). The live tbd's gate is never touched.
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
const { DEFAULT_PIN, GIT_SAFE, GIT_ENV, minimalEnv, cloneAt, claudeEnv, git: pinnedGit, SHA_RE } = require('../lib/util');
const tagsLib = require('../lib/tags');
const { render, tools } = require('../lib/phase-settings');
const { isolationArgv, ISOLATION_ENV, AGENT_GIT_ENV } = require('../lib/spawn');
const { SANDBOX, arr, sleep, readJson, write, git, events, runNs, runInfo, metricLines, ticketOf, reapRuns, chk, fence, details, usd, costOf, cell } = require('./eval-planner');
const { LEAKS, memLevel, freePort, FAKE_APP, fakeExec, fakeDocs, killIn, blindPacket, scoreJson } = require('./harness');

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

// The golden tag: the P4 keys + every P5 key the live tag will carry (contract K16; lib/gates/types.js TagP5). --stop
// close: qa_ports [qaPort]. No push, no ident: the squash takes the clone's (tb agent).
const goldenTag = (rules, qaPort = null) => ({
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
  ...(qaPort && { qa_ports: [qaPort] }),
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
// check 0: the run stopped where it must: review, or (--stop close, f.stop) final_gate waiting close (squashed)
const reached = (f) => (f.stop === 'close' ? f.state === 'final_gate' && f.waiting?.reason === 'close' : f.state === 'review');
const at0 = (f, name) => (f.stop === 'close' ? name.replace('reached review', 'reached final_gate waiting close') : name);
const state0 = (f) => `state ${f.state}${f.stop === 'close' ? ` waiting ${f.waiting?.reason ?? 'none'}` : ''}`;

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
/** @param {any} f facts: {state, waiting?, stop?, gate, why?, e2e, hidden, migrations, spec: {base, head, diff}, paginationChanged, service, src, api: {code, base, head, why?}} */
function checksB(f) {
  const g = f.gate;
  const ok0 = chk(at0(f, B_NAMES[0]), reached(f) && g?.ok === true, `${state0(f)}; last working gate ${gateWord(g)}`);
  if (!f.e2e) return [ok0, ...notRun(B_NAMES.slice(1), f.why ?? `state ${f.state}`)];
  const hits = Object.entries(f.src ?? {}).flatMap(([p, s]) => queryInLoop(s).map((h) => `${p}:${h.line} ${h.call} in ${h.loop}`));
  const gone = removedLines(f.spec.diff, /expect\(large\)\.toBe\(small\)/);
  const before = blockOf(f.spec.base, QUERY_TEST);
  const kept = before !== null && before === blockOf(f.spec.head, QUERY_TEST);
  const d = specDiff(f.api.base, f.api.head);
  return [ok0,
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
/** @param {any} f facts: {state, waiting?, stop?, gate, why?, diff, baseCols, sync, api, resetBase, deploy, resetHead, testDiff} */
function checksC(f) {
  const g = f.gate;
  const ok0 = reached(f) && g?.ok === true && change(g.schema, 'drop User.nickname', true) && change(g.api, 'remove UserDto.nickname', true) && !arr(g.unused_allowed).length;
  const row0 = chk(at0(f, C_NAMES[0]), ok0, `${state0(f)}; last working gate ${gateWord(g)}; schema ${JSON.stringify(arr(g?.schema))}; api ${JSON.stringify(arr(g?.api))}; unused ${JSON.stringify(arr(g?.unused_allowed))}`);
  if (!f.diff) return [row0, ...notRun(C_NAMES.slice(1), f.why ?? `state ${f.state}`)];
  const cols = newTableCols(f.diff.out, 'User');
  const lost = cols ? f.baseCols.filter((x) => !cols.includes(x)) : null;
  const d = specDiff(f.api.base, f.api.head);
  const userGone = d ? d.props_removed.filter((p) => p.startsWith('UserDto.')) : [];
  const userNew = d ? d.props_added.filter((p) => p.startsWith('UserDto.')) : [];
  const bad = nonNicknameLines(f.testDiff);
  return [row0,
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
// S2: git in the run's clone (agent-written) goes through lib/util git pinned to the ticket's clone: a planted .git
// (config, commondir, alternates, a link) refuses it on every call (cloneRefused, code PLANTED) and its stderr is masked
// (gitWhy: exit + a fixed kind, never git's raw words). Throws that short message. The tag repo keeps the plain git.
async function cloneGit(t, ...args) {
  if (!t.clone) throw new Error(`git ${args[0]} refused: the ticket has no clone pin`);
  const r = await pinnedGit(t.worktree, args, { dirs: t });
  if (r.err) throw Object.assign(new Error(`git ${args[0]} in the clone: ${r.stderr}`), { code: r.err.code });
  return r.stdout;
}
// a file at sha, null when git exits non-zero (none there); a refused clone or a timeout throws (fail closed)
const show = (t, sha, p) => cloneGit(t, 'show', `${sha}:${p}`).catch((e) => { if (typeof e.code !== 'number') throw e; return null; });
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

// --dry --stop close: the review, QA and final sessions after the working one (queued right after queueDry, so the next
// invocations), from test/golden/fixtures/dry-loop.json: review passes; QA = the fixture app on the qa port, tbx req per
// case (harness fakeExec); final = its two docs (harness fakeDocs), then pass.
function queueLoop(env, scn) {
  const L = JSON.parse(fs.readFileSync(path.join(FIX, 'dry-loop.json'), 'utf8'));
  const n = fs.readdirSync(scn).filter((f) => f.startsWith('.run-')).length + 2; // + 1: the working session's
  write(path.join(scn, `${n}.json`), { steps: [{ result: { structured_output: L.review, num_turns: 1 } }] });
  write(path.join(scn, `${n + 1}.json`), { steps: [fakeExec(env, { key: 'qa', ...L.qa }), { result: { structured_output: L.qa.example, num_turns: 1 } }] });
  write(path.join(scn, `${n + 2}.json`), { steps: [fakeDocs(env, { key: 'final', ...L.final }), { result: { structured_output: L.final.example, num_turns: 1 } }] });
}

// The ticket's own clone of tb-sandbox at base (H2.11: util.cloneAt + the refs/tb/<id>/base pin, as planning.worktree
// makes them) + the ticket as planning leaves it at plan_approval (round 1 plan kept, facts, decisions; Irfan's answer:
// decisions locked on the ticket, J17), written while tbd is down.
async function seed(env, plan, text) {
  const id = `t_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(env.tbHome, 'tickets', id);
  const wt = path.join(env.tbHome, 'worktrees', id);
  fs.mkdirSync(path.dirname(wt), { recursive: true, mode: 0o700 });
  let made;
  try {
    made = await cloneAt(env.commonDir, wt, env.base, {});
    git(env.commonDir, 'update-ref', `refs/tb/${id}/base`, env.base, '');
  } catch (e) {
    try { cleanSandbox(id, wt, env.tbHome); } catch { /* the throw below says why */ }
    throw e;
  }
  const now = new Date().toISOString();
  write(path.join(dir, 'ticket.json'), {
    id, type: 'flow', kind: 'code', tag: 'sandbox', title: text.slice(0, 100), text, state: 'plan_approval', round: 1, created_at: now, updated_at: now,
    parent: null, blocked_by: [], fix_of: null, must_ask: false, rework: 0, failures: {}, waiting: null, lease: null,
    base_sha: env.base, worktree: wt, git_dir: made.git_dir, common_dir: env.commonDir, clone: made.clone,
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
  const g = (...args) => cloneGit(t, ...args);
  const head = (await g('rev-parse', 'HEAD')).trim();
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
  const lsSrc = async (sha) => (await g('ls-tree', '-r', '--name-only', sha, '--', 'src/users')).split('\n').filter((p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'));
  const src = {};
  for (const p of await lsSrc(head)) src[p] = (await show(t, head, p)) ?? '';
  return Object.assign(f, {
    migrations: (await g('diff', '--name-only', base, head, '--', 'prisma/migrations')).split('\n').filter(Boolean),
    spec: { base: await show(t, base, 'test/users.e2e-spec.ts'), head: await show(t, head, 'test/users.e2e-spec.ts'), diff: await g('diff', base, head, '--', 'test/users.e2e-spec.ts') },
    paginationChanged: !!(await g('diff', '--name-only', base, head, '--', 'src/common/pagination.ts')).trim(),
    service: (await show(t, head, 'src/users/users.service.ts')) ?? '',
    src,
    lsSrc,
  });
}

async function factsC(R, ctx, t, dir, tag) {
  const { base_sha: base, branch } = t;
  const g = (...args) => cloneGit(t, ...args);
  const head = (await g('rev-parse', 'HEAD')).trim();
  const baseSchema = (await show(t, base, 'prisma/schema.prisma')) ?? '';
  const basePrisma = path.join(ctx.gtmp, 'base.prisma'); // the gate tmp: inside the profile's write set
  fs.writeFileSync(basePrisma, baseSchema, { mode: 0o600 });
  const f = {
    api: await apiFacts(R, ctx, dir, tag),
    diff: await boxed(R, ctx, [PRISMA, 'migrate', 'diff', '--from-schema', basePrisma, '--to-schema', 'prisma/schema.prisma', '--script', '--exit-code']),
    baseCols: modelCols(baseSchema, 'User'),
    sync: await boxed(R, ctx, [PRISMA, 'migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema', 'prisma/schema.prisma', '--exit-code']),
    testDiff: await g('diff', base, head, '--', 'test'),
  };
  // check 5: test.db reset at base (base client), the head's migrations on that seeded data, reset at head; back to head
  try {
    await g('switch', '-q', '--detach', base);
    await boxed(R, ctx, [PRISMA, 'generate']);
    f.resetBase = await boxed(R, ctx, [R.NPM, 'run', 'db:test:reset']);
  } finally {
    await g('switch', '-q', branch);
    await boxed(R, ctx, [PRISMA, 'generate']);
  }
  f.deploy = await boxed(R, ctx, [PRISMA, 'migrate', 'deploy'], { DATABASE_URL: 'file:./test.db' });
  f.resetHead = await boxed(R, ctx, [R.NPM, 'run', 'db:test:reset']);
  return f;
}

// K16: after each run only this run's own git state goes: its clone (only TB_HOME/worktrees/<id>, id a harness one),
// tb/<id>-* branch, refs/tb/<id>/*, then prune (legacy, harmless); and tb-sandbox's git-ignored test.db (db:test:reset
// starts the same way). Never main, never another ticket's refs.
function cleanSandbox(id, wt, tbHome) {
  if (!ID_RE.test(id)) throw new Error(`cleanup: ${id} is not a harness ticket id`);
  if (wt !== path.join(tbHome, 'worktrees', id)) throw new Error(`cleanup: ${wt} is not TB_HOME/worktrees/${id}: left alone`);
  const notes = [];
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch (e) { notes.push(`clone remove: ${String(e.message).slice(0, 200)}`); } // a clone (H2), not a linked worktree
  const refs = git(SANDBOX, 'for-each-ref', '--format=%(refname)', `refs/heads/tb/${id}-*`, `refs/tb/${id}`).split('\n').filter(Boolean);
  for (const r of refs) git(SANDBOX, 'update-ref', '-d', r);
  git(SANDBOX, 'worktree', 'prune');
  for (const f of ['test.db', 'test.db-journal']) {
    let ignored = false;
    try { git(SANDBOX, 'check-ignore', '-q', f); ignored = true; } catch { /* tracked or not ignored: left alone */ }
    if (ignored) fs.rmSync(path.join(SANDBOX, f), { force: true });
  }
  const stale = git(SANDBOX, 'for-each-ref', '--format=%(refname)', 'refs/heads/tb', 'refs/tb').split('\n').filter(Boolean).length;
  return [...notes, `clone removed`, `${refs.length} ref(s) of ${id} deleted`, `worktree pruned`, `test.db reset`, ...(stale ? [`${stale} other tb ref(s) left (not ours)`] : [])];
}

// What tbd needs at runtime (no runtime deps); everything else, the answer key included, stays out. → dest
function codeCopy(dest) {
  for (const f of ['tbd.js', 'package.json', 'lib', 'hooks', 'bin', 'ui', 'phases']) fs.cpSync(path.join(REPO, f), path.join(dest, f), { recursive: true });
  return dest;
}

// ---- one run ------------------------------------------------------------------------------------------------------
let aborted = false;
// the run goes on: review (default) until it leaves working; close until final_gate waits close (squashed), blocked,
// clarify or cancelled
const LOOP = ['plan_approval', 'working', 'review', 'qa', 'final_gate'];
const live = (t, stop = 'review') => (stop === 'close'
  ? LOOP.includes(t.state) && !(t.state === 'plan_approval' && t.waiting?.reason === 'setup_failed') && !(t.state === 'final_gate' && t.waiting?.reason === 'close')
  : t.state === 'working' || (t.state === 'plan_approval' && t.waiting?.reason !== 'setup_failed'));

async function runOne(o, env, key, i) {
  const c = CASES[key];
  const plan = env.plans[key];
  const text = env.texts[c.letter];
  const { id, dir, wt } = await seed(env, plan, text);
  if (o.dry) queueDry(env.scn, path.join(FIX, c.patch), env.dry[key]);
  if (o.dry && o.stop === 'close') queueLoop(env, env.scn);
  const r = { key, i, id, text, plan: c.plan, scored: c.scored, stop: o.stop, checks: [], notes: [], error: null };
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
    try { cleanSandbox(id, wt, env.tbHome); } catch { /* reported by the throw below */ }
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
    for (let t = ticketOf(dir); ap.code === 0 && live(t, o.stop); t = ticketOf(dir)) {
      const low = !o.dry && memLevel() < 15; // the freeze guard (8 GB Mac: eval-phase's)
      if (aborted || low || Date.now() - t0 > env.runMs) {
        r.timeout = true;
        if (low) r.notes.push('kern.memorystatus_level < 15: cancelled');
        console.log(`golden: ${id}: ${aborted ? 'aborted' : low ? 'memory level under 15' : 'run cap reached'} in ${t.state}: tb cancel`);
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
    if (o.stop === 'close') {
      const left = killIn(wt); // the QA app
      if (left.length) r.notes.push(`killed ${left.length} process(es) left with their cwd in the clone: pids ${left.join(', ')}`);
    }
  }
  r.min = Math.round((Date.now() - t0) / 60_000);
  Object.assign(r, collect(env.tbHome, dir, id));
  r.contaminated = contamination(r.runsEvents);
  const t = r.ticket;
  const gate = r.gates.filter((g) => g.gate === 'working').at(-1) ?? null;
  const base = { state: t.state, waiting: t.waiting, stop: o.stop, gate, origin: t.clarify_origin, transitions: r.transitions };
  // --packet: the whole change, base..squash in tb-sandbox (the squash lands there); over 1 MB (git's buffer) → no item
  if (o.stop === 'close' && c.scored && /^[0-9a-f]{40}$/.test(t.final?.sha ?? '')) {
    try { r.change = git(SANDBOX, 'diff', env.base, t.final.sha); } catch (e) { r.notes.push(`change diff: ${e.code === 'ENOBUFS' ? 'over 1 MB: diff too big for blind scoring (blind null, K17 not met)' : String(e.message).slice(0, 200)}`); }
  }
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
        if (key === 'B') r.firstCatch = await firstCatchOf(t, f, r.runsEvents);
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
  r.diff = await headDiff(t);
  delete r.runsEvents;
  if (!o.keep) {
    try { r.notes.push(...cleanSandbox(id, wt, env.tbHome)); } catch (e) { r.notes.push(`cleanup: ${e.message}`); }
    fs.mkdirSync(path.join(env.root, 'done'), { recursive: true });
    fs.renameSync(dir, path.join(env.root, 'done', id)); // the next run's tbd never sees this ticket
  } else r.notes.push(`kept; later: rm -rf ${wt} && git -C ${SANDBOX} for-each-ref --format='delete %(refname)' 'refs/heads/tb/${id}-*' refs/tb/${id} | git -C ${SANDBOX} update-ref --stdin`);
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

// refs/tb/<id>/*: the tag repo's (H2: tbd fetches there) + the clone's (agent-written: only a sha goes into argv)
async function firstCatchOf(t, f, runsEvents) {
  const refs = [await cloneGit(t, 'for-each-ref', '--format=%(objectname)', `refs/tb/${t.id}`), git(SANDBOX, 'for-each-ref', '--format=%(objectname)', `refs/tb/${t.id}`)]
    .flatMap((out) => out.split('\n').filter((x) => SHA_RE.test(x)));
  const shas = new Set();
  for (const range of [`${t.base_sha}..HEAD`, ...refs.map((x) => `${t.base_sha}..${x}`)]) for (const sha of (await cloneGit(t, 'rev-list', '--reverse', range)).split('\n').filter(Boolean)) shas.add(sha);
  const commits = [];
  for (const sha of shas) {
    const hits = [];
    for (const p of await f.lsSrc(sha)) hits.push(...queryInLoop((await show(t, sha, p)) ?? '').map((h) => `${p}:${h.line} ${h.call} in ${h.loop}`));
    commits.push({ sha, hits });
  }
  const head = Object.entries(f.src).flatMap(([p, s]) => queryInLoop(s).map((h) => `${p}:${h.line}`));
  return firstCatch({ edits: runsEvents.flatMap((x) => loopEdits(x.evs, x.n)), commits, head });
}

async function headDiff(t) {
  if (!fs.existsSync(t.worktree) || !t.base_sha) return null;
  try {
    const d = await cloneGit(t, 'diff', t.base_sha, 'HEAD');
    return { head: (await cloneGit(t, 'rev-parse', 'HEAD')).trim(), stat: await cloneGit(t, 'diff', '--stat', t.base_sha, 'HEAD'), text: d.length > DIFF_MAX ? `${d.slice(0, DIFF_MAX)}\n... (${d.length} bytes, cut)` : d };
  } catch (e) {
    return { head: '?', stat: `git: ${e.message}`, text: '' }; // cloneGit's short message, never git's stderr
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
    ...(r.stop === 'close' ? [`- review ${t.review ? `#${t.review.n} ${arr(t.review.open).length ? `block (${t.review.open.join(', ')})` : 'pass'}` : '-'} · QA ${t.qa?.verdict ? `#${t.qa.n} ${t.qa.verdict} (${t.qa.pass} pass, ${t.qa.fail} fail, ${t.qa.blocked} blocked)` : '-'} · final ${t.final?.verdict ? `#${t.final.n} ${t.final.verdict}` : '-'} · fix rounds ${t.fixes ?? 0} · squash \`${t.final?.sha?.slice(0, 12) ?? '-'}\``] : []),
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
    `- claude_bin \`${env.claude}\` · working model: config default (opus xhigh), not overridden · one run at a time${env.noDockerReserve ? ' · RAM gate: docker reserve 0 (--no-docker-reserve, D-0126/D-0141)' : ''}`,
    `- prompt \`${o.prompt}\` (sha256 ${env.promptSha}) as code/working/prompt.md`,
    `- tbd dev, own port per run · TB_HOME \`${env.tbHome}\` (${o.keep ? 'kept' : 'removed'}) · HOME ${o.dry ? 'temp' : 'real (keychain login)'}`,
    `- sandbox \`${SANDBOX}\` base \`${env.base.slice(0, 12)}\` · checks: sandbox-exec, gate profile (mode test) + gate env`,
    `- total cost ${usd(results.reduce((s, r) => s + r.cost, 0))}`,
    ...(o.packet ? [`- blind packet \`${o.packet}\`: ${env.packetError ? `**REFUSED**: ${cell(env.packetError)}` : `${Object.keys(env.labels ?? {}).length} item(s), labels \`${o.labels}\``}`] : []),
    ...(o.json ? [`- score JSON v1 \`${o.json}\`${env.jsonError ? `: **FAILED**: ${cell(env.jsonError)}` : ''}`] : []),
    '', ...(o.stop === 'close' ? MERMAID.map((l) => l.replace('R[review: stop]', 'R[review, QA, final gate: stop at waiting close]')) : MERMAID), '',
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

// ---- phases copy, blind packet, score JSON -------------------------------------------------------------------------
// The phases/ copy tbd runs (TB_PHASES_DIR) with the working prompt under test. review (default): these goldens score
// working only and end where they always did: M5.1 built code/review, its prompt goes (review unbuilt, waiting manual, no
// review run spawned; the review phase has its own evals, scripts/eval-phase.js). close: every phase prompt kept. → dir
function phasesCopy(dir, promptText, stop = 'review') {
  fs.cpSync(path.join(REPO, 'phases'), dir, { recursive: true });
  write(path.join(dir, 'code', 'working', 'prompt.md'), promptText);
  if (stop !== 'close') fs.rmSync(path.join(dir, 'code', 'review', 'prompt.md'), { force: true });
  return dir;
}

// --packet (D-0069): one item per clean B/C run that reached its squash (r.change): the ticket text and the whole change,
// nothing else (no plan, phase output, transcript, check or ticket id). A run without one gets no blind score (K17 not
// met). harness blindPacket anonymises, scans, writes; throws on a leak. → labels {golden:<case>#<run>: label}
function packetOf(dir, results, { base, labelsFile }) {
  const items = results.filter((r) => r.scored && !arr(r.contaminated).length && typeof r.change === 'string')
    .map((r) => ({ key: `golden:${r.key}#${r.i}`, files: { 'ticket.md': `${r.text}\n`, 'change.diff': r.change } }));
  return blindPacket(dir, items, { base, labelsFile });
}

// --json: golden score JSON v1 (harness scoreJson), blind null. cost_micro: integer micro-USD (t:run cost_delta).
const stopOf = (t) => (t.waiting?.reason ? `${t.state}:${t.waiting.reason}` : t.state);
const microOf = (x) => (Number.isInteger(x.metric?.cost_delta) ? x.metric.cost_delta : Math.round((x.result?.cost_usd ?? 0) * 1e6));
const scoreOf = (results, meta) => scoreJson(results.map((r) => ({
  id: `golden:${r.key}`, run: r.i, stop: stopOf(r.ticket), checks: r.checks, contaminated: r.contaminated, fix_rounds: r.ticket.fixes ?? 0,
  rework: r.ticket.rework ?? 0, cost_micro: arr(r.runs).reduce((s, x) => s + microOf(x), 0), min: r.min, blind: null,
})), { sources: ['golden-working'], ...meta });

// ---- --blind: K17 by sandboxed reviewers (D-0069 rev 2: blind by sandbox, not trust; no golden run) ------------------
const REVIEW_SHAPE = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['label', 'score', 'agree', 'wrong', 'missing', 'why'],
  properties: { label: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 5 }, agree: { type: 'array', items: { type: 'string' } },
    wrong: { type: 'array', items: { type: 'string' } }, missing: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } } } } } };
const REVIEW_PROMPT = 'Read README.md in this folder and do what it asks for every item folder. Answer one entry per folder: label = the folder name, its score, what the change gets right (agree), what it gets wrong (wrong), what it lacks (missing), and why.\n';
const REVIEW_MS = 30 * 60_000;

// What no reviewer reads (TB_EVAL_DENY_READ): this repo (the answer key), the labels' and the scores' dirs, the packet
// source, the golden run root; each as given and as its real path.
function blindDeny({ labels, scores, packet, runRoot = null }) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return [...new Set([REPO, path.dirname(labels), path.dirname(scores), packet, runRoot].filter(Boolean).map((p) => path.resolve(p)).flatMap((p) => [p, real(p)]))];
}

// One reviewer's claude -p, built, not spawned. dir: its cwd (packet + repo-at-base), never in a denied dir; box: its temp
// TB_HOME (settings + mcp files: sandbox denyRead), code copy (TB_CODE: no answer key) and empty skills dir. Settings:
// the read-only review template (lib/phase-settings render) with deny (TB_EVAL_DENY_READ) + the live board denied; argv:
// -p + spawn's isolation flags; env: claudeEnv + spawn's isolation and git extras (no key) + TB_PHASE review (bash-guard's
// read-only git rules), not all of start()'s env (no bin/ PATH, subagent caps, gh dir, tbd socket, run key). → {argv,
// settings, env, cwd}
function reviewer({ dir, box, deny, port }) {
  const bad = deny.find((d) => dir === d || dir.startsWith(d + path.sep));
  if (bad) throw new Error(`blind: reviewer dir ${dir} lies in denied ${bad}`);
  const home = path.join(box, 'home');
  const ticket = path.join(home, 'tickets', 't_000000');
  const skills = path.join(box, 'skills');
  for (const d of [path.join(ticket, 'out'), skills]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const prev = process.env.TB_EVAL_DENY_READ;
  process.env.TB_EVAL_DENY_READ = deny.join(':');
  let settings;
  try {
    settings = render('code', 'review', { WORKTREE: dir, TAG_PATH: path.join(dir, 'repo-at-base'), TB_HOME: home, TICKET_DIR: ticket, OUT_DIR: path.join(ticket, 'out'),
      SKILLS_DIR: skills, TB_CODE: codeCopy(path.join(box, 'code')), TB_NODE: process.execPath, TB_PORT: port, HEAVY: [] });
  } finally {
    if (prev === undefined) delete process.env.TB_EVAL_DENY_READ;
    else process.env.TB_EVAL_DENY_READ = prev;
  }
  write(path.join(box, 'settings.json'), settings);
  write(path.join(box, 'mcp.json'), { mcpServers: {} });
  const argv = ['-p', ...isolationArgv({ settings: path.join(box, 'settings.json'), mcp: path.join(box, 'mcp.json'), tools: tools(settings) }),
    '--model', 'opus', '--max-turns', '40', '--json-schema', JSON.stringify(REVIEW_SHAPE), '--output-format', 'stream-json', '--verbose'];
  return { argv, settings, env: { ...claudeEnv(process.env), ...ISOLATION_ENV, ...AGENT_GIT_ENV, TB_PHASE: 'review' }, cwd: dir };
}

// one reviewer run: the prompt on stdin, the stream's events back. Its own process group (T6), killed whole after
// REVIEW_MS, at its end (what it left running) and on a Ctrl-C (detached: the terminal's SIGINT no longer reaches it).
function claudeRun(bin, r) {
  return new Promise((resolve) => {
    const c = spawn(bin, r.argv, { cwd: r.cwd, env: r.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    let out = '';
    const kill = () => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } };
    const int = () => { kill(); process.kill(process.pid, 'SIGINT'); }; // once: the SIGINT sent again ends the harness as before
    process.once('SIGINT', int);
    const timer = setTimeout(kill, REVIEW_MS);
    c.stdout.on('data', (b) => { out += b; });
    c.on('error', (e) => console.log(`golden: blind: ${e.message}`));
    c.on('close', () => {
      clearTimeout(timer);
      process.off('SIGINT', int);
      kill();
      resolve(out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }));
    });
    c.stdin.on('error', () => {}).end(REVIEW_PROMPT);
  });
}

// Reviewer k: a fresh dir (packet + tb-sandbox at base) and box, one run, both removed after. A run whose tool calls name
// the answer key (contamination) is discarded and run once more; twice → null. Before each run the freeze guard (8 GB
// Mac): kern.memorystatus_level under 15 waits up to 10 min, then the reviewer is skipped (null). → the review or null
async function blindReview(bin, packet, base, deny, k) {
  for (let n = 1; n <= 2; n++) {
    for (let w = 0; memLevel() < 15; w++) {
      if (w === 60) {
        console.log(`golden: blind reviewer ${k}: kern.memorystatus_level under 15 for 10 min: skipped (blind null)`);
        return null;
      }
      await sleep(10_000);
    }
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbr-')));
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbrb-')));
    try {
      fs.cpSync(packet, dir, { recursive: true });
      const tar = path.join(box, 'base.tar');
      git(SANDBOX, 'archive', '--format=tar', `--output=${tar}`, base);
      fs.mkdirSync(path.join(dir, 'repo-at-base'));
      execFileSync('/usr/bin/tar', ['-xf', tar, '-C', path.join(dir, 'repo-at-base')], { stdio: 'ignore' });
      fs.rmSync(tar);
      console.log(`golden: blind reviewer ${k} try ${n}: ${dir}`);
      const evs = await claudeRun(bin, reviewer({ dir, box, deny, port: await freePort() }));
      const hits = contamination([{ n: k, evs }]);
      if (!hits.length) return evs.findLast((m) => m.type === 'result')?.structured_output ?? null;
      console.log(`golden: blind reviewer ${k} try ${n}: CONTAMINATED (discarded): ${hits.join('; ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(box, { recursive: true, force: true });
    }
  }
  return null;
}

// Reviews mapped back by label: {scores: {key: [s1, s2, ...]}, third: keys whose 2 scores are 2+ apart}. Refused: an
// unknown or repeated label, a score not an integer 1-5, a labelled item a review left out.
function blindMerge(labels, reviews) {
  const keyOf = new Map(Object.entries(labels).map(([k, l]) => [l, k]));
  const scores = Object.fromEntries(Object.keys(labels).map((k) => [k, []]));
  reviews.forEach((rv, i) => {
    const seen = new Set();
    for (const it of arr(rv?.items)) {
      const k = keyOf.get(it?.label);
      if (!k || seen.has(k)) throw new Error(`blind: review ${i + 1}: label ${JSON.stringify(it?.label)} ${k ? 'twice' : 'unknown'}`);
      if (!Number.isInteger(it.score) || it.score < 1 || it.score > 5) throw new Error(`blind: review ${i + 1}: ${it.label} score ${JSON.stringify(it.score)} is not an integer 1-5`);
      seen.add(k);
      scores[k].push(it.score);
    }
    const left = Object.keys(labels).filter((k) => !seen.has(k));
    if (left.length) throw new Error(`blind: review ${i + 1} left out ${left.map((k) => labels[k]).join(', ')}`);
  });
  return { scores, third: Object.keys(scores).filter((k) => scores[k].length === 2 && Math.abs(scores[k][0] - scores[k][1]) >= 2) };
}

// S3: a file no reviewer may read lies outside the packet (copied whole into each reviewer's cwd): blindPacket's rule on
// real paths (one not made yet: its nearest existing parent's real path + the rest). Throws a usage error.
const realOf = (p) => { try { return fs.realpathSync(p); } catch { const d = path.dirname(p); return d === p ? p : path.join(realOf(d), path.basename(p)); } };
function outsidePacket(packet, files) {
  for (const [flag, f] of Object.entries(files)) {
    const rel = path.relative(realOf(path.resolve(packet)), realOf(path.resolve(f)));
    if (rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw new Error(`${flag} ${f} lies inside the packet ${packet}: a reviewer would read it\n${USAGE}`);
  }
}

async function blindMain(o) {
  const [packet, labelsFile, scoresFile, out] = [o.blind, o.labels, o.scores, o.json].map((f) => path.resolve(f));
  outsidePacket(packet, { '--labels': labelsFile, '--scores': scoresFile, '--json': out });
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  const sj = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
  if (sj?.v !== 1 || sj.kind !== 'golden-score' || !/^[0-9a-f]{40}$/.test(sj.sandbox_base ?? '')) throw new Error(`${scoresFile}: not a golden score JSON v1`);
  const keyOf = (c) => `${c.id}#${c.run}`;
  const lost = Object.keys(labels).filter((k) => !sj.cases.some((c) => keyOf(c) === k));
  if (lost.length) throw new Error(`blind: ${lost.join(', ')} labelled, not in ${scoresFile}`);
  const claude = path.resolve(o.claude ?? path.join(os.homedir(), '.local', 'share', 'claude', 'versions', DEFAULT_PIN));
  fs.accessSync(claude, fs.constants.X_OK);
  const deny = blindDeny({ labels: labelsFile, scores: scoresFile, packet, runRoot: o.runRoot });
  const reviews = [];
  for (let k = 1; k <= (o.reviewers ?? 2) && reviews.every(Boolean); k++) reviews.push(await blindReview(claude, packet, sj.sandbox_base, deny, k));
  let m = reviews.every(Boolean) ? blindMerge(labels, reviews) : null;
  if (m?.third.length) { // a spread of 2+: a 3rd reviewer, its score counts for those runs only (median of 3)
    const r3 = await blindReview(claude, packet, sj.sandbox_base, deny, reviews.length + 1);
    if (r3) { const s3 = blindMerge(labels, [r3]).scores; for (const k of m.third) m.scores[k].push(s3[k][0]); } else m = null;
  }
  if (!m) console.log('golden: blind: a reviewer gave no result, named the answer key twice or was skipped (memory): blind null for every labelled run (K17 not met)');
  const json = scoreJson(sj.cases.map((c) => ({ ...c, checks: Array.from({ length: c.checks.total }, (_, i) => ({ ok: i < c.checks.pass })),
    blind: Object.hasOwn(labels, keyOf(c)) ? (m ? { scores: m.scores[keyOf(c)] } : null) : c.blind })), sj);
  write(out, json);
  console.log(`golden: blind ${json.pass && m ? 'PASS' : 'FAIL'} · ${json.cases.map((c) => `${keyOf(c)} ${c.blind ? `${c.blind.scores.join('/')} = ${c.blind.score}` : 'none'}`).join(' · ')} · ${out}`);
  process.exitCode = json.pass && m ? 0 : 1;
}

// models, wall caps, max turns: repo defaults (working = opus xhigh). config.json merges shallow: a memory key replaces the
// default memory object whole, so --no-docker-reserve spreads the defaults. lib/store must NOT stay loaded here: its paths
// are fixed at require, and gatesRun loads it later with the temp TB_HOME (its guard refused every check on 2026-10-18).
function storeDefaults() {
  const p = require.resolve('../lib/store');
  const had = Object.hasOwn(require.cache, p);
  const { DEFAULTS } = require(p);
  if (!had) delete require.cache[p]; // ponytail: read the constants, unload; move DEFAULTS to a path-free module if more scripts need them
  return DEFAULTS;
}
function harnessConfig(o, claude) {
  return {
    claude_bin: claude,
    interview: { lavish: false }, // M5.4: harness tbds never start a real lavish page or browser tab
    ...(o.dry && { memory: { min_free_gb: 0, phase_need_gb: { planning: 0, working: 0, review: 0, qa: 0, final_gate: 0 }, docker_reserved_gb: 0, start_at_warn_when_idle: true }, disk: { warn_gb: 0, stop_gb: 0 } }),
    ...(!o.dry && o.noDockerReserve && { memory: { ...storeDefaults().memory, docker_reserved_gb: 0 } }),
  };
}

// ---- main ---------------------------------------------------------------------------------------------------------
const USAGE = `usage: node scripts/golden-working.js (--dry | --real) [--only ${Object.keys(CASES).join('|')}[,...]] [--runs N] [--prompt <md>] [--claude <bin>] [--keep] [--out <md>] [--stop review|close] [--cap-min N] [--packet <dir> [--labels <file>]] [--json <file>] [--no-docker-reserve]
       node scripts/golden-working.js --blind <packet-dir> --labels <file> --scores <in.json> --json <out.json> [--reviewers 2|3] [--run-root <dir>] [--claude <bin>]`;
// the flags added after P5 (R box): set only when given, so a run without them parses as before
const MORE = { '--stop': 'stop', '--cap-min': 'capMin', '--packet': 'packet', '--labels': 'labels', '--json': 'json', '--blind': 'blind', '--scores': 'scores', '--reviewers': 'reviewers', '--run-root': 'runRoot' };
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
    else if (a === '--no-docker-reserve') o.noDockerReserve = true;
    else if (Object.hasOwn(MORE, a)) {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${USAGE}`);
      o[MORE[a]] = ['--cap-min', '--reviewers'].includes(a) ? Number(v) : v;
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (o.noDockerReserve && o.dry !== false) throw new Error('--no-docker-reserve: with --real only');
  if (o.blind !== undefined) {
    if (o.dry !== null) throw new Error('--blind runs no golden: no --dry or --real');
    if (!o.labels || !o.scores || !o.json) throw new Error(`--blind needs --labels, --scores and --json\n${USAGE}`);
    if (o.reviewers !== undefined && ![2, 3].includes(o.reviewers)) throw new Error('--reviewers: 2 or 3');
    return o;
  }
  if (o.scores || o.reviewers !== undefined || o.runRoot) throw new Error('--scores, --reviewers, --run-root: with --blind only');
  if (o.stop !== undefined && !['review', 'close'].includes(o.stop)) throw new Error('--stop: review or close');
  if (o.capMin !== undefined && (!Number.isInteger(o.capMin) || o.capMin < 1 || o.capMin > 480)) throw new Error('--cap-min: 1 to 480');
  if (o.packet && o.stop !== 'close') throw new Error('--packet needs --stop close (the squash is the change scored)');
  if (o.labels && !o.packet) throw new Error('--labels: with --packet or --blind');
  if (o.dry === null) throw new Error(`pick --dry (fake claude) or --real (opus xhigh, costs money)\n${USAGE}`);
  if (!o.only.length || o.only.some((k) => !Object.hasOwn(CASES, k))) throw new Error(`--only: pick from ${Object.keys(CASES).join(',')}`);
  if (o.runs !== null && (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 5)) throw new Error('--runs: 1 to 5');
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.blind) return blindMain(o);
  o.stop ??= 'review';
  if (o.packet) [o.packet, o.labels] = [path.resolve(o.packet), path.resolve(o.labels ?? `${path.resolve(o.packet)}.labels.json`)];
  if (o.json) o.json = path.resolve(o.json);
  if (o.packet) outsidePacket(o.packet, { '--labels': o.labels, ...(o.json && { '--json': o.json }) });
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
  const phases = phasesCopy(path.join(root, 'phases'), promptText, o.stop);
  const code = codeCopy(path.join(root, 'code'));
  const scn = path.join(root, 'scn');
  const rules = path.join(root, 'rules', 'FUNDAMENTALS.md'); // T1: the owner's rules, copied (~/.claude is never written)
  write(rules, fs.readFileSync(path.join(os.homedir(), '.claude', 'FUNDAMENTALS.md'), 'utf8'));
  const port = o.stop === 'close' ? await freePort() : null;
  const tag = goldenTag(rules, port);
  tagsLib.validate('sandbox', tag);
  write(path.join(tbHome, 'tags.json'), { sandbox: tag });
  write(path.join(tbHome, 'config.json'), harnessConfig(o, claude));
  if (o.dry) fs.mkdirSync(scn);
  const env = {
    root, tbHome, code, phases, scn, base, tag, plans, texts, date, claude, port, noDockerReserve: !!o.noDockerReserve, app: o.dry && port ? path.join(root, 'fake-app.js') : null,
    commonDir: fs.realpathSync(git(SANDBOX, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()),
    dry: o.dry ? Object.fromEntries(o.only.map((k) => [k, precommit(root, base, path.join(FIX, CASES[k].patch))])) : null,
    runMs: (o.capMin ?? (o.dry ? 15 : o.stop === 'close' ? 240 : 150)) * 60_000, poll: o.dry ? 1000 : 10_000,
    planned: o.only.reduce((n, k) => n + (o.runs ?? CASES[k].runs), 0),
    promptSha: crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 12),
  };
  if (env.app) write(env.app, FAKE_APP);
  console.log(`golden: ${o.dry ? 'DRY (fake claude)' : 'REAL (opus xhigh)'} · ${o.only.map((k) => `${k} ×${o.runs ?? CASES[k].runs}`).join(', ')}${o.stop === 'close' ? ` · stop close, qa port ${port}` : ''}${o.noDockerReserve ? ' · docker reserve 0' : ''} · root ${root}`);
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
      if (o.packet) {
        try {
          env.labels = packetOf(o.packet, results, { base: env.base, labelsFile: o.labels });
          console.log(`golden: blind packet ${o.packet} (${Object.keys(env.labels).length} item(s)) · labels ${o.labels}`);
        } catch (e) {
          env.packetError = e.message;
          console.log(`golden: blind packet refused: ${e.message}`);
        }
      }
      if (o.json) {
        try {
          write(o.json, scoreOf(results, { commit: git(REPO, 'rev-parse', 'HEAD').trim(), sandbox_base: env.base, mode: o.dry ? 'dry' : 'real' }));
          console.log(`golden: score JSON ${o.json}`);
        } catch (e) {
          env.jsonError = e.message;
          console.log(`golden: score JSON failed: ${e.message}`);
        }
      }
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
  const ok = !failed && !aborted && clean.length === env.planned && all.every((x) => x.ok) && !env.packetError && !env.jsonError;
  console.log(`golden: ${ok ? 'PASS' : 'FAIL'} · ${all.filter((x) => x.ok).length}/${all.length} scripted checks · ${clean.length}/${env.planned} clean runs · ${results.length - clean.length} contaminated`);
  process.exitCode = ok ? 0 : 1;
}

module.exports = { harnessConfig, codeCopy, freshPath, CASES, goldenTag, ticketText, guardHome, gatesRun, factsB, factsC, precommit, queueDry, report, DRY_MSG, queryInLoop, blockOf, removedLines, nonNicknameLines, specDiff, newTableCols, modelCols, firstCatch, loopEdits, contamination, checksB, checksC, checksCEmpty, B_NAMES, C_NAMES, CE_NAMES, parse,
  seed, cleanSandbox, live, phasesCopy, packetOf, scoreOf, blindDeny, reviewer, blindMerge };

if (require.main === module) {
  main().catch((e) => {
    console.log(`golden: error: ${e.message}`);
    process.exitCode = 1;
  });
}
