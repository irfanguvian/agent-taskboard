'use strict';
// UP1 / UP2 (M7 fix 8): the web UI and the tb CLI reach the same routes. Routes, query keys and literal body keys are read from the
// source of lib/cli.js and ui/app.js; every CLI route must be in the UI or on the CLI-only list, every UI route in the CLI or on the
// UI-only list, and for a shared route every CLI query / body key must be one the UI sends or one on the exempt list (m7-build.md
// "D-0149 + D-0156 parity"). Body keys are compared only when both sides pass an object literal to api(): a body built elsewhere
// (the PATCH of a reminder) has no keys to read here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// the literal that starts at src[i] (' " or `), with `${…}` groups (and templates inside them) skipped whole → {raw, end}
function literalAt(src, i) {
  const q = src[i];
  let j = i + 1;
  for (; j < src.length && src[j] !== q; j++) {
    if (src[j] === '\\') j++;
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') j = groupEnd(src, j + 1);
  }
  return { raw: src.slice(i + 1, j), end: j };
}
// src[i] is '{': the index of its matching '}' (strings and templates inside are read whole)
function groupEnd(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') j = literalAt(src, j).end;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return src.length;
}
// "/api/tickets/${t.id}/log?${q}" → { route: '/api/tickets/:id/log', query: ['tail', …] }: a group after '/' is an id, any other group is dropped
function shape(raw) {
  let out = '', keys = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const e = groupEnd(raw, i + 1);
      if (raw[i - 1] === '/') out += ':id';
      keys.push(...[...raw.slice(i, e).matchAll(/[?&]([a-z_]+)=/g)].map((m) => m[1]));
      i = e;
    } else out += raw[i];
  }
  keys.push(...[...out.matchAll(/[?&]([a-z_]+)=/g)].map((m) => m[1]));
  return { route: out.split('?')[0], query: keys };
}
// the identifiers before a colon in an object literal
const keysOf = (lit) => [...lit.matchAll(/(?:^|[{,\s])([A-Za-z_]+)\s*:(?!:)/g)].map((m) => m[1]);

// → Map 'METHOD /route' → { query: Set, body: Set|null }
function routesOf(src) {
  const map = new Map();
  // every literal that opens with /api/ or /events (found by that start, so an apostrophe in a comment cannot derail the scan)
  for (const m of src.matchAll(/['"`](?=\/(?:api\/|events))/g)) {
    const { raw, end } = literalAt(src, m.index), i = end;
    const before = src.slice(Math.max(0, i - raw.length - 80), i - raw.length - 1);
    const method = /\b(?:api|request)\(\s*'([A-Z]+)'\s*,\s*$/.exec(before)?.[1] || 'GET';
    const { route, query } = shape(raw);
    const e = map.get(`${method} ${route}`) ?? { query: new Set(), body: null };
    query.forEach((k) => e.query.add(k));
    const after = /^\s*,\s*(\{)/.exec(src.slice(end + 1, end + 6));
    if (after) {
      const at = end + 1 + after[0].length - 1;
      e.body ??= new Set();
      keysOf(src.slice(at, groupEnd(src, at) + 1)).forEach((k) => e.body.add(k));
    }
    // a query built apart: new URLSearchParams(Object.entries({ n: f.n, … })) just above the call, or tb logs' read('tail=200')
    if (/\?\$\{\w+\}/.test(raw)) {
      const p = /URLSearchParams\(Object\.entries\((\{[^}]*\})/.exec(src.slice(Math.max(0, i - 400), i));
      if (p) keysOf(p[1]).forEach((k) => e.query.add(k));
      if (route.endsWith('/log')) for (const m of src.matchAll(/\bread\((['`])([^'`]*)\1/g)) [...m[2].matchAll(/(?:^|&)([a-z_]+)=/g)].forEach((k) => e.query.add(k[1]));
    }
    map.set(`${method} ${route}`, e);
  }
  // the ticket verbs are posted through one dynamic path (`/api/tickets/${id}/${verb}`): read the verbs where they are named
  map.delete('POST /api/tickets/:id/:id');
  const verbs = [...src.matchAll(/\bpost\(\s*[\w.]+\s*,\s*'([a-z-]+)'/g), ...src.matchAll(/\bcontrol\('([a-z]+)'/g), ...src.matchAll(/\[\s*'(allow-change|deny-change|answer)'\s*,\s*\{/g),
    ...(/const OPS = \{([^}]*)\}/.exec(src)?.[1].matchAll(/(\w+):/g) ?? [])].map((m) => m[1]);
  for (const v of verbs) if (!map.has(`POST /api/tickets/:id/${v}`)) map.set(`POST /api/tickets/:id/${v}`, { query: new Set(), body: null });
  return map;
}

// the routes only one side has, each with its reason (m7-build.md "CLI-only" and "UI-only" lists)
const CLI_ONLY = new Set([
  'POST /api/tags', 'POST /api/doctor', 'GET /api/gc', 'POST /api/gc', 'POST /api/drills', 'POST /api/evals', // agent wall (D39, D-0149, D-0172): copy-command forms in the UI
  'POST /api/session/code', 'POST /api/notify-test', 'GET /api/whoami', // tb open, tb notify-test, the CLI's identity check
]);
const UI_ONLY = new Set([
  'GET /api/ui-whoami', 'GET /api/session/csrf', 'GET /events', 'GET /api/tickets/:id/docs', 'GET /api/tickets/:id/gates/:id/log', // identity, CSRF, stream, doc and gate-log links
  'GET /api/tickets/:id/feedback/:id', 'GET /api/tickets/:id/pass', // feedback file and pass preview
]);
const EXEMPT_KEYS = new Set(['pos', 'note', 'tag']); // reminder add: the UI drags for pos, edits for note and tag (m7-build.md)

// the gaps, as a sorted list of strings
function gaps(cli, ui, { cliOnly = CLI_ONLY, uiOnly = UI_ONLY, exempt = EXEMPT_KEYS } = {}) {
  const out = [];
  for (const k of cli.keys()) if (!ui.has(k) && !cliOnly.has(k)) out.push(`cli route ${k} has no UI`);
  for (const k of ui.keys()) if (!cli.has(k) && !uiOnly.has(k)) out.push(`ui route ${k} has no CLI`);
  for (const [k, c] of cli) {
    const u = ui.get(k);
    if (!u) continue;
    for (const q of c.query) if (!u.query.has(q) && !exempt.has(q)) out.push(`${k}: query ${q} missing in the UI`);
    if (c.body && u.body) for (const b of c.body) if (!u.body.has(b) && !exempt.has(b)) out.push(`${k}: body key ${b} missing in the UI`);
  }
  return out.sort();
}

test('UP1: every CLI route is in the UI or CLI-only, every UI route in the CLI or UI-only, shared routes share their query and body keys', () => {
  const cli = routesOf(read('lib/cli.js')), ui = routesOf(read('ui/app.js'));
  assert.ok(cli.size > 25 && ui.size > 25, `routes found: cli ${cli.size}, ui ${ui.size}`);
  assert.ok(cli.get('POST /api/flows').body.has('fix_of') && ui.get('POST /api/flows').body.has('fix_of'), 'the extractor reads body keys on both sides');
  assert.ok(ui.get('GET /api/tickets/:id/report').query.has('n') && ui.get('GET /api/tickets/:id/log').query.has('after'), 'and query keys');
  assert.deepEqual(gaps(cli, ui), []);
});

test('UP1: the page never calls a CLI-only route (agent wall: copy-command forms instead)', () => {
  const ui = routesOf(read('ui/app.js'));
  for (const k of CLI_ONLY) assert.ok(!ui.has(k), `the UI calls ${k}`);
  assert.ok(!read('ui/app.js').match(/['"`]\/api\/(gc|doctor|evals)\b/), 'no literal path of a CLI-only route in app.js');
});

test('UP2: gaps() on a synthetic list names exactly the planted route and the planted key', () => {
  const cli = new Map([
    ['GET /api/a', { query: new Set(['limit', 'planted_q']), body: null }],
    ['POST /api/b', { query: new Set(), body: new Set(['title', 'planted_b']) }],
    ['GET /api/c', { query: new Set(), body: null }], // the planted route: CLI only, not on the list
    ['GET /api/d', { query: new Set(), body: null }], // on the CLI-only list
  ]);
  const ui = new Map([
    ['GET /api/a', { query: new Set(['limit']), body: null }],
    ['POST /api/b', { query: new Set(), body: new Set(['title']) }],
    ['GET /events', { query: new Set(), body: null }], // on the UI-only list
  ]);
  assert.deepEqual(gaps(cli, ui, { cliOnly: new Set(['GET /api/d']), uiOnly: new Set(['GET /events']), exempt: new Set() }),
    ['GET /api/a: query planted_q missing in the UI', 'POST /api/b: body key planted_b missing in the UI', 'cli route GET /api/c has no UI']);
  assert.deepEqual(gaps(new Map([['GET /api/x', { query: new Set(['pos']), body: null }]]), new Map([['GET /api/x', { query: new Set(), body: null }]]), { exempt: new Set(['pos']) }), [], 'an exempt key is no gap');
  assert.deepEqual(gaps(new Map(), new Map([['GET /api/u', { query: new Set(), body: null }]]), { uiOnly: new Set() }), ['ui route GET /api/u has no CLI'], 'and a UI route the CLI lacks');
});
