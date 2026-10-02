// Reading an agent's screen. approvalChoice decides which keys get sent to a
// real agent when the user presses `y`, so being wrong here is not a rendering
// glitch: it answers a prompt the user never read. The screens below are the
// shapes the agents named in docs/design.md actually draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOutput, findAsk, bubbleText, approvalChoice, cursorMenu, alwaysOption, summarize, describeDetection, lastSaid } from '../src/summary.mjs';

const screen = (s) => cleanOutput(s.trimEnd());

// Both halves of a read, which is what the office hands approvalChoice: the cleaned
// lines everything else works from, and the raw screen, because a cursor menu is drawn
// in the indentation and the cursor glyph that cleaning takes out.
const both = (s) => [cleanOutput(s.trimEnd()), s.trimEnd()];

// A menu with no numbers on it, of the kind a full-screen agent TUI draws: a cursor on
// the row that enter would take, the rest of the rows lined up under it, then a rule and
// a footer saying which keys move. Written out here rather than captured, so the fixture
// is about the shape and not about anybody's terminal.
const CURSOR_MENU = `
  Tool: write_file requires approval

  write_file  src/app.js

  ❯ Allow
    Always allow
    Deny
    Always deny
  ${'─'.repeat(28)}
  esc to close · ↑↓ to navigate ↵ to select · Tab to edit
`;

test('a literal y/n prompt is answered with letters', () => {
  const s = screen(`
$ rm -rf build
Do you want to run this command? (y/n)
`);
  assert.deepEqual(approvalChoice(s), { shape: 'y/n', approve: ['y'], deny: ['n'], always: null });
});

test('a numbered menu is answered with the digit', () => {
  const s = screen(`
Allow npm install?
❯ 1. Yes
  2. No, and tell me what to do differently
`);
  assert.deepEqual(approvalChoice(s), { shape: 'menu', approve: ['1'], deny: ['esc'], always: null });
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
  // It is offered separately, on its own key, carrying the digit read off the menu
  // and the words the menu used. `y` still cannot reach it.
  assert.deepEqual(choice.always, { keys: ['2'], label: "Yes, and don't ask again for rm commands" });
});

test('the always option is read off the menu rather than assumed to be 2', () => {
  // A hardcoded 2 aimed at this menu would deny the command and tell the agent to
  // do something else, which is a wrong answer sent under a key labelled "yes".
  const s = screen(`
Bash command: git push --force
❯ 1. Yes
  2. No, and tell Claude what to do differently
  3. Yes, and don't ask again for git push commands
`);
  assert.deepEqual(approvalChoice(s).always, { keys: ['3'], label: "Yes, and don't ask again for git push commands" });
});

test('a no that stops asking is not an always', () => {
  // "No, and don't ask again" is a deny. Reaching it with a key the footer calls
  // "always allow" would refuse the thing the user just tried to permit.
  const s = screen(`
Allow reading .env?
❯ 1. Yes
  2. No, and don't ask again for this file
`);
  assert.equal(approvalChoice(s).always, null, 'a deny must never be offered as an always');
});

test('a menu with no standing option offers none', () => {
  // The common case, and the reason the key is conditional: a prompt that cannot
  // grant standing permission must not advertise a key that would send a digit
  // into a menu that has no such entry.
  const s = screen(`
Allow npm install?
❯ 1. Yes
  2. No
`);
  assert.equal(approvalChoice(s).always, null);
});

test('an unreadable menu never grants standing permission', () => {
  // The first option is not a yes, so the office does not understand this menu.
  // Not understanding it is exactly when a digit must not be sent.
  const s = screen(`
Pick a branch to push
❯ 1. main
  2. release, and don't ask again
`);
  const choice = approvalChoice(s);
  assert.equal(choice.shape, 'menu?');
  assert.equal(choice.always, null, 'a menu the office cannot read is not one it can grant permission from');
});

test('the always option survives the phrasings agents actually use', () => {
  for (const [line, digit] of [
    ['  2. Yes, and always allow this command', '2'],
    ['  2. Yes, allow always', '2'],
    ['  4. Allow, and stop asking', '4'],
    ["  2. Yes, and do not ask again", '2'],
  ]) {
    const s = screen(`Allow it?\n❯ 1. Yes\n${line}\n`);
    assert.deepEqual(alwaysOption(s)?.keys, [digit], `did not read: ${line}`);
  }
});

test('a menu whose first option is not a yes falls back to the agent default', () => {
  const s = screen(`
Which file should I edit?
❯ 1. src/render.mjs
  2. src/office.mjs
`);
  assert.deepEqual(approvalChoice(s), { shape: 'menu?', approve: ['enter'], deny: ['esc'], always: null });
});

test('a menu with no numbers on it is answered by walking the cursor', () => {
  const choice = approvalChoice(...both(CURSOR_MENU));
  assert.equal(choice.shape, 'cursor');
  // The cursor is already on Allow, so yes is just enter. No is two rows down, and
  // esc on this menu is what the footer calls close: it cancels, which is not a deny.
  assert.deepEqual(choice.approve, ['enter']);
  assert.deepEqual(choice.deny, ['down', 'down', 'enter']);
});

test('the walk is counted from wherever the cursor is actually sitting', () => {
  // The whole hazard of this shape. The same menu, one row further down, and every
  // answer on it is a different number of keystrokes.
  const moved = CURSOR_MENU.replace('  ❯ Allow', '    Allow').replace('    Deny', '  ❯ Deny');
  const choice = approvalChoice(...both(moved));
  assert.deepEqual(choice.approve, ['up', 'up', 'enter']);
  assert.deepEqual(choice.deny, ['enter']);
});

test('a cursor menu stops at the rule, so the footer is not an option', () => {
  const menu = cursorMenu(CURSOR_MENU.trimEnd());
  assert.deepEqual(menu.options.map((o) => o.label), ['Allow', 'Always allow', 'Deny', 'Always deny']);
  assert.equal(menu.cursor, 0);
});

test('"always allow" on a cursor menu is offered separately and never as the yes', () => {
  const choice = approvalChoice(...both(CURSOR_MENU));
  assert.deepEqual(choice.approve, ['enter'], 'approve must be the plain allow');
  assert.deepEqual(choice.always, { keys: ['down', 'enter'], label: 'Always allow' });
});

test('"always deny" is not mistaken for a standing permission', () => {
  // It is on the same menu, one row below the real one, and it is a deny. Arming it
  // under a key labelled "always allow" would refuse the thing the user just allowed.
  const choice = approvalChoice(...both(CURSOR_MENU));
  assert.notEqual(choice.always.label, 'Always deny');
  assert.deepEqual(choice.deny, ['down', 'down', 'enter'], 'deny must be the plain one too');
});

test('a numbered menu that also draws a cursor is still answered with the digit', () => {
  // Most menus are both. The digit says which row it means without depending on where
  // the cursor was when the screen was last read, so it wins.
  const s = `
Allow npm install?
❯ 1. Yes
  2. No
`;
  assert.deepEqual(approvalChoice(...both(s)), { shape: 'menu', approve: ['1'], deny: ['esc'], always: null });
});

test('a cursor menu with no yes and no no in it is left to the fallback', () => {
  // A walk onto a row we have only half identified is how a standing permission gets
  // granted by accident, so an unreadable menu gets enter and esc and no claim.
  const s = `
Which file should I edit?
  ❯ src/render.mjs
    src/office.mjs
`;
  assert.equal(approvalChoice(...both(s)).shape, 'unknown');
});

test('a cursor menu cannot be seen in the cleaned lines alone', () => {
  // Not a quirk to work around: it is why approvalChoice takes the raw screen as well,
  // and if this ever starts passing the second argument has stopped being necessary.
  assert.equal(approvalChoice(screen(CURSOR_MENU)).shape, 'unknown');
  assert.equal(cursorMenu(screen(CURSOR_MENU).join('\n')), null);
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
    'I have finished refactoring the cache warming path and split it in two.',
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

test('lastSaid is the one line of it that fits in somebody else\'s sentence', () => {
  // The same reading the card shows, cut to one line, because a stall notice has room
  // for a clause and not for a paragraph. The last of the three rather than the first:
  // the tail of the output is where an agent says why it gave up.
  const said = [
    'I have finished refactoring the cache warming path and split it in two.',
    'Two of the integration tests were relying on the old timing, so I updated them.',
    'I cannot apply the patch because the file has changed underneath me.',
  ];
  assert.ok(lastSaid(said).startsWith('I cannot apply the patch'));
  // And it is the same line the card would put last, not a separately chosen one. A
  // notice that quoted a different line from the card under it would read as the office
  // disagreeing with itself about what it had just read.
  const card = summarize({ status: 'idle' }, said);
  assert.ok(card.at(-1).trim().startsWith(lastSaid(said).replace(/…$/, '').trim().slice(0, 20)));
});

test('a quote off a screen cannot be made any length the screen likes', () => {
  // This string arrives from a stranger\'s terminal and ends up in a line the office
  // otherwise writes itself, so the cap is here rather than at the edge. Without it a
  // notice is whatever shape an agent felt like printing.
  const long = `the build failed and here is why ${'x'.repeat(400)}`;
  assert.equal(lastSaid([long]).length, 44);
  assert.equal(lastSaid([long], 12).length, 12);
  assert.ok(lastSaid([long]).endsWith('…'), 'cut without saying it was cut');
});

test('a screen with nothing quotable on it says nothing rather than something', () => {
  // An empty answer is an answer, and the surfaces above treat it as one: no quote means
  // a stall notice states the fact and stops, rather than printing `said ""`.
  assert.equal(lastSaid([]), '');
  assert.equal(lastSaid(null), '');
  assert.equal(lastSaid(undefined), '');
  assert.equal(lastSaid(['ok', 'y/n', '$ ls']), '', 'chrome and shell noise is not a quote');
});

test('a full-screen agent\'s footers are chrome, not the last thing it said', () => {
  // The list falls back to this line when an agent sets no pane title, so a footer
  // getting through here puts a spend counter in the column that is meant to say what
  // the desk is doing. Each of these is a shape a TUI paints every frame.
  const chrome = [
    'Credits: turn 0.01 • session 0.02 | Time: 0m 03s',
    '/sessions to resume · /copy to clipboard',
    'To edit cloud configs: https://example.com/agents',
  ];
  for (const line of chrome) assert.equal(lastSaid([line]), '', `quoted as a status update: ${line}`);
  // And the thing they are drawn around still is one.
  const real = 'I rewrote the parser and the whole suite is passing again';
  assert.equal(lastSaid([...chrome, real], 200), real);
});

test('a quote is stripped of everything an agent can draw', () => {
  // Straight into a status line that shares a row with key hints, so an escape sequence
  // or a stray control character in it would move the cursor rather than say anything.
  // sanitize() is applied on the way out even though cleanOutput() already ran, because
  // this function is called on whatever the caller has, not only on cleaned screens.
  const dirty = `\u001b[31mthe tests failed\u001b[0m and \u0007the fixture \u001b[2Jchanged`;
  const quote = lastSaid([dirty], 200);
  assert.doesNotMatch(quote, /\u001b|\u0007/);
  assert.match(quote, /the tests failed/);
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
