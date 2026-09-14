// Clicks. A hitbox is a promise that something is drawn at those coordinates,
// and the buttons among them send real keystrokes to a real agent, so a hitbox
// in the wrong place is not a cosmetic bug: it approves something the user never
// looked at. These tests read the glyphs actually rendered underneath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, HIRE_ID } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, DETAILS, HIRES, COMPOSES, KINDS, NEWS, FILTERS, officeRoster, viewOf, stripAnsi } from './fixtures.mjs';
import { matches as matchFilter } from '../src/filter.mjs';

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
    for (const box of hitboxes.filter((b) => b.action?.startsWith('hire:start:'))) {
      seen += 1;
      const kind = box.action.slice('hire:start:'.length);
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
    assert.equal(hitboxes.filter((b) => b.action?.startsWith('hire:start:')).length, 0, `${label} should have no menu cells`);
  }
});

test('the worktree row is only clickable where it is legible', () => {
  // Two of these three buttons create a directory and a git branch on disk, so a
  // box over a truncated label (or over the row of a menu that is not asking
  // anything) would make one off a click on nothing.
  const worktree = HIRES.find(([n]) => n === 'into a worktree')[1];
  const here = HIRES.find(([n]) => n === 'a menu')[1];
  const boxes = (view) => renderFrame(view).hitboxes.filter((b) => b.action?.startsWith('hire:where') || b.action === 'hire:branch');
  const at = (cols, rows, hire) => {
    const view = viewOf({ people, cols, rows, hire, selectedId: HIRE_ID });
    const { lines } = renderFrame(view);
    return boxes(view).map((b) => ({ ...b, under: stripAnsi(lines[b.y] || '').slice(b.x, b.x + b.w) }));
  };

  // Wide enough for the whole row: every button is there, and each one is over its
  // own label rather than over a neighbour's.
  const wide = at(140, 46, here);
  assert.deepEqual(wide.map((b) => b.action), ['hire:where:here', 'hire:where:worktree']);
  assert.ok(wide[0].under.includes('this project'), wide[0].under);
  assert.ok(wide[1].under.includes('worktree'), wide[1].under);

  const wt = at(140, 46, worktree);
  assert.deepEqual(wt.map((b) => b.action), ['hire:branch', 'hire:branch', 'hire:where:here']);
  assert.ok(wt[0].under.includes('office/claude'), wt[0].under);
  assert.ok(wt[1].under.includes('rename'), wt[1].under);
  for (const b of wt) assert.equal(width(b.under), b.w, `${b.action} is ${width(b.under)} cells, claims ${b.w}`);

  // Editing swaps the two buttons for a prompt, so there is exactly one box (the
  // field) and no way to click your way out of the edit into a hire.
  const editing = at(140, 46, HIRES.find(([n]) => n === 'naming the branch')[1]);
  assert.deepEqual(editing.map((b) => b.action), ['hire:branch']);

  // A hire already in flight offers no choices at all: the destination is decided
  // and the calls are out. A failed one keeps them, because the branch name is
  // usually the thing that needs changing.
  for (const label of ['making a worktree', 'starting somebody']) {
    const hire = HIRES.find(([n]) => n === label)[1];
    assert.equal(at(140, 46, hire).length, 0, `${label} should offer no destination buttons`);
  }
  assert.deepEqual(
    at(140, 46, HIRES.find(([n]) => n === 'the worktree went wrong')[1]).map((b) => b.action),
    ['hire:branch', 'hire:branch', 'hire:where:here'],
  );

  // Narrow enough that the row truncates: whatever survives is still over its own
  // label, and the buttons that got cut off are simply not clickable. The branch
  // field is allowed to show an elided name (clicking it opens a rename, which
  // makes nothing), but a destination button must never sit on half a word.
  for (const cols of [24, 32, 40, 50, 60, 72]) {
    for (const hire of [here, worktree]) {
      for (const b of at(cols, 46, hire)) {
        assert.equal(width(b.under), b.w, `${cols} cols: ${b.action} claims ${b.w} cells over ${JSON.stringify(b.under)}`);
        if (b.action === 'hire:branch') continue;
        assert.ok(!b.under.includes('…'), `${cols} cols: ${b.action} sits on a truncated label ${JSON.stringify(b.under)}`);
      }
    }
  }

  // And a pane too short for the row does not draw it at all: the menu keeps the
  // space, the title still says where the hire is going, and the keys still work.
  assert.equal(at(140, 10, worktree).length, 0, 'a short panel has no room for a destination row');
  assert.ok(at(140, 11, worktree).length > 0, 'one row taller and it is back');
});

test('nothing in the assign field is clickable, and neither is the floor under it', () => {
  // A design guarantee, not an accident, so it is asserted rather than trusted.
  // `agent.prompt` cannot be taken back, and a click target reading "send this to
  // six agents" is exactly the stray click there is no undoing. You reached the
  // keyboard to type the text at all, so enter is already under your hand.
  //
  // The stronger half: while the field is open the floor keeps its [y] and [n]
  // buttons drawn, and a click that answered somebody's approval prompt while you
  // were mid-sentence would be the worst accident available in here. office.mjs
  // drops mouse events outright, but the panel must not add any of its own either.
  const many = officeRoster(new Array(40).fill('blocked')).people;
  let seen = 0;
  for (const [cols, rows] of SIZES) {
    for (const [name, compose] of COMPOSES) {
      if (!compose) continue;
      for (const crowd of [people, [], many]) {
        const { lines, hitboxes } = renderFrame(viewOf({ people: crowd, cols, rows, compose }));
        // The panel announces itself: its top border carries "assign ·" or
        // "standup ·". Everything from that row down belongs to the field.
        const top = lines.findIndex((l) => /╭─ (assign|standup) · /.test(stripAnsi(l)));
        if (top < 0) continue; // too small to draw the panel at all
        seen += 1;
        for (const b of hitboxes) {
          assert.ok(b.y < top, `compose=${name} ${cols}x${rows}: a ${b.action || 'desk'} hitbox at row ${b.y} is inside the field (top ${top})`);
        }
      }
    }
  }
  assert.ok(seen > 50, `only checked ${seen} frames`);
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

test('news is scenery, not a control', () => {
  // The slab hangs where the speech bubble hangs, and a blocked desk's bubble is
  // the one place [y] and [n] live. So the question is not whether news is
  // clickable (it is not meant to be) but whether adding it ever moves or removes
  // a button that was already there. Same floor, twice, boxes compared.
  for (const news of NEWS) {
    for (const [cols, rows] of SIZES) {
      for (const frame of FRAMES) {
        const quiet = renderFrame(viewOf({ people, cols, rows, frame }));
        const loud = renderFrame(viewOf({
          people: people.map((p) => ({ ...p, event: { ...news } })),
          cols,
          rows,
          frame,
        }));
        assert.deepEqual(
          loud.hitboxes,
          quiet.hitboxes,
          `news=${news.kind}/${news.label.length} ${cols}x${rows} f${frame}: news changed what is clickable`,
        );
      }
    }
  }
});

test('a filtered floor is only clickable where somebody is standing', () => {
  // Every hitbox has to belong to a desk that is actually drawn. The hazard is the
  // approval buttons: a [y] left over from an unfiltered layout would sit on carpet
  // and answer for somebody who is not even on the screen.
  for (const [name, filter] of FILTERS) {
    const shown = people.filter((p) => matchFilter(p, filter.filter));
    for (const [cols, rows] of SIZES) {
      const view = viewOf({ people: shown, cols, rows, total: people.length, ...filter });
      const { lines, hitboxes } = renderFrame(view);
      const ids = new Set(shown.map((p) => p.id));
      for (const box of hitboxes) {
        if (box.id === HIRE_ID) continue;
        assert.ok(ids.has(box.id), `filter=${name} ${cols}x${rows}: a hitbox for ${box.id}, who is filtered out`);
      }
      const plain = lines.map(stripAnsi);
      for (const box of answers(hitboxes)) {
        const under = (plain[box.y] || '').slice(box.x, box.x + box.w);
        assert.match(under, /^\[[yn]\]( (approve|deny))?$/, `filter=${name} ${cols}x${rows}: button over ${JSON.stringify(under)}`);
      }
    }
  }
});

test('a filter offers no empty desk to hire into', () => {
  // Hiring while filtered is not wrong, but a chair that appeared because you typed
  // three letters reads as somebody having left, so the vacancy is suppressed and
  // its hitbox has to go with it.
  for (const [cols, rows] of SIZES) {
    const { hitboxes } = renderFrame(viewOf({ people: people.slice(0, 1), cols, rows, total: people.length, filter: 'ada' }));
    assert.equal(hitboxes.filter((b) => b.id === HIRE_ID).length, 0, `${cols}x${rows}`);
  }
});
