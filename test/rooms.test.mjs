// Rooms. Two things are worth pinning down: that one workspace stays exactly the
// office it always was, and that the colours are a property of the office rather
// than of whoever happens to be on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRooms, roomOf, roomWall, roomsShown, ROOM_TINTS } from '../src/rooms.mjs';
import { P } from '../src/theme.mjs';

const desk = (id, workspaceId, workspaceName = '') => ({ id, workspaceId, workspaceName, status: 'working' });

test('one workspace is not a room, it is just the office', () => {
  // The common case. Painting a wall to tell you that the only room in the building
  // is the one you are in, and printing a legend for it, would be noise on every
  // single frame, so it has to be nothing at all.
  const people = [desk('w1:p1', 'w1', 'main'), desk('w1:p2', 'w1', 'main')];
  const rooms = assignRooms(people);
  assert.equal(rooms.size, 0);
  assert.equal(roomOf(rooms, people[0]), null);
  assert.equal(roomWall(rooms, people[0]), P.wall, 'the wall is the wall it always was');
  assert.deepEqual(roomsShown(rooms, people), []);
});

test('rooms are numbered in floor order', () => {
  // Floor order rather than a hash of the id, so walking the floor walks the
  // colours in order and two rooms next to each other are never the same shade.
  const people = [
    desk('w1:p1', 'w1', 'main'),
    desk('w1:p2', 'w1', 'main'),
    desk('w2:p1', 'w2', 'web-app'),
    desk('w3:p1', 'w3', 'notes'),
  ];
  const rooms = assignRooms(people);
  assert.equal(rooms.size, 3);
  assert.deepEqual([...rooms.keys()], ['w1', 'w2', 'w3']);
  assert.deepEqual([...rooms.values()].map((r) => r.number), [1, 2, 3]);
  assert.deepEqual([...rooms.values()].map((r) => r.name), ['main', 'web-app', 'notes']);
  assert.equal(roomWall(rooms, people[0]), ROOM_TINTS[0].wall);
  assert.equal(roomWall(rooms, people[2]), ROOM_TINTS[1].wall);
  // Room one keeps the office's own wall colour, so adding a second workspace does
  // not repaint the desks that were already there.
  assert.equal(ROOM_TINTS[0].wall, P.wall);
  const walls = new Set([...rooms.values()].map((r) => r.wall));
  assert.equal(walls.size, 3, 'no two rooms on this floor share a wall');
});

test('the paint runs out rather than getting louder', () => {
  // Seven workspaces, six colours. The seventh reuses the first, which is fine
  // because they are six desks apart, and much better than inventing a shade bright
  // enough to be mistaken for a raised hand.
  const people = new Array(8).fill(0).map((_, i) => desk(`w${i + 1}:p1`, `w${i + 1}`, `ws${i + 1}`));
  const rooms = assignRooms(people);
  assert.equal(rooms.size, 8);
  assert.equal(rooms.get('w7').wall, rooms.get('w1').wall);
  assert.equal(rooms.get('w8').wall, rooms.get('w2').wall);
  // Never the amber of somebody waiting on you, whichever room you are in.
  for (const room of rooms.values()) assert.notEqual(room.wall.toLowerCase(), '#ffc14d');
});

test('a filter does not repaint the walls', () => {
  // The whole reason assignment takes the full roster: if it took the people on
  // screen then typing three letters would move every colour by one, and the legend
  // would be describing an office that only exists while you hold the key down.
  const all = [desk('w1:p1', 'w1', 'main'), desk('w2:p1', 'w2', 'web-app'), desk('w3:p1', 'w3', 'notes')];
  const rooms = assignRooms(all);
  const onScreen = [all[2]];
  assert.equal(roomWall(rooms, onScreen[0]), ROOM_TINTS[2].wall, 'still the third room');
  // The legend, though, describes what you are looking at: a room whose every desk
  // is hidden is not a room you can see.
  assert.deepEqual(roomsShown(rooms, onScreen).map((r) => r.number), [3]);
  assert.deepEqual(roomsShown(rooms, all).map((r) => r.number), [1, 2, 3]);
});

test('an unnamed workspace still gets a room', () => {
  const people = [desk('w1:p1', 'w1', ''), desk('w2:p1', 'w2', 'notes')];
  const rooms = assignRooms(people);
  // Falls back to the workspace id, which is at least something you can match
  // against the `where` line on the card.
  assert.equal(rooms.get('w1').name, 'w1');
});

test('nonsense cannot assign a room', () => {
  assert.equal(assignRooms().size, 0);
  assert.equal(assignRooms([null, undefined, {}]).size, 0);
  // A desk with no workspace at all is in no room, rather than in a room called
  // empty string along with every other homeless desk.
  const rooms = assignRooms([desk('a', ''), desk('b', 'w2'), desk('c', 'w3')]);
  assert.equal(rooms.size, 2);
  assert.equal(roomOf(rooms, { workspaceId: '' }), null);
  assert.equal(roomOf(null, { workspaceId: 'w2' }), null);
  assert.equal(roomWall(undefined, { workspaceId: 'w2' }), P.wall);
  assert.deepEqual(roomsShown(null, []), []);
});
