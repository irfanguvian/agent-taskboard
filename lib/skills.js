'use strict';
// skills: where each skill's folder lives, as the copy source for a ticket's skills at plan approval (P1 AC8).
// Local <home>/.claude/skills/<name>/ wins over claude.ai-synced <home>/.claude/skills/synced/<uuid>_<uuid>/<name>/.
// Read-only, async fs: P4 calls it at approval time, never on a hot path.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ls = (dir) => fsp.readdir(dir).catch(() => []);

// SKILL.md frontmatter `name:`, else the folder name; null when the folder has no SKILL.md.
async function skillName(dir) {
  const text = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (text === null) return null;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(front)?.[1] ?? path.basename(dir);
}

// → { skills: {<name>: <real dir>}, conflicts: [{name, used, ignored}] }. First seen wins: local (sorted), then synced (sorted).
async function skillSources(home = os.homedir()) {
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

module.exports = { skillSources };
