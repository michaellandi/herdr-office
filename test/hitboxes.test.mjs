// Clicks. A hitbox is a promise that something is drawn at those coordinates,
// and the buttons among them send real keystrokes to a real agent, so a hitbox
// in the wrong place is not a cosmetic bug: it approves something the user never
// looked at. These tests read the glyphs actually rendered underneath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, DETAILS, officeRoster, viewOf, stripAnsi } from './fixtures.mjs';

const roster = officeRoster();
const people = roster.people;

// Every frame worth checking, once, so each test can walk the same list.
function* frames() {
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) {
      for (const [name, detail] of DETAILS) {
        const view = viewOf({ people, cols, rows, frame, detail });
        yield { label: `${cols}x${rows} f${frame} panel=${name}`, view, ...renderFrame(view) };
      }
    }
  }
}

test('every button sits on the glyph it claims', () => {
  let seen = 0;
  for (const { label, lines, hitboxes } of frames()) {
    const plain = lines.map(stripAnsi);
    for (const box of hitboxes.filter((b) => b.action)) {
      seen += 1;
      const under = (plain[box.y] || '').slice(box.x, box.x + box.w);
      const want = box.action === 'approve' ? /^\[y\]( approve)?$/ : /^\[n\]( deny)?$/;
      assert.match(under, want, `${label}: ${box.action} at ${box.x},${box.y} is over ${JSON.stringify(under)}`);
    }
  }
  assert.ok(seen > 0, 'no buttons were rendered at all, so this test proved nothing');
});

test('only a desk that is actually waiting on you carries a button', () => {
  for (const { label, hitboxes } of frames()) {
    for (const box of hitboxes.filter((b) => b.action)) {
      const person = roster.find(box.id);
      assert.ok(person, `${label}: button on ${box.id}, who does not work here`);
      assert.equal(person.status, 'blocked', `${label}: button on ${box.id}, who is ${person.status}`);
    }
  }
});

test('no hitbox hangs off the edge of the frame', () => {
  // office.mjs hit-tests raw mouse coordinates against these, so a box outside
  // the pane is a click that does something with nothing visible under it.
  for (const { label, view, lines, hitboxes } of frames()) {
    const { cols } = view.size;
    for (const box of hitboxes) {
      assert.ok(box.x >= 0 && box.y >= 0, `${label}: box at ${box.x},${box.y} is off the top or left`);
      assert.ok(box.x + box.w <= cols, `${label}: box ends at column ${box.x + box.w}, pane is ${cols} wide`);
      assert.ok(box.y + box.h <= lines.length, `${label}: box ends at row ${box.y + box.h}, frame is ${lines.length} tall`);
    }
  }
});

test('no two buttons overlap', () => {
  // hitTest picks the first action box under the pointer, which is only
  // unambiguous while they are disjoint.
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const { label, hitboxes } of frames()) {
    const buttons = hitboxes.filter((b) => b.action);
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        assert.ok(!hits(buttons[i], buttons[j]), `${label}: ${buttons[i].action} and ${buttons[j].action} overlap`);
      }
    }
  }
});

test('every hitbox belongs to somebody real', () => {
  for (const { label, hitboxes } of frames()) {
    for (const box of hitboxes) {
      assert.ok(roster.find(box.id), `${label}: hitbox for ${box.id}, who is not on the roster`);
    }
  }
});

test('a desk is clickable wherever it is drawn', () => {
  // The whole tile, not just the nameplate: the desk hitbox has to cover the art
  // that identifies it, or clicking the person you are looking at does nothing.
  const [cols, rows] = [140, 46];
  const { lines, hitboxes } = renderFrame(viewOf({ people, cols, rows }));
  const desks = hitboxes.filter((b) => !b.action);
  assert.equal(desks.length, people.length, 'every desk on screen should be clickable');
  for (const box of desks) {
    const plain = stripAnsi(lines[box.y]).slice(box.x, box.x + box.w);
    assert.equal(width(plain), box.w);
    assert.ok(plain.startsWith('╭') && plain.endsWith('╮'), `desk hitbox for ${box.id} is not over a cubicle: ${plain}`);
  }
});
