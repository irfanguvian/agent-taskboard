'use strict';
// P5c (contract "UI parity in P5": agent strings via el() / textContent only): ui/app.js runs in a vm with a stub DOM
// (no browser, no network); the P5 drawer parts render a gate, an ask, a pass check and a feedback whose agent-written
// strings (notes, question, file names, gate tails, why, change names, subject) carry HTML payloads. Each payload must
// land in the tree as a plain text child only: never as markup (no innerHTML / outerHTML / insertAdjacentHTML / write
// anywhere in app.js; the stub throws on them), never as an element, never inside an attribute.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
const P = '<img src=x onerror=alert(1)>';
const S = '<script>alert(2)</script>';

class Node {
  constructor(tag) {
    this.tag = tag;
    /** @type {any[]} */ this.kids = [];
    /** @type {Record<string, string>} */ this.attrs = {};
    this.dataset = {};
    /** @type {Record<string, Function[]>} */ this.handlers = {};
    /** @type {any} */ this.open = false; // dialog
    /** @type {any} */ this.onsubmit = null; // set by app.js on the sheet form
    this.style = {};
    this.classList = { add() {}, remove() {}, contains: () => false };
  }
  append(...k) { this.kids.push(...k); }
  get children() { return this.kids; }
  select() {}
  // a <select> answers with its selected option (or the first), the rest keep what was assigned
  get value() { return this.tag === 'select' && this._v === undefined ? (this.kids.find((o) => o.attrs?.selected !== undefined) ?? this.kids[0])?.attrs.value : this._v; }
  set value(v) { this._v = v; }
  replaceChildren(...k) { this.kids = k; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  removeEventListener() {}
  setCustomValidity() {}
  reportValidity() { this.reported = true; }
  focus() {}
  close() {}
  showModal() {}
  remove() {}
  querySelector() { return new Node('stub'); }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  set innerHTML(_v) { throw new Error('innerHTML used'); }
  set outerHTML(_v) { throw new Error('outerHTML used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }
}
function sandbox(qs = {}) { // qs: selector → the node $() answers with (the rest get a fresh stub)
  const document = {
    createElement: (t) => new Node(t), createElementNS: (_ns, t) => Object.assign(new Node(t), { ns: true }), querySelector: (s) => qs[s] ?? new Node('stub'), querySelectorAll: () => [], body: new Node('body'),
    documentElement: new Node('html'), addEventListener() {}, write() { throw new Error('document.write used'); }, activeElement: null, visibilityState: 'hidden',
  };
  const ctx = {
    document, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, CSS: { escape: (s) => s },
    crypto: { getRandomValues: (a) => a }, fetch: async () => { throw new Error('no network in this test'); }, console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'app.js' });
  return ctx;
}
// every string in the tree, and where it sits: text (a child) or attr. Tags leave out icon() SVG (createElementNS, fixed
// path data from app.js's ICONS), which may only ever make svg and path: an 'svg' tag in the list still means one made
// from markup.
function walk(n, out = { text: [], attrs: [], tags: [] }) {
  if (typeof n === 'string' || typeof n === 'number') { out.text.push(String(n)); return out; }
  if (!(n instanceof Object) || !Array.isArray(n.kids)) return out;
  if (n.ns) assert.ok(n.tag === 'svg' || n.tag === 'path', `createElementNS made only svg / path, not ${n.tag}`);
  else out.tags.push(n.tag);
  for (const [k, v] of Object.entries(n.attrs)) out.attrs.push(`${k}=${v}`);
  for (const k of n.kids) walk(k, out);
  return out;
}

// every node under n (preorder), and the ones whose data-role is r
const flat = (n) => (n instanceof Object && Array.isArray(n.kids) ? [n, ...n.kids.flatMap(flat)] : []);
const roles = (n, r) => flat(n).filter((x) => x.attrs?.['data-role'] === r);
const textOf = (n) => walk(n).text.join(' ');

test('XSS: agent strings in the P5 drawer (gate tail, why, file names, changes, question, notes, feedback, sha subject) render as text only', () => {
  assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|\beval\(/, 'no HTML sink in app.js');
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_xss001";');
  ctx.gate = {
    n: 3, gate: 'working', task: `T1${P}`, attempt: 1, ok: false, class: 'policy', ms: 1200,
    checks: [{ check: `unit${S}`, ok: false, exit: 1, ms: 9, flaky: true, log: `gates/03-T1-unit.log.gz`, tail: `FAIL ${P}` }],
    scope: { outside: [`src/${P}.js`], protected: [{ path: `package.json${S}`, blob: 'b' }], deps: true, bad: [] },
    tests: { failfirst: `unproven_compile${S}`, files: [`test/${P}.test.js`], skips_added: [S], deleted: [], expects_removed: [], count_drops: [], count: { pre: 1, head: 2 } },
    schema: [{ op: 'drop', ref: `User.${P}`, allowed: false }], api: [{ op: 'remove', ref: `Dto.${S}`, dir: `response${P}`, allowed: true }],
    unused_allowed: [`drop M.${P}`], migration: [`prisma/migrations/${S}`], ask: { kind: `policy${P}`, changes: [P] }, why: `policy: ${P}`,
  };
  run('ui.plan = { allowed_schema_changes: ["drop M.' + P.replaceAll('"', '\\"') + '"], allowed_api_changes: [] };');
  const trees = [
    run('gateItem("t_xss001", gate, true)'),
    run(`askPanel("t_xss001", { round: 3, clarify_origin: { phase: "working", task: ${JSON.stringify(`T2${S}`)}, class: "policy", why: "w" } },
      { kind: "policy", changes: [${JSON.stringify(`drop User.${P}`)}], reason: ${JSON.stringify(`because ${S}`)}, files: [] })`),
    run(`askPanel("t_xss001", { round: 3, clarify_origin: { phase: "working", task: "T1", class: "scope" } },
      { kind: "scope", files: [${JSON.stringify(`lib/${P}.js`)}], reason: ${JSON.stringify(`outside ${P}`)} })`),
    run(`askPanel("t_xss001", { round: 3, clarify_origin: { phase: "working", task: "T1", class: "NEEDS_CONTEXT" } },
      { kind: "NEEDS_CONTEXT", question: ${JSON.stringify(`which table? ${P}`)}, notes: ${JSON.stringify(`notes ${S}`)} })`),
    run(`ui.pass = { id: "t_xss001", input: "abcdef1", typed: "", got: { sha: "${'a'.repeat(40)}", subject: ${JSON.stringify(`feat: ${P}`)} } }; passForm("t_xss001")`),
    run(`ui.fb = { id: "t_xss001", n: 1, text: ${JSON.stringify(`feedback ${S}`)} };
      workView("t_xss001", { rework: 1, plan_hash: "h", plan_hashes: ["h"], base_checks: { [${JSON.stringify(`unit${P}`)}]: { ok: false, ms: 3 } },
        work: { task: "T1", tries: 1, unit_ms: 5, gate: { kind: "task", ok: false, class: ${JSON.stringify(`work${S}`)}, n: 2 }, tasks: [{ id: ${JSON.stringify(`T1${P}`)}, status: "red", attempt: 2, head: null }] } })`),
    run(`notice("t_xss001", { reason: "infra", why: ${JSON.stringify(`npm ${S}`)} })`),
  ];
  for (const tree of trees) {
    const w = walk(tree);
    assert.ok(w.tags.length >= 2, 'rendered something');
    assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
    // setAttribute never parses markup: only handler / src attributes and links could run a payload
    const sinks = w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction)=/i.test(a) || (/^href=/i.test(a) && (a.includes('<') || /javascript:/i.test(a))));
    assert.deepEqual(sinks, [], 'no payload in a handler, src or link attribute');
    assert.ok(w.text.some((s) => s.includes(P) || s.includes(S)), 'the payload is there, as text');
  }
  // the log link is built from tbd's numbers and an encoded check name, never raw agent text
  const link = walk(trees[0]).attrs.find((a) => a.startsWith('href='));
  assert.equal(link, `href=/api/tickets/t_xss001/gates/3/log?check=${encodeURIComponent(`unit${S}`)}`);
});

test('XSS: review findings (M5.1 Review view) render as text only', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_xss001"; ui.fixMax = 3;');
  const f = (over) => ({ id: 'F1', severity: 'HIGH', confidence: 'high', where: `src/${P}.js:1`, problem: `p ${P}`, failure_scenario: `s ${S}`, fix: `f ${P}`, blocking: true, ...over });
  const tree = run(`ui.review = { id: "t_xss001", data: { n: 1, verdict: ${JSON.stringify(`block${S}`)}, at: "2026-10-12T01:02:03.000Z",
    findings: [${JSON.stringify(f())}, ${JSON.stringify(f({ id: `F2${P}`, blocking: false }))}], closed: [{ id: "F3", how: ${JSON.stringify(`how ${P}`)} }] } };
    reviewView("t_xss001", { fixes: 1, review: { n: 1 } })`);
  const w = walk(tree);
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), [], 'no payload in a handler, src or link attribute');
  assert.ok(w.text.some((s) => s.includes(`p ${P}`)) && w.text.some((s) => s.includes(`s ${S}`)) && w.text.includes('fix 1/3'), 'the payload and fix n/3 are there, as text');
});

test('XSS: the QA view (M5.2: cases, need review, findings, report text, screenshots, recs) renders agent text as text only', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_xss001";');
  const c = (over) => ({ id: 'TC-1', type: 'backend', kind: 'positive', source: `src/${P}.js:1`, acceptance: ['A1'], pre: `pre ${S}`, steps: [`step ${P}`], expect: `expect ${S}`,
    result: 'PASS', recs: ['7.1'], screenshots: [], observed: { status: 200, note: `note ${P}` }, evidence: 'captured by tbd', ...over });
  const data = { n: 1, verdict: 'fail', at: '2026-10-13T01:02:03.000Z', report: 'docs/verification/r.md', need_review: [`QA 1: ${S}`], findings: [`finding ${P}`],
    cases: [c(), c({ id: 'TC-2', type: 'frontend', result: 'FAIL', cause: 'code', recs: [], evidence: 'agent-made',
      screenshots: ['docs/verification/screenshots/a.png', `docs/verification/screenshots/${P}.png`] })] };
  const recs = { id: 't_xss001', run: 7, runs: [7, 5], next: 1, items: [{ n: '7.1', at: data.at, ms: 3, curl: `curl '${P}'`, status: 200, headers: [['x-h', S]], body: `body ${P}`, truncated: false }] };
  const tree = run(`ui.qa = { id: "t_xss001", data: ${JSON.stringify(data)}, doc: { text: ${JSON.stringify(`# report\n${S}`)} } }; ui.rec = ${JSON.stringify(recs)};
    qaView("t_xss001", { qa: { n: 1, verdict: "fail" } })`);
  const w = walk(tree);
  assert.ok(w.tags.every((t) => !['script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.equal(w.tags.filter((t) => t === 'img').length, 1, 'one screenshot as <img>: the payload path stays text');
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), ['src=/api/tickets/t_xss001/docs?path=verification%2Fscreenshots%2Fa.png'], 'the one src is tbd\'s docs route');
  for (const s of [`step ${P}`, `expect ${S}`, `note ${P}`, `src/${P}.js:1`, `QA 1: ${S}`, `finding ${P}`, `# report\n${S}`, `curl '${P}'`, `docs/verification/screenshots/${P}.png`]) {
    assert.ok(w.text.some((x) => x.includes(s)), `as text: ${s}`);
  }
  assert.ok(w.text.some((x) => x.includes(`x-h: ${S}`) && x.includes(`body ${P}`)), 'rec answer as text');
  assert.ok(w.text.includes('captured by tbd') && w.text.includes('agent-made'), 'evidence labels');
});

test('M5.2 C9: waiting qa_lock reads qa:<tag> on the card and in the drawer facts', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const f = { id: 't_xss001', title: 't', kind: 'code', tag: 'self/tb', state: 'qa', waiting: { reason: 'qa_lock', since: '2026-10-13T01:02:03.000Z' } };
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_xss001";`);
  assert.ok(walk(run(`flowRow(${JSON.stringify(f)})`)).text.includes('waiting: qa:self/tb'));
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify({ ...f, qa: { n: 1, head: 'a' } })})`);
  const t = walk(drawer).text;
  assert.equal(t[t.indexOf('Waiting') + 1], 'qa:self/tb');
});

// 2026-10-20 (Irfan: "finished, still on working"): a Task waiting for Irfan reads Your Turn, not Working, and is not Running
test('a Task waiting you reads "Your Turn" in its row and drawer head and is not Running; a Task mid-run still reads Working and is Running', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  // contract change (2026-10-20 review): a board row carries lease_exit (tbd's /api/state flows); Your Turn needs the run's end saved
  const you = { id: 't_you001', title: 't', kind: 'task', tag: 'self/tb', state: 'working', lease_exit: 'result', waiting: { reason: 'you', since: '2026-10-20T05:41:14.678Z' } };
  const busy = { ...you, id: 't_run001', waiting: null };
  run(`state = { reminders: [], flows: ${JSON.stringify([you, busy])}, system: {}, calendar: {} }; ui.open = "t_you001";`);
  const pillOf = (f) => { const t = walk(run(`flowRow(${JSON.stringify(f)})`)).text; return t[t.indexOf('task · #self/tb · ' + f.id) + 1]; };
  assert.deepEqual([pillOf(you), pillOf(busy)], ['Your Turn', 'Working']);
  assert.deepEqual([run(`isRunning(${JSON.stringify(you)})`), run(`isRunning(${JSON.stringify(busy)})`)], [false, true]);
  // the run's end not saved yet: still Working and Running, not Needs You
  const early = { ...you, id: 't_early1', lease_exit: null };
  assert.deepEqual([pillOf(early), run(`isRunning(${JSON.stringify(early)})`), run(`needsYou(${JSON.stringify(early)})`)], ['Working', true, false]);
  // the pill says it: the row does not repeat "waiting: your turn" / "waiting: close"
  const close = { id: 't_cls001', title: 't', kind: 'code', tag: 'self/tb', state: 'final_gate', waiting: { reason: 'close' } };
  for (const g of [you, close]) assert.ok(!textOf(run(`flowRow(${JSON.stringify(g)})`)).includes('waiting:'), `no second waiting line: ${g.id}`);
  assert.ok(textOf(run(`flowRow(${JSON.stringify({ ...close, waiting: { reason: 'folder_busy' } })})`)).includes('waiting: folder busy'), 'a reason without its own pill keeps the line');
  run(`drawerBody(${JSON.stringify(you)}, ${JSON.stringify({ ...you, lease: { phase: 'working', exit: 'result' } })})`);
  const t = walk(drawer).text;
  assert.equal(t[t.indexOf('task · #self/tb · t_you001') - 1], 'Your Turn', 'the drawer head pill');
  // the board row is stale after fsm.move (waiting approve), the loaded ticket is not: the head follows the ticket
  const stale = { id: 't_stl001', title: 't', kind: 'code', tag: 'self/tb', state: 'working', waiting: { reason: 'approve' } };
  run(`drawerBody(${JSON.stringify(stale)}, ${JSON.stringify({ ...stale, waiting: null })})`);
  const t2 = walk(drawer).text;
  assert.equal(t2[t2.indexOf('code · #self/tb · t_stl001') - 1], 'Working');
});

// 2026-10-20 (Irfan: "when it blocks I can't decide anything, I need the raw log"): the Overview's first box says what he must do
test('Blocked task_changed: the Needs You box sits under the step bar with the reason, the undo lines, the refusal in words and Resume / Restart / Cancel once each', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const f = { id: 't_blk001', title: 't', kind: 'task', tag: 'self/tb', state: 'blocked', waiting: { reason: 'task_changed', why: 'changed: a.js (undo: git checkout -- a.js)\nnew: b.js (undo: rm b.js)' } };
  // tbd's real shape for a refused start: exit crash, no pid, the start's own message in error
  const k = { ...f, blocked_from: 'review', lease: { phase: 'working', started_at: '2026-10-20T05:00:00.000Z', exit: 'crash', pid: null, error: 'changed since the ticket started: a.js, b.js\nmore' } };
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_blk001";`);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  const all = flat(drawer), box = roles(drawer, 'needs-you')[0];
  assert.ok(box, 'the box');
  assert.ok(all.indexOf(all.find((n) => n.attrs?.['aria-label'] === 'Flow steps')) < all.indexOf(box), 'after the step bar');
  const inBox = textOf(box);
  for (const x of ['undo: git checkout -- a.js', 'undo: rm b.js', 'Run refused. ', 'changed since the ticket started: a.js, b.js\nmore', 'ended: refused']) assert.ok(inBox.includes(x), `in the box: ${x}`);
  assert.ok(!inBox.includes('ended: crash'), 'no raw exit word');
  for (const r of ['resume', 'restart', 'cancel']) assert.deepEqual([roles(drawer, r).length, roles(box, r).length], [1, 1], `${r}: once, inside the box`);
  const t = walk(drawer).text;
  assert.ok(t.includes('Blocked in Review') && t.includes('Last run · ended: refused: changed since the ticket started: a.js, b.js'), 'blocked_from, not the lease phase; the run in words');
  assert.ok(!t.join(' ').includes('Cancel and start a new Task'), 'old advice gone');
  assert.equal(t[t.indexOf('task · #self/tb · t_blk001') - 1], 'Blocked');
});

// the words of "Last run" (Irfan: the raw log must never be needed to know how it ended): every exit tbd writes + the error shapes it stores
test('lastRun: one plain phrase per exit (lib/stream EXITS + held), a crash with no pid is "refused", the first error line follows once', () => {
  const run = (code) => vm.runInContext(code, sandbox());
  const WORDS = { result: 'finished', crash: 'crashed', interrupted: 'stopped before it ended', stalled: 'stalled: no output', usage: 'paused: usage limit', paused: 'paused',
    held: 'in your terminal', schema_fail: 'its answer was rejected', cancelled: 'cancelled', max_turns: 'hit the turn limit', refusal: 'the model refused', wall_cap: 'stopped: time cap' };
  for (const e of [...require('../lib/stream').EXITS, 'held']) assert.ok(e in WORDS, `a phrase for ${e}`);
  for (const [exit, word] of Object.entries(WORDS)) assert.equal(run(`lastRun(${JSON.stringify({ exit, pid: 4242 })})`), `ended: ${word}`, exit);
  const last = (l) => run(`lastRun(${JSON.stringify(l)})`);
  assert.equal(last({ exit: 'crash', pid: null, error: 'refusing to start: config planted by the agent\nsecond line' }), 'ended: refused: refusing to start: config planted by the agent');
  assert.equal(last({ exit: 'crash', error: 'changed since the ticket started: a.js' }), 'ended: refused: changed since the ticket started: a.js');
  assert.equal(last({ exit: 'crash', pid: 77, error: 'exit code 1' }), 'ended: crashed: exit code 1');
  assert.equal(last({ exit: 'result', pid: 77, error: 'unit: 2 failing' }), 'ended: finished: unit: 2 failing', 'a red gate ends a run that finished');
  assert.equal(last({ exit: 'schema_fail', pid: 77, error: 'status DONE needs a commit' }), 'ended: its answer was rejected: status DONE needs a commit');
  assert.equal(last({ exit: 'crash', pid: null, pending: { why: 'usage' }, error: 'old' }), 'ended: refused', 'a recovering lease shows no error');
  assert.equal(last({ exit: 'weird', pid: 1 }), 'ended: weird', 'an unknown word as it came');
});

test('Task asks from working (plan frozen): its questions and Open in Lavish show, not "No open questions found."; wait pills read in words and none is Running', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const f = { id: 't_ask001', title: 't', kind: 'task', tag: 'self/tb', state: 'clarify' };
  const k = { ...f, plan_hash: 'a'.repeat(64), round: 2, clarify_origin: { phase: 'working', class: 'questions' } };
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_ask001";
    ui.plan = { kind: 'plan', summary: 's', steps: [], tasks: [] }; ui.round = { kind: 'questions', n: 2, phase: 'working', questions: [{ id: 'Q1', question: 'Which port?', why: 'w', options: ['a', 'b'], recommended: 'a' }] };`);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  const t = walk(drawer).text;
  assert.ok(t.includes('Which port?') && t.includes('Open in Lavish'), 'the questions and the lavish button');
  assert.ok(!t.includes('No open questions found.'));
  assert.ok(t.some((x) => x.includes('is the agent’s call')), 'a Task\'s ask from working: the agent decides what is left open, not "the planner"');
  const pill = (x) => { const w = walk(run(`flowPill(${JSON.stringify(x)})`)).text; return w[0]; };
  /** @type {[any, string, boolean][]} [flow, pill, Needs You] */ const cases = [[{ state: 'clarify' }, 'Questions', true], [{ state: 'clarify', clarify_class: 'questions' }, 'Questions', true],
    [{ state: 'clarify', clarify_class: 'scope' }, 'Your Call', true], [{ state: 'plan_approval' }, 'Approve Plan', true],
    [{ state: 'working', waiting: { reason: 'approve' } }, 'Approve Action', true], [{ state: 'working', waiting: { reason: 'blocked_action' } }, 'Action Blocked', true],
    [{ state: 'review', waiting: { reason: 'manual' } }, 'Your Call', true], [{ state: 'working', waiting: { reason: 'needs_scope' } }, 'Your Call', true],
    [{ state: 'final_gate', waiting: { reason: 'close' } }, 'Close or Push', true],
    [{ state: 'plan_approval', waiting: { reason: 'setup' } }, 'Setting Up', false], // approved: tbd sets up for minutes, nothing is on Irfan
    [{ state: 'plan_approval', waiting: { reason: 'setup_failed' } }, 'Approve Plan', true]];
  for (const [x, word, you] of cases) {
    const g = { id: 't_p', kind: 'code', ...x };
    assert.deepEqual([pill(g), run(`needsYou(${JSON.stringify(g)})`), run(`isRunning(${JSON.stringify(g)})`)], [word, you, word === 'Setting Up'], word);
  }
});

// the Needs You box for every wait on Irfan (review of the Needs You UX): one box, its actions once, nothing for a setup that runs by itself
test('drawer: Approve Action cards, a manual / close wait and an unexplained block land in the one Needs You box; a setup wait has none and no Approve Plan', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const draw = (f, k) => {
    run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = ${JSON.stringify(f.id)};`);
    run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify({ ...f, ...k })})`);
    return [roles(drawer, 'needs-you'), walk(drawer).text];
  };
  const base = { title: 't', kind: 'code', tag: 'self/tb' };
  // Approve Action: the card is inside the box, once
  let [box, t] = draw({ ...base, id: 't_apv001', state: 'working', waiting: { reason: 'approve' } }, { approvals: [{ id: 'a1', status: 'pending', tool: 'Bash', input_text: 'rm -r build', reason: 'clean' }] });
  assert.equal(box.length, 1);
  assert.equal(t.filter((x) => x === 'Needs Your OK').length, 1, 'the cards once');
  assert.ok(textOf(box[0]).includes('Needs Your OK') && roles(box[0], 'yes-a1').length === 1 && roles(drawer, 'yes-a1').length === 1, 'Yes Once inside the box, once');
  // manual wait in an unbuilt phase: pass / send back inside the box, once
  [box, t] = draw({ ...base, id: 't_man001', state: 'review', waiting: { reason: 'manual' } }, { work: {} });
  assert.equal(box.length, 1);
  assert.equal(t.filter((x) => x === 'Review: Your Call').length, 1);
  assert.ok(textOf(box[0]).includes('Review: Your Call') && roles(box[0], 'pass').length === 1 && roles(box[0], 'rework').length === 1 && roles(drawer, 'pass').length === 1, 'pass and send back inside the box');
  // waiting close: Close Flow, Push and Close, Push and the send-back box, once each, inside the box
  run('ui.tagDefs = { "self/tb": { push: { remote: "mirror" }, ident: { name: "I", email: "i@example.com" } } };');
  [box, t] = draw({ ...base, id: 't_cls001', state: 'final_gate', waiting: { reason: 'close' } }, { branch: 'tb/x', final: { sha: 'a'.repeat(40) }, work: {} });
  assert.equal(box.length, 1);
  assert.ok(t.some((x) => x.startsWith('Waits for close')) && textOf(box[0]).includes('Waits for close'), 'the wait text in the box');
  for (const r of ['close-flow', 'push-close', 'push', 'rework-text']) assert.deepEqual([roles(box[0], r).length, roles(drawer, r).length], [1, 1], `${r}: once, inside the box`);
  assert.equal(flat(drawer).filter((n) => n.attrs?.id === 'pu-h').length, 1, 'the Push section is not repeated below');
  // a block WAIT has no text for: the wait's own why, as text, in the box
  [box, t] = draw({ ...base, id: 't_blk002', state: 'blocked', waiting: { reason: 'interrupted', why: `the run was interrupted ${P}` } }, { blocked_from: 'working', lease: { phase: 'working', started_at: '2026-10-20T05:00:00.000Z', exit: 'interrupted', pid: 9 } });
  assert.equal(box.length, 1);
  assert.equal(roles(box[0], 'wait-why')[0]?.kids[0], `the run was interrupted ${P}`, 'the why in a pre inside the box');
  assert.ok(t.includes('Blocked in Working') && t.includes('Last run · ended: stopped before it ended'));
  // setup: nothing waits on Irfan: no box, no Approve Plan, the head says Setting Up
  [box, t] = draw({ ...base, id: 't_set001', state: 'plan_approval', waiting: { reason: 'setup' } }, {});
  assert.equal(box.length, 0, 'no box');
  assert.ok(t.includes('Setting Up') && !t.includes('Approve Plan') && !t.includes('Needs You'));
  // a stale board row after fsm.move: the loaded ticket decides
  [box] = draw({ ...base, id: 't_stl002', state: 'working', waiting: { reason: 'approve' } }, { waiting: null });
  assert.equal(box.length, 0);
  // a family row uses the same pill words
  run(`state.flows = [{ id: 't_kid001', title: 'kid', kind: 'code', state: 'plan_approval', waiting: { reason: 'setup' } }]`);
  assert.ok(textOf(run(`family({ children: ['t_kid001'] })`)).includes('Setting Up'));
});

test('XSS: M5.3 push state, tag ident and the Push view (git why, ident name) render as text only; Push disabled without the tag ident', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const role = (n, r) => (n?.attrs?.['data-role'] === r ? n : (n?.kids ?? []).map((x) => role(x, r)).find(Boolean));
  const f = { id: 't_xss001', title: 't', kind: 'code', tag: 'acme/api', state: 'final_gate', waiting: { reason: 'close' } };
  const k = { ...f, branch: 'tb/t_xss001-x', final: { sha: 'a'.repeat(40) },
    push: { state: 'failed', remote: 'mirror', ref: 'refs/heads/tb/t_xss001-x', sha: 'a'.repeat(40), why: `rejected ${P}` } };
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_xss001";
    ui.tagDefs = { "acme/api": { push: { remote: "mirror" }, ident: { name: ${JSON.stringify(`Irfan ${P}`)}, email: "i@example.com" } } };`);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  const w = walk(drawer);
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), [], 'no payload in a handler, src or link attribute');
  for (const s of [`failed · mirror tb/t_xss001-x · ${'a'.repeat(12)} · rejected ${P}`, `Irfan ${P} <i@example.com>`]) assert.ok(w.text.includes(s), `as text: ${s}`);
  assert.equal(role(drawer, 'push').attrs.disabled, undefined, 'ident set: Push enabled');

  run('ui.tagDefs = { "acme/api": { push: { remote: "mirror" } } };');
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  const t2 = walk(drawer).text;
  assert.equal(role(drawer, 'push').attrs.disabled, '', 'no ident: Push disabled');
  assert.ok(t2.filter((s) => s === 'tb doctor --tag acme/api --ident').length === 2 && t2.includes('ident not set: run '), 'the hint in the facts and by the button');
  run('ui.tagDefs = { "acme/api": {} };');
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  assert.equal(role(drawer, 'push'), undefined, 'no push remote: no Push button');
});

test('M5.3 C15: waiting blockers_diverge is explained in the drawer', () => {
  const ctx = sandbox();
  const text = walk(vm.runInContext('notice("t_xss001", { reason: "blockers_diverge", error: "t_a and t_b diverge" })', ctx)).text;
  assert.ok(text.some((s) => /^Blockers diverge: .*does not rebase\. Cancel it, or re-plan it\.$/.test(s)) && text.includes('t_a and t_b diverge'), String(text));
});

test('XSS: M5.3 Final view (findings, summary, verdict doc) renders agent text as text only, the verification doc as a docs route link; Close + send back at waiting close only', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const role = (n, r) => (n?.attrs?.['data-role'] === r ? n : (n?.kids ?? []).map((x) => role(x, r)).find(Boolean));
  const f = { id: 't_xss001', title: 't', kind: 'code', tag: null, state: 'final_gate', waiting: { reason: 'close' } };
  const k = { ...f, fixes: 1, work: { tasks: [] }, final: { n: 2, tested_sha: 'b'.repeat(40), sha: 'c'.repeat(40), verdict: 'pass' } };
  const fin = (doc) => ({ data: { n: 2, verdict: 'pass', at: '2026-10-14T01:02:03.000Z', verification_doc: doc,
    findings: [{ id: 'F1', severity: 'LOW', confidence: 'medium', where: `src/${P}.js:1`, problem: `p ${P}`, failure_scenario: `s ${S}`, fix: `f ${P}`, blocking: false }] } });
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_xss001"; ui.fixMax = 3;
    ui.final = { id: "t_xss001", final: ${JSON.stringify(fin('docs/verification/f.md'))}, summary: { text: ${JSON.stringify(`**Title:** ${S}`)} }, verdict: { text: ${JSON.stringify(`PASS ${P}`)} } };`);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k)})`);
  const w = walk(drawer);
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), ['href=/api/tickets/t_xss001/docs?path=verification%2Ff.md'], 'the one link is tbd\'s docs route');
  for (const s of [`p ${P}`, `s ${S}`, `f ${P}`, `src/${P}.js:1`, `**Title:** ${S}`, `PASS ${P}`, 'pass · squash cccccccccccc · tested bbbbbbbbbbbb']) assert.ok(w.text.includes(s), `as text: ${s}`);
  assert.ok(role(drawer, 'close-flow') && role(drawer, 'rework-text'), 'waiting close: Close + the send-back box');

  run(`ui.final.final = ${JSON.stringify(fin(`docs/verification/${P}.md`))};`);
  run(`drawerBody(${JSON.stringify({ ...f, waiting: null })}, ${JSON.stringify({ ...k, waiting: null })})`);
  const w2 = walk(drawer);
  assert.deepEqual(w2.attrs.filter((a) => /^href=/i.test(a)), [], 'a path off the docs regex: no link');
  assert.ok(w2.text.includes(`docs/verification/${P}.md`), 'it stays text');
  assert.ok(!role(drawer, 'close-flow') && !role(drawer, 'rework-text'), 'a final gate not waiting close: neither');
});

test('XSS: a question topic renders as a heading text; questions group by topic in first-appearance order; Open in Lavish button', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} };');
  const qs = [{ id: 'Q1', question: 'one', why: 'w', options: ['a'], recommended: 'a', topic: P }, { id: 'Q2', question: 'two', why: 'w', options: ['a'], recommended: 'a' },
    { id: 'Q3', question: 'three', why: 'w', options: ['a'], recommended: 'a', topic: P }];
  const tree = run(`clarifyForm("t_xss001", { n: 1, questions: ${JSON.stringify(qs)} })`);
  const w = walk(tree);
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction)=/i.test(a)), []);
  assert.equal(w.text.filter((s) => s === P).length, 1, 'one heading for the shared topic, as text');
  assert.deepEqual(w.text.filter((s) => ['one', 'two', 'three'].includes(s)), ['one', 'three', 'two'], 'Q3 joins Q1 under the topic; Q2 (no topic) follows');
  assert.ok(w.text.includes('Open in Lavish'));
});

test('XSS: M5.5 the parent\'s lanes table (task id, waiting why) renders as text only; lane_setup is not the approve-setup text', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_xss001";');
  const lanes = [{ id: 't_lan001', task: `T2${P}`, state: 'blocked', waiting: { reason: 'infra', why: `gate ${S}` }, live: false, attempt: 2 }];
  const w = walk(run(`workView("t_xss001", { work: { task: "T1", tries: 0, tasks: [], gate: null }, lanes: ${JSON.stringify(lanes)} })`));
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), [], 'no payload in an attribute');
  // X14: one row, as text: task, lane id, state, waiting (reason: why), live (no: as tb show), attempt
  const at = w.text.indexOf(`T2${P}`);
  assert.deepEqual(w.text.slice(at, at + 6), [`T2${P}`, 't_lan001', 'Blocked', `infra: gate ${S}`, 'no', '2']);
  const wait = (r) => walk(run(`notice("t_xss001", { reason: "${r}" })`)).text.join(' ');
  assert.match(wait('lane_setup'), /Nothing to approve/);
  assert.doesNotMatch(wait('lane_setup'), /approved plan/);
});

// ---------- M7 (lane M-C): Health view, edit form, search, drawer facts, Follow, Older / Newer, add sheets, copy-command forms ----------
const { execFileSync } = require('node:child_process');

const find = (n, pred, out = []) => {
  if (n instanceof Object && Array.isArray(n.kids)) {
    if (pred(n)) out.push(n);
    for (const k of n.kids) find(k, pred, out);
  }
  return out;
};
const txt = (n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : (n?.kids ?? []).map(txt).join(''));
const byRole = (n, r) => find(n, (x) => x.attrs['data-role'] === r)[0];
const byName = (n, name) => find(n, (x) => x.attrs.name === name)[0];
const tick = () => new Promise((r) => setImmediate(r));
const noMarkup = (w) => {
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'svg', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), [], 'no payload in a handler, src or link attribute');
};
// a fetch that records the calls; replies: 'METHOD url' → {status, json}
function net(replies = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const r = replies[`${method} ${url}`] ?? { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json, text: async () => '' };
  };
  return { calls, fetch };
}
const trust = (ctx, replies) => {
  const n = net(replies);
  ctx.fetch = n.fetch;
  vm.runInContext('trusted = true; ui.csrf = "tok";', ctx);
  return n;
};
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'health.json'), 'utf8'));
const HEALTH = { window_days: FX.window_days, from: FX.from, to: FX.to, bytes_read: FX.bytes_read, cut: FX.cut, targets: FX.targets, doctor: FX.doctor };

test('UX1: the Health view shows the 10 targets from the fixture with x / y and PASS / FAIL / n/a as words; doctor, drill and tag text stay text', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const health = { ...HEALTH, doctor: { at: FX.doctor.at, ok: false, checks: [{ name: 'claude', ok: true, detail: 'claude 2.1.295' },
    { name: `tag ${P}`, ok: false, detail: `git ls-remote failed ${P}`, fix: `tb doctor --tag x ${S}` }] } };
  const hl = { days: 30, health, drills: { items: [{ at: '2026-10-15T08:00:00.000Z', name: 'kill-tbd', ok: false, note: `lost ${P}` }], next: '2026-10-15T08:00:00.000Z' },
    tags: { 'acme/api': { type: 'git', path: `/code/${P}` }, group: {} } };
  const tree = run(`healthView(${JSON.stringify(hl)})`);
  // expected from the fixture's rules (m7-build.md §12): result word, "x / y", goal
  const EXPECT = { // result words are status pills in Title Case (DESIGN.md §8); tb health prints PASS / FAIL
    recovered: ['Fail', '2 / 4', '≥ 95%'], resume_restart: ['Fail', '2 / 10', '≤ 5%'], infra: ['Fail', '2 / 4', '≤ 5%'], false_stall: ['Pass', '1 / 5', '≤ 20%'],
    rework: ['Pass', '4 / 5', '≥ 70%'], hands_off: ['Fail', '2 / 4', '≥ 60%'], fix_of: ['Fail', '2 / 5', '≤ 10%'], golden: ['Pass', '2 / 2', 'all'],
    rss: ['Pass', '61.2 / 80 MB', '≤ 80 MB'], planner_call: ['N/A', '4 / 9', 'watch'],
  };
  const rows = find(tree, (x) => x.tag === 'tr' && x.attrs['data-key']);
  assert.deepEqual(rows.map((r) => r.attrs['data-key']), Object.keys(EXPECT), '10 targets in the frozen order');
  for (const r of rows) {
    const [label, result, now, goal] = r.kids.map(txt), [word, xy, g] = EXPECT[r.attrs['data-key']];
    assert.equal(result, word, r.attrs['data-key']);
    assert.ok(now.startsWith(xy), `${r.attrs['data-key']}: ${now}`);
    assert.equal(goal, g);
    assert.ok(label.length > 5);
  }
  assert.match(txt(rows[0].kids[2]), /1 pending/);
  assert.match(txt(rows[5].kids[2]), /1 no data/);
  assert.match(txt(rows[7].kids[0]), /Compared with the run of 2026-10-08 .*changed \(total moved, not compared\): golden:E/);
  const w = walk(tree);
  assert.ok(w.text.includes('4 of 9'), 'hero: x = ok true (4), y = every non-watch target (9, n/a counts as not met)');
  assert.deepEqual(find(tree, (x) => x.tag === 'th').filter((th) => th.attrs.scope !== 'col'), [], 'every th has scope=col');
  noMarkup(w);
  for (const s of [`git ls-remote failed ${P}`, `tb doctor --tag x ${S}`, `lost ${P}`, `/code/${P}`]) assert.ok(w.text.some((t) => t.includes(s)), `as text: ${s}`);
  assert.ok(!w.text.includes('claude 2.1.295'), 'a passing doctor check is not listed');
  assert.equal(byRole(tree, 'drills-older').attrs.disabled, undefined, 'next set: Older works');
  assert.ok(byRole(tree, 'tag-edit-acme/api'), 'a tag row has Edit');

  const empty = walk(run(`healthView(${JSON.stringify({ days: 30, health, drills: { items: [], next: null }, tags: {} })})`));
  assert.ok(empty.text.includes('No drills recorded yet.') && empty.text.includes('No tags yet.'));
  assert.equal(byRole(run(`healthView(${JSON.stringify({ days: 30, health, drills: { items: [], next: null } })})`), 'drills-older').attrs.disabled, '', 'no next: Older is disabled');
  assert.equal(find(run('healthView({ days: 30, loading: true })'), (x) => x.tag === 'table').length, 0, 'no data yet: no table');
});

test('UX2: the edit form shows note / project payloads as values; only changed fields go in one PATCH; an emptied one is cleared; unchanged sends nothing', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const t = () => ({ id: 't_e1', type: 'reminder', title: 'Pay rent', status: 'next', project: P, note: S, due: '2026-11-01', tag: 'acme/api', created: '2026-10-01' });
  const setup = (replies) => {
    ctx.t1 = t();
    run('state = { reminders: [t1], flows: [], system: {}, calendar: {} }; ui.editing = "t_e1";');
    return trust(ctx, replies);
  };
  let n = setup();
  let form = run('editInput(t1)');
  const w = walk(form);
  noMarkup(w);
  assert.equal(byName(form, 'project').value, P);
  assert.equal(byName(form, 'note').value, S);
  assert.equal(byName(form, 'due').value, '2026-11-01');
  assert.equal(byName(form, 'tag').value, 'acme/api');
  assert.ok(!w.text.includes(P) && !w.text.includes(S), 'the payloads are values, not text');
  assert.deepEqual(find(form, (x) => x.tag === 'label').map((l) => txt(l.kids[0])), ['Project', 'Due', 'Tag', 'Note'], 'every extra field has a visible label');
  assert.equal(byRole(form, 'edit').attrs['aria-label'], 'Edit title');

  byName(form, 'project').value = 'Acme';
  byName(form, 'note').value = '';
  form.handlers.submit[0]({ preventDefault() {} });
  await tick(); await tick();
  assert.deepEqual(n.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body]), [['/api/reminders/t_e1', { project: 'Acme', note: null }]]);

  n = setup(); form = run('editInput(t1)');
  form.handlers.submit[0]({ preventDefault() {} });
  await tick(); await tick();
  assert.deepEqual(n.calls.filter((c) => c.method === 'PATCH'), [], 'nothing changed: no request');

  n = setup(); form = run('editInput(t1)');
  byRole(form, 'edit').value = 'Pay rent today';
  form.handlers.submit[0]({ preventDefault() {} });
  await tick(); await tick();
  assert.deepEqual(n.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ title: 'Pay rent today' }], 'a title-only edit is as before');

  n = setup(); form = run('editInput(t1)');
  byName(form, 'tag').value = 'Bad Tag';
  form.handlers.submit[0]({ preventDefault() {} });
  await tick();
  assert.equal(byName(form, 'tag').reported, true, 'a malformed tag stays in the form');
  assert.deepEqual(n.calls.filter((c) => c.method === 'PATCH'), []);
});

test('UX2: search finds a done item past the 15 cap (title, note, project or id, any case); a miss reads "No matches."', () => {
  const board = new Node('div');
  const ctx = sandbox({ '#board': board });
  const run = (code) => vm.runInContext(code, ctx);
  const done = Array.from({ length: 20 }, (_, i) => ({ id: `t_d${i}`, type: 'reminder', title: `finished ${i}`, status: 'done', done_at: '2026-10-01', project: i === 19 ? 'Acme' : undefined, note: i === 18 ? 'See Needle' : undefined }));
  run(`state = { reminders: ${JSON.stringify([...done, { id: 't_n1', type: 'reminder', title: 'Call bank', status: 'now' }])}, flows: [], system: {}, calendar: {} };`);
  run('renderReminders()');
  let w = walk(board);
  assert.ok(!w.text.includes('finished 19') && w.text.includes('finished 14') && w.text.includes('5 older not shown'), 'no search: 15 of the 20 done');
  for (const q of ['acme', 'NEEDLE', 't_d17', 'finished 19']) {
    run(`ui.q = ${JSON.stringify(q.toLowerCase())}; renderReminders()`);
    w = walk(board);
    assert.ok(w.text.some((t) => /^finished 1[789]$|^finished 19$/.test(t)), `finds ${q}`);
    assert.ok(!w.text.includes('Call bank') && !w.text.includes('older not shown'), 'only the matches, no cap note');
  }
  run('ui.q = "acme"; renderReminders()');
  assert.ok(walk(board).text.includes('1') && !walk(board).text.includes('1 / 3'), 'Now counts matches too, not n / 3');
  run('ui.q = "zzz"; renderReminders()');
  assert.deepEqual(walk(board).text, ['No Matches', 'Try another word, or clear the search.', 'Clear Search']);
});

test('UX3: the drawer shows fix_of (opens that ticket) and promoted_from as text; absent: no fact row', async () => {
  const drawer = new Node('dialog');
  const ctx = sandbox({ '#drawer': drawer });
  const run = (code) => vm.runInContext(code, ctx);
  const f = { id: 't_f2', title: 'Fix', kind: 'code', tag: null, state: 'backlog' };
  run(`state = { reminders: [], flows: [{ id: "t_a1", title: ${JSON.stringify(`Original ${P}`)}, state: "done" }, ${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_f2";`);
  const n = trust(ctx);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify({ ...f, fix_of: 't_a1', promoted_from: `r_${S}` })})`);
  const w = walk(drawer);
  noMarkup(w);
  assert.equal(w.text[w.text.indexOf('Fix of') + 1], `Original ${P}`, 'the fix_of title, as text');
  assert.equal(w.text[w.text.indexOf('Promoted from') + 1], `r_${S}`);
  drawer.open = true;
  byRole(drawer, 'fix-of').handlers.click[0]();
  await tick();
  assert.ok(n.calls.some((c) => c.url === '/api/tickets/t_a1'), 'Fix of opens that ticket');

  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(f)})`);
  const none = walk(drawer).text;
  assert.ok(!none.includes('Fix of') && !none.includes('Promoted from'));
});

test('UX4: Follow on + a run event of the open ticket reads the log after the last offset once; the run ending turns it off', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const n = trust(ctx, { 'GET /api/tickets/t_f1/log?after=100&run=7': { status: 200, json: { lines: ['b', 'c'], offset: 130, ended: false } },
    'GET /api/tickets/t_f1/log?after=130&run=7': { status: 200, json: { lines: ['d'], offset: 140, ended: true } } });
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_f1"; ui.log = { id: "t_f1", lines: ["a"], run: 7, offset: 100, ended: false }; ui.follow = { id: "t_f1", on: true };');
  const ev = (id) => `onRun({ data: JSON.stringify({ id: "${id}", liveness: "thinking", live: true }) })`;
  run(ev('t_other'));
  await tick();
  assert.deepEqual(n.calls.filter((c) => c.url.includes('/log')), [], 'a run event of another ticket reads nothing');
  run(ev('t_f1'));
  await tick(); await tick();
  assert.deepEqual(n.calls.filter((c) => c.url.includes('/log')).map((c) => c.url), ['/api/tickets/t_f1/log?after=100&run=7']);
  assert.deepEqual(JSON.parse(run('JSON.stringify(ui.log.lines)')), ['a', 'b', 'c']);
  run(ev('t_f1'));
  await tick(); await tick();
  assert.equal(n.calls.filter((c) => c.url.includes('/log')).length, 2);
  assert.equal(run('ui.follow.on'), false, 'ended: follow is off');
  assert.deepEqual(JSON.parse(run('JSON.stringify(ui.log.lines)')), ['a', 'b', 'c', 'd']);
  run(ev('t_f1'));
  await tick(); await tick();
  assert.equal(n.calls.filter((c) => c.url.includes('/log')).length, 2, 'off: the next run event makes no request');
  // the run left the view (liveness null): read on until tbd says ended, then off; never stuck on
  const n2 = trust(ctx, { 'GET /api/tickets/t_f1/log?after=140&run=7': { status: 200, json: { lines: [], offset: 140, ended: true } } });
  run('ui.follow = { id: "t_f1", on: true }; ui.log.offset = 140;');
  run('onRun({ data: JSON.stringify({ id: "t_f1", liveness: null }) })');
  await tick(); await tick();
  assert.equal(n2.calls.filter((c) => c.url.includes('/log')).length, 1);
  assert.equal(run('ui.follow.on'), false);
  assert.equal(run('ui.follow.busy'), false, 'busy is cleared');
  // (-) not ended on that last read: Follow is off anyway, and follow scheduled no timer
  const timers = [];
  ctx.setTimeout = (...a) => timers.push(a);
  const n3 = trust(ctx, { 'GET /api/tickets/t_f1/log?after=140&run=7': { status: 200, json: { lines: ['z'], offset: 150, ended: false } } });
  run('ui.follow = { id: "t_f1", on: true }; ui.log.offset = 140;');
  run('onRun({ data: JSON.stringify({ id: "t_f1", liveness: null }) })');
  await tick(); await tick();
  assert.equal(n3.calls.filter((c) => c.url.includes('/log')).length, 1, 'one read');
  assert.equal(run('ui.follow.on'), false);
  assert.deepEqual(timers.filter((t) => t[0].name !== 'readOpen'), [], 'no timer from follow (onRun\'s own readOpen debounce aside)');
  // the run-end event arrives while a read is in flight: that read, then ONE more, then off
  let release;
  const gate = new Promise((r) => { release = r; });
  const urls = [];
  /** @type {any} */ (ctx).fetch = async (url) => { urls.push(url); if (urls.length === 1) await gate; return { ok: true, status: 200, json: async () => ({ lines: [], offset: 150, ended: false }) }; };
  run('ui.follow = { id: "t_f1", on: true }; ui.log.offset = 140;');
  run('onRun({ data: JSON.stringify({ id: "t_f1", liveness: "thinking", live: true }) })');
  await tick();
  run('onRun({ data: JSON.stringify({ id: "t_f1", liveness: null }) })');
  release();
  await tick(); await tick(); await tick();
  assert.equal(urls.filter((u) => u.includes('/log')).length, 2, 'in-flight read + one more');
  assert.equal(run('ui.follow.on'), false);
  // the button: a button with aria-pressed
  run('ui.follow = { id: "t_f1", on: true };');
  const box = walk(run('el("div", null, ...runBox("t_f1", { state: "working", lease: { log: "runs/7.jsonl", phase: "working" } }))'));
  assert.ok(box.attrs.includes('aria-pressed=true') && box.text.includes('Following'));
});

test('UX5: Older at review / QA / final n=2 asks n=1; at n=1 Older has disabled; a 404 for the older one disables it', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const rv = (n) => ({ n, verdict: 'block', at: '2026-10-12T01:02:03.000Z', findings: [], closed: [] });
  const n = trust(ctx, { 'GET /api/tickets/t_p1/report?kind=review&n=1': { status: 200, json: rv(1) }, 'GET /api/tickets/t_p1/report?kind=qa&n=1': { status: 404, json: { error: 'none' } } });
  run('state = { reminders: [], flows: [], system: {}, calendar: {} }; ui.open = "t_p1"; ui.fixMax = 3;');
  run(`ui.review = { id: "t_p1", data: ${JSON.stringify(rv(2))}, latest: 2 }`);
  let tree = run('reviewView("t_p1", { fixes: 0 })');
  assert.equal(byRole(tree, 'review-older').attrs.disabled, undefined);
  assert.equal(byRole(tree, 'review-newer').attrs.disabled, '', 'at the newest: Newer is disabled');
  byRole(tree, 'review-older').handlers.click[0]();
  await tick(); await tick();
  assert.deepEqual(n.calls.map((c) => c.url), ['/api/tickets/t_p1/report?kind=review&n=1']);
  tree = run('reviewView("t_p1", { fixes: 0 })');
  assert.equal(byRole(tree, 'review-older').attrs.disabled, '', 'n=1: Older is disabled');
  assert.equal(byRole(tree, 'review-newer').attrs.disabled, undefined, 'and Newer works');

  const qa = { n: 2, verdict: 'pass', at: '2026-10-13T01:02:03.000Z', report: 'docs/verification/r.md', need_review: [], findings: [], cases: [] };
  run(`ui.qa = { id: "t_p1", data: ${JSON.stringify(qa)}, latest: 2 }`);
  assert.equal(byRole(run('qaView("t_p1", { qa: { n: 2 } })'), 'qa-older').attrs.disabled, undefined);
  run('loadQa("t_p1", 1)');
  await tick(); await tick();
  assert.equal(run('ui.qa.noOlder'), true, '404 for the older one');
  assert.equal(run('ui.qa.data.n'), 2, 'the shown result stays');
  assert.equal(byRole(run('qaView("t_p1", { qa: { n: 2 } })'), 'qa-older').attrs.disabled, '');

  run(`ui.final = { id: "t_p1", final: { data: { n: 1, verdict: "pass", findings: [], verification_doc: null } }, summary: { text: "s" }, verdict: { text: "v" } }`);
  assert.equal(byRole(run('finalView("t_p1", { fixes: 0 })'), 'final-older').attrs.disabled, '', 'final n=1');
});

test('UX6: the flow sheet with title posts {text, title, kind, tag} once; an empty goal posts nothing; no Fix Of field (contract change)', async () => {
  const sheet = new Node('form'), scrim = new Node('div');
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': scrim });
  const run = (code) => vm.runInContext(code, ctx);
  const n = trust(ctx);
  // board-terminal-parity 6.2: the kinds are the built ones tbd names (system.kinds)
  run(`state = { reminders: [], flows: [{ id: "t_a1", title: "Earlier flow", state: "done" }], system: { kinds: ["code"] }, calendar: {} }; ui.tags = ["acme/api"];`);
  run('openNew("flow")'); // calm UI: the New sheet (N / New) replaced the composer line and its More… sheet
  assert.deepEqual(find(sheet, (x) => x.tag === 'label').map((l) => txt(l)), ['Goal for the Agent', 'Short Title', 'Kind', 'Tag',
    'Locked run: for untrusted text (an issue, a pasted log). Fewer tools, slower.', 'Start Now']); // board-terminal-parity 6.3 words, 6.1 Start Now
  const ids = find(sheet, (x) => x.tag === 'label').map((l) => l.attrs.for);
  assert.deepEqual(ids.map((id) => find(sheet, (x) => x.attrs.id === id).length), [1, 1, 1, 1, 1, 1], 'each label points at one control');
  assert.deepEqual(find(byName(sheet, 'tag'), (x) => x.tag === 'option').map((o) => o.attrs.value), ['', 'acme/api', '+add-tag'], 'Add Tag… is the last option');
  byName(sheet, 'text').value = 'Make the list sortable';
  byName(sheet, 'tag').value = 'acme/api';
  byName(sheet, 'title').value = 'Sortable list';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]),
    [['/api/flows', { text: 'Make the list sortable', title: 'Sortable list', kind: 'code', tag: 'acme/api' }]]);

  byName(sheet, 'title').value = '';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').at(-1).body, { text: 'Make the list sortable', kind: 'code', tag: 'acme/api' }, 'no title key');
  byName(sheet, 'sandbox').checked = true; // full access is the default; the box asks for today's locked run (tb new --sandbox)
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').at(-1).body, { text: 'Make the list sortable', kind: 'code', tag: 'acme/api', sandbox: true }, 'sandbox box → sandbox: true');
  byName(sheet, 'sandbox').checked = false;
  byName(sheet, 'start').checked = true; // board-terminal-parity 6.1: Start Now asks tbd to assign it at once (tb new --start)
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').at(-1).body, { text: 'Make the list sortable', kind: 'code', tag: 'acme/api', start: true }, 'Start Now → start: true');

  byName(sheet, 'text').value = '   ';
  const before = n.calls.length;
  await sheet.onsubmit({ preventDefault() {} });
  assert.equal(n.calls.length, before, 'an empty goal: no request');
  assert.ok(txt(sheet).includes('Write the goal first.'));
});

test('UX7: the reminder sheet with column + due + project posts {title, status, due, project}; a title-only add still posts what the composer line did; the id line shows done_at for done only', async () => {
  const sheet = new Node('form');
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': new Node('div') });
  const run = (code) => vm.runInContext(code, ctx);
  const n = trust(ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} };');
  run('openNew("reminder")'); // calm UI: the New sheet replaced the composer line and its More… sheet; note and tag joined the add (D-0149 fields)
  assert.deepEqual(find(sheet, (x) => x.tag === 'label').map((l) => txt(l)), ['Title', 'Column', 'Due', 'Project', 'Note', 'Tag']);
  assert.deepEqual(find(byName(sheet, 'status'), (x) => x.tag === 'option').map((o) => o.attrs.value), ['inbox', 'now', 'next', 'later'], 'no Done column in an add');
  byName(sheet, 'title').value = '  Pay rent ';
  byName(sheet, 'status').value = 'next';
  byName(sheet, 'due').value = '2026-11-01';
  byName(sheet, 'project').value = 'Acme';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]), [['/api/reminders', { title: 'Pay rent', status: 'next', due: '2026-11-01', project: 'Acme' }]]);

  // a title-only add: the body of the old composer line (top of Inbox)
  run('openNew("reminder")');
  byName(sheet, 'title').value = ' Buy milk ';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').at(-1), { url: '/api/reminders', method: 'POST', body: { title: 'Buy milk', status: 'inbox', pos: 'top' } });

  const text = (t) => txt(run(`detailLine(${JSON.stringify(t)})`));
  assert.equal(text({ id: 't_1', created: '2026-10-01', status: 'done', done_at: '2026-10-05' }), 'Id t_1 · Created 2026-10-01 · Done 2026-10-05');
  assert.equal(text({ id: 't_2', created: '2026-10-01', status: 'next' }), 'Id t_2 · Created 2026-10-01', 'an open item: no done date');
});

test('calm UI: the New sheet refuses a blank title and a malformed tag inline (no request); note and tag go in the add', async () => {
  const sheet = new Node('form');
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': new Node('div') });
  const run = (code) => vm.runInContext(code, ctx);
  const n = trust(ctx);
  const posts = () => n.calls.filter((c) => c.method === 'POST');
  run('state = { reminders: [], flows: [], system: {}, calendar: {} };');
  run('openNew("reminder")');
  await sheet.onsubmit({ preventDefault() {} });
  assert.ok(txt(sheet).includes('Type a title first.'));
  byName(sheet, 'title').value = 'Pay rent';
  byName(sheet, 'tag').value = 'Bad Tag';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts(), [], 'blank title, then a malformed tag: nothing posted');
  assert.ok(txt(sheet).includes('Use lowercase letters, digits and -; a/b for a child.'));
  byName(sheet, 'tag').value = 'home';
  byName(sheet, 'note').value = 'Before Friday';
  await sheet.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts().map((c) => c.body), [{ title: 'Pay rent', status: 'inbox', pos: 'top', note: 'Before Friday', tag: 'home' }]);
});

test('calm UI: New Flow posts once while its add is in flight (a second submit, Enter in the goal box); once it lands Add works again', async () => {
  const sheet = /** @type {any} */ (new Node('form'));
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': new Node('div') });
  const run = (code) => vm.runInContext(code, ctx);
  trust(ctx);
  const posts = [];
  let land;
  /** @type {any} */ (ctx).fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => { // a POST waits until land(): the add stays in flight
    if (init.method === 'POST') { posts.push([url, JSON.parse(init.body)]); await new Promise((r) => { land = r; }); }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  run('state = { reminders: [], flows: [], system: { kinds: ["code"] }, calendar: {} };'); // board-terminal-parity 6.2: tbd names the kinds
  run('openNew("flow")');
  sheet.requestSubmit = () => sheet.onsubmit({ preventDefault() {} }); // the browser's: a submit event
  byRole(sheet, 'sheet-add').isConnected = true;
  byName(sheet, 'text').value = 'Make the list sortable';
  const first = sheet.onsubmit({ preventDefault() {} });
  sheet.onsubmit({ preventDefault() {} }); // not awaited: a second post would wait for land() too
  sheet.onkeydown({ key: 'Enter', target: { tagName: 'TEXTAREA' }, preventDefault() {} });
  await tick();
  assert.deepEqual(posts, [['/api/flows', { text: 'Make the list sortable', kind: 'code' }]], 'one POST while the first add is in flight');
  land();
  await first;
  const again = sheet.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 2, 'the add landed: the next submit posts');
  land();
  await again;
});

test('Add Tag from the New Flow sheet: the Add Tag… option opens Add Tag and the Tag stays on its old value; Cancel brings the New sheet back with goal, title and tag kept', async () => {
  const sheet = new Node('form'), scrim = new Node('div');
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': scrim });
  const run = (code) => vm.runInContext(code, ctx);
  trust(ctx);
  run('state = { reminders: [], flows: [], system: { kinds: ["code"] }, calendar: {} }; ui.tags = ["acme/api", "acme/web"]; ui.tagsLoaded = true;');
  run('openNew("flow")');
  byName(sheet, 'text').value = 'Make the list sortable';
  byName(sheet, 'title').value = 'Sortable';
  byName(sheet, 'tag').value = 'acme/web';
  for (const h of byName(sheet, 'tag').handlers.change) h({ target: byName(sheet, 'tag') }); // the user picked acme/web
  byName(sheet, 'tag').value = '+add-tag';
  for (const h of byName(sheet, 'tag').handlers.change) h({ target: byName(sheet, 'tag'), stopImmediatePropagation() {} });
  assert.equal(txt(find(sheet, (x) => x.attrs.id === 'sheet-title')[0]), 'Add Tag', 'Add Tag replaced the New sheet');
  byRole(sheet, 'sheet-cancel').handlers.click[0]({});
  await tick();
  assert.equal(txt(find(sheet, (x) => x.attrs.id === 'sheet-title')[0]), 'New Flow', 'Cancel: New Flow is back');
  assert.deepEqual(['text', 'title', 'tag'].map((k) => byName(sheet, k).value), ['Make the list sortable', 'Sortable', 'acme/web'], 'fields kept, the old tag');
});

test('Add Tag from the New Flow sheet, Page Tools on: Add posts the tag and New Flow comes back on it with goal, title, kind, locked run and Start Now kept; no request carries the +add-tag sentinel', async () => {
  const sheet = new Node('form'), scrim = new Node('div');
  const isOpen = new Set();
  /** @type {any} */ (scrim).classList = { add: (c) => isOpen.add(c), remove: (c) => isOpen.delete(c), contains: (c) => isOpen.has(c) };
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': scrim });
  const run = (code) => vm.runInContext(code, ctx);
  const n = trust(ctx, {
    'GET /api/folders/recent': { status: 200, json: { folders: [] } },
    'POST /api/folders/branches': { status: 200, json: { type: 'git', branches: ['main', 'dev'], current: 'main' } },
    'POST /api/tags/quick': { status: 200, json: { tag: { name: 'acme/new' } } },
    'GET /api/tags': { status: 200, json: { tags: { 'acme/api': { path: '/x/api' }, 'acme/new': { path: '/x/new' } } } },
  });
  run('state = { reminders: [], flows: [], system: { kinds: ["code", "research"] }, calendar: {} }; ui.cfg = { config: { terminal: { page_tools: true } } }; ui.tags = ["acme/api"]; ui.tagsLoaded = true;');
  run('openNew("flow")');
  byName(sheet, 'text').value = 'Make the list sortable';
  byName(sheet, 'title').value = 'Sortable';
  byName(sheet, 'kind').value = 'research';
  byName(sheet, 'sandbox').checked = true;
  byName(sheet, 'start').checked = false;
  byName(sheet, 'tag').value = '+add-tag';
  for (const h of byName(sheet, 'tag').handlers.change) h({ target: byName(sheet, 'tag'), stopImmediatePropagation() {} });
  assert.equal(txt(find(sheet, (x) => x.attrs.id === 'sheet-title')[0]), 'Add Tag');
  byName(sheet, 'name').value = 'acme/new';
  byName(sheet, 'path').value = '/x/new';
  await sheet.onsubmit({ preventDefault() {} });
  await tick();
  assert.equal(txt(find(sheet, (x) => x.attrs.id === 'sheet-title')[0]), 'New Flow', 'Add: New Flow is back');
  assert.deepEqual(['text', 'title', 'kind', 'tag'].map((k) => byName(sheet, k).value), ['Make the list sortable', 'Sortable', 'research', 'acme/new']);
  assert.deepEqual(['sandbox', 'start'].map((k) => byName(sheet, k).attrs.checked !== undefined), [true, false], 'the stub reads a checked box as an attribute');
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]), [
    ['/api/folders/branches', { path: '/x/new' }],
    ['/api/tags/quick', { name: 'acme/new', path: '/x/new', base: 'main' }],
  ]);
  assert.ok(n.calls.every((c) => !c.url.includes('%2Badd-tag') && !c.url.includes('+add-tag') && !JSON.stringify(c.body ?? '').includes('add-tag')), 'the sentinel never reaches a request');
});

test('@ in the Goal box: fast typing makes one GET /api/files for the last word; a late older reply is ignored; a pick inserts @path and a path with a space is quoted', async () => {
  const sheet = new Node('form');
  const ctx = /** @type {any} */ (sandbox({ '#sheet .sheet': sheet, '#sheet': new Node('div') }));
  const run = (code) => vm.runInContext(code, ctx);
  const timers = [];
  ctx.setTimeout = (fn) => timers.push(fn);
  ctx.clearTimeout = (id) => { timers[id - 1] = null; };
  const fire = async () => { for (const f of timers.splice(0)) f?.(); await tick(); }; // not awaited: a read waits for its reply
  const files = {}; // q → resolve(reply)
  const urls = [];
  ctx.fetch = (url) => {
    urls.push(url);
    if (!url.startsWith('/api/files')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    return new Promise((res) => { files[new URL(url, 'http://x').searchParams.get('q')] = (reply) => res({ ok: true, status: 200, json: async () => reply }); });
  };
  vm.runInContext('trusted = true; ui.csrf = "tok";', ctx);
  run('state = { reminders: [], flows: [], system: { kinds: ["code"] }, calendar: {} }; ui.tags = ["acme/web"]; ui.tagsLoaded = true;');
  run('openNew("flow")');
  const ta = byName(sheet, 'text'), list = find(sheet, (x) => x.attrs.id === 'skill-list')[0];
  ta.removeAttribute = (k) => delete ta.attrs[k]; // the stub Node has none of these
  ta.setSelectionRange = (a, b) => { ta.selectionStart = a; ta.selectionEnd = b; };
  byName(sheet, 'tag').value = 'acme/web';
  const type = (v) => { ta.value = v; ta.selectionStart = ta.selectionEnd = v.length; for (const h of ta.handlers.input) h({}); };
  type('go @c');
  type('go @ca');
  await fire();
  assert.deepEqual(urls.filter((u) => u.startsWith('/api/files')), ['/api/files?tag=acme%2Fweb&q=ca'], 'one read, for the last word');
  type('go @car');
  await fire();
  files.car({ files: ['src/Cart.js', 'src/my cart.js'], more: true });
  await tick();
  files.ca({ files: ['src/old.js'], more: false }); // the older read lands late
  await tick();
  const opts = find(list, (x) => x.attrs.role === 'option');
  assert.deepEqual(opts.map((o) => txt(o)), ['@src/Cart.js', '@src/my cart.js', 'More files: type more of the name.']);
  opts[0].handlers.click[0]({});
  assert.equal(ta.value, 'go @src/Cart.js ');
  type('go @car');
  await fire(); // same word again: no new read, the kept list answers
  type('go @carx');
  await fire();
  files.carx({ files: ['src/my cart.js'], more: false });
  await tick();
  find(list, (x) => x.attrs.role === 'option')[0].handlers.click[0]({});
  assert.equal(ta.value, 'go @"src/my cart.js" ');
});

test('calm UI: the Overdue highlight filters Reminders to open reminders due before today (never a done one); a search narrows it; the chip clears it', () => {
  const board = new Node('div'), chips = new Node('div');
  const ctx = sandbox({ '#board': board, '#rfilters': chips });
  const run = (code) => vm.runInContext(code, ctx);
  const rs = [
    { id: 't_o1', type: 'reminder', title: 'Pay rent', status: 'next', due: '2020-01-01' },
    { id: 't_o2', type: 'reminder', title: 'Call bank', status: 'inbox', due: '2020-01-02' },
    { id: 't_d1', type: 'reminder', title: 'Old done', status: 'done', due: '2020-01-01', done_at: '2020-01-01' },
    { id: 't_f1', type: 'reminder', title: 'Later thing', status: 'next', due: '2999-01-01' },
    { id: 't_n1', type: 'reminder', title: 'No date', status: 'now' },
  ];
  run(`state = { reminders: ${JSON.stringify(rs)}, flows: [], system: {}, calendar: {} };`);
  run('filterReminders("overdue")');
  let w = walk(board).text;
  assert.ok(w.includes('Pay rent') && w.includes('Call bank'), 'the two open late ones');
  assert.ok(!w.includes('Old done') && !w.includes('Later thing') && !w.includes('No date'), 'not done, not later, not undated');
  assert.ok(walk(chips).text.includes('Overdue · 2'));
  run('ui.q = "rent"; renderReminders()');
  w = walk(board).text;
  assert.ok(w.includes('Pay rent') && !w.includes('Call bank'), 'filter and search combine');
  run('ui.q = ""');
  byRole(chips, 'rfilter').handlers.click[0]();
  assert.equal(run('ui.rfilter'), null);
  assert.ok(walk(board).text.includes('No date'), 'cleared: every column is back');
});

// ---- D-0172 copy-command forms: expected commands from the usage text in lib/cli.js (HELP), never from running the builder ----
test('D-0172: tag-add / doctor / gc / eval build the commands of the usage text; ids shipped: tag-add, doctor, gc, eval', () => {
  const ctx = sandbox();
  const cmd = (id, v) => JSON.parse(vm.runInContext(`JSON.stringify(buildCmd(${JSON.stringify(id)}, ${JSON.stringify(v)}))`, ctx));
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(Object.keys(CMDS))', ctx)).sort(), ['doctor', 'eval', 'gc', 'tag-add']);
  const ok = (id, v, want) => assert.deepEqual(cmd(id, v), { cmd: want, errors: {} });
  // tag add examples: `tb tag add acme/api --type git --path ~/code/acme-api --base main`, `tb tag add acme/api --ident --push-remote origin`
  ok('tag-add', { name: 'acme/api', type: 'git', path: '~/code/acme-api', base: 'main' }, "tb tag add 'acme/api' --type 'git' --path ~/'code/acme-api' --base 'main'");
  ok('tag-add', { name: 'acme/api', ident: true, 'push-remote': 'origin' }, "tb tag add 'acme/api' --ident --push-remote 'origin'");
  ok('tag-add', { name: 'acme' }, "tb tag add 'acme'");
  ok('tag-add', { name: 'a/b', type: 'folder', path: '/srv/x', 'qa-ports': '3000,3001', db: 'local', 'leak-check': true, checks: '{"lint":"npm run lint"}', heavy: '["npm ci"]' },
    "tb tag add 'a/b' --type 'folder' --path '/srv/x' --checks '{\"lint\":\"npm run lint\"}' --heavy '[\"npm ci\"]' --leak-check --qa-ports '3000,3001' --db 'local'");
  // doctor examples: `tb doctor`, `tb doctor --tag acme/api`, `tb doctor --tag acme/api --ident`
  ok('doctor', {}, 'tb doctor');
  ok('doctor', { tag: 'acme/api' }, "tb doctor --tag 'acme/api'");
  ok('doctor', { tag: 'acme/api', ident: true, 'qa-ports': '3000', db: 'none' }, "tb doctor --tag 'acme/api' --ident --qa-ports '3000' --db 'none'");
  // gc example: `tb gc --delete worktree/t_k3x9qa`; the list is `tb gc [--limit 20]`
  ok('gc', { mode: 'list' }, 'tb gc');
  ok('gc', { mode: 'list', limit: '20' }, "tb gc --limit '20'");
  ok('gc', { mode: 'delete', ids: 'worktree/t_k3x9qa' }, "tb gc --delete 'worktree/t_k3x9qa'");
  ok('gc', { mode: 'delete', ids: 'worktree/t_k3x9qa\ncache/x' }, "tb gc --delete 'worktree/t_k3x9qa' 'cache/x'");
  // eval: `tb eval fake`, `tb eval golden --dry`, `--real [--only …]` (no --yes: the CLI prints the cost and refuses until the user adds it), `--record <file>` (m7-build.md M-B)
  ok('eval', { mode: 'fake' }, 'tb eval fake');
  ok('eval', { mode: 'dry' }, 'tb eval golden --dry');
  ok('eval', { mode: 'real' }, 'tb eval golden --real');
  ok('eval', { mode: 'real', only: 'golden,planner' }, "tb eval golden --real --only 'golden,planner'");
  ok('eval', { mode: 'record', file: '/tmp/score.json' }, "tb eval golden --record '/tmp/score.json'");

  // the checks of lib/cli.js / lib/tags.js
  const bad = (id, v, key) => assert.ok(cmd(id, v).errors[key], `${id} ${JSON.stringify(v)}: ${key} refused`);
  bad('tag-add', {}, 'name');
  bad('tag-add', { name: 'Acme' }, 'name');
  bad('tag-add', { name: '-x' }, 'name');
  bad('tag-add', { name: '--setup' }, 'name');
  bad('doctor', { tag: '--setup' }, 'tag');
  bad('tag-add', { name: 'a', type: 'git', path: '/x' }, 'base');
  bad('tag-add', { name: 'a', type: 'git', base: 'main' }, 'path');
  bad('tag-add', { name: 'a', path: '/x' }, 'type');
  bad('tag-add', { name: 'a', 'qa-ports': '0' }, 'qa-ports');
  bad('tag-add', { name: 'a', 'qa-ports': '70000' }, 'qa-ports');
  bad('tag-add', { name: 'a', 'push-remote': '-x' }, 'push-remote');
  bad('tag-add', { name: 'a', checks: '[1]' }, 'checks');
  bad('tag-add', { name: 'a', heavy: '{}' }, 'heavy');
  bad('doctor', { ident: true }, 'ident');
  bad('doctor', { db: 'local' }, 'db');
  bad('doctor', { tag: 'A b' }, 'tag');
  bad('gc', { mode: 'list', limit: '0' }, 'limit');
  bad('gc', { mode: 'delete', ids: '' }, 'ids');
  bad('gc', { mode: 'delete', ids: 'rm -rf /' }, 'ids');
  bad('eval', { mode: 'real', only: 'golden,bogus' }, 'only');
  bad('eval', { mode: 'record', file: '' }, 'file');
});

test('D-0172: a hostile value stays one quoted word in a real shell; ~ still expands; name "a b; rm -rf ~" is quoted and refused', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const sh = (cmd, env = {}) => execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${cmd.replace(/^tb /, '')}`], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' }).trimEnd().split('\n');
  const hostile = "x'; echo PWNED; echo '";
  const { cmd } = JSON.parse(run(`JSON.stringify(buildCmd("tag-add", ${JSON.stringify({ name: 'a', type: 'folder', path: hostile, setup: 'npm ci && npm test' })}))`));
  assert.deepEqual(sh(cmd), ['tag', 'add', 'a', '--type', 'folder', '--path', hostile, '--setup', 'npm ci && npm test'], 'every value arrives as one argument; nothing ran');
  const home = JSON.parse(run(`JSON.stringify(buildCmd("tag-add", ${JSON.stringify({ name: 'a', type: 'folder', path: '~/my code' })}))`)).cmd;
  assert.deepEqual(sh(home, { HOME: '/home/irfan' }).slice(-1), ['/home/irfan/my code'], '~ expanded by the shell, the rest one word');
  assert.equal(run('shq("it\'s")'), "'it'\\''s'");

  const name = 'a b; rm -rf ~';
  const r = JSON.parse(run(`JSON.stringify(buildCmd("tag-add", ${JSON.stringify({ name })}))`));
  assert.equal(r.cmd, "tb tag add 'a b; rm -rf ~'");
  assert.ok(r.errors.name);
  assert.deepEqual(sh(r.cmd), ['tag', 'add', name], 'even refused, the preview is one literal word');
});

test('D-0172: the sheet shows the command as text, labels every field, and keeps Copy off while a field is invalid', () => {
  const sheet = new Node('form');
  const ctx = sandbox({ '#sheet .sheet': sheet, '#sheet': new Node('div') });
  const run = (code) => vm.runInContext(code, ctx);
  let s = run('cmdSheet("tag-add", { name: "a b; rm -rf ~" })');
  assert.equal(s.copy.disabled, true, 'invalid name: Copy off');
  assert.ok(txt(s.pre).includes("tb tag add 'a b; rm -rf ~'") && txt(sheet).includes('Use lowercase letters, digits and -'), 'quoted literal and the inline reason');
  s = run('cmdSheet("tag-add", { name: "acme/api", type: "git", path: "~/code/acme-api", base: "main" })');
  assert.equal(s.copy.disabled, false);
  assert.equal(txt(s.pre), "tb tag add 'acme/api' --type 'git' --path ~/'code/acme-api' --base 'main'");
  const labels = find(sheet, (x) => x.tag === 'label').map((l) => l.attrs.for);
  const ctls = find(sheet, (x) => ['input', 'select', 'textarea'].includes(x.tag)).map((c) => c.attrs.id);
  assert.deepEqual(labels, ctls, 'every field has exactly one label');
  assert.equal(byRole(sheet, 'copy').attrs.type, 'submit');

  // a tag name from the server fills the doctor form: hostile names are quoted and refused
  s = run(`cmdSheet("doctor", { tag: ${JSON.stringify("x';reboot;'")} })`);
  assert.equal(s.copy.disabled, true);
  assert.ok(txt(s.pre).includes("tb doctor --tag 'x'\\'';reboot;'\\'''"));
  noMarkup(walk(sheet));
  s = run('cmdSheet("doctor", { tag: "acme/api" })');
  assert.equal(txt(s.pre), "tb doctor --tag 'acme/api'", 'Edit on a tag row prefills doctor --tag');
});

test('D-0172: Copy puts the exact command on the clipboard; without one the preview is selected', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const copied = [];
  ctx.navigator = { clipboard: { writeText: async (c) => { copied.push(c); } } };
  const pre = new Node('pre');
  await run('copyCmd')(pre, 'tb doctor');
  assert.deepEqual(copied, ['tb doctor']);
  const picked = [];
  ctx.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  ctx.document.createRange = () => ({ selectNodeContents: (n) => picked.push(n) });
  ctx.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  await run('copyCmd')(pre, 'tb doctor');
  assert.deepEqual(picked, [pre], 'fallback: the preview text is selected');
});

// full-access-runs Phase 9 + 8 (taint): the held run box builds its resume line only from shq() (the worktree) and a
// session id that passes UUID_RE; while held no Resume / Restart, one Hand Back; a backlog flow's Sandbox turns off from
// the page too (board-terminal-parity 6.3: it posts {on: false}); the tag-add form's skills-off field
test('Phase 9 held run box: "cd <shq(worktree)> && claude --resume <uuid>" arrives as plain words in a real shell, Hand Back, no Resume / Restart; no uuid → no line; sandbox off from the page (board-terminal-parity 6.3); tag add --skills-off', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} };');
  const uuid = '11111111-2222-4333-8444-555555555555', wt = "/tmp/w'; touch PWNED; echo '";
  const box = (lease) => run(`el('div', null, ...runBox("t_hold01", ${JSON.stringify({ state: 'working', worktree: wt, lease: { phase: 'working', log: 'runs/1.jsonl', ...lease } })}))`);
  const held = box({ exit: 'held', session: uuid });
  const line = txt(byRole(held, 'resume-cmd'));
  const words = execFileSync('/bin/sh', ['-c', line.replace(/^cd /, "printf '%s\\n' ").replace(' && claude --resume ', ' ')], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(words, [wt, uuid], `one word each, nothing ran: ${line}`);
  assert.deepEqual(['handback', 'copy-resume', 'resume', 'restart', 'hold'].map((r) => !!byRole(held, r)), [true, true, false, false, false]);
  assert.equal(byRole(box({ exit: 'held', session: 'x; rm -rf ~' }), 'resume-cmd'), undefined, 'a session that is no uuid: no line');
  assert.equal(byRole(box({ exit: 'held', session: uuid, pending: { why: 'hold' } }), 'resume-cmd'), undefined, 'the run still dies: no line yet');
  assert.match(txt(box({ exit: 'held', session: uuid, pending: { why: 'handback' } })), /Handing back: the board resumes the same session/, 'a pending hand back says so');
  const cancelled = run(`el('div', null, ...runBox("t_hold01", ${JSON.stringify({ state: 'cancelled', worktree: wt, lease: { phase: 'working', log: 'runs/1.jsonl', exit: 'held', session: uuid } })}))`);
  assert.deepEqual(['held', 'handback'].map((r) => !!byRole(cancelled, r)), [false, false], 'a cancelled flow keeps no Hand Back');
  const squashed = run(`el('div', null, ...runBox("t_hold01", ${JSON.stringify({ state: 'final_gate', waiting: { reason: 'close' }, worktree: wt, lease: { phase: 'final_gate', log: 'runs/1.jsonl', exit: 'result', session: uuid } })}))`);
  assert.equal(byRole(squashed, 'hold'), undefined, 'squashed, waiting close: no Pause and Copy');
  const live = box({ session: uuid, lstart: 'x', pid: 42 });
  assert.deepEqual(['hold', 'resume', 'restart', 'note-text'].map((r) => !!byRole(live, r)), [true, true, true, true], 'a live run: Pause and Copy, the note box');
  noMarkup(walk(held));

  // board-terminal-parity 6.3: the page turns it off too (POST …/sandbox {on: false}, backlog only): no copy command
  const on = run('el("div", null, sandboxPart("t_sbx001", { sandbox: true }))');
  assert.equal(byRole(on, 'sandbox-cmd'), undefined);
  assert.equal(byRole(on, 'sandbox').attrs.disabled, undefined, 'the page can turn it off');
  const sb = trust(ctx);
  byRole(on, 'sandbox').handlers.change[0]({ target: { checked: false } });
  await tick();
  assert.deepEqual(sb.calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]), [['/api/tickets/t_sbx001/sandbox', { on: false }]]);
  const off = run('el("div", null, sandboxPart("t_sbx001", {}))');
  assert.deepEqual([byRole(off, 'sandbox-cmd'), byRole(off, 'sandbox').attrs.disabled], [undefined, undefined]);
  // the tag-add form's --skills-off field (cli.js CHECK['skills-off']: plain names, comma-separated)
  const cmd = (v) => JSON.parse(run(`JSON.stringify(buildCmd("tag-add", ${JSON.stringify(v)}))`));
  assert.deepEqual(cmd({ name: 'acme/api', 'skills-off': 'caveman,ponytail' }), { cmd: "tb tag add 'acme/api' --skills-off 'caveman,ponytail'", errors: {} });
  assert.ok(cmd({ name: 'acme/api', 'skills-off': 'a b;rm' }).errors['skills-off']);
});

// Continue in Terminal: one button (role hold) for a running agent-phase flow (Overview part), a Task's Your Turn card and
// a Blocked flow's Run section; none for a done / cancelled flow, nor a Blocked start that never spawned fresh. One click
// = hold; once held with no recovery pending and Page Tools on, the page posts "terminal" once by itself.
test('Continue in Terminal: the button shows for running, Your Turn and Blocked flows, not done / cancelled; a click holds, then Terminal opens once by itself', async () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  run('state = { reminders: [], flows: [], system: {}, calendar: {} };');
  const uuid = '11111111-2222-4333-8444-555555555555', wt = '/tmp/w';
  const tk = (over) => JSON.stringify({ state: 'working', worktree: wt, lease: { phase: 'working', session: uuid, pid: 42, log: 'runs/1.jsonl' }, ...over });
  const holdIn = (code) => byRole(run(code), 'hold');
  const running = holdIn(`el('div', null, contSec("t_c1", ${tk()}, false))`);
  assert.equal(txt(running), 'Continue in Terminal');
  const you = JSON.parse(tk({ kind: 'task', waiting: { reason: 'you' }, task_result: {}, lease: { phase: 'working', session: uuid, pid: 42, exit: 'result', log: 'runs/1.jsonl' } }));
  assert.equal(txt(byRole(run(`youCard("t_c1", ${JSON.stringify(you)})`), 'hold')), 'Continue in Terminal', 'Your Turn card');
  assert.equal(run(`contSec("t_c1", ${JSON.stringify(you)}, true)`), null, 'the card holds the button: no second one in the Overview');
  const blockedK = { state: 'blocked', blocked_from: 'working', round: 2, worktree: wt, lease: { phase: 'working', round: 1, session: uuid, pid: 42, exit: 'crash', log: 'runs/1.jsonl' } }; // fsm.move bumps the round into Blocked: the run's + 1
  assert.equal(txt(byRole(run(`el('div', null, ...runBox("t_c1", ${JSON.stringify(blockedK)}))`), 'hold')), 'Continue in Terminal', 'Blocked');
  const never = { ...blockedK, lease: { ...blockedK.lease, pid: null } };
  assert.equal(byRole(run(`el('div', null, ...runBox("t_c1", ${JSON.stringify(never)}))`), 'hold'), undefined, 'Blocked, never spawned, fresh: no session to continue');
  assert.ok(byRole(run(`el('div', null, ...runBox("t_c1", ${JSON.stringify({ ...never, lease: { ...never.lease, resumed: true } })}))`), 'hold'), 'Blocked, never spawned but a resume: its session exists');
  // the server's refusals, mirrored: Blocked in review | qa, an equal round (a run of another visit), a lane, a run never started in a plain state
  const noHold = (k, why) => assert.equal(byRole(run(`el('div', null, ...runBox("t_c1", ${JSON.stringify(k)}))`), 'hold'), undefined, why);
  noHold({ ...blockedK, blocked_from: 'review', lease: { ...blockedK.lease, phase: 'review' } }, 'Blocked in review');
  noHold({ ...blockedK, round: 1 }, 'Blocked with the run\'s own round');
  noHold({ ...JSON.parse(tk()), lane_of: { id: 't_par001', task: 'T2' } }, 'a lane');
  noHold({ ...JSON.parse(tk()), lease: { phase: 'working', session: uuid, log: 'runs/1.jsonl', exit: 'crash' } }, 'never started, no resume, even in a plain state');
  noHold({ ...JSON.parse(tk()), work: { task: 'T2' } }, 'the run is of another task than the flow\'s');
  for (const state of ['done', 'cancelled']) {
    assert.equal(run(`contSec("t_c1", ${tk({ state })}, false)`), null, `${state}: no Overview part`);
    assert.equal(holdIn(`el('div', null, ...runBox("t_c1", ${tk({ state })}))`), undefined, `${state}: no button in the Run section`);
  }

  // one click = hold (the flow is remembered); held + Page Tools: terminal posted once, never on a later render
  const n = trust(ctx);
  running.handlers.click[0]();
  await tick();
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').map((c) => c.url), ['/api/tickets/t_c1/hold']);
  run('ui.cfg = { config: { terminal: { page_tools: true } } }; ui.cont.add("t_c1");');
  const heldK = tk({ lease: { phase: 'working', session: uuid, pid: 42, exit: 'held', log: 'runs/1.jsonl' } });
  run(`heldBox("t_c1", ${heldK})`);
  await tick();
  run(`heldBox("t_c1", ${heldK})`);
  await tick();
  assert.deepEqual(n.calls.filter((c) => c.method === 'POST').map((c) => c.url), ['/api/tickets/t_c1/hold', '/api/tickets/t_c1/terminal']);
  run('ui.cfg = { config: { terminal: { page_tools: false } } }; ui.cont.add("t_c2");');
  run(`heldBox("t_c2", ${heldK})`);
  await tick();
  assert.equal(n.calls.filter((c) => c.url.endsWith('/t_c2/terminal')).length, 0, 'Page Tools off: only the resume line shows');
  assert.equal(run('ui.cont.has("t_c2")'), false, 'the click is used up on the first held render, Page Tools or not: a later hold never opens Terminal by itself');
});

test('XSS: Phase 3 parallel badges, reasons and buttons render as text; Allow Back / Run Next show for the right badge; Subagents warns at 3 and 4 only', () => {
  const ctx = sandbox();
  const run = (code) => vm.runInContext(code, ctx);
  const drawer = new Node('dialog');
  /** @type {any} */ (ctx.document).querySelector = (s) => (s === '#drawer' ? drawer : new Node('stub'));
  const role = (n, r) => (n?.attrs?.['data-role'] === r ? n : (n?.kids ?? []).map((x) => role(x, r)).find(Boolean));
  const f = { id: 't_xss002', title: 't', kind: 'code', tag: 'acme/api', state: 'working' };
  const task = (id, over = {}) => ({ id, status: 'pending', attempt: 0, blocked_by: [], ...over });
  const k = (sub) => ({ ...f, ...(sub && { subagents: { concurrent: sub } }), work: { task: 'T1', serial: ['T3', 'T4'], tasks: [task('T1'), task('T2'), task('T3'), task('T4'), task('T5'), task('T6')] },
    parallel: { top: `on, up to 1 extra at once ${P}`, tasks: { T2: { badge: 'can', next: false }, T3: { badge: 'one', why: `it came back ${P}`, serial: true, security: false },
      T4: { badge: 'one', why: 'security', serial: true, security: true }, T5: { badge: 'can', next: true }, T6: { badge: 'one', why: 'it shares a file' } } } });
  run(`state = { reminders: [], flows: [${JSON.stringify(f)}], system: {}, calendar: {} }; ui.open = "t_xss002"; ui.cfg = { config: { subagents: { concurrent: 2 } } };
    ui.plan = { tasks: [{ id: "T1", title: "one" }, { id: "T2", title: ${JSON.stringify(`two ${P}`)} }, { id: "T3", title: "three" }, { id: "T4", title: "four" }, { id: "T5", title: "five" }, { id: "T6", title: "six" }] };`);
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k(0))})`);
  const w = walk(drawer);
  assert.ok(w.tags.every((t) => !['img', 'script', 'iframe', 'object'].includes(t)), `no element from a payload: ${w.tags}`);
  assert.deepEqual(w.attrs.filter((a) => /^(on\w+|src|srcdoc|formaction|href)=/i.test(a)), [], 'no payload in a handler, src or link attribute');
  for (const s of [`on, up to 1 extra at once ${P}`, `One at a time: it came back ${P}`, 'Can run in parallel']) assert.ok(w.text.includes(s), `as text: ${s}`);
  const li = (x) => (function find(n) { return n?.attrs?.['data-task'] === x ? n : (n?.kids ?? []).map(find).find(Boolean); })(drawer);
  const rolesIn = (n) => (n?.attrs?.['data-role'] ? [n.attrs['data-role']] : []).concat((n?.kids ?? []).flatMap(rolesIn));
  assert.deepEqual(['T2', 'T3', 'T4', 'T5', 'T6'].map((x) => rolesIn(li(x))), [['lane-next:T2'], ['lane-allow:T3'], [], [], []],
    'Run Next only on a can row not yet picked; Allow only on a plain serial row (not security, not a gate-only reason)');
  assert.ok(!role(drawer, 'subagents-warn'), 'default 2 does not warn');
  for (const n of [3, 4]) {
    run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k(n))})`);
    assert.ok(role(drawer, 'subagents-warn'), `${n} warns`);
    assert.equal(role(drawer, 'subagents').value, String(n), `${n} is the selected option`);
  }
  run(`ui.cfg = { config: { subagents: { concurrent: 3 } } }; drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k(0))})`);
  assert.deepEqual([role(drawer, 'subagents').value, !!role(drawer, 'subagents-warn')], ['', true], 'no own pick: the default 3 warns too');
  run('ui.cfg = { config: { subagents: { concurrent: 2 } } }');
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify(k(2))})`);
  assert.equal(role(drawer, 'subagents-warn'), undefined, '2 does not warn');
});
