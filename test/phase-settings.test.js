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
        'code/final_gate': ['prompt.md', 'result.schema.json', 'settings.json'] };
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
    `Edit(/${H}/tbd.sock)`, `Edit(/${H}/bin/**)`, W(CTX.SKILLS_DIR), 'Edit(~/taskboard-live/**)', `Edit(/${CTX.WORKTREE}/.git)`,
    `Edit(/${CTX.TICKET_DIR}/*.json)`, `Edit(/${CTX.TICKET_DIR}/rounds/**)`, 'Bash(git push *)',
    ...PLANTED.map((p) => `Edit(/${p}${p.endsWith('.claude') ? '/**' : ''})`),
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
    const bashPhase = k === 'code/working' || k === 'code/qa';
    // tbx, node, npm; M5 S4 (contract change; was none): code/qa reads the one DB CLI file, not ~/bin
    const reopen = bashPhase ? [REPO, '/u/.nvm/v24', '~/.npm', '~/Library/Caches/ms-playwright', ...(k === 'code/qa' ? ['~/bin/postgres-irfan-axi'] : [])] : [];
    assert.deepEqual(sb.filesystem.allowRead, [CTX.WORKTREE, CTX.TICKET_DIR, `${H}/tbd.sock`, ...reopen], k);
    for (const p of [REPO, '/u/.nvm/v24/bin', '~/.claude*', '~/.zshrc', `${CTX.TAG_PATH}/.git/config`, `${CTX.TAG_PATH}/.git/hooks`,
      `${CTX.TAG_PATH}/.git/info`, `${CTX.TAG_PATH}/.git/modules`, `${CTX.TAG_PATH}/.git/worktrees/*/config.worktree`, `${CTX.WORKTREE}/.git`, `${CTX.TICKET_DIR}/runs`, ...PLANTED,
      `${CTX.TAG_PATH}/.git/worktrees/*/commondir`, `${CTX.TAG_PATH}/.git/worktrees/*/gitdir`, `${CTX.TAG_PATH}/.git/refs/replace`, `${CTX.TICKET_DIR}/rounds`, `${CTX.TICKET_DIR}/*.json`]) { // P4 S1, L7, replace refs
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
test('phase-settings: code/working M1 node_modules + env-file denies, .cache / .prisma left writable; D34 trailer off', () => {
  const s = render('code', 'working', { ...CTX, ENV_FILES: ['.env.test'] });
  const nm = `${CTX.WORKTREE}/node_modules`;
  const edit = [`${nm}/[a-zA-Z0-9@_-]*`, `${nm}/[a-zA-Z0-9@_-]*/**`, `${nm}/.bin`, `${nm}/.bin/**`, `${nm}/.package-lock.json`, `${CTX.WORKTREE}/.env.test`].map((p) => `Edit(/${p})`);
  assert.deepEqual(s.permissions.deny.filter((r) => r.includes('node_modules') || r.includes('.env.test')), edit);
  assert.deepEqual(s.sandbox.filesystem.denyWrite.filter((p) => p.includes('node_modules') || p.includes('.env.test')), [`${nm}/[a-zA-Z0-9@_-]*`, `${nm}/.bin`, `${nm}/.package-lock.json`, `${CTX.WORKTREE}/.env.test`]);
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
  assert.equal(qa.permissions.deny.filter(nm).length, 6, '5 node_modules rules + the env file (the list: the M1 test above)');
  assert.deepEqual(qa.sandbox.filesystem.denyWrite.filter(nm), working.sandbox.filesystem.denyWrite.filter(nm));
  // M5.2 sec F2: QA never commits, so no index write either (update-index --skip-worktree would blind the tree pin)
  assert.deepEqual([qa, working].map((s) => s.sandbox.filesystem.denyWrite.includes(`${CTX.TAG_PATH}/.git`)), [true, false]);
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
  assert.ok(fin.sandbox.filesystem.denyWrite.includes(`${CTX.TAG_PATH}/.git`));
  assert.deepEqual(fin.attribution, { commit: '', pr: '' });
  assert.deepEqual(tools(fin), ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']);
  for (const f of ['docs/verdicts/2026-10-14-t_abc123.md', 'docs/verification/2026-10-14-t_abc123-final.md']) {
    assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/${f}` } }, fin.env), null, f);
  }
  for (const f of ['src/a.ts', 'docs/notes.md', '.env.test', 'node_modules/x/index.js']) {
    assert.equal(check({ tool_input: { file_path: `${CTX.WORKTREE}/${f}` } }, fin.env)?.permissionDecision, 'deny', f);
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
