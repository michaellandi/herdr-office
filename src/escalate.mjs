// Escalation: saying it again when a raised hand has gone unanswered.
//
// The first toast is easy, and the office has always sent it. The hard part is the
// second one, because a nagging tool gets muted and a muted tool might as well not
// have shipped. So three rules hold the whole thing up:
//
//   1. One toast, however many hands are up. A floor with six stuck agents does not
//      get six notifications; it gets the longest wait and a count of the rest.
//   2. Backing off, not repeating. A minute, then five, then fifteen, then every
//      fifteen. Somebody who has been waiting an hour is a known problem, not news
//      that needs telling four times a minute.
//   3. Silence while you are looking at it. If the office pane is the focused one,
//      the hand is already on your screen and a toast about it is an insult. The
//      ladder is not consumed while you watch, so looking away with somebody still
//      waiting nudges you then, which is exactly when it is useful again.
import { formatDuration } from './text.mjs';

// How long a hand has to be up before each successive nudge. Past the end of the
// ladder it repeats at the last interval, so the escalation flattens out instead of
// growing without limit or firing forever at fifteen-minute intervals off a
// timestamp nobody is looking at any more.
export const LADDER = [60000, 300000, 900000];

export function nextThreshold(stage = 0) {
  const i = Math.max(0, Math.floor(stage));
  if (i < LADDER.length) return LADDER[i];
  const last = LADDER[LADDER.length - 1];
  // Stage 3 is 30 minutes, stage 4 is 45, and so on: the same interval, added on.
  return last * (i - LADDER.length + 2);
}

// A first sighting is deliberately not escalated. The roster only knows when a
// state was *entered* if it saw it happen, so an agent that was already stuck when
// the office opened has an assumed duration, and "waiting 4 seconds" about somebody
// who has been waiting since lunch is worse than saying nothing. It becomes real the
// moment they change state, which is when it starts to matter anyway.
const eligible = (p) => p?.status === 'blocked' && !p.assumedSince;

// Takes `statusMs` off the people rather than a clock of its own, because the
// roster has just recomputed it and two sources of "how long" that can disagree is
// one too many.
export function escalate({ people = [], state = null, watching = false } = {}) {
  const stuck = people.filter(eligible).sort((a, b) => (b.statusMs ?? 0) - (a.statusMs ?? 0));
  // Nobody waiting, so nothing to remember: the next hand to go up starts at the
  // bottom of the ladder rather than inheriting somebody else's stage.
  if (!stuck.length) return { toast: null, state: null };

  const worst = stuck[0];
  // The stage belongs to a person, not to the office. A different name at the top
  // of the list is a different problem and starts again from one minute.
  const stage = state?.id === worst.id ? Math.max(0, Math.floor(state.stage) || 0) : 0;
  const held = { id: worst.id, stage };
  if ((worst.statusMs ?? 0) < nextThreshold(stage)) return { toast: null, state: held };
  if (watching) return { toast: null, state: held };

  const others = stuck.length - 1;
  return {
    toast: {
      title: `${worst.name} is still waiting`,
      body: others
        ? `${formatDuration(worst.statusMs)} and ${others} other${others > 1 ? 's' : ''} waiting`
        : `${formatDuration(worst.statusMs)} with a hand up, ${worst.kind} in ${worst.id}`,
    },
    state: { id: worst.id, stage: stage + 1 },
  };
}
