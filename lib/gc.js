'use strict';
// gc: what `tb gc` can free (plan AC12): worktrees of done / cancelled / missing tickets, run logs older than
// 30 days, cache entries. Everything lives under TB_HOME/{worktrees,tickets,cache}; any other path (a symlink,
// a crafted id, ~/taskboard-live, the dev checkout) is never listed and never touched. Async only (D31).
// P5 (contract R1 M13): + git refs in the repo a ticket recorded (common_dir, S1; git runs on that dir only, never in a
// worktree): branches tb/<id>-<slug> of cancelled tickets (name checked, the preview counts the commits no other branch
// has: unmerged) and refs/tb/<id>/* (attempts, replan snapshots) of done / cancelled ones. One for-each-ref per repo.
// C-L6: a clone ticket's worktree row counts the commits only its clone holds (clone_only; git in the clone only
// through its pin, util.git H2.2).
// Deleted only as confirmed ids of a fresh list: `branch -D -- <name>` after the worktrees went (a checked-out branch
// cannot go), refs through one `update-ref --stdin`.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, minimalEnv, GIT_SAFE, GIT_ENV, git: pinned } = require('./util');

const DAY_MS = 86_400_000;
const LOG_DAYS = 30;
const CLOSED = ['done', 'cancelled'];
const DU_PARALLEL = 4;
const UNREADABLE = 'ticket unreadable'; // its dir exists but the store could not load it: never "missing"
const BRANCH_RE = /^tb\/t_[a-z0-9]+-[a-z0-9-]+$/;
const REF_RE = /^refs\/tb\/t_[a-z0-9]+\/[A-Za-z0-9@_-][A-Za-z0-9@._/-]{0,200}$/;
const bad = (msg) => new TbError(400, msg);
const PIN = Symbol('pin'); // a clone worktree row's ticket (C-L6), never in the JSON

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
      const reason = t ? `ticket ${t.state}` : (await gone(e.name)) ? 'ticket missing' : UNREADABLE;
      return { id: `worktree/${e.name}`, kind: 'worktree', path: e.path, age_days: e.age_days, reason, ...(t?.clone && { [PIN]: t }) };
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
      const r = await gitIn(common, ['for-each-ref', '--format=%(refname)', 'refs/heads/tb', 'refs/tb']);
      if (r.err) continue;
      const names = r.stdout.split('\n').filter(Boolean);
      for (const t of ts) {
        const age = Math.floor((now() - Date.parse(t.updated_at)) / DAY_MS);
        const base = { common, age_days: Number.isFinite(age) ? age : null };
        const refs = names.filter((n) => n.startsWith(`refs/tb/${t.id}/`) && REF_RE.test(n) && !n.includes('..'));
        if (refs.length) items.push({ id: `refs/${t.id}`, kind: 'refs', refs, ...base, reason: `ticket ${t.state} · ${refs.length} ref${refs.length === 1 ? '' : 's'}` });
        if (t.state !== 'cancelled') continue;
        for (const n of names) {
          const branch = n.slice('refs/heads/'.length);
          if (n.startsWith(`refs/heads/tb/${t.id}-`) && BRANCH_RE.test(branch)) items.push({ id: `branch/${branch}`, kind: 'branch', branch, ...base, reason: `ticket ${t.state}` });
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

  async function destroy(item) {
    if (item.kind === 'branch' || item.kind === 'refs') {
      const r = item.kind === 'branch' ? await gitIn(item.common, ['branch', '-D', '--', item.branch])
        : await gitIn(item.common, ['update-ref', '--stdin'], item.refs.map((x) => `delete ${x}\n`).join(''));
      if (r.err) throw new Error(String(r.stderr || r.err.message).trim().split('\n').pop().slice(0, 200));
      return;
    }
    if ((await fsp.lstat(item.path)).isSymbolicLink()) throw new Error('is a symlink');
    // S1: git never runs inside the worktree (an agent may have rewritten its .git link or its commondir: a planted
    // filter or fsmonitor would run as Irfan). The dir goes, then the owning repo prunes its entry from the common dir
    // assign recorded; no record (no ticket) → that entry stays, `git worktree list` shows it prunable.
    let common = null;
    if (item.kind === 'worktree') common = store.listTickets().find((t) => t.id === path.basename(item.path))?.common_dir ?? null;
    await fsp.rm(item.path, { recursive: true, force: true });
    if (typeof common === 'string' && path.isAbsolute(common)) await gitIn(common, ['worktree', 'prune']);
  }

  // POST { ids }: only ids in a freshly computed list are deleted; the rest come back as skipped.
  async function remove(body) {
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
    for (const [n, item] of todo.entries()) {
      try {
        await destroy(item);
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
