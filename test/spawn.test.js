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
// full-access-runs Phase 3 + 4: read-only phases (no bare Bash allow), as planning / review / final_gate / context are
for (const ph of ['context', 'planning']) {
  for (const [file, content] of Object.entries({ 'prompt.md': `# ${ph} fixture\n`, 'result.schema.json': JSON.stringify(SCHEMA),
    'settings.json': JSON.stringify({ permissions: { allow: ['Read', 'Glob', 'Grep', 'Bash(git log *)'] } }) })) {
    fs.mkdirSync(path.join(PHASES, 'code', ph), { recursive: true });
    fs.writeFileSync(path.join(PHASES, 'code', ph, file), content);
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
    return { d: JSON.parse(fs.readFileSync(path.join(dump, '1.json'), 'utf8')), ticketDir, dump, mcp: s.mcp_stdio };
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
  assert.equal(d.opts['--tools'], 'Read,Glob,Grep,Edit,Write,Bash,Agent,Skill,Task', 'full access: Skill + Task (2.1.302 Agent name) too (full-access-runs Phase 4 contract change)');
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
  // full-access-runs Phase 3 (contract change): the locked run (sandbox: true) keeps --setting-sources project + _rules.md
  const { d, ticketDir } = await run({ resume: false, ticket: { worktree: wt, base_sha: git('rev-parse', 'HEAD'), sandbox: true } });
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
  // full-access-runs Phase 4 (contract change): the rule holds only with final_distinct: true (default false)
  const cfg = (review, final, billing = 'plan') => ({ fable_billing: billing, final_distinct: true, models: { review, final_gate: final } });
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
  const { d } = await run({ ticket: { sandbox: true } }); // full-access-runs Phase 3 (contract change): the locked run
  const iso = spawn.isolationArgv({ settings: d.opts['--settings'], mcp: d.opts['--mcp-config'], tools: d.opts['--tools'].split(',') });
  const pairs = iso.flatMap((x, i) => (!x.startsWith('--') ? [] : [iso[i + 1]?.startsWith('--') === false ? [x, iso[i + 1]] : [x]]));
  assert.deepEqual(pairs.map((p) => p[0]), ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--tools', '--permission-mode', '--permission-prompts'], 'phase allows Agent: no --disallowedTools');
  assert.deepEqual(pairs.filter((p) => !d.argv.some((x, i) => x === p[0] && (p.length === 1 || d.argv[i + 1] === p[1]))), []);
  assert.deepEqual(d.argv.filter((x) => x.startsWith('-') && !PER_RUN_FLAGS.includes(x) && !iso.includes(x)), [], 'start() isolation flag missing from isolationArgv');
});

// ---- full-access-runs Phase 3: full access by default, the Sandbox toggle = the locked run ---------------------------
const RO_CONFIG = { ...CONFIG, models: { ...CONFIG.models, context: { model: 'opus', effort: 'xhigh' } }, max_turns: { ...CONFIG.max_turns, context: 40 },
  liveness: { wall_min: { ...CONFIG.liveness.wall_min, context: 30 } } };
// A tag main checkout (with .learning/ and the two local files) and a HOME with the live global rules + user skills
function fullFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'full-')));
  const tag = path.join(root, 'tag');
  const home = path.join(root, 'home');
  for (const d of [path.join(tag, '.learning'), path.join(tag, '.claude'), path.join(home, '.claude', 'skills')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(tag, 'CLAUDE.local.md'), 'canary-local\n');
  fs.writeFileSync(path.join(tag, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# global rules\n');
  return { tag, home, learning: path.join(tag, '.learning') };
}
const settingsOf = (ticketDir) => JSON.parse(fs.readFileSync(path.join(ticketDir, 'runs/2.settings.json'), 'utf8'));
const LOCKED_SETTINGS = (s) => s.sandbox.enabled === true && s.sandbox.failIfUnavailable === true && !('enabledPlugins' in s);

test('full access (default): user + project + local sources, no --strict-mcp-config, seatbelt off, OMC off, ssh + .env read denies, learning DB (dir, env, Edit in working), board note, global sha; path-guard roots recomputed', async () => {
  const f = fullFixture();
  const { d, ticketDir } = await run({ resume: false, tag: { path: f.tag, skills: ['extra-skill'], skills_off: ['caveman'] }, env: { HOME: f.home } });
  assert.equal(d.opts['--setting-sources'], 'user,project,local');
  assert.equal(d.argv.includes('--strict-mcp-config'), false);
  assert.equal(d.opts['--mcp-config'], path.join(PHASES, 'code/working/mcp.json'), 'a phase with its own mcp.json keeps it');
  assert.deepEqual(d.opts['--add-dir'], [path.join(ticketDir, 'skills'), f.learning, path.join(f.home, '.claude', 'skills')]);
  assert.deepEqual([d.env.LEARNING_DIR, d.env.DISABLE_OMC, d.env.GIT_CONFIG_GLOBAL, d.env.GIT_CONFIG_NOSYSTEM, d.env.TB_FULL_ACCESS], [f.learning, '1', '/dev/null', '1', '1']);
  assert.deepEqual([d.env.SSH_AUTH_SOCK, d.env.CAVEMAN_DEFAULT_MODE], ['', 'caveman'], 'no ssh agent in the run env; caveman normal level');
  const s = settingsOf(ticketDir);
  assert.equal(s.sandbox.enabled, false);
  assert.equal('failIfUnavailable' in s.sandbox, false);
  assert.deepEqual(s.enabledPlugins, { 'oh-my-claudecode@omc': false });
  for (const r of ['Read(~/.ssh/**)', 'Read(~/**/.env*)', 'Read(**/.env*)', 'Read(//**/.env*)', 'Edit(~/.claude/**)', 'Bash(git push *)']) assert.ok(s.permissions.deny.includes(r), r);
  assert.equal(s.agentsMd, 'claude-md-and-agents-md');
  assert.ok(s.permissions.allow.includes(`Edit(/${f.learning}/**)`), 'working may save /learning');
  assert.equal(s.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '3');
  const sys = fs.readFileSync(path.join(ticketDir, 'runs/2.system.md'), 'utf8');
  // Phase 4: the effective list (board defaults + tag adds − tag removes) and the removals as "do not use"
  const skills = 'learning, grilling, lavish, test-engineer-irfan, tdd, codebase-design, postgres-irfan-axi, chrome-devtools-axi, ponytail, frontend-design, extra-skill';
  assert.equal(sys, `# working fixture\n\n\n${fs.readFileSync(path.join(__dirname, '..', 'phases', '_board.md'), 'utf8')}\n\ndefault skills for this board: ${skills}\ndo not use: caveman\n`);
  // path-guard with the roots the run got: the main DB writable, Claude config under it not
  const { check } = require('../hooks/path-guard');
  const edit = (p) => check({ cwd: d.cwd, tool_name: 'Write', tool_input: { file_path: p } }, s.env);
  assert.equal(edit(path.join(f.learning, 'SESSIONS.md')), null);
  assert.equal(edit(path.join(f.learning, '.claude', 'x'))?.permissionDecision, 'deny');
});

// board-terminal-parity task 5: the /names Irfan typed (t.skills_asked) join the board note, right after the default skills
test('full access: skills Irfan asked for on the ticket (skills_asked) → one line in system.md after the default skills; a locked run → no line', async () => {
  const f = fullFixture();
  const { ticketDir } = await run({ resume: false, ticket: { skills_asked: ['tdd', 'shop:deploy'] }, tag: { path: f.tag }, env: { HOME: f.home } });
  const defaults = 'learning, grilling, lavish, test-engineer-irfan, tdd, codebase-design, postgres-irfan-axi, chrome-devtools-axi, caveman, ponytail, frontend-design';
  assert.equal(fs.readFileSync(path.join(ticketDir, 'runs/2.system.md'), 'utf8'), `# working fixture\n\n\n${fs.readFileSync(path.join(__dirname, '..', 'phases', '_board.md'), 'utf8')}\n\ndefault skills for this board: ${defaults}\nIrfan asked for these skills on this ticket: /tdd, /shop:deploy. Use them where they fit.\n`);
  // a locked run (Sandbox on): the rules only, no asked line (D-0217)
  const locked = await run({ resume: false, ticket: { sandbox: true, skills_asked: ['tdd'] }, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.equal(fs.readFileSync(path.join(locked.ticketDir, 'runs/2.system.md'), 'utf8'), `# working fixture\n\n\n${fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md'), 'utf8')}`);
});

test('full access, read-only phase: rtk git reads + learn find allowed, the user allow list\'s bash / node / npx denied, no Edit on the DB; no global rules → _rules.md', async () => {
  const f = fullFixture();
  fs.rmSync(path.join(f.home, '.claude', 'CLAUDE.md'));
  const { d, ticketDir } = await run({ phase: 'context', config: RO_CONFIG, resume: false, tag: { path: f.tag }, env: { HOME: f.home } });
  const s = settingsOf(ticketDir);
  for (const r of ['Bash(rtk git log *)', 'Bash(rtk git show *)', 'Bash(rtk git diff *)', 'Bash(rtk git status *)', 'Bash(learn find *)']) assert.ok(s.permissions.allow.includes(r), r);
  for (const r of ['Bash(bash:*)', 'Bash(node:*)', 'Bash(npx:*)', `Edit(/${f.learning}/**)`]) assert.ok(s.permissions.deny.includes(r), r);
  assert.equal(s.permissions.allow.some((r) => r.startsWith('Edit')), false);
  assert.equal(d.opts['--tools'], 'Read,Glob,Grep,Bash,Skill', 'Skill in every code phase; context is no agent phase: no Agent');
  const defaults = 'learning, grilling, lavish, test-engineer-irfan, tdd, codebase-design, postgres-irfan-axi, chrome-devtools-axi, caveman, ponytail, frontend-design';
  assert.equal(fs.readFileSync(path.join(ticketDir, 'runs/2.system.md'), 'utf8'), `# context fixture\n\n\n${fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md'), 'utf8')}\n\ndefault skills for this board: ${defaults}\n`);
});

test('Sandbox toggle (sandbox: true): the locked argv and settings, none of the full-access extras', async () => {
  const f = fullFixture();
  const { d, ticketDir } = await run({ resume: false, ticket: { sandbox: true }, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.deepEqual([d.opts['--setting-sources'], d.argv.includes('--strict-mcp-config'), d.opts['--add-dir']], ['project', true, [path.join(ticketDir, 'skills')]]);
  for (const k of ['LEARNING_DIR', 'DISABLE_OMC', 'GIT_CONFIG_GLOBAL', 'TB_FULL_ACCESS', 'TB_LAST_TASK', 'SSH_AUTH_SOCK', 'CAVEMAN_DEFAULT_MODE']) assert.equal(k in d.env, false, k);
  assert.equal('agentsMd' in settingsOf(ticketDir), false);
  const s = settingsOf(ticketDir);
  assert.ok(LOCKED_SETTINGS(s));
  assert.equal(s.permissions.deny.includes('Read(**/.env*)'), false);
  assert.equal(fs.readFileSync(path.join(ticketDir, 'runs/2.system.md'), 'utf8').endsWith(fs.readFileSync(path.join(__dirname, '..', 'phases', '_rules.md'), 'utf8')), true);
});

test('full access drops or changes exactly these locked pairs: --setting-sources, --strict-mcp-config, --mcp-config (none without a phase mcp.json)', async () => {
  const f = fullFixture();
  const both = await Promise.all([true, false].map((sandbox) => run({ phase: 'context', config: RO_CONFIG, resume: false, ticket: { sandbox }, tag: { path: f.tag }, env: { HOME: f.home } })));
  const pairs = (/** @type {any} */ { d }) => d.argv.flatMap((x, i) => (x.startsWith('--') && !PER_RUN_FLAGS.includes(x) ? [`${x} ${d.argv[i + 1]?.startsWith('--') === false ? d.argv[i + 1].replace(/\/[^ ]*runs\//, 'runs/') : ''}`.trim()] : []));
  const [locked, full] = both.map(pairs);
  assert.deepEqual(locked.filter((x) => !full.includes(x)), ['--setting-sources project', '--strict-mcp-config', `--mcp-config runs/2.mcp.json`, '--tools Read,Glob,Grep,Bash']);
  assert.deepEqual(full.filter((x) => !locked.includes(x)), ['--setting-sources user,project,local', '--tools Read,Glob,Grep,Bash,Skill'], 'Phase 4: Skill');
  assert.equal(fs.existsSync(path.join(both[1].ticketDir, 'runs/2.mcp.json')), false, 'no empty mcp file: user + plugin servers load');
});

test('TB_LAST_TASK: working on the last pending plan task only; another task pending, a review fix task (@rv) or a sandbox run → unset', async () => {
  const work = (task, tasks) => ({ work: { task, tasks: tasks.map(([id, status]) => ({ id, status })) } });
  const env = async (ticket) => (await run({ resume: false, ticket })).d.env.TB_LAST_TASK;
  assert.equal(await env(work('T2', [['T1', 'done'], ['T2', 'running']])), '1');
  assert.equal(await env(work('T2', [['T1', 'done'], ['T2', 'running'], ['T3', 'pending']])), undefined);
  assert.equal(await env(work('T2@rv1', [['T1', 'done'], ['T2', 'done'], ['T2@rv1', 'running']])), undefined);
  assert.equal(await env({ ...work('T2', [['T2', 'running']]), sandbox: true }), undefined);
});

test('local copies: CLAUDE.local.md + .claude/settings.local.json copied fresh into the clone (0600, hash-pinned, git-excluded: dirtyPaths []); a changed copy or extra .claude content refused; a sandbox start removes them', async () => {
  const f = fullFixture();
  const { wt, t } = await tagClone();
  const ok = await run({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } });
  const copies = JSON.parse(fs.readFileSync(path.join(ok.ticketDir, 'runs/2.local.json'), 'utf8'));
  assert.deepEqual(Object.keys(copies).sort(), ['.claude/settings.local.json', 'CLAUDE.local.md']);
  assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.local.md'), 'utf8'), 'canary-local\n');
  assert.equal(fs.statSync(path.join(wt, '.claude', 'settings.local.json')).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(t.git_dir, 'info', 'exclude'), 'utf8'), /^# tbd local copies\n\/CLAUDE\.local\.md\n\/\.claude\/settings\.local\.json$/m);
  assert.deepEqual(await spawn.dirtyPaths(t), []);
  // hash pin (plantedConfig with the recorded copies): changed content, or .claude holding more than the copies
  fs.appendFileSync(path.join(wt, 'CLAUDE.local.md'), 'planted\n');
  assert.deepEqual(await spawn.plantedConfig(t, wt, ok.ticketDir, GENV, copies), ['CLAUDE.local.md']);
  fs.writeFileSync(path.join(wt, 'CLAUDE.local.md'), 'canary-local\n');
  fs.writeFileSync(path.join(wt, '.claude', 'extra.json'), '{}');
  fs.appendFileSync(path.join(t.git_dir, 'info', 'exclude'), '/.claude/extra.json\n'); // ignored too: .claude is one ignored dir
  assert.deepEqual(await spawn.plantedConfig(t, wt, ok.ticketDir, GENV, copies), ['.claude', '.claude/extra.json'], 'git lists the ignored dir and its files');
  fs.rmSync(path.join(wt, '.claude', 'extra.json'));
  fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), '{}'); // untracked, not excluded
  refused(await attempt({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } }), /\.claude\/settings\.json: agent-planted config/);
  fs.rmSync(path.join(wt, '.claude', 'settings.json'));
  // the Sandbox toggle: stale copies go before the locked run's planted check
  const locked = await attempt({ resume: false, ticket: { ...t, sandbox: true }, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.equal(locked.err, undefined);
  assert.deepEqual([fs.existsSync(path.join(wt, 'CLAUDE.local.md')), fs.existsSync(path.join(wt, '.claude', 'settings.local.json'))], [false, false]);
  // review LOW: a tag file deleted since the last full-access run leaves no stale copy for the planted check to refuse
  assert.equal((await attempt({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } })).err, undefined);
  fs.rmSync(path.join(f.tag, 'CLAUDE.local.md'));
  assert.equal((await attempt({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } })).err, undefined);
  assert.deepEqual([fs.existsSync(path.join(wt, 'CLAUDE.local.md')), fs.existsSync(path.join(wt, '.claude', 'settings.local.json'))], [false, true]);
  // review LOW: a dir planted where a copy goes is refused as planted (Blocked at once), not a generic start error
  fs.mkdirSync(path.join(wt, '.claude', 'settings.local.json.d'));
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  fs.renameSync(path.join(wt, '.claude', 'settings.local.json.d'), path.join(wt, '.claude', 'settings.local.json'));
  const dir = await attempt({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.deepEqual([dir.err?.code, /settings\.local\.json is not a file/.test(dir.err?.message ?? '')], ['PLANTED', true]);
});

// ---- full-access-runs Phase 4: Skill + Agent, the subagent cap, the final_distinct knob -------------------------------
test('Phase 4 planning: full access allows Skill + Agent (+ its 2.1.302 name Task; no --disallowedTools) with the default cap 2 (env + settings env); sandbox: no Agent, Skill only once a skill was copied', async () => {
  const { DEFAULTS } = require('../lib/store');
  const config = { ...CONFIG, subagents: DEFAULTS.subagents, models: { planning: DEFAULTS.models.planning }, max_turns: { planning: DEFAULTS.max_turns.planning },
    liveness: { wall_min: { planning: 30 } } };
  const full = await run({ phase: 'planning', config, resume: false });
  assert.deepEqual([full.d.opts['--tools'], full.d.argv.includes('--disallowedTools')], ['Read,Glob,Grep,Bash,Skill,Agent,Task', false]);
  assert.deepEqual([full.d.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, settingsOf(full.ticketDir).env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS], ['2', '2']);
  assert.deepEqual([full.d.opts['--model'], full.d.opts['--effort']], ['opus', 'xhigh'], 'decision 7: opus xhigh by default');
  const locked = await run({ phase: 'planning', config, resume: false, ticket: { sandbox: true } });
  assert.deepEqual([locked.d.opts['--tools'], locked.d.opts['--disallowedTools']], ['Read,Glob,Grep,Bash', 'Agent']);
  const copied = await run({ phase: 'planning', config, resume: false, ticket: { sandbox: true }, files: { 'skills/.claude/skills/tdd/SKILL.md': '# tdd\n' } });
  assert.deepEqual([copied.d.opts['--tools'], copied.d.opts['--disallowedTools']], ['Read,Glob,Grep,Bash,Skill', 'Agent']);
});

test('Phase 4 finalModel: final_distinct false (default) keeps the configured final model even when it is review\'s; true moves it off', () => {
  const models = { review: { model: 'opus', effort: 'xhigh' }, final_gate: { model: 'opus', effort: 'xhigh' } };
  assert.deepEqual(spawn.modelFor({ fable_billing: 'plan', models }, 'final_gate'), { model: 'opus', effort: 'xhigh', fable: false });
  assert.deepEqual(spawn.modelFor({ fable_billing: 'plan', final_distinct: true, models }, 'final_gate'), { model: 'fable', effort: 'xhigh', fable: true });
});

// Phase 1 fact (2.1.302 -p skips AGENTS.md beside a CLAUDE.md): full access appends the base commit's AGENTS.md
test('AGENTS.md beside CLAUDE.md at the base commit: a full-access run gets the base version in its system prompt (a worktree edit: refused as planted); a sandbox run or a repo without CLAUDE.md does not', async () => {
  const mk = (files) => {
    const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
    const git = (...a) => execFileSync('/usr/bin/git', ['-C', wt, ...a], { env: GENV, encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), c);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
    return { worktree: wt, base_sha: git('rev-parse', 'HEAD') };
  };
  const sys = async (ticket) => fs.readFileSync(path.join((await run({ resume: false, ticket })).ticketDir, 'runs/2.system.md'), 'utf8');
  const both = mk({ 'CLAUDE.md': '# repo\n', 'AGENTS.md': 'agents canary OSPREY\n' });
  const full = await sys(both);
  assert.ok(full.endsWith('\n# AGENTS.md (repo root, at the base commit)\n\nagents canary OSPREY\n'), full.slice(-200));
  // board-terminal-parity Phase 2 task 1 (contract change; was: a worktree edit runs, the prompt keeping the base
  // version): an AGENTS.md changed since base is agent-planted config, so the run is refused
  fs.writeFileSync(path.join(both.worktree, 'AGENTS.md'), 'planted by an earlier run\n');
  refused(await attempt({ resume: false, ticket: both }), /has AGENTS\.md: agent-planted config/);
  fs.writeFileSync(path.join(both.worktree, 'AGENTS.md'), 'agents canary OSPREY\n');
  assert.equal((await sys({ ...both, sandbox: true })).includes('# AGENTS.md'), false, 'sandbox: the locked run unchanged');
  assert.equal((await sys(mk({ 'AGENTS.md': 'agents only\n' }))).includes('# AGENTS.md'), false, 'no CLAUDE.md: claude loads AGENTS.md itself');
});

// security review LOW: a local file the tag repo tracks is never copied (exclude can't hide it) nor removed by a sandbox run
test('local copies: a path the clone tracks (CLAUDE.local.md committed) is left alone in full access and in sandbox mode; the untracked one is still copied', async () => {
  const f = fullFixture();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'clone-')));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const git = (cwd, ...a) => execFileSync('/usr/bin/git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), 'tracked notes\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base_sha = git(repo, 'rev-parse', 'HEAD');
  const common_dir = path.join(repo, '.git');
  const t = { worktree: wt, base_sha, common_dir, ...(await require('../lib/util').cloneAt(common_dir, wt, base_sha)) };
  const ok = await run({ resume: false, ticket: t, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(ok.ticketDir, 'runs/2.local.json'), 'utf8'))), ['.claude/settings.local.json']);
  assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.local.md'), 'utf8'), 'tracked notes\n');
  assert.deepEqual(await spawn.dirtyPaths(t), []);
  assert.equal((await attempt({ resume: false, ticket: { ...t, sandbox: true }, tag: { path: f.tag }, env: { HOME: f.home } })).err, undefined);
  assert.deepEqual([fs.existsSync(path.join(wt, 'CLAUDE.local.md')), fs.existsSync(path.join(wt, '.claude', 'settings.local.json'))], [true, false]);
});

// full-access wall (config full_access_wall; Phase 1b smoke full-light-v2m): the seatbelt stays on, widened for terminal
// tools, ~/.ssh + every .env* walled in both directions, the tag's copied env files re-allowed by exact path
test('full-access wall on: seatbelt on (fail closed), ~/.ssh + .env* + ~/.config/gh read- and write-denied, the copied env file re-allowed exactly, Postgres socket named (no allowAllUnixSockets), WebFetch through the proxy, tb-chrome in working only (excludedCommands + wall profile + note); wall off → seatbelt off; sandbox: true → locked', async () => {
  const f = fullFixture();
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', wt, ...a], { env: GENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  const ticket = { worktree: wt, base_sha: git('rev-parse', 'HEAD') };
  const tag = { path: f.tag, env_files: ['.env.test'], qa_ports: [3000, 5432] };
  const on = await run({ resume: false, config: { ...CONFIG, full_access_wall: true }, ticket, tag, env: { HOME: f.home } });
  const s = settingsOf(on.ticketDir);
  const fsb = s.sandbox.filesystem;
  assert.deepEqual([s.sandbox.enabled, s.sandbox.failIfUnavailable, s.sandbox.allowUnsandboxedCommands], [true, true, false]);
  for (const p of ['~/.ssh', '/**/.env*', '~/.config/gh']) assert.ok(fsb.denyRead.includes(p) && fsb.denyWrite.includes(p), p);
  for (const p of ['~/.git-credentials', '~/.netrc', '~/.aws']) assert.ok(fsb.denyRead.includes(p), p); // push credentials (review MED)
  assert.ok(fsb.allowRead.includes(`${wt}/.env.test`));
  assert.ok(fsb.allowWrite.includes('~/.npm') && fsb.denyWrite.includes('~/.claude*'));
  assert.deepEqual(s.sandbox.network.allowUnixSockets, [path.join(path.dirname(path.dirname(on.ticketDir)), 'tbd.sock'), '/tmp/.s.PGSQL.5432', '/private/tmp/.s.PGSQL.5432']);
  assert.equal('allowAllUnixSockets' in s.sandbox.network, false);
  assert.equal('blockReadsOutsideWorkingDirectories' in s.permissions, false);
  assert.ok(s.permissions.allow.includes('WebFetch(domain:*)') && s.permissions.deny.includes('Read(~/.ssh/**)'));
  // contract change (Chrome in runs, 2026-10-19; was: "browser checks ... are not available in this run"): the working run
  // gets bin/tb-chrome by full path in excludedCommands, its wall as a seatbelt profile and the note; planning gets neither
  const tbc = path.join(__dirname, '..', 'bin', 'tb-chrome');
  assert.deepEqual(s.sandbox.excludedCommands, [`${tbc} *`]);
  assert.equal(on.d.env.TB_CHROME_SB, path.join(on.ticketDir, 'runs/2.chrome.sb'));
  const [bport, cport] = on.d.env.TB_CHROME_PORTS.split(' ').map(Number);
  assert.deepEqual([cport - bport, bport >= 20000 && bport < 48000, on.d.env.TB_CHROME_NODE], [1, true, process.execPath]);
  const sb = fs.readFileSync(path.join(on.ticketDir, 'runs/2.chrome.sb'), 'utf8');
  const line = (start) => sb.split('\n').find((l) => l.startsWith(start)) ?? '';
  const real = (p) => JSON.stringify(fs.realpathSync(p)); // the seatbelt sees /private/var, not /var
  assert.ok(line('(deny file-read* ').includes(`(subpath ${JSON.stringify(path.join(f.home, '.ssh'))})`) && line('(deny file-read* ').includes(`(subpath ${real(path.dirname(path.dirname(on.ticketDir)))})`), sb.slice(0, 400));
  assert.ok(line('(allow file-read* ').includes(`(subpath ${real(wt)})`) && sb.includes(JSON.stringify(`${fs.realpathSync(wt)}/.env.test`)));
  // loopback: the ticket's two ports + the tag's qa ports, never Postgres (as the recorder)
  assert.equal(line('(allow network-outbound (remote ip '), `(allow network-outbound (remote ip "localhost:${bport}") (remote ip "localhost:${cport}") (remote ip "localhost:3000"))`);
  assert.ok(fs.readFileSync(path.join(on.ticketDir, 'runs/2.system.md'), 'utf8').includes(`\nbrowser checks: \`${tbc} <chrome-devtools-axi command>\``));
  const plan = await run({ phase: 'planning', resume: false, config: { ...CONFIG, full_access_wall: true, max_turns: { ...CONFIG.max_turns, planning: 5 }, liveness: { wall_min: { ...CONFIG.liveness.wall_min, planning: 30 } }, models: { ...CONFIG.models, planning: { model: 'opus' } } }, ticket, tag, env: { HOME: f.home } });
  assert.deepEqual(['excludedCommands' in settingsOf(plan.ticketDir).sandbox, fs.existsSync(path.join(plan.ticketDir, 'runs/2.chrome.sb')), plan.d.env.TB_CHROME_SB], [false, false, undefined]);
  assert.match(fs.readFileSync(path.join(plan.ticketDir, 'runs/2.system.md'), 'utf8'), /\nno browser checks in this step/);
  const off = settingsOf((await run({ resume: false, config: { ...CONFIG, full_access_wall: false }, ticket, tag, env: { HOME: f.home } })).ticketDir);
  assert.deepEqual([off.sandbox.enabled, off.permissions.blockReadsOutsideWorkingDirectories, off.permissions.allow.includes('WebFetch(domain:*)'), 'excludedCommands' in off.sandbox], [false, true, false, false]);
  const locked = await run({ resume: false, config: { ...CONFIG, full_access_wall: true }, ticket: { ...ticket, sandbox: true }, tag, env: { HOME: f.home } });
  assert.ok(LOCKED_SETTINGS(settingsOf(locked.ticketDir)));
  assert.equal(settingsOf(locked.ticketDir).sandbox.filesystem.denyRead.includes('~/.ssh'), false, 'the locked run is not widened');
  assert.equal(fs.readFileSync(path.join(locked.ticketDir, 'runs/2.system.md'), 'utf8').includes('chrome-devtools-axi'), false);
  assert.deepEqual(['excludedCommands' in settingsOf(locked.ticketDir).sandbox, fs.existsSync(path.join(locked.ticketDir, 'runs/2.chrome.sb'))], [false, false]);
});

// ---- board-terminal-parity Phase 2: containment, ~/.zshenv, Bash in every step, folder MCP ---------------------------
const TERM = { bash_all_steps: false, folder_mcp: false, git_bridge: false, auto_mode: false, task_tickets: false, page_tools: false, approve_min: 10 };
const PLAN_CONFIG = { ...CONFIG, max_turns: { ...CONFIG.max_turns, planning: 5 }, liveness: { wall_min: { ...CONFIG.liveness.wall_min, planning: 30 } }, models: { ...CONFIG.models, planning: { model: 'opus' } } };
const commitAll = (git) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'); return git('rev-parse', 'HEAD'); };

test('Phase 2 task 1: .mcp.json + AGENTS.md Edit- and write-denied at any depth, ~/.claude.json* + ~/.zshenv read-denied (wall + Read rule); S1 refuses an untracked .mcp.json (a changed AGENTS.md: the AGENTS.md test), a tracked one at base runs', async () => {
  const f = fullFixture();
  const wt = fs.mkdtempSync(path.join(ROOT, 'wt-'));
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', wt, ...a], { env: GENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(wt, '.mcp.json'), '{"mcpServers":{}}\n');
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# agents\n');
  const ticket = { worktree: wt, base_sha: commitAll(git) };
  const opts = { resume: false, config: { ...CONFIG, full_access_wall: true }, ticket, tag: { path: f.tag }, env: { HOME: f.home } };
  const s = settingsOf((await run(opts)).ticketDir); // tracked at base: runs
  for (const n of ['.mcp.json', 'AGENTS.md']) {
    for (const p of [`${wt}/${n}`, `${wt}/**/${n}`, `${f.tag}/**/${n}`]) assert.ok(s.permissions.deny.includes(`Edit(/${p})`) && s.sandbox.filesystem.denyWrite.includes(p), p);
  }
  for (const p of ['~/.claude.json*', '~/.zshenv']) assert.ok(s.sandbox.filesystem.denyRead.includes(p) && s.permissions.deny.includes(`Read(${p})`), p);
  fs.mkdirSync(path.join(wt, 'sub'));
  fs.writeFileSync(path.join(wt, 'sub', '.mcp.json'), '{"mcpServers":{"x":{"command":"/bin/sh"}}}\n');
  refused(await attempt(opts), /has sub\/\.mcp\.json: agent-planted config/);
});

test('Phase 2 task 1b: ~/.zshenv exports reach a full-access run as runs/<n>.zdot/.zshenv (ZDOTDIR) minus secret-like names, PATH merged with the run\'s bin first; a locked run gets none', async () => {
  const f = fullFixture();
  fs.writeFileSync(path.join(f.home, '.zshenv'), 'export FOO_TOKEN=x\nexport MYTOOL_HOME=/y\nexport QUOTE_HOME="it\'s"\nexport PATH="/opt/x:$PATH"\n');
  const { d, ticketDir } = await run({ resume: false, tag: { path: f.tag }, env: { HOME: f.home } });
  const zdot = path.join(ticketDir, 'runs/2.zdot');
  assert.equal(d.env.ZDOTDIR, zdot);
  const bin = path.join(__dirname, '..', 'bin');
  const want = ["export MYTOOL_HOME='/y'", "export QUOTE_HOME='it'\\''s'", `export PATH='${[bin, '/opt/x', ...process.env.PATH.split(':').filter((p) => p !== bin)].join(':')}'`];
  assert.deepEqual(fs.readFileSync(path.join(zdot, '.zshenv'), 'utf8').split('\n').filter(Boolean).sort(), want.sort());
  assert.equal(fs.statSync(path.join(zdot, '.zshenv')).mode & 0o777, 0o600);
  // what the run's zsh reads (ZDOTDIR): the value comes back whole
  assert.equal(execFileSync('/bin/zsh', ['-c', 'printf %s "$QUOTE_HOME"'], { env: { PATH: '/usr/bin:/bin', HOME: f.home, ZDOTDIR: zdot }, encoding: 'utf8' }), "it's");
  const locked = await run({ resume: false, ticket: { sandbox: true }, tag: { path: f.tag }, env: { HOME: f.home } });
  assert.deepEqual(['ZDOTDIR' in locked.d.env, fs.existsSync(path.join(locked.ticketDir, 'runs/2.zdot'))], [false, false]);
});

test('Phase 2 task 2: bash_all_steps on → a read-only phase gets bare Bash (no bash / node / npx deny) and, in a plain folder, the board note says tbd cannot check it; off → today\'s', async () => {
  const f = fullFixture();
  const tag = { path: f.tag, type: 'folder' };
  const on = await run({ phase: 'planning', config: { ...PLAN_CONFIG, terminal: { ...TERM, bash_all_steps: true } }, resume: false, tag, env: { HOME: f.home } });
  const s = settingsOf(on.ticketDir);
  assert.ok(s.permissions.allow.includes('Bash'));
  for (const r of ['Bash(bash:*)', 'Bash(node:*)', 'Bash(npx:*)']) assert.equal(s.permissions.deny.includes(r), false, r);
  const note = /\nthis step only reads: tbd cannot check a plain folder for changes, so change no file in it\n/;
  assert.match(fs.readFileSync(path.join(on.ticketDir, 'runs/2.system.md'), 'utf8'), note);
  const off = await run({ phase: 'planning', config: { ...PLAN_CONFIG, terminal: TERM }, resume: false, tag, env: { HOME: f.home } });
  assert.deepEqual([settingsOf(off.ticketDir).permissions.allow.includes('Bash'), settingsOf(off.ticketDir).permissions.deny.includes('Bash(node:*)')], [false, true]);
  assert.doesNotMatch(fs.readFileSync(path.join(off.ticketDir, 'runs/2.system.md'), 'utf8'), note);
});

test('Phase 2 task 3: folder_mcp → the folder\'s servers (local scope + enabled .mcp.json at base_sha, repo keys only once trusted) in TB_HOME/run-secrets/<id>-<n>/mcp.json (0600) via --mcp-config, mcp__<normalized> rules, the repo + allowedTools lists filtered into bare-Bash phases only; off → no file, allow unchanged', async () => {
  const f = fullFixture();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'mcp-')));
  const repo = path.join(root, 'repo'); // the tag's main checkout
  const wt = path.join(root, 'wt');
  const git = (...a) => execFileSync('/usr/bin/git', ['-C', repo, ...a], { env: GENV, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  git('init', '-q', '-b', 'main');
  const srv = (x) => ({ command: '/bin/echo', args: [x] });
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'srv-a': srv('a'), 'srv-b': srv('b') } }));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['srv-a', 'srv-b', 'srv-c'], permissions: { allow: ['Bash(npm run x)', 'Bash', 'Edit(//elsewhere/**)'] } }));
  const base_sha = commitAll(git);
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'srv-a': srv('a'), 'srv-b': srv('b'), 'srv-c': srv('c') } })); // not committed
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm run y)', 'WebFetch(domain:example.com)'] } }));
  const common_dir = path.join(repo, '.git');
  const ticket = { worktree: wt, base_sha, common_dir, ...(await require('../lib/util').cloneAt(common_dir, wt, base_sha)) };
  const entry = (trusted) => fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ projects: { [repo]: {
    hasTrustDialogAccepted: trusted, disabledMcpjsonServers: ['srv-b'], allowedTools: ['Read(x)', 'mcp__srv__t', 'mcp__*'],
    mcpServers: { 'local.srv': srv('l'), web: { type: 'http', url: 'https://example.invalid/mcp' } } } } }));
  entry(true);
  const tag = { path: repo };
  const config = { ...CONFIG, terminal: { ...TERM, folder_mcp: true } };
  const secretsOf = (ticketDir) => path.join(path.dirname(path.dirname(ticketDir)), 'run-secrets', 't_spawn1-2');
  const on = await run({ resume: false, config, ticket, tag, env: { HOME: f.home } });
  const file = path.join(secretsOf(on.ticketDir), 'mcp.json');
  assert.equal(on.d.opts['--mcp-config'], file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, { 'local.srv': srv('l'), web: { type: 'http', url: 'https://example.invalid/mcp' }, 'srv-a': srv('a') });
  assert.deepEqual([fs.statSync(file).mode & 0o777, fs.statSync(path.dirname(file)).mode & 0o777, on.mcp], [0o600, 0o700, 2], 'two stdio servers (admission)');
  const allow = settingsOf(on.ticketDir).permissions.allow;
  for (const r of ['mcp__local_srv', 'mcp__web', 'mcp__srv-a', 'mcp__srv__t', 'Bash(npm run x)', 'Bash(npm run y)']) assert.ok(allow.includes(r), r);
  for (const r of ['mcp__srv-b', 'mcp__srv-c', 'mcp__*', 'Edit(//elsewhere/**)', 'Read(x)', 'WebFetch(domain:example.com)']) assert.equal(allow.includes(r), false, r);
  assert.equal(allow.filter((r) => r === 'Bash').length, 1);
  // a read-only phase (bash_all_steps off): the server rules, none of the imports
  const plan = settingsOf((await run({ phase: 'planning', resume: false, config: { ...PLAN_CONFIG, terminal: config.terminal }, ticket, tag, env: { HOME: f.home } })).ticketDir).permissions.allow;
  assert.deepEqual([plan.includes('mcp__srv-a'), plan.includes('Bash(npm run x)'), plan.includes('mcp__srv__t')], [true, false, false]);
  // not trusted: the repo's enable keys do not count (srv-a was enabled only there)
  entry(false);
  const untrusted = await run({ resume: false, config, ticket, tag, env: { HOME: f.home } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(secretsOf(untrusted.ticketDir), 'mcp.json'), 'utf8')).mcpServers).sort(), ['local.srv', 'web']);
  // switch off: no file, the phase's own mcp.json, no mcp__ rule
  const off = await run({ resume: false, config: { ...CONFIG, terminal: TERM }, ticket, tag, env: { HOME: f.home } });
  assert.deepEqual([fs.existsSync(secretsOf(off.ticketDir)), off.d.opts['--mcp-config'], settingsOf(off.ticketDir).permissions.allow.some((r) => r.startsWith('mcp__') || r === 'Bash(npm run x)')],
    [false, path.join(PHASES, 'code/working/mcp.json'), false]);
});
