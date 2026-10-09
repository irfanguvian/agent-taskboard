'use strict';
// stream: tails one run's stream-json log (runs/<n>.jsonl) from a byte offset and classifies how the run ended
// (spec §8, App C, D-0009, D-0010). Keeps only liveness facts: last event time (the log's mtime, so a re-attach
// after a tbd restart reads the real time, not "now"), the running tool's name and since when, whether the last
// event is an API retry (liveness "waiting"), and counters. Never the text.
// Every line is agent-influenced, so untrusted (D31): a line that is not a JSON object is counted and skipped, the
// result envelope is type-checked field by field, and its structured_output is passed on only as an object.
// The outcome comes from the LAST result line, never from an exit code a restarted tbd could not collect.
// P3c (plan P3 AC9): a log is gzipped once its run ended (packLog, zlib streams, T6); readLog renders either form as
// short, plain lines for `tb logs` and the card's log tail (partial-message deltas skipped, control characters out).
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
    rate_limit: null, rejected: null, result: null,
  };
  const open = new Map(); // tool_use id → tool name, for the ones without a tool_result yet
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
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string' || c.id.length > 200) continue;
        state.tool_uses++;
        if (open.size >= MAX_OPEN) open.delete(open.keys().next().value);
        open.set(c.id, typeof c.name === 'string' && TOOL_RE.test(c.name) ? c.name : 'tool');
      }
    } else if (ev.type === 'user') {
      for (const c of content) if (c?.type === 'tool_result') open.delete(c.tool_use_id);
    } else if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info;
      if (isObj(info) && RATE.includes(info.status)) {
        state.rate_limit = { status: info.status, resets_at: iso(info.resetsAt) };
        if (info.status === 'rejected') state.rejected = state.rate_limit;
      }
    } else if (ev.type === 'result') {
      state.result = envelope(ev);
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
    return state;
  }

  return { state, read };
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
// most SHOW characters.
const flat = (v) => {
  const s = plain((typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ')).trim();
  return s.length > SHOW ? `${s.slice(0, SHOW - 1)}…` : s;
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
 * earlier read → the lines since (at most about AFTER_MAX); else the last `tail` lines (of the last TAIL_BYTES of a
 * plain log). offset: where the next `after` read starts (the same in both forms). ended: packed and read to its end,
 * so the run is over. null: no log.
 * @param {string} file @param {{tail?: number, after?: number|null}} [o]
 * @returns {Promise<{lines: string[], offset: number, ended: boolean} | null>}
 */
async function readLog(file, { tail = 200, after = null } = {}) {
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
  const out = [];
  try {
    const used = await lines(stream, (text, bytes) => {
      if (skip > 0) return void (skip -= packed ? bytes : 1);
      out.push(...(text === null ? [`(a line of ${Math.round(bytes / 1024)} KB, not shown)`] : render(text)));
      if (after == null) out.splice(0, out.length - tail);
      else if (out.length >= AFTER_MAX) more = true;
      return !more;
    }, packed);
    return { lines: out, offset: start + used, ended: packed && !more };
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

module.exports = { createTail, outcome, OUTCOMES, EXITS, render, readLog, packLog };
