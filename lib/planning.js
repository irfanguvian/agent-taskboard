'use strict';
// planning: code tickets from Backlog through Planning (spec §4, §5 Planning ⇄ Clarify; plan P4 AC2 AC3; contract
// U1 U2 U4 U5 U6 J3 J6 J7). tbd.js requires it at startup: it registers the code/planning handler + seed.
// assign(): backlog → planning once the tag passes doctor's static checks and every blocker is merged or squashed (code;
// C15: final.sha) or done (others); a git tag pins base_sha (local base ref, no fetch; a child: its code blockers' final
// commit, D-0091) and gets its own clone of the tag repo, detached at it (H2.1): the planning cwd.
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
// P5 (contract N3 T1 K4+C2 M9): approve then captures the OpenAPI base and runs the base checks at base_sha through the
// gates (lib/working.js holds them; red → setup_failed "base red: <check>"), snapshots the tag's rules (T1), keeps the
// plan as an immutable plan-<hash>.json (t.plan_file points at it; plan_hashes lists every approved hash) and seeds the
// work cursor in the final write. A re-approve after a replan (the ticket has work) keeps the done prefix the plan names in
// `keep` (its tasks copied from the old plan), saves the dirty tree and the old HEAD under refs/tb/<id>/replan-<n>[-wip],
// resets to the last kept commit (else base_sha) and cleans (no -x); setup: none when that commit's lockfile is the one
// node_modules was last built from (t.work.deps_blob) and the tripwire matches, else the sandboxed RO2 build
// (gates.runDepsSetup, offline; a build that needs the network → the ticket asks deps in clarify). Never the tag's own
// setup on a replan: the tree holds kept agent commits, and root install scripts run files they may have changed.
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
const tagsLib = require('./tags');
const { procs } = require('./slots');
const { killOrphans } = require('./recovery');
const { TbError } = require('./errors');
const sh = require('./sh');
const { isObj, isFile, within, copyPlain, git: gitIn, cloneAt, cloneConfig, ROUND_RE, SHA_RE } = require('./util');

const TB_HOME = process.env.TB_HOME || path.join(os.homedir(), '.taskboard');
const USES = ['recommended', 'you_decide'];
// a Backlog child's waits only Irfan ends (tb assign / cancel). C15 blockers_diverge too: bases never move (no rebase,
// D-0091), so a blocker's change never heals it and a re-check per tick would only re-run git
const WAIT_IRFAN = ['assign_failed', 'blocker_cancelled', 'blockers_diverge'];
const TEXT_MAX = 10_000; // an answer's text, a reject comment
const TAIL = 2000; // characters of a failed approve's error kept in waiting.error (≈ 2 KB)
const SKILLS_SHOWN = 200; // installed skill names in a seed's ## Tag block
const RULES_MAX = 8192; // T1: a tag's rules, all files together (refused above it, never cut)
const PLAN_FILE_RE = /^plan-[0-9a-f]{64}\.json$/;
const { q } = rules; // agent text inside a reason: quoted, short
const iso = () => new Date().toISOString();
const bad = (msg) => new TbError(400, msg);
class Moved extends Error {} // the ticket left the state a background step expected: its write is dropped
class Diverge extends TbError {} // C15: no code blocker's final commit holds the others' (autoAssign: blockers_diverge)
const assigning = new Set(); // ids with an assign in flight (tb, HTTP or auto): one at a time per ticket
const approving = new Set(); // ids with an approve's setup in flight (J12: two approves → one setup)

const git = (cwd, args, timeout = 20_000, dirs = null) => gitIn(cwd, args, { timeout, dirs });
const gitTail = (r) => String(r.stderr || r.err?.message || '').trim().split('\n').pop().slice(0, 200);

// U1 J6 J7 H2.1: base_sha = the local base ref's commit (no fetch), or `at` when given (C15: a child's blocker's final
// commit; M5.5 lanes: cur.pre); the ticket's own clone of the tag repo at it (util.cloneAt: own .git, no refs, HEAD
// detached, objects read from the tag repo, the tag's ident else `tb agent`). → {base_sha, worktree, git_dir, common_dir,
// clone}. A leftover at the path (a tbd killed mid-assign) is removed first, never adopted (a fresh clone is cheap); a
// legacy worktree entry there is pruned. common_dir: the tag repo's real common dir (push, gc and the gates' fetch-back
// use it); git_dir + clone.config: every later git in the clone pins them (util.git H2.2). No src: the tag repo pins
// base_sha as refs/tb/<id>/base (forced: the assign lock owns it) so its gc keeps what the clone reads. src (lanes,
// H2.6): the parent's pin {id, worktree, git_dir, common_dir, clone, base_sha}: cloned at its base_sha, `at` fetched from
// it (objects only, fsck), no base pin. Any failure: unclone(), code PLANTED kept. signal (M5.5 X3: a lane setup's job): an
// abort kills git.
async function worktree(id, tag, at = '', signal = undefined, src = undefined) {
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ args, timeout = 20_000) => gitIn(cwd, args, { timeout, signal });
  // P5 (security): the branch by its full name: a bare name lets refs/tags/<base> shadow the branch
  const r = at ? { err: null, stdout: at } : await git(tag.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${tag.base}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.err || !SHA_RE.test(sha)) throw new TbError(409, `${id}: base ${at || tag.base} not found in ${tag.path}`);
  const wt = path.join(TB_HOME, 'worktrees', id);
  await fsp.mkdir(path.dirname(wt), { recursive: true, mode: 0o700 });
  const c = await git(tag.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common_dir = c.err ? null : await fsp.realpath(c.stdout.trim()).catch(() => null);
  const stays = () => (store.getTicket(id).state === 'backlog' ? '; the ticket stays in backlog' : '');
  if (!common_dir) throw new TbError(409, `${id}: ${tag.path}: no git common dir (${gitTail(c)})${stays()}`);
  await fsp.rm(wt, { recursive: true, force: true });
  await git(tag.path, ['worktree', 'prune']);
  try {
    const made = await cloneAt(common_dir, wt, sha, { from: src, ident: tag.ident, alt: src && `refs/tb/${src.id}/`, signal });
    if (!src) { // C-L4: forced (a crash's pin at an older base never fails an assign; the assign lock owns the ref)
      const ref = `refs/tb/${id}/base`;
      const p = await git(common_dir, ['update-ref', ref, sha]);
      if (p.err) throw new Error(`git update-ref ${ref} failed: ${gitTail(p)}`);
    }
    return { base_sha: sha, worktree: wt, git_dir: made.git_dir, common_dir, clone: made.clone };
  } catch (e) {
    await unclone(id, wt, common_dir);
    throw Object.assign(new TbError(409, `${id}: ${e.message}${stays()}`), e.code === 'PLANTED' && { code: 'PLANTED' }); // C-M4: a lane's security end (D-0140)
  }
}

// F13: a clone that never made it onto the ticket (a failed assign, a refused assign CAS, a failed lane setup): its dir
// and the tag repo's base pin go again (none for a lane: a no-op). Never `git worktree remove`: a clone is a plain dir.
async function unclone(id, wt, common) {
  await fsp.rm(wt, { recursive: true, force: true });
  await gitIn(common, ['update-ref', '-d', `refs/tb/${id}/base`], { timeout: 20_000 });
}

// U2: why a blocker still holds t (code: squashed, final.sha (C15: at waiting close, done or pushed; never a cancelled
// one's), or merged, legacy pr.merged_at; done: others) → {why} ('' = none). J13: a cancelled blocker holds an
// auto-assign ({why, cancelled: its id}, even past a not-yet one) but not Irfan's own assign (manual: his explicit choice
// to go on without it).
function blocker(t, manual = false) {
  let why = '';
  for (const b of t.blocked_by ?? []) {
    let k;
    try {
      k = store.getTicket(b);
    } catch {
      return { why: `blocker ${b} is not a ticket` };
    }
    if (k.kind === 'code' ? (k.final?.sha && k.state !== 'cancelled') || k.pr?.merged_at : k.state === 'done') continue;
    if (k.state !== 'cancelled') why ||= `blocker ${b} is not ${k.kind === 'code' ? 'merged' : 'done'} yet`;
    else if (!manual) return { why: `blocker ${b} was cancelled`, cancelled: b };
  }
  return { why };
}

// C15 (D-0091): t's code blockers with a final commit, [{id, sha}] in blocked_by order (a cancelled one left out: a
// manual assign goes on without it). assign builds the worktree on them and compares them again in its final CAS.
const finals = (t) => (t.kind !== 'code' ? [] : (t.blocked_by ?? []).flatMap((b) => {
  let k;
  try {
    k = store.getTicket(b);
  } catch {
    return []; // gone: blocker() refused it already; in the CAS the list then differs
  }
  return k.kind === 'code' && k.final?.sha && k.state !== 'cancelled' ? [{ id: b, sha: k.final.sha }] : [];
}));

// C15 (D-0091, A16): a child's base = the final commit of the blocker that holds every other one's (git merge-base
// --is-ancestor in the tag repo: one pass picks the candidate, one checks it), '' = none: the tag base. Never a rebase:
// none holds them all → Diverge (409).
async function childBase(id, tag, fin) {
  const holds = async (a, b) => { // a is b or an ancestor of it
    const r = await git(tag.path, ['merge-base', '--is-ancestor', a, b]);
    if (r.err && r.err.code !== 1) throw new TbError(409, `${id}: git merge-base ${a.slice(0, 12)} ${b.slice(0, 12)} failed: ${gitTail(r)}; the ticket stays in backlog`);
    return !r.err;
  };
  let top = fin[0]?.sha ?? '';
  for (const f of fin.slice(1)) if (await holds(top, f.sha)) top = f.sha;
  for (const f of fin) {
    if (f.sha !== top && !(await holds(f.sha, top))) {
      throw new Diverge(409, `${id}: blockers diverge: ${fin.map((x) => `${x.id} ${x.sha.slice(0, 12)}`).join(', ')}: no final commit holds the others' and there is no rebase (D-0091); cancel the blocker that is off the chain, or cancel this ticket`);
    }
  }
  return top;
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
    const fin = finals(t);
    const patch = tag.type === 'git' ? await worktree(id, tag, await childBase(id, tag, fin)) : {};
    try {
      if (patch.worktree) {
        const s = await doctor.settingsCheck(t.tag, patch.worktree);
        if (!s.ok) throw new TbError(409, `${id}: the worktree at base fails doctor: ${s.detail}; the ticket stays in backlog`);
      }
      return await store.updateTicket(id, (k) => {
        // C15: a blocker's final commit changed while the worktree was built (a rework at close clears it): refused.
        // L7 closed: a blocker's rework at close (fsm close_rework: every dependent still in backlog) and this CAS share
        // store.serial, ONE queue for every ticket's writes, so they never interleave: a rework saved first reads here
        // as the new final (refused); one after finds this ticket in planning (its close_rework refused). Backstop:
        // blockers_diverge (a child whose blockers' finals no longer chain waits for Irfan).
        if (JSON.stringify(finals(k)) !== JSON.stringify(fin)) throw new TbError(409, `${id}: a blocker's final commit changed during the assign; the ticket stays in backlog`);
        return fsm.move({ ...k, ...patch }, 'planning', 'you', { assign: () => true });
      });
    } catch (e) { // refused, or moved meanwhile (a Cancel): the clone and its base pin go again (F13)
      if (patch.worktree) await unclone(id, patch.worktree, patch.common_dir);
      throw e;
    }
  } finally {
    assigning.delete(id);
  }
}

// J5: tbd assigns an approval-made child (auto_assign) once every blocker is squashed (code) or done (others); the runner's
// tick hands it each Backlog ticket. In the background: git never holds the tick. A failure waits for Irfan (waiting
// assign_failed + one alert), never tried again here: he runs `tb assign` (same guards) once it is fixed. J13: a
// cancelled blocker → waiting blocker_cancelled + one alert, no assign: Irfan assigns it (going on without the blocker)
// or cancels it. C15: blockers that diverge → waiting blockers_diverge + one alert, no assign (WAIT_IRFAN).
function autoAssign(t, alert = (_a) => {}) {
  if (t.state !== 'backlog' || !t.auto_assign || WAIT_IRFAN.includes(t.waiting?.reason) || assigning.has(t.id)) return;
  const b = blocker(t);
  if (b.cancelled) return void wait(t.id, 'backlog', { reason: 'blocker_cancelled', blocker: b.cancelled }, alert,
    { title: 'Blocker cancelled', message: `${t.id} ${t.title}: blocker ${b.cancelled} was cancelled; tb assign ${t.id} to go on without it, or cancel it` });
  if (b.why) return;
  assign(t.id, false).catch((e) => {
    const error = String(e.message).slice(0, 500);
    console.error(`tbd: ${t.id}: auto-assign failed: ${error}`);
    if (e instanceof Diverge) return void wait(t.id, 'backlog', { reason: 'blockers_diverge', error }, alert, { title: 'Blockers diverge', message: `${t.id} ${t.title}: ${error}` });
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
// The approved plan t.plan_file points at (P5 M9: plan-<hash>.json, immutable; plan.json before P5), or null: not a
// plain file. readPlan works without a plan_hash too (a replan reads the plan it replaces).
const planFile = (t) => (PLAN_FILE_RE.test(t.plan_file ?? '') ? t.plan_file : 'plan.json');
async function readPlan(t) {
  const f = path.join(store.ticketDir(t.id), planFile(t));
  return (await isFile(f)) ? JSON.parse(await fsp.readFile(f, 'utf8')) : null;
}
// L7: the plan approve froze, or null: no plan_hash yet, or not a plain file.
const frozenPlan = async (t) => (t.plan_hash ? readPlan(t) : null);

// P5 K4: keep_ok for the plan rules (in-run hook + handler): the approved plan's task ids in order while done (what a
// replan may keep), null when no task ran yet (no replan). M5.5: and while each one's pre is the head before it (from
// base_sha): a lane merged after a later task (branch order ≠ plan order) stops it, so a reset to the last kept head
// never drops a merged commit.
async function keepOk(t) {
  if (!t.work) return null;
  const byId = new Map(t.work.tasks.map((x) => [x.id, x]));
  const ok = [];
  let at = t.base_sha;
  for (const { id } of (await readPlan(t).catch(() => null))?.tasks ?? []) {
    const x = byId.get(id);
    if (x?.status !== 'done' || x.pre !== at) break;
    ok.push(id);
    at = x.head;
  }
  return ok;
}

// P5 K4 (M4): `keep` only on a replan (the ticket has a work cursor): ids of tasks done under the approved plan, in its
// order, first in tasks in the same order (approve copies them from the old plan: their text cannot change).
async function keepRules(t, out) {
  if (out.kind !== 'plan' || !Array.isArray(out.keep) || !out.keep.length) return []; // an empty keep = none (as plan-rules)
  if (!t.work) return ['keep: only a replan keeps tasks (no task ran yet): leave it out'];
  const ids = ((await readPlan(t).catch(() => null))?.tasks ?? []).map((x) => x.id);
  const done = new Set(t.work.tasks.filter((x) => x.status === 'done').map((x) => x.id));
  const why = out.keep.flatMap((id, i) => (!ids.includes(id) ? [`keep[${i}] ${q(id)}: not a task of the approved plan`] : !done.has(id) ? [`keep[${i}] ${q(id)}: not done`] : []));
  const at = out.keep.map((id) => ids.indexOf(id));
  if (at.some((x, i) => i && x <= at[i - 1])) why.push("keep: ids must follow the approved plan's order");
  if ((out.tasks ?? []).slice(0, out.keep.length).map((x) => x?.id).join('\0') !== out.keep.join('\0')) why.push(`tasks: the kept ids ${out.keep.map(q).join(', ')} must come first, in the same order`);
  return why;
}

// T1: the tag's rules (Irfan's files, absolute paths): plain files only (lstat), all together ≤ RULES_MAX bytes, else
// refused (never cut). → {text, sha}; no rules → null. Agents get the text, never a path.
async function readRules(tag) {
  if (!tag?.rules?.length) return null;
  const parts = [];
  for (const f of tag.rules) {
    if (typeof f !== 'string' || !path.isAbsolute(f) || !(await isFile(f))) throw new Error(`tag rules file ${q(f)}: not a plain file (missing, a dir or a link)`);
    parts.push((await fsp.readFile(f, 'utf8')).trimEnd());
  }
  const text = parts.join('\n\n') + '\n';
  if (Buffer.byteLength(text) > RULES_MAX) throw new Error(`tag rules are ${Buffer.byteLength(text)} bytes, over ${RULES_MAX}: shorten them (never cut)`);
  return { text, sha: crypto.createHash('sha256').update(text).digest('hex') };
}

// The code/planning handler. questions → clarify (must_ask cleared), plan → plan_approval; else {reject}. The round's
// files are written by `after`, which the runner calls inside the move's own store write once the move is sure (a
// Restart or Cancel meanwhile leaves no file behind for the next seed).
async function handle(t, out) {
  // P5 K4: a replan's paths are checked at the branch HEAD (ctx.at), where the done tasks' files are
  const head = t.work && t.worktree ? (await git(t.worktree, ['rev-parse', '--verify', 'HEAD'], 20_000, t)).stdout.trim() : '';
  const tag = t.tag ? store.listTags()[t.tag] : null;
  const ctx = rules.ctxOf(t, (await skillSources()).skills, { at: SHA_RE.test(head) ? head : undefined, test_scripts: tag ? tagsLib.gateTag(tag).test_scripts : undefined, keep_ok: (await keepOk(t)) ?? undefined });
  const why = [...(await rules.check(out, ctx)), ...(await keepRules(t, out))];
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
  // M5.4 X11 (F8): questions after a working replan are the planner's: clarify_origin (the planner's why) now names
  // planning, so answers, the lavish page and boot treat this clarify as a planning one (planningClarify)
  const origin = t.clarify_origin && { clarify_origin: { ...t.clarify_origin, phase: 'planning' } };
  return out.kind === 'questions'
    ? { to: 'clarify', ctx: { questions: () => true }, patch: { must_ask: false, ...origin }, after }
    : { to: 'plan_approval', ctx: { plan_valid: () => true }, after };
}

// M5.4 X11: a clarify the planner opened (its questions), not a working task's ask (clarify_origin phase working). The
// one predicate for answer routing (http, cli, ui), the lavish page (open, reopen) and boot.
const planningClarify = (/** @type {any} */ t) => t.state === 'clarify' && t.clarify_origin?.phase !== 'working';

// J16: the ticket's tag for the seed: name, type, base, its checks (a test_cmd's npm script must exist), context files,
// default skills and the installed skill names (plan skills name only these; sorted, the first SKILLS_SHOWN).
function tagBlock(name, tag, names) {
  const list = (v) => (v?.length ? v.join(', ') : '(none)');
  const more = names.length > SKILLS_SHOWN ? ` (+${names.length - SKILLS_SHOWN} more)` : '';
  const gt = tagsLib.gateTag(tag); // P5: what the gates hold the plan to (a migrations dir in generated still goes in modules)
  return [`tag: ${name} (${tag.type ?? 'no type'}${tag.base ? `, base ${tag.base}` : ''})`,
    `checks: ${list(Object.entries(tag.checks ?? {}).map(([k, v]) => `${k} = ${v}`))}`, `test scripts (test_cmd may run): ${gt.test_scripts}`,
    `protected: ${list(gt.protected)}`, `generated: ${list(gt.generated)}`, `context files: ${list(tag.context)}`,
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
  // m7 (X1): the plan rule's one mustAsk: Irfan's flag, or D-0116 (no answers and no locked decisions yet: round 1)
  if (rules.mustAsk(t)) {
    out.push('## Ask first', t.must_ask ? 'Irfan wants to be asked more before a plan: return kind "questions" this round; a plan is refused.'
      : 'Round 1 must be questions (no answers or locked decisions yet): return kind "questions" this round; a plan is refused.');
  }
  const tag = t.tag ? store.listTags()[t.tag] : null;
  if (tag) out.push('## Tag', tagBlock(t.tag, tag, Object.keys((await skillSources()).skills).sort()));
  if (tag?.rules?.length) out.push("## Irfan's rules", await readRules(tag).then((r) => r.text.trimEnd(), (e) => `(not shown: ${e.message})`)); // T1
  if (t.work) { // P5 K4: a replan; the done tasks as the approved plan has them (a kept task is copied from there)
    const old = (await readPlan(t).catch(() => null)) ?? {};
    const acc = new Map((old.acceptance ?? []).map((a) => [a.id, a]));
    const done = t.work.tasks.filter((x) => x.status === 'done').map((x) => {
      const o = old.tasks?.find((y) => y.id === x.id);
      const a = (o?.acceptance ?? []).map((id) => `${id} (${acc.get(id)?.type ?? '?'}): ${acc.get(id)?.text ?? '?'}`).join('; ');
      return `- ${x.id} (${String(x.head ?? x.commit ?? '').slice(0, 12)}): ${o?.title ?? '?'} | files: ${(o?.files ?? []).join(', ') || '(none)'} | test_cmd: ${o?.test_cmd ?? '(none)'} | acceptance: ${a || '(none)'}`;
    });
    out.push('## Replan', [`Work stopped${t.clarify_origin?.task ? ` at ${t.clarify_origin.task}` : ''}${t.clarify_origin?.why ? `: ${t.clarify_origin.why}` : ''}.`,
      'Done so far:', ...(done.length ? done : ['(none)']), 'List done tasks to keep unchanged in "keep" (first in tasks, same order, with their acceptance ids); every other task starts again from the last kept one.'].join('\n'));
  }
  out.push('## System now', system);
  return out.join('\n\n') + '\n';
}

// U8: Irfan's answers to the open Clarify round → planning (the next round: a fresh session seeded with them). body:
// {answers: {<qid>: {pick: <one of its options>} | {text} | {use: "recommended" | "you_decide"}}, plan_now?}. Every
// question needs one unless plan_now ("Enough, plan now": the rest is the planner's call). Each joins t.answers; a pick,
// a text or "use recommended" is also locked as a decision {id: R<round>Q<qid>, source: answer:R<round>Q<qid>}.
// D-0117: every answer is an intervention row with its actor (cli | ui | lavish: the Clarify page, lib/interview.js),
// in the same write as the move.
async function answer(id, body, actor = 'cli') {
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
  return store.intervention(id, { actor, verb: 'answer', payload: body }, (k) => {
    if (k.round !== t.round) throw new TbError(409, `${id}: it moved on meanwhile (now ${k.state})`); // CR-9: another answer won
    return fsm.move({ ...k, answers: [...(k.answers ?? []), ...rows], locked_decisions: [...(k.locked_decisions ?? []), ...locked] },
      'planning', 'you', { answers_complete: () => true });
  });
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
async function keepSetup(id, pid, known = undefined) {
  const lstart = known ?? (await procs(true))?.get(pid)?.lstart; // C locale, UTC: compared as is at the next boot
  if (!lstart) return;
  await store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval' || k.waiting?.reason !== 'setup') throw new Moved(); // setup ended meanwhile
    return { ...k, waiting: { ...k.waiting, pid, lstart } };
  }).catch((e) => { if (!(e instanceof Moved)) console.error(`tbd: ${id}: setup pid not saved: ${e.message}`); });
}

// U9 in order, each step done again or skipped when done (a re-approve resumes): plan frozen (plan_hash, plan.json +
// P5 plan-<hash>.json; L7: n given → it must be the newest round) → git tags: branch tb/<id>-<slug> (the worktree must be
// clean at base_sha first) → S2: the tree reset to base_sha and cleaned (ignored files too) on every first approve, so
// setup runs nothing planted since (an ignored .npmrc, a hook script); P5 K4 a replan keeps the done prefix instead
// (replan()) → env files → skills → the tag's setup in the heavy slot → the config baseline (U10, + tripwire) → P5 N3:
// the OpenAPI base and the base checks (first approve only: a replan keeps both) → T1 rules → children + the work cursor
// + plan_approval → working, one store job. git_dir + common_dir (+ clone) pinned (S1, H2.2).
async function setup(id, n) {
  const dir = store.ticketDir(id);
  const live = (patch) => store.updateTicket(id, (k) => {
    if (k.state !== 'plan_approval') throw new Moved();
    return { ...k, ...patch };
  });
  const t0 = store.getTicket(id);
  const r = await currentRound(t0);
  if (r?.kind !== 'plan') throw new Error('no plan to approve (rounds/NN-plan.json)');
  if (n !== undefined && r.n !== n) throw new Error(`the plan changed: round ${r.n} is the newest, not round ${n}; look at it again, then approve`);
  const plan = { ...r };
  delete plan.n;
  // K4: kept tasks come from the approved plan (the planner's copy is never taken); kept = the longest prefix of its
  // tasks that are done and listed in keep (handle() checked keep)
  const old = t0.work ? await readPlan(t0) : null;
  const done = new Map((t0.work?.tasks ?? []).filter((x) => x.status === 'done').map((x) => [x.id, x]));
  const kept = [];
  for (const x of old?.tasks ?? []) if (kept.length === old.tasks.indexOf(x) && done.has(x.id) && (plan.keep ?? []).includes(x.id)) kept.push(x.id);
  if (kept.length) plan.tasks = plan.tasks.map((x) => (kept.includes(x.id) ? old.tasks.find((o) => o.id === x.id) : x));
  const hash = crypto.createHash('sha256').update(canon(plan)).digest('hex');
  const was = t0.plan_hash;
  if (was && was !== hash) throw new Error(`the plan changed after it was frozen (plan_hash ${was.slice(0, 12)}): reject it and plan again`);
  const text = JSON.stringify(plan, null, 2) + '\n';
  await store.writeAtomic(path.join(dir, 'plan.json'), text);
  await store.writeAtomic(path.join(dir, `plan-${hash}.json`), text); // M9: immutable; the final write points at it
  let t = await live({ plan_hash: hash, skills: plan.skills });
  const tag = store.listTags()[t.tag];
  if (!tag?.path) throw new Error(`tag ${t.tag} has no path any more`);
  const isGit = tag.type === 'git';
  const replanning = isGit && !!t.work;
  let pre = t.base_sha;
  const resetup = !replanning; // the tag's own (unsandboxed) setup: the first approve only (P4 consent, base_sha's tree)
  if (isGit) {
    const wt = t.worktree;
    if (typeof wt !== 'string' || !path.isAbsolute(wt)) throw new Error('the ticket has no worktree (tb assign makes it)');
    if (!SHA_RE.test(t.base_sha ?? '')) throw new Error('the ticket has no base_sha (tb assign sets it)');
    // H2.1 rev 3 #9 + S-L1: a tbd killed after the tag's setup wrote the clone's config, before the hash below was
    // saved, left the old hash and setup_pending (written before that setup ran, = that old hash): only then is the
    // config hashed again, before the first pinned git. No marker: no setup of tbd's ran since the hash, so a changed
    // config is planted: the pin refuses it (PLANTED), nothing blessed.
    if (resetup && t.clone && t.setup_pending === t.clone.config) t = await live({ clone: await cloneConfig(t.git_dir), setup_pending: undefined });
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
    if (replanning) pre = await replan(t, tag, kept, g);
    else {
      for (const args of [['reset', '-q', '--hard', t.base_sha], ['clean', '-q', '-ffdx', '-e', '.claude/.cc-writes']]) {
        const x = await g(args, 120_000);
        if (x.err) throw new Error(`git ${args[0]} in ${wt}: ${gitTail(x)}`);
      }
    }
    await copyEnv(tag, wt);
  }
  await copySkills(id, plan.skills);
  const base = {}; // N3: base_checks + openapi_base of this approve (a replan keeps the old ones)
  if (isGit && resetup) {
    if (tag.setup && t.clone) t = await live({ setup_pending: t.clone.config }); // S-L1: the marker, before the setup runs
    const s = tag.setup ? await doctor.setup(t.worktree, tag.setup, (pid) => keepSetup(id, pid)) : null;
    // the baseline right after setup, failed or not: what setup made is tbd's (a reject → planning must not refuse it).
    // H2.1 F3: setup may write the clone's config (husky: core.hooksPath): hashed again first, the baseline taken with
    // that hash, both in one write (the marker cleared in it)
    const clone = t.clone && (await cloneConfig(t.git_dir));
    const tt = clone ? { ...t, clone } : t;
    t = await live({ config_baseline: await spawn.configBaseline(tt, t.worktree), ...(clone && { clone, setup_pending: undefined }) });
    if (s?.err) {
      const head = `setup ${q(tag.setup)} failed (${s.err.timedOut ? 'timed out' : `exit ${s.err.code}`}):\n`;
      throw new Error(head + s.output.slice(-(TAIL - head.length)));
    }
  }
  // K3 RO2: Irfan's allows / denies of the kept tasks stay (scope.json), the others go (a new plan may reuse their ids)
  const W = require('./working'); // lazy: working requires this module
  const sc = replanning ? await W.readScope(id) : { allow: {}, denied: {} };
  if (replanning) {
    for (const m of [sc.allow, sc.denied]) for (const x of Object.keys(m)) if (!kept.includes(x)) delete m[x];
    await W.writeScope(id, sc);
  }
  // RO2: what node_modules is built from (t.work.deps_blob): base_sha's lockfile after the first approve's setup; on a
  // replan the kept commit's, when it had to be built again
  // C-M3 S-L7: a lockfile blob at a commit is read from the tag repo's objects only (trusted: base_sha is pinned there,
  // a kept head was fetched by its gate), never the clone's own store
  const tt = t.clone ? { ...t, trusted: true } : t;
  let built = isGit ? await W.depsBlob(tt, replanning ? null : t.base_sha) : null;
  let online = null; // RO2: the offline build needs the network → why, the ticket asks deps (clarify) after the move
  if (replanning) {
    const want = await W.depsBlob(tt, pre);
    const trip = await spawn.tripwire(t.worktree);
    const b = t.config_baseline?.tripwire;
    const same = !!t.work.deps_blob && want === t.work.deps_blob && !!b && trip.lock === b.lock && trip.bin === b.bin;
    if (!same) {
      const r = await W.gates().runDepsSetup({ t: W.withScope(t, sc), wt: t.worktree, tag, online: false, onSpawn: (/** @type {number} */ pid) => void keepSetup(id, pid), signal: new AbortController().signal });
      if (r?.needs_online) {
        online = `the kept commits' dependencies (${want.split(':')[0]}) are not the ones node_modules was built from, and the build needs the network (443 to any host while npm ci runs): tb scope ${id} --allow to build online, or --replan`;
        built = null; // unknown until the online build
      } else if (!r?.ok) throw new Error(`dependency setup (RO2) failed: ${String(r?.why ?? 'no result').slice(0, 500)}`);
      else t = await live({ config_baseline: await spawn.configBaseline(t, t.worktree) }); // the tripwire again: the build is tbd's
    }
    if (!online) built = await W.depsBlob(t); // the worktree's lockfile now = pre's (npm ci never rewrites it)
  }
  if (isGit && !replanning) Object.assign(base, await baseChecks(id, t, tag));
  const rulesSnap = await readRules(tag); // T1: refreshed at every approve (a new approval is a new consent)
  if (rulesSnap) await store.writeAtomic(path.join(dir, 'rules.md'), rulesSnap.text);
  await store.createChildren(id, plan.children, async (k) => {
    const next = fsm.move({
      ...k, ...base, plan_file: `plan-${hash}.json`, plan_hashes: [...(k.plan_hashes ?? []), hash], rules_sha: rulesSnap?.sha ?? null,
      work: { ...W.seedWork(plan, { ...k, ...base }, { pre, kept }), scope: W.counts(sc.allow), denied: W.counts(sc.denied), deps_blob: built }, // unit_ms: base unit time (K13)
    }, 'working', 'you', { approve: () => true });
    delete next.clarify_origin;
    return online ? W.askDeps(next, ['package.json', 'package-lock.json'], online) : next;
  });
}

// P5 N3: the tag's OpenAPI base, then its base checks (typecheck, unit, lint, build: those it sets) at base_sha through
// the gates, in the setup's pid slot (waiting: a tbd that dies meanwhile → lostSetups ends it). A tag with neither runs
// nothing (no gate is asked). Red → throws "base red: <check>" (setup_failed: main must be green before work starts).
async function baseChecks(id, t, tag) {
  const gt = tagsLib.gateTag(tag);
  const want = ['typecheck', 'unit', 'lint', 'build'].some((c) => gt.checks?.[c]);
  if (!gt.openapi && !want) return { base_checks: {} }; // none to run (as migrate)
  const gates = require('./working').gates(); // lazy (RAM): lib/gates loads with the first gate job only
  const onSpawn = (pid) => void keepSetup(id, pid);
  const save = async (patch) => {
    if (patch?.proc) await keepSetup(id, patch.proc.pid, patch.proc.lstart);
    const k = store.getTicket(id);
    return k.state === 'plan_approval' && k.waiting?.reason === 'setup';
  };
  const signal = new AbortController().signal;
  const out = {};
  if (gt.openapi) {
    const o = await gates.captureOpenapiBase({ t, wt: t.worktree, tag, onSpawn, signal });
    if (!o?.ok) throw new Error(`base red: openapi: ${String(o?.why ?? 'no result').slice(0, 500)}`);
    out.openapi_base = { sha: t.base_sha, at: iso() };
  }
  if (want) {
    const b = await gates.runBaseChecks({ t, wt: t.worktree, tag, save, onSpawn, signal });
    const red = Object.entries(isObj(b?.checks) ? b.checks : {}).filter(([, c]) => !c?.ok).map(([c]) => c);
    if (!b?.ok) throw new Error(`base red: ${red.join(', ') || String(b?.why ?? 'no result').slice(0, 500)}${red.length && b?.why ? `: ${String(b.why).slice(0, 500)}` : ''}`);
    out.base_checks = Object.fromEntries(Object.entries(b.checks).map(([c, x]) => [c, { ok: !!x.ok, ms: Number.isFinite(x.ms) ? x.ms : null }]));
  }
  return out;
}

// P5 K4+C2 (critic MINOR 3): a re-approve after a replan. n = the replan's number. The dirty tree, untracked files too
// (not ignored ones, not the env files), is saved first as a commit on refs/tb/<id>/replan-<n>-wip (a temp index:
// GIT_INDEX_FILE; the real one is reset next anyway), the old HEAD on refs/tb/<id>/replan-<n> (both create-only: a
// retry after a failed setup keeps the first), then reset --hard to the last kept task's commit (else base_sha) and
// clean -fdq (no -x: node_modules stays). → pre: that commit.
async function replan(t, tag, kept, g) {
  const n = (t.plan_hashes ?? []).length;
  const ref = (x) => `refs/tb/${t.id}/${x}`;
  const run = async (args, o = {}) => {
    const x = await gitIn(t.worktree, args, { timeout: 120_000, dirs: t, ...o });
    if (x.err) throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} in ${t.worktree}: ${gitTail(x)}`);
    return x.stdout.trim();
  };
  const head = await run(['rev-parse', '--verify', 'HEAD']);
  if ((await spawn.dirtyPaths(t)).length) {
    const idx = path.join(store.ticketDir(t.id), `replan-${n}.index`);
    const temp = { exec: (/** @type {string} */ f, /** @type {string[]} */ a, /** @type {any} */ o) => sh(f, a, { ...o, env: { ...o.env, GIT_INDEX_FILE: idx } }) };
    try {
      await fsp.rm(idx, { force: true });
      await run(['add', '-A'], temp);
      if (tag.env_files?.length) await run(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...tag.env_files], temp); // secrets never in an object
      const tree = await run(['write-tree'], temp);
      const wip = await run(['-c', 'user.name=tbd', '-c', 'user.email=tbd@localhost', 'commit-tree', tree, '-p', head, '-m', `tb replan ${n}: the tree before the reset`]);
      await g(['update-ref', ref(`replan-${n}-wip`), wip, '']); // '': create only (a retry keeps the first), any object format
    } finally {
      await fsp.rm(idx, { force: true });
    }
  }
  await g(['update-ref', ref(`replan-${n}`), head, '']);
  const last = kept.length ? t.work.tasks.find((x) => x.id === kept.at(-1)) : null;
  const pre = last?.head ?? last?.commit ?? t.base_sha;
  await run(['reset', '-q', '--hard', pre]);
  await run(['clean', '-q', '-fd', '-e', '.claude/.cc-writes']);
  return pre;
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
// stale → its orphaned setup ended (killSetups), then setup_failed + an alert (J12: approve again resumes). ps failing →
// nothing marked (`waiting: setup` keeps approve / reject at 409: never two setups in one worktree), tried again in 30 s.
async function lostSetups(alert = (_a) => {}) {
  const error = 'tbd restarted during setup; approve again';
  const lost = store.listTickets().filter((t) => t.state === 'plan_approval' && t.waiting?.reason === 'setup' && !approving.has(t.id));
  if (!(await killOrphans(lost.map((t) => t.waiting).filter((w) => Number.isInteger(w.pid) && w.lstart), procs))) { // recovery.js
    return void setTimeout(() => void lostSetups(alert).catch((e) => console.error(`tbd: lost setups: ${e.message}`)), 30_000).unref();
  }
  for (const t of lost) {
    await wait(t.id, 'plan_approval', { reason: 'setup_failed', error }, alert, { title: 'Setup failed', message: `${t.id} ${t.title}: ${error}` },
      (k) => k.waiting?.reason === 'setup' && !approving.has(k.id));
  }
}

phases.registerHandler('code/planning', handle, seed);

module.exports = { assign, autoAssign, worktree, blocker, answer, planningClarify, reject, approve, currentRound, frozenPlan, readPlan, keepOk, lostSetups, copyEnv, copySkills, readRules, canon };
