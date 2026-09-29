// What the manager's desk says, which is the same set of facts src/notices.mjs already
// produces, shaped to fit a 12 by 2 monitor and a 27 cell status line.
//
// A separate module from notices.mjs on purpose. That file decides *what is true about
// this floor*, and it is the one with the reasoning about thresholds and false
// positives in it. This one decides *how a desk says it*, which is a rendering
// question: how many cells there are, what fits, and what a word like "parked" is
// short for. Keeping them apart means the wording can be argued about without
// reopening the rules, and the rules can change without touching a sprite.
//
// Like notices.mjs, nothing here can act. It takes a list and returns strings.
import { truncate, width as cellWidth } from './text.mjs';

// The manager has no pane behind it, so it needs an id that walks and clicks can carry
// and that no real pane can collide with, exactly as the empty desk does. herdr pane
// ids are `workspace:pane`, so a leading `+` is unreachable.
export const MANAGER_ID = '+manager';

// The monitor is twelve cells wide and two rows tall. Everything below is written to
// that budget, because a headline that does not fit is not a headline.
export const SCREEN_COLS = 12;

// What each kind of notice is called when there is only room for one word. These are
// labels on a gauge rather than sentences: the whole sentence is on the status line
// under the desk, and all of them are on the card.
const LABEL = {
  collision: 'one checkout',
  full: 'full head',
  'same-ask': 'same question',
  stalled: 'parked',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// How many desks all of this is about, which is not how many notices there are and is the
// number somebody reading the floor from across the room actually wants.
//
// This was `notices.length` and it was wrong in the case the desk exists for. Three agents
// stopped in one checkout is one notice, because four reports of one directory's file count
// reads as four times the work, and the desk therefore said `1 THING` while three people
// were stuck. One is the number of sentences the office has to say. Three is the number of
// desks that need somebody, and nobody has ever wanted the first number.
//
// Counted as a set because a desk can be in two notices at once: a full head in a shared
// checkout is two things worth saying about one person, and `2 DESKS` for one person would
// be the same lie in the other direction.
const deskCount = (list) => new Set(list.flatMap((n) => (Array.isArray(n.ids) ? n.ids : []))).size;

// Centred, because every other monitor in the office is: a running command, APPROVE?
// and ALL DONE all sit in the middle of the glass, and a manager's screen flush against
// the left bezel read as a bug rather than as a choice.
function centre(text) {
  const s = truncate(String(text || ''), SCREEN_COLS);
  const pad = SCREEN_COLS - s.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + s + ' '.repeat(pad - left);
}

// The headline, as the two rows of the monitor. The count first, because the count is
// the part you read from across the room, and what it is about second.
//
// Desks rather than notices, for the reason written on `deskCount`. Twelve cells fits
// `3 desks` and would not fit `3 desks, 1 thing`, and of the two the count of people is
// the one worth the glass.
function screenOf(list) {
  if (!list.length) return [centre('all quiet'), centre('')];
  return [centre(plural(deskCount(list), 'desk')), centre(LABEL[list[0].kind] || '')];
}

// Whether the manager is animated, and how it holds itself. Two states rather than
// five, because a desk with nothing to report should be visibly doing nothing: the
// whole complaint this desk answers is that a silent manager is indistinguishable from
// a broken one, and a calm figure at a desk is the cheapest fix for that.
const poseOf = (list) => (list.length ? 'news' : 'watching');

// One sentence for the status line under the desk, in the width a desk has. The most
// urgent notice rather than a summary of all of them, because a summary of four facts
// is not a fact, and the card is right there.
//
// The reason a desk stopped is appended only when the whole of it fits, which is the same
// rule the footer follows and for the same reason: half a quote is the office putting
// somebody else's words in its mouth and cutting them off mid-sentence. In practice that
// means the compact list row, which has the whole pane to spend, carries the reason and
// the 27 cells under a tile do not. Losing it there is the right trade: the chip already
// says how many things there are and the monitor already says what kind, so on a tile the
// fact is stated three times over, while the reason needs a full sentence or none.
// Exported because two surfaces draw this sentence in two different widths, and only one
// of them knows its width when it asks for the rest of the tile. The compact list row
// spends twenty-odd cells on a face, a chip and a name before the sentence starts, so
// asking for it at the pane's full width and then cutting the row to fit produced exactly
// the half-quote this function exists to refuse. It asks twice instead: once for the
// fields, once for the sentence, with the room it actually has.
export function managerLine(notices, room) {
  return lineOf(Array.isArray(notices) ? notices.filter((n) => n && n.text) : [], room);
}

function lineOf(list, room) {
  if (!list.length) return 'nothing needs you right now';
  const n = list[0];
  const whole = n.why ? `${n.text}, ${n.why}` : n.text;
  // Measured in cells rather than code units. Screen text reaches this line through
  // notices.mjs, and a quote of a name in kanji is half as many characters as it is
  // columns, which is the difference between a sentence that fits and a torn row.
  return truncate(cellWidth(whole) <= room ? whole : n.text, room);
}

// The chip where a real desk says WORKING or NEEDS YOU. Deliberately not one of the
// five agent statuses: the manager is not an agent, and a desk claiming a status herdr
// never reported would be the office inventing state.
const chipOf = (list) => (list.length ? plural(deskCount(list), 'DESK').toUpperCase() : 'WATCHING');

// Everything the tile needs, from the notices the office has already computed.
//
// `width` is how much room the status line has, which the renderer knows and this
// module does not. Defaulted so a caller that only wants the words can leave it out.
export function manager({ notices = [], width = 27 } = {}) {
  const list = Array.isArray(notices) ? notices.filter((n) => n && n.text) : [];
  return {
    id: MANAGER_ID,
    name: 'THE MANAGER',
    // Where a person's pane title goes. Says what the desk is for, because a desk
    // nobody can name is furniture.
    role: 'chief of staff',
    pose: poseOf(list),
    chip: chipOf(list),
    screen: screenOf(list),
    line: lineOf(list, width),
    // How many, so the card and the header can count without re-deriving it. Both
    // numbers, because they answer different questions and the card asks both: `count`
    // is how many sentences `m` steps through, `desks` is how many people are waiting.
    count: list.length,
    desks: deskCount(list),
    // Carried through so the card can list all of them and `enter` has something to
    // open. Not copied: the renderer only reads it.
    notices: list,
  };
}
