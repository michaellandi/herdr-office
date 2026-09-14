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
