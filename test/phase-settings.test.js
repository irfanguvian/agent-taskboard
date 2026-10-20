'use strict';
// P2 AC10 (+ AC8 sandbox block, D35c, D9): per-phase settings templates rendered by lib/phase-settings.js.
// Table = spec §5 tool lists per phase (working/qa/pr/context derived from §5 text + §6 + §9, see EXPECTED notes);
// deny = plan §3b exact paths + D35c; hooks wired by path; rendered env drives the real bash-guard / path-guard.
// Real-run proof of the same settings: scripts/contain-smoke.js (docs/verification/2026-10-08-p2-containment.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { render, tools } = require('../lib/phase-settings');
const { guard } = require('../hooks/bash-guard');
const { check } = require('../hooks/path-guard');

const REPO = path.join(__dirname, '..');
const H = '/u/.taskboard';
const CTX = {
  WORKTREE: `${H}/worktrees/t_abc123`, TICKET_DIR: `${H}/tickets/t_abc123`, OUT_DIR: `${H}/tickets/t_abc123/out`,
  TB_HOME: H, TAG_PATH: '/u/code/repo', SKILLS_DIR: `${H}/tickets/t_abc123/skills`, TB_CODE: REPO, TB_NODE: '/u/.nvm/v24/bin/node', TB_PORT: 7777,
  HEAVY: ['npm test', 'npm run build'], TAG_GIT: '/u/code/main/.git', // H2.7: the ticket's common_dir (here: the tag is a linked worktree of main)
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
  'code/working': [[...RO, W(CTX.WORKTREE), 'Bash'], [CTX.WORKTREE]], // tasks in the worktree; P5 K15 (contract change; was + Agent): no subagents
  'research/working': [[...RO, W(CTX.OUT_DIR), ...WEB, 'Agent'], [CTX.OUT_DIR]], // one session, ≤3 subagents, only out/
  'brainstorm/working': [[...RO, W(CTX.OUT_DIR), ...WEB, 'Agent'], [CTX.OUT_DIR]], // research variant
  'design/working': [[...RO, W(CTX.OUT_DIR), 'Agent'], [CTX.OUT_DIR]],
  'code/review': [GIT, []], // read-only: Read, Glob, Grep + read-only git
  'research/review': [RO, []],
  'brainstorm/review': [RO, []],
  'design/review': [RO, []],
  // M5 C5 (contract change; was Edit(qa/**)): QA writes only its reports + screenshots under docs/verification/
  'code/qa': [[...RO, W(`${CTX.WORKTREE}/docs/verification`), 'Bash', 'Agent'], [`${CTX.WORKTREE}/docs/verification`]],
  'research/qa': [RO, []], // claim spot-check reads the runner's fetched pages; no subagents (§6)
  'design/qa': [RO, []], // visual check
  // M5.3 A17 (contract change; was code/pr: Read, Glob, Grep + Edit(out/**), Sonnet writes out/pr.md): no PR phase (D-0082:
  // gh and PRs are gone); code/final_gate reads with review's git and writes its two docs under the docs dirs only (C11)
  'code/final_gate': [[...GIT, W(`${CTX.WORKTREE}/docs/verdicts`), W(`${CTX.WORKTREE}/docs/verification`)], [`${CTX.WORKTREE}/docs/verdicts`, `${CTX.WORKTREE}/docs/verification`]],
  'code/context': [[...GIT, W(`${CTX.WORKTREE}/.learning`)], [`${CTX.WORKTREE}/.learning`]], // module context refresh
  // board-terminal-parity Phase 4 (contract edit): a Task plans read-only (+ git status), works like code/working
  'task/planning': [[...GIT, 'Bash(git status *)'], []],
  'task/working': [[...RO, W(CTX.WORKTREE), 'Bash'], [CTX.WORKTREE]],
};
const all = () => Object.keys(EXPECTED).map((k) => [k, render(...k.split('/'), CTX)]);
// S1: Claude config at any depth (and top level) of every root an agent can write
const PLANTED = [CTX.WORKTREE, CTX.TICKET_DIR, CTX.TAG_PATH].flatMap((r) => ['.claude', 'CLAUDE.md', 'CLAUDE.local.md'].flatMap((f) => [`${r}/${f}`, `${r}/**/${f}`]));

test('phase-settings: one template per §5/§6 phase, allow == table, prompt.md + schema only where built (D9)', () => {
  const found = [];
  const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); // M5.1: phases/_rules.md is a file, not a kind
  for (const kind of dirs(path.join(REPO, 'phases'))) {
    for (const phase of dirs(path.join(REPO, 'phases', kind))) {
      found.push(`${kind}/${phase}`);
      // P4 (contract change; was settings.json only everywhere): code/planning is built (D9: prompt.md + settings.json +
      // result.schema.json + its handler), landed after the fable evals passed 3/3 and golden A scored 4/5 (AC1 AC9)
      // P5 (contract change; was settings.json only): code/working gains its result.schema.json (P5d: prompt.md landed, code/working is built)
      const want = { 'code/planning': ['prompt.md', 'result.schema.json', 'settings.json'], 'code/working': ['prompt.md', 'result.schema.json', 'settings.json'],
        // M5.1 (contract change; was settings.json only): code/review is built (D9: prompt.md + result.schema.json + settings.json)
        'code/review': ['prompt.md', 'result.schema.json', 'settings.json'],
        // M5.2 (contract change; was settings.json only): code/qa is built (D9: prompt.md + result.schema.json + settings.json)
        'code/qa': ['prompt.md', 'result.schema.json', 'settings.json'],
        // M5.3 (new phase dir): code/final_gate is built (D9: prompt.md + result.schema.json + settings.json)
        'code/final_gate': ['prompt.md', 'result.schema.json', 'settings.json'],
        // board-terminal-parity Phase 4 (contract edit; new phase dirs): task/planning + task/working are built
        'task/planning': ['prompt.md', 'result.schema.json', 'settings.json'], 'task/working': ['prompt.md', 'result.schema.json', 'settings.json'] };
      assert.deepEqual(fs.readdirSync(path.join(REPO, 'phases', kind, phase)), want[`${kind}/${phase}`] ?? ['settings.json'], `${kind}/${phase}`);
    }
  }
  assert.deepEqual(found.sort(), Object.keys(EXPECTED).sort());
  for (const [k, s] of all()) {
    assert.deepEqual(s.permissions.allow, EXPECTED[k][0], k);
    assert.deepEqual(JSON.parse(s.env.TB_WRITE_ROOTS), EXPECTED[k][1], k);
    assert.doesNotMatch(JSON.stringify(s), /\$\{/, `${k}: placeholder left`);
  }
});

test('phase-settings: §3b deny paths + D35c reads + S1 Claude config on every phase; own worktree and out/ never denied', () => {
  const must = [
    ...['config.json', 'tags.json', 'tasks.json', 'token', 'session', 'metrics.jsonl', 'leak-denylist.txt', 'slots.json', 'doctor.json',
      'events.jsonl', 'tbd.log', 'tbd.pid', 'deploy.log', 'backup/**', 'rec-key*'].flatMap((f) => [`Read(/${H}/${f})`, `Edit(/${H}/${f})`]), // rec-key: M5 C6
    // H2.7 SPIKE S2 FIX (contract change; was Edit(/<worktree>/.git)): the tag's git dir, the clone's git files one by one (H2.7 test below)
    `Edit(/${H}/tbd.sock)`, `Edit(/${H}/bin/**)`, W(CTX.SKILLS_DIR), 'Edit(~/taskboard-live/**)', W(CTX.TAG_GIT),
    `Edit(/${CTX.TICKET_DIR}/*.json)`, `Edit(/${CTX.TICKET_DIR}/rounds/**)`, 'Bash(git push *)',
    ...PLANTED.map((p) => `Edit(/${p}${p.endsWith('.claude') ? '/**' : ''})`),
  ];
  for (const [k, s] of all()) {
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true, k); // file tools: cwd + --add-dir only
    assert.ok(!JSON.stringify(s.permissions.allow).includes('tbx'), `${k}: rewrite wrapper allowed by name`);
    for (const rule of must) assert.ok(s.permissions.deny.includes(rule), `${k}: missing ${rule}`);
    // committing phases write the tag repo's shared .git from their worktree: no tag deny there (smoke: commit works,
    // main checkout still unwritable); every other phase denies the tag path
    const committing = k === 'code/working' || k === 'code/qa' || k === 'task/working'; // Phase 4 contract edit: task/working = code/working's template
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
      ...(k === 'code/planning' ? [{ matcher: 'StructuredOutput', hooks: cmd('plan-check') }] : []), // P4e J15: planning only
    ], k);
    assert.deepEqual(s.hooks.SubagentStart, [{ hooks: cmd('subagent-count') }], k);
    assert.deepEqual(s.hooks.SubagentStop, [{ hooks: cmd('subagent-count') }], k);
    for (const name of ['bash-guard', 'path-guard', 'subagent-count', 'plan-check']) assert.ok(fs.existsSync(path.join(REPO, 'hooks', `${name}.js`)));
    assert.deepEqual({ ...s.env, TB_WRITE_ROOTS: undefined }, { TBD_SOCK: `${H}/tbd.sock`, TB_PORT: '7777', TB_HEAVY: '["npm test","npm run build"]', TB_CODE: REPO, TB_WRITE_ROOTS: undefined }, k);
    const sb = s.sandbox;
    assert.equal(sb.enabled && sb.failIfUnavailable && !sb.allowUnsandboxedCommands && !sb.autoAllowBashIfSandboxed, true, k);
    // P4 L8 (contract change; was [TB_HOME] only): a TB_HOME that is not the live ~/.taskboard denies the live one too
    assert.deepEqual(sb.filesystem.denyRead, [H, path.join(os.homedir(), '.taskboard')], k);
    const bashPhase = k === 'code/working' || k === 'code/qa' || k === 'task/working'; // Phase 4 contract edit: task/working = code/working's template
    // tbx, node, npm; M5 S4 (contract change; was none): code/qa reads the one DB CLI file, not ~/bin
    const reopen = bashPhase ? [REPO, '/u/.nvm/v24', '~/.npm', '~/Library/Caches/ms-playwright', ...(k === 'code/qa' ? ['~/bin/postgres-irfan-axi'] : [])] : [];
    // H2.7 (contract change; was without the tag objects): the clone reads the tag repo's objects through its alternates
    assert.deepEqual(sb.filesystem.allowRead, [CTX.WORKTREE, CTX.TICKET_DIR, `${H}/tbd.sock`, `${CTX.TAG_GIT}/objects`, ...reopen], k);
    // H2.7 (contract change; was the tag's .git/{config,hooks,info,modules,refs/replace,worktrees/*/{config.worktree,commondir,gitdir}}
    // + the worktree's .git file): the tag's whole git dir (both names); the clone's own git files in the H2.7 test below
    for (const p of [REPO, '/u/.nvm/v24/bin', '~/.claude*', '~/.zshrc', CTX.TAG_GIT, `${CTX.TAG_PATH}/.git`, `${CTX.TICKET_DIR}/runs`, ...PLANTED,
      `${CTX.TICKET_DIR}/rounds`, `${CTX.TICKET_DIR}/*.json`]) { // P4 S1, L7
      assert.ok(sb.filesystem.denyWrite.includes(p), `${k}: denyWrite ${p}`);
    }
    assert.ok(!sb.filesystem.denyWrite.some((p) => CTX.WORKTREE.startsWith(`${p}/`) || p === CTX.WORKTREE), `${k}: worktree write-denied`);
    assert.deepEqual(sb.network.allowUnixSockets, [`${H}/tbd.sock`], k);
    assert.equal(sb.network.allowLocalBinding === true, bashPhase, `${k}: allowLocalBinding`);
  }
  const live = path.join(os.homedir(), '.taskboard'); // L8: the live TB_HOME is denied once, not twice
  assert.deepEqual(render('code', 'planning', { ...CTX, TB_HOME: live }).sandbox.filesystem.denyRead, [live]);
});

// P5 M1 (contract change; code/working had no node_modules rules): the spike's char-class rules (p5-spike.md, run 2): an
// Edit deny becomes a sandbox write deny too, so node_modules/** would block .cache/.prisma; only non-dot entries, .bin
// and .package-lock.json are denied; env files (ctx.ENV_FILES) are denied in both layers
// H2.7 D-0151 (contract change; was without .pnpm, .modules.yaml, .yarn-state.yml, in the working/qa/final_gate templates):
// one node_modules list in BASE: pnpm's store + state and yarn's state are agent-proof too
test('phase-settings: code/working M1 node_modules + env-file denies, .cache / .prisma left writable; D34 trailer off', () => {
  const s = render('code', 'working', { ...CTX, ENV_FILES: ['.env.test'] });
  const nm = `${CTX.WORKTREE}/node_modules`;
  const edit = [`${nm}/[a-zA-Z0-9@_-]*`, `${nm}/[a-zA-Z0-9@_-]*/**`, `${nm}/.bin`, `${nm}/.bin/**`, `${nm}/.package-lock.json`, `${nm}/.pnpm`, `${nm}/.pnpm/**`,
    `${nm}/.modules.yaml`, `${nm}/.yarn-state.yml`, `${CTX.WORKTREE}/.env.test`].map((p) => `Edit(/${p})`);
  assert.deepEqual(s.permissions.deny.filter((r) => r.includes('node_modules') || r.includes('.env.test')), edit);
  assert.deepEqual(s.sandbox.filesystem.denyWrite.filter((p) => p.includes('node_modules') || p.includes('.env.test')),
    [`${nm}/[a-zA-Z0-9@_-]*`, `${nm}/.bin`, `${nm}/.package-lock.json`, `${nm}/.pnpm`, `${nm}/.modules.yaml`, `${nm}/.yarn-state.yml`, `${CTX.WORKTREE}/.env.test`]);
  assert.ok(![...s.permissions.deny, ...s.sandbox.filesystem.denyWrite].some((r) => /node_modules\/\*\*|node_modules\)$|\.cache|\.prisma/.test(r)), 'no rule covers node_modules/.cache or .prisma');
  assert.deepEqual(s.attribution, { commit: '', pr: '' });
});

// M5 C5 + S4 (contract change; code/qa had Edit(qa/**) and network registry.npmjs.org): QA writes docs/verification/
// only, reaches no domain (loopback via allowLocalBinding: the app, 127.0.0.1:5432), and carries code/working's
// node_modules + env-file denies and attribution off verbatim
test('phase-settings: code/qa M5 C5: Edit docs/verification/** only (real path-guard), no allowed domain, working\'s node_modules + env-file denies, D34 trailer off', () => {
  const ctx = { ...CTX, ENV_FILES: ['.env.test'] };
  const qa = render('code', 'qa', ctx);
  const working = render('code', 'working', ctx);
  const nm = (r) => r.includes('node_modules') || r.includes('.env.test');
  assert.deepEqual(qa.permissions.deny.filter(nm), working.permissions.deny.filter(nm));
  assert.equal(qa.permissions.deny.filter(nm).length, 10, '9 node_modules rules + the env file (the list: the M1 test above; H2.7 contract change: was 5 + 1)');
  assert.deepEqual(qa.sandbox.filesystem.denyWrite.filter(nm), working.sandbox.filesystem.denyWrite.filter(nm));
  // M5.2 sec F2: QA never commits, so no index write either (update-index --skip-worktree would blind the tree pin).
  // H2.7 (contract change; was the tag's .git: QA's [true], working's [false]): the clone's whole .git; the tag's in both
  assert.deepEqual([qa, working].map((s) => s.sandbox.filesystem.denyWrite.includes(`${CTX.WORKTREE}/.git`)), [true, false]);
  assert.deepEqual(qa.attribution, { commit: '', pr: '' });
  assert.deepEqual(qa.sandbox.network, { allowUnixSockets: [`${H}/tbd.sock`], allowLocalBinding: true });
  assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/docs/verification/screenshots/a.png` } }, qa.env), null);
  for (const f of ['src/a.ts', 'docs/verdicts/x.md', 'qa/x.md', '.env.test']) {
    assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/${f}` } }, qa.env)?.permissionDecision, 'deny', f);
  }
});

// M5 C11 (D-0089): the final review writes its verdict + verification doc only (real path-guard), never the tag repo's .git
// (no index flag can hide an edit from its tree pin, as QA), with code/working's node_modules + env-file denies and
// attribution off
test('phase-settings: code/final_gate M5 C11: Edit docs/verdicts/** + docs/verification/** only, .git write-denied, working\'s node_modules + env-file denies, D34 trailer off', () => {
  const ctx = { ...CTX, ENV_FILES: ['.env.test'] };
  const fin = render('code', 'final_gate', ctx);
  const working = render('code', 'working', ctx);
  const nm = (r) => r.includes('node_modules') || r.includes('.env.test');
  assert.deepEqual(fin.permissions.deny.filter(nm), working.permissions.deny.filter(nm));
  assert.deepEqual(fin.sandbox.filesystem.denyWrite.filter(nm), working.sandbox.filesystem.denyWrite.filter(nm));
  assert.ok(fin.sandbox.filesystem.denyWrite.includes(`${CTX.TAG_PATH}/.git`) && fin.sandbox.filesystem.denyWrite.includes(`${CTX.WORKTREE}/.git`), 'H2.7: tag + own clone .git');
  assert.deepEqual(fin.attribution, { commit: '', pr: '' });
  assert.deepEqual(tools(fin), ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']);
  for (const f of ['docs/verdicts/2026-10-14-t_abc123.md', 'docs/verification/2026-10-14-t_abc123-final.md']) {
    assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/${f}` } }, fin.env), null, f);
  }
  for (const f of ['src/a.ts', 'docs/notes.md', '.env.test', 'node_modules/x/index.js']) {
    assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/${f}` } }, fin.env)?.permissionDecision, 'deny', f);
  }
});

// H2.7 (D-0146) + SPIKE S2 FIX: every phase write-denies the tag repo's whole .git (TAG_GIT = the ticket's common dir, and
// <TAG_PATH>/.git) and reads only its objects (the clone's alternates); the clone's git files that steer tbd's git are
// denied one by one (an Edit deny of .git/** write-denies index.lock: no commit); the read-only phases deny the whole clone
// .git, working does not (its agent commits); pnpm / yarn node_modules state denied everywhere (D-0151)
test('phase-settings H2.7: tag .git denied, its objects the only tag read; clone git files denied one by one, whole clone .git only in read-only phases; working\'s commit paths free; TAG_GIT derived when absent', () => {
  const RO_PH = ['code/planning', 'code/review', 'code/context', 'code/qa', 'code/final_gate'];
  const files = ['config', 'config.worktree', 'commondir', 'shallow'].map((f) => `${CTX.WORKTREE}/.git/${f}`);
  const dirs = ['hooks', 'info', 'modules', 'objects/info', 'refs/replace'].map((f) => `${CTX.WORKTREE}/.git/${f}`);
  const nm = ['.pnpm', '.modules.yaml', '.yarn-state.yml'].map((f) => `${CTX.WORKTREE}/node_modules/${f}`);
  for (const [k, s] of all()) {
    const f = s.sandbox.filesystem;
    for (const p of [CTX.TAG_GIT, `${CTX.TAG_PATH}/.git`, ...files, ...dirs, ...nm]) assert.ok(f.denyWrite.includes(p), `${k}: denyWrite ${p}`);
    for (const p of [...files, ...dirs.map((d) => `${d}/**`), `${CTX.TAG_GIT}/**`]) assert.ok(s.permissions.deny.includes(`Edit(/${p})`), `${k}: Edit deny ${p}`);
    assert.deepEqual(f.allowRead.filter((p) => p.startsWith('/u/code/')), [`${CTX.TAG_GIT}/objects`], `${k}: the only tag read`);
    assert.equal(f.denyWrite.includes(`${CTX.WORKTREE}/.git`), RO_PH.includes(k), `${k}: whole clone .git write-denied`);
  }
  const w = render('code', 'working', CTX);
  const edits = w.permissions.deny.map((r) => /^Edit\(\/(\/.*?)(\/\*\*)?\)$/.exec(r)?.[1]).filter(Boolean);
  for (const p of ['index', 'index.lock', 'HEAD', 'refs/heads/tb/x', 'objects/ab/cdef', 'objects/pack/p.pack', 'logs/HEAD', 'packed-refs'].map((x) => `${CTX.WORKTREE}/.git/${x}`)) {
    const hit = (/** @type {string} */ r) => p === r || p.startsWith(`${r}/`);
    assert.ok(!w.sandbox.filesystem.denyWrite.some(hit) && !edits.some(hit), `working: ${p} must stay writable (the agent commits)`);
  }
  const old = render('code', 'working', { ...CTX, TAG_GIT: undefined }).sandbox.filesystem; // a caller without TAG_GIT
  assert.deepEqual([old.denyWrite.filter((p) => p === `${CTX.TAG_PATH}/.git`).length, old.allowRead.includes(`${CTX.TAG_PATH}/.git/objects`)], [1, true]);
});

// C-H1 (no breaking change): a ticket from before H2 (spawn's CLONE false: a linked worktree) commits in working through
// the tag repo's shared .git: there the pre-H2 per-file denies (both names of the tag .git) + the worktree's .git file,
// never the whole tag .git; its read-only phases, and every clone (CLONE absent or true), keep the whole deny
test('phase-settings C-H1: legacy working (CLONE false) → <common>/worktrees/<id>, index, objects, refs writable, the pre-H2 git files denied; clone working (CLONE absent / true) and legacy qa → the whole tag .git denied', () => {
  // a sandbox glob (`*` one part, `**` any depth) covers p: p itself or below it
  const covers = (r, p) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}(/.*)?$`).test(p);
  const denied = (s, p) => s.sandbox.filesystem.denyWrite.some((r) => covers(r, p))
    || s.permissions.deny.some((r) => { const m = /^Edit\(\/(\/.*)\)$/.exec(r); return !!m && covers(m[1], p); });
  const gits = [CTX.TAG_GIT, `${CTX.TAG_PATH}/.git`];
  const commit = gits.flatMap((g) => ['worktrees/t_abc123/index', 'worktrees/t_abc123/index.lock', 'worktrees/t_abc123/HEAD', 'objects/ab/cdef', 'objects/pack/p.pack',
    'refs/heads/tb/t_abc123-x', 'logs/HEAD', 'packed-refs'].map((x) => `${g}/${x}`));
  const steer = [...gits.flatMap((g) => ['config', 'hooks/pre-commit', 'info/exclude', 'modules/m/config', 'worktrees/t_abc123/config.worktree', 'worktrees/t_abc123/commondir',
    'worktrees/t_abc123/gitdir', 'refs/replace/ab'].map((x) => `${g}/${x}`)), `${CTX.WORKTREE}/.git`];
  const legacy = render('code', 'working', { ...CTX, CLONE: false });
  for (const p of commit) assert.equal(denied(legacy, p), false, `legacy working: ${p} must stay writable (its agent commits)`);
  for (const p of steer) assert.equal(denied(legacy, p), true, `legacy working: ${p} denied`);
  assert.deepEqual([legacy.permissions.deny.includes(`Edit(/${CTX.WORKTREE}/.git)`), legacy.permissions.deny.includes(W(CTX.TAG_GIT))], [true, false]);
  for (const [k, s] of [['clone working (no CLONE)', render('code', 'working', CTX)], ['clone working', render('code', 'working', { ...CTX, CLONE: true })], ['legacy qa', render('code', 'qa', { ...CTX, CLONE: false })]]) {
    for (const g of gits) assert.ok(s.sandbox.filesystem.denyWrite.includes(g), `${k}: ${g} whole`);
    for (const p of commit) assert.equal(denied(s, p), true, `${k}: ${p} denied`);
  }
});

test('phase-settings: --tools from allow (Edit brings Write); read-only phases get no write tool', () => {
  assert.deepEqual(tools(render('code', 'working', CTX)), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']); // P5 K15 (contract change): no Agent
  assert.deepEqual(tools(render('code', 'planning', CTX)), ['Read', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(tools(render('research', 'review', CTX)), ['Read', 'Glob', 'Grep']);
});

test('phase-settings: rendered env drives the real guards (worktree write ok, config/token/tbd port denied)', () => {
  const s = render('code', 'working', CTX);
  assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/src/a.ts` } }, s.env), null);
  assert.equal(check({ tool_input: { file_path: `${H}/config.json` } }, s.env)?.permissionDecision, 'deny');
  assert.equal(check({ tool_input: { file_path: `${H}/tickets/other/x.md` } }, s.env)?.permissionDecision, 'deny');
  assert.match(check({ tool_input: { file_path: `${CTX.WORKTREE}/pkg/.claude/skills/x/SKILL.md` } }, s.env)?.permissionDecisionReason ?? '', /Claude config/); // S1
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
    { TAG_GIT: 'repo/.git' }, { TAG_GIT: '/u/code/main/.git/' }, // H2.7
  ];
  for (const b of bad) assert.throws(() => render('code', 'working', { ...CTX, ...b }), /phase-settings:/, JSON.stringify(b));
  for (const [kind, phase] of [['..', 'working'], ['code', '../planning'], ['code', 'nope'], ['Code', 'working']]) {
    assert.throws(() => render(kind, phase, CTX), /phase-settings:/, `${kind}/${phase}`);
  }
  // M5 C10: a phase dir name may hold `_` after its first letter (final_gate); the name check refuses anything else
  const why = (kind, phase) => { try { render(kind, phase, CTX); return ''; } catch (e) { return e.message; } };
  assert.doesNotMatch(why('code', 'final_gate'), /bad phase/); // renders once phases/code/final_gate/settings.json is there
  for (const [kind, phase] of [['code', '_x'], ['code', 'Final'], ['code', 'final-gate'], ['code', 'final_gate/..'], ['_code', 'qa']]) {
    assert.match(why(kind, phase), /bad phase/, `${kind}/${phase}`);
  }
});

// D-0059: TB_EVAL_DENY_READ (golden harness) denies the real repo to Bash (sandbox) and the file tools (Read), dev TB_HOME only
test('phase-settings: TB_EVAL_DENY_READ denies a path in sandbox + Read for a dev TB_HOME, is ignored for the live one, rejects a bad path', () => {
  const was = process.env.TB_EVAL_DENY_READ;
  const withKnob = (v, ctx) => { process.env.TB_EVAL_DENY_READ = v; try { return render('code', 'working', ctx); } finally { if (was === undefined) delete process.env.TB_EVAL_DENY_READ; else process.env.TB_EVAL_DENY_READ = was; } };
  const s = withKnob('/r/one:/r/two', CTX);
  assert.deepEqual(s.sandbox.filesystem.denyRead.slice(-2), ['/r/one', '/r/two']);
  for (const p of ['/r/one', '/r/two']) assert.ok(s.permissions.deny.includes(`Read(/${p}/**)`), p);
  const live = path.join(os.homedir(), '.taskboard');
  const l = withKnob('/r/one', { ...CTX, TB_HOME: live });
  assert.deepEqual(l.sandbox.filesystem.denyRead, [live]);
  assert.ok(!l.permissions.deny.includes('Read(//r/one/**)'));
  for (const bad of ['rel/x', '/r/../x', '/r/*', '/r/x/']) assert.throws(() => withKnob(bad, CTX), /TB_EVAL_DENY_READ/, bad);
});

// full-access-runs, Chrome in runs: tb-chrome runs outside claude's seatbelt under a profile built from the run's own
// wall (security review 2026-10-19: as tight as the wall). Real sandbox-exec, fake HOME, probes in node (the only program
// the profile lets run besides Chrome and the shell): worktree + copied env file read, worktree + temp write, the
// listed loopback port; refused: ssh keys, another .env, TB_HOME, Claude config, HOME writes, a node_modules package
// (char-class glob), other programs, other loopback ports, unix sockets, code mapped from a writable dir.
test('chromeProfile: the run wall as a seatbelt profile (real sandbox-exec): allowed files, port and node only; secrets, config, programs, other ports, sockets refused', async () => {
  const net = require('node:net');
  const { execFile } = require('node:child_process');
  const { fullAccess, chromeProfile } = require('../lib/phase-settings');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chromesb-')));
  const home = path.join(root, 'home');
  const tbh = path.join(home, '.taskboard');
  const wt = path.join(tbh, 'worktrees', 't_c1');
  for (const d of [path.join(home, '.ssh'), path.join(wt, 'node_modules', 'react'), path.join(tbh, 'tickets', 't_c1')]) fs.mkdirSync(d, { recursive: true });
  for (const [f, c] of [[path.join(home, '.ssh', 'id_ed25519'), 'KEY'], [path.join(tbh, 'token'), 'TOK'], [path.join(wt, 'index.html'), 'page'],
    [path.join(wt, '.env'), 'S=1'], [path.join(wt, '.env.test'), 'T=1']]) fs.writeFileSync(f, c);
  const ctx = { ...CTX, WORKTREE: wt, TICKET_DIR: path.join(tbh, 'tickets', 't_c1'), OUT_DIR: path.join(tbh, 'tickets', 't_c1', 'out'), TB_HOME: tbh,
    SKILLS_DIR: path.join(tbh, 'tickets', 't_c1', 'skills'), TAG_GIT: undefined, ENV_FILES: ['.env.test'] };
  const s = fullAccess(render('code', 'working', ctx), { phase: 'working', learning: null, wall: true, worktree: wt, envFiles: ['.env.test'] });
  const servers = await Promise.all([0, 0].map(() => new Promise((r) => { const v = net.createServer((c) => c.end()).listen(0, '127.0.0.1', () => r(v)); })));
  const sock = path.join(root, 'u.sock'); // a unix socket the profile does not name (as Docker's, an editor's IPC)
  servers.push(await new Promise((r) => { const v = net.createServer((c) => c.end()).listen(sock, () => r(v)); }));
  const [open, shut] = servers.map((v) => v.address().port);
  const sb = path.join(root, 'run.sb');
  fs.writeFileSync(sb, chromeProfile(s.sandbox, { home, cwd: wt, node: process.execPath, ports: [open] }));
  const probe = (js) => new Promise((resolve) => execFile('/usr/bin/sandbox-exec', ['-f', sb, process.execPath, '-e', js], (e, out) => resolve(e ? 'fail' : out.trim())));
  const rd = (p) => probe(`require('fs').readFileSync(${JSON.stringify(p)}); console.log('ok')`);
  const wr = (p) => probe(`require('fs').writeFileSync(${JSON.stringify(p)}, 'x'); console.log('ok')`);
  const tcp = (port) => probe(`require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('ok'); process.exit(0); }).on('error', () => process.exit(1))`);
  try {
    assert.deepEqual(await Promise.all([rd(`${wt}/index.html`), rd(`${wt}/.env.test`), wr(`${wt}/shot.png`), wr(`${os.tmpdir()}/chromesb-${process.pid}`), tcp(open)]),
      ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(await Promise.all([rd(`${home}/.ssh/id_ed25519`), rd(`${wt}/.env`), rd(`${tbh}/token`), wr(`${wt}/CLAUDE.md`), wr(`${home}/.zshrc`),
      wr(`${wt}/node_modules/react/index.js`), tcp(shut), probe(`require('net').connect(${JSON.stringify(sock)}).on('connect', () => { console.log('ok'); process.exit(0); }).on('error', () => process.exit(1))`),
      probe("require('child_process').execFileSync('/bin/ls', ['/']); console.log('ok')")]),
      ['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
  } finally {
    servers.forEach((v) => v.close());
    fs.rmSync(`${os.tmpdir()}/chromesb-${process.pid}`, { force: true });
  }
});

// board-terminal-parity Phase 2 (run secrets rule): TB_HOME/run-secrets/<run>/ (the folder MCP file and its env) lies
// under BASE's TB_HOME read deny; tb-chrome's profile, built from the wall, re-opens only the run's own dirs
test('chromeProfile text: the run-secrets dir stays read-denied (TB_HOME denied, no allow rule re-opens it)', () => {
  const { fullAccess, chromeProfile } = require('../lib/phase-settings');
  const s = fullAccess(render('code', 'working', CTX), { phase: 'working', learning: null, wall: true, worktree: CTX.WORKTREE });
  const sb = chromeProfile(s.sandbox, { home: '/u', cwd: CTX.WORKTREE, node: CTX.TB_NODE, ports: [] }).split('\n');
  const secret = `${H}/run-secrets/t_abc123-2/mcp.json`;
  const covers = (l) => [...l.matchAll(/\((subpath|literal|regex) ("(?:[^"\\]|\\.)*")\)/g)].some(([, k, v]) => {
    const p = JSON.parse(v);
    return k === 'regex' ? new RegExp(p).test(secret) : k === 'subpath' ? secret.startsWith(`${p}/`) : secret === p;
  });
  assert.ok(sb.some((l) => l.startsWith('(deny file-read* ') && l.includes(`(subpath ${JSON.stringify(H)})`)));
  assert.deepEqual(sb.filter((l) => l.startsWith('(allow file-read') && covers(l)), []);
});

// board-terminal-parity Phase 2 task 5: bin/tb-git's git under a profile built from the run's own wall (spike h's git.sb
// the baseline). Real sandbox-exec + the real git binary (xcrun -f git), fake HOME: Irfan's ssh key and the worktree
// readable, the repo writable; refused: another .env, TB_HOME (its run secrets too), the clone's .git/config, a planted
// CLAUDE.md, a HOME write, any program but git (a shell).
test('gitProfile: the run wall for tb-git (real sandbox-exec + real git): ssh key + worktree read, repo write; .env, TB_HOME + run secrets, .git/config, CLAUDE.md, HOME writes, a shell refused', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const { fullAccess, gitProfile } = require('../lib/phase-settings');
  const realGit = fs.realpathSync(execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).trim());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitsb-')));
  const home = path.join(root, 'home');
  const tbh = path.join(home, '.taskboard');
  const wt = path.join(tbh, 'worktrees', 't_g1');
  for (const d of [path.join(home, '.ssh'), path.join(wt, '.git'), path.join(tbh, 'run-secrets', 't_g1-2'), path.join(tbh, 'tickets', 't_g1')]) fs.mkdirSync(d, { recursive: true });
  for (const [f, c] of [[path.join(home, '.ssh', 'id_ed25519'), 'KEY'], [path.join(tbh, 'token'), 'TOK'], [path.join(tbh, 'run-secrets', 't_g1-2', 'git.json'), '{}'],
    [path.join(wt, 'a.txt'), 'a'], [path.join(wt, '.env'), 'S=1'], [path.join(wt, '.git', 'config'), '']]) fs.writeFileSync(f, c);
  const ctx = { ...CTX, WORKTREE: wt, TICKET_DIR: path.join(tbh, 'tickets', 't_g1'), OUT_DIR: path.join(tbh, 'tickets', 't_g1', 'out'), TB_HOME: tbh, SKILLS_DIR: path.join(tbh, 'tickets', 't_g1', 'skills'), TAG_GIT: undefined };
  const s = fullAccess(render('code', 'working', ctx), { phase: 'working', learning: null, wall: true, worktree: wt });
  const sb = path.join(root, 'git.sb');
  fs.writeFileSync(sb, gitProfile(s.sandbox, { home, cwd: wt, git: realGit }));
  const run = (file, ...a) => (spawnSync('/usr/bin/sandbox-exec', ['-f', sb, file, ...a], { cwd: wt, env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' } }).status === 0 ? 'ok' : 'fail');
  const rd = (p) => run(realGit, 'hash-object', p);
  const wr = (p) => run(realGit, 'config', '--file', p, 'x.y', 'z');
  try {
    assert.deepEqual([rd(`${home}/.ssh/id_ed25519`), rd(`${wt}/a.txt`), wr(`${wt}/b.cfg`)], ['ok', 'ok', 'ok']);
    assert.deepEqual([rd(`${wt}/.env`), rd(`${tbh}/token`), rd(`${tbh}/run-secrets/t_g1-2/git.json`), wr(`${wt}/.git/config`), wr(`${wt}/CLAUDE.md`), wr(`${home}/x.cfg`), run('/bin/sh', '-c', 'true')],
      ['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Phase 4 Own Worktree, design test 8 (wall contract, pure; the lists = design 3c, measured under real claude in step 0b):
// a worktree Task's working run writes <common> minus the 3c rows (both layers) and each sibling's git folder; planning
// keeps the whole <common> deny; the tag's .learning gets the planted-name and .git denies in any kind's working run
test('phase-settings Phase 4 tree walls: working → allowWrite <common>, exactly the 3c rows in both layers, its commit paths writable; planning → <common> denied whole; a sibling name with a " stops the run; .learning planted + .git denies in working (any kind); My Folder gets none of it', () => {
  const { fullAccess } = require('../lib/phase-settings');
  const wt = `${H}/worktrees/t_tree08`, repo = '/u/code/repo', C = `${repo}/.git`, L = `${repo}/.learning`;
  const ctx = { ...CTX, WORKTREE: wt, TAG_PATH: wt, TAG_GIT: C, CLONE: false, TREE: true, TREE_OTHERS: ['sib1'], NODE_MODULES: false, ENV_FILES: [] };
  const fa = (phase) => ({ phase, learning: L, wall: true, worktree: wt });
  const w = fullAccess(render('task', 'working', ctx), fa('working'));
  const rows = ['config', 'hooks', 'info', 'modules', 'worktrees/*/config.worktree', 'worktrees/*/commondir', 'worktrees/*/gitdir', 'refs/replace',
    'HEAD', 'index', 'ORIG_HEAD', 'logs/HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'objects/info', 'shallow', 'worktrees/*/modules', 'worktrees/sib1'].map((x) => `${C}/${x}`);
  const f = w.sandbox.filesystem, sorted = (a) => [...new Set(a)].sort();
  assert.ok(f.allowWrite.includes(C), 'allowWrite <common>');
  assert.deepEqual(sorted(w.permissions.deny.filter((r) => r.startsWith(`Edit(/${C}`))), sorted(rows.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])), 'Edit rows on <common>: exactly 3c');
  assert.deepEqual(sorted(f.denyWrite.filter((p) => p.startsWith(`${C}`))), sorted(rows), 'denyWrite rows on <common>: exactly 3c');
  assert.deepEqual([w.permissions.deny.includes(`Edit(/${wt}/.git)`), f.denyWrite.includes(`${wt}/.git`)], [true, true], 'the gitfile');
  const covers = (r, p) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}(/.*)?$`).test(p);
  const denied = (s, p) => s.sandbox.filesystem.denyWrite.some((r) => covers(r, p)) || s.permissions.deny.some((r) => { const m = /^Edit\(\/(\/.*)\)$/.exec(r); return !!m && covers(m[1], p); });
  for (const p of ['worktrees/t_tree08/index', 'worktrees/t_tree08/HEAD', 'worktrees/t_tree08/ORIG_HEAD', 'worktrees/t_tree08/logs/HEAD', 'objects/ab/cdef', 'objects/pack/p.pack',
    'refs/heads/tb/t_tree08', 'refs/remotes/origin/tb/t_tree08', 'logs/refs/heads/tb/t_tree08', 'packed-refs'].map((x) => `${C}/${x}`)) assert.equal(denied(w, p), false, `working: ${p} writable (the agent commits)`);
  for (const p of [...rows.map((r) => r.replace('*', 't_tree08')), `${C}/worktrees/sib1/HEAD`, `${wt}/.git`]) assert.equal(denied(w, p), true, `working: ${p} denied`);
  const p = fullAccess(render('task', 'planning', ctx), fa('planning'));
  assert.deepEqual([p.sandbox.filesystem.denyWrite.includes(C), p.permissions.deny.includes(`Edit(/${C}/**)`), (p.sandbox.filesystem.allowWrite ?? []).includes(C)], [true, true, false], 'planning: <common> whole');
  assert.throws(() => render('task', 'working', { ...ctx, TREE_OTHERS: ['sib1', 'a"b'] }), (/** @type {any} */ e) => e.code === 'PLANTED' && /^a worktree of this repo has a name tbd cannot wall \("a\\"b"\): rename it with git worktree move$/.test(e.message));
  // .learning (design 3c/3e), any kind's working run; planning denies it whole
  const lrows = [...['.claude/**', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', 'AGENTS.md'].flatMap((x) => [`${L}/${x}`, `${L}/**/${x}`]), `${L}/.git`, `${L}/.git/**`, `${L}/**/.git`, `${L}/**/.git/**`];
  const lwrite = [...['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', 'AGENTS.md'].flatMap((x) => [`${L}/${x}`, `${L}/**/${x}`]), `${L}/.git`, `${L}/**/.git`];
  for (const [k, s] of [['task tree', w], ['code', fullAccess(render('code', 'working', CTX), fa('working'))]]) {
    assert.deepEqual(sorted(s.permissions.deny.filter((r) => r.startsWith(`Edit(/${L}/`))), sorted(lrows.map((x) => `Edit(/${x})`)), `${k}: .learning Edit denies`);
    assert.deepEqual(sorted(s.sandbox.filesystem.denyWrite.filter((x) => x.startsWith(`${L}/`))), sorted(lwrite), `${k}: .learning write denies`);
  }
  assert.deepEqual(p.permissions.deny.filter((r) => r.startsWith(`Edit(/${L}`)), [`Edit(/${L}/**)`], 'planning: .learning denied whole');
  // My Folder (TAG_GIT = <cwd>/.git, CLONE true): no tree rows, its .git stays writable for its commits; TREE there is refused
  const F = '/u/code/folder', mine = { ...CTX, WORKTREE: F, TAG_PATH: F, TAG_GIT: `${F}/.git`, CLONE: true };
  const m = render('task', 'working', mine);
  assert.deepEqual([(m.sandbox.filesystem.allowWrite ?? []).includes(`${F}/.git`), denied(m, `${F}/.git/HEAD`), denied(m, `${F}/.git/index`), denied(m, `${F}/.git/ORIG_HEAD`)], [false, false, false, false]);
  assert.throws(() => render('task', 'working', { ...mine, CLONE: false, TREE: true, TREE_OTHERS: [] }), /TREE needs TAG_GIT = the repo's git dir/);
});

// design test 8, sibling listing (spawn.treeOthers on a temp <common>/worktrees): a real folder with a gitdir file is
// listed; the Task's own, a folder without gitdir and a link are not; no worktrees folder → none
test('spawn treeOthers: real worktree git folders only, minus the Task\'s own', async () => {
  const { treeOthers } = require('../lib/spawn');
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'others-'));
  try {
    assert.deepEqual(await treeOthers({ id: 't_self01', common_dir: common }), []);
    const wts = path.join(common, 'worktrees');
    for (const n of ['t_self01', 'sib', 'nogit']) fs.mkdirSync(path.join(wts, n), { recursive: true });
    for (const n of ['t_self01', 'sib']) fs.writeFileSync(path.join(wts, n, 'gitdir'), '/x/.git\n');
    fs.symlinkSync(path.join(wts, 'sib'), path.join(wts, 'lnk'));
    assert.deepEqual(await treeOthers({ id: 't_self01', common_dir: common }), ['sib']);
  } finally {
    fs.rmSync(common, { recursive: true, force: true });
  }
});
