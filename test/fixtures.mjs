// Shared setup. Everything here exists to make the awkward cases the default:
// the roster below has a stuck desk with a short ask, a stuck desk whose ask is
// far longer than its bubble, a stuck desk with no ask at all yet, an unnamed
// tab, and a tab name that overflows its card. A test that only ever renders a
// tidy office proves nothing, because a tidy office is not what breaks.
import { Roster } from '../src/roster.mjs';
import { stripAnsi } from '../src/text.mjs';
import { assignRooms } from '../src/rooms.mjs';

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

export const COMMANDS = ['npm test', 'pytest -x --last-failed --maxfail=1', 'cargo build', null, 'tsc', 'go', 'gradlew assemble'];

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
  // A working desk's monitor shows the command herdr could name for it. This list
  // is deliberately uneven: one command far wider than the twelve cells a screen
  // has, and one desk left with nothing at all, because "herdr could not name it"
  // is the common case and still has to draw.
  roster.people.forEach((person, i) => {
    if (person.status === 'working') roster.setCommand(person.id, COMMANDS[i % COMMANDS.length]);
  });
  return roster;
}

// Which workspace each desk is in, for the rooms. The default plan is what a real
// session looks like: a few desks in the workspace you are living in and a couple
// parked in others. `roomyRoster(one per desk)` is the wrap case, since there are
// only six wall colours and seven desks.
const WS_NAMES = ['main', 'a-really-long-workspace-name-that-will-not-fit-anywhere', '', 'notes', 'sandbox', 'ops', 'seventh'];

export function roomyRoster(plan = [1, 1, 1, 2, 2, 3, 3], statuses = STATUSES) {
  const roster = new Roster();
  roster.setWorkspaces(WS_NAMES.map((label, i) => ({ workspace_id: `w${i + 1}`, label, number: i + 1 })));
  roster.setTabs([
    { tab_id: 't1', label: 'group-resolver', number: 1 },
    { tab_id: 't2', label: 'a-really-long-tab-name-that-overflows-its-card', number: 2 },
    { tab_id: 't3', label: '', number: 3 },
  ]);
  roster.update(
    statuses.map((status, i) => ({
      pane_id: `w${plan[i % plan.length]}:p${i + 1}`,
      agent: 'claude',
      agent_status: status,
      workspace_id: `w${plan[i % plan.length]}`,
      tab_id: `t${(i % 3) + 1}`,
      cwd: `/Users/you/Desktop/projects/repo${plan[i % plan.length]}`,
      terminal_title_stripped: `a task ${i}`,
      focused: i === 0,
      state_change_seq: 1,
    })),
  );
  roster.setAsk(roster.people.find((p) => p.status === 'blocked')?.id, 'shell requires approval', { shape: 'y/n', approve: ['y'], deny: ['n'] });
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
  // The worktree half: a branch name, one being typed, an empty field mid-edit,
  // and a name far longer than the row it sits in.
  ['into a worktree', { kinds: KINDS, index: 0, pending: null, error: null, worktree: true, branch: 'office/claude-0914-1502' }],
  ['naming the branch', { kinds: KINDS, index: 0, pending: null, error: null, worktree: true, branch: 'office/claude-0914-1502', editing: true }],
  ['an empty branch field', { kinds: KINDS, index: 0, pending: null, error: null, worktree: true, branch: '', editing: true }],
  ['a silly long branch', { kinds: KINDS, index: 3, pending: null, error: null, worktree: true, branch: `office/${'x'.repeat(72)}` }],
  ['making a worktree', { kinds: KINDS, index: 1, pending: 'claude', error: null, worktree: true, branch: 'office/claude-0914-1502' }],
  ['the worktree went wrong', { kinds: KINDS, index: 0, pending: null, worktree: true, branch: 'office/claude-0914-1502', error: 'could not hire claude: repository is not trusted. The worktree it made is still there.' }],
];

const SOME = [
  { id: 'w1:p3', name: 'Cass', status: 'idle' },
  { id: 'w1:p4', name: 'Dev', status: 'done' },
  { id: 'w1:p5', name: 'Ede', status: 'unknown' },
];

const CROWD = new Array(30).fill(0).map((_, i) => ({ id: `w1:q${i}`, name: `Person${i}`, status: 'idle' }));

const LONG = 'rebase onto main, run the whole test suite, and if anything fails leave it '
  + 'alone and tell me what broke instead of trying to fix it yourself, because the last '
  + 'three attempts made it worse and I would rather read the failure than the patch';

// Every shape the assign field can be in. The two that matter most are the confirm
// step (the only place one enter reaches more than one agent) and a broadcast that
// reaches nobody, because both are generated sentences rather than fixed art.
export const COMPOSES = [
  ['none', null],
  ['empty, one person', { scope: 'one', id: 'w1:p3', name: 'Cass', text: '', to: [SOME[0]], skipped: { blocked: 0, working: 0 }, confirm: false, sending: false, error: null }],
  ['typed, one person', { scope: 'one', id: 'w1:p3', name: 'Cass', text: 'rebase onto main', to: [SOME[0]], skipped: { blocked: 0, working: 0 }, confirm: false, sending: false, error: null }],
  ['a prompt that wraps', { scope: 'one', id: 'w1:p3', name: 'Cass', text: LONG, to: [SOME[0]], skipped: { blocked: 0, working: 0 }, confirm: false, sending: false, error: null }],
  ['a broadcast with skips', { scope: 'all', id: null, name: null, text: 'standup: what are you on?', to: SOME, skipped: { blocked: 2, working: 1 }, confirm: false, sending: false, error: null }],
  ['a broadcast to a crowd', { scope: 'all', id: null, name: null, text: 'standup', to: CROWD, skipped: { blocked: 0, working: 4 }, confirm: false, sending: false, error: null }],
  ['a broadcast to nobody', { scope: 'all', id: null, name: null, text: 'standup', to: [], skipped: { blocked: 3, working: 2 }, confirm: false, sending: false, error: null }],
  ['confirming a broadcast', { scope: 'all', id: null, name: null, text: 'standup: what are you on?', to: SOME, skipped: { blocked: 2, working: 1 }, confirm: true, sending: false, error: null }],
  ['confirming to a crowd', { scope: 'all', id: null, name: null, text: LONG, to: CROWD, skipped: { blocked: 0, working: 0 }, confirm: true, sending: false, error: null }],
  ['sending', { scope: 'one', id: 'w1:p3', name: 'Cass', text: 'rebase onto main', to: [SOME[0]], skipped: { blocked: 0, working: 0 }, confirm: false, sending: true, error: null }],
  ['nothing typed yet', { scope: 'one', id: 'w1:p3', name: 'Cass', text: '', to: [SOME[0]], skipped: { blocked: 0, working: 0 }, confirm: false, sending: false, error: 'nothing typed yet' }],
  ['a very long name', { scope: 'one', id: 'w1:p3', name: 'a-really-long-agent-name-nobody-would-pick', text: 'go', to: [{ id: 'w1:p3', name: 'a-really-long-agent-name-nobody-would-pick', status: 'idle' }], skipped: { blocked: 0, working: 0 }, confirm: false, sending: false, error: null }],
];

// News over a desk: every kind, plus the two that are only a rendering problem (a
// label far wider than the wall it hangs on, and an empty one).
export const NEWS = [
  { label: 'tests passed', kind: 'good' },
  { label: 'the build broke', kind: 'broke' },
  { label: 'merge conflict', kind: 'snag' },
  { label: 'a label nobody would ever write that is far too long for the wall', kind: 'good' },
  { label: '', kind: 'good' },
  { label: 'committed', kind: 'nonsense-kind' },
];

// Every state the filter can be in: off, a field just opened with nothing in it,
// a filter that matches, one that matches nobody, and one long enough to need
// cutting in the header chip.
// Branches, as they arrive: ordinary, long enough to crowd the line, one that is
// only just a name at all, and none.
export const BRANCHES = [
  'main',
  'feature/sso',
  'renovate/bump-everything-all-at-once-please',
  'x',
  null,
];

export const FILTERS = [
  ['off', { filter: '', filtering: false }],
  ['field open, empty', { filter: '', filtering: true }],
  ['typing', { filter: 'wait', filtering: true }],
  ['accepted', { filter: 'waiting', filtering: false }],
  ['matches nobody', { filter: 'zzzz', filtering: false }],
  ['matches nobody, still typing', { filter: 'zzzz', filtering: true }],
  ['a silly long filter', { filter: 'a-filter-nobody-would-ever-type-but-here-we-are', filtering: true }],
  ['a filter with spaces', { filter: 'group resolver', filtering: false }],
];

export function viewOf({ people, cols, rows, frame = 0, detail = null, selectedId, message = '', drag = null, busy = new Set(), hire = null, compose = null, filter = '', filtering = false, following = false, zoom = 'auto', total = null, rooms = null, stats = null, shift = null }) {
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
    compose,
    filter,
    filtering,
    following,
    zoom,
    total: total ?? people.length,
    // Derived from these people by default, which for a one-workspace roster is no
    // rooms at all: every test written before rooms existed keeps rendering exactly
    // the office it was written against.
    rooms: rooms || assignRooms(people),
    // The punch clock's numbers. Null by default: an office nobody has watched for
    // any length of time has an empty whiteboard, which is what the pre-punch-clock
    // tests were all written against.
    stats,
    shift,
  };
}
