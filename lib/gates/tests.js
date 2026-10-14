'use strict';
// gates/tests: test weakening, read statically (contract M5+N7), pure. Input: the changed and deleted test blobs at
// pre and at HEAD (strings: the CLI reads the files git wrote; the scope check already refused a blob > 5 MB, M6) and the
// deleted test paths. tbd never runs scan itself: the task gate runs this file as a capped child (CLI below, R.child).
// No test runs: a preserve task never runs at pre. The task gate goes red ("return TEST_DISPUTES_SPEC") on any of:
//   - skips_added: a skip/only/todo/focus marker more at HEAD than at pre, per file (jest, vitest, node:test forms; a
//     computed access `describe['skip'](…)` and an empty table `it.each([])` count as markers too);
//   - deleted: a test file gone;
//   - count_drops: a file whose test count fell (contract regex `\b(it|test)(\.each)?\s*\(`, minus `re.test(`, plus
//     .concurrent/.sequential and node:test subtests `t.test('b', fn)`; per path: tests added in file A never hide a
//     drop in file B; `count` keeps the totals).
// expects_removed (an `expect(` line at pre, gone at HEAD) is listed for review, never red: a legit contract change
// drops asserts (trap C). Counts and markers read the code only: comments dropped, string/template/regex contents
// emptied, so a commented-out test leaves the count and a test name can't fake one. ponytail: a scanner, not a parser
// (a regex right after `)`, as in `if (x) /re/`, reads as division and can desync it); markers are also counted on the
// raw text minus whole-line `//` comments (no scanner: a regex holding `/*` can't hide the rest) and either rise counts,
// so a desync can't hide one. Residuals: a test title or a trailing comment naming a marker ('rejects it.only',
// `x(); // it.only`) still counts there (a false red, fail closed); a marker after more than 4 chained modifiers
// (`describe.a.b.c.d.only`) is missed (the regexes are bounded, see MARK_RES).
// isTestFile / testFiles: K7/R2 test files = tag test_globs minus protected (protected wins: test/utils/** is a helper the
// tests lean on, editing it can weaken every test at once, so it asks instead of counting as a test); globs: the gates'
// file-glob matcher, compiled once (matchesGlob's semantics).
// missingNames: K7 `proven_missing` (rev 4.1) — the names a failing run at pre says are missing (TS2305/TS2307/
// TS2339, Cannot find module, missing ESM export, jest's unmapped module, `is not a function`), ANSI stripped; the
// caller checks the task's non-test diff adds every one (added, in the child: the diff is the agent's).
// trailers: D34, the commits whose message carries an AI attribution (task.js trailer, in the child: the messages are
// the agent's). Every list a child returns is capped at LIST_MAX entries (its JSON is parsed in tbd).
const fs = require('node:fs');
const path = require('node:path');
const { d34 } = require('../util');

// markers anchored on a test function or node:test's `t` (it.skip, describe.concurrent.only, t.todo), so ordinary code
// (`expect(dto.skip)`, `run.fails`, `chart.fit()`) is no marker
// Every quantifier is bounded (an agent writes these files; scan runs in a child with a 30 s timeout, still: an
// unbounded `*` here went quadratic, 80 KB → 65 s): ≤ 4 chained modifiers of ≤ 64 characters, ≤ 40 spaces, option
// windows ≤ 200 chars and never past a `{` (an options object holding a nested `{` before skip: is missed).
// One pass per marker family (label order = skips_added order):
const LABELS = ['.skip', '.only', '.todo', '.skipIf', '.runIf', '.fails', 'xit', 'xtest', 'xdescribe', 'fit', 'fdescribe', '{ skip }', '{ todo }', '[key]', '.each([])'];
/** @type {[RegExp, (m: RegExpMatchArray) => string][]} */
const MARK_RES = [
  [/\b(?:it|test|describe|suite|t)(?:\.\w{1,64}){0,4}\.(skip|only|todo|skipIf|runIf|fails)\b/g, (m) => `.${m[1]}`],
  [/(?<![.\w$])(xit|xtest|xdescribe|fit|fdescribe)(?:\.each)?\s{0,40}\(/g, (m) => m[1]], // fit.each(...) = it.only.each
  // node:test options as the 2nd argument: test('name', { skip: true }, fn); any value but a literal false
  [/\b(?:it|test|describe|suite)\s{0,40}\([^,(){}]{0,200},\s{0,40}\{[^{}]{0,200}\b(skip|todo)\s{0,40}:(?!\s{0,40}false\b)/g, (m) => `{ ${m[1]} }`],
  [/\b(?:it|test|describe)\s{0,40}\[/g, () => '[key]'], // describe['skip'](…): a marker no dotted form names
  [/\.each\(\s{0,40}\[\s{0,40}\]\s{0,40}\)/g, () => '.each([])'], // an empty table: the test is counted, never runs
];
// label → how many times a text holds it
function marks(text) {
  const n = new Map();
  for (const [re, label] of MARK_RES) for (const m of text.matchAll(re)) n.set(label(m), (n.get(label(m)) ?? 0) + 1);
  return n;
}
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm; // whole-line // comments ([ \t], not \s: \s spans lines and goes quadratic)
// a test: it( / test( (+ .each / .concurrent / .sequential), or a node:test subtest `t.test('title', fn)` (its title is
// emptied to '' in the code-only text, a comma follows) or with a variable title `t.test(name, fn)`; `re.test(x)` and
// `re.test('str')` are no test (one argument, no comma)
const COUNT_RE = /(?<!\.)\b(?:it|test)(?:\.(?:each|concurrent|sequential)){0,3}\s{0,40}\(|\.test\s{0,40}\(\s{0,40}(?:(['"`])\1|[\w$.]{1,200})\s{0,40},/g;
const EXPECT_RE = /\bexpect\s*\(/;
const LIST_MAX = 100; // entries per returned list (expects_removed lines: each ≤ 200 characters)
// matches of a /g regex, no match array built (a 5 MB blob holds a million)
const count = (s, re) => {
  let n = 0;
  for (re.lastIndex = 0; re.exec(s);) n++;
  return n;
};

// a `/` after one of these (or a keyword) starts a regex literal, else it divides
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// JS/TS source → {code: comments dropped, literals kept; blank: comments dropped, string/template/regex contents emptied}
// One pass, linear: plain runs are copied as slices (never char by char: a 5 MB blob must not build 5M strings).
function views(src) {
  const code = [];
  const blank = [];
  let run = 0; // start of the plain text not copied yet
  const flush = (i) => {
    if (i <= run) return;
    code.push(src.slice(run, i));
    blank.push(src.slice(run, i));
  };
  let prev = ''; // the last significant char, or the word it ended
  let word = false; // the last char kept was part of a word
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { // line comment: up to the newline (kept)
      flush(i);
      const e = src.indexOf('\n', i);
      i = (e < 0 ? src.length : e) - 1;
      run = i + 1;
      word = false;
    } else if (c === '/' && n === '*') { // block comment: its newlines kept, else one space
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      const keep = src.slice(i, end).replace(/[^\n]/g, '') || ' ';
      flush(i);
      code.push(keep);
      blank.push(keep);
      i = end - 1;
      run = end;
      word = false;
    } else if (c === '"' || c === "'" || c === '`' || (c === '/' && (prev === '' || REGEX_AFTER.has(prev) || REGEX_WORDS.has(prev)))) {
      let j = i + 1;
      for (let cls = false; j < src.length; j++) { // to the closing quote; \ escapes; a regex [class] may hold a /
        const d = src[j];
        if (d === '\\') j++;
        else if (d === '\n' && c !== '`') break;
        else if (c !== '/' && d === c) break;
        else if (c === '/' && d === '[') cls = true;
        else if (c === '/' && d === ']') cls = false;
        else if (c === '/' && d === '/' && !cls) break;
      }
      flush(i);
      code.push(src.slice(i, j + 1));
      blank.push(c + c);
      prev = c;
      word = false;
      i = j;
      run = j + 1;
    } else {
      const k = src.charCodeAt(i);
      const w = (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k === 36; // [\w$]
      if (w) prev = word ? (prev.length < 16 ? prev + c : prev) : c; // keywords are short: no 5 MB word string
      else if (k !== 32 && (k < 9 || k > 13)) prev = c;
      word = w;
    }
  }
  flush(src.length);
  return { code: code.join(''), blank: blank.join('') };
}

// expect( lines of a file, trimmed → how many times each
function expects(code) {
  const m = new Map();
  for (const l of code.split('\n')) {
    const t = l.trim().slice(0, 200);
    if (EXPECT_RE.test(t)) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/**
 * @param {{pre: Record<string, string>, head: Record<string, string>, deleted?: string[]}} o path → blob text; a path
 *   missing on one side is a new (pre) or deleted (head) file
 * @returns {{skips_added: string[], deleted: string[], expects_removed: string[], count: {pre: number, head: number},
 *   count_drops: string[]}} count_drops: `<path>: <pre> → <head>`
 */
function scan({ pre, head, deleted = [] }) {
  const v = (blobs) => new Map(Object.entries(blobs).map(([p, s]) => {
    const raw = String(s ?? '');
    const w = views(raw);
    return [p, { ...w, mb: marks(w.blank), ml: marks(raw.replace(LINE_COMMENT, '')) }];
  }));
  const P = v(pre);
  const H = v(head);
  const none = { code: '', blank: '', mb: new Map(), ml: new Map() };
  const skips = [];
  const drops = [];
  const gone = [];
  let [nPre, nHead] = [0, 0];
  for (const [p, h] of H) {
    const b = P.get(p) ?? none;
    const more = (x, y, mark) => (x.get(mark) ?? 0) > (y.get(mark) ?? 0);
    for (const mark of LABELS) if (skips.length < LIST_MAX && (more(h.mb, b.mb, mark) || more(h.ml, b.ml, mark))) skips.push(`${p}: ${mark}`);
  }
  for (const p of new Set([...P.keys(), ...H.keys()])) {
    const [b, h] = [P.get(p) ?? none, H.get(p) ?? none];
    const [x, y] = [count(b.blank, COUNT_RE), count(h.blank, COUNT_RE)];
    nPre += x;
    nHead += y;
    if (y < x && drops.length < LIST_MAX) drops.push(`${p}: ${x} → ${y}`);
    if (gone.length >= LIST_MAX) continue; // listed enough: no more work
    const left = expects(h.code);
    for (const [line, k] of expects(b.code)) {
      for (let i = left.get(line) ?? 0; i < k && gone.length < LIST_MAX; i++) gone.push(`${p}: ${line}`);
    }
  }
  return { skips_added: skips, deleted: deleted.slice(0, LIST_MAX), expects_removed: gone, count: { pre: nPre, head: nHead }, count_drops: drops };
}

// K7: of names (identifiers), those the added lines of a `git diff -U0` add: `+` lines per file (a `+++` header starts
// the next: an unclosed literal never blanks another file), comments dropped and string/template/regex contents
// emptied (views: linear; a regex here went quadratic, 160 KB → 8.7 s), then a [\w$] boundary on both sides
function added(diff, names) {
  const files = [[]];
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++')) files.push([]);
    else if (l.startsWith('+')) files.at(-1).push(l.slice(1));
  }
  const blanks = files.map((f) => views(f.join('\n')).blank);
  return names.filter((n) => {
    const re = new RegExp(`(^|[^\\w$])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`, 'm');
    return blanks.some((b) => re.test(b));
  });
}

// D34: `git log --format='%H %B%x00'` → the short shas of the messages util.d34 flags (`co-authored-by:` and then claude
// or anthropic on the same line, or `generated with` anywhere, any case; linear).
function trailers(log) {
  const hits = [];
  for (const m of log.split('\0')) if (d34(m) !== null && hits.length < LIST_MAX) hits.push(m.trim().slice(0, 12));
  return hits;
}

// file globs → one matcher, compiled once: path.posix.matchesGlob's semantics (minimatch, dot:false) at regex speed
// (matchesGlob compiles per call: 20k paths × 23 globs = 1.4 s on tbd's thread). `*` one part, `**` any depth, `?`,
// [class] ([!…] negates), {a,b}; `*` / `**` / `?` never match a part starting with `.` unless the pattern part does.
// ponytail: no extglob (`+(…)`, `!(…)`): read as literal characters.
// Case-insensitive by default, as matchesGlob is for wildcards and as APFS resolves names (`TSConfig.json` IS
// tsconfig.json to tsc): protected / test globs then over-match, the safe side. nocase false for globs that WIDEN
// scope (generated): there the safe side is the narrow match.
function globs(list, nocase = true) {
  const expand = (g) => {
    const m = /\{([^{}]*)\}/.exec(g);
    return m ? m[1].split(',').flatMap((x) => expand(g.slice(0, m.index) + x + g.slice(m.index + m[0].length))) : [g];
  };
  const part = (p) => {
    let out = p.startsWith('.') ? '' : '(?!\\.)';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      const j = c === '[' ? p.indexOf(']', i + 2) : -1;
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if (j > 0) {
        out += `[${p[i + 1] === '!' ? '^' : p[i + 1]}${p.slice(i + 2, j).replace(/[\\\]]/g, '\\$&')}]`;
        i = j;
      } else out += /[.+^$|(){}[\]\\]/.test(c) ? `\\${c}` : c;
    }
    return out;
  };
  const re = (g) => {
    const ps = g.split('/');
    // `**` within: any number of parts, each with its `/`; last: anything below (or nothing)
    const body = ps.map((p, i) => (p === '**' ? (i < ps.length - 1 ? '(?:(?!\\.)[^/]+/)*' : '(?:(?!\\.)[^/]*(?:/(?!\\.)[^/]*)*)?') : part(p) + (i < ps.length - 1 ? '/' : '')));
    return new RegExp(`^${body.join('')}$`, nocase ? 'i' : '');
  };
  const res = list.flatMap(expand).map(re);
  return (/** @type {string} */ p) => res.some((r) => r.test(p));
}
// K7/R2 test files, compiled once: (path) → test_globs and not protected
const testFiles = (/** @type {string[]} */ testGlobs, /** @type {string[]} */ protectedGlobs) => {
  const [t, pr] = [globs(testGlobs), globs(protectedGlobs)];
  return (/** @type {string} */ p) => !pr(p) && t(p);
};
/** @param {string} p repo-relative @param {string[]} testGlobs @param {string[]} protectedGlobs */
const isTestFile = (p, testGlobs, protectedGlobs) => testFiles(testGlobs, protectedGlobs)(p);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'); // ts-jest colours TS diagnostics even with NO_COLOR (spike)
const MISSING = [
  /error TS2305: Module '[^']*' has no exported member '([^']+)'/g,
  /error TS2339: Property '([^']+)' does not exist/g,
  /Cannot find module '([^']+)'/g, // TS2307 and jest's CJS resolver
  /does not provide an export named '([^']+)'/g, // ESM: the requested module './x.js' ...
  /Could not locate module (\S+) mapped as/g, // jest moduleNameMapper
  /([\w$]+)\)? is not a function/g, // svc.fn / (0 , _mod.fn) is not a function
];

/** @param {string} output a check's log (head + tail) @returns {string[]} unique, in order of first mention */
function missingNames(output) {
  const text = String(output ?? '').replace(ANSI, '');
  const names = new Set();
  for (const re of MISSING) for (const m of text.matchAll(re)) names.add(m[1]);
  return [...names];
}

// ---- CLI (a child of tbd: own process, so sync fs is fine) ---------------------------------------------------------
// `node --max-old-space-size=96 lib/gates/tests.js <dir>` (96 MB: 5 legit 5 MB test files pass, a hostile 5 MB one
// dies), by <dir>/manifest.json's mode → one JSON line:
//   (none) {pre, head: {path: blob sha}, deleted: [path]}, each blob in <dir>/<sha> → scan's result;
//   'trailers': <dir>/log (git log) → {hits}; 'added' {names}: <dir>/diff (git diff -U0) → {found}.
// Exit: 0 ok; 2 usage; 1 anything else.
if (require.main === module) {
  const [dir] = process.argv.slice(2);
  try {
    if (!dir) throw Object.assign(new Error('usage: tests.js <dir>'), { exit: 2 });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const file = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    const read = (side) => Object.fromEntries(Object.entries(side).map(([p, sha]) => [p, file(sha)]));
    const out = m.mode === 'trailers' ? { hits: trailers(file('log')) } : m.mode === 'added' ? { found: added(file('diff'), m.names) }
      : scan({ pre: read(m.pre), head: read(m.head), deleted: m.deleted });
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    process.stderr.write(`${String(e.message).slice(0, 1000)}\n`);
    process.exitCode = e.exit ?? 1;
  }
}

module.exports = { scan, globs, testFiles, isTestFile, missingNames, trailers, added };
