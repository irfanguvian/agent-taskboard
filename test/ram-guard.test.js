'use strict';
// ram-guard (scripts/ram-guard.js, D-0021): the real hook script fed hook JSON on stdin. A fake sysctl on PATH sets the
// free %, and TMPDIR points at a temp dir, so the slot file is never the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'scripts', 'ram-guard.js');
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const agent = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } };
const ago = (ms) => new Date(Date.now() - ms);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'sysctl'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_FREE"\n', { mode: 0o755 });
  const hook = (input, free = '60') => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, FAKE_FREE: free },
    });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, stderr: r.stderr };
  };
  const start = (id) => hook({ hook_event_name: 'SubagentStart', agent_id: id, transcript_path: path.join(dir, 'sess.jsonl') });
  const gd = path.join(dir, 'claude-ram-guard');
  const files = () => (fs.existsSync(gd) ? fs.readdirSync(gd).filter((f) => f !== '.lock') : []);
  // n hook processes at once, like parallel Agent calls in one message
  const parallel = (n, free = '90') => Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, [GUARD], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, FAKE_FREE: free } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'));
    c.stdin.end(JSON.stringify(agent));
  })));
  return { dir, gd, files, hook, start, parallel };
}

test('Bash: heavy commands are denied below 25% free; light commands and 25%+ pass', (t) => {
  const { hook } = setup(t);
  for (const cmd of ['npm test', 'node --test test/x.test.js', './node_modules/.bin/tsc --noEmit', 'claude -p hi --model sonnet', 'chrome-devtools-axi open x']) {
    const { out } = hook(bash(cmd), '24');
    assert.equal(out?.permissionDecision, 'deny', cmd);
    assert.match(out.permissionDecisionReason, /^RAM low \(24% free, need 25%\): close apps/);
  }
  assert.equal(hook(bash('git status'), '5').out, null);
  assert.equal(hook(bash('claude --version'), '5').out, null);
  assert.equal(hook(bash('npm test'), '25').out, null);
});

test('Agent: at most 3 at once, each extra one needs 40% free; only the same agent stopping frees its place', (t) => {
  const { hook, start } = setup(t);
  assert.equal(hook(agent, '60').out, null, '1st');
  assert.match(hook(agent, '39').out?.permissionDecisionReason, /^RAM: parallel subagent #2 needs 40% free \(39% now\)/);
  assert.equal(hook(agent, '40').out, null, '2nd at 40%');
  assert.match(hook(agent, '39').out?.permissionDecisionReason, /^RAM: parallel subagent #3 needs 40% free \(39% now\)/);
  assert.equal(hook(agent, '40').out, null, '3rd at 40%');
  assert.match(hook(agent, '90').out?.permissionDecisionReason, /^D-0039: 3 subagents already run \(max 3\)/, '4th');
  start('a1');
  start('a2');
  start('a3');
  assert.equal(hook(agent, '90').out?.permissionDecision, 'deny', 'all 3 started');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'other' });
  assert.equal(hook(agent, '90').out?.permissionDecision, 'deny', 'another agent stopping frees nothing');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.equal(hook(agent, '90').out, null, 'a1 stopped: one place free');
});

test('parallel Agent calls: 4 hooks at once → exactly 3 allowed (lock)', async (t) => {
  const { parallel, files } = setup(t);
  const got = await parallel(4);
  assert.deepEqual(got.sort(), ['allow', 'allow', 'allow', 'deny']);
  assert.equal(files().filter((f) => f.startsWith('res-')).length, 3);
});

test('stale places free themselves: a reservation after 1 min, a started agent after 15 min without transcript writes', (t) => {
  const { dir, gd, files, hook, start } = setup(t);
  const age = (ms) => { for (const f of files()) fs.utimesSync(path.join(gd, f), ago(ms), ago(ms)); };
  hook(agent);
  hook(agent);
  age(120_000);
  assert.equal(hook(agent).out, null, 'reservations never started: free after 1 min');
  start('a1');
  const transcript = path.join(dir, 'sess', 'subagents', 'agent-a1.jsonl'); // where claude writes it
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{}\n');
  hook(agent);
  start('a2');
  age(20 * 60_000);
  assert.equal(hook(agent).out, null, 'a2 silent 20 min: stale; a1 transcript fresh: live');
  assert.equal(hook(agent).out, null, 'a1 + 2 new: 3rd place');
  assert.equal(hook(agent).out?.permissionDecision, 'deny', 'a1 + 2 new = 3: full');
});

test('Agent below 25% free is denied and reserves nothing; TeamCreate and Workflow are always denied', (t) => {
  const { files, hook } = setup(t);
  assert.match(hook(agent, '10').out?.permissionDecisionReason, /^RAM low \(10% free/);
  assert.deepEqual(files(), []);
  for (const tool_name of ['TeamCreate', 'Workflow']) {
    assert.match(hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} }, '90').out?.permissionDecisionReason, /^D-0021: no agent teams/);
  }
});

test('sysctl with no number allows with a note (fail open), never denies as 0% free', (t) => {
  const { hook } = setup(t);
  const { out, stderr } = hook(bash('npm test'), '');
  assert.equal(out, null);
  assert.equal(stderr, 'ram-guard: sysctl gave ""; allowing\n');
});
