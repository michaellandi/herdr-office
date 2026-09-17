// What the office draws in pixels, and why each one earns the layer it costs.
//
// The test every chart in here had to pass: **a terminal cell cannot do this.**
// Not "this looks nicer in pixels", which is true of everything and is how a
// terminal program ends up as a worse web page. A cell can hold a word, a colour
// and one of eight block glyphs, so it can say `worked 12m · waiting 3m` perfectly
// well. What it cannot do is show you that the waiting was a fifth of the session,
// at a resolution finer than an eighth of a cell, without you doing the division
// yourself. Proportion is the thing pixels are for here, and both charts below are
// proportions.
//
// The second rule, learned the hard way: a layer may only cover cells that were
// already a picture. The whiteboard chart originally took the two rows of writing
// with it, so it deleted `worked 12m · waiting 3m` in order to draw a picture of it
// and left five colours with no legend. It now covers one row that already holds the
// same bar in whole cells. See the regions list in src/render.mjs.
//
// Each one returns a signature next to its canvas. The signature is whatever the
// picture actually depends on, quantised to the pixel: the office animates at
// 320ms and the numbers behind these move once every few seconds, so
// src/graphics.mjs compares signatures and puts nothing on the wire for a frame
// that would look identical. Getting that wrong is not a slow office, it is a
// megabyte a second of PNGs nobody can see the difference between.
import { P, STATUS } from './theme.mjs';
import { cellCanvas } from './canvas.mjs';

// The order the header already counts statuses in, so the stack and the legend
// above it read left to right the same way.
const ORDER = ['working', 'blocked', 'idle', 'done', 'unknown'];

// Integer widths that sum to exactly `total`, by largest remainder. Rounding each
// segment on its own leaves a bar one or two pixels short of its own track, and at
// this size that gap lands on the end of the last segment and reads as a rendering
// fault rather than as rounding.
export function allot(values, total) {
  const sum = values.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(total > 0)) return values.map(() => 0);
  const exact = values.map((v) => (v / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  // Biggest fractional part first, and a stable tiebreak on index so the same
  // numbers always produce the same bar.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/* ------------------------------------------------------- the whiteboard chart */

// Where the session's time actually went, as one stacked bar.
//
// This covers the whiteboard's bar row and nothing else. Not the frame, not the
// `open since 09:41` title, and above all not the two lines of writing: those are
// words, so they stay in cells. The row it does cover already holds the same bar
// drawn in whole cells, so what the layer buys is resolution, not information, and a
// terminal that cannot draw it is not missing a thing.
export function timeChart(stats, cols, rows, caps) {
  if (!stats) return null;
  const c = cellCanvas(cols, rows, caps);
  const pad = Math.max(4, Math.round(caps.cellW * 0.6));
  const track = c.w - pad * 2;
  if (track < 8) return null;
  c.fill(P.paper);

  // One bar, filling the row it was given. It used to be two, stacked, and the
  // second one cost more than it was worth: "hands 7 · 4 from here" is already an
  // exact sentence, and a bar of four-sevenths next to it was a picture of something
  // the words had said better. What the words cannot do is the time split, so that is
  // what is left.
  const gap = Math.max(1, Math.round(c.h * 0.16));
  const barH = Math.max(3, c.h - gap * 2);
  const y0 = Math.floor((c.h - barH) / 2);
  const r = Math.min(3, Math.floor(barH / 2));

  // The empty track first, so a session with nothing in a bucket yet reads as a
  // bar that has not filled rather than as a missing bar.
  c.round(pad, y0, track, barH, r, P.screen);
  const spent = stats.spent || {};
  const widths = allot(ORDER.map((k) => Math.max(0, spent[k] || 0)), track);
  let x = pad;
  const sig = [];
  ORDER.forEach((key, i) => {
    const w = widths[i];
    sig.push(w);
    if (w <= 0) return;
    // Only the outer ends of the whole stack are rounded. Rounding every segment
    // would put a notch between two touching colours and turn one bar into five
    // lozenges, which reads as five separate measurements.
    const first = sig.slice(0, i).every((v) => v === 0);
    const last = widths.slice(i + 1).every((v) => v === 0);
    if (first || last) {
      c.round(x, y0, w, barH, r, STATUS[key].fg);
      // Square off the inner end again, or the rounding eats into its neighbour.
      if (first && !last) c.rect(x + w - r, y0, r, barH, STATUS[key].fg);
      if (last && !first) c.rect(x, y0, r, barH, STATUS[key].fg);
    } else {
      c.rect(x, y0, w, barH, STATUS[key].fg);
    }
    x += w;
  });

  // Quarter marks, faint, straight over the stack. This is the whole reason the
  // bar beats the sentence: with them you can see that waiting was about a fifth
  // of the session without reading a number or doing the division.
  for (const q of [0.25, 0.5, 0.75]) {
    c.vline(pad + Math.round(track * q), y0 + 1, barH - 2, P.carpet, 0.35);
  }

  return { canvas: c, signature: `t:${sig.join(',')}@${track}` };
}

/* --------------------------------------------------------- the attention strip */

// Every desk in the session as one tick, on the blank row under the header.
//
// The floor plan pages: with more desks than fit, the office draws floor 1 of 3
// and says "keep walking for the rest". That sentence is the only thing telling
// you the other two floors exist, and it cannot tell you that one of them has two
// raised hands on it. This can, in a row that is currently a spacer full of
// carpet, at a cost of one layer.
//
// A hand up is drawn taller rather than only brighter, so the row reads as a
// skyline whose spikes are the people waiting on you. That is legible at the
// distance a wall display is actually looked at, which no amount of colour on a
// one-cell row is.
export function attentionStrip(people, selectedId, cols, rows, caps) {
  const roster = Array.isArray(people) ? people : [];
  if (!roster.length) return null;
  const c = cellCanvas(cols, rows, caps);
  // Starts where the header's own text starts, so the strip sits under the title
  // and the counts instead of hanging off the left edge on its own.
  const pad = caps.cellW * 2;
  const room = c.w - pad * 2;
  if (room < roster.length) return null;
  c.fill(P.carpet);

  // A wider gap where the workspace changes, because the roster is already sorted
  // by workspace and the groups are the rooms on the floor: the strip should break
  // in the same places the floor does.
  const breaks = roster.map((p, i) => i > 0 && p.workspaceId !== roster[i - 1].workspaceId);
  // A room break is measured off the cell rather than off the tick, so it stays
  // wider than the ordinary gap on a crowded floor. Scaled to the tick it vanished
  // exactly when there were enough desks for the grouping to be worth showing.
  const jump = Math.max(2, Math.round(caps.cellW * 0.5));
  const extra = breaks.filter(Boolean).length * jump;
  // Ticks take the room they need and no more. Letting them divide the whole row
  // turns seven desks into seven slabs the width of a word, which reads as a bar
  // chart of something and loses the one property that makes the strip worth a
  // layer: that you can count it at a glance. Below the cap they shrink, so a floor
  // of forty still fits.
  //
  // The cap has to be on the stride, not just on the tick, and it has to be loose
  // enough to be seen. Capping at two cells put five desks in the leftmost hundred
  // pixels of a two-thousand-pixel row: technically drawn, 1.2% ink, and invisible
  // at the distance anybody looks at this. Four cells of stride keeps a small floor
  // a solid legible group rather than a smudge in the corner, and a crowded floor
  // never reaches the cap anyway.
  const unit = Math.max(1, Math.min(caps.cellW * 4, Math.floor((room - extra) / roster.length)));
  // Held a little under the stride so there is always a gap to count between two
  // ticks, and capped below it so a very sparse floor spaces out instead of growing
  // slabs. Which is the same rule as before, just no longer the only one.
  const tick = Math.max(1, Math.min(caps.cellW * 3, unit - Math.max(1, Math.round(unit * 0.2))));

  const base = Math.max(2, Math.round(c.h * 0.27));
  const tall = Math.max(base + 2, Math.round(c.h * 0.64));
  const r = tick >= 4 ? 1 : 0;
  const sig = [];
  // What the ticks will actually occupy: every stride but the last, which only needs
  // the tick itself, plus the room breaks. On a crowded floor this is the whole row
  // and the centring below is a no-op.
  const span = extra + (roster.length - 1) * unit + tick;
  // Centred rather than pinned to the left edge. A small floor cannot fill a wide
  // row whatever the cap is, and a short group of ticks in the middle of the row
  // reads as one deliberate object, where the same group in the top-left corner
  // reads as something that failed to finish drawing.
  let x = pad + Math.max(0, Math.floor((room - span) / 2));
  roster.forEach((person, i) => {
    if (breaks[i]) x += jump;
    const raised = person.status === 'blocked';
    const h = raised ? tall : base;
    const st = STATUS[person.status] || STATUS.unknown;
    // Standing on the same baseline, so height is the only thing that varies and
    // the eye reads it as one row rather than as scattered marks.
    const y = c.h - h - Math.max(1, Math.round(c.h * 0.14));
    c.round(x, y, tick, h, r, st.fg);
    if (person.id === selectedId) {
      // Where you are standing, marked under the tick rather than on it: a
      // highlight that recoloured the tick would hide that desk's status, and its
      // status is the reason the strip exists.
      c.rect(x, c.h - 2, tick, 1, P.accent);
    }
    sig.push(`${person.status[0]}${person.id === selectedId ? '*' : ''}${breaks[i] ? '|' : ''}`);
    x += unit;
  });

  return { canvas: c, signature: `s:${sig.join('')}@${tick}x${c.w}` };
}
