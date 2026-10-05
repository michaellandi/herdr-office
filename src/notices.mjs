// The office manager: the things somebody watching this floor would notice, and
// that nobody currently says out loud.
//
// Every fact in here is one the office already holds. It knows two desks are sitting
// in the same checkout, because it keys branches and uncommitted counts by working
// directory and has done since those features shipped. It knows two raised hands are
// asking the identical question, because it read both screens to draw both bubbles.
// It knows a head is nearly full, because it puts the number in the monitor's frame.
// It has never mentioned any of it, and the reason is structural rather than an
// oversight: every other thing the office draws is a fact about *one* desk, and
// these are facts about pairs of desks, or about one desk crossing a line. Neither
// has a field on anybody's card, so neither has ever had anywhere to go.
//
// Three rules hold this file up, and all three are about staying a reporter:
//
//   1. **A notice states a fact and does not give an instruction.** "Ada and Bo are
//      both in herdr-office" is true, and is the whole of what the office knows.
//      "Ada and Bo are about to clobber each other" is a guess about two agents'
//      intentions, and two agents deliberately sharing a checkout is a thing people
//      do on purpose. Whoever is reading this knows which one it is. The office does
//      not, and a warning that is wrong a third of the time gets ignored the other
//      two thirds.
//   2. **Only the last segment of a path is ever drawn.** A working directory is an
//      absolute path under somebody's home and this pane gets screen-shared, which
//      is the same rule src/summary.mjs already follows for manifest paths.
//   3. **Nothing here can act.** No socket, no clock, no writes, no state between
//      calls. It takes the roster the office has already built and returns
//      sentences. The keys that send real input to real agents are still the only
//      things that do, and none of them is in this file.
//
// The last one is why this is a separate module rather than a method on Roster:
// something that cannot do anything is much easier to believe, and the whole
// argument for shipping a "manager" at all is that this first version of one is
// provably incapable of managing.
import { sanitize, truncate, formatDuration } from './text.mjs';

// How long a desk has to have been stopped before its unfinished work is worth
// mentioning. Long enough that an agent between turns, or one waiting on a slow tool
// call, is never called stalled: those are seconds and this is a quarter of an hour.
export const STALL_MS = 900000;

// The point at which a context window is worth a sentence. The same 90 the monitor's
// frame already thickens at, because two different definitions of "nearly full" on
// one screen is one too many.
export const FULL_HEAD = 90;

// The longest a directory name may be in a notice. The footer truncates the whole
// line anyway, but it truncates from the right, and a 200 character directory name
// would push every word that matters off the end before the reader got to it.
const DIR_MAX = 24;

// A cwd is not sanitized on the way in (the roster only cleans titles), so a
// directory with an ambiguous-width glyph in its name would be a cell the grid did
// not budget for, in a string the footer is about to measure. Cleaned here rather
// than trusted, for the same reason every other screen-derived string is.
const dirName = (cwd) => truncate(sanitize(String(cwd || '').split('/').pop() || ''), DIR_MAX);

// Two asks are the same question when they differ only in case, spacing or a
// trailing full stop. They come off two different screens, and an approval prompt
// rendered two cells narrower on one pane than the other is the same prompt.
const sameQuestion = (ask) => String(ask || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.?!\s]+$/, '').trim();

function group(list, keyOf) {
  const out = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

// Names, as a person would say them, and never more than three of them: a notice
// that lists eleven names is a notice nobody finishes reading, and the count is the
// part that carries the alarm anyway.
function listNames(people) {
  const names = people.map((p) => p.name || p.id);
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// Somebody is actively holding a working tree open: editing it, or stopped mid-task
// with an approval pending and whatever they had already written still on disk. An
// idle or finished desk is excluded, because the thing worth saying is that two
// agents are *both moving* in one directory.
const busy = (p) => p.status === 'working' || p.status === 'blocked';

// Two agents in one working tree, which is the one notice here that is about damage
// rather than about attention. It is also the cheapest to be sure of: two desks with
// the same cwd are by definition the same checkout on the same branch, so there is
// no inference in it at all.
//
// The filter on a truthy cwd is doing more work than it looks like. A server that
// returns no working directory gives every desk the empty string, and without this
// the whole floor would group together and the office would announce a twelve-way
// collision in a directory it cannot name.
function collisions(people) {
  const out = [];
  for (const [cwd, crowd] of group(people, (p) => p.cwd)) {
    const active = crowd.filter(busy);
    if (active.length < 2) continue;
    const where = dirName(cwd);
    out.push({
      kind: 'collision',
      ids: active.map((p) => p.id),
      text: `${listNames(active)} ${active.length === 2 ? 'are both' : 'are all'} in ${where || 'one checkout'}`,
    });
  }
  return out;
}

// A head about to be emptied while its owner is still working. Worth saying because
// of what happens next rather than what is happening now: the agent compacts, loses
// the middle of its reasoning, and carries on with a summary of what it was doing.
// Which is survivable if you know, and mystifying if you do not.
function fullHeads(people) {
  return people
    .filter((p) => p.status === 'working' && Number.isFinite(p.head?.used) && p.head.used >= FULL_HEAD)
    .map((p) => ({ kind: 'full', ids: [p.id], text: `${p.name} is ${p.head.used}% full and still working` }));
}

// Two hands up on the same question, which is the one notice that is an opportunity
// rather than a problem: it is two keystrokes of work that looks like two separate
// interruptions. What they are asking is deliberately not repeated here, because it
// is already drawn in full in both bubbles and the footer has one line.
function sameAsks(people) {
  const out = [];
  const stuck = people.filter((p) => p.status === 'blocked' && p.ask);
  for (const crowd of group(stuck, (p) => sameQuestion(p.ask)).values()) {
    if (crowd.length < 2) continue;
    out.push({ kind: 'same-ask', ids: crowd.map((p) => p.id), text: `${listNames(crowd)} are stuck on the same thing` });
  }
  return out;
}

// A desk that stopped a while ago with unfinished work sitting in its checkout.
// Neither half is interesting alone: an idle agent has usually finished, and
// uncommitted files are what a working agent looks like. Together they are the shape
// of something that quietly gave up, which is the failure mode a floor of agents has
// that a floor of people does not, because a person would have said so.
//
// A duration the office is only guessing at is still allowed here, unlike in the
// escalation ladder, and for a reason rather than by oversight: an assumed
// `statusMs` is a *lower* bound, so a desk that crosses fifteen minutes on a guess
// has genuinely been idle at least that long. The guess can make this notice late.
// It cannot make it wrong.
// Grouped by checkout, which was not the first version and is the whole reason this
// function is longer than the others. Uncommitted files are a fact about a directory,
// not about a desk: `dirt` is keyed by cwd, so four desks parked in one repository all
// report the same count. Reported one desk at a time that came out as four lines each
// claiming ten uncommitted files, which reads as forty, and it was permanent, because
// a floor where several agents live in one checkout is the ordinary case rather than
// the exception. Four reports of one fact is exactly the noise this file is supposed
// not to make.
//
// The group line drops the duration that the single line carries. The threshold is
// already the claim that it has been a while, the names and the file count are the
// parts you act on, and the real clock for each desk is on the card `m` walks you to.
function stalls(people) {
  const stopped = people.filter((p) => p.status === 'idle' && (p.statusMs ?? 0) >= STALL_MS && (p.dirt?.files ?? 0) > 0);
  const byCheckout = group(stopped, (p) => p.cwd);
  const out = [];
  const spoken = new Set();
  for (const p of stopped) {
    if (spoken.has(p.id)) continue;
    // A desk the server gave no cwd for is its own crowd of one. It cannot have dirt in
    // practice, since dirt is read per directory, but the grouping above drops falsy
    // keys and a desk silently disappearing is worse than a redundant branch.
    const crowd = (p.cwd && byCheckout.get(p.cwd)) || [p];
    for (const q of crowd) spoken.add(q.id);
    // Off the first desk rather than summed, because it is one directory's count and
    // every desk in the crowd is reporting the same number.
    const files = `${p.dirt.files} file${p.dirt.files === 1 ? '' : 's'} uncommitted`;
    out.push(crowd.length > 1
      ? { kind: 'stalled', ids: crowd.map((q) => q.id), text: `${listNames(crowd)} stopped in ${dirName(p.cwd)} with ${files}` }
      : { kind: 'stalled', ids: [p.id], text: `${p.name} stopped ${formatDuration(p.statusMs)} ago with ${files}` });
  }
  return out;
}

// Everything worth saying about this floor, most important first.
//
// The order is the concatenation below, and it is an argument rather than a
// preference: a collision can destroy work that already exists, a full head is about
// to lose reasoning that only exists in one place, two identical hands are somebody
// waiting who could be unblocked twice over in one keystroke, and a stall is a thing
// that already happened and will keep. Within a kind the order is the floor's, which
// is the order the desks are drawn in, so a notice never moves for a reason that is
// not on screen.
//
// Takes `statusMs` off the people rather than a clock of its own, exactly as
// src/escalate.mjs does: the roster has just recomputed it, and two sources of "how
// long" that can disagree is one too many.
export function notices({ people = [] } = {}) {
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.id);
  return [...collisions(list), ...fullHeads(list), ...sameAsks(list), ...stalls(list)];
}
