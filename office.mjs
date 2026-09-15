#!/usr/bin/env node
// Herdr Office: your agents, drawn as people at desks.
//
// Runs as a Herdr plugin pane entrypoint (see herdr-plugin.toml) but works
// standalone in any terminal that can reach the Herdr socket.
//
//   node office.mjs            live office
//   node office.mjs --demo     fake roster, no server needed
//   node office.mjs --once     render one frame and exit (handy for diffing art)
//   node office.mjs --quiet    no toast when somebody starts waiting on you
//   node office.mjs --no-title leave the window title alone
import { spawn } from 'node:child_process';
import { ApiClient, EventStream, resolveSocketPath } from './src/socket.mjs';
import { Roster } from './src/roster.mjs';
import { renderFrame, nextZoom, ZOOMS, HIRE_ID } from './src/render.mjs';
import { cleanOutput, summarize, describeDetection, bubbleText, approvalChoice } from './src/summary.mjs';
import { parseMouse, nextDrag } from './src/mouse.mjs';
import { typeChunk, sanitizeBranch, defaultBranch, nextIndex } from './src/hire.mjs';
import { typePromptChunk, cleanPrompt, broadcastTargets } from './src/compose.mjs';
import { width } from './src/text.mjs';
import { runningCommand } from './src/process.mjs';
import { WATCH_PATTERN, eventFromMatch } from './src/events.mjs';
import { windowTitle } from './src/title.mjs';
import { escalate } from './src/escalate.mjs';
import { filterPeople, typeFilterChunk, terms } from './src/filter.mjs';
import { follow } from './src/follow.mjs';
import { assignRooms } from './src/rooms.mjs';
import { Clocks } from './src/punchclock.mjs';
import { branchFromList } from './src/branches.mjs';

const argv = new Set(process.argv.slice(2));
const DEMO = argv.has('--demo');
const ONCE = argv.has('--once');
// Toasts are on by default. The whole reason to watch the office is to find out
// that somebody is waiting on you, and a default that has to be switched on by
// editing an installed plugin's manifest is a default nobody ever gets.
// `--notify` still parses, because it used to be the way to ask for this.
const NOTIFY = !argv.has('--quiet');
// The window title is the office's only presence outside its own pane, which is
// exactly why it is opt-out: it is somebody else's window, and a title is a
// shared surface that other things may also care about.
const TITLE = !argv.has('--no-title');
const FOLLOW = argv.has('--follow');
// --zoom picks the level to open at. An unknown value is the floor plan rather than
// an error: this is a wall display as often as it is a tool, and a typo in a plugin
// action's arguments should not leave somebody with a blank pane and no explanation.
const ZOOM_ARG = ([...argv].find((a) => a.startsWith('--zoom=')) || '').slice(7);
// Which pane the office itself is in, when herdr started it. Used for one thing:
// knowing whether you are looking at the floor right now, so a nudge about a hand
// you can already see is never sent.
const OWN_PANE = process.env.HERDR_PANE_ID || '';

const ANIM_MS = 320;
const POLL_MS = 2000;
const DETAIL_MS = 2500;
// A bubble is one screen read per stuck desk, so it is cheap but not free: only
// blocked desks are read, and only when their bubble has gone stale.
const ASK_MS = 6000;
// A monitor showing the real command is one `pane.process_info` per *working*
// desk, and that response is the whole foreground process tree: on a real
// machine it is fifteen kilobytes a pane, because every agent permanently
// carries its MCP servers around. So it is throttled harder than a bubble and
// capped per pass, and a busy floor gets read a few desks at a time instead of
// all of them every two seconds.
const CMD_MS = 5000;
const CMD_PER_PASS = 4;
// Branches move a lot less often than a foreground process does, so they are asked
// for far less often, and the answer is cached per working directory rather than per
// desk: twelve panes in one checkout are one question. A checkout somebody is
// actively switching branches in catches up within half a minute, which is the right
// trade for a wall display.
const BRANCH_MS = 30000;
const BRANCH_PER_PASS = 2;

// Global subscriptions: these need no pane_id. pane.agent_status_changed is
// per-pane, so it gets added for every desk we know about and re-subscribed
// whenever the roster changes shape.
const GLOBAL_EVENTS = [
  'pane.agent_detected',
  'pane.created',
  'pane.closed',
  'pane.exited',
  'pane.updated',
  'pane.focused',
  'workspace.created',
  'workspace.renamed',
  'workspace.closed',
  'tab.created',
  'tab.renamed',
  'tab.closed',
];

const roster = new Roster();
// Where the office's time went. Fed from the same status changes the roster is
// already tracking, so it costs nothing on the wire.
const clocks = new Clocks();
let api = null;
let events = null;
let selectedId = null;
// The filter. `text` is what is typed, `editing` is whether the field has the
// keyboard: an accepted filter keeps narrowing the floor after you have stopped
// typing, which is the whole point of it.
let filter = '';
let filtering = false;
// Shepherd mode, off until you ask for it. `handsSeen` is null rather than empty so
// the first pass after switching it on treats a hand that is already up as news:
// being taken to somebody is the reason you pressed the key.
let following = FOLLOW;
let handsSeen = null;
// The zoom level: 'auto' is the floor plan deciding for itself when it has stopped
// being readable, which is what the office has always done.
let zoom = ZOOMS.includes(ZOOM_ARG) ? ZOOM_ARG : 'auto';
let detail = null;
let message = '';
let messageUntil = 0;
let frame = 0;
let prevLines = [];
let refreshTimer = null;
let stopped = false;

// COLUMNS/LINES only matter when stdout is not a tty (piped --once renders).
const size = () => ({
  cols: Math.max(20, process.stdout.columns || Number(process.env.COLUMNS) || 80),
  rows: Math.max(8, process.stdout.rows || Number(process.env.LINES) || 24),
});

function note(text, ms = 4000) {
  message = text;
  messageUntil = Date.now() + ms;
}

/* ---------------------------------------------------------------- terminal */

function enterTerminal() {
  // 1002 rather than 1000: button-event tracking reports motion while a button
  // is held, which is the difference between being able to drag a desk and only
  // seeing where it was picked up and put down.
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1002h\x1b[?1006h');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onInput);
  process.stdout.on('resize', () => {
    prevLines = [];
    draw();
  });
}

function leaveTerminal() {
  // Both trackers off, in case something upstream left 1000 on.
  process.stdout.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function quit(code = 0, msg) {
  if (stopped) return;
  stopped = true;
  clearInterval(anim);
  clearInterval(poll);
  events?.close();
  leaveTerminal();
  if (msg) process.stderr.write(`${msg}\n`);
  // The socket stays open just long enough to give the window title back, then
  // goes regardless. Half a second is the whole budget: an office that would not
  // quit because a title would not clear is worse than a stale title.
  const done = () => {
    api?.close();
    process.exit(code);
  };
  const bail = setTimeout(done, 500);
  bail.unref?.();
  clearTitle()
    .catch(() => {})
    .then(() => {
      clearTimeout(bail);
      done();
    });
}

/* ------------------------------------------------------------------ drawing */

// The header counts what is on the floor, which with a filter on is the filtered
// set. Counting the whole room under a filtered floor plan would have the header
// and the desks under it disagreeing about how many people are stuck.
function countOf(people) {
  const tally = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
  for (const p of people) tally[p.status] = (tally[p.status] ?? 0) + 1;
  return tally;
}

function view() {
  if (message && Date.now() > messageUntil) message = '';
  // Filtering happens here, once, and everything downstream (paging, the compact
  // list, hitboxes, the counts in the header) just sees a shorter floor. A filter
  // that reached into the layout would have needed every one of those to learn
  // about it.
  const people = filterPeople(roster.people, filter);
  return {
    people,
    // Room colours come from the WHOLE roster rather than the filtered floor, so a
    // filter narrows who is on screen without repainting the walls behind them.
    rooms: assignRooms(roster.people),
    // Plain numbers, read once per frame, so the renderer stays a pure function of
    // its view rather than holding a clock it can ask questions of.
    shift: detail ? clocks.desk(detail.id) : null,
    stats: clocks.office(),
    counts: countOf(people),
    total: roster.people.length,
    filter,
    filtering,
    following,
    zoom,
    selectedId,
    detail,
    frame,
    now: Date.now(),
    size: size(),
    message,
    drag,
    busy,
    hire,
    compose,
  };
}

let hitboxes = [];
let grid = { cols: 0, rows: 0, ids: [], menuCols: 1, menuVisible: 0 };

function draw() {
  const rendered = renderFrame(view());
  hitboxes = rendered.hitboxes;
  grid = rendered.grid;
  const { cols, rows } = size();
  let out = '';
  for (let i = 0; i < rows; i += 1) {
    const line = rendered.lines[i] ?? '';
    if (prevLines[i] === line) continue;
    // Only clear the tail when there is a tail. On a line that already fills the
    // row the cursor is sitting in the last column with a pending wrap, and an
    // erase-to-end-of-line there eats the character we just drew.
    out += `\x1b[${i + 1};1H${line}${width(line) < cols ? '\x1b[K' : ''}`;
    prevLines[i] = line;
  }
  if (out) process.stdout.write(out);
}

/* --------------------------------------------------------------------- data */

// Who is actually on the floor: the roster, minus anybody the filter is hiding.
// Walking, the next-raised-hand key and the selection all work off this rather
// than the full roster, because a filter you can walk out of the side of is not a
// filter, it is a decoration.
function floorPeople() {
  return filterPeople(roster.people, filter);
}

function ensureSelection() {
  // The empty desk is a real place to be standing even though nobody is in the
  // roster under that id, so a poll must not walk you off it.
  if (selectedId === HIRE_ID) return;
  const floor = floorPeople();
  if (selectedId && floor.some((p) => p.id === selectedId)) return;
  const raised = floor.find((p) => p.status === 'blocked');
  selectedId = (raised || floor[0])?.id ?? null;
}

// Shepherd mode's one move per poll. The decision lives in src/follow.mjs; this
// only hands it the floor and takes the selection back. It runs off the filtered
// floor, so a filter still means what it says: shepherd will not walk you to a desk
// the filter is hiding.
function shepherd() {
  const out = follow({
    people: floorPeople(),
    selectedId,
    seen: handsSeen,
    active: following,
    state: { compose, hire, drag, filtering },
  });
  handsSeen = out.seen;
  if (!out.moved) return;
  selectedId = out.selectedId;
  // Said out loud, because a highlight that moved on its own needs a reason
  // attached to it. Not a toast: the notification for this already went out.
  note(`${out.person.name} has a hand up`);
  if (detail) loadDetail(selectedId, { force: true });
}

// Ask every stuck desk what it wants, so the floor plan can put it in a bubble
// without the user having to open each one.
async function refreshAsks() {
  const blocked = roster.people.filter((p) => p.status === 'blocked');
  await Promise.all(
    blocked.map(async (person) => {
      if (roster.askAge(person.id) < ASK_MS) return;
      try {
        const res = await api.request('agent.read', { target: person.id, source: 'visible' });
        const lines = cleanOutput(res?.read?.text ?? '');
        roster.setAsk(person.id, bubbleText(lines), approvalChoice(lines));
      } catch {
        // A desk that will not talk keeps whatever it last said.
      }
    }),
  );
  if (blocked.length && !ONCE) draw();
}

// Ask the working desks what they are actually running, so the monitor can say
// `npm test` instead of scrolling generic code. Stale desks first, so a floor
// with more working agents than one pass allows rotates through them fairly
// rather than starving the ones at the bottom.
async function refreshCommands() {
  const due = roster.people
    .filter((p) => p.status === 'working' && roster.commandAge(p.id) >= CMD_MS)
    .sort((a, b) => roster.commandAge(b.id) - roster.commandAge(a.id))
    .slice(0, CMD_PER_PASS);
  if (!due.length) return;
  for (const person of due) {
    try {
      const res = await api.request('pane.process_info', { pane_id: person.id });
      roster.setCommand(person.id, runningCommand(res?.process_info));
    } catch {
      // A pane that will not say keeps whatever it last said. Deliberately not
      // cleared: a transient failure should not blank a monitor mid-build.
    }
  }
  if (!ONCE) draw();
}

// Which branch each desk is on, via `worktree.list`. Asked per distinct working
// directory, stalest first, a couple at a time, so a floor spread across eight repos
// fills in over a few passes instead of firing eight calls at once. **`trust_repository`
// is never sent** (see src/branches.mjs): an untrusted repo has no branch on its
// desks, and that is the correct outcome rather than a prompt this pane has no
// business raising on somebody's behalf.
async function refreshBranches() {
  const dirs = [...new Set(roster.people.map((p) => p.cwd).filter(Boolean))]
    .filter((cwd) => roster.branchAge(cwd) >= BRANCH_MS)
    .sort((a, b) => roster.branchAge(b) - roster.branchAge(a))
    .slice(0, BRANCH_PER_PASS);
  if (!dirs.length) return;
  for (const cwd of dirs) {
    try {
      const res = await api.request('worktree.list', { cwd });
      roster.setBranch(cwd, branchFromList(res, cwd));
    } catch {
      // Not a repo, not trusted, or the server would rather not say. Recorded as an
      // answer all the same, so the office does not ask the same directory again
      // every two seconds for the rest of the afternoon.
      roster.setBranch(cwd, {});
    }
  }
  if (!ONCE) draw();
}

// Puts the headline count on the window itself, so the office is legible from a
// tab bar or an alt-tab list with its pane nowhere in sight. Only ever sent when
// the string actually changes: a title set twenty times a minute to the same
// eighteen characters is pure noise on the socket.
let lastTitle = '';
function syncTitle() {
  if (!TITLE || DEMO || ONCE) return;
  const title = windowTitle(roster.counts());
  if (title === lastTitle) return;
  api
    ?.request('client.window_title.set', { title })
    .then((res) => {
      // `no_foreground_client` means there is no window listening right now, so
      // nothing was set and nothing should be remembered as set: the title has to
      // go out again when a window comes back. Anything else counts as landed.
      lastTitle = res?.reason === 'no_foreground_client' ? '' : title;
    })
    .catch(() => {
      // A title is the least important thing on this socket. If it will not take,
      // it will be retried on the next state change and never mentioned.
      lastTitle = '';
    });
}

// Hands the window back on the way out. Bounded by the caller, because a hung
// socket must never be the reason ctrl-c does not work.
function clearTitle() {
  if (!TITLE || DEMO || ONCE || !lastTitle) return Promise.resolve();
  lastTitle = '';
  return api?.request('client.window_title.clear', {}, 400) ?? Promise.resolve();
}

// Feeds the roster everything it needs to seat people where their panes really
// are. Order matters: the layouts refer to workspaces and tabs by id, so the
// numbers have to be in hand before the geometry is read.
function seat(snapshot, tabs) {
  const snap = snapshot?.snapshot;
  // Whether the office is the pane you are looking at. Free with the snapshot we
  // already fetch, and the difference between a useful nudge and a rude one.
  if (snap) watching = Boolean(OWN_PANE) && snap.focused_pane_id === OWN_PANE;
  if (snap?.workspaces) roster.setWorkspaces(snap.workspaces);
  // The snapshot's tabs carry `number`, which is what orders one workspace's
  // tabs. tab.list goes second so its labels win where the two disagree, and it
  // cannot clobber a number it does not carry.
  if (snap?.tabs) roster.setTabs(snap.tabs);
  if (tabs?.tabs) roster.setTabs(tabs.tabs);
  if (snap?.layouts) roster.setLayouts(snap.layouts);
}

async function refresh() {
  if (DEMO) {
    roster.update(demoAgents());
    demoExtras();
    clocks.observe(roster.people);
    ensureSelection();
    shepherd();
    draw();
    return;
  }
  try {
    const [agentList, snapshot, tabs] = await Promise.all([
      api.request('agent.list', {}),
      api.request('session.snapshot', {}).catch(() => null),
      api.request('tab.list', {}).catch(() => null),
    ]);
    seat(snapshot, tabs);
    const newlyBlocked = roster.update(agentList.agents || []);
    clocks.observe(roster.people);
    ensureSelection();
    shepherd();
    syncSubscriptions();
    refreshAsks();
    refreshCommands();
    refreshBranches();
    syncTitle();
    nudge();
    if (NOTIFY) {
      for (const id of newlyBlocked) {
        const person = roster.find(id);
        if (!person || person.firstSeen) continue;
        api
          .request('notification.show', {
            title: `${person.name} raised a hand`,
            body: `${person.kind} in ${person.id} needs you`,
            sound: 'request',
          })
          .catch(() => {});
      }
    }
    draw();
  } catch (err) {
    note(`api: ${err.message}`);
    draw();
  }
}

// Says it again when a hand stays up: one toast however many are waiting, backing
// off as it goes, and nothing at all while the office is the pane you are looking
// at. See src/escalate.mjs for why each of those is a rule rather than a nicety.
let watching = false;
let escalation = null;
function nudge() {
  if (!NOTIFY || DEMO || ONCE) return;
  const { toast, state } = escalate({ people: roster.people, state: escalation, watching });
  escalation = state;
  if (!toast) return;
  api?.request('notification.show', { ...toast, sound: 'request' }).catch(() => {});
}

// Per-pane status subscriptions have to be rebuilt when desks come and go.
// Cheap: one extra socket, only when the set of pane ids actually changes.
let subscribedTo = '';
function syncSubscriptions() {
  if (DEMO) return;
  const ids = roster.people.map((p) => p.id).sort();
  const key = ids.join(',');
  if (key === subscribedTo) return;
  subscribedTo = key;
  events?.close();
  events = new EventStream();
  // Two subscriptions per desk: the status change, and one watch for everything
  // in the office's watchlist at once. One pattern rather than one per phrase,
  // because the subscription list is rebuilt every time the roster changes shape
  // and eight patterns a desk would make that a hundred descriptors on a busy
  // session. `visible` is the safe source (the `recent` ones can drop the
  // connection), and a handful of lines is all a summary line ever needs.
  const subs = [
    ...GLOBAL_EVENTS,
    ...ids.flatMap((pane_id) => [
      { type: 'pane.agent_status_changed', pane_id },
      {
        type: 'pane.output_matched',
        pane_id,
        source: 'visible',
        match: { type: 'regex', value: WATCH_PATTERN },
        lines: 8,
        strip_ansi: true,
      },
    ]),
  ];
  events
    .open(
      subs,
      (msg) => onServerEvent(msg),
      () => {
        // Force a resubscribe on the next poll if the stream dies.
        subscribedTo = '';
      },
    )
    .catch((err) => note(`events: ${err.message}`));
}

// An event off the stream. Everything gets a poll scheduled, because the roster is
// the source of truth for state; an output match additionally puts a line of news
// over the desk it came from.
//
// The matched output is never drawn. eventFromMatch turns it into one of the
// office's own fixed labels or into nothing at all, so an error message with a
// path or a token in it cannot end up on the wall (see src/events.mjs).
function onServerEvent(msg) {
  const payload = msg?.result || msg?.event || msg;
  if (payload?.type === 'output_matched' && payload.pane_id) {
    const news = eventFromMatch(payload);
    if (news && roster.find(payload.pane_id)) {
      roster.setEvent(payload.pane_id, news.label, news.kind);
      draw();
    }
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 120);
}

// Reading a desk, carefully. The `visible` source is a plain screen snapshot
// and always safe. The `recent` sources page through alternate-screen
// scrollback, which the server only tolerates for an idle agent (and which can
// drop the connection outright when it does not), so they are a bonus, not the
// primary source.
async function readDesk(id, person) {
  const visible = await api.request('agent.read', { target: id, source: 'visible' });
  const screen = cleanOutput(visible?.read?.text ?? '');
  if (person && (person.status === 'idle' || person.status === 'done')) {
    try {
      const history = await api.request('agent.read', { target: id, source: 'recent_unwrapped', lines: 80 });
      const lines = cleanOutput(history?.read?.text ?? '');
      if (lines.length > screen.length) return lines;
    } catch {
      // Fall through to the screen snapshot; scrollback is optional.
    }
  }
  return screen;
}

// agent.explain over the socket returns a huge rule-evaluation dump and can
// hang up the connection mid-response, so shell out to the CLI for it instead.
const explainCache = new Map();
function explainDesk(id) {
  const cached = explainCache.get(id);
  if (cached && Date.now() - cached.at < 10000) return Promise.resolve(cached.lines);
  return new Promise((resolve) => {
    const bin = process.env.HERDR_BIN_PATH || 'herdr';
    const child = spawn(bin, ['agent', 'explain', id, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    const done = (lines) => {
      explainCache.set(id, { at: Date.now(), lines });
      resolve(lines);
    };
    child.on('error', () => done([]));
    child.on('close', () => {
      try {
        done(describeDetection(JSON.parse(out)));
      } catch {
        done([]);
      }
    });
  });
}

async function loadDetail(id, { force = false } = {}) {
  if (!detail || detail.id !== id) detail = { id, loading: true, summary: [], output: [], detection: [], fetchedAt: 0 };
  if (!force && Date.now() - detail.fetchedAt < DETAIL_MS) return;
  const person = roster.find(id);
  if (DEMO) {
    detail = {
      id,
      loading: false,
      fetchedAt: Date.now(),
      summary: summarize(person, ['Running the test suite', 'Do you want me to apply the patch? (y/n)']),
      output: ['$ npm test', '  12 passing', '  Do you want me to apply the patch? (y/n)'],
      detection: ['state ' + (person?.status || '?') + ' via rule demo'],
      choice: approvalChoice(['Do you want me to apply the patch? (y/n)']),
    };
    draw();
    return;
  }
  try {
    const [output, detection] = await Promise.all([readDesk(id, person), explainDesk(id)]);
    detail = {
      id,
      loading: false,
      fetchedAt: Date.now(),
      output,
      summary: summarize(person, output),
      detection,
      choice: approvalChoice(output),
    };
  } catch (err) {
    detail = {
      id,
      loading: false,
      fetchedAt: Date.now(),
      output: [],
      // agent_not_idle is the common one: full-screen agents will not give up
      // scrollback while they are mid-turn.
      summary: [`could not read this desk: ${err.code || err.message}`],
      detection: [],
      choice: null,
    };
  }
  draw();
}

/* ---------------------------------------------------------------- interaction */

function move(dx, dy) {
  const ids = grid.ids.length ? grid.ids : floorPeople().map((p) => p.id);
  const idx = ids.indexOf(selectedId);
  if (idx < 0) {
    ensureSelection();
    return;
  }
  const cols = grid.cols || 1;
  let next = idx;
  if (dx) next = idx + dx;
  if (dy) next = idx + dy * cols;
  if (next < 0 || next >= ids.length) {
    // The empty desk is the last thing on the last floor and is in nobody's
    // roster, so there is nothing past it to page to. Walking off it stays put
    // rather than teleporting to whoever happens to be first.
    if (selectedId === HIRE_ID) return;
    // Walking off the edge of the visible floor moves through the full roster,
    // which is what makes paging work with only arrow keys.
    const all = floorPeople().map((p) => p.id);
    const globalIdx = all.indexOf(selectedId) + (dx || dy * cols);
    if (globalIdx >= 0 && globalIdx < all.length) selectedId = all[globalIdx];
    return;
  }
  selectedId = ids[next];
}

function nextRaisedHand() {
  const raised = floorPeople().filter((p) => p.status === 'blocked');
  if (!raised.length) {
    note(terms(filter).length ? 'nobody matching that has a hand up' : 'nobody has a hand up');
    return;
  }
  const idx = raised.findIndex((p) => p.id === selectedId);
  selectedId = raised[(idx + 1) % raised.length].id;
}

// Switching shepherd mode on takes effect now rather than on the next poll, because
// a key that visibly does nothing for two seconds reads as a key that did not work.
function toggleFollow() {
  following = !following;
  handsSeen = null;
  if (!following) return note('not following hands');
  note('following hands');
  shepherd();
}

// Answer an approval prompt without walking over to the pane. The keys come
// from that desk's own screen (see approvalChoice), preferring the panel's read
// when one is open because it is the fresher of the two.
async function respond(kind) {
  const person = roster.find(selectedId);
  if (!person) return;
  if (person.status !== 'blocked') {
    note(`${person.name} is not waiting on you`);
    return;
  }
  const choice = (detail?.id === person.id ? detail.choice : null) || person.choice;
  if (!choice) {
    note(`still reading ${person.name}'s screen, try again in a second`);
    return;
  }
  const keys = kind === 'approve' ? choice.approve : choice.deny;
  if (DEMO) {
    note(`demo mode: would send ${keys.join(' ')} to ${person.name}`);
    return;
  }
  try {
    await api.request('agent.send_keys', { target: person.id, keys });
    // Counted only once the keys are actually away, so the whiteboard's tally is
    // answers the office really sent rather than answers it tried to send.
    clocks.answer();
    note(`sent ${keys.join(' ')} to ${person.name}`);
    // The prompt is gone but herdr has not noticed yet, so ask again shortly
    // rather than leaving a hand up that has already been dealt with.
    setTimeout(() => refresh(), 400);
    if (detail?.id === person.id) setTimeout(() => loadDetail(person.id, { force: true }), 600);
  } catch (err) {
    note(`could not answer ${person.name}: ${err.code || err.message}`);
  }
}

async function jumpToPane() {
  if (!selectedId) return;
  if (selectedId === HIRE_ID) {
    note('nobody sits there yet');
    return;
  }
  if (DEMO) {
    note('demo mode: nowhere to jump');
    return;
  }
  try {
    await api.request('pane.focus', { pane_id: selectedId });
    note(`focused ${selectedId}`);
  } catch (err) {
    note(`could not focus ${selectedId}: ${err.code || err.message}`);
  }
}

// Swapping two desks swaps the two real panes, which is why it asks the server
// rather than just reordering the picture: the floor is a view of the session,
// and a drag that only moved a drawing would be a lie the next poll erased.
// `pane.swap` is reversible and closes nothing, so it needs no confirmation, but
// it does need the in-flight guard: a second swap fired at a pane whose first
// swap has not landed yet is a race against a layout that is still moving.
const busy = new Set();

async function swapDesks(sourceId, targetId) {
  const from = roster.find(sourceId);
  const to = roster.find(targetId);
  if (!from || !to || sourceId === targetId) return;
  if (busy.has(sourceId) || busy.has(targetId)) {
    note('still moving those two, hold on');
    return;
  }
  if (DEMO) {
    note(`demo mode: would swap ${from.name} and ${to.name}`);
    return;
  }
  busy.add(sourceId);
  busy.add(targetId);
  draw();
  try {
    await api.request('pane.swap', { source_pane_id: sourceId, target_pane_id: targetId });
    note(`${from.name} and ${to.name} swapped desks`);
    await refresh();
  } catch (err) {
    note(`could not swap ${from.name} and ${to.name}: ${err.code || err.message}`);
  } finally {
    busy.delete(sourceId);
    busy.delete(targetId);
    draw();
  }
}

/* ------------------------------------------------------------------- hiring */

// The empty desk. Hiring is two calls: make somewhere for them to sit, then start
// an agent in the pane that came with it (`agent.start` does not create one, and
// it wants a pane sitting at an interactive shell prompt, which a fresh tab is).
// Somewhere to sit is either a plain tab in the project you are already in, or a
// whole new worktree on its own branch, which is `worktree.create` and comes with
// its own workspace, tab and pane.
//
// It is the one thing in the office that creates something rather than reporting
// on it, so it takes two deliberate steps: walk to the empty desk, then pick a
// kind. Nothing is started by a single stray click on the floor.
let hire = null;

// Long enough for a cold agent on a slow morning. The server's own default is
// 30s, which a first-run agent downloading something will blow straight through.
const HIRE_TIMEOUT_MS = 90000;

async function agentKinds() {
  if (DEMO) return ['claude', 'codex', 'gemini', 'kiro', 'opencode', 'amp', 'cursor', 'droid'];
  const res = await api.request('server.agent_manifests', {});
  // The manifests are what this machine can actually start, which is a different
  // (usually shorter) list than the kinds the CLI knows the names of.
  return (res?.manifests || [])
    .map((m) => m.agent)
    .filter(Boolean)
    .sort();
}

async function openHire() {
  if (hire) return;
  selectedId = HIRE_ID;
  // The menu and a desk's detail share the bottom half of the pane, so opening
  // one puts the other away.
  detail = null;
  hire = { kinds: [], index: 0, pending: null, error: null, worktree: false, branch: '', editing: false };
  prevLines = [];
  draw();
  try {
    const kinds = await agentKinds();
    if (hire && !hire.pending) hire = { ...hire, kinds };
  } catch (err) {
    if (hire) hire = { ...hire, error: `cannot ask herdr who it can start: ${err.code || err.message}` };
  }
  draw();
}

function closeHire() {
  if (!hire) return;
  hire = null;
  prevLines = [];
  draw();
}

// The menu is laid out in the same shape it is stored in, so walking it is
// walking the grid that is on the screen. `menuVisible` is the stop: on a short
// pane the tail of the list is not drawn, and a cursor you cannot see is worse
// than a list you cannot reach.
function moveHire(dx, dy) {
  if (!hire || hire.pending || hire.editing || !hire.kinds.length) return;
  const limit = Math.min(hire.kinds.length, grid.menuVisible || hire.kinds.length);
  const index = nextIndex(hire.index, dx, dy, grid.menuCols, limit);
  // The offered name has the agent's own name in it, so it follows the cursor.
  // Only until somebody types their own, though: a name you chose is not something
  // walking one cell to the left gets to overwrite.
  const branch = hire.named ? hire.branch : defaultBranch(hire.kinds[index]);
  hire = { ...hire, index, branch };
}

// Where the hire lands. Switching to a worktree offers a branch name straight
// away, because a worktree with no branch is not a thing you can create, and a
// name nobody has to type is a name nobody has to think about.
function setWorktree(on) {
  if (!hire || hire.pending) return;
  if (on === hire.worktree) return;
  const branch = hire.named ? hire.branch : defaultBranch(hire.kinds[hire.index]);
  hire = { ...hire, worktree: on, branch, editing: false };
}

// Renaming starts from empty, not from the offered name. The offered name is
// twenty-odd characters of timestamp, and a field that made you backspace through
// all of it before you could type your own is a field nobody would use twice. esc
// puts the old one back, and leaving it empty falls back to the offer.
function editBranch(on) {
  if (!hire || hire.pending || !hire.worktree) return;
  if (on) hire = { ...hire, editing: true, was: hire.branch, branch: '' };
  else if (hire.branch) hire = { ...hire, editing: false, named: true };
  else hire = { ...hire, editing: false, branch: hire.was || defaultBranch(hire.kinds[hire.index]) };
}

// `agent.start` waits for the agent to reach its own prompt, which can take the
// better part of a minute, and every request on the main socket is queued behind
// the one in front of it. So a hire gets its own connection: the office keeps
// polling and animating while somebody is being shown to their desk.
async function startHire(kind) {
  if (!hire || hire.pending || !kind) return;
  const wantsWorktree = hire.worktree;
  // Sanitized once, here, at the last possible moment: what goes on the wire is a
  // name git will accept, and the field keeps whatever was typed into it.
  const branch = wantsWorktree ? sanitizeBranch(hire.branch) || defaultBranch(kind) : null;
  if (DEMO) {
    note(wantsWorktree
      ? `demo mode: would make a worktree on ${branch} and start ${kind} in it`
      : `demo mode: would open a tab and start ${kind} in it`);
    return;
  }
  hire = { ...hire, pending: kind, error: null, editing: false };
  prevLines = [];
  draw();
  // Same project as everyone else, by default: an agent hired into the wrong
  // directory is worse than no agent, and the focused desk is the best guess at
  // what you are actually working on. For a worktree it is also the repository the
  // new branch comes off.
  const cwd = (roster.people.find((p) => p.focused) || roster.people[0])?.cwd || undefined;
  let side = null;
  try {
    side = await new ApiClient().open();
    // `worktree.create` brings its own workspace, tab and pane, so it replaces
    // tab.create rather than being done alongside it. `trust_repository` is
    // deliberately not sent: auto-trusting a repository on somebody's behalf is
    // exactly the prompt they asked herdr to show them, so a untrusted repo
    // surfaces as an error here instead of being waved through.
    const made = wantsWorktree
      ? await side.request('worktree.create', { cwd, branch, label: branch, focus: false }, 30000)
      : await side.request('tab.create', { cwd, label: kind, focus: false });
    const paneId = made?.root_pane?.pane_id;
    if (!paneId) throw new Error(`herdr made ${wantsWorktree ? 'a worktree' : 'a tab'} with no pane in it`);
    await side.request('agent.start', { name: kind, kind, pane_id: paneId, timeout_ms: HIRE_TIMEOUT_MS }, HIRE_TIMEOUT_MS + 5000);
    hire = null;
    selectedId = paneId;
    note(wantsWorktree ? `${kind} is on ${branch} now` : `${kind} is at a desk now`);
    prevLines = [];
    await refresh();
  } catch (err) {
    // Whatever got made is left where it is on purpose. A pane at a shell prompt
    // is harmless, and closing panes (or deleting a worktree, and the branch and
    // the files in it) on somebody's behalf because a start timed out is how you
    // throw away the thing they had just started typing in.
    const left = wantsWorktree ? 'The worktree it made is still there.' : 'The tab it opened is still there.';
    const why = `could not hire ${kind}: ${err.code || err.message}. ${left}`;
    if (hire) hire = { ...hire, pending: null, error: why };
    else note(why);
  } finally {
    side?.close();
    prevLines = [];
    draw();
  }
}

/* ------------------------------------------------------------- assigning work */

// `agent.prompt` puts text into a real agent's input and makes it act on it. It is
// the only thing the office does that cannot be undone, reversed or answered
// again, so it is the most guarded: the field has to be opened deliberately, the
// text has to be typed, and a broadcast has to be confirmed against a list of
// names before a single request goes out. Nothing here is clickable.
let compose = null;

// Long enough for an agent that is thinking about the prompt before acknowledging
// it, short enough that a wedged one does not hold the field open all afternoon.
const PROMPT_TIMEOUT_MS = 20000;

// Saying no, and saying so on the screen this instant. note() alone waits for the
// next animation tick, which on a refusal reads as a key that did nothing.
function refuse(text) {
  note(text);
  draw();
}

function openCompose(scope) {
  if (compose) return;
  const person = scope === 'one' ? roster.find(selectedId) : null;
  if (scope === 'one') {
    if (!person) return refuse(selectedId === HIRE_ID ? 'nobody sits there yet' : 'nobody selected');
    // The server rejects a blocked agent outright, before anything is sent. Saying
    // so here is better than letting somebody type out a paragraph first.
    if (person.status === 'blocked') return refuse(`${person.name} has a hand up: answer that first`);
  }
  const { to, skipped } = scope === 'all'
    ? broadcastTargets(roster.people)
    : { to: [person], skipped: { blocked: 0, working: 0 } };
  if (scope === 'all' && !to.length) return refuse('nobody is free to take a new job right now');
  // Assign and the hire menu are the same half of the pane, and half-typed text is
  // the more valuable of the two, so opening one puts the other away.
  hire = null;
  detail = null;
  compose = {
    scope,
    id: person?.id || null,
    name: person?.name || null,
    text: '',
    to,
    skipped,
    confirm: false,
    sending: false,
    error: null,
  };
  prevLines = [];
  draw();
}

function closeCompose() {
  if (!compose) return;
  compose = null;
  prevLines = [];
  draw();
}

// One `agent.prompt` per recipient, on its own connection: `wait` is not used, but
// a slow agent still takes a moment to acknowledge, and requests on the main socket
// are queued behind each other, so a standup would otherwise freeze the room.
//
// Sent one at a time rather than in parallel because the client serializes anyway,
// and because a partial failure has to be reportable as "four of five", not as one
// rejected promise.
async function sendCompose() {
  if (!compose || compose.sending) return;
  const text = cleanPrompt(compose.text);
  if (!text) {
    // A blank prompt is a keystroke sent to an agent for no reason.
    compose = { ...compose, error: 'nothing typed yet' };
    prevLines = [];
    draw();
    return;
  }
  const to = compose.to || [];
  if (!to.length) {
    compose = { ...compose, error: 'nobody to send that to' };
    prevLines = [];
    draw();
    return;
  }
  if (DEMO) {
    note(`demo mode: would send "${truncateNote(text)}" to ${to.map((p) => p.name).join(', ')}`);
    compose = null;
    prevLines = [];
    draw();
    return;
  }
  compose = { ...compose, sending: true, confirm: false, error: null };
  prevLines = [];
  draw();
  let side = null;
  const failed = [];
  try {
    side = await new ApiClient().open();
    for (const person of to) {
      try {
        await side.request('agent.prompt', { target: person.id, text }, PROMPT_TIMEOUT_MS);
      } catch (err) {
        failed.push(`${person.name} (${err.code || err.message})`);
      }
    }
  } catch (err) {
    failed.push(`nobody (${err.code || err.message})`);
  } finally {
    side?.close();
  }
  const sent = to.length - failed.length;
  compose = null;
  if (!sent) note(`could not assign that: ${failed.join(', ')}`);
  else if (failed.length) note(`sent to ${sent} of ${to.length}; not ${failed.join(', ')}`);
  else note(to.length === 1 ? `${to[0].name} is on it` : `sent to all ${to.length}`);
  prevLines = [];
  draw();
  // They should be turning green about now, so do not wait out the poll to say so.
  setTimeout(() => refresh(), 500);
}

// The footer is one line, and a four-hundred character prompt is not.
function truncateNote(text) {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

// Nothing while the button is up. Once it goes down on a desk this holds where
// it went down, so a press can turn out to have been a drag later without the
// click handler having had to guess up front.
let drag = null;

function cancelDrag() {
  if (!drag) return;
  drag = null;
  prevLines = [];
  draw();
}

// All the deciding happens in nextDrag; this only carries it out. Walking over
// to whoever is under the pointer happens on every outcome, so the footer hints
// and the next keystroke are about the desk you just touched.
function onMouse(ev) {
  // The assign field draws no buttons, and while it is open the mouse does nothing
  // at all: the floor underneath it still has [y] and [n] on it, and a click that
  // answered somebody's approval prompt while you were writing a sentence would be
  // the worst kind of accident in here.
  if (compose) return;
  const { drag: next, act } = nextDrag(drag, ev, hitboxes);
  drag = next;
  if (!act) return;
  if (act.id) selectedId = act.id;
  if (act.type === 'answer') {
    // The empty desk and the menu cells are buttons like [y] and [n] are, so they
    // arrive here. Neither one starts anything by itself: the desk opens the menu,
    // and only a cell in the menu is a hire.
    if (act.action === 'hire') openHire();
    else if (act.action === 'hire:where:here') setWorktree(false);
    else if (act.action === 'hire:where:worktree') setWorktree(true);
    else if (act.action === 'hire:branch') editBranch(true);
    else if (act.action.startsWith('hire:start:')) startHire(act.action.slice(11));
    else respond(act.action);
  } else if (act.type === 'open') {
    if (act.id === HIRE_ID) openHire();
    else loadDetail(act.id, { force: true });
  } else if (act.type === 'swap') {
    selectedId = act.from;
    swapDesks(act.from, act.to);
  } else if (act.type === 'cancel') note('put it back');
  // A desk that has been in the air has left pale borders and lifted rows behind
  // it, so the cheap line-diff repaint cannot be trusted for this frame.
  if (act.type === 'swap' || act.type === 'cancel') prevLines = [];
  draw();
}

// `/` gives the keyboard to the filter field. Reopening keeps what is already
// there, because narrowing "waiting" to "waiting sso" is the common second thought.
function openFilter() {
  filtering = true;
  prevLines = [];
  draw();
}

function closeFilter(clear) {
  filtering = false;
  if (clear) filter = '';
  ensureSelection();
  prevLines = [];
  draw();
}

function onInput(chunk) {
  const str = chunk.toString('utf8');

  // A chunk can carry a whole run of motion reports, and mid-drag it usually
  // does, so every one of them gets handled rather than just the first.
  const mice = parseMouse(str);
  if (mice.length) {
    for (const ev of mice) onMouse(ev);
    return;
  }

  if (str === '\x03' || str === 'q') return quit(0);
  // esc closes the panel. Enter no longer does: the panel shares the pane with
  // the floor now, so enter still means "show me this desk" even while one is
  // open, which is what walking to a new desk and hitting it should do.
  if (str === '\x1b') {
    // A desk in mid-air outranks the panel: esc puts it down first.
    if (drag) return cancelDrag();
    // Backing out of a confirm goes back to the text rather than throwing it away,
    // because "wait, who does this reach" should not cost you the paragraph.
    if (compose?.confirm) {
      compose = { ...compose, confirm: false };
      prevLines = [];
      draw();
      return;
    }
    if (compose) return compose.sending ? undefined : closeCompose();
    // And a half-typed branch name outranks the menu it is in, so esc puts the
    // old name back rather than throwing away the whole hire you were setting up.
    if (hire?.editing) {
      hire = { ...hire, editing: false, branch: hire.was || defaultBranch(hire.kinds[hire.index]) };
      prevLines = [];
      draw();
      return;
    }
    if (hire) return closeHire();
    // The field, then whatever panel is open, then the filter itself. So esc walks
    // back out the way you came in rather than throwing away a filter you are
    // still using because a panel happened to be open.
    if (filtering) return closeFilter(true);
    if (detail) {
      detail = null;
      prevLines = [];
      draw();
      return;
    }
    if (terms(filter).length) return closeFilter(true);
    prevLines = [];
    draw();
    return;
  }

  // The assign field has the keyboard outright: every printable key is a letter in
  // the prompt, and nothing falls through to the floor. It has to be this way, or a
  // `y` typed into a sentence would answer somebody's approval prompt for them.
  if (compose) {
    if (compose.sending) return;
    if (compose.confirm) {
      // The only two keys that mean anything here. Enter sends, and it is the second
      // deliberate enter, against a list of names that is on the screen.
      if (str === '\r' || str === '\n') sendCompose();
      return;
    }
    const { text, done } = typePromptChunk(compose.text, str);
    compose = { ...compose, text, error: null };
    // A single assign sends on enter. A broadcast steps through a confirm first,
    // because it is one keystroke turning into N irreversible writes.
    if (done) {
      if (compose.scope === 'all' && cleanPrompt(text)) compose = { ...compose, confirm: true };
      else sendCompose();
    }
    prevLines = [];
    draw();
    return;
  }

  // While the menu is open the arrows are picking an agent, not walking the floor.
  // Everything else is swallowed, because a keystroke meant for the menu must not
  // fall through and answer a prompt at whatever desk was selected before.
  if (hire) {
    if (hire.pending) return;
    // And while the branch field has the keyboard, every printable key is a letter
    // in a branch name. Not a menu key, not a hire: the only way out is enter or
    // esc, so nothing can be started by a stray keystroke aimed at the field.
    if (hire.editing) {
      const { branch, done } = typeChunk(hire.branch, str);
      hire = { ...hire, branch };
      if (done) editBranch(false);
      prevLines = [];
      draw();
      return;
    }
    if (str === '\x1b[A' || str === 'k') moveHire(0, -1);
    else if (str === '\x1b[B' || str === 'j') moveHire(0, 1);
    else if (str === '\x1b[D' || str === 'h') moveHire(-1, 0);
    else if (str === '\x1b[C' || str === 'l' || str === '\t') moveHire(1, 0);
    else if (str === 'w') setWorktree(true);
    else if (str === 't') setWorktree(false);
    else if (str === 'e') editBranch(true);
    else if (str === '\r' || str === '\n' || str === ' ') startHire(hire.kinds[hire.index]);
    prevLines = [];
    draw();
    return;
  }

  // Same bargain as the assign field: while the filter has the keyboard every
  // printable key is a letter in it, so a `y` typed into a filter cannot answer
  // somebody's approval prompt.
  if (filtering) {
    const { text, done } = typeFilterChunk(filter, str);
    filter = text;
    // Selection has to keep up with the field: typing a letter that hides the desk
    // you were standing at should walk you to the first one that is left, not leave
    // the cursor on somebody who is no longer in the room.
    ensureSelection();
    if (done) return closeFilter(false);
    prevLines = [];
    draw();
    return;
  }

  if (str === '/') return openFilter();
  if (str === '+') return openHire();
  if (str === 'a') return openCompose('one');
  if (str === 'A') return openCompose('all');
  if (str === '\x1b[A' || str === 'k') move(0, -1);
  else if (str === '\x1b[B' || str === 'j') move(0, 1);
  else if (str === '\x1b[D' || str === 'h') move(-1, 0);
  else if (str === '\x1b[C' || str === 'l') move(1, 0);
  else if (str === '\t') move(1, 0);
  else if (str === '\r' || str === '\n' || str === ' ') {
    if (selectedId === HIRE_ID) openHire();
    else if (selectedId) loadDetail(selectedId, { force: true });
  } else if (str === 'y') respond('approve');
  else if (str === 'n') respond('deny');
  else if (str === 'f') jumpToPane();
  else if (str === 'b') nextRaisedHand();
  else if (str === 'F') toggleFollow();
  else if (str === 'z') {
    zoom = nextZoom(zoom);
    // Said out loud, because on a small pane 'auto' and 'list' can look identical:
    // the floor plan degrades to the list on its own when there is no room for desks,
    // and without the message the key would look broken on exactly the panes where
    // somebody is most likely to reach for it.
    note(zoom === 'auto' ? 'floor plan' : zoom === 'list' ? 'list view' : 'one desk');
  }
  else if (str === 'r') {
    refresh();
    if (detail) loadDetail(detail.id, { force: true });
    note('refreshed');
  } else return;

  if (detail && selectedId && selectedId !== HIRE_ID && detail.id !== selectedId) loadDetail(selectedId, { force: true });
  draw();
}

/* --------------------------------------------------------------------- demo */

let demoTick = 0;
const DEMO_TABS = ['socket-client', 'login-flow', 'flaky-tests', 'deps', 'office-plugin', 'triage', 'null-hunt'];
// Three workspaces, because one was hiding the thing rooms exist to show. Real
// sessions spread across a few, and a demo floor where every desk is in the same
// one could never have caught a wall painted the wrong colour.
const DEMO_WORKSPACES = [
  { workspace_id: 'w1', label: 'herdr-office', number: 1 },
  { workspace_id: 'w2', label: 'web-app', number: 2 },
  { workspace_id: 'w3', label: 'notes', number: 3 },
];
function demoAgents() {
  demoTick += 1;
  roster.setWorkspaces(DEMO_WORKSPACES);
  const cycle = ['working', 'working', 'blocked', 'idle', 'done', 'unknown'];
  const desks = [
    ['w1:p1', 'claude', 'refactor the socket client'],
    ['w1:p2', 'kiro', 'rewrite the login flow'],
    ['w1:p3', 'codex', 'fix a flaky test'],
    ['w2:p1', 'opencode', 'bump deps'],
    ['w2:p2', 'claude', 'write the office plugin'],
    ['w3:p1', 'gemini', 'triage the bug queue'],
    ['w3:p2', 'kiro', 'chase a null pointer'],
  ];
  roster.setTabs(desks.map(([pane_id], i) => ({ tab_id: `${pane_id.split(':')[0]}:t${i + 1}`, label: DEMO_TABS[i], number: i + 1 })));
  return desks.map(([pane_id, agent, title], i) => ({
    pane_id,
    agent,
    // Room, repo and checkout agree with each other, because a demo where the card
    // said one workspace and the cwd under it said another repo would be teaching
    // the reader something that is not true of a real session.
    agent_status: cycle[(i + Math.floor(demoTick / 6)) % cycle.length],
    workspace_id: pane_id.split(':')[0],
    tab_id: `${pane_id.split(':')[0]}:t${i + 1}`,
    // A checkout each, because that is how a floor of agents on different branches
    // actually looks: one desk in the repo itself and the rest in linked worktrees.
    cwd: DEMO_BRANCHES[i]
      ? `/Users/you/Desktop/projects/${DEMO_WORKSPACES.find((w) => w.workspace_id === pane_id.split(':')[0]).label}${
        i ? `/.worktrees/${DEMO_BRANCHES[i].replace(/\//g, '-')}` : ''
      }`
      // The one desk with no branch is somewhere that is not a repository at all,
      // which has to be its own directory: a branch is a fact about a checkout, so
      // two desks in the same checkout cannot disagree about it, and the cache is
      // keyed that way on purpose.
      : '/Users/you',
    terminal_title_stripped: title,
    focused: i === 0,
    state_change_seq: 1,
  }));
}

// The parts of a desk that come from a follow-up call rather than agent.list: the
// bubble over a stuck person's head and the command on a working monitor. Real
// runs get these from agent.read and pane.process_info; the demo makes them up,
// deterministically, so the recorded GIF and the --once render are the same
// office every time. One command is deliberately longer than the twelve cells a
// monitor has, because that is the case worth being able to look at.
// One desk on main and the rest on their own branches, which is the arrangement the
// feature exists for: telling those two apart from across the room.
const DEMO_BRANCHES = ['main', 'feature/sso', 'fix/flaky-tests', 'renovate/deps', 'office-plugin', 'triage', null];

const DEMO_COMMANDS = ['npm test', 'cargo build', 'git rebase', 'pytest -x --last-failed', 'tsc', 'make'];

// News is normally driven by `pane.output_matched`, which the demo has no server
// for, so a couple of lines are fed through the real classifier rather than
// having their labels written out here. That way the demo cannot show a label the
// live office could not produce.
const DEMO_OUTPUT = ['42 passed, 0 failed', '1 failed, 41 passed', 'CONFLICT (content): merge conflict in src/render.mjs', '3 files changed, 41 insertions(+)'];

function demoExtras() {
  roster.people.forEach((person, i) => {
    if (person.status === 'blocked') roster.setAsk(person.id, 'apply the patch?', approvalChoice(['apply the patch? (y/n)']));
    if (person.status === 'working') roster.setCommand(person.id, DEMO_COMMANDS[i % DEMO_COMMANDS.length]);
    roster.setBranch(person.cwd, { branch: DEMO_BRANCHES[i % DEMO_BRANCHES.length], repo: person.workspaceName || 'herdr-office' });
    // Every third desk has just had some news, so the demo shows the slab without
    // the whole floor shouting at once.
    if (person.status !== 'blocked' && i % 3 === 1) {
      const news = eventFromMatch({ matched_line: DEMO_OUTPUT[i % DEMO_OUTPUT.length] });
      if (news) roster.setEvent(person.id, news.label, news.kind);
    }
  });
}

/* --------------------------------------------------------------------- boot */

const anim = setInterval(() => {
  frame += 1;
  if (detail) loadDetail(detail.id);
  // News puts itself away. It expires on a clock rather than on the next poll,
  // because a quiet office might not poll anything into a different state for
  // minutes and a stale "tests passed" would sit there the whole time.
  roster.expireEvents();
  draw();
}, ANIM_MS);

const poll = setInterval(refresh, POLL_MS);

async function main() {
  if (!DEMO) {
    try {
      api = await new ApiClient().open();
    } catch (err) {
      clearInterval(anim);
      clearInterval(poll);
      process.stderr.write(
        `herdr-office: cannot reach the Herdr socket at ${resolveSocketPath()}\n` +
          `  ${err.message}\n  Is the server running? Try: herdr status\n`,
      );
      process.exit(1);
    }
  }

  if (ONCE) {
    clearInterval(anim);
    clearInterval(poll);
    if (DEMO) {
      roster.update(demoAgents());
      demoExtras();
      clocks.observe(roster.people);
    } else {
      const snapshot = await api.request('session.snapshot', {}).catch(() => null);
      const tabs = await api.request('tab.list', {}).catch(() => null);
      seat(snapshot, tabs);
      const list = await api.request('agent.list', {});
      roster.update(list.agents || []);
      clocks.observe(roster.people);
      await refreshAsks();
      await refreshCommands();
    }
    ensureSelection();
    if (argv.has('--detail') && selectedId) await loadDetail(selectedId, { force: true });
    process.stdout.write(renderFrame(view()).lines.join('\n') + '\n');
    api?.close();
    events?.close();
    process.exit(0);
  }

  enterTerminal();
  await refresh();
  draw();
}

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
process.on('uncaughtException', (err) => quit(1, `herdr-office crashed: ${err.stack}`));

main();
