// The canvas. Every one of these is about a chart being unable to hurt itself:
// arithmetic that lands outside the box clips instead of throwing, and a rounded
// corner is antialiased rather than a staircase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, cellCanvas } from '../src/canvas.mjs';

const CAPS = { cellW: 10, cellH: 22 };
const at = (c, x, y) => {
  const i = (y * c.w + x) * 4;
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
};

test('a canvas starts fully transparent', () => {
  // Which matters: a layer is placed over cells the office gave up, and an
  // uninitialised canvas full of opaque black would be a hole in the floor.
  const c = new Canvas(3, 2);
  assert.equal(c.data.length, 24);
  assert.ok([...c.data].every((v) => v === 0));
});

test('a cell canvas is exactly as many pixels as the cells it covers', () => {
  const c = cellCanvas(4, 2, CAPS);
  assert.equal(c.w, 40);
  assert.equal(c.h, 44);
  // Retina hands back a bigger cell, and the same chart gets twice the detail for
  // free rather than being scaled up.
  assert.equal(cellCanvas(4, 2, { cellW: 20, cellH: 44 }).w, 80);
});

test('a zero-column region still makes a canvas rather than a zero-byte one', () => {
  // encodePNG refuses a zero dimension, on purpose. The floor for a region is one
  // cell so a degenerate layout produces a tiny picture, not a thrown frame.
  const c = cellCanvas(0, 0, CAPS);
  assert.equal(c.w, 10);
  assert.equal(c.h, 22);
});

test('drawing outside the canvas clips instead of throwing or wrapping', () => {
  // The important half is "or wrapping". A negative x that wrapped would put pixels
  // on the far right of the row above, which reads as corruption rather than as a
  // clipping bug and is very hard to trace back here.
  const c = new Canvas(4, 4);
  c.rect(-3, -3, 4, 4, '#ffffff');
  c.rect(3, 3, 10, 10, '#ffffff');
  c.px(100, 100, '#ffffff');
  c.px(-1, 2, '#ffffff');
  assert.deepEqual(at(c, 0, 0), [255, 255, 255, 255], 'the one pixel that was inside');
  assert.deepEqual(at(c, 3, 3), [255, 255, 255, 255]);
  assert.deepEqual(at(c, 3, 0), [0, 0, 0, 0], 'nothing wrapped onto this row');
  assert.deepEqual(at(c, 0, 2), [0, 0, 0, 0]);
});

test('opaque paint replaces, translucent paint blends with what is under it', () => {
  const c = new Canvas(2, 1);
  c.fill('#000000');
  c.px(0, 0, '#ffffff');
  assert.deepEqual(at(c, 0, 0), [255, 255, 255, 255]);
  c.px(1, 0, '#ffffff', 0.5);
  const [r, g, b, a] = at(c, 1, 0);
  assert.ok(r > 120 && r < 136, `expected a mid grey, got ${r}`);
  assert.equal(r, g);
  assert.equal(g, b);
  assert.equal(a, 255, 'blending onto opaque paint stays opaque');
});

test('alpha of zero is a no-op, not a hole', () => {
  // The quarter marks on the whiteboard bar are drawn at 0.35, and a chart is free
  // to compute its way to 0. That must leave the bar alone rather than erase it.
  const c = new Canvas(1, 1);
  c.fill('#123456');
  c.px(0, 0, '#ffffff', 0);
  assert.deepEqual(at(c, 0, 0), [0x12, 0x34, 0x56, 255]);
});

test('fill covers every pixel', () => {
  const c = new Canvas(5, 3);
  c.fill('#0a141e');
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 5; x += 1) assert.deepEqual(at(c, x, y), [10, 20, 30, 255], `${x},${y}`);
  }
});

test('lines are one pixel thick in the direction they are not going', () => {
  const c = new Canvas(6, 6);
  c.hline(1, 2, 4, '#ffffff');
  c.vline(4, 1, 3, '#ffffff');
  assert.equal(at(c, 0, 2)[3], 0);
  assert.equal(at(c, 1, 2)[3], 255);
  assert.equal(at(c, 1, 3)[3], 0, 'hline did not bleed down a row');
  assert.equal(at(c, 4, 1)[3], 255);
  assert.equal(at(c, 5, 1)[3], 0, 'vline did not bleed across a column');
});

test('rounded corners are softened, and the straight edges are not', () => {
  const c = new Canvas(20, 10);
  c.round(0, 0, 20, 10, 3, '#ffffff');
  // The very corner pixel is mostly outside the arc, so it is faint or empty.
  assert.ok(at(c, 0, 0)[3] < 200, 'corner should not be fully painted');
  // Halfway down the left edge is straight, and must be solid: an antialiasing rule
  // that leaked into the edges would make every bar look blurry.
  assert.equal(at(c, 0, 5)[3], 255);
  assert.equal(at(c, 10, 0)[3], 255, 'the top edge between the corners is straight');
  assert.equal(at(c, 10, 5)[3], 255, 'and the middle is filled');
});

test('a radius of zero is a plain rectangle, corners included', () => {
  const c = new Canvas(6, 6);
  c.round(0, 0, 6, 6, 0, '#ffffff');
  for (const [x, y] of [
    [0, 0],
    [5, 0],
    [0, 5],
    [5, 5],
  ]) {
    assert.equal(at(c, x, y)[3], 255, `${x},${y}`);
  }
});

test('a radius bigger than the box gives a capsule, not a shape turned inside out', () => {
  // The hands bar asks for a radius of 2 in a box that can be three pixels tall on a
  // small cell. Clamping is what keeps that a pill instead of a negative-width arc.
  const c = new Canvas(20, 4);
  c.round(0, 0, 20, 4, 50, '#ffffff');
  assert.equal(at(c, 10, 2)[3], 255, 'the middle is still filled');
  assert.ok(at(c, 0, 0)[3] < 255);
});

test('every primitive returns the canvas, so charts can chain', () => {
  const c = new Canvas(4, 4);
  assert.equal(c.fill('#000000'), c);
  assert.equal(c.rect(0, 0, 1, 1, '#ffffff'), c);
  assert.equal(c.round(0, 0, 2, 2, 1, '#ffffff'), c);
  assert.equal(c.hline(0, 0, 2, '#ffffff'), c);
  assert.equal(c.vline(0, 0, 2, '#ffffff'), c);
  assert.equal(c.px(0, 0, '#ffffff'), c);
});

test('png() encodes at the canvas size', () => {
  const png = new Canvas(12, 7).fill('#1c2331').png();
  assert.equal(png.readUInt32BE(16), 12);
  assert.equal(png.readUInt32BE(20), 7);
});
