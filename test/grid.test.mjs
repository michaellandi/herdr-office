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
import { renderFrame } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, DETAILS, officeRoster, viewOf } from './fixtures.mjs';

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
  // Its own layout: no desks, two lines of prose, and the furniture. The second
  // line is 63 characters, which is wider than several of these panes.
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: [], cols, rows }), `empty ${cols}x${rows}`);
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

test('a footer message never pushes a line over', () => {
  const long = 'could not answer Ada: the socket hung up halfway through sending the keys';
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people, cols, rows, message: long }), `message ${cols}x${rows}`);
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
