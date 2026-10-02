// The pixel plumbing. Nothing here draws anything: these are the promises
// src/graphics.mjs makes to the rest of the office, and most of them are about what
// does NOT happen.
//
//   1. A herdr that cannot render app graphics is never written an image byte.
//   2. A picture that would look identical never reaches the terminal.
//   3. A failing graphics layer turns itself off instead of taking the office down.
//
// Rule 1 is the one that changed shape, and it is now the most important thing in this
// file. The office used to ask herdr to place images over the socket; herdr 0.9.2
// removed those methods, and the office writes Kitty graphics to its own stdout
// instead. But stdout is also the floor. An older herdr has no renderer for an APC
// image sequence, so bytes meant as a picture arrive as several kilobytes of base64
// printed across somebody's desks. That is strictly worse than no pictures, which is
// why the version gate below is tested harder than the drawing is.
//
// So these assert against a fake stdout rather than a fake socket, and they read the
// actual escape sequences. Reading bytes in a test is usually a smell; here the bytes
// are the entire interface, and a test that mocked a layer above them would pass while
// the office wrote nonsense to a real terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graphics, atLeast } from '../src/graphics.mjs';
import { Canvas } from '../src/canvas.mjs';

// The version the gate wants, and one below it. Named rather than inline so the two
// sides of every gate test cannot drift apart.
const NEW = '0.9.3';
const OLD = '0.9.0';

// A socket that answers `session.snapshot` and nothing else, because that is now the
// only thing this file asks for. `version` of null is a server that answers without
// saying, and a function throws.
function fakeApi(version = NEW) {
  const calls = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      if (typeof version === 'function') return Promise.resolve().then(version);
      return Promise.resolve({ snapshot: version === null ? {} : { version, protocol: 22 } });
    },
  };
}

// The floor, as a string. `fail` makes the next write throw, which is how a terminal
// that has gone away behaves.
function fakeOut() {
  let fail = 0;
  const out = {
    text: '',
    writes: 0,
    breakNext(n = 1) {
      fail = n;
    },
    write(s) {
      if (fail > 0) {
        fail -= 1;
        throw new Error('EPIPE');
      }
      out.writes += 1;
      out.text += s;
      return true;
    },
  };
  return out;
}

const frame = (id, signature, region = { x: 0, y: 1, w: 8, h: 1 }) => ({
  id,
  signature,
  region,
  canvas: new Canvas(80, 22).fill('#101418'),
});

// Every APC graphics sequence on the floor, as `{ keys, payload }` with the keys
// parsed out. The office writes cursor moves between them, which this ignores: those
// are checked by name in their own test rather than smeared across every other one.
function apcs(text) {
  const found = [];
  const re = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const keys = {};
    for (const pair of m[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k) keys[k] = v;
    }
    found.push({ keys, payload: m[2] ?? '' });
  }
  return found;
}

const sets = (out) => apcs(out.text).filter((a) => a.keys.a === 'T');
const dels = (out) => apcs(out.text).filter((a) => a.keys.a === 'd');

// A graphics object already past the gate, which is the starting point for every test
// that is about drawing rather than about probing.
async function ready(version = NEW) {
  const api = fakeApi(version);
  const out = fakeOut();
  const g = new Graphics(api, 'w1:p1', out);
  await g.probe();
  return { g, out, api };
}

/* -------------------------------------------------------------------- probing */

test('no api or no pane id means graphics are off before anything is asked', () => {
  // --demo has no socket, and an office run by hand outside herdr has no pane id.
  // Both are text-only, and neither is an error.
  assert.equal(new Graphics(null, 'w1:p1').off, true);
  assert.equal(new Graphics(fakeApi(), '').off, true);
});

test('a herdr new enough to render app graphics reports a cell size', async () => {
  const { g } = await ready();
  assert.equal(g.off, false);
  assert.equal(g.caps.visible, true);
  assert.ok(g.caps.cellW > 0 && g.caps.cellH > 0, 'a cell has to have pixels in it');
  assert.equal(g.caps.version, NEW);
});

test('the version is read off a method the office already calls', async () => {
  // Not because one request is expensive, but because every method named in this
  // repository is checked against herdr's schema, and a new one is a new way to be
  // wrong on the wire.
  const { api } = await ready();
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['session.snapshot'],
  );
});

test('a herdr too old to render app graphics is written nothing at all', async () => {
  // The whole reason probe() still exists. An older herdr prints an image sequence
  // as text, so the bar is not "no picture" but "not one byte".
  const { g, out } = await ready(OLD);
  assert.equal(g.off, true);
  assert.equal(g.caps, null);
  g.sync([frame('office.board', 't:1')]);
  await g.clear();
  assert.equal(out.text, '', 'an old herdr would have printed every one of these bytes');
  assert.equal(out.writes, 0);
});

test('a version nobody can read is a no, not an optimistic yes', async () => {
  // A server that answers without saying which version it is, and a server that does
  // not answer at all. The cost of a wrong yes is base64 across somebody's screen;
  // the cost of a wrong no is a plain floor. So both are no.
  for (const version of [null, '', 'herdr-dev', () => Promise.reject(new Error('nope'))]) {
    const out = fakeOut();
    const g = new Graphics(fakeApi(version), 'w1:p1', out);
    assert.equal(await g.probe(), null, `${String(version)} should not open the gate`);
    assert.equal(g.off, true);
    g.sync([frame('office.board', 't:1')]);
    assert.equal(out.text, '');
  }
});

test('the gate compares versions as numbers, not as strings', () => {
  // '0.10.0' > '0.9.2' is false as a string compare and true as a version, and herdr
  // is one minor release away from that mattering.
  assert.equal(atLeast('0.9.2', '0.9.2'), true);
  assert.equal(atLeast('0.9.3', '0.9.2'), true);
  assert.equal(atLeast('0.10.0', '0.9.2'), true);
  assert.equal(atLeast('1.0.0', '0.9.2'), true);
  assert.equal(atLeast('0.9.1', '0.9.2'), false);
  assert.equal(atLeast('0.9.0', '0.9.2'), false);
  assert.equal(atLeast('0.9.2-rc1', '0.9.2'), true);
  assert.equal(atLeast('', '0.9.2'), false);
  assert.equal(atLeast(undefined, '0.9.2'), false);
});

test('the assumed cell size can be corrected by somebody who knows theirs', async () => {
  // Nothing in herdr's schema reports pixel metrics any more, so the office assumes.
  // Assuming is survivable because placement is in cells, but the assumption decides
  // how sharp a chart is, and this is the way out for anybody who cares.
  const before = process.env.HERDR_OFFICE_CELL;
  try {
    process.env.HERDR_OFFICE_CELL = '13x31';
    const { g } = await ready();
    assert.equal(g.caps.cellW, 13);
    assert.equal(g.caps.cellH, 31);
    // Garbage falls back to the default rather than to zero, which charts divide by.
    process.env.HERDR_OFFICE_CELL = 'wide';
    const bad = await ready();
    assert.ok(bad.g.caps.cellW > 0 && bad.g.caps.cellH > 0);
  } finally {
    if (before === undefined) delete process.env.HERDR_OFFICE_CELL;
    else process.env.HERDR_OFFICE_CELL = before;
  }
});

/* -------------------------------------------------------------- what gets sent */

test('what goes on the screen is a png placed in cells', async () => {
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1', { x: 4, y: 10, w: 38, h: 2 })]);
  const [set] = sets(out);
  assert.ok(set, 'something was drawn');
  assert.equal(set.keys.f, '100', 'f=100 is png');
  // The placement is in terminal cells, which is what registers a pixel chart onto
  // the rectangle the text renderer set aside for it, whatever a cell turns out to
  // measure in pixels.
  assert.equal(set.keys.c, '38');
  assert.equal(set.keys.r, '2');
  assert.ok(Number(set.keys.i) > 0, 'and carries an image id a later delete can name');
});

test('a layer is written once and then left alone', async () => {
  // The office repaints every 320ms and the numbers behind a chart move every few
  // seconds. Without this the feature is a steady stream of identical PNGs down the
  // same pipe as the text.
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1')]);
  const first = out.text.length;
  assert.equal(sets(out).length, 1);
  for (let i = 0; i < 5; i += 1) g.sync([frame('office.board', 't:1')]);
  assert.equal(sets(out).length, 1);
  assert.equal(out.text.length, first, 'not one further byte');
});

test('a changed signature is redrawn', async () => {
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1')]);
  g.sync([frame('office.board', 't:2')]);
  assert.equal(sets(out).length, 2);
});

test('the same picture in a different place is redrawn', async () => {
  // The signature covers the picture; the key covers where it went. A chart that
  // moved one row down is new work even though it looks the same.
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1', { x: 0, y: 4, w: 8, h: 1 })]);
  g.sync([frame('office.board', 't:1', { x: 0, y: 5, w: 8, h: 1 })]);
  assert.equal(sets(out).length, 2);
});

test('a moved layer deletes its old placement before making a new one', async () => {
  // `a=T` creates a placement wherever the cursor is, so re-sending a chart that has
  // moved would leave the old one behind and stack a second on top: the floating
  // duplicate, again, by a different route. An id has at most one placement.
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1', { x: 0, y: 4, w: 8, h: 1 })]);
  out.text = '';
  g.sync([frame('office.board', 't:1', { x: 0, y: 9, w: 8, h: 1 })]);
  const order = apcs(out.text).map((a) => a.keys.a);
  assert.equal(order[0], 'd', 'the delete has to come first');
  assert.ok(order.includes('T'));
  assert.equal(dels(out)[0].keys.i, sets(out)[0].keys.i, 'and name the same image');
});

test('the terminal is told never to answer', async () => {
  // A reply would arrive on stdin, where the only reader is the key handler, so a
  // terminal confirming a picture would be read as somebody typing.
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1')]);
  g.sync([]);
  const all = apcs(out.text);
  assert.ok(all.length >= 2);
  for (const a of all) {
    // Continuation chunks carry only `m`, and a chunk is not a question.
    if (!a.keys.a) continue;
    assert.equal(a.keys.q, '2', `every request must be quiet: ${JSON.stringify(a.keys)}`);
  }
});

test('the cursor is put back where it was found', async () => {
  // The office positions every line absolutely, so a cursor left in the wrong place
  // is a whole frame drawn in the wrong place.
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1', { x: 4, y: 10, w: 38, h: 2 })]);
  const saved = out.text.indexOf('\x1b7');
  const moved = out.text.indexOf('\x1b[11;5H');
  const restored = out.text.lastIndexOf('\x1b8');
  assert.ok(saved >= 0, 'the cursor is saved');
  assert.ok(moved > saved, 'then moved to the top-left cell of the rectangle, 1-indexed');
  assert.ok(restored > moved, 'and put back afterwards');
  assert.ok(out.text.endsWith('\x1b8'), 'the restore is the last thing written');
  // Belt and braces: C=1 asks the terminal not to move it in the first place.
  assert.equal(sets(out)[0].keys.C, '1');
});

test('a picture too big for one sequence is split, and only the last chunk says so', async () => {
  // Kitty wants the payload in chunks, and `m=1` means "more coming". Getting the
  // last one wrong leaves the terminal waiting for a chunk that never arrives, which
  // looks exactly like no picture at all.
  const { g, out } = await ready();
  // Deliberately incompressible. A png of a flat fill, or of a chart, is a couple of
  // kilobytes however large the canvas, and would fit in one chunk and prove nothing.
  // A fixed seed so the size is the same on every machine and every run.
  let seed = 1;
  const noise = () => (((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xffffff).toString(16).padStart(6, '0');
  const busy = new Canvas(160, 160);
  for (let y = 0; y < 160; y += 1) for (let x = 0; x < 160; x += 1) busy.px(x, y, `#${noise()}`);
  g.sync([{ id: 'office.board', signature: 't:1', region: { x: 0, y: 0, w: 40, h: 10 }, canvas: busy }]);
  const chunks = apcs(out.text).filter((a) => a.keys.m !== undefined);
  assert.ok(chunks.length > 1, `a 400x220 png should not fit in one 4096-byte chunk, got ${chunks.length}`);
  for (const c of chunks.slice(0, -1)) assert.equal(c.keys.m, '1');
  assert.equal(chunks.at(-1).keys.m, '0');
  // Only the first chunk carries the control keys; the rest carry the continuation.
  assert.equal(chunks[0].keys.a, 'T');
  for (const c of chunks.slice(1)) assert.equal(c.keys.a, undefined);
  const png = Buffer.from(chunks.map((c) => c.payload).join(''), 'base64');
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'and reassemble into a png');
});

test('a layer that stops being wanted is cleared', async () => {
  // A whiteboard that scrolled off a short pane takes its pixels with it, instead of
  // leaving a chart sitting on the carpet.
  const { g, out } = await ready();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  const boardId = sets(out)[1].keys.i;
  out.text = '';
  g.sync([frame('office.strip', 's:a')]);
  const gone = dels(out);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].keys.i, boardId);
});

test('no frames at all clears everything', async () => {
  const { g, out } = await ready();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  out.text = '';
  g.sync([]);
  assert.equal(dels(out).length, 2);
  assert.equal(sets(out).length, 0);
});

test('a frame with nothing drawn in it is skipped, not sent empty', async () => {
  // A chart that decided its rectangle was too small to say anything returns null,
  // and then the text it would have replaced simply stays.
  const { g, out } = await ready();
  g.sync([{ id: 'office.board', signature: 't:1', region: { x: 0, y: 1, w: 8, h: 1 }, canvas: null }]);
  assert.equal(out.text, '');
});

test('more layers than the pane allows are dropped, not stacked up', async () => {
  const { g, out } = await ready();
  g.sync(Array.from({ length: 9 }, (_, i) => frame(`office.l${i}`, `s:${i}`)));
  assert.equal(sets(out).length, g.caps.maxLayers);
});

/* ------------------------------------------------------- failing without fuss */

// The bug these exist for, as it was reported: "sometimes the progress bar appears to
// float after resize, and shows up twice."
//
// A layer the office stopped being sure about used to be deleted from its records, and
// only ids it still has a record of are ever cleared, so the pixels stayed up with
// nothing left that could take them down. Resizing smaller is what makes that visible:
// the chart declines a rectangle it cannot say anything in, the text version of the
// same bar draws in its place, and the orphaned image is still sitting at the
// coordinates the old layout gave it. Twice, and one of them in the wrong place.
//
// So the promise is about a *clear* arriving, not about a redraw. A test that only
// checks the redraw passes against the bug.

test('a layer whose drawing failed can still be taken down', async () => {
  const { g, out } = await ready();
  out.breakNext();
  g.sync([frame('office.board', 't:1')]);
  assert.equal(sets(out).length, 0, 'the write failed, so nothing landed');
  // A failed write is a question with no answer: part of a picture may be on screen
  // and this object cannot know how much. So the layer stays on the books.
  g.sync([]);
  assert.equal(dels(out).length, 1, 'and is still clearable afterwards');
});

test('a clear that failed is tried again rather than forgotten', async () => {
  const { g, out } = await ready();
  g.sync([frame('office.board', 't:1')]);
  out.text = '';
  out.breakNext();
  g.sync([]);
  assert.equal(dels(out).length, 0, 'the clear did not get out');
  g.sync([]);
  assert.equal(dels(out).length, 1, 'so it goes again on the next frame');
});

test('a run of failures turns graphics off for the rest of the session', async () => {
  // A terminal that takes bytes and then fails is worse than one that takes none,
  // because the failures arrive one a frame.
  const { g, out } = await ready();
  out.breakNext(3);
  for (let i = 0; i < 3; i += 1) g.sync([frame('office.board', `t:${i}`)]);
  assert.equal(g.off, true);
  assert.equal(g.caps, null);
  out.text = '';
  g.sync([frame('office.board', 't:9')]);
  assert.equal(out.text, '', 'and stays off');
});

test('a single failure is retried rather than latched', async () => {
  const { g, out } = await ready();
  out.breakNext();
  g.sync([frame('office.board', 't:1')]);
  g.sync([frame('office.board', 't:1')]);
  assert.equal(g.off, false);
  assert.equal(sets(out).length, 1, 'the same frame is sent again because UNSURE matches nothing');
});

test('quitting takes the office pixels down with it', async () => {
  const { g, out } = await ready();
  g.sync([frame('office.strip', 's:a'), frame('office.board', 't:1')]);
  out.text = '';
  await g.clear();
  assert.equal(dels(out).length, 2);
});

test('clearing nothing costs nothing, and a broken terminal does not block the exit', async () => {
  // A hung or vanished stdout must never be the reason ctrl-c did not work.
  const { g, out } = await ready();
  await g.clear();
  assert.equal(out.writes, 0);
  g.sync([frame('office.board', 't:1')]);
  out.breakNext();
  await g.clear();
});
