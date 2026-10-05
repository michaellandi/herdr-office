#!/usr/bin/env node
// Answers one question the office cannot ask itself: does a pixel layer actually
// appear on the screen, and where.
//
//   node scripts/graphics-doctor.mjs            probe only, changes nothing
//   node scripts/graphics-doctor.mjs --draw     draw a test bar, wait, clear it
//   node scripts/graphics-doctor.mjs --draw --leave   draw it and leave it up
//   node scripts/graphics-doctor.mjs --clear    take down whatever --leave left
//   node scripts/graphics-doctor.mjs --draw --pane w1:pD --hold 8 --row 1
//
// `--leave` is there because the useful version of this test is the one where you get
// to look at the screen in your own time. A Kitty image and its placement are state in
// the terminal, keyed by an image id, so they outlive this process and `--clear` is a
// separate errand that works from a separate run.
//
// Why this exists as its own script: src/graphics.mjs swallows every failure on
// purpose, because a coat of paint does not get to take the building down. That is
// right in the office and useless when you are trying to find out why nothing is
// showing up, so this does the opposite and prints everything.
//
// It drives the real Graphics class rather than hand-rolling the escape sequence a
// second time. That is the whole point. A doctor with its own private encoder can
// cheerfully pass while the one the office actually uses is broken, which is the only
// way for this script to be worse than nothing.
//
// The test bar is deliberately loud and deliberately in a known place. If it appears
// one row lower than the label says, the cursor arithmetic in src/graphics.mjs is off
// by one. If it does not appear at all, the transport is the problem, not the charts.
import { ApiClient } from '../src/socket.mjs';
import { Canvas } from '../src/canvas.mjs';
import { Graphics, ID_BASE, atLeast } from '../src/graphics.mjs';

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

// Everything this script says goes to stderr, because stdout is where the pixels go.
// Mixing the two would put the report inside the image payload.
const say = (...a) => console.error(...a);

// A stdout that counts what went through it and refuses to hide a failure. Graphics
// catches whatever write() throws, so this reports the error on the way past.
function loudOut() {
  const out = {
    bytes: 0,
    writes: 0,
    failures: 0,
    write(s) {
      out.writes += 1;
      out.bytes += Buffer.byteLength(s);
      try {
        return process.stdout.write(s);
      } catch (err) {
        out.failures += 1;
        say(`  WRITE FAILED after ${out.bytes} bytes: ${err.message}`);
        throw err;
      }
    },
  };
  return out;
}

// `--clear` has nothing drawn to clear, so it cannot ask Graphics for the image id of
// a layer it never sent. The first id Graphics hands out is ID_BASE, and `office.doctor`
// is the only layer this script ever draws, so its number is ID_BASE. Imported rather
// than written as 7311 so the two cannot drift apart.
const del = (n) => `\x1b_Ga=d,d=I,i=${n},q=2\x1b\\`;

async function main() {
  if (!PANE) {
    say('no pane id. Run this inside a herdr pane, or pass --pane w1:pX');
    process.exit(1);
  }

  if (CLEAR) {
    // Deliberately does not probe. If a bar is stuck on the screen you want it gone,
    // and a delete for an id that has no placement is a no-op in any terminal that
    // understands the sequence and ignored bytes in one that does not.
    process.stdout.write(del(ID_BASE));
    say(`sent a delete for image ${ID_BASE} (layer ${LAYER})`);
    return;
  }

  const api = await new ApiClient().open();
  say(`pane ${PANE}`);

  // The same gate the office uses, asked out loud. Below 0.9.2 herdr has no renderer
  // for an app-written image, so the bytes would land on the screen as base64 text:
  // that is why the office refuses, and why this script has to refuse too.
  const snap = await api.request('session.snapshot', {}, 3000).catch((e) => ({ error: e.message }));
  if (snap.error) {
    say(`  could not read the snapshot: ${snap.error}`);
    say('  -> no version means no permission to write image bytes. The office is text-only here.');
    api.close();
    return;
  }
  const version = String(snap?.snapshot?.version ?? snap?.version ?? '');
  const protocol = snap?.snapshot?.protocol ?? snap?.protocol ?? '?';
  say(`  herdr ${version || '(no version in the snapshot)'}, protocol ${protocol}`);
  if (!atLeast(version, '0.9.2')) {
    say('  -> this server does not render app-written graphics. The office is correctly text-only here.');
    say('     If `herdr --version` disagrees, the binary was upgraded under a session still');
    say('     running the old server. Restart herdr: the version on the socket is the one that counts.');
    api.close();
    return;
  }

  const floor = loudOut();
  const g = new Graphics(api, PANE, floor);
  const caps = await g.probe();
  if (!caps) {
    say('  -> probe said no even though the version passed, which should not happen.');
    api.close();
    return;
  }
  say(`  cell ${caps.cellW}x${caps.cellH}px (assumed; set HERDR_OFFICE_CELL=WxH to correct it)`);
  say(`  up to ${caps.maxLayers} layers`);

  if (!DRAW) {
    say('');
    say('probe only. Re-run with --draw to put a test bar on the screen.');
    api.close();
    return;
  }

  // Sized to a known number of cells so the bar is unmistakable rather than a smudge
  // in a corner.
  const cols = 40;
  const canvas = new Canvas(cols * caps.cellW, caps.cellH);
  canvas.fill('#ff00ff');
  // A white block at each end and a black one in the middle, so a bar that is
  // stretched, cropped or offset is obvious rather than merely wrong.
  canvas.rect(0, 0, caps.cellW, caps.cellH, '#ffffff');
  canvas.rect(canvas.w - caps.cellW, 0, caps.cellW, caps.cellH, '#ffffff');
  canvas.rect(Math.floor(canvas.w / 2) - caps.cellW, 0, caps.cellW * 2, caps.cellH, '#000000');

  const frame = {
    id: LAYER,
    signature: `doctor:${Date.now()}`,
    region: { x: 0, y: ROW, w: cols, h: 1 },
    canvas,
  };
  say('');
  say(`  drawing ${canvas.w}x${canvas.h}px into ${cols}x1 cells at col 0 row ${ROW}`);
  g.sync([frame]);
  say(`  ${g.caps ? 'sent' : 'gave up'}: ${floor.bytes} bytes in ${floor.writes} write(s), ${floor.failures} failure(s)`);

  if (!g.caps) {
    say('  -> Graphics turned itself off, so the write failed. The transport is the');
    say('     problem, not the charts.');
    api.close();
    return;
  }

  say('');
  say(`A magenta bar with white ends and a black middle should now be on ROW ${ROW}`);
  say(`of pane ${PANE}, counting the top row as row 0.`);
  say('');
  say(`  on row ${ROW}          -> placement is 0-indexed, which is what the office assumes`);
  say(`  on row ${ROW + 1}          -> off by one, check the cursor move in src/graphics.mjs`);
  say('  soft or stretched   -> the assumed cell size is wrong, try HERDR_OFFICE_CELL=WxH');
  say('  base64 on screen    -> this herdr is not rendering it despite the version. Report it.');
  say('  nowhere at all      -> the bytes went out and nothing drew them');
  say('');
  if (LEAVE) {
    say('leaving it up. Take it down with:');
    say(`  node scripts/graphics-doctor.mjs --clear --pane ${PANE}`);
    api.close();
    return;
  }
  say(`clearing in ${HOLD}s...`);
  await new Promise((r) => setTimeout(r, HOLD * 1000));
  await g.clear();
  say('cleared.');
  api.close();
}

main().catch((err) => {
  console.error(`doctor: ${err.message}`);
  process.exit(1);
});
