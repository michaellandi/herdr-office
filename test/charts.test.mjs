// The two charts. What is tested here is not how they look, which is checked by
// rendering them and looking; it is the two properties the office depends on and
// cannot see: that a bar exactly fills its own track, and that the signature
// changes when the picture would and not when it would not.
//
// The signature is load-bearing. src/graphics.mjs sends nothing for an unchanged
// one, so a signature that never changes is a chart frozen on the first frame, and
// one that changes every frame is a PNG on the wire three times a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allot, timeChart, attentionStrip } from '../src/charts.mjs';
import { officeRoster, roomyRoster } from './fixtures.mjs';

const CAPS = { cellW: 10, cellH: 22, visible: true, maxLayers: 16 };

const STATS = {
  open: 3 * 3600e3,
  spent: { working: 600e3, blocked: 120e3, idle: 60e3, done: 30e3, unknown: 0 },
  worked: 600e3,
  waiting: 120e3,
  hands: 6,
  answers: 4,
  longest: 380e3,
  desks: 7,
  closed: 2,
};

const alpha = (c) => {
  let n = 0;
  for (let i = 3; i < c.data.length; i += 4) if (c.data[i] > 0) n += 1;
  return n;
};

// The topmost row holding anything other than the background the chart filled
// itself with. Which is how you measure a skyline: the strip is painted edge to
// edge, so counting painted pixels says nothing, but how high the tallest tick
// reaches says everything.
const skyline = (c) => {
  const bg = [c.data[0], c.data[1], c.data[2]];
  for (let y = 0; y < c.h; y += 1) {
    for (let x = 0; x < c.w; x += 1) {
      const i = (y * c.w + x) * 4;
      if (c.data[i] !== bg[0] || c.data[i + 1] !== bg[1] || c.data[i + 2] !== bg[2]) return y;
    }
  }
  return c.h;
};

/* ----------------------------------------------------------------- allot */

test('allot hands out exactly the total, however the fractions fall', () => {
  // The reason this function exists. Rounding each segment independently leaves the
  // stack one or two pixels short of its own track, and that gap lands on the end of
  // the last colour where it reads as a rendering fault rather than as rounding.
  for (const total of [8, 33, 100, 271, 380]) {
    for (const values of [
      [1, 1, 1],
      [1, 2, 3, 4, 5],
      [7, 0, 0, 0, 1],
      [1e6, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
    ]) {
      const out = allot(values, total);
      assert.equal(
        out.reduce((a, b) => a + b, 0),
        total,
        `${values} into ${total}`,
      );
      assert.ok(
        out.every((v) => Number.isInteger(v) && v >= 0),
        'widths are non-negative integers',
      );
    }
  }
});

test('allot gives nothing away when there is nothing to give', () => {
  assert.deepEqual(allot([0, 0, 0], 100), [0, 0, 0]);
  assert.deepEqual(allot([1, 2], 0), [0, 0]);
  assert.deepEqual(allot([], 50), []);
});

test('allot is stable: the same numbers always draw the same bar', () => {
  // Without the index tiebreak, two segments with equal remainders could swap which
  // one gets the spare pixel between frames, and the bar would shimmer.
  const once = allot([1, 1, 1, 1], 10);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(allot([1, 1, 1, 1], 10), once);
});

test('allot lets a sub-pixel slice vanish rather than overstate it', () => {
  // Largest remainder, honestly applied: one percent of a forty-pixel track is less
  // than half a pixel, and rounding it up to one would draw a slice four times its
  // real size. On a track wide enough to hold it, it appears.
  assert.deepEqual(allot([100, 1], 40), [40, 0]);
  assert.ok(allot([100, 1], 400)[1] >= 1, 'the same minority shows on a wider bar');
});

/* ------------------------------------------------------------ the whiteboard */

test('no stats, no chart', () => {
  // The first frame of a session. The text renderer already declines to draw a
  // whiteboard with nothing on it, and the chart follows the same rule so the two
  // never disagree about whether the wall exists.
  assert.equal(timeChart(null, 38, 1, CAPS), null);
});

test('the whiteboard chart fills the rectangle it was given', () => {
  const out = timeChart(STATS, 38, 1, CAPS);
  assert.equal(out.canvas.w, 380);
  // One row, not two. The second row went back to being the `hands 7` line it always
  // should have been.
  assert.equal(out.canvas.h, 22);
  assert.ok(alpha(out.canvas) > 380 * 22 * 0.9, 'the background is painted, so no cells show through');
});

test('a rectangle too narrow to say anything says nothing', () => {
  // A pane squeezed until the whiteboard is a few cells wide. Returning null leaves
  // the text in place, which at that width is still readable; a two-pixel stacked
  // bar would not be.
  assert.equal(timeChart(STATS, 1, 1, { cellW: 4, cellH: 8 }), null);
});

test('the signature moves when the proportions move', () => {
  const base = timeChart(STATS, 38, 1, CAPS).signature;
  const shifted = timeChart(
    { ...STATS, spent: { ...STATS.spent, blocked: 600e3 } },
    38,
    1,
    CAPS,
  ).signature;
  assert.notEqual(base, shifted);
});

test('the signature holds still when the numbers move but the picture cannot', () => {
  // The whole damage argument. The office repaints every 320ms and these numbers
  // tick every second, but a millisecond does not move a pixel on a 360px track, so
  // nothing should go on the wire.
  const base = timeChart(STATS, 38, 1, CAPS).signature;
  const nudged = timeChart({ ...STATS, spent: { ...STATS.spent, working: 600e3 + 7 } }, 38, 1, CAPS).signature;
  assert.equal(base, nudged);
});

test('the signature moves when the chart is resized', () => {
  // Same proportions, different track: the picture is genuinely different, and the
  // placement key alone would not catch a canvas that changed shape.
  const narrow = timeChart(STATS, 20, 1, CAPS).signature;
  const wide = timeChart(STATS, 38, 1, CAPS).signature;
  assert.notEqual(narrow, wide);
});

test('the chart says nothing about hands, because the words already do', () => {
  // There used to be a second bar here for answered-of-raised. It went because
  // `hands 7 · 4 from here` is exact, and a picture of four sevenths beside that
  // sentence was a chart competing with a number it could not beat. So hands must not
  // reach the signature at all: if they did, the layer would be redrawn every time a
  // hand went up without the picture changing.
  const base = timeChart(STATS, 38, 1, CAPS).signature;
  assert.equal(timeChart({ ...STATS, hands: 99, answers: 40 }, 38, 1, CAPS).signature, base);
  assert.ok(!base.includes('h:'), `signature ${base} should carry only the time split`);
});

test('missing buckets are zeros, not crashes', () => {
  // stats.spent comes off the punch clock, and an office that has only just opened
  // may not have every key in it yet.
  assert.ok(timeChart({ hands: 0 }, 38, 1, CAPS));
  assert.ok(timeChart({ spent: {}, hands: 3, answers: 1 }, 38, 1, CAPS));
});

/* --------------------------------------------------------- the attention strip */

test('an empty floor has no strip', () => {
  assert.equal(attentionStrip([], null, 80, 1, CAPS), null);
  assert.equal(attentionStrip(null, null, 80, 1, CAPS), null);
});

test('the strip fills the row it was given', () => {
  const out = attentionStrip(officeRoster().people, null, 80, 1, CAPS);
  assert.equal(out.canvas.w, 800);
  assert.equal(out.canvas.h, 22);
});

test('a row too narrow for one tick per desk draws nothing', () => {
  // Better a spacer row than a row of marks that cannot be told apart, because a
  // strip you cannot count is a strip that lies about how many desks there are.
  assert.equal(attentionStrip(roomyRoster().people, null, 4, 1, { cellW: 2, cellH: 8 }), null);
});

test('ticks stay countable rather than dividing up the whole row', () => {
  // The defect this was written for: seven desks on an eighty-column pane produced
  // seven slabs a hundred pixels wide, which reads as a bar chart of something and
  // loses the one property that earns the layer.
  //
  // Three cells is the cap rather than two because two was invisible: five desks on
  // a wide pane came to 1.2% ink, all of it in the leftmost hundred pixels. A tick
  // still has to be a tick, so the ceiling stays, it is just high enough to see.
  const out = attentionStrip(officeRoster().people, null, 80, 1, CAPS);
  const tick = Number(out.signature.match(/@(\d+)x/)[1]);
  assert.ok(tick > 0 && tick <= CAPS.cellW * 3, `tick of ${tick}px should be at most three cells`);
});

test('a small floor is centred, not left in the corner of a wide row', () => {
  // Five desks cannot fill a 238-column row at any honest tick size, so the question
  // is only where the group sits. In the corner it reads as a half-drawn thing; in
  // the middle it reads as deliberate.
  const five = ['working', 'blocked', 'working', 'idle', 'unknown'].map((status, i) => ({
    id: `p${i}`,
    status,
    workspaceId: 'w1',
  }));
  const out = attentionStrip(five, null, 238, 1, CAPS);
  const c = out.canvas;
  const bg = [c.data[0], c.data[1], c.data[2]];
  const painted = [];
  for (let x = 0; x < c.w; x += 1) {
    for (let y = 0; y < c.h; y += 1) {
      const i = (y * c.w + x) * 4;
      if (c.data[i] !== bg[0] || c.data[i + 1] !== bg[1] || c.data[i + 2] !== bg[2]) {
        painted.push(x);
        break;
      }
    }
  }
  const mid = (painted[0] + painted[painted.length - 1]) / 2;
  // Within a cell of the middle of the row. Not exact, because the group is built
  // from whole pixels and an odd remainder has to land on one side.
  assert.ok(
    Math.abs(mid - c.w / 2) <= CAPS.cellW,
    `group centre at ${Math.round(mid)}px should be near the row centre ${c.w / 2}px`,
  );
  assert.ok(painted[0] > CAPS.cellW * 4, 'and well clear of the left edge');
});

test('a crowded floor still fills the row rather than sitting inset', () => {
  // The centring must not become an indent. It can only ever move the group by the
  // slack left over after the ticks are laid out, so a floor that nearly fills the
  // row must still nearly fill it: the leftover is under one desk slot, split in two.
  const many = roomyRoster(
    Array.from({ length: 34 }, (_, i) => (i % 5) + 1),
    Array.from({ length: 34 }, (_, i) => ['working', 'blocked', 'idle', 'done'][i % 4]),
  );
  const out = attentionStrip(many.people, null, 80, 1, CAPS);
  const c = out.canvas;
  const bg = [c.data[0], c.data[1], c.data[2]];
  const painted = [];
  for (let x = 0; x < c.w; x += 1) {
    for (let y = 0; y < c.h; y += 1) {
      const i = (y * c.w + x) * 4;
      if (c.data[i] !== bg[0] || c.data[i + 1] !== bg[1] || c.data[i + 2] !== bg[2]) {
        painted.push(x);
        break;
      }
    }
  }
  const room = c.w - CAPS.cellW * 4;
  const span = painted[painted.length - 1] - painted[0];
  assert.ok(span / room > 0.85, `crowded floor should still span the row, covered ${Math.round((100 * span) / room)}%`);
});

test('a crowded floor shrinks its ticks to fit instead of giving up', () => {
  const many = roomyRoster(
    Array.from({ length: 34 }, (_, i) => (i % 5) + 1),
    Array.from({ length: 34 }, (_, i) => ['working', 'blocked', 'idle', 'done'][i % 4]),
  ).people;
  const out = attentionStrip(many, null, 80, 1, CAPS);
  assert.ok(out, 'thirty-four desks still fit on an eighty-column row');
  const tick = Number(out.signature.match(/@(\d+)x/)[1]);
  assert.ok(tick >= 1);
});

test('a raised hand is drawn taller, not only brighter', () => {
  // Height is what makes the strip legible at the distance a wall display is
  // actually looked at. Colour alone on a one-cell row is not.
  const calm = officeRoster().people.map((p) => ({ ...p, status: 'working' }));
  const stuck = calm.map((p, i) => (i === 2 ? { ...p, status: 'blocked' } : p));
  const flat = skyline(attentionStrip(calm, null, 80, 1, CAPS).canvas);
  const spiked = skyline(attentionStrip(stuck, null, 80, 1, CAPS).canvas);
  assert.ok(spiked < flat, `a raised hand should reach higher: ${spiked} vs ${flat}`);
});

test('the signature tracks status, selection and room breaks', () => {
  const people = officeRoster().people;
  const base = attentionStrip(people, null, 80, 1, CAPS).signature;
  const moved = attentionStrip(people, people[1].id, 80, 1, CAPS).signature;
  assert.notEqual(base, moved, 'walking to another desk moves the marker');
  // Index 1 is the working desk in the fixture; index 0 already has its hand up.
  const stuck = people.map((p, i) => (i === 1 ? { ...p, status: 'blocked' } : p));
  assert.notEqual(base, attentionStrip(stuck, null, 80, 1, CAPS).signature, 'a hand going up is news');
});

test('the signature holds still while nothing on the floor changes', () => {
  // A desk's command, bubble and elapsed time all change constantly and none of them
  // are in this picture, so none of them may reach the wire through it.
  const people = officeRoster().people;
  const base = attentionStrip(people, people[0].id, 80, 1, CAPS).signature;
  const churned = people.map((p) => ({ ...p, command: 'npm test', ask: 'apply?', lastSeen: Date.now() }));
  assert.equal(attentionStrip(churned, people[0].id, 80, 1, CAPS).signature, base);
});

test('a desk moving to another room changes the strip', () => {
  // Rooms are the gaps in the row, so regrouping is a different picture even with
  // every status unchanged.
  const people = roomyRoster([1, 1, 1, 2, 2, 3, 3]).people;
  const base = attentionStrip(people, null, 80, 1, CAPS).signature;
  const regrouped = people.map((p, i) => (i === 2 ? { ...p, workspaceId: people.at(-1).workspaceId } : p));
  assert.notEqual(attentionStrip(regrouped, null, 80, 1, CAPS).signature, base);
});

test('both charts encode to a small png', () => {
  // The number that decided the format. The same pictures as base64 raw RGBA are
  // tens of kilobytes each, redrawn on every change.
  const board = timeChart(STATS, 38, 1, CAPS).canvas.png();
  const strip = attentionStrip(officeRoster().people, null, 80, 1, CAPS).canvas.png();
  assert.ok(board.length < 4096, `whiteboard chart is ${board.length} bytes`);
  assert.ok(strip.length < 4096, `attention strip is ${strip.length} bytes`);
});
