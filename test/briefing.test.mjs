// The account the manager gives of a desk, tested away from the panel it is drawn in.
//
// This module exists because of one complaint, recorded at the top of src/briefing.mjs:
// three desks were stopped and the office said one truncated line about one of them. So
// the tests that matter most here are the ones about a crowd. A briefing that quietly
// drops the second and third desk is the original bug wearing a new module, and it would
// look completely fine on a screenshot of the first one.
//
// The other half is about restraint. Every clause here is a fact the office already holds
// and none of them is a cause, which is src/notices.mjs rule 1, and the way that rule gets
// broken is not by somebody writing `gave up because` on purpose. It is by a clause that
// says something the office only half knows: a stale command on a stopped desk, a context
// reading on a desk with plenty of room, half a quote that reads as a paraphrase. There is
// a negative test for each of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, report, wrap, QUOTE_MAX } from '../src/briefing.mjs';
import { width } from '../src/text.mjs';

// A desk as the roster hands one over, spelled out rather than defaulted, for the same
// reason test/notices.test.mjs spells its one out: these tests are about which fields make
// the office speak, so the fields belong in the test and not in a helper's cleverness.
const desk = (name, extra = {}) => ({
  id: `w1:${name}`,
  name,
  kind: 'claude',
  status: 'idle',
  statusMs: 1_800_000,
  assumedSince: false,
  cwd: '/Users/someone/code/herdr-office',
  branch: 'a-manager-who-notices',
  repo: 'herdr-office',
  command: '',
  title: '',
  said: '',
  ask: '',
  dirt: null,
  head: null,
  lastEvent: null,
  ...extra,
});

const said = (kind, ids, text = 'something happened') => ({ kind, ids, text });

// One desk's account, which is what almost every test below wants and what indexing into
// the array by hand makes unreadable.
const one = (person, notice) => brief({ people: [person], notices: [notice] })[0];

/* ------- nothing to say */

test('an empty floor briefs nobody', () => {
  assert.deepEqual(brief({ people: [], notices: [] }), []);
  assert.deepEqual(brief({}), []);
  assert.deepEqual(brief(), []);
});

test('a notice about a desk that is not there is not briefed', () => {
  // Notices and people arrive from two reads of the same floor and a desk can close
  // between them. An account of a desk the office cannot see would have a name and
  // nothing else in it, which reads as the office having lost the desk rather than as
  // the desk having gone.
  const list = brief({ people: [desk('Ada')], notices: [said('stalled', ['w1:Ghost'])] });
  assert.deepEqual(list, []);
});

test('junk in the notice list does not become an account', () => {
  const list = brief({ people: [desk('Ada')], notices: [null, {}, said('stalled', null), said('stalled', ['w1:Ada'])] });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Ada');
});

test('a person with no id is not briefable', () => {
  // The id is the only thing joining a notice to a desk, so a desk without one cannot be
  // the subject of one, and treating it as one would put somebody else's facts under its
  // name.
  assert.deepEqual(brief({ people: [{ name: 'Nameless' }], notices: [said('stalled', [undefined])] }), []);
});

/* ------- the line that says why this desk is on the card */

test('a stall says how long this desk in particular has been stopped', () => {
  // The whole reason the briefing exists. The grouped notice cannot carry a duration,
  // because four desks in one checkout have four clocks and one sentence between them.
  assert.equal(one(desk('Ada'), said('stalled', ['w1:Ada'])).head, 'stopped 30m00s ago');
  const guessed = one(desk('Ada', { assumedSince: true }), said('stalled', ['w1:Ada']));
  assert.equal(guessed.head, 'stopped at least 30m00s ago', 'the same hedge the tile draws as a tilde');
});

test('a stall with no clock behind it says so without printing zeros', () => {
  // `stopped at least 0s ago` is three zeros standing where a real number is about to
  // be. Unreachable from a real stall, which is fifteen minutes old before it is a
  // notice, so this is the contract holding rather than a bug being fixed.
  assert.equal(one(desk('Ada', { statusMs: 0 }), said('stalled', ['w1:Ada'])).head, 'has stopped');
  assert.equal(one(desk('Ada', { statusMs: NaN }), said('stalled', ['w1:Ada'])).head, 'has stopped');
});

test('a collision tells each desk who it is sharing with', () => {
  const people = [desk('Ada'), desk('Bo'), desk('Cass')];
  const list = brief({ people, notices: [said('collision', ['w1:Ada', 'w1:Bo', 'w1:Cass'])] });
  assert.equal(list.length, 3, 'three desks in one notice is three accounts');
  assert.equal(list[0].head, 'sharing herdr-office with Bo and Cass');
  assert.equal(list[1].head, 'sharing herdr-office with Ada and Cass');
  assert.equal(list[2].head, 'sharing herdr-office with Ada and Bo');
});

test('a collision with nobody else in it still says where', () => {
  // Not something notices() produces, since a collision is two desks by definition. It is
  // what a notice whose other desks have closed degrades to, and `sharing herdr-office
  // with` trailing off into nothing is worse than a plain statement of where somebody is.
  assert.equal(one(desk('Ada'), said('collision', ['w1:Ada'])).head, 'working in herdr-office');
  assert.equal(one(desk('Ada', { cwd: '' }), said('collision', ['w1:Ada'])).head, 'working in one checkout');
});

test('a full head says the number the notice was about', () => {
  assert.equal(one(desk('Ada', { head: { used: 94 } }), said('full', ['w1:Ada'])).head, '94% full and still working');
  assert.equal(one(desk('Ada'), said('full', ['w1:Ada'])).head, 'nearly full and still working');
});

test('a shared question names who else is waiting on the answer', () => {
  const people = [desk('Ada', { status: 'blocked' }), desk('Bo', { status: 'blocked' })];
  const list = brief({ people, notices: [said('same-ask', ['w1:Ada', 'w1:Bo'])] });
  assert.equal(list[0].head, 'waiting on the same answer as Bo');
  assert.equal(list[1].head, 'waiting on the same answer as Ada');
  assert.equal(one(desk('Ada', { status: 'blocked' }), said('same-ask', ['w1:Ada'])).head, 'waiting on an answer');
});

test('a notice kind this file has not heard of costs one headline, not the card', () => {
  // A kind added to src/notices.mjs and forgotten here should degrade to the notice's own
  // sentence. A throw would take the whole card down over one new word.
  const account = one(desk('Ada'), said('on-fire', ['w1:Ada'], 'Ada is on fire'));
  assert.equal(account.head, 'Ada is on fire');
  assert.equal(account.kind, 'on-fire', 'and the kind is passed through for the renderer to colour');
});

/* ------- the account under the name */

test('an account reads in the order somebody would tell it', () => {
  const account = one(
    desk('Ada', {
      status: 'idle',
      title: 'apply the security patch',
      lastEvent: { label: 'tests failed', kind: 'broke', ageMs: 1_460_000 },
      dirt: { files: 7, conflicts: 3 },
      // Short enough to survive the cap intact, because the cap has its own test below and
      // this one is about the order.
      said: 'I cannot apply the patch',
    }),
    said('stalled', ['w1:Ada']),
  );
  assert.deepEqual(account.facts, [
    'was doing "apply the security patch"',
    'on a-manager-who-notices in herdr-office',
    'tests failed 24m20s ago',
    '7 uncommitted · 3 conflicted',
    'said "I cannot apply the patch"',
  ]);
});

test('a desk still typing is described in the present tense', () => {
  const working = one(desk('Ada', { status: 'working', title: 'port the tests', command: 'npm test' }), said('full', ['w1:Ada']));
  assert.equal(working.facts[0], 'doing "port the tests"');
  assert.ok(working.facts.includes('running npm test'));
  const done = one(desk('Ada', { status: 'done', title: 'port the tests' }), said('stalled', ['w1:Ada']));
  assert.equal(done.facts[0], 'was doing "port the tests"', 'a finished desk is past tense too');
});

test('facts the office does not have do not become apologies', () => {
  // A desk the office knows one thing about gets one clause. The alternative, which every
  // status panel written in a hurry ends up with, is five rows of `unknown`.
  const account = one(desk('Ada', { branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(account.facts, []);
  assert.equal(account.head, 'stopped 30m00s ago', 'and the headline still stands on its own');
});

test('the checkout falls back to the directory when there is no repo name', () => {
  const account = one(desk('Ada', { repo: '', branch: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(account.facts, ['in herdr-office']);
});

test('the directory is not said twice on a collision', () => {
  // The headline has already named it. Four rows that say `herdr-office` twice is the
  // office padding, and padding is what makes somebody stop reading the card.
  const account = one(desk('Ada', { repo: 'herdr-office' }), said('collision', ['w1:Ada', 'w1:Bo']));
  assert.deepEqual(account.facts, ['on a-manager-who-notices']);
  assert.ok(!account.facts.some((f) => f.includes('in herdr-office')));
});

test('the context reading is not said twice on a full head', () => {
  const account = one(desk('Ada', { head: { used: 94 }, branch: '', repo: '', cwd: '' }), said('full', ['w1:Ada']));
  assert.ok(account.head.includes('94%'));
  assert.deepEqual(account.facts, [], 'the notice is about the number, so the number is said once');
});

test('a context window with room in it is not worth a clause', () => {
  // Every desk has one and most of them are half empty. A summary that spends a row on
  // `31% full` on all seven desks teaches the reader to skip the row the interesting one
  // is on, which costs more than the clause is worth.
  const quiet = one(desk('Ada', { head: { used: 31 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(quiet.facts, []);
  const filling = one(desk('Ada', { head: { used: 60 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(filling.facts, [], 'half full is not news either');
  const hot = one(desk('Ada', { head: { used: 80 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(hot.facts, ['80% full · not much room left']);
  const brimming = one(desk('Ada', { head: { used: 94 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(brimming.facts, ['94% full · about to compact']);
});

test('an empty checkout is worth saying on a desk that stopped', () => {
  // The one count that looks like a non-fact and is not. On a stalled desk it is the
  // difference between work to rescue and nothing to do, and the reader cannot tell
  // `nothing uncommitted` from `nobody asked` unless the office says which.
  const clean = one(desk('Ada', { dirt: { files: 0 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(clean.facts, ['nothing uncommitted']);
  const unread = one(desk('Ada', { dirt: null, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(unread.facts, [], 'a checkout nobody has read yet says nothing at all');
});

test('news outlives the slab it was drawn on', () => {
  // The clause src/roster.mjs stopped deleting an event for. `tests failed 24m ago` over a
  // desk stopped for half an hour is most of the answer, and until the roster kept a faded
  // entry it was gone twelve seconds after the only surface that drew it stopped.
  const old = one(desk('Ada', { lastEvent: { label: 'the build broke', kind: 'broke', ageMs: 5_400_000 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(old.facts, ['the build broke 1h30m ago']);
  const fresh = one(desk('Ada', { lastEvent: { label: 'pushed', kind: 'good', ageMs: 200 }, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(fresh.facts, ['pushed just now'], 'a clock reading of 0s is not news, it is a clock reading');
});

/* ------- their own words */

test('a raised hand is quoted as a question and a stopped desk as a statement', () => {
  // The difference between something you can answer from here and something you have to
  // walk over and look at, which is the only decision the card is really helping with.
  const asking = one(desk('Ada', { status: 'blocked', ask: 'Should I delete the old migration?', said: 'ignore me', branch: '', repo: '', cwd: '' }), said('same-ask', ['w1:Ada']));
  assert.deepEqual(asking.facts, ['asks "Should I delete the old migration?"']);
  const stopped = one(desk('Ada', { status: 'idle', ask: 'ignore me', said: 'I am out of ideas', branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.deepEqual(stopped.facts, ['said "I am out of ideas"']);
});

test('a long quote is cut once and never paraphrased', () => {
  const long = 'x'.repeat(200);
  const account = one(desk('Ada', { said: long, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  const quoted = account.facts[0];
  assert.equal(width(quoted), QUOTE_MAX + 'said ""'.length, 'the cap is on the quote, not on the clause around it');
  assert.ok(quoted.endsWith('…"'), 'and the cut is visible inside the quotation marks');
});

test('the caps on borrowed text are the numbers the office agreed on', () => {
  // Spelled out rather than read off the module, because a test that compares a constant to
  // itself passes at any value and these two are the only thing standing between a card row
  // and however many characters an agent felt like putting in its pane title. 44 is what
  // src/summary.mjs already quotes a screen at, so a desk's own words are the same length
  // wherever you read them in the office.
  assert.equal(QUOTE_MAX, 44);
  const account = one(desk('Ada', { title: 'y'.repeat(200), branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  assert.equal(width(account.facts[0]), 40 + 'was doing ""'.length, 'a pane title is a clause, not an essay');
});

test('nothing off a screen reaches a briefing unsanitized', () => {
  // Everything here is author-controlled text off a terminal. A title is whatever an agent
  // set its pane title to, and a quote is whatever it printed, so both go through the same
  // scrub the rest of the office uses rather than a second idea of what is safe.
  const nasty = '\u001b[31mred\u001b[0m\u0007 and \u0000 a \u{1f600} face → there';
  const account = one(desk('Ada', { title: nasty, said: nasty, branch: '', repo: '', cwd: '' }), said('stalled', ['w1:Ada']));
  for (const fact of account.facts) {
    assert.ok(!/\u001b/.test(fact), `escape survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(fact), `control character survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[\u{1f000}-\u{1ffff}]/u.test(fact), `emoji survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[←-⯿]/.test(fact), `symbol survived: ${JSON.stringify(fact)}`);
  }
  assert.ok(account.facts[0].includes('red'), 'and the readable part of it is kept');
});

/* ------- one desk, two reasons */

test('a desk in two notices is one account that says both', () => {
  // The office's commonest pair is a full head in a shared checkout. Two blocks under one
  // name, repeating the same four facts under two headlines, is how a card stops being
  // readable at four desks.
  const people = [desk('Ada', { status: 'working', head: { used: 94 } }), desk('Bo', { status: 'working' })];
  const list = brief({
    people,
    notices: [said('collision', ['w1:Ada', 'w1:Bo']), said('full', ['w1:Ada'])],
  });
  const ada = list.filter((d) => d.name === 'Ada');
  assert.equal(ada.length, 1, 'once, not twice');
  assert.equal(ada[0].head, 'sharing herdr-office with Bo', 'the more urgent notice is the headline');
  assert.equal(ada[0].kind, 'collision');
  assert.equal(ada[0].facts[0], '94% full and still working', 'and the other one joins the front of the account');
});

test('the order is the notices own order and each desk appears once', () => {
  // The notices arrive already argued about (see the bottom of src/notices.mjs), so the
  // briefing has no opinion of its own to add. Re-sorting here would mean two modules
  // ranking the same floor.
  const people = [desk('Ada'), desk('Bo'), desk('Cass')];
  const list = brief({
    people,
    notices: [said('collision', ['w1:Bo', 'w1:Cass']), said('stalled', ['w1:Ada', 'w1:Bo'])],
  });
  assert.deepEqual(list.map((d) => d.name), ['Bo', 'Cass', 'Ada']);
  assert.equal(list[0].kind, 'collision');
  assert.equal(list[2].kind, 'stalled');
});

test('an account is keyed by the desk and not by its name', () => {
  // Two agents called claude is the default state of a real floor, so the id is what joins
  // a notice to a desk and the name is only what gets printed.
  const people = [desk('claude'), { ...desk('claude'), id: 'w2:claude' }];
  const list = brief({ people, notices: [said('stalled', ['w1:claude', 'w2:claude'])] });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.id), ['w1:claude', 'w2:claude']);
});

test('a desk with no name at all is briefed under its id', () => {
  const list = brief({ people: [{ ...desk('Ada'), name: '' }], notices: [said('stalled', ['w1:Ada'])] });
  assert.equal(list[0].name, 'w1:Ada');
});

/* ------- the whole floor, not just the part of it that needs you */

test('a quiet floor is still a report', () => {
  // The difference between report() and brief() in one test. brief() answers "who needs me",
  // so a floor with nothing noticed about it is an empty answer. A summary of what work is
  // happening on a floor where everybody is fine is not empty, it is "everybody is fine",
  // and that sentence cannot be written by a function that only ever sees the exceptions.
  const list = report({ people: [desk('Ada'), desk('Bo')], notices: [] });
  assert.deepEqual(list.map((d) => d.name), ['Ada', 'Bo']);
  assert.deepEqual(list.map((d) => d.noticed), [false, false]);
  assert.deepEqual(brief({ people: [desk('Ada'), desk('Bo')], notices: [] }), [], 'and the card still says nothing');
});

test('an empty floor reports nobody', () => {
  assert.deepEqual(report({ people: [], notices: [] }), []);
  assert.deepEqual(report({}), []);
  assert.deepEqual(report(), []);
});

test('the desks something is known about come first', () => {
  // The order is still an argument about what matters and notices.mjs has already made it,
  // so the noticed desks keep their own order and the rest follow in the floor's. A reader
  // who stops halfway down has read the half worth reading.
  const people = [desk('Ada'), desk('Bo'), desk('Cass'), desk('Dev')];
  const list = report({ people, notices: [said('stalled', ['w1:Cass', 'w1:Ada'])] });
  assert.deepEqual(list.map((d) => d.name), ['Cass', 'Ada', 'Bo', 'Dev']);
  assert.deepEqual(list.map((d) => d.noticed), [true, true, false, false]);
});

test('a desk in a notice is not reported twice', () => {
  // The bug this ordering makes easy: build the noticed half, then walk the floor and append
  // it all. Ada would appear as a stall and again as an idle desk, which reads as two agents.
  const list = report({ people: [desk('Ada')], notices: [said('collision', ['w1:Ada']), said('stalled', ['w1:Ada'])] });
  assert.equal(list.length, 1);
  assert.equal(list[0].noticed, true);
  assert.equal(list[0].head, 'working in herdr-office', 'and it is the notice that speaks, not the status');
});

test('a quiet desk says what it is doing and how long it has been at it', () => {
  // The clause no notice covers, and the reason the quiet half is worth reporting at all.
  // Fifteen minutes of working is a turn. Three hours of working is something worth knowing
  // that the office has no notice for, because a long turn is not a stall.
  const head = (extra) => report({ people: [desk('Ada', extra)], notices: [] })[0].head;
  assert.equal(head({ status: 'working', statusMs: 11_400_000 }), 'working for 3h10m');
  assert.equal(head({ status: 'idle', statusMs: 120_000 }), 'idle for 2m00s');
  assert.equal(head({ status: 'done', statusMs: 45_000 }), 'done for 45s');
  assert.equal(head({ status: 'blocked', statusMs: 60_000 }), 'waiting on an answer for 1m00s');
  assert.equal(head({ status: 'working', statusMs: 60_000, assumedSince: true }), 'working for at least 1m00s', 'the same hedge the tile draws as a tilde');
});

test('a status the office could not read is not reported as an idle desk', () => {
  // src/render.mjs is emphatic that `unknown` is not proof of completion, and a summary that
  // flattens it to `idle` is the office telling a reader something it does not know.
  assert.equal(report({ people: [desk('Ada', { status: 'unknown' })], notices: [] })[0].head, 'status unknown for 30m00s');
  assert.equal(report({ people: [desk('Ada', { status: 'wat' })], notices: [] })[0].head, 'status unknown for 30m00s', 'and so is a status nobody has heard of');
});

test('a quiet desk with no clock behind it says the status without printing zeros', () => {
  assert.equal(report({ people: [desk('Ada', { status: 'working', statusMs: 0 })], notices: [] })[0].head, 'working');
  assert.equal(report({ people: [desk('Ada', { status: 'working', statusMs: NaN })], notices: [] })[0].head, 'working');
});

test('a quiet desk gets the same account a noticed one does', () => {
  // One set of clauses in this file, not two. A report whose quiet half says less than its
  // noticed half is a report that goes stale the moment somebody adds a clause above.
  const person = desk('Ada', {
    status: 'working',
    title: 'port the tests',
    command: 'npm test',
    lastEvent: { label: 'the build broke', kind: 'broke', ageMs: 1_460_000 },
    dirt: { files: 7 },
    head: { used: 94 },
    said: 'retrying the flaky one',
  });
  assert.deepEqual(report({ people: [person], notices: [] })[0].facts, [
    'doing "port the tests"',
    'on a-manager-who-notices in herdr-office',
    'running npm test',
    'the build broke 24m20s ago',
    '7 uncommitted',
    '94% full · about to compact',
    'said "retrying the flaky one"',
  ]);
});

test('a quiet desk has no notice kind for a renderer to colour by', () => {
  assert.equal(report({ people: [desk('Ada')], notices: [] })[0].kind, null);
  assert.equal(report({ people: [desk('Ada')], notices: [said('stalled', ['w1:Ada'])] })[0].kind, 'stalled');
});

test('a desk with no id is not reportable', () => {
  const list = report({ people: [{ name: 'Nameless' }, desk('Ada')], notices: [] });
  assert.deepEqual(list.map((d) => d.name), ['Ada']);
  assert.deepEqual(report({ people: [null, undefined, desk('Ada')], notices: [] }).map((d) => d.name), ['Ada']);
});

test('two desks sharing an id are one account', () => {
  // Not something a real roster produces, since a pane id is the key it is built on, but the
  // report is about to be read by something that counts the lines, and a floor of seven that
  // reports eight accounts is a summary nobody can check.
  const list = report({ people: [desk('Ada'), { ...desk('Ada'), name: 'Ghost' }], notices: [] });
  assert.deepEqual(list.map((d) => d.name), ['Ada']);
});

test('who is on the floor is the caller question', () => {
  // How the manager stays out of its own report without this module knowing a manager
  // exists. Nothing here filters by kind, name or id shape, so a desk the caller leaves out
  // of `people` is absent from the report even while its notices are still in the list.
  const list = report({ people: [desk('Ada')], notices: [said('stalled', ['w1:Ada', 'w1:Manager'])] });
  assert.deepEqual(list.map((d) => d.name), ['Ada']);
  assert.equal(list[0].head, 'stopped 30m00s ago', 'and the notice it was in still speaks about the desks that are there');
});

test('nothing off a screen reaches a report unsanitized', () => {
  // The quiet half of the report is the half that does not go through brief(), so the scrub
  // is asserted on both. This text is heading for an agent's prompt as well as a card now,
  // and a control character in a prompt is a different kind of problem from one on a grid.
  const nasty = '\u001b[31mred\u001b[0m\u0007 and \u0000 a \u{1f600} face → there';
  const list = report({ people: [desk('Ada', { title: nasty, said: nasty })], notices: [] });
  for (const fact of list[0].facts) {
    assert.ok(!/\u001b/.test(fact), `escape survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(fact), `control character survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[\u{1f000}-\u{1ffff}]/u.test(fact), `emoji survived: ${JSON.stringify(fact)}`);
    assert.ok(!/[←-⯿]/.test(fact), `symbol survived: ${JSON.stringify(fact)}`);
  }
});

/* ------- clauses into rows */

test('clauses pack greedily into rows', () => {
  assert.deepEqual(wrap(['aaaa', 'bbbb'], 11), ['aaaa · bbbb']);
  assert.deepEqual(wrap(['aaaa', 'bbbb'], 10), ['aaaa', 'bbbb'], 'the separator counts towards the room');
  assert.deepEqual(wrap(['aa', 'bb', 'cc'], 8), ['aa · bb', 'cc']);
});

test('no row is wider than the room it was given', () => {
  const facts = ['was doing "apply the security patch"', 'on a-manager-who-notices in herdr-office', 'tests failed 24m20s ago', '7 uncommitted · 3 conflicted', 'said "I cannot apply the patch"'];
  for (const room of [1, 5, 12, 26, 40, 68, 120]) {
    for (const line of wrap(facts, room)) {
      assert.ok(width(line) <= room, `${width(line)} cells in ${room}: ${line}`);
    }
  }
});

test('a clause too long for any row is cut once, not split across two', () => {
  // The same rule the reason on a notice follows. Half a quote ending mid word at a row
  // edge reads as the office having paraphrased somebody, and it is not entitled to.
  const rows = wrap(['x'.repeat(50), 'after'], 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], `${'x'.repeat(9)}…`);
  assert.equal(rows[1], 'after', 'and no sliver of the first clause leaks onto the second row');
});

test('a room with nothing in it gets no rows', () => {
  assert.deepEqual(wrap(['anything'], 0), []);
  assert.deepEqual(wrap(['anything'], -4), []);
  assert.deepEqual(wrap([], 40), []);
  assert.deepEqual(wrap(null, 40), []);
  assert.deepEqual(wrap(['', null, undefined, 'kept'], 40), ['kept'], 'and empty clauses do not become empty rows');
});
