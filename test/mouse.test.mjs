// Mouse decoding, and the one decision in it that matters: whether a press that
// moved was a drag or a shaky click. Getting that wrong either makes desks
// impossible to pick up or makes every click open a desk and then swap it with
// its neighbour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMouse, hitTest, deskAt, isDrag, nextDrag, DRAG_SLOP } from '../src/mouse.mjs';

const press = (b, x, y) => `\x1b[<${b};${x};${y}M`;
const release = (b, x, y) => `\x1b[<${b};${x};${y}m`;

test('a press, a motion and a release are told apart', () => {
  assert.deepEqual(parseMouse(press(0, 10, 5)), [{ kind: 'press', button: 0, x: 9, y: 4 }]);
  // 32 is the motion bit, set on top of the held button.
  assert.deepEqual(parseMouse(press(32, 10, 5)), [{ kind: 'drag', button: 0, x: 9, y: 4 }]);
  assert.deepEqual(parseMouse(release(0, 10, 5)), [{ kind: 'release', button: 0, x: 9, y: 4 }]);
});

test('coordinates come back zero-based', () => {
  // Terminals count columns and rows from 1; every hitbox in the office is
  // zero-based, so an off-by-one here misses the top row of the floor entirely.
  const [ev] = parseMouse(press(0, 1, 1));
  assert.equal(ev.x, 0);
  assert.equal(ev.y, 0);
});

test('the wheel is not a click', () => {
  // 64 and 65 are wheel up and down. Treating either as a press would open a
  // desk every time somebody scrolled.
  assert.equal(parseMouse(press(64, 4, 4))[0].kind, 'wheel');
  assert.equal(parseMouse(press(65, 4, 4))[0].kind, 'wheel');
});

test('the right button keeps its identity', () => {
  assert.equal(parseMouse(press(2, 4, 4))[0].button, 2);
  assert.equal(parseMouse(press(34, 4, 4))[0].kind, 'drag');
  assert.equal(parseMouse(press(34, 4, 4))[0].button, 2);
});

test('every report in one chunk is returned, in order', () => {
  // The reason this is not `exec` returning the first match: a chunk arriving
  // mid-drag routinely carries a run of motion reports, and dropping all but the
  // first would leave the drop target lagging behind the pointer.
  const chunk = press(0, 1, 1) + press(32, 3, 1) + press(32, 6, 2) + release(0, 6, 2);
  assert.deepEqual(
    parseMouse(chunk).map((e) => [e.kind, e.x, e.y]),
    [
      ['press', 0, 0],
      ['drag', 2, 0],
      ['drag', 5, 1],
      ['release', 5, 1],
    ],
  );
});

test('keystrokes in the same chunk are ignored, not parsed as mouse', () => {
  assert.deepEqual(parseMouse('q'), []);
  assert.deepEqual(parseMouse('\x1b[A'), []);
  assert.deepEqual(parseMouse(''), []);
});

test('the parser is not left holding state between chunks', () => {
  // The regex is module-level and global, so a stale lastIndex would silently
  // skip the first report of the next chunk.
  parseMouse(press(0, 20, 20));
  assert.deepEqual(parseMouse(press(0, 1, 1)), [{ kind: 'press', button: 0, x: 0, y: 0 }]);
});

const BOXES = [
  { id: 'w1:p1', x: 0, y: 0, w: 33, h: 16 },
  { id: 'w1:p1', action: 'approve', x: 10, y: 8, w: 3, h: 1 },
  { id: 'w1:p1', action: 'deny', x: 14, y: 8, w: 3, h: 1 },
  { id: 'w1:p2', x: 34, y: 0, w: 33, h: 16 },
];

test('a button beats the desk it is drawn on', () => {
  assert.equal(hitTest(BOXES, 11, 8).action, 'approve');
  assert.equal(hitTest(BOXES, 15, 8).action, 'deny');
  assert.equal(hitTest(BOXES, 2, 2).action, undefined);
  assert.equal(hitTest(BOXES, 2, 2).id, 'w1:p1');
});

test('nothing under the pointer is nothing, not the first box', () => {
  assert.equal(hitTest(BOXES, 200, 200), null);
  assert.equal(hitTest(BOXES, 33, 0), null); // the gap between two desks
});

test('a drop lands on the desk, even over its buttons', () => {
  // Dropping somebody onto a stuck colleague's [y] must swap the two desks, not
  // answer the prompt: that is the whole select-versus-act separation.
  assert.equal(deskAt(BOXES, 11, 8).id, 'w1:p1');
  assert.equal(deskAt(BOXES, 11, 8).action, undefined);
  assert.equal(deskAt(BOXES, 40, 3).id, 'w1:p2');
  assert.equal(deskAt(BOXES, 200, 200), null);
});

test('a sloppy click is still a click', () => {
  const start = { x: 10, y: 10 };
  assert.equal(isDrag(start, 10, 10), false);
  assert.equal(isDrag(start, 11, 10), false); // one cell of wobble
  assert.equal(isDrag(start, 10, 11), false);
  assert.equal(isDrag(start, 12, 10), true);
  assert.equal(isDrag(start, 11, 11), true); // diagonal, Manhattan distance 2
  assert.equal(isDrag(start, 4, 2), true);
  assert.equal(DRAG_SLOP, 2);
});

/* ------------------------------------------------------- the drag state machine */

// The reports above are written in terminal coordinates, because checking that
// they get decremented is the point of those tests. Down here the interesting
// numbers are hitbox cells, so these take a cell and do the conversion.
const down = (x, y, b = 0) => press(b, x + 1, y + 1);
const moveTo = (x, y, b = 0) => press(b | 32, x + 1, y + 1);
const up = (x, y, b = 0) => release(b, x + 1, y + 1);

// Replays a run of reports through the reducer and returns every action it asked
// for, which is the only thing office.mjs ever acts on.
function replay(chunks, boxes = BOXES) {
  let drag = null;
  const acts = [];
  for (const chunk of chunks) {
    for (const ev of parseMouse(chunk)) {
      const out = nextDrag(drag, ev, boxes);
      drag = out.drag;
      if (out.act) acts.push(out.act);
    }
  }
  return { drag, acts };
}

test('press and release without moving opens the desk', () => {
  const { drag, acts } = replay([down(3, 3), up(3, 3)]);
  assert.equal(drag, null);
  assert.deepEqual(acts, [
    { type: 'select', id: 'w1:p1' },
    { type: 'open', id: 'w1:p1' },
  ]);
});

test('a press that wobbles one cell is still an open, not a swap', () => {
  // The case that would otherwise make the office unusable on a trackpad: every
  // click landing as a pane swap.
  const { acts } = replay([down(3, 3), moveTo(4, 3), up(4, 3)]);
  assert.deepEqual(acts.at(-1), { type: 'open', id: 'w1:p1' });
});

test('dragging onto another desk swaps the two panes', () => {
  const { drag, acts } = replay([down(3, 3), moveTo(20, 3), moveTo(40, 4), up(40, 4)]);
  assert.equal(drag, null);
  assert.deepEqual(acts.at(-1), { type: 'swap', from: 'w1:p1', to: 'w1:p2' });
  // And exactly one swap: a run of motion reports must not fire one per report.
  assert.equal(acts.filter((a) => a.type === 'swap').length, 1);
});

test('dropping on carpet changes nothing', () => {
  const { acts } = replay([down(3, 3), moveTo(30, 3), up(200, 200)]);
  assert.deepEqual(acts.at(-1), { type: 'cancel' });
});

test('dropping a desk back on itself changes nothing', () => {
  // Picked up, wandered, came home. Swapping a pane with itself is a pointless
  // request to make of the server.
  const { acts } = replay([down(3, 3), moveTo(20, 3), moveTo(3, 3), up(3, 3)]);
  assert.deepEqual(acts.at(-1), { type: 'cancel' });
});

test('a drop on somebody else s [y] swaps desks, it does not answer for them', () => {
  // The dangerous one. The buttons live inside p1's tile, so a drag that ends
  // over one must be read as a drop, or dragging near a stuck colleague would
  // approve whatever they were waiting on.
  const boxes = [
    { id: 'w1:p2', x: 34, y: 0, w: 33, h: 16 },
    { id: 'w1:p1', x: 0, y: 0, w: 33, h: 16 },
    { id: 'w1:p1', action: 'approve', x: 10, y: 8, w: 3, h: 1 },
  ];
  const { acts } = replay([down(40, 3), moveTo(20, 6), moveTo(11, 8), up(11, 8)], boxes);
  assert.deepEqual(acts.at(-1), { type: 'swap', from: 'w1:p2', to: 'w1:p1' });
  assert.equal(acts.some((a) => a.type === 'answer'), false);
});

test('a click on [y] answers, and never picks the desk up', () => {
  const { drag, acts } = replay([down(11, 8), up(11, 8)]);
  assert.equal(drag, null, 'a button press must not leave a desk in the air');
  assert.deepEqual(acts, [{ type: 'answer', id: 'w1:p1', action: 'approve' }]);
});

test('motion with no button down does nothing', () => {
  // Under mode 1002 a stray report can arrive with nothing held. It must not
  // start a drag out of thin air.
  const { drag, acts } = replay([moveTo(3, 3, 3), moveTo(40, 3), up(40, 3)]);
  assert.equal(drag, null);
  assert.deepEqual(acts, []);
});

test('the right button neither selects nor swaps', () => {
  const { drag, acts } = replay([down(3, 3, 2), moveTo(40, 3, 2), up(40, 3, 2)]);
  assert.equal(drag, null);
  assert.deepEqual(acts, []);
});

test('the wheel over a desk does not open it', () => {
  const { acts } = replay([down(3, 3, 64), down(3, 3, 65)]);
  assert.deepEqual(acts, []);
});

test('a press on carpet clears anything being carried', () => {
  const { drag } = replay([down(3, 3), down(200, 200)]);
  assert.equal(drag, null);
});

test('the drop target follows the pointer while it moves', () => {
  let drag = null;
  const at = (x, y) => {
    const out = nextDrag(drag, parseMouse(moveTo(x, y))[0], BOXES);
    drag = out.drag;
    return drag;
  };
  drag = nextDrag(null, parseMouse(down(3, 3))[0], BOXES).drag;
  assert.equal(drag.active, false);
  assert.equal(at(20, 3).overId, 'w1:p1'); // still over itself, now airborne
  assert.equal(at(20, 3).active, true);
  assert.equal(at(40, 3).overId, 'w1:p2');
  assert.equal(at(200, 200).overId, null); // out over the carpet
  assert.equal(at(40, 3).overId, 'w1:p2'); // and back
});
