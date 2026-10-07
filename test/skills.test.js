'use strict';
// P1 AC8: skill copy sources from local + claude.ai-synced skill dirs (uuid dir → skill name). Temp HOME
// fixture only; never reads the real ~/.claude.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillSources } = require('../lib/skills');

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  const S = '.claude/skills';
  write(`${S}/alpha/SKILL.md`, '---\nname: alpha\ndescription: x\n---\n# alpha\n');
  write(`${S}/beta/SKILL.md`, '# no frontmatter: folder name\n');
  write(`${S}/renamed-dir/SKILL.md`, '---\ndescription: y\nname: "gamma"\n---\n');
  write(`${S}/nodoc/README.md`, 'not a skill');
  write('elsewhere/linked/SKILL.md', '# linked\n');
  fs.symlinkSync(path.join(home, 'elsewhere/linked'), path.join(home, S, 'linked'));
  write(`${S}/synced/u1_u2/manifest.json`, '{}');
  write(`${S}/synced/u1_u2/docx/SKILL.md`, '---\nname: docx\n---\n');
  write(`${S}/synced/u1_u2/alpha/SKILL.md`, '---\nname: alpha\n---\n');
  write(`${S}/synced/u3_u4/docx/SKILL.md`, '---\nname: docx\n---\n');
  return { home, s: path.join(home, S) };
}

test('AC8 skillSources: local + synced layouts, frontmatter name wins, symlinks resolved, no-SKILL.md dirs ignored', async (t) => {
  const { home, s } = fixture(t);
  const { skills } = await skillSources(home);
  assert.deepEqual(skills, {
    alpha: path.join(s, 'alpha'),
    beta: path.join(s, 'beta'),
    gamma: path.join(s, 'renamed-dir'),
    linked: path.join(home, 'elsewhere/linked'),
    docx: path.join(s, 'synced/u1_u2/docx'),
  });
});

test('AC8 skillSources: local beats synced, first synced uuid dir beats later ones; each loser listed in conflicts', async (t) => {
  const { home, s } = fixture(t);
  const { conflicts } = await skillSources(home);
  assert.deepEqual(conflicts, [
    { name: 'alpha', used: path.join(s, 'alpha'), ignored: path.join(s, 'synced/u1_u2/alpha') },
    { name: 'docx', used: path.join(s, 'synced/u1_u2/docx'), ignored: path.join(s, 'synced/u3_u4/docx') },
  ]);
});

test('AC8 skillSources: HOME without ~/.claude/skills → empty, no throw', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await skillSources(home), { skills: {}, conflicts: [] });
});
