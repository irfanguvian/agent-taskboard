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
