// The window title. Herdr lets a client set the title of the window its pane is
// in, which is the one piece of the office that is legible when the office is not
// on screen at all: a tab bar, a dock, an alt-tab list. So it carries the single
// thing worth interrupting you for, the number of people waiting on you, and it
// says it first, because every window list in every OS truncates from the right.
//
// It is somebody else's window. That buys two rules: the title is short, and it
// is handed back on the way out (`client.window_title.clear`), because "2 waiting
// on you" left behind on a window after the office has exited is a lie that
// outlives the process that told it.

// Long enough for "12 waiting - 30 working - office", short enough that no
// terminal is being asked to hold a paragraph. Titles are for glancing at.
const MAX = 48;

// A title goes off to a window manager by way of a terminal escape sequence, so
// control characters are not a formatting problem, they are an injection: a stray
// ESC or BEL in a name would end the sequence early and leave the rest of the
// string being interpreted as something else entirely. Nothing in here is ever
// user-supplied today (the words are fixed and the numbers are numbers), and this
// is what keeps that true if that ever changes.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const scrub = (s) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

export function windowTitle(counts = {}) {
  // Rounded as well as floored: a count is a number of people, and "1.6 working"
  // on a window is the kind of thing that makes somebody distrust the rest of it.
  const n = (key) => Math.max(0, Math.round(Number(counts[key])) || 0);
  const blocked = n('blocked');
  const working = n('working');
  const total = blocked + working + n('idle') + n('done') + n('unknown');

  const parts = [];
  // Waiting first and always, on its own if that is all there is room for. It is
  // the only count on this list that is a request rather than a status.
  if (blocked) parts.push(`${blocked} waiting`);
  if (working) parts.push(`${working} working`);
  if (!parts.length) parts.push(total ? 'all quiet' : 'nobody in');
  parts.push('office');

  return scrub(parts.join(' - ')).slice(0, MAX);
}
