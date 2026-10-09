'use strict';
// plan-rules: every deterministic rule of a planner result in one module (contract J15 J16 J17 J18, U4), enforced
// twice: hooks/plan-check.js denies a StructuredOutput call that breaks one (the model fixes it in the same session; the
// hook fails open), and lib/planning.js's handler checks the result again after the run (authoritative: reasons →
// {reject}, resumed once with them, then Blocked). check(result, ctx) → reasons, [] = ok; each names its field.
// ctx (ctxOf): {locked: Irfan's decisions [{id, text, source}], must_ask, skills: installed names (or {name: dir}),
// base_sha, cwd: the worktree (null: folder tag, no path checks), git_dir + common_dir (S1: pinned for git; a ticket
// from before has none), git?: (args, input) → sh result (tests)}.
// Paths: ONE `git cat-file --batch-check` for every path the result names, at base_sha (plus one `cat-file blob` of
// package.json when a test_cmd runs an npm script), never a process per path; absolute paths and `..` segments are
// refused before git sees them. git via util.git: argv, GIT_SAFE + GIT_ENV, minimal env, a timeout (D31, D35d).
// allowed_* grammar: P5.
const path = require('node:path');
const { git: gitIn, isObj } = require('./util');

const PLAN = ['summary', 'acceptance', 'tasks', 'allowed_schema_changes', 'allowed_api_changes', 'skills', 'ui', 'children'];
// planning.js answer() locks R<n>Q<qid> with source answer:R<n>Q<qid>; reject() locks R<n>C with source reject:R<n>
const SOURCE_RE = /^(answer:R\d+Q\S+|reject:R\d+|ticket|adr:\S+|planner)$/;
// placeholders: TBD / TODO (upper case, whole word: "a todo list" is a feature), "implement / fill in later", "same as
// T2"; "add (appropriate) error handling" and "handle edge cases" only as the whole step ("add error handling for 404
// from gh" says what)
const PLACEHOLDER = [/\b(?:TBD|TODO)\b/, /\b(?:implement|fill in) later\b|\b(?:similar|same) (?:to|as) T\d/i, /^(?:add (?:appropriate )?error handling|handle edge cases)\.?$/i];
// ponytail: the repo root's package.json only; a monorepo's `cd pkg && npm test` is refused until P5 needs it
const NPM_RE = /\bnpm\s+(?:run(?:-script)?\s+([^\s;&|)]+)|(test)\b)/g;
// the npm scripts a test_cmd runs (`npm run "lint"`: quotes dropped)
const scriptsOf = (cmd) => [...String(cmd ?? '').matchAll(NPM_RE)].map((m) => (m[1] ?? m[2]).replace(/^["']|["']$/g, ''));
const SHA_RE = /^[0-9a-f]{40,64}$/;
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

// The ctx of a ticket's planning run: what tbd knows. spawn writes it to runs/<n>.plan-ctx.json for the hook.
const ctxOf = (t, skills) => ({
  locked: t.locked_decisions ?? [], must_ask: !!t.must_ask, skills, base_sha: t.base_sha ?? null, cwd: t.worktree ?? null,
  ...(t.git_dir && { git_dir: t.git_dir, common_dir: t.common_dir }),
});

/** @param {any} out @param {{locked?: any[], must_ask?: boolean, skills?: string[] | Record<string, string>, base_sha?: string | null, cwd?: string | null, git_dir?: string, common_dir?: string, git?: (args: string[], input?: string) => Promise<any>}} ctx @returns {Promise<string[]>} */
async function check(out, ctx) {
  if (!isObj(out)) return ['the result must be a JSON object'];
  const why = [];
  const paths = []; // {p: as named, at: its field, need: 'any' | 'tree' | 'blob' | 'file' (it, or its folder)}
  const scripts = []; // {name, at}
  const plan = out.kind === 'plan';
  if (out.kind === 'questions') {
    if (!arr(out.questions).length) why.push('kind "questions" needs at least one question');
    const extra = PLAN.filter((k) => out[k] !== undefined);
    if (extra.length) why.push(`kind "questions" carries plan fields ${extra.join(', ')}: leave them out, or return kind "plan"`);
  } else if (plan) {
    if (ctx.must_ask) return ['Irfan asked to be asked more first (must_ask): return kind "questions" this round, not a plan'];
    if (out.questions !== undefined) why.push('kind "plan" carries questions: leave them out, or return kind "questions"');
    const missing = PLAN.filter((k) => out[k] === undefined);
    if (missing.length) why.push(`a plan needs ${missing.join(', ')}`);
  } else return [`kind must be "questions" or "plan", got ${q(out.kind)}`];

  const qids = new Set();
  for (const [i, x] of arr(out.questions).entries()) {
    const n = arr(x.options).length;
    const nid = typeof x.id === 'string' ? x.id.replace(/^Q/, '') : x.id; // the locked id: R<n>Q<nid> (planning.answer)
    if (qids.has(nid)) why.push(`questions[${i}].id ${q(x.id)}: questions need unique ids ("Q1" and "1" are the same)`);
    qids.add(nid);
    if (n < 2 || n > 4) why.push(`questions[${i}].options: 2 to 4 options, got ${n}`);
    if (!arr(x.options).includes(x.recommended)) why.push(`questions[${i}].recommended ${q(x.recommended)}: must be exactly one of its options`);
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
      if (before.has(x.id)) why.push(`${at}.id ${q(x.id)}: tasks need unique ids`);
      if (x.type !== 'new' && x.type !== 'preserve') why.push(`${at}.type ${q(x.type)}: must be "new" or "preserve"`);
      for (const b of arr(x.blocked_by)) if (!before.has(b)) why.push(`${at}.blocked_by ${q(b)}: name only tasks listed before this one`);
      before.add(x.id);
      for (const a of arr(x.acceptance)) {
        if (acc.has(a)) covered.add(a);
        else why.push(`${at}.acceptance ${q(a)}: no such acceptance id`);
      }
      arr(x.files).forEach((p, j) => paths.push({ p, at: `${at}.files[${j}]`, need: 'file' }));
      arr(x.modules).forEach((p, j) => paths.push({ p, at: `${at}.modules[${j}]`, need: 'tree' }));
      for (const [k, s] of [['title', x.title], ...arr(x.steps).map((s, j) => [`steps[${j}]`, s])]) {
        const text = String(s).trim();
        const m = PLACEHOLDER.map((re) => re.exec(text)).find(Boolean);
        if (m) why.push(`${at}.${k}: placeholder ${q(m[0])}: say exactly what to do`);
      }
      for (const name of scriptsOf(x.test_cmd)) scripts.push({ name, at: `${at}.test_cmd` });
    }
    for (const a of acc) if (!covered.has(a)) why.push(`acceptance ${q(a)}: no task covers it: list it in a task's acceptance`);

    const known = new Set(Array.isArray(ctx.skills) ? ctx.skills : Object.keys(ctx.skills ?? {}));
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
    const left = new Map(kids.map((c) => [c.id, arr(c.blocked_by).filter((b) => b !== 'parent')]));
    for (let size = -1; size !== left.size;) { // peel children whose sibling blockers are gone; what stays is a cycle
      size = left.size;
      for (const [id, deps] of left) if (!deps.some((b) => left.has(b))) left.delete(id);
    }
    if (left.size) why.push(`children blocked_by form a cycle: ${[...left.keys()].map(q).join(', ')}`);
  }

  if (ctx.cwd && (paths.length || scripts.length)) await atBase(ctx, paths, scripts, why);
  return why.length > MAX ? [...why.slice(0, MAX), `(+${why.length - MAX} more)`] : why;
}

// The path rules at base_sha: one cat-file --batch-check for every path, each file's folder and package.json; then
// package.json's scripts (one cat-file blob) for the npm scripts the test_cmds run. A git failure throws (the hook
// allows, the runner blocks).
async function atBase(ctx, paths, scripts, why) {
  if (!SHA_RE.test(ctx.base_sha ?? '')) throw new Error(`plan-rules: base_sha missing in a worktree ticket: paths can't be checked`);
  const git = ctx.git ?? ((args, input) => gitIn(ctx.cwd, args, { timeout: 10_000, input, dirs: ctx }));
  const ask = new Set(scripts.length ? ['package.json'] : []);
  const ok = [];
  for (const x of paths) {
    const p = rel(x.p);
    if (p === null) {
      why.push(`${x.at} ${q(x.p)}: a path relative to the repo root, without a leading / or .. segments`);
      continue;
    }
    ok.push({ ...x, rel: p });
    ask.add(p);
    if (x.need === 'file') ask.add(parent(p));
  }
  const list = [...ask];
  const r = await git(['cat-file', '--batch-check'], list.map((p) => `${ctx.base_sha}:${p}\n`).join(''));
  const lines = String(r.stdout ?? '').split('\n');
  if (r.err || lines.length <= list.length) throw new Error(`plan-rules: git cat-file --batch-check: ${String(r.stderr || r.err?.message || 'short output').trim().slice(0, 200)}`);
  const type = new Map(list.map((p, i) => [p, / (missing|ambiguous)$/.test(lines[i]) ? null : lines[i].split(' ')[1]]));
  for (const x of ok) {
    const t = type.get(x.rel);
    if (x.need === 'tree' && t !== 'tree' && t !== 'commit') why.push(`${x.at} ${q(x.p)}: not a folder at base`);
    else if (x.need === 'file' && !t && type.get(parent(x.rel)) !== 'tree') why.push(`${x.at} ${q(x.p)}: neither the file nor its folder exists at base`);
    else if (x.need === 'file' && (t === 'tree' || t === 'commit')) why.push(`${x.at} ${q(x.p)}: a folder, not a file: name the files (modules takes folders)`);
    else if (x.need === 'any' && !t) why.push(`${x.at} ${q(x.p)}: no such file or folder at base`);
    else if (x.need === 'blob' && t !== 'blob') why.push(`${x.at} ${q(x.p)}: no such file at base`);
  }
  if (!scripts.length) return;
  let have = null;
  if (type.get('package.json') === 'blob') {
    const b = await git(['cat-file', 'blob', `${ctx.base_sha}:package.json`]);
    if (b.err) throw new Error(`plan-rules: git cat-file blob package.json: ${String(b.stderr || b.err.message).trim().slice(0, 200)}`);
    try {
      have = JSON.parse(b.stdout).scripts;
    } catch { /* not JSON: no scripts */ }
  }
  for (const s of scripts) if (!isObj(have) || !Object.hasOwn(have, s.name)) why.push(`${s.at}: npm script ${q(s.name)} is not in package.json at base`);
}

module.exports = { check, ctxOf, q, scriptsOf, PLAN, SOURCE_RE };
