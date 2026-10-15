'use strict';
// notify: Mac banner + Glass sound when a ticket waits on you (D3), re-ping every notify.reping_min,
// silent in notify.quiet hours with one summary when they end (D28), and the v1 "Do now" reminders at
// remind_at on weekdays (server.js port). Driven by store ticket events + one 20 s tick; clock, exec, the monitor
// snapshot and a run's RAM need are injectable for tests. TB_NOTIFY=0 turns every banner and sound off.
// D-0079: a memory wait notifies at once too; its text is info, not a to-do (RAM needed, RAM free, biggest apps).
const { execFile } = require('node:child_process');
const path = require('node:path');
const sh = require('./sh');
const admission = require('./admission');
const metrics = require('./metrics');

const GB = 1024 ** 3;
const WAIT_STATES = ['clarify', 'plan_approval', 'blocked'];
const WAIT_REASONS = ['manual', 'needs_scope', 'memory'];
const LABEL = {
  clarify: 'Questions for you',
  plan_approval: 'Plan ready to approve',
  blocked: 'Blocked',
  manual: 'Waiting on you: manual step',
  needs_scope: 'Waiting on you: scope',
  memory: 'Waiting for RAM',
};
const OPTS = { timeout: 10_000 };
// What a ticket waits on you for, or null. Takes a ticket or a store `ticket` event ({id, state, waiting}).
const waitsFor = (t) => (WAIT_STATES.includes(t.state) ? t.state : WAIT_REASONS.includes(t.waiting?.reason) ? t.waiting.reason : null);

// ps -U <uid> -o rss=,comm= (rss KB) → "Google Chrome 1.4 GB, claude 0.8 GB, Spotify 0.2 GB": RSS summed per app (a
// program under /Applications/X.app/ is X, else its file name), the 3 biggest. Untrusted text: only names + numbers out.
function biggest(text) {
  const kb = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const app = /\/Applications\/([^/]+)\.app\//.exec(m[2])?.[1] ?? path.basename(m[2]);
    kb.set(app, (kb.get(app) ?? 0) + Number(m[1]));
  }
  return [...kb].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([app, k]) => `${app} ${(k / 1024 ** 2).toFixed(1)} GB`).join(', ');
}

// Wall clock in tz: { date: 'YYYY-MM-DD', hhmm: 'HH:MM', weekend }.
function local(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

/**
 * system: the monitor snapshot (avail bytes) or null; need: a run's expected RAM need in GB for a phase (the runner's).
 * @param {{store: any, exec?: (file: string, args: string[], opts: object, cb: Function) => any, now?: () => number, enabled?: boolean,
 *   system?: () => any, need?: (phase: string) => number}} deps
 */
function createNotifier({ store, exec = execFile, now = () => Date.now(), enabled = process.env.TB_NOTIFY !== '0',
  system = () => null, need = (phase) => admission.needGb(phase, metrics.runs(), store.config) }) {
  const quietRange = store.config.notify?.quiet ?? '';
  if (quietRange && !/^\d\d:\d\d-\d\d:\d\d$/.test(quietRange)) throw new Error(`config notify.quiet must look like 22:00-07:00, got "${quietRange}"`);
  const [from, to] = quietRange.split('-');
  // HH:MM strings compare in time order; a range like 22:00-07:00 wraps past midnight.
  const quiet = (hhmm) => Boolean(quietRange) && (from > to ? hhmm >= from || hhmm < to : hhmm >= from && hhmm < to);
  const tracked = new Map(); // ticket id -> { why, title, last } (last = ms of the last banner)
  let wasQuiet = false;
  let lastFired = '';
  const held = new Map(); // title → one-off alert raised in quiet hours (latest per title), sent when they end

  function notify({ title, message, subtitle = '', sound = true }) {
    if (!enabled) return false;
    const done = () => {};
    // text goes in as argv after `--`: quotes or a leading "-" in a title can't become AppleScript or options.
    // Absolute paths: a PATH entry can't swap in another binary.
    exec('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)', '-e', 'end run', '--', title, message, subtitle], OPTS, done);
    if (sound) exec('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], OPTS, done);
    return true;
  }

  // v1 server.js summary(): top `now` reminder + counts.
  function summary() {
    const today = local(now(), store.tz).date;
    const open = store.listReminders().filter((t) => t.status !== 'done');
    const nowCol = open.filter((t) => t.status === 'now');
    const overdue = open.filter((t) => t.due && t.due < today).length;
    const inbox = open.filter((t) => t.status === 'inbox').length;
    const top = nowCol[0] ? nowCol[0].title : 'Nothing in Now. Pick one from Next.';
    const extra = [`${nowCol.length} in Now`, overdue ? `${overdue} overdue` : '', inbox ? `${inbox} in Inbox` : ''].filter(Boolean).join(' · ');
    return { top, extra };
  }

  // "Do now" banner, no sound (as v1). Returned for POST /api/notify-test.
  function doNow() {
    const { top, extra } = summary();
    return { sent: notify({ title: 'Do now', message: top, subtitle: extra, sound: false }), top, extra };
  }

  // D-0079 memory wait text: the RAM a run of the ticket's phase needs (admission's sum: min_free_gb + need, + docker_reserved_gb
  // while Docker runs; left out when not a number), what the monitor saw free, the pressure when not normal, and the 3
  // biggest apps from ONE ps now (never per sample; its output is never logged). ps fails → numbers.
  async function ramText(id) {
    const m = store.config.memory;
    const snap = system();
    const n = m.min_free_gb + need(store.getTicket(id).state) + (snap?.docker ? m.docker_reserved_gb : 0);
    const has = snap?.avail == null ? '' : `, has ${(snap.avail / GB).toFixed(1)} GB`;
    const press = snap?.pressure && snap.pressure !== 'normal' ? `Memory pressure ${snap.pressure}. ` : '';
    const r = await sh('/bin/ps', ['-U', String(process.getuid()), '-o', 'rss=,comm='], OPTS, exec);
    const apps = r.err ? '' : biggest(String(r.stdout));
    return `${Number.isFinite(n) ? `Needs ${n.toFixed(1)} GB free to run${has}. ` : ''}${press}Starts by itself when RAM frees.${apps ? ` Biggest now: ${apps}` : ''}`;
  }

  // A wait's banner: the ticket title; a memory wait's is its RAM text (title as subtitle), made at send time and sent
  // only while that same wait is still tracked (ps takes a moment).
  function ping(id, w, title) {
    if (w.why !== 'memory') return void notify({ title, message: w.title });
    if (!enabled) return;
    ramText(id).then((message) => {
      if (tracked.get(id) === w) notify({ title, message, subtitle: w.title });
    }).catch((e) => console.error(`tbd: RAM wait banner for ${id}: ${e.message}`));
  }

  function onTicket(e) {
    const why = waitsFor(e);
    if (!why) return void tracked.delete(e.id);
    if (store.getTicket(e.id).lane_of) return; // X14: a lane is the parent's: no banner
    if (tracked.get(e.id)?.why === why) return;
    const t = now();
    const entry = { why, title: store.getTicket(e.id).title, last: t };
    tracked.set(e.id, entry);
    if (quiet(local(t, store.tz).hhmm)) wasQuiet = true; // held for the summary when quiet hours end
    else ping(e.id, entry, LABEL[why]);
  }

  function tick() {
    const t = now();
    const { date, hhmm, weekend } = local(t, store.tz);
    if (quiet(hhmm)) {
      wasQuiet = true;
      return;
    }
    if (wasQuiet) {
      wasQuiet = false;
      for (const a of held.values()) notify(a);
      held.clear();
      if (tracked.size) {
        const ws = [...tracked.values()];
        const ram = ws.filter((w) => w.why === 'memory').length; // a RAM wait is not on you
        const title = [ws.length - ram && `${ws.length - ram} waiting on you`, ram && `${ram} waiting for RAM`].filter(Boolean).join(', ');
        notify({ title, message: ws.map((w) => w.title).join(' · ') });
        for (const w of tracked.values()) w.last = t;
      }
    }
    const reping = (store.config.notify?.reping_min ?? 30) * 60_000;
    for (const [id, w] of tracked) {
      if (t - w.last < reping) continue;
      w.last = t;
      ping(id, w, `Still waiting: ${LABEL[w.why]}`);
    }
    const key = `${date} ${hhmm}`;
    if (!weekend && (store.config.remind_at ?? []).includes(hhmm) && key !== lastFired) {
      lastFired = key;
      doNow();
    }
  }

  // One-off alert {title, message} (disk, heavy slot revoked): sent now, or held until quiet hours end.
  function alert(a) {
    if (!quiet(local(now(), store.tz).hhmm)) return void notify(a);
    held.set(a.title, a);
    wasQuiet = true;
  }

  // Monitor `disk` event (one per downward crossing of disk.warn_gb / disk.stop_gb, spec §7); held in quiet hours.
  function disk({ band, disk_free }) {
    const message = `${(disk_free / 1024 ** 3).toFixed(1)} GB free. Run tb gc to free space.`;
    alert({ title: band === 'stop' ? 'Disk almost full: new runs stopped' : 'Disk space low', message });
  }

  // Tickets already waiting at startup are tracked silently; they re-ping on the normal schedule.
  function start() {
    const t = now();
    for (const k of store.listTickets()) if (!k.lane_of && waitsFor(k)) tracked.set(k.id, { why: waitsFor(k), title: k.title, last: t });
    wasQuiet = quiet(local(t, store.tz).hhmm);
    store.on('ticket', onTicket);
    setInterval(tick, 20_000).unref(); // 20 s: every remind_at minute gets at least one tick (v1)
  }

  return { start, tick, notify, doNow, disk, alert };
}

module.exports = { createNotifier };
