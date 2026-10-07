'use strict';
// tags: validation of tags.json entries (spec §3, App A; + leak_check D20). Pure: store owns the file.
const path = require('node:path');
const { TbError } = require('./errors');

const NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const CHECKS = ['lint', 'typecheck', 'unit', 'e2e', 'build', 'prisma_diff', 'openapi'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v !== '';
const strs = (v) => Array.isArray(v) && v.every(str);
const KEYS = {
  path: (v) => str(v) && path.isAbsolute(v) && path.resolve(v) === v, // normalized: no .., ., // or trailing /
  type: (v) => v === 'git' || v === 'folder',
  base: str,
  setup: str,
  output: str,
  env_files: strs,
  heavy: strs,
  context: strs,
  skills: strs,
  checks: (v) => isObj(v) && Object.entries(v).every(([k, x]) => CHECKS.includes(k) && (k === 'prisma_diff' ? typeof x === 'boolean' : str(x))),
  leak_check: (v) => typeof v === 'boolean',
};

const bad = (msg) => new TbError(400, msg);

function validName(name) {
  if (typeof name !== 'string' || name.length > 100 || !NAME_RE.test(name)) {
    throw bad('tag name must look like a or a/b (lowercase letters, digits, -)');
  }
}

// A group tag ({}) only names a level; a tag with a folder needs both path and type.
function validate(name, def) {
  validName(name);
  if (!isObj(def)) throw bad('tag def must be a JSON object');
  for (const [k, v] of Object.entries(def)) {
    if (!Object.hasOwn(KEYS, k)) throw bad(`unknown tag key "${k}"`); // own keys only: "constructor" etc. are not keys
    if (!KEYS[k](v)) throw bad(k === 'path' ? 'tag path must be an absolute, normalized path' : `bad value for tag key "${k}"`);
  }
  if ((def.path === undefined) !== (def.type === undefined)) throw bad('tag path and type go together');
  if (def.type === 'git' && def.base === undefined) throw bad('git tags need base');
}

// Flows need a leaf tag with a path (spec §3). Reminders may use any level.
function assertFlowTag(map, name) {
  validName(name);
  if (!map[name] || !map[name].path) throw bad(`tag ${name} has no path; flows need a leaf tag with a path`);
  if (Object.keys(map).some((n) => n.startsWith(name + '/'))) throw bad(`tag ${name} is not a leaf; pick one of its children`);
}

module.exports = { NAME_RE, validName, validate, assertFlowTag };
