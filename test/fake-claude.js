#!/usr/bin/env node
// Stand-in for the `claude` binary (spec §9 spawn line, §12 fake suite). Zero deps.
// Scenario: FAKE_CLAUDE_SCENARIO=<file.json> or FAKE_CLAUDE_SCENARIO_DIR=<dir> (<dir>/<n>.json by invocation).
// Scenario JSON: {"init"?: false, "steps": [ step ... ], "resume_steps"?: [ step ... ] (used instead when run with
// --resume)}. Step = {"emit": event} | {"sleep_ms": n} | {"crash": code}
//   | {"hang": true} | {"hang": "ignore_sigint"} (D-0011: SIGINT ignored) | {"hang": "ignore_term"} (INT, TERM, HUP
//   ignored: only SIGKILL ends it) | {"result": {...}}
//   | {"background": [file, ...args], "env"?: {...}} (started in this process group with this env + env, left running
//     when this one exits; its pid is emitted)
//   | {"exec": [file, ...args]} (runs it in this env + cwd; emits its exit status and stderr tail)
//   | "refusal" | "usage_limit" | "max_turns" | "schema_fail" | "invalid_json" | "api_retry".
// Event shapes follow test/fixtures/stream/real-sonnet-sample.jsonl (claude 2.1.292).
'use strict';
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const VALUE_FLAGS = new Set(['--session-id', '--resume', '--setting-sources', '--settings', '--append-system-prompt-file',
  '--add-dir', '--mcp-config', '--tools', '--disallowedTools', '--permission-mode', '--permission-prompts', '--model',
  '--effort', '--fallback-model', '--max-turns', '--json-schema', '--output-format']);
const BOOL_FLAGS = new Set(['-p', '--print', '--strict-mcp-config', '--verbose', '--include-partial-messages']);
const ENV_KEEP = /^(CLAUDE_|ANTHROPIC_|GIT_|GH_|BASH_|TB_)|^(GITHUB_TOKEN|SSH_AUTH_SOCK|DISABLE_AUTOUPDATER|TBD_SOCK|TBX_RUN|PATH|NODE_OPTIONS)$/;
const ENV_SECRET = /TOKEN|_KEY$|^SSH_AUTH_SOCK$/; // D31: dump presence only, never the value

const warn = (msg) => fs.writeSync(2, `fake-claude: ${msg}\n`);

const argv = process.argv.slice(2);
const opts = { '--add-dir': [] };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (a === '--add-dir') opts[a].push(v);
    else opts[a] = v;
  } else if (BOOL_FLAGS.has(a)) opts[a] = true;
  else if (a.startsWith('-')) warn(`unknown flag ${a}`);
  else positional.push(a);
}

const sessionId = opts['--resume'] || opts['--session-id'] || crypto.randomUUID();
const prompt = positional.length ? positional.join(' ') : process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
const model = opts['--model'] || 'fake-model';

// Claim invocation number n atomically (O_EXCL), so concurrent spawns never share a scenario.
function claim(dir, name) {
  for (let n = 1; ; n++) {
    try {
      fs.closeSync(fs.openSync(path.join(dir, name(n)), 'wx'));
      return n;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

const { FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_SCENARIO_DIR, FAKE_CLAUDE_DUMP_DIR } = process.env;
let n = 0;
let scenarioFile = FAKE_CLAUDE_SCENARIO;
if (FAKE_CLAUDE_SCENARIO_DIR) {
  n = claim(FAKE_CLAUDE_SCENARIO_DIR, (i) => `.run-${i}`);
  scenarioFile = path.join(FAKE_CLAUDE_SCENARIO_DIR, `${n}.json`);
}
if (FAKE_CLAUDE_DUMP_DIR) {
  if (!n) n = claim(FAKE_CLAUDE_DUMP_DIR, (i) => `${i}.json`);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_KEEP.test(k)) env[k] = ENV_SECRET.test(k) ? '<redacted>' : v;
  fs.writeFileSync(path.join(FAKE_CLAUDE_DUMP_DIR, `${n}.json`),
    JSON.stringify({ argv, opts, env, cwd: process.cwd(), prompt }, null, 2));
}

/** @type {{ init?: boolean, steps: any[], resume_steps?: any[] }} */
let scenario = { steps: [{ result: {} }] };
if (scenarioFile) {
  try {
    scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  } catch (e) {
    warn(`cannot load scenario ${scenarioFile}: ${e.message}`);
    process.exit(2);
  }
}

const emit = (ev) => fs.writeSync(1, JSON.stringify({ ...ev, session_id: ev.session_id ?? sessionId, uuid: ev.uuid ?? crypto.randomUUID() }) + '\n');

// Result line shaped like the real one: success carries result (+ structured_output), errors carry errors[].
function resultLine(over) {
  const subtype = over.subtype ?? 'success';
  const base = { type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1, duration_ms: 1, duration_api_ms: 1,
    stop_reason: 'end_turn', terminal_reason: 'completed', total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    permission_denials: [], api_error_status: null };
  if (subtype === 'success') base.result = 'structured_output' in over ? JSON.stringify(over.structured_output) : 'ok';
  else base.errors = [];
  return { ...base, ...over };
}

const SHORTCUTS = {
  refusal: () => [
    { emit: { type: 'assistant', message: { type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'I can\'t help with that.' }], stop_reason: 'refusal' } } },
    { result: { is_error: true, stop_reason: 'refusal', result: 'I can\'t help with that.' } }],
  usage_limit: (resetsAt = Math.floor(Date.now() / 1000) + 3600) => [
    { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } } },
    { result: { is_error: true, api_error_status: 429, stop_reason: null, result: `Claude AI usage limit reached|${resetsAt}` } }],
  max_turns: () => [{ result: { subtype: 'error_max_turns', terminal_reason: 'max_turns', errors: ['Reached max turns'] } }],
  schema_fail: () => [{ result: { subtype: 'error_max_structured_output_retries', terminal_reason: 'structured_output_retry_exhausted',
    errors: ['Failed to provide valid structured output after maximum retries'] } }],
  invalid_json: () => [{ result: { structured_output: 'not an object' } }],
  api_retry: () => [{ emit: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' } }],
};

async function main() {
  if (scenario.init !== false) {
    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: (opts['--tools'] || '').split(',').filter(Boolean),
      mcp_servers: [], model, permissionMode: opts['--permission-mode'] || 'default', apiKeySource: 'none', claude_code_version: 'fake' });
  }
  let exitCode = 0;
  const steps = (opts['--resume'] && scenario.resume_steps ? scenario.resume_steps : scenario.steps).flatMap((s) => {
    if (typeof s !== 'string') return [s];
    if (!SHORTCUTS[s]) {
      warn(`unknown shortcut ${s}`);
      process.exit(2);
    }
    return SHORTCUTS[s]();
  });
  for (const s of steps) {
    if (s.emit) emit(s.emit);
    else if (s.sleep_ms) await new Promise((r) => setTimeout(r, s.sleep_ms));
    else if ('crash' in s) process.exit(s.crash);
    else if (s.hang) {
      for (const sig of { ignore_sigint: ['SIGINT'], ignore_term: ['SIGINT', 'SIGTERM', 'SIGHUP'] }[s.hang] ?? []) process.on(sig, () => {});
      setInterval(() => {}, 1 << 30); // stay alive until killed
      return;
    } else if (s.background) {
      const child = spawn(s.background[0], s.background.slice(1), { env: { ...process.env, ...s.env }, stdio: 'ignore' }); // not detached: same group
      child.unref();
      emit({ type: 'system', subtype: 'fake_child', pid: child.pid });
    } else if (s.exec) {
      const r = spawnSync(s.exec[0], s.exec.slice(1), { encoding: 'utf8', timeout: 30_000 });
      emit({ type: 'system', subtype: 'fake_exec', status: r.status, stderr: String(r.stderr ?? r.error?.message ?? '').slice(-500) });
    } else if (s.result) {
      const line = resultLine(s.result);
      emit(line);
      exitCode = line.is_error ? 1 : 0;
    }
  }
  process.exit(exitCode);
}

main();
