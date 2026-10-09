'use strict';
// schema: a zero-dep subset of JSON Schema for the phases' result.schema.json (contract U3, P3 carry T8). Agent output
// is untrusted (D31): runner.handle() checks structured_output here before any phase handler sees it. Only the
// keywords our schemas use; compile() throws on any other keyword (fail closed: a schema this code can't fully check is
// never half-checked) and on a malformed value of a known one.
const { isObj } = require('./util');

const TYPES = {
  object: isObj, array: Array.isArray, string: (v) => typeof v === 'string', integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v), boolean: (v) => typeof v === 'boolean', null: (v) => v === null,
};
const MAX_ERRORS = 10;
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
// keyword → is its value well formed (sub-schemas are checked by walk)
const KEYWORDS = {
  type: (v) => [].concat(v).length > 0 && [].concat(v).every((x) => Object.hasOwn(TYPES, x)),
  properties: isObj,
  required: strs,
  additionalProperties: (v) => typeof v === 'boolean',
  items: isObj,
  enum: (v) => Array.isArray(v) && v.length > 0,
  minItems: (v) => Number.isInteger(v) && v >= 0,
  maxItems: (v) => Number.isInteger(v) && v >= 0,
  minLength: (v) => Number.isInteger(v) && v >= 0,
};

function walk(s, at) {
  if (!isObj(s)) throw new Error(`schema ${at || '/'}: must be an object`);
  for (const [k, v] of Object.entries(s)) {
    if (!Object.hasOwn(KEYWORDS, k)) throw new Error(`schema ${at || '/'}: unsupported keyword "${k}"`);
    if (!KEYWORDS[k](v)) throw new Error(`schema ${at || '/'}: bad value for "${k}"`);
  }
  for (const [k, sub] of Object.entries(s.properties ?? {})) walk(sub, `${at}/properties/${k}`);
  if (s.items) walk(s.items, `${at}/items`);
}

// Errors of v against s as "<json pointer>: <why>", at most MAX_ERRORS.
function check(s, v, at, out) {
  if (out.length >= MAX_ERRORS) return;
  const types = s.type === undefined ? null : [].concat(s.type);
  if (types && !types.some((t) => TYPES[t](v))) return void out.push(`${at || '/'}: must be ${types.join(' or ')}`);
  if (s.enum && !s.enum.some((x) => x === v)) return void out.push(`${at || '/'}: must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at || '/'}: must have at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at || '/'}: must have at most ${s.maxItems} item${s.maxItems === 1 ? '' : 's'}`);
    if (s.items) v.forEach((x, i) => check(s.items, x, `${at}/${i}`, out));
  }
  if (typeof v === 'string' && s.minLength !== undefined && [...v].length < s.minLength) out.push(`${at || '/'}: must have at least ${s.minLength} character${s.minLength === 1 ? '' : 's'}`);
  if (isObj(v)) {
    for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) out.push(`${at || '/'}: missing "${k}"`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : null;
      if (sub) check(sub, x, `${at}/${k}`, out);
      else if (s.additionalProperties === false) out.push(`${at || '/'}: unknown field "${k.slice(0, 64)}"`);
    }
  }
}

/** @param {any} schema @returns {(value: any) => string[]} errors, [] when valid. Throws on an unsupported schema. */
function compile(schema) {
  walk(schema, '');
  return (value) => {
    const out = [];
    check(schema, value, '', out);
    return out.slice(0, MAX_ERRORS);
  };
}

module.exports = { compile };
