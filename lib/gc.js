'use strict';
// gc: what `tb gc` can free (plan AC12): worktrees of done / cancelled / missing tickets, run logs older than
// 30 days, cache entries. Everything lives under TB_HOME/{worktrees,tickets,cache}; any other path (a symlink,
// a crafted id, ~/taskboard-live, the dev checkout) is never listed and never touched. Async only (D31).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sh = require('./sh');
const { TbError } = require('./errors');
const { isObj, minimalEnv, GIT_SAFE, GIT_ENV } = require('./util');

const DAY_MS = 86_400_000;
const LOG_DAYS = 30;
const CLOSED = ['done', 'cancelled'];
const DU_PARALLEL = 4;
const UNREADABLE = 'ticket unreadable'; // its dir exists but the store could not load it: never "missing"
const bad = (msg) => new TbError(400, msg);

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
      return { id: `worktree/${e.name}`, kind: 'worktree', path: e.path, age_days: e.age_days, reason };
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
    return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
    await pmap(items, DU_PARALLEL, async (i) => { i.bytes = await size(i.path); });
    return { items, total: all.length, next: rest.length > limit ? items[limit - 1].id : null };
  }

  const gitEnv = () => ({ ...minimalEnv(process.env), ...GIT_ENV });

  async function destroy(item) {
    if ((await fsp.lstat(item.path)).isSymbolicLink()) throw new Error('is a symlink');
    if (item.kind === 'worktree') {
      // from the owning repo, so its worktree list forgets it; a broken link just falls through to the rm
      const common = await sh(git, [...GIT_SAFE, '-C', item.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env: gitEnv(), timeout: 20_000 });
      if (!common.err) await sh(git, [...GIT_SAFE, '--git-dir', common.stdout.trim(), 'worktree', 'remove', '--force', item.path], { env: gitEnv(), timeout: 120_000 });
    }
    await fsp.rm(item.path, { recursive: true, force: true });
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
    const bytes = await pmap(todo, DU_PARALLEL, (item) => size(item.path));
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
