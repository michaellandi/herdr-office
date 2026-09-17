#!/usr/bin/env node
// Writes the pixel charts to PNG files so you can look at them without a terminal
// that can draw, a running server, or a visible pane.
//
//   node scripts/preview-charts.mjs            write to /tmp, print the sizes
//   node scripts/preview-charts.mjs --out ./x  somewhere else
//   node scripts/preview-charts.mjs --zoom 1   at the real pixel size
//
// This exists because the charts were built by looking at them, and two real bugs
// were found that way and could not have been found any other way: the attention
// strip drew seven slabs instead of a countable skyline, and the gap marking a room
// break vanished exactly when there were enough desks for the grouping to matter.
// Neither is a wrong number, so no assertion would have caught either.
//
// It also prints the encoded size of every chart, which is the number that decided
// PNG over raw RGBA and is worth keeping an eye on: everything here goes down a
// socket, and the office redraws whenever a chart changes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas } from '../src/canvas.mjs';
import { timeChart, attentionStrip } from '../src/charts.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const OUT = arg('--out', '/tmp');
const ZOOM = Math.max(1, Number(arg('--zoom', 3)) || 3);

// What `pane.graphics.info` reports on a normal non-retina terminal. Pass --cell to
// see what a retina window gets, which is the same chart at twice the detail.
const CAPS = { cellW: Number(arg('--cell-w', 10)), cellH: Number(arg('--cell-h', 22)) };

// Nearest neighbour, for inspection only. Nothing in the office scales an image:
// charts are drawn at the terminal's real pixel size. This is here so a two-pixel
// antialiased corner is visible on a screen instead of being one grey dot.
function zoom(c, n) {
  if (n === 1) return c;
  const out = new Canvas(c.w * n, c.h * n);
  for (let y = 0; y < out.h; y += 1) {
    for (let x = 0; x < out.w; x += 1) {
      const i = (((y / n) | 0) * c.w + ((x / n) | 0)) * 4;
      const j = (y * out.w + x) * 4;
      out.data[j] = c.data[i];
      out.data[j + 1] = c.data[i + 1];
      out.data[j + 2] = c.data[i + 2];
      out.data[j + 3] = c.data[i + 3];
    }
  }
  return out;
}

const person = (id, status, workspaceId) => ({ id, status, workspaceId });

// A session with something in every bucket, so the stack has all five colours in it
// and the quarter marks have something to cross.
const BUSY = {
  open: 66 * 60e3,
  spent: { working: 41 * 60e3, blocked: 9 * 60e3, idle: 12 * 60e3, done: 4 * 60e3, unknown: 90e3 },
  worked: 41 * 60e3,
  waiting: 9 * 60e3,
  hands: 7,
  answers: 4,
  longest: 240e3,
  desks: 7,
  closed: 1,
};

const FLOOR = [
  person('w1:p1', 'working', 'w1'),
  person('w1:p2', 'blocked', 'w1'),
  person('w1:p3', 'working', 'w1'),
  person('w2:p1', 'idle', 'w2'),
  person('w2:p2', 'done', 'w2'),
  person('w3:p1', 'blocked', 'w3'),
  person('w3:p2', 'unknown', 'w3'),
];

const CROWD = Array.from({ length: 34 }, (_, i) =>
  person(`x${i}`, ['working', 'working', 'blocked', 'idle', 'done', 'unknown'][i % 6], `w${(i / 9) | 0}`),
);

// Each case is a shape the office really produces, not a demo: the first frame of a
// session, a crowded floor, a narrow pane. A chart that only looks right on the
// happy path is a chart that looks wrong most of the time.
const CASES = [
  ['board-busy', () => timeChart(BUSY, 38, 1, CAPS)],
  ['board-fresh', () => timeChart({ ...BUSY, spent: { working: 30e3 }, hands: 0, answers: 0 }, 38, 1, CAPS)],
  ['board-stuck', () => timeChart({ ...BUSY, spent: { ...BUSY.spent, blocked: 50 * 60e3 }, answers: 1 }, 38, 1, CAPS)],
  ['board-narrow', () => timeChart(BUSY, 20, 1, CAPS)],
  ['strip-floor', () => attentionStrip(FLOOR, 'w1:p3', 80, 1, CAPS)],
  ['strip-calm', () => attentionStrip(FLOOR.map((p) => ({ ...p, status: 'working' })), null, 80, 1, CAPS)],
  ['strip-crowd', () => attentionStrip(CROWD, 'x11', 80, 1, CAPS)],
  ['strip-wide', () => attentionStrip(FLOOR, 'w1:p1', 200, 1, CAPS)],
];

mkdirSync(OUT, { recursive: true });
const pad = Math.max(...CASES.map(([name]) => name.length));
for (const [name, build] of CASES) {
  const out = build();
  if (!out) {
    // Not a failure. A chart returns null when its rectangle is too small to say
    // anything honestly, and the office leaves the text it would have replaced.
    console.log(`${name.padEnd(pad)}  (declined: too small to draw)`);
    continue;
  }
  const png = out.canvas.png();
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, zoom(out.canvas, ZOOM).png());
  const raw = out.canvas.w * out.canvas.h * 4;
  console.log(
    `${name.padEnd(pad)}  ${String(out.canvas.w).padStart(4)}x${String(out.canvas.h).padStart(3)}` +
      `  ${String(png.length).padStart(5)}B png` +
      `  ${String(Math.round(raw / png.length)).padStart(3)}x smaller than raw` +
      `  ${out.signature}`,
  );
  if (ZOOM > 1) console.log(`${' '.repeat(pad)}  -> ${file} (at ${ZOOM}x for looking at)`);
  else console.log(`${' '.repeat(pad)}  -> ${file}`);
}
