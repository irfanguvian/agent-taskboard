'use strict';
// spawn: one agent run's command line, env and files (spec §8 "spawn so runs survive", §9 spawn line + env, §6).
// Files in <ticket>/runs/: <n>.prompt (stdin), <n>.jsonl (stdout), <n>.err (stderr), <n>.settings.json (the phase
// template rendered for this run), <n>.mcp.json when the phase has no mcp.json (--strict-mcp-config: none) and, for
// planning, <n>.plan-ctx.json (lib/plan-rules ctx for hooks/plan-check.js, J15); M5 C2: <n>.system.md, a code run's
// system prompt (phase prompt + phases/_rules.md). Full-access runs (t.sandbox !== true, plan full-access-runs Phase 3):
// no <n>.mcp.json (user MCP loads), <n>.local.json = the local copies' hashes, system.md + phases/_board.md instead;
// board-terminal-parity Phase 2: <n>.zdot/.zshenv (~/.zshenv filtered, ZDOTDIR) and, with config.terminal.folder_mcp,
// TB_HOME/run-secrets/<id>-<n>/mcp.json (the tag folder's MCP servers, outside the ticket dir); with
// config.terminal.auto_mode, the approve tool server `tb` in it (lib/approvals.js: a.sock beside it); with
// config.terminal.git_bridge, git.json there (bin/tb-git's run file) + runs/<n>.git.sb (its seatbelt profile).
// Files, never pipes: a tbd crash can't break a pipe the child writes to. detached: the run leads its own process
// group, so a signal to tbd never reaches it and it outlives tbd. Async only (D31).
const crypto = require('node:crypto');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const phases = require('./phases');
const { render, tools, fullAccess, chromeProfile, gitProfile } = require('./phase-settings');
const planRules = require('./plan-rules');
const { gateTag } = require('./tags');
const { skillSources, effectiveSkills } = require('./skills');
const sh = require('./sh');
const { isObj, claudeEnv, git, isFile, within, readPlain, shq, SHA_RE } = require('./util');

const TB_CODE = path.join(__dirname, '..');
const TB_CHROME = path.join(TB_CODE, 'bin', 'tb-chrome'); // full-access runs' browser wrapper (excludedCommands)
const TB_GIT = path.join(TB_CODE, 'bin', 'tb-git'); // board-terminal-parity Phase 2 task 5: the git bridge (excludedCommands)
const RESUME_PROMPT = 'Your previous run was interrupted. Check the current state and continue from your last step.'; // §8 step 5
const FABLE_OK = ['plan', 'credits_ok']; // §6 Fable gate: else opus xhigh
const capKey = (phase) => (phase === 'working' ? 'working_task' : phase); // max_turns + wall_min key
// working on the last pending task of the plan (no other task pending; a review fix task, @rv<n>, never counts)
const AGENT_PHASES = ['planning', 'working', 'review', 'qa', 'final_gate'];
const lastTask = (t, phase) => phase === 'working' && typeof t.work?.task === 'string' && !t.work.task.includes('@')
  && Array.isArray(t.work.tasks) && t.work.tasks.every((x) => x.id === t.work.task || x.status !== 'pending');
// The isolation flags of a run (§6: project settings + ours only, no MCP but ours, the tool list, no subagents, no
// prompts) and its env extras (D-0011), for a claude -p outside start() (golden-working --blind). start() writes the same
// pairs, not contiguous (test/spawn.test.js holds the drift).
const isolationArgv = (/** @type {{settings: string, mcp: string, tools: string[]}} */ { settings, mcp, tools: list }) => [
  '--setting-sources', 'project', '--settings', settings, '--strict-mcp-config', '--mcp-config', mcp,
  '--tools', list.join(','), ...(list.includes('Agent') ? [] : ['--disallowedTools', 'Agent']), '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
const ISOLATION_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
// git in a run: never a terminal prompt, no credential helper, and every push URL rewritten to no-push://<url>
// (pushInsteadOf "" matches all URLs). start() and the blind reviewer spread this one object.
const AGENT_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'url.no-push://.pushInsteadOf', GIT_CONFIG_VALUE_1: '',
};
// The phase's model + effort (App A models); fable only when billing allows it (§6), else opus xhigh. t:run metrics too.
// opus: the run re-runs a phase Fable refused (P4 AC7, U7): opus xhigh whatever the config says. M5 C11 G9: final_gate
// through finalModel (the runner's lease, spawn's argv and t:run all ask here).
function configured(config, phase, opus = false) {
  const m = config.models?.[phase] ?? {};
  const fable = !opus && m.model === 'fable' && FABLE_OK.includes(config.fable_billing);
  const [model, effort] = opus || (m.model === 'fable' && !fable) ? ['opus', 'xhigh'] : [m.model, m.effort];
  return { model, effort, fable };
}
// M5 C11 G9: the final review is a second pair of eyes, never on review's model: models.final_gate, else the first of
// opus, fable (billing ok), sonnet that differs (the config's effort kept). full-access-runs Phase 4: only while
// config.final_distinct is true (default false: opus xhigh for review and final alike, decision 7)
function finalModel(config) {
  const m = configured(config, 'final_gate');
  const review = configured(config, 'review').model;
  if (config.final_distinct !== true || m.model !== review) return m;
  const model = ['opus', FABLE_OK.includes(config.fable_billing) && 'fable', 'sonnet'].find((x) => x && x !== review);
  return { model, effort: m.effort, fable: model === 'fable' };
}
const modelFor = (config, phase, opus = false) => (phase === 'final_gate' && !opus ? finalModel(config) : configured(config, phase, opus));
// what --setting-sources project loads from the cwd; board-terminal-parity Phase 2 task 1: + .mcp.json (its servers' commands
// run as Irfan) and AGENTS.md (agentsMd), as phase-settings planted()
const CONFIG = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', 'AGENTS.md'];
const isConfig = (name) => CONFIG.some((c) => c.toLowerCase() === name.toLowerCase()); // APFS ignores case
// claude's own write staging: with the sandbox on, a Bash call makes <cwd>/.claude/.cc-writes (seen 2.1.295, P3d smoke).
// No config loads from it and the agent can't write under .claude (Edit deny + sandbox denyWrite), so it isn't planted.
// Only plain files right in it (a claude killed mid-write may leave its temp file), none named like config.
const STAGING = '.cc-writes';
const STAGING_RE = /^\.claude\/\.cc-writes\/[^/]+$/; // cwd root only, exact case: where claude makes it
const lstatDir = (p) => fsp.lstat(p).then((st) => st.isDirectory(), () => false); // a symlink is never a dir here
// claude's staging dir: a real dir of plain files, none named like config
const ccWrites = async (p) => (await lstatDir(p)) && (await fsp.readdir(p, { withFileTypes: true })).every((e) => e.isFile() && !isConfig(e.name));
async function stagingOnly(dir) { // a .claude dir holding nothing but claude's staging dir
  const names = await fsp.readdir(dir);
  return names.every((n) => n === STAGING) && (!names.length || ccWrites(path.join(dir, STAGING)));
}
// S2: every Claude config name under dir (relative paths), any depth, any case. Dirents are lstat: links never
// followed. A config dir is named, not walked into. Top-level runs/ and skills/ are tbd's own (no agent writes them:
// Edit deny + sandbox denyWrite); skills/ holds the skill copies tbd hands the run (--add-dir: their .claude/skills).
async function configPaths(dir, rel = '') {
  const ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  const found = await Promise.all(ents.filter((e) => rel || (e.name !== 'runs' && e.name !== 'skills')).map((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return isConfig(e.name) ? [p] : e.isDirectory() ? configPaths(dir, p) : [];
  }));
  return found.flat();
}

// A worktree's Claude config paths (relative, any depth, any case) that differ from t.base_sha: tracked ones changed
// (diff --raw: added, changed, deleted, both names of a rename), untracked ones (--exclude-standard: git never enters an
// ignored dir), and what its ignored entries hold (U10): an ignored config file or dir by name, else each ignored dir is
// walked, every run (configPaths: lstat, links never followed; a real node_modules, 21k files, ~90 ms warm; P3 listed
// every ignored file with git, 20 s), so a config planted in node_modules after setup is seen too; plantedConfig drops
// what the baseline holds. git never enters a nested repo (untracked: one `sub/` entry) or a submodule's work tree
// (gitlink, mode 160000: from the index, so a base submodule counts even with .gitmodules deleted; changed ones from diff
// --raw; .gitmodules paths, initialized or not), so its lists can't see config in them: each is walked the same way, only
// when it really lies inside the worktree (S4: realpath; a link is never walked). git output is NUL-separated (-z): names
// are never quoted (a `café/` nested repo). claude's staging (.claude/.cc-writes/<plain file>) is left out. 5 git
// processes, in parallel, git_dir + common_dir pinned (S1, util.git). → {paths, ignored: the ignored dirs seen} (approve
// saves both).
async function worktreeConfig(t, cwd, env) {
  if (typeof t.base_sha !== 'string' || !SHA_RE.test(t.base_sha)) throw new Error(`ticket.base_sha missing or not a sha: can't check worktree ${cwd} for agent-planted Claude config`);
  const run = (args, maxBuffer = 10 << 20) => git(cwd, args, { env, dirs: t, maxBuffer });
  const [modules, ...rs] = await Promise.all([run(['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']), // exit 1: none
    run(['ls-files', '-z', '--others', '--exclude-standard'], 64 << 20), run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    run(['diff', '--raw', '-z', '--ignore-submodules=dirty', t.base_sha], 64 << 20), run(['ls-files', '-s', '-z'], 64 << 20)]); // every index entry (gitlinks): a big repo's index lists MBs
  const bad = rs.find((r) => r.err);
  if (bad) throw Object.assign(new Error(`can't check worktree ${cwd} for agent-planted Claude config: git ${String(bad.stderr || bad.err.message).trim().slice(0, 200)}`), bad.err?.code === 'PLANTED' && { code: 'PLANTED' }); // a rewritten commondir: Blocked at once
  const [untracked, ignored, raw, index] = rs.map((r) => r.stdout.split('\0').filter(Boolean));
  const named = (p) => p.split('/').some(isConfig);
  const found = untracked.filter((p) => !p.endsWith('/') && named(p));
  const dirs = [];
  // p: a path git lists as one entry (dir: trailing /). Config-named → found (unless it is claude's staging), else a dir
  // is walked. → true when it walked p.
  const entry = async (p) => {
    const dir = p.endsWith('/');
    const rel = dir ? p.slice(0, -1) : p;
    if (named(rel)) {
      const staging = dir && (rel === '.claude' ? await stagingOnly(path.join(cwd, rel)) : rel === `.claude/${STAGING}` && await ccWrites(path.join(cwd, rel)));
      if (!staging) found.push(rel);
      return false;
    }
    if (dir) found.push(...(await configPaths(cwd, rel)));
    return dir;
  };
  for (const p of ignored) if (await entry(p)) dirs.push(p);
  // diff --raw -z: ":<modes> <shas> <status>" then its path (two for a rename or copy: the new one is last)
  const changedLinks = [];
  for (let i = 0; i < raw.length; i++) {
    const kind = /^:\S+ \S+ \S+ \S+ ([RC])/.exec(raw[i])?.[1];
    const n = kind ? 2 : 1;
    const names = raw.slice(i + 1, i + 1 + n);
    if (/^:160000 |^:\S+ 160000 /.test(raw[i]) && names[n - 1]) changedLinks.push(names[n - 1]);
    found.push(...(kind === 'C' ? names.slice(1) : names).filter(named)); // a copy's source is unchanged
    i += n;
  }
  const gitlinks = [...new Set([...changedLinks,
    ...index.filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1)), // "<mode> <sha> <stage>\t<path>"
    ...(modules.err ? [] : modules.stdout.split('\0').filter(Boolean).map((e) => e.slice(e.indexOf('\n') + 1)))])]; // "<key>\n<path>"
  // .gitmodules is the agent's to write: a path out of the worktree (/x, ../x) is never walked, it is refused; so is one
  // that leads out through a link on the way (S4: realpath)
  const inside = (g) => g && !path.isAbsolute(g) && !g.split('/').includes('..');
  found.push(...gitlinks.filter((g) => !inside(g)).map((g) => `.gitmodules: ${g}`));
  const root = await fsp.realpath(cwd);
  for (const g of gitlinks.filter(inside).map((x) => x.replace(/\/+$/, ''))) {
    const real = await fsp.realpath(path.join(cwd, g)).catch(() => null); // gone: nothing to walk
    if (real && !within(real, root)) found.push(`.gitmodules: ${g} (leads outside the worktree)`);
    else if (real && await lstatDir(path.join(cwd, g))) await entry(`${g}/`); // no trailing slash: a leaf link is not followed
  }
  for (const p of untracked.filter((x) => x.endsWith('/'))) if (await lstatDir(path.join(cwd, p.slice(0, -1)))) await entry(p); // nested repos
  // .cc-writes/<name>: a plain file only (lstat): a link there is planted (P3 carry)
  const staged = await Promise.all(found.map((f) => STAGING_RE.test(f) && !isConfig(path.basename(f)) && isFile(path.join(cwd, f))));
  return { paths: [...new Set(found.filter((_, i) => !staged[i]))], ignored: dirs };
}

// S1: Claude config in the run's cwd that tbd never wrote → refuse (an agent planted it: its hooks would run outside the
// sandbox as Irfan). Ticket dir: none may exist, at any depth (configPaths). Worktree: none may differ from base_sha
// (worktreeConfig) unless the post-setup baseline has it (U10: what setup made, e.g. node_modules/x/CLAUDE.md). A folder
// tag's path (--add-dir, its .claude/skills load too) has no baseline: not checked here, the Edit deny + sandbox
// write-deny gate it.
// Full access (copies: localCopies' {rel: sha256}): a recorded copy passes while its content is the recorded one, and the
// .claude dir only while it holds nothing but recorded copies (+ claude's staging); the baseline never exempts either.
async function plantedConfig(t, cwd, ticketDir, env, copies = null) {
  if (cwd === ticketDir) {
    const found = await configPaths(cwd);
    const clean = found.includes('.claude') && await lstatDir(path.join(cwd, '.claude')) && await stagingOnly(path.join(cwd, '.claude'));
    return found.filter((f) => !(clean && f === '.claude'));
  }
  const base = new Set(t.config_baseline?.paths ?? []);
  const found = (await worktreeConfig(t, cwd, env)).paths;
  if (!copies) return found.filter((p) => !base.has(p));
  const ok = await Promise.all(found.map((p) => copyOk(cwd, p, copies)));
  return found.filter((p, i) => !ok[i] && (!base.has(p) || p === '.claude' || Object.hasOwn(copies, p)));
}

// Full-access runs (plan full-access-runs Phase 3, decision 3): the tag main checkout's CLAUDE.local.md (root) and
// .claude/settings.local.json, copied fresh into the clone at every run start (read O_NOFOLLOW as a plain file ≤ 1 MB,
// else skipped; the bytes read are the bytes hashed and written, 0600, never through a link), hidden from git by the
// clone's .git/info/exclude under MARK (tbd owns .git/info: CLONE_NO_WRITE). A path the clone tracks is never copied or
// removed (exclude can't hide it: the copy would be a change). → {rel: sha256} of what was copied (plantedConfig pins
// them), null for none. A sandbox run removes them (dropCopies).
const LOCAL = ['CLAUDE.local.md', '.claude/settings.local.json'];
const MARK = '# tbd local copies';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// a ticket's tb-chrome bridge port (+1: Chrome's debug port), fixed so the profile can name them
const chromePort = (key) => 20000 + (parseInt(sha256(key).slice(0, 8), 16) % 14000) * 2; // below the ephemeral range (49152)
// the clone's .git/info/exclude when .git and .git/info are real dirs (make: .git/info made first), else null
async function gitInfo(cwd, make = false) {
  const g = path.join(cwd, '.git');
  if (!(await lstatDir(g))) return null;
  if (make) await fsp.mkdir(path.join(g, 'info'), { recursive: true });
  return (await lstatDir(path.join(g, 'info'))) ? path.join(g, 'info', 'exclude') : null;
}
// LOCAL minus what the clone tracks (pinned git, S1); git failing → [] (the planted check then says why)
async function untracked(t, cwd, env) {
  const r = await git(cwd, ['ls-files', '-z', '--', ...LOCAL], { env, dirs: t });
  return r.err ? [] : LOCAL.filter((rel) => !r.stdout.split('\0').includes(rel));
}
async function localCopies(t, tagPath, cwd, env) {
  const exclude = await gitInfo(cwd, true);
  if (!exclude) return null; // no clone .git/info (a planted link?): no copies; the pin / planted check say why
  const copies = {};
  for (const rel of await untracked(t, cwd, env)) {
    const text = await readPlain(path.join(tagPath, rel), 1 << 20);
    if (text === null) continue;
    const dest = path.join(cwd, rel);
    if (rel.startsWith('.claude/')) {
      if (await fsp.lstat(path.join(cwd, '.claude')).then((st) => !st.isDirectory(), () => false)) continue; // a link: refused below
      await fsp.mkdir(path.join(cwd, '.claude'), { recursive: true, mode: 0o700 });
    }
    await rmCopy(dest);
    await fsp.writeFile(dest, text, { mode: 0o600, flag: 'wx' }); // wx after the rm: never written through a planted link
    copies[rel] = sha256(text);
  }
  if (!Object.keys(copies).length) return null; // nothing copied: the planted check as before, no exclude line
  const old = await fsp.readFile(exclude, 'utf8').catch(() => '');
  if (!old.split('\n').includes(MARK)) await fsp.appendFile(exclude, `${old && !old.endsWith('\n') ? '\n' : ''}${MARK}\n${LOCAL.map((r) => `/${r}`).join('\n')}\n`, { mode: 0o644, flag: fsp.constants.O_WRONLY | fsp.constants.O_APPEND | fsp.constants.O_CREAT | fsp.constants.O_NOFOLLOW });
  return copies;
}
async function dropCopies(t, cwd, env) {
  const exclude = await gitInfo(cwd);
  if (!exclude || !(await fsp.readFile(exclude, 'utf8').catch(() => '')).split('\n').includes(MARK)) return;
  for (const rel of await untracked(t, cwd, env)) {
    if (!rel.startsWith('.claude/') || (await lstatDir(path.join(cwd, '.claude')))) await rmCopy(path.join(cwd, rel));
  }
}
// rm of a copy; a dir planted in its place (EISDIR) is agent-planted: Blocked at once, like plantedConfig
const rmCopy = (p) => fsp.rm(p, { force: true }).catch((e) => {
  throw Object.assign(new Error(`refusing to start: ${p} is not a file (${e.code}): agent-planted, remove by hand`), { code: 'PLANTED' });
});
// Phase 1 smoke (2.1.302): claude -p skips AGENTS.md when a CLAUDE.md sits beside it, and the agentsMd settings key
// (flag or project settings) did not change that. So a full-access run gets the repo-root AGENTS.md (≤ 16 KB) in its
// system prompt when both are in the base commit: read from base_sha (pinned git), never the worktree copy an earlier
// run could have edited. → its text, or null.
async function agentsMd(t, cwd, env) {
  if (!t.worktree || !SHA_RE.test(t.base_sha ?? '')) return null;
  const ls = await git(cwd, ['ls-tree', '--name-only', '-z', t.base_sha, '--', 'AGENTS.md', 'CLAUDE.md'], { env, dirs: t });
  if (ls.err || ls.stdout.split('\0').filter(Boolean).length !== 2) return null;
  const r = await git(cwd, ['show', `${t.base_sha}:AGENTS.md`], { env, dirs: t });
  return r.err || Buffer.byteLength(r.stdout) > 16 * 1024 ? null : r.stdout;
}

// board-terminal-parity Phase 2 task 3 (config.terminal.folder_mcp, full access): the MCP servers + allow rules Irfan's
// terminal has in the tag folder. ~/.claude.json (his, ≤ 20 MB, read once per spawn) projects[tag.path]: mcpServers
// (local scope) + allowedTools. .mcp.json and the repo's .claude/settings.json only from base_sha (pinned git: never the
// work tree, never an agent's commit; a folder tag has neither). A .mcp.json server loads as in the terminal: named in
// enabledMcpjsonServers (or enableAllProjectMcpServers), not in disabledMcpjsonServers; disabledMcpServers drops any
// server. Those keys count from the project entry and user settings, from the repo's settings only once Irfan trusted
// the folder (hasTrustDialogAccepted: claude's own gate). rules: mcp__<name> per server, the name as claude normalizes it
// (spike a: chars outside [A-Za-z0-9_-] → _; mcp__* is ignored: never written). imports (the caller adds them to bare-Bash
// phases only): the repo's permissions.allow (settings.json at base_sha + the main checkout's untracked settings.local.json)
// and allowedTools, strings ≤ 500 chars, ≤ 500 of each, minus bare Bash, mcp__ wildcards and IMPORT_DROP's tools.
// → {servers, rules, imports, stdio: its stdio servers (admission RAM)}
const IMPORT_DROP = new Set(['Agent', 'Task', 'Read', 'WebFetch', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
async function folderMcp(t, tag, cwd, env, home) {
  const json = (/** @type {string | null} */ text) => { try { const v = JSON.parse(text ?? 'null'); return isObj(v) ? v : {}; } catch { return {}; } };
  const pinned = async (/** @type {string} */ rel) => {
    if (!t.worktree || !SHA_RE.test(t.base_sha ?? '')) return {};
    const r = await git(cwd, ['cat-file', 'blob', `${t.base_sha}:${rel}`], { env, dirs: t, maxBuffer: 1 << 20 });
    return r.err ? {} : json(r.stdout);
  };
  const [cj, user, local, mcpjson, repo] = await Promise.all([
    readPlain(path.join(home, '.claude.json'), 20 << 20, true).then(json),
    readPlain(path.join(home, '.claude', 'settings.json'), 1 << 20, true).then(json),
    readPlain(path.join(tag.path, '.claude', 'settings.local.json'), 1 << 20).then(json),
    pinned('.mcp.json'), pinned('.claude/settings.json'),
  ]);
  const proj = isObj(cj.projects?.[tag.path]) ? cj.projects[tag.path] : {};
  const keys = [proj, user, ...(proj.hasTrustDialogAccepted === true ? [repo] : [])];
  const [on, off, gone] = ['enabledMcpjsonServers', 'disabledMcpjsonServers', 'disabledMcpServers'].map((k) => new Set(keys.flatMap((s) => (Array.isArray(s[k]) ? s[k] : []))));
  const all = keys.some((s) => s.enableAllProjectMcpServers === true);
  const servers = new Map(); // local scope first: it wins a name over .mcp.json, as in claude
  for (const [n, d] of Object.entries(isObj(proj.mcpServers) ? proj.mcpServers : {})) if (n && isObj(d) && !gone.has(n)) servers.set(n, d);
  for (const [n, d] of Object.entries(isObj(mcpjson.mcpServers) ? mcpjson.mcpServers : {})) if (n && isObj(d) && (all || on.has(n)) && !off.has(n) && !gone.has(n) && !servers.has(n)) servers.set(n, d);
  const list = (/** @type {unknown} */ a) => (Array.isArray(a) ? a.slice(0, 500) : []).filter((r) => typeof r === 'string' && r.length <= 500);
  const imports = [repo.permissions?.allow, local.permissions?.allow, proj.allowedTools].flatMap(list)
    .filter((r) => !/^\s*bash\s*(\(\s*[*:\s]*\))?\s*$/i.test(r) && !IMPORT_DROP.has(r.split('(')[0].trim()) && !(r.startsWith('mcp__') && r.includes('*')));
  return { servers: Object.fromEntries(servers), rules: [...servers.keys()].map((n) => `mcp__${n.replace(/[^A-Za-z0-9_-]/g, '_')}`), imports,
    stdio: [...servers.values()].filter((d) => (d.type ?? 'stdio') === 'stdio').length };
}
// A run's secrets dir (board-terminal-parity rule "run secrets": the folder MCP file and its env): under TB_HOME, which no
// agent reads (BASE denyRead; chromeProfile keeps it), 0700; removed at run end and by the runner's boot sweep
const runSecrets = (/** @type {string} */ tbHome, /** @type {string} */ id, /** @type {number | string} */ n) => path.join(tbHome, 'run-secrets', `${id}-${n}`);

// board-terminal-parity Phase 2 task 1b (Irfan; spike d: every agent Bash call's zsh read ~/.zshenv, FIGMA_TOKEN seen).
// Full access: tbd evaluates ~/.zshenv once per spawn, outside the wall (Irfan's own file; base env = the run's, never
// tbd's), keeps each export whose name looks like no secret (SECRETISH) and that the run env does not pin (PATH merged:
// the run's bin/ stays first), and writes them as `export NAME='value'` lines to dir/.zshenv (dir: runs/<n>.zdot,
// write-denied to agents); ZDOTDIR points the run's zsh there, the wall read-denies ~/.zshenv. No ~/.zshenv, or zsh
// failing (5 s timeout): an empty file.
const SECRETISH = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PAT(?![A-Z])|AUTH|BEARER|SESSION|COOKIE|DSN/i; // security review M1: drop on doubt
const CRED_URL = /:\/\/[^/\s]*@/; // a value holding userinfo (user:password@, a token@: a DB or git URL), whatever its name
const ZSH_OWN = ['PWD', 'OLDPWD', 'SHLVL', '_', 'LOGNAME']; // zsh sets these itself (LOGNAME when the env has none)
async function zdot(/** @type {string} */ dir, /** @type {Record<string, string>} */ childEnv, /** @type {Record<string, string | undefined>} */ base) {
  // -f: zsh's own startup files skipped, so ~/.zshenv runs once (as in the agent's shell), by the explicit source
  const r = await sh('/bin/zsh', ['-f', '-c', 'source ~/.zshenv 2>/dev/null; env -0'], { env: base, timeout: 5000 });
  const bin = childEnv.PATH.split(':')[0];
  const lines = [];
  for (const pair of r.err ? [] : r.stdout.split('\0')) {
    const i = pair.indexOf('=');
    const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
    if (i < 1 || !/^[A-Za-z_]\w*$/.test(k) || SECRETISH.test(k) || CRED_URL.test(v) || ZSH_OWN.includes(k) || (k !== 'PATH' && Object.hasOwn(childEnv, k))) continue;
    const val = k === 'PATH' ? [bin, ...v.split(':').filter((p) => p !== bin)].join(':') : v;
    if (k !== 'PATH' || val !== childEnv.PATH) lines.push(`export ${k}=${shq(val)}\n`);
  }
  await fsp.mkdir(dir, { mode: 0o700 });
  await fsp.writeFile(path.join(dir, '.zshenv'), lines.join(''), { mode: 0o600, flag: 'wx' });
}
// p: a path plantedConfig found. A recorded copy with its recorded content, or a .claude dir of recorded copies only.
async function copyOk(cwd, p, copies) {
  if (Object.hasOwn(copies, p)) return (await isFile(path.join(cwd, p))) && sha256(await fsp.readFile(path.join(cwd, p))) === copies[p];
  if (p !== '.claude' || !(await lstatDir(path.join(cwd, p)))) return false;
  const names = await fsp.readdir(path.join(cwd, p));
  return (await Promise.all(names.map((n) => (n === STAGING ? ccWrites(path.join(cwd, p, n)) : copyOk(cwd, `.claude/${n}`, copies))))).every(Boolean);
}

// board-terminal-parity Phase 2 task 5 (spike h): the real git binary (`xcrun -f git`; /usr/bin/git is a shim that needs
// xcrun, which tb-git's profile does not run), asked once per tbd (memo; a failure is asked again next spawn) → its
// real path, or null (no bridge in that run)
let gitBin = null;
const realGit = () => (gitBin ??= sh('/usr/bin/xcrun', ['-f', 'git'], { timeout: 10_000 }).then(async (r) => {
  const p = r.err ? '' : r.stdout.trim();
  const real = path.isAbsolute(p) ? await fsp.realpath(p).catch(() => null) : null;
  if (!real) { gitBin = null; console.error(`tbd: xcrun -f git: no git found${r.err ? ` (${String(r.stderr || r.err.message).trim().slice(0, 200)})` : ''}: no git bridge`); }
  return real;
}));
// The git bridge's view of the remotes: the clone's remote.<name>.url / pushurl and core.hooksPath (its own config
// file, pinned: util.git refuses a config tbd did not write), and every URL of a registered git tag's remotes (each tag
// main checkout's config: Irfan's). A git that fails reads as none.
async function bridgeRemotes(t, cwd, env, tags) {
  const rx = '^(remote\\..*\\.(url|pushurl)|core\\.hookspath)$';
  const lines = (r) => (r.err ? '' : r.stdout).split('\n').map((l) => /^(\S+) (.*)$/.exec(l)).filter(Boolean);
  const [own, ...theirs] = await Promise.all([git(cwd, ['config', '--file', path.join(t.git_dir, 'config'), '--get-regexp', rx], { env, dirs: t }),
    ...Object.values(tags).filter((d) => d?.type === 'git' && path.isAbsolute(d.path ?? '')).map((d) => git(d.path, ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { env }))]);
  const remotes = {};
  let hooks = '';
  for (const [, k, v] of lines(own)) {
    const m = /^remote\.(.+)\.(url|pushurl)$/.exec(k);
    if (m) (remotes[m[1]] ??= {})[m[2]] = v;
    else if (k === 'core.hookspath' && !path.isAbsolute(v) && !v.split('/').includes('..')) hooks = path.posix.normalize(v).replace(/\/+$/, '');
  }
  return { remotes, hooks, registered: [...new Set(theirs.flatMap((r) => lines(r).map((m) => m[2])))] };
}

// TB_GIT_FILE_REMOTE (tbd's env, tests only): one local remote path tb-git's git may read and write. Ignored for the live
// ~/.taskboard (security review L10, as phase-settings' TB_EVAL_DENY_READ). → the path or ''
const fileRemote = (/** @type {Record<string, string | undefined>} */ env, /** @type {string} */ tbHome) => (path.resolve(tbHome) !== path.join(os.homedir(), '.taskboard')
  && path.isAbsolute(env.TB_GIT_FILE_REMOTE ?? '') ? /** @type {string} */ (env.TB_GIT_FILE_REMOTE) : '');

// tb-chrome's browser (session tb-<ticket>, its own process group: a run's kill misses it) ends with the run; nothing
// to do for a ticket that never opened one. Fire and forget: `chrome-devtools-axi stop` with the pinned node.
function stopChrome(id, env = process.env) {
  const session = `tb-${id}`;
  fsp.access(path.join(env.HOME || os.homedir(), '.chrome-devtools-axi', 'sessions', session)).then(() => {
    execFile(process.execPath, [path.join(TB_CODE, 'tools', 'chrome', 'node_modules', 'chrome-devtools-axi', 'dist', 'bin', 'chrome-devtools-axi.js'), 'stop'],
      { env: { ...claudeEnv(env), CHROME_DEVTOOLS_AXI_SESSION: session, CHROME_DEVTOOLS_AXI_PORT: String(chromePort(id)) }, timeout: 20_000 }, () => {});
  }, () => {});
}

/**
 * Writes the run's files and spawns config.claude_bin detached. n: run number; session: uuid (new run:
 * --session-id, resume: --resume and no --session-id); key: the run's slots key (TBX_RUN); tag: the ticket's tag def;
 * opus: on opus xhigh, not the phase's model (modelFor).
 * @param {{ticket: any, phase: string, n: number, session: string, resume?: boolean, key: string, prompt: string,
 *   config: any, tag?: any, tbHome: string, ticketDir: string, port: number, opus?: boolean, env?: Record<string, string | undefined>}} o
 */
async function start({ ticket: t, phase, n, session, resume = false, key, prompt, config, tag, tbHome, ticketDir, port, opus = false, env = process.env }) {
  const runs = path.join(ticketDir, 'runs');
  const skills = path.join(ticketDir, 'skills');
  const ghDir = path.join(tbHome, 'gh-empty'); // GH_CONFIG_DIR: no gh login reaches the agent
  const phaseDir = path.join(phases.DIR, t.kind, phase);
  const file = (ext) => path.join(runs, `${n}.${ext}`);
  if (t.worktree != null && !(typeof t.worktree === 'string' && path.isAbsolute(t.worktree))) {
    throw new Error(`ticket.worktree must be an absolute path, got ${JSON.stringify(t.worktree)}`); // never a silent fallback
  }
  const cwd = t.worktree ?? ticketDir; // no worktree (folder tags; code tags before P4): the ticket dir
  // Full access (plan full-access-runs Phase 3) unless the ticket's Sandbox toggle is on: then today's locked run
  const full = t.sandbox !== true;
  const home = env.HOME || os.homedir();
  const clone = !!t.worktree && !!t.clone; // local copies: an H2 clone only (a linked worktree shares the tag's .git/info)
  // stale copies of an earlier full-access run go first: the locked run never sees them, and a tag file deleted since
  // leaves no copy behind for the planted check to refuse
  if (clone) await dropCopies(t, cwd, env);
  const copies = full && clone && tag?.path ? await localCopies(t, tag.path, cwd, env) : null;
  const planted = await plantedConfig(t, cwd, ticketDir, env, copies); // new run and resume alike, before anything is written
  if (planted.length) {
    throw Object.assign(new Error(`refusing to start: ${cwd} has ${planted.slice(0, 10).join(', ')}${planted.length > 10 ? ` (+${planted.length - 10} more)` : ''}: agent-planted config, remove by hand`), { code: 'PLANTED' }); // runner: Blocked at once
  }
  // S3: skills goes to --add-dir; mkdir accepts a link planted there, and claude would read wherever it points
  const sk = await fsp.lstat(skills).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (sk && !sk.isDirectory()) throw Object.assign(new Error(`refusing to start: ${skills} is not a directory (a link?): agent-planted, remove by hand`), { code: 'PLANTED' });
  await Promise.all([runs, skills, ghDir].map((d) => fsp.mkdir(d, { recursive: true, mode: 0o700 })));

  const envFiles = ['working', 'qa', 'final_gate'].includes(phase) && t.worktree ? tag?.env_files ?? [] : [];
  const wall = full && config.full_access_wall === true; // full-access wall (lib/phase-settings.js fullAccessSandbox)
  const settings = render(t.kind, phase, {
    WORKTREE: cwd, TICKET_DIR: ticketDir, OUT_DIR: path.join(ticketDir, 'out'), TB_HOME: tbHome,
    TAG_PATH: tag?.path ?? path.join(tbHome, 'no-tag'), SKILLS_DIR: skills, TB_CODE, TB_NODE: process.execPath,
    TAG_GIT: path.isAbsolute(t.common_dir ?? '') ? t.common_dir : undefined, // H2.7: the tag repo's real git dir
    CLONE: !t.worktree || !!t.clone, // C-H1: false = a worktree from before H2 (linked): its commits write the tag's .git
    // P5 M1: the secrets approve copied in; M5 C5 C7: qa + final_gate too (the copy the app reads = the file the DB guard checked)
    TB_PORT: port, HEAVY: tag?.heavy ?? [], ENV_FILES: envFiles,
  });
  // P5 R1 (D-0040): skills run only through the Skill tool. full-access-runs Phase 4: every code phase; full access
  // always (user + plugin skills load natively), sandbox when tbd copied one (skills/.claude/skills, at assign + approve)
  const allow = settings.permissions.allow;
  if (t.kind === 'code' && (full || (await fsp.readdir(path.join(skills, '.claude', 'skills')).then((d) => d.length > 0, () => false)))) allow.push('Skill');
  // decision 8: subagents (cap: config.subagents) in every agent phase, full access only; sandbox keeps the templates' (qa)
  // (2.1.302's init names the Agent tool Task: both names in allow and --tools; subagent-count matches Agent|Task)
  if (full && AGENT_PHASES.includes(phase)) allow.push(...['Agent', 'Task'].filter((x) => !allow.includes(x)));
  const learning = full && tag?.path && (await lstatDir(path.join(tag.path, '.learning'))) ? path.join(tag.path, '.learning') : null;
  const userSkills = full && (await fsp.stat(path.join(home, '.claude', 'skills')).then((st) => st.isDirectory(), () => false)) ? path.join(home, '.claude', 'skills') : null;
  const bashAll = full && config.terminal?.bash_all_steps === true; // board-terminal-parity Phase 2 task 2
  const readOnly = !allow.includes('Bash'); // the template's: planning, review, final_gate, context
  if (full) {
    fullAccess(settings, { phase, learning, wall, worktree: cwd, envFiles, bashAll });
    settings.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(config.subagents?.concurrent ?? 3); // also in the process env
  }
  // board-terminal-parity Phase 2 task 3: the folder's MCP servers (a run-secrets file, below) + their allow rules; the
  // repo's allow list only where the phase now has bare Bash (after fullAccess: every phase with bash_all_steps on)
  const fm = full && config.terminal?.folder_mcp === true && tag?.path ? await folderMcp(t, tag, cwd, env, home) : null;
  if (fm) for (const r of [...fm.rules, ...(allow.includes('Bash') ? fm.imports : [])]) if (!allow.includes(r)) allow.push(r);
  // board-terminal-parity Phase 2 task 4a (config.terminal.auto_mode, full access): auto mode as in the terminal, the ask
  // list (lib/approvals.js) asks Irfan first through the approve tool (below); 4b: Irfan's one-shot exact allow rules
  // (t.allow_once: the runner took them off the ticket as this run started). A locked run gets neither.
  const auto = full && config.terminal?.auto_mode === true;
  const approveMin = config.terminal?.approve_min ?? 10;
  // security review M2: a Bash one goes to allow as its exact rule; a WebFetch / MCP one ({ask, tool, text}) never to allow:
  // its matching rule to ask, and a seed the approve tool answers yes once for exactly that input (lib/approvals.js
  // request); any other call that rule matches gets a card
  const once = full && Array.isArray(t.allow_once) ? t.allow_once : [];
  for (const r of once) if (typeof r === 'string' && r.startsWith('Bash(') && !allow.includes(r)) allow.push(r);
  const seeds = auto ? once.filter((x) => isObj(x) && typeof x.ask === 'string' && typeof x.tool === 'string' && typeof x.text === 'string') : [];
  if (auto) settings.permissions.ask = [...(settings.permissions.ask ?? []), ...require('./approvals').askRules(), ...seeds.map((x) => x.ask)];
  // Chrome in runs (wall on, phases with Bash: working, qa): Chrome can't start inside claude's seatbelt, so bin/tb-chrome
  // runs outside it (excludedCommands: only a plain call matches, 2.1.302 keeps compound commands in), under the run's
  // own wall as a seatbelt profile (runs/<n>.chrome.sb, chromeProfile)
  const browser = wall && allow.includes('Bash');
  // Phase 2 task 5 (config.terminal.git_bridge, a phase with Bash in a ticket's own clone): bin/tb-git the same way, under
  // runs/<n>.git.sb (gitProfile); its run file git.json in the run secrets (below). bridgeGit: the real git binary
  const bridgeGit = full && config.terminal?.git_bridge === true && allow.includes('Bash') && !!t.clone && path.isAbsolute(t.git_dir ?? '') ? await realGit() : null;
  if (browser || bridgeGit) settings.sandbox.excludedCommands = [...(browser ? [`${TB_CHROME} *`] : []), ...(bridgeGit ? [`${TB_GIT} *`] : [])];
  // auto mode would ask its classifier about every tb-git call: the bridge holds its own rules (verbs, remotes, push cards), so it is allowed by name
  if (bridgeGit && !allow.includes(`Bash(${TB_GIT} *)`)) allow.push(`Bash(${TB_GIT} *)`);
  const schema = JSON.parse(await fsp.readFile(path.join(phaseDir, 'result.schema.json'), 'utf8'));
  if (!isObj(schema)) throw new Error(`${t.kind}/${phase}: result.schema.json must hold a JSON object`);
  const { model, effort, fable } = modelFor(config, phase, opus);
  const turns = config.max_turns?.[capKey(phase)];
  const wallMin = config.liveness?.wall_min?.[capKey(phase)];
  if (typeof model !== 'string' || !model) throw new Error(`config.models.${phase}.model is missing`);
  if (!Number.isInteger(turns) || turns < 1) throw new Error(`config.max_turns.${capKey(phase)} must be a positive integer`);
  if (!(wallMin > 0)) throw new Error(`config.liveness.wall_min.${capKey(phase)} must be a positive number`);

  let mcp = path.join(phaseDir, 'mcp.json');
  const phaseMcp = await fsp.access(mcp).then(() => true, () => false);
  if (!phaseMcp && !full) { // full access: user + plugin MCP servers load (decision 1), no empty file needed
    mcp = file('mcp.json');
    await fsp.writeFile(mcp, '{"mcpServers":{}}\n', { mode: 0o600, flag: 'wx' });
  }
  await fsp.writeFile(file('settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  // the folder servers (their env may hold tokens): TB_HOME/run-secrets/<id>-<n>/mcp.json, 0600, never under runs/ (the
  // agent reads its ticket dir); a phase's own mcp.json servers go in the same file (one --mcp-config)
  // Phase 2 task 4a: + server `tb` = the approve tool, `/usr/bin/nc -U <dir>/a.sock` (an absolute path: never one the
  // agent's cwd resolves), its socket bound by tbd before the spawn (lib/approvals.js)
  let folderFile = null;
  const servers = !!fm && Object.keys(fm.servers).length > 0;
  const dir = servers || auto || bridgeGit ? runSecrets(tbHome, t.id, n) : null;
  if (dir) {
    await fsp.rm(dir, { recursive: true, force: true }); // a start that died before its run end: never written through
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  if (servers || auto) {
    folderFile = path.join(dir, 'mcp.json');
    const own = phaseMcp ? JSON.parse(await fsp.readFile(mcp, 'utf8')).mcpServers : {};
    const sock = path.join(dir, 'a.sock');
    if (auto) await require('./approvals').listen(sock, `${t.id}-${n}`, t.id, seeds.map((x) => ({ tool: x.tool, text: x.text })));
    await fsp.writeFile(folderFile, JSON.stringify({ mcpServers: { ...fm?.servers, ...own, ...(auto && { tb: { type: 'stdio', command: '/usr/bin/nc', args: ['-U', sock] } }) } }) + '\n', { mode: 0o600, flag: 'wx' });
  }
  // Phase 2 task 5: tb-git's run file (the repo it may touch, its pin, the remotes, tbd's own SSH_AUTH_SOCK, never the
  // caller's) and profile (fileRemote: tests only). ask_token (L2): tb-git sends it with each approve.ask; lib/slots.js
  // compares it with this file's, so an agent on tbd.sock raises no card.
  if (bridgeGit) {
    const { remotes, hooks, registered } = await bridgeRemotes(t, cwd, env, require('./store').listTags());
    const ssh = env.SSH_AUTH_SOCK ? await fsp.realpath(env.SSH_AUTH_SOCK).catch(() => '') : '';
    const remote = fileRemote(env, tbHome);
    await fsp.writeFile(file('git.sb'), gitProfile(settings.sandbox, { home, cwd, git: bridgeGit, ssh, hooks, remote }), { mode: 0o600, flag: 'wx' });
    await fsp.writeFile(path.join(dir, 'git.json'), JSON.stringify({
      ticket: t.id, kind: t.kind, n, ask_token: crypto.randomBytes(32).toString('hex'),
      repo: cwd, git_dir: t.git_dir, common_dir: t.common_dir, clone: t.clone, base: tag?.base ?? null, base_sha: t.base_sha ?? null,
      remotes, registered, hooks, git: bridgeGit, profile: file('git.sb'), ssh_auth_sock: ssh, home, user: env.USER ?? '', lang: env.LANG ?? 'en_US.UTF-8',
      sock: path.join(tbHome, 'tbd.sock'), ...(remote && { file_remote: remote }),
    }) + '\n', { mode: 0o600, flag: 'wx' });
  }
  // Chrome's bridge + debug ports, fixed per ticket (the profile opens only these and the tag's qa ports on loopback;
  // never tbd's, lavish's, Irfan's lavish 4387 or Postgres, as the recorder). ponytail: a hash, a clash between two
  // tickets fails one browser start (EADDRINUSE), no port table
  const cport = browser ? chromePort(t.id ?? cwd) : 0;
  const shut = browser ? [port, require('./store').interviewConfig(config).port, 4387, 5432] : []; // lazy: spawn never loads the store otherwise
  if (browser) await fsp.writeFile(file('chrome.sb'), chromeProfile(settings.sandbox, { home, cwd, node: process.execPath,
    ports: [cport, cport + 1, ...(tag?.qa_ports ?? []).filter((p) => !shut.includes(p))] }), { mode: 0o600, flag: 'wx' });
  await fsp.writeFile(file('prompt'), prompt, { mode: 0o600, flag: 'wx' });
  if (copies) await fsp.writeFile(file('local.json'), JSON.stringify(copies) + '\n', { mode: 0o600, flag: 'wx' });
  // M5 C2 (D-0085): a code run's system prompt = the phase prompt + phases/_rules.md (lib/phases.js read it at load).
  // Full access with a live ~/.claude/CLAUDE.md (it loads natively): + phases/_board.md instead; global = its sha12
  let system = path.join(phaseDir, 'prompt.md');
  if (t.kind === 'code' && !phases.rules) throw new Error('phases/_rules.md is missing or over 8 KB: code phases are misconfigured');
  const globalMd = full ? await fsp.readFile(path.join(home, '.claude', 'CLAUDE.md')).catch(() => null) : null;
  const note = globalMd && phases.board ? phases.board : t.kind === 'code' ? phases.rules : null;
  if (note) {
    // full-access-runs Phase 4: full access names the board's skills (user + plugin skills load natively; the tag's
    // removals are this note only)
    const off = full && Array.isArray(tag?.skills_off) && tag.skills_off.length ? `\ndo not use: ${tag.skills_off.join(', ')}` : '';
    const nob = browser ? `\nbrowser checks: \`${TB_CHROME} <chrome-devtools-axi command>\` (open, snapshot, click, fill, screenshot, eval, console, network, stop): call it by that full path, alone in its Bash call (no &&, ;, |, $(...), > or 2>&1), never \`npx chrome-devtools-axi\` (the sandbox wall blocks its Chrome); \`${TB_CHROME} stop\` when done`
      : wall ? '\nno browser checks in this step' : '';
    // board-terminal-parity 5: the /names Irfan typed in the Goal (t.skills_asked: known skill names, store-checked);
    // full access only (in sk): a locked run gets the board defaults, no asked skills (D-0217)
    const ask = Array.isArray(t.skills_asked) && t.skills_asked.length ? `\nIrfan asked for these skills on this ticket: ${t.skills_asked.map((n) => `/${n}`).join(', ')}. Use them where they fit.` : '';
    // board-terminal-parity Phase 2 task 2: a plain folder has no git tree for escaped() to diff
    const nogit = bashAll && readOnly && !t.worktree ? '\nthis step only reads: tbd cannot check a plain folder for changes, so change no file in it' : '';
    // Phase 2 tasks 4a + 5: the ask list in plain words; the git bridge's verbs
    const asks = auto ? `\n${require('./approvals').askNote(approveMin)}` : '';
    const gitb = bridgeGit ? `\ngit network (fetch, pull, push, ls-remote, clone) only through \`${TB_GIT} fetch [<remote>] [<branch>]\`, \`${TB_GIT} pull [<remote> <branch>] [--rebase|--ff-only]\`, \`${TB_GIT} push <remote> <branch>\`, \`${TB_GIT} ls-remote <remote>\`, \`${TB_GIT} clone <url> <dir>\`: call it by that full path, alone in its Bash call (no &&, ;, |, $(...), > or 2>&1); plain git fetch, pull, push and clone have no keys here. Push only when Irfan asked you to, and only your own branch (the one this ticket made, tb/<ticket id>-…): each push waits for his yes and lists its files (never the base or default branch, never forced, never CI, .env or key files)` : '';
    const sk = full ? `\n\ndefault skills for this board: ${effectiveSkills(config, tag).join(', ') || '(none)'}${off}${ask}${nob}${nogit}${asks}${gitb}\n` : '';
    const agents = full ? await agentsMd(t, cwd, env) : null;
    await fsp.writeFile(file('system.md'), `${await fsp.readFile(system, 'utf8')}\n\n${note.text}${sk}${agents ? `\n# AGENTS.md (repo root, at the base commit)\n\n${agents}` : ''}`, { mode: 0o600, flag: 'wx' });
    system = file('system.md');
  }
  // J15: hooks/plan-check.js reads the run's plan rules ctx here (TB_PLAN_CTX): runs/ is tbd's, no agent writes it
  const planning = phase === 'planning';
  // P5 K4: a replan (the ticket has a work cursor) checks paths at its branch HEAD (ctx.at), not base_sha, and may keep
  // the done prefix (ctx.keep_ok)
  const at = planning && t.work && t.worktree ? (await git(cwd, ['rev-parse', '--verify', 'HEAD'], { env, dirs: t })).stdout.trim() : '';
  if (planning) {
    const keep_ok = t.work ? (await require('./planning').keepOk(t)) ?? undefined : undefined; // lazy: planning requires spawn
    const ctx = planRules.ctxOf(t, Object.keys((await skillSources()).skills).sort(), { at: SHA_RE.test(at) ? at : undefined, test_scripts: tag ? gateTag(tag).test_scripts : undefined, keep_ok });
    await fsp.writeFile(file('plan-ctx.json'), JSON.stringify(ctx) + '\n', { mode: 0o600, flag: 'wx' });
  }

  const list = tools(settings);
  const argv = [
    '-p', ...(resume ? ['--resume', session] : ['--session-id', session]),
    '--setting-sources', full ? 'user,project,local' : 'project', '--settings', file('settings.json'),
    '--append-system-prompt-file', system,
    '--add-dir', skills, ...(tag?.type === 'folder' ? ['--add-dir', tag.path] : []),
    ...(learning ? ['--add-dir', learning] : []), ...(userSkills ? ['--add-dir', userSkills] : []), // full access only
    ...(!full ? ['--strict-mcp-config', '--mcp-config', mcp] : folderFile ? ['--mcp-config', folderFile] : phaseMcp ? ['--mcp-config', mcp] : []),
    '--tools', list.join(','), ...(list.includes('Agent') ? [] : ['--disallowedTools', 'Agent']), // §6: no subagents
    // Phase 2 task 4a: auto mode + the approve tool (spike g: hidden from the model, needs no allow rule); else today's
    '--permission-mode', auto ? 'auto' : 'dontAsk', '--permission-prompts', auto ? 'host' : 'none', ...(auto ? ['--permission-prompt-tool', 'mcp__tb__approve'] : []),
    '--model', model, ...(effort ? ['--effort', effort] : []), ...(fable ? ['--fallback-model', 'opus'] : []),
    '--max-turns', String(turns),
    '--json-schema', JSON.stringify(schema), // the schema itself, not its path (`claude --help` 2.1.294: --json-schema <schema>, inline JSON example)
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  ];
  const childEnv = {
    ...claudeEnv(env), // the env doctor checks too (removed keys, DISABLE_AUTOUPDATER)
    PATH: `${path.join(TB_CODE, 'bin')}:${env.PATH ?? '/usr/bin:/bin'}`, // bash-guard's heavy rewrite calls plain `tbx`
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(config.subagents?.concurrent ?? 3),
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(config.subagents?.depth ?? 1),
    ...ISOLATION_ENV,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(Math.round(wallMin * 60_000)), // §6: background subagents live up to the wall cap
    BASH_DEFAULT_TIMEOUT_MS: '1800000',
    BASH_MAX_TIMEOUT_MS: '1800000',
    ...AGENT_GIT_ENV,
    GH_CONFIG_DIR: ghDir,
    TBD_SOCK: path.join(tbHome, 'tbd.sock'),
    TBX_RUN: key,
    TB_PHASE: phase, // bash-guard: planning's git is read-only (J16)
    ...(planning && { TB_PLAN_CTX: file('plan-ctx.json') }),
    // full access: OMC's hooks exit early, learning hooks + learn read the main checkout's DB, bash-guard's ssh / .env
    // bump, TB_LAST_TASK: the learning stop hook saves only on the plan's last task (critic round 3 note 3: review fix
    // tasks @rv<n> never); no global/system git
    // config (Irfan's credential helper, his ssh rewrites); no ssh agent (Irfan 21:05; claudeEnv drops it, "" pins it);
    // caveman's normal level (under -p it injects nothing unless this is set; never ultra)
    ...(full && { DISABLE_OMC: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SSH_AUTH_SOCK: '', CAVEMAN_DEFAULT_MODE: 'caveman', TB_FULL_ACCESS: '1', ...(learning && { LEARNING_DIR: learning }) }),
    ...(full && lastTask(t, phase) && { TB_LAST_TASK: '1' }),
    ...(browser && { TB_CHROME_SB: file('chrome.sb'), TB_CHROME_PORTS: `${cport} ${cport + 1}`, TB_CHROME_NODE: process.execPath }), // bin/tb-chrome's; only tbd's env reaches it (no VAR=x form)
    ...(full && { ZDOTDIR: file('zdot') }), // board-terminal-parity Phase 2 task 1b: ~/.zshenv's filtered copy
    // Phase 2 task 4a: claude's MCP idle timeout (spike g) past the approve wait, so the board's No answers, never claude
    ...(auto && { MCP_TOOL_TIMEOUT: String(approveMin * 60_000 + 60_000) }),
    // bin/tb-git's run file + the node it execs (L1: never one on PATH); tbd's env reaches it, as tb-chrome's
    ...(bridgeGit && { TB_GIT_RUN: path.join(dir, 'git.json'), TB_NODE: process.execPath }),
  };
  if (full) await zdot(file('zdot'), childEnv, { ...claudeEnv(env), PATH: childEnv.PATH });

  const fhs = [];
  try {
    fhs.push(await fsp.open(file('prompt'), 'r'), await fsp.open(file('jsonl'), 'wx', 0o600), await fsp.open(file('err'), 'wx', 0o600));
    const child = spawn(config.claude_bin, argv, { cwd, env: childEnv, stdio: fhs.map((f) => f.fd), detached: true });
    // listeners now, before any await: a fast exit must not be missed
    const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    ready.catch(() => {}); // rejects (e.g. ENOENT) while the fds close below: the caller awaits it after
    child.on('error', () => {}); // later errors (a failed kill) are not fatal to tbd
    child.unref();
    return { child, ready, done, log: `runs/${n}.jsonl`, ...(globalMd && { global: sha256(globalMd).slice(0, 12) }), ...(folderFile && fm?.stdio && { mcp_stdio: fm.stdio }), ...(auto && { auto: true }) };
  } finally {
    await Promise.all(fhs.map((f) => f.close()));
  }
}

// J16: what changed in t's worktree: `git status --porcelain` lines (untracked files one by one), claude's own staging
// left out (.claude/.cc-writes/<plain file> not named like config: the planted-config rules) and Finder's .DS_Store (any
// depth: GIT_CONFIG_GLOBAL=/dev/null drops Irfan's global excludes). [] = clean. A planning run must leave it so
// (runner), and approve branches only from a clean one (planning.js). git_dir + common_dir pinned (S1). M5.2 sec F2: a
// tracked file flagged skip-worktree or assume-unchanged (`git update-index`) hides its edits from git status, so each
// one counts too, as a line `<ls-files -v tag>  <path>` (S, or lower case: `S  src/a.js`).
async function dirtyPaths(t, env = process.env) {
  const cwd = t.worktree;
  const fail = (/** @type {any} */ r, /** @type {string} */ what) => Object.assign(new Error(`git ${what} in ${cwd}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`), r.err?.code === 'PLANTED' && { code: 'PLANTED' });
  // --ignore-submodules=dirty: never git inside a submodule (its own config, agent-writable, could run a filter). Accepted
  // trade-off: edits inside a populated submodule are not seen here (a changed submodule commit still is; S4 walks it)
  const [r, f] = await Promise.all([git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { env, dirs: t }),
    git(cwd, ['ls-files', '-v', '-z'], { env, dirs: t })]);
  if (r.err) throw fail(r, 'status');
  if (f.err) throw fail(f, 'ls-files');
  // -z: names unquoted (café.txt); a rename/copy entry is followed by its old path, which is skipped
  const items = r.stdout.split('\0');
  const lines = [];
  for (let i = 0; i < items.length; i++) if (items[i]) { lines.push(items[i]); if (/^[RC]/.test(items[i])) i++; }
  // skip-worktree (S) / assume-unchanged (lowercase) hide an edit from status: dirty (sec F2). ponytail: ls-files lists
  // every tracked path per call under sh's 10 MB maxBuffer (~150k paths, then git errors → Blocked) and a sparse
  // worktree reads dirty everywhere; a bigger maxBuffer or a streamed filter if a repo ever gets there
  for (const e of f.stdout.split('\0')) if (/^(S|[a-z]) /.test(e)) lines.push(`${e[0]}  ${e.slice(2)}`);
  const skip = await Promise.all(lines.map((l) => path.basename(l.slice(3)) === '.DS_Store'
    || (STAGING_RE.test(l.slice(3)) && !isConfig(path.basename(l.slice(3))) && isFile(path.join(cwd, l.slice(3))))));
  return lines.filter((_, i) => !skip[i]);
}

// M5.3 SEC-2 (D-0107: the final gate and the final judge only): the tracked files of t's worktree whose content is not
// HEAD's, stat-independent. The worktree's index is the agent's to write: a stat cache forged onto HEAD's blob makes `git
// status` (dirtyPaths) clean while the file is not (`ls-files -v` shows H). So a fresh index read from HEAD into a temp
// dir tbd makes (GIT_INDEX_FILE, never in the worktree; no stat data: git hashes each file), attributes from HEAD too
// (--attr-source: a planted worktree .gitattributes changes no comparison). → `git status --porcelain` lines
// (` M src/a.js`), [] = HEAD's content. The temp dir lies in TB_HOME (0700: no agent reads or writes there), removed
// after. Throws when git fails. ponytail: hashes every tracked file per call (ceiling: repo size, 120 s timeout →
// Blocked infra); a tree hash cached per HEAD if a big repo ever waits on it.
async function contentDirty(t, env = process.env) {
  const dir = await fsp.mkdtemp(path.join(process.env.TB_HOME || path.join(os.homedir(), '.taskboard'), 'idx-'));
  try {
    const o = { env, dirs: t, add: { GIT_INDEX_FILE: path.join(dir, 'index') }, timeout: 120_000 };
    let r = await git(t.worktree, ['read-tree', 'HEAD'], o);
    if (!r.err) r = await git(t.worktree, ['--attr-source=HEAD', 'status', '--porcelain', '-z', '--untracked-files=no', '--ignore-submodules=dirty'], o);
    if (r.err) throw Object.assign(new Error(`git content check in ${t.worktree}: ${String(r.stderr || r.err.message).trim().slice(0, 200)}`), r.err?.code === 'PLANTED' && { code: 'PLANTED' });
    return r.stdout.split('\0').filter(Boolean); // the index is HEAD: no staged entry, so no rename pair
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// H1 (D-0105, D-0107 at every gate): what changed in t's worktree whatever its index says: dirtyPaths (status: untracked
// files, skip-worktree flags) ∪ contentDirty (tracked content vs HEAD, stat-free), run in parallel (F19), one line per
// path (C-L2: a staged edit is `M  x` there, ` M x` here: status's line kept). Gates and judges call it with the trusted
// t (H2.5): HEAD's tree read from the tag repo's objects only.
async function treeDirty(t, env = process.env) {
  const [a, b] = await Promise.all([dirtyPaths(t, env), contentDirty(t, env)]);
  const seen = new Set();
  return [...a, ...b].filter((l) => !seen.has(l.slice(3)) && seen.add(l.slice(3)));
}

// P5 M1 tripwire: what setup left in node_modules that tests run through: sha256 of npm's hidden lockfile
// (node_modules/.package-lock.json, null when missing) and of node_modules/.bin's sorted "name→link target" list (a plain
// file there, a planted script, counts as "name!file"). lstat + readlink only: nothing is followed. Compact (two hashes)
// so ticket.json stays small; the gate is told only that it changed.
async function tripwire(cwd) {
  const nm = path.join(cwd, 'node_modules');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  // lstat both: a symlinked node_modules or .bin is recorded as a link (readdir/isFile would follow it into its target)
  const lst = (f) => fsp.lstat(f).catch(() => null);
  const [nmSt, lockSt, binSt] = await Promise.all([lst(nm), lst(path.join(nm, '.package-lock.json')), lst(path.join(nm, '.bin'))]);
  const lock = nmSt?.isSymbolicLink() ? 'link' : lockSt?.isFile() ? sha(await fsp.readFile(path.join(nm, '.package-lock.json'))) : null;
  const names = nmSt?.isSymbolicLink() || binSt?.isSymbolicLink() || !binSt ? [] : (await fsp.readdir(path.join(nm, '.bin')).catch(() => [])).sort();
  const links = nmSt?.isSymbolicLink() || binSt?.isSymbolicLink() ? ['link'] : await Promise.all(names.map((n) => fsp.readlink(path.join(nm, '.bin', n)).then((to) => `${n}→${to}`, () => `${n}!file`)));
  return { lock, bin: sha(links.join('\0')) };
}

// U10: the baseline approve saves after setup: every config path then (and the ignored dirs seen, for the record).
// P5 M1: + the node_modules tripwire at the same moment.
const configBaseline = async (t, cwd, env = process.env) => ({ ...(await worktreeConfig({ ...t, config_baseline: undefined }, cwd, env)), tripwire: await tripwire(cwd) });

// board-terminal-parity Phase 2 task 6: folderMcp, realGit, chromePort, fileRemote, TB_GIT, TB_CHROME for lib/terminal-check.js (one source)
module.exports = { start, stopChrome, runSecrets, folderMcp, realGit, chromePort, fileRemote, TB_GIT, TB_CHROME, isolationArgv, ISOLATION_ENV, AGENT_GIT_ENV, RESUME_PROMPT, capKey, modelFor, finalModel, plantedConfig, configBaseline, dirtyPaths, contentDirty, treeDirty, tripwire };
