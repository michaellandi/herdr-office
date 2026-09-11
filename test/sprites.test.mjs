// The art. sprites.mjs already throws on import if a pose or a screen drifts off
// its declared width, which is the right place for that check; these tests give
// those failures a name, and cover the invariants the renderer relies on but the
// module does not assert for itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSES, SCREENS, PROPS, POSE_W, SCREEN_W, ART_ROWS, HAIR_FROM, HAIR_TO } from '../src/sprites.mjs';
import { P } from '../src/theme.mjs';
import { width } from '../src/text.mjs';

test('every pose is exactly the declared size', () => {
  for (const [name, p] of Object.entries(POSES)) {
    p.frames.forEach((rows, i) => {
      assert.equal(rows.length, ART_ROWS, `pose ${name}[${i}] has ${rows.length} rows`);
      rows.forEach((row, j) => {
        assert.equal(width(row), POSE_W, `pose ${name}[${i}] row ${j} is ${width(row)} cells`);
      });
    });
  }
});

test('every screen line is exactly the declared size', () => {
  for (const [name, frames] of Object.entries(SCREENS)) {
    frames.forEach((rows, i) =>
      rows.forEach((row, j) => {
        assert.equal(width(row), SCREEN_W, `screen ${name}[${i}] row ${j} is ${width(row)} cells`);
      }),
    );
  }
});

test('the buttons are on the blocked screen where the renderer looks for them', () => {
  // render.mjs finds the clickable columns with indexOf on this exact string. If
  // the art is redrawn without them, the buttons silently move to column -1.
  for (const rows of SCREENS.blocked) {
    assert.ok(rows[1].includes('[y]'), 'the blocked screen has lost its [y]');
    assert.ok(rows[1].includes('[n]'), 'the blocked screen has lost its [n]');
  }
});

test('hair sits inside the top row of every pose', () => {
  assert.ok(HAIR_FROM >= 0 && HAIR_TO <= POSE_W, 'the hair span runs off the pose');
  for (const [name, p] of Object.entries(POSES)) {
    for (const rows of p.frames) {
      const hair = [...rows[0]].slice(HAIR_FROM, HAIR_TO).join('');
      assert.ok(hair.trim().length > 0, `pose ${name} has no hair in the hair columns`);
    }
  }
});

test('every prop is a rectangle of single-cell glyphs', () => {
  // propRow() maps columns straight onto array indices, so a two-cell glyph in a
  // plant would shift every prop to its right by one and skew the whole band.
  for (const [name, prop] of Object.entries(PROPS)) {
    assert.equal(prop.rows.length, prop.h, `prop ${name} claims ${prop.h} rows, has ${prop.rows.length}`);
    prop.rows.forEach((row, i) => {
      assert.equal(width(row), prop.w, `prop ${name} row ${i} is ${width(row)} cells, want ${prop.w}`);
      for (const ch of row) assert.equal(width(ch), 1, `prop ${name} row ${i} contains a ${width(ch)}-cell glyph: ${ch}`);
    });
  }
});

test('every prop row names a colour that exists', () => {
  for (const [name, prop] of Object.entries(PROPS)) {
    assert.equal(prop.rowFg.length, prop.h, `prop ${name} has ${prop.rowFg.length} colours for ${prop.h} rows`);
    prop.rowFg.forEach((key, i) => {
      assert.ok(P[key], `prop ${name} row ${i} wants palette colour "${key}", which is not in the palette`);
    });
  }
});

test('nothing in the art is an ambiguous-width glyph', () => {
  // Geometric Shapes and the emoji planes render one cell wide in some terminals
  // and two in others, which is unfixable once it is on the grid. Box drawing and
  // block elements are safe; anything past U+2600 is not.
  const art = [
    ...Object.values(POSES).flatMap((p) => p.frames.flat()),
    ...Object.values(SCREENS).flat(2),
    ...Object.values(PROPS).flatMap((p) => p.rows),
  ];
  for (const row of art) {
    for (const ch of row) {
      const cp = ch.codePointAt(0);
      // Block Elements end at U+259F, Geometric Shapes start at U+25A0.
      assert.ok(cp < 0x25a0, `art contains U+${cp.toString(16).toUpperCase()} (${ch}), whose width depends on the terminal`);
    }
  }
});
