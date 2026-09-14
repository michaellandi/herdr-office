// Mouse decoding and the click-versus-drag decision. Pure functions: they take
// a terminal chunk or a hitbox list and return what happened, so the parts that
// can send a real keystroke to a real agent are testable without a terminal.
//
// Reports are SGR (mode 1006) under button-event tracking (mode 1002), which is
// what makes dragging possible: 1000 only reports press and release, so a desk
// could be picked up and dropped with nothing in between to draw.

// \x1b[<button;col;rowM on press and motion, ...m on release. One chunk can
// carry several reports, and while a desk is being dragged it usually does, so
// this returns all of them rather than the first.
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function parseMouse(str) {
  const events = [];
  REPORT.lastIndex = 0;
  let m;
  while ((m = REPORT.exec(str))) {
    const raw = Number(m[1]);
    const wheel = Boolean(raw & 64);
    const motion = Boolean(raw & 32);
    events.push({
      // A release report carries the button bits too, but `m` is what makes it a
      // release; motion is only interesting while a button is held.
      kind: wheel ? 'wheel' : m[4] === 'm' ? 'release' : motion ? 'drag' : 'press',
      button: raw & 3,
      // Terminals count from 1, the grid counts from 0.
      x: Number(m[2]) - 1,
      y: Number(m[3]) - 1,
    });
  }
  return events;
}

// Everything under the pointer, most specific first. A button drawn on top of a
// desk has to beat the desk it is drawn on, or answering an approval would only
// ever select the person.
export function hitTest(hitboxes, x, y) {
  const under = hitboxes.filter((box) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h);
  return under.find((box) => box.action) || under[0] || null;
}

// A desk, ignoring the buttons on it: the drop target for a drag. Dropping on
// somebody's [y] means dropping on their desk, not approving their prompt.
export function deskAt(hitboxes, x, y) {
  return hitboxes.find((box) => !box.action && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) || null;
}

// How far the pointer has to travel before a press stops being a click. Two
// cells is enough to absorb a shaky hand on a trackpad without swallowing a
// deliberate short drag between neighbouring desks.
export const DRAG_SLOP = 2;

export const isDrag = (start, x, y) => Math.abs(x - start.x) + Math.abs(y - start.y) >= DRAG_SLOP;

// The whole click-and-drag decision, as a function of the state and one report.
// It lives here rather than in the event handler because the thing it decides is
// whether to send a keystroke to somebody's real agent, and that is worth being
// able to test without a terminal or a server attached.
//
// `drag` is null when nothing is being carried. Returns the next drag state and
// what the caller should do about it, exactly one of:
//   { type: 'answer', id, action }  a click on a [y] or [n] button
//   { type: 'open',   id }          an ordinary click on a desk
//   { type: 'swap',   from, to }    a desk dropped on a different desk
//   { type: 'select', id }          picked up, nothing to do yet
//   { type: 'cancel' }              put back down where it was
// or null for a report that changes nothing worth redrawing for.
export function nextDrag(drag, ev, hitboxes) {
  // Only the left button drags. A wheel report or a right click is somebody
  // scrolling or reaching for a menu, and picking a desk up under either would
  // be a surprise.
  if (ev.kind === 'wheel' || ev.button !== 0) return { drag, act: null };

  if (ev.kind === 'press') {
    const box = hitTest(hitboxes, ev.x, ev.y);
    if (!box) return { drag: null, act: null };
    // A button answers on press and can never start a drag: an approval is the
    // one irreversible thing on this screen, so it must not double as a handle
    // you can accidentally pick the desk up by.
    if (box.action) return { drag: null, act: { type: 'answer', id: box.id, action: box.action } };
    // Selecting on press is what makes the footer hints and the drag feedback
    // follow the pointer. OPENING the desk waits for the release, because a
    // press that turns into a drag was never a request to open anything: that is
    // the select-versus-act separation.
    return { drag: { id: box.id, start: { x: ev.x, y: ev.y }, overId: box.id, active: false }, act: { type: 'select', id: box.id } };
  }

  if (ev.kind === 'drag') {
    if (!drag) return { drag, act: null };
    if (!drag.active && !isDrag(drag.start, ev.x, ev.y)) return { drag, act: null };
    const over = deskAt(hitboxes, ev.x, ev.y);
    const overId = over ? over.id : null;
    // Nothing moved that anyone can see, so do not ask for a repaint.
    if (drag.active && overId === drag.overId) return { drag, act: null };
    return { drag: { ...drag, active: true, overId }, act: { type: 'select', id: drag.id } };
  }

  if (ev.kind === 'release') {
    if (!drag) return { drag: null, act: null };
    // It never travelled: an ordinary click, so do what a click does.
    if (!drag.active) return { drag: null, act: { type: 'open', id: drag.id } };
    const over = deskAt(hitboxes, ev.x, ev.y);
    // Dropped on carpet, or back where it started: put it down and change
    // nothing. A drag is only a swap when it lands on somebody else.
    if (!over || over.id === drag.id) return { drag: null, act: { type: 'cancel' } };
    return { drag: null, act: { type: 'swap', from: drag.id, to: over.id } };
  }

  return { drag, act: null };
}
