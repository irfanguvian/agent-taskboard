'use strict';
// final: code/final_gate, the final gate (contract .omc/handoffs/m5-contract.md rev 4 C10 C11 C12 C13; D-0089 D-0090
// D-0092 D-0105 D-0106). tbd.js requires it like lib/qa.js: it registers the code/final_gate handler, seed and next hook,
// and tells lib/working.js what a final gate's result means (setFinal: this module requires working.js, never the reverse).
// Next hook (runner.consider, after the QA lock: the final checks hold it too): waiting close → the "Ready to close"
// alert a crash lost (L8), else nothing; a legacy D9 pass (pr.merged_at) → nothing. A pass of this round's final review not squashed yet → the squash (C12, below). Else: a new
// visit (or a gate of an earlier lease gen, or a red one Resume left) → one CAS final {tested_sha: HEAD} + work.gate
// {gen, kind final}; pending → the gate job (lib/working.js gateJob: the D-0105 dirty check, then GATES.code.final; never
// into critical memory); green → {} (a fresh session of the final review; no write here: a run waiting on admission asks
// again each tick). Resume out of Blocked → {stop}: the next tick starts again from the checks (lock, then this hook).
// Gate result (decideGate): green → the review; interrupted → pending again; infra, integrity, config (the DB guard: db)
// → Blocked; an ask (policy, scope, protected, deps) → Blocked config (nobody is asked here); red work → fix n = t.fixes +
// 1 (lib/review.js FIX_MAX, one counter per ticket) as @fx<n> (brief: the gate's why) back in working, then review, QA
// and this gate again; a 4th → Blocked waiting final.
// Handler (C11; every check code, a refusal = {reject}: schema_fail, resumed once with the reason, then Blocked): tree
// pin (HEAD = final.tested_sha; no tracked change but docs and env files, content compared too: SEC-2), verdict =
// review.blocking() over the findings, both docs plain files under their docs dir (no link on the way, one link, ≤ 1 MB)
// that the mirror holds, the mirrored verdict doc free of tbd's Evidence heading, an open code fence or HTML comment
// (M1), the summary's texts not blank, free of an env secret value (SEC-5) and its title + description of a D34 line
// (they become the squash message), its verdict 'blocked' exactly when the result blocks (L3). A taken result is
// kept in final/NN.json (n: the next free one; the move's write). Blocking → fix n as @fx<n> (brief: the blocking
// findings + the cheap LOW ones); a 4th → Blocked waiting final. Pass (G3) → one CAS: final {n, verdict} + summary.md +
// the evidence appended to the mirrored verdict doc (D-0106: the QA cases, the last QA round's recs as curl, the final
// checks' lines; the agent writes prose only). Every result is mirrored first; at the visit's end the untracked docs leave
// the worktree (D-0101, as lib/qa.js).
// Squash (C12, the next hook after the pass; one at a time per ticket, M4): a squash a crash left is adopted (ref
// final-pre-<n> = tested, same tree, base its only parent, the squash's ident + message: SEC-7); else HEAD = tested_sha, no docs dir path in base..tested, the ident (util.ident: the tag's; a
// push tag without one → Blocked config) → commit-tree <tested>^{tree} -p <base> (summary title + description) →
// update-ref final-pre-<n> (create only) → the branch CAS'd from tested to the squash → reset --soft; then one CAS final
// {sha, at} + summary.md + waiting close, and one alert "Ready to close". Nothing here pushes (lib/push.js).
// close(id, actor) (C13): Irfan's tb close: final_gate → done (fsm close_ok + children_done); never pushes; the
// worktree stays until tb gc.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const phases = require('./phases');
const fsm = require('./fsm');
const planning = require('./planning');
const spawn = require('./spawn');
const docs = require('./docs');
const working = require('./working');
const { FIX_MAX, blocking, nextN } = require('./review');
const { Stale } = require('./recovery');
const { TbError } = require('./errors');
const { git: gitIn, readPlain, eachLine, isFile, d34, ident, envBlock, SHA_RE } = require('./util');

/** @typedef {import('./gates/types').FinalResult} FinalResult @typedef {import('./gates/types').Summary} Summary */

const DOC_MAX = 1 << 20; // a verdict / verification doc the handler takes
const STAT_MAX = 8192;
const REPORT_CUT = 16 * 1024; // the QA report in the seed
const EVIDENCE_MAX = 256 * 1024; // the section tbd appends to the verdict doc
const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW; // the mirrored doc must be there
const iso = () => new Date().toISOString();
const cut = (s, n = STAT_MAX) => String(s ?? '').slice(0, n);
const list = (v, n = 10) => `${v.slice(0, n).join(', ')}${v.length > n ? ` (+${v.length - n} more)` : ''}`;
const git = (t, args, o = {}) => gitIn(t.worktree, args, { timeout: 120_000, dirs: t, ...o });
const rev = async (t, x) => { const r = await git(t, ['rev-parse', '--verify', '--quiet', x]); return r.err ? '' : r.stdout.trim(); };
const nn = (/** @type {number} */ n) => String(n).padStart(2, '0');
const file = (id, ...f) => path.join(store.ticketDir(id), ...f);
const readJson = async (f) => JSON.parse((await readPlain(f, 4 << 20)) ?? 'null');
const findingText = (f) => `- ${f.id} ${f.severity} (${f.confidence}) ${f.where}: ${f.problem}\n  fails when: ${f.failure_scenario}\n  fix: ${f.fix}`;
const cell = (s) => String(s ?? '').replace(/[|\r\n]/g, ' ');
const fence = (s) => '`'.repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1)));
// the last line of a check's output tail (the verdict doc and the seed show one line per check)
const lastLine = (s) => cut(String(s ?? '').trim().split('\n').at(-1), 200);
// t's last qa | review result (qa/NN.json, review/NN.json), null when none
const lastOf = async (t, /** @type {'qa' | 'review'} */ kind) => (Number.isInteger(t[kind]?.n) ? readJson(file(t.id, kind, `${nn(t[kind].n)}.json`)).catch(() => null) : null);
// M1: the code fence a markdown text ends inside (CommonMark: ≤ 3 spaces, then 3+ ` or ~; closed by a line of the same
// char at least as long with nothing after it; a ` fence's info string holds no `) → {open: its marker, '' when all are
// closed; prose: H6, the lines outside every fence, fence lines left out}
function openFence(/** @type {string} */ text) {
  let open = '';
  const prose = [];
  for (const line of text.split(/\r\n?|\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = '';
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = m[1];
    else prose.push(line);
  }
  return { open, prose };
}

// ---- the gate's result (lib/working.js apply) ---------------------------------------------------------------------
/** @param {any} t @param {any} res → a working.js Decision (+ wait, fixes) */
function decideGate(t, res) {
  const D = (/** @type {string} */ d, /** @type {string} */ why, extra = {}) => ({ do: d, task: null, mode: null, why: cut(why, 4096), ...extra });
  if (res.ok) return D('final', 'final checks green: the final review');
  if (res.class === 'interrupted') return D('gate', `final checks interrupted: they run again (${res.why})`);
  if (['infra', 'integrity', 'config'].includes(res.class)) return D('blocked', `final checks ${res.class}: ${res.why}`);
  if (res.ask || res.class !== 'work') return D('blocked', `final checks ${res.class}: ${res.why} (nobody is asked at the final gate: fix it, then Resume)`, { wait: 'config' });
  const fixes = (t.fixes ?? 0) + 1;
  if (fixes > FIX_MAX) return D('blocked', `final checks red: fix ${fixes} needed, max ${FIX_MAX} per ticket; Resume from Blocked resets the count: ${res.why}`, { wait: 'final' });
  return D('fix', `The final checks found these problems (fix ${fixes} of ${FIX_MAX}). Fix them, commit, return done:\n\n${res.why}`, { task: `@fx${fixes}`, fixes });
}
working.setFinal(decideGate);

// ---- the result handler (runner.handle, after the schema) ---------------------------------------------------------
// D-0101: the docs live in the worktree during the visit only (as lib/qa.js, clean before the move's CAS too): a taken
// result, or a refusal of the schema retry (the runner blocks on that), takes the untracked ones out once the mirror
// holds them.
/** @param {any} t @param {FinalResult} out */
async function handle(t, out) {
  if (out.questions?.length) return planning.askFrom(t, out); // Phase 5: first; the visit goes on (docs stay for the resumed session)
  await docs.mirror(t, [out.verdict_doc, out.verification_doc]); // every result, refused ones too; its two docs first (L4)
  const r = await judge(t, out);
  if ((!r.reject || t.lease?.schema_retry) && store.getTicket(t.id)?.lease?.gen === t.lease?.gen) await docs.clean(t); // a Restart / Cancel won during judge: its new session owns the docs
  return r;
}

// rel: an agent's doc path → why it is not a plain file with one link (≤ 1 MB) under a docs dir, no link on the way; ''
async function docWhy(root, rel) {
  if (!docs.isDoc(rel)) return 'not under docs/verdicts/ or docs/verification/';
  // docs.mirror's segment rule (the schema's pattern is not the only wall): tickets/<id>/<rel> stays under docs/
  if (!rel.split('/').every((s) => s && s !== '.' && s !== '..')) return 'a path segment is empty, . or ..';
  const abs = path.join(root, rel);
  if ((await fsp.realpath(abs).catch(() => null)) !== abs) return 'not there, or a link lies on the way';
  const st = await fsp.lstat(abs).catch(() => null);
  return st?.isFile() && st.nlink === 1 && st.size <= DOC_MAX ? '' : `not a plain file with one link of at most ${DOC_MAX} bytes`;
}

/** @param {any} t @param {FinalResult} out → {reject} | {to, ctx, patch, after, waiting?} | {patch, after} */
async function judge(t, out) {
  const f = t.final ?? {};
  const h = await working.head(t);
  if (h !== f.tested_sha) return { reject: `HEAD is ${h.slice(0, 12)}, not ${String(f.tested_sha).slice(0, 12)} that the final checks tested: the final review never commits nor moves HEAD` };
  const tag = store.listTags()[t.tag];
  const env = new Set(tag?.env_files ?? []);
  // SEC-2 (D-0107) H1: status + the content compare (a forged stat cache hides a change from status), both from the tag
  // repo's objects only (H2.5: the final gate fetched tested_sha = HEAD there)
  const lines = (await spawn.treeDirty(t.clone ? { ...t, trusted: true } : t)).filter((l) => !l.startsWith('?? '));
  const changed = await docs.dropDocs(t.worktree, lines.filter((l) => !env.has(l.slice(3))));
  if (changed.length) return { reject: `tracked files changed during the final review: ${list(changed)}: it never edits tracked files (it writes its two new docs only); restore them` };
  const block = out.findings.filter((x) => blocking(x));
  const want = block.length ? 'block' : 'pass';
  if (out.verdict !== want) return { reject: `verdict must be ${want}: ${block.length ? `${block.map((x) => x.id).join(', ')} block` : 'no finding blocks'} (a finding blocks when its severity is CRIT, HIGH or MED AND its confidence is high)` };
  const root = await fsp.realpath(t.worktree);
  for (const [key, rel] of [['verdict_doc', out.verdict_doc], ['verification_doc', out.verification_doc]]) {
    const why = await docWhy(root, rel);
    if (why) return { reject: `${key} ${rel}: ${why}` };
    if (!(await isFile(file(t.id, rel)))) return { reject: `${key} ${rel}: not mirrored: the docs dirs hold too much (≤ 200 entries, 5 MB a file, 20 MB in all)` };
  }
  // M1 (D-0106): tbd's Evidence section after the agent's text stays tbd's: the mirrored copy (what tbd appends to) holds
  // no heading of that name to forge, no code fence or HTML comment left open to swallow tbd's heading
  const vd = await readPlain(file(t.id, out.verdict_doc), DOC_MAX);
  if (vd === null) return { reject: `verdict_doc ${out.verdict_doc}: the mirrored copy is not a plain file of at most ${DOC_MAX} bytes` };
  const forged = /^ {0,3}(?:#{1,6}[ \t]*)?evidence \(captured by tbd\).*$/im.exec(vd);
  if (forged) return { reject: `verdict_doc: line "${cut(forged[0].trim(), 100)}": tbd appends the Evidence (captured by tbd) section itself; write prose only and point to it ("see Evidence below")` };
  const { open, prose } = openFence(vd);
  if (open) return { reject: `verdict_doc: a code fence opened with ${open} is never closed: close it (tbd's Evidence section follows your text)` };
  // H6 (C4): a <!-- inside a closed code fence is code, not a comment: the prose alone is checked. Fail closed: a prose line
  // holding anything like a tag start (<div, </x, <!, <?; a list item too) may open an HTML block, inside which a fence
  // line is no fence → the whole doc, as before. comments never nest: open iff the last <!-- has no --> after it
  const scope = prose.some((l) => /<[A-Za-z/!?]/.test(l)) ? vd : prose.join('\n');
  const c = scope.lastIndexOf('<!--'); // (<!--> is closed)
  if (c >= 0 && scope.indexOf('-->', c + 2) < 0) return { reject: 'verdict_doc: an HTML comment <!-- is never closed with -->: close it (it would hide tbd\'s Evidence section after your text)' };
  const s = out.summary;
  const blank = [...['title', 'description', 'blocker', 'need_review'].filter((x) => !s[x].trim()), ...(s.worked_on.some((x) => !x.trim()) ? ['worked_on'] : [])];
  if (blank.length) return { reject: `summary ${blank.join(', ')}: blank: write each one (blocker and need_review may be "none")` };
  const ai = d34(`${s.title}\n${s.description}`);
  if (ai !== null) return { reject: `summary title + description become the squash commit's message: no Co-Authored-By Claude / Anthropic and no "Generated with" line (D34): ${ai}` };
  // L3: the summary's verdict follows the result's (prompt: blocked = verdict block)
  if ((want === 'block') !== (s.verdict === 'blocked')) return { reject: `summary verdict ${s.verdict}: ${want === 'block' ? 'a blocking result is "blocked"' : '"blocked" is for a blocking result only: "shipped" or "partial"'}` };
  // SEC-5 (D-0108): no env file secret value in the summary: it becomes the squash message and summary.md. H3 (D-0151,
  // D-0153): util.envBlock, the blocking set (SECRET-named values, URL passwords; no booleans, digits or plain words such
  // as development); strict: an env file it can't read throws → Blocked
  const texts = [s.title, s.description, s.blocker, s.need_review, ...s.worked_on];
  if ((await envBlock(tag)).some((v) => texts.some((x) => x.includes(v)))) return { reject: 'summary holds a secret value of the tag\'s env files: never copy an env value into the summary (it becomes the squash commit\'s message)' };

  const n = await nextN(t.id, 'final');
  const save = async () => {
    await fsp.mkdir(path.dirname(file(t.id, 'final', 'x')), { recursive: true, mode: 0o700 });
    await store.writeAtomic(file(t.id, 'final', `${nn(n)}.json`), JSON.stringify({ n, at: iso(), round: t.round, tested_sha: h, ...out }, null, 2) + '\n');
  };
  if (!block.length) {
    return { patch: { final: { ...f, n, verdict: 'pass' } }, after: async () => { await save(); await writeSummary(t, s, out.findings); await appendEvidence(t, out.verdict_doc); } };
  }
  const fixes = (t.fixes ?? 0) + 1;
  if (fixes > FIX_MAX) {
    return { to: 'blocked', ctx: {}, after: save, waiting: { reason: 'final', why: `final review ${n}: ${block.length} blocking finding(s) need fix ${fixes}, max ${FIX_MAX} per ticket; Resume from Blocked resets the count`, since: iso() } };
  }
  const task = `@fx${fixes}`;
  const cheap = out.findings.filter((x) => x.severity === 'LOW' && x.cheap);
  const brief = [`The final review ${n} found ${block.length} blocking finding(s) (fix ${fixes} of ${FIX_MAX}). Fix each one, commit, return done.`, '', ...block.map(findingText),
    ...(cheap.length ? ['', 'Also fix these small ones while you are there:', ...cheap.map(findingText)] : [])].join('\n');
  return {
    to: 'working', ctx: { rework: () => true }, patch: { fixes, work: working.openTask(t.work, task, h) },
    after: async () => { await save(); await working.journal(t.id, { t: 'task', id: task, brief }); },
  };
}

// Irfan's handoff block (C1 Summary) → summary.md, verdict first (his handoff format). Need Review: the agent's text, tbd's own lines (extra: the squash
// ident, C12 step 3), then (M3) the residuals tbd knows, in code, never left to the agent: the last QA's need_review, the
// last review's medium-confidence and non-cheap LOW findings, this final result's (findings) medium-confidence ones;
// one line each (id, severity, where, problem ≤ 200 chars)
async function writeSummary(t, /** @type {Summary} */ s, /** @type {any[]} */ findings, /** @type {string[]} */ extra = []) {
  const [q, rv] = await Promise.all([lastOf(t, 'qa'), lastOf(t, 'review')]);
  const one = (/** @type {string} */ from, /** @type {any} */ x) => `- ${from} ${cut(cell(x.id), 20)} ${x.severity} (${x.confidence}) ${cut(cell(x.where), 200)}: ${cut(cell(x.problem), 200)}`;
  const residuals = [...(q?.need_review ?? []).map((x) => `- QA ${q.n} need review: ${cut(cell(x), 200)}`),
    ...(rv?.findings ?? []).filter((x) => x.confidence === 'medium' || (x.severity === 'LOW' && !x.cheap)).map((x) => one(`review ${rv.n}`, x)),
    ...findings.filter((x) => x.confidence === 'medium').map((x) => one('final', x))];
  const md = [`**Verdict:** ${s.verdict}`, '', `**Title:** ${s.title}`, '', `**Description:** ${s.description}`, '', '**What I worked on:**', ...s.worked_on.map((x) => `- ${x}`), '',
    `**Blocker:** ${s.blocker}`, '', `**Need Review:** ${[s.need_review, ...extra, ...residuals].join('\n')}`].join('\n');
  return store.writeAtomic(file(t.id, 'summary.md'), `${md}\n`);
}

// The gate's checks of t's final gate (gates/NN.json, lib/gates wrote it) → '- check: pass|fail — last line' lines
async function checkLines(t) {
  const g = Number.isInteger(t.work?.gate?.n) ? await readJson(file(t.id, 'gates', `${nn(t.work.gate.n)}.json`)).catch(() => null) : null;
  return (g?.checks ?? []).map((c) => `- ${c.check}: ${c.ok ? 'pass' : 'fail'}${lastLine(c.tail) ? ` — ${lastLine(c.tail)}` : ''}`);
}

// D-0106: `## Evidence (captured by tbd)` appended to the mirrored verdict doc (tickets/<id>/<rel>): the last QA's case
// table with each case's evidence label, every rec of that QA round as curl + status + body (lib/recorder.js recItem:
// masked as recorded, texts cut), the final checks' lines. ≤ EVIDENCE_MAX; shown as text, never rendered.
async function appendEvidence(t, rel) {
  const q = await lastOf(t, 'qa');
  const out = ['', '', '## Evidence (captured by tbd)', '', `### QA ${q?.n ?? '(none)'}: cases`, '', '| id | kind | result | evidence |', '|---|---|---|---|',
    ...(q?.cases ?? []).map((c) => `| ${cell(c.id)} | ${cell(c.kind)} | ${cell(c.result)} | ${cell(c.evidence)} |`), '', '### Recorded calls', ''];
  const recs = [];
  if (q) {
    const dir = file(t.id, 'runs');
    const runs = (await fsp.readdir(dir).catch(() => [])).map((x) => Number(/^(\d{1,9})\.rec\.jsonl$/.exec(x)?.[1])).filter(Boolean).sort((a, b) => a - b);
    const { recItem } = require('./recorder'); // lazy: lib/recorder.js loads with the first http.req or here
    for (const run of runs) {
      await eachLine(path.join(dir, `${run}.rec.jsonl`), (v, i) => {
        if (i === 1) return !(v?.meta === true && v.ticket === t.id && v.phase === 'qa' && v.round === q.round);
        if (v && typeof v.n === 'string') recs.push(recItem(v, 4096));
        return false;
      });
    }
  }
  for (const r of recs) {
    out.push(`#### rec ${cell(r.n)}`, '', fence(r.curl), r.curl, fence(r.curl), '', `status: ${r.status ?? `none (${cut(r.error, 200)})`}`, '');
    if (r.body) out.push(fence(r.body), r.body, fence(r.body), '');
  }
  if (!recs.length) out.push('(none recorded)', '');
  const checks = await checkLines(t);
  out.push('### Final checks', '', ...(checks.length ? checks : ['(none)']), '');
  let text = out.join('\n');
  if (Buffer.byteLength(text) > EVIDENCE_MAX) text = `${Buffer.from(text).subarray(0, EVIDENCE_MAX).toString('utf8')}\n\n… (cut at ${EVIDENCE_MAX} bytes)\n`;
  const fh = await fsp.open(file(t.id, rel), APPEND);
  try {
    if (!(await fh.stat()).isFile()) throw new Error(`${rel}: the mirrored verdict doc is not a plain file`);
    await fh.write(text);
  } finally {
    await fh.close();
  }
}

// ---- seed: a fresh session's prompt -------------------------------------------------------------------------------
async function seed(t) {
  const plan = (await planning.readPlan(t).catch(() => null)) ?? {};
  const tested = t.final?.tested_sha;
  if (!SHA_RE.test(tested ?? '') || !SHA_RE.test(t.base_sha ?? '')) throw new Error('final.tested_sha or base_sha missing'); // fail closed
  const r = await git(t, ['diff', '--stat', `${t.base_sha}..${tested}`]);
  if (r.err) throw new Error(`git diff ${t.base_sha}..${tested} in ${t.worktree}: ${cut(r.stderr || r.err.message, 200)}`);
  const out = [store.renderMd(t).trimEnd(),
    '## Plan', [plan.summary ?? '(no summary)', 'acceptance:', ...(plan.acceptance ?? []).map((a) => `- ${a.id} (${a.type}): ${a.text}`),
      'tasks:', ...(plan.tasks ?? []).map((x) => `- ${x.id} (${x.type}): ${x.title}`)].join('\n'),
    '## Diff', `base: ${t.base_sha}\ntested (HEAD): ${tested}\nthe whole change: git diff ${t.base_sha}..${tested}\n\n${cut(r.stdout.trim() || '(no change)')}`];
  const rv = await lastOf(t, 'review');
  out.push('## Last review', rv ? [`review ${rv.n}: ${rv.verdict}`, 'findings:', ...(rv.findings ?? []).map((x) => `${findingText(x)}${blocking(x, rv.closed ?? []) ? '\n  (blocking)' : ''}`),
    'closed:', ...(rv.closed ?? []).map((c) => `- ${c.id}: ${c.how}`)].join('\n') : '(no review file)');
  const q = await lastOf(t, 'qa');
  const report = t.qa?.report ? await readPlain(file(t.id, t.qa.report), 4 << 20).catch(() => null) : null; // the mirror's copy
  out.push('## QA', q ? [`QA ${q.n}: ${q.verdict} (${t.qa.pass} pass, ${t.qa.fail} fail, ${t.qa.blocked} blocked)`, 'cases (evidence: captured by tbd = recorded calls only; agent-made = screenshots or notes):',
    ...(q.cases ?? []).map((c) => `- ${c.id} ${c.kind} ${c.type} ${c.result} [${c.evidence}] ${c.source}: ${c.expect}`), ...(q.need_review ?? []).map((x) => `need review: ${x}`),
    `report (${t.qa.report}):`, report === null ? '(not mirrored)' : cut(report, REPORT_CUT)].join('\n') : '(no QA file)');
  out.push('## Final checks', (await checkLines(t)).join('\n') || '(none)');
  const day = iso().slice(0, 10);
  const n = await nextN(t.id, 'final'); // L5: the n this round's result gets: a 2nd pass the same day keeps the 1st docs
  out.push('## Your output', `verdict doc: docs/verdicts/${day}-${t.id}-f${n}.md\nverification doc: docs/verification/${day}-${t.id}-final-f${n}.md`);
  return out.join('\n\n') + '\n';
}

// ---- the squash (C12) ---------------------------------------------------------------------------------------------
// One CAS on t's pass while it is not squashed yet (Stale → false: the ticket moved on); passBlock: that pass → Blocked
const passWrite = (t, fn) => store.updateTicket(t.id, async (k) => {
  if (!(k.state === 'final_gate' && k.round === t.round && k.final?.n === t.final.n && !k.final.sha)) throw new Stale();
  return fn(k);
}).then(() => true, (e) => { if (e instanceof Stale) return false; throw e; });
async function passBlock(t, api, reason, why) {
  if (await passWrite(t, (k) => ({ ...fsm.move(k, 'blocked', 'runner'), waiting: { reason, why: cut(why, 500), since: iso() } }))) api.alert?.({ title: `Blocked: ${reason}`, message: `${t.id}: ${cut(why, 300)}` });
}

// H2.5: every git of the squash reads the tag repo's objects only (trusted; the commit it makes lands there too); refs
// and the index stay the clone's. t (the store's) is what the writes check; tt never goes into a write. H2.3 F13: the tag
// repo's branch tb/<id>-<slug> = the squash, by tbd alone: created at the first squash, moved from tag_tip on a later one.
async function squash(t0, api) {
  const t = t0.clone ? { ...t0, trusted: true } : t0;
  const f = t.final;
  const write = (fn) => passWrite(t0, fn);
  const block = (reason, why) => passBlock(t0, api, reason, why);
  const tested = f.tested_sha;
  const base = t.base_sha;
  if (!SHA_RE.test(tested ?? '') || !SHA_RE.test(base ?? '') || !t.branch) return block('config', 'squash: final.tested_sha, base_sha or branch missing');
  const ref = `refs/tb/${t.id}/final-pre-${f.n}`;
  const h = await working.head(t).catch((e) => e);
  if (h instanceof Error) return block('infra', h.message);
  const who = await ident(t, tested);
  const fj = await readJson(file(t.id, 'final', `${nn(f.n)}.json`)).catch(() => null);
  const s = fj?.summary;
  const msg = s?.title ? `${s.title}\n\n${s.description}\n` : '';
  let sha = '';
  if (h !== tested) { // 1. adopt: a squash a crash left between the branch update and the ticket write (F8). SEC-7: made
    // by the squash's ident with the summary as its message too: a branch + ref another agent of the tag set in that
    // window is never taken (it would ship under Irfan's ident)
    const [pre, ht, tt, par, lg] = await Promise.all([rev(t, ref), rev(t, `${h}^{tree}`), rev(t, `${tested}^{tree}`), git(t, ['rev-list', '--parents', '-n', '1', h]),
      git(t, ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', h])]);
    const parents = par.err ? [] : par.stdout.trim().split(' ').slice(1);
    const [an, ae, cn, ce, body] = lg.err ? [] : lg.stdout.split('\0');
    const ours = !('error' in who) && !!msg && an === who.name && ae === who.email && cn === who.name && ce === who.email && body?.replace(/\n+$/, '') === msg.replace(/\n+$/, '');
    if (pre === tested && ht && ht === tt && parents.length === 1 && parents[0] === base && ours) sha = h;
    else return block('config', `HEAD ${h.slice(0, 12)} is not the tested commit ${tested.slice(0, 12)}${pre === tested ? ' nor its squash (the tag ident, the summary as message)' : ''}: the branch moved after the final checks; Resume runs them again`);
  } else {
    // 2. docs dirs never ship (C8)
    const d = await git(t, ['diff', '--name-only', `${base}..${tested}`, '--', 'docs/verification', 'docs/verdicts']);
    if (d.err) return block('infra', `git diff --name-only: ${cut(d.stderr || d.err.message, 200)}`);
    const paths = d.stdout.split('\n').filter(Boolean);
    if (paths.length) return block('config', `${list(paths)}: docs dirs are never committed, yet ${base.slice(0, 12)}..${tested.slice(0, 12)} changes them`);
    // 3. the ident
    if ('error' in who) return block('config', `squash ident: ${who.error}`);
    // 4. one commit: the tested tree on base, the summary as its message
    if (!msg) return block('config', `final/${nn(f.n)}.json: no summary to make the squash message from`);
    const ai = d34(msg);
    if (ai !== null) return block('config', `the squash message has a D34 line: ${ai}`);
    const id = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const c = await git(t, ['commit-tree', `${tested}^{tree}`, '-p', base, '-F', '-'], { input: msg, add: id });
    sha = c.stdout.trim();
    if (c.err || !SHA_RE.test(sha)) return block('infra', `git commit-tree: ${cut(c.stderr || c.err?.message, 200)}`);
    const u = await git(t, ['update-ref', ref, tested, '']); // create only; a redo finds it there with the same value
    if (u.err && (await rev(t, ref)) !== tested) return block('infra', `git update-ref ${ref}: ${cut(u.stderr || u.err.message, 200)}`);
    const b = await git(t, ['update-ref', `refs/heads/${t.branch}`, sha, tested]); // CAS: only from the tested commit
    if (b.err) return block('config', `git update-ref refs/heads/${t.branch}: ${cut(b.stderr || b.err.message, 200)}: the branch moved`);
    const r = await git(t, ['reset', '-q', '--soft', sha]); // same tree: the docs and the index stay
    if (r.err) return block('infra', `git reset --soft: ${cut(r.stderr || r.err.message, 200)}`);
  }
  // 5. the tag repo's branch (a clone's refs are its own): CAS from what tbd set last (none: create). Refused but there at
  // sha → a redo after a crash, done; else someone moved it outside tbd → Blocked config
  if (t.clone) {
    const tagRef = `refs/heads/${t.branch}`;
    const u = await gitIn(t.common_dir, ['update-ref', tagRef, sha, t.tag_tip ?? ''], { timeout: 20_000, bare: true });
    if (u.err && (await gitIn(t.common_dir, ['rev-parse', '--verify', '--quiet', tagRef], { timeout: 20_000, bare: true })).stdout.trim() !== sha) {
      return block('config', `tag branch ${t.branch} moved outside tbd (${cut(u.stderr || u.err.message, 200)}): it is tbd's to set at the squash; delete it or move it back to ${t.tag_tip ? t.tag_tip.slice(0, 12) : 'nothing'}, then Resume`);
    }
  }
  // 6. the record, then one alert ('close' is no re-ping reason: lib/notify.js)
  const extra = [];
  if (!('error' in who) && who.from === 'tag') {
    const a = await git(t, ['log', '-1', '--format=%an%x00%ae', tested]);
    const [an, ae] = a.stdout.replace(/\n$/, '').split('\0');
    if (a.err || an !== who.name || ae !== who.email) extra.push(`The squash is authored as the tag ident ${who.name} <${who.email}>; the tested commits were ${a.err ? 'of an unknown author' : `by ${an} <${ae}>`}: check the authorship before pushing.`);
  }
  const done = await write(async (k) => {
    if (s) await writeSummary(t, s, fj.findings ?? [], extra);
    return { ...k, final: { ...k.final, sha, at: iso() }, ...(t.clone && { tag_tip: sha }), waiting: { reason: 'close', since: iso() } };
  });
  if (done) await closeAlert(t0, api);
}

// L8: "Ready to close" once per squash: the alert, then final.alerted in a CAS. A tbd that died between the squash's
// record and that CAS alerts from the next hook (waiting close, no alerted); one that died right after the alert sends a
// 2nd (at least once). The store's ticket, not the tick's copy: a squash may have alerted since it was taken.
async function closeAlert(t, api) {
  const k = store.getTicket(t.id);
  const sha = k.final?.sha;
  if (k.state !== 'final_gate' || k.waiting?.reason !== 'close' || !sha || k.final.alerted) return;
  api.alert?.({ title: 'Ready to close', message: `${k.id} ${cut(k.title, 100)}: squashed to ${sha.slice(0, 12)}: tb close ${k.id} (or tb push ${k.id} first)` });
  await store.updateTicket(k.id, (x) => {
    if (x.state !== 'final_gate' || x.final?.sha !== sha) throw new Stale();
    return { ...x, final: { ...x.final, alerted: true } };
  }).catch((e) => { if (!(e instanceof Stale)) throw e; });
}

// M4: one squash (or close alert) per ticket at a time: runner.decide calls the next hook each tick and never awaits it.
// A throw → Blocked infra (a pass not squashed yet; else only logged), never an unhandled rejection (tbd would exit).
const squashing = new Set();
async function once(t, api, /** @type {(t: any, api: any) => Promise<any>} */ fn) {
  squashing.add(t.id);
  try {
    await fn(t, api);
  } catch (e) {
    console.error(`tbd: ${t.id}: ${fn.name} failed: ${e.message}`);
    await passBlock(t, api, 'infra', `${fn.name} failed: ${e.message}`).catch((e2) => console.error(`tbd: ${t.id}: not blocked: ${e2.message}`));
  } finally {
    squashing.delete(t.id);
  }
}

// ---- the next hook (runner.consider after the QA lock; recovery rerunGate) -----------------------------------------
async function next(t, api) {
  if (api.rerun) return { stop: true }; // Resume out of Blocked: consider starts the visit next tick (lock, then below)
  if (squashing.has(t.id)) return undefined;
  if (t.waiting?.reason === 'close') return void (await once(t, api, closeAlert));
  if (t.pr?.merged_at || working.jobBusy(t.id)) return undefined;
  const gen = t.lease?.gen ?? 0;
  if (t.final?.verdict === 'pass' && !t.final.sha && t.lease?.phase === 'final_gate' && t.lease.round === t.round) return void (await once(t, api, squash));
  const g = t.work?.gate;
  // Phase 5: Irfan's answers to this visit's final review ask → the asking session at once, never a new visit: the checks
  // passed at this HEAD already, and a new visit's gate cleans the docs dirs the session wrote (lib/working.js cleanDocs)
  const cont = planning.continueOf(t);
  if (cont && g?.kind === 'final' && g.ok === true && t.final?.tested_sha && t.final.tested_sha === (await working.head(t).catch(() => null))) return cont;
  const ours = g?.kind === 'final' && g.gen === gen;
  if (ours && g.ok === true) return planning.continueOf(t) ?? {}; // green: the final review, a fresh session (Phase 5: or the asking one with Irfan's answers)
  if (ours && g.ok === undefined) {
    if (api.system?.()?.pressure === 'critical') return void (await api.setWaiting?.('memory')); // K12: no gate into a memory kill
    void working.gateJob(t, api); // never awaited: the job acts itself (a runner tick never waits on a gate)
    return undefined;
  }
  // a new visit: the final checks at HEAD (C1: tested_sha's one writer; n comes with a passing result). A pre-P5 ticket
  // parked here gets an empty work cursor. HEAD unreadable (worktree gone) → Blocked config once, not a log line a tick.
  // L2: an old wait (manual, qa_lock) ends with it (the deploy guard reads waiting)
  const h = await working.head(t).catch((e) => e);
  await store.updateTicket(t.id, (k) => {
    if (k.state !== 'final_gate' || k.round !== t.round || (k.lease?.gen ?? 0) !== gen) throw new Stale();
    if (h instanceof Error) return { ...fsm.move(k, 'blocked', 'runner'), waiting: { reason: 'config', why: cut(h.message, 500), since: iso() } };
    return { ...k, final: { tested_sha: h }, waiting: null, work: { task: null, tasks: [], tries: 0, unit_ms: null, scope: {}, denied: {}, ...k.work, gate: { gen, kind: 'final' } } };
  }).catch((e) => { if (!(e instanceof Stale)) throw e; });
  return undefined;
}

// ---- Irfan's close (C13) ------------------------------------------------------------------------------------------
/** tb close / POST /api/tickets/:id/close: final_gate (squashed, waiting close) → done once every child is done or
 * cancelled. One intervention; never pushes; the worktree stays (tb gc). */
async function close(id, actor = 'cli') {
  if (!['cli', 'ui'].includes(actor)) throw new TbError(400, 'actor must be cli or ui');
  const t = store.getTicket(id);
  const ctx = { ticketOf: working.ticketOf };
  const can = fsm.check(t, 'done', 'you', { ...fsm.GUARDS, ...ctx });
  if (!can.ok) throw new TbError(409, `${id}: ${can.reason}`);
  return store.intervention(id, { actor, verb: 'close', task: null, payload: null }, (k) => {
    if (k.state !== t.state || k.round !== t.round) throw new TbError(409, `${id}: it moved on meanwhile (now ${k.state})`);
    return fsm.move(k, 'done', 'you', ctx); // close_ok + children_done again, in the write
  });
}

phases.registerHandler('code/final_gate', handle, seed, next);

module.exports = { handle, seed, next, close, decideGate };
