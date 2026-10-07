'use strict';
// notify: Mac banner + Glass sound when a ticket waits on you (D3), re-ping every notify.reping_min,
// silent in notify.quiet hours with one summary when they end (D28), and the v1 "Do now" reminders at
// remind_at on weekdays (server.js port). Driven by store ticket events + one 20 s tick; clock and exec
// are injectable for tests. TB_NOTIFY=0 turns every banner and sound off.
const { execFile } = require('node:child_process');

const WAIT_STATES = ['clarify', 'plan_approval', 'blocked'];
const WAIT_REASONS = ['manual', 'needs_scope'];
const LABEL = {
  clarify: 'Questions for you',
  plan_approval: 'Plan ready to approve',
  blocked: 'Blocked',
  manual: 'Waiting on you: manual step',
  needs_scope: 'Waiting on you: scope',
};
const OPTS = { timeout: 10_000 };
// What a ticket waits on you for, or null. Takes a ticket or a store `ticket` event ({id, state, waiting}).
const waitsFor = (t) => (WAIT_STATES.includes(t.state) ? t.state : WAIT_REASONS.includes(t.waiting?.reason) ? t.waiting.reason : null);

// Wall clock in tz: { date: 'YYYY-MM-DD', hhmm: 'HH:MM', weekend }.
function local(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

/** @param {{store: any, exec?: (file: string, args: string[], opts: object, cb: Function) => any, now?: () => number, enabled?: boolean}} deps */
function createNotifier({ store, exec = execFile, now = () => Date.now(), enabled = process.env.TB_NOTIFY !== '0' }) {
  const quietRange = store.config.notify?.quiet ?? '';
  if (quietRange && !/^\d\d:\d\d-\d\d:\d\d$/.test(quietRange)) throw new Error(`config notify.quiet must look like 22:00-07:00, got "${quietRange}"`);
  const [from, to] = quietRange.split('-');
  // HH:MM strings compare in time order; a range like 22:00-07:00 wraps past midnight.
  const quiet = (hhmm) => Boolean(quietRange) && (from > to ? hhmm >= from || hhmm < to : hhmm >= from && hhmm < to);
  const tracked = new Map(); // ticket id -> { why, title, last } (last = ms of the last banner)
  let wasQuiet = false;
  let lastFired = '';

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

  function onTicket(e) {
    const why = waitsFor(e);
    if (!why) return void tracked.delete(e.id);
    if (tracked.get(e.id)?.why === why) return;
    const t = now();
    const entry = { why, title: store.getTicket(e.id).title, last: t };
    tracked.set(e.id, entry);
    if (quiet(local(t, store.tz).hhmm)) wasQuiet = true; // held for the summary when quiet hours end
    else notify({ title: LABEL[why], message: entry.title });
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
      if (tracked.size) {
        notify({ title: `${tracked.size} waiting on you`, message: [...tracked.values()].map((w) => w.title).join(' · ') });
        for (const w of tracked.values()) w.last = t;
      }
    }
    const reping = (store.config.notify?.reping_min ?? 30) * 60_000;
    for (const w of tracked.values()) {
      if (t - w.last < reping) continue;
      w.last = t;
      notify({ title: `Still waiting: ${LABEL[w.why]}`, message: w.title });
    }
    const key = `${date} ${hhmm}`;
    if (!weekend && (store.config.remind_at ?? []).includes(hhmm) && key !== lastFired) {
      lastFired = key;
      doNow();
    }
  }

  // Tickets already waiting at startup are tracked silently; they re-ping on the normal schedule.
  function start() {
    const t = now();
    for (const k of store.listTickets()) if (waitsFor(k)) tracked.set(k.id, { why: waitsFor(k), title: k.title, last: t });
    wasQuiet = quiet(local(t, store.tz).hhmm);
    store.on('ticket', onTicket);
    setInterval(tick, 20_000).unref(); // 20 s: every remind_at minute gets at least one tick (v1)
  }

  return { start, tick, notify, doNow };
}

module.exports = { createNotifier };
