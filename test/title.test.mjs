// The window title. Two things to hold: it says the actionable number first,
// because every window list truncates from the right, and it can never contain a
// control character, because it leaves here inside a terminal escape sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowTitle } from '../src/title.mjs';

test('the title leads with the number you have to do something about', () => {
  assert.match(windowTitle({ blocked: 2, working: 3, idle: 1 }), /^2 waiting\b/);
  // Truncation is the whole reason for the order: cut anywhere past the first
  // word and the count is still there.
  const title = windowTitle({ blocked: 12, working: 30, idle: 9, done: 9, unknown: 9 });
  assert.match(title.slice(0, 10), /12 waiting|12 waitin/);
});

test('every shape an office can be in gets a title', () => {
  assert.equal(windowTitle({ working: 3 }), '3 working - office');
  // A room full of people, none of them doing anything, is not the same as an
  // empty room, and the title says which.
  assert.equal(windowTitle({ idle: 4 }), 'all quiet - office');
  assert.equal(windowTitle({ done: 1, unknown: 2 }), 'all quiet - office');
  assert.equal(windowTitle({}), 'nobody in - office');
  assert.equal(windowTitle(), 'nobody in - office');
});

test('a title stays short enough to be glanceable', () => {
  const worst = windowTitle({ blocked: 9999, working: 9999, idle: 9999, done: 9999, unknown: 9999 });
  assert.ok(worst.length <= 48, `title is ${worst.length} characters`);
});

test('nothing in a title can end the escape sequence that carries it', () => {
  // The counts are numbers today, so this is defence in depth rather than a live
  // bug: an ESC or a BEL in a title does not corrupt the office's own grid, it
  // corrupts whatever the terminal does next.
  const nasty = windowTitle({ blocked: '2\u001b]0;pwned\u0007', working: '\n3' });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/.test(nasty), `control character survived: ${JSON.stringify(nasty)}`);
  assert.ok(!nasty.includes('pwned'), `title carried a payload: ${JSON.stringify(nasty)}`);
  // A count that is not a number is not a count: the escape sequence in the
  // blocked slot scrubs to nothing rather than to 2, so the title reports what it
  // can stand behind. `'\n3'` is genuinely three, whitespace and all.
  assert.equal(nasty, '3 working - office');
});

test('nonsense counts cannot produce a nonsense title', () => {
  assert.equal(windowTitle({ blocked: -4, working: null, idle: undefined }), 'nobody in - office');
  assert.equal(windowTitle({ blocked: NaN, working: 1.6 }), '2 working - office');
});
