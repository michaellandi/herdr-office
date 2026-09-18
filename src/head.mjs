// How full an agent's head is: the context window, off its own status line.
//
// The office can say who is working, what they are running, which branch they are on
// and how much they have written. None of that answers the question you actually have
// before you hand somebody more work, which is whether they have any room left to do
// it in. An agent at ninety per cent is about to compact, and the ten minutes after a
// compaction are the ten minutes it re-reads everything it already knew. A floor where
// that is visible is a floor where you can send the next job to the desk that can hold
// it, and where a desk that has quietly gone useless is something you notice.
//
// It is not in the socket API. `AgentInfo` carries a `tokens` map, which reads like it
// is exactly this, and on a live session it is `undefined` on every agent: it is a free
// form map the server has nothing to put in. There is no other method that comes close.
//
// What there is, on every agent worth watching, is a status line the agent prints for a
// human, with the percentage on it. So this reads the screen, which the office was
// already doing for the bubble over a stuck desk's head, and takes two things off it.
//
// Three rules govern it, and the third is the one that matters.
//
// **Only an anchored shape counts.** Not "a percentage somewhere near the bottom": a
// percentage next to the word `context`, or next to the moon glyph the other family of
// agents draws instead of the word. A test run that prints `94%` of anything, a
// coverage report, a download, a diff with a similarity index in it, all say nothing
// here. The cost of the strictness is an agent whose status line this does not know,
// which draws exactly as it does today; the cost of being loose is a desk that reports
// a number off somebody's test output as though it were the truth about that agent.
//
// **The number means used, not left.** Established by watching rather than assumed: a
// pane at sixty-four read sixty-five three minutes later without being touched, and the
// freshest agent on the floor read four. Both shapes here are used, and if a family ever
// prints the remaining fraction it gets its own shape and its own conversion rather than
// a flag on this one.
//
// **Nothing but a number and a model name ever leaves this file.** Same rule as
// src/dirt.mjs and src/process.mjs, and here it is load bearing, because the line this
// parses is the single most dangerous line on an agent's screen to repeat. Real ones
// carry an auth countdown, a spend figure, a branch name, a working directory and
// whatever else that agent thought worth telling its owner, on a display that gets
// screen shared. So the parse returns an integer and, when it recognises one, a short
// model token off a fixed list. The line itself is dropped on the floor. This is also
// why the model is not simply "whatever is in the first field": that would put an
// arbitrary piece of somebody's status bar on a card, which is the one thing this file
// must not do.

// Escape codes come off and nothing else does. sanitize(), which everything drawn on the
// floor goes through, would take the moon glyph below with it: it drops that whole block
// for being ambiguous width. That is the right call for a pane title and the wrong one
// here, and the fact that the anchor this reads is a glyph the grid refuses to draw is a
// tidy reminder of which side of the line this file is on.
import { stripAnsi } from './text.mjs';

// How far up from the bottom of the screen the status line can be. It is not the last
// line: an agent in a full screen UI keeps an input box and a row of hints below it, and
// measured against a live pane that chrome is about ten rows deep. Sixteen clears it with
// room for a taller one, and going much further is how scrollback starts getting read as
// a status bar.
const TAIL = 16;

// The shape of a status bar, as opposed to a line that happens to mention a percentage.
// Both families separate their fields with one of these, which is the same observation
// src/summary.mjs makes from the other end: its UI_NOISE list throws these lines away
// for being chrome. This file reads the line that file discards, and requiring the
// separator is what keeps the two agreeing about which line that is.
const STATUS_BAR = /[|·]/;

// `Context: 65%`, with or without the colon.
const WORDED = /\bcontext:?\s*(\d{1,3})\s*%/i;
// The same fact drawn as a moon that fills up: `◑ 58%`. The glyph is not read for its
// own sake, only as the anchor that makes the number a context gauge rather than a
// number: which moon an agent picks for which fraction is its own business.
const MOONED = /[◐◑◒◓◔◕○●]\s*(\d{1,3})\s*%/u;

// Model families this will name, and nothing else. A list rather than a pattern because
// the point is to recognise, not to guess: an unrecognised model is a card with no model
// row on it, which is the correct outcome and not a gap worth filling with a token
// scraped out of somebody's status bar.
const FAMILIES = ['opus', 'sonnet', 'haiku', 'gpt', 'codex', 'gemini', 'grok', 'kimi', 'qwen', 'glm', 'llama', 'mistral'];
// An optional `claude-` prefix comes off, because the family is the informative half and
// the row is nine cells wide. A trailing version stays: `opus-4.8` and `opus` are
// genuinely different answers to "what is this desk running".
const MODEL = new RegExp(`\\b(?:claude[-\\s])?((?:${FAMILIES.join('|')})(?:[-.\\s]?\\d+(?:\\.\\d+)?)*)`, 'i');
// A cap on what can reach a card, in case a version string turns out to be longer than
// anybody expects. The card gives this row about forty cells; this is a long way inside
// that.
const MODEL_MAX = 16;

// What one screen says about how full a head is, or null if it says nothing this
// recognises. `session` is carried through untouched so the caller can tell a window
// that emptied itself from an agent that was restarted underneath the same pane.
//
// Scanned from the bottom up and the first match wins, because the status bar is the
// bottom-most place this shape can appear: anything higher is scrollback, which is
// history rather than state.
export function parseGauge(text, session = null) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < TAIL; i -= 1) {
    const line = stripAnsi(lines[i]);
    if (!line.trim()) continue;
    seen += 1;
    if (!STATUS_BAR.test(line)) continue;
    const hit = WORDED.exec(line) || MOONED.exec(line);
    if (!hit) continue;
    const used = Number(hit[1]);
    // A three digit number that is not a percentage is a number that was never this
    // gauge, so it is skipped rather than clamped.
    if (!Number.isInteger(used) || used < 0 || used > 100) continue;
    const model = MODEL.exec(line);
    return {
      used,
      model: model ? model[1].toLowerCase().slice(0, MODEL_MAX) : null,
      session: session || null,
    };
  }
  return null;
}

// How much is too much, as a band. The renderer turns a band into a colour (src/render.mjs
// tints the monitor frame with it); this is only the judgement about where the lines are.
//
// Four bands, and what they drive is the alarm rather than the message. The number itself
// is drawn on every desk the office has a reading for; these decide what colour it is in
// and whether the monitor looks like it is under strain.
//
// That split is a correction. The first version of this let the bands govern everything
// and drew nothing at all below the first one, on the reasoning that there is nothing to
// do about thirty per cent and a gauge on every desk would be furniture within a day. On
// a real floor of four desks that came to exactly one tinted frame, two shades of dim
// apart from its neighbours, with no number anywhere: a feature you had to be told was
// there in order to see it. The reasoning was not wrong about noise, it was wrong about
// where the noise comes from. A number in a frame that was already being drawn adds no
// cell and no colour, and reading it is optional in a way a coloured frame is not.
//
// The lines themselves: half full is where "plenty of room" stops being true, three
// quarters is where the next long job is a gamble, and ninety is where a compaction is
// not a risk but a schedule.
export const FILLING = 50;
export const HOT = 75;
export const BRIMMING = 90;
export const HEAD_BANDS = ['calm', 'filling', 'hot', 'brimming'];

export function pressure(used) {
  const n = Number(used);
  if (!Number.isFinite(n) || n < FILLING) return 'calm';
  if (n < HOT) return 'filling';
  if (n < BRIMMING) return 'hot';
  return 'brimming';
}

// The short form: `76%`. Written into a monitor's top edge on the floor, and riding in the
// same column as the branch and the count of uncommitted files in the list.
//
// Every reading the office has, calm ones included. Empty only for a desk nobody has read
// yet, which is the one distinction worth keeping in the shape rather than the colour: a
// plain bezel now means "nobody has looked", not "plenty of room", and those were
// previously identical on screen. Where the row genuinely has no space for it (a raised
// hand needs the same columns) the caller drops it, which is a decision about space and
// not about whether the number was worth saying.
export function headBadge(used) {
  if (used == null || used === '') return '';
  const n = Number(used);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '';
}

// The card's version, in words, where there is room for the real number.
//
// Said out loud at every band, including the calm one, which is the difference between a
// card and a wall display: you opened this card to find out, and "31% full" is a real
// answer. The clause on the end only appears once it is telling you something you might
// act on, and it is about room rather than about doom: the agent is not broken at ninety
// per cent, it is about to lose the early half of what it knows.
export function headWords(head) {
  if (!head || !Number.isFinite(Number(head.used))) return null;
  const used = Math.round(Number(head.used));
  const band = pressure(used);
  if (band === 'brimming') return `${used}% full · about to compact`;
  if (band === 'hot') return `${used}% full · not much room left`;
  return `${used}% full`;
}

// A window that emptied itself. Drawn as news over the desk, in the same row and with
// the same expiry as the tests going green, because it is the same kind of fact: a thing
// that just happened here and that you would otherwise have to be watching to catch.
//
// Twenty five points, because nothing else moves the number that far downwards. It
// climbs a point at a time while an agent works and there is no ordinary event that
// takes it down at all, so the threshold is not really a judgement about how big a drop
// counts. It is a guard against two reads of two different agents being compared, which
// cannot happen here, and against a misread, which can.
export const COMPACT_DROP = 25;

// The label is one of the office's own fixed strings, like every other piece of news
// (see src/events.mjs), and `snag` rather than `broke` or `good` because that is what it
// is: nothing failed, nothing was achieved, and the desk is going to be slower for the
// next few minutes.
//
// It is the wrong word in two cases and is still the right label. An agent that was
// cleared, or restarted in the same pane, also reads as a window that emptied, and where
// the server gives us a session id to compare, that is caught below. Where it does not,
// the mislabel stands: compaction happens to a working agent several times an afternoon
// and a restart happens when somebody deliberately does it, so the common reading is the
// true one, and in all three cases the consequence for the person reading the floor is
// identical anyway.
export function compactionNews(before, after) {
  if (!before || !after) return null;
  // Different agent session in the same pane: somebody started something new here. That
  // is not news the office has any business announcing.
  if (before.session && after.session && before.session !== after.session) return null;
  const from = Number(before.used);
  const to = Number(after.used);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from - to < COMPACT_DROP) return null;
  return { label: 'compacted', kind: 'snag' };
}
