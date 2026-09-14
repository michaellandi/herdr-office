// Shepherd mode. As with the escalation ladder, most of what is worth asserting is
// that it stays still: a mode that moves the selection when you did not ask it to is
// a mode you switch off after one afternoon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { follow } from '../src/follow.mjs';

const desk = (id, status = 'working', over = {}) => ({ id, name: id, kind: 'claude', status, ...over });

test('a hand going up brings you to it', () => {
  const before = [desk('w1:p1'), desk('w1:p2'), desk('w1:p3')];
  const first = follow({ people: before, selectedId: 'w1:p1', seen: null, active: true });
  assert.equal(first.moved, false, 'nobody is stuck yet');
  const after = [desk('w1:p1'), desk('w1:p2', 'blocked'), desk('w1:p3')];
  const out = follow({ people: after, selectedId: 'w1:p1', seen: first.seen, active: true });
  assert.equal(out.selectedId, 'w1:p2');
  assert.equal(out.moved, true);
  assert.equal(out.person.id, 'w1:p2');
});

test('it moves once, not every poll', () => {
  // The failure this prevents is the one that makes the mode useless: the same hand
  // still being up two seconds later is not a new event, so walking away from it has
  // to stick. Otherwise the mode fights you for the floor.
  const people = [desk('w1:p1'), desk('w1:p2', 'blocked')];
  const first = follow({ people, selectedId: 'w1:p1', seen: new Set(['w1:p9']), active: true });
  assert.equal(first.selectedId, 'w1:p2');
  // You walk off deliberately. It has to let you.
  let seen = first.seen;
  for (let i = 0; i < 30; i += 1) {
    const out = follow({ people, selectedId: 'w1:p1', seen, active: true });
    seen = out.seen;
    assert.equal(out.moved, false, `poll ${i} dragged the selection back`);
    assert.equal(out.selectedId, 'w1:p1');
  }
  // A second, genuinely new hand still gets you.
  const more = [...people, desk('w1:p3', 'blocked')];
  assert.equal(follow({ people: more, selectedId: 'w1:p1', seen, active: true }).selectedId, 'w1:p3');
});

test('it will not move you off somebody who needs you', () => {
  // Standing at a raised hand means you are dealing with that person. The second one
  // can wait as long as it takes to press y.
  const people = [desk('w1:p1', 'blocked'), desk('w1:p2', 'blocked')];
  const out = follow({ people, selectedId: 'w1:p1', seen: new Set(['w1:p1']), active: true });
  assert.equal(out.moved, false);
  assert.equal(out.selectedId, 'w1:p1');
  // And once you have answered them, the one that was waiting is still waiting, but
  // it is no longer new, so it does not yank you either. `b` is for that.
  const answered = [desk('w1:p1'), desk('w1:p2', 'blocked')];
  assert.equal(follow({ people: answered, selectedId: 'w1:p1', seen: out.seen, active: true }).moved, false);
});

test('a panel with the keyboard is left alone', () => {
  // Retargeting the selection under an open assign field would change who the
  // message is addressed to without saying so.
  const people = [desk('w1:p1'), desk('w1:p2', 'blocked')];
  const args = { people, selectedId: 'w1:p1', seen: new Set(), active: true };
  for (const state of [{ compose: { text: 'hi' } }, { hire: {} }, { drag: { active: true } }, { filtering: true }]) {
    const out = follow({ ...args, state });
    assert.equal(out.moved, false, JSON.stringify(state));
    assert.equal(out.selectedId, 'w1:p1');
    // The hand is remembered as seen anyway, so closing the panel is not a jolt: by
    // then it has been up a while and there is no event left to react to.
    assert.ok(out.seen.has('w1:p2'));
    assert.equal(follow({ ...args, seen: out.seen }).moved, false);
  }
  // A card being open is not a modal panel, so that one does move.
  assert.equal(follow({ ...args, state: { detail: { id: 'w1:p1' } } }).moved, true);
});

test('switching it on takes you to a hand that is already up', () => {
  // No history means everything is news, which is what you wanted when you pressed
  // the key: the point of turning it on is to be taken to somebody.
  const people = [desk('w1:p1'), desk('w1:p2', 'blocked')];
  assert.equal(follow({ people, selectedId: 'w1:p1', seen: null, active: true }).selectedId, 'w1:p2');
});

test('switched off it does nothing but watch', () => {
  // It still keeps the seen set current, so turning it on later does not treat six
  // old hands as six new events.
  const people = [desk('w1:p1'), desk('w1:p2', 'blocked')];
  const out = follow({ people, selectedId: 'w1:p1', seen: new Set(), active: false });
  assert.equal(out.moved, false);
  assert.equal(out.selectedId, 'w1:p1');
  assert.ok(out.seen.has('w1:p2'));
});

test('nonsense cannot move anybody', () => {
  assert.deepEqual(follow(), { selectedId: null, seen: new Set(), moved: false });
  const out = follow({ people: [desk('w1:p1', 'blocked')], seen: ['w1:p1'], active: true, selectedId: null });
  assert.equal(out.moved, false, 'an array of seen ids is honoured, not ignored');
  assert.equal(follow({ people: [null, undefined, desk('w1:p1', 'blocked')], active: true, seen: new Set() }).selectedId, 'w1:p1');
});
