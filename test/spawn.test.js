'use strict';
// P3a AC2 variants of the §9 spawn line (lib/spawn.js in-process, fake-claude as claude_bin, argv/env dump): resume
// uses --resume without --session-id and the §8 resume prompt; Fable gate (§6); a phase with Agent gets no
// --disallowedTools; a phase's own mcp.json is used; config errors spawn nothing; S1: agent-planted Claude config in
// the cwd (ticket dir, or a worktree vs ticket.base_sha) refuses the run before anything is written. The new-run line
// through a real tbd (env from tbd, TBX_RUN registered) is in runner.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PHASES = path.join(ROOT, 'phases');
const SCHEMA = { type: 'object', required: ['status'] };
for (const ph of ['working', 'qa', 'review']) { // M5 C5: qa + review for the env-file deny test
  for (const [file, content] of Object.entries({
    'prompt.md': '# working fixture\n',
    'settings.json': { permissions: { allow: ['Read', 'Glob', 'Grep', 'Edit(/${WORKTREE}/**)', 'Bash', 'Agent'] } },
    'result.schema.json': SCHEMA,
    'mcp.json': { mcpServers: {} },
  })) {
    fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
    fs.writeFileSync(path.join(PHASES, 'code', ph, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
}
process.env.TB_PHASES_DIR = PHASES; // read by lib/phases + lib/phase-settings at load
require('./helpers/runs').passFakeEnv(); // FAKE_CLAUDE_DUMP_DIR through the claudeEnv allowlist
const spawn = require('../lib/spawn');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SID = '22222222-2222-4222-8222-222222222222';
const CONFIG = {
  claude_bin: FAKE, fable_billing: 'unknown', subagents: { concurrent: 3, depth: 1 },
  models: { working: { model: 'fable', effort: 'high' } }, max_turns: { working_task: 80 }, liveness: { wall_min: { working_task: 45 } },
};

// One spawn.start into a fresh temp dir; err set when it refused (then nothing may have been spawned).
async function attempt({ config = CONFIG, resume = true, ticket = {}, env = {}, files = {}, phase = 'working', tag = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'run-'));
  const tbHome = path.join(dir, 'tbhome');
  const ticketDir = path.join(tbHome, 'tickets', 't_spawn1');
  const dump = path.join(dir, 'dump');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(dump);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ticketDir, f)), { recursive: true });
    fs.writeFileSync(path.join(ticketDir, f), c);
  }
  try {
    const s = await spawn.start({
      ticket: { id: 't_spawn1', kind: 'code', ...ticket }, phase, tag, n: 2, session: SID, resume, key: 'ef'.repeat(16),
      prompt: spawn.RESUME_PROMPT, config, tbHome, ticketDir, port: 7777,
      env: { PATH: process.env.PATH, HOME: dir, FAKE_CLAUDE_DUMP_DIR: dump, ...env },
    });
    await s.ready;
    await s.done;
    return { d: JSON.parse(fs.readFileSync(path.join(dump, '1.json'), 'utf8')), ticketDir, dump };
  } catch (err) {
    return { err, ticketDir, dump };
  }
}
async function run(opts) {
  const r = await attempt(opts);
  if (r.err) throw r.err;
  return r;
}

test('AC2 resume: --resume <session> and no --session-id, resume prompt verbatim; Fable gate; Agent phase; phase mcp.json; claude env', async () => {
  const base = { ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x', NODE_OPTIONS: '--require /x.js', GH_TOKEN: 'x', TB_HOME: '/x', CLAUDECODE: '1' };
  const { d, ticketDir } = await run({ env: base });
  assert.equal(d.opts['--resume'], SID);
  assert.equal(d.argv.includes('--session-id'), false, 'resume never sends --session-id (§8 step 5)');
  assert.equal(d.prompt, 'Your previous run was interrupted. Check the current state and continue from your last step.');
  assert.deepEqual([d.opts['--model'], d.opts['--effort'], d.opts['--fallback-model']], ['opus', 'xhigh', undefined], 'fable_billing unknown: opus xhigh');
  assert.equal(d.argv.includes('--disallowedTools'), false, 'phase allows Agent');
  assert.equal(d.opts['--tools'], 'Read,Glob,Grep,Edit,Write,Bash,Agent');
  assert.equal(d.opts['--mcp-config'], path.join(PHASES, 'code/working/mcp.json'));
  assert.equal(fs.existsSync(path.join(ticketDir, 'runs/2.mcp.json')), false);
  assert.deepEqual([d.opts['--max-turns'], d.opts['--json-schema']], ['80', JSON.stringify(SCHEMA)], 'working → working_task cap; schema inline');
  assert.equal(d.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(45 * 60_000));
  for (const k of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'GH_TOKEN', 'TB_HOME', 'CLAUDECODE']) assert.equal(k in d.env, false, `${k} dropped`); // S2: no env token
  assert.equal(d.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(ticketDir), 'no worktree yet: ticket dir');
});

test('AC2 Fable gate: fable only with fable_billing plan or credits_ok, then with --fallback-model opus', async () => {
  for (const billing of ['plan', 'credits_ok']) {
    const { d } = await run({ config: { ...CONFIG, fable_billing: billing }, resume: false });
    assert.deepEqual([d.opts['--model'], d.opts['--effort'], d.opts['--fallback-model'], d.opts['--session-id']], ['fable', 'high', 'opus', SID], billing);
  }
});

test('config errors spawn nothing: no model, no turn cap, worktree not absolute, schema not an object', async (t) => {
  /** @type {[any, RegExp][]} */
  const cases = [
    [{ config: { ...CONFIG, models: {} } }, /config\.models\.working\.model is missing/],
    [{ config: { ...CONFIG, max_turns: { working_task: 0 } } }, /max_turns\.working_task must be a positive integer/],
    [{ ticket: { worktree: '~/.taskboard/worktrees/t_spawn1' } }, /ticket\.worktree must be an absolute path/], // never the ticket dir instead
  ];
  const check = (r, re) => {
    assert.match(r.err?.message ?? 'no error', re);
    assert.deepEqual(fs.readdirSync(r.dump), [], 'never spawned');
    assert.equal(fs.existsSync(path.join(r.ticketDir, 'runs/2.jsonl')), false);
  };
  for (const [opts, re] of cases) check(await attempt(opts), re);
  fs.writeFileSync(path.join(PHASES, 'code/working/result.schema.json'), '[]');
  t.after(() => fs.writeFileSync(path.join(PHASES, 'code/working/result.schema.json'), JSON.stringify(SCHEMA)));
  check(await attempt(), /result\.schema\.json must hold a JSON object/);
});

// S1 layer 2. Every refusal: the message names the file, nothing written, nothing spawned (new run and resume alike).
const refused = (r, re) => {
  assert.match(r.err?.message ?? 'no error', re);
  assert.deepEqual(fs.readdirSync(r.dump), [], 'never spawned');
  assert.equal(fs.existsSync(path.join(r.ticketDir, 'runs')), false, 'nothing written');
};

test('S1 ticket dir as cwd: a .claude dir, CLAUDE.md or CLAUDE.local.md (any case) refuses the run; a clean ticket dir runs', async () => {
  /** @type {[string, boolean][]} */
  const cases = [['.claude/settings.json', true], ['CLAUDE.md', false], ['claude.local.md', true], ['.claude/.cc-writes/CLAUDE.md', false]];
  for (const [f, resume] of cases) {
    refused(await attempt({ resume, files: { [f]: '{}' } }), new RegExp(`has ${f.split('/')[0].replaceAll('.', '\\.')}: agent-planted config, remove by hand`, 'i')); // APFS: any case
  }
  const ok = await attempt({ files: { 'out/claude.ts': 'x', 'notes.md': 'x' } });
  assert.equal(ok.err, undefined, 'look-alikes are not config');
  assert.equal((await attempt({ files: { '.claude/.cc-writes/tmp': 'x' } })).err, undefined, "claude's own sandbox write staging (2.1.295) is not planted");
  refused(await attempt({ files: { '.claude/.cc-writes/tmp': 'x', '.claude/settings.json': '{}' } }), /has \.claude: agent-planted config/);
});

test('S1 worktree as cwd: config changed since base_sha (tracked, untracked, ignored, nested, committed) or no base_sha refuses; the base\'s own config runs', async () => {
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
  const put = (f, c = 'x') => { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), c); };
  git('init', '-q');
  put('.claude/settings.json', '{}');
  put('CLAUDE.md', 'repo notes');
  put('.gitignore', 'ignored/\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base_sha = git('rev-parse', 'HEAD');
  put('src/a.js'); // dirty, but no config
  put('.claude/.cc-writes/tmp'); // claude's own sandbox write staging (2.1.295), untracked
  const ok = await attempt({ ticket: { worktree: wt, base_sha } });
  assert.equal(ok.err, undefined, 'unchanged base config + other dirty files run');
  assert.equal(fs.realpathSync(ok.d.cwd), fs.realpathSync(wt));

  refused(await attempt({ ticket: { worktree: wt } }), /ticket\.base_sha missing/);
  /** @type {[() => void, string][]} */
  const plants = [
    [() => put('.claude/settings.json', '{"hooks":{}}'), '.claude/settings.json'], // tracked, changed
    [() => put('pkg/.Claude/skills/x/SKILL.md'), 'pkg/.Claude/skills/x/SKILL.md'], // untracked, nested, other case
    [() => put('ignored/CLAUDE.local.md'), 'ignored/CLAUDE.local.md'], // ignored still counts
    [() => put('.claude/.cc-writes/sub/x.json'), '.claude/.cc-writes/sub/x.json'], // staging holds depth-1 files only
    [() => { put('lib/CLAUDE.md'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'agent'); }, 'lib/CLAUDE.md'],
  ];
  for (const [plant, f] of plants) {
    plant();
    refused(await attempt({ ticket: { worktree: wt, base_sha } }), new RegExp(`${f.replaceAll('.', '\\.')}.*agent-planted config, remove by hand`));
    git('reset', '-q', '--hard', base_sha);
    git('clean', '-qfdx');
  }
});

// ---- P4 fix lane B2 (security review S1 S4) -------------------------------------------------------------------------
const GENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// A tag repo with one commit and a worktree detached at it, as assign makes them: {repo, wt, t (the ticket's git fields)}.
function tagRepo() {
  const root = fs.mkdtempSync(path.join(ROOT, 'tag-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base_sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, base_sha);
  const t = { worktree: wt, base_sha, git_dir: fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir')), common_dir: fs.realpathSync(path.join(repo, '.git')) };
  return { root, repo, wt, t };
}

test('S1 git dirs pinned: commondir rewritten to a copy whose config has a clean filter → dirtyPaths and the planted check refuse git before it runs (unpinned it does run)', async () => {
  const { root, repo, wt, t } = tagRepo();
  const marker = path.join(root, 'filter-ran');
  const evil = path.join(root, 'evil');
  fs.cpSync(path.join(repo, '.git'), evil, { recursive: true }); // the agent's copy of the common dir, its filter runs code
  fs.appendFileSync(path.join(evil, 'config'), `[filter "x"]\n\tclean = touch ${marker} && cat\n`);
  fs.writeFileSync(path.join(t.git_dir, 'commondir'), `${evil}\n`);
  fs.writeFileSync(path.join(wt, '.gitattributes'), '* filter=x\n');
  const touch = () => fs.utimesSync(path.join(wt, 'a.txt'), new Date(), new Date(Date.now() + 3_600_000)); // git must hash it again
  touch();
  // final verify (contract change; was: git ran pinned and listed ?? .gitattributes): git 2.50 still reads refs via the
  // commondir file, so tbd refuses git when it does not lead to the recorded common_dir (fail closed: Blocked / refused)
  await assert.rejects(spawn.dirtyPaths(t), /commondir leads to /);
  await assert.rejects(spawn.plantedConfig(t, wt, path.join(root, 'ticket'), process.env), /commondir leads to/);
  assert.equal(fs.existsSync(marker), false, 'pinned: the planted filter never ran');
  touch();
  await spawn.dirtyPaths({ worktree: wt }); // control: a ticket from before the fix (no git_dir) reads commondir
  assert.equal(fs.existsSync(marker), true, 'unpinned: the planted filter runs (the attack is real)');
  // git strips only the trailing newline: `../.. ` (a space) is another dir an agent can make → refused, not trimmed
  fs.mkdirSync(path.join(path.dirname(t.git_dir), '.. '));
  fs.writeFileSync(path.join(t.git_dir, 'commondir'), '../.. \n');
  await assert.rejects(spawn.dirtyPaths(t), (/** @type {any} */ e) => /commondir leads to /.test(e.message) && e.code === 'PLANTED');
  // a link first, then `..`: git follows L (→ evil/a/b/c) before the dots, so this is evil/, not the common dir
  fs.mkdirSync(path.join(evil, 'a', 'b', 'c'), { recursive: true });
  fs.symlinkSync(path.join(evil, 'a', 'b', 'c'), path.join(t.git_dir, 'L'));
  fs.writeFileSync(path.join(t.git_dir, 'commondir'), 'L/../../..\n');
  await assert.rejects(spawn.dirtyPaths(t), (/** @type {any} */ e) => /commondir leads to /.test(e.message) && e.code === 'PLANTED');
});

// ---- H2.2 clone pin (replaces D-0046 for clones) --------------------------------------------------------------------
// A tag repo with one commit and the ticket's own clone of it, as assign makes it (util.cloneAt): {root, wt, t, git}.
async function tagClone() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'clone-')));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base_sha = git(repo, 'rev-parse', 'HEAD');
  const common_dir = path.join(repo, '.git');
  const t = { worktree: wt, base_sha, common_dir, ...(await require('../lib/util').cloneAt(common_dir, wt, base_sha)) };
  return { root, wt, t, git };
}

test('H2.2 clone pin: a cloneAt clone (own .git dir, no refs, HEAD at base, alternates = the tag objects, tb agent ident, config hash) runs git pinned; a planted commondir, an edited config (its filter never runs), a changed alternates file or .git swapped for a link to an exact copy → PLANTED, git refused', async () => {
  const { wt, t, git } = await tagClone();
  assert.ok(fs.lstatSync(path.join(wt, '.git')).isDirectory());
  assert.deepEqual([git(wt, 'for-each-ref'), git(wt, 'rev-parse', 'HEAD')], ['', t.base_sha], 'no branch, remote-tracking ref or tag; HEAD at base');
  assert.equal(fs.readFileSync(path.join(t.git_dir, 'objects/info/alternates'), 'utf8'), `${t.common_dir}/objects\n`);
  assert.deepEqual([git(wt, 'config', 'user.name'), git(wt, 'config', 'user.email')], ['tb agent', 'tb-agent@localhost']);
  assert.equal(git(wt, 'remote'), '', 'C-L3: no remote (an agent fetches nothing from the tag repo)');
  assert.equal(t.clone.config, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(t.git_dir, 'config'))).digest('hex'));
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  assert.deepEqual(await spawn.dirtyPaths(t), ['?? b.txt']);
  /** @type {[RegExp, (c: any) => void][]} */
  const rows = [
    [/commondir exists/, (c) => fs.writeFileSync(path.join(c.t.git_dir, 'commondir'), `${c.t.common_dir}\n`)],
    [/config is not the one tbd wrote/, (c) => {
      fs.appendFileSync(path.join(c.t.git_dir, 'config'), `[filter "x"]\n\tclean = touch ${c.root}/filter-ran && cat\n`);
      fs.writeFileSync(path.join(c.wt, '.gitattributes'), '* filter=x\n');
      fs.utimesSync(path.join(c.wt, 'a.txt'), new Date(), new Date(Date.now() + 3_600_000)); // git must hash it again
    }],
    [/alternates does not name only/, (c) => fs.appendFileSync(path.join(c.t.git_dir, 'objects/info/alternates'), `${c.root}/evil/objects\n`)],
    [/is not a directory/, (c) => {
      fs.cpSync(c.t.git_dir, path.join(c.wt, '.g'), { recursive: true });
      fs.rmSync(c.t.git_dir, { recursive: true });
      fs.symlinkSync(path.join(c.wt, '.g'), c.t.git_dir);
    }],
    // S-H1: a state file git parses as text (its errors quote a line) linked to a file of Irfan's: never read by tbd's git
    [/packed-refs is a link or not a plain file/, (c) => {
      fs.rmSync(path.join(c.t.git_dir, 'packed-refs'), { force: true });
      fs.symlinkSync(path.join(c.root, 'secret'), path.join(c.t.git_dir, 'packed-refs'));
    }],
    [/packed-refs is a link or not a plain file/, (c) => { // a hard link: a plain file, 2 links
      fs.rmSync(path.join(c.t.git_dir, 'packed-refs'), { force: true });
      fs.linkSync(path.join(c.root, 'secret'), path.join(c.t.git_dir, 'packed-refs'));
    }],
    [/sequencer holds a link or not a plain file/, (c) => {
      fs.mkdirSync(path.join(c.t.git_dir, 'sequencer'));
      fs.symlinkSync(path.join(c.root, 'secret'), path.join(c.t.git_dir, 'sequencer', 'todo'));
    }],
  ];
  for (const [why, plant] of rows) {
    const c = await tagClone();
    fs.writeFileSync(path.join(c.root, 'secret'), 'tok_S3CR3T_LINE\n');
    plant(c);
    await assert.rejects(spawn.dirtyPaths(c.t), (/** @type {any} */ e) => e.code === 'PLANTED' && why.test(e.message) && !e.message.includes('S3CR3T'), String(why));
    assert.equal(fs.existsSync(path.join(c.root, 'filter-ran')), false, 'nothing ran');
  }
  // S-H1 (A09): a pinned clone git that fails never hands its stderr on (it may quote a file of Irfan's): exit code + a fixed word
  const c = await tagClone();
  const r = await require('../lib/util').git(c.wt, ['ls-tree', 'tok_S3CR3T_ARG'], { dirs: c.t });
  assert.deepEqual([r.stderr, r.err.message, r.err.code], ['git exit 128: pin/ref error', 'git exit 128: pin/ref error', 128]);
  const u = await require('../lib/util').git(c.wt, ['ls-tree', 'tok_S3CR3T_ARG'], {}); // unpinned (tbd's own repo): as before
  assert.match(u.stderr, /tok_S3CR3T_ARG/);
});

test('S4 a .gitmodules path that leads out of the worktree through a link (the leaf or a folder on the way) → refused by name, the outside never walked', async () => {
  const { root, wt, t } = tagRepo();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
  for (const f of ['CLAUDE.md', 'sub/CLAUDE.md']) fs.writeFileSync(path.join(outside, f), 'planted\n');
  fs.symlinkSync(outside, path.join(wt, 'link'));
  fs.symlinkSync(outside, path.join(wt, 'a'));
  fs.writeFileSync(path.join(wt, '.gitmodules'), '[submodule "l"]\n\tpath = link\n\turl = ./l\n[submodule "s"]\n\tpath = a/sub\n\turl = ./s\n');
  assert.deepEqual((await spawn.plantedConfig(t, wt, path.join(root, 'ticket'), process.env)).sort(),
    ['.gitmodules: a/sub (leads outside the worktree)', '.gitmodules: link (leads outside the worktree)']);
});

// M5 C2 (D-0085): the rules reach every code run through its system prompt; the repo's own CLAUDE.md through the cwd
test('M5 C2 a code run: runs/<n>.system.md (0600) = the phase prompt + \\n\\n + phases/_rules.md, passed as --append-system-prompt-file; the repo\'s own CLAUDE.md (tracked at base_sha) is not refused and loads (cwd = worktree, --setting-sources project)', async () => {
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', wt, ...a], { env: GENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), '# repo conventions\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const { d, ticketDir } = await run({ resume: false, ticket: { worktree: wt, base_sha: git('rev-parse', 'HEAD') } });
  const sys = path.join(ticketDir, 'runs/2.system.md');
  assert.equal(d.opts['--append-system-prompt-file'], sys);
  assert.equal(fs.readFileSync(sys, 'utf8'), `# working fixture\n\n\n${fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md'), 'utf8')}`);
  assert.equal(fs.statSync(sys).mode & 0o777, 0o600);
  assert.equal(fs.realpathSync(d.cwd), fs.realpathSync(wt));
  assert.equal(d.opts['--setting-sources'], 'project', 'claude loads the cwd CLAUDE.md');
});

// M5 C5 C7: the tag's env files are Edit- and sandbox-write-denied in working and qa runs (the copy the app reads = the
// file the DB guard checked; P5 M1 was working only); a review run never writes, its settings name none
test('M5 C5 env files: working and qa runs deny Edit + sandbox write of the tag env_files; a review run has no such rule', async () => {
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', wt, ...a], { env: GENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  const per = (v) => Object.fromEntries(['qa', 'review'].map((p) => [p, v]));
  const config = { ...CONFIG, models: { ...CONFIG.models, ...per({ model: 'opus', effort: 'xhigh' }) }, max_turns: { ...CONFIG.max_turns, ...per(40) },
    liveness: { wall_min: { ...CONFIG.liveness.wall_min, ...per(30) } } };
  for (const phase of ['working', 'qa', 'review']) {
    const { ticketDir } = await run({ phase, config, resume: false, ticket: { worktree: wt, base_sha: git('rev-parse', 'HEAD') }, tag: { env_files: ['.env.test'] } });
    const s = JSON.parse(fs.readFileSync(path.join(ticketDir, 'runs/2.settings.json'), 'utf8'));
    const denied = [s.permissions.deny.includes(`Edit(/${wt}/.env.test)`), s.sandbox.filesystem.denyWrite.includes(`${wt}/.env.test`)];
    assert.deepEqual(denied, phase === 'review' ? [false, false] : [true, true], phase);
    // C-H1: a worktree with no clone (from before H2) is rendered CLONE false: working keeps the tag .git's commit paths
    const tg = path.join(path.dirname(path.dirname(ticketDir)), 'no-tag', '.git');
    assert.deepEqual([tg, `${tg}/config`].map((p) => s.sandbox.filesystem.denyWrite.includes(p)), [phase !== 'working', phase === 'working'], `${phase}: legacy tag .git`);
  }
});

// M5 C11 G9: the final review never runs on review's model: models.final_gate when it differs (the default: opus vs
// fable), else the first of opus, fable (billing ok), sonnet that differs; the runner's lease, the argv and t:run all ask
// modelFor (the argv case: test/final.test.js F1)
test('M5 C11 G9 finalModel: configured final model kept when it is not review\'s; same as review → opus, fable (billing ok), sonnet, the first that differs', () => {
  const cfg = (review, final, billing = 'plan') => ({ fable_billing: billing, models: { review, final_gate: final } });
  const pick = (c) => spawn.modelFor(c, 'final_gate').model;
  assert.equal(pick(cfg({ model: 'fable' }, { model: 'opus', effort: 'xhigh' })), 'opus', 'the defaults: kept');
  assert.equal(pick(cfg({ model: 'opus' }, { model: 'opus' })), 'fable', 'review opus, billing ok → fable');
  assert.equal(pick(cfg({ model: 'opus' }, { model: 'opus' }, 'unknown')), 'sonnet', 'review opus, no fable billing → sonnet');
  assert.equal(pick(cfg({ model: 'fable' }, { model: 'fable' }, 'unknown')), 'sonnet', 'both fable without billing run as opus: still not the same model');
  assert.deepEqual(spawn.modelFor(cfg({ model: 'opus' }, { model: 'opus', effort: 'xhigh' }), 'final_gate'), { model: 'fable', effort: 'xhigh', fable: true });
  assert.equal(spawn.modelFor(cfg({ model: 'opus' }, { model: 'opus' }), 'final_gate', true).model, 'opus', 'a Fable refusal\'s opus re-run stays opus (U7)');
});

// start()'s flags that belong to one run, not to its isolation (session, prompts, dirs, model, caps, output): every
// other flag start() emits must come from isolationArgv too. A list, not derived: start()'s argv marks no flag as
// isolation (AN1: it stays as is), so a new start() flag fails the test below until it goes in isolationArgv or here.
const PER_RUN_FLAGS = ['-p', '--session-id', '--resume', '--append-system-prompt-file', '--add-dir', '--model', '--effort', '--fallback-model',
  '--max-turns', '--json-schema', '--output-format', '--verbose', '--include-partial-messages'];
test('isolationArgv (golden-working --blind) drifts from start() never: every pair it returns is in start()\'s argv, and every isolation flag start() emits is in it', async () => {
  const { d } = await run();
  const iso = spawn.isolationArgv({ settings: d.opts['--settings'], mcp: d.opts['--mcp-config'], tools: d.opts['--tools'].split(',') });
  const pairs = iso.flatMap((x, i) => (!x.startsWith('--') ? [] : [iso[i + 1]?.startsWith('--') === false ? [x, iso[i + 1]] : [x]]));
  assert.deepEqual(pairs.map((p) => p[0]), ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--tools', '--permission-mode', '--permission-prompts'], 'phase allows Agent: no --disallowedTools');
  assert.deepEqual(pairs.filter((p) => !d.argv.some((x, i) => x === p[0] && (p.length === 1 || d.argv[i + 1] === p[1]))), []);
  assert.deepEqual(d.argv.filter((x) => x.startsWith('-') && !PER_RUN_FLAGS.includes(x) && !iso.includes(x)), [], 'start() isolation flag missing from isolationArgv');
});
