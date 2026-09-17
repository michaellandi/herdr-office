#!/usr/bin/env node
// Answers one question the office cannot ask itself: does a pixel layer actually
// appear on the screen, and where.
//
//   node scripts/graphics-doctor.mjs            probe only, changes nothing
//   node scripts/graphics-doctor.mjs --draw     draw a test bar, wait, clear it
//   node scripts/graphics-doctor.mjs --draw --leave   draw it and leave it up
//   node scripts/graphics-doctor.mjs --clear    take down whatever --leave left
//   node scripts/graphics-doctor.mjs --draw --pane w1:pD --hold 8
//
// `--leave` is there because the useful version of this test is the one where you
// get to look at the screen in your own time. A layer is server-side state on the
// pane, so it outlives this process and `--clear` is a separate errand.
//
// Why this exists as its own script: src/graphics.mjs swallows every failure on
// purpose, because a coat of paint does not get to take the building down. That is
// right in the office and useless when you are trying to find out why nothing is
// showing up, so this does the opposite and prints everything, including the raw
// server response.
//
// The test bar is deliberately loud and deliberately in a known place: row 1 of the
// pane, the same row the attention strip claims. If it appears one row lower than
// the label says, `viewport_row` is 1-indexed and src/graphics.mjs needs to subtract
// one. If it does not appear at all, the transport is the problem, not the charts.
import { ApiClient } from '../src/socket.mjs';
import { Canvas } from '../src/canvas.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const DRAW = argv.includes('--draw');
const LEAVE = argv.includes('--leave');
const CLEAR = argv.includes('--clear');
const PANE = arg('--pane', process.env.HERDR_PANE_ID || '');
const HOLD = Math.max(1, Number(arg('--hold', 6)) || 6);
const ROW = Number(arg('--row', 1));
const LAYER = 'office.doctor';

const say = (...a) => console.log(...a);

async function main() {
  if (!PANE) {
    say('no pane id. Run this inside a herdr pane, or pass --pane w1:pX');
    process.exit(1);
  }
  const api = await new ApiClient().open();

  if (CLEAR) {
    await api
      .request('pane.graphics.clear', { pane_id: PANE, layer_id: LAYER }, 3000)
      .then(() => say(`cleared ${LAYER} on ${PANE}`))
      .catch((e) => say(`clear failed: ${e.message}`));
    api.close();
    return;
  }

  say(`pane ${PANE}`);
  const info = await api.request('pane.graphics.info', { pane_id: PANE }, 3000).catch((e) => ({ error: e.message }));
  say(`  info: ${JSON.stringify(info)}`);
  if (info.error) {
    say('  -> this server has no graphics. The office is correctly text-only here.');
    api.close();
    return;
  }
  const cellW = Number(info.cell_width_px) || 0;
  const cellH = Number(info.cell_height_px) || 0;
  if (!(cellW > 0 && cellH > 0)) {
    say('  -> a cell with no pixels in it. The office treats this as a no.');
    api.close();
    return;
  }
  if (info.pane_visible === false) {
    say('  -> WARNING: this pane is not visible, so nothing will be drawn into it.');
    say('     Point --pane at a pane you are actually looking at.');
  }

  if (!DRAW) {
    say('');
    say('probe only. Re-run with --draw to put a test bar on the screen.');
    api.close();
    return;
  }

  // Sized to the pane's real width so the bar is unmistakable rather than a smudge
  // in a corner. 40 cells, or the pane, whichever is smaller.
  const cols = 40;
  const canvas = new Canvas(cols * cellW, cellH);
  canvas.fill('#ff00ff');
  // A white block at each end and a black one in the middle, so a bar that is
  // stretched, cropped or offset is obvious rather than merely wrong.
  canvas.rect(0, 0, cellW, cellH, '#ffffff');
  canvas.rect(canvas.w - cellW, 0, cellW, cellH, '#ffffff');
  canvas.rect(Math.floor(canvas.w / 2) - cellW, 0, cellW * 2, cellH, '#000000');
  const png = canvas.png();

  const params = {
    pane_id: PANE,
    layer_id: LAYER,
    format: 'png',
    image_width: canvas.w,
    image_height: canvas.h,
    data_base64: png.toString('base64'),
    z_index: 0,
    placement: { grid_cols: cols, grid_rows: 1, viewport_col: 0, viewport_row: ROW },
  };
  say('');
  say(`  set: ${canvas.w}x${canvas.h}px png, ${png.length} bytes, into ${cols}x1 cells at col 0 row ${ROW}`);
  try {
    const res = await api.request('pane.graphics.set', params, 5000);
    say(`  server said: ${JSON.stringify(res)}`);
  } catch (err) {
    say(`  FAILED: ${err.message}`);
    say('  -> the transport is the problem, not the charts.');
    api.close();
    return;
  }

  const drawn = await api.request('pane.graphics.info', { pane_id: PANE }, 3000).catch(() => null);
  say(`  info after: ${JSON.stringify(drawn)}`);
  say('');
  say(`A magenta bar with white ends and a black middle should now be on ROW ${ROW}`);
  say(`of pane ${PANE}, counting the top row as row 0.`);
  say('');
  say(`  on row ${ROW}          -> placement is 0-indexed, which is what the office assumes`);
  say(`  on row ${ROW + 1}          -> 1-indexed, subtract one in src/graphics.mjs`);
  say('  nowhere at all      -> the server accepted it but the terminal did not draw it');
  say('');
  if (LEAVE) {
    say('leaving it up. Take it down with:');
    say(`  node scripts/graphics-doctor.mjs --clear --pane ${PANE}`);
    api.close();
    return;
  }
  say(`clearing in ${HOLD}s...`);
  await new Promise((r) => setTimeout(r, HOLD * 1000));
  await api
    .request('pane.graphics.clear', { pane_id: PANE, layer_id: LAYER }, 3000)
    .then(() => say('cleared.'))
    .catch((e) => say(`clear failed: ${e.message} (layer ${LAYER} may still be up)`));
  api.close();
}

main().catch((err) => {
  console.error(`doctor: ${err.message}`);
  process.exit(1);
});
