// Escalation. The thing under test is not really the arithmetic, it is the
// restraint: a tool that nags gets muted, and a muted tool never tells you the one
// thing you needed to hear. So most of these assert that nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalate, nextThreshold, LADDER } from '../src/escalate.mjs';

const person = (over = {}) => ({
  id: 'w1:p1',
  name: 'Ada',
  kind: 'claude',
  status: 'blocked',
  statusMs: 0,
  assumedSince: false,
  ...over,
});

test('a hand has to be up a while before anything is said twice', () => {
  // The first toast is somebody else's job (it goes out the moment the status
  // changes); this is only about saying it again.
  assert.equal(escalate({ people: [person({ statusMs: 5000 })] }).toast, null);
  assert.equal(escalate({ people: [person({ statusMs: LADDER[0] - 1 })] }).toast, null);
  const { toast, state } = escalate({ people: [person({ statusMs: LADDER[0] })] });
  assert.ok(toast, 'a minute of silence should get one nudge');
  assert.match(toast.title, /^Ada is still waiting$/);
  assert.deepEqual(state, { id: 'w1:p1', stage: 1 });
});

test('it backs off instead of repeating', () => {
  // The same nudge every two seconds is what makes people turn notifications off,
  // so each one buys a longer silence than the last.
  let state = null;
  const fired = [];
  // Walk a hand being up for two hours, in the two-second steps the office polls at.
  for (let ms = 0; ms <= 7200000; ms += 2000) {
    const out = escalate({ people: [person({ statusMs: ms })], state });
    state = out.state;
    if (out.toast) fired.push(ms);
  }
  assert.deepEqual(fired.slice(0, 3), LADDER, 'the first three are the ladder itself');
  // Past the ladder it settles into a steady interval rather than accelerating or
  // stopping: fifteen minutes apart, forever.
  const gaps = fired.slice(1).map((ms, i) => ms - fired[i]);
  assert.deepEqual(gaps.slice(2), new Array(gaps.length - 2).fill(900000));
  // Ten toasts for two hours of being ignored: a minute, five, fifteen, then a
  // quarter-hour apart for as long as the hand stays up. It does not give up,
  // because the hand is not going down on its own, but it never gets faster either.
  assert.equal(fired.length, 10, `two hours of being ignored is ${fired.length} toasts`);
});

test('nothing is said while you are looking at the floor', () => {
  // A toast about a raised hand that is drawn on your screen right now is noise.
  const people = [person({ statusMs: 3600000 })];
  const out = escalate({ people, watching: true });
  assert.equal(out.toast, null);
  // And the rung is not spent: looking away is exactly when the nudge becomes
  // useful again, so it goes out then rather than on the next fifteen-minute mark.
  assert.deepEqual(out.state, { id: 'w1:p1', stage: 0 });
  assert.ok(escalate({ people, state: out.state }).toast, 'looking away should nudge');
});

test('one toast, however many hands are up', () => {
  // Six stuck agents used to mean six notifications, which is a pager, not an
  // office. The longest wait is the headline and the rest are a count.
  const crowd = [
    person({ id: 'w1:p1', name: 'Ada', statusMs: 400000 }),
    person({ id: 'w1:p2', name: 'Bo', statusMs: 900000 }),
    person({ id: 'w1:p3', name: 'Cass', statusMs: 61000 }),
  ];
  const { toast, state } = escalate({ people: crowd });
  assert.match(toast.title, /^Bo /, 'the longest wait is the one worth naming');
  assert.match(toast.body, /15m00s and 2 others waiting/);
  assert.equal(state.id, 'w1:p2');
  // One waiting says who and where instead, because there is room for it.
  assert.match(escalate({ people: [person({ statusMs: 61000 })] }).toast.body, /1m01s with a hand up, claude in w1:p1/);
  // And the plural is not "1 others".
  const two = escalate({ people: crowd.slice(0, 2) }).toast;
  assert.match(two.body, /and 1 other waiting/);
});

test('the stage belongs to a person, not to the office', () => {
  // Ada being answered must not leave Bo inheriting her fifteen-minute silence.
  const state = { id: 'w1:p1', stage: 3 };
  const { toast } = escalate({ people: [person({ id: 'w1:p2', name: 'Bo', statusMs: LADDER[0] })], state });
  assert.ok(toast, 'a different person starts at the bottom of the ladder');
  assert.match(toast.title, /^Bo /);
  // An empty floor forgets everything, so the next hand up is news again.
  assert.deepEqual(escalate({ people: [], state }), { toast: null, state: null });
  assert.deepEqual(escalate({ people: [person({ status: 'working', statusMs: 99999999 })], state }), { toast: null, state: null });
});

test('an agent that was already stuck when the office opened is left alone', () => {
  // The roster only knows when a state was entered if it saw it happen, so this
  // duration is a floor, not a fact, and a nudge quoting it would be a lie. It
  // becomes real the moment they change state.
  const stale = person({ statusMs: 7200000, assumedSince: true });
  assert.deepEqual(escalate({ people: [stale] }), { toast: null, state: null });
  // But a real one standing next to it is still nudged about, and the assumed one
  // is not even counted among the others.
  const { toast } = escalate({ people: [stale, person({ id: 'w1:p2', name: 'Bo', statusMs: 61000 })] });
  assert.match(toast.title, /^Bo /);
  assert.match(toast.body, /with a hand up/);
});

test('nonsense state cannot break the ladder', () => {
  assert.equal(nextThreshold(-5), LADDER[0]);
  assert.equal(nextThreshold(0.7), LADDER[0]);
  assert.equal(nextThreshold(LADDER.length), 1800000);
  const people = [person({ statusMs: 999999 })];
  assert.ok(escalate({ people, state: { id: 'w1:p1', stage: NaN } }).toast);
  assert.ok(escalate({ people, state: { id: 'w1:p1' } }).toast);
  assert.deepEqual(escalate(), { toast: null, state: null });
});
