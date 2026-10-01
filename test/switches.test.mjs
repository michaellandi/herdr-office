// The settings card as it is drawn. test/settings.test.mjs is the argument about what the
// office believes; this is the argument about what you can see and click.
//
// The load-bearing assertions are the two that are easy to lose: that all six switches are
// on screen at every size the office supports, because a card that silently drops the one
// you came for is worse than no card, and that every row is a target the mouse can hit
// along its whole width rather than two cells next to a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, SETTINGS_ID } from '../src/render.mjs';
import { SETTINGS, defaults, settle } from '../src/settings.mjs';
import { STATUS, fg, P } from '../src/theme.mjs';
import { width } from '../src/text.mjs';
import { SIZES, officeRoster, viewOf, stripAnsi } from './fixtures.mjs';

const floor = () => officeRoster().people;

// The office as it ships, with the card open on whichever switch is asked for.
const open = (over = {}) => ({ index: 0, error: null, file: '~/.config/herdr-office/settings.json', ...settle(null, []), ...over });

const frame = (over = {}, cols = 110, rows = 32) =>
  renderFrame(viewOf({ people: floor(), cols, rows, settings: open(over) }));
const card = (over = {}, cols = 110, rows = 32) => frame(over, cols, rows).lines.map(stripAnsi);
const painted = (over = {}, cols = 110, rows = 32) => frame(over, cols, rows).lines;
const rowFor = (lines, label) => lines.find((l) => l.includes(label)) || '';
// Labels are truncated in a narrow pane, so a sweep across every size asks for the part of
// each one that is still on screen at twenty cells. All six differ inside twelve characters.
const stub = (label) => label.slice(0, 12);
// Just the card, with the floor above it thrown away, for the tests that are about a colour:
// a frame of working desks is full of greens that have nothing to do with a switch.
const panelOnly = (lines) => {
  const top = lines.findIndex((l) => stripAnsi(l).includes('\u256d\u2500 settings'));
  const end = lines.findIndex((l, i) => i > top && stripAnsi(l).includes('\u2570'));
  return lines.slice(top, end + 1);
};
// Wrapped help text has a line break wherever it ran out of room, and a border on both ends
// of every row, so a phrase is looked for in the card read back as one paragraph.
const flat = (lines) => lines.join(' ').replace(/[\u2500-\u257f]/g, ' ').replace(/\s+/g, ' ');

test('every switch is on the card, at every size the office supports', () => {
  for (const [cols, rows] of SIZES) {
    const lines = card({}, cols, rows);
    // Twenty by eight is excluded for the same reason every other sweep in here excludes
    // it: four rows below the header is not a card, and the office has never claimed the
    // panels work down there.
    if (cols > 20) {
      for (const s of SETTINGS) {
        assert.ok(
          lines.some((l) => l.includes(stub(s.label))),
          `${cols}x${rows}: "${s.label}" is not on the card`,
        );
      }
    }
    assert.ok(lines.some((l) => l.includes('settings')), `${cols}x${rows}: the card has no title`);
    for (const line of lines) {
      assert.ok(width(line) <= cols, `${cols}x${rows}: a row is ${width(line)} wide`);
    }
  }
});

test('every switch says which way it is, in words', () => {
  const lines = card();
  for (const s of SETTINGS) assert.match(rowFor(lines, s.label), /\son\b/, `${s.label} does not say it is on`);
  const off = card({ values: { ...defaults(), git: false } });
  assert.match(rowFor(off, 'count what is uncommitted'), /\soff\b/);
  // And only that one. A card where turning one thing off reads as all six off is a card
  // nobody would trust twice.
  assert.match(rowFor(off, 'draw the pixel charts'), /\son\b/);
});

test('the words line up, so a column of them can be read down', () => {
  const lines = card();
  const at = SETTINGS.map((s) => rowFor(lines, s.label).indexOf('on'));
  for (const x of at) {
    assert.ok(x > 0);
    assert.equal(x, at[0], 'the state words are not in a column');
  }
  // Including when one of them is the longer word, which is the case the gap exists for.
  const mixed = card({ values: { ...defaults(), manager: false } });
  assert.equal(rowFor(mixed, 'hire a manager').indexOf('off'), at[0]);
});

test('the one under the cursor is marked, and it is the only one', () => {
  const lines = card({ index: 2 });
  assert.match(rowFor(lines, SETTINGS[2].label), /▌/);
  assert.ok(!/▌/.test(rowFor(lines, SETTINGS[0].label)), 'two switches are under the cursor');
  assert.ok(!/▌/.test(rowFor(lines, SETTINGS[5].label)));
});

test('an index that cannot be right is the first switch rather than a blank card', () => {
  // The index comes off the office's own state so it should never be out of range, but a
  // card is not where a bad number gets to show.
  // A number too big is the last switch and a number too small is the first, because
  // clamping keeps the cursor on a real row; anything that is not a whole number at all is
  // the first, because there is nothing in it to clamp.
  for (const index of [null, undefined, 1.5, 'two', -3]) {
    assert.match(rowFor(card({ index }), SETTINGS[0].label), /▌/, `index ${index} drew no cursor`);
  }
  assert.match(rowFor(card({ index: 99 }), SETTINGS.at(-1).label), /▌/);
  // And exactly one of them, whatever was asked for.
  for (const index of [null, 1.5, -3, 99, 2]) {
    // Counted on the card alone: the floor above it draws the same glyph on every desk.
    assert.equal(panelOnly(card({ index })).filter((l) => l.includes('▌')).length, 1, `index ${index} drew two cursors`);
  }
});

test('the help text is about the one you are looking at, and only that one', () => {
  const lines = flat(card({ index: 0 }));
  // The sentence about the manager, which is what somebody opened this to read.
  assert.ok(lines.includes('spends tokens'), 'the help text for the selected switch is missing');
  // And not the other five at once, which is the wall of true sentences the card exists
  // to avoid: the git sentence belongs to a switch nobody has selected.
  assert.ok(!lines.includes('not a socket call'), 'every help text was drawn at once');

  const moved = flat(card({ index: 2 }));
  assert.ok(moved.includes('not a socket call'), 'moving the cursor did not move the help text');
  assert.ok(!moved.includes('spends tokens'));
  // Named, so you can tell what the paragraph under the switches is about.
  assert.ok(moved.includes('count what is uncommitted'));
});

test('a pane too short for a sentence still has all six switches', () => {
  const lines = card({}, 80, 14);
  for (const s of SETTINGS) assert.ok(lines.some((l) => l.includes(s.label)), `${s.label} was dropped`);
  // The switches are the card. The help is the thing that goes when there is no room,
  // because a switch with no explanation is still a switch and an explanation with no
  // switch is nothing at all.
  assert.ok(lines.every((l) => !l.includes('spends tokens')));
});

test('a switch that is off because of a flag says so, rather than looking broken', () => {
  const lines = card(settle({ manager: true }, ['--no-manager']));
  const row = rowFor(lines, 'hire a manager');
  assert.match(row, /\soff\b/);
  // The one word that explains it. Without this the card reads as having ignored the file.
  assert.ok(row.includes('--no-manager'), 'the card does not say the flag is why');
  assert.ok(row.includes('this run'), 'the card does not say it is only this run');
  // Nothing is said for a default or a saved value, because those are the card agreeing
  // with itself and there is no surprise to explain.
  assert.ok(!rowFor(lines, 'count what is uncommitted').includes('--no-git'));
  assert.ok(!rowFor(card({ values: { ...defaults(), git: false } }), 'count what is uncommitted').includes('--no-git'));
});

test('the card says where this is being kept', () => {
  const lines = card().join('\n');
  assert.ok(lines.includes('~/.config/herdr-office/settings.json'), 'the path is not on the card');
  // The home directory collapsed, because this pane gets screen-shared.
  assert.ok(!/\/Users\//.test(lines), 'an absolute home path reached the card');
});

test('a card with nowhere to write says that instead of a path', () => {
  const lines = card({ file: null }).join('\n');
  assert.ok(lines.includes('this run only'), 'a card that cannot persist does not say so');
});

test('a write that failed is said in the colour of a thing that needs a person', () => {
  const lines = card({ error: 'could not write ~/.config/herdr-office/settings.json' });
  assert.ok(lines.join('\n').includes('could not write'), 'the error is not on the card');
  // Instead of the path, not alongside it: the path is in the error.
  assert.ok(!lines.join('\n').includes('kept in'));
  const hot = panelOnly(painted({ error: 'could not write ~/x.json' })).join('\n');
  assert.ok(hot.includes(fg(STATUS.blocked.fg)), 'a failed write is not drawn as needing a person');
});

test('an on switch is drawn in the accent, never in the colour of a working desk', () => {
  const hot = panelOnly(painted()).join('\n');
  assert.ok(hot.includes(fg(P.accent)), 'the card has no accent on it at all');
  // Green is a monitor that is working and amber is a raised hand. A preference does not
  // get to borrow either, because then the one colour that must always win the eye could
  // be won by a switch.
  assert.ok(!hot.includes(fg(STATUS.working.fg)), 'a switch is drawn in the working green');
  assert.ok(!hot.includes(fg(STATUS.blocked.fg)), 'a switch is drawn in the raised-hand amber');
});

test('every switch is clickable, along the whole row rather than at the word', () => {
  for (const [cols, rows] of SIZES) {
    const { hitboxes } = frame({}, cols, rows);
    const mine = hitboxes.filter((h) => h.id === SETTINGS_ID);
    // All six wherever the card has room for all six, and never a hitbox for a row the
    // card was too short to draw: a click on coordinates holding something else would
    // otherwise flip a switch nobody could see.
    if (cols > 20) assert.equal(mine.length, SETTINGS.length, `${cols}x${rows}: ${mine.length} of six switches are clickable`);
    else assert.ok(mine.length < SETTINGS.length, 'a pane with four rows below the header drew six switch rows');
    for (const [i, box] of mine.entries()) {
      assert.equal(box.action, `settings:toggle:${SETTINGS[i].key}`, `${cols}x${rows}: the wrong switch is under row ${i}`);
      assert.equal(box.h, 1);
      // Wide enough to be worth aiming at. A two-cell target next to its own label is a
      // target that gets missed.
      assert.ok(box.w >= Math.min(12, cols), `${cols}x${rows}: a switch is only ${box.w} cells wide`);
      assert.ok(box.y >= 0 && box.y < rows, `${cols}x${rows}: a switch is off screen at row ${box.y}`);
    }
    // In order, one row apart, which is also what makes the index and the click agree.
    for (let i = 1; i < mine.length; i += 1) assert.equal(mine[i].y, mine[i - 1].y + 1);
  }
});

test('a click on a switch lands on the row you can see it on', () => {
  const { lines, hitboxes } = frame({}, 110, 32);
  const plain = lines.map(stripAnsi);
  for (const box of hitboxes.filter((h) => h.id === SETTINGS_ID)) {
    const key = box.action.slice('settings:toggle:'.length);
    assert.ok(
      plain[box.y].includes(SETTINGS.find((s) => s.key === key).label),
      `the hitbox for ${key} is on a row that does not hold it`,
    );
  }
});

test('the key bar is about the card while the card is open', () => {
  const bar = stripAnsi(card().at(-1));
  assert.ok(bar.includes('pick a switch'), 'the key bar still describes the floor');
  assert.ok(bar.includes('esc'));
  // The verb matches the switch under the cursor, so the bar is never offering to turn on
  // something that is already on.
  assert.ok(bar.includes('turn it off'), 'the bar offers to turn on a switch that is on');
  const off = stripAnsi(card({ values: { ...defaults(), manager: false } }).at(-1));
  assert.ok(off.includes('turn it on'), 'the bar offers to turn off a switch that is off');
});

test('the floor says the card is there, and the comma is how', () => {
  // A wide pane with nothing on the notice line, which is the same condition `q leave`
  // needs: the footer shares its row with whatever the manager has to say, and everything
  // past `r refresh` is cut when there is news. A preference is last but one on purpose.
  const bar = stripAnsi(
    renderFrame(viewOf({ people: officeRoster(['idle', 'idle', 'done']).people, cols: 200, rows: 60, notices: [] })).lines.at(-1),
  );
  assert.ok(bar.includes('settings'), 'nothing on the floor mentions the settings card');
  assert.match(bar, /,\s+settings/, 'the key for it is not next to it');
});

test('the card is the one panel on screen', () => {
  // Five panels, one slot. The settings card is last of the five, so anything else being
  // open means the card is not drawn at all.
  const lines = renderFrame(
    viewOf({ people: floor(), cols: 140, rows: 46, board: true, settings: open() }),
  ).lines.map(stripAnsi);
  assert.ok(!lines.some((l) => l.includes('hire a manager')), 'two panels were drawn at once');
});
