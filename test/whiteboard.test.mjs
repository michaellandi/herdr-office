// The punch clock, made visible: the whiteboard on the back wall and the shift
// line on a desk's card. The numbers themselves are tested in punchclock.test.mjs.
// What matters here is that writing them on the wall cannot break the wall, and
// that the wall is never the only place the office says something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, whiteboard } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, officeRoster, roomyRoster, viewOf, stripAnsi } from './fixtures.mjs';

const STATS = {
  open: 3 * 3600e3 + 41 * 60e3,
  spent: { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 },
  worked: 3 * 3600e3 + 40 * 60e3,
  waiting: 12 * 60e3 + 30e3,
  hands: 6,
  answers: 4,
  longest: 6 * 60e3 + 20e3,
  desks: 7,
  closed: 2,
};

const plain = (lines) => lines.map(stripAnsi);
const onWall = (lines) => plain(lines).some((l) => l.includes('open since'));

test('an office with nothing to report has a blank whiteboard', () => {
  // The first frame of every session. Three lines of zeros would be furniture
  // pretending to be information, and worse, it would be the wall shouting at you
  // before anything has happened.
  assert.equal(whiteboard(null, 0), null);
  assert.equal(whiteboard(undefined, 0), null);
  const fresh = { ...STATS, worked: 0, waiting: 0, hands: 0, answers: 0, longest: 0 };
  assert.equal(whiteboard(fresh, 0), null);
  // One second of work is enough. The board fills in as the day does.
  assert.ok(whiteboard({ ...fresh, worked: 1000 }, 0));
  assert.ok(whiteboard({ ...fresh, hands: 1 }, 0));
});

test('the board is a box, whatever the numbers do to it', () => {
  // The one thing that could not be allowed to happen: a row of the board wider
  // than the others, which shears the wall, or wider than the pane, which wraps
  // the whole screen. The numbers are formatted at runtime from a session that
  // could have been running for a week.
  const silly = [
    STATS,
    { ...STATS, worked: 0, waiting: 0, hands: 1, answers: 0, longest: 0 },
    { ...STATS, worked: 400 * 3600e3, waiting: 399 * 3600e3, longest: 398 * 3600e3, hands: 999999, answers: 123456 },
    { ...STATS, open: -1, worked: -5, waiting: -5, hands: -5, answers: -5, longest: -5, closed: -1 },
    { ...STATS, worked: 1e15, hands: Number.MAX_SAFE_INTEGER, answers: Number.MAX_SAFE_INTEGER },
  ];
  const widths = new Set();
  for (const stats of silly) {
    const board = whiteboard(stats, Date.UTC(2026, 8, 10, 12, 0, 0));
    if (!board) continue;
    assert.equal(board.rows.length, board.h);
    assert.equal(board.rowFg.length, board.h);
    for (const row of board.rows) {
      assert.equal(width(row), board.w, row);
      widths.add(width(row));
    }
  }
  assert.equal(widths.size, 1, 'every board ever drawn is the same width');
});

test('the whiteboard is furniture, so a small pane simply does not have one', () => {
  // It hangs in the strip of wall under the desks, which is the first thing the
  // floor gives up when there are more people than room. That is the right
  // priority: a desk you cannot see is a problem, a statistic you cannot see is
  // not, and nothing in the office is ONLY written on the wall.
  let seen = 0;
  for (const [cols, rows] of SIZES) for (const zoom of ['auto', 'list', 'cubicle']) {
    const people = officeRoster().people;
    const view = viewOf({ people, cols, rows, zoom, stats: STATS, selectedId: null });
    const { lines } = renderFrame(view);
    assert.equal(lines.length, rows, `${cols}x${rows} ${zoom} rows`);
    lines.forEach((l, i) => assert.equal(width(l), cols, `${cols}x${rows} ${zoom} line ${i}`));
    if (onWall(lines)) {
      seen += 1;
      // Where it is drawn, it is drawn in full: a board missing its bottom edge
      // would read as a rendering bug rather than as a small pane.
      const text = plain(lines);
      assert.ok(text.some((l) => l.includes('worked 3h40m')), `${cols}x${rows} ${zoom} worked`);
      assert.ok(text.some((l) => l.includes('4 from here')), `${cols}x${rows} ${zoom} answered`);
      assert.ok(text.some((l) => l.includes('worst 6m20s')), `${cols}x${rows} ${zoom} worst`);
    }
  }
  assert.ok(seen > 0, 'somewhere in this list is a pane big enough for a whiteboard');
});

test('the wall is paint, so nothing moves under the mouse', () => {
  // Same argument as the rooms: the board lives in the furniture band, below the
  // last desk, and it must not shift a single hitbox. Some of those boxes are
  // approve buttons.
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list', 'cubicle']) {
      const people = roomyRoster().people;
      const base = { people, cols, rows, zoom, selectedId: people[0].id };
      const bare = renderFrame(viewOf({ ...base })).hitboxes;
      const hung = renderFrame(viewOf({ ...base, stats: STATS })).hitboxes;
      assert.deepEqual(hung, bare, `${cols}x${rows} ${zoom}`);
    }
  }
});

test('a desk card says how its own day went', () => {
  // The office already says how long this desk has been blocked. The shift line is
  // the part it could never say: that it has been up for an hour and worked for
  // four minutes of it, and that you are the reason for the rest.
  const people = officeRoster().people;
  const shift = { onShift: 3600e3, worked: 4 * 60e3, waiting: 20 * 60e3, hands: 3, longest: 12 * 60e3 };
  const view = viewOf({ people, cols: 120, rows: 40, detail: people[0], selectedId: people[0].id, shift });
  const text = plain(renderFrame(view).lines).join('\n');
  assert.ok(text.includes('1h00m on shift'), text);
  assert.ok(text.includes('4m00s working'), text);
  assert.ok(text.includes('20m00s waiting on you'), text);
  assert.ok(text.includes('3 hands'), text);
  // A desk nobody has waited on says nothing about waiting, rather than boasting
  // about a zero.
  const quiet = viewOf({ people, cols: 120, rows: 40, detail: people[0], selectedId: people[0].id, shift: { onShift: 60e3, worked: 60e3, waiting: 0, hands: 0, longest: 0 } });
  const quietText = plain(renderFrame(quiet).lines).join('\n');
  assert.ok(quietText.includes('1m00s on shift'));
  assert.ok(!quietText.includes('waiting on you'));
  // ("hands" on its own appears in the footer hints, so this is the clock's own
  // phrasing: a count of hands next to a duration.)
  assert.ok(!/\d+ hands/.test(quietText));
  // And a desk the clock has never met (the office just opened, or it is the hire
  // tile) has no shift line at all rather than a row of zeros.
  const unseen = viewOf({ people, cols: 120, rows: 40, detail: people[0], selectedId: people[0].id, shift: null });
  assert.ok(!plain(renderFrame(unseen).lines).join('\n').includes('on shift'));
});
