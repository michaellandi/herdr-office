// Shepherd mode: `F`, and the office walks you to a hand as it goes up.
//
// The job it does is small. Twenty desks is more than a screen, and the useful
// moment is the two seconds after somebody gets stuck, which is exactly when you
// are looking at something else. With shepherd on, the selection is already
// standing at them, so the approve keys are live and the card is theirs.
//
// Three restraints, and they are the whole design.
//
// It moves on a hand GOING UP, not on every poll. A mode that re-derived "who
// should you be looking at" twice a second would take the floor away from you the
// moment you tried to walk it, and you would fight it rather than use it. So it
// remembers which hands were already up and only reacts to new ones.
//
// It never moves you off somebody who needs you. If you are standing at a raised
// hand you are dealing with that person, and the second one can wait the two
// seconds it takes you to press `y`. Otherwise a busy floor would shuffle you
// between stuck agents without your ever finishing one.
//
// It never touches the real terminal focus. `f` yanks your foreground pane on
// purpose because you asked it to; a background mode that did the same would move
// your cursor out from under your hands while you were typing somewhere else. All
// shepherd mode moves is a highlight inside the office.

// True when this office is in no state to be walked around: a modal panel has the
// keyboard, or a drag is in the air. Retargeting the selection under an open assign
// field would silently change who the message is addressed to, which is the worst
// version of a helpful feature.
const occupied = (state) => Boolean(state?.compose || state?.hire || state?.drag?.active || state?.filtering);

export function follow({ people = [], selectedId = null, seen = null, active = false, state = null } = {}) {
  const raised = people.filter((p) => p?.status === 'blocked');
  const now = new Set(raised.map((p) => p.id));
  // The seen set is updated whether or not we move. A hand that went up while a
  // panel was open is not news later on: it has been up for a while by then, and
  // jumping to it when you close the panel would be a jolt with no event behind it.
  if (!active) return { selectedId, seen: now, moved: false };
  const known = seen instanceof Set ? seen : new Set(Array.isArray(seen) ? seen : []);
  if (occupied(state)) return { selectedId, seen: now, moved: false };
  // Already at a raised hand: that person is the job in front of you.
  if (selectedId && now.has(selectedId)) return { selectedId, seen: now, moved: false };
  // First pass after switching the mode on has no history, so everything looks new.
  // That is the right behaviour: you turned it on to be taken to a hand.
  const fresh = seen === null ? raised : raised.filter((p) => !known.has(p.id));
  if (!fresh.length) return { selectedId, seen: now, moved: false };
  // Floor order, which is layout order, so on the rare pass where two hands go up
  // together you end up at the one nearer the top left rather than at whichever the
  // server happened to mention first.
  const target = fresh[0];
  if (target.id === selectedId) return { selectedId, seen: now, moved: false };
  return { selectedId: target.id, seen: now, moved: true, person: target };
}
