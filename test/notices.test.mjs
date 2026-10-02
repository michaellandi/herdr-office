// The office manager, which at this point is a manager who can only talk.
//
// Every test here is about a sentence being said or not said. There is no socket in
// this file and no way to reach one from the module it tests, which is the point: the
// first version of a coordinator is one that is provably incapable of coordinating,
// and that property is worth a suite of its own to keep.
//
// The ones that matter most are the negatives. A notice that fires when it should not
// is worse than a missing feature, because the whole value of the line is that seeing
// something on it means something is true. Half of these exist to keep it quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notices, STALL_MS, FULL_HEAD } from '../src/notices.mjs';
import { renderFrame } from '../src/render.mjs';
import { width } from '../src/text.mjs';
import { SIZES, officeRoster, viewOf, stripAnsi } from './fixtures.mjs';

// A desk, as the roster hands one over. Deliberately spelled out rather than built
// from a helper with clever defaults: these tests are about which fields make the
// office speak, so the fields are in the test.
const desk = (name, extra = {}) => ({
  id: `w1:${name}`,
  name,
  kind: 'claude',
  status: 'working',
  statusMs: 1000,
  assumedSince: false,
  cwd: '',
  ask: '',
  dirt: null,
  head: null,
  ...extra,
});

const kinds = (list) => list.map((n) => n.kind);
const texts = (list) => list.map((n) => n.text);

test('an empty floor has nothing to say', () => {
  assert.deepEqual(notices({ people: [] }), []);
  assert.deepEqual(notices({}), []);
  assert.deepEqual(notices(), []);
});

/* ---------------------------------------------------------------- collisions */

test('two agents working in one checkout is the notice this file exists for', () => {
  const list = notices({
    people: [
      desk('Ada', { cwd: '/Users/you/code/herdr-office' }),
      desk('Bo', { cwd: '/Users/you/code/herdr-office' }),
    ],
  });
  assert.deepEqual(kinds(list), ['collision']);
  assert.equal(list[0].text, 'Ada and Bo are both in herdr-office');
  assert.deepEqual(list[0].ids, ['w1:Ada', 'w1:Bo']);
});

test('only the last segment of the path is ever said out loud', () => {
  // This pane gets screen-shared, and a working directory is an absolute path under
  // somebody's home. The same rule src/summary.mjs follows for manifest paths.
  const list = notices({
    people: [
      desk('Ada', { cwd: '/Users/realname/clients/acme-secret-merger/api' }),
      desk('Bo', { cwd: '/Users/realname/clients/acme-secret-merger/api' }),
    ],
  });
  assert.equal(list[0].text, 'Ada and Bo are both in api');
  assert.doesNotMatch(list[0].text, /realname|clients|acme/);
});

test('a desk on its own in a checkout is just a desk', () => {
  const list = notices({
    people: [desk('Ada', { cwd: '/w/one' }), desk('Bo', { cwd: '/w/two' })],
  });
  assert.deepEqual(list, []);
});

test('a server that reports no working directory does not collide the whole floor', () => {
  // The bug this is here to prevent: with no cwd every desk shares the empty string,
  // and a naive grouping announces a twelve-way collision in a directory it cannot
  // even name. Which is what most of a floor looks like when `worktree.list` is off.
  const list = notices({ people: [desk('Ada'), desk('Bo'), desk('Cass'), desk('Dev')] });
  assert.deepEqual(list, []);
});

test('somebody who has stopped is not in the way', () => {
  // Two agents *both moving* in one tree is the thing worth saying. An idle or
  // finished desk is sitting still, and its checkout is not being written to.
  const held = { cwd: '/w/repo' };
  assert.deepEqual(notices({ people: [desk('Ada', held), desk('Bo', { ...held, status: 'idle' })] }), []);
  assert.deepEqual(notices({ people: [desk('Ada', held), desk('Bo', { ...held, status: 'done' })] }), []);
  assert.deepEqual(notices({ people: [desk('Ada', held), desk('Bo', { ...held, status: 'unknown' })] }), []);
});

test('a hand up still counts as being in the room', () => {
  // A blocked agent stopped mid-task with whatever it had already written still on
  // disk, so the tree is held open even though nothing is moving this second.
  const list = notices({
    people: [desk('Ada', { cwd: '/w/repo' }), desk('Bo', { cwd: '/w/repo', status: 'blocked', ask: 'write a file?' })],
  });
  assert.deepEqual(kinds(list), ['collision']);
});

test('a crowd is named up to three and then counted', () => {
  const at = (name) => desk(name, { cwd: '/w/repo' });
  assert.equal(notices({ people: [at('Ada'), at('Bo'), at('Cass')] })[0].text, 'Ada, Bo and Cass are all in repo');
  assert.equal(notices({ people: [at('Ada'), at('Bo'), at('Cass'), at('Dev')] })[0].text, 'Ada, Bo and 2 more are all in repo');
});

test('two checkouts in trouble are two notices', () => {
  const list = notices({
    people: [
      desk('Ada', { cwd: '/w/one' }), desk('Bo', { cwd: '/w/one' }),
      desk('Cass', { cwd: '/w/two' }), desk('Dev', { cwd: '/w/two' }),
    ],
  });
  assert.deepEqual(texts(list), ['Ada and Bo are both in one', 'Cass and Dev are both in two']);
});

test('a directory named to break the grid cannot', () => {
  // A cwd is never sanitized on the way in, so this is the one string in a notice
  // that arrives unchecked. An ambiguous-width glyph here is a cell the footer did
  // not budget for, and a long name pushes the words that matter off the end.
  const nasty = `/w/${'x'.repeat(80)}\u{1F600}`;
  const list = notices({ people: [desk('Ada', { cwd: nasty }), desk('Bo', { cwd: nasty })] });
  assert.equal(kinds(list).length, 1);
  assert.ok(list[0].text.length < 60, `notice was ${list[0].text.length} characters: ${list[0].text}`);
  assert.doesNotMatch(list[0].text, /\u{1F600}/u, 'no ambiguous-width glyph reaches the grid');
});

/* ---------------------------------------------------------------- full heads */

test('a nearly full head that is still working gets a sentence', () => {
  const list = notices({ people: [desk('Cass', { head: { used: 94, model: 'claude', session: null } })] });
  assert.deepEqual(kinds(list), ['full']);
  assert.equal(list[0].text, 'Cass is 94% full and still working');
});

test('the line for a full head is the same line the monitor frame draws at', () => {
  const at = (used) => notices({ people: [desk('Cass', { head: { used } })] });
  assert.deepEqual(at(FULL_HEAD - 1), [], 'one below says nothing');
  assert.deepEqual(kinds(at(FULL_HEAD)), ['full']);
});

test('a full head nobody is using is not urgent', () => {
  // The notice is about what happens next: it compacts and carries on with a
  // summary. A desk that has stopped is not about to do that.
  for (const status of ['idle', 'done', 'blocked', 'unknown']) {
    assert.deepEqual(notices({ people: [desk('Cass', { status, head: { used: 99 } })] }), [], status);
  }
});

test('a head nobody has read is not a full one', () => {
  assert.deepEqual(notices({ people: [desk('Cass', { head: null })] }), []);
  assert.deepEqual(notices({ people: [desk('Cass', { head: { used: null } })] }), []);
});

/* ----------------------------------------------------------------- same asks */

test('two hands on the same question are one interruption', () => {
  const list = notices({
    people: [
      desk('Ada', { status: 'blocked', ask: 'Run rm -rf build?' }),
      desk('Bo', { status: 'blocked', ask: 'Run rm -rf build?' }),
    ],
  });
  assert.deepEqual(kinds(list), ['same-ask']);
  assert.equal(list[0].text, 'Ada and Bo are stuck on the same thing');
});

test('the same question rendered two cells narrower is the same question', () => {
  const list = notices({
    people: [
      desk('Ada', { status: 'blocked', ask: 'Run rm -rf build?' }),
      desk('Bo', { status: 'blocked', ask: '  run   RM -RF BUILD  ' }),
    ],
  });
  assert.deepEqual(kinds(list), ['same-ask']);
});

test('what they are asking is not repeated on the line', () => {
  // It is already drawn in full in both bubbles, and the footer has one row. This
  // also keeps screen text off a line that is otherwise all the office's own words.
  const list = notices({
    people: [
      desk('Ada', { status: 'blocked', ask: 'delete /Users/somebody/secrets?' }),
      desk('Bo', { status: 'blocked', ask: 'delete /Users/somebody/secrets?' }),
    ],
  });
  assert.doesNotMatch(list[0].text, /secrets|Users|delete/);
});

test('two different questions are two different interruptions', () => {
  const list = notices({
    people: [
      desk('Ada', { status: 'blocked', ask: 'run the tests?' }),
      desk('Bo', { status: 'blocked', ask: 'push to main?' }),
    ],
  });
  assert.deepEqual(list, []);
});

test('two desks nobody has read a question off yet are not stuck on the same thing', () => {
  // An empty ask is "not asked yet", not "asking nothing", and grouping on it would
  // pair every freshly blocked desk on the floor with every other one.
  const list = notices({
    people: [desk('Ada', { status: 'blocked', ask: '' }), desk('Bo', { status: 'blocked', ask: '' })],
  });
  assert.deepEqual(list, []);
});

/* -------------------------------------------------------------------- stalls */

test('a desk that stopped with work still on the floor gets mentioned', () => {
  const list = notices({
    people: [desk('Dev', { status: 'idle', statusMs: STALL_MS + 60000, dirt: { files: 7, conflicts: 0 } })],
  });
  assert.deepEqual(kinds(list), ['stalled']);
  assert.match(list[0].text, /^Dev stopped 16m\d\ds ago with 7 files uncommitted$/);
});

test('one file is one file', () => {
  const list = notices({
    people: [desk('Dev', { status: 'idle', statusMs: STALL_MS, dirt: { files: 1, conflicts: 0 } })],
  });
  assert.match(list[0].text, /1 file uncommitted$/);
});

test('neither half of a stall is interesting on its own', () => {
  // An idle agent has usually just finished, and uncommitted files are what a
  // working agent looks like from the outside.
  const idleAndClean = desk('Dev', { status: 'idle', statusMs: STALL_MS * 2, dirt: { files: 0, conflicts: 0 } });
  const busyAndDirty = desk('Dev', { status: 'working', statusMs: STALL_MS * 2, dirt: { files: 9, conflicts: 0 } });
  const idleAndUnasked = desk('Dev', { status: 'idle', statusMs: STALL_MS * 2, dirt: null });
  assert.deepEqual(notices({ people: [idleAndClean] }), []);
  assert.deepEqual(notices({ people: [busyAndDirty] }), []);
  assert.deepEqual(notices({ people: [idleAndUnasked] }), []);
});

test('a desk that stopped a moment ago has not stalled', () => {
  const list = notices({
    people: [desk('Dev', { status: 'idle', statusMs: STALL_MS - 1, dirt: { files: 3, conflicts: 0 } })],
  });
  assert.deepEqual(list, []);
});

test('desks parked in one checkout are one stall rather than one each', () => {
  // The bug this is here to prevent, found on a real floor: uncommitted files are a fact
  // about a directory and `dirt` is keyed by cwd, so four desks in one repository all
  // report the same ten files. One notice each read as four separate piles of ten, and
  // it was permanent, because several agents living in one checkout is the ordinary case.
  const parked = (name) => desk(name, { status: 'idle', statusMs: STALL_MS * 2, cwd: '/w/brain', dirt: { files: 10, conflicts: 0 } });
  const list = notices({ people: [parked('Cass'), parked('Dev'), parked('Ede'), parked('Fen')] });
  assert.deepEqual(kinds(list), ['stalled']);
  assert.equal(list[0].text, 'Cass, Dev and 2 more stopped in brain with 10 files uncommitted');
  // And it still carries every desk, so `m` can walk you to all four.
  assert.deepEqual(list[0].ids, ['w1:Cass', 'w1:Dev', 'w1:Ede', 'w1:Fen']);
  // The count is the directory's, stated once, not four of them added up.
  assert.doesNotMatch(list[0].text, /40|30|20/);
});

test('two checkouts that have both gone quiet are two stalls', () => {
  const parked = (name, cwd) => desk(name, { status: 'idle', statusMs: STALL_MS * 2, cwd, dirt: { files: 3, conflicts: 0 } });
  const list = notices({
    people: [parked('Cass', '/w/one'), parked('Dev', '/w/one'), parked('Ede', '/w/two'), parked('Fen', '/w/two')],
  });
  assert.deepEqual(texts(list), [
    'Cass and Dev stopped in one with 3 files uncommitted',
    'Ede and Fen stopped in two with 3 files uncommitted',
  ]);
});

test('a desk stalled on its own still says how long it has been', () => {
  // The single case keeps the duration, because with one desk that is the interesting
  // part. A crowd drops it: the threshold already says it has been a while, and the
  // per-desk clock is on the card `m` takes you to.
  const list = notices({
    people: [
      desk('Cass', { status: 'idle', statusMs: STALL_MS * 2, cwd: '/w/one', dirt: { files: 2, conflicts: 0 } }),
      desk('Dev', { status: 'working', cwd: '/w/one' }),
    ],
  });
  assert.deepEqual(kinds(list), ['stalled']);
  assert.match(list[0].text, /^Cass stopped 30m\d\ds ago with 2 files uncommitted$/);
});

test('a desk the server gave no directory for is not dropped on the floor', () => {
  // The grouping ignores falsy keys, and a desk vanishing out of a notice is worse than
  // a redundant branch. Not reachable in practice, since dirt is read per directory.
  const list = notices({
    people: [desk('Cass', { status: 'idle', statusMs: STALL_MS * 2, cwd: '', dirt: { files: 4, conflicts: 0 } })],
  });
  assert.deepEqual(kinds(list), ['stalled']);
  assert.match(list[0].text, /^Cass stopped .* with 4 files uncommitted$/);
});

test('a duration the office is only guessing at can make a stall late, never wrong', () => {
  // Unlike the escalation ladder, an assumed clock is allowed here. `statusMs` on a
  // first sighting is a lower bound, so crossing the threshold on a guess means the
  // desk has genuinely been idle at least that long.
  const list = notices({
    people: [desk('Dev', { status: 'idle', statusMs: STALL_MS + 1, assumedSince: true, dirt: { files: 2, conflicts: 0 } })],
  });
  assert.deepEqual(kinds(list), ['stalled']);
});

/* ------------------------------------------------------------- why it stopped */

// The thing the line was missing. "Dev stopped 16m ago with 7 files uncommitted" says a
// desk has a problem and nothing about what it is, which meant the only use for the
// notice was to go and read the pane, which is what you were doing before the office had
// a manager at all.
//
// The `why` rides alongside the sentence rather than inside it, and every test here is
// about that being a separate, droppable field: the desk's 27 cells keep the fact and
// lose the reason, and neither surface may be given a half-quote to print.

const stalled = (name, extra = {}) => desk(name, { status: 'idle', statusMs: STALL_MS * 2, dirt: { files: 7, conflicts: 0 }, ...extra });

test('a stall says why, when the office can say without guessing', () => {
  const list = notices({ people: [stalled('Dev', { said: 'I cannot apply the patch, the file moved' })] });
  assert.equal(list[0].why, 'said "I cannot apply the patch, the file …"');
  // Attributed, and still a fact about a screen rather than a cause. `said "..."` is
  // something the office watched happen; "it stopped because the file moved" would be a
  // guess about an agent's reasoning, which is the one thing this file does not do.
  assert.match(list[0].why, /^said "/);
  // And the sentence itself is untouched, so a surface with no room for the reason still
  // gets exactly the line it got before this existed.
  assert.match(list[0].text, /^Dev stopped 30m\d\ds ago with 7 files uncommitted$/);
});

test('the office prefers its own fact to a quote of somebody else\'s', () => {
  // A conflicted tree is read out of git by the same pass that counted the files, so it
  // is the office\'s own observation and it is the most common reason an agent gives up
  // mid-task. A quote is second best, and only used when there is nothing better.
  const list = notices({ people: [stalled('Dev', { dirt: { files: 7, conflicts: 3 }, said: 'I cannot apply the patch' })] });
  assert.equal(list[0].why, '3 of them conflicted');
  assert.doesNotMatch(list[0].why, /said/);
  // One conflict is one conflict.
  const one = notices({ people: [stalled('Dev', { dirt: { files: 2, conflicts: 1 } })] });
  assert.equal(one[0].why, '1 of them conflicted');
});

test('a stall the office cannot explain says nothing rather than guessing', () => {
  // The empty case has to be empty rather than a phrase like "reason unknown". Every
  // surface tests `n.why` for truth to decide whether to spend a row on it, and a
  // placeholder would spend that row saying the office has nothing to say.
  for (const said of ['', null, undefined, '   ']) {
    const list = notices({ people: [stalled('Dev', { said })] });
    assert.deepEqual(kinds(list), ['stalled'], `said=${JSON.stringify(said)} changed the notice`);
    assert.equal(list[0].why, '', `said=${JSON.stringify(said)} invented a reason`);
  }
  // And a desk that was never asked has no field at all, which must not throw.
  const bare = notices({ people: [desk('Dev', { status: 'idle', statusMs: STALL_MS * 2, dirt: { files: 7, conflicts: 0 } })] });
  assert.equal(bare[0].why, '');
});

test('a crowd names whose screen the quote came off', () => {
  // The file count is the directory\'s and is stated unattributed. A quote is not: four
  // desks in one checkout have four screens, and `said "..."` with no name in front of it
  // reads as the office quoting all of them.
  const parked = (name, extra) => stalled(name, { cwd: '/w/brain', dirt: { files: 10, conflicts: 0 }, ...extra });
  const list = notices({ people: [parked('Cass', { said: 'the merge is not going to work' }), parked('Dev')] });
  assert.equal(list[0].text, 'Cass and Dev stopped in brain with 10 files uncommitted');
  assert.equal(list[0].why, 'Cass said "the merge is not going to work"');
  // The conflict count is the tree\'s, so it stays unattributed even in a crowd.
  const both = notices({ people: [parked('Cass', { dirt: { files: 10, conflicts: 2 }, said: 'nope' }), parked('Dev', { dirt: { files: 10, conflicts: 2 } })] });
  assert.equal(both[0].why, '2 of them conflicted');
});

test('a quote in a notice is capped, cleaned, and cannot carry a path', () => {
  // The same rule as the directory name two hundred lines up, for the same reason: this
  // pane gets screen-shared, and everything in this string came off a terminal the office
  // does not control.
  const secret = '/Users/realname/clients/acme-secret-merger/api/src/index.ts is broken';
  const list = notices({ people: [stalled('Dev', { said: `\u001b[31mcannot read ${secret}\u001b[0m` })] });
  // Capped, so a notice is a sentence and not a paragraph.
  assert.ok(list[0].why.length <= 'said "…"'.length + 36, `${list[0].why.length} cells of reason`);
  assert.doesNotMatch(list[0].why, /\u001b/);
  assert.doesNotMatch(list[0].why, /index\.ts|acme/);
  // What is NOT claimed here: that a quote can never contain a path at all. It can, if an
  // agent prints a short one, and the office has no way to tell a path from a sentence in
  // text it did not write. What the cap buys is that it is a clause rather than a dump,
  // and the alternative -- paraphrasing screen text -- is the office making things up.
});

/* --------------------------------------------------------------------- order */

test('the order is an argument about what can still be saved', () => {
  // A collision can destroy work that already exists. A full head is about to lose
  // reasoning that exists in one place only. Two identical hands are somebody
  // waiting who could be unblocked twice over in one keystroke. A stall already
  // happened and will keep.
  const list = notices({
    people: [
      desk('Dev', { status: 'idle', statusMs: STALL_MS * 2, dirt: { files: 4, conflicts: 0 } }),
      desk('Ada', { status: 'blocked', ask: 'ok?', cwd: '/w/repo' }),
      desk('Bo', { status: 'blocked', ask: 'ok?', cwd: '/w/repo' }),
      desk('Cass', { head: { used: 97 } }),
    ],
  });
  assert.deepEqual(kinds(list), ['collision', 'full', 'same-ask', 'stalled']);
});

test('one desk can be in trouble more than one way', () => {
  const list = notices({
    people: [
      desk('Ada', { cwd: '/w/repo', head: { used: 96 } }),
      desk('Bo', { cwd: '/w/repo' }),
    ],
  });
  assert.deepEqual(kinds(list), ['collision', 'full']);
  assert.ok(list.every((n) => n.ids.includes('w1:Ada')));
});

test('every notice carries the desks it is about, so something can walk you there', () => {
  const list = notices({
    people: [
      desk('Ada', { cwd: '/w/repo' }), desk('Bo', { cwd: '/w/repo' }),
      desk('Cass', { head: { used: 91 } }),
      desk('Dev', { status: 'idle', statusMs: STALL_MS * 2, dirt: { files: 1, conflicts: 0 } }),
    ],
  });
  for (const n of list) {
    assert.ok(Array.isArray(n.ids) && n.ids.length, `${n.kind} named no desks`);
    assert.ok(n.ids.every((id) => typeof id === 'string' && id), `${n.kind} had a blank id`);
    assert.ok(n.text && typeof n.text === 'string', `${n.kind} had no sentence`);
  }
});

test('rubbish in the roster is skipped rather than drawn', () => {
  const list = notices({ people: [null, undefined, {}, { id: '' }, desk('Ada')] });
  assert.deepEqual(list, []);
});

/* ------------------------------------------------------------------ on screen */

// A notice nobody can read is not a feature, and the row it goes on is the one row
// that cannot spare a cell: it already carries the key hints, right-aligned, with the
// message's room reserved before they fill it. So these tests are half "the sentence
// arrives" and half "the frame is still the right shape afterwards".

const people = officeRoster().people;
const screen = (extra) => renderFrame(viewOf({ people, cols: 110, rows: 32, ...extra })).lines.map(stripAnsi).join('\n');
// The key bar, which is the last line of the frame and the only one this file is about.
// The manager's desk and its row in the compact list both draw notice text too, so an
// assertion about the footer has to be an assertion about the footer.
const footer = (extra) => screen(extra).split('\n').at(-1);

// A notice as the module builds one, shaped by hand so these tests do not depend on
// which desks the roster fixture happens to put where.
const said = (text) => ({ kind: 'collision', ids: [people[0].id], text });

test('a notice reaches the footer', () => {
  assert.match(screen({ notices: [said('Ada and Bo are both in herdr-office')] }), /Ada and Bo are both in herdr-office/);
});

test('an empty list leaves the footer exactly as it was', () => {
  // The line shares a slot with the office's own messages, so "no notices" has to be
  // indistinguishable from the office before any of this existed.
  assert.equal(screen({ notices: [] }), screen({ notices: [], noticeAt: 3 }));
  assert.doesNotMatch(screen({ notices: [] }), /next notice|go to the notice/);
});

test('what the office just did outranks what it has noticed', () => {
  // A message is a receipt for a keystroke the reader pressed a second ago. A notice
  // is a standing fact that will still be true on the next frame, so it yields.
  //
  // The footer line on its own, not the whole frame. The manager's desk says the same
  // sentence up on the floor and is supposed to keep saying it: a notice yielding to a
  // message is about one row at the bottom of the screen, and searching the frame for the
  // text would pass or fail on whether that desk happened to be drawn.
  const text = footer({ notices: [said('Ada and Bo are both in herdr-office')], message: 'sent to 6 agents' });
  assert.match(text, /sent to 6 agents/);
  assert.doesNotMatch(text, /both in herdr-office/);
});

test('a count appears once there is more than one thing to say', () => {
  const one = [said('Ada and Bo are both in herdr-office')];
  assert.doesNotMatch(screen({ notices: one }), /1\/1/);
  assert.match(screen({ notices: [...one, said('Cass is 94% full and still working')] }), /1\/2/);
  assert.match(screen({ notices: [...one, said('Cass is 94% full and still working')], noticeAt: 1 }), /2\/2/);
});

test('the key is only offered when it has somewhere to go', () => {
  // On a wide pane, because the footer fills hints in order until it runs out of room
  // and stops: `m` sits behind nine others, so a narrow pane drops it exactly as it
  // already drops F, z, f, r and q. The hint is a bonus on a big display, and the
  // notice itself is the part that is always there.
  const wide = (extra) => screen({ cols: 200, ...extra });
  assert.doesNotMatch(wide({ notices: [] }), /next notice|go to the notice/);
  assert.match(wide({ notices: [said('one thing')] }), /go to the notice/);
  assert.match(wide({ notices: [said('one thing'), said('another')] }), /next notice/);
});

test('the cursor into the list is clamped by the renderer rather than trusted', () => {
  // office.mjs recomputes the list every frame and keeps only an index into it, so a
  // desk finishing between the keypress and the paint can shorten the list under the
  // cursor. Reading past the end would throw inside the repaint, which takes the
  // whole office down rather than dropping a line.
  const list = [said('first thing'), said('second thing')];
  for (const noticeAt of [-5, 0, 1, 2, 99, NaN, undefined, null]) {
    const text = screen({ notices: list, noticeAt });
    assert.match(text, /first thing|second thing/, `noticeAt=${noticeAt} drew nothing`);
  }
});

test('a notice cannot push a line over, at any size', () => {
  // The whole reason the notice reuses the message slot instead of taking a row of
  // its own. One cell too wide wraps the footer, which shoves every row below it
  // down by one and corrupts a terminal the reader did not open.
  const long = [
    said('Ada, Bo and 11 more are all in a-directory-with-a-name-that-somebody-chose-badly'),
    said('Cass is 99% full and still working'),
  ];
  for (const [cols, rows] of SIZES) {
    const { lines } = renderFrame(viewOf({ people, cols, rows, notices: long }));
    assert.equal(lines.length, rows, `${cols}x${rows}: ${lines.length} lines`);
    lines.forEach((line, i) => {
      assert.equal(width(line), cols, `${cols}x${rows}: line ${i} is ${width(line)} cells`);
    });
  }
});
