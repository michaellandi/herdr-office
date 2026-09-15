// Hiring: the parts with no terminal in them.
//
// What the menu cursor does with a keystroke, and what a branch name is allowed
// to be. Both live here rather than in office.mjs because both decide something
// that leaves the process: one picks the agent that gets started, the other names
// a git branch and a directory that get created on disk. That deserves a test
// that needs neither a server nor a screen.

// The characters a branch name may contain. git's own rule (check-ref-format) is
// a list of things a ref may NOT contain, which is the wrong shape for something
// typed one key at a time, so this is the allowlist instead: letters, digits, and
// the four separators that read as a branch name. Everything else is dropped, and
// a space becomes a hyphen because that is what people mean by it.
const ALLOWED = /[A-Za-z0-9._/-]/;

// A single keystroke, applied to the branch field. Deliberately does not tidy the
// name up (no trimming, no collapsing): the field has to be typeable, and a
// "feature/" that lost its slash the moment you typed it would be unusable.
// sanitizeBranch does the tidying, once, on the way out.
export function typeBranch(branch, key, max = 80) {
  const current = String(branch ?? '');
  if (key === '\x7f' || key === '\b') return current.slice(0, -1);
  const ch = key === ' ' ? '-' : key;
  if (ch.length !== 1 || !ALLOWED.test(ch)) return current;
  if (current.length >= max) return current;
  return current + ch;
}

// A whole chunk of stdin, applied to the field. A terminal delivers one keystroke
// at a time, but a paste arrives as one string, and so does a bracketed-paste
// wrapper or an arrow key. So: an escape sequence is ignored outright (an arrow
// key must not land in the field as "[A"), a return anywhere in the chunk ends the
// edit at that point, and everything before it is typed one code point at a time
// through the same filter a single keystroke goes through.
export function typeChunk(branch, chunk, max = 80) {
  const str = String(chunk ?? '');
  if (!str || str.startsWith('\x1b')) return { branch: String(branch ?? ''), done: false };
  const stop = Math.min(...['\r', '\n'].map((c) => (str.includes(c) ? str.indexOf(c) : Infinity)));
  const typed = [...(stop === Infinity ? str : str.slice(0, stop))]
    .reduce((acc, ch) => typeBranch(acc, ch, max), String(branch ?? ''));
  return { branch: typed, done: stop !== Infinity };
}

// What actually gets sent. git refuses a name with `..` in it, one that starts or
// ends with a separator, or one ending `.lock`, and a rejected branch is a hire
// that fails for a reason nobody typed.
export function sanitizeBranch(raw, max = 80) {
  let out = [...String(raw ?? '')]
    .map((ch) => (ch === ' ' ? '-' : ch))
    .filter((ch) => ALLOWED.test(ch))
    .join('');
  out = out.replace(/\.{2,}/g, '.').replace(/\/{2,}/g, '/');
  out = out.replace(/^[./-]+/, '').replace(/[./]+$/, '');
  out = out.replace(/\.lock$/i, '');
  return out.slice(0, max);
}

// The name offered before anyone types anything. Prefixed so a session's worth of
// hires is one obvious group in `git branch`, and stamped rather than counted so
// two offices, or two runs, cannot both propose the same branch.
export function defaultBranch(kind, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return sanitizeBranch(`office/${kind || 'agent'}-${stamp}`);
}

// One step of the menu cursor. `limit` is how many cells are actually on the
// screen, not how many kinds exist: a cursor you cannot see is worse than a list
// you cannot reach the end of.
export function nextIndex(index, dx, dy, cols, limit) {
  if (limit <= 0) return 0;
  const next = index + dx + dy * Math.max(1, cols);
  if (next < 0 || next >= limit) return Math.min(index, limit - 1);
  return next;
}
