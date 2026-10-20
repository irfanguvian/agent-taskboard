'use strict';
// gc: what `tb gc` can free (plan AC12): worktrees of done / cancelled / missing tickets, run logs older than
// 30 days, cache entries. Everything lives under TB_HOME/{worktrees,tickets,cache}; any other path (a symlink,
// a crafted id, ~/taskboard-live, the dev checkout) is never listed and never touched. Async only (D31).
// P5 (contract R1 M13): + git refs in the repo a ticket recorded (common_dir, S1; git runs on that dir only, never in a
// worktree): branches tb/<id>-<slug> of cancelled tickets (name checked, the preview counts the commits no other branch
// has: unmerged) and refs/tb/<id>/* (attempts, replan snapshots) of done / cancelled ones. One for-each-ref per repo.
// C-L6: a clone ticket's worktree row counts the commits only its clone holds (clone_only; git in the clone only
// through its pin, util.git H2.2).
// Deleted only as confirmed ids of a fresh list: a branch after the worktrees went (one checked out is refused), refs
// through one `update-ref --stdin`.
// Phase 4 (design .omc/plans/2026-10-20-phase4-one-kind-design.md revision 6, section 6): an Own Worktree Task's row
// says how many files Done left uncommitted (task.kept) and goes through task.untree (its exact git folder, never a
// prune), only once its run is over; its tb/<id> branch is listed when done or cancelled. A branch row carries the sha
// it was listed at: the delete is first written down in <TB_HOME>/gc-branches.jsonl ({common, ref, sha}, D-0238: the
// safety check skips only these deletes), then `update-ref -d <ref> <sha>` (only the branch gc listed).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, minimalEnv, GIT_SAFE, GIT_ENV, SHA_RE, shq, readPlain, git: pinned } = require('./util');

const DAY_MS = 86_400_000;
const LOG_DAYS = 30;
const CLOSED = ['done', 'cancelled'];
const DU_PARALLEL = 4;
const UNREADABLE = 'ticket unreadable'; // its dir exists but the store could not load it: never "missing"
const BRANCH_RE = /^tb\/t_[a-z0-9]+(-[a-z0-9-]+)?$/; // a code ticket's tb/<id>-<slug>, an Own Worktree Task's tb/<id>
const REF_RE = /^refs\/tb\/t_[a-z0-9]+\/[A-Za-z0-9@_-][A-Za-z0-9@._/-]{0,200}$/;
const bad = (msg) => new TbError(400, msg);
const PIN = Symbol('pin'); // a clone worktree row's ticket (C-L6), never in the JSON
const TREE = Symbol('tree'); // an Own Worktree Task row's ticket (removed by task.untree), never in the JSON
const RECORD = 'gc-branches.jsonl';
const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW; // store's event log flags
const MISSING = (/** @type {string} */ p) => `if it was an Own Worktree, run \`git worktree unlock ${shq(p)} && git worktree prune\` in its repo`;
const HEAD_FILES = ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']; // a branch a rebase or bisect is on
const own = (/** @type {any} */ t) => t?.kind === 'task' && t.task?.mode === 'worktree';

// fn over items, at most `limit` at once; results in input order.
async function pmap(items, limit, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}

/** @param {{store: any, tbHome?: string, now?: () => number, du?: string, git?: string}} deps */
function createGc({ store, tbHome = process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), now = () => Date.now(), du = '/usr/bin/du', git = '/usr/bin/git' }) {
  // Entries of dir that are not symlinks: [{ name, path, dir, age_days }]. A missing or symlinked dir has none.
  async function entries(dir) {
    const out = [];
    if ((await fsp.realpath(dir).catch(() => '')) !== dir) return out; // dir is built from the real home: any difference = a link
    for (const name of await fsp.readdir(dir)) {
      const p = path.join(dir, name);
      const st = await fsp.lstat(p).catch(() => null);
      if (st && !st.isSymbolicLink()) out.push({ name, path: p, dir: st.isDirectory(), age_days: Math.floor((now() - st.mtimeMs) / DAY_MS) });
    }
    return out;
  }

  // Everything that may be deleted, sorted by id. No sizes yet.
  async function candidates() {
    const home = await fsp.realpath(tbHome).catch(() => '');
    if (!home) return [];
    const byId = new Map(store.listTickets().map((t) => [t.id, t]));
    const items = [];
    const gone = (name) => fsp.lstat(path.join(home, 'tickets', name)).then(() => false, (e) => e.code === 'ENOENT'); // any other failure counts as there
    const trees = (await entries(path.join(home, 'worktrees'))).filter((e) => e.dir && (!byId.has(e.name) || CLOSED.includes(byId.get(e.name).state)));
    items.push(...await Promise.all(trees.map(async (e) => {
      const t = byId.get(e.name);
      const missing = !t && (await gone(e.name));
      const kept = own(t) && Number.isInteger(t.task.kept) && t.task.kept > 0 ? ` · ${t.task.kept} file${t.task.kept === 1 ? '' : 's'} not committed` : '';
      const reason = t ? `ticket ${t.state}${kept}` : missing ? 'ticket missing' : UNREADABLE;
      // no ticket: gc never trusts the folder's agent-reachable .git file to find the repo, so it says how
      return { id: `worktree/${e.name}`, kind: 'worktree', path: e.path, age_days: e.age_days, reason, ...(missing && { hint: MISSING(e.path) }),
        ...(t?.clone && !t.clone.real && { [PIN]: t }), ...(own(t) && { [TREE]: t }) };
    })));
    for (const tk of await entries(path.join(home, 'tickets'))) {
      if (!tk.dir) continue;
      for (const e of await entries(path.join(tk.path, 'runs'))) {
        if (e.age_days >= LOG_DAYS) items.push({ id: `log/${tk.name}/runs/${e.name}`, kind: 'log', path: e.path, age_days: e.age_days, reason: `run older than ${LOG_DAYS} days` });
      }
    }
    for (const e of await entries(path.join(home, 'cache'))) {
      items.push({ id: `cache/${e.name}`, kind: 'cache', path: e.path, age_days: e.age_days, reason: 'cache' });
    }
    const repos = new Map(); // common dir → its closed tickets
    for (const t of byId.values()) {
      if (CLOSED.includes(t.state) && typeof t.common_dir === 'string' && path.isAbsolute(t.common_dir)) repos.set(t.common_dir, [...(repos.get(t.common_dir) ?? []), t]);
    }
    for (const [common, ts] of repos) {
      const r = await gitIn(common, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/tb', 'refs/tb']);
      if (r.err) continue;
      const shas = new Map(r.stdout.split('\n').filter(Boolean).map((l) => /** @type {[string, string]} */ (l.split(' '))));
      const names = [...shas.keys()];
      for (const t of ts) {
        const age = Math.floor((now() - Date.parse(t.updated_at)) / DAY_MS);
        const base = { common, age_days: Number.isFinite(age) ? age : null };
        const refs = names.filter((n) => n.startsWith(`refs/tb/${t.id}/`) && REF_RE.test(n) && !n.includes('..'));
        if (refs.length) items.push({ id: `refs/${t.id}`, kind: 'refs', refs, ...base, reason: `ticket ${t.state} · ${refs.length} ref${refs.length === 1 ? '' : 's'}` });
        const task = t.kind === 'task'; // design section 6 + Decided defaults: every Task ticket's tb/<id>, My Folder too
        if (t.state !== 'cancelled' && !task) continue; // code tickets: cancelled only; a Task: done too
        for (const n of names) {
          const branch = n.slice('refs/heads/'.length);
          const mine = task ? n === `refs/heads/tb/${t.id}` : n.startsWith(`refs/heads/tb/${t.id}-`);
          if (mine && BRANCH_RE.test(branch) && SHA_RE.test(shas.get(n) ?? '')) items.push({ id: `branch/${branch}`, kind: 'branch', branch, sha: shas.get(n), ...base, reason: `ticket ${t.state}` });
        }
      }
    }
    return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // git on a repo's common dir (never inside a worktree: S1), GIT_SAFE + GIT_ENV, a minimal env.
  const gitIn = (common, args, input = undefined) => sh(git, [...GIT_SAFE, '--git-dir', common, ...args], { env: gitEnv(), timeout: 120_000, ...(input !== undefined && { input }) });
  // Commits on the branch that no other (non-tb) branch has: what a delete loses. null: git failed.
  async function unmerged(i) {
    const r = await gitIn(i.common, ['rev-list', '--count', `refs/heads/${i.branch}`, '--not', '--exclude=tb/*', '--branches']);
    return r.err || !/^\d+$/.test(r.stdout.trim()) ? null : Number(r.stdout.trim());
  }

  // C-L6 (H2.3): the commits a clone holds that no ref of the tag repo reaches (its agent's, never fetched back by a gate):
  // what deleting the worktree loses. git in the clone only through its pin (util.git: config hash, alternates); null:
  // refused or failed.
  async function cloneOnly(t) {
    const r = await pinned(t.worktree, ['rev-list', '--count', 'HEAD', '--branches', '--not', '--alternate-refs'], { dirs: t, timeout: 120_000 });
    return r.err || !/^\d+$/.test(r.stdout.trim()) ? null : Number(r.stdout.trim());
  }

  async function size(p) {
    const r = await sh(du, ['-sk', p], { timeout: 120_000 });
    const kb = /^(\d+)/.exec(r.stdout)?.[1];
    return kb === undefined ? null : Number(kb) * 1024;
  }

  // GET: one page (default 20, max 100) after the cursor id; only the page is sized.
  async function list(q = {}) {
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit must be a number from 1 to 100');
    const all = await candidates();
    const rest = q.after ? all.filter((i) => i.id > q.after) : all;
    const items = rest.slice(0, limit);
    await pmap(items, DU_PARALLEL, async (i) => {
      i.bytes = i.path ? await size(i.path) : null;
      if (i.kind === 'branch') {
        i.unmerged = await unmerged(i);
        i.reason += ` · ${i.unmerged ?? '?'} unmerged commit${i.unmerged === 1 ? '' : 's'}`;
      }
      if (i[PIN]) {
        i.clone_only = await cloneOnly(i[PIN]);
        i.reason += ` · ${i.clone_only ?? '?'} commit${i.clone_only === 1 ? '' : 's'} only in its clone`;
      }
    });
    return { items, total: all.length, next: rest.length > limit ? items[limit - 1].id : null };
  }

  const gitEnv = () => ({ ...minimalEnv(process.env), ...GIT_ENV });

  const lastLine = (/** @type {any} */ r) => String(r.stderr || r.err.message).trim().split('\n').pop().slice(0, 200);
  // One line of the delete record (D-0238): one small O_APPEND write (parallel deletes never mix lines, no
  // read-modify-write), never through a link. Throws: then no delete. ponytail: never pruned (~120 bytes per deleted
  // branch); upgrade path: drop lines whose common has no open Task.
  const record = async (/** @type {object} */ line) => fsp.appendFile(path.join(await fsp.realpath(tbHome), RECORD), JSON.stringify(line) + '\n', { mode: 0o600, flag: APPEND });
  // The branches in use in any worktree of a repo, once per repo per delete: checked out (`worktree list` reads <common>
  // only), or under a rebase or bisect, which shows as detached there (`branch -D` refused those too): the head-name /
  // BISECT_START of <common> and of each <common>/worktrees/*. Plain files only (lstat, no link, no FIFO); a missing one
  // is skipped. The agent can write the worktree copies: a planted name can only refuse a delete. null: git failed.
  async function readHead(/** @type {string} */ f) {
    if (!(await fsp.lstat(f).then((st) => st.isFile(), () => false))) return null;
    const v = (await readPlain(f, 4096))?.trim();
    return !v || SHA_RE.test(v) ? null : v.startsWith('refs/') ? v : `refs/heads/${v}`; // BISECT_START: a short name or a sha
  }
  async function inUse(/** @type {string} */ common) {
    const r = await gitIn(common, ['worktree', 'list', '--porcelain', '-z']);
    if (r.err) return null;
    const out = new Set(r.stdout.split('\0').filter((x) => x.startsWith('branch ')).map((x) => x.slice('branch '.length)));
    const wts = path.join(common, 'worktrees');
    const dirs = [common, ...(await fsp.readdir(wts).catch(() => [])).map((n) => path.join(wts, n))];
    for (const v of await Promise.all(dirs.flatMap((d) => HEAD_FILES.map((f) => readHead(path.join(d, f)))))) if (v) out.add(v);
    return out;
  }
  async function checkedOut(/** @type {string} */ common, /** @type {Map<string, Promise<Set<string> | null>>} */ seen) {
    if (!seen.has(common)) seen.set(common, inUse(common));
    return seen.get(common);
  }
  // design section 6 (round 1 review): two deletes of one branch at once (two POST /api/gc; tb gc goes through tbd too)
  // must not both write a line: the second's failed update-ref would write sha null and Block every open Task. Keyed
  // `${common}\0${ref}`, held around the record + update-ref. A later call lists fresh (remove → candidates), so a gone
  // branch is "not in the current gc list" then. ponytail: in-process only (one tbd per TB_HOME).
  const deleting = new Set();

  async function destroy(item, { seen = new Map(), free = undefined } = {}) {
    if (item.kind === 'branch') {
      const ref = `refs/heads/${item.branch}`;
      const key = `${item.common}\0${ref}`;
      if (deleting.has(key)) throw new Error('already being deleted');
      deleting.add(key);
      try {
        const out = await checkedOut(item.common, seen);
        if (!out) throw new Error('git worktree list failed');
        if (out.has(ref)) throw new Error(`${item.branch} is checked out in a worktree (or a rebase or bisect is on it): remove that first`);
        await record({ common: item.common, ref, sha: item.sha }).catch((e) => { throw new Error(`the delete was not written down (${e.code ?? e.message}): not deleted`); });
        const r = await gitIn(item.common, ['update-ref', '-d', ref, item.sha]); // the old-value form: only the branch gc listed
        if (r.err) {
          // moved since the listing: the line above names a delete that did not happen; a newer line without a sha cancels it
          await record({ common: item.common, ref, sha: null }).catch((e) => console.error(`tbd: gc: ${ref} not written down as kept: ${e.message}`));
          throw new Error(lastLine(r));
        }
      } finally {
        deleting.delete(key);
      }
      return;
    }
    if (item.kind === 'refs') {
      const r = await gitIn(item.common, ['update-ref', '--stdin'], item.refs.map((x) => `delete ${x}\n`).join(''));
      if (r.err) throw new Error(lastLine(r));
      return;
    }
    if ((await fsp.lstat(item.path)).isSymbolicLink()) throw new Error('is a symlink');
    const t = item[TREE];
    if (t) {
      // design 3h, D-0239: removed only once its run is over (no live lease, no recovery still stopping it, and no
      // Continue in Terminal session still on it: runner.terminalFree), so no run process walks it meanwhile
      if (t.lease && (!t.lease.exit || t.lease.pending)) throw new Error('its run is still live: try again once it ended');
      if (t.lease?.exit === 'held') {
        if (!free) throw new Error('held for your terminal: Hand Back or Done first');
        await free(t.id);
      }
      // the exact git folder first, then the folder; the branch stays (its own row). A crash mid-add saved no fields: the
      // add's own paths (untree checks each)
      const g = typeof t.task.repo === 'string' ? path.join(t.task.repo, '.git') : undefined;
      await require('./task').untree({ ...t, worktree: item.path, git_dir: t.git_dir ?? (g && path.join(g, 'worktrees', t.id)), common_dir: t.common_dir ?? g });
      return;
    }
    // S1: git never runs inside the worktree (an agent may have rewritten its .git link or its commondir: a planted
    // filter or fsmonitor would run as Irfan). The dir goes, then the owning repo prunes its entry from the common dir
    // assign recorded; no record (no ticket) → that entry stays, `git worktree list` shows it prunable.
    let common = null;
    if (item.kind === 'worktree') common = store.listTickets().find((t) => t.id === path.basename(item.path))?.common_dir ?? null;
    await fsp.rm(item.path, { recursive: true, force: true });
    if (typeof common === 'string' && path.isAbsolute(common)) await gitIn(common, ['worktree', 'prune']);
  }

  // POST { ids }: only ids in a freshly computed list are deleted; the rest come back as skipped.
  // free(id): runner.terminalFree (http passes it), throws when his terminal still runs a held Task's session
  async function remove(body, { free = undefined } = {}) {
    if (!isObj(body) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || !body.ids.every((s) => typeof s === 'string')) {
      throw bad('ids must be a list of 1-100 ids from `tb gc`');
    }
    const fresh = new Map((await candidates()).map((i) => [i.id, i]));
    const deleted = [];
    const skipped = [];
    const todo = [];
    for (const id of new Set(body.ids)) {
      const item = fresh.get(id);
      if (!item) skipped.push({ id, reason: 'not in the current gc list' });
      else if (item.reason === UNREADABLE) skipped.push({ id, reason: UNREADABLE });
      else todo.push(item);
    }
    todo.sort((a, b) => Number(a.kind === 'branch') - Number(b.kind === 'branch')); // branches last: their worktree goes first
    const bytes = await pmap(todo, DU_PARALLEL, (item) => (item.path ? size(item.path) : null));
    const seen = new Map(); // repo → its checked-out branches, read at the first branch (after the worktrees went)
    for (const [n, item] of todo.entries()) {
      try {
        await destroy(item, { seen, free });
        deleted.push({ id: item.id, bytes: bytes[n] });
      } catch (e) {
        skipped.push({ id: item.id, reason: e.message });
      }
    }
    return { deleted, skipped };
  }

  return { list, remove };
}

// The daemon's instance; tests build their own with createGc.
module.exports = { createGc, ...createGc({ store: require('./store') }) };
