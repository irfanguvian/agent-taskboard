'use strict';
// task-actions (board-terminal-parity Phase 4, contract section 5, Lane B): a Task ticket's own actions on routes that
// already exist — Done (POST …/close) and Commit and Push (POST …/push) — and grantOk, the gate every Task push from
// tb-git passes (lib/approvals.js ask): the folder check (S1), a leak scan (fail closed), then Commit and Push's
// single-use grant (no card) or a normal card. Every guard is re-checked inside the one write (first write wins: a second
// click gets 409). Agent-made names (files, branch) stay data: argv only, never a shell.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { TbError } = require('./errors');
const store = require('./store');
const fsm = require('./fsm');
const { git, SHA_RE, realConfig } = require('./util');

const T = () => require('./task'); // lazy: task ↔ planning ↔ spawn
const iso = () => new Date().toISOString();
const last = (/** @type {string} */ s) => String(s ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';

// The guards Done and Commit and Push share: a Task, working, waiting for Irfan, its run over
function ready(/** @type {any} */ k, /** @type {string} */ id) {
  if (k.kind !== 'task') throw new TbError(409, `${id}: not a Task ticket`);
  if (k.state !== 'working' || k.waiting?.reason !== 'you') throw new TbError(409, `${id}: it does not wait for you (now ${k.state}${k.waiting ? ` waiting ${k.waiting.reason}` : ''})`);
  if (k.lease && !k.lease.exit) throw new TbError(409, `${id}: a run is live`);
}

// security review MED 6: a rebase todo the agent left (exec lines) runs as Irfan on his `git rebase --continue`
async function rebasing(/** @type {any} */ t) {
  if (typeof t.git_dir !== 'string') return null;
  for (const d of ['rebase-merge', 'rebase-apply']) if (await fsp.lstat(path.join(t.git_dir, d)).then(() => true, () => false)) return `a rebase is in progress in ${t.git_dir} (${d}): finish or abort it in your terminal first`;
  return null;
}

// security review MED 4: tracked files whose content is not HEAD's but `git status` shows clean (a forged index stat
// cache hides an edit from Irfan's review: D-0107's contentDirty, stat-free) → their paths
async function hidden(/** @type {any} */ t) {
  if (typeof t.git_dir !== 'string') return [];
  const sp = require('./spawn');
  const [a, b] = await Promise.all([sp.dirtyPaths(t), sp.contentDirty(t)]);
  const seen = new Set(a.map((l) => l.slice(3)));
  return b.map((l) => l.slice(3)).filter((p) => !seen.has(p) && path.basename(p) !== '.DS_Store'); // Finder's, dirtyPaths skips it too
}

// The folder check (S1, lib/task.js) + hidden edits: anything changed → the ticket Blocked (with the undo steps) and
// 409; a rebase in progress → 409 only
async function checked(/** @type {any} */ t) {
  const reb = await rebasing(t);
  if (reb) throw new TbError(409, `${t.id}: ${reb}`);
  const r = await T().check(t);
  const h = r.length ? [] : await hidden(t);
  if (h.length) r.push(`files hidden from git status (their index entry was forged): ${h.slice(0, 10).join(', ')}: undo: git update-index --really-refresh, then look at git diff`);
  if (!r.length) return;
  await T().block(t.id, r);
  throw new TbError(409, T().why(r));
}

// Done: the folder checked, then done in one intervention (no grant left behind)
async function done(/** @type {string} */ id, /** @type {string} */ actor) {
  const t = store.getTicket(id);
  ready(t, id);
  await checked(t);
  return store.intervention(id, { actor, verb: 'close' }, (k) => {
    ready(k, id);
    const n = fsm.move(k, 'done', 'you', { task_done: () => true });
    delete n.push_grant;
    return n;
  });
}

// what Irfan saw on the card is what is committed: the fields that decide it (ahead is display only)
const shown = (/** @type {any} */ p) => JSON.stringify([p?.branch, p?.remote, p?.new_branch, p?.files, p?.left]);

// Commit and Push (Irfan round 2 C): the folder checked; the files the Task changed, as the card showed them (else the
// fresh list is written and 409: look again); then in one intervention the branch switch (tb/<id> when new: created or
// switched to; uncommitted files go along), HEAD read, and the same session resumed with "commit these files … and push"
// plus a grant for exactly that push (bound to the next run's gen at its start, lib/runner.js)
async function commitPush(/** @type {string} */ id, /** @type {string} */ actor) {
  const t = store.getTicket(id);
  ready(t, id);
  if (store.config.terminal?.git_bridge !== true) throw new TbError(409, `${id}: the git bridge is off (Settings → Terminal): commit and push from your terminal`);
  const want = t.task_result?.push_to;
  if (!want) throw new TbError(409, `${id}: ${t.task_result?.push_why ?? 'nothing to commit and push'}`);
  await checked(t);
  const now = await T().pushTo(t, store.listTags()[t.tag]);
  if (shown(now?.push_to) !== shown(want)) {
    await store.updateTicket(id, (k) => {
      ready(k, id);
      const r = { ...k.task_result, push_to: now?.push_to ?? null };
      if (now?.push_why) r.push_why = now.push_why;
      else delete r.push_why;
      return { ...k, task_result: r };
    });
    throw new TbError(409, `${id}: the files changed since the result: look again`);
  }
  const { remote, branch, files } = want;
  await store.intervention(id, { actor, verb: 'push', payload: { remote, branch, files } }, async (k) => {
    ready(k, id);
    if (shown(k.task_result?.push_to) !== shown(want)) throw new TbError(409, `${id}: the result changed meanwhile: look again`);
    const g = (/** @type {string[]} */ args) => git(k.worktree, args, { dirs: k });
    if (want.new_branch && (await g(['symbolic-ref', '-q', 'HEAD'])).stdout.trim() !== `refs/heads/${branch}`) {
      const has = !(await g(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).err;
      const sw = await g(has ? ['switch', branch] : ['switch', '-c', branch]);
      if (sw.err) throw new TbError(409, `${id}: could not switch to ${branch}: ${last(sw.stderr)}`);
    }
    const h = await g(['rev-parse', '--verify', 'HEAD']);
    const head = h.stdout.trim();
    if (h.err || !SHA_RE.test(head)) throw new TbError(409, `${id}: no HEAD commit to start from`);
    const at = iso();
    const text = `commit these files to ${branch} and push to ${remote}: ${JSON.stringify(files)}`; // names as data
    return { ...T().resume({ ...k, notes: [...(k.notes ?? []), { at, text }] }, 'commit'), push_grant: { remote, branch, at, gen: null, head, files } };
  });
  return { id, op: 'commit-push', accepted: true, task: true, branch, remote, files };
}

// A remote's push URLs (pushurl, else url) from the folder's own config file (util.realConfig: --file, no includes, no
// repo discovery; its pin checked first by check())
async function pushUrls(/** @type {any} */ t, /** @type {string} */ remote) {
  const cfg = (await realConfig(t.git_dir)) ?? [];
  const get = (/** @type {string} */ key) => cfg.filter((e) => e.startsWith(`${key}\n`)).map((e) => e.slice(key.length + 1));
  const push = get(`remote.${remote}.pushurl`); // git lowercases the section and key, never the remote's name
  return push.length ? push : get(`remote.${remote}.url`);
}

// Every Task push (tb-git → approve.ask): 1 the folder check; 2 the leak scan of <sha> --not <the remote's tips> (the
// commits already on the branch too), before any card (round 2 MED 2); 3 the grant: same gen, remote and branch; 4 the
// push starts at the grant's HEAD and touches only its files (else a card: Irfan decides); 5 the grant taken in one CAS.
// → 'allow' | 'card' | {deny: why}; any failure denies (fail closed) and alerts.
async function grantOk(/** @type {any} */ t, /** @type {{gen: number, remote?: string, branch?: string, sha: string}} */ { gen, remote, branch, sha }, /** @type {Function} */ alert = () => {}) {
  const deny = (/** @type {string} */ why) => {
    alert({ title: 'Push refused', message: `${t.id}: ${why}`.slice(0, 500) });
    return { deny: why };
  };
  try {
    if (typeof remote !== 'string' || typeof branch !== 'string' || !SHA_RE.test(sha)) return deny('a Task push names its remote, branch and commit');
    const reb = await rebasing(t);
    if (reb) return deny(reb);
    const r = await T().check(t);
    if (r.length) {
      await T().block(t.id, r);
      return deny(T().why(r));
    }
    const urls = await pushUrls(t, remote);
    if (!urls.length) return deny(`no URL for remote ${remote}`);
    const s = await require('./push').leakScan({ cwd: t.common_dir, sha, urls, branch, tag: store.listTags()[t.tag], protocols: 'ssh:https',
      add: process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {} });
    if (!s.ok) return deny(`${s.why}: ${s.msg}`);
    const g = t.push_grant;
    if (!g || g.gen !== gen || g.remote !== remote || g.branch !== branch || !SHA_RE.test(g.head ?? '')) return 'card';
    if ((await git(t.worktree, ['merge-base', '--is-ancestor', g.head, sha], { dirs: t })).err) return 'card';
    // security review HIGH 2: every commit the push sends that is newer than the start point (the agent's, also on the
    // start branch or a tb/<id> it made itself), not only those after the grant's HEAD; "on the remote" = the tips
    // ls-remote reported (leakScan), never refs/remotes (re-check HIGH: the agent writes those). stdin: tips can be many
    if (!SHA_RE.test(t.base_sha ?? '')) return 'card';
    const not = [t.base_sha, ...(Array.isArray(s.tips) ? s.tips : [])].filter((x) => SHA_RE.test(x)).map((x) => `^${x}`);
    const log = await git(t.worktree, ['log', '--no-renames', '--diff-merges=first-parent', '--format=', '--name-only', '-z', '--stdin'], { dirs: t, input: [sha, ...not].join('\n') + '\n' });
    if (log.err) return 'card';
    const mine = new Set(g.files);
    if (log.stdout.split('\0').map((x) => x.trim()).filter(Boolean).some((f) => !mine.has(f))) return 'card'; // more than the Task's files
    let took = false;
    await store.updateTicket(t.id, (k) => {
      if (JSON.stringify(k.push_grant) !== JSON.stringify(g)) return k; // used or replaced meanwhile: a card
      took = true;
      const n = { ...k };
      delete n.push_grant;
      return n;
    });
    return took ? 'allow' : 'card';
  } catch (e) {
    return deny(`the push check failed: ${/** @type {any} */ (e).message}`);
  }
}

module.exports = { done, commitPush, grantOk };
