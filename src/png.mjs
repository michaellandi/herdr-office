// A PNG encoder, in about sixty lines.
//
// `pane.graphics.set` will take raw `rgba` bytes, which needs no encoder at all,
// and that is the tempting way to do this. It is also the way that does not work:
// the whiteboard's chart is 400x44 cells of pixels, which is 70KB raw and 94KB
// once it is base64'd onto a socket that carries one JSON object per line. At the
// office's animation rate that is 300KB a second to draw two bars.
//
// The same picture is flat rectangles of solid colour, which is the case deflate
// was made for: it comes out under a kilobyte. So the frames go out as PNG, and
// the encoder is here rather than in a dependency because `node:zlib` is a
// built-in and the rest of the format is a signature, three chunks and a CRC.
import { deflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// length, type, data, CRC. The CRC covers the type and the data but not the
// length, which is the one part of this format that is easy to get wrong.
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// 8 bits a channel, truecolour with alpha, no interlacing, and filter 0 on every
// scanline. The per-scanline filters exist to help the compressor find gradients
// in photographs; nothing in this office is a photograph, so declaring "none"
// costs a byte a row and saves doing the arithmetic.
export function encodePNG(width, height, rgba) {
  if (!(width > 0 && height > 0)) throw new Error(`cannot encode a ${width}x${height} png`);
  const want = width * height * 4;
  if (rgba.length !== want) throw new Error(`png wants ${want} bytes for ${width}x${height}, got ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    src.copy(raw, at + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
