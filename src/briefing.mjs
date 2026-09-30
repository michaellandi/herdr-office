// What happened at each desk that needs you, so that reading one card is an alternative
// to walking to four agents.
//
// This exists because of a specific complaint about the first version of the manager,
// which is worth writing down because it is the whole design brief: three desks were
// stopped in one checkout and the office said `1 THING` and one truncated sentence naming
// one of them. Every fact needed to explain all three was already in the roster. The
// manager had nowhere to put any of it, because it was built to fill a 27 cell status bar
// and the card was a bigger copy of that bar rather than a different thing.
//
// So the card is no longer a list of notices. It is one short account per desk, and the
// notice it came from is the account's first line. Nothing is lost by dropping the notice
// list: a fact about two desks is drawn twice, once from each desk's point of view, which
// is how it would be told. `Ada and Bo are both in herdr-office` becomes `sharing
// herdr-office with Bo` under Ada and `sharing herdr-office with Ada` under Bo.
//
// Two rules, inherited rather than invented:
//
//   1. **Every clause is a fact the office already holds, and none of them is a cause.**
//      "was doing X, tests failed 24m ago, 7 files uncommitted, said Y" is four things
//      that are true. "gave up because the tests failed" is a guess about an agent's
//      reasoning, and src/notices.mjs rule 1 says the office does not make those. The
//      order of the clauses is the nearest thing here to a narrative, and it is only an
//      order: whoever reads it is the one drawing the conclusion, which is the right way
//      round, because they know things about this work that the office does not.
//   2. **A clause is printed whole or cut once, and never split across rows.** The same
//      rule the reason on a notice follows. Half a quote ending mid-word at a row edge
//      reads as the office paraphrasing somebody, and it is not entitled to.
//
// Like notices.mjs and manager.mjs: no socket, no clock, no state. People and notices in,
// strings out. It cannot manage anything, which is still the entire argument for shipping
// a manager at all.
import { sanitize, truncate, formatDuration, width as cellWidth } from './text.mjs';
import { dirName, listNames } from './notices.mjs';
import { dirtWords } from './dirt.mjs';
import { headWords, pressure } from './head.mjs';

// The longest quote off somebody's screen a briefing will carry. Larger than the 36 a
// notice allows, and the difference is about room rather than about caution: a notice has
// to share one status line with a whole sentence, whereas a clause here gets a row of a
// panel to itself if it needs one. 44 is what src/summary.mjs already quotes a screen at
// on the detail card, so a desk's own words are the same length wherever you read them.
export const QUOTE_MAX = 44;

// How much of a pane title is worth repeating. A terminal title is author-controlled text
// and agents write essays in them; this is a clause in a sentence, not the sentence.
const TASK_MAX = 40;

const quote = (text, max = QUOTE_MAX) => truncate(sanitize(String(text || '')), max);

// A duration as a thing that happened rather than a thing that is elapsing. Anything
// inside a second is "just now": `tests failed 0s ago` is a clock reading, not news.
const ago = (ms) => (Number.isFinite(ms) && ms >= 1000 ? `${formatDuration(ms)} ago` : 'just now');

// The one line that says why this desk is on the card at all, phrased about this desk
// rather than about the group. This is where the crowd notices get taken apart: the notice
// says two names and the briefing says, to each of them, who the other one is.
//
// The stall line is the one that gains most from being per desk. The grouped notice drops
// the duration entirely, because four desks in one checkout have four different clocks and
// only one sentence, and this is where those four clocks fit.
function headline(notice, person, others) {
  // "stopped at least 0s ago" is three zeros where a real number is about to be, the same
  // noise src/render.mjs keeps off a card it has only just laid eyes on. It cannot happen
  // from a real stall, which is fifteen minutes old before it is a notice at all, so this
  // is a guard on the contract and not a live bug.
  const dwell = Number.isFinite(person.statusMs) && person.statusMs >= 1000
    ? `stopped ${person.assumedSince ? 'at least ' : ''}${formatDuration(person.statusMs)} ago`
    : 'has stopped';
  if (notice.kind === 'collision') {
    const where = dirName(person.cwd) || 'one checkout';
    return others.length ? `sharing ${where} with ${listNames(others)}` : `working in ${where}`;
  }
  if (notice.kind === 'full') {
    const used = Math.round(Number(person.head?.used));
    return Number.isFinite(used) ? `${used}% full and still working` : 'nearly full and still working';
  }
  if (notice.kind === 'same-ask') {
    return others.length ? `waiting on the same answer as ${listNames(others)}` : 'waiting on an answer';
  }
  if (notice.kind === 'stalled') return dwell;
  // Not reachable from notices(), and deliberately not a throw: a notice kind added there
  // and forgotten here should cost this desk its headline, not the whole card.
  return notice.text || '';
}

// The headline for a desk nothing has been noticed about, which is every desk on a quiet
// floor and most desks on a busy one. Only report() reaches this: the card briefs the
// noticed desks and nobody else, whereas a summary of what work is happening has to
// account for the seven desks where the answer is "fine, still going".
//
// Same vocabulary as the tile's status word, in a sentence rather than a chip. The dwell is
// the interesting half: `working for 2m00s` and `working for 3h10m` are the same status and
// very different pieces of news, and the second one is the one the office has no notice for
// because a long turn is not a stall.
const PLAIN = { working: 'working', blocked: 'waiting on an answer', done: 'done', idle: 'idle', unknown: 'status unknown' };

function plainHead(person) {
  const word = PLAIN[person.status] || PLAIN.unknown;
  if (!Number.isFinite(person.statusMs) || person.statusMs < 1000) return word;
  return `${word} for ${person.assumedSince ? 'at least ' : ''}${formatDuration(person.statusMs)}`;
}

// The account itself, in the order somebody would tell it: what the desk was asked to do,
// where, what it ran, what came of that, what it left behind, how full its head got, and
// the last thing it said. Missing facts drop out rather than becoming apologies, so a desk
// the office knows two things about gets two clauses and not five parenthetical nothings.
//
// Takes the notice's kind rather than the notice, because the only thing it wants from one
// is which clause the headline has already said, and a desk with no notice at all passes
// null and gets the full set.
function factsFor(kind, person) {
  const out = [];
  const task = quote(person.title, TASK_MAX);
  // Past tense for a desk that has stopped, because that is what the reader is being told:
  // this is what it *was* doing. A desk still typing is described in the present.
  const stopped = person.status === 'idle' || person.status === 'done';
  if (task) out.push(`${stopped ? 'was doing' : 'doing'} "${task}"`);

  // The checkout, with the branch first because the branch is the part that decides
  // whether somebody else's work is in danger. The directory is dropped when the headline
  // has already named it, rather than said twice in four rows.
  const place = person.repo || dirName(person.cwd);
  const where = [person.branch ? `on ${person.branch}` : '', place && kind !== 'collision' ? `in ${place}` : ''].filter(Boolean).join(' ');
  if (where) out.push(where);

  // Only ever present on a working desk: the roster drops the command the moment a desk
  // stops, on the grounds that a stale `npm test` on an idle monitor is a lie.
  if (person.command) out.push(`running ${person.command}`);

  // The most useful clause on the card and the reason src/roster.mjs now keeps an event
  // past its twelve seconds on the wall. "tests failed 24m ago" over a desk that has been
  // stopped for half an hour is most of the answer, and until now it was thrown away four
  // seconds after the only surface that drew it stopped drawing it.
  if (person.lastEvent?.label) out.push(`${person.lastEvent.label} ${ago(person.lastEvent.ageMs)}`);

  // The checkout's counts, not this desk's, exactly as the detail card's `changes` row.
  // Worth a clause even when it is `nothing uncommitted`: on a desk that stopped that is
  // the difference between work to rescue and nothing to do.
  const changes = dirtWords(person.dirt);
  if (changes) out.push(changes);

  // Only where it is part of the story. Every desk has a context window and most of them
  // are half empty, and a summary that spends a clause on `31% full` on every desk teaches
  // the reader to skip the row the interesting one is on. The `full` notice's headline
  // already says it, so it is not said twice there either.
  if (kind !== 'full' && ['hot', 'brimming'].includes(pressure(person.head?.used))) out.push(headWords(person.head));

  // Their own words, last, because they are the longest clause and the only one the office
  // did not write. A raised hand is quoted as a question and a stopped desk as a statement,
  // which is the difference between something you can answer and something you have to go
  // and look at.
  const said = person.status === 'blocked' ? quote(person.ask) : quote(person.said);
  if (said) out.push(person.status === 'blocked' ? `asks "${said}"` : `said "${said}"`);
  return out;
}

// One entry per desk any notice is about, most urgent first, each desk appearing once.
//
// The order is the notices' own order, which is already an argument about what matters (see
// the bottom of src/notices.mjs), and within a notice it is the floor's order.
//
// A desk in two notices appears once and says both. The office's most common pair is a
// full head in a shared checkout, and the alternative was two blocks about one person
// repeating the same four facts underneath two different headlines. The most urgent of its
// notices is the headline and the rest join the front of the account, where they wrap with
// everything else instead of running off the end of the name row.
//
// There are deliberately no numbers on this list, which is a change from the notice list it
// replaced. Numbers were the only handle a list of sentences had, and a desk has a name: a
// footer counting `3/4` through the notices names the same people the blocks here do. Once
// desks rather than notices are the unit, a number beside them can only be the index of the
// notice they were filed under, which skips whenever two notices are about one desk, and a
// list jumping from 2 to 4 is a reader looking for the missing one.
export function brief({ people = [], notices = [] } = {}) {
  const floor = new Map((Array.isArray(people) ? people : []).filter((p) => p && p.id).map((p) => [p.id, p]));
  // Which notices each desk is in, in the notices' own order, and the order the desks
  // themselves come out in, which is the order they were first mentioned.
  const mine = new Map();
  for (const notice of Array.isArray(notices) ? notices : []) {
    if (!notice) continue;
    for (const id of Array.isArray(notice.ids) ? notice.ids : []) {
      if (!floor.has(id)) continue;
      if (!mine.has(id)) mine.set(id, []);
      mine.get(id).push(notice);
    }
  }

  const out = [];
  for (const [id, list] of mine) {
    const person = floor.get(id);
    const said = (notice) => headline(notice, person, (notice.ids || []).filter((x) => x !== id).map((x) => floor.get(x)).filter(Boolean));
    out.push({
      id,
      name: person.name || id,
      kind: list[0].kind,
      head: said(list[0]),
      facts: [...list.slice(1).map(said), ...factsFor(list[0].kind, person)],
    });
  }
  return out;
}

// Every desk on the floor, the noticed ones first in brief()'s order and the rest in the
// floor's own order.
//
// This is the same accounts the card draws, for a different reader. The card answers "who
// needs me", so it briefs the desks something has been noticed about and stops. A summary of
// what work is happening has to cover the desk that is fine, because "six of them are fine"
// is most of the answer and it cannot be said by a function that only ever sees the other
// one. The quiet desks come last because the order is still an argument about what matters,
// and nothing here re-ranks the noticed ones: notices.mjs already did that.
//
// Pure, like everything else in this file. No socket, no clock, no state. Whether a desk
// belongs on the floor at all is the caller's question, which is how the manager keeps
// itself out of its own report without this module knowing a manager exists.
export function report({ people = [], notices = [] } = {}) {
  const noticed = brief({ people, notices }).map((account) => ({ ...account, noticed: true }));
  const seen = new Set(noticed.map((account) => account.id));
  const quiet = [];
  for (const person of Array.isArray(people) ? people : []) {
    if (!person || !person.id || seen.has(person.id)) continue;
    seen.add(person.id);
    quiet.push({
      id: person.id,
      name: person.name || person.id,
      // No notice, so no kind. Null rather than the status, because kind is what the
      // renderer colours a headline by and a status has its own colour already.
      kind: null,
      noticed: false,
      head: plainHead(person),
      facts: factsFor(null, person),
    });
  }
  return [...noticed, ...quiet];
}

// Clauses packed into rows of a given width, greedily, never splitting one.
//
// Width-aware and layout-unaware on purpose: how wide the room is belongs to the
// renderer, and which facts are worth saying belongs above. A wide pane gets one row of
// four clauses and a narrow one gets four rows of one, and the same briefing is behind
// both, which is what makes the card testable at every size in test/manager.test.mjs.
export function wrap(facts, room) {
  const rows = [];
  let line = '';
  for (const fact of Array.isArray(facts) ? facts : []) {
    // Cut here rather than at the row edge, so a clause too long for any row is one cut
    // clause and not a clause plus a sliver on the next row.
    const clause = truncate(String(fact || ''), room);
    if (!clause) continue;
    if (!line) {
      line = clause;
      continue;
    }
    const joined = `${line} · ${clause}`;
    if (cellWidth(joined) <= room) line = joined;
    else {
      rows.push(line);
      line = clause;
    }
  }
  if (line) rows.push(line);
  return rows;
}
