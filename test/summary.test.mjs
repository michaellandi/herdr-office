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

test('the said lines are labelled once and line up under it', () => {
  // Three lines of an agent talking read as the tail of one thought. Labelling each
  // of them read as three unrelated remarks and spent eleven cells a line saying a
  // thing already said, on the narrowest column in the office.
  const said = [
    'I have finished refactoring the token refresh path and split it in two.',
    'The retry loop now backs off instead of hammering the endpoint every second.',
    'Two of the integration tests were relying on the old timing, so I updated them.',
    'Next I want to check whether the cache invalidation still behaves the same way.',
  ];
  const out = summarize({ status: 'idle' }, said);
  assert.equal(out.length, 3, 'three of them, not two');
  assert.equal(out.filter((l) => l.includes('last said:')).length, 1, 'said once');
  assert.ok(out[0].startsWith('last said: '));
  // The indent has to be exactly the label, or the block does not line up. Asserted
  // against the label's own length rather than a number, so changing the wording
  // cannot silently knock the alignment out.
  const indent = ' '.repeat('last said: '.length);
  for (const line of out.slice(1)) {
    assert.ok(line.startsWith(indent), `not aligned: ${JSON.stringify(line)}`);
    assert.ok(line.trim().length, 'an indent with nothing after it');
  }
  // And it is still the LAST three, oldest first, not the first three.
  assert.deepEqual(
    out.map((l) => l.replace('last said:', '').trim()),
    said.slice(-3),
  );
});

test('summarize says something even about an empty screen', () => {
  assert.deepEqual(summarize(null, []), ['nothing to report']);
  assert.deepEqual(summarize({ status: 'blocked' }, []), ['stuck waiting on you (could not spot the question)']);
});

test('describeDetection reads the socket envelope as well as the bare body', () => {
  const want = ['state blocked via rule prompt', 'signals: blocker'];
  const body = { state: 'blocked', matched_rule: { id: 'prompt' }, visible_blocker: true };
  assert.deepEqual(describeDetection(body), want, 'the CLI returns the body bare');
  assert.deepEqual(describeDetection({ explain: body }), want, 'the socket wraps it in `explain`');
});

// A live explain read off a real machine, condensed to what the office draws. The
// point of the section is answering "why does it think that", so every line here is
// one of the reasons a state can disagree with the screen in front of you.
test('describeDetection explains a real explain payload', () => {
  assert.deepEqual(
    describeDetection({
      state: 'blocked',
      matched_rule: { id: 'tool_approval_prompt', priority: 950, region: 'bottom_non_empty_lines(5)' },
      evaluated_rules: [{ matched: true }, { matched: false }, { matched: false }],
      visible_blocker: true,
      skip_state_update: true,
      remote_update_status: 'stale',
      manifest_source: 'remote:/Users/somebody/.local/state/herdr/agent-detection/remote/claude.toml',
      manifest_version: '2026.09.01.1',
    }),
    [
      'state blocked via rule tool_approval_prompt',
      'state held, not being updated',
      'manifest update stale',
      'priority 950, looking at bottom_non_empty_lines(5)',
      '3 rules checked, 1 matched',
      'signals: blocker',
      'rules from claude.toml 2026.09.01.1 (remote)',
    ],
  );
});

// The panel clips this section from the bottom to keep the answer keys on screen,
// so the order is part of the contract: which rule fired has to outrank which file
// the rules came from, or a short pane keeps the trivia and drops the answer.
test('describeDetection puts the rule that fired first and the paperwork last', () => {
  const lines = describeDetection({
    state: 'idle',
    matched_rule: { id: 'osc_title', priority: 10, region: 'whole_recent' },
    manifest_source: 'local:/tmp/kiro.toml',
    screen_detection_skipped: true,
  });
  assert.match(lines[0], /^state idle via rule osc_title$/);
  assert.equal(lines.indexOf('screen detection skipped'), 1);
  assert.match(lines[lines.length - 1], /^rules from kiro\.toml/);
});

// The load-bearing test in this file. Every field of an explain payload is a place
// herdr can hand us a path, a URL, a token or a copy of somebody's screen, and one
// live read produced an account id and a paragraph of private reasoning. So the
// assertion is not "the output looks right", it is that none of the input reaches
// the output unless it is shaped like one of herdr's own identifiers.
test('describeDetection draws nothing that came off the wire', () => {
  const secret = 'ACCOUNT 000000000000 sk-live-000 /Users/somebody/.aws/credentials';
  const lines = describeDetection({
    // A state, a rule id and a region that are really prose. Shaped wrong, so dropped
    // rather than trimmed: a trimmed secret is still a secret with the end cut off.
    state: `blocked ${secret}`,
    matched_rule: { id: secret, priority: 9e9, region: `whole_recent ${secret}`, state: secret },
    // Free text by design. Acknowledged, never repeated.
    warning: `manifest ${secret} failed to load`,
    fallback_reason: `could not reach https://example.invalid/${secret}`,
    skipped_update_reason: `rate limited until 2026-09-10 by ${secret}`,
    remote_update_status: secret,
    remote_update_error: secret,
    // The dangerous half of the payload: every rule quotes the screen.
    evaluated_rules: [
      { id: secret, matched: true, evidence: { region_preview: secret, contains: [secret], regex: secret, line_regex: secret, region_bytes: 99 } },
    ],
    // An absolute path under somebody's home directory.
    manifest_source: `remote:/Users/somebody/.local/state/herdr/${secret}/claude.toml`,
    manifest_version: secret,
    agent: secret,
  }).join('\n');

  for (const needle of ['000000000000', 'sk-live', '/Users/', '.aws', 'example.invalid', 'rate limited', 'failed to load', 'could not reach']) {
    assert.ok(!lines.includes(needle), `${JSON.stringify(needle)} leaked: ${JSON.stringify(lines)}`);
  }
  // What it says instead: that there is something to read, and where to read it.
  assert.match(lines, /^warning reported \(run: herdr agent explain\)$/m);
  assert.match(lines, /^fallback reported \(run: herdr agent explain\)$/m);
  assert.match(lines, /^update skipped reported \(run: herdr agent explain\)$/m);
  // An absurd priority is not a number worth printing either.
  assert.ok(!lines.includes('9000000000'), lines);
  // And the safe arithmetic still comes through, because that is the point.
  assert.match(lines, /^1 rules checked, 1 matched$/m);
});

// The whole payload can also be junk, or wrapped in an envelope, or not there at
// all. `herdr agent explain --json` returns the body bare; the socket wraps it.
test('describeDetection survives whatever agent explain returns', () => {
  assert.deepEqual(describeDetection(null), []);
  assert.deepEqual(describeDetection('nonsense'), []);
  assert.deepEqual(describeDetection(42), []);
  assert.deepEqual(describeDetection([]), []);
  assert.deepEqual(describeDetection({}), []);
  assert.deepEqual(describeDetection({ explain: null }), []);
  assert.deepEqual(describeDetection({ state: null, matched_rule: 'not an object', evaluated_rules: 'nope' }), []);
  assert.deepEqual(describeDetection({ evaluated_rules: [null, 'x', { matched: true }] }), ['3 rules checked, 1 matched']);
  // A rule with nothing legible about it beyond its id still names the rule.
  assert.deepEqual(describeDetection({ matched_rule: { id: 'prompt', priority: null, region: null } }), ['matched rule prompt']);
});
