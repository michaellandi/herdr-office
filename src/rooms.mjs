// Rooms: which workspace a desk belongs to, said in paint.
//
// A herdr session with three workspaces open is three separate bodies of work,
// and the office was drawing them as one undifferentiated floor. The workspace is
// already the first thing the seating order sorts by, so desks from the same one
// are always adjacent; all that was missing was a way to see where one group ends
// and the next begins.
//
// This is deliberately colour and nothing else. No label rows, no dividers, no
// extra cells anywhere: the floor's geometry decides how many desks fit on a page
// and where the walkway goes, and a room heading inserted between two rows of
// cubicles would have moved every one of those numbers. A cubicle wall painted a
// different shade costs zero cells and cannot wrap a line.
//
// One workspace gets no colours at all. That is the common case, and a legend
// explaining that the only room in the office is the room you are in would be
// worse than nothing.
import { P } from './theme.mjs';

// Six partition-wall shades, then it wraps.
//
// Every `wall` is a permutation of the same three channel values, which is not a
// cute trick: it means all six sit at the same luminance, so no room is brighter
// than its neighbours and none of them reads as the amber of a raised hand. That
// is the one rule the palette has to obey. A raised hand must win the eye in any
// room, so these are muted paint, not signal colours, and the border precedence in
// render.mjs keeps a status colour ahead of a wall colour anyway.
//
// `ink` is the same hue lifted to something legible on the header bar, because
// #3a4658 text on a #1c2331 bar is a rumour rather than a legend.
export const ROOM_TINTS = [
  { wall: '#3a4658', ink: '#a8bdd8' }, // slate: the same wall the office always had
  { wall: '#584a3a', ink: '#d8c8a8' }, // sand
  { wall: '#4a3a58', ink: '#c0a8d8' }, // heather
  { wall: '#3a5850', ink: '#a8d8c8' }, // teal
  { wall: '#583a46', ink: '#d8a8bd' }, // rose
  { wall: '#46583a', ink: '#bdd8a8' }, // olive
];

// Rooms, in floor order: the first workspace you meet walking the floor is room
// one, so the colours run in the same order as the desks do rather than in
// whatever order a hash put them.
//
// Callers pass the WHOLE roster, not the filtered floor. A room's colour is a fact
// about the office, and if it were derived from what happens to be on screen then
// typing three letters into the filter would repaint every wall.
export function assignRooms(people = []) {
  const ids = [];
  const names = new Map();
  for (const person of people) {
    const id = person?.workspaceId || '';
    if (!id) continue;
    if (!names.has(id)) names.set(id, person.workspaceName || id);
    if (!ids.includes(id)) ids.push(id);
  }
  const rooms = new Map();
  // One room is not a room, it is just the office.
  if (ids.length < 2) return rooms;
  ids.forEach((id, i) => {
    const tint = ROOM_TINTS[i % ROOM_TINTS.length];
    // Past six the paint runs out and a shade is used twice. Better than inventing
    // a seventh colour bright enough to compete with a status: the rooms are still
    // in floor order, so two desks sharing a shade are nowhere near each other.
    rooms.set(id, { index: i, number: i + 1, name: names.get(id), wall: tint.wall, ink: tint.ink });
  });
  return rooms;
}

export const roomOf = (rooms, person) =>
  (rooms instanceof Map ? rooms.get(person?.workspaceId || '') : null) || null;

// The wall a desk's cubicle is painted, which is the plain office grey whenever
// there is only one room to be in.
export const roomWall = (rooms, person) => roomOf(rooms, person)?.wall || P.wall;

// The rooms actually represented by the people on screen, for the header legend.
// Assignment comes from the whole office (above) but the legend describes what you
// are looking at: listing a room whose every desk a filter has hidden would be
// pointing at nothing.
export function roomsShown(rooms, people = []) {
  if (!(rooms instanceof Map) || !rooms.size) return [];
  const out = [];
  for (const person of people) {
    const room = roomOf(rooms, person);
    if (room && !out.includes(room)) out.push(room);
  }
  return out.sort((a, b) => a.index - b.index);
}
