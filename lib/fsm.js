'use strict';
// fsm: the flow transition table (spec §4 + plan §3b) and the only code that changes a ticket's state.
// check() is pure: guards come from ctx by name, a missing guard denies. transition() adds the
// built-in GUARDS (need no runner) and saves through store.updateTicket.
const { TbError } = require('./errors');
const phases = require('./phases');

const ACTIVE = ['backlog', 'planning', 'clarify', 'plan_approval', 'working', 'review', 'qa', 'final_gate']; // flow order
const STATES = [...ACTIVE, 'done', 'blocked', 'cancelled'];
const PHASES = ['planning', 'working', 'review', 'qa', 'final_gate'];
const AGENT = ['planning', 'working', 'review', 'qa']; // phases that run an agent (spec §5, App A models)
const KINDS = ['code', 'research', 'brainstorm', 'design'];
const QA = ['code', 'research', 'design']; // brainstorm skips qa

/** @type {{from: string, to: string, by: string, guard: string|string[]|null, kinds?: string[]}[]} */
const TABLE = [
  { from: 'backlog', to: 'planning', by: 'you', guard: 'assign' },
  { from: 'planning', to: 'clarify', by: 'runner', guard: 'questions' },
  { from: 'clarify', to: 'planning', by: 'you', guard: 'answers_complete' },
  { from: 'planning', to: 'plan_approval', by: 'runner', guard: 'plan_valid' },
  { from: 'plan_approval', to: 'working', by: 'you', guard: 'approve' },
  { from: 'plan_approval', to: 'planning', by: 'you', guard: 'comment_saved' },
  { from: 'working', to: 'clarify', by: 'runner', guard: 'task_needs' },
  { from: 'clarify', to: 'working', by: 'you', guard: 'answer_added' },
  { from: 'clarify', to: 'planning', by: 'you', guard: 'changes_plan' },
  { from: 'working', to: 'review', by: 'runner', guard: 'working_gate' },
  { from: 'review', to: 'qa', by: 'runner', guard: 'no_blocking', kinds: QA },
  { from: 'review', to: 'final_gate', by: 'runner', guard: 'no_blocking', kinds: ['brainstorm'] },
  { from: 'qa', to: 'final_gate', by: 'runner', guard: 'qa_gate', kinds: QA },
  { from: 'final_gate', to: 'done', by: 'runner', guard: 'final_gate' },
  { from: 'review', to: 'working', by: 'runner', guard: 'rework' },
  { from: 'qa', to: 'working', by: 'runner', guard: 'rework', kinds: QA },
  { from: 'final_gate', to: 'working', by: 'runner', guard: 'rework' },
  // §3b `tb pass`: you stand in for a phase the live code can't run yet (final also needs --sha on main)
  { from: 'review', to: 'qa', by: 'you', guard: 'phase_unbuilt', kinds: QA },
  { from: 'review', to: 'final_gate', by: 'you', guard: 'phase_unbuilt', kinds: ['brainstorm'] },
  { from: 'qa', to: 'final_gate', by: 'you', guard: 'phase_unbuilt', kinds: QA },
  { from: 'final_gate', to: 'done', by: 'you', guard: ['phase_unbuilt', 'sha_on_main'] },
  ...ACTIVE.map((from) => ({ from, to: 'blocked', by: 'runner', guard: null })),
  ...PHASES.map((to) => ({ from: 'blocked', to, by: 'you', guard: 'resume', ...(to === 'qa' && { kinds: QA }) })),
  ...[...ACTIVE, 'blocked'].map((from) => ({ from, to: 'cancelled', by: 'you', guard: null })),
];

// Guards that need no runner. Return true, or a reason string.
const GUARDS = {
  resume: (t, to) => ACTIVE.indexOf(to) <= ACTIVE.indexOf(t.blocked_from) || `resume only up to ${t.blocked_from}`,
  phase_unbuilt: (t) => !phases.built(t.kind, t.state) || `phase ${t.kind}/${t.state} is built; the runner moves it`,
};

function refusal(row, ticket, to, ctx) {
  for (const name of [].concat(row.guard ?? [])) {
    if (typeof ctx[name] !== 'function') return `guard ${name} unavailable`;
    const r = ctx[name](ticket, to, ctx);
    if (r !== true) return typeof r === 'string' ? r : `guard ${name} refused`;
  }
  return '';
}

function check(ticket, to, actor, ctx = {}) {
  const rows = TABLE.filter((r) => r.from === ticket.state && r.to === to && r.by === actor && (!r.kinds || r.kinds.includes(ticket.kind)));
  if (!rows.length) return { ok: false, reason: `${ticket.state} → ${to} is not allowed for ${actor}` };
  const reasons = [];
  for (const r of rows) {
    const reason = refusal(r, ticket, to, ctx);
    if (!reason) return { ok: true };
    reasons.push(reason);
  }
  return { ok: false, reason: reasons.join('; ') }; // clarify → planning has two rows: say why each failed
}

// The ticket after the move (pure; refused → TbError 409). The runner applies it inside its own lease
// compare-and-swap write, so state and lease change in one save (P3b recovery).
function move(t, to, actor, ctx = {}) {
  const res = check(t, to, actor, { ...GUARDS, ...ctx });
  if (!res.ok) throw new TbError(409, res.reason);
  // A wait reason belongs to the state it was set in. round: every move starts a new one, so the runner never takes
  // the lease of an earlier visit to a phase for this one (I9: planning again after Clarify is a new run and clock).
  const next = { ...t, state: to, waiting: null, round: (t.round ?? 0) + 1 };
  if (to === 'blocked') next.blocked_from = t.state;
  else if (t.state === 'blocked' && to !== 'cancelled') { // resume: fresh rework count
    next.rework = 0;
    delete next.blocked_from;
  }
  return next;
}

function transition(store, id, to, actor, ctx = {}) {
  return store.updateTicket(id, (t) => move(t, to, actor, ctx));
}

module.exports = { STATES, KINDS, AGENT, TABLE, GUARDS, check, move, transition };
