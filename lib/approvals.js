'use strict';
// approvals: Irfan's Approve cards and auto mode's blocks (board-terminal-parity Phase 2 task 4, redesigned after the
// spike: .omc/research/btp-p2-spike.md g). One module holds:
// - the ask list: what a full-access auto-mode run asks first (settings permissions.ask), with its plain words for the
//   board note. Only `ask` outcomes reach the prompt tool; auto mode's classifier blocks never do (spike g);
// - the per-run approve tool server: claude runs `/usr/bin/nc -U <run-secrets>/<id>-<n>/a.sock` as stdio MCP server
//   `tb` (≈ 1.6 MB, no node per run, spike i); tbd binds that socket before the spawn (0600, dir 0700) and speaks
//   MCP JSON-RPC there (initialize, tools/list → approve, tools/call). The socket path is the run's identity;
// - the request queue (also fed by bin/tb-git through tbd.sock: lib/slots.js approve.ask): ≤ 4 waiting per ticket (a
//   5th is refused at once), the same tool + input as a waiting one joins it, one timer each (terminal.approve_min,
//   test knob TB_APPROVE_MS), a caller gone (its socket closed) cancels its request; nothing on a socket answers:
//   only answer() does (HTTP POST …/approvals/:aid, tb approve-action);
// - the classifier's blocks (lib/stream.js tail → blocked_actions) and Allow and retry (allow_once, taken off the ticket
//   when the next run starts: lib/runner.js) + the same session resumed through Irfan's note. Bash: a one-shot exact allow
//   rule in that run's permissions.allow. WebFetch / MCP (security review M2: a host or tool rule would allow more than
//   the one call): no allow rule; the call's rule goes to that run's permissions.ask and a seed {tool, text} to its
//   approve socket: that exact input → yes at once (the seed gone), any other call the rule matches → a card.
// Agent text (tool names, inputs, reasons) is kept as plain strings; the page shows it through textContent only.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const { TbError } = require('./errors');
const { isObj } = require('./util');

const S = () => require('./store'); // lazy: lib/runner.js loads this module at its own load (its tests bring their own store)

// [permissions.ask rule, plain words for the board note]. Bash(git push *) stays denied (BASE): pushes go via tb-git.
const ASK = [
  ['Bash(rm -rf *)', 'rm -rf (delete a folder and all in it)'],
  ['Bash(git reset --hard*)', 'git reset --hard'],
  ['Bash(git clean*)', 'git clean'],
  ['Bash(*prisma migrate reset*)', 'prisma migrate reset (wipes the database)'],
  ['Bash(*db:reset*)', 'a db:reset script'],
  ['Bash(dropdb*)', 'dropdb'],
];
const askRules = () => ASK.map(([r]) => r);
const askNote = (/** @type {number} */ min) => `these wait for Irfan's yes first (an Approve card; no answer in ${min} min = no): ${ASK.map(([, w]) => w).join(', ')}`;

const MAX_PENDING = 4; // per ticket: claude sends one ask at a time per run (spike g); tb-git asks beside it
const MAX_WAITERS = 8; // callers joined on one request (the same action asked again), more → no (L12)
const HIDDEN = /\r|\s{20,}/; // L4: a carriage return or a long blank run can hide a command's tail on a card: only No
const SHOW_MAX = 8 * 1024; // input bytes a card shows; more: "too long to show", No only
const TEXT_MAX = 2000; // a blocked action's input text; a longer one is shown cut and never allowed
const KEEP = 20; // approvals and blocked actions kept on a ticket (waiting ones always)
const OPEN_MAX = 2 * KEEP; // re-review M1: blocked actions kept at all (a looping agent adds up to 20 a tick): the oldest go
const ANSWERED_MAX = 300; // an answered approval keeps this much of its input text
const LINE_MAX = 1 << 20; // one JSON-RPC line on an approve socket
const SOCK_MAX = 103; // macOS sun_path: 104 bytes incl. NUL
const DENY = (/** @type {string} */ message) => ({ behavior: 'deny', message });
const TOOL = { name: 'approve', description: 'Permission prompt tool (board).',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } };

/** @type {Map<string, {aid: string, ticket: string, key: string, input: any, long: boolean, hidden: boolean, waiters: Set<Function>, timer: any}>} */
const pending = new Map(); // aid → a request waiting for Irfan
/** @type {Map<string, {srv: net.Server, conns: Set<net.Socket>}>} */
const servers = new Map(); // `${id}-${n}` → a run's approve socket
const iso = () => new Date().toISOString();
const newId = (/** @type {string} */ p) => `${p}_${crypto.randomBytes(3).toString('hex')}`;
const minutes = () => S().config.terminal?.approve_min ?? 10; // tb-git's asks; a run's approve socket has its spawn's (listen)
const waiting = (/** @type {string} */ id) => [...pending.values()].some((p) => p.ticket === id);
// newest KEEP, plus every one still waiting (live: an approval's pending, a block's open)
const trim = (/** @type {any[]} */ list, live = 'pending') => list.filter((a, i) => a.status === live || i >= list.length - KEEP);
const answered = (/** @type {any} */ a, /** @type {any} */ patch) => ({ ...a, ...patch, ...(typeof a.input_text === 'string' && { input_text: a.input_text.slice(0, ANSWERED_MAX) }) });
// M3: Allow and retry only while the next run resumes the blocked session: its run still live (Irfan's note resumes it),
// or ended in a way the recovery resumes (it had spawned), or (re-review L2) a result whose answers resume it (t.continue,
// recovery step 5); never while a Restart waits (re-review L3: pending.fresh starts a new session). ui/app.js has the same
// check (its Dismiss-only cards).
const RESUMES = ['crash', 'interrupted', 'stalled', 'usage', 'paused', 'held', 'schema_fail'];
const resumes = (/** @type {any} */ k, /** @type {any} */ b) => typeof b?.session === 'string' && k.state === b.phase && k.lease?.phase === b.phase && k.lease.session === b.session
  && !k.lease.pending?.fresh && (!k.lease.exit || (RESUMES.includes(k.lease.exit) && Number.isInteger(k.lease.pid))
    || (k.lease.exit === 'result' && k.continue?.phase === b.phase && k.continue.session === b.session));

// What a card shows of an input: a Bash command alone when the input holds nothing else that runs (its description is
// the agent's words, shown as the reason); tb-git's own text; else all of it as JSON.
function shown(/** @type {string} */ tool, /** @type {any} */ input) {
  if (tool === 'tb-git' && typeof input?.text === 'string') return input.text;
  if (tool === 'Bash' && typeof input?.command === 'string' && Object.keys(input).every((k) => k === 'command' || k === 'description')) return input.command;
  return JSON.stringify(input, null, 1);
}

// Allow and retry: the narrowest rule claude has for that action, or null (Dismiss only). Bash: the command as an exact
// allow rule, never with `*` (claude reads it as a wildcard: the rule would allow more) or a line break; WebFetch: its
// host (claude's narrowest WebFetch rule; never an IP, localhost or .local host: Dismiss only); an MCP tool: its full
// name. Those two go to ask with a seed, never to allow (M2). Anything else: null.
function exactRule(/** @type {string} */ tool, /** @type {any} */ input) {
  if (tool === 'Bash') {
    const c = input?.command;
    return typeof c === 'string' && c.trim() && c.length <= TEXT_MAX && !/[*\r\n]/.test(c) ? `Bash(${c})` : null;
  }
  if (tool === 'WebFetch') {
    let host = '';
    try { host = new URL(String(input?.url)).hostname; } catch { /* null below */ }
    return /^[a-z0-9.-]{1,253}$/i.test(host) && !/^[\d.]+$|(^|\.)localhost\.?$|\.local\.?$/i.test(host) ? `WebFetch(domain:${host})` : null;
  }
  return /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,128}$/.test(tool) ? tool : null;
}

// One request on ticket id → a promise of claude's permission answer ({behavior: allow, updatedInput} | {behavior:
// deny, message}); null when the caller went away first (signal). kind: ask (the approve tool) | push | remote (tb-git).
// seeds (the run's approve socket, M2): one whose tool + shown input equal this request's → allow at once, used up.
// min: the wait (the run's spawn read it: claude's MCP timeout is set from it), else the config's now
function request(/** @type {string} */ id, /** @type {{kind?: string, tool: string, input: any, reason?: string}} */ r, /** @type {AbortSignal | undefined} */ signal, /** @type {{tool: string, text: string}[] | null} */ seeds = null, /** @type {number | null} */ min = null) {
  if (signal?.aborted) return Promise.resolve(null);
  const s = seeds ? seeds.findIndex((x) => x.tool === r.tool && x.text === shown(r.tool, r.input)) : -1;
  if (s >= 0) {
    seeds?.splice(s, 1);
    return Promise.resolve({ behavior: 'allow', updatedInput: r.input });
  }
  const text = JSON.stringify(r.input ?? {});
  const key = `${r.kind ?? 'ask'}\0${r.tool}\0${text}`;
  return new Promise((resolve) => {
    let p = [...pending.values()].find((x) => x.ticket === id && x.key === key); // the same action asked again: joins it
    if (!p) {
      if ([...pending.values()].filter((x) => x.ticket === id).length >= MAX_PENDING) return resolve(DENY(`${MAX_PENDING} actions already wait for Irfan on this ticket; try again later`));
      const mins = min ?? minutes();
      const long = Buffer.byteLength(text) > SHOW_MAX;
      const show = long ? null : shown(r.tool, r.input);
      const hidden = !!show && (HIDDEN.test(show) || show.split('\n').length > 12); // r3: a tall input scrolls its tail out of the card
      const q = { aid: newId('a'), ticket: id, key, input: r.input, long, hidden, waiters: new Set(), timer: null };
      p = q;
      pending.set(q.aid, q);
      q.timer = setTimeout(() => settle(q.aid, 'timeout', DENY(`Irfan did not answer in ${mins} minutes`)), Number(process.env.TB_APPROVE_MS) || mins * 60_000);
      q.timer.unref?.();
      const why = typeof r.reason === 'string' ? r.reason : typeof r.input?.description === 'string' ? r.input.description : '';
      const rec = { id: q.aid, at: iso(), kind: r.kind ?? 'ask', tool: r.tool, input_text: show, ...(long && { too_long: true }), ...(hidden && { hidden: true }), ...(why && { reason: why.slice(0, 500) }), status: 'pending' };
      S().updateTicket(id, (k) => ({ ...k, approvals: trim([...(k.approvals ?? []), rec]), waiting: { reason: 'approve', since: rec.at } }))
        .catch((e) => settle(q.aid, 'gone', DENY(`the board could not ask Irfan: ${e.message}`)));
    }
    const w = p;
    if (w.waiters.size >= MAX_WAITERS) return resolve(DENY(`${MAX_WAITERS} callers already wait on this same action`));
    // L12: the end (settle or abort) removes the other one: a long-lived connection keeps no listener per request
    const gone = () => {
      w.waiters.delete(done);
      resolve(null);
      if (!w.waiters.size) settle(w.aid, 'gone', null);
    };
    const done = (/** @type {any} */ d) => {
      signal?.removeEventListener('abort', gone);
      resolve(d);
    };
    w.waiters.add(done);
    signal?.addEventListener('abort', gone, { once: true });
  });
}

// The one end of a request: off the queue at once (a second answer finds nothing: 409), every waiter answered, then the
// ticket's record (status, answered_at, input_text cut to ANSWERED_MAX; once none of the ticket's waits: waiting
// blocked_action while a block is open, else cleared). actor: Irfan's answer → an interventions row in the same write.
function settle(/** @type {string} */ aid, /** @type {string} */ status, /** @type {any} */ decision, /** @type {string | null} */ actor = null) {
  const p = pending.get(aid);
  if (!p) return Promise.resolve();
  pending.delete(aid);
  clearTimeout(p.timer);
  for (const w of p.waiters) w(decision); // decision null ('gone') only once no waiter is left
  p.waiters.clear();
  const at = iso();
  const fn = (/** @type {any} */ k) => ({ ...k, approvals: (k.approvals ?? []).map((a) => (a.id === aid ? answered(a, { status, answered_at: at }) : a)),
    ...(!waiting(p.ticket) && k.waiting?.reason === 'approve' && { waiting: (k.blocked_actions ?? []).some((b) => b?.status === 'open') ? { reason: 'blocked_action', since: at } : null }) });
  const write = actor ? S().intervention(p.ticket, { actor, verb: 'approve-action', payload: { aid, yes: status === 'yes' } }, fn) : S().updateTicket(p.ticket, fn);
  return write.then(() => {}, (e) => console.error(`tbd: ${p.ticket}: approval ${aid} ${status} not saved: ${e.message}`));
}

// Irfan's answer (http, tb approve-action): aid must be on ticket id (else 404) and still waiting (else 409, no replay);
// Yes = allow with exactly the input the card showed (never for one too long to show, or one a blank run or carriage
// return could hide part of: L4). → the ticket.
async function answer(/** @type {string} */ id, /** @type {string} */ aid, /** @type {boolean} */ yes, /** @type {string} */ actor) {
  const rec = (S().getTicket(id).approvals ?? []).find((a) => a?.id === aid);
  if (!rec) throw new TbError(404, `${id}: no approval ${String(aid).slice(0, 40)}`);
  const p = pending.get(aid);
  if (!p || p.ticket !== id) throw new TbError(409, `${id}: approval ${aid} is ${rec.status === 'pending' ? 'gone' : rec.status}: nothing to answer`);
  if (yes && p.long) throw new TbError(409, `${id}: approval ${aid} is too long to show: only No`);
  if (yes && p.hidden) throw new TbError(409, `${id}: approval ${aid} holds a carriage return or a long blank run that can hide part of it: only No`);
  await settle(aid, yes ? 'yes' : 'no', yes ? { behavior: 'allow', updatedInput: p.input } : DENY('Irfan said no'), actor);
  return S().getTicket(id);
}

// tb-git's ask (lib/slots.js approve.ask: the run key + pid checked there): its run → its ticket. → the decision, null
async function ask(/** @type {{runId: string, kind: string, text: string}} */ r, /** @type {AbortSignal} */ signal) {
  if (S().config.terminal?.git_bridge !== true) throw new Error('the git bridge is off (terminal.git_bridge)');
  return request(r.runId.slice(0, r.runId.lastIndexOf('.')), { kind: r.kind, tool: 'tb-git', input: { text: r.text } }, signal);
}

// The approve tool server of run key (`${id}-${n}`) on sock (absolute, ≤ 103 bytes: never a path relative to the
// agent's cwd). Each nc is one connection; a closed one cancels what it asked. seeds (M2): this run's one-shot yeses,
// gone with the run. min: the run's terminal.approve_min (its spawn's, as claude's MCP timeout).
async function listen(/** @type {string} */ sock, /** @type {string} */ key, /** @type {string} */ id, /** @type {{tool: string, text: string}[]} */ seeds = [], /** @type {number | null} */ min = null) {
  if (Buffer.byteLength(sock) > SOCK_MAX) throw new Error(`approve socket ${sock} is over ${SOCK_MAX} bytes: use a shorter TB_HOME`);
  close(key);
  await fsp.rm(sock, { force: true });
  const conns = new Set();
  const srv = net.createServer((c) => serve(c, id, conns, seeds, min));
  srv.maxConnections = 8;
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(sock, () => resolve(undefined));
  });
  srv.on('error', (e) => console.error(`tbd: ${key}: approve socket: ${e.message}`));
  await fsp.chmod(sock, 0o600); // its dir is 0700: the moment before this is not exposed
  srv.unref();
  servers.set(key, { srv, conns });
}
function close(/** @type {string} */ key) {
  const s = servers.get(key);
  if (!s) return;
  servers.delete(key);
  s.srv.close();
  for (const c of s.conns) c.destroy();
}

// MCP JSON-RPC, one JSON object a line (the shapes the spike measured): initialize, tools/list, tools/call approve, ping;
// a notification is dropped, anything else answered -32601 (claude's server/discover probe falls back on it)
function serve(/** @type {net.Socket} */ c, /** @type {string} */ id, /** @type {Set<net.Socket>} */ conns, /** @type {{tool: string, text: string}[]} */ seeds, /** @type {number | null} */ min) {
  conns.add(c);
  const gone = new AbortController();
  c.on('close', () => { conns.delete(c); gone.abort(); });
  c.on('error', () => {}); // claude went away: close above cancels its request
  c.setEncoding('utf8');
  const send = (/** @type {any} */ o) => { if (!c.destroyed) c.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); };
  const call = async (/** @type {any} */ a) => {
    if (!isObj(a) || typeof a.tool_name !== 'string' || !a.tool_name || a.tool_name.length > 200 || !isObj(a.input)) return DENY('the board could not read this permission request');
    return request(id, { tool: a.tool_name, input: a.input }, gone.signal, seeds, min);
  };
  let buf = '';
  c.on('data', (/** @type {string} */ d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!isObj(m) || m.id === undefined || m.id === null) continue;
      const rid = m.id;
      if (m.method === 'initialize') send({ id: rid, result: { protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tb', version: '1' } } });
      else if (m.method === 'tools/list') send({ id: rid, result: { tools: [TOOL] } });
      else if (m.method === 'ping') send({ id: rid, result: {} });
      else if (m.method === 'tools/call' && m.params?.name === 'approve') {
        call(m.params.arguments).then((r) => { if (r) send({ id: rid, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } }); });
      } else send({ id: rid, error: { code: -32601, message: `no method ${String(m.method).slice(0, 60)}` } });
    }
    if (buf.length > LINE_MAX) c.destroy();
  });
}

// auto mode's classifier blocks of a live run (lib/stream.js tail: {id, tool, input | null, reason}) → blocked_actions
// (the newest 20 answered kept, every open one, each {id, at, tool, input_text ≤ 2000, reason, rule, phase + session:
// the run's lease (M3), status open}) + waiting blocked_action (Needs You), never over a waiting Approve card's
async function blocked(/** @type {string} */ id, /** @type {any[]} */ items, /** @type {any} */ lease = null) {
  const at = iso();
  const add = items.map((b) => {
    const text = b.input ? shown(b.tool, b.input) : '(the input was not seen)';
    return { id: newId('b'), at, tool: b.tool, input_text: text.slice(0, TEXT_MAX), reason: String(b.reason ?? '').slice(0, 500),
      rule: b.input && text.length <= TEXT_MAX ? exactRule(b.tool, b.input) : null, ...(lease && { phase: lease.phase, session: lease.session }), status: 'open' };
  });
  await S().updateTicket(id, (k) => ({ ...k, blocked_actions: trim([...(k.blocked_actions ?? []), ...add], 'open').slice(-OPEN_MAX),
    waiting: k.waiting?.reason === 'approve' ? k.waiting : { reason: 'blocked_action', since: at } }));
}

// Allow and retry / Dismiss on blocked action bid of ticket id (bid must be on id: else 404; still open: else 409). Allow:
// to allow_once (≤ 10) in the same write as the interventions row: Bash its exact rule, WebFetch / MCP {ask: its rule,
// tool, text: its input as shown} (M2); then Irfan's note resumes the same session (note: runner.note, its own guards
// checked here first, in the write), a fixed text (M3: never the agent's input). Review M3: only while the next run
// resumes the blocked session (resumes), else 409. → {live} of the note.
async function decideBlocked(/** @type {string} */ id, /** @type {string} */ bid, /** @type {boolean} */ allow, /** @type {string} */ actor, /** @type {Function | null} */ note = null) {
  let text = '';
  const ticket = await S().intervention(id, { actor, verb: allow ? 'allow-blocked' : 'dismiss-blocked', payload: { bid } }, (k) => {
    const b = (k.blocked_actions ?? []).find((x) => x?.id === bid);
    if (!b) throw new TbError(404, `${id}: no blocked action ${String(bid).slice(0, 40)}`);
    if (b.status !== 'open') throw new TbError(409, `${id}: blocked action ${bid} is ${b.status}`);
    if (allow && !b.rule) throw new TbError(409, `${id}: the board cannot allow exactly this action (a * or line break, too long, a local or IP host, or not Bash, WebFetch or an MCP tool): run it from your terminal, or Dismiss`);
    if (allow && (k.state === 'done' || k.state === 'cancelled')) throw new TbError(409, `${id}: ${k.state}: no run takes it`);
    if (allow && !resumes(k, b)) throw new TbError(409, `${id}: the blocked run is over: run it from your terminal, or Dismiss`);
    if (allow && (k.notes ?? []).length >= 10) throw new TbError(409, `${id}: 10 notes already wait for the next run`);
    text = `Irfan allowed the ${b.tool} call that auto mode blocked (board id ${b.id}). Retry that same call once, unchanged. Nothing else is newly allowed.`;
    const list = k.blocked_actions.map((x) => (x.id === bid ? { ...x, status: allow ? 'allowed' : 'dismissed', answered_at: iso() } : x));
    const open = list.some((x) => x.status === 'open');
    const once = b.tool === 'Bash' ? b.rule : { ask: b.rule, tool: b.tool, text: b.input_text };
    return { ...k, blocked_actions: list, ...(allow && { allow_once: [...(k.allow_once ?? []), once].slice(-10) }), ...(!open && k.waiting?.reason === 'blocked_action' && { waiting: null }) };
  });
  return allow && note ? { live: (await note(id, text, actor)).live } : { ticket };
}

// L-start: allow_once that reached no run (a start that failed before its spawn, or re-review L3 one that started a new
// session): per allow (Bash: its rule; WebFetch / MCP: {ask, tool, text}) the newest block it came from opens again with
// why, its retry note (decideBlocked's text names the block id) leaves t.notes unless keep (a run's prompt holds them:
// lease.notes counts them by place), and the ticket waits blocked_action
function reopen(/** @type {any} */ k, /** @type {any[]} */ once, /** @type {string} */ why, keep = false) {
  const list = [...(k.blocked_actions ?? [])];
  const ids = new Set();
  for (const x of once) {
    const i = list.findLastIndex((b) => b?.status === 'allowed' && !ids.has(b.id) && (typeof x === 'string' ? b.tool === 'Bash' && x === b.rule : x?.ask === b.rule && x.tool === b.tool && x.text === b.input_text));
    if (i < 0) continue;
    ids.add(list[i].id);
    list[i] = { ...list[i], status: 'open', answered_at: null, note: why };
  }
  if (!ids.size) return {};
  const notes = (k.notes ?? []).filter((n) => ![...ids].some((id) => String(n?.text).includes(`(board id ${id})`)));
  return { blocked_actions: list, ...(!keep && { notes: notes.length ? notes : undefined }), waiting: k.waiting?.reason === 'approve' ? k.waiting : { reason: 'blocked_action', since: iso() } };
}

// Boot: requests from before a restart are gone with their callers (claude's nc died with the old socket, spike g):
// marked lost, the ticket says why
async function boot() {
  for (const t of S().listTickets()) {
    if (!(t.approvals ?? []).some((a) => a?.status === 'pending')) continue;
    await S().updateTicket(t.id, (k) => ({ ...k, approvals: (k.approvals ?? []).map((a) => (a?.status === 'pending' ? answered(a, { status: 'lost', note: 'could not ask you: board restarted' }) : a)),
      ...(k.waiting?.reason === 'approve' && { waiting: (k.blocked_actions ?? []).some((b) => b?.status === 'open') ? { reason: 'blocked_action', since: iso() } : null }) })).catch((e) => console.error(`tbd: ${t.id}: lost approvals not marked: ${e.message}`));
  }
}

module.exports = { ASK, askRules, askNote, exactRule, request, answer, ask, listen, close, waiting, blocked, decideBlocked, resumes, reopen, boot };
