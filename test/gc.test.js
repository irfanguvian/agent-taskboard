'use strict';
// P2 AC12: tb gc (lib/gc.js). Unit tests drive createGc against a fake TB_HOME with real git worktrees of a temp "dev"
// repo (which also has a "live" worktree standing in for ~/taskboard-live); the e2e block runs a real tbd + tb on a
// temp HOME + TB_HOME. Nothing outside the temp dirs is read or written.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGc } = require('../lib/gc');
const { GIT_SAFE } = require('../lib/util');
const { startTbd, runTb } = require('./helpers/tbd');

const DAY = 86_400_000;
const is400 = (e) => e?.status === 400;
const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const put = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const ago = (p, days) => {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
};

// Temp world: dev repo + live worktree + a victim file outside TB_HOME; TB_HOME with worktrees, run logs and cache.
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')));
  roots.push(root);
  const dev = path.join(root, 'dev');
  const live = path.join(root, 'live');
  const tbHome = path.join(root, 'tbhome');
  put(path.join(dev, 'README'), 'dev\n');
  git(dev, 'init', '-q', '-b', 'main');
  git(dev, 'add', '-A');
  git(dev, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', '--detach', live);
  const wt = (id) => git(dev, 'worktree', 'add', '-q', '--detach', path.join(tbHome, 'worktrees', id));
  fs.mkdirSync(path.join(tbHome, 'worktrees'), { recursive: true });
  for (const id of ['t_done01', 't_canc01', 't_orph01', 't_work01']) wt(id);
  put(path.join(tbHome, 'worktrees', 't_plain1', 'file'), 'plain dir, no git');
  put(path.join(tbHome, 'worktrees', 'notes.txt'), 'a file is not a worktree');
  fs.symlinkSync(live, path.join(tbHome, 'worktrees', 't_link01'));
  for (const [id, run, days] of /** @type {[string, string, number][]} */ ([['t_done01', 'old', 40], ['t_done01', 'new', 1], ['t_work01', 'older', 31], ['t_work01', 'edge', 29]])) {
    put(path.join(tbHome, 'tickets', id, 'runs', run, 'stream.jsonl'), 'x'.repeat(2000));
    ago(path.join(tbHome, 'tickets', id, 'runs', run), days);
  }
  put(path.join(tbHome, 'cache', 'a', 'blob'), 'x'.repeat(5000));
  put(path.join(tbHome, 'cache', 'b.txt'), 'cached');
  fs.symlinkSync(live, path.join(tbHome, 'cache', 'link'));
  put(path.join(root, 'victim', 'keep'), 'do not touch');
  const common = fs.realpathSync(path.join(dev, '.git')); // assign records it (S1); gc prunes from it, never runs git in a worktree
  const tickets = [{ id: 't_done01', state: 'done', common_dir: common }, { id: 't_canc01', state: 'cancelled', common_dir: common }, { id: 't_work01', state: 'working', common_dir: common }];
  const gc = createGc({ store: { listTickets: () => tickets }, tbHome });
  return {
    root, dev, live, tbHome, tickets, gc,
    ids: async () => (await gc.list({ limit: 100 })).items.map((i) => i.id),
    listed: () => git(dev, 'worktree', 'list', '--porcelain'),
    intact: () => ['dev/README', 'live/README', 'victim/keep', 'tbhome/worktrees/t_work01/README'].every((f) => fs.existsSync(path.join(root, f))),
  };
}

describe('list', () => {
  test('worktrees of done / cancelled / missing tickets, run logs over 30 days and cache entries, with size, age and reason', async () => {
    const w = world();
    const { items, total, next } = await w.gc.list();
    assert.deepEqual(items.map((i) => [i.id, i.kind, i.reason]), [
      ['cache/a', 'cache', 'cache'],
      ['cache/b.txt', 'cache', 'cache'],
      ['log/t_done01/runs/old', 'log', 'run older than 30 days'],
      ['log/t_work01/runs/older', 'log', 'run older than 30 days'],
      ['worktree/t_canc01', 'worktree', 'ticket cancelled'],
      ['worktree/t_done01', 'worktree', 'ticket done'],
      ['worktree/t_orph01', 'worktree', 'ticket missing'],
      ['worktree/t_plain1', 'worktree', 'ticket missing'],
    ]);
    assert.equal(total, 8);
    assert.equal(next, null);
    for (const i of items) assert.ok(i.path.startsWith(w.tbHome + path.sep) && i.bytes > 0 && Number.isInteger(i.age_days), JSON.stringify(i));
    assert.equal(items[0].bytes >= 5000, true, 'du counts the files inside');
    assert.equal(items.find((i) => i.id === 'log/t_done01/runs/old').age_days, 40);
    assert.equal(w.intact(), true);
  });

  test('never lists: an active ticket, a fresh run log, a symlink, a plain file, ~/taskboard-live or the dev checkout', async () => {
    const w = world();
    const ids = await w.ids();
    for (const no of ['worktree/t_work01', 'worktree/t_link01', 'worktree/notes.txt', 'log/t_done01/runs/new', 'log/t_work01/runs/edge', 'cache/link']) {
      assert.ok(!ids.includes(no), `${no} must not be listed`);
    }
    const paths = (await w.gc.list({ limit: 100 })).items.map((i) => i.path);
    assert.ok(!paths.some((p) => p === w.live || p === w.dev || !p.startsWith(w.tbHome + path.sep)));
  });

  test('H1 a worktree whose ticket dir exists but did not load is "ticket unreadable", never "missing": listed, and refused on delete', async () => {
    const w = world();
    git(w.dev, 'worktree', 'add', '-q', '--detach', path.join(w.tbHome, 'worktrees', 't_bad001'));
    put(path.join(w.tbHome, 'tickets', 't_bad001', 'ticket.json'), '{ torn json'); // the store skipped it: not in listTickets
    const { items } = await w.gc.list({ limit: 100 });
    assert.equal(items.find((i) => i.id === 'worktree/t_bad001').reason, 'ticket unreadable');
    assert.equal(items.find((i) => i.id === 'worktree/t_orph01').reason, 'ticket missing', 'no ticket dir at all is still missing');

    const r = await w.gc.remove({ ids: ['worktree/t_bad001', 'worktree/t_orph01'] });
    assert.deepEqual(r.deleted.map((d) => d.id), ['worktree/t_orph01']);
    assert.deepEqual(r.skipped, [{ id: 'worktree/t_bad001', reason: 'ticket unreadable' }]);
    assert.ok(fs.existsSync(path.join(w.tbHome, 'worktrees', 't_bad001', 'README')), 'worktree kept');
    assert.ok(w.listed().includes('t_bad001'), 'and git still knows it');
  });

  test('H8 du and git run as /usr/bin/du and /usr/bin/git: ones earlier on PATH are never executed', async () => {
    const w = world();
    const bin = path.join(w.root, 'evil-bin');
    const ran = path.join(w.root, 'evil-ran');
    fs.mkdirSync(bin);
    for (const name of ['du', 'git']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    try {
      const { items } = await w.gc.list({ limit: 100 });
      assert.ok(items.every((i) => i.bytes > 0), 'sizes came from the real du');
      const r = await w.gc.remove({ ids: ['worktree/t_done01'] });
      assert.deepEqual(r.deleted.map((d) => d.id), ['worktree/t_done01']);
    } finally {
      process.env.PATH = was;
    }
    assert.ok(!w.listed().includes('t_done01'), 'pruned through the real git, which forgot the worktree');
    assert.equal(fs.existsSync(ran), false, 'nothing from PATH ran');
  });

  // Repo config that names scripts: core.fsmonitor and a reference-transaction hook, both writing a marker. Set last, so the
  // setup git calls cannot trip them.
  function armed(root, dev) {
    const marker = path.join(root, 'marker');
    const script = path.join(root, 'run-me');
    fs.writeFileSync(script, `#!/bin/sh\necho "$0" >> "${marker}"\nprintf '\\0'\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.copyFileSync(script, path.join(root, 'hooks', 'reference-transaction'));
    fs.chmodSync(path.join(root, 'hooks', 'reference-transaction'), 0o755);
    git(dev, 'config', 'core.fsmonitor', script);
    git(dev, 'config', 'core.hooksPath', path.join(root, 'hooks'));
    fs.rmSync(marker, { force: true });
    return marker;
  }

  test('H11 the flags do switch off what a repo config names (control: git status runs the script without them, not with them)', () => {
    const w = world();
    const marker = armed(w.root, w.dev);
    git(w.live, 'status', '--short');
    assert.ok(fs.existsSync(marker), 'control: the planted fsmonitor runs on a plain git status');
    fs.rmSync(marker);
    git(w.live, ...GIT_SAFE, 'status', '--short');
    assert.equal(fs.existsSync(marker), false);
  });

  test('H11 gc git calls: -c core.fsmonitor=false -c core.hooksPath=/dev/null first, GIT_CONFIG_GLOBAL / SYSTEM off, minimal env; a repo config naming scripts runs none', async () => {
    const w = world();
    const log = path.join(w.root, 'git-calls');
    const rec = path.join(w.root, 'git-rec');
    fs.writeFileSync(rec, `#!/bin/sh\n{ echo "ARGV $*"; /usr/bin/env | sed 's/^/ENV /'; } >> "${log}"\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const marker = armed(w.root, w.dev);
    const gc = createGc({ store: { listTickets: () => w.tickets }, tbHome: w.tbHome, git: rec });
    const was = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'gh-secret';
    try {
      assert.ok((await gc.list({ limit: 100 })).items.length > 0);
      const r = await gc.remove({ ids: ['worktree/t_done01', 'worktree/t_canc01', 'worktree/t_orph01'] });
      assert.equal(r.deleted.length, 3, JSON.stringify(r.skipped));
    } finally {
      if (was === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = was;
    }
    const calls = fs.readFileSync(log, 'utf8').split('ARGV ').slice(1);
    // S1 (P4 security review; was rev-parse + worktree remove run inside each worktree = 6): one prune per worktree whose
    // ticket recorded its repo (t_done01, t_canc01), from that common dir; the orphan (no ticket) gets none. P5 contract
    // change (R1 M13: gc deletes tb branches + refs/tb): + one ref list of that repo per gc list (list, and remove's fresh one)
    const ends = (c, s) => c.split('\n')[0].endsWith(s);
    const PRUNE = ' worktree prune';
    // Phase 4 contract change (design revision 6 section 6; was --format=%(refname)): each branch's sha is listed too,
    // for the delete record and the old-value delete
    const REFS = ' for-each-ref --format=%(refname) %(objectname) refs/heads/tb refs/tb';
    // security review round 1 HIGH contract change (was [2, 2, 4]: one prune per worktree with a known repo): no worktree
    // prune at all (task.untree removes exactly that entry, no git), one ref list per gc list
    assert.deepEqual([calls.filter((c) => ends(c, PRUNE)).length, calls.filter((c) => ends(c, REFS)).length, calls.length], [0, 2, 2], 'no worktree prune, one ref list per gc list');
    for (const c of calls) {
      const [argv, ...env] = c.split('\n').filter(Boolean);
      assert.ok(argv.startsWith(`${GIT_SAFE.join(' ')} `), argv);
      assert.ok((argv.endsWith(PRUNE) || argv.endsWith(REFS)) && argv.includes(`--git-dir ${w.tickets[0].common_dir}`) && !argv.includes(' -C '), `no git inside a worktree: ${argv}`);
      const keys = env.map((l) => l.slice(4, l.indexOf('=')));
      assert.deepEqual(keys.filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'HOME', 'LANG', 'PATH', 'TMPDIR'].filter((k) => keys.includes(k)), 'no GITHUB_TOKEN or other daemon variable');
      assert.ok(env.includes('ENV GIT_CONFIG_GLOBAL=/dev/null') && env.includes('ENV GIT_CONFIG_NOSYSTEM=1'));
    }
    assert.equal(fs.existsSync(marker), false, 'no script named by the repo config ran');
    assert.ok(!w.listed().includes('t_done01'), 'and the dev repo still forgot the worktree (its exact entry removed)');
  });

  test('H2 sizes are measured in parallel, at most 4 du at once, in list and in delete; results keep their order', async () => {
    const w = world();
    const dir = path.join(w.root, 'du-running');
    const log = path.join(w.root, 'du.log');
    const du = path.join(w.root, 'du-fake');
    fs.mkdirSync(dir);
    fs.writeFileSync(du, `#!/bin/sh\ntouch "${dir}/$$"\necho $(ls "${dir}" | wc -l) >> "${log}"\nsleep 0.5\nrm "${dir}/$$"\nprintf '4\\t%s\\n' "$2"\n`, { mode: 0o755 });
    const peak = () => Math.max(...fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number));
    const gc = createGc({ store: { listTickets: () => w.tickets }, tbHome: w.tbHome, du });

    const { items } = await gc.list({ limit: 100 });
    assert.equal(items.length, 8);
    assert.ok(items.every((i) => i.bytes === 4096));
    assert.equal(peak(), 4, 'list: 8 sizes, 4 at a time');

    fs.rmSync(log);
    const ids = items.map((i) => i.id).reverse();
    const r = await gc.remove({ ids });
    assert.deepEqual(r.deleted.map((d) => d.id), ids, 'deleted in the order asked');
    assert.ok(r.deleted.every((d) => d.bytes === 4096));
    assert.equal(peak(), 4, 'delete: sizes also 4 at a time');
    assert.equal(w.intact(), true);
  });

  test('pages by cursor (default 20, max 100): walking the pages yields every item once; bad limits are a 400', async () => {
    const w = world();
    const seen = [];
    let after;
    for (let n = 0; n < 10; n++) {
      const page = await w.gc.list({ limit: '3', ...(after && { after }) });
      assert.ok(page.items.length <= 3);
      seen.push(...page.items.map((i) => i.id));
      after = page.next;
      if (!after) break;
    }
    assert.deepEqual(seen, await w.ids());
    assert.equal(seen.length, 8);
    for (const limit of ['0', '101', 'x', '1.5']) await assert.rejects(() => w.gc.list({ limit }), is400, limit);
  });

  test('a missing TB_HOME or missing subdirectories list nothing; a symlinked worktrees/ dir is not followed', async () => {
    const w = world();
    assert.deepEqual((await createGc({ store: { listTickets: () => [] }, tbHome: path.join(w.root, 'nowhere') }).list()).items, []);
    const outside = path.join(w.root, 'outside');
    put(path.join(outside, 't_x', 'file'));
    fs.rmSync(path.join(w.tbHome, 'worktrees'), { recursive: true });
    fs.symlinkSync(outside, path.join(w.tbHome, 'worktrees'));
    assert.ok((await w.ids()).every((id) => !id.startsWith('worktree/')));
    const r = await w.gc.remove({ ids: ['worktree/t_x'] });
    assert.deepEqual(r.deleted, []);
    assert.ok(fs.existsSync(path.join(outside, 't_x', 'file')));
  });
});

describe('remove', () => {
  test('deletes only the confirmed ids: worktrees removed, the dev repo forgets those whose ticket recorded it (S1: prune, no git inside), logs and cache are removed', async () => {
    const w = world();
    const r = await w.gc.remove({ ids: ['worktree/t_done01', 'worktree/t_orph01', 'worktree/t_plain1', 'log/t_done01/runs/old', 'cache/a'] });
    assert.deepEqual(r.deleted.map((d) => d.id), ['worktree/t_done01', 'worktree/t_orph01', 'worktree/t_plain1', 'log/t_done01/runs/old', 'cache/a']);
    assert.ok(r.deleted.every((d) => d.bytes > 0));
    assert.deepEqual(r.skipped, []);
    for (const gone of ['worktrees/t_done01', 'worktrees/t_orph01', 'worktrees/t_plain1', 'tickets/t_done01/runs/old', 'cache/a']) {
      assert.equal(fs.existsSync(path.join(w.tbHome, gone)), false, gone);
    }
    const listed = w.listed();
    assert.ok(!listed.includes('t_done01'), 'git worktree list forgot it (pruned from the recorded common dir)');
    // S1 contract change (was: forgot too): the orphan has no ticket, so no trusted repo to prune from; its entry stays prunable
    assert.match(listed, /worktree [^\n]*t_orph01\n(?:[^\n]+\n)*?prunable/, 'orphan: entry left, marked prunable');
    assert.ok(listed.includes(`worktree ${w.live}`) && listed.includes(`worktree ${w.dev}`) && listed.includes('t_work01') && listed.includes('t_canc01'));
    assert.equal(w.intact(), true, 'live, dev, the active worktree and the victim are untouched');
    assert.ok(fs.existsSync(path.join(w.tbHome, 'cache', 'b.txt')) && fs.existsSync(path.join(w.tbHome, 'tickets', 't_done01', 'runs', 'new')), 'unlisted ids stay');
    const again = await w.gc.remove({ ids: ['worktree/t_done01'] });
    assert.deepEqual(again.skipped, [{ id: 'worktree/t_done01', reason: 'not in the current gc list' }]);
  });

  test('refuses everything outside the list: crafted ids, paths outside TB_HOME, symlinks, the live and dev trees, active tickets', async () => {
    const w = world();
    const crafted = [
      'worktree/t_work01', // exists, ticket still working
      'worktree/t_link01', // symlink to the live tree
      'worktree/../../victim', 'worktree/../victim', '../victim', 'cache/../../victim', 'cache/link', 'cache/link/README',
      'log/t_work01/runs/../../../../victim', 'log/t_done01/runs/new', 'worktree/t_done01/../t_work01',
      `worktree/${w.live}`, w.live, w.dev, w.tbHome, path.join(w.root, 'victim'), '', 'worktree/', 'worktree/notes.txt',
    ];
    const r = await w.gc.remove({ ids: crafted });
    assert.deepEqual(r.deleted, []);
    assert.equal(r.skipped.length, new Set(crafted).size);
    assert.ok(r.skipped.every((s) => s.reason === 'not in the current gc list'));
    assert.equal(w.intact(), true);
    assert.ok(fs.existsSync(path.join(w.tbHome, 'worktrees', 't_link01')) && fs.existsSync(path.join(w.tbHome, 'cache', 'link')));
    assert.ok(w.listed().includes(`worktree ${w.live}`) && w.listed().includes('t_work01'));
  });

  test('the list is recomputed on delete: a ticket that went active after `tb gc` ran keeps its worktree', async () => {
    const w = world();
    assert.ok((await w.ids()).includes('worktree/t_done01'));
    w.tickets.find((t) => t.id === 't_done01').state = 'working'; // e.g. a rework restarted it
    const r = await w.gc.remove({ ids: ['worktree/t_done01'] });
    assert.deepEqual(r.deleted, []);
    assert.ok(fs.existsSync(path.join(w.tbHome, 'worktrees', 't_done01', 'README')));
  });

  test('an entry swapped for a symlink after it was listed is refused, not followed', async () => {
    const w = world();
    const home = path.join(w.root, 'tb2'); // one entry only, so the clock hook below runs for exactly that entry
    put(path.join(home, 'cache', 'a', 'blob'));
    const entry = path.join(home, 'cache', 'a');
    const gc = createGc({
      store: { listTickets: () => [] },
      tbHome: home,
      now: () => { // called right after the entry was seen as a plain dir: swap it for a link to the victim dir
        fs.rmSync(entry, { recursive: true, force: true });
        fs.symlinkSync(path.join(w.root, 'victim'), entry);
        return Date.now();
      },
    });
    const r = await gc.remove({ ids: ['cache/a'] });
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.skipped, [{ id: 'cache/a', reason: 'is a symlink' }]);
    assert.ok(fs.existsSync(path.join(w.root, 'victim', 'keep')));
  });

  test('bad bodies are a 400', async () => {
    const w = world();
    for (const body of [null, {}, { ids: [] }, { ids: 'cache/a' }, { ids: [1] }, { ids: Array.from({ length: 101 }, (_, i) => `cache/${i}`) }]) {
      await assert.rejects(() => w.gc.remove(body), is400, JSON.stringify(body)?.slice(0, 40));
    }
    assert.equal(w.intact(), true);
  });
});

// ---- P5 (contract R1 M13): tb branches + refs/tb ------------------------------------------------------------------
describe('branches + refs', () => {
  test('lists a cancelled ticket\'s tb/<id>-* branches (name checked, unmerged commits counted) and refs/tb/<id>/* of done / cancelled ones; deletes only confirmed ids, a checked-out branch after its worktree; never an active ticket\'s', async () => {
    const w = world();
    const commit = (msg) => git(w.dev, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);
    git(w.dev, 'switch', '-q', '-c', 'tb/t_canc01-old-work');
    commit('one');
    commit('two');
    git(w.dev, 'switch', '-q', 'main');
    for (const b of ['tb/t_canc01-merged', 'tb/t_canc01-Bad_Name', 'tb/t_work01-x', 'tb/t_done01-x']) git(w.dev, 'branch', b, 'main');
    for (const r of ['refs/tb/t_canc01/T1-a1', 'refs/tb/t_canc01/replan-1-wip', 'refs/tb/t_done01/replan-1', 'refs/tb/t_work01/T1-a1']) git(w.dev, 'update-ref', r, 'main');
    git(path.join(w.tbHome, 'worktrees', 't_canc01'), 'switch', '-q', '-c', 'tb/t_canc01-wt'); // the cancelled ticket's worktree is on its branch
    const refs = () => git(w.dev, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);

    const items = (await w.gc.list({ limit: 100 })).items.filter((i) => i.kind === 'branch' || i.kind === 'refs');
    assert.deepEqual(items.map((i) => [i.id, i.reason, i.bytes]), [
      ['branch/tb/t_canc01-merged', 'ticket cancelled · 0 unmerged commits', null],
      ['branch/tb/t_canc01-old-work', 'ticket cancelled · 2 unmerged commits', null],
      ['branch/tb/t_canc01-wt', 'ticket cancelled · 0 unmerged commits', null],
      ['refs/t_canc01', 'ticket cancelled · 2 refs', null],
      ['refs/t_done01', 'ticket done · 1 ref', null],
    ], 'no bad name, no active ticket\'s, no done ticket\'s branch');

    const alone = await w.gc.remove({ ids: ['branch/tb/t_canc01-wt'] });
    assert.deepEqual(alone.deleted, []);
    assert.match(alone.skipped[0].reason, /checked out|used by worktree/, 'git refuses a branch its worktree still has');
    const r = await w.gc.remove({ ids: ['branch/tb/t_canc01-wt', 'branch/tb/t_canc01-old-work', 'refs/t_canc01', 'worktree/t_canc01', 'refs/t_done01', 'branch/tb/t_canc01-Bad_Name', 'branch/tb/t_work01-x', 'refs/t_work01'] });
    assert.deepEqual(r.deleted.map((d) => d.id), ['refs/t_canc01', 'worktree/t_canc01', 'refs/t_done01', 'branch/tb/t_canc01-wt', 'branch/tb/t_canc01-old-work'], 'branches last');
    assert.deepEqual(r.skipped.map((s) => s.reason), Array(3).fill('not in the current gc list'));
    assert.deepEqual(refs().filter((x) => x.includes('/tb/')).sort(), ['refs/heads/tb/t_canc01-Bad_Name', 'refs/heads/tb/t_canc01-merged', 'refs/heads/tb/t_done01-x', 'refs/heads/tb/t_work01-x', 'refs/tb/t_work01/T1-a1']);
    assert.equal(w.intact(), true);
  });
});

// ---- real tbd + tb ------------------------------------------------------------------------------------------------
describe('e2e: GET/POST /api/gc and tb gc on a real tbd', () => {
  let t;
  const tb = (...args) => runTb(args, t);
  before(async () => {
    t = await startTbd({ files: { 'cache/old/blob': 'x'.repeat(3000), 'cache/second.txt': 'y', 'worktrees/t_zzzzzz/file': 'orphan' } });
  });
  after(() => t.stop());

  test('needs the token; lists with sizes; bad limit is a 400', async () => {
    assert.equal((await t.api('GET', '/api/gc', undefined, { 'x-tb-token': undefined })).status, 401);
    assert.equal((await t.api('POST', '/api/gc', { ids: [] }, { 'x-tb-token': undefined })).status, 401);
    const r = await t.api('GET', '/api/gc');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((i) => i.id), ['cache/old', 'cache/second.txt', 'worktree/t_zzzzzz']);
    assert.ok(r.json.items.every((i) => i.bytes > 0 && i.path.startsWith(fs.realpathSync(t.tbHome))));
    assert.equal((await t.api('GET', '/api/gc?limit=1')).json.next, 'cache/old');
    assert.equal((await t.api('GET', '/api/gc?limit=1&after=cache/old')).json.items[0].id, 'cache/second.txt');
    assert.equal((await t.api('GET', '/api/gc?limit=500')).status, 400);
    assert.equal((await t.api('POST', '/api/gc', { ids: 'x' })).status, 400);
  });

  test('tb gc lists as a table; tb gc --delete removes only the named ids and exits 1 on a refused one', async () => {
    const list = await tb('gc');
    assert.equal(list.code, 0, list.stdout);
    assert.match(list.stdout, /^gc\[3\]\{id,kind,size,age_days,reason\}:$/m);
    assert.match(list.stdout, /^ {2}cache\/old,cache,\d+ KB,0,cache$/m);
    assert.match(list.stdout, /^ {2}worktree\/t_zzzzzz,worktree,\d+ KB,0,ticket missing$/m);
    assert.match(list.stdout, /^help: tb gc --delete <id>\.\.\. removes for good$/m);
    assert.match((await tb('gc', '--limit', '1')).stdout, /^count: 1 of 3\n[^]*help: tb gc --after cache\/old$/m);

    const del = await tb('gc', '--delete', 'cache/old', 'worktree/t_zzzzzz');
    assert.equal(del.code, 0, del.stdout);
    assert.match(del.stdout, /^deleted\[2\]\{id,size\}:$/m);
    assert.equal(fs.existsSync(path.join(t.tbHome, 'cache', 'old')), false);
    assert.equal(fs.existsSync(path.join(t.tbHome, 'worktrees', 't_zzzzzz')), false);
    assert.ok(fs.existsSync(path.join(t.tbHome, 'cache', 'second.txt')), 'not named, not deleted');

    const refused = await tb('gc', '--delete', 'cache/second.txt', '../etc');
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /^deleted\[1\]/m);
    assert.match(refused.stdout, /^skipped\[1\]\{id,reason\}:\n {2}\.\.\/etc,"?not in the current gc list"?$/m);
    assert.match((await tb('gc')).stdout, /^gc\[0\]: none$/m);
  });

  test('tb gc usage errors: ids without --delete, --delete without ids, listing flags with --delete', async () => {
    assert.equal((await tb('gc', 'cache/x')).code, 2);
    assert.equal((await tb('gc', '--delete')).code, 2);
    assert.equal((await tb('gc', '--delete', 'cache/x', '--limit', '5')).code, 2);
    assert.equal((await tb('gc', '--limit', '0')).code, 2);
    const after = await tb('gc', '--after', 'zzz'); // a page cursor (a value), not eval chaos's --after switch
    assert.deepEqual([after.code, after.stdout], [0, 'gc[0]: none\n']);
  });
});

// ---- Phase 4 build step 3 (design revision 6 test 10, section 6): an Own Worktree Task's tb/<id> branch rows ----
describe('Own Worktree Task branches', () => {
  // a done Own Worktree Task whose tb/<id> has one commit no other branch has (the store's fields gc reads)
  function treeWorld(gitBin) {
    const w = world();
    const id = 't_tree01';
    git(w.dev, 'branch', `tb/${id}`, 'main');
    git(w.dev, 'branch', 'tb/t_tree02', 'main'); // another Task's, not listed
    const idx = path.join(w.root, 'idx');
    const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...a) => spawnSync('git', ['-C', w.dev, ...a], { encoding: 'utf8', env }).stdout.trim();
    g('read-tree', 'main');
    git(w.dev, 'update-ref', `refs/heads/tb/${id}`, g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', g('write-tree'), '-p', 'main', '-m', 'work'));
    const t = { id, kind: 'task', state: 'done', task: { mode: 'worktree', repo: w.dev }, common_dir: w.tickets[0].common_dir, updated_at: new Date().toISOString() };
    w.tickets.push(t, { id: 't_tree02', kind: 'task', state: 'working', task: { mode: 'worktree', repo: w.dev }, common_dir: t.common_dir });
    const gc = createGc({ store: { listTickets: () => w.tickets }, tbHome: w.tbHome, ...(gitBin && { git: gitBin }) });
    return { ...w, id, gc, sha: () => git(w.dev, 'rev-parse', `refs/heads/tb/${id}`).trim(), rec: path.join(w.tbHome, 'gc-branches.jsonl') };
  }

  test('a done Task\'s tb/<id> is listed with its sha and unmerged count; delete writes {common, ref, sha} first, then removes exactly it; a missing ticket\'s row carries the unlock + remove hint (never prune)', async () => {
    const w = treeWorld();
    const sha = w.sha();
    const { items } = await w.gc.list({ limit: 100 });
    const row = items.find((i) => i.kind === 'branch');
    assert.deepEqual([row.id, row.sha, row.reason], [`branch/tb/${w.id}`, sha, 'ticket done · 1 unmerged commit']);
    assert.equal(items.filter((i) => i.kind === 'branch').length, 1, 'the open Task\'s branch is not listed');
    // round 1 review: the row's own path, shell-quoted (was <path>)
    // security review HIGH 2 (contract change; was "... && git worktree prune"): prune empties where a planted link leads
    const orph = `'${path.join(fs.realpathSync(w.tbHome), 'worktrees', 't_orph01')}'`;
    assert.equal(items.find((i) => i.id === 'worktree/t_orph01').hint, `if it was an Own Worktree, run \`git worktree unlock ${orph} && git worktree remove --force ${orph}\` in its repo`);
    assert.equal(items.find((i) => i.id === 'worktree/t_done01').hint, undefined);
    const r = await w.gc.remove({ ids: [`branch/tb/${w.id}`] });
    assert.deepEqual([r.deleted.map((d) => d.id), r.skipped], [[`branch/tb/${w.id}`], []]);
    assert.equal(git(w.dev, 'branch', '--list', `tb/${w.id}`), '');
    assert.deepEqual(fs.readFileSync(w.rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ common: w.tickets[0].common_dir, ref: `refs/heads/tb/${w.id}`, sha }]);
  });

  test('a branch moved after the listing is skipped and stays (the old-value delete), its record cancelled by a line with no sha; a record that cannot be written (a link there) → no delete', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mv-')));
    roots.push(root);
    const arm = path.join(root, 'arm');
    const to = path.join(root, 'to');
    const wrap = path.join(root, 'git'); // the real git; once armed, moves the branch right after gc's for-each-ref read it
    fs.writeFileSync(wrap, `#!/bin/sh\n/usr/bin/git "$@"; s=$?\ncase "$*" in *for-each-ref*) if [ -f "${arm}" ]; then rm "${arm}"; /usr/bin/git --git-dir "$(cat "${to}.gd")" update-ref "$(cat "${to}")" HEAD; fi;; esac\nexit $s\n`, { mode: 0o755 });
    const w = treeWorld(wrap);
    const was = w.sha();
    fs.writeFileSync(to, `refs/heads/tb/${w.id}`);
    fs.writeFileSync(`${to}.gd`, w.tickets[0].common_dir);
    fs.writeFileSync(arm, '');
    const r = await w.gc.remove({ ids: [`branch/tb/${w.id}`] });
    assert.deepEqual(r.deleted, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(w.sha(), git(w.dev, 'rev-parse', 'main').trim(), 'the moved branch stays where it moved');
    assert.notEqual(w.sha(), was);
    assert.deepEqual(fs.readFileSync(w.rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sha), [was, null]);

    const w2 = treeWorld();
    const before = w2.sha();
    fs.symlinkSync(path.join(w2.root, 'victim', 'keep'), w2.rec);
    const r2 = await w2.gc.remove({ ids: [`branch/tb/${w2.id}`] });
    assert.deepEqual(r2.deleted, []);
    assert.match(r2.skipped[0].reason, /^the delete was not written down \(ELOOP\): not deleted$/);
    assert.equal(w2.sha(), before, 'the branch stays');
    assert.equal(fs.readFileSync(path.join(w2.root, 'victim', 'keep'), 'utf8'), 'do not touch', 'nothing written through the link');
  });

  test('round 1 review: a My Folder Task\'s done tb/<id> is listed too; a branch a rebase stopped on (detached in git worktree list) is refused and stays; two deletes of one branch at once → one delete, one record line, no sha-null line', async () => {
    const w = treeWorld();
    git(w.dev, 'branch', 'tb/t_fold03', 'main');
    w.tickets.push({ id: 't_fold03', kind: 'task', state: 'done', task: { mode: 'folder', real: w.dev }, common_dir: w.tickets[0].common_dir, updated_at: new Date().toISOString() });
    assert.equal((await w.gc.list({ limit: 100 })).items.find((i) => i.id === 'branch/tb/t_fold03')?.reason, 'ticket done · 0 unmerged commits');

    const id = ['branch/tb/t_fold03'];
    const sha = git(w.dev, 'rev-parse', 'refs/heads/tb/t_fold03').trim();
    const both = await Promise.all([w.gc.remove({ ids: id }), w.gc.remove({ ids: id })]);
    assert.deepEqual(both.flatMap((r) => r.deleted.map((d) => d.id)), id, JSON.stringify(both));
    assert.ok(['already being deleted', 'not in the current gc list'].includes(both.flatMap((r) => r.skipped)[0]?.reason), JSON.stringify(both));
    assert.deepEqual(fs.readFileSync(w.rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ common: w.tickets[0].common_dir, ref: 'refs/heads/tb/t_fold03', sha }]);

    const as = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
    put(path.join(w.dev, 'README'), 'main side\n');
    git(w.dev, ...as, 'commit', '-qam', 'main side');
    git(w.live, 'switch', '-q', `tb/${w.id}`);
    put(path.join(w.live, 'README'), 'branch side\n');
    git(w.live, ...as, 'commit', '-qam', 'branch side');
    const stopped = spawnSync('git', ['-C', w.live, ...as, 'rebase', 'main'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.notEqual(stopped.status, 0, 'the rebase stopped on its conflict');
    assert.match(git(w.dev, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${w.live}\\nHEAD [0-9a-f]+\\ndetached`), 'git worktree list shows it detached');
    const was = w.sha();
    const r = await w.gc.remove({ ids: [`branch/tb/${w.id}`] });
    assert.deepEqual(r.deleted, []);
    assert.equal(r.skipped[0]?.reason, `tb/${w.id} is checked out in a worktree (or a rebase or bisect is on it): remove that first`);
    assert.equal(w.sha(), was, 'the branch stays');
  });

  test('round 2 review: a call that listed a branch, then waits on an earlier item while another call deletes it, does not write the delete again (no sha-null line: no Task Blocked)', async () => {
    const w = treeWorld();
    const started = path.join(w.root, 'started');
    const go = path.join(w.root, 'go');
    const du = path.join(w.root, 'du-slow'); // cache/a waits for `go` (at most 10 s); every other size at once
    fs.writeFileSync(du, `#!/bin/sh\ncase "$2" in */cache/a) touch "${started}"; i=0; while [ ! -f "${go}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done;; esac\nprintf '4\\t%s\\n' "$2"\n`, { mode: 0o755 });
    const gc = createGc({ store: { listTickets: () => w.tickets }, tbHome: w.tbHome, du });
    const sha = w.sha();
    const id = `branch/tb/${w.id}`;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = gc.remove({ ids: ['cache/a', id] }); // B lists the branch, then is busy sizing cache/a
    for (let i = 0; i < 100 && !fs.existsSync(started); i++) await wait(50);
    assert.ok(fs.existsSync(started), 'B is on its first item');
    const a = gc.remove({ ids: [id] });
    await Promise.race([a, wait(1000)]);
    fs.writeFileSync(go, '');
    const [rb, ra] = await Promise.all([b, a]);
    assert.deepEqual([...rb.deleted, ...ra.deleted].map((d) => d.id).filter((x) => x === id), [id], JSON.stringify([rb, ra]));
    assert.deepEqual([...rb.skipped, ...ra.skipped], [{ id, reason: 'not in the current gc list' }]);
    assert.deepEqual(fs.readFileSync(w.rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ common: w.tickets[0].common_dir, ref: `refs/heads/tb/${w.id}`, sha }]);
  });
});
