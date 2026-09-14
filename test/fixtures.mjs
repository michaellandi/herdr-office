// Shared setup. Everything here exists to make the awkward cases the default:
// the roster below has a stuck desk with a short ask, a stuck desk whose ask is
// far longer than its bubble, a stuck desk with no ask at all yet, an unnamed
// tab, and a tab name that overflows its card. A test that only ever renders a
// tidy office proves nothing, because a tidy office is not what breaks.
import { Roster } from '../src/roster.mjs';
import { stripAnsi } from '../src/text.mjs';

export { stripAnsi };

// Terminal sizes worth caring about. The small ones are the point: office.mjs
// clamps to 20x8, and every layout branch (desks, the compact list, the split
// panel) has to survive down there without a single row overflowing.
export const SIZES = [
  [200, 60],
  [140, 46],
  [132, 34],
  [105, 45],
  [95, 32],
  [84, 24],
  [80, 30],
  [70, 14],
  [40, 20],
  [31, 15],
  [20, 8],
];

export const FRAMES = [0, 1, 2, 3];

const STATUSES = ['blocked', 'working', 'idle', 'done', 'unknown', 'blocked', 'blocked'];

export function officeRoster(statuses = STATUSES) {
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main' }]);
  roster.setTabs([
    { tab_id: 'w1:t1', label: 'group-resolver' },
    { tab_id: 'w1:t2', label: 'a-really-long-tab-name-that-overflows-its-card' },
    { tab_id: 'w1:t3', label: '' },
  ]);
  roster.update(
    statuses.map((status, i) => ({
      pane_id: `w1:p${i + 1}`,
      agent: 'claude',
      agent_status: status,
      workspace_id: 'w1',
      tab_id: `w1:t${(i % 3) + 1}`,
      cwd: '/Users/you/Desktop/projects/herdr-office',
      terminal_title_stripped: `a task ${i}`,
      focused: i === 0,
      state_change_seq: 1,
    })),
  );
  roster.setAsk('w1:p1', 'shell requires approval', { shape: 'y/n', approve: ['y'], deny: ['n'] });
  roster.setAsk('w1:p6', 'Do you want to overwrite the whole configuration file and restart everything?', {
    shape: 'menu',
    approve: ['1'],
    deny: ['esc'],
  });
  // p7 is deliberately left with no ask, to exercise the "needs your OK" fallback.
  return roster;
}

const detailFor = (id, choice) => ({
  id,
  loading: false,
  summary: ['stuck on: shell requires approval'],
  output: ['$ rm -rf /tmp/x', 'Allow? (y/n)'],
  detection: ['state blocked via rule prompt'],
  fetchedAt: 0,
  ...(choice ? { choice } : {}),
});

// Every shape the panel can take, including a desk that has closed since the
// panel was opened, which is its own branch and easy to forget.
export const DETAILS = [
  ['none', null],
  ['loading', { id: 'w1:p1', loading: true, summary: [], output: [], detection: [], fetchedAt: 0 }],
  ['no choice yet', detailFor('w1:p1')],
  ['y/n', detailFor('w1:p1', { shape: 'y/n', approve: ['y'], deny: ['n'] })],
  ['unrecognised prompt', detailFor('w1:p1', { shape: 'unknown', approve: ['enter'], deny: ['esc'] })],
  ['desk has gone', detailFor('w1:pGONE', { shape: 'y/n', approve: ['y'], deny: ['n'] })],
];

// The drag states worth rendering: nothing in the air, a desk picked up but not
// yet moved, one hovering over somebody else, and one hovering over carpet.
// Every one of them has to hold the cell-exact invariant.
export const DRAGS = [
  ['no drag', null],
  ['lifted, not moved', { id: 'w1:p1', start: { x: 2, y: 2 }, overId: 'w1:p1', active: false }],
  ['over another desk', { id: 'w1:p1', start: { x: 2, y: 2 }, overId: 'w1:p3', active: true }],
  ['over carpet', { id: 'w1:p1', start: { x: 2, y: 2 }, overId: null, active: true }],
  ['over a desk that has gone', { id: 'w1:p1', start: { x: 2, y: 2 }, overId: 'w1:pGONE', active: true }],
];

// The real list off a live machine, because a menu of twenty-one names is what
// actually has to wrap, clip and overflow.
export const KINDS = [
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'maki',
  'muse',
];

// Every shape the hire menu can be in: still asking herdr who it can start, the
// full list, the cursor on the last name, an agent coming up, and the two ways it
// can have nothing to offer.
export const HIRES = [
  ['none', null],
  ['still asking', { kinds: [], index: 0, pending: null, error: null }],
  ['a menu', { kinds: KINDS, index: 0, pending: null, error: null }],
  ['cursor at the end', { kinds: KINDS, index: KINDS.length - 1, pending: null, error: null }],
  ['one kind only', { kinds: ['claude'], index: 0, pending: null, error: null }],
  ['starting somebody', { kinds: KINDS, index: 1, pending: 'claude', error: null }],
  ['a very long kind name', { kinds: ['a-locally-overridden-agent-with-a-silly-name', 'claude'], index: 0, pending: null, error: null }],
  ['it went wrong', { kinds: KINDS, index: 0, pending: null, error: 'could not hire claude: timed out waiting for it to come up. The tab it opened is still there.' }],
];

export function viewOf({ people, cols, rows, frame = 0, detail = null, selectedId, message = '', drag = null, busy = new Set(), hire = null }) {
  const counts = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
  for (const p of people) counts[p.status] = (counts[p.status] ?? 0) + 1;
  return {
    people,
    counts,
    selectedId: selectedId === undefined ? people[0]?.id ?? null : selectedId,
    detail,
    frame,
    now: Date.UTC(2026, 8, 10, 12, 0, 0),
    size: { cols, rows },
    message,
    drag,
    busy,
    hire,
  };
}
