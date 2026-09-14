// Seating. The floor has to be laid out in the same order the real panes are,
// or a drag that swaps two panes changes the session and leaves the picture
// looking identical, which reads as a bug in the swap rather than in the sort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../src/roster.mjs';

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
    { workspace_id: 'wB', label: 'second', number: 2 },
    { workspace_id: 'wA', label: 'first', number: 1 },
  ]);
  roster.setTabs([
    { tab_id: 'wA:t2', label: 'later', number: 2 },
    { tab_id: 'wA:t1', label: 'earlier', number: 1 },
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
