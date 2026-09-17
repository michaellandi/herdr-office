// The pixel plumbing. Nothing here draws anything: these are the three promises
// src/graphics.mjs makes to the rest of the office, and all three are about what
// does NOT happen.
//
//   1. A terminal that cannot draw is asked once and then left alone.
//   2. A picture that would look identical never reaches the socket.
//   3. A failing graphics layer turns itself off instead of taking the office down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graphics } from '../src/graphics.mjs';
import { Canvas } from '../src/canvas.mjs';

const INFO = {
  cell_width_px: 10,
  cell_height_px: 22,
  pane_visible: true,
  max_layers_per_pane: 16,
  pixel_mouse: true,
};

// A socket that records instead of sending. `answers` maps a method to a value or a
// thrower, so a test can make exactly one call fail.
function fakeApi(answers = {}) {
  const calls = [];
  return {
    calls,
    sent: (method) => calls.filter((c) => c.method === method),
    request(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (typeof answer === 'function') return Promise.resolve().then(() => answer(params));
      return Promise.resolve(answer ?? {});
    },
  };
}

const frame = (id, signature, region = { x: 0, y: 1, w: 8, h: 1 }) => ({
  id,
  signature,
  region,
  canvas: new Canvas(80, 22).fill('#101418'),
});

// sync() is deliberately fire-and-forget, so a test has to let the microtasks it
// queued actually run before asking what was sent.
const settle = () => new Promise((r) => setTimeout(r, 0));

/* -------------------------------------------------------------------- probing */

test('no api or no pane id means graphics are off before anything is asked', () => {
  // --demo has no socket, and an office run by hand outside herdr has no pane id.
  // Both are text-only, and neither is an error.
  assert.equal(new Graphics(null, 'w1:p1').off, true);
  assert.equal(new Graphics(fakeApi(), '').off, true);
});

test('a pane that can draw reports its cell size', async () => {
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  const caps = await g.probe();
  assert.deepEqual(caps, { cellW: 10, cellH: 22, visible: true, maxLayers: 16, pixelMouse: true });
  assert.equal(api.calls[0].params.pane_id, 'w1:p1');
});

test('a server without the method is a text terminal, and is never asked twice', async () => {
  // The commonest case in the world: an older herdr, or a terminal with no graphics
  // support at all. One question, one answer, and the office stops bothering it.
  const api = fakeApi({
    'pane.graphics.info': () => {
      throw new Error('unknown method');
    },
  });
  const g = new Graphics(api, 'w1:p1');
  assert.equal(await g.probe(), null);
  assert.equal(g.off, true);
  await g.probe();
  await g.probe();
  assert.equal(api.sent('pane.graphics.info').length, 1);
});

test('a cell with no pixels in it is treated as a no rather than divided by', async () => {
  // A response that does not make sense gets the same posture as the rest of the
  // office: assume nothing, draw the text, move on.
  for (const bad of [{}, { cell_width_px: 0, cell_height_px: 22 }, { cell_width_px: 10, cell_height_px: null }]) {
    const g = new Graphics(fakeApi({ 'pane.graphics.info': bad }), 'w1:p1');
    assert.equal(await g.probe(), null);
    assert.equal(g.off, true);
  }
});

test('a pane nobody is looking at is drawn into anyway, but nothing is sent', async () => {
  const api = fakeApi({ 'pane.graphics.info': { ...INFO, pane_visible: false } });
  const g = new Graphics(api, 'w1:p1');
  const caps = await g.probe();
  assert.equal(caps.visible, false);
  assert.equal(g.off, false, 'a hidden pane is not a broken pane');
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 0);
});

test('coming back into view is a full redraw', async () => {
  // A pane that was off screen may have had its images dropped while it was away,
  // and there is no way to find out from here. The only safe assumption is that
  // whatever the office thinks it drew is gone.
  const answers = { 'pane.graphics.info': { ...INFO } };
  const api = fakeApi(answers);
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 1);

  answers['pane.graphics.info'] = { ...INFO, pane_visible: false };
  await g.probe();
  answers['pane.graphics.info'] = { ...INFO, pane_visible: true };
  await g.probe();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 2, 'the same picture is sent again after a hide');
});

/* ------------------------------------------------------------------- polling */

test('poll asks once and then holds off, so the frame rate is not the question rate', async () => {
  // draw() runs every 320ms. Without the throttle this is three `info` calls a
  // second for an answer that changes when somebody switches tab.
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  for (let i = 0; i < 10; i += 1) {
    g.poll();
    await settle();
  }
  assert.equal(api.sent('pane.graphics.info').length, 1);
});

test('poll asks far more often while nobody is looking', async () => {
  // The asymmetry is the whole point. Visible, there is nothing to learn. Hidden,
  // the answer is the only thing the office is waiting for, and the delay before
  // pixels come back is what somebody actually sits through.
  const api = fakeApi({ 'pane.graphics.info': { ...INFO, pane_visible: false } });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  const before = api.sent('pane.graphics.info').length;
  // Longer than HIDDEN_MS, far shorter than VISIBLE_MS. A visible pane would still
  // be sitting on its first answer here.
  await new Promise((r) => setTimeout(r, 300));
  g.poll();
  await settle();
  assert.equal(api.sent('pane.graphics.info').length, before + 1);
});

test('poll does not stack up questions when the server is slow to answer', async () => {
  // A hanging `info` on a 320ms frame is how one slow call becomes a hundred.
  let release;
  const api = fakeApi({
    'pane.graphics.info': () => new Promise((r) => {
      release = () => r(INFO);
    }),
  });
  const g = new Graphics(api, 'w1:p1');
  for (let i = 0; i < 5; i += 1) {
    g.poll();
    await settle();
  }
  assert.equal(api.sent('pane.graphics.info').length, 1);
  release();
  await settle();
});

test('poll costs nothing once graphics are off', async () => {
  const api = fakeApi({});
  const g = new Graphics(api, '');
  g.poll();
  await settle();
  assert.equal(api.sent('pane.graphics.info').length, 0);
});

/* --------------------------------------------------------------------- damage */

test('a layer is sent once and then left alone', async () => {
  // The reason the whole signature mechanism exists. The office repaints every
  // 320ms; without this, that is three identical PNGs a second, forever.
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  for (let i = 0; i < 10; i += 1) {
    g.sync([frame('office.strip', 's:abc')]);
    await settle();
  }
  assert.equal(api.sent('pane.graphics.set').length, 1);
});

test('a changed signature is redrawn', async () => {
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:abc')]);
  await settle();
  g.sync([frame('office.strip', 's:abd')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 2);
});

test('the same picture in a different place is redrawn', async () => {
  // The floor plan moves the whiteboard when a page indicator appears. A key that
  // was only the signature would leave the chart one row off its own frame.
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.board', 't:1', { x: 4, y: 10, w: 38, h: 2 })]);
  await settle();
  g.sync([frame('office.board', 't:1', { x: 4, y: 11, w: 38, h: 2 })]);
  await settle();
  const sets = api.sent('pane.graphics.set');
  assert.equal(sets.length, 2);
  assert.equal(sets[1].params.placement.viewport_row, 11);
});

test('what goes on the wire is a png placed in cells', async () => {
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.board', 't:1', { x: 4, y: 10, w: 38, h: 2 })]);
  await settle();
  const { params } = api.sent('pane.graphics.set')[0];
  assert.equal(params.pane_id, 'w1:p1');
  assert.equal(params.layer_id, 'office.board');
  assert.equal(params.format, 'png');
  assert.equal(params.image_width, 80);
  assert.equal(params.image_height, 22);
  // The placement is in terminal cells, which is what registers a pixel chart onto
  // the rectangle the text renderer set aside for it.
  assert.deepEqual(params.placement, { grid_cols: 38, grid_rows: 2, viewport_col: 4, viewport_row: 10 });
  assert.ok(Buffer.from(params.data_base64, 'base64').subarray(1, 4).toString('ascii') === 'PNG');
});

test('a layer that stops being wanted is cleared', async () => {
  // A whiteboard that scrolled off a short pane takes its pixels with it, instead of
  // leaving a chart sitting on the carpet.
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  await settle();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  const cleared = api.sent('pane.graphics.clear');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].params.layer_id, 'office.board');
});

test('no frames at all clears everything', async () => {
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  await settle();
  g.sync([]);
  await settle();
  assert.equal(api.sent('pane.graphics.clear').length, 2);
});

test('a frame with nothing drawn in it is skipped, not sent empty', async () => {
  // Charts return null when their rectangle is too small to say anything, and the
  // caller may pass that straight through.
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([{ id: 'office.strip', signature: 's:a', region: { x: 0, y: 1, w: 8, h: 1 } }]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 0);
});

test('more layers than the pane allows are dropped, not stacked up', async () => {
  const api = fakeApi({ 'pane.graphics.info': { ...INFO, max_layers_per_pane: 1 } });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 1);
});

test('a slow socket is never waited on twice at once', async () => {
  // draw() is synchronous and runs on a 320ms timer. A sync that overlapped itself
  // would queue a frame per tick behind a socket that is already behind.
  let release;
  const api = fakeApi({
    'pane.graphics.info': INFO,
    'pane.graphics.set': () => new Promise((r) => (release = r)),
  });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  for (let i = 0; i < 5; i += 1) {
    g.sync([frame('office.strip', `s:${i}`)]);
    await settle();
  }
  assert.equal(api.sent('pane.graphics.set').length, 1, 'still only the one in flight');
  release({});
  await settle();
  g.sync([frame('office.strip', 's:done')]);
  await settle();
  assert.equal(api.sent('pane.graphics.set').length, 2, 'and it picks up again once free');
});

/* ------------------------------------------------------------------- giving up */

test('a run of failures turns graphics off for the rest of the session', async () => {
  // A terminal that says yes and then fails is worse than one that says no, because
  // the failures arrive one a frame. Three in a row is taken as a no.
  const api = fakeApi({
    'pane.graphics.info': INFO,
    'pane.graphics.set': () => {
      throw new Error('nope');
    },
  });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  for (let i = 0; i < 6; i += 1) {
    g.sync([frame('office.strip', `s:${i}`)]);
    await settle();
  }
  assert.equal(g.off, true);
  assert.equal(g.caps, null, 'and the caller can tell, so it stops covering rows');
  assert.equal(api.sent('pane.graphics.set').length, 3);
});

test('a single failure is retried rather than latched', async () => {
  // One dropped call on a busy socket is not a broken terminal.
  let fail = true;
  const api = fakeApi({
    'pane.graphics.info': INFO,
    'pane.graphics.set': () => {
      if (fail) {
        fail = false;
        throw new Error('once');
      }
      return {};
    },
  });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  assert.equal(g.off, false);
  assert.equal(api.sent('pane.graphics.set').length, 2, 'the same picture is sent again after a failure');
});

/* ---------------------------------------------------------------- on the way out */

test('quitting takes the office pixels down with it', async () => {
  const api = fakeApi({ 'pane.graphics.info': INFO });
  const g = new Graphics(api, 'w1:p1');
  await g.probe();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  await settle();
  await g.clear();
  assert.deepEqual(
    api.sent('pane.graphics.clear').map((c) => c.params.layer_id),
    ['office.strip', 'office.board'],
  );
});

test('clearing nothing costs nothing, and a broken socket does not block the exit', async () => {
  const api = fakeApi({
    'pane.graphics.info': INFO,
    'pane.graphics.clear': () => {
      throw new Error('socket is gone');
    },
  });
  const g = new Graphics(api, 'w1:p1');
  await g.clear();
  assert.equal(api.calls.length, 0, 'nothing drawn, nothing to clear');
  await g.probe();
  g.sync([frame('office.strip', 's:a')]);
  await settle();
  await g.clear();
  assert.equal(api.sent('pane.graphics.clear').length, 1, 'it tried, and it came back anyway');
});
