// The PNG encoder. Not a picture test: the pictures are checked by looking at them.
// This checks the bytes are a PNG, because the office writes them straight into a
// socket and a malformed one is a chart that silently never appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePNG } from '../src/png.mjs';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Walks the chunk list the way a decoder does, so a wrong length or a wrong CRC
// shows up here rather than as a terminal quietly declining to draw.
function chunks(png) {
  const out = [];
  let at = 8;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    const crc = png.readUInt32BE(at + 8 + len);
    out.push({ type, data, crc, body: png.subarray(at + 4, at + 8 + len) });
    at += 12 + len;
  }
  assert.equal(at, png.length, 'chunk lengths must account for every byte in the file');
  return out;
}

const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const solid = (w, h, [r, g, b, a]) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return px;
};

test('a png starts with the signature and ends with IEND', () => {
  const png = encodePNG(4, 3, solid(4, 3, [10, 20, 30, 255]));
  assert.deepEqual(png.subarray(0, 8), SIG);
  const list = chunks(png);
  assert.deepEqual(
    list.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  assert.equal(list.at(-1).data.length, 0);
});

test('every chunk carries a correct CRC', () => {
  // The one part of the format a decoder is entitled to reject the whole file
  // over, and the one part that is pure arithmetic with nothing to look at.
  for (const c of chunks(encodePNG(7, 5, solid(7, 5, [1, 2, 3, 200])))) {
    assert.equal(c.crc, crc32(c.body), `${c.type} crc`);
  }
});

test('the header says what was asked for: 8-bit RGBA, no interlace', () => {
  const [ihdr] = chunks(encodePNG(400, 44, solid(400, 44, [0, 0, 0, 0])));
  assert.equal(ihdr.data.readUInt32BE(0), 400);
  assert.equal(ihdr.data.readUInt32BE(4), 44);
  assert.equal(ihdr.data[8], 8, 'bit depth');
  assert.equal(ihdr.data[9], 6, 'colour type: truecolour with alpha');
  assert.equal(ihdr.data[10], 0, 'deflate');
  assert.equal(ihdr.data[11], 0, 'adaptive filtering');
  assert.equal(ihdr.data[12], 0, 'no interlace: the office draws once, not progressively');
});

test('the pixels survive the round trip, row filters and all', () => {
  // Every scanline is prefixed with a filter byte of 0, so inflating gives back the
  // original rows with one extra byte each. If that offset is ever off by one the
  // whole image shears diagonally, which is exactly the kind of bug that looks like
  // a chart bug.
  const w = 5;
  const h = 4;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 7) % 251;
  const [, idat] = chunks(encodePNG(w, h, px));
  const raw = inflateSync(idat.data);
  assert.equal(raw.length, h * (w * 4 + 1));
  for (let y = 0; y < h; y += 1) {
    const at = y * (w * 4 + 1);
    assert.equal(raw[at], 0, `row ${y} filter byte`);
    assert.deepEqual(
      Buffer.from(raw.subarray(at + 1, at + 1 + w * 4)),
      Buffer.from(px.subarray(y * w * 4, y * w * 4 + w * 4)),
      `row ${y} pixels`,
    );
  }
});

test('flat colour compresses to nothing, which is the whole reason for PNG here', () => {
  // The size argument this file exists to hold up. A whiteboard chart as raw RGBA
  // is ~35KB before base64 inflates it by a third; the office redraws that on every
  // change and the socket carries it. Flat rectangles are what these charts are made
  // of, and deflate is extremely good at flat rectangles.
  const w = 400;
  const h = 44;
  const png = encodePNG(w, h, solid(w, h, [30, 40, 50, 255]));
  assert.ok(png.length < 1024, `expected under a kilobyte, got ${png.length}`);
  assert.ok(png.length * 40 < w * h * 4, 'expected better than 40x against raw');
});

test('a size that does not match its pixels is refused, not truncated', () => {
  // A chart that computed its own canvas wrong should fail loudly in a test run,
  // not send a subtly sheared image to a terminal that will draw it anyway.
  assert.throws(() => encodePNG(4, 4, new Uint8Array(10)), /wants 64 bytes/);
  assert.throws(() => encodePNG(0, 4, new Uint8Array(0)), /0x4/);
  assert.throws(() => encodePNG(4, 0, new Uint8Array(0)), /4x0/);
});
