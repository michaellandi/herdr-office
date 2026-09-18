// The rectangles the office is willing to give up to a pixel layer.
//
// This is the contract between src/render.mjs and src/graphics.mjs, and it is the
// one place a mistake is expensive: an image occludes the cells it covers, with no
// compositing, so a region that is one row too tall eats a line of text and there is
// nothing on screen to say it happened. Every test here is a rectangle landing
// exactly where it was meant to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, whiteboard } from '../src/render.mjs';
import { SIZES, officeRoster, roomyRoster, viewOf, stripAnsi } from './fixtures.mjs';

const STATS = {
  open: 3 * 3600e3 + 41 * 60e3,
  spent: { working: 600e3, blocked: 120e3, idle: 60e3, done: 30e3, unknown: 0 },
  worked: 3 * 3600e3 + 40 * 60e3,
  waiting: 12 * 60e3 + 30e3,
  hands: 6,
  answers: 4,
  longest: 6 * 60e3 + 20e3,
  desks: 7,
  closed: 2,
};

const frameAt = (cols, rows, extra = {}) =>
  renderFrame(viewOf({ people: officeRoster().people, cols, rows, stats: STATS, ...extra }));

const kinds = (out) => out.regions.map((r) => r.kind);
const find = (out, kind) => out.regions.find((r) => r.kind === kind);

test('every frame carries a regions list, even when it offers nothing', () => {
  // graphics.mjs iterates it unconditionally, and office.mjs decides what to cover
  // from it. An undefined list would be a crash on the smallest pane.
  for (const [cols, rows] of SIZES) {
    for (const stats of [null, STATS]) {
      const out = renderFrame(viewOf({ people: officeRoster().people, cols, rows, stats }));
      assert.ok(Array.isArray(out.regions), `${cols}x${rows}`);
    }
  }
});

test('a region never runs off the screen it was measured against', () => {
  // The single most damaging way to get this wrong. A rectangle past the bottom of
  // the pane is an image the terminal places somewhere the office did not intend,
  // and one past the right edge is a chart drawn over a scrollbar.
  for (const [cols, rows] of SIZES) {
    for (const people of [officeRoster().people, roomyRoster().people]) {
      for (const detail of [null, { ...people[0], detail: true }]) {
        const out = renderFrame(viewOf({ people, cols, rows, stats: STATS, detail }));
        for (const r of out.regions) {
          assert.ok(r.w > 0 && r.h > 0, `${r.kind} at ${cols}x${rows} has a real size`);
          assert.ok(r.x >= 0 && r.y >= 0, `${r.kind} at ${cols}x${rows} starts on screen`);
          assert.ok(r.x + r.w <= cols, `${r.kind} at ${cols}x${rows} ends by column ${cols}`);
          assert.ok(r.y + r.h <= rows, `${r.kind} at ${cols}x${rows} ends by row ${rows}`);
        }
      }
    }
  }
});

test('no two regions overlap', () => {
  // Two layers over the same cell is one of them invisible, and which one depends on
  // z-index arithmetic nobody wants to reason about.
  for (const [cols, rows] of SIZES) {
    const out = frameAt(cols, rows);
    for (let i = 0; i < out.regions.length; i += 1) {
      for (let j = i + 1; j < out.regions.length; j += 1) {
        const a = out.regions[i];
        const b = out.regions[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.kind} and ${b.kind} overlap at ${cols}x${rows}`);
      }
    }
  }
});

test('region kinds are unique, because a layer id is built from them', () => {
  for (const [cols, rows] of SIZES) {
    const list = kinds(frameAt(cols, rows));
    assert.equal(new Set(list).size, list.length, `${cols}x${rows}: ${list}`);
  }
});

/* ------------------------------------------------------------------- the strip */

test('the strip claims the blank row under the header and nothing else', () => {
  const out = frameAt(80, 24);
  const strip = find(out, 'strip');
  assert.deepEqual(strip, { kind: 'strip', x: 0, y: 1, w: 80, h: 1 });
});

test('the row the strip claims is empty carpet in the text render', () => {
  // The whole justification for offering it. Losing this row to an image costs the
  // office nothing, because there was never a word on it: it is the gap between the
  // header bar and the back wall.
  for (const [cols, rows] of SIZES) {
    const out = frameAt(cols, rows);
    const strip = find(out, 'strip');
    if (!strip) continue;
    const text = stripAnsi(out.lines[strip.y] ?? '');
    assert.equal(text.trim(), '', `${cols}x${rows} row ${strip.y} should be blank, got ${JSON.stringify(text)}`);
  }
});

test('a pane too short to have a spacer row offers no strip', () => {
  assert.ok(!kinds(frameAt(80, 1)).includes('strip'));
});

/* --------------------------------------------------------------- the whiteboard */

test('the board region is the bar row, and never the writing', () => {
  // The defect this was written for. The region used to be both interior rows, so the
  // chart deleted `worked 12m · waiting 3m` in order to draw a picture of it, and what
  // was left was five colours with nothing to say which one meant waiting. The words
  // must survive on both sides of the bar.
  const out = frameAt(140, 46);
  const board = find(out, 'board');
  assert.ok(board, 'a roomy floor plan hangs a whiteboard');
  assert.equal(board.h, 1, 'one row, because the other three are words and a frame');
  const plain = out.lines.map(stripAnsi);
  assert.ok((plain[board.y - 1] ?? '').includes('worked'), 'the time split is still in text above the bar');
  assert.ok((plain[board.y + 1] ?? '').includes('hands'), 'the hands line is still in text below it');
});

test('the row the board region claims is already a bar, not words', () => {
  // The permission rule for every region: a layer may only cover cells that were
  // already a picture. Here that is literal, so the fine bar and the coarse one say
  // the same thing and a terminal without graphics is not missing information.
  const out = frameAt(140, 46);
  const board = find(out, 'board');
  const row = (out.lines.map(stripAnsi)[board.y] ?? '').slice(board.x, board.x + board.w);
  assert.ok(row.includes('█'), `the bar row should hold blocks, held ${JSON.stringify(row)}`);
  assert.ok(!/[a-z]/.test(row), `the bar row should hold no words, held ${JSON.stringify(row)}`);
});

test('the board region matches the whiteboard the renderer actually drew', () => {
  // The row index comes from whiteboard(), so inserting or moving a line has to move
  // the rectangle with it or the chart will land on top of a sentence.
  const board = whiteboard(STATS, Date.now());
  const region = find(frameAt(140, 46), 'board');
  const out = frameAt(140, 46);
  const plain = out.lines.map(stripAnsi);
  const title = plain.findIndex((l) => l.includes('open since'));
  assert.equal(region.y, title + board.barRow, 'the region sits at the board own bar row');
  assert.equal(region.h, 1);
});

test('no whiteboard, no board region', () => {
  // The first frame of a session, before anything has happened. There is nothing on
  // the wall to replace.
  const out = renderFrame(viewOf({ people: officeRoster().people, cols: 140, rows: 46, stats: null }));
  assert.ok(!kinds(out).includes('board'));
});

test('a floor too cramped to hang a whiteboard offers no board region', () => {
  // The compact list and the small floor plans do not draw one, and the region list
  // must agree with the picture rather than with the intent.
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list', 'cubicle']) {
      const out = frameAt(cols, rows, { zoom });
      const hasBoard = kinds(out).includes('board');
      const onWall = out.lines.some((l) => stripAnsi(l).includes('open since'));
      assert.equal(hasBoard, onWall, `${cols}x${rows} ${zoom}: region and wall disagree`);
    }
  }
});

test('a detail card covering the floor takes the whiteboard region with it', () => {
  const out = frameAt(140, 46, { detail: { ...officeRoster().people[0], explain: null } });
  const onWall = out.lines.some((l) => stripAnsi(l).includes('open since'));
  assert.equal(kinds(out).includes('board'), onWall);
});
