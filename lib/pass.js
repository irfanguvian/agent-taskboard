'use strict';
// pass: `tb pass` (plan §3b, D9 D26; contract rev 4.1 K2 M15; P5 AC9) and the AC11 children watcher (J4, D-0035).
// pass(id, {sha?}, actor): Irfan stands in for a phase the live code cannot run yet. review / qa unbuilt → the next
// phase (the fsm rows `by: you`, guard phase_unbuilt; no sha). final_gate unbuilt (D9): --sha = the squash commit on the
// tag's base branch, checked (M15) before anything is written: 7-40 lowercase hex before any git; `rev-parse --verify
// --end-of-options <sha>^{commit}` → the full 40 hex, which must start with what was typed (a ref named like the prefix,
// e.g. a tag an agent made, never stands in for it); base_sha an ancestor of it and not it; on refs/heads/<base> (guard
// sha_on_main; the full name: a tag `main` never shadows the branch); at least one path the branch changed also changed
// in base_sha..sha. Then pr {sha, merged_at} (the assign guard reads merged_at: children blocked by it may start) and →
// done, or, while a child is open, it stays in final_gate waiting {reason: 'children', done, total, blocked, since}; a
// second pass then is refused (merged_at is never rewritten). final_gate built + a leak_check tag (D26) → waiting manual cleared only
// (P6 pushes and moves it). Every pass is one store.intervention (actor cli | ui). git: util.git with the ticket's
// pinned git_dir + common_dir (S1), argv only.
// watch({alert}): store `transition` events, no timers. Any move of a child → its parent (in final_gate, its own pass
// recorded) counts again: all finished → final_gate → done (runner row, guards final_gate + children_done), which is a
// transition too, so it climbs to the grandparent (any depth); else waiting children n/m + the blocked ones. One alert
// per child newly in that blocked list (already blocked when the wait began, or blocked later; notify never re-pings
// `children`). boot(): the same count for every parent waiting on children (a tbd that died between a child's move and
// its parent's); tbd.js runs it after watch().
const store = require('./store');
const fsm = require('./fsm');
const phases = require('./phases');
const { TbError } = require('./errors');
const { isObj, git } = require('./util');

const CLOSED = ['done', 'cancelled'];
const SHA_IN = /^[0-9a-f]{7,40}$/;
const SHA_FULL = /^[0-9a-f]{40}$/;
const SUBJECT_MAX = 200;
const iso = () => new Date().toISOString();
const bad = (msg) => new TbError(400, msg);
const no = (msg) => new TbError(409, msg);
const short = (s) => String(s).slice(0, 12);
class Moved extends Error {} // the parent left the state the watcher expected: nothing written

/** @param {string} id */
const ticketOf = (id) => {
  try {
    return store.getTicket(id);
  } catch {
    return null;
  }
};
const count = (t) => {
  const kids = (t.children ?? []).map((c) => [c, ticketOf(c)?.state]);
  return { done: kids.filter(([, s]) => CLOSED.includes(s)).length, total: kids.length, blocked: kids.filter(([, s]) => s === 'blocked').map(([c]) => c) };
};
const same = (t) => (k) => {
  if (k.state !== t.state || k.round !== t.round) throw no(`${t.id}: it moved on meanwhile (now ${k.state})`);
};

// M15 → {sha (40 hex), subject}. Every refusal names what failed; nothing is written.
async function verify(t, input) {
  if (typeof input !== 'string' || !SHA_IN.test(input)) throw bad('sha must be 7-40 lowercase hex characters (a commit id)');
  const tag = store.listTags()[t.tag];
  if (!t.worktree || !SHA_FULL.test(t.base_sha ?? '') || !tag?.base) throw no(`${t.id}: no worktree, base_sha or tag base to check the sha against`);
  const g = (args) => git(t.worktree, args, { dirs: t, timeout: 20_000 });
  const main = `refs/heads/${tag.base}`;
  const r = await g(['rev-parse', '--verify', '--quiet', '--end-of-options', `${input}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.err || !SHA_FULL.test(sha) || !sha.startsWith(input)) throw no(`${t.id}: ${input} is not a commit id in ${t.tag}'s repo`);
  if (sha === t.base_sha) throw no(`${t.id}: ${short(sha)} is base_sha itself: pass the squash commit made after it`);
  if ((await g(['merge-base', '--is-ancestor', t.base_sha, sha])).err) throw no(`${t.id}: base_sha ${short(t.base_sha)} is not an ancestor of ${short(sha)}`);
  if ((await g(['merge-base', '--is-ancestor', sha, main])).err) throw no(`${t.id}: ${short(sha)} is not on ${tag.base}`);
  const diff = (to) => g(['diff', '--name-only', '-z', '--no-renames', t.base_sha, to, '--']);
  const [mine, theirs, log] = await Promise.all([diff(t.branch ? `refs/heads/${t.branch}` : 'HEAD'), diff(sha), g(['log', '-1', '--format=%s', sha])]);
  if (mine.err || theirs.err) throw no(`${t.id}: git diff failed: ${String(mine.stderr || theirs.stderr).trim().slice(0, 200)}`);
  const changed = new Set(mine.stdout.split('\0').filter(Boolean));
  if (!theirs.stdout.split('\0').some((p) => p && changed.has(p))) throw no(`${t.id}: ${short(sha)} changes none of the paths ${t.branch ?? 'the branch'} changed since base_sha`);
  return { sha, subject: log.stdout.trim().slice(0, SUBJECT_MAX) };
}

// final_gate → done (actor's row, ctx its guards) once every child is done or cancelled; while one is open: waiting
// children n/m (its since kept). Pure: runs inside the caller's store write.
function finish(k, actor, ctx) {
  const others = fsm.check(k, 'done', actor, { ...fsm.GUARDS, ...ctx, children_done: () => true });
  if (!others.ok) throw no(`${k.id}: ${others.reason}`);
  const { done, total, blocked } = count(k);
  if (done < total) return { ...k, waiting: { reason: 'children', done, total, blocked, since: k.waiting?.reason === 'children' ? k.waiting.since : iso() } };
  return fsm.move(k, 'done', actor, { ...ctx, ticketOf }); // children_done checks again (fail closed)
}

/** GET preview (the UI's confirm): the sha resolved + its subject, every M15 check run, nothing written. */
async function preview(id, input) {
  const t = store.getTicket(id);
  if (t.state !== 'final_gate' || phases.built(t.kind, 'final_gate')) throw no(`${id}: a sha is passed only at an unbuilt final gate (state ${t.state})`);
  return verify(t, input);
}

/** `tb pass` → the ticket after it. body: {} | {"sha": "<7-40 hex>"}. */
async function pass(id, body, actor = 'cli') {
  if (!isObj(body) || Object.keys(body).some((k) => k !== 'sha') || (body.sha !== undefined && typeof body.sha !== 'string')) throw bad('body must be {} or {"sha": "<commit>"}');
  const t = store.getTicket(id);
  const write = (fn) => store.intervention(id, { actor, verb: 'pass', task: null, payload: body }, (k) => {
    same(t)(k);
    return fn(k);
  });
  if (t.state === 'review' || t.state === 'qa') {
    if (body.sha !== undefined) throw bad(`${id}: --sha is for the final gate; ${t.state} passes without one`);
    const to = t.state === 'qa' || t.kind === 'brainstorm' ? 'final_gate' : 'qa';
    return write((k) => fsm.move(k, to, 'you'));
  }
  if (t.state !== 'final_gate') throw no(`${id}: nothing to pass in ${t.state}`);
  if (phases.built(t.kind, 'final_gate')) { // D26: the leak scan parked it; pass = the push OK
    if (store.listTags()[t.tag]?.leak_check !== true) throw no(`${id}: phase ${t.kind}/final_gate is built; the runner moves it`);
    if (body.sha !== undefined) throw bad(`${id}: a leak_check park takes no sha: tb pass is the push OK`);
    if (t.waiting?.reason !== 'manual') throw no(`${id}: not parked (waiting ${t.waiting?.reason ?? 'none'}): nothing to OK yet`);
    return write((k) => {
      if (k.waiting?.reason !== 'manual') throw no(`${id}: no longer parked`);
      return { ...k, waiting: null };
    });
  }
  const passed = (k) => k.pr?.merged_at && no(`${id}: passed already (${short(k.pr.sha)} at ${k.pr.merged_at}); it waits for its children`);
  if (passed(t)) throw passed(t);
  if (body.sha === undefined) throw bad(`${id}: the final gate needs --sha <the squash commit on the base branch>`);
  const { sha } = await verify(t, body.sha);
  const next = await write((k) => {
    if (passed(k)) throw passed(k);
    return finish({ ...k, pr: { ...k.pr, sha, merged_at: iso() } }, 'you', { sha_on_main: (x) => x.pr?.sha === sha || 'sha not checked' });
  });
  tell(t, next);
  return next;
}

// ---- AC11 watcher ---------------------------------------------------------------------------------------------------
let notify = (/** @type {any} */ _a) => {}; // watch() sets it: the runner's alert
const wait = (k) => (k?.waiting?.reason === 'children' ? k.waiting : null);
// One alert per child that joined the parent's blocked list in this write (before → after).
function tell(before, after) {
  const was = new Set(wait(before)?.blocked ?? []);
  for (const c of wait(after)?.blocked ?? []) {
    if (!was.has(c)) notify({ title: 'Child ticket blocked', message: `${after.id} ${after.title}: waits for ${c} ${ticketOf(c)?.title ?? ''}, which is blocked` });
  }
}

/** A parent in final_gate with its own pass recorded counts its children again: done, or waiting n/m (+ blocked). */
async function settle(id) {
  const p = ticketOf(id);
  if (p?.state !== 'final_gate' || !p.pr?.merged_at || !p.children?.length) return;
  let before = null;
  try {
    const next = await store.updateTicket(id, (k) => {
      if (k.state !== 'final_gate' || !k.pr?.merged_at) throw new Moved();
      const n = finish(k, 'runner', { final_gate: (x) => Boolean(x.pr?.merged_at) || 'its own pass is not recorded' });
      const key = (x) => JSON.stringify([x.state, wait(x)?.done, wait(x)?.total, wait(x)?.blocked]);
      if (key(n) === key(k)) throw new Moved(); // nothing new: no write
      before = k;
      return n;
    });
    tell(before, next);
  } catch (e) {
    if (e instanceof Moved) return;
    console.error(`tbd: ${id}: children count not saved: ${e.message}`);
    notify({ title: 'Parent not finished', message: `${id}: ${String(e.message).slice(0, 300)}` });
  }
}

let watching = false;
/** tbd.js, once, after store.init: the children watcher (store `transition` events). */
function watch({ alert = (_a) => {} } = {}) {
  notify = alert;
  if (watching) return;
  watching = true;
  store.on('transition', (next) => {
    if (next.parent) void settle(next.parent);
  });
}

/** tbd.js boot, after watch(): every parent waiting on its children counts them again (a finish lost to a stop). */
async function boot() {
  for (const t of store.listTickets()) if (t.state === 'final_gate' && t.pr?.merged_at && t.children?.length) await settle(t.id);
}

module.exports = { pass, preview, watch, boot };
