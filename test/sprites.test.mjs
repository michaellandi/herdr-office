// The art. sprites.mjs already throws on import if a pose or a screen drifts off
// its declared width, which is the right place for that check; these tests give
// those failures a name, and cover the invariants the renderer relies on but the
// module does not assert for itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSES, MANAGER_POSES, SCREENS, PROPS, VACANT_CHAIR, VACANT_SCREEN, runningScreen, pose, screen, managerPose, POSE_W, SCREEN_W, ART_ROWS, HAIR_FROM, HAIR_TO } from '../src/sprites.mjs';
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

test('the empty chair fits the same footprint as a person', () => {
  // It is drawn into the same tile rows as a pose and a screen, so it has to be
  // the same size, even though it lives outside POSES.
  assert.equal(VACANT_CHAIR.length, ART_ROWS);
  VACANT_CHAIR.forEach((row, i) => assert.equal(width(row), POSE_W, `the vacant chair row ${i} is ${width(row)} cells`));
  VACANT_SCREEN.forEach((row, i) => assert.equal(width(row), SCREEN_W, `the vacant screen row ${i} is ${width(row)} cells`));
});

test('the manager fits the same footprint as a person', () => {
  // It lives outside POSES for the reason the empty chair does: it is not an agent
  // status and must never be reachable by a lookup on one. Which means every check
  // written over POSES misses it, and this is the one that catches that.
  for (const [name, p] of Object.entries(MANAGER_POSES)) {
    p.frames.forEach((rows, i) => {
      assert.equal(rows.length, ART_ROWS, `manager pose ${name}[${i}] has ${rows.length} rows`);
      rows.forEach((row, j) => {
        assert.equal(width(row), POSE_W, `manager pose ${name}[${i}] row ${j} is ${width(row)} cells`);
      });
      const hair = [...rows[0]].slice(HAIR_FROM, HAIR_TO).join('');
      assert.ok(hair.trim().length > 0, `manager pose ${name}[${i}] has no hair in the hair columns`);
    });
  }
  // And the clipboard is in both states, because it is the prop that says which desk
  // this is: a figure at a keyboard with no clipboard is just another agent.
  for (const [name, p] of Object.entries(MANAGER_POSES)) {
    for (const rows of p.frames) assert.ok(rows[2].includes('┌┐'), `manager pose ${name} has lost its clipboard`);
  }
});

test('a name or a frame the art does not have still draws something', () => {
  // Every lookup in this module falls back rather than throwing, because all three are
  // called from inside the repaint: a status herdr has not taught the office about, or
  // a frame counter that is not a number, has to cost a wrong-looking sprite rather
  // than the whole office. The negative frame is the one that was actually broken:
  // `frames[frame % n]` indexes past the start of the array and hands back undefined.
  const names = ['watching', 'news', 'blocked', 'nonsense', '', null, undefined];
  const frames = [0, 1, 2, 3, 99, -1, -7, NaN, null, undefined, 1.5];
  for (const name of names) {
    for (const frame of frames) {
      const at = `${name} f${frame}`;
      const m = managerPose(name, frame);
      assert.equal(m.rows.length, ART_ROWS, `manager ${at} gave ${m.rows.length} rows`);
      for (const row of m.rows) assert.equal(width(row), POSE_W, `manager ${at}: "${row}" is ${width(row)} cells`);
      const p = pose(name, frame);
      assert.equal(p.rows.length, ART_ROWS, `pose ${at} gave ${p.rows.length} rows`);
      for (const row of p.rows) assert.equal(width(row), POSE_W, `pose ${at}: "${row}" is ${width(row)} cells`);
      const rows = screen(name, frame);
      assert.ok(Array.isArray(rows), `screen ${at} gave ${rows}`);
      for (const row of rows) assert.equal(width(row), SCREEN_W, `screen ${at}: "${row}" is ${width(row)} cells`);
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
    ...Object.values(MANAGER_POSES).flatMap((p) => p.frames.flat()),
    ...Object.values(SCREENS).flat(2),
    ...Object.values(PROPS).flatMap((p) => p.rows),
    ...VACANT_CHAIR,
    ...VACANT_SCREEN,
    // The chugging bar is generated rather than tabled, so it has to be swept too.
    ...[0, 1, 2, 3, 4, 11, 12].flatMap((f) => runningScreen('npm test', f)),
  ];
  for (const row of art) {
    for (const ch of row) {
      const cp = ch.codePointAt(0);
      // Block Elements end at U+259F, Geometric Shapes start at U+25A0.
      assert.ok(cp < 0x25a0, `art contains U+${cp.toString(16).toUpperCase()} (${ch}), whose width depends on the terminal`);
    }
  }
});

test('the running monitor is the same twelve cells whatever it is told', () => {
  // Generated art, so the width rule is not something a table can be eyeballed
  // for: a command label comes off a real process on somebody's machine, and the
  // grid does not care how long that was.
  const labels = ['', 'npm test', 'x', 'cargo build --release --all-features', 'gradlew assembleRelease', null, undefined];
  for (const label of labels) {
    for (let frame = 0; frame < 24; frame += 1) {
      const rows = runningScreen(label, frame);
      assert.equal(rows.length, 2, `${label} f${frame} gave ${rows.length} rows`);
      for (const r of rows) {
        assert.equal([...r].length, SCREEN_W, `${JSON.stringify(label)} f${frame}: "${r}" is ${[...r].length} cells`);
        assert.equal(width(r), SCREEN_W, `${JSON.stringify(label)} f${frame}: "${r}" is ${width(r)} wide`);
      }
    }
  }
  // The label is centred, and the bar under it actually moves.
  assert.equal(runningScreen('npm test', 0)[0], '  npm test  ');
  assert.notEqual(runningScreen('npm test', 0)[1], runningScreen('npm test', 1)[1]);
});
