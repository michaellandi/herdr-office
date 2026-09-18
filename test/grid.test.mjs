// The load-bearing test. Everything the office draws goes onto a fixed cell
// grid, and the repaint in office.mjs writes lines straight to the terminal
// without measuring them. One row wider than the pane wraps, which shoves every
// row below it down by one and corrupts the whole screen until something forces
// a full redraw. In someone else's terminal, in a pane they did not open.
//
// So: every frame is exactly `rows` lines, and every line is exactly `cols`
// cells. No exceptions, no sizes excused, every layout branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, HIRE_ID } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { matches as matchFilter } from '../src/filter.mjs';
import { pile, PILE_MAX } from '../src/dirt.mjs';
import { SIZES, FRAMES, DETAILS, DRAGS, HIRES, COMPOSES, TRUSTS, NEWS, FILTERS, BRANCHES, DIRTS, officeRoster, roomyRoster, viewOf, stripAnsi } from './fixtures.mjs';
import { assignRooms, ROOM_TINTS } from '../src/rooms.mjs';
import { fg } from '../src/theme.mjs';

function assertExact(view, label) {
  const { cols, rows } = view.size;
  const { lines } = renderFrame(view);
  assert.equal(lines.length, rows, `${label}: ${lines.length} lines, want ${rows}`);
  lines.forEach((line, i) => {
    assert.equal(width(line), cols, `${label}: line ${i} is ${width(line)} cells, want ${cols}`);
  });
}

const people = officeRoster().people;

test('desks, at every size and in every frame', () => {
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) {
      assertExact(viewOf({ people, cols, rows, frame }), `${cols}x${rows} f${frame}`);
    }
  }
});

test('with a desk open, in every state the panel can be in', () => {
  for (const [cols, rows] of SIZES) {
    for (const [name, detail] of DETAILS) {
      assertExact(viewOf({ people, cols, rows, detail }), `${cols}x${rows} panel=${name}`);
    }
  }
});

test('an empty office', () => {
  // Two branches, depending on the pane: big enough for one desk and it draws the
  // empty one, too small and it is two lines of prose plus the furniture. The
  // prose is 61 characters, which is wider than several of these panes.
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: [], cols, rows }), `empty ${cols}x${rows}`);
    assertExact(viewOf({ people: [], cols, rows, selectedId: HIRE_ID }), `empty at the desk ${cols}x${rows}`);
  }
});

test('one desk, and enough desks to page', () => {
  const one = officeRoster(['blocked']).people;
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: one, cols, rows }), `one ${cols}x${rows}`);
    // Forty desks overflows any pane, so this is the compact list and the paging
    // note, not the desk grid.
    assertExact(viewOf({ people: many, cols, rows }), `forty ${cols}x${rows}`);
    assertExact(viewOf({ people: many, cols, rows, selectedId: 'w1:p40' }), `forty last page ${cols}x${rows}`);
  }
});

test('a monitor showing a real command, at every size and frame', () => {
  // The running monitor is generated rather than drawn from a table: the command
  // is centred in the twelve cells a screen has and the bar under it rotates every
  // frame. So the sizes matter (the label has to be cut, not wrapped) and so do
  // more frames than usual, because the bar's rotation is what changes.
  const busyFloor = officeRoster(new Array(5).fill('working')).people;
  assert.ok(
    busyFloor.some((p) => p.command) && busyFloor.some((p) => !p.command),
    'the fixture should have both named and unnamed working desks',
  );
  for (const [cols, rows] of SIZES) {
    for (let frame = 0; frame < 13; frame += 1) {
      assertExact(viewOf({ people: busyFloor, cols, rows, frame }), `running ${cols}x${rows} f${frame}`);
      assertExact(viewOf({ people: busyFloor, cols, rows, frame, detail: DETAILS[3][1] }), `running+panel ${cols}x${rows} f${frame}`);
    }
  }
  // A command long enough to need cutting, on a floor small enough to draw desks.
  const wordy = officeRoster(['working']).people;
  wordy[0].command = 'gradlew assembleReleaseWithAVeryLongTaskName';
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) assertExact(viewOf({ people: wordy, cols, rows, frame }), `wordy ${cols}x${rows} f${frame}`);
  }
});

test('news over a desk, in every kind and at every size', () => {
  // The slab hangs on the same wall as the speech bubble and in the same columns,
  // so the sizes that matter are the ones where the wall is barely there at all.
  // A blocked desk is included on purpose: the ask owns that row, and news must
  // not appear alongside it or fight it for the space.
  for (const news of NEWS) {
    const floor = officeRoster().people.map((p) => ({ ...p, event: { ...news } }));
    for (const [cols, rows] of SIZES) {
      for (const frame of FRAMES) {
        assertExact(viewOf({ people: floor, cols, rows, frame }), `news=${news.kind}/${news.label.length} ${cols}x${rows} f${frame}`);
      }
      // And the compact list, where news takes over the pane title for a moment.
      const many = officeRoster(new Array(40).fill('working')).people.map((p) => ({ ...p, event: { ...news } }));
      assertExact(viewOf({ people: many, cols, rows }), `news list ${cols}x${rows}`);
    }
  }
  // A stuck desk keeps saying what it needs: the ask wins the wall.
  const { lines } = renderFrame(viewOf({
    people: officeRoster(['blocked']).people.map((p) => ({ ...p, event: { label: 'tests passed', kind: 'good' } })),
    cols: 105,
    rows: 45,
  }));
  const text = lines.join('\n');
  assert.ok(text.includes('shell requires approval'), 'the ask should still be on the wall');
  assert.ok(!text.includes('tests passed'), 'news must not push the ask off a stuck desk');
});

test('a filter, in every state the field can be in', () => {
  // The filter adds a chip to the header, changes the footer hints and can empty
  // the floor entirely, so it touches all three bands of the screen. The one that
  // catches things is a filter matching nobody: that is a code path with no desks
  // in it at all, on a pane with room for plenty.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [name, filter] of FILTERS) {
    for (const [cols, rows] of SIZES) {
      const shown = people.filter((p) => matchFilter(p, filter.filter));
      assertExact(viewOf({ people: shown, cols, rows, total: people.length, ...filter }), `filter=${name} ${cols}x${rows}`);
      // With a panel open, since the header chip and the panel share the width.
      assertExact(viewOf({ people: shown, cols, rows, total: people.length, detail: DETAILS[3][1], ...filter }), `filter=${name} +panel ${cols}x${rows}`);
      // And over the compact list, where forty desks are filtered down to a few.
      const shownMany = many.filter((p) => matchFilter(p, filter.filter));
      assertExact(viewOf({ people: shownMany, cols, rows, total: many.length, ...filter }), `filter=${name} list ${cols}x${rows}`);
      // An office that is empty for the ordinary reason, with a filter typed into
      // it, must still say the ordinary thing rather than both at once.
      assertExact(viewOf({ people: [], cols, rows, total: 0, ...filter }), `filter=${name} empty ${cols}x${rows}`);
    }
  }
});

test('a branch on the desk, at every length and every size', () => {
  // The branch shares the bottom line of a desk with the job, and the bottom row of
  // the compact list with the ask, so a name that did not give ground would push a
  // line over. Every zoom level, because each of the three draws it differently.
  for (const branch of BRANCHES) {
    const floor = officeRoster().people.map((p) => ({ ...p, branch, repo: 'herdr-office' }));
    for (const [cols, rows] of SIZES) {
      for (const zoom of ['auto', 'list', 'cubicle']) {
        assertExact(viewOf({ people: floor, cols, rows, zoom }), `branch=${branch} zoom=${zoom} ${cols}x${rows}`);
      }
      assertExact(viewOf({ people: floor, cols, rows, detail: { id: floor[0].id, read: null } }), `branch=${branch} +card ${cols}x${rows}`);
      const many = officeRoster(new Array(40).fill('working')).people.map((p) => ({ ...p, branch, repo: 'herdr-office' }));
      assertExact(viewOf({ people: many, cols, rows }), `branch=${branch} 40 ${cols}x${rows}`);
    }
  }
});

test('the branch gives up its space before the job does', () => {
  // The rule the widths encode: on a line with room for one of them, the job wins.
  // Half a branch name next to half a sentence is two lies where there could have
  // been one truth.
  const long = officeRoster().people.map((p) => ({
    ...p,
    title: 'refactor the socket client so it stops hanging up on us',
    branch: 'renovate/bump-everything-all-at-once-please',
  }));
  const wide = renderFrame(viewOf({ people: long, cols: 140, rows: 46 })).lines.map(stripAnsi).join('\n');
  assert.match(wide, /@renovate/, 'a wide desk shows both');
  // And a raised hand keeps its ask whatever the branch is doing.
  const stuck = officeRoster(['blocked']).people.map((p) => ({ ...p, branch: 'renovate/bump-everything-all-at-once-please' }));
  const text = renderFrame(viewOf({ people: stuck, cols: 105, rows: 45 })).lines.map(stripAnsi).join('\n');
  assert.match(text, /shell requires approval/);
});

test('a pile of uncommitted work, at every size and every zoom', () => {
  // The pile sits on the desk row between the sticky note and the keyboard, and the
  // badge that replaces it in the compact list shares the branch's column. Both are
  // drawn from a number that an agent changes while the office is watching, so every
  // width the pile can be is checked rather than the two a demo happens to produce.
  for (const dirt of DIRTS) {
    const label = dirt ? `${dirt.files}/${dirt.conflicts}` : 'unread';
    const floor = officeRoster().people.map((p) => ({ ...p, dirt, branch: 'feature/sso', repo: 'herdr-office' }));
    const many = officeRoster(new Array(40).fill('working')).people.map((p) => ({ ...p, dirt, branch: 'feature/sso', repo: 'herdr-office' }));
    for (const [cols, rows] of SIZES) {
      for (const zoom of ['auto', 'list', 'cubicle']) {
        assertExact(viewOf({ people: floor, cols, rows, zoom }), `dirt=${label} zoom=${zoom} ${cols}x${rows}`);
      }
      // The card grows a row for this, and the panel's height is what the floor above
      // it is measured against.
      assertExact(viewOf({ people: floor, cols, rows, detail: { id: floor[0].id, read: null } }), `dirt=${label} +card ${cols}x${rows}`);
      assertExact(viewOf({ people: many, cols, rows }), `dirt=${label} 40 ${cols}x${rows}`);
      // And with a raised hand's answer rows in the way, which is the case where the
      // badge gives its space up rather than taking it.
      assertExact(viewOf({ people: many, cols, rows, detail: DETAILS[3][1] }), `dirt=${label} 40 +card ${cols}x${rows}`);
    }
  }
});

test('the pile, the badge and the card all say the same thing', () => {
  // Three surfaces, one number, and the point of this is that it is the checkout's
  // number rather than the person's: fed through the roster the way the poll does it,
  // so two desks in one tree agree and a desk in another does not.
  const roomy = roomyRoster([1, 1, 2, 2, 3, 3, 3]);
  roomy.setDirt('/Users/you/Desktop/projects/repo1', { files: 0, conflicts: 0 });
  roomy.setDirt('/Users/you/Desktop/projects/repo2', { files: 3, conflicts: 0 });
  roomy.setDirt('/Users/you/Desktop/projects/repo3', { files: 148, conflicts: 1 });
  const people = roomy.people.map((p) => ({ ...p, branch: 'main', repo: 'herdr-office' }));
  const piles = people.map((p) => pile(p.dirt?.files));
  assert.deepEqual([...new Set(piles)].sort(), [0, 2, PILE_MAX], 'the fixture should show three different piles');

  // On the desk grid, the pile is wider *and* taller with the work, and the smallest
  // one is a glyph the desk furniture does not use, so a single cell cannot be read as
  // another mug.
  const desks = renderFrame(viewOf({ people, cols: 200, rows: 60 })).lines.map(stripAnsi).join('\n');
  assert.match(desks, /▄  ▃▃ /, 'a small pile');
  assert.match(desks, /▄  █████/, 'a large one');
  // The smallest pile there is, which is the case that has to survive: one cell, in a
  // glyph the sticky note and the mug do not use, clear of both.
  const one = renderFrame(viewOf({ people: people.map((p) => ({ ...p, dirt: { files: 1, conflicts: 0 } })), cols: 200, rows: 60 })).lines.map(stripAnsi).join('\n');
  assert.match(one, /▄  ▁ /, 'the smallest pile went missing');
  assert.ok(!/▄ ▄/.test(one), 'a pile drawn in the desk furniture\'s own glyph is furniture');

  // In the compact list, the number itself, next to the branch it belongs to. A clean
  // checkout says nothing rather than +0.
  const list = renderFrame(viewOf({ people, cols: 200, rows: 60, zoom: 'list' })).lines.map(stripAnsi).join('\n');
  assert.match(list, /@main \+3\b/);
  assert.match(list, /@main \+148\b/);
  assert.ok(!list.includes('+0'), list);

  // And on the card, in words, for whichever desk is open.
  const busy = people.find((p) => p.dirt?.files === 148);
  const card = renderFrame(viewOf({ people, cols: 200, rows: 60, detail: { id: busy.id, read: null } })).lines.map(stripAnsi).join('\n');
  assert.match(card, /changes\s+148 uncommitted · 1 conflicted/);
  const clean = people.find((p) => p.dirt?.files === 0);
  const tidy = renderFrame(viewOf({ people, cols: 200, rows: 60, detail: { id: clean.id, read: null } })).lines.map(stripAnsi).join('\n');
  assert.match(tidy, /changes\s+nothing uncommitted/);
  // A checkout nobody has read yet has no row at all, rather than a hedge.
  const unread = people.map((p) => ({ ...p, dirt: null }));
  const quiet = renderFrame(viewOf({ people: unread, cols: 200, rows: 60, detail: { id: unread[0].id, read: null } })).lines.map(stripAnsi).join('\n');
  assert.ok(!/\bchanges\b/.test(quiet), quiet);
});

test('a pile of paper never paints over a raised hand, or costs it a cell', () => {
  // The desk row the paper lives on is the same row the sticky note and the keyboard
  // are on, and a stuck desk's ask hangs above it. The pile is furniture: it must not
  // move anything, and it must not recolour a desk that is asking for something.
  const stuck = officeRoster(['blocked']).people;
  const bare = renderFrame(viewOf({ people: stuck, cols: 105, rows: 45 })).lines;
  const piled = renderFrame(viewOf({ people: stuck.map((p) => ({ ...p, dirt: { files: 148, conflicts: 1 } })), cols: 105, rows: 45 })).lines;
  assert.equal(piled.length, bare.length);
  piled.forEach((line, i) => assert.equal(width(line), width(bare[i]), `line ${i} changed width`));
  const text = piled.map(stripAnsi).join('\n');
  assert.match(text, /shell requires approval/, 'the ask still owns the wall');
});

test('every zoom level, at every size, still fills the pane exactly', () => {
  // Zoom changes how many desks are on the floor, which is the number every other
  // measurement in the renderer is derived from, so this is the suite that would
  // catch a cubicle spilling a row or a forced list on a pane with room for desks.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const zoom of ['auto', 'list', 'cubicle']) {
    for (const [cols, rows] of SIZES) {
      for (const frame of FRAMES) {
        assertExact(viewOf({ people, cols, rows, frame, zoom }), `zoom=${zoom} ${cols}x${rows} f${frame}`);
      }
      assertExact(viewOf({ people: many, cols, rows, zoom }), `zoom=${zoom} 40 desks ${cols}x${rows}`);
      assertExact(viewOf({ people: [], cols, rows, zoom }), `zoom=${zoom} empty ${cols}x${rows}`);
      assertExact(viewOf({ people, cols, rows, zoom, detail: DETAILS[3][1] }), `zoom=${zoom} +panel ${cols}x${rows}`);
      // The header's worst case: two badges, a long filter and a clock, all at once.
      assertExact(viewOf({
        people, cols, rows, zoom, following: true, filtering: true,
        filter: 'a-filter-nobody-would-ever-type-but-here-we-are', total: people.length,
      }), `zoom=${zoom} loaded header ${cols}x${rows}`);
    }
  }
});

test('one desk means one desk, and it says which one', () => {
  // The cubicle is the grid with room for a single tile, so the thing worth checking
  // is that the paging note counts people rather than floors: "floor 3 of 7" with one
  // person on the screen reads as six colleagues who have gone missing.
  const view = viewOf({ people, cols: 140, rows: 46, zoom: 'cubicle', selectedId: people[2].id });
  const text = renderFrame(view).lines.map(stripAnsi).join('\n');
  assert.match(text, /desk 3 of 7/);
  assert.ok(!text.includes('floor 3 of 7'), 'a floor with one desk on it is a desk');
  // Exactly one nameplate is drawn, and it is the selected person's.
  const named = people.filter((p) => text.includes(p.name));
  assert.deepEqual(named.map((p) => p.id), [people[2].id]);
  // And a pane too small to draw a desk at all falls back to the list rather than
  // showing an empty room.
  const tiny = renderFrame(viewOf({ people, cols: 60, rows: 12, zoom: 'cubicle' })).lines.map(stripAnsi).join('\n');
  assert.ok(people.filter((p) => tiny.includes(p.name)).length > 1, tiny);
});

test('shepherd mode wears a badge without shoving the clock off', () => {
  // The header is the one row where three things compete for the width: the counts,
  // the filter chip and this. It is also the row with the clock pinned to its right
  // edge, so a badge that did not fit would push the whole line over.
  for (const [cols, rows] of SIZES) {
    for (const frame of FRAMES) {
      assertExact(viewOf({ people, cols, rows, frame, following: true }), `following ${cols}x${rows} f${frame}`);
      // And with everything on at once, which is the actual worst case.
      assertExact(viewOf({
        people, cols, rows, frame, following: true, filtering: true,
        filter: 'a-filter-nobody-would-ever-type-but-here-we-are', total: people.length,
      }), `following+filter ${cols}x${rows} f${frame}`);
    }
  }
  const head = stripAnsi(renderFrame(viewOf({ people, cols: 140, rows: 46, following: true })).lines[0]);
  assert.match(head, /following hands/);
  assert.equal(head.indexOf('following hands'), head.lastIndexOf('following hands'), 'once is enough');
});

test('a filter that matches nobody says so, and offers no empty desk', () => {
  // The failure this guards against is quiet: with no desks left, the floor would
  // fall through to the "hire somebody" empty state, and a filter typo would read
  // as every agent having died.
  const { lines } = renderFrame(viewOf({ people: [], cols: 140, rows: 46, total: 7, filter: 'zzzz' }));
  const text = lines.map(stripAnsi).join('\n');
  assert.ok(text.includes('Nobody here matches "zzzz"'), text.slice(0, 400));
  assert.ok(!/hire/i.test(text.split('\n').slice(2, -2).join('\n')), 'no hiring prompt on a filtered floor');
  // The header still says how many people are really in the room.
  assert.match(stripAnsi(lines[0]), /0 of 7 desks/);
});

test('a floor split into rooms, at every size and every zoom', () => {
  // Rooms are colour and nothing else, which is exactly the claim worth testing on
  // the grid: paint cannot move a cell, so if any of this changed a line width then
  // it was not colour after all.
  for (const plan of [[1, 1, 1, 2, 2, 3, 3], [1, 2, 3, 4, 5, 6, 7], [1, 1, 1, 1, 1, 1, 2]]) {
    const roomy = roomyRoster(plan).people;
    for (const [cols, rows] of SIZES) {
      for (const zoom of ['auto', 'list', 'cubicle']) {
        assertExact(viewOf({ people: roomy, cols, rows, zoom }), `${cols}x${rows} rooms=${plan.join('')} ${zoom}`);
        // And with a desk open, since the card puts the workspace name in the room's
        // own colour.
        assertExact(viewOf({ people: roomy, cols, rows, zoom, detail: DETAILS[3][1] }), `${cols}x${rows} rooms card ${zoom}`);
      }
    }
  }
});

test('the room legend gives way rather than shoving the clock off', () => {
  // Seven rooms is more legend than a header has room for, and the clock is on the
  // far right: the chips have to stop when they run out of space, the same way the
  // status counts already do.
  const roomy = roomyRoster([1, 2, 3, 4, 5, 6, 7]).people;
  for (const [cols, rows] of SIZES) {
    const header = stripAnsi(renderFrame(viewOf({ people: roomy, cols, rows })).lines[0]);
    assert.equal(width(header), cols, `${cols}x${rows} header`);
    if (cols >= 60) assert.match(header, /\d\d:\d\d:\d\d/, `${cols}x${rows} lost the clock`);
  }
  // On a pane wide enough for everything, the rooms are actually named.
  const wide = stripAnsi(renderFrame(viewOf({ people: roomy, cols: 200, rows: 60 })).lines[0]);
  assert.ok(wide.includes('notes'), wide);
});

test('a room colour never paints over a raised hand', () => {
  // The one rule the palette has to obey. A wall is the last thing the border
  // consults, after the drag, the selection and the status, so a desk with its hand
  // up is drawn identically whether it is in a coloured room or not.
  const roomy = roomyRoster([1, 2, 2, 2, 2, 2, 2]).people;
  const rooms = assignRooms(roomy);
  const sand = fg(ROOM_TINTS[1].wall); // room two's wall, a colour nothing else uses
  const blocked = roomy.find((p) => p.status === 'blocked' && p.workspaceId === 'w2');
  const working = roomy.find((p) => p.status === 'working' && p.workspaceId === 'w2');
  assert.ok(blocked && working);
  // One column, one desk, nobody selected: the only wall on the screen belongs to
  // the desk being asserted about, and no selection or drag is in the way of it.
  const floor = (person, withRooms) => {
    const view = viewOf({ people: [person], cols: 40, rows: 20, selectedId: null, rooms: withRooms ? rooms : new Map() });
    return renderFrame(view).lines.slice(2, 18);
  };
  assert.deepEqual(floor(blocked, true), floor(blocked, false), 'the room repainted a raised hand');
  assert.ok(!floor(blocked, true).join('').includes(sand), 'a wall colour reached a raised hand');
  // ...and the wall of a desk that is merely working does change, or none of this
  // would be doing anything at all.
  assert.notDeepEqual(floor(working, true), floor(working, false));
  assert.ok(floor(working, true).join('').includes(sand), 'no room colour on the wall');
});

test('a footer message never pushes a line over', () => {
  const long = 'could not answer Ada: the socket hung up halfway through sending the keys';
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people, cols, rows, message: long }), `message ${cols}x${rows}`);
  }
});

test('dragging a desk, in every drag state', () => {
  // Drag feedback is meant to be colour only. If a drop target ever grows a
  // glyph or an extra cell, the whole floor wraps, so it is checked here rather
  // than trusted.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, drag] of DRAGS) {
      assertExact(viewOf({ people, cols, rows, drag }), `drag=${name} ${cols}x${rows}`);
      assertExact(viewOf({ people, cols, rows, drag, detail: DETAILS[3][1] }), `drag=${name} +panel ${cols}x${rows}`);
      // Forty desks is the compact list, which paints drag state as a row
      // background instead of a border.
      assertExact(viewOf({ people: many, cols, rows, drag }), `drag=${name} list ${cols}x${rows}`);
    }
    // A swap in flight pales its two desks whether or not anything is being
    // dragged right now.
    assertExact(viewOf({ people, cols, rows, busy: new Set(['w1:p1', 'w1:p3']) }), `busy ${cols}x${rows}`);
    assertExact(viewOf({ people: many, cols, rows, busy: new Set(['w1:p1', 'w1:p3']) }), `busy list ${cols}x${rows}`);
  }
});

test('hiring, in every state the menu can be in', () => {
  // The menu is a grid inside a grid: twenty-one names in fixed cells, laid out in
  // however many columns fit, with a name in there deliberately far longer than a
  // cell. Same rule as everything else, no line over.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, hire] of HIRES) {
      assertExact(viewOf({ people, cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} ${cols}x${rows}`);
      // With nobody in the office, the empty desk is the only thing on the floor.
      assertExact(viewOf({ people: [], cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} empty ${cols}x${rows}`);
      // And over the compact list, where there is no empty desk to stand at but
      // the menu still opens on the key.
      assertExact(viewOf({ people: many, cols, rows, hire, selectedId: HIRE_ID }), `hire=${name} list ${cols}x${rows}`);
    }
  }
});

test('assigning work, in every state the field can be in', () => {
  // Almost everything in this panel is generated at render time: the prompt wraps
  // to whatever width is left, the recipients line is a sentence built out of names
  // that may not fit, and a broadcast to thirty desks has to become a count rather
  // than a second row nobody budgeted for.
  const many = officeRoster(new Array(40).fill('working')).people;
  for (const [cols, rows] of SIZES) {
    for (const [name, compose] of COMPOSES) {
      assertExact(viewOf({ people, cols, rows, compose }), `compose=${name} ${cols}x${rows}`);
      assertExact(viewOf({ people: [], cols, rows, compose }), `compose=${name} empty ${cols}x${rows}`);
      assertExact(viewOf({ people: many, cols, rows, compose }), `compose=${name} list ${cols}x${rows}`);
    }
  }
  // The field outranks the other two panels, and asking for all three at once must
  // still come out as one panel's worth of rows rather than a stack of them.
  const compose = COMPOSES[3][1];
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people, cols, rows, compose, detail: DETAILS[3][1] }), `compose+detail ${cols}x${rows}`);
    assertExact(viewOf({ people, cols, rows, compose, hire: HIRES[2][1] }), `compose+hire ${cols}x${rows}`);
  }
});

test('a standing permission, armed, in every size the footer has', () => {
  // The armed grant puts the menu's own wording in two places at once: the footer
  // hint and the card's third answer row. Both are text off somebody else's screen,
  // which is the kind that does not fit, and the footer is the one row that cannot
  // afford to overflow because everything else is measured against it.
  //
  // The card is opened alongside it, since arming pulls the card open on purpose:
  // the confirm is supposed to happen with the menu on screen.
  const granting = DETAILS.find(([name]) => name === 'a standing grant on offer')[1];
  for (const [cols, rows] of SIZES) {
    for (const [name, trust] of TRUSTS) {
      assertExact(viewOf({ people, cols, rows, trust }), `trust=${name} ${cols}x${rows}`);
      assertExact(viewOf({ people, cols, rows, trust, detail: granting }), `trust=${name} +card ${cols}x${rows}`);
    }
  }
});

test('a pane title full of junk cannot skew the grid', () => {
  // Agents put anything in a terminal title. sanitize() is supposed to drop the
  // ambiguous-width glyphs before they reach the grid; this is the proof.
  const roster = officeRoster();
  roster.people[1].title = '🚀 建立 sandbox ██ [31mred[0m  ▪▪▪';
  roster.people[2].tabName = '日本語のタブ名';
  for (const [cols, rows] of SIZES) {
    assertExact(viewOf({ people: roster.people, cols, rows }), `junk ${cols}x${rows}`);
  }
});
