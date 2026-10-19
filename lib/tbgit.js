'use strict';
// tb-git: the board's git bridge (board-terminal-parity Phase 2 task 5; plan B1 B2 C2, spike d + h). A board run calls
// `<TB_CODE>/bin/tb-git <verb> …` as a plain Bash call: sandbox.excludedCommands runs it outside claude's seatbelt, with
// claude's process env (tbd's) only. git then runs as in Irfan's terminal (his global git config, his ssh keys through
// the SSH_AUTH_SOCK tbd itself got from launchd) but under the run's git profile (lib/phase-settings.js gitProfile:
// only git, git-core and ssh may run; writes only in the repo, never its git config, hooks or planted names) and with
// an env built here: the caller's env never reaches git (AGENT_GIT_ENV's no-push rewrite, a GIT_SSH_COMMAND).
// Verbs: fetch [<remote>] [<branch>], pull [<remote> <branch>] [--rebase|--ff-only] (both --no-tags; pull refuses a
// fetched tip that touches Claude config or the hooks dir), push <remote> <branch>, ls-remote <remote>, clone <url> <dir>.
// bin/tb-git (bash) execs lib/tbgit-main.js with TB_NODE, the board's own node (never one found on PATH).
// Any other word or flag: refused. tb-git builds git's argv itself; the repo is the ticket's clone from the tbd-written
// run file (TB_GIT_RUN): always --git-dir + --work-tree, its config pin checked before each git (util.cloneRefused), cwd
// inside it (a nested clone's own .git/config is never used). A remote whose URL is no registered tag's remote, and
// every push (never the tag's base branch, never forced or a deletion: a dry run first, then the sha pinned), wait for
// Irfan's Approve card: tbd.sock approve.ask (it only asks; the answer comes from Irfan) with the run file's ask_token
// (lib/slots.js checks it: only this bridge, never an agent on tbd.sock, raises a card).
// Push (security review H1): a code ticket's own branch only (tb/<ticket id>…; the ticket's base and the remote's default
// branch refused); every file it carries listed first (git diff from the remote's tip, or the ticket's base for a new
// branch): a planted name, the hooks dir, a CI file or a secret-looking path → refused before any card; the card names
// up to 15 files. --no-follow-tags: a push never carries a tag.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { call } = require('./slots');
const { GIT_SAFE, SHA_RE, cloneRefused, readPlain, within, isObj } = require('./util');

class Refused extends Error {}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // a remote name
const URL_OK = /^(ssh:\/\/\S+|https:\/\/\S+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+)$/; // clone: ssh (scp form or ssh://) or https only
const branchOk = (/** @type {string} */ b) => /^[\w./-]{1,200}$/.test(b) && !/^[-./]|[./]$|\.\.|\/\/|\/\.|\.lock(\/|$)/.test(b) && b !== 'HEAD';
const PLANTED = ['.claude', 'claude.md', 'claude.local.md', '.mcp.json', 'agents.md']; // lib/spawn.js CONFIG, any case
const planted = (/** @type {string} */ f, /** @type {string} */ hooks) => f.split('/').some((x) => PLANTED.includes(x.toLowerCase())) || (!!hooks && (f === hooks || f.startsWith(`${hooks}/`)));
// a push never carries these from a board run (H1): CI that runs on the remote, hook dirs, secret-looking files (any case: APFS)
const CI = /^(\.github\/|\.gitlab-ci\.yml$|\.circleci\/|Jenkinsfile$|\.buildkite\/|azure-pipelines\.yml$|bitbucket-pipelines\.yml$|\.travis\.yml$|\.drone\.yml$|\.husky\/|\.githooks\/)/i;
const SECRET = /(^|\/)(\.env[^/]*|id_[^/]*|[^/]*\.(pem|key|p12|pfx))$/i;
const few = (/** @type {string[]} */ list, /** @type {number} */ k) => `${list.slice(0, k).join(', ')}${list.length > k ? ` (+${list.length - k} more)` : ''}`;
const TB_GIT = path.join(__dirname, '..', 'bin', 'tb-git');

// argv → what to do, or Refused (pure). run: the run file (base = the tag's base branch).
function parse(/** @type {string[]} */ argv, /** @type {any} */ run) {
  const [verb, ...rest] = argv;
  const refuse = (/** @type {string} */ why) => { throw new Refused(why); };
  const flags = rest.filter((a) => a.startsWith('-'));
  const words = rest.filter((a) => !a.startsWith('-'));
  const only = (/** @type {string[]} */ ok) => {
    const bad = flags.find((f) => !ok.includes(f));
    if (bad) refuse(`${verb} takes no ${bad.slice(0, 40)}${ok.length ? ` (only ${ok.join(' or ')})` : ''}: tb-git builds git's options itself`);
  };
  const remote = (/** @type {string} */ r) => (NAME.test(r) ? r : refuse(`not a remote name: ${r.slice(0, 80)}`));
  const branch = (/** @type {string} */ b) => (branchOk(b) ? b : refuse(`not a branch name: ${b.slice(0, 80)}`));
  switch (verb) {
    case 'fetch':
      only([]);
      if (words.length > 2) refuse('usage: tb-git fetch [<remote>] [<branch>]');
      return { verb, remote: remote(words[0] ?? 'origin'), branch: words[1] === undefined ? null : branch(words[1]) };
    case 'pull':
      only(['--rebase', '--ff-only']);
      if (flags.length > 1 || (words.length !== 0 && words.length !== 2)) refuse('usage: tb-git pull [<remote> <branch>] [--rebase|--ff-only]');
      return { verb, remote: remote(words[0] ?? 'origin'), branch: words[1] === undefined ? null : branch(words[1]), mode: flags[0] ?? null };
    case 'push': {
      only([]);
      if (words.length !== 2) refuse('usage: tb-git push <remote> <branch>');
      const b = branch(words[1]);
      if (b === run.base) refuse(`a push to the base branch ${b} is refused: push your own branch`);
      // Phase 4: a Task pushes only its own branches (git.json own: the branch it started on when not the base, tb/<id>)
      if (run.kind === 'task') {
        const mine = Array.isArray(run.own) ? run.own.filter((x) => typeof x === 'string') : [];
        if (!mine.includes(b)) refuse(`push only this Task's branch ${mine.join(' or ') || '(none)'}, not ${b.slice(0, 80)}`);
        return { verb, remote: remote(words[0]), branch: b };
      }
      // H1: a code ticket pushes its own tb/<id>… branch only
      const own = `tb/${run.ticket}`;
      if (run.kind !== 'code' || typeof run.ticket !== 'string' || !run.ticket) refuse('a push is refused here: only a code ticket pushes, its own tb/<ticket id> branch');
      if (!b.startsWith(own) || !/^([-/]|$)/.test(b.slice(own.length))) refuse(`push only this ticket's own branch ${own}-…, not ${b.slice(0, 80)}`);
      return { verb, remote: remote(words[0]), branch: b };
    }
    case 'ls-remote':
      only([]);
      if (words.length !== 1) refuse('usage: tb-git ls-remote <remote>');
      return { verb, remote: remote(words[0]) };
    case 'clone': {
      only([]);
      if (words.length !== 2) refuse('usage: tb-git clone <url> <dir>');
      if (!URL_OK.test(words[0])) refuse(`clone takes an ssh or https URL, not ${words[0].slice(0, 80)}`);
      const dir = path.posix.normalize(words[1]);
      if (path.isAbsolute(dir) || dir === '.' || dir.split('/').includes('..')) refuse('clone <dir> is a new dir inside the current one');
      return { verb, url: words[0], dir };
    }
    default:
      return refuse(`unknown verb ${String(verb ?? '').slice(0, 40)}: tb-git fetch | pull | push | ls-remote | clone`);
  }
}

// git's env: built from the run file only (tbd's HOME, USER, LANG, its own SSH_AUTH_SOCK), a fixed PATH, no prompt, no
// editor. The caller's env (claude's: GIT_*, SSH_*, a token from ~/.zshenv) is never read.
const gitEnv = (/** @type {any} */ run) => ({ HOME: run.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: run.lang, USER: run.user,
  ...(run.ssh_auth_sock && { SSH_AUTH_SOCK: run.ssh_auth_sock }), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' });
// git's argv: tbd's safe config (no hooks, no fsmonitor), only ssh + https (file: TB_GIT_FILE_REMOTE, tests), no
// submodules, the ticket repo pinned (repo false: clone, which makes a new one)
const gitArgs = (/** @type {any} */ run, /** @type {string[]} */ args, repo = true) => [...GIT_SAFE, '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.https.allow=always', ...(run.file_remote ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false', ...(repo ? ['--git-dir', run.git_dir, '--work-tree', run.repo] : []), ...args];

const RUN_KEYS = ['repo', 'git_dir', 'common_dir', 'git', 'profile', 'home', 'sock'];
async function runFile() {
  const file = process.env.TB_GIT_RUN;
  if (!file || !path.isAbsolute(file)) throw new Refused('board runs only, with the git bridge on (terminal.git_bridge)');
  let run = null;
  try { run = JSON.parse((await readPlain(file, 64 << 10)) ?? 'null'); } catch { /* refused below */ }
  if (!isObj(run) || !RUN_KEYS.every((k) => typeof run[k] === 'string' && path.isAbsolute(run[k])) || !isObj(run.clone) || !isObj(run.remotes) || !Array.isArray(run.registered)) {
    throw new Refused(`no readable run file at ${file}: board runs only`);
  }
  return run;
}

async function main(/** @type {string[]} */ argv) {
  try {
    process.exitCode = await bridge(argv);
  } catch (e) {
    process.stderr.write(`tb-git: ${e instanceof Refused ? e.message : `error: ${e.message}`}\n`);
    process.exitCode = 2;
  }
}

async function bridge(/** @type {string[]} */ argv) {
  const run = await runFile();
  // excludedCommands only matches a plain call: anything compound stays in claude's seatbelt, where git has no keys
  if (spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status !== 0) {
    throw new Refused(`still inside the sandbox. Call it by its full path, alone in its Bash call (no &&, ;, |, $(...), > or 2>&1): ${TB_GIT} ${argv.join(' ')}`);
  }
  const p = parse(argv, run);
  const cwd = fs.realpathSync(process.cwd());
  if (!within(cwd, fs.realpathSync(run.repo))) throw new Refused(`run it inside the ticket's repo ${run.repo}`);
  const dirs = { git_dir: run.git_dir, common_dir: run.common_dir, clone: run.clone };
  // one git under the profile, the pin checked first. → {status, stdout, stderr}
  const git = async (/** @type {string[]} */ args, repo = true) => {
    const why = await cloneRefused(dirs);
    if (why) throw new Refused(`the repo is not as tbd pinned it (${why}): git refused`);
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', run.profile, run.git, ...gitArgs(run, args, repo)], { cwd, env: gitEnv(run), encoding: 'utf8', timeout: 300_000, maxBuffer: 16 << 20 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error?.message ?? '') };
  };
  const show = (/** @type {{status: number, stdout: string, stderr: string}} */ r) => {
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return r.status;
  };
  // more (push): remote, branch, sha — Phase 4: a Task push is leak-scanned and may go on a single-use grant (no card)
  const askIrfan = async (/** @type {string} */ kind, /** @type {string} */ text, /** @type {Record<string, string>} */ more = {}) => {
    process.stderr.write(`tb-git: waiting for Irfan's answer on the board: ${text}\n`);
    const res = await call(run.sock, { op: 'approve.ask', run: process.env.TBX_RUN, pid: process.pid, n: run.n, token: run.ask_token, kind, text: text.slice(0, 2000), ...more })
      .catch((e) => ({ ok: false, error: e.code === 'ECONNRESET' ? 'the board restarted' : e.message }));
    if (!res?.ok) throw new Refused(`could not ask Irfan: ${res?.error ?? 'no answer'}`);
    if (!res.yes) throw new Refused(`Irfan said no${res.message ? ` (${res.message})` : ''}`);
  };
  // a remote of the pinned config; its URL no registered tag's remote → Irfan's card first
  const known = async (/** @type {string} */ name, /** @type {string} */ verb, push = false) => {
    const r = run.remotes[name];
    const url = (push && r?.pushurl) || r?.url;
    if (typeof url !== 'string' || !url) throw new Refused(`no remote ${name} in this repo`);
    if (!run.registered.includes(url)) await askIrfan('remote', `tb-git ${verb} ${name}: ${url} is no remote of a board tag`);
    return url;
  };
  switch (p.verb) {
    case 'fetch':
      await known(p.remote, 'fetch');
      return show(await git(['fetch', '--no-tags', '--no-recurse-submodules', p.remote, ...(p.branch ? [p.branch] : [])]));
    case 'ls-remote':
      await known(p.remote, 'ls-remote');
      return show(await git(['ls-remote', p.remote]));
    case 'pull': {
      await known(p.remote, 'pull');
      const cur = p.branch ?? (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
      if (!branchOk(cur)) throw new Refused('HEAD is on no branch: name it, tb-git pull <remote> <branch>');
      const f = await git(['fetch', '--no-tags', '--no-recurse-submodules', p.remote, cur]);
      if (f.status) return show(f);
      // L8: the fetched tip, once: the diff checked and the merge are the same commit
      const tip = (await git(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])).stdout.trim();
      if (!SHA_RE.test(tip)) throw new Refused('the fetch gave no commit: nothing merged');
      const d = await git(['diff', '--name-only', '-z', `HEAD...${tip}`]); // what the merge would bring in
      if (d.status) return show(d);
      const bad = d.stdout.split('\0').filter((x) => x && planted(x, run.hooks));
      if (bad.length) throw new Refused(`pull touches ${few(bad, 3)} — pull from your terminal`);
      return show(await git(p.mode === '--rebase' ? ['rebase', tip] : ['merge', p.mode === '--ff-only' ? '--ff-only' : '--no-edit', tip]));
    }
    case 'push': {
      const url = await known(p.remote, 'push', true);
      // H1: the remote's default branch (its HEAD) is refused like the base; unknown (no HEAD listed): the base rule only
      const def = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec((await git(['ls-remote', '--symref', p.remote, 'HEAD'])).stdout)?.[1];
      if (def === p.branch) throw new Refused(`a push to ${p.remote}'s default branch ${def} is refused: push your own branch`);
      const sha = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}^{commit}`])).stdout.trim();
      if (!SHA_RE.test(sha)) throw new Refused(`no local branch ${p.branch}`);
      const to = `${sha}:refs/heads/${p.branch}`; // the sha pinned now: Yes pushes exactly it
      const dry = await git(['push', '--dry-run', '--porcelain', '--no-verify', '--no-follow-tags', p.remote, to]);
      const line = dry.stdout.split('\n').map((l) => /^([ +\-*=!])\t[^\t]*\t(.*)$/.exec(l)).find(Boolean);
      if (!line) {
        show(dry);
        throw new Refused('the dry run gave no answer: nothing pushed');
      }
      const [, flag, summary] = line;
      if (flag === '+') throw new Refused('a forced update is refused: pull first, then push');
      if (flag === '-') throw new Refused('a deletion is refused');
      if (flag === '!') throw new Refused(`the remote refuses it: ${summary.slice(0, 200)}`);
      if (flag === '=') {
        process.stdout.write('tb-git: up to date, nothing to push\n');
        return 0;
      }
      // what the push carries: a fast-forward from the remote's tip, a new branch from where it left the ticket's base
      // (three dots: the merge base); both sides of a rename (--no-renames). Not listed → nothing pushed.
      const from = flag === ' ' ? summary.split('..')[0] : run.base_sha;
      const list = from ? await git(['diff', '--name-only', '--no-renames', '-z', `${from}...${sha}`]) : null;
      if (!list || list.status) throw new Refused('cannot list what the push carries: push from your terminal');
      // security review r3: also each file any pushed commit touched (a .env committed, then deleted, is still in the history)
      const hist = await git(['log', '--format=', '--name-only', '--no-renames', '-z', `${from}..${sha}`]);
      if (hist.status) throw new Refused('cannot list what the push carries: push from your terminal');
      const files = [...new Set([...list.stdout.split('\0'), ...hist.stdout.split('\0')].filter(Boolean))];
      const bad = files.filter((x) => planted(x, run.hooks) || CI.test(x) || SECRET.test(x));
      if (bad.length) throw new Refused(`push touches ${few(bad, 3)}: push from your terminal`);
      const n = (await git(['rev-list', '--count', `${from}..${sha}`])).stdout.trim();
      const names = files.map((f) => (f.length > 100 ? `${f.slice(0, 99)}…` : f)); // 15 of them fit the card's 2000 characters
      await askIrfan('push', `push ${p.branch} to ${p.remote} (${url}): ${n || '?'} commit(s), ${sha.slice(0, 12)}; files: ${few(names, 15) || '(none)'}`, { remote: p.remote, branch: p.branch, sha });
      return show(await git(['push', '--porcelain', '--no-verify', '--no-follow-tags', p.remote, to]));
    }
    case 'clone': {
      // L9: the target's real parent inside cwd (a planted link never leads out) and nothing at the target, not even a
      // link (lstat); checked before any card. git gets the real path.
      const target = path.resolve(cwd, p.dir);
      const parent = await fsp.realpath(path.dirname(target)).catch(() => '');
      const taken = await fsp.lstat(target).then(() => true, () => false);
      if (!parent || !within(parent, cwd) || target === cwd || taken) throw new Refused(`clone <dir> must be a new dir inside ${cwd}`);
      if (!run.registered.includes(p.url)) await askIrfan('remote', `tb-git clone ${p.url}: no remote of a board tag`);
      return show(await git(['clone', '--no-recurse-submodules', '--', p.url, path.join(parent, path.basename(target))], false));
    }
    default:
      throw new Refused('unknown verb');
  }
}

module.exports = { main, parse, gitEnv, gitArgs, planted, Refused };
