// Clicks. A hitbox is a promise that something is drawn at those coordinates,
// and the buttons among them send real keystrokes to a real agent, so a hitbox
// in the wrong place is not a cosmetic bug: it approves something the user never
// looked at. These tests read the glyphs actually rendered underneath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, HIRE_ID } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, DETAILS, HIRES, KINDS, officeRoster, viewOf, stripAnsi } from './fixtures.mjs';

const roster = officeRoster();
const people = roster.people;

// The approval buttons, specifically. The empty desk and the hire menu are
// clickable too, but they are the only boxes in here that do not send a keystroke
// to a running agent, so the tests about buttons are not about them.
const answers = (hitboxes) => hitboxes.filter((b) => b.action === 'approve' || b.action === 'deny');

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
    for (const box of answers(hitboxes)) {
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
    for (const box of answers(hitboxes)) {
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
    const buttons = answers(hitboxes);
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        assert.ok(!hits(buttons[i], buttons[j]), `${label}: ${buttons[i].action} and ${buttons[j].action} overlap`);
      }
    }
  }
});

test('every hitbox belongs to somebody real, or to the empty desk', () => {
  for (const { label, hitboxes } of frames()) {
    for (const box of hitboxes) {
      if (box.id === HIRE_ID) continue;
      assert.ok(roster.find(box.id), `${label}: hitbox for ${box.id}, who is not on the roster`);
    }
  }
});

test('the empty desk is the sentinel id, which no real pane can be', () => {
  // It stands where a pane id stands, in grid.ids and in the hitboxes, so office.mjs
  // reaches it through the walk and click paths with no special case. That only
  // works while it cannot collide with a real pane id, and herdr's are
  // `<workspace>:<pane>`.
  assert.equal(HIRE_ID, '+hire');
  assert.ok(!HIRE_ID.includes(':'));
  for (const person of people) assert.notEqual(person.id, HIRE_ID);
});

test('the empty desk is clickable, and only where there is room for it', () => {
  const [cols, rows] = [140, 46];
  const vacancy = (view) => renderFrame(view).hitboxes.find((b) => b.id === HIRE_ID && b.action === 'hire');

  const { lines } = renderFrame(viewOf({ people, cols, rows }));
  const box = vacancy(viewOf({ people, cols, rows }));
  assert.ok(box, 'seven desks on a floor that holds eight should leave a spare');
  const plain = stripAnsi(lines[box.y]).slice(box.x, box.x + box.w);
  assert.equal(width(plain), box.w);
  assert.ok(plain.startsWith('╭') && plain.endsWith('╮'), `the empty desk is not over a cubicle: ${plain}`);

  // Nobody in at all: the empty desk is the whole office.
  assert.ok(vacancy(viewOf({ people: [], cols, rows })), 'an empty office should still offer a desk');
  // A floor with no slot going free must not offer one, because that would mean
  // paging to a desk nobody sits at.
  const eight = officeRoster(new Array(8).fill('working')).people;
  assert.equal(vacancy(viewOf({ people: eight, cols, rows })), undefined);
});

test('every hire menu cell sits on the name it would start', () => {
  // These cells start a real agent, so a cell in the wrong place hires somebody
  // the user did not point at.
  const [cols, rows] = [140, 46];
  let seen = 0;
  for (const [name, hire] of HIRES) {
    if (!hire) continue;
    const { lines, hitboxes } = renderFrame(viewOf({ people, cols, rows, hire, selectedId: HIRE_ID }));
    const plain = lines.map(stripAnsi);
    for (const box of hitboxes.filter((b) => b.action?.startsWith('hire:'))) {
      seen += 1;
      const kind = box.action.slice('hire:'.length);
      const under = (plain[box.y] || '').slice(box.x, box.x + box.w);
      assert.equal(width(under), box.w, `hire=${name}: cell for ${kind} is ${width(under)} cells`);
      assert.ok(under.includes(kind.slice(0, 9)), `hire=${name}: cell for ${kind} is over ${JSON.stringify(under)}`);
    }
  }
  assert.ok(seen >= KINDS.length, `only ${seen} menu cells were drawn, so this test proved nothing`);
});

test('a menu that cannot be shown offers nothing to click', () => {
  // Pending, failed, and still-loading menus draw prose instead of cells. A stale
  // hitbox left behind there would hire somebody off a click on a sentence.
  const [cols, rows] = [140, 46];
  for (const label of ['still asking', 'starting somebody', 'it went wrong']) {
    const hire = HIRES.find(([n]) => n === label)[1];
    const { hitboxes } = renderFrame(viewOf({ people, cols, rows, hire, selectedId: HIRE_ID }));
    assert.equal(hitboxes.filter((b) => b.action?.startsWith('hire:')).length, 0, `${label} should have no menu cells`);
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
