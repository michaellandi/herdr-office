// The manager's desk.
//
// src/notices.mjs decides what is true about the floor and test/notices.test.mjs is
// where that argument lives. This file is about the desk that says it: the words that
// fit on a twelve cell monitor, and the fact that a desk drawn in the middle of the
// grid still cannot reach an agent.
//
// The reason the desk exists at all is written down in the first test: a manager that
// only spoke on the footer was indistinguishable, to the person who asked for it, from
// one that had never been built. So "it is visibly there when it has nothing to say" is
// the load-bearing assertion here, not a nicety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manager, MANAGER_ID, SCREEN_COLS } from '../src/manager.mjs';
import { renderFrame, MANAGER_ID as RE_EXPORTED, HIRE_ID } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, FRAMES, officeRoster, viewOf, stripAnsi, isManagerRow } from './fixtures.mjs';

// Notices as src/notices.mjs builds them, shaped by hand so nothing here depends on
// which desks the roster fixture happens to put where.
// The ids are real desks in the fixture roster and they matter now: the card reads the
// notice's `ids` back off the floor to say what happened at each of those desks, so a
// notice pointing at a pane nobody drew would silently brief nobody.
const said = (kind, text, ids = ['w1:p1']) => ({ kind, ids, text });
const COLLISION = said('collision', 'Ada and Bo are both in herdr-office', ['w1:p1', 'w1:p2']);
const FULL = said('full', 'Cass is 94% full and still working', ['w1:p3']);
const SAME = said('same-ask', 'Ada and Bo are stuck on the same thing', ['w1:p1', 'w1:p2']);
const STALL = said('stalled', 'Dev stopped 16m02s ago with 7 files uncommitted', ['w1:p4']);
const ALL = [COLLISION, FULL, SAME, STALL];
// The same stall with the reason notices.mjs now hands over alongside it. A separate
// field rather than a longer sentence, because each surface below has a different amount
// of room and only one of them has enough.
const WHY = { ...STALL, why: 'said "I cannot apply the patch, the file …"' };
const WHOLE = `${WHY.text}, ${WHY.why}`;

/* --------------------------------------------------------------- what it says */

test('a quiet floor still has a manager sitting at a desk', () => {
  // The whole point. The first version of this only spoke when it had news, and the
  // person who asked for it ran the office, saw nothing, and reasonably concluded it
  // was broken. Correct and invisible is indistinguishable from absent.
  const m = manager({ notices: [] });
  assert.equal(m.name, 'THE MANAGER');
  assert.equal(m.role, 'chief of staff');
  assert.equal(m.pose, 'watching');
  assert.equal(m.chip, 'WATCHING');
  assert.equal(m.count, 0);
  assert.equal(m.line, 'nothing needs you right now');
  assert.match(m.screen[0], /all quiet/);
});

test('one desk to say something about is said in the singular', () => {
  // A wide desk, so this test is about the words rather than about where they get cut.
  const m = manager({ notices: [FULL], width: 60 });
  assert.equal(m.pose, 'news');
  assert.equal(m.chip, '1 DESK');
  assert.equal(m.count, 1);
  assert.equal(m.desks, 1);
  assert.match(m.screen[0], /1 desk/);
  assert.match(m.screen[1], /full head/);
  assert.equal(m.line, FULL.text);
});

test('a crowd of notices counts the desks and names the most urgent one', () => {
  // notices() is already ordered most-urgent-first, so the label on the screen and the
  // sentence under the desk are both about the same notice: the one at the top of the
  // list the footer counts `1/4` through.
  const m = manager({ notices: ALL, width: 60 });
  assert.equal(m.chip, '4 DESKS');
  assert.equal(m.count, 4, 'four sentences');
  assert.equal(m.desks, 4, 'about four desks: Ada and Bo are each in two of them');
  assert.match(m.screen[0], /4 desks/);
  assert.match(m.screen[1], /one checkout/);
  assert.equal(m.line, COLLISION.text);
});

test('the chip counts desks that need somebody, not sentences about them', () => {
  // The bug this fixes, in the shape it was reported in: three agents stopped in one
  // checkout, and the desk said `1 THING`. One is the number of sentences the office has
  // to say, because four reports of one directory's file count reads as four times the
  // work. Three is the number of people who are stuck, and nobody has ever wanted the
  // first number.
  const crowd = said('stalled', 'Ada, Bo and Cass stopped in herdr-office with 7 files uncommitted', ['w1:p1', 'w1:p2', 'w1:p3']);
  const m = manager({ notices: [crowd], width: 60 });
  assert.equal(m.chip, '3 DESKS');
  assert.match(m.screen[0], /3 desks/);
  assert.equal(m.count, 1, 'still one sentence');
  assert.equal(m.desks, 3);

  // And a desk in two notices at once is one desk, which is the same lie the other way
  // round: a full head in a shared checkout is two things worth saying about one person.
  const twice = manager({ notices: [said('collision', 'Ada and Bo are both in herdr-office', ['w1:p1', 'w1:p2']), said('full', 'Ada is 94% full and still working', ['w1:p1'])] });
  assert.equal(twice.count, 2);
  assert.equal(twice.desks, 2);
  assert.equal(twice.chip, '2 DESKS');
});

test('every kind of notice has a word that fits on the glass', () => {
  // A label wider than the monitor is a label nobody reads. The kinds are enumerated
  // here rather than derived, so a new kind added to notices.mjs without a word for it
  // fails this rather than silently drawing an empty second row.
  for (const n of ALL) {
    const m = manager({ notices: [n] });
    assert.ok(m.screen[1].trim(), `${n.kind} had no word for the screen`);
    assert.ok(width(m.screen[1]) === SCREEN_COLS, `${n.kind} label is ${width(m.screen[1])} cells`);
  }
});

test('the monitor is always exactly the monitor', () => {
  // Two rows, each the full width, whatever it is saying. The renderer pads and
  // truncates again on the way out, so a wrong answer here would not tear the grid,
  // it would silently knock the centring off by a cell and nobody would know why.
  const cases = [[], [COLLISION], ALL, [said('collision', 'x'.repeat(200))], [said('unheard-of-kind', 'something new')]];
  for (const notices of cases) {
    const m = manager({ notices });
    assert.equal(m.screen.length, 2);
    for (const line of m.screen) assert.equal(width(line), SCREEN_COLS, `"${line}" is ${width(line)} cells`);
  }
});

test('the screen is centred, the way every other monitor in the office is', () => {
  // Flush left read as a bug rather than a choice when it was drawn next to a running
  // command and an APPROVE?, both of which sit in the middle of their glass.
  const m = manager({ notices: [] });
  assert.ok(m.screen[0].startsWith(' '), 'the headline was flush against the bezel');
  assert.ok(m.screen[0].endsWith(' '));
});

test('a notice longer than the desk is cut to the desk', () => {
  const long = said('collision', `Ada, Bo and 11 more are all in ${'d'.repeat(200)}`);
  assert.equal(width(manager({ notices: [long], width: 27 }).line), 27);
  assert.equal(width(manager({ notices: [long], width: 9 }).line), 9);
  // And the default is a real desk's width, so a caller that only wants the words
  // still gets something a desk could hold.
  assert.ok(width(manager({ notices: [long] }).line) <= 27);
});

test('rubbish in the notice list is dropped rather than drawn', () => {
  // view.notices comes off a render call and office.mjs recomputes it every frame, so
  // this is defence against a shape change upstream, not against a known bug.
  assert.equal(manager().count, 0);
  assert.equal(manager({}).count, 0);
  assert.equal(manager({ notices: null }).count, 0);
  assert.equal(manager({ notices: 'not a list' }).count, 0);
  assert.equal(manager({ notices: [null, undefined, {}, { kind: 'collision' }] }).count, 0);
  assert.equal(manager({ notices: [null, COLLISION] }).count, 1);
});

test('nothing the manager hands back can do anything', () => {
  // The claim this whole feature rests on: it is a pure function of a list of
  // sentences. A callable on this object would be a way for a desk to acquire a verb
  // without anybody noticing, which is exactly the property the office is trading on
  // when it says the manager is read-only.
  const m = manager({ notices: ALL });
  for (const [key, value] of Object.entries(m)) {
    assert.notEqual(typeof value, 'function', `${key} is callable`);
  }
});

test('the id cannot be a pane', () => {
  // herdr pane ids are `workspace:pane`, so a leading `+` is unreachable. Both desks
  // with nothing behind them rely on this, and they must not be each other.
  assert.equal(MANAGER_ID, '+manager');
  assert.equal(RE_EXPORTED, MANAGER_ID, 'render.mjs re-exports a different id');
  assert.notEqual(MANAGER_ID, HIRE_ID);
  assert.ok(MANAGER_ID.startsWith('+'));
  assert.ok(!MANAGER_ID.includes(':'));
});

/* ------------------------------------------------------------------ on screen */

const people = officeRoster().people;
const floor = (extra) => renderFrame(viewOf({ people, cols: 140, rows: 46, ...extra }));
const plain = (frame) => frame.lines.map(stripAnsi);

test('the manager has a desk on the floor plan, and it is the first one', () => {
  const frame = floor({ notices: [] });
  const desks = frame.hitboxes.filter((b) => !b.action && b.h > 1);
  assert.equal(desks[0].id, MANAGER_ID, `the first desk was ${desks[0].id}`);
  assert.ok(plain(frame).some((l) => l.includes('THE MANAGER')), 'the desk was not drawn');
  assert.ok(plain(frame).some((l) => l.includes('chief of staff')));
});

test('clicking the desk selects it and does nothing else', () => {
  // The empty desk next to it carries `hire`, which starts an agent. This one carries
  // no action at all, so there is no click on it that writes anywhere.
  const boxes = floor({ notices: [] }).hitboxes.filter((b) => b.id === MANAGER_ID);
  assert.equal(boxes.length, 1, `${boxes.length} hitboxes for one desk`);
  assert.equal(boxes[0].action, undefined);
});

test('a quiet desk is still obviously a desk with somebody at it', () => {
  // The failure mode being guarded here is the one the footer had: on a calm floor the
  // manager must not be mistakable for the empty chair beside it.
  const quiet = plain(floor({ notices: [] }));
  assert.ok(quiet.some((l) => l.includes('WATCHING')), 'the quiet desk said nothing at all');
  assert.ok(quiet.some((l) => l.includes('nothing needs you right now')));
});

test('news reaches the desk as well as the footer', () => {
  // A sentence short enough to fit both places, so this is about it arriving twice
  // rather than about the desk's 27 cells. The long case is truncation, tested above.
  const short = said('collision', 'Ada and Bo share a tree', ['w1:p1', 'w1:p2']);
  const lines = plain(floor({ notices: [short, FULL, SAME, STALL] }));
  assert.ok(lines.some((l) => l.includes('4 DESKS')), 'the chip did not count');
  assert.equal(lines.filter((l) => l.includes(short.text)).length, 2, 'the sentence is not on both the desk and the footer');
});

test('the manager is row one of the compact list', () => {
  // What a narrow pane gets, and what an 80 column pane gets at any height. Leaving it
  // out here would have reproduced the original complaint one pane size along.
  const lines = plain(renderFrame(viewOf({ people, cols: 80, rows: 30, zoom: 'list', notices: [COLLISION] })));
  const rows = lines.filter((l) => /WORKING|NEEDS YOU|IDLE|DONE|UNSURE|WATCHING|\d+ DESKS?\b/.test(l));
  assert.ok(isManagerRow(rows[0]), `the first row was "${rows[0]}"`);
  assert.match(rows[0], /manager/);
  assert.match(rows[0], /are both in herdr-office/);
  // And every row below it is somebody real, so the manager took one row, not two.
  assert.equal(rows.filter(isManagerRow).length, 1);
});

test('the manager stands down while a filter is on', () => {
  // The notices are about the whole office. A manager in a view of three desks would
  // be making claims about the nine that are not on the screen. Same reasoning as the
  // empty desk, which also disappears under a filter.
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list']) {
      const frame = renderFrame(viewOf({ people, cols, rows, zoom, filter: 'waiting', notices: ALL }));
      assert.ok(!frame.hitboxes.some((b) => b.id === MANAGER_ID), `${cols}x${rows} ${zoom}: the manager stayed`);
    }
  }
});

test('a floor with room for one desk spends it on a person', () => {
  // Cubicle zoom, and any pane too small for a second tile. The manager taking the
  // slot here means a whole floor to itself, every colleague bumped one floor along,
  // and "desk 1 of 8" on a seven desk office.
  const frame = renderFrame(viewOf({ people, cols: 140, rows: 46, zoom: 'cubicle', notices: ALL }));
  assert.ok(!frame.hitboxes.some((b) => b.id === MANAGER_ID));
  assert.ok(plain(frame).some((l) => l.includes(people[0].name)));
});

test('the manager is on the first floor and nowhere else', () => {
  // The page is derived from the selection rather than stored, so a desk that appeared
  // on every floor would have no answer to "which floor am I on" when selected. One
  // floor it is, and the footer line carries the news on the others.
  // Twelve desks at this size is two floors of eight, which is the most `auto` will
  // draw as desks at all: past two floors it gives you the compact list instead, and
  // the list has no pages for the manager to be on the wrong one of.
  const crowd = officeRoster(new Array(12).fill('working')).people;
  const at = (selectedId) => renderFrame(viewOf({ people: crowd, cols: 140, rows: 46, selectedId, notices: ALL }));
  assert.ok(at(MANAGER_ID).hitboxes.some((b) => b.id === MANAGER_ID), 'selecting it did not draw it');
  // Standing at a desk on a later floor: the manager is not on that floor.
  const later = at(crowd[11].id);
  assert.ok(plain(later).some((l) => l.includes(crowd[11].name)), 'the wrong floor is on screen');
  assert.ok(!later.hitboxes.some((b) => b.id === MANAGER_ID), 'the manager followed you upstairs');
});

test('walking off the first floor and back finds the desk again', () => {
  // The paging arithmetic has two branches now (floor one holds one fewer person), and
  // the way to get that wrong is to lose or duplicate a desk at the boundary.
  const crowd = officeRoster(new Array(12).fill('working')).people;
  const seen = new Set();
  for (const p of crowd) {
    for (const id of renderFrame(viewOf({ people: crowd, cols: 140, rows: 46, selectedId: p.id })).hitboxes.filter((b) => b.h > 1).map((b) => b.id)) {
      seen.add(id);
    }
  }
  for (const p of crowd) assert.ok(seen.has(p.id), `${p.name} was on no floor at all`);
  assert.ok(seen.has(MANAGER_ID));
});

test('the card says what it is and what it cannot do', () => {
  // Where somebody goes to ask what this thing is, which is why the second field is a
  // standing promise rather than a status.
  const lines = plain(floor({ board: true, selectedId: MANAGER_ID, notices: ALL }));
  const text = lines.join('\n');
  assert.match(text, /THE MANAGER · chief of staff/);
  // Both numbers, because they answer different questions: four people are waiting and
  // there are four things to say about them, and the second number being larger is normal.
  assert.match(text, /4 desks, 4 things worth mentioning/);
  assert.match(text, /nothing: it reads the floor and writes lines/);
  assert.match(text, /what happened at each desk/);
  assert.match(text, /m walks to the desk each one is about/);
});

test('a quiet card says so, and says that is the good outcome', () => {
  const text = plain(floor({ board: true, selectedId: MANAGER_ID, notices: [] })).join('\n');
  assert.match(text, /nothing worth mentioning/);
  assert.match(text, /the floor is quiet/);
  assert.match(text, /nothing, which is the good outcome/);
});

test('the card has nothing to click', () => {
  // Every other panel has buttons on it, and the buttons send keystrokes to real
  // agents. This one is a card, so a stray hitbox inside it would be a click that
  // reached a pane from a panel that has no business reaching one.
  const frame = floor({ board: true, selectedId: MANAGER_ID, notices: ALL });
  const rows = frame.lines.length;
  const inPanel = frame.hitboxes.filter((b) => b.y >= rows / 2 && b.action);
  assert.deepEqual(inPanel, [], `the card had ${inPanel.length} buttons`);
});

test('the card is clipped rather than allowed to overflow', () => {
  // The notice list is as long as the floor is broken, and the panel is as tall as the
  // pane allows. One row too many pushes the footer off the bottom.
  const many = new Array(40).fill(0).map((_, i) => said('collision', `pair ${i} are both in some-repo`));
  for (const [cols, rows] of SIZES) {
    const { lines } = renderFrame(viewOf({ people, cols, rows, board: true, selectedId: MANAGER_ID, notices: many }));
    assert.equal(lines.length, rows, `${cols}x${rows}: ${lines.length} lines`);
    lines.forEach((line, i) => assert.equal(width(line), cols, `${cols}x${rows}: line ${i} is ${width(line)} cells`));
  }
});

/* ------------------------------------------------------- why the desk stopped */

// "Dev stopped 16m02s ago with 7 files uncommitted" says a desk has a problem and
// nothing about what it is. The reason arrives on the notice as its own field, and these
// four tests are the four widths it has to survive: a 27 cell status bar under a tile, a
// compact list row, the footer, and the card.
//
// The rule every one of them follows is that a reason is printed whole or not at all.
// Half a quote is the office putting somebody else's words in its mouth and cutting them
// off mid-sentence, which is worse than the line it replaced.

test('a desk narrow enough to cut the reason drops it instead', () => {
  // The tile's status bar. 27 cells is not a sentence and a half, so the fact wins: the
  // chip already says how many things there are and the monitor already says what kind,
  // so on a tile the fact is stated three times over while the reason needs room or none.
  const line = manager({ notices: [WHY], width: 27 }).line;
  assert.equal(width(line), 27);
  assert.doesNotMatch(line, /said/, 'a tile printed part of a quote');
  assert.ok(WHY.text.startsWith(line.replace(/…$/, '')), `"${line}" is not the front of the fact`);
});

test('a desk wide enough for the whole reason says it', () => {
  // And the trade is worth making only if the reason is actually reachable somewhere. A
  // rule that drops it at every width is a feature that does not exist.
  assert.equal(manager({ notices: [WHY], width: 200 }).line, WHOLE);
  // Exactly enough is enough, and one cell short is not.
  assert.equal(manager({ notices: [WHY], width: width(WHOLE) }).line, WHOLE);
  assert.doesNotMatch(manager({ notices: [WHY], width: width(WHOLE) - 1 }).line, /said/);
});

test('no surface anywhere prints half a quote', () => {
  // The sweep that makes the rule above worth having. Both zooms at every size, checking
  // the drawn characters rather than the string handed to the renderer: the bug this
  // found was in the compact row, which asked for the sentence at the pane's full width
  // and then cut the row down to fit, which is precisely the failure being forbidden.
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list']) {
      const text = plain(renderFrame(viewOf({ people, cols, rows, zoom, notices: [WHY] }))).join('\n');
      const where = `${cols}x${rows} ${zoom}`;
      if (text.includes('said')) assert.ok(text.includes(WHY.why), `${where}: a fragment of the quote is on screen`);
    }
  }
});

test('the compact row carries the reason when the row is long enough', () => {
  // The negative above is satisfied by never printing a reason at all, so this is the
  // other half: a wide pane in list view does show it, and a narrow one shows the fact.
  const row = (cols) => plain(renderFrame(viewOf({ people, cols, rows: 30, zoom: 'list', notices: [WHY] }))).find(isManagerRow);
  assert.ok(row(200).includes(WHY.why), 'a 200 column row had no room for a reason');
  assert.ok(row(80).includes('Dev stopped'), 'a narrow row lost the fact as well');
  assert.doesNotMatch(row(80), /said/);
});

test('the footer appends the reason only when the whole of it fits', () => {
  const footer = (cols) => plain(renderFrame(viewOf({ people, cols, rows: 30, notices: [WHY] }))).at(-1);
  assert.ok(footer(200).includes(WHY.why), 'the footer never says why at any width');
  assert.ok(footer(90).includes('Dev stopped'), 'the footer lost the fact too');
  assert.doesNotMatch(footer(90), /said/);
});

/* ------------------------------------------ what happened at each desk */

// The card stopped being a list of notices here, and the reason is a complaint about the
// version that was: three agents were stopped in one checkout, and what the office offered
// was `1 THING` and one truncated sentence naming one of them. Every fact needed to explain
// all three was already in the roster. The card had nowhere to put any of it, because it was
// a wider copy of the 27 cell status bar under the desk rather than a different thing.
//
// So these tests are about the card being an account per desk. The rules from the section
// above still hold on the surfaces that have one line: a status bar and a footer still print
// a reason whole or not at all. This is the surface that has room for all of them.

// That floor, built out. One notice, because the file count belongs to the directory, and
// three people, because that is how many are stuck.
const STUCK = { kind: 'stalled', ids: ['w1:p1', 'w1:p2', 'w1:p3'], text: 'Ada, Bo and Cass stopped in herdr-office with 7 files uncommitted', why: 'Ada said "I cannot apply the patch, the file …"' };
const stuckFloor = () => {
  const list = officeRoster(['idle', 'idle', 'idle']).people;
  // What tells them apart, all of it already in the person the roster builds: what each was
  // asked to do, what each last said, and which of the seven events last fired at it.
  const own = [
    { title: 'apply the security patch', said: 'I cannot apply the patch, the file has changed', lastEvent: { label: 'tests failed', kind: 'broke', ageMs: 1_460_000 } },
    { title: 'rewrite the auth guard', said: 'Should I delete the old migration?', lastEvent: { label: 'merge conflict', kind: 'snag', ageMs: 320_000 } },
    { title: 'port the tests to node:test', head: { used: 94, model: 'a-model' } },
  ];
  list.forEach((p, i) =>
    Object.assign(p, {
      statusMs: 1_800_000 + i * 600_000,
      dirt: { files: 7, conflicts: i === 1 ? 3 : 0 },
      branch: 'a-manager-who-notices',
      repo: 'herdr-office',
      ...own[i],
    }),
  );
  return list;
};
const bigCard = (notices, people = stuckFloor(), cols = 140, rows = 46) =>
  plain(renderFrame(viewOf({ people, cols, rows, board: true, selectedId: MANAGER_ID, notices })));

// A floor where everybody is stuck and every desk has something to say, for the tests
// about what a card does when it runs out of room. Seven desks and thirty notices is more
// than any pane in SIZES can print, which is the point: every size below is a card that
// has to stop somewhere.
const crowdedFloor = () => {
  const list = officeRoster(new Array(7).fill('idle')).people;
  list.forEach((p, i) =>
    Object.assign(p, {
      statusMs: 1_800_000 + i * 600_000,
      dirt: { files: 7 },
      branch: 'a-manager-who-notices',
      repo: 'herdr-office',
      title: `job number ${i}`,
      said: `the thing I am stuck on number ${i}`,
    }),
  );
  return list;
};
const MANY = new Array(30).fill(0).map((_, i) => ({ kind: 'stalled', ids: [`w1:p${(i % 7) + 1}`], text: `Desk ${i} stopped 20m00s ago with 4 files uncommitted` }));
// The rows the card itself drew, ignoring the carpet under it, so "the last thing the
// office said" is a question that can be asked of a panel shorter than its room.
const drawnRows = (lines) => lines.filter((l) => /[│├╰╭]/.test(l));

test('one notice about three desks is three accounts on the card', () => {
  // The complaint, as an assertion. One sentence on the footer, three accounts here, each
  // with the clock, the news and the words belonging to the desk it is under.
  const lines = bigCard([STUCK]);
  const at = (name) => lines.findIndex((l) => l.includes(`${name} · `));
  for (const name of ['Ada', 'Bo', 'Cass']) assert.ok(at(name) > 0, `${name} is stuck and is not on the card`);

  const block = (name) => lines.slice(at(name), at(name) + 4).join('\n');
  // Its own clock, which the grouped notice drops because four desks in one checkout have
  // four of them and one sentence.
  // `at least`, because the fixture roster has only just laid eyes on these desks and an
  // assumed duration is a lower bound. A stall is allowed to be late and is not allowed to
  // be wrong, which is the same reasoning as the `~` under a tile.
  assert.match(block('Ada'), /stopped at least 30m00s ago/);
  assert.match(block('Bo'), /stopped at least 40m00s ago/);
  assert.match(block('Cass'), /stopped at least 50m00s ago/);
  // Its own last words, rather than the one quote the notice had room to carry.
  assert.match(block('Ada'), /said "I cannot apply the patch/);
  assert.match(block('Bo'), /said "Should I delete the old migration\?"/);
  // Its own news, from before the twelve seconds a slab lasts: this is the fact the roster
  // now keeps an event past its expiry for, and it is most of the answer on a stalled desk.
  assert.match(block('Ada'), /tests failed 24m20s ago/);
  assert.match(block('Bo'), /merge conflict 5m20s ago/);
  // And what is only true of one of them.
  assert.match(block('Bo'), /3 conflicted/);
  assert.match(block('Cass'), /94% full/);
  assert.doesNotMatch(block('Ada'), /conflicted/);
  // Under one name only. Ada's words appearing under Bo would be the office attributing
  // somebody else's sentence, which is worse than saying nothing. Not asserted as "once in
  // the frame": the footer is entitled to the same quote, because the notice carries it as
  // the one reason it has room for, and it names Ada when it does.
  for (const name of ['Bo', 'Cass']) assert.doesNotMatch(block(name), /I cannot apply the patch/, `Ada's words are under ${name}`);
});

test('an account is a hanging indent under one name', () => {
  // Four rows that read as one desk. Run on against the border they read as four separate
  // things the office noticed, which is the shape this card was built to stop being.
  const lines = bigCard([STUCK]);
  const at = lines.findIndex((l) => l.includes('Ada · '));
  const name = lines[at].indexOf('Ada');
  // Asserted against the name's own column rather than a count of spaces, so widening the
  // margin cannot knock the two out of line without anybody noticing.
  assert.ok(lines[at + 1].indexOf('was doing') > name, `the account is not indented under the name: "${lines[at + 1]}"`);
  assert.equal(lines[at + 2].indexOf('said "'), lines[at + 1].indexOf('was doing'), 'the account does not line up with itself');
  // And the row after the account is the next desk, back at the name column.
  assert.equal(lines[at + 3].indexOf('Bo'), name, `"${lines[at + 3]}" is not the next name`);
});

test('a desk in two notices is one account that says both', () => {
  // The office's commonest pair. Two blocks about one person, repeating the same four facts
  // under two headlines, would be the notice list's redundancy back in a new shape.
  const people = stuckFloor();
  const lines = bigCard([{ kind: 'collision', ids: ['w1:p1', 'w1:p2'], text: 'Ada and Bo are both in herdr-office' }, { kind: 'full', ids: ['w1:p1'], text: 'Ada is 94% full and still working' }], people);
  assert.equal(lines.filter((l) => l.includes('Ada · ')).length, 1, 'Ada is on the card twice');
  const block = lines.slice(lines.findIndex((l) => l.includes('Ada · ')), lines.findIndex((l) => l.includes('Bo · '))).join('\n');
  // The more urgent notice is the headline and the other joins the account, where it wraps
  // with everything else rather than running off the end of the name row.
  assert.match(block, /Ada · sharing herdr-office with Bo/);
  assert.match(block, /full and still working/);
});

test('the card gives up the hint before it gives up a desk', () => {
  // What a short pane spends its rows on, which is a decision and not an accident. The line
  // that says what `m` does names a key that is in the README, on the footer, and that you
  // pressed to get here. The accounts are what somebody opened this card to read, so they
  // outrank it, and the rule that used to hold two rows back for the hint is gone.
  const many = new Array(30).fill(0).map((_, i) => ({ kind: 'stalled', ids: [`w1:p${(i % 7) + 1}`], text: `Desk ${i} stopped 20m00s ago with 4 files uncommitted` }));
  for (const [cols, rows] of SIZES) {
    const crowded = bigCard(many, stuckFloor(), cols, rows).join('\n');
    const quiet = bigCard([], stuckFloor(), cols, rows).join('\n');
    // A pane so short that even the quiet card cannot finish is out of scope: at twenty by
    // eight the panel gets three rows and the figure alone is four, so there is no version
    // of this card that fits and nothing for a priority rule to get right.
    if (!quiet.includes('the floor is quiet')) continue;
    // The most urgent desk is always there, and its name is the handle.
    assert.match(crowded, /Ada/, `${cols}x${rows}: the first desk is missing`);
    // A heading with nothing under it is worse than no heading, so the pair goes together.
    assert.equal(crowded.includes('what to do about it'), crowded.includes('m walks to the desk'), `${cols}x${rows}: half the hint`);
    // Geometry is not re-asserted here: the sweep above already draws every size with a
    // long list, and this test is about what survives the clip rather than the shape.
  }
});

test('a clipped card says how many desks it did not get to', () => {
  // Clipping in silence is the failure that matters: a card showing two desks out of five
  // reads as an office where three people are fine.
  const many = new Array(6).fill(0).map((_, i) => ({ kind: 'stalled', ids: [`w1:p${i + 1}`], text: `Desk ${i} stopped 20m00s ago with 4 files uncommitted` }));
  const lines = bigCard(many, officeRoster(new Array(7).fill('idle')).people, 100, 26);
  const named = ['Ada', 'Bo', 'Cass', 'Dev', 'Ede', 'Fen'].filter((n) => lines.some((l) => l.includes(`${n} · `)));
  assert.ok(named.length < 6, 'nothing was clipped, so there is nothing to say about clipping');
  assert.ok(named.includes('Ada'), 'the most urgent desk was the one dropped');
  assert.ok(lines.some((l) => l.includes(`and ${6 - named.length} more desk`)), `clipped ${6 - named.length} desks in silence`);
});

test('the card closes at every size it can be drawn at', () => {
  // The closing border is the one row the panel holds back, and both ways of getting the
  // arithmetic wrong spend a row past it: a hint drawn one row too eagerly, or a planner
  // that lets one more name row through. Either way the border falls off the bottom and
  // the last thing on screen is half a sentence, which reads as the pane having cut the
  // office off mid-thought rather than as the office having run out of room.
  for (const [cols, rows] of SIZES) {
    const quiet = bigCard([], crowdedFloor(), cols, rows);
    // A pane too short for even the quiet card is out of scope, the same exclusion the test
    // below makes: at twenty by eight the figure alone is taller than the panel, so there is
    // no version of this card that fits.
    if (!quiet.some((l) => l.includes('the floor is quiet'))) continue;
    for (const [label, lines] of [['quiet', quiet], ['crowded', bigCard(MANY, crowdedFloor(), cols, rows)]]) {
      const drawn = drawnRows(lines);
      assert.match(drawn[drawn.length - 1] || '', /╰─+╯/, `${cols}x${rows} ${label}: the card does not close`);
    }
  }
});

test('a card with room for the heading has room for a desk under it', () => {
  // The other half of giving up the hint first. A card that draws `what happened at each
  // desk` and then `and 30 more desks` has answered nothing, and that is what holding two
  // rows back for the hint did to a short pane: at seventy by fourteen it printed the
  // heading, the count, and not one desk.
  for (const [cols, rows] of SIZES) {
    const lines = bigCard(MANY, crowdedFloor(), cols, rows);
    if (!lines.some((l) => l.includes('what happened at each desk'))) continue;
    assert.ok(lines.some((l) => / · stopped/.test(l)), `${cols}x${rows}: a heading and not one desk under it`);
  }
});

test('the desk cannot push a cell over, at any size, in any state', () => {
  // The grid invariant the whole suite is built on. A tile one cell wide or one row
  // tall corrupts a terminal the reader did not open, and the manager is a new tile
  // with its own art, its own card and its own status bar.
  const states = [
    [],
    [COLLISION],
    ALL,
    [said('collision', `Ada, Bo and 9 more are all in ${'x'.repeat(90)}`)],
    // With a reason, which is a second sentence on a line that was already near the width
    // of the status bar, and a second row inside the card.
    [WHY],
    [{ ...WHY, why: `said "${'y'.repeat(120)}"` }, ...ALL],
  ];
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list']) {
      for (const frame of FRAMES) {
        for (const notices of states) {
          for (const selectedId of [undefined, MANAGER_ID]) {
            const { lines } = renderFrame(viewOf({ people, cols, rows, zoom, frame, notices, selectedId }));
            const where = `${cols}x${rows} ${zoom} frame ${frame} n=${notices.length}`;
            assert.equal(lines.length, rows, `${where}: ${lines.length} lines`);
            lines.forEach((line, i) => assert.equal(width(line), cols, `${where}: line ${i} is ${width(line)} cells`));
          }
        }
      }
    }
  }
});

test('an office with nobody in it has no manager either', () => {
  // A manager reporting on an empty floor is a desk with a job that cannot exist, and
  // the empty office already has its own screen telling you how to hire somebody.
  const frame = renderFrame(viewOf({ people: [], cols: 140, rows: 46, selectedId: null, notices: [] }));
  assert.ok(!frame.hitboxes.some((b) => b.id === MANAGER_ID));
});
