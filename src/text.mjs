// Display-width aware string helpers. Everything drawn on the office floor is
// laid out on a fixed cell grid, so width has to be counted in cells, not code
// units: ANSI escapes are zero width and CJK/emoji are two cells wide.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x3fffd],
];

export function stripAnsi(str) {
  return String(str).replace(ANSI, '');
}

function charWidth(cp) {
  if (cp === 0x200d || cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

export function width(str) {
  let total = 0;
  for (const ch of stripAnsi(str)) total += charWidth(ch.codePointAt(0));
  return total;
}

// Drop the glyphs that wreck a cell grid: control chars, variation selectors,
// and the ambiguous-width symbol blocks agents love to put in pane titles.
export function sanitize(str) {
  let out = '';
  for (const ch of stripAnsi(String(str))) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) {
      out += ' ';
      continue;
    }
    if (cp === 0xfe0f || cp === 0x200d) continue;
    if (cp >= 0x2190 && cp <= 0x2bff) continue; // arrows, symbols, dingbats
    if (cp >= 0x1f000) continue; // emoji planes
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function truncate(str, max) {
  if (max <= 0) return '';
  if (width(str) <= max) return str;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export function padEnd(str, max) {
  const clipped = truncate(str, max);
  return clipped + ' '.repeat(Math.max(0, max - width(clipped)));
}

export function center(str, max) {
  const clipped = truncate(str, max);
  const slack = Math.max(0, max - width(clipped));
  const left = Math.floor(slack / 2);
  return ' '.repeat(left) + clipped + ' '.repeat(slack - left);
}

export function formatDuration(ms) {
  if (ms == null) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${String(mins % 60).padStart(2, '0')}m`;
}
