'use strict';
// board-terminal-parity Phase 1 server (plan tasks 0, 4, 5, 6.1, 6.5, 6.6) on a real tbd (harness temp HOME + TB_HOME):
// the terminal switches (POST /api/config), the page tools behind terminal.page_tools (quick tag, folder branches,
// recent folders, the folder picker, Open in Terminal, Check Setup / Clean Up), GET /api/skills, skills_asked and Start
// now. osascript is a fake that records its argv (TB_OSASCRIPT). Names: sandbox/shop style only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { startTbd, runTb } = require('./helpers/tbd');
const { ticket, until } = require('./helpers/runs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'page-tools-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function repo(name, files = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries({ 'README.md': 'shop\n', ...files })) write(path.join(dir, f), text);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

// the fake osascript: its argv (NUL-separated) into argv-<n>; `choose folder` prints a folder, or cancels when ./cancel exists
const FAKE = path.join(ROOT, 'osa', 'osascript');
write(FAKE, `#!/bin/sh
d=$(dirname "$0"); n=$(ls "$d" | grep -c '^argv-'); printf '%s\\0' "$@" > "$d/argv-$n"
case "$*" in *"choose folder"*) [ -e "$d/cancel" ] && { echo 'execution error: User canceled. (-128)' >&2; exit 1; }; echo '/Volumes/work/shop/';; esac
`);
fs.chmodSync(FAKE, 0o755);
const argvs = () => fs.readdirSync(path.dirname(FAKE)).filter((f) => f.startsWith('argv-')).sort().map((f) => fs.readFileSync(path.join(path.dirname(FAKE), f), 'utf8').split('\0').slice(0, -1));

const UUID = '33333333-3333-4333-8333-333333333333';
const WT = path.join(ROOT, "it's the worktree");
const TERMINAL = { bash_all_steps: false, folder_mcp: false, git_bridge: false, auto_mode: false, task_tickets: false, page_tools: false, approve_min: 10 };
let tbd, ui, csrf;
before(async () => {
  // a real checkout: Open in Terminal runs the planted-config check on the worktree first (review HIGH 3)
  write(path.join(WT, 'README.md'), 'shop\n');
  git(WT, 'init', '-q', '-b', 'main');
  git(WT, 'add', '.');
  git(WT, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base_sha = git(WT, 'rev-parse', 'HEAD');
  tbd = await startTbd({
    env: { TB_OSASCRIPT: FAKE, TB_PHASES_DIR: path.join(ROOT, 'no-phases') }, // no phase built: no run starts
    files: {
      'tickets/t_held01/ticket.json': ticket('t_held01', { state: 'working', worktree: WT, base_sha, lease: { phase: 'working', round: 1, gen: 2, log: 'runs/1.jsonl', exit: 'held', session: UUID } }),
      'tickets/t_free01/ticket.json': ticket('t_free01', { state: 'working', worktree: WT, base_sha, lease: { phase: 'working', round: 1, gen: 2, log: 'runs/1.jsonl', exit: 'paused', session: UUID } }),
    },
  });
  fs.mkdirSync(path.join(ROOT, 'claude-real')); // ~/.claude a link to another folder, before page-tools reads its roots (once)
  fs.symlinkSync(path.join(ROOT, 'claude-real'), path.join(tbd.home, '.claude'));
  ui = { 'x-tb-token': undefined, cookie: await tbd.unlock(), 'sec-fetch-site': 'same-origin' };
  csrf = { ...ui, 'x-tb-csrf': (await tbd.api('GET', '/api/session/csrf', undefined, ui)).json.csrf };
});
after(() => tbd.stop());
const switchTo = (over) => tbd.api('POST', '/api/config', { terminal: { ...TERMINAL, ...over } });

test('task 0 terminal switches: all 7 keys → 200 and GET /api/config shows them; a missing or an unknown key inside → 400 with the rule, nothing changed', async () => {
  assert.deepEqual((await tbd.api('GET', '/api/config')).json.config.terminal, TERMINAL, 'off in code');
  const on = { ...TERMINAL, git_bridge: true, approve_min: 15 };
  const ok = await tbd.api('POST', '/api/config', { terminal: on }, csrf);
  assert.deepEqual([ok.status, ok.json.config.terminal], [200, on]);
  assert.deepEqual((await tbd.api('GET', '/api/config', undefined, ui)).json.config.terminal, on);
  const rule = 'bad value for config key "terminal": all 7 keys: bash_all_steps, folder_mcp, git_bridge, auto_mode, task_tickets, page_tools true|false, approve_min a whole number 1-60';
  const { approve_min: _drop, ...missing } = on;
  for (const terminal of [missing, { ...on, extra: true }]) {
    const r = await tbd.api('POST', '/api/config', { terminal });
    assert.deepEqual([r.status, r.json], [400, { error: rule }], JSON.stringify(terminal));
  }
  assert.deepEqual((await tbd.api('GET', '/api/config')).json.config.terminal, on, 'refused: unchanged');
  assert.equal((await switchTo({})).status, 200);
});

test('page_tools off: a cookie caller of every page-tools route → 401 CLI only (the token still gets through); on: the cookie gets through, a POST still needs X-TB-CSRF', async () => {
  assert.equal((await switchTo({ page_tools: false })).status, 200);
  const routes = [['POST', '/api/tags/quick'], ['POST', '/api/folders/branches'], ['GET', '/api/folders/recent'], ['POST', '/api/pick-folder'],
    ['POST', '/api/tickets/t_held01/terminal'], ['POST', '/api/doctor'], ['GET', '/api/gc'], ['POST', '/api/gc']];
  for (const [method, p] of routes) {
    const r = await tbd.api(method, p, method === 'POST' ? {} : undefined, csrf);
    assert.deepEqual([r.status, r.json], [401, { error: 'CLI only: use tb' }], `${method} ${p}`);
  }
  assert.equal((await tbd.api('GET', '/api/folders/recent')).status, 200, 'the token: as today');
  assert.equal(argvs().length, 0, 'no program ran');
  assert.equal((await switchTo({ page_tools: true })).status, 200);
  assert.deepEqual([(await tbd.api('GET', '/api/gc', undefined, ui)).status], [200], 'Clean Up list from the page');
  const noCsrf = await tbd.api('POST', '/api/gc', {}, ui);
  assert.deepEqual([noCsrf.status, noCsrf.json], [403, { error: 'missing or wrong X-TB-CSRF token: reload the page' }]);
});

test('task 4 POST /api/tags/quick: a git folder → 201 {git, base main, leak_check}, saved; refused: HOME, a folder under TB_HOME, base not a local branch, the same name again (409), an extra key; branches + recent folders', async () => {
  assert.equal((await switchTo({ page_tools: true })).status, 200);
  const shop = repo('shop');
  git(shop, 'branch', 'feat');
  const quick = (b) => tbd.api('POST', '/api/tags/quick', b, csrf);
  const ok = await quick({ name: 'sandbox/shop', path: shop, base: 'main' });
  const tag = { name: 'sandbox/shop', path: shop, type: 'git', base: 'main', leak_check: true };
  assert.deepEqual([ok.status, ok.json], [201, { tag }]);
  const { name: _n, ...def } = tag;
  assert.deepEqual((await tbd.api('GET', '/api/tags')).json.tags['sandbox/shop'], def);
  const refusedMsg = (p) => `${p} is refused: never HOME, /, the board's own folders, or a system or secret folder`;
  const cases = [
    [{ name: 'sandbox/home', path: tbd.home }, 400, refusedMsg(fs.realpathSync(tbd.home))],
    [{ name: 'sandbox/tb', path: path.join(tbd.tbHome, 'tickets') }, 400, refusedMsg(fs.realpathSync(path.join(tbd.tbHome, 'tickets')))],
    [{ name: 'sandbox/nobase', path: shop, base: 'nope' }, 400, `base must be a local branch of ${shop}`],
    [{ name: 'sandbox/shop', path: shop, base: 'main' }, 409, 'tag sandbox/shop exists'],
    [{ name: 'sandbox/extra', path: shop, base: 'main', setup: 'npm ci' }, 400, 'body must be {"name", "path", "base"?}'],
  ];
  for (const [b, status, error] of cases) {
    const r = await quick(b);
    assert.deepEqual([r.status, r.json], [status, { error }], JSON.stringify(b));
  }
  assert.deepEqual(Object.keys((await tbd.api('GET', '/api/tags')).json.tags), ['sandbox/shop'], 'nothing else saved');

  const br = await tbd.api('POST', '/api/folders/branches', { path: shop }, csrf);
  assert.deepEqual([br.status, br.json], [200, { type: 'git', current: 'main', branches: ['feat', 'main'] }]);
  assert.equal((await tbd.api('POST', '/api/folders/branches', { path: tbd.home }, csrf)).status, 400, 'same root rules');
  for (const [p, real, why] of [[path.join(tbd.home, '.claude'), path.join(ROOT, 'claude-real'), '~/.claude a link: its real folder'], [path.dirname(tbd.tbHome), fs.realpathSync(path.dirname(tbd.tbHome)), 'a parent of TB_HOME']]) {
    const r = await tbd.api('POST', '/api/folders/branches', { path: p }, csrf);
    assert.deepEqual([r.status, r.json], [400, { error: refusedMsg(real) }], why);
  }

  write(path.join(tbd.home, '.claude.json'), JSON.stringify({ projects: { [shop]: {}, [path.join(ROOT, 'gone')]: {}, [tbd.tbHome]: {}, [tbd.home]: {} } }));
  const rec = await tbd.api('GET', '/api/folders/recent', undefined, ui);
  assert.deepEqual([rec.status, rec.json], [200, { folders: [{ name: 'shop', path: shop }] }], 'gone, TB_HOME and HOME left out');
});

test('task 4 POST /api/pick-folder: the picked folder (trailing / cut) → {path}; the user cancels → {cancelled: true}; osascript argv exact', async () => {
  assert.equal((await switchTo({ page_tools: true })).status, 200);
  const start = argvs().length;
  const r = await tbd.api('POST', '/api/pick-folder', {}, csrf);
  assert.deepEqual([r.status, r.json], [200, { path: '/Volumes/work/shop' }]);
  write(path.join(path.dirname(FAKE), 'cancel'), '');
  const c = await tbd.api('POST', '/api/pick-folder', {}, csrf);
  fs.rmSync(path.join(path.dirname(FAKE), 'cancel'));
  assert.deepEqual([c.status, c.json], [200, { cancelled: true }]);
  assert.deepEqual(argvs().slice(start), [0, 1].map(() => ['-e', 'POSIX path of (choose folder with prompt "Pick the tag folder")']));
});

test('task 6.5 POST /api/tickets/:id/terminal: a held run → 202, osascript gets the resume line as one argv item (shq worktree); not held, or claude --resume <session> still runs → 409, nothing run', async (t) => {
  assert.equal((await switchTo({ page_tools: true })).status, 200);
  const start = argvs().length;
  const no = await tbd.api('POST', '/api/tickets/t_free01/terminal', {}, csrf);
  assert.deepEqual([no.status, no.json], [409, { error: 't_free01: not held: Pause and Copy first (a held run with a session in a worktree)' }]);
  const term = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', '--resume', UUID], { stdio: 'ignore' }); // a terminal on the session
  t.after(() => term.kill('SIGKILL'));
  await once(term, 'spawn');
  const busy = await tbd.api('POST', '/api/tickets/t_held01/terminal', {}, csrf);
  term.kill('SIGKILL');
  await once(term, 'exit');
  assert.deepEqual([busy.status, busy.json], [409, { error: `t_held01: claude --resume ${UUID} still runs: close your terminal session first` }]);
  assert.equal(argvs().length, start, 'no osascript ran');
  const r = await tbd.api('POST', '/api/tickets/t_held01/terminal', {}, csrf);
  assert.deepEqual([r.status, r.json], [202, { ok: true }]);
  const got = await until(() => argvs().length > start && argvs().slice(start), 10_000, 'osascript ran');
  assert.deepEqual(got, [['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'tell application "Terminal" to activate', '-e', 'end run',
    `cd '${ROOT}/it'\\''s the worktree' && claude --resume ${UUID}`]]);
  // review HIGH 3: Claude config the run left in the worktree is loaded by his `claude --resume` outside the wall: 409, no osascript
  write(path.join(WT, '.claude', 'settings.json'), '{"hooks":{}}\n');
  const after = argvs().length;
  const planted = await tbd.api('POST', '/api/tickets/t_held01/terminal', {}, csrf);
  fs.rmSync(path.join(WT, '.claude'), { recursive: true });
  assert.deepEqual([planted.status, planted.json], [409, { error: `t_held01: ${WT} has .claude/settings.json: agent-planted config, remove by hand` }]);
  assert.equal(argvs().length, after, 'no osascript ran');
});

// default phases (code/working + planning built): flows can be made and assigned
test('task 5 GET /api/skills: user skill (folded description), enabled plugin skill as <plugin>:<skill>, the git tag\'s committed .claude/skills; a disabled plugin and an uncommitted skill are not listed; skills_asked from "/tdd /nope go /api/users" (a path asks nothing)', async (t) => {
  const own = await startTbd();
  t.after(() => own.stop());
  const h = own.home;
  write(path.join(h, '.claude/skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: >\n  Test first.\n  Then code.\n---\n# tdd\n');
  write(path.join(h, '.claude/skills/api/SKILL.md'), '---\nname: api\ndescription: Call the shop API\n---\n'); // `/api/users` in a goal asks nothing
  const cache = path.join(h, 'plugin-cache');
  write(path.join(cache, 'shop/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: "Ship the shop"\n---\n');
  write(path.join(cache, 'off/skills/hidden/SKILL.md'), '---\nname: hidden\ndescription: off\n---\n');
  write(path.join(h, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'shop@market': [{ scope: 'user', installPath: path.join(cache, 'shop') }], 'off@market': [{ scope: 'user', installPath: path.join(cache, 'off') }] } }));
  write(path.join(h, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'shop@market': true, 'off@market': false } }));
  const shop = repo('skills-shop', { '.claude/skills/shop-qa/SKILL.md': "---\nname: shop-qa\ndescription: 'QA the shop'\n---\n" });
  write(path.join(shop, '.claude/skills/draft/SKILL.md'), '---\nname: draft\n---\n'); // not committed: not at HEAD
  assert.equal((await own.api('POST', '/api/tags', { name: 'sandbox/shop', def: { type: 'git', path: shop, base: 'main' } })).status, 201);

  const r = await own.api('GET', '/api/skills?tag=sandbox/shop');
  assert.deepEqual([r.status, r.json], [200, { skills: [
    { name: 'api', description: 'Call the shop API', source: 'user' },
    { name: 'tdd', description: 'Test first.', source: 'user' },
    { name: 'shop:deploy', description: 'Ship the shop', source: 'plugin' },
    { name: 'shop-qa', description: 'QA the shop', source: 'project' },
  ] }]);
  assert.equal((await own.api('GET', '/api/skills?tag=sandbox/nope')).status, 400);

  const f = await own.api('POST', '/api/flows', { text: '/tdd /nope go /api/users\n/shop:deploy too', kind: 'code', tag: 'sandbox/shop' });
  assert.deepEqual([f.status, f.json.ticket.skills_asked], [201, ['tdd', 'shop:deploy']]);
  assert.deepEqual((await own.api('GET', `/api/tickets/${f.json.ticket.id}`)).json.ticket.skills_asked, ['tdd', 'shop:deploy']);
  const none = await own.api('POST', '/api/flows', { text: 'no /nope skills here', kind: 'code' });
  assert.equal('skills_asked' in none.json.ticket, false);
});

test('GET /api/files: a git tag lists tracked files that match q (name or folder prefix first), never untracked or ignored ones; limit caps and sets more; unknown tag → 400', async (t) => {
  const own = await startTbd();
  t.after(() => own.stop());
  const dir = repo('files-shop', { 'src/Cart.js': '', 'src/cart-util.js': '', 'docs/notes-cart.md': '', 'src/other.js': '', '.gitignore': 'secret.txt\n' });
  write(path.join(dir, 'secret.txt'), 'x'); // ignored
  write(path.join(dir, 'node_modules/cart/index.js'), 'x'); // untracked
  assert.equal((await own.api('POST', '/api/tags', { name: 'sandbox/files', def: { type: 'git', path: dir, base: 'main' } })).status, 201);
  const get = (q) => own.api('GET', `/api/files?tag=sandbox/files&${q}`);

  const hit = await get('q=CART');
  assert.deepEqual([hit.status, hit.json], [200, { files: ['src/Cart.js', 'src/cart-util.js', 'docs/notes-cart.md'], more: false }]);
  assert.deepEqual((await get('q=secret')).json, { files: [], more: false });
  assert.deepEqual((await get('q=node_modules')).json, { files: [], more: false });
  assert.deepEqual((await get('q=src/&limit=2')).json, { files: ['src/Cart.js', 'src/cart-util.js'], more: true });
  assert.equal((await own.api('GET', '/api/files?tag=sandbox/nope&q=a')).status, 400);

  // a plain folder is walked: no dot-folders, no node_modules, no dot-files, no symlinks
  const plain = path.join(ROOT, 'files-plain');
  write(path.join(plain, 'src/app.js'), 'x');
  write(path.join(plain, '.hidden/secret.js'), 'x');
  write(path.join(plain, 'node_modules/dep/index.js'), 'x');
  write(path.join(plain, '.env'), 'KEY=1');
  fs.symlinkSync(path.join(plain, 'src/app.js'), path.join(plain, 'link.js'));
  assert.equal((await own.api('POST', '/api/tags', { name: 'sandbox/plain', def: { type: 'folder', path: plain } })).status, 201);
  assert.deepEqual((await own.api('GET', '/api/files?tag=sandbox/plain&q=')).json, { files: ['src/app.js'], more: false });
});

test('task 6.1 Start now: POST /api/flows {start: true} with a folder tag → started, planning; tb new --start without a tag → stays backlog, the line says why', async (t) => {
  const own = await startTbd();
  t.after(() => own.stop());
  const notes = path.join(ROOT, 'notes');
  fs.mkdirSync(notes);
  assert.equal((await own.api('POST', '/api/tags', { name: 'sandbox/notes', def: { type: 'folder', path: notes } })).status, 201);
  const r = await own.api('POST', '/api/flows', { text: 'Start me', kind: 'code', tag: 'sandbox/notes', start: true });
  assert.deepEqual([r.status, r.json.started, r.json.ticket.state], [201, true, 'planning']);
  const no = await runTb(['new', 'Never started', '-f', 'code', '--start'], own);
  assert.equal(no.code, 0, no.stdout);
  const id = /^added: (t_[a-z0-9]{6}) → backlog/.exec(no.stdout)?.[1];
  assert.ok(id, no.stdout);
  assert.equal(no.stdout.split('\n')[1], `not started: ${JSON.stringify(`${id} has no tag: a flow needs a tag with a path to be assigned`)}`);
  assert.equal((await own.api('GET', `/api/tickets/${id}`)).json.ticket.state, 'backlog');
});
