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
    this.style = {};
    this.classList = { add() {}, remove() {}, contains: () => false };
  }
  append(...k) { this.kids.push(...k); }
  replaceChildren(...k) { this.kids = k; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
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
function sandbox() {
  const document = {
    createElement: (t) => new Node(t), querySelector: () => new Node('stub'), querySelectorAll: () => [], body: new Node('body'),
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
// every string in the tree, and where it sits: text (a child) or attr
function walk(n, out = { text: [], attrs: [], tags: [] }) {
  if (typeof n === 'string' || typeof n === 'number') { out.text.push(String(n)); return out; }
  if (!(n instanceof Object) || !Array.isArray(n.kids)) return out;
  out.tags.push(n.tag);
  for (const [k, v] of Object.entries(n.attrs)) out.attrs.push(`${k}=${v}`);
  for (const k of n.kids) walk(k, out);
  return out;
}

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
  assert.ok(walk(run(`flowCard(${JSON.stringify(f)})`)).text.includes('waiting: qa:self/tb'));
  run(`drawerBody(${JSON.stringify(f)}, ${JSON.stringify({ ...f, qa: { n: 1, head: 'a' } })})`);
  const t = walk(drawer).text;
  assert.equal(t[t.indexOf('Waiting') + 1], 'qa:self/tb');
});
