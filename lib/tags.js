'use strict';
// tags: validation of tags.json entries (spec §3, App A; + leak_check D20). Pure: store owns the file.
// P5 keys (gates/types.js TagP5, contract K6 K7 K8 K9 K11 R2 T1 K5): generated (only * and **, never a lockfile),
// rules (absolute files Irfan owns; checkRules: lstat regular, ≤ 8 KB in all), protected + test_globs (relative globs),
// test_scripts (a regex), deny_ports, openapi {cmd, file}, prisma {schema, migrations}, checks.generate. M5: qa_ports, db.
// gateTag(def): the read-time view with defaults; old shapes map there (checks.openapi:"cmd" → openapi,
// checks.prisma_diff:true → prisma defaults), tags.json is never rewritten.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { TbError } = require('./errors');

const NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const CHECKS = ['lint', 'typecheck', 'unit', 'e2e', 'build', 'generate', 'prisma_diff', 'openapi'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v !== '';
const strs = (v) => Array.isArray(v) && v.every(str);
// a repo path or glob: relative, no `..` segment, no control character (git and the gate profile take it as is)
const relPath = (v) => str(v) && v.length <= 500 && !v.startsWith('/') && !v.split('/').includes('..') && ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const globs = (v) => Array.isArray(v) && v.length <= 100 && v.every(relPath);
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const TIMEOUT_KEYS = ['lint', 'typecheck', 'unit', 'e2e', 'build', 'generate', 'openapi', 'test_cmd'];
// default minutes per check; one table for the gates and `tb doctor --tag` (they must agree: a doctor-green tag gives the
// gate the same time)
const TIMEOUT_MIN = Object.freeze({ typecheck: 10, unit: 20, test_cmd: 20, build: 15, openapi: 15, lint: 10, generate: 5, e2e: 20, setup: 15 });
// K11: * and ** only (no ? [] {} !), and never a lockfile at the root or one level down; deeper (`sub/**` holds
// sub/yarn.lock) is refused where the globs are matched: gates/task.js inScope never counts a LOCKS basename
const genGlob = (v) => relPath(v) && !/[?[\]{}!]/.test(v) && !LOCKS.some((l) => path.posix.matchesGlob(l, v) || path.posix.matchesGlob(`a/${l}`, v));
const regex = (v) => {
  if (!str(v) || v.length > 200) return false;
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
};
const exact = (v, keys) => isObj(v) && Object.keys(v).every((k) => keys.includes(k));
const ports = (v) => Array.isArray(v) && v.length <= 100 && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
// config files that steer how tests and installs run (contract R2): the default protected list starts with them, and
// gates/task.js protects them wherever they sit (one list, both sites)
const CONFIG_GLOBS = Object.freeze(['package.json', '.npmrc', 'tsconfig*.json', 'jest.config.*', 'vitest.config.*', 'babel.config.*', '.swcrc',
  'nest-cli.json', 'prisma.config.ts']);
const DEFAULTS = Object.freeze({
  protected: Object.freeze([...CONFIG_GLOBS, 'test/utils/**', 'test/helpers/**']), // a tag's `protected` ADDS to this list
  test_globs: Object.freeze(['**/*.{test,spec,e2e-spec}.*', 'test/**', '__tests__/**']),
  test_scripts: '^test(:|$)',
  prisma: Object.freeze({ schema: 'prisma/', migrations: 'prisma/migrations' }),
  openapi_file: 'openapi.json',
});
const RULES_MAX = 8192; // T1: bytes of all rules files together; more → refused, never truncated
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
  // checks.generate never runs npx (D5: it fetches and runs whatever the registry serves): ./node_modules/.bin/<tool>
  checks: (v) => isObj(v) && Object.entries(v).every(([k, x]) => CHECKS.includes(k) && (k === 'prisma_diff' ? typeof x === 'boolean' : str(x) && !(k === 'generate' && /\bnpx\b/.test(x)))),
  leak_check: (v) => typeof v === 'boolean',
  generated: (v) => Array.isArray(v) && v.length <= 100 && v.every(genGlob),
  rules: (v) => Array.isArray(v) && v.length <= 20 && v.every((p) => str(p) && path.isAbsolute(p) && path.resolve(p) === p),
  protected: globs, // added to DEFAULTS.protected (gateTag; Irfan 2026-10-11): a tag never drops a default
  test_globs: globs,
  test_scripts: regex,
  deny_ports: ports,
  // M5 C6 C7: the ports QA's `tbx req` may call (lib/recorder.js); db "local": gates may reach localhost:5432 (opt-in)
  qa_ports: ports,
  db: (v) => v === 'local',
  openapi: (v) => exact(v, ['cmd', 'file']) && str(v.cmd) && (v.file === undefined || relPath(v.file)),
  prisma: (v) => exact(v, ['schema', 'migrations']) && (v.schema === undefined || relPath(v.schema)) && (v.migrations === undefined || relPath(v.migrations)),
  // per-check gate timeout override in minutes (contract Rules: tag override); always under the slot's 60 min max hold
  timeout_min: (v) => isObj(v) && Object.entries(v).every(([k, m]) => TIMEOUT_KEYS.includes(k) && Number.isInteger(m) && m >= 1 && m <= 59),
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

// T1: every rules file a plain file (lstat: a link is refused, never followed), ≤ RULES_MAX bytes together. Async (no
// sync fs on a request path): the caller awaits it after validate(), at tag add and doctor --tag.
/** @param {string[] | undefined} rules */
async function checkRules(rules) {
  let total = 0;
  for (const p of rules ?? []) {
    const st = await fsp.lstat(p).catch(() => null);
    if (!st?.isFile()) throw bad(`tag rules: ${p} is not a plain file (links are refused)`);
    total += st.size;
  }
  if (total > RULES_MAX) throw bad(`tag rules: ${total} bytes in all, at most ${RULES_MAX} (never truncated)`);
}

// The P5 view of a tag def at read time: defaults filled, old shapes mapped (no file rewrite). openapi/prisma stay
// undefined when the tag sets neither shape (that check is skipped).
/** @param {any} def @returns {import('./gates/types').TagP5 & {test_globs: string[], protected: string[], test_scripts: string, generated: string[], rules: string[], deny_ports: number[]}} */
function gateTag(def) {
  const { prisma_diff: _p, openapi: oldApi, ...checks } = def.checks ?? {};
  const openapi = def.openapi ? { file: DEFAULTS.openapi_file, ...def.openapi } : str(oldApi) ? { cmd: oldApi, file: DEFAULTS.openapi_file } : undefined;
  const prisma = def.prisma ? { ...DEFAULTS.prisma, ...def.prisma } : def.checks?.prisma_diff === true ? { ...DEFAULTS.prisma } : undefined;
  return {
    generated: def.generated ?? [], rules: def.rules ?? [], protected: [...new Set([...DEFAULTS.protected, ...(def.protected ?? [])])],
    test_globs: def.test_globs ?? [...DEFAULTS.test_globs], test_scripts: def.test_scripts ?? DEFAULTS.test_scripts,
    deny_ports: def.deny_ports ?? [], openapi, prisma, checks,
  };
}

// Flows need a leaf tag with a path (spec §3). Reminders may use any level.
function assertFlowTag(map, name) {
  validName(name);
  if (!map[name] || !map[name].path) throw bad(`tag ${name} has no path; flows need a leaf tag with a path`);
  if (Object.keys(map).some((n) => n.startsWith(name + '/'))) throw bad(`tag ${name} is not a leaf; pick one of its children`);
}

// a check's timeout (ms): the tag's timeout_min, else config gates.timeout_min, else TIMEOUT_MIN; always under the slot's
// max hold (contract Rules). config: the store's config (passed in: this module reads no store).
function checkTimeoutMs(key, tag = {}, config = {}) {
  const pick = (m) => (Number.isFinite(m?.[key]) && m[key] > 0 ? m[key] : null);
  const hold = config.slots?.max_hold_min;
  const holdMin = Number.isFinite(hold) && hold > 0 ? hold : 60;
  return Math.min(pick(tag.timeout_min) ?? pick(config.gates?.timeout_min) ?? TIMEOUT_MIN[key] ?? 15, holdMin - 1) * 60_000;
}

module.exports = { NAME_RE, CONFIG_GLOBS, LOCKS, DEFAULTS, validName, validate, checkRules, gateTag, assertFlowTag, checkTimeoutMs };
