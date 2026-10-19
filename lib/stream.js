'use strict';
// stream: tails one run's stream-json log (runs/<n>.jsonl) from a byte offset and classifies how the run ended
// (spec §8, App C, D-0009, D-0010). Keeps only liveness facts: last event time (the log's mtime, so a re-attach
// after a tbd restart reads the real time, not "now"), the running tool's name and since when, whether the last
// event is an API retry (liveness "waiting"), and counters; board-terminal-parity Phase 3: the run facts too (model,
// context tokens, subagents ≤ 16 with short names, refusals) and the open tools' short inputs in a closed map (doing()),
// never a tool's whole input or output on the state.
// Every line is agent-influenced, so untrusted (D31): a line that is not a JSON object is counted and skipped, the
// result envelope is type-checked field by field, and its structured_output is passed on only as an object.
// The outcome comes from the LAST result line, never from an exit code a restarted tbd could not collect.
// P3c (plan P3 AC9): a log is gzipped once its run ended (packLog, zlib streams, T6); readLog renders either form as
// short, plain lines for `tb logs` and the card's log tail (partial-message deltas skipped, control characters out).
// board-terminal-parity Phase 2 task 4b: auto mode's classifier blocks → state.blocked ({id, tool, input, reason}, taken
// by the runner): a system permission_denied event with decision_reason_type "classifier" (spike f1/f3, claude 2.1.302),
// or, under --permission-prompts host where that event did not come (spike g3), a tool_result error whose text is
// claude's own classifier denial. The tool's input comes from its tool_use line (kept while open, ≤ 4 KB). Security
// review L3: any tool (an MCP server) can return that text, so such a tool_result counts only once claude confirms its
// tool_use_id (a later permission_denied event, or a result line's permission_denials); unconfirmed at run end: dropped.
// board-terminal-parity Phase 3 (Now card): the tail also keeps the run's facts, no other text: model (init), ctx_tokens
// (the last main-session assistant usage: input + cache creation + cache read), subs (local_agent tasks from the task_*
// events, ≤ SUBS_MAX) and denied (permission_denied events); tail.doing() = the shown tool + its input in short (off
// the state: it holds no tool text but a block's). brief()
// turns a log line into plain feed rows for GET …/activity and `tb logs --plain` (readLog's show option).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { isObj } = require('./util');
const { plain } = require('./toon');

const CHUNK = 1 << 20;
const LINE_MAX = 4 << 20; // one longer line (a huge tool result) is dropped as a bad line; 4 MB: 8 GB Mac
const MAX_OPEN = 64; // tool_use ids tracked at once
const TOOL_RE = /^[\w.:-]{1,64}$/;
const RATE = ['allowed', 'allowed_warning', 'rejected'];
const INPUT_MAX = 4096; // a tool_use input kept for a block (JSON bytes); a bigger one is recorded as not seen
const BLOCKED_MAX = 20; // blocks not taken yet
const CLASSIFIER = 'Permission for this action was denied by the Claude Code auto mode classifier.'; // its tool_result text (2.1.302)
const SUBS_MAX = 16; // subagents kept per run (the oldest dropped)
const SHORT = 80; // characters of a doing text, a subagent's description or type, the model
const nameOf = (v) => (typeof v === 'string' && TOOL_RE.test(v) ? v : 'tool'); // an agent's tool name, never echoed odd
const str = (v) => (typeof v === 'string' ? v : '');
const resultText = (c) => (typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join('') : '');
const reasonOf = (text) => /Reason: (.*?)\. If you have other tasks/s.exec(text)?.[1]; // the classifier's reason in its denial text
// The input field a tool's short text shows (doing, the feed); other tools: none.
const FIELD = new Map([['Bash', 'command'], ['Read', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'], ['Grep', 'pattern'], ['Glob', 'pattern'], ['Skill', 'skill'], ['Task', 'description'], ['Agent', 'description']]);
const argOf = (c) => { const k = FIELD.get(c.name); return k && isObj(c.input) ? str(c.input[k]) : ''; };

const WEEK_MS = 7 * 24 * 3600_000;
// A reset time (epoch seconds) as ISO; null when not a time or more than 7 days ahead (S12: a bogus far-future epoch
// would pause every run; null = the usage retry delay applies).
const iso = (sec) => (Number.isFinite(sec) && sec > 0 && sec * 1000 <= Date.now() + WEEK_MS ? new Date(sec * 1000).toISOString() : null);

// The result line, checked: null fields where the type is wrong; valid only when the core fields are right.
function envelope(ev) {
  const cost = ev.total_cost_usd;
  const valid = typeof ev.subtype === 'string' && typeof ev.is_error === 'boolean' && typeof ev.session_id === 'string' &&
    (cost === undefined || (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0));
  if (!valid) return { valid: false };
  const text = typeof ev.result === 'string' ? ev.result : '';
  const limit = ev.api_error_status === 429 || /usage limit/i.test(text);
  return {
    valid: true,
    subtype: ev.subtype,
    is_error: ev.is_error,
    session_id: ev.session_id,
    refusal: ev.stop_reason === 'refusal',
    limit,
    resets_at: limit ? iso(Number(/\|(\d{9,11})\s*$/.exec(text)?.[1])) : null,
    cost_micro: cost === undefined ? null : Math.round(cost * 1e6), // T5: integer micro-USD
    num_turns: Number.isInteger(ev.num_turns) ? ev.num_turns : null,
    output: isObj(ev.structured_output) ? ev.structured_output : null,
  };
}

/** @param {string} file absolute path of the run's .jsonl log */
function createTail(file) {
  const state = {
    offset: 0, last_event_at: null, tool: null, tool_since: null, retrying: false, events: 0, tool_uses: 0, bad_lines: 0,
    rate_limit: null, rejected: null, result: null, blocked: [],
    model: null, ctx_tokens: null, subs: /** @type {any[]} */ ([]), denied: 0, // Phase 3 run facts
  };
  const open = new Map(); // tool_use id → tool name, for the ones without a tool_result yet
  const inputs = new Map(); // tool_use id → its input (≤ INPUT_MAX) or null, beside open
  const shorts = new Map(); // Phase 3: tool_use id → its input in short (flat, ≤ SHORT), beside open: doing()
  const seen = new Set(); // tool_use ids already blocked (both signals can come for one call)
  const unsure = new Map(); // L3: tool_use id → {tool, input, reason} of a classifier-text tool_result claude has not confirmed yet
  function block(id, tool, reason, input = unsure.get(id)?.input ?? inputs.get(id) ?? null) {
    unsure.delete(id);
    if (typeof id !== 'string' || seen.has(id) || state.blocked.length >= BLOCKED_MAX) return;
    if (seen.size >= MAX_OPEN) seen.delete(seen.values().next().value);
    seen.add(id);
    state.blocked.push({ id, tool: nameOf(tool), input, reason: typeof reason === 'string' ? reason.slice(0, 500) : '' });
  }
  // Phase 3: a task_* event → state.subs: local_agent starts only (a background Bash is no subagent), ≤ SUBS_MAX
  function sub(ev) {
    const id = ev.task_id;
    if (typeof id !== 'string' || !TOOL_RE.test(id)) return;
    if (ev.subtype === 'task_started') {
      if (ev.task_type !== 'local_agent' || state.subs.some((x) => x.id === id)) return;
      state.subs.push({ id, desc: flat(ev.description, SHORT), type: flat(ev.subagent_type ?? ev.task_type, SHORT), tool: null, tokens: null, status: 'running' });
      if (state.subs.length > SUBS_MAX) state.subs.shift();
      return;
    }
    const s = state.subs.find((x) => x.id === id);
    if (!s) return;
    if (ev.subtype === 'task_progress') {
      if (typeof ev.last_tool_name === 'string') s.tool = nameOf(ev.last_tool_name);
      if (Number.isSafeInteger(ev.usage?.total_tokens) && ev.usage.total_tokens >= 0) s.tokens = ev.usage.total_tokens;
    } else {
      const to = ev.subtype === 'task_notification' ? ev.status : ev.subtype === 'task_updated' ? ev.patch?.status : undefined;
      if (typeof to === 'string' && TOOL_RE.test(to)) s.status = to;
    }
  }
  const confirm = (/** @type {unknown} */ id) => { const u = unsure.get(id); if (u) block(id, u.tool, u.reason, u.input); };
  let toolId = null; // id of the tool shown (the last open one): a new id is a new tool, even with the same name
  const decoder = new TextDecoder('utf-8'); // one per log: a character split across two reads stays whole
  let partial = '';
  let skipping = false; // inside an over-long line: drop bytes until its newline

  function onLine(line) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { /* counted below */ }
    if (!isObj(ev) || typeof ev.type !== 'string') return void state.bad_lines++;
    state.events++;
    state.retrying = ev.type === 'system' && ev.subtype === 'api_retry';
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (ev.type === 'assistant') {
      const u = ev.message?.usage;
      if (ev.parent_tool_use_id == null && isObj(u) && Number.isSafeInteger(u.input_tokens)) { // Phase 3: the main session's context
        state.ctx_tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number.isSafeInteger(u[k]) && u[k] > 0 ? u[k] : 0), 0);
      }
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string' || c.id.length > 200) continue;
        state.tool_uses++;
        if (open.size >= MAX_OPEN) {
          inputs.delete(open.keys().next().value);
          shorts.delete(open.keys().next().value);
          open.delete(open.keys().next().value);
        }
        open.set(c.id, nameOf(c.name));
        inputs.set(c.id, isObj(c.input) && JSON.stringify(c.input).length <= INPUT_MAX ? c.input : null);
        shorts.set(c.id, flat(argOf(c), SHORT));
      }
    } else if (ev.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const text = resultText(c);
        if (c.is_error === true && text.startsWith(CLASSIFIER) && typeof c.tool_use_id === 'string' && !seen.has(c.tool_use_id) && unsure.size < MAX_OPEN) {
          unsure.set(c.tool_use_id, { tool: open.get(c.tool_use_id), input: inputs.get(c.tool_use_id) ?? null, reason: reasonOf(text) });
        }
        open.delete(c.tool_use_id);
        inputs.delete(c.tool_use_id);
        shorts.delete(c.tool_use_id);
      }
    } else if (ev.type === 'system') {
      if (ev.subtype === 'init' && typeof ev.model === 'string') state.model = flat(ev.model, SHORT) || null;
      else if (ev.subtype === 'permission_denied') {
        state.denied++; // Phase 3: every refusal (auto mode, a rule, a subagent's), one signal
        if (ev.decision_reason_type === 'classifier') block(ev.tool_use_id, ev.tool_name, ev.decision_reason); // claude's own event: confirms an unsure one too
      } else sub(ev);
    } else if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info;
      if (isObj(info) && RATE.includes(info.status)) {
        state.rate_limit = { status: info.status, resets_at: iso(info.resetsAt) };
        if (info.status === 'rejected') state.rejected = state.rate_limit;
      }
    } else if (ev.type === 'result') {
      state.result = envelope(ev);
      for (const d of Array.isArray(ev.permission_denials) ? ev.permission_denials : []) confirm(d?.tool_use_id);
    }
    state.tool = open.size ? [...open.values()].at(-1) : null;
    toolId = open.size ? [...open.keys()].at(-1) : null;
  }

  function feed(text) {
    let start = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
      if (skipping) skipping = false;
      else onLine(partial + text.slice(start, i));
      partial = '';
      start = i + 1;
    }
    if (skipping) return;
    partial += text.slice(start);
    if (partial.length > LINE_MAX) {
      partial = '';
      skipping = true;
      state.bad_lines++;
    }
  }

  // Reads what was appended since the last call. final: the writer is gone, so a last line without its newline counts.
  // NOFOLLOW (S9): a link planted at the log throws ELOOP, never read through.
  async function read({ final = false } = {}) {
    let fh;
    try {
      fh = await fsp.open(file, NOFOLLOW);
    } catch (e) {
      if (e.code === 'ENOENT') return state;
      throw e;
    }
    try {
      const st = await fh.stat();
      const before = toolId;
      if (st.size > state.offset) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - state.offset));
        while (state.offset < st.size) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - state.offset), state.offset);
          if (!bytesRead) break;
          state.offset += bytesRead;
          feed(decoder.decode(buf.subarray(0, bytesRead), { stream: true }));
        }
        state.last_event_at = st.mtime.toISOString();
        if (toolId !== before) state.tool_since = toolId ? state.last_event_at : null;
      }
    } finally {
      await fh.close();
    }
    if (final && partial && !skipping) {
      onLine(partial);
      partial = '';
    }
    if (final) unsure.clear(); // L3: never confirmed by claude: no card
    return state;
  }

  // Phase 3: the shown tool (state.tool) and its input in short, null when none is open
  const doing = () => (toolId ? { tool: state.tool, text: shorts.get(toolId) ?? '' } : null);
  return { state, read, doing };
}

// Every exit outcome() returns; EXITS adds the ones the runner sets when it stops a run (recovery). App C `t:run`
// exit has no refusal or cancelled: P3c metrics map them.
const OUTCOMES = ['result', 'schema_fail', 'max_turns', 'usage', 'refusal', 'crash', 'interrupted'];
const EXITS = [...OUTCOMES, 'stalled', 'paused', 'wall_cap', 'cancelled'];

/**
 * How the run ended (one of OUTCOMES), from the last result line (+ a rejected rate_limit_event). code: the child's exit code, known only to the tbd that
 * spawned it (null: unknown or a signal); session: the lease's session id (another session's result is not this run's).
 * @param {any} s tail state @param {{code?: number|null, session?: string}} [end]
 * @returns {{exit: string, output?: object, resets_at?: string|null}}
 */
function outcome(s, { code = null, session } = {}) {
  const r = s.result;
  if (r?.valid && r.session_id === session) {
    if (r.refusal) return { exit: 'refusal' }; // even with is_error false and a structured_output
    if (r.subtype === 'success' && !r.is_error) return r.output ? { exit: 'result', output: r.output } : { exit: 'schema_fail' }; // no object = invalid JSON
    if (s.rejected || r.limit) return { exit: 'usage', resets_at: s.rejected?.resets_at ?? r.resets_at };
    if (r.subtype === 'error_max_turns') return { exit: 'max_turns' };
    if (r.subtype === 'error_max_structured_output_retries') return { exit: 'schema_fail' };
    return { exit: 'crash' }; // error_during_execution and other errors
  }
  if (s.rejected) return { exit: 'usage', resets_at: s.rejected.resets_at }; // ended on the limit without a result
  if (r) return { exit: 'crash' }; // a result line that fails the checks
  return { exit: Number.isInteger(code) && code !== 0 ? 'crash' : 'interrupted' };
}

// ---- log tail (P3c) ----------------------------------------------------------------
const SHOW = 300; // characters per shown line
const TAIL_BYTES = 4 << 20; // a tail of a live log reads at most its last 4 MB
const SHOW_LINE_MAX = 1 << 20; // a longer log line is named, not parsed
const AFTER_MAX = 2000; // lines per `after` read; the next read goes on from its offset
const NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW; // runs/ is the agent's dir: a planted symlink is never read

// Agent text, made safe to print: one line, no control characters (terminal escapes) or bidi controls (toon.plain), at
// most max (SHOW) characters.
const flat = (v, max = SHOW) => {
  const s = plain((typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ')).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// One stream-json log line → the lines worth showing (none for partial-message deltas and status pings).
function render(line) {
  if (line.length > SHOW_LINE_MAX) return [`(a line of ${Math.round(line.length / 1024)} KB, not shown)`];
  if (line.startsWith('{"type":"stream_event"')) return []; // cheap skip of the bulk; the parse below catches the rest
  let ev;
  try { ev = JSON.parse(line); } catch { /* shown as unreadable */ }
  if (!isObj(ev) || typeof ev.type !== 'string') return [`(unreadable line) ${flat(line)}`];
  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  switch (ev.type) {
    case 'stream_event': return [];
    case 'system':
      if (ev.subtype === 'status') return [];
      return [ev.subtype === 'init' ? flat(`init · model ${ev.model} · claude ${ev.claude_code_version}`) : flat(`system ${ev.subtype ?? ''}`)];
    case 'assistant':
      return content.flatMap((c) => (c?.type === 'text' ? [`assistant: ${flat(c.text)}`]
        : c?.type === 'tool_use' ? [`tool ${flat(c.name)}: ${flat(c.input)}`] : c?.type === 'thinking' ? ['thinking'] : []));
    case 'user':
      return content.filter((c) => c?.type === 'tool_result').map((c) => {
        const text = Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join(' ') : c.content;
        return `tool result${c.is_error ? ' (error)' : ''}: ${flat(text)}`;
      });
    case 'rate_limit_event': return [flat(`rate limit ${ev.rate_limit_info?.status} · resets ${iso(ev.rate_limit_info?.resetsAt) ?? '?'}`)];
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(2)}` : '';
      return [flat(`result ${ev.subtype}${ev.is_error ? ' (error)' : ''} · turns ${ev.num_turns ?? '?'}${cost}`)];
    }
    default: return [flat(ev.type)];
  }
}

// board-terminal-parity Phase 3 activity feed: one stream-json log line → plain-words rows {at, text, tone} (0..n), the
// main session only (a subagent's work shows through its task_* events). Text through flat(), ≤ FEED_TEXT. at: the
// line's timestamp, else the last one seen in this read (seen: readLog keeps it per read), else null. An unreadable or
// oversized line → none (the raw log shows it). Auto mode's Approve requests are not in the stream (the prompt tool is
// hidden from it, spike g): the page's Approve cards show them.
const FEED_TEXT = 200;
const DENIED = 'Permission to use '; // claude's own tool_result text of a mode / rule denial (2.1.302)
const VERB = new Map([['Read', 'Read'], ['Edit', 'Edited'], ['MultiEdit', 'Edited'], ['NotebookEdit', 'Edited'], ['Write', 'Wrote'], ['Bash', 'Ran'],
  ['Grep', 'Searched'], ['Glob', 'Searched'], ['Skill', 'Used skill']]); // a tool → its feed verb; others: Used <name>
function brief(line, seen = { at: null }) {
  if (typeof line !== 'string' || line.length > SHOW_LINE_MAX || line.startsWith('{"type":"stream_event"')) return [];
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  if (!isObj(ev)) return [];
  const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
  if (Number.isFinite(ts)) seen.at = new Date(ts).toISOString();
  const row = (text, tone = 'info') => ({ at: seen.at, text: flat(text, FEED_TEXT), tone });
  const content = ev.parent_tool_use_id == null && Array.isArray(ev.message?.content) ? ev.message.content : []; // main session only
  switch (ev.type) {
    case 'assistant':
      return content.flatMap((c) => {
        if (c?.type === 'text') return [row(`Said: ${str(c.text)}`)];
        if (c?.type !== 'tool_use' || c.name === 'Task' || c.name === 'Agent') return []; // task_started says it
        const name = nameOf(c.name);
        return [row(VERB.has(name) ? `${VERB.get(name)} ${argOf(c)}` : `Used ${name}`)];
      });
    case 'user':
      return content.filter((c) => c?.type === 'tool_result' && c.is_error === true).map((c) => {
        const text = resultText(c);
        if (text.startsWith(DENIED)) return []; // a mode or rule denial: its permission_denied row says it
        if (!text.startsWith(CLASSIFIER)) return row(`Failed: ${text}`, 'bad');
        const why = reasonOf(text);
        return row(`Refused by auto mode${why ? `: ${why}` : ''}`, 'warn');
      });
    case 'system':
      if (ev.subtype === 'init') return [row(`Started · model ${str(ev.model)}`)];
      // auto mode's block: its tool_result row says it with the reason (under host prompts this event may not come, spike g3)
      if (ev.subtype === 'permission_denied') return ev.decision_reason_type === 'classifier' ? [] : [row(`Refused ${nameOf(ev.tool_name)}`, 'warn')];
      if (ev.subtype === 'task_started') {
        return [row(ev.task_type === 'local_agent' ? `Started subagent ${flat(ev.description, SHORT)} (${flat(ev.subagent_type, SHORT)})` : `Started ${flat(ev.description, SHORT)}`)];
      }
      if (ev.subtype === 'task_notification') {
        return [row(`Finished ${flat(ev.summary, 150)} (${str(ev.status)})`, ev.status === 'completed' ? 'ok' : ev.status === 'failed' ? 'bad' : 'info')];
      }
      return [];
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) ? ` · $${ev.total_cost_usd.toFixed(2)}` : '';
      return [row(`Step ended: ${str(ev.subtype)}${cost}`, ev.subtype === 'success' && !ev.is_error ? 'ok' : 'bad')];
    }
    case 'rate_limit_event': return ev.rate_limit_info?.status === 'rejected' ? [row('Usage limit reached', 'bad')] : [];
    default: return [];
  }
}

// Calls onLine(text, bytes) for each whole line of a byte stream (bytes: its length with the newline; text null for a
// line over SHOW_LINE_MAX, which is only measured); end: also the last line without a newline (a packed log is final).
// onLine returns false to stop. → bytes up to the end of the last line taken.
async function lines(stream, onLine, end) {
  let used = 0;
  let part = []; // null: the line is too long to keep
  let len = 0;
  const take = (bytes) => {
    const text = part && Buffer.concat(part).toString('utf8');
    part = [];
    len = 0;
    used += bytes;
    return onLine(text, bytes);
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      part?.push(chunk.subarray(start, i));
      if (take(len + i - start + 1) === false) return used;
      start = i + 1;
    }
    len += chunk.length - start;
    if (len > SHOW_LINE_MAX) part = null;
    else part.push(chunk.subarray(start));
  }
  if (end && len) take(len);
  return used;
}

/**
 * The shown lines of run log `file` (runs/<n>.jsonl; once packed, <file>.gz read whole). after: a byte offset from an
 * earlier read → the lines since (at most max, whole log lines: one whose rows would pass max starts the next page,
 * unless it is the first); else the last `tail` lines (of the last TAIL_BYTES of a plain log). offset: where the next
 * `after` read starts (the same in both forms). ended: packed and read to its end, so the run is over. null: no log.
 * show: a log line → its rows (render, or brief for the activity feed; it gets a per-read {at} too).
 * @param {string} file @param {{tail?: number, after?: number|null, show?: (line: string, seen: {at: string|null}) => any[], max?: number}} [o]
 * @returns {Promise<{lines: any[], offset: number, ended: boolean} | null>}
 */
async function readLog(file, { tail = 200, after = null, show = render, max = AFTER_MAX } = {}) {
  const open = (f) => fsp.open(f, NOFOLLOW).catch((e) => { if (e.code !== 'ENOENT' && e.code !== 'ELOOP') throw e; }); // ELOOP: a symlink, no log
  let fh = await open(file);
  const packed = !fh;
  let start = 0;
  let stream;
  if (fh) {
    const { size } = await fh.stat();
    start = Math.min(after ?? Math.max(0, size - TAIL_BYTES), size);
    if (start === size) {
      await fh.close();
      return { lines: [], offset: start, ended: false };
    }
    stream = fh.createReadStream({ start, end: size - 1 }); // closes fh when it ends or is destroyed
  } else {
    if (!(fh = await open(`${file}.gz`))) return null;
    stream = zlib.createGunzip();
    pipeline(fh.createReadStream(), stream).catch(() => {}); // a bad .gz fails the read below; an early stop ends both
  }
  let skip = packed ? after ?? 0 : after == null && start > 0 ? 1 : 0; // packed: bytes before `after`; plain tail: its cut first line
  let more = false;
  let back = 0; // the bytes of a line left for the next page
  const seen = { at: null };
  const out = [];
  try {
    const used = await lines(stream, (text, bytes) => {
      if (skip > 0) return void (skip -= packed ? bytes : 1);
      const rows = text !== null ? show(text, seen) : show === render ? [`(a line of ${Math.round(bytes / 1024)} KB, not shown)`] : [];
      if (after != null && out.length && out.length + rows.length > max) {
        back = bytes;
        return !(more = true);
      }
      out.push(...rows);
      if (after == null) out.splice(0, out.length - tail);
      else if (out.length >= max) more = true;
      return !more;
    }, packed);
    return { lines: out, offset: start + used - back, ended: packed && !more };
  } finally {
    stream.destroy();
  }
}

// T6: an ended run's log → <file>.gz through zlib streams (tmp, then rename), then the plain file goes. A reader
// meanwhile finds one of the two whole. → false when there is no plain log (packed already, or never written). Neither
// end follows a symlink an agent planted in runs/: the log opens O_NOFOLLOW (ELOOP throws), the tmp is removed and
// created anew (wx), and rename replaces a planted .gz link itself.
async function packLog(file) {
  let src;
  try {
    src = await fsp.open(file, NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const tmp = `${file}.gz.tmp`;
  try {
    await fsp.rm(tmp, { force: true });
    await pipeline(src.createReadStream(), zlib.createGzip(), fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  } finally {
    await src.close().catch(() => {}); // the stream closed it already, unless it never started
  }
  await fsp.rename(tmp, `${file}.gz`);
  await fsp.rm(file, { force: true });
  return true;
}

module.exports = { createTail, outcome, OUTCOMES, EXITS, render, brief, readLog, packLog };
