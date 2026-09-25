// Seating. The floor has to be laid out in the same order the real panes are,
// or a drag that swaps two panes changes the session and leaves the picture
// looking identical, which reads as a bug in the swap rather than in the sort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster, EVENT_MS } from '../src/roster.mjs';

const agent = (pane_id, extra = {}) => ({
  pane_id,
  agent: 'claude',
  agent_status: 'working',
  workspace_id: pane_id.split(':')[0],
  state_change_seq: 1,
  ...extra,
});

const seatedIds = (roster) => roster.people.map((p) => p.id);

test('with no layout, seating is pane id order', () => {
  // The order the office has always used, and the one demo mode still gets.
  const roster = new Roster();
  roster.update([agent('w1:p10'), agent('w1:p2'), agent('w1:p1')]);
  assert.deepEqual(seatedIds(roster), ['w1:p1', 'w1:p2', 'w1:p10']);
});

test('desks follow the panes: workspace, then tab, then reading order', () => {
  const roster = new Roster();
  roster.setWorkspaces([
    { workspace_id: 'wA', label: 'first', number: 1 },
    { workspace_id: 'wB', label: 'second', number: 2 },
  ]);
  // Listed in the order the bars show them, which is the order that seats a desk.
  roster.setTabs([
    { tab_id: 'wA:t1', label: 'earlier', number: 1 },
    { tab_id: 'wA:t2', label: 'later', number: 2 },
    { tab_id: 'wB:t1', label: 'other room', number: 1 },
  ]);
  roster.setLayouts([
    {
      workspace_id: 'wA',
      tab_id: 'wA:t1',
      // Deliberately out of reading order in the payload: bottom-left, then
      // top-right, then top-left.
      panes: [
        { pane_id: 'wA:p3', rect: { x: 0, y: 20, width: 80, height: 20 } },
        { pane_id: 'wA:p2', rect: { x: 80, y: 0, width: 80, height: 20 } },
        { pane_id: 'wA:p1', rect: { x: 0, y: 0, width: 80, height: 20 } },
      ],
    },
    { workspace_id: 'wA', tab_id: 'wA:t2', panes: [{ pane_id: 'wA:p9', rect: { x: 0, y: 0, width: 160, height: 40 } }] },
    { workspace_id: 'wB', tab_id: 'wB:t1', panes: [{ pane_id: 'wB:p1', rect: { x: 0, y: 0, width: 160, height: 40 } }] },
  ]);
  // Fed in an order that matches nothing, so only the seating can produce the
  // expected result.
  roster.update([agent('wB:p1'), agent('wA:p9'), agent('wA:p2'), agent('wA:p3'), agent('wA:p1')]);
  assert.deepEqual(seatedIds(roster), ['wA:p1', 'wA:p2', 'wA:p3', 'wA:p9', 'wB:p1']);
});

test('desks follow the tab bar, not the numbers the tabs answer to', () => {
  // The bug this exists to stop coming back. `number` is the shortcut you reach a
  // tab by and it is baked into the tab's id, so a tab dragged to the front of the
  // bar keeps the number it was created with. Seating by number therefore drew the
  // office in the order the tabs were made, which matched the bar until the day
  // somebody moved one and then silently never matched it again.
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  const tabs = [
    { tab_id: 'w1:tE', label: 'office', number: 14 },
    { tab_id: 'w1:t7', label: 'plugin', number: 7 },
    { tab_id: 'w1:t1', label: 'notes', number: 1 },
  ];
  roster.setTabs(tabs);
  roster.setLayouts(tabs.map((tab, i) => ({
    workspace_id: 'w1',
    tab_id: tab.tab_id,
    panes: [{ pane_id: `w1:p${i + 1}`, rect: { x: 0, y: 0, width: 80, height: 40 } }],
  })));
  const agents = [agent('w1:p1'), agent('w1:p2'), agent('w1:p3')];
  roster.update(agents);
  assert.deepEqual(seatedIds(roster), ['w1:p1', 'w1:p2', 'w1:p3'], 'the bar reads 14, 7, 1 and so must the floor');

  // And it follows a move, rather than only being right the first time.
  roster.setTabs([tabs[2], tabs[0], tabs[1]]);
  roster.setLayouts([
    { workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p3', rect: { x: 0, y: 0 } }] },
    { workspace_id: 'w1', tab_id: 'w1:tE', panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0 } }] },
    { workspace_id: 'w1', tab_id: 'w1:t7', panes: [{ pane_id: 'w1:p2', rect: { x: 0, y: 0 } }] },
  ]);
  roster.update(agents);
  assert.deepEqual(seatedIds(roster), ['w1:p3', 'w1:p1', 'w1:p2']);
});

// The two properties below are the invariant the tab-order bug broke, written as
// relations between two runs rather than as an expected order. An expected order is a
// second copy of the sort, and it agreed with the sort for as long as the bug was
// there. What did not agree was the room: renumbering the tabs moved desks that had
// not moved, and moving a tab left them where they were. So these say what has to stay
// true of any seating rather than what this one produces, which is what makes them
// worth more than the case they were written for.
const seatFloor = (tabOrder, numbers) => {
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  roster.setTabs(tabOrder.map((t) => ({ tab_id: `w1:t${t}`, label: `tab ${t}`, number: numbers[t] })));
  roster.setLayouts(tabOrder.map((t) => ({
    workspace_id: 'w1',
    tab_id: `w1:t${t}`,
    panes: [{ pane_id: `w1:p${t}`, rect: { x: 0, y: 0, width: 80, height: 40 } }],
  })));
  roster.update(tabOrder.map((t) => agent(`w1:p${t}`)));
  return seatedIds(roster);
};

test('what a tab is numbered cannot move anybody', () => {
  // Nobody moved desks, so nobody may move on the floor. Every one of these numberings
  // is one a real session can hand us: gaps from closed tabs, an order that disagrees
  // with the bar, and the one that happens to agree, which is the reason the bug hid.
  const bar = ['a', 'b', 'c', 'd'];
  const seated = seatFloor(bar, { a: 1, b: 2, c: 3, d: 4 });
  for (const numbers of [
    { a: 4, b: 3, c: 2, d: 1 },
    { a: 14, b: 7, c: 1, d: 4 },
    { a: 9, b: 9, c: 9, d: 9 },
    { a: 0, b: 100, c: 2, d: 3 },
  ]) {
    assert.deepEqual(seatFloor(bar, numbers), seated, `renumbering moved a desk: ${JSON.stringify(numbers)}`);
  }
});

test('moving a tab moves its desk, and only by as much as the tab moved', () => {
  // The other half, and the half the bug actually failed: a floor that ignores the
  // numbers could equally be ignoring the bar. Each permutation of the bar has to come
  // back as the same permutation of the floor, with the numbers held fixed and
  // deliberately disagreeing so they cannot be what produces the answer.
  const numbers = { a: 14, b: 7, c: 1, d: 4 };
  for (const bar of [
    ['a', 'b', 'c', 'd'],
    ['d', 'c', 'b', 'a'],
    ['c', 'a', 'd', 'b'],
    ['b', 'd', 'a', 'c'],
  ]) {
    assert.deepEqual(seatFloor(bar, numbers), bar.map((t) => `w1:p${t}`), `the floor did not follow the bar: ${bar}`);
  }
});

test('a server that lists no tabs falls back to the numbers rather than to nothing', () => {
  // An index only means anything relative to the list it came from, so an empty
  // list is not an order: it is no answer. Treating it as one would flatten every
  // tab onto the same rank and reshuffle the whole floor on a dropped call.
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  roster.setTabs([{ tab_id: 'w1:t2', label: 'second', number: 2 }, { tab_id: 'w1:t1', label: 'first', number: 1 }]);
  roster.setTabs([]);
  const layouts = [
    { workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0 } }] },
    { workspace_id: 'w1', tab_id: 'w1:t2', panes: [{ pane_id: 'w1:p2', rect: { x: 0, y: 0 } }] },
  ];
  roster.setLayouts(layouts);
  roster.update([agent('w1:p1'), agent('w1:p2')]);
  // The last order that was actually reported, which is the listed one and not the
  // numbered one.
  assert.deepEqual(seatedIds(roster), ['w1:p2', 'w1:p1']);

  // With nothing ever reported, the numbers are all there is to go on.
  const cold = new Roster();
  cold.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  cold.tabNumbers.set('w1:t1', 1);
  cold.tabNumbers.set('w1:t2', 2);
  cold.setLayouts(layouts);
  cold.update([agent('w1:p2'), agent('w1:p1')]);
  assert.deepEqual(seatedIds(cold), ['w1:p1', 'w1:p2']);
});

test('a swap in the layout moves the desk', () => {
  // The actual point. Same panes, same tab; the geometry of two of them trades
  // places, and the floor has to trade with it.
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  roster.setTabs([{ tab_id: 'w1:t1', label: 'work', number: 1 }]);
  const layout = (leftPane, rightPane) => [
    {
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      panes: [
        { pane_id: leftPane, rect: { x: 0, y: 0, width: 80, height: 40 } },
        { pane_id: rightPane, rect: { x: 80, y: 0, width: 80, height: 40 } },
      ],
    },
  ];
  const agents = [agent('w1:p1'), agent('w1:p2')];

  roster.setLayouts(layout('w1:p1', 'w1:p2'));
  roster.update(agents);
  assert.deepEqual(seatedIds(roster), ['w1:p1', 'w1:p2']);
  assert.equal(roster.find('w1:p1').name, 'Ada');

  roster.setLayouts(layout('w1:p2', 'w1:p1'));
  roster.update(agents);
  assert.deepEqual(seatedIds(roster), ['w1:p2', 'w1:p1']);
  // Names go by seat, so the front desk is still Ada; a different person is now
  // sitting at it.
  assert.equal(roster.find('w1:p2').name, 'Ada');
});

test('a pane the layout does not mention sits at the back', () => {
  // Better than putting it at the front, where an unplaced desk would shove
  // everybody along and rename the whole office.
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  roster.setTabs([{ tab_id: 'w1:t1', label: 'work', number: 1 }]);
  roster.setLayouts([
    { workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p5', rect: { x: 0, y: 0, width: 160, height: 40 } }] },
  ]);
  roster.update([agent('w1:p1'), agent('w1:p5')]);
  assert.deepEqual(seatedIds(roster), ['w1:p5', 'w1:p1']);
});

test('stale layouts are dropped, not accumulated', () => {
  const roster = new Roster();
  roster.setLayouts([{ workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0 } }] }]);
  roster.setLayouts([]);
  assert.equal(roster.seats.size, 0);
});

test('a layout with no rects does not throw', () => {
  // Older servers, and a snapshot that arrived mid-resize.
  const roster = new Roster();
  roster.setLayouts([{ workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1' }, {}] }]);
  roster.update([agent('w1:p1')]);
  assert.deepEqual(seatedIds(roster), ['w1:p1']);
});

test('a command lives on a desk only while that desk is working', () => {
  // The point of the throttle upstream is that a desk is only asked what it is
  // running every few seconds, so the answer has to survive polls in between. The
  // point of forgetting it is that a stale `npm test` on a dozing monitor is a lie.
  const roster = new Roster();
  roster.update([agent('w1:p1')]);
  assert.equal(roster.find('w1:p1').command, null);
  assert.equal(roster.commandAge('w1:p1'), Infinity);

  roster.setCommand('w1:p1', 'npm test');
  assert.equal(roster.find('w1:p1').command, 'npm test');
  assert.ok(roster.commandAge('w1:p1') < 1000);
  roster.update([agent('w1:p1')]);
  assert.equal(roster.find('w1:p1').command, 'npm test', 'a poll must not blank the monitor');

  // "herdr could not name it" is an answer, and it is remembered as one: the age
  // resets, so the same quiet desk is not re-read on every single poll.
  roster.setCommand('w1:p1', null);
  assert.equal(roster.find('w1:p1').command, null);
  assert.ok(roster.commandAge('w1:p1') < 1000);

  roster.setCommand('w1:p1', 'cargo build');
  roster.update([agent('w1:p1', { agent_status: 'idle' })]);
  assert.equal(roster.find('w1:p1').command, null, 'an idle desk is not running anything');
  assert.equal(roster.commandAge('w1:p1'), Infinity);
});

test('how full a head is belongs to the person, and leaves with them', () => {
  // The other way round from the pile of paper below, and for a reason worth keeping
  // straight: a checkout is a place and two desks in it share everything about it, but a
  // context window is the agent's own and two agents in one directory have nothing to do
  // with each other's.
  const roster = new Roster();
  roster.update([agent('w1:p1', { cwd: '/repo' }), agent('w1:p2', { cwd: '/repo' })]);
  assert.equal(roster.find('w1:p1').head, null);
  assert.equal(roster.headAge('w1:p1'), Infinity);

  roster.setHead('w1:p1', { used: 65, model: 'opus', session: 'abc' });
  assert.deepEqual(roster.find('w1:p1').head, { used: 65, model: 'opus', session: 'abc' });
  assert.equal(roster.find('w1:p2').head, null, 'a reading is not shared with the desk next door');
  assert.ok(roster.headAge('w1:p1') < 1000);
  // Handed back whole, because the next reading is only news in comparison with this one.
  assert.deepEqual(roster.head('w1:p1'), { used: 65, model: 'opus', session: 'abc' });

  // Survives a poll. The screen behind it is read every few seconds and the floor is
  // redrawn twice a second, so a reading that did not outlive a poll would flicker.
  roster.update([agent('w1:p1', { cwd: '/repo' }), agent('w1:p2', { cwd: '/repo' })]);
  assert.equal(roster.find('w1:p1').head?.used, 65);
  // And a change of state, unlike the ask and the running command: an agent that stops
  // working does not forget what it was told.
  roster.update([agent('w1:p1', { cwd: '/repo', agent_status: 'idle' })]);
  assert.equal(roster.find('w1:p1').head?.used, 65);

  // "the screen said nothing about it" is recorded as an answer, the same way a null
  // command and an unreadable checkout are, and it takes the tint off the monitor: a
  // desk the office can no longer vouch for must stop claiming a number.
  roster.setHead('w1:p1', null);
  assert.equal(roster.find('w1:p1').head, null);
  assert.ok(roster.headAge('w1:p1') < 1000);

  // Nonsense is dropped rather than drawn, and a real reading is pinned to the scale it
  // is drawn on: a monitor frame has four bands and no room for a hundred and ten.
  roster.setHead('w1:p1', { used: 'most of it' });
  assert.equal(roster.find('w1:p1').head, null);
  roster.setHead('w1:p1', { used: 110 });
  assert.equal(roster.find('w1:p1').head.used, 100);
  roster.setHead('w1:p1', { used: -5 });
  assert.equal(roster.find('w1:p1').head.used, 0);
  roster.setHead('w1:p1', { used: 64.6 });
  assert.equal(roster.find('w1:p1').head.used, 65);

  // And when the desk goes, the reading goes with it. A pane id can come back around,
  // and inheriting a stale window from whoever sat here last would be one desk reporting
  // another's number.
  roster.update([agent('w1:p2', { cwd: '/repo' })]);
  assert.equal(roster.headAge('w1:p1'), Infinity);
  assert.equal(roster.head('w1:p1'), null);
});

test('a pile of paper belongs to the checkout, not to the person', () => {
  // Uncommitted work is a fact about a working directory, so it is cached against one
  // and every desk sitting in that directory gets it. Two agents in one checkout really
  // do share a pile of paper, and being able to see that is worth having.
  const roster = new Roster();
  roster.update([agent('w1:p1', { cwd: '/repo' }), agent('w1:p2', { cwd: '/repo' }), agent('w1:p3', { cwd: '/elsewhere' })]);
  assert.equal(roster.find('w1:p1').dirt, null);
  assert.equal(roster.dirtAge('/repo'), Infinity);

  roster.setDirt('/repo', { files: 12, conflicts: 1 });
  assert.deepEqual(roster.find('w1:p1').dirt, { files: 12, conflicts: 1 });
  assert.deepEqual(roster.find('w1:p2').dirt, { files: 12, conflicts: 1 }, 'the other desk in the same tree');
  assert.equal(roster.find('w1:p3').dirt, null, 'and nobody outside it');
  assert.ok(roster.dirtAge('/repo') < 1000);

  // Survives a poll, like a command does: the checkout is only read every few seconds,
  // so the answer has to outlive the polls in between.
  roster.update([agent('w1:p1', { cwd: '/repo' })]);
  assert.deepEqual(roster.find('w1:p1').dirt, { files: 12, conflicts: 1 });

  // A clean tree is zero, and zero is not the same as unknown: the card says "nothing
  // uncommitted" for one and draws no row at all for the other.
  roster.setDirt('/repo', { files: 0, conflicts: 0 });
  assert.deepEqual(roster.find('w1:p1').dirt, { files: 0, conflicts: 0 });

  // "git would not say" is recorded as an answer too, or a directory that is not a
  // repository costs a subprocess on every pass forever.
  roster.setDirt('/repo', null);
  assert.equal(roster.find('w1:p1').dirt, null);
  assert.ok(roster.dirtAge('/repo') < 1000);

  // Nonsense from anywhere is dropped rather than drawn: a count is a whole number of
  // things, and a card is not the place to find out it was a string.
  roster.setDirt('/repo', { files: 'lots' });
  assert.equal(roster.find('w1:p1').dirt, null);
  roster.setDirt('/repo', { files: -4, conflicts: -1 });
  assert.deepEqual(roster.find('w1:p1').dirt, { files: 0, conflicts: 0 });
  roster.setDirt('/repo', { files: 3.7 });
  assert.deepEqual(roster.find('w1:p1').dirt, { files: 3, conflicts: 0 });

  // A pane with no directory has nothing to key on, and asking about '' would be asking
  // about the office's own working directory.
  roster.setDirt('', { files: 5 });
  assert.equal(roster.dirt.has(''), false);
});

test('news over a desk puts itself away', () => {
  // News is not state: nothing downstream will ever tell us the tests stopped
  // having passed, so the only thing that clears it is the clock. A fake one here,
  // because the alternative is a test that sleeps for twelve seconds.
  let now = 1000;
  const roster = new Roster(() => now);
  roster.update([agent('w1:p1')]);
  assert.equal(roster.find('w1:p1').event, null);

  roster.setEvent('w1:p1', 'tests passed', 'good');
  assert.deepEqual(roster.find('w1:p1').event, { label: 'tests passed', kind: 'good' });
  // A poll in between must not wipe it, the same as a command.
  roster.update([agent('w1:p1')]);
  assert.deepEqual(roster.find('w1:p1').event, { label: 'tests passed', kind: 'good' });

  // An empty label is not news and must not blank real news either.
  roster.setEvent('w1:p1', '', 'broke');
  assert.deepEqual(roster.find('w1:p1').event, { label: 'tests passed', kind: 'good' });
  // A kind nobody defined still draws: the theme falls back rather than throwing.
  roster.setEvent('w1:p2', 'committed');
  assert.equal(roster.events.get('w1:p2').kind, 'good');

  assert.equal(roster.expireEvents(), false, 'nothing is stale yet');
  now += EVENT_MS - 1;
  assert.equal(roster.expireEvents(), false, 'not stale until it is');
  now += 2;
  assert.equal(roster.expireEvents(), true, 'and then it goes');
  assert.equal(roster.find('w1:p1').event, null);
  assert.equal(roster.events.size, 0);
  assert.equal(roster.expireEvents(), false, 'an empty wall reports no change');
});

/* -------------------------------------------------------------------- the day book */

// Reopening the office used to reset every desk's clock, so an agent that had been
// blocked since breakfast was drawn as having been blocked for one second. The book keeps
// those clocks for the day, and what follows is the rule that keeps it honest: a saved
// clock is believed only where herdr can prove nothing happened to the desk in the
// meantime, and thrown away everywhere else. The office may under-report time it did not
// watch. It must never over-report it.
const BREAKFAST = Date.parse('2026-09-25T09:00:00Z');
const ELEVEN = Date.parse('2026-09-25T11:00:00Z');

// The office shut and opened again: a book from the first run handed to a second one two
// hours later, which then takes its first look at the floor.
const reopenWith = (book, agents, savedAt = ELEVEN - 2000) => {
  const roster = new Roster(() => ELEVEN);
  roster.restoreStates(book, savedAt, ELEVEN);
  const blocked = roster.update(agents);
  return { roster, blocked, person: roster.people[0] || null, away: roster.awayReport() };
};

const stuckSince = (at, seq = 7) => [{ id: 'w1:p1', status: 'blocked', since: at, seq, assumed: false }];

test('a desk nobody touched while the office was shut keeps its clock', () => {
  const { person, away } = reopenWith(stuckSince(BREAKFAST), [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
  ]);
  assert.equal(person.since, BREAKFAST);
  assert.equal(person.statusMs, ELEVEN - BREAKFAST, 'two hours stuck, not two seconds');
  // And it is not a guess, so the floor must not apologise for it with a `~`.
  assert.equal(person.assumedSince, false);
  assert.deepEqual([away.held, away.missed, away.gone], [1, 0, 0]);
});

test('a sequence number that moved is proof of a transition nobody watched', () => {
  const { person, away } = reopenWith(stuckSince(BREAKFAST), [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 8 }),
  ]);
  // Still blocked, but not the same block: herdr counted a change in between and the
  // office has no idea when it happened. So this desk is treated as one it has never met.
  assert.equal(person.since, ELEVEN);
  assert.equal(person.assumedSince, true);
  assert.equal(person.firstSeen, true, 'first sighting of this state, whatever the book said');
  assert.deepEqual([away.held, away.missed, away.gone], [0, 1, 0]);
});

test('a line nobody can check is not believed', () => {
  for (const [what, extra] of [
    ['the status disagrees with the book', { agent_status: 'working', state_change_seq: 7 }],
    ['there is no sequence number to check against', { agent_status: 'blocked', state_change_seq: null }],
  ]) {
    const { person } = reopenWith(stuckSince(BREAKFAST), [agent('w1:p1', extra)]);
    assert.equal(person.since, ELEVEN, what);
    assert.equal(person.assumedSince, true, what);
  }
});

test('a clock from the future is a machine that changed its mind about the time', () => {
  // Nothing here says which of the two readings was wrong, so neither is trusted.
  const { person } = reopenWith(stuckSince(ELEVEN + 60_000), [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
  ]);
  assert.equal(person.since, ELEVEN);
  assert.equal(person.assumedSince, true);
});

test('a clock that was already a guess is still a guess after a reopen', () => {
  // Keeping a duration makes it survive, not makes it true. A desk first met mid-block
  // has an unknown start time and coming back to it does not discover one.
  const { person } = reopenWith([{ id: 'w1:p1', status: 'blocked', since: BREAKFAST, seq: 7, assumed: true }], [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
  ]);
  assert.equal(person.since, BREAKFAST, 'the clock is kept');
  assert.equal(person.assumedSince, true, 'and it is still only a lower bound');
});

test('a hand that was already up when the office reopened does not ring the bell again', () => {
  // The toast means somebody has just started waiting on you. This one has been waiting
  // two hours, and announcing it on every reopen is how a notification gets muted.
  const { blocked } = reopenWith(stuckSince(BREAKFAST), [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
  ]);
  assert.deepEqual(blocked, []);
});

test('the report separates what held, what moved and what has gone', () => {
  const { away } = reopenWith(
    [
      { id: 'w1:p1', status: 'blocked', since: BREAKFAST, seq: 7, assumed: false },
      { id: 'w1:p2', status: 'working', since: BREAKFAST, seq: 3, assumed: false },
      { id: 'w1:p3', status: 'idle', since: BREAKFAST, seq: 1, assumed: false },
    ],
    [
      agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
      agent('w1:p2', { agent_status: 'idle', state_change_seq: 4 }),
      agent('w1:p9', { agent_status: 'working', state_change_seq: 1 }),
    ],
  );
  // p1 held, p2 moved, p3 is gone, and p9 is new and so is in nobody's book.
  assert.deepEqual([away.held, away.missed, away.gone], [1, 1, 1]);
  assert.equal(away.shut, 2000, 'how long the office was shut, from the file it wrote');
  assert.equal(away.kept, 3);
});

test('what we missed is news, and news is only news once', () => {
  const { roster, away } = reopenWith(stuckSince(BREAKFAST), [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
  ]);
  assert.ok(away);
  assert.equal(roster.awayReport(), null);
});

test('a book nobody could use leaves no report to give', () => {
  // Not the same as a report saying nothing happened: there was nothing to check.
  const roster = new Roster(() => ELEVEN);
  for (const book of [null, undefined, [], 'punchclock.json', [{ id: 'w1:p1' }], [{ status: 'idle' }]]) {
    assert.equal(roster.restoreStates(book, ELEVEN - 2000, ELEVEN), 0, JSON.stringify(book));
  }
  roster.update([agent('w1:p1')]);
  assert.equal(roster.awayReport(), null);
});

test('the book keeps only the lines that can be checked later', () => {
  const roster = new Roster(() => BREAKFAST);
  roster.update([
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
    agent('w1:p2', { agent_status: 'working', state_change_seq: null }),
  ]);
  const book = roster.snapshotStates();
  // p2 is left out: with no sequence number nothing could ever confirm it, so writing it
  // down buys exactly what leaving it out buys, one poll later and via the filesystem.
  assert.deepEqual(
    book,
    [{ id: 'w1:p1', status: 'blocked', since: BREAKFAST, seq: 7, assumed: true }],
  );
  // And reading the book must not change it, because it is written on a timer.
  assert.deepEqual(roster.snapshotStates(), book);
});

test('a book survives the round trip a real restart puts it through', () => {
  // The clocks go out through JSON and a file, so the shapes have to be ones JSON keeps.
  const first = new Roster(() => BREAKFAST);
  first.update([
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
    agent('w1:p2', { agent_status: 'working', state_change_seq: 3 }),
  ]);
  const book = JSON.parse(JSON.stringify({ desks: first.snapshotStates() })).desks;

  const { roster } = reopenWith(book, [
    agent('w1:p1', { agent_status: 'blocked', state_change_seq: 7 }),
    agent('w1:p2', { agent_status: 'working', state_change_seq: 3 }),
  ]);
  for (const person of roster.people) {
    assert.equal(person.since, BREAKFAST, `${person.id} lost its clock`);
    assert.equal(person.statusMs, ELEVEN - BREAKFAST, person.id);
  }
});
