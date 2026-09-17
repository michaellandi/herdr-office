// A canvas the office draws its own pixels on.
//
// No image library and no dependency: a flat RGBA framebuffer and the four or
// five primitives a chart is made of. That is not asceticism, it is scope. The
// only things worth drawing in pixels here are the things a terminal cell cannot
// do, which turns out to be exactly one thing: a bar whose length means something,
// at a resolution finer than the eight block glyphs a cell can hold. Rectangles,
// rounded rectangles and lines cover that, and none of them need a font.
//
// Which is the other half of the scope, and it is deliberate. **Nothing in here
// draws text.** Text stays in the terminal's own layer, where it is already
// width-correct, already themed and already safe, and where the office's rule
// about what may reach a screen has been enforced on it. A bitmap font in the
// graphics layer would be a second path to the same screen with none of that, so
// the split is: words are cells, proportions are pixels.
import { encodePNG } from './png.mjs';

// Hex is what the theme already speaks (`P.carpet`, `STATUS.working.fg`), so the
// charts hand those straight in rather than converting at every call site. Parsed
// once per colour: this is called per pixel, and there are only a few dozen
// colours in the whole office.
const parsed = new Map();
function rgb(hex) {
  let out = parsed.get(hex);
  if (!out) {
    const n = parseInt(String(hex).slice(1), 16);
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    parsed.set(hex, out);
  }
  return out;
}

// How much of this pixel is inside a rectangle with rounded corners. Straight
// edges and the whole middle are 1; only the corner arcs are fractional, which
// is where a hard edge would read as a staircase at this size.
function coverage(px, py, x0, y0, w, h, r) {
  if (r <= 0) return 1;
  const cx = px < x0 + r ? x0 + r : px > x0 + w - r ? x0 + w - r : px;
  const cy = py < y0 + r ? y0 + r : py > y0 + h - r ? y0 + h - r : py;
  if (cx === px || cy === py) return 1;
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

export class Canvas {
  constructor(w, h) {
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    this.data = new Uint8Array(this.w * this.h * 4);
  }

  // Every primitive goes through here, so clipping is done once and no caller has
  // to bounds-check its arithmetic. A chart that computed a bar one pixel wider
  // than its box should come out clipped, not throwing.
  px(x, y, hex, a = 1) {
    if (a <= 0) return this;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return this;
    const [r, g, b] = rgb(hex);
    const i = (yi * this.w + xi) * 4;
    const d = this.data;
    if (a >= 1) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
      return this;
    }
    // Source-over onto what is already there. Every frame the office draws starts
    // by filling its background, so the destination is opaque by the time anything
    // translucent lands on it and this stays the two-term blend rather than the
    // full premultiplied one.
    const inv = 1 - a;
    d[i] = Math.round(r * a + d[i] * inv);
    d[i + 1] = Math.round(g * a + d[i + 1] * inv);
    d[i + 2] = Math.round(b * a + d[i + 2] * inv);
    d[i + 3] = Math.max(d[i + 3], Math.round(255 * a));
    return this;
  }

  fill(hex, a = 1) {
    return this.rect(0, 0, this.w, this.h, hex, a);
  }

  rect(x, y, w, h, hex, a = 1) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    for (let dy = 0; dy < Math.round(h); dy += 1) {
      for (let dx = 0; dx < Math.round(w); dx += 1) this.px(x0 + dx, y0 + dy, hex, a);
    }
    return this;
  }

  // A filled rectangle with rounded corners. The radius is clamped to half the
  // shorter side, so asking for a radius bigger than the box gives a capsule
  // rather than a shape turned inside out.
  round(x, y, w, h, r, hex, a = 1) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const bw = Math.round(w);
    const bh = Math.round(h);
    const rad = Math.max(0, Math.min(r, Math.floor(Math.min(bw, bh) / 2)));
    for (let dy = 0; dy < bh; dy += 1) {
      for (let dx = 0; dx < bw; dx += 1) {
        const cov = coverage(x0 + dx + 0.5, y0 + dy + 0.5, x0, y0, bw, bh, rad);
        if (cov > 0) this.px(x0 + dx, y0 + dy, hex, a * cov);
      }
    }
    return this;
  }

  hline(x, y, len, hex, a = 1) {
    return this.rect(x, y, len, 1, hex, a);
  }

  vline(x, y, len, hex, a = 1) {
    return this.rect(x, y, 1, len, hex, a);
  }

  png() {
    return encodePNG(this.w, this.h, this.data);
  }
}

// A canvas exactly as big as a rectangle of terminal cells. `cell_width_px` and
// `cell_height_px` come off `pane.graphics.info`, so a chart is drawn at the
// terminal's real resolution instead of being scaled into it: on this machine a
// cell is 10 by 22, and a retina window would hand back double that and get twice
// the detail for free.
export function cellCanvas(cols, rows, caps) {
  return new Canvas(Math.max(1, cols) * caps.cellW, Math.max(1, rows) * caps.cellH);
}
