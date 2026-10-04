// The office manager: one real agent on the floor whose job is the rest of the floor.
//
// The manager is not a drawing. It is an ordinary herdr agent in an ordinary pane,
// started the same way a hire is, and the only thing that makes it the manager is
// that its tab is called `office-manager` (or that the office was started with
// `--manager=<pane id>`). Everything an agent can do it can still do: it raises a
// hand, it has a screen you can read, it can be focused, and `m` hands it a written
// brief of the office to work from.
//
// What is in here is the part with no terminal in it: which desk is the manager, the
// order the rest of the room needs attention in, and the brief that order turns into.
// The card on the floor draws `officeBrief` directly, so the manager's desk is useful
// the moment it exists, before the agent behind it has been asked anything. The
// prompt it is sent is built from the same list, so the card and the agent never
// work from two different readings of the room.

// The tab label that makes a desk the manager. A hire made with `M` gets this label,
// and any tab renamed to it is promoted, which is the low-ceremony way to make an
// agent you already have into the manager.
export const MANAGER_TAB = 'office-manager';

// What the manager's desk is called, in place of a name off the seat pool. Taking a
// pool name would shift every name after it, and Ada is Ada because she sits first
// among the people doing the work.
export const MANAGER_NAME = 'Manager';

const isManagerTab = (person) => String(person?.tabName || '').trim().toLowerCase() === MANAGER_TAB;

// Which desk is the manager, or null. A pane pinned by id wins, because somebody
// typed it; otherwise the first `office-manager` tab in floor order. Exactly one,
// always: two managers would be two first cards, which is no first card at all.
export function pickManager(people, pinned = '') {
  const list = Array.isArray(people) ? people : [];
  if (pinned) {
    const hit = list.find((p) => p?.id === pinned);
    if (hit) return hit.id;
  }
  return list.find(isManagerTab)?.id ?? null;
}

// The floor with the manager moved to the front. Stable for everybody else, so the
// rest of the room keeps the reading order herdr's own layout gave it.
export function managerFirst(people, managerId) {
  const list = Array.isArray(people) ? people : [];
  if (!managerId) return list;
  const boss = list.find((p) => p.id === managerId);
  if (!boss) return list;
  return [boss, ...list.filter((p) => p.id !== managerId)];
}

// The tiers, in the order a person should deal with them. A raised hand is
// somebody stopped until you act; working desks are where things are about to go
// right or wrong; finished work is waiting to be looked at; idle and unclassified
// desks are capacity, not problems.
const TIER = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const tierOf = (status) => TIER[status] ?? TIER.unknown;

// Within working, the desks most likely to go wrong next go first: a merge conflict
// is somebody about to be stuck, and a head over ninety per cent is somebody about
// to forget what they were doing.
const CONTEXT_HOT = 90;
const risk = (p) => (p.dirt?.conflicts ? 2 : 0) + ((p.head?.used ?? 0) >= CONTEXT_HOT ? 1 : 0);

// Every desk but the manager, in the order it needs you, each with a short reason.
// Longest-waiting first inside a tier, because the hand that has been up longest
// is the one costing the most.
export function priorities(people, { managerId = null, now = Date.now() } = {}) {
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.id !== managerId && !p.manager);
  return list
    .map((p) => ({ person: p, tier: tierOf(p.status), risk: risk(p), held: now - (p.since ?? now) }))
    .sort((a, b) => a.tier - b.tier || b.risk - a.risk || b.held - a.held)
    .map(({ person }) => ({ person, why: reason(person) }));
}

// The reason, in as few words as fit on a clipboard line. Built only from things the
// office already shows elsewhere: the bubble, the command off the allowlist, counts
// off git, the context number. Nothing new is read off anybody's screen for this.
export function reason(p) {
  const flags = [];
  if (p.dirt?.conflicts) flags.push('conflict');
  if ((p.head?.used ?? 0) >= CONTEXT_HOT) flags.push(`ctx ${p.head.used}%`);
  const tail = flags.length ? ` · ${flags.join(' · ')}` : '';
  switch (p.status) {
    case 'blocked':
      return `approve: ${p.ask || 'needs your OK'}`;
    case 'working':
      return `${p.command || 'working'}${tail}`;
    case 'done':
      return `${p.dirt?.files ? `done · ${p.dirt.files} to review` : 'done'}${tail}`;
    case 'idle':
      return `idle${p.dirt?.files ? ` · ${p.dirt.files} uncommitted` : ''}${tail}`;
    default:
      return `unsure${tail}`;
  }
}

// The one line on top of the clipboard: the counts, hands first. Empty tiers are
// left out, so a quiet office reads as a short sentence rather than a row of zeros.
export function headline(items) {
  const n = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const { person } of items) n[person.status in n ? person.status : 'unknown'] += 1;
  if (!items.length) return 'nobody else on the floor';
  const parts = [];
  if (n.blocked) parts.push(`${n.blocked} need${n.blocked === 1 ? 's' : ''} you`);
  if (n.working) parts.push(`${n.working} working`);
  if (n.done) parts.push(`${n.done} done`);
  if (n.idle) parts.push(`${n.idle} idle`);
  if (n.unknown) parts.push(`${n.unknown} unsure`);
  return parts.join(' · ');
}

// The whole brief, as the card draws it.
export function officeBrief(people, opts = {}) {
  const items = priorities(people, opts);
  return { headline: headline(items), items };
}

// What `B` sends the manager agent: the brief, as plain text it can reason over,
// and the job.
//
// The ask text is deliberately left out. Everything else here is either the office's
// own vocabulary or a number, but a bubble is a line off somebody's screen, and
// handing one agent's screen to another agent is a step further than drawing it on
// a wall the human is already looking at. The manager is told that a desk is
// waiting on an approval; the human can see what it is.
export function briefingPrompt(people, { managerId = null, now = Date.now() } = {}) {
  const { headline: top, items } = officeBrief(people, { managerId, now });
  const lines = items.map(({ person: p }, i) => {
    const facts = [p.status];
    if (p.status === 'blocked') facts.push('waiting on an approval from the human');
    if (p.status === 'working' && p.command) facts.push(`running ${p.command}`);
    if (p.branch) facts.push(`branch ${p.branch}`);
    if (p.dirt) facts.push(`${p.dirt.files} uncommitted${p.dirt.conflicts ? `, ${p.dirt.conflicts} conflicted` : ''}`);
    if (p.head?.used != null) facts.push(`context ${p.head.used}% full`);
    const where = [p.kind, p.tabName && `tab "${p.tabName}"`].filter(Boolean).join(', ');
    return `${i + 1}. ${p.name} (${where}): ${facts.join('; ')}`;
  });
  return [
    'You are the office manager for this Herdr session. The Herdr Office plugin has listed every other agent below,',
    'already in priority order: approvals and blocked agents first, then active work, then finished work, then idle.',
    '',
    `Office right now: ${top}.`,
    ...(lines.length ? lines : ['(no other agents on the floor)']),
    '',
    'Reply with a two or three sentence summary of what the office is doing, then a short numbered list of what',
    'the human should look at first and why. Do not type into, approve for, or change any other agent\'s pane.',
  ].join('\n');
}
