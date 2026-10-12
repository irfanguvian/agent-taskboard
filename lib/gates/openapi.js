'use strict';
// gates/openapi: the API half of the working gate's policy check (contract K9+M7). diff(base, head) is pure: two parsed
// OpenAPI 3.0/3.1 documents → ApiChange[] (K10 refs, allowed:false; plan-rules.markAllowed sets it). It throws on a
// document it can't read (not OpenAPI 3, a $ref it can't follow, nesting over DEPTH): fail closed, the gate is red.
// tbd never parses a spec itself (an agent writes it; V8 rarely gives a big JSON.parse heap back): it runs this file
// as a child, `node --max-old-space-size=128 lib/gates/openapi.js <base.json> <head.json> [<head root>]`, 30 s, and
// reads one JSON line {"changes": [...]} on stdout. Exit: 0 ok; 2 usage; 3 a file missing; 4 a file over 5 MB (infra);
// 5 refused: a link, not a regular file, or head outside <head root> (realpath); 6 not JSON / not an OpenAPI 3 document.
// Normalized: $ref followed (local only, cycle guard; a $ref to another component is compared by shape, as oasdiff
// does: a DTO renamed to a superset is no change), `{param}` → `{}` in paths (a path param rename is no change),
// path params keyed by position, header names lower case, 3.0 `nullable: true` ≡ 3.1 `type: [T, "null"]`, allOf merged.
// Components compare once each, by where an operation reaches them (base or HEAD): response, request (params + body)
// or both (the union of both rule lists). Breaking:
//   response: property removed (remove S.f), required → optional (optional S.f), null added (type S.f), type change
//     (type S.f), enum value added (enum S.f);
//   request: optional → required (required S.f), new required property or param (add-required S.f), type change,
//     enum value removed (enum S.f);
//   operation: path or method gone (remove METHOD /path), a 2xx status gone (remove METHOD /path#<status>);
//   a component gone that responses reached (remove S).
// Inline schemas are named `METHOD /path#req` (request body), `METHOD /path#<status>`, params `METHOD /path#<in>.<name>`.
const fs = require('node:fs');
const path = require('node:path');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const DEPTH = 256; // nesting levels read; deeper → refused
const VISITS = 200_000; // schema pairs compared per diff; more → refused
const CHANGES_MAX = 1000; // changes listed; more → refused (bounds the child's heap, its stdout and tbd's parse)
const HOPS = 20; // $ref → $ref chain
const FILE_MAX = 5 * 1024 * 1024;
const SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const normPath = (p) => p.replace(/\{[^}]*\}/g, '{}');

// `#/a/b~1c` in doc (RFC 6901), or throw: only local refs
function pointer(doc, ref) {
  if (!ref.startsWith('#/')) throw new Error(`$ref ${JSON.stringify(ref.slice(0, 100))}: only local refs (#/...) are read`);
  let n = doc;
  for (const raw of ref.slice(2).split('/')) {
    const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if ((!isObj(n) && !Array.isArray(n)) || !Object.hasOwn(n, k)) throw new Error(`$ref ${JSON.stringify(ref.slice(0, 100))}: not found`);
    n = n[k];
  }
  return n;
}
// a node's $ref chain followed to its target (params, bodies, responses, inline schema refs)
function deref(doc, node) {
  for (let i = 0; isObj(node) && typeof node.$ref === 'string'; i++) {
    if (i >= HOPS) throw new Error(`$ref ${JSON.stringify(node.$ref.slice(0, 100))}: a cycle or a chain over ${HOPS} hops`);
    node = pointer(doc, node.$ref);
  }
  return node;
}
const refName = (node) => (isObj(node) && typeof node.$ref === 'string' ? SCHEMA_REF.exec(node.$ref)?.[1] ?? null : null);
// the schema of a body or response: application/json, else its first media type
function media(doc, x) {
  const c = deref(doc, x)?.content;
  const m = isObj(c) ? c['application/json'] ?? Object.values(c)[0] : undefined;
  return isObj(m) ? m.schema : undefined;
}

// METHOD /path → {op, params: Map<key, {required, schema}>}
function ops(doc) {
  const out = new Map();
  const paths = doc.paths ?? {};
  if (!isObj(paths)) throw new Error('paths is not an object');
  for (const [raw, item0] of Object.entries(paths)) {
    const item = deref(doc, item0);
    if (!isObj(item)) throw new Error(`paths ${JSON.stringify(raw.slice(0, 100))} is not an object`);
    const names = [...raw.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
    for (const m of METHODS.filter((x) => isObj(item[x]))) {
      const key = `${m.toUpperCase()} ${normPath(raw)}`;
      if (out.has(key)) throw new Error(`${key}: two paths differ only in parameter names`);
      const params = new Map();
      for (const p0 of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(item[m].parameters) ? item[m].parameters : [])]) {
        const p = deref(doc, p0);
        if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') throw new Error(`${key}: a parameter without name and in`);
        const i = names.indexOf(p.name);
        const k = p.in === 'path' ? `path.${i < 0 ? p.name : i}` : `${p.in}.${p.in === 'header' ? p.name.toLowerCase() : p.name}`;
        params.set(k, { required: p.in === 'path' || p.required === true, schema: p.schema ?? media(doc, p) }); // op-level wins
      }
      out.set(key, { op: item[m], params });
    }
  }
  return out;
}

// component names a node reaches through $ref (into the components, each once), added to acc; refs: every other $ref
// already walked (once each: n refs fanning out to the same target stay n walks, not 2^n)
function reach(doc, node, acc, refs, depth = 0) {
  if (depth > DEPTH) throw new Error(`a schema nests deeper than ${DEPTH}`);
  if (Array.isArray(node)) return node.forEach((x) => reach(doc, x, acc, refs, depth + 1));
  if (!isObj(node)) return;
  const name = refName(node);
  if (name !== null) {
    if (acc.has(name)) return;
    acc.add(name);
    return reach(doc, deref(doc, node), acc, refs, 0); // a component's own nesting counts, not the DFS chain to it (acc: once each)
  }
  if (typeof node.$ref === 'string') {
    if (refs.has(node.$ref)) return;
    refs.add(node.$ref);
    return reach(doc, deref(doc, node), acc, refs, 0);
  }
  for (const [k, v] of Object.entries(node)) if (k !== 'example' && k !== 'examples' && k !== 'default') reach(doc, v, acc, refs, depth + 1);
}

const types = (s) => {
  const t = Array.isArray(s.type) ? s.type : s.type !== undefined ? [s.type] : s.properties ? ['object'] : s.items ? ['array'] : [];
  return [...new Set(t.filter((x) => x !== 'null'))].sort().join();
};
const nullable = (s) => s.nullable === true || (Array.isArray(s.type) && s.type.includes('null'));
// allOf members merged into one schema (properties, required, first type, nullable)
function flat(doc, s, depth = 0) {
  if (!Array.isArray(s.allOf)) return s;
  if (depth > 16) throw new Error('allOf nests deeper than 16');
  const { allOf, ...out } = s;
  for (const m0 of allOf) {
    const m = deref(doc, m0);
    if (!isObj(m)) continue;
    const f = flat(doc, m, depth + 1);
    out.properties = { ...f.properties, ...out.properties };
    out.required = [...(out.required ?? []), ...(Array.isArray(f.required) ? f.required : [])];
    out.type ??= f.type;
    if (nullable(f)) out.nullable = true;
  }
  return out;
}

/**
 * One schema pair at `name`, breaking for `dirs` ('request' | 'response').
 * @param {{base: any, head: any, emit: (op: string, ref: string, dirs: string[]) => void, seen: Map<object, Set<object>>, n: {visits: number}}} c
 * @param {any} b @param {any} h @param {string} name @param {string[]} dirs
 */
function cmp(c, b, h, name, dirs, depth = 0) {
  if (depth > DEPTH) throw new Error(`${name}: nests deeper than ${DEPTH}`);
  if (b === undefined) return; // a schema where none was: nothing an old client relies on
  if (h === undefined) return c.emit('type', name, dirs);
  const rb = refName(b);
  const rh = refName(h);
  if (rb !== null && rb === rh) return; // same component: it compares once, as a component
  // another component (or inline ↔ $ref): compared by shape here, as oasdiff does: a DTO renamed to a superset is additive
  b = deref(c.base, b);
  h = deref(c.head, h);
  if (!isObj(b) || !isObj(h)) return JSON.stringify(b) !== JSON.stringify(h) ? c.emit('type', name, dirs) : undefined; // 3.1 true/false
  // cycle guard on the current path only: a pair reached by two paths (a renamed DTO used twice) is walked at each, so a
  // break at the 2nd path is still named; VISITS caps the fan-out (over → throw → red, fail closed)
  const on = c.seen.get(b) ?? new Set();
  if (on.has(h)) return;
  if (++c.n.visits > VISITS) throw new Error(`more than ${VISITS} schema pairs compared`);
  c.seen.set(b, on.add(h));
  try {
    shape(c, b, h, name, dirs, depth);
  } finally {
    on.delete(h);
  }
}

// cmp's pair, both dereferenced objects: the K9 rules
function shape(c, b, h, name, dirs, depth) {
  b = flat(c.base, b);
  h = flat(c.head, h);
  const R = dirs.filter((d) => d === 'response');
  const Q = dirs.filter((d) => d === 'request');
  if (types(b) !== types(h)) c.emit('type', name, dirs);
  if (!nullable(b) && nullable(h)) c.emit('type', name, R);
  if (b.enum !== undefined || h.enum !== undefined) {
    const be = Array.isArray(b.enum) ? b.enum.map((v) => JSON.stringify(v)) : null; // null: any value
    const he = Array.isArray(h.enum) ? h.enum.map((v) => JSON.stringify(v)) : null;
    if (be !== null && (he === null || he.some((v) => !be.includes(v)))) c.emit('enum', name, R);
    if (he !== null && (be === null || be.some((v) => !he.includes(v)))) c.emit('enum', name, Q);
  }
  const bp = isObj(b.properties) ? b.properties : {};
  const hp = isObj(h.properties) ? h.properties : {};
  const br = new Set(Array.isArray(b.required) ? b.required : []);
  const hr = new Set(Array.isArray(h.required) ? h.required : []);
  for (const [k, v] of Object.entries(bp)) {
    const ref = `${name}.${k}`;
    if (!Object.hasOwn(hp, k)) {
      c.emit('remove', ref, R);
      continue;
    }
    if (br.has(k) && !hr.has(k)) c.emit('optional', ref, R);
    if (!br.has(k) && hr.has(k)) c.emit('required', ref, Q);
    cmp(c, v, hp[k], ref, dirs, depth + 1);
  }
  for (const k of Object.keys(hp)) if (!Object.hasOwn(bp, k) && hr.has(k)) c.emit('add-required', `${name}.${k}`, Q);
  if (b.items !== undefined) cmp(c, b.items, h.items, `${name}[]`, dirs, depth + 1);
  for (const k of ['oneOf', 'anyOf']) if (JSON.stringify(b[k]) !== JSON.stringify(h[k])) c.emit('type', name, dirs);
}

/** @param {any} base @param {any} head @returns {import('./types').ApiChange[]} */
function diff(base, head) {
  for (const [side, d] of [['base', base], ['HEAD', head]]) {
    if (!isObj(d) || typeof d.openapi !== 'string' || !d.openapi.startsWith('3.')) throw new Error(`${side}: not an OpenAPI 3 document`);
  }
  /** @type {Map<string, import('./types').ApiChange>} */
  const out = new Map();
  const emit = (op, ref, dirs) => {
    if (!dirs.length) return;
    if (out.size >= CHANGES_MAX && !out.has(`${op} ${ref}`)) throw new Error(`more than ${CHANGES_MAX} API changes`);
    const prev = out.get(`${op} ${ref}`)?.dir;
    const all = new Set([...(prev === 'both' ? ['request', 'response'] : prev ? [prev] : []), ...dirs]);
    out.set(`${op} ${ref}`, { op, ref, dir: all.size > 1 ? 'both' : /** @type {any} */ ([...all][0]), allowed: false });
  };
  const n = { visits: 0 };
  const run = (b, h, name, dirs) => cmp({ base, head, emit, seen: new Map(), n }, b, h, name, dirs);
  const B = ops(base);
  const H = ops(head);
  const req = new Set();
  const resp = new Set();
  for (const [doc, list] of [[base, B], [head, H]]) { // one walk per document (a name seen at base is walked at HEAD too)
    const [q, r, qRefs, rRefs] = [new Set(), new Set(), new Set(), new Set()];
    for (const { op, params } of list.values()) {
      for (const p of params.values()) reach(doc, p.schema, q, qRefs);
      reach(doc, op.requestBody, q, qRefs);
      reach(doc, op.responses, r, rRefs);
    }
    q.forEach((n) => req.add(n));
    r.forEach((n) => resp.add(n));
  }
  const bc = isObj(base.components?.schemas) ? base.components.schemas : {};
  const hc = isObj(head.components?.schemas) ? head.components.schemas : {};
  for (const name of new Set([...req, ...resp])) {
    if (!Object.hasOwn(bc, name)) continue; // new at HEAD
    const dirs = [...(req.has(name) ? ['request'] : []), ...(resp.has(name) ? ['response'] : [])];
    if (!Object.hasOwn(hc, name)) emit('remove', name, dirs.filter((d) => d === 'response'));
    else run(bc[name], hc[name], name, dirs);
  }
  for (const [key, bo] of B) {
    const ho = H.get(key);
    if (!ho) {
      emit('remove', key, ['operation']);
      continue;
    }
    for (const [k, hp] of ho.params) {
      const bp = bo.params.get(k);
      if (!bp) {
        if (hp.required) emit('add-required', `${key}#${k}`, ['request']);
        continue;
      }
      if (!bp.required && hp.required) emit('required', `${key}#${k}`, ['request']);
      run(bp.schema, hp.schema, `${key}#${k}`, ['request']);
    }
    const bb = deref(base, bo.op.requestBody);
    const hb = deref(head, ho.op.requestBody);
    if (isObj(hb) && hb.required === true && !(isObj(bb) && bb.required === true)) emit(isObj(bb) ? 'required' : 'add-required', `${key}#req`, ['request']);
    if (isObj(bb) && isObj(hb)) run(media(base, bb), media(head, hb), `${key}#req`, ['request']);
    const brs = isObj(bo.op.responses) ? bo.op.responses : {};
    const hrs = isObj(ho.op.responses) ? ho.op.responses : {};
    for (const [s, r] of Object.entries(brs)) {
      if (!Object.hasOwn(hrs, s)) {
        if (s.startsWith('2')) emit('remove', `${key}#${s}`, ['operation']);
        continue;
      }
      run(media(base, r), media(head, hrs[s]), `${key}#${s}`, ['response']);
    }
  }
  return [...out.values()];
}

// ---- CLI (a child of tbd: own process, so sync fs is fine) ---------------------------------------------------------
const fail = (exit, msg) => Object.assign(new Error(msg), { exit });

// lstat (a link is refused, never followed), ≤ FILE_MAX, inside root (realpath) when given; O_NOFOLLOW + same inode
// (a file swapped between the checks and the open is refused). beforeOpen: tests swap the file there.
function readSpec(file, root, beforeOpen = () => {}) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    throw fail(e.code === 'ENOENT' ? 3 : 5, `${file}: ${e.code}`);
  }
  if (!st.isFile()) throw fail(5, `${file}: not a regular file (links are refused)`);
  if (st.size > FILE_MAX) throw fail(4, `${file}: ${st.size} bytes, at most ${FILE_MAX}`);
  if (root && !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw fail(5, `${file}: outside ${root}`);
  beforeOpen();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const now = fs.fstatSync(fd);
    if (now.ino !== st.ino || now.dev !== st.dev) throw fail(5, `${file}: changed while it was read`);
    const text = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > FILE_MAX) throw fail(4, `${file}: grew over ${FILE_MAX} bytes`);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw fail(6, `${file}: not JSON (${e.message})`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

if (require.main === module) {
  const [b, h, root] = process.argv.slice(2);
  try {
    if (!b || !h) throw fail(2, 'usage: openapi.js <base.json> <head.json> [<head root>]');
    const base = readSpec(b);
    const head = readSpec(h, root);
    let changes;
    try {
      changes = diff(base, head);
    } catch (e) {
      throw fail(6, `openapi: ${e.message}`);
    }
    process.stdout.write(`${JSON.stringify({ changes })}\n`);
  } catch (e) {
    process.stderr.write(`${String(e.message).slice(0, 1000)}\n`);
    process.exitCode = e.exit ?? 1;
  }
}

module.exports = { diff, readSpec };
