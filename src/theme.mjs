// Colours, and the painter everything else draws through.
//
// The art in sprites.mjs is written as plain text on a fixed cell grid. Colour
// arrives separately as a list of column spans, which keeps the ASCII readable
// in source and means escape codes are emitted once per style change instead of
// once per character.
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';

const codes = new Map();
function seq(kind, hex) {
  const key = kind + hex;
  let out = codes.get(key);
  if (!out) {
    const n = parseInt(hex.slice(1), 16);
    out = `\x1b[${kind};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
    codes.set(key, out);
  }
  return out;
}
export const fg = (hex) => seq(38, hex);
export const bg = (hex) => seq(48, hex);

// The room.
export const P = {
  carpet: '#14181f',
  carpetEdge: '#0f1319',
  bar: '#1c2331',
  cubicle: '#232b38',
  cubicleAlt: '#1e2532',
  wall: '#3a4658',
  deskTop: '#8a6a45',
  deskFront: '#5c4630',
  keys: '#2b2f38',
  screen: '#0a0f18',
  screenOff: '#0d1219',
  paper: '#2c3444', // the card pinned to the cubicle wall
  bubble: '#4a3a17', // the speech bubble over a stuck person's head
  bubbleInk: '#ffe6a8',
  // The far wall of the room and the trim where it meets the floor, so the
  // furniture stands against something instead of floating on carpet.
  backWall: '#191f28',
  trim: '#2b3543',
  aisle: '#171c24', // the walkway between two rows of cubicles
  // Furniture. Muted on purpose: it is scenery, and it must never pull the eye
  // away from a raised hand.
  leaf: '#3f7d52',
  pot: '#7a4b34',
  water: '#3f6f86',
  plastic: '#4b5568',
  fabric: '#4a4356',
  wood: '#6b533a',
  ink: '#e6edf7',
  soft: '#a8b3c4',
  dim: '#6b7789',
  faint: '#4a5566',
  accent: '#5ec8f5',
};

export const STATUS = {
  working: { label: 'WORKING', fg: '#5ce08a', screen: '#7cf0a6' },
  blocked: { label: 'NEEDS YOU', fg: '#ffc14d', screen: '#ffd67a', hot: '#fff0c2' },
  idle: { label: 'IDLE', fg: '#8b97aa', screen: '#7d899c' },
  done: { label: 'DONE', fg: '#4fd6e8', screen: '#86e9f5' },
  unknown: { label: 'UNSURE', fg: '#c48bff', screen: '#d9b3ff' },
};

export const status = (name) => STATUS[name] || STATUS.unknown;

// Everyone gets a shirt, a haircut and a skin tone, derived from the pane id so
// the same desk keeps the same person between runs.
const SHIRTS = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#7f9ff5', '#e39ec1', '#84cc8f'];
const HAIR = ['#2e2620', '#4a3220', '#7a5c3a', '#26303e', '#5c3a2a', '#171c24', '#8a7f6a'];
const SKIN = ['#f0c7a1', '#d9a173', '#b57b4f', '#8d5a3b', '#6b422b', '#f5d5b8'];

export function identity(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return {
    shirt: SHIRTS[h % SHIRTS.length],
    hair: HAIR[(h >>> 8) % HAIR.length],
    skin: SKIN[(h >>> 16) % SKIN.length],
  };
}

// spans: [{ from, to, fg, bg, bold, dim }] in code-point columns, later wins.
export function paint(text, spans = [], base = {}) {
  const chars = [...text];
  let out = '';
  let key = null;
  for (let i = 0; i < chars.length; i += 1) {
    let s = base;
    for (const sp of spans) {
      if (i >= sp.from && i < sp.to) {
        s = {
          fg: sp.fg ?? s.fg,
          bg: sp.bg ?? s.bg,
          bold: sp.bold ?? s.bold,
          dim: sp.dim ?? s.dim,
        };
      }
    }
    const k = `${s.fg || ''}|${s.bg || ''}|${s.bold ? 1 : 0}|${s.dim ? 1 : 0}`;
    if (k !== key) {
      out += RESET;
      if (s.bold) out += BOLD;
      if (s.dim) out += DIM;
      if (s.fg) out += fg(s.fg);
      if (s.bg) out += bg(s.bg);
      key = k;
    }
    out += chars[i];
  }
  return out + RESET;
}

export const fill = (cells, bgHex) => paint(' '.repeat(Math.max(0, cells)), [], { bg: bgHex });
