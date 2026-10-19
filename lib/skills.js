'use strict';
// skills: where each skill's folder lives, as the copy source for a ticket's skills at plan approval (P1 AC8).
// Local <home>/.claude/skills/<name>/ wins over claude.ai-synced <home>/.claude/skills/synced/<uuid>_<uuid>/<name>/.
// Read-only, async fs: P4 calls it at approval time, never on a hot path.
// board-terminal-parity Phase 1: listSkills (GET /api/skills: the Goal box's / list) and asked (the /names a flow's text
// asks for, POST /api/flows → t.skills_asked).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { git, isObj, readPlain } = require('./util');
const sh = require('./sh');

const ls = (dir) => fsp.readdir(dir).catch(() => []);

// SKILL.md frontmatter `name:`, else the folder name; null when the folder has no SKILL.md.
async function skillName(dir) {
  const text = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (text === null) return null;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(front)?.[1] ?? path.basename(dir);
}

// → { skills: {<name>: <real dir>}, conflicts: [{name, used, ignored}] }. First seen wins: local (sorted), then synced (sorted).
// One read serves the calls of the next MEMO_MS (a planning run's seed and plan ctx come in the same breath).
const MEMO_MS = 2000;
let memo = null; // {home, at, p}
function skillSources(home = os.homedir()) {
  if (!memo || memo.home !== home || Date.now() - memo.at > MEMO_MS) memo = { home, at: Date.now(), p: read(home) };
  return memo.p;
}

async function read(home) {
  const root = path.join(home, '.claude', 'skills');
  const dirs = (await ls(root)).sort().map((n) => path.join(root, n));
  for (const u of (await ls(path.join(root, 'synced'))).sort()) {
    for (const n of (await ls(path.join(root, 'synced', u))).sort()) dirs.push(path.join(root, 'synced', u, n));
  }
  const names = await Promise.all(dirs.map(skillName));
  const skills = {};
  const conflicts = [];
  for (let i = 0; i < dirs.length; i++) {
    if (!names[i]) continue;
    const real = await fsp.realpath(dirs[i]); // symlinked skills resolve to the folder to copy
    if (skills[names[i]]) conflicts.push({ name: names[i], used: skills[names[i]], ignored: real });
    else skills[names[i]] = real;
  }
  return { skills, conflicts };
}

// Board default skills (full-access-runs Phase 4); config.skills.defaults replaces them.
const DEFAULT_SKILLS = ['learning', 'grilling', 'lavish', 'test-engineer-irfan', 'tdd', 'codebase-design', 'postgres-irfan-axi', 'chrome-devtools-axi', 'caveman', 'ponytail', 'frontend-design'];

// (board defaults ∪ tag.skills) − tag.skills_off; stable order, no duplicates.
function effectiveSkills(config, tag) {
  const off = new Set(tag?.skills_off ?? []);
  return [...new Set([...(config?.skills?.defaults ?? DEFAULT_SKILLS), ...(tag?.skills ?? [])])].filter((n) => !off.has(n));
}

// ---- board-terminal-parity Phase 1: the / list and the asked names ----------------------------------------------
const HEAD = 4096; // SKILL.md bytes read for the name + description
const LIST_MAX = 500;
const DESC_MAX = 200;
const LIST_MS = 30_000;
const ASKED_MAX = 20;
const SKILL_MAX = 16 << 10; // a committed SKILL.md over 16 KB is not listed (only its first 4 KB is read; caps the cat-file buffer)
const NAME_RE = /^[a-z0-9][\w:.-]{0,63}$/; // a listed name: what ASK_RE can ask for
// a /name at a word start, ended by the text end, a space or , ; ! ? ) (`/api/users` asks nothing). The same in
// ui/app.js ASK_RE: keep both identical.
const ASK_RE = /(^|\s)\/([a-z0-9][\w:.-]{0,63})(?=$|[\s,;!?)])/g;

// The first 4 KB of a regular file (O_NONBLOCK: a FIFO never hangs the open), else null.
async function head(/** @type {string} */ file) {
  let fh;
  try {
    fh = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!(await fh.stat()).isFile()) return null;
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(HEAD), 0, HEAD, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// frontmatter (closed or cut at 4 KB) → {name: `name:` else dir, description: `description:` plain or quoted on its
// line; folded > or | → the block's first non-empty line; ≤ 200 chars}; a name NAME_RE refuses (> 64 chars, other
// chars) → null: not listed
function meta(/** @type {string} */ text, /** @type {string} */ dir) {
  const front = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(text)?.[1] ?? '';
  const lines = front.split(/\r?\n/);
  const name = /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(front)?.[1] ?? dir;
  if (!NAME_RE.test(name)) return null;
  const i = lines.findIndex((l) => l.startsWith('description:'));
  let d = i < 0 ? '' : lines[i].slice('description:'.length).trim();
  if (/^[>|][+-]?$/.test(d)) {
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => l.trim() && !/^\s/.test(l)); // the block ends at the next key
    d = (end < 0 ? rest : rest.slice(0, end)).find((l) => l.trim())?.trim() ?? '';
  } else if (/^(["']).*\1$/.test(d)) d = d.slice(1, -1);
  return { name, description: d.slice(0, DESC_MAX) };
}

// <root>/<dir>/SKILL.md for each dir (sorted), as {name: prefix + name, description, source}
async function dirSkills(/** @type {string} */ root, /** @type {string} */ source, prefix = '') {
  const all = await Promise.all((await ls(root)).sort().map(async (n) => {
    const text = await head(path.join(root, n, 'SKILL.md'));
    const m = text === null ? null : meta(text, n);
    return m && { ...m, source };
  }));
  return all.filter((x) => x !== null).map((x) => ({ ...x, name: prefix + x.name })).filter((x) => NAME_RE.test(x.name)); // the prefixed name too: what ASK_RE can ask for
}

// enabled user-scope plugins: installed_plugins.json {plugins: {"<plugin>@<market>": [{scope, installPath}]}} whose key is
// true in settings.json enabledPlugins → <installPath>/skills/*/SKILL.md as <plugin>:<skill>
async function pluginSkills(/** @type {string} */ home) {
  const json = async (/** @type {string} */ f) => { try { return JSON.parse(await readPlain(f, 1 << 20, true) ?? 'null'); } catch { return null; } };
  const [inst, set] = await Promise.all([json(path.join(home, '.claude', 'plugins', 'installed_plugins.json')), json(path.join(home, '.claude', 'settings.json'))]);
  const on = isObj(set?.enabledPlugins) ? set.enabledPlugins : {};
  const each = Object.entries(isObj(inst?.plugins) ? inst.plugins : {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, list]) => {
    const at = Array.isArray(list) ? list.find((e) => e?.scope === 'user' && typeof e.installPath === 'string' && path.isAbsolute(e.installPath)) : null;
    return on[key] === true && at ? dirSkills(path.join(at.installPath, 'skills'), 'plugin', `${key.split('@')[0]}:`) : [];
  });
  return (await Promise.all(each)).flat();
}

// the tag folder's .claude/skills: a git tag's from its HEAD tree (ls-tree of the skill dirs, cat-file --batch-check of
// each HEAD:<dir>/SKILL.md for its size: over 64 KB skipped, then ONE cat-file --batch for the rest; util.git:
// GIT_SAFE), a plain folder's from the folder
const asBuffer = (/** @type {string} */ f, /** @type {string[]} */ a, /** @type {any} */ o) => sh(f, a, { ...o, encoding: 'buffer' });
async function projectSkills(/** @type {any} */ tag) {
  if (typeof tag?.path !== 'string') return [];
  if (tag.type !== 'git') return dirSkills(path.join(tag.path, '.claude', 'skills'), 'project');
  const tree = await git(tag.path, ['ls-tree', '-z', 'HEAD', '--', '.claude/skills/']);
  if (tree.err) return [];
  const dirs = tree.stdout.split('\0').flatMap((e) => {
    const m = /^\d+ tree [0-9a-f]{40,64}\t\.claude\/skills\/([^/\n]+)$/.exec(e); // no newline: one batch line each
    return m ? [m[1]] : [];
  }).slice(0, LIST_MAX);
  if (!dirs.length) return [];
  const check = await git(tag.path, ['cat-file', '--batch-check'], { input: dirs.map((d) => `HEAD:.claude/skills/${d}/SKILL.md\n`).join('') });
  if (check.err) return [];
  const sizes = check.stdout.split('\n'); // "<sha> blob <size>" per line, in input order ("<name> missing" else)
  const blobs = dirs.flatMap((dir, i) => {
    const [sha, type, size] = (sizes[i] ?? '').split(' ');
    return type === 'blob' && Number(size) <= SKILL_MAX ? [{ sha, dir }] : [];
  });
  if (!blobs.length) return [];
  const cat = await git(tag.path, ['cat-file', '--batch'], { input: blobs.map((b) => `${b.sha}\n`).join(''), exec: asBuffer, maxBuffer: blobs.length * (SKILL_MAX + 128) });
  if (cat.err) return [];
  const out = /** @type {Buffer} */ (cat.stdout), text = new Map();
  for (let i = 0; i < out.length;) { // "<sha> blob <size>\n<bytes>\n" per blob ("<sha> missing\n" has no bytes)
    const nl = out.indexOf(10, i);
    if (nl < 0) break;
    const [sha, type, size] = out.toString('utf8', i, nl).split(' ');
    i = nl + 1;
    if (type !== 'blob') continue;
    text.set(sha, out.toString('utf8', i, i + Math.min(Number(size), HEAD)));
    i += Number(size) + 1;
  }
  return blobs.flatMap((b) => {
    const m = text.has(b.sha) ? meta(/** @type {string} */ (text.get(b.sha)), b.dir) : null;
    return m ? [{ ...m, source: 'project' }] : [];
  });
}

async function readList(/** @type {any} */ tag, /** @type {string} */ home) {
  const [{ skills }, plugin, project] = await Promise.all([skillSources(home), pluginSkills(home), projectSkills(tag)]);
  const user = (await Promise.all(Object.entries(skills).map(async ([name, dir]) => {
    const m = meta((await head(path.join(dir, 'SKILL.md'))) ?? '', name);
    return m ? [{ name, description: m.description, source: 'user' }] : [];
  }))).flat();
  const seen = new Set(); // a name listed once: user, then plugin, then project
  return [...user, ...plugin, ...project].filter((x) => !seen.has(x.name) && seen.add(x.name)).slice(0, LIST_MAX);
}

// → [{name, description, source: user|plugin|project}] ≤ 500. tag: the tag def (path, type) or null. One memo entry (the
// last home + tag), 30 s: no growing cache; a failed read is not kept.
/** @type {{key: string, at: number, p: Promise<{name: string, description: string, source: string}[]>} | null} */
let listMemo = null;
function listSkills(/** @type {any} */ tag = null, home = os.homedir()) {
  const key = JSON.stringify([home, tag?.path ?? null, tag?.type ?? null]);
  if (!listMemo || listMemo.key !== key || Date.now() - listMemo.at > LIST_MS) {
    const p = readList(tag, home);
    listMemo = { key, at: Date.now(), p };
    p.catch(() => { if (listMemo?.p === p) listMemo = null; });
  }
  return listMemo.p;
}

// the /name tokens of text that name a listed skill: first-seen order, no repeats, ≤ 20
async function asked(/** @type {string} */ text, /** @type {any} */ tag = null, home = os.homedir()) {
  const tokens = [...new Set([...text.matchAll(ASK_RE)].map((m) => m[2]))];
  if (!tokens.length) return [];
  const names = new Set((await listSkills(tag, home)).map((x) => x.name));
  return tokens.filter((n) => names.has(n)).slice(0, ASKED_MAX);
}

module.exports = { skillSources, DEFAULT_SKILLS, effectiveSkills, listSkills, asked };
