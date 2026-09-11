// Reading an agent's screen. approvalChoice decides which keys get sent to a
// real agent when the user presses `y`, so being wrong here is not a rendering
// glitch: it answers a prompt the user never read. The screens below are the
// shapes the agents named in the README actually draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOutput, findAsk, bubbleText, approvalChoice, summarize, describeDetection } from '../src/summary.mjs';

const screen = (s) => cleanOutput(s.trimEnd());

test('a literal y/n prompt is answered with letters', () => {
  const s = screen(`
$ rm -rf build
Do you want to run this command? (y/n)
`);
  assert.deepEqual(approvalChoice(s), { shape: 'y/n', approve: ['y'], deny: ['n'] });
});

test('a numbered menu is answered with the digit', () => {
  const s = screen(`
Allow npm install?
❯ 1. Yes
  2. No, and tell me what to do differently
`);
  assert.deepEqual(approvalChoice(s), { shape: 'menu', approve: ['1'], deny: ['esc'] });
});

test('the "and stop asking me" option is never the one picked', () => {
  // The single most important line in this file. Option 2 grants standing
  // permission; answering it on the user's behalf takes a decision away from them
  // that they cannot easily take back.
  const s = screen(`
Bash command: rm -rf node_modules
❯ 1. Yes
  2. Yes, and don't ask again for rm commands
  3. No, and tell Claude what to do differently
`);
  const choice = approvalChoice(s);
  assert.deepEqual(choice.approve, ['1'], 'approve should be the plain yes');
  assert.notDeepEqual(choice.approve, ['2']);
});

test('a menu whose first option is not a yes falls back to the agent default', () => {
  const s = screen(`
Which file should I edit?
❯ 1. src/render.mjs
  2. src/office.mjs
`);
  assert.deepEqual(approvalChoice(s), { shape: 'menu?', approve: ['enter'], deny: ['esc'] });
});

test('an unrecognised screen falls back to enter and esc, and says so', () => {
  const s = screen(`
Thinking very hard about your request
`);
  const choice = approvalChoice(s);
  assert.equal(choice.shape, 'unknown', 'the shape has to say it is a guess, because the panel shows that');
  assert.deepEqual(choice.approve, ['enter']);
  assert.deepEqual(choice.deny, ['esc']);
});

test('a y/n prompt wins over a menu further up the screen', () => {
  const s = screen(`
❯ 1. Yes
  2. No
Actually, overwrite the config? (y/n)
`);
  assert.equal(approvalChoice(s).shape, 'y/n');
});

test('a prompt long dead in the scrollback is not answered', () => {
  // Only the last 40 lines count. A stale prompt from ten minutes ago must not
  // decide what key gets sent now.
  const s = screen(['Delete everything? (y/n)', ...Array.from({ length: 60 }, (_, i) => `  compiled module ${i}`)].join('\n'));
  assert.equal(approvalChoice(s).shape, 'unknown');
});

test('the ask is found, and keybinding hints are not mistaken for it', () => {
  const s = screen(`
Running the test suite
  12 passing
esc to interrupt · ctrl+c to quit
Do you want me to apply the patch? (y/n)
`);
  assert.equal(findAsk(s), 'Do you want me to apply the patch? (y/n)');
});

test('a screen of nothing but keybinding hints has no ask in it', () => {
  const s = screen(`
? for shortcuts
ctrl+r to expand
tokens used 1240
context: 42%
`);
  assert.equal(findAsk(s), null);
});

test('the bubble says the question without the (y/n) tacked on', () => {
  const s = screen('Do you want me to apply the patch? (y/n)');
  assert.equal(bubbleText(s), 'Do you want me to apply the patch?');
});

test('the bubble always says something', () => {
  for (const s of [[], screen('nothing interesting here'), screen('(y/n)')]) {
    assert.ok(bubbleText(s).length > 0, 'a stuck desk with an unreadable screen still needs a bubble');
  }
});

test('cleanOutput strips the boxes and gutters agents draw', () => {
  // Border rows go because they are nothing but chrome, and the box glyphs left
  // inside a row of text go because sanitize drops that whole Unicode range on
  // the way in. What is left is the words.
  const out = cleanOutput('╭──────────╮\n│ hello    │\n╰──────────╯\n\n  ───\n│ world');
  assert.deepEqual(out, ['hello', 'world']);
});

test('summarize leads with what they are stuck on', () => {
  const person = { status: 'blocked', title: 'fix the flaky test' };
  const out = summarize(person, screen('Ran the suite and three cases failed intermittently\nApply the patch? (y/n)'));
  assert.match(out[0], /^stuck on: Apply the patch\?/);
  assert.ok(
    out.some((l) => l.startsWith('pane title:')),
    'the pane title is worth saying too',
  );
});

test('summarize says something even about an empty screen', () => {
  assert.deepEqual(summarize(null, []), ['nothing to report']);
  assert.deepEqual(summarize({ status: 'blocked' }, []), ['stuck waiting on you (could not spot the question)']);
});

test('describeDetection survives whatever agent explain returns', () => {
  assert.deepEqual(describeDetection(null), []);
  assert.deepEqual(describeDetection('nonsense'), []);
  assert.deepEqual(describeDetection({}), []);
  assert.deepEqual(describeDetection({ explain: { state: 'blocked', matched_rule: { id: 'prompt' }, visible_blocker: true } }), [
    'state blocked via rule prompt',
    'signals: blocker',
  ]);
});
