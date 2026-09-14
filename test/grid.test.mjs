// The load-bearing test. Everything the office draws goes onto a fixed cell
// grid, and the repaint in office.mjs writes lines straight to the terminal
// without measuring them. One row wider than the pane wraps, which shoves every
// row below it down by one and corrupts the whole screen until something forces
// a full redraw. In someone else's terminal, in a pane they did not open.
//
// So: every frame is exactly `rows` lines, and every line is exactly `cols`
// cells. No exceptions, no sizes excused, every layout branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, HIRE_ID } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, DETAILS, DRAGS, HIRES, COMPOSES, NEWS, officeRoster, viewOf } from './fixtures.mjs';

function assertExact(view, label) {
  const { cols, rows } = view.size;
  const { lines } = renderFrame(view);
  assert.equal(lines.length, rows, `${label}: ${lines.length} lines, want ${rows}`);
  lines.forEach((line, i) => {
    assert.equal(width(line), cols, `${label}: line ${i} is ${width(line)} cells, want ${cols}`);
  });
}

const people = officeRoster().people;

test('desks, at every size and in every frame', () => {
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) {
      assertExact(viewOf({ people, cols, rows, frame }), `${cols}x${rows} f${frame}`);
    }
  }
});

test('with a desk open, in every state the panel can be in', () => {
  for (const [cols, rows] of SIZES) {
    for (const [name, detail] of DETAILS) {
      assertExact(viewOf({ people, cols, rows, detail }), `${cols}x${rows} panel=${name}`);
    }
  }
});

test('an empty office', () => {
  // Two branches, depending on the pane: big enough for one desk and it draws the
  // empty one, too small and it is two lines of prose plus the furniture. The
  // prose is 61 characters, which is wider than several of these panes.
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: [], cols, rows }), `empty ${cols}x${rows}`);
    assertExact(viewOf({ people: [], cols, rows, selectedId: HIRE_ID }), `empty at the desk ${cols}x${rows}`);
  }
});

test('one desk, and enough desks to page', () => {
  const one = officeRoster(['blocked']).people;
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: one, cols, rows }), `one ${cols}x${rows}`);
    // Forty desks overflows any pane, so this is the compact list and the paging
    // note, not the desk grid.
    assertExact(viewOf({ people: many, cols, rows }), `forty ${cols}x${rows}`);
    assertExact(viewOf({ people: many, cols, rows, selectedId: 'w1:p40' }), `forty last page ${cols}x${rows}`);
  }
});

test('a monitor showing a real command, at every size and frame', () => {
  // The running monitor is generated rather than drawn from a table: the command
  // is centred in the twelve cells a screen has and the bar under it rotates every
  // frame. So the sizes matter (the label has to be cut, not wrapped) and so do
  // more frames than usual, because the bar's rotation is what changes.
  const busyFloor = officeRoster(new Array(5).fill('working')).people;
  assert.ok(
    busyFloor.some((p) => p.command) && busyFloor.some((p) => !p.command),
    'the fixture should have both named and unnamed working desks',
  );
  for (const [cols, rows] of SIZES) {
    for (let frame = 0; frame < 13; frame += 1) {
      assertExact(viewOf({ people: busyFloor, cols, rows, frame }), `running ${cols}x${rows} f${frame}`);
      assertExact(viewOf({ people: busyFloor, cols, rows, frame, detail: DETAILS[3][1] }), `running+panel ${cols}x${rows} f${frame}`);
    }
  }
  // A command long enough to need cutting, on a floor small enough to draw desks.
  const wordy = officeRoster(['working']).people;
  wordy[0].command = 'gradlew assembleReleaseWithAVeryLongTaskName';
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) assertExact(viewOf({ people: wordy, cols, rows, frame }), `wordy ${cols}x${rows} f${frame}`);
  }
});

test('news over a desk, in every kind and at every size', () => {
  // The slab hangs on the same wall as the speech bubble and in the same columns,
  // so the sizes that matter are the ones where the wall is barely there at all.
  // A blocked desk is included on purpose: the ask owns that row, and news must
  // not appear alongside it or fight it for the space.
  for (const news of NEWS) {
    const floor = officeRoster().people.map((p) => ({ ...p, event: { ...news } }));
    for (const [cols, rows] of SIZES) {
      for (const frame of FRAMES) {
        assertExact(viewOf({ people: floor, cols, rows, frame }), `news=${news.kind}/${news.label.length} ${cols}x${rows} f${frame}`);
      }
      // And the compact list, where news takes over the pane title for a moment.
      const many = officeRoster(new Array(40).fill('working')).people.map((p) => ({ ...p, event: { ...news } }));
      assertExact(viewOf({ people: many, cols, rows }), `news list ${cols}x${rows}`);
    }
  }
  // A stuck desk keeps saying what it needs: the ask wins the wall.
  const { lines } = renderFrame(viewOf({
    people: officeRoster(['blocked']).people.map((p) => ({ ...p, event: { label: 'tests passed', kind: 'good' } })),
    cols: 105,
    rows: 45,
  }));
  const text = lines.join('\n');
  assert.ok(text.includes('shell requires approval'), 'the ask should still be on the wall');
  assert.ok(!text.includes('tests passed'), 'news must not push the ask off a stuck desk');
});

test('a footer message never pushes a line over', () => {
  const long = 'could not answer Ada: the socket hung up halfway through sending the keys';
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people, cols, rows, message: long }), `message ${cols}x${rows}`);
  }
});

test('dragging a desk, in every drag state', () => {
  // Drag feedback is meant to be colour only. If a drop target ever grows a
  // glyph or an extra cell, the whole floor wraps, so it is checked here rather
  // than trusted.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, drag] of DRAGS) {
      assertExact(viewOf({ people, cols, rows, drag }), `drag=${name} ${cols}x${rows}`);
      assertExact(viewOf({ people, cols, rows, drag, detail: DETAILS[3][1] }), `drag=${name} +panel ${cols}x${rows}`);
      // Forty desks is the compact list, which paints drag state as a row
      // background instead of a border.
      assertExact(viewOf({ people: many, cols, rows, drag }), `drag=${name} list ${cols}x${rows}`);
    }
    // A swap in flight pales its two desks whether or not anything is being
    // dragged right now.
    assertExact(viewOf({ people, cols, rows, busy: new Set(['w1:p1', 'w1:p3']) }), `busy ${cols}x${rows}`);
    assertExact(viewOf({ people: many, cols, rows, busy: new Set(['w1:p1', 'w1:p3']) }), `busy list ${cols}x${rows}`);
  }
});

test('hiring, in every state the menu can be in', () => {
  // The menu is a grid inside a grid: twenty-one names in fixed cells, laid out in
  // however many columns fit, with a name in there deliberately far longer than a
  // cell. Same rule as everything else, no line over.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, hire] of HIRES) {
      assertExact(viewOf({ people, cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} ${cols}x${rows}`);
      // With nobody in the office, the empty desk is the only thing on the floor.
      assertExact(viewOf({ people: [], cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} empty ${cols}x${rows}`);
      // And over the compact list, where there is no empty desk to stand at but
      // the menu still opens on the key.
      assertExact(viewOf({ people: many, cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} list ${cols}x${rows}`);
    }
  }
});

test('assigning work, in every state the field can be in', () => {
  // Almost everything in this panel is generated at render time: the prompt wraps
  // to whatever width is left, the recipients line is a sentence built out of names
  // that may not fit, and a broadcast to thirty desks has to become a count rather
  // than a second row nobody budgeted for.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, compose] of COMPOSES) {
      assertExact(viewOf({ people, cols, rows, compose }), `compose=${name} ${cols}x${rows}`);
      assertExact(viewOf({ people: [], cols, rows, compose }), `compose=${name} empty ${cols}x${rows}`);
      assertExact(viewOf({ people: many, cols, rows, compose }), `compose=${name} list ${cols}x${rows}`);
    }
  }
  // The field outranks the other two panels, and asking for all three at once must
  // still come out as one panel's worth of rows rather than a stack of them.
  const compose = COMPOSES[3][1];
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people, cols, rows, compose, detail: DETAILS[3][1] }), `compose+detail ${cols}x${rows}`);
    assertExact(viewOf({ people, cols, rows, compose, hire: HIRES[2][1] }), `compose+hire ${cols}x${rows}`);
  }
});

test('a pane title full of junk cannot skew the grid', () => {
  // Agents put anything in a terminal title. sanitize() is supposed to drop the
  // ambiguous-width glyphs before they reach the grid; this is the proof.
  const roster = officeRoster();
  roster.people[1].title = '🚀 建立 sandbox ██ [31mred[0m  ▪▪▪';
  roster.people[2].tabName = '日本語のタブ名';
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: roster.people, cols, rows }), `junk ${cols}x${rows}`);
  }
});
