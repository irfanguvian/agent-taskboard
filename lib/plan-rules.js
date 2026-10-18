'use strict';
// plan-rules: every deterministic rule of a planner result in one module (contract J15 J16 J17 J18, U4), enforced
// twice: hooks/plan-check.js denies a StructuredOutput call that breaks one (the model fixes it in the same session; the
// hook fails open), and lib/planning.js's handler checks the result again after the run (authoritative: reasons →
// {reject}, resumed once with them, then Blocked). check(result, ctx) → reasons, [] = ok; each names its field.
// ctx (ctxOf): {locked: Irfan's decisions [{id, text, source}], must_ask, skills: installed names (or {name: dir}),
// base_sha, at?: the sha paths are checked at (replan: the branch HEAD, N4; default base_sha), test_scripts?: the tag's
// regex for `npm run <script>` (RO4), cwd: the worktree (null: folder tag, no path checks), git_dir + common_dir (S1:
// pinned for git; a ticket from before has none), git?: (args, input) → sh result (tests)}.
// Paths: ONE `git cat-file --batch-check` for every path the result names, at `at` (plus package.json at base_sha and
// one `cat-file blob` of it when a test_cmd runs an npm script), never a process per path; absolute paths and `..`
// segments are refused before git sees them. git via util.git: argv, GIT_SAFE + GIT_ENV, minimal env, a timeout (D31,
// D35d).
// P5 grammars live here, not under lib/gates/ (planning requires this at boot; lib/gates/ loads at the first gate):
// K6+M3 RO4 test_cmd → argv (testArgv); K10 allowed_* (parseAllowed, isAllowed, markAllowed). tbd re-parses both at
// gate time with the same functions.
const path = require('node:path');
const { git: gitIn, isObj, SHA_RE } = require('./util');
const { DEFAULT_SKILLS } = require('./skills');

const PLAN = ['summary', 'acceptance', 'tasks', 'allowed_schema_changes', 'allowed_api_changes', 'skills', 'ui', 'children'];
// planning.js answer() locks R<n>Q<qid> with source answer:R<n>Q<qid>; reject() locks R<n>C with source reject:R<n>
const SOURCE_RE = /^(answer:R\d+Q\S+|reject:R\d+|ticket|adr:\S+|planner)$/;
// placeholders: TBD / TODO (upper case, whole word: "a todo list" is a feature), "implement / fill in later", "same as
// T2"; "add (appropriate) error handling" and "handle edge cases" only as the whole step ("add error handling for 404
// from gh" says what)
const PLACEHOLDER = [/\b(?:TBD|TODO)\b/, /\b(?:implement|fill in) later\b|\b(?:similar|same) (?:to|as) T\d/i, /^(?:add (?:appropriate )?error handling|handle edge cases)\.?$/i];
// task ids and keep ids: a git ref part (refs/tb/<id>/<task>) and never @fix (working.js kindOf): no leading @ or -, no
// `..`, no trailing `.` or `.lock` (git check-ref-format)
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const badId = (id) => typeof id !== 'string' || !TASK_ID.test(id) || id.includes('..') || /\.(lock)?$/.test(id);
const CHILDREN_MAX = 20; // children of one plan
const MAX = 20; // reasons kept
const q = (v) => JSON.stringify(String(v).slice(0, 100)); // agent text inside a reason: quoted, short
const arr = (v) => (Array.isArray(v) ? v : []);
const parent = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

// A path as git takes it after `<sha>:` ('' = the root), or null: not a string, empty, absolute, a `..` segment or a
// control character (one line per path on git's stdin).
function rel(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..')) return null;
  if ([...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const n = path.posix.normalize(p).replace(/\/+$/, '');
  return n === '.' ? '' : n;
}

// ---- K6+M3 RO4: test_cmd grammar ----------------------------------------------------------------------------
// `npm test [-- args]` or `npm run <script> [-- args]`, nothing else (no shell: no &&, pipes, quotes, npx). Each arg a
// plain path word, never a flag (`-t x`, `--config=y`, `--passWithNoTests` skip or redirect the tests), no `..`, not
// absolute, ≤ 20. <script> (run only) matches the tag's test_scripts (least privilege: no `npm run deploy`). Pure: the
// caller checks the script in package.json at base_sha and each arg path at `at` (plan: it or its folder) or HEAD (gate).
const ARG_RE = /^(?!-)[A-Za-z0-9._@+/-]{1,200}$/;
const SCRIPT_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._:@/+-]{1,100}$/;
const TEST_SCRIPTS = '^test(:|$)';
const ARGS_MAX = 20;
const NPM = path.join(path.dirname(process.execPath), 'npm'); // D30: npm beside the node tbd runs on
const GRAMMAR = 'must be `npm test [-- <paths>]` or `npm run <test script> [-- <paths>]`';

/** @param {any} cmd @param {{test_scripts?: string, npm?: string}} [ctx] @returns {{argv: string[], script: string, paths: string[]} | {why: string}} */
function testArgv(cmd, ctx = {}) {
  if (typeof cmd !== 'string' || cmd.length > 5000) return { why: GRAMMAR };
  const [npm, verb, ...rest] = cmd.trim().split(/\s+/);
  const run = verb === 'run' && rest.length > 0;
  if (npm !== 'npm' || (verb !== 'test' && !run)) return { why: GRAMMAR };
  const script = run ? rest.shift() : 'test';
  if (rest.length && rest[0] !== '--') return { why: `${GRAMMAR}: args go after --` };
  const args = rest.slice(1);
  if (!SCRIPT_RE.test(script)) return { why: `npm script ${q(script)}: letters, digits and ._:@/+- only, no ..` };
  if (args.length > ARGS_MAX) return { why: `at most ${ARGS_MAX} args after --, got ${args.length}` };
  const bad = args.find((a) => !ARG_RE.test(a) || a.includes('..') || a.startsWith('/'));
  if (bad !== undefined) return { why: `arg ${q(bad)}: a relative path (letters, digits, ._@+/-), not a flag, no .. or leading /` };
  if (run) {
    let re;
    try {
      re = new RegExp(ctx.test_scripts ?? TEST_SCRIPTS);
    } catch {
      return { why: `the tag's test_scripts ${q(ctx.test_scripts)} is not a valid regex` }; // tags.js refuses it; fail closed
    }
    if (!re.test(script)) return { why: `npm script ${q(script)} is not a test script (tag test_scripts ${q(re.source)})` };
  }
  return { argv: [ctx.npm ?? NPM, ...(run ? ['run', script] : ['test']), ...rest], script, paths: args };
}
// the npm script a test_cmd runs, [] when it breaks the grammar (scripts/eval-planner.js reads it)
const scriptsOf = (cmd) => {
  const r = testArgv(cmd);
  return 'why' in r ? [] : [r.script];
};

// ---- K10: allowed_* grammar ------------------------------------------------------------------------------------
// Exact strings, one change each. Schema: drop M.f | drop M | drop E.V | rename M.a M.b | type M.f | required M.f.
// API: remove S.f | remove S | remove METHOD /path | required S.f | optional S.f | add-required S.f | type S.f |
// enum S.f, where S is a component name or an inline schema `METHOD /path#req|#<status>` (openapi.js names them; see
// its header for params and the S-level type/enum of a component). Normalized: whitespace runs
// → one space, path params `{id}` → `{}`, `#path.<name>` → `#path.<position>`, `#header.<Name>` lower case (openapi.js
// names them the same way). A change is allowed only by its exact
// string; `rename M.a M.b` also allows `drop M.a`, but only when the diff saw M.b added (never a prefix or a pattern).
const ID = '[A-Za-z_][A-Za-z0-9_]*'; // `_UserToTag`: Prisma's implicit m2m table
const SCHEMA_RE = new RegExp(`^(?:drop ${ID}(?:\\.${ID})?|rename (${ID})\\.${ID} \\1\\.${ID}|(?:type|required) ${ID}\\.${ID})$`);
const API_RE = /^(remove|required|optional|add-required|type|enum) (.+)$/;
const OP_PATH_RE = /^((?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) \/[^\s#]*)/;
// an API ref: `METHOD /path[#req|#<status>|#<in>.<name>][.field...]` or `S[.field...]` (S a component name); no spaces
// elsewhere, so prose ("remove nickname from UserDto: ...") is refused. S alone also takes type/enum: a component's own
// type or enum list changes too (an enum component).
const API_REF_RE = /^(?:(?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) \/[^\s#]*(?:#\S+)?|[A-Za-z0-9_][^\s#]*)$/;
// the METHOD /path part of an API ref normalized like openapi.js keys it
function apiNorm(ref) {
  const m = OP_PATH_RE.exec(ref);
  if (!m) return ref;
  const names = [...m[1].matchAll(/\{([^}]*)\}/g)].map((x) => x[1]);
  const rest = ref.slice(m[1].length)
    .replace(/^#path\.([^.\s]+)/, (all, n) => (names.includes(n) ? `#path.${names.indexOf(n)}` : all))
    .replace(/^#header\.([^.\s]+)/, (_, n) => `#header.${n.toLowerCase()}`);
  return m[1].replace(/\{[^}]*\}/g, '{}') + rest;
}
const ALLOWED_MAX = 50;
const ALLOWED_LEN = 300;
const HELP = {
  schema: 'drop M.f | drop M | drop E.V | rename M.a M.b | type M.f | required M.f',
  api: 'remove S.f | remove S | remove METHOD /path | required S.f | optional S.f | add-required S.f | type S.f | enum S.f',
};

/** @param {any} list @param {'schema'|'api'} kind @param {string} [at] @returns {{entries: string[], why: string[]}} */
function parseAllowed(list, kind, at = `allowed_${kind}_changes`) {
  if (!Array.isArray(list)) return { entries: [], why: [`${at}: a list of strings`] };
  if (list.length > ALLOWED_MAX) return { entries: [], why: [`${at}: at most ${ALLOWED_MAX} entries, got ${list.length}`] };
  const entries = [];
  const why = [];
  for (const [i, s] of list.entries()) {
    const e = typeof s === 'string' && s.length <= ALLOWED_LEN && ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      ? s.trim().replace(/\s+/g, ' ') : null;
    const m = e === null ? null : kind === 'schema' ? SCHEMA_RE.exec(e) : API_RE.exec(e);
    const ok = m && (kind === 'schema' || API_REF_RE.test(m[2]));
    if (ok) entries.push(kind === 'api' ? `${m[1]} ${apiNorm(m[2])}` : e);
    else why.push(`${at}[${i}] ${q(s)}: not one change in the exact form ${HELP[kind]}`);
  }
  return { entries, why };
}

/** @param {{op: string, ref: string}} change @param {string[]} entries parseAllowed's @param {string[]} [added] refs the diff saw added (rename) */
function isAllowed(change, entries, added = []) {
  if (entries.includes(`${change.op} ${change.ref}`)) return true;
  return change.op === 'drop' && entries.some((e) => {
    const m = /^rename (\S+) (\S+)$/.exec(e);
    return !!m && m[1] === change.ref && added.includes(m[2]);
  });
}

// A diff's changes with `allowed` set + the entries no change used (the gate reports them: the plan drifted).
/** @template {{op: string, ref: string}} C @param {C[]} changes @param {string[]} entries @param {string[]} [added] @returns {{changes: (C & {allowed: boolean})[], unused: string[]}} */
function markAllowed(changes, entries, added = []) {
  const marked = changes.map((c) => ({ ...c, allowed: isAllowed(c, entries, added) }));
  const unused = entries.filter((e) => !marked.some((c) => c.allowed && isAllowed(c, [e], added)));
  return { changes: marked, unused };
}

// D-0116: round 1 is questions: a flag, or a ticket with no answers and no inherited locked decisions.
/** @param {any} t */
const round1 = (t) => !t.answers?.length && !t.locked_decisions?.length;
const mustAsk = (t) => !!t.must_ask || round1(t);

// The ctx of a ticket's planning run: what tbd knows. spawn writes it to runs/<n>.plan-ctx.json for the hook. o.at: the
// sha paths are checked at (replan: the branch HEAD, N4); o.test_scripts: the tag's (RO4); o.keep_ok: the old plan's
// done task ids in order (replan, K4). Each left out when unset.
/** @param {any} t @param {any} skills @param {{at?: string, test_scripts?: string, keep_ok?: string[]}} [o] */
const ctxOf = (t, skills, o = {}) => ({
  locked: t.locked_decisions ?? [], must_ask: !!t.must_ask, round1: round1(t), skills, base_sha: t.base_sha ?? null, cwd: t.worktree ?? null,
  ...(t.git_dir && { git_dir: t.git_dir, common_dir: t.common_dir, ...(t.clone && { clone: t.clone }) }), // H2.2: a clone pins like util.git
  ...(o.at && { at: o.at }), ...(o.test_scripts && { test_scripts: o.test_scripts }), ...(o.keep_ok && { keep_ok: o.keep_ok }),
});

/** @param {any} out @param {{locked?: any[], must_ask?: boolean, round1?: boolean, skills?: string[] | Record<string, string>, base_sha?: string | null, at?: string, test_scripts?: string, keep_ok?: string[], cwd?: string | null, git_dir?: string, common_dir?: string, clone?: {config: string}, git?: (args: string[], input?: string) => Promise<any>}} ctx @returns {Promise<string[]>} */
async function check(out, ctx) {
  if (!isObj(out)) return ['the result must be a JSON object'];
  const why = [];
  const paths = []; // {p: as named, at: its field, need: 'any' | 'tree' | 'blob' | 'file' | 'arg' (it, or its folder)}
  const scripts = []; // {name, at}
  const plan = out.kind === 'plan';
  if (out.kind === 'questions') {
    if (!arr(out.questions).length) why.push('kind "questions" needs at least one question');
    const extra = PLAN.filter((k) => out[k] !== undefined);
    if (extra.length) why.push(`kind "questions" carries plan fields ${extra.join(', ')}: leave them out, or return kind "plan"`);
  } else if (plan) {
    if (ctx.must_ask) return ['Irfan asked to be asked more first (must_ask): return kind "questions" this round, not a plan'];
    if (ctx.round1) return ['round 1 must be questions (no answers or locked decisions yet)'];
    if (out.questions !== undefined) why.push('kind "plan" carries questions: leave them out, or return kind "questions"');
    const missing = PLAN.filter((k) => out[k] === undefined);
    if (missing.length) why.push(`a plan needs ${missing.join(', ')}`);
  } else return [`kind must be "questions" or "plan", got ${q(out.kind)}`];

  const qids = new Set();
  for (const [i, x] of arr(out.questions).entries()) {
    const n = arr(x.options).length;
    const nid = typeof x.id === 'string' ? x.id.replace(/^Q/, '') : x.id; // the locked id: R<n>Q<nid> (planning.answer)
    if (typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(x.id)) why.push(`questions[${i}].id ${q(x.id)}: 1-16 letters, digits, _ or - (e.g. "Q1")`); // the page's form key + the locked id (M5.4 sec)
    if (qids.has(nid)) why.push(`questions[${i}].id ${q(x.id)}: questions need unique ids ("Q1" and "1" are the same)`);
    qids.add(nid);
    if (n < 2 || n > 4) why.push(`questions[${i}].options: 2 to 4 options, got ${n}`);
    if (!arr(x.options).includes(x.recommended)) why.push(`questions[${i}].recommended ${q(x.recommended)}: must be exactly one of its options`);
    if (arr(x.options).includes(x.recommended) && x.options[0] !== x.recommended) why.push(`questions[${i}].options: list the recommended option ${q(x.recommended)} first`);
    if (typeof x.why !== 'string' || !x.why.trim()) why.push(`questions[${i}].why: say why the answer matters`);
  }

  // J17: a locked id comes back with Irfan's text or not at all (the runner merges them into decisions.json)
  const locked = new Map(arr(ctx.locked).map((d) => [d.id, d]));
  for (const [i, d] of arr(out.decisions).entries()) {
    const l = locked.get(d.id);
    if (l && d.text !== l.text) why.push(`decisions[${i}] ${q(d.id)}: Irfan locked it as ${q(l.text)}: return his text exactly or leave it out`);
    if (!SOURCE_RE.test(d.source)) why.push(`decisions[${i}].source ${q(d.source)}: must be answer:R<n>Q<id>, reject:R<n>, ticket, adr:<path> or planner`);
    else if (/^(answer|reject):/.test(d.source) && !l) why.push(`decisions[${i}].source ${q(d.source)}: answer: and reject: are only for Irfan's locked decisions, ${q(d.id)} is not one: use planner or ticket`);
    else if (d.source.startsWith('adr:')) paths.push({ p: d.source.slice(4), at: `decisions[${i}].source`, need: 'blob' }); // an ADR is a file
  }
  for (const [i, f] of arr(out.facts).entries()) {
    const m = /^([^\s:]+):/.exec(String(f));
    if (m) paths.push({ p: m[1], at: `facts[${i}]`, need: 'any' });
    else why.push(`facts[${i}] ${q(f)}: start with the path it is about: "<path>: <fact>"`);
  }

  if (plan) {
    const acc = new Set(arr(out.acceptance).map((a) => a.id));
    const covered = new Set();
    const before = new Set(); // task ids listed so far: blocked_by names only these (no cycle, order kept)
    for (const [i, x] of arr(out.tasks).entries()) {
      const at = `tasks[${i}]`;
      if (badId(x.id)) why.push(`${at}.id ${q(x.id)}: 1-32 letters, digits, . _ - only, starting with a letter or digit, no .. and no .lock ending`);
      if (before.has(x.id)) why.push(`${at}.id ${q(x.id)}: tasks need unique ids`);
      if (x.type !== 'new' && x.type !== 'preserve') why.push(`${at}.type ${q(x.type)}: must be "new" or "preserve"`);
      for (const b of arr(x.blocked_by)) if (!before.has(b)) why.push(`${at}.blocked_by ${q(b)}: name only tasks listed before this one`);
      before.add(x.id);
      for (const a of arr(x.acceptance)) {
        if (acc.has(a)) covered.add(a);
        else why.push(`${at}.acceptance ${q(a)}: no such acceptance id`);
      }
      arr(x.files).forEach((p, j) => paths.push({ p, at: `${at}.files[${j}]`, need: 'file' }));
      for (const [j, p] of arr(x.modules).entries()) { // M6: a module is a folder below the root, never the root itself
        if (rel(p) === '') why.push(`${at}.modules[${j}] ${q(p)}: a folder below the repo root, not the root itself`);
        else paths.push({ p, at: `${at}.modules[${j}]`, need: 'tree' });
      }
      for (const [k, s] of [['title', x.title], ...arr(x.steps).map((s, j) => [`steps[${j}]`, s])]) {
        const text = String(s).trim();
        const m = PLACEHOLDER.map((re) => re.exec(text)).find(Boolean);
        if (m) why.push(`${at}.${k}: placeholder ${q(m[0])}: say exactly what to do`);
      }
      const cmd = testArgv(x.test_cmd, ctx);
      if ('why' in cmd) why.push(`${at}.test_cmd ${q(x.test_cmd)}: ${cmd.why}`);
      else {
        scripts.push({ name: cmd.script, at: `${at}.test_cmd` });
        cmd.paths.forEach((p) => paths.push({ p, at: `${at}.test_cmd`, need: 'arg' }));
      }
    }
    for (const a of acc) if (!covered.has(a)) why.push(`acceptance ${q(a)}: no task covers it: list it in a task's acceptance`);
    // K4+C2 M4: keep = the longest prefix of the old plan's done tasks this plan keeps; the runner copies them from the
    // old frozen plan and resets to the last kept commit, so the ids, their order and their place in tasks must match
    if (arr(out.keep).length) { // keep: [] = no keep (a first plan) or keep nothing (a replan)
      const keep = arr(out.keep);
      const ok = Array.isArray(ctx.keep_ok) ? ctx.keep_ok : null;
      if (!ok) why.push('keep: keep only on a replan');
      else {
        const gone = keep.filter((id) => !ok.includes(id));
        for (const id of keep) if (badId(id)) why.push(`keep ${q(id)}: not a valid task id`);
        for (const id of gone) why.push(`keep ${q(id)}: not a done task of the old plan (${ok.map(q).join(', ') || 'none'})`);
        if (!gone.length && keep.some((id, i) => ok[i] !== id)) why.push(`keep: a prefix of the old plan's done tasks in their order (${ok.map(q).join(', ')})`);
        if (keep.some((id, i) => arr(out.tasks)[i]?.id !== id)) why.push('keep: the kept tasks come first in tasks, in the same order');
      }
    }
    why.push(...parseAllowed(out.allowed_schema_changes ?? [], 'schema').why, ...parseAllowed(out.allowed_api_changes ?? [], 'api').why);

    // + the board default list: its plugin skills (caveman, ponytail, frontend-design) live outside ~/.claude/skills
    const known = new Set([...(Array.isArray(ctx.skills) ? ctx.skills : Object.keys(ctx.skills ?? {})), ...DEFAULT_SKILLS]);
    const unknown = arr(out.skills).filter((s) => !known.has(s));
    if (unknown.length) why.push(`unknown skills ${unknown.map(q).join(', ')}: name only installed skills`);

    // J3: children name "parent" or siblings, unique ids, no cycle, at most CHILDREN_MAX
    const kids = arr(out.children);
    if (kids.length > CHILDREN_MAX) why.push(`at most ${CHILDREN_MAX} children, got ${kids.length}: fold the rest into fewer`);
    const ids = new Set(kids.map((c) => c.id));
    if (ids.size !== kids.length || ids.has('parent')) why.push('children need unique ids, none of them "parent"');
    for (const c of kids) {
      const title = String(c.title ?? '').trim();
      const text = String(c.text ?? '');
      if (!title || title.length > 500 || !text.trim() || text.length > 100_000) why.push(`child ${q(c.id)}: title 1-500 and text 1-100000 characters`);
      const no = arr(c.blocked_by).filter((b) => b !== 'parent' && (b === c.id || !ids.has(b)));
      if (no.length) why.push(`child ${q(c.id)}: blocked_by ${no.map(q).join(', ')} must name "parent" or another child`);
    }
    const sibs = new Map(kids.map((c) => [c.id, arr(c.blocked_by).filter((b) => b !== 'parent')]));
    const left = new Map(sibs);
    for (let size = -1; size !== left.size;) { // peel children whose sibling blockers are gone; what stays is a cycle
      size = left.size;
      for (const [id, deps] of left) if (!deps.some((b) => left.has(b))) left.delete(id);
    }
    if (left.size) why.push(`children blocked_by form a cycle: ${[...left.keys()].map(q).join(', ')}`);
    // C15 (D-0091): a child starts on one blocker's final commit, never a rebase: its blockers form one chain (of any
    // two, one reaches the other through blocked_by; "parent" counts, and every child reaches it: store.createChildren)
    const reaches = (a, b, seen = new Set()) => arr(sibs.get(a)).some((x) => x === b || (!seen.has(x) && !!seen.add(x) && reaches(x, b, seen)));
    for (const [id, deps] of sibs) {
      const bs = [...new Set(deps)];
      const off = bs.flatMap((a, i) => bs.slice(i + 1).filter((b) => !reaches(a, b) && !reaches(b, a)).map((b) => `${q(a)} and ${q(b)}`));
      if (off.length) why.push(`child ${q(id)}: blockers diverge: no rebase (D-0091): ${off.slice(0, 3).join(', ')}: neither reaches the other; chain them (one blocked_by the other) or merge the children`);
    }
  }

  if (ctx.cwd && (paths.length || scripts.length)) await atBase(ctx, paths, scripts, why);
  return why.length > MAX ? [...why.slice(0, MAX), `(+${why.length - MAX} more)`] : why;
}

// The path rules at `at` (base_sha unless a replan names the branch HEAD, N4): one cat-file --batch-check for every
// path, each file's folder and package.json at base_sha; then package.json's scripts (one cat-file blob) for the npm
// scripts the test_cmds run (RO4: at base_sha, never the branch's). A git failure throws (the hook allows, the runner
// blocks).
async function atBase(ctx, paths, scripts, why) {
  if (!SHA_RE.test(ctx.base_sha ?? '')) throw new Error(`plan-rules: base_sha missing in a worktree ticket: paths can't be checked`);
  const at = ctx.at ?? ctx.base_sha;
  if (!SHA_RE.test(at)) throw new Error(`plan-rules: ctx.at ${q(at)} is not a sha`);
  const where = at === ctx.base_sha ? 'base' : 'branch HEAD';
  const git = ctx.git ?? ((args, input) => gitIn(ctx.cwd, args, { timeout: 10_000, input, dirs: ctx }));
  const PKG = `${ctx.base_sha}:package.json`;
  const ask = new Set(scripts.length ? [PKG] : []); // `<sha>:<path>` specs, one line each
  const ok = [];
  for (const x of paths) {
    const p = rel(x.p);
    if (p === null) {
      why.push(`${x.at} ${q(x.p)}: a path relative to the repo root, without a leading / or .. segments`);
      continue;
    }
    ok.push({ ...x, rel: p });
    ask.add(`${at}:${p}`);
    if (x.need === 'file' || x.need === 'arg') ask.add(`${at}:${parent(p)}`);
  }
  const list = [...ask];
  const r = await git(['cat-file', '--batch-check'], list.map((s) => `${s}\n`).join(''));
  const lines = String(r.stdout ?? '').split('\n');
  if (r.err || lines.length <= list.length) throw new Error(`plan-rules: git cat-file --batch-check: ${String(r.stderr || r.err?.message || 'short output').trim().slice(0, 200)}`);
  const kinds = new Map(list.map((s, i) => [s, / (missing|ambiguous)$/.test(lines[i]) ? null : lines[i].split(' ')[1]]));
  const type = (p) => kinds.get(`${at}:${p}`);
  for (const x of ok) {
    const t = type(x.rel);
    if (x.need === 'tree' && t !== 'tree' && t !== 'commit') why.push(`${x.at} ${q(x.p)}: not a folder at ${where}`);
    // a new test file (arg) goes in an existing folder below the root: a bare word (`-- invoice`) passes at plan time
    // only to fail at the gate, where every arg must exist at HEAD
    else if (x.need === 'arg' && !t && parent(x.rel) === '') why.push(`${x.at} ${q(x.p)}: not at ${where}; a new test file goes in an existing folder below the repo root`);
    else if ((x.need === 'file' || x.need === 'arg') && !t && type(parent(x.rel)) !== 'tree') why.push(`${x.at} ${q(x.p)}: neither the file nor its folder exists at ${where}`);
    else if (x.need === 'file' && (t === 'tree' || t === 'commit')) why.push(`${x.at} ${q(x.p)}: a folder, not a file: name the files (modules takes folders)`);
    else if (x.need === 'any' && !t) why.push(`${x.at} ${q(x.p)}: no such file or folder at ${where}`);
    else if (x.need === 'blob' && t !== 'blob') why.push(`${x.at} ${q(x.p)}: no such file at ${where}`);
  }
  if (!scripts.length) return;
  let have = null;
  if (kinds.get(PKG) === 'blob') {
    const b = await git(['cat-file', 'blob', `${ctx.base_sha}:package.json`]);
    if (b.err) throw new Error(`plan-rules: git cat-file blob package.json: ${String(b.stderr || b.err.message).trim().slice(0, 200)}`);
    try {
      have = JSON.parse(b.stdout).scripts;
    } catch { /* not JSON: no scripts */ }
  }
  for (const s of scripts) if (!isObj(have) || !Object.hasOwn(have, s.name)) why.push(`${s.at}: npm script ${q(s.name)} is not in package.json at base`);
}

module.exports = { check, ctxOf, mustAsk, q, testArgv, scriptsOf, parseAllowed, isAllowed, markAllowed, PLAN, SOURCE_RE, TEST_SCRIPTS };
