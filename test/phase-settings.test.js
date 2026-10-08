'use strict';
// P2 AC10 (+ AC8 sandbox block, D35c, D9): per-phase settings templates rendered by lib/phase-settings.js.
// Table = spec §5 tool lists per phase (working/qa/pr/context derived from §5 text + §6 + §9, see EXPECTED notes);
// deny = plan §3b exact paths + D35c; hooks wired by path; rendered env drives the real bash-guard / path-guard.
// Real-run proof of the same settings: scripts/contain-smoke.js (docs/verification/2026-10-08-p2-containment.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, tools } = require('../lib/phase-settings');
const { guard } = require('../hooks/bash-guard');
const { check } = require('../hooks/path-guard');

const REPO = path.join(__dirname, '..');
const H = '/u/.taskboard';
const CTX = {
  WORKTREE: `${H}/worktrees/t_abc123`, TICKET_DIR: `${H}/tickets/t_abc123`, OUT_DIR: `${H}/tickets/t_abc123/out`,
  TB_HOME: H, TAG_PATH: '/u/code/repo', SKILLS_DIR: `${H}/tickets/t_abc123/skills`, TB_CODE: REPO, TB_NODE: '/u/.nvm/v24/bin/node', TB_PORT: 7777,
  HEAVY: ['npm test', 'npm run build'],
};
const RO = ['Read', 'Glob', 'Grep'];
const GIT = [...RO, 'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)']; // §5 planning; review "read-only git"
const WEB = ['WebSearch', 'WebFetch'];
const W = (p) => `Edit(/${p}/**)`;
// kind/phase → [allow, write roots]
const EXPECTED = {
  'code/planning': [GIT, []],
  'research/planning': [[...GIT, ...WEB], []], // §5: + WebSearch, WebFetch for research and brainstorm
  'brainstorm/planning': [[...GIT, ...WEB], []],
  'design/planning': [GIT, []],
  'code/working': [[...RO, W(CTX.WORKTREE), 'Bash', 'Agent'], [CTX.WORKTREE]], // tasks in the worktree, ≤3 subagents (§6)
  'research/working': [[...RO, W(CTX.OUT_DIR), ...WEB, 'Agent'], [CTX.OUT_DIR]], // one session, ≤3 subagents, only out/
  'brainstorm/working': [[...RO, W(CTX.OUT_DIR), ...WEB, 'Agent'], [CTX.OUT_DIR]], // research variant
  'design/working': [[...RO, W(CTX.OUT_DIR), 'Agent'], [CTX.OUT_DIR]],
  'code/review': [GIT, []], // read-only: Read, Glob, Grep + read-only git
  'research/review': [RO, []],
  'brainstorm/review': [RO, []],
  'design/review': [RO, []],
  'code/qa': [[...RO, W(`${CTX.WORKTREE}/qa`), 'Bash', 'Agent'], [`${CTX.WORKTREE}/qa`]], // QA writes only to qa/
  'research/qa': [RO, []], // claim spot-check reads the runner's fetched pages; no subagents (§6)
  'design/qa': [RO, []], // visual check
  'code/pr': [[...RO, W(CTX.OUT_DIR)], [CTX.OUT_DIR]], // Sonnet writes out/pr.md
  'code/context': [[...GIT, W(`${CTX.WORKTREE}/.learning`)], [`${CTX.WORKTREE}/.learning`]], // module context refresh
};
const all = () => Object.keys(EXPECTED).map((k) => [k, render(...k.split('/'), CTX)]);

test('phase-settings: one template per §5/§6 phase, allow == table, no prompt.md or schema anywhere (D9)', () => {
  const found = [];
  for (const kind of fs.readdirSync(path.join(REPO, 'phases'))) {
    for (const phase of fs.readdirSync(path.join(REPO, 'phases', kind))) {
      found.push(`${kind}/${phase}`);
      assert.deepEqual(fs.readdirSync(path.join(REPO, 'phases', kind, phase)), ['settings.json'], `${kind}/${phase}`);
    }
  }
  assert.deepEqual(found.sort(), Object.keys(EXPECTED).sort());
  for (const [k, s] of all()) {
    assert.deepEqual(s.permissions.allow, EXPECTED[k][0], k);
    assert.deepEqual(JSON.parse(s.env.TB_WRITE_ROOTS), EXPECTED[k][1], k);
    assert.doesNotMatch(JSON.stringify(s), /\$\{/, `${k}: placeholder left`);
  }
});

test('phase-settings: §3b deny paths + D35c reads on every phase; own worktree and out/ never denied', () => {
  const must = [
    ...['config.json', 'tags.json', 'tasks.json', 'token', 'session', 'metrics.jsonl', 'leak-denylist.txt', 'slots.json', 'doctor.json',
      'events.jsonl', 'tbd.log', 'tbd.pid', 'deploy.log', 'backup/**'].flatMap((f) => [`Read(/${H}/${f})`, `Edit(/${H}/${f})`]),
    `Edit(/${H}/tbd.sock)`, `Edit(/${H}/bin/**)`, W(CTX.SKILLS_DIR), 'Edit(~/taskboard-live/**)', `Edit(/${CTX.WORKTREE}/.git)`,
    `Edit(/${CTX.TICKET_DIR}/*.json)`, `Edit(/${CTX.TICKET_DIR}/rounds/**)`, 'Bash(git push *)',
  ];
  for (const [k, s] of all()) {
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true, k); // file tools: cwd + --add-dir only
    assert.ok(!JSON.stringify(s.permissions.allow).includes('tbx'), `${k}: rewrite wrapper allowed by name`);
    for (const rule of must) assert.ok(s.permissions.deny.includes(rule), `${k}: missing ${rule}`);
    // committing phases write the tag repo's shared .git from their worktree: no tag deny there (smoke: commit works,
    // main checkout still unwritable); every other phase denies the tag path
    const committing = k === 'code/working' || k === 'code/qa';
    assert.equal(s.permissions.deny.includes(W(CTX.TAG_PATH)), !committing, `${k}: tag path deny`);
    assert.ok(!s.permissions.allow.some((r) => r.includes(CTX.TAG_PATH)), `${k}: tag path allowed`);
    // deny beats allow: no deny rule may cover the worktree or out/ (spec §9's blanket ~/.taskboard deny did)
    for (const rule of s.permissions.deny) {
      const p = /^\w+\(\/(\/.*?)(\/\*\*)?\)$/.exec(rule)?.[1];
      if (p) for (const own of [CTX.WORKTREE, CTX.OUT_DIR]) assert.ok(!own.startsWith(`${p}/`) && own !== p, `${k}: ${rule} covers ${own}`);
      if (p) assert.ok(!`${CTX.WORKTREE}/src/a.ts`.startsWith(`${p}/`), `${k}: ${rule} covers worktree files`);
    }
  }
});

test('phase-settings: hooks wired by absolute path; sandbox kept on, localhost only for Bash test phases (AC8)', () => {
  const cmd = (name) => [{ type: 'command', command: `"${CTX.TB_NODE}" "${REPO}/hooks/${name}.js"` }]; // never PATH's node
  for (const [k, s] of all()) {
    assert.deepEqual(s.hooks.PreToolUse, [
      { matcher: 'Bash', hooks: cmd('bash-guard') },
      { matcher: 'Edit|Write|NotebookEdit|MultiEdit', hooks: cmd('path-guard') },
      { matcher: 'Agent|Task', hooks: cmd('subagent-count') },
    ], k);
    assert.deepEqual(s.hooks.SubagentStart, [{ hooks: cmd('subagent-count') }], k);
    assert.deepEqual(s.hooks.SubagentStop, [{ hooks: cmd('subagent-count') }], k);
    for (const name of ['bash-guard', 'path-guard', 'subagent-count']) assert.ok(fs.existsSync(path.join(REPO, 'hooks', `${name}.js`)));
    assert.deepEqual({ ...s.env, TB_WRITE_ROOTS: undefined }, { TBD_SOCK: `${H}/tbd.sock`, TB_PORT: '7777', TB_HEAVY: '["npm test","npm run build"]', TB_CODE: REPO, TB_WRITE_ROOTS: undefined }, k);
    const sb = s.sandbox;
    assert.equal(sb.enabled && sb.failIfUnavailable && !sb.allowUnsandboxedCommands && !sb.autoAllowBashIfSandboxed, true, k);
    assert.deepEqual(sb.filesystem.denyRead, [H], k);
    const bashPhase = k === 'code/working' || k === 'code/qa';
    const reopen = bashPhase ? [REPO, '/u/.nvm/v24', '~/.npm', '~/Library/Caches/ms-playwright'] : []; // tbx, node, npm
    assert.deepEqual(sb.filesystem.allowRead, [CTX.WORKTREE, CTX.TICKET_DIR, `${H}/tbd.sock`, ...reopen], k);
    for (const p of [REPO, '/u/.nvm/v24/bin', '~/.claude*', '~/.zshrc', `${CTX.TAG_PATH}/.git/config`, `${CTX.TAG_PATH}/.git/hooks`,
      `${CTX.TAG_PATH}/.git/info`, `${CTX.TAG_PATH}/.git/modules`, `${CTX.TAG_PATH}/.git/worktrees/*/config.worktree`, `${CTX.WORKTREE}/.git`]) {
      assert.ok(sb.filesystem.denyWrite.includes(p), `${k}: denyWrite ${p}`);
    }
    assert.ok(!sb.filesystem.denyWrite.some((p) => CTX.WORKTREE.startsWith(`${p}/`) || p === CTX.WORKTREE), `${k}: worktree write-denied`);
    assert.deepEqual(sb.network.allowUnixSockets, [`${H}/tbd.sock`], k);
    assert.equal(sb.network.allowLocalBinding === true, bashPhase, `${k}: allowLocalBinding`);
  }
});

test('phase-settings: --tools from allow (Edit brings Write); read-only phases get no write tool', () => {
  assert.deepEqual(tools(render('code', 'working', CTX)), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Agent']);
  assert.deepEqual(tools(render('code', 'planning', CTX)), ['Read', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(tools(render('research', 'review', CTX)), ['Read', 'Glob', 'Grep']);
});

test('phase-settings: rendered env drives the real guards (worktree write ok, config/token/tbd port denied)', () => {
  const s = render('code', 'working', CTX);
  assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/src/a.ts` } }, s.env), null);
  assert.equal(check({ tool_input: { file_path: `${H}/config.json` } }, s.env)?.permissionDecision, 'deny');
  assert.equal(check({ tool_input: { file_path: `${H}/tickets/other/x.md` } }, s.env)?.permissionDecision, 'deny');
  assert.match(guard(`cat ${H}/token`, s.env)?.deny ?? '', /token and session/);
  assert.match(guard('curl -s http://127.0.0.1:7777/api/state', s.env)?.deny ?? '', /HTTP API/);
  assert.deepEqual(guard('cd x && npm run build', s.env), { command: `"$TB_CODE/bin/tbx" heavy -- sh -c 'cd x && npm run build'` });
  const ro = render('code', 'planning', CTX); // no write roots → path-guard denies every write
  assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/a.ts` } }, ro.env)?.permissionDecision, 'deny');
});

test('phase-settings: bad ctx or phase name is refused, nothing rendered', () => {
  const bad = [
    { WORKTREE: 'worktrees/t1' }, { TAG_PATH: '/u/code/"repo' }, { TAG_PATH: '/u/code/repo/../x' }, { SKILLS_DIR: '/u/s/' },
    { TB_CODE: '/u/$(id)' }, { OUT_DIR: '/u/o/*' }, { TB_NODE: 'node' }, { TICKET_DIR: undefined }, { TB_PORT: '77; rm' }, { HEAVY: 'npm test' }, { HEAVY: [''] },
  ];
  for (const b of bad) assert.throws(() => render('code', 'working', { ...CTX, ...b }), /phase-settings:/, JSON.stringify(b));
  for (const [kind, phase] of [['..', 'working'], ['code', '../planning'], ['code', 'nope'], ['Code', 'working']]) {
    assert.throws(() => render(kind, phase, CTX), /phase-settings:/, `${kind}/${phase}`);
  }
});
