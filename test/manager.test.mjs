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
import { STATUS, fg } from '../src/theme.mjs';

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

/* ------------------------------------------ the card when somebody is hired */

// A manager that has been hired and has said something. Two sentences, because one is
// what the office asked for and three is what it will sometimes get, and the card has to
// do something sensible with either.
const SAID = [
  'Ada and Bo are both stopped in herdr-office and Ada has a hand up, so Ada is the one to look at first.',
  'Nobody else is waiting on anything.',
];
const hired = (extra = {}) => ({ hired: true, name: 'claude', asking: false, answer: SAID, question: '', ageMs: 42_000, error: null, ...extra });
const hiredCard = (chief, notices = MANY, cols = 140, rows = 46) => paintedCard(chief, notices, cols, rows).map(stripAnsi);
// The same card with its colours still on it, for the two tests that are about a colour.
const paintedCard = (chief, notices = MANY, cols = 140, rows = 46) =>
  renderFrame(viewOf({ people: crowdedFloor(), cols, rows, board: true, selectedId: MANAGER_ID, notices, chief })).lines;

test('a card with nobody hired says so, and says which key hires', () => {
  // The discoverable half. A summary section that only appears once you have already
  // found the key that fills it is a feature nobody finds, so the empty state is the
  // advertisement, and it sits in the field row rather than in a section of its own
  // because an empty section is worse than no section.
  const text = hiredCard(null).join('\n');
  assert.match(text, /nobody hired/);
  assert.match(text, /M hires a manager/);
  // And no heading over nothing.
  assert.ok(!text.includes('what the manager says'), 'an empty section was drawn');
});

test('a hired manager is named on the card before it has said anything', () => {
  // The gap between pressing M and the first answer landing is twenty seconds of real
  // time. A card that looks exactly like the unhired one for that whole stretch reads as
  // a key that did not work, so the name goes up the moment the hire lands.
  const text = hiredCard(hired({ answer: null, ageMs: null })).join('\n');
  assert.match(text, /claude · nothing asked yet/);
  assert.ok(!text.includes('what the manager says'), 'a heading with no answer under it');
});

test('a manager mid-answer says it is reading, not that it is silent', () => {
  const text = hiredCard(hired({ asking: true, answer: null })).join('\n');
  assert.match(text, /claude · reading the floor now/);
});

test('a manager still shows its last answer while it reads the floor again', () => {
  // R and a both re-ask, and the twenty seconds after either one are the twenty seconds
  // somebody is most likely to be looking at the card. Blanking the old answer to say
  // `reading` would make pressing R look like it deleted something.
  const text = hiredCard(hired({ asking: true })).join('\n');
  assert.match(text, /reading the floor now/);
  assert.match(text, /Ada is the one to look at first/);
});

test('an answer says how long ago it was asked for', () => {
  // The one thing the office knows about the answer that the answer does not say. A
  // summary of a floor is worth less the older it is, and there is no other clue: the
  // text does not change when it goes stale, it just stops being true.
  assert.match(hiredCard(hired()).join('\n'), /claude · asked 42s ago/);
  assert.match(hiredCard(hired({ ageMs: 400 })).join('\n'), /claude · just asked/);
});

test('a manager that could not be reached says that instead of a summary', () => {
  // The failure has to be visible on the card, because the card is the only place the
  // manager exists. A socket that refused the prompt and a floor that is quiet look
  // identical if the error is swallowed.
  const text = hiredCard(hired({ error: 'claude did not answer in 2m00s', answer: null })).join('\n');
  assert.match(text, /did not answer/);
  assert.ok(!text.includes('what the manager says'), 'an error and a summary at once');
});

test('what the manager said is attributed to it, and is never a row among the facts', () => {
  // The rule the whole feature rests on. Every other row on this card is mechanical: a process
  // state, a git count, a quoted line. The manager's points are a model's reading of those and
  // can be wrong, so they sit under a heading that says whose they are and nothing counted is
  // drawn inside that section.
  const lines = hiredCard(hired());
  const says = lines.findIndex((l) => l.includes('what the manager says'));
  assert.ok(says >= 0, 'the manager said something and the card did not say who');
  const under = lines.slice(says + 1, lines.findIndex((l, i) => i > says && l.includes('what to do about it')));
  assert.ok(under.length, 'the heading had nothing under it');
  assert.ok(!under.some((l) => /Ada · stopped|Bo · stopped/.test(l)), 'an account was drawn inside the summary');
});

test('a bullet pays for its own marker out of the row it wraps to', () => {
  // The marker takes two cells and the row is finite, so the wrapper has to know about it. When
  // it did not, the wrap filled the whole row and the draw truncated two cells off the end of it,
  // which chops a word rather than wrapping one. It only shows at the word lengths where a packed
  // row lands within two cells of the edge, so the lengths are swept rather than picked.
  for (let len = 4; len <= 12; len += 1) {
    const word = 'w'.repeat(len);
    const card = hiredCard(hired({ answer: [new Array(60).fill(word).join(' ')] }), [], 140, 46);
    const start = card.findIndex((l) => l.includes('what the manager says'));
    const prose = card.slice(start + 1).filter((l) => l.includes(word));
    assert.ok(prose.length > 1, `word length ${len}: sixty words did not wrap`);
    for (const line of prose) {
      const inner = line.slice(line.indexOf('│') + 1, line.lastIndexOf('│'));
      for (const w of inner.trim().split(/\s+/)) {
        assert.ok(w === '-' || w === word, `word length ${len}: "${w}" was chopped rather than wrapped`);
      }
    }
  }
});

test('nothing the card draws is a glyph whose width depends on the terminal', () => {
  // The rule test/sprites.test.mjs holds over the art, held here over the one glyph on this card
  // that was a choice rather than a table. A real bullet reads better than a hyphen and is one
  // cell in some terminals and two in others, which is unfixable once it is on the grid.
  for (const chief of [null, hired(), hired({ question: 'who is waiting?' })]) {
    for (const line of hiredCard(chief, MANY)) {
      for (const ch of line) {
        const cp = ch.codePointAt(0);
        const safe = cp < 0x2600 && !(cp >= 0x25a0 && cp <= 0x25ff);
        assert.ok(safe, `the card drew U+${cp.toString(16).toUpperCase()} (${ch})`);
      }
    }
  }
});

test('a summary replaces the accounts rather than sitting on top of them', () => {
  // The complaint this answers: a card that summarised the floor and then printed the whole
  // floor underneath is the wall of true sentences the summary exists to replace, with the
  // replacement stapled to the front of it. One keystroke away instead, which the hint names.
  const summarised = hiredCard(hired());
  assert.ok(!summarised.some((l) => l.includes('what happened at each desk')), 'the accounts are still under the summary');
  assert.ok(summarised.some((l) => l.includes('m walks to the desk')), 'and nothing says how to reach them');
});

test('the accounts are what a card with no summary on it draws instead', () => {
  // The other half, and the reason the section was kept rather than deleted. With nobody hired,
  // mid-hire, after a hire that failed, and in the minute before the first answer lands, the
  // card has no summary to show and is not allowed to be empty.
  for (const [label, chief] of [
    ['nobody hired', null],
    ['mid-hire', hiring()],
    ['hire failed', { ...hired(), answer: null, error: 'could not hire a manager: NOPE' }],
    ['not answered yet', hired({ answer: null })],
  ]) {
    const lines = hiredCard(chief, [STUCK]);
    assert.ok(lines.some((l) => l.includes('what happened at each desk')), `${label}: no summary and no accounts either`);
    assert.ok(lines.some((l) => /Ada · /.test(l)), `${label}: the accounts heading had no desk under it`);
  }
});

test('each point gets one marker, and a point that had to wrap does not get two', () => {
  // What makes it a list rather than a paragraph with hyphens in it. A point too long for the
  // row hangs under its own marker, so four rows of two points read as two points.
  const long = new Array(14).fill('a clause of some length').join(', ');
  const card = hiredCard(hired({ answer: [long, 'a short second point'] }), [], 140, 46);
  const start = card.findIndex((l) => l.includes('what the manager says'));
  const prose = card.slice(start + 1).filter((l) => /a clause of some length|a short second point/.test(l));
  assert.ok(prose.length >= 3, `${prose.length} rows for a point that has to wrap plus one that does not`);
  assert.equal(prose.filter((l) => /│\s*-\s/.test(l)).length, 2, 'one marker per point, and only per point');
});

test('a question changes the heading, because the answer is no longer a summary', () => {
  const asked = hiredCard(hired({ question: 'is anybody waiting on me?' })).join('\n');
  assert.match(asked, /what the manager says about that/);
  assert.match(hiredCard(hired()).join('\n'), /what the manager says\b/);
});

test('the manager still has nothing to click once it can be asked things', () => {
  // The card grew two keys and a section of model-written text, and neither is a reason
  // for it to grow a hitbox: a click inside this panel would be a panel reaching a pane.
  const frame = renderFrame(viewOf({ people: crowdedFloor(), cols: 140, rows: 46, board: true, selectedId: MANAGER_ID, notices: MANY, chief: hired() }));
  const rows = frame.lines.length;
  assert.deepEqual(frame.hitboxes.filter((b) => b.y >= rows / 2 && b.action), []);
});

test('the hint names the keys that exist, and only those', () => {
  // M is meaningless once somebody is hired and a is a lie until somebody is, and the
  // card is the only surface either key is advertised on.
  //
  // One notice rather than thirty, because the hint is chrome and gives its row up to the
  // accounts first: at this size a crowded floor with a summary on it has no room for the
  // hint at all, which is the priority working rather than the wording being wrong.
  //
  // Matched on the hint row itself rather than on the whole card, because the field row above
  // also names M and an assertion against the joined frame passes while the hint says nothing.
  const hintRow = (chief) => hiredCard(chief, [STUCK]).find((l) => l.includes('m walks to the desk')) || '';
  const bare = hintRow(null);
  const full = hintRow(hired());
  assert.match(bare, /M hires a manager/);
  assert.ok(!/a asks it/.test(bare), 'the unhired card advertised asking');
  assert.match(full, /a asks it/);
  assert.match(full, /R re-asks/);
  assert.ok(!/M hires/.test(full), 'the hired card advertised hiring again');
});

test('a quiet floor with a manager still offers the question', () => {
  // The case the summary is least useful and the question is most: nothing is wrong, and
  // "what did everybody get done" is the thing you actually want to ask.
  const text = hiredCard(hired(), [], 140, 46).join('\n');
  assert.match(text, /nothing, which is the good outcome/);
  assert.match(text, /a asks it/);
});

test('a summary is drawn at every size the accounts would have been', () => {
  // The inverse of the check this replaced, which held the accounts against the summary back
  // when both were on the card. The summary is now what the card is for, so the rule is that
  // wherever an unhired card could say something about the floor, a hired one says something
  // too: a pane short enough to lose the answer and keep nothing in its place would be a card
  // that got worse for having a manager.
  for (const [cols, rows] of SIZES) {
    const bare = hiredCard(null, MANY, cols, rows);
    if (!bare.some((l) => / · stopped/.test(l))) continue;
    const full = hiredCard(hired({ answer: [SAID.join(' '), SAID.join(' ')] }), MANY, cols, rows);
    assert.ok(full.some((l) => l.includes('what the manager says')), `${cols}x${rows}: no heading`);
    // A marked row with something on it, rather than a phrase from the answer: at thirty columns
    // the text wraps to nineteen cells and no sentence from it survives as one row.
    assert.ok(full.some((l) => /│\s*-\s\S/.test(l)), `${cols}x${rows}: a heading and no answer`);
  }
});

test('the card closes at every size with an answer on it, however long', () => {
  // The same border the unhired card holds a row back for, now with a variable number of
  // rows of somebody else's prose above it. A model that replies with a paragraph is not
  // a reason for a terminal to end mid-box.
  const long = hired({ answer: [new Array(40).fill('a sentence that keeps going').join(', ')] });
  for (const [cols, rows] of SIZES) {
    if (!hiredCard(null, [], cols, rows).some((l) => l.includes('the floor is quiet'))) continue;
    for (const [label, chief] of [['answered', hired()], ['long', long], ['asking', hired({ asking: true })]]) {
      for (const notices of [[], MANY]) {
        const drawn = drawnRows(hiredCard(chief, notices, cols, rows));
        assert.match(drawn[drawn.length - 1] || '', /╰─+╯/, `${cols}x${rows} ${label} n=${notices.length}: the card does not close`);
      }
    }
  }
});

test('a point that needs a person is marked, and marked in the one colour that already means that', () => {
  // The whole of the important-things feature on the drawing side. Two rules: the mark is a
  // different glyph, so it survives a screenshot and a colourblind reader, and it is the
  // raised-hand amber, so a reader who is not reading yet looks in the right place. The office
  // already spends that colour on exactly one idea and this is the same idea.
  const card = paintedCard(hired({ answer: [
    { text: 'URGENT Ada has a hand up', urgent: true },
    { text: 'ORDINARY Bo is getting on with it', urgent: false },
  ] }), [], 140, 46);
  const hot = card.find((l) => l.includes('URGENT Ada'));
  const cold = card.find((l) => l.includes('ORDINARY Bo'));
  assert.ok(hot && cold, 'the points were not drawn at all');
  assert.match(stripAnsi(hot), /│\s+!\s\S/, 'a marked point is not marked');
  assert.match(stripAnsi(cold), /│\s+-\s\S/, 'an ordinary point lost its bullet');
  assert.ok(hot.includes(fg(STATUS.blocked.fg)), 'the mark is not in the raised-hand amber');
  assert.ok(!cold.includes(fg(STATUS.blocked.fg)), 'an ordinary point is drawn as if it were urgent');
  // And both start in the same column, so the list still reads as a list.
  const col = (l) => stripAnsi(l).indexOf('URGENT Ada') + stripAnsi(l).indexOf('ORDINARY Bo') + 1;
  assert.equal(stripAnsi(hot).indexOf('URGENT'), stripAnsi(cold).indexOf('ORDINARY'), `the mark moved the text (${col(hot)})`);
});

test('a point the office has no mark for is drawn as an ordinary point', () => {
  // An answer was a list of strings before the mark existed, and a plain string still arrives
  // from the demo roster and from any caller that has not been told the shape changed. A card is
  // not the place to find out about that, so a bare string is a point with no mark on it.
  const card = paintedCard(hired({ answer: ['PLAIN Ada is fine', { text: 'SHAPED Bo is fine' }] }), [], 140, 46);
  for (const name of ['PLAIN Ada', 'SHAPED Bo']) {
    const line = card.find((l) => l.includes(name));
    assert.ok(line, `${name} was not drawn`);
    assert.match(stripAnsi(line), /│\s+-\s\S/, name);
    assert.ok(!line.includes(fg(STATUS.blocked.fg)), `${name} was drawn urgent`);
  }
});

test('an answer too long for the room is cut and says it was cut', () => {
  // The cap is most of the panel now rather than three rows, so this is checked on a pane where
  // the room genuinely runs out. A reply that runs past it has to end in a way that reads as
  // "there is more of this" rather than as the manager having trailed off.
  const long = hiredCard(hired({ answer: new Array(6).fill(new Array(40).fill('and another clause').join(', ')) }), [], 70, 14);
  const start = long.findIndex((l) => l.includes('what the manager says'));
  const prose = long.slice(start + 1).filter((l) => l.includes('another clause'));
  assert.ok(prose.length >= 1, 'a hundred rows of answer and the card showed none of it');
  assert.ok(prose.length < long.length, `${prose.length} rows of prose in a ${long.length} row frame`);
  assert.match(prose[prose.length - 1], /…/);
  assert.match(drawnRows(long)[drawnRows(long).length - 1], /╰─+╯/, 'the prose pushed the border off');
  // And it is the top that survives the cut, not the tail. The points come back in the order
  // the manager decided says most first, and `wrapField` slices from the end by default because
  // everywhere else in the office it is packing a field somebody is still typing into. Reading
  // the last rows of a reply would put the manager's closing aside on the card and drop the
  // desk it named.
  const marked = hiredCard(hired({ answer: ['FIRST this is the thing to look at.', ...new Array(20).fill('and then some more about it'), 'LAST an aside.'] }), [], 70, 14);
  const said = marked.slice(marked.findIndex((l) => l.includes('what the manager says')) + 1).join('\n');
  assert.match(said, /FIRST/);
  assert.ok(!said.includes('LAST'), 'the card read the reply backwards');
});

test('a heading is never the last thing inside the card', () => {
  // What the row-budget check in front of the summary is for. The section costs a heading plus
  // at least one row of prose, and a card that had room for the heading alone would draw
  // `what the manager says` with the border directly under it, which reads as the manager
  // having been asked and said nothing rather than as the pane being short.
  const long = hired({ answer: [new Array(40).fill('a sentence that keeps going').join(', ')] });
  for (const [cols, rows] of SIZES) {
    for (const chief of [hired(), long]) {
      for (const notices of [[], MANY]) {
        const drawn = drawnRows(hiredCard(chief, notices, cols, rows));
        for (let i = 0; i < drawn.length; i += 1) {
          if (!drawn[i].includes('what the manager says')) continue;
          const under = drawn[i + 1] || '';
          assert.ok(!/^\s*[╰├]/.test(stripAnsi(under).trim()) && under.trim() !== '', `${cols}x${rows}: a heading with nothing under it`);
        }
      }
    }
  }
});

test('nothing a manager says can push a cell over, at any size', () => {
  // The grid invariant again, against the one string in the whole office that the office
  // did not write. Control characters, an emoji, a box drawing run that would break the
  // border, and a line with no spaces in it for a word wrapper to break on.
  const nasty = [
    ['plain', hired()],
    ['wide', hired({ answer: ['Ada \u001b[31mis\u001b[0m stuck \u{1F600} on ──── the patch'] })],
    ['unbroken', hired({ answer: ['x'.repeat(400)] })],
    ['many', hired({ answer: new Array(6).fill('a sentence about a desk') })],
    ['named', hired({ name: 'y'.repeat(80), error: 'z'.repeat(200) })],
  ];
  for (const [cols, rows] of SIZES) {
    for (const [label, chief] of nasty) {
      for (const notices of [[], MANY]) {
        const { lines } = renderFrame(viewOf({ people: crowdedFloor(), cols, rows, board: true, selectedId: MANAGER_ID, notices, chief }));
        assert.equal(lines.length, rows, `${cols}x${rows} ${label}: ${lines.length} lines`);
        lines.forEach((line, i) => assert.equal(width(line), cols, `${cols}x${rows} ${label}: line ${i} is ${width(line)} cells`));
      }
    }
  }
});

/* ------------------------------------------------- asking it something */

const asking = (extra = {}) => ({
  scope: 'chief', id: 'w1:p9', name: 'claude', text: 'is anybody waiting on me?',
  to: [{ id: 'w1:p9', name: 'claude', status: 'idle' }], ask: null, error: null,
  sending: false, confirm: false, skipped: null, ...extra,
});
const askPanel = (extra) => plain(renderFrame(viewOf({ people, cols: 140, rows: 46, compose: asking(extra) })));

test('asking the manager is a question, not an assignment', () => {
  // Same panel, same keys, and the one word that changes is the whole difference: every
  // other thing this box does sends work to an agent that will go and do it. This one
  // sends a question to an agent that has been told not to.
  const text = askPanel().join('\n');
  assert.match(text, /ask · claude/);
  assert.ok(!/assign/.test(text), 'the question box offered to assign work');
  assert.match(text, /ask about the floor/);
  assert.match(text, /the answer lands on the card/);
});

test('the keybar over a question offers to ask rather than to send', () => {
  const text = askPanel().join('\n');
  assert.match(text, /a question/);
  assert.match(text, /ask it/);
  assert.ok(!/send it/.test(text), 'the keybar offered to send a question');
});

test('a question is never broadcast and never asks who gets it', () => {
  // The confirm step exists because A can reach every desk at once. A question reaches
  // one agent by construction, so a card that asked `review who gets it` would be
  // inventing a decision.
  const text = askPanel().join('\n');
  assert.ok(!/review who gets it/.test(text));
  assert.ok(!/desks/.test(text.split('ask · claude')[1] || ''), 'a question was addressed to a floor');
});

test('the card stops promising something it cannot promise once somebody is hired', () => {
  // The claim that was true of the office and stopped being true of the system. Unhired,
  // `can do nothing` is a fact about src/manager.mjs: it takes notices and returns strings.
  // Hired, the thing writing the summary is an agent with a shell, and a card still saying
  // the manager can do nothing would be the office vouching for something it cannot see.
  const bare = hiredCard(null, [STUCK]).join('\n');
  const full = hiredCard(hired(), [STUCK]).join('\n');
  assert.match(bare, /nothing: it reads the floor and writes lines/);
  assert.match(full, /never acted on/);
  assert.ok(!/it reads the floor and writes lines/.test(full), 'the hired card kept the unhired promise');
});

/* ------------------------------------------ the card while it is hiring somebody */

// Opening this card is what hires a manager now, and a cold agent takes up to ninety seconds
// to come up. That stretch is a state the card has to be able to say out loud: the summary is
// coming, nobody is there yet, and neither of the keys that normally apply does anything.
const hiring = (extra = {}) => ({
  hired: false, hiring: true, name: null, asking: false, answer: null, question: '', ageMs: null, error: null, ...extra,
});

test('a card that is hiring says so instead of saying nobody is coming', () => {
  // The open that went and got somebody must not spend the next minute advertising the key
  // that gets somebody, which is what the unhired card exists to do.
  const text = hiredCard(hiring()).join('\n');
  assert.match(text, /hiring somebody to read this floor/);
  assert.ok(!text.includes('nobody hired'), 'the card called it empty while it was filling');
  assert.ok(!text.includes('what the manager says'), 'a heading over an answer that does not exist yet');
});

test('the keys the card offers mid-hire are the ones that would do something', () => {
  // `M` during a hire opens a picker that starts a second agent beside the one already
  // coming, and `a` has nobody to ask. The desks clause survives, because it is the only
  // thing on this card that works in every state it has.
  const hint = hiredCard(hiring(), [{ kind: 'stalled', ids: ['w1:p1'], text: 'Ada stopped' }])
    .find((l) => l.includes('m walks to the desk'));
  assert.ok(hint, 'the hint row went missing');
  assert.ok(!hint.includes('M hires'), 'offered to hire a second one');
  assert.ok(!hint.includes('a asks'), 'offered to ask nobody');
});

test('a hire that failed says so, and says what to press instead', () => {
  // The one case where the office started something without being asked and it did not work.
  // Silently going back to `nobody hired` would read as the card never having tried, and the
  // office does not try again in the same run, so the key has to be named again here.
  const text = hiredCard({ ...hiring(), hiring: false, error: 'could not hire a manager: TIMEOUT. M hires one by hand.' }).join('\n');
  assert.match(text, /could not hire a manager/);
  assert.match(text, /M hires one by hand/);
  assert.ok(!text.includes('hiring somebody'), 'still claimed to be hiring after it gave up');
});

test('the card stops promising what it cannot promise as soon as somebody is on the way', () => {
  // `nothing: it reads the floor and writes lines` is true of the office's own manager code
  // and false the moment an agent session is involved. The line has to change when the hire
  // starts, not when it lands: in between, there is already a real agent coming up.
  assert.ok(hiredCard(hiring()).join('\n').includes('its answer is read, never acted on'));
});

test('a card mid-hire closes at every size', () => {
  for (const [cols, rows] of SIZES) {
    if (cols === 20) continue; // known: the panel does not close at 20x8, hired or not
    const lines = hiredCard(hiring(), MANY, cols, rows);
    const drawn = lines.filter((l) => /[│├╰╭]/.test(l));
    assert.match(drawn[drawn.length - 1] || '', /╰─+╯/, `${cols}x${rows}`);
    for (const line of lines) assert.ok(line.length <= cols, `${cols}x${rows}: ${line.length} cells`);
  }
});
