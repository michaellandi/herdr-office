// The punch clock. These numbers get written on a whiteboard for somebody to draw
// a conclusion from, so the two properties worth pinning down are that they are
// exact (not "roughly, if the poll was on time") and that they never go backwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clocks } from '../src/punchclock.mjs';

const desk = (id, status, since) => ({ id, status, since });

test('time is accounted off the status changes, not off the polls', () => {
  // The whole reason the intervals are closed with herdr's own timestamps: a slow
  // refresh, a fast one, or ten in a row must all produce the same answer.
  let now = 1000;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'working', 1000)], now);
  now = 61000;
  // A minute of work, and the change happened five seconds before we noticed it.
  c.observe([desk('p1', 'idle', 56000)], now);
  const out = c.desk('p1', now);
  assert.equal(out.worked, 55000, 'worked from 1000 to 56000');
  assert.equal(out.spent.idle, 5000, 'idle since, counted up to now');
  assert.equal(out.onShift, 60000);
  // Observing again with nothing new changes nothing at all.
  const before = JSON.stringify(c.desk('p1', now));
  c.observe([desk('p1', 'idle', 56000)], now);
  c.observe([desk('p1', 'idle', 56000)], now);
  assert.equal(JSON.stringify(c.desk('p1', now)), before);
  // And reading the numbers does not bank them: the open interval keeps growing
  // rather than being counted twice.
  now = 71000;
  assert.equal(c.desk('p1', now).spent.idle, 15000);
});

test('hands are counted as they go up', () => {
  let now = 0;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'working', 0)], now);
  assert.equal(c.desk('p1', now).hands, 0);
  now = 10000;
  c.observe([desk('p1', 'blocked', 5000)], now);
  assert.equal(c.desk('p1', now).hands, 1);
  // Still up is not a new hand, however many times it is observed.
  c.observe([desk('p1', 'blocked', 5000)], now);
  assert.equal(c.desk('p1', now).hands, 1);
  // A fresh prompt at the same desk is a fresh hand: `since` moved, which is the
  // only signal there is that the last one was answered and another arrived.
  now = 20000;
  c.observe([desk('p1', 'blocked', 15000)], now);
  assert.equal(c.desk('p1', now).hands, 2);
  now = 30000;
  c.observe([desk('p1', 'working', 25000)], now);
  now = 40000;
  c.observe([desk('p1', 'blocked', 35000)], now);
  assert.equal(c.desk('p1', now).hands, 3);
  assert.equal(c.office(now).hands, 3);
});

test('a hand already up when the office opened is still a hand', () => {
  // Otherwise the count disagrees with the floor: there is a hand up in front of
  // you and the whiteboard says nobody has needed anything.
  const c = new Clocks(() => 5000);
  c.observe([desk('p1', 'blocked', 1000)]);
  assert.equal(c.desk('p1').hands, 1);
  // On shift only from when the office met it. Claiming the four seconds before it
  // opened would be inventing time nobody watched.
  assert.equal(c.desk('p1').onShift, 4000);
});

test('the longest wait includes one that is still going', () => {
  let now = 0;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'blocked', 0)], now);
  now = 30000;
  c.observe([desk('p1', 'working', 20000)], now);
  assert.equal(c.desk('p1', now).longest, 20000);
  // A wait in progress counts, because the answer to "what is the worst it has been"
  // must not be smaller than what is on the screen right now.
  now = 100000;
  c.observe([desk('p1', 'blocked', 40000)], now);
  assert.equal(c.desk('p1', now).longest, 60000);
  assert.equal(c.office(now).longest, 60000);
});

test('a desk closing does not un-spend its time', () => {
  // A total that dropped when somebody tidied up a tab would read as a bug in the
  // office rather than as a closed tab.
  let now = 0;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'working', 0), desk('p2', 'working', 0)], now);
  now = 60000;
  c.observe([desk('p1', 'working', 0), desk('p2', 'working', 0)], now);
  const total = c.office(now).worked;
  assert.equal(total, 120000);
  // p2 goes away. Its open interval is closed at now, which is the last moment the
  // office can honestly say it was there.
  c.observe([desk('p1', 'working', 0)], now);
  const after = c.office(now);
  assert.equal(after.worked, total);
  assert.equal(after.desks, 1);
  assert.equal(after.closed, 1);
  assert.equal(c.desk('p2', now), null, 'a closed desk has no card');
  // And it keeps growing for the one that is still there.
  now = 120000;
  assert.equal(c.office(now).worked, 180000);
});

test('answers are the ones the office actually sent', () => {
  // The only number here that is about you rather than about the agents, so it is
  // counted by the code that sends the keys and by nothing else. A prompt that
  // resolved because somebody walked over to the pane is not an answer from here.
  const c = new Clocks(() => 0);
  c.observe([desk('p1', 'blocked', 0)]);
  assert.equal(c.office().answers, 0);
  c.answer();
  c.answer();
  assert.equal(c.office().answers, 2);
  assert.equal(c.office().hands, 1, 'answering is not the same event as asking');
});

test('nonsense cannot bend the clock', () => {
  let now = 1000;
  const c = new Clocks(() => now);
  c.observe(null, now);
  c.observe([null, undefined, {}, { id: '' }], now);
  assert.equal(c.office(now).desks, 0);
  // An unrecognised status is bucketed as unsure rather than dropped, so the sum of
  // the buckets is still all of the time.
  c.observe([desk('p1', 'nonsense-status', 1000)], now);
  now = 2000;
  assert.equal(c.desk('p1', now).spent.unknown, 1000);
  // A server clock that stepped backwards must not hand out negative time.
  c.observe([desk('p1', 'working', 500)], now);
  const out = c.desk('p1', now);
  for (const key of Object.keys(out.spent)) assert.ok(out.spent[key] >= 0, key);
  assert.ok(out.onShift >= 0);
  // A desk with no `since` at all is treated as starting now, not in 1970.
  c.observe([{ id: 'p2', status: 'working' }], now);
  assert.equal(c.desk('p2', now).onShift, 0);
});

/* ------------------------------------------------------------- across restarts */

test('a restart continues the morning instead of starting a new one', () => {
  // The reason persistence exists. The whiteboard is the only part of the office that
  // says what happened rather than what is happening, and reopening the pane at 11:20
  // used to reset it to "open since 11:20 · worked 0s".
  let now = 9 * 3600e3;
  const first = new Clocks(() => now);
  first.observe([desk('p1', 'working', now)], now);
  now += 600e3;
  first.observe([desk('p1', 'blocked', now)], now);
  first.answer();
  now += 120e3;
  const saved = first.snapshot(now);

  // Quit, five minutes go by, reopen. The same desk is still there, still blocked
  // since the same moment.
  now += 300e3;
  const second = new Clocks(() => now);
  second.restore(saved, now);
  second.observe([desk('p1', 'blocked', 9 * 3600e3 + 600e3)], now);
  const out = second.office(now);
  // Seventeen minutes, not the twelve the office was actually watching. `open` is
  // wall clock from when the day started, which is what "open since 09:00" claims and
  // all it claims; the buckets below are the part that is only ever watched time.
  assert.equal(out.open, 17 * 60e3, 'open since 09:00, not since the reopen');
  assert.equal(out.worked, 600e3, 'the ten minutes of work survived');
  assert.equal(out.waiting, 120e3, 'and so did the two minutes of waiting');
  assert.equal(out.hands, 1);
  assert.equal(out.answers, 1);
  assert.equal(out.desks, 1, 'the desk is on the floor');
  assert.equal(out.closed, 0, 'and is not also counted as having been and gone');
});

test('the five minutes the office was shut belong to nobody', () => {
  // The one thing a naive restore gets wrong. The desk's `since` predates the
  // restart, so closing its first interval off that timestamp would credit it with
  // the gap AND with the time already banked before the save.
  let now = 0;
  const first = new Clocks(() => now);
  first.observe([desk('p1', 'working', 0)], now);
  now = 600e3;
  const saved = first.snapshot(now);
  assert.equal(saved.closed.spent.working, 600e3);

  now = 900e3; // five minutes shut
  const second = new Clocks(() => now);
  second.restore(saved, now);
  second.observe([desk('p1', 'working', 0)], now);
  now = 960e3; // one more minute watched
  second.observe([desk('p1', 'idle', now)], now);
  const out = second.office(now);
  assert.equal(out.worked, 660e3, 'ten minutes banked plus one watched, and not the gap');
  const total = Object.values(out.spent).reduce((a, b) => a + b, 0);
  assert.ok(total <= out.open, `${total}ms accounted for cannot exceed the ${out.open}ms session`);
});

test('a desk that does not come back keeps its time anyway', () => {
  // Everything is folded into the closed totals on the way out, because a pane id
  // means nothing after a restart. The work happened whether or not the pane did.
  let now = 0;
  const first = new Clocks(() => now);
  first.observe([desk('p1', 'working', 0), desk('p2', 'blocked', 0)], now);
  now = 300e3;
  const second = new Clocks(() => now);
  second.restore(first.snapshot(now), now);
  second.observe([], now);
  const out = second.office(now);
  assert.equal(out.worked, 300e3);
  assert.equal(out.waiting, 300e3);
  assert.equal(out.hands, 1);
  assert.equal(out.desks, 0);
});

test('reading the snapshot does not spend anything', () => {
  // It runs on a timer while the office is open, so it has to be as safe to call as
  // `office` is: banking the open interval would double it on the next tick.
  let now = 0;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'working', 0)], now);
  now = 60e3;
  const once = c.snapshot(now);
  for (let i = 0; i < 5; i += 1) c.snapshot(now);
  assert.deepEqual(c.snapshot(now), once);
  assert.equal(c.office(now).worked, 60e3);
});

test('a snapshot survives the trip through JSON', () => {
  // It goes to disk and comes back, so anything that is a Map, a Set or an undefined
  // in here is a number that quietly becomes zero on the next open.
  let now = 1000;
  const c = new Clocks(() => now);
  c.observe([desk('p1', 'working', 1000), desk('p2', 'blocked', 1000)], now);
  now = 61000;
  const saved = c.snapshot(now);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
});

test('a mangled snapshot loses a field, not the morning', () => {
  const base = () => new Clocks(() => 5000);
  assert.equal(base().restore(null, 5000), false);
  assert.equal(base().restore('nope', 5000), false);
  assert.equal(base().restore(42, 5000), false);

  // Missing everything but `opened`, which is the field a person actually reads.
  const partial = base();
  partial.restore({ opened: 1000 }, 5000);
  assert.equal(partial.office(5000).open, 4000);
  assert.equal(partial.office(5000).worked, 0);

  // Negative, NaN, string and object numbers are all dropped rather than added.
  const junk = base();
  junk.restore(
    {
      opened: 'yesterday',
      answers: -5,
      closed: { spent: { working: 'lots', blocked: NaN, idle: -1 }, hands: {}, longest: undefined, desks: Infinity },
    },
    5000,
  );
  const out = junk.office(5000);
  assert.equal(out.open, 0, 'an unreadable `opened` leaves the office opening now');
  assert.equal(out.answers, 0);
  assert.equal(out.worked, 0);
  assert.equal(out.hands, 0);
  assert.equal(out.longest, 0);
  assert.equal(out.closed, 0);
});

test('a stored open time in the future is ignored', () => {
  // A clock that moved between runs, or a state file copied off another machine.
  // "open since" is rendered as a duration, and a negative one reads as a bug.
  const c = new Clocks(() => 1000);
  c.restore({ opened: 999999 }, 1000);
  assert.ok(c.office(1000).open >= 0);
  assert.equal(c.office(1000).open, 0);
});

test('a hand already up at the reopen is not a second hand', () => {
  // The defect this rule was written for. Every blocked desk on the floor is a desk
  // the reopened office has never met, so it counted each one as a fresh hand and the
  // whiteboard said `hands 2` about one prompt nobody had answered yet.
  let now = 0;
  const first = new Clocks(() => now);
  first.observe([desk('p1', 'blocked', 0)], now);
  assert.equal(first.office(now).hands, 1);
  now = 60e3;
  const saved = first.snapshot(now);

  now = 90e3;
  const second = new Clocks(() => now);
  second.restore(saved, now);
  // Same prompt, same `since`, still waiting.
  second.observe([desk('p1', 'blocked', 0)], now);
  assert.equal(second.office(now).hands, 1, 'the same prompt is the same hand');

  // A prompt raised after the reopen is genuinely new and does count, which is the
  // half of this that a blanket "never count the first hand" would have got wrong.
  now = 120e3;
  second.observe([desk('p1', 'working', 100e3)], now);
  second.observe([desk('p2', 'blocked', 110e3)], now);
  assert.equal(second.office(now).hands, 2);
});
