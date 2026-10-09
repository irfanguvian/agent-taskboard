'use strict';
// planning: code tickets from Backlog through Planning (spec §4, §5 Planning ⇄ Clarify; plan P4 AC2 AC3; contract
// U1 U2 U4 U5 U6 J3 J6 J7). tbd.js requires it at startup: it registers the code/planning handler + seed.
// assign(): backlog → planning once the tag passes doctor's static checks and every blocker is merged (code) or done
// (others); a git tag pins base_sha (local base ref, no fetch) and gets a detached worktree at it: the planning cwd.
// handle(): the planner's result, schema-checked already (runner U3), against lib/plan-rules.js (J15 J16: the same
// rules the in-run hook applies; here they are authoritative). A broken rule → {reject}: the runner resumes once with
// the reasons, then Blocked. Kept: rounds/NN-*.json, facts.json, decisions.json (atomic; J17: Irfan's locked decisions
// merged in, his win). seed(): a fresh round's prompt. Async only (D31); git via execFile argv (D35d).
// P4b (plan P4 AC3 AC4; contract U8 U9 U10 J3 J5 J12): answer() clarify → planning with Irfan's answers (locked as
// decisions); reject() plan_approval → planning with his comment (locked) and must_ask on "Ask me more"; approve()
// freezes the plan, then in the background sets the worktree up (branch, env files, skills, the tag's setup in the
// heavy slot, the config baseline, children) and moves it to working; a failed step waits in plan_approval
// (setup_failed + its tail, an alert) and a re-approve resumes. autoAssign(): the runner's tick hands it each Backlog
// ticket; an approval-made child is assigned once its blockers are merged / done.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');
const fsm = require('./fsm');
const phases = require('./phases');
const doctor = require('./doctor');
const spawn = require('./spawn');
const { skillSources } = require('./skills');
const rules = require('./plan-rules');
const { procs } = require('./slots');
const { tree } = require('./recovery');
const { TbError } = require('./errors');
const { isObj, isFile, within, copyPlain, git: gitIn, ROUND_RE } = require('./util');

const TB_HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const SHA_RE = /^[0-9a-f]{40,64}$/;
const USES = ['recommended', 'you_decide'];
const WAIT_IRFAN = ['assign_failed', 'blocker_cancelled']; // a Backlog child's waits only Irfan ends (tb assign / cancel)
const TEXT_MAX = 10_000; // an answer's text, a reject comment
const TAIL = 2000; // characters of a failed approve's error kept in waiting.error (≈ 2 KB)
const SKILLS_SHOWN = 200; // installed skill names in a seed's ## Tag block
const { q } = rules; // agent text inside a reason: quoted, short
const iso = () => new Date().toISOString();
const bad = (msg) => new TbError(400, msg);
class Moved extends Error {} // the ticket left the state a background step expected: its write is dropped
const assigning = new Set(); // ids with an assign in flight (tb, HTTP or auto): one at a time per ticket
const approving = new Set(); // ids with an approve's setup in flight (J12: two approves → one setup)

const git = (cwd, args, timeout = 20_000, dirs = null) => gitIn(cwd, args, { timeout, dirs });
const gitTail = (r) => String(r.stderr || r.err?.message || '').trim().split('\n').pop().slice(0, 200);

// U1 J6 J7: base_sha = the local base ref's commit (no fetch); the worktree detached at it. → {base_sha, worktree,
// git_dir, common_dir}. A tbd killed between `worktree add` and the ticket's write left one: taken as is when git lists
// it detached at that commit, else removed (git's own worktree at that path only) and stale entries pruned before the
// add. S1: git_dir (the worktree's own, read right after the add, before any agent ran in it) and common_dir (the tag
// repo's, from the tag path) are kept on the ticket: every later git in the worktree pins them (util.git).
async function worktree(id, tag) {
  const r = await git(tag.path, ['rev-parse', '--verify', '--quiet', `${tag.base}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.err || !SHA_RE.test(sha)) throw new TbError(409, `${id}: base ${tag.base} not found in ${tag.path}`);
  const wt = path.join(TB_HOME, 'worktrees', id);
  await fsp.mkdir(path.dirname(wt), { recursive: true, mode: 0o700 });
  const real = path.join(await fsp.realpath(path.dirname(wt)), id); // git lists real paths (/private/var)
  const list = await git(tag.path, ['worktree', 'list', '--porcelain']);
  const had = list.stdout.split('\n\n').map((b) => Object.fromEntries(b.split('\n').map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)])))
    .find((e) => e.worktree === wt || e.worktree === real);
  if (!had || had.HEAD !== sha || !had.detached) {
    if (had) await git(tag.path, ['worktree', 'remove', '--force', wt]);
    await git(tag.path, ['worktree', 'prune']);
    const add = await git(tag.path, ['worktree', 'add', '--detach', wt, sha], 120_000);
    if (add.err) throw new TbError(409, `${id}: git worktree add ${wt} failed: ${gitTail(add)}${store.getTicket(id).state === 'backlog' ? '; the ticket stays in backlog' : ''}`);
  }
  const [d, c] = await Promise.all([git(wt, ['rev-parse', '--absolute-git-dir']), git(tag.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])]);
  const [git_dir, common_dir] = await Promise.all([d, c].map((x) => (x.err ? null : fsp.realpath(x.stdout.trim()).catch(() => null))));
  if (!git_dir || !common_dir || path.dirname(git_dir) !== path.join(common_dir, 'worktrees')) {
    await git(tag.path, ['worktree', 'remove', '--force', wt]);
    throw new TbError(409, `${id}: worktree ${wt}: its git dir ${git_dir ?? gitTail(d)} is not under ${common_dir ?? gitTail(c)}/worktrees; the ticket stays in backlog`);
  }
  return { base_sha: sha, worktree: wt, git_dir, common_dir };
}

// U2: why a blocker still holds t (merged: code, pr.merged_at; done: others) → {why} ('' = none). J13: a cancelled
// blocker holds an auto-assign ({why, cancelled: its id}, even past a not-yet one) but not Irfan's own assign
// (manual: his explicit choice to go on without it).
function blocker(t, manual = false) {
  let why = '';
  for (const b of t.blocked_by ?? []) {
    let k;
    try {
      k = store.getTicket(b);
    } catch {
      return { why: `blocker ${b} is not a ticket` };
    }
    if (k.kind === 'code' ? k.pr?.merged_at : k.state === 'done') continue;
    if (k.state !== 'cancelled') why ||= `blocker ${b} is not ${k.kind === 'code' ? 'merged' : 'done'} yet`;
    else if (!manual) return { why: `blocker ${b} was cancelled`, cancelled: b };
  }
  return { why };
}

// AC3 (assign), U2: the same guards for tb, HTTP and auto-assign (manual false: J13). L3: the worktree's own repo
// settings at base_sha (doctor's billing check) pass too, else it goes again. → the ticket, now in planning.
async function assign(id, manual = true) {
  if (assigning.has(id)) throw new TbError(409, `${id}: an assign is already running`);
  assigning.add(id);
  try {
    const t = store.getTicket(id);
    if (t.state !== 'backlog') throw new TbError(409, `${id}: already assigned (state ${t.state})`);
    const can = fsm.check(t, 'planning', 'you', { assign: () => true });
    if (!can.ok) throw new TbError(409, `${id}: ${can.reason}`);
    if (!t.tag) throw new TbError(409, `${id} has no tag: a flow needs a tag with a path to be assigned`);
    const failed = (await doctor.tagStatic(t.tag)).filter((c) => !c.ok);
    if (failed.length) throw new TbError(409, `${id}: tag ${t.tag} fails doctor: ${failed.map((c) => c.detail).join('; ')}`);
    const { why } = blocker(t, manual);
    if (why) throw new TbError(409, `${id}: ${why}`);
    const tag = store.listTags()[t.tag];
    const patch = tag.type === 'git' ? await worktree(id, tag) : {};
    try {
      if (patch.worktree) {
        const s = await doctor.settingsCheck(t.tag, patch.worktree);
        if (!s.ok) throw new TbError(409, `${id}: the worktree at base fails doctor: ${s.detail}; the ticket stays in backlog`);
      }
      return await store.updateTicket(id, (k) => fsm.move({ ...k, ...patch }, 'planning', 'you', { assign: () => true }));
    } catch (e) { // refused, or moved meanwhile (a Cancel): the worktree goes again
      if (patch.worktree) await git(tag.path, ['worktree', 'remove', '--force', patch.worktree]);
      throw e;
    }
  } finally {
    assigning.delete(id);
  }
}

// J5: tbd assigns an approval-made child (auto_assign) once every blocker is merged (code) or done (others); the runner's
// tick hands it each Backlog ticket. In the background: git never holds the tick. A failure waits for Irfan (waiting
// assign_failed + one alert), never tried again here: he runs `tb assign` (same guards) once it is fixed. J13: a
// cancelled blocker → waiting blocker_cancelled + one alert, no assign: Irfan assigns it (going on without the blocker)
// or cancels it.
function autoAssign(t, alert = (_a) => {}) {
  if (t.state !== 'backlog' || !t.auto_assign || WAIT_IRFAN.includes(t.waiting?.reason) || assigning.has(t.id)) return;
  const b = blocker(t);
  if (b.cancelled) return void wait(t.id, 'backlog', { reason: 'blocker_cancelled', blocker: b.cancelled }, alert,
    { title: 'Blocker cancelled', message: `${t.id} ${t.title}: blocker ${b.cancelled} was cancelled; tb assign ${t.id} to go on without it, or cancel it` });
  if (b.why) return;
  assign(t.id, false).catch((e) => {
    const error = String(e.message).slice(0, 500);
    console.error(`tbd: ${t.id}: auto-assign failed: ${error}`);
    wait(t.id, 'backlog', { reason: 'assign_failed', error }, alert, { title: 'Auto-assign failed', message: `${t.id} ${t.title}: ${error}; fix it, then tb assign ${t.id}` });
  });
}

// The ticket waits (waiting set, then the alert) only while it is still in `state` and ok(k) holds; set once: a ticket
// already waiting for that reason is left alone (a second tick: no second alert). A ticket that moved on: nothing.
async function wait(id, state, waiting, alert, msg, ok = (_k) => true) {
  try {
    await store.updateTicket(id, (k) => {
      if (k.state !== state || k.waiting?.reason === waiting.reason || !ok(k)) throw new Moved();
      return { ...k, waiting: { ...waiting, since: iso() } };
    });
    alert(msg);
  } catch (e) {
    if (!(e instanceof Moved)) console.error(`tbd: ${id}: waiting ${waiting.reason} not saved: ${e.message}`);
  }
}

// The newest rounds/NN-*.json kept (U5; a refused result is not kept): {n, file}, or null.
async function newest(t) {
  const dir = path.join(store.ticketDir(t.id), 'rounds');
  let top = null;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const m = ROUND_RE.exec(f);
    if (m && (!top || Number(m[1]) > top.n)) top = { n: Number(m[1]), file: path.join(dir, f) };
  }
  return top;
}
const nextRound = async (t) => ((await newest(t))?.n ?? 0) + 1;
// The newest round as {...its result, n}, or null. Only a plain file is read.
async function currentRound(t) {
  const top = await newest(t);
  if (!top) return null;
  if (!(await isFile(top.file))) throw new Error(`${top.file} is not a plain file (a link?)`);
  return { ...JSON.parse(await fsp.readFile(top.file, 'utf8')), n: top.n };
}
// L7: the plan approve froze (plan.json), or null: no plan_hash yet, or not a plain file.
async function frozenPlan(t) {
  const f = path.join(store.ticketDir(t.id), 'plan.json');
  return t.plan_hash && (await isFile(f)) ? JSON.parse(await fsp.readFile(f, 'utf8')) : null;
}

// The code/planning handler. questions → clarify (must_ask cleared), plan → plan_approval; else {reject}. The round's
// files are written by `after`, which the runner calls inside the move's own store write once the move is sure (a
// Restart or Cancel meanwhile leaves no file behind for the next seed).
async function handle(t, out) {
  const why = await rules.check(out, rules.ctxOf(t, (await skillSources()).skills));
  if (why.length) return { reject: why.join('\n') };
  const locked = t.locked_decisions ?? [];
  const mine = new Set(locked.map((d) => d.id));
  const decisions = [...locked, ...out.decisions.filter((d) => !mine.has(d.id))]; // J17: Irfan's win; no echo needed
  const after = async () => {
    const dir = store.ticketDir(t.id);
    const rounds = path.join(dir, 'rounds');
    await fsp.mkdir(rounds, { recursive: true, mode: 0o700 });
    if (!(await fsp.lstat(rounds)).isDirectory()) throw new Error(`${rounds} is not a directory (a link?)`); // never written through
    const json = (v) => JSON.stringify(v, null, 2) + '\n';
    await store.writeAtomic(path.join(rounds, `${String(await nextRound(t)).padStart(2, '0')}-${out.kind}.json`), json(out));
    await store.writeAtomic(path.join(dir, 'facts.json'), json(out.facts));
    await store.writeAtomic(path.join(dir, 'decisions.json'), json(decisions));
  };
  return out.kind === 'questions'
    ? { to: 'clarify', ctx: { questions: () => true }, patch: { must_ask: false }, after }
    : { to: 'plan_approval', ctx: { plan_valid: () => true }, after };
}

// J16: the ticket's tag for the seed: name, type, base, its checks (a test_cmd's npm script must exist), context files,
// default skills and the installed skill names (plan skills name only these; sorted, the first SKILLS_SHOWN).
function tagBlock(name, tag, names) {
  const list = (v) => (v?.length ? v.join(', ') : '(none)');
  const more = names.length > SKILLS_SHOWN ? ` (+${names.length - SKILLS_SHOWN} more)` : '';
  return [`tag: ${name} (${tag.type ?? 'no type'}${tag.base ? `, base ${tag.base}` : ''})`,
    `checks: ${list(Object.entries(tag.checks ?? {}).map(([k, v]) => `${k} = ${v}`))}`, `context files: ${list(tag.context)}`,
    `default skills: ${list(tag.skills)}`, `installed skills: ${list(names.slice(0, SKILLS_SHOWN))}${more}`].join('\n');
}

// U6: a fresh session per round, seeded with ticket.md (answers as Q/A), the facts and decisions so far (Irfan's locked
// ones marked), his last reject comment, the must_ask note, the tag (## Tag, J16) and "System now" (system: TOON
// lines, as `tbx status`).
async function seed(t, system) {
  const dir = store.ticketDir(t.id);
  const read = async (f) => ((await isFile(path.join(dir, f)))
    ? fsp.readFile(path.join(dir, f), 'utf8').then((x) => JSON.parse(x)).then((v) => (Array.isArray(v) ? v : []), () => []) : []);
  const [facts, decisions, n] = await Promise.all([read('facts.json'), read('decisions.json'), nextRound(t)]);
  const locked = t.locked_decisions ?? [];
  const mine = new Set(locked.map((d) => d.id));
  const all = [...locked.map((d) => ({ ...d, locked: true })), ...decisions.filter((d) => !mine.has(d?.id))];
  const out = [store.renderMd(t).trimEnd(), `## Planning round ${n}`,
    'A fresh session: what earlier rounds found is below. Return kind "questions" or kind "plan" with every fact and decision so far.',
    '## Facts', facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(none yet)',
    '## Decisions', all.length ? all.map((d) => `- ${d.id} (source: ${d.source}): ${d.text}${d.locked ? " [locked: Irfan's decision: never plan against it; no need to repeat it]" : ''}`).join('\n') : '(none yet)'];
  if (t.reject_comment) out.push("## Irfan's comment on the last plan", t.reject_comment);
  if (t.must_ask) out.push('## Ask first', 'Irfan wants to be asked more before a plan: return kind "questions" this round; a plan is refused.');
  const tag = t.tag ? store.listTags()[t.tag] : null;
  if (tag) out.push('## Tag', tagBlock(t.tag, tag, Object.keys((await skillSources()).skills).sort()));
  out.push('## System now', system);
  return out.join('\n\n') + '\n';
}

// U8: Irfan's answers to the open Clarify round → planning (the next round: a fresh session seeded with them). body:
// {answers: {<qid>: {pick: <one of its options>} | {text} | {use: "recommended" | "you_decide"}}, plan_now?}. Every
// question needs one unless plan_now ("Enough, plan now": the rest is the planner's call). Each joins t.answers; a pick,
// a text or "use recommended" is also locked as a decision {id: R<round>Q<qid>, source: answer:R<round>Q<qid>}.
async function answer(id, body) {
  if (!isObj(body) || Object.keys(body).some((k) => k !== 'answers' && k !== 'plan_now') || !isObj(body.answers ?? {})
    || typeof (body.plan_now ?? false) !== 'boolean') throw bad('body must be {"answers": {"<question id>": {...}}, "plan_now"?: true|false}');
  const t = store.getTicket(id);
  if (t.state !== 'clarify') throw new TbError(409, `${id}: answers go to a ticket in clarify, not ${t.state}`);
  const r = await currentRound(t);
  if (r?.kind !== 'questions' || !Array.isArray(r.questions)) throw new TbError(409, `${id}: no questions round to answer`);
  const given = body.answers ?? {};
  const qs = new Map(r.questions.map((x) => [x.id, x]));
  for (const [qid, a] of Object.entries(given)) {
    const x = qs.get(qid);
    if (!x) throw bad(`round ${r.n} has no question ${q(qid)}: its questions are ${[...qs.keys()].map(q).join(', ')}`);
    const [k, ...more] = isObj(a) ? Object.keys(a) : [];
    const ok = !more.length && (k === 'pick' ? x.options.includes(a.pick)
      : k === 'text' ? typeof a.text === 'string' && a.text.trim() !== '' && a.text.length <= TEXT_MAX : k === 'use' && USES.includes(a.use));
    if (!ok) throw bad(`answer to ${q(qid)} must be {"pick": ${x.options.map(q).join(' | ') || '(no options)'}}, {"text": "<1-${TEXT_MAX} characters>"} or {"use": "recommended" | "you_decide"}`);
  }
  const open = r.questions.filter((x) => !Object.hasOwn(given, x.id));
  if (open.length && !body.plan_now) throw new TbError(409, `${id}: not answered: ${open.map((x) => q(x.id)).join(', ')}: answer every question, or plan now`);
  const rows = [];
  const locked = [];
  for (const x of r.questions) {
    const a = Object.hasOwn(given, x.id) ? given[x.id] : { use: 'you_decide' }; // plan now: the planner's call
    const aid = `R${r.n}${x.id.startsWith('Q') ? '' : 'Q'}${x.id}`;
    rows.push({ id: aid, question: x.question, answer: a, ...(a.use === 'recommended' && { recommended: x.recommended }) });
    const value = a.pick ?? a.text ?? (a.use === 'recommended' ? x.recommended : null);
    if (value !== null) locked.push({ id: aid, text: `${x.question} → ${value}`, source: `answer:${aid}` });
  }
  return store.updateTicket(id, (k) => fsm.move({ ...k, answers: [...(k.answers ?? []), ...rows], locked_decisions: [...(k.locked_decisions ?? []), ...locked] },
    'planning', 'you', { answers_complete: () => true }));
}

// Request changes / Ask me more: plan_approval → planning. The comment is kept (t.reject_comment: the next seed shows it)
// and locked as a decision (source reject:R<round>); ask sets must_ask (the next result must be questions). A frozen
// plan_hash goes with the plan, and so do child ids an approve reserved for it (L4: the next plan gets its own). Refused
// while an approve's setup runs: checked inside the store write (M3: an approve that began meanwhile wins).
async function reject(id, body) {
  if (!isObj(body) || Object.keys(body).some((k) => k !== 'comment' && k !== 'ask') || typeof body.comment !== 'string' || !body.comment.trim()
    || body.comment.length > TEXT_MAX || typeof (body.ask ?? false) !== 'boolean') throw bad(`body must be {"comment": "<1-${TEXT_MAX} characters>", "ask"?: true|false}`);
  const t = store.getTicket(id);
  if (t.state !== 'plan_approval') throw new TbError(409, `${id}: only a plan in plan_approval can be rejected, not ${t.state}`);
  const n = (await currentRound(t))?.n ?? 0;
  const comment = body.comment.trim();
  const d = { id: `R${n}C`, text: comment, source: `reject:R${n}` };
  return store.updateTicket(id, (k) => {
    if (k.waiting?.reason === 'setup') throw new TbError(409, // approve set it in its own serialized write: first write wins
      `${id}: setup of the approved plan is running; reject once it ended`);
    return fsm.move({ ...k, reject_comment: comment, must_ask: body.ask === true, plan_hash: null, children: undefined, locked_decisions: [...(k.locked_decisions ?? []), d] },
      'planning', 'you', { comment_saved: () => true });
  });
}

// sha256 of the plan with keys sorted at every level (U5: plan_hash)
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'flow';

// U9: the tag's env_files (relative to its path) into the worktree, the same relative place: plain files only (lstat:
// no link, no dir), inside the tag path (a linked dir on the way counts: realpath), never written through a link: the
// nearest folder that exists on the way in the worktree must lie inside it (realpath) before mkdir makes the rest;
// copyPlain (O_NOFOLLOW + same inode: a file swapped for a link after the check is refused), mode 0600 (secrets).
async function copyEnv(tag, wt) {
  const [root, wtReal] = await Promise.all([fsp.realpath(tag.path), fsp.realpath(wt)]);
  for (const f of tag.env_files ?? []) {
    const rel = path.relative(tag.path, path.resolve(tag.path, f));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`env file ${q(f)} is not inside ${tag.path}`);
    const src = path.join(tag.path, rel);
    if (!(await isFile(src)) || !within(await fsp.realpath(src), root)) throw new Error(`env file ${q(f)}: not a plain file inside ${tag.path} (missing, a dir or a link)`);
    const dest = path.join(wt, rel);
    let up = path.dirname(dest);
    while (!(await fsp.lstat(up).then(() => true, () => false))) up = path.dirname(up);
    if (!within(await fsp.realpath(up), wtReal)) throw new Error(`env file ${q(f)}: its folder in the worktree leads outside it (a link)`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await copyPlain(src, dest, 0o600);
  }
}

// U9 + spec §9: the plan's skills copied (never linked) to <ticket>/skills/.claude/skills/<name> (spawn's --add-dir),
// a fresh copy each approve: skills/.claude goes whole first (rm takes a link itself, never what it points to), then
// is made again. Sources from skills.js; links inside a skill are left out, never followed.
async function copySkills(id, names) {
  const sk = path.join(store.ticketDir(id), 'skills');
  const st = await fsp.lstat(sk).catch(() => null);
  if (st && !st.isDirectory()) throw new Error(`${sk} is not a directory (a link?)`);
  await fsp.rm(path.join(sk, '.claude'), { recursive: true, force: true });
  const dest = path.join(sk, '.claude', 'skills');
  await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
  const { skills } = await skillSources();
  for (const n of names) {
    if (!Object.hasOwn(skills, n) || !/^[\w-][\w.-]*$/.test(n)) throw new Error(`skill ${q(n)} is not installed (or not a plain name)`);
    await fsp.cp(skills[n], path.join(dest, n), { recursive: true, filter: async (p) => { const s = await fsp.lstat(p); return s.isFile() || s.isDirectory(); } });
  }
}

// The setup's tbx (its own process group: doctor.setup) as {pid, lstart} in waiting: a tbd that dies meanwhile leaves it
// running, and the next one's lostSetups ends it. Never throws.
async function keepSetup(id, pid) {
  const lstart = (await procs(true))?.get(pid)?.lstart; // C locale, UTC: compared as is at the next boot
  if (!lstart) return;
  await store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval' || k.waiting?.reason !== 'setup') throw new Moved(); // setup ended meanwhile
    return { ...k, waiting: { ...k.waiting, pid, lstart } };
  }).catch((e) => { if (!(e instanceof Moved)) console.error(`tbd: ${id}: setup pid not saved: ${e.message}`); });
}

// U9 in order, each step done again or skipped when done (a re-approve resumes): plan frozen (plan_hash, plan.json; L7:
// n given → it must be the newest round) → git tags: branch tb/<id>-<slug> (the worktree must be clean at base_sha
// first) → S2: the tree reset to base_sha and cleaned (ignored files too) on every approve, so setup runs nothing
// planted since (an ignored .npmrc, a hook script) → env files → skills → the tag's setup in the heavy slot → the config
// baseline (U10) → children + plan_approval → working, one store job. git_dir + common_dir pinned (S1).
async function setup(id, n) {
  const dir = store.ticketDir(id);
  const live = (patch) => store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval') throw new Moved();
    return { ...k, ...patch };
  });
  const r = await currentRound(store.getTicket(id));
  if (r?.kind !== 'plan') throw new Error('no plan to approve (rounds/NN-plan.json)');
  if (n !== undefined && r.n !== n) throw new Error(`the plan changed: round ${r.n} is the newest, not round ${n}; look at it again, then approve`);
  const plan = { ...r };
  delete plan.n;
  const hash = crypto.createHash('sha256').update(canon(plan)).digest('hex');
  const was = store.getTicket(id).plan_hash;
  if (was && was !== hash) throw new Error(`the plan changed after it was frozen (plan_hash ${was.slice(0, 12)}): reject it and plan again`);
  await store.writeAtomic(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  let t = await live({ plan_hash: hash, skills: plan.skills });
  const tag = store.listTags()[t.tag];
  if (!tag?.path) throw new Error(`tag ${t.tag} has no path any more`);
  const isGit = tag.type === 'git';
  if (isGit) {
    const wt = t.worktree;
    if (typeof wt !== 'string' || !path.isAbsolute(wt)) throw new Error('the ticket has no worktree (tb assign makes it)');
    if (!SHA_RE.test(t.base_sha ?? '')) throw new Error('the ticket has no base_sha (tb assign sets it)');
    const g = (args, timeout = 20_000) => git(wt, args, timeout, t);
    const branch = t.branch ?? `tb/${id}-${slug(t.title)}`;
    if ((await g(['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim() !== branch) {
      // claude's own staging dir (.claude/.cc-writes, sandboxed Bash in planning) is not a change (dirtyPaths)
      const [dirty, head] = await Promise.all([spawn.dirtyPaths(t), g(['rev-parse', 'HEAD'])]);
      if (head.err) throw new Error(`git in ${wt}: ${gitTail(head)}`);
      if (dirty.length) throw new Error(`worktree ${wt} is not clean:\n${dirty.slice(0, 20).join('\n')}`);
      if (head.stdout.trim() !== t.base_sha) throw new Error(`worktree ${wt} is at ${head.stdout.trim().slice(0, 12)}, not base_sha ${String(t.base_sha).slice(0, 12)}`);
      const sw = await g(['switch', '-c', branch]);
      if (sw.err) throw new Error(`git switch -c ${branch}: ${gitTail(sw)}`);
    }
    t = await live({ branch });
    for (const args of [['reset', '-q', '--hard', t.base_sha], ['clean', '-q', '-ffdx', '-e', '.claude/.cc-writes']]) {
      const x = await g(args, 120_000);
      if (x.err) throw new Error(`git ${args[0]} in ${wt}: ${gitTail(x)}`);
    }
    await copyEnv(tag, wt);
  }
  await copySkills(id, plan.skills);
  if (isGit) {
    const s = tag.setup ? await doctor.setup(t.worktree, tag.setup, (pid) => keepSetup(id, pid)) : null;
    // the baseline right after setup, failed or not: what setup made is tbd's (a reject → planning must not refuse it)
    t = await live({ config_baseline: await spawn.configBaseline(t, t.worktree) });
    if (s?.err) {
      const head = `setup ${q(tag.setup)} failed (${s.err.timedOut ? 'timed out' : `exit ${s.err.code}`}):\n`;
      throw new Error(head + s.output.slice(-(TAIL - head.length)));
    }
  }
  await store.createChildren(id, plan.children, (k) => fsm.move(k, 'working', 'you', { approve: () => true }));
}

// U9 J12: Approve. Now: plan_approval (fsm), L7: n (the round Irfan saw, UI) still the newest round (else 409), no
// approve running (else 409), waiting: setup; the rest in the background (HTTP answers 202): setup(). A failure leaves
// the ticket in plan_approval, waiting setup_failed with the error's tail, and alerts (sound); approving again resumes.
async function approve(id, { alert = (_a) => {}, n = undefined } = {}) {
  const t = store.getTicket(id);
  const can = fsm.check(t, 'working', 'you', { approve: () => true });
  if (!can.ok) throw new TbError(409, `${id}: ${can.reason}`);
  const top = n === undefined ? null : await newest(t);
  if (n !== undefined && top?.n !== n) throw new TbError(409, `${id}: the newest plan is round ${top?.n ?? 'none'}, not round ${n}: look at it again, then approve`);
  // the guard sits in the serialized write (first write wins), not in memory: `approving` is cleared only after the
  // setup_failed save, so an in-memory check refused a re-approve for ~10 ms after it (final verify flake)
  await store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval') throw new TbError(409, `${id}: it is ${k.state} now`);
    if (k.waiting?.reason === 'setup') throw new TbError(409, `${id}: approve is already running (setup)`);
    return { ...k, waiting: { reason: 'setup', since: iso() } };
  });
  approving.add(id); // lostSetups only: a setup this tbd runs is not lost
  setup(id, n).catch(async (e) => {
    if (e instanceof Moved) return;
    const error = String(e.message).slice(0, TAIL);
    console.error(`tbd: ${id}: approve setup failed: ${error.split('\n')[0]}`);
    await wait(id, 'plan_approval', { reason: 'setup_failed', error }, alert,
      { title: 'Setup failed', message: `${id} ${t.title}: ${error.split('\n')[0].slice(0, 200)}; tb approve ${id} again once fixed` });
  }).finally(() => approving.delete(id));
}

// At boot: an approve's setup dies with the tbd that ran it, so `waiting: setup` left on a plan_approval ticket is
// stale → its orphaned setup ended (killSetups), then setup_failed + an alert (J12: approve again resumes).
async function lostSetups(alert = (_a) => {}) {
  const error = 'tbd restarted during setup; approve again';
  const lost = store.listTickets().filter((t) => t.state === 'plan_approval' && t.waiting?.reason === 'setup' && !approving.has(t.id));
  await killSetups(lost.map((t) => t.waiting).filter((w) => Number.isInteger(w.pid) && w.lstart));
  for (const t of lost) {
    await wait(t.id, 'plan_approval', { reason: 'setup_failed', error }, alert, { title: 'Setup failed', message: `${t.id} ${t.title}: ${error}` },
      (k) => k.waiting?.reason === 'setup' && !approving.has(k.id));
  }
}

// What an orphaned setup still runs: its tbx (pid = pgid), the members of that group and what they started (by ppid:
// the command tbx runs in a group of its own). SIGTERM (tbx passes it on to its command's group), 2 s, SIGKILL to what
// is left. Own processes only: pid + start time as saved (recovery.tree; a reused pid is never touched).
async function killSetups(ws) {
  if (!ws.length) return;
  const m = await procs(true);
  if (!m) return void console.error('tbd: ps failed: an orphaned setup may still run');
  const pids = new Map(ws.flatMap((w) => [...tree({ pid: w.pid, lstart: w.lstart, pgid: w.pid }, m)]));
  const send = (sig, now) => { for (const [p, ls] of pids) if (now?.get(p)?.lstart === ls) try { process.kill(p, sig); } catch { /* gone */ } };
  if (!pids.size) return;
  send('SIGTERM', m);
  await new Promise((res) => setTimeout(res, 2000));
  send('SIGKILL', await procs(true));
}

phases.registerHandler('code/planning', handle, seed);

module.exports = { assign, autoAssign, answer, reject, approve, currentRound, frozenPlan, lostSetups };
