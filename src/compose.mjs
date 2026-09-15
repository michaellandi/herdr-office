// Assigning work: the parts with no terminal in them.
//
// This is the most consequential thing the office can do. `agent.prompt` puts text
// into a real agent's input and makes it act on it, and unlike a pane swap there is
// no undoing it. So the decisions worth testing are gathered here, away from the
// screen and the socket: what a keystroke does to the field, what the field is
// allowed to contain, and exactly who a broadcast reaches.
import { sanitize, width } from './text.mjs';

// Long enough for a real instruction, short enough that nothing pasted by accident
// ends up being submitted as a paragraph nobody read.
export const MAX_PROMPT = 400;

// sanitize()'s rules, minus the trim. sanitize() is for text that has finished
// being text (a pane title, an outgoing prompt) and it collapses and trims, which
// is exactly wrong halfway through typing: the space you just pressed between two
// words would disappear until you typed the next letter.
function printable(str) {
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) {
      out += ' ';
      continue;
    }
    if (cp === 0xfe0f || cp === 0x200d) continue;
    if (cp >= 0x2190 && cp <= 0x2bff) continue; // arrows, symbols, box drawing
    if (cp >= 0x1f000) continue; // emoji planes
    out += ch;
  }
  return out;
}

// The first `max` display cells of a string, cut on a code point so a wide glyph
// can never straddle the edge of the field.
function takeCells(str, max) {
  let out = '';
  let used = 0;
  for (const ch of String(str)) {
    const w = width(ch);
    if (used + w > max) break;
    out += ch;
    used += w;
  }
  return out;
}

// A chunk of stdin, applied to the field. Same shape as the branch field's
// typeChunk, and for the same reason: stdin arrives in chunks, so a paste and an
// arrow key both turn up as strings rather than keystrokes.
//
// Unlike a branch name this is free prose, so the filter is sanitize() (which
// drops control characters and the ambiguous-width glyphs that wreck a cell grid)
// rather than an allowlist. A return submits; ctrl-u clears the line and ctrl-w
// deletes the last word, because a field that only had backspace would be
// unusable at four hundred characters.
export function typePromptChunk(text, chunk, max = MAX_PROMPT) {
  const current = String(text ?? '');
  const str = String(chunk ?? '');
  // An escape sequence is not text. Not one character of it.
  if (!str || str.startsWith('\x1b')) return { text: current, done: false };
  if (str === '\x7f' || str === '\b') return { text: current.slice(0, -1), done: false };
  if (str === '\x15') return { text: '', done: false };
  if (str === '\x17') return { text: current.replace(/\s*\S+\s*$/, ''), done: false };
  const stop = Math.min(...['\r', '\n'].map((c) => (str.includes(c) ? str.indexOf(c) : Infinity)));
  const head = stop === Infinity ? str : str.slice(0, stop);
  // A tab in prose is a tab nobody meant; a run of whitespace is one space.
  const clean = printable(head).replace(/\s+/g, ' ');
  const room = Math.max(0, max - current.length);
  return { text: current + clean.slice(0, room), done: stop !== Infinity };
}

// What actually gets sent. Trimmed, collapsed, and capped. An empty result means
// there is nothing to send, which the caller must treat as "do nothing" rather
// than as "send a blank line".
export function cleanPrompt(raw, max = MAX_PROMPT) {
  return sanitize(String(raw ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

// The field, laid out for a panel that is `cols` wide and can spare `lines` rows.
// Wraps on spaces where it can, hard-breaks a word too long to fit, and shows the
// LAST `lines` rows rather than the first: the cursor is at the end, and a field
// that scrolled off the thing you were typing would be worse than no field.
export function wrapField(text, cols, lines = 3) {
  const room = Math.max(1, cols);
  const out = [];
  let line = '';
  for (const word of String(text ?? '').split(' ')) {
    // A single word wider than the field is broken rather than allowed to overflow,
    // one cell at a time so a wide glyph cannot straddle the edge.
    let rest = word;
    while (width(rest) > room) {
      const head = takeCells(rest, room);
      if (!head) break; // a single glyph wider than the whole field: give up rather than loop
      if (line) { out.push(line); line = ''; }
      out.push(head);
      rest = rest.slice(head.length);
    }
    if (!line) line = rest;
    else if (width(line) + 1 + width(rest) <= room) line += ` ${rest}`;
    else { out.push(line); line = rest; }
  }
  out.push(line);
  return out.slice(-Math.max(1, lines));
}

// Who a broadcast reaches, and who it does not.
//
// Blocked is excluded because `agent.prompt` rejects it outright (agent_blocked,
// before anything is sent), and showing it as a recipient would be a lie. Working
// is excluded because it is mid-turn: barging in on somebody who is already doing
// what you asked them to do is not a standup, it is an interruption, and it is not
// something a single keystroke should do to five agents at once.
//
// Both are reported rather than silently dropped, because "it went to four of your
// seven agents" is the whole thing the user needs to know before pressing enter.
const REACHABLE = new Set(['idle', 'done', 'unknown']);

export function broadcastTargets(people) {
  const list = Array.isArray(people) ? people : [];
  const to = list.filter((p) => REACHABLE.has(p?.status));
  const skipped = { blocked: 0, working: 0 };
  for (const p of list) {
    if (p?.status === 'blocked') skipped.blocked += 1;
    else if (p?.status === 'working') skipped.working += 1;
  }
  return { to, skipped };
}

// The sentence that has to be true before enter sends anything. Names as many
// people as fit and counts the rest, so a broadcast to twenty desks is still one
// readable line rather than a wall of names.
export function describeTargets(to, cols) {
  if (!to.length) return 'nobody is free to take this right now';
  const names = to.map((p) => p.name || p.id);
  for (let keep = names.length; keep > 0; keep -= 1) {
    const rest = names.length - keep;
    const line = rest
      ? `${names.slice(0, keep).join(', ')} and ${rest} more`
      : names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    if (width(line) <= cols) return line;
  }
  return `${to.length} people`;
}
