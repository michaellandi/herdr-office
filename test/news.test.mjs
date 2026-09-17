// News, from a label on a desk to a slab on the screen.
//
// The decode is pinned in test/events.test.mjs and the expiry in test/roster.test.mjs.
// What neither of them covers is the last hop: whether a label the roster is holding
// ever becomes cells. That hop was the one place this feature could still have been
// broken after the wire was fixed, and checking it turned up two rules that were real
// decisions in the renderer and written down nowhere.
//
// Both are about news losing. It is the least important thing a desk can be saying, so
// it gives way to a raised hand and it gives way to a pane with no room, and either one
// looks exactly like the feature not working if you do not know the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeRoster, viewOf, stripAnsi } from './fixtures.mjs';
import { renderFrame } from '../src/render.mjs';

const LABEL = 'tests failed';

// The frame as one string, with a label hung over exactly one desk.
function frameWith(index, { cols, rows }, label = LABEL) {
  const people = officeRoster().people;
  for (const p of people) p.event = null;
  if (index !== null) people[index].event = { label, kind: 'broke' };
  const { lines } = renderFrame(viewOf({ people, cols, rows, selectedId: null }));
  return { text: lines.map(stripAnsi).join('\n'), people };
}

// Wide enough for desks, and wide enough for the compact list. Both draw news, in
// different places, which is why both are here.
const FLOOR = { cols: 120, rows: 40 };
const LIST = { cols: 60, rows: 20 };

test('a label on a desk becomes a slab on the screen', () => {
  // The whole feature, end to end from the roster's point of view. This is the
  // assertion that would have failed for the entire life of the feature while every
  // other test in the suite passed, had the label ever got as far as the roster.
  for (const size of [FLOOR, LIST]) {
    const { text, people } = frameWith(1, size);
    assert.equal(people[1].status, 'working', 'this test needs a desk with no hand up');
    assert.ok(text.includes(LABEL), `${size.cols}x${size.rows}: the label never reached the frame`);
  }
});

// Which desks are actually on this floor. Seven desks do not fit on one screen, and a
// desk on page two draws nothing at all: a test that did not check this would report
// "no news on that desk" for a desk that is not there, and pass or fail for reasons
// that have nothing to do with news. Found the hard way, on Gus.
function drawn(text, people) {
  return people.map((p, i) => [i, p]).filter(([, p]) => text.includes(p.name));
}

test('news reaches every desk that is not waiting on you', () => {
  const { text, people } = frameWith(null, FLOOR);
  const quiet = drawn(text, people).filter(([, p]) => p.status !== 'blocked');
  assert.ok(quiet.length >= 3, 'the fixture floor has stopped having quiet desks on screen');
  for (const [i, p] of quiet) {
    assert.ok(frameWith(i, FLOOR).text.includes(LABEL), `a ${p.status} desk did not show its news`);
  }
});

test('a raised hand outranks whatever just happened', () => {
  // The rule, and the reason the feature can look dead on a live floor: a desk that is
  // waiting on you says so instead, because what it needs from you matters more than
  // what its test run did. Every blocked desk in the fixture, so this is not one
  // desk's accident.
  //
  // The renderer guards this twice over, which is worth knowing before trusting this
  // test: no slab is built while there is a bubble, and the row that draws them prefers
  // the bubble anyway. Breaking either one on its own changes nothing on screen. What
  // this catches is both of them going at once, which is what a rewrite of that row
  // would do.
  const bare = frameWith(null, FLOOR);
  const waiting = drawn(bare.text, bare.people).filter(([, p]) => p.status === 'blocked');
  assert.ok(waiting.length >= 2, 'the fixture floor has stopped having blocked desks on screen');
  for (const [i] of waiting) {
    const { text, people: floor } = frameWith(i, FLOOR);
    assert.ok(!text.includes(LABEL), 'news covered a raised hand');
    // And it is not simply that nothing is drawn there: the ask took the row. Only
    // the start of it, because a bubble is narrower than most questions and one desk
    // in the fixture has no ask at all and falls back to saying so.
    const asked = (floor[i].ask || 'needs your OK').slice(0, 12);
    assert.ok(text.includes(asked), `the ask did not take the row either: ${JSON.stringify(asked)}`);
  }
});

test('the compact list carries news where the command goes', () => {
  // Not a slab: in the list a desk has one line, so the news takes the column the
  // command was in. Asserted on the row rather than the frame, or a label appearing
  // anywhere at all would pass.
  const { text, people } = frameWith(1, LIST);
  const row = text.split('\n').find((l) => l.includes(people[1].name));
  assert.ok(row, 'the desk is not in the list');
  assert.ok(row.includes(LABEL), `news is not on the desk's own row: ${JSON.stringify(row)}`);
  // The command it displaced is a fixture title, so its absence is the displacement.
  assert.ok(!row.includes(people[1].title), 'both the command and the news are on the row');
});

test('a pane with no room for a command has no room for news', () => {
  // 40 columns drops the whole right-hand column from the list, and the news goes with
  // it. Worth a test because it is indistinguishable from the feature being broken,
  // and because the alternative (crowding out the name, or the status) is worse: at
  // this size the only thing on the row is who and how they are.
  const narrow = frameWith(1, { cols: 40, rows: 16 });
  assert.ok(!narrow.text.includes(LABEL), 'news found room where the command could not');
  assert.ok(narrow.text.includes(narrow.people[1].name), 'the name still has to be there');
  assert.ok(!narrow.text.includes(narrow.people[1].title), 'the command is gone too, which is the point');
});

test('an empty label hangs nothing', () => {
  // setEvent refuses an empty label, but the renderer is reached by more than
  // setEvent, and a blank slab is a hole in a desk rather than a quiet desk.
  const { text } = frameWith(1, FLOOR, '');
  const plain = frameWith(null, FLOOR).text;
  assert.equal(text, plain, 'an empty label changed the frame');
});
