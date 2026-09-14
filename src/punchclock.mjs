// The punch clock: how the office's time was actually spent.
//
// Every desk already says how long it has been in its current state, which
// answers "is this one stuck right now" and nothing else. It cannot tell you that
// the desk has been up for two hours and worked for eleven minutes of them, or
// that the office spent forty minutes today waiting on a human who was in a
// meeting. Those are the numbers that change what you do next, and none of them
// cost a single call: they are all derivable from the status changes the office is
// already polling for.
//
// The accounting is done off the status-change timestamps rather than by adding up
// poll intervals, so the numbers do not depend on the poll rate and cannot drift
// when a refresh is slow: an interval is closed with the timestamp herdr gave for
// the change that ended it.
//
// Nothing in here is persisted. The clock starts when you open the office and the
// numbers are about this session, which is why they are labelled that way. A
// "today" that quietly reset whenever the office was reopened, or spanned
// midnight, would be a worse lie than a smaller true number.
const BUCKETS = ['working', 'blocked', 'idle', 'done', 'unknown'];

const zero = () => ({ working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 });

const addInto = (into, from) => {
  for (const key of BUCKETS) into[key] += from[key] || 0;
  return into;
};

export class Clocks {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.opened = clock();
    // Live desks. Keyed by pane id, like everything else in the office.
    this.desks = new Map();
    // Time that belonged to desks which have since closed. Folded in here so the
    // office totals only ever go up: a pane closing did not un-spend the hour it
    // spent working, and a number that fell when somebody tidied up their tabs
    // would be read as a bug in the office rather than as a closed tab.
    this.closed = { spent: zero(), hands: 0, longest: 0, desks: 0 };
    // Answers the OFFICE sent, not prompts that resolved. This is the one number
    // here that is about you rather than about the agents, and it is only honest
    // because the office knows exactly when it sent the keys itself.
    this.answers = 0;
  }

  answer() {
    this.answers += 1;
  }

  // Fold in everything that has happened since the last look. Safe to call as
  // often as you like: it only moves anything when a status change has closed an
  // interval, so calling it twice in a row is a no-op.
  observe(people = [], now = this.clock()) {
    const seen = new Set();
    for (const person of Array.isArray(people) ? people : []) {
      if (!person?.id) continue;
      seen.add(person.id);
      const status = BUCKETS.includes(person.status) ? person.status : 'unknown';
      // `since` is when herdr says this state was entered, which for a desk the
      // office has only just met is the moment it met it. That is the honest floor
      // on a shift: claiming a desk has been up for two hours because its agent
      // was would be inventing time the office never watched.
      const since = Number.isFinite(person.since) ? person.since : now;
      let entry = this.desks.get(person.id);
      if (!entry) {
        entry = { firstSeen: Math.min(since, now), status, since, spent: zero(), hands: 0, longest: 0 };
        this.desks.set(person.id, entry);
        // A hand that was already up when the office opened still counts: it is a
        // hand up, you are about to deal with it, and pretending otherwise would
        // make the count disagree with the floor in front of you.
        if (status === 'blocked') entry.hands += 1;
        continue;
      }
      if (entry.status === status && entry.since === since) continue;
      // The interval that just ended ran from where it started to where herdr says
      // the next one began. Clamped at zero because a server clock that stepped
      // backwards must not hand out negative time.
      const spent = Math.max(0, since - entry.since);
      entry.spent[entry.status] += spent;
      if (entry.status === 'blocked') entry.longest = Math.max(entry.longest, spent);
      // Anything that got us this far is a change herdr reported, so a desk that is
      // still blocked with a later `since` is a NEW prompt at the same desk rather
      // than the same one being seen twice: that is exactly what the sequence number
      // behind `since` means, and it is a second hand you had to answer.
      if (status === 'blocked') entry.hands += 1;
      entry.status = status;
      entry.since = since;
    }
    // Desks that have gone. Their open interval is closed at `now`, which is the
    // last moment the office can honestly say they were there.
    for (const [id, entry] of [...this.desks]) {
      if (seen.has(id)) continue;
      const spent = Math.max(0, now - entry.since);
      entry.spent[entry.status] += spent;
      if (entry.status === 'blocked') entry.longest = Math.max(entry.longest, spent);
      addInto(this.closed.spent, entry.spent);
      this.closed.hands += entry.hands;
      this.closed.longest = Math.max(this.closed.longest, entry.longest);
      this.closed.desks += 1;
      this.desks.delete(id);
    }
  }

  // One desk's card. The open interval is added in on the way out rather than
  // being folded into the buckets, so reading the numbers never changes them.
  desk(id, now = this.clock()) {
    const entry = this.desks.get(id);
    if (!entry) return null;
    const open = Math.max(0, now - entry.since);
    const spent = addInto(zero(), entry.spent);
    spent[entry.status] += open;
    return {
      onShift: Math.max(0, now - entry.firstSeen),
      spent,
      worked: spent.working,
      waiting: spent.blocked,
      hands: entry.hands,
      longest: entry.status === 'blocked' ? Math.max(entry.longest, open) : entry.longest,
    };
  }

  // The whole office, for the whiteboard.
  office(now = this.clock()) {
    const spent = addInto(zero(), this.closed.spent);
    let hands = this.closed.hands;
    let longest = this.closed.longest;
    for (const entry of this.desks.values()) {
      addInto(spent, entry.spent);
      spent[entry.status] += Math.max(0, now - entry.since);
      hands += entry.hands;
      longest = Math.max(longest, entry.status === 'blocked' ? Math.max(entry.longest, now - entry.since) : entry.longest);
    }
    return {
      open: Math.max(0, now - this.opened),
      spent,
      worked: spent.working,
      waiting: spent.blocked,
      hands,
      answers: this.answers,
      longest: Math.max(0, longest),
      desks: this.desks.size,
      // Desks that have been and gone, so "4 desks" on the whiteboard is not read
      // as "and never anybody else".
      closed: this.closed.desks,
    };
  }
}
