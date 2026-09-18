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
//   node office.mjs --no-graphics  text only, no pixel charts
//   node office.mjs --no-git   do not run git in anybody's checkout
//   node office.mjs --no-context  do not read how full anybody's context window is
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
import { readProcessTable, paneProcesses } from './src/ps.mjs';
import { WATCH_PATTERN, eventFromMatch, newsFromEvent } from './src/events.mjs';
import { windowTitle } from './src/title.mjs';
import { escalate } from './src/escalate.mjs';
import { filterPeople, typeFilterChunk, terms } from './src/filter.mjs';
import { follow } from './src/follow.mjs';
import { assignRooms } from './src/rooms.mjs';
import { Clocks } from './src/punchclock.mjs';
import { load as loadState, save as saveState } from './src/state.mjs';
import { branchFromList } from './src/branches.mjs';
import { readDirt } from './src/dirt.mjs';
import { parseGauge, compactionNews } from './src/head.mjs';
import { Graphics, graphicsLog } from './src/graphics.mjs';
import { timeChart, attentionStrip } from './src/charts.mjs';

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
// Pixels, in the two places a chart beats a sentence. Opt-out for the same reason
// toasts are: the pane is asked once whether it can draw at all, and a terminal
// that says no is never asked again, so there is nothing here for a default to
// break. What it is opt-out *for* is taste: some people want a terminal to be
// only text, and that is a preference, not a capability.
const GRAPHICS = !argv.has('--no-graphics');
// Whether the office may run `git status` in the checkouts its desks are sitting in, to
// say how much is uncommitted. Opt-out rather than opt-in because it is the answer to
// the question people actually have about a floor of agents, and because what it runs is
// a read that cannot take a lock (see src/dirt.mjs). Opt-out at all because it is the
// one thing the office does that is not a socket call: somebody watching agents on a
// machine where git is expensive, or who would simply rather this pane never shelled
// out into their repositories, gets to say no in one flag.
const GIT = !argv.has('--no-git');
// Whether the office may read how full each agent's context window is (see src/head.mjs).
// On by default because it is the question a floor of agents cannot otherwise answer, and
// opt-out because of what it costs on the wire: this is the one feature that reads the
// visible screen of every desk on a rotation rather than only the desks with their hands
// up. Nothing off those screens is drawn or kept, and somebody who would still rather this
// pane were not looking gets to say so in one flag.
const HEAD = !argv.has('--no-context');
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
// How often the whiteboard is written to disk. Not on every observe, which runs twice
// a second and would put a file write on the poll path for numbers nobody has read
// yet. Fifteen seconds is the most a crash can cost, measured in whiteboard rather
// than in anything that matters, and the ordinary exit writes on the way out anyway.
const SAVE_MS = 15000;
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
//
// It is also one `ps` per pass, shared by every desk in that pass, because the
// jobs an agent starts are not in the pane's foreground process group and so are
// not in that response at all (src/ps.mjs says why, at length). That is 90ms and
// 270KB for the whole floor, once per throttle window rather than once per desk.
const CMD_MS = 5000;
const CMD_PER_PASS = 4;
// Branches move a lot less often than a foreground process does, so they are asked
// for far less often, and the answer is cached per working directory rather than per
// desk: twelve panes in one checkout are one question. A checkout somebody is
// actively switching branches in catches up within half a minute, which is the right
// trade for a wall display.
const BRANCH_MS = 30000;
const BRANCH_PER_PASS = 2;
// The pile of paper on a desk is one `git status` per checkout, so it is throttled and
// capped the same way branches are, and cached against the same key. Twice as often as a
// branch, because it moves the other way round: a branch changes once an afternoon and
// the number of uncommitted files changes every time an agent writes a file, which on a
// working floor is constantly. Fifteen seconds is close enough for a wall display and
// far enough apart that the subprocess cost is nothing anybody can feel.
const DIRT_MS = 15000;
const DIRT_PER_PASS = 2;
// How full a head is comes off the same screen read as the bubble over a stuck desk, so on
// a floor where everybody is blocked it is free. Everywhere else it is one extra
// `agent.read` per desk per window, which is the cheapest call the office makes: the
// visible screen is a few kilobytes and the server has it in hand.
//
// Ten seconds, which is not about how fast the number moves. It climbs about a point a
// minute under a working agent, so for the gauge itself a minute would do. It is about the
// one thing that moves it sharply: a compaction is detected by comparing two readings, and
// a compaction you hear about a minute after it happened is history rather than news. Four
// desks a pass keeps a floor of twenty inside a minute even when none of the reads are
// shared with a bubble.
const GAUGE_MS = 10000;
const GAUGE_PER_PASS = 4;
// How much of a desk's screen the server matches the watchlist against, counted up
// from the bottom. This was 8, on the reasoning that news is the last thing printed,
// and 8 is almost exactly wrong for the panes this office watches: an agent in a
// full-screen UI keeps its input box and its hints at the bottom of the screen, so the
// last eight lines are chrome and the test run is above them. Measured against a live
// agent pane, a phrase plainly on screen produced no event at 4 or 8 lines and fired at
// 12, which puts that pane's chrome at about ten rows.
//
// So the window has to clear the chrome, and 24 is that with room for another agent's
// UI being taller. It is not the whole screen, deliberately. The match is edge
// triggered: the server fires when the window starts matching and stays quiet while it
// still does, so the wider the window the longer one old failure sitting on screen
// suppresses everything after it. A window that scrolls is what keeps news arriving.
//
// Where exactly the sweet spot is between those two was not settled, and could not be
// on the pane available to measure from: it renders in a way that kept the test phrase
// on screen throughout, so the rollover timings from it say more about that agent's UI
// than about the server. 24 is a reasoned floor, not a measured optimum.
const MATCH_LINES = 24;

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
// The pixel layers, when the pane can take them. Null the whole time in --demo and
// --once, which have no socket and no pane to draw into respectively.
let graphics = null;
// The timer that writes the punch clock down. Null in --demo, whose numbers are made
// up and must never land in the state file, and in --once, which is over before the
// first tick would fire.
let saveTimer = null;
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
    // A resize moves the rectangles the pixel layers were placed into, so whatever
    // is on screen is in the wrong place until the redraw lands. Uncovering the rows
    // means the text comes back first and the picture goes over it again a frame
    // later, rather than a stale chart sitting over a floor that has moved.
    covered = new Set();
    draw();
  });
}

function leaveTerminal() {
  // Both trackers off, in case something upstream left 1000 on.
  process.stdout.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

// Pick up this morning, if there was one. Called before the first `observe`, because
// `restore` sets the floor that stops the desks about to walk in from being credited
// with time already banked. Demo numbers are invented, so the demo never reads or
// writes the real file.
function openTheBooks() {
  if (DEMO) return;
  const saved = loadState();
  if (saved) clocks.restore(saved);
}

// The other half. Synchronous and failure-swallowing all the way down, which is what
// lets `quit` call it without spending any of its half-second budget.
function closeTheBooks() {
  if (DEMO) return;
  saveState(clocks.snapshot());
}

function quit(code = 0, msg) {
  if (stopped) return;
  stopped = true;
  clearInterval(anim);
  clearInterval(poll);
  clearInterval(saveTimer);
  // Before the socket goes, and before anything that could throw. Everything since
  // the last tick of SAVE_MS would otherwise be the one part of the day that the
  // office watched and then forgot, and quitting is exactly when it happens.
  closeTheBooks();
  events?.close();
  leaveTerminal();
  if (msg) process.stderr.write(`${msg}\n`);
  // The socket stays open just long enough to give the window title back and take
  // the office's pixels down with it, then goes regardless. Half a second is the
  // whole budget for both: an office that would not quit because a title would not
  // clear is worse than a stale title, and the same goes for a leftover chart.
  const done = () => {
    api?.close();
    process.exit(code);
  };
  const bail = setTimeout(done, 500);
  bail.unref?.();
  Promise.all([clearTitle(), graphics?.clear() ?? Promise.resolve()])
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
    trust,
  };
}

let hitboxes = [];
let grid = { cols: 0, rows: 0, ids: [], menuCols: 1, menuVisible: 0 };

// Screen rows currently hidden behind a pixel layer. The renderer still produces
// their text and the diff below still remembers it; the bytes are just never
// written. An image occludes the cells underneath it rather than compositing with
// them, so writing that row again would punch the text back through the middle of
// the picture, and at 320ms the office would flicker between the two.
let covered = new Set();

function draw() {
  const model = view();
  const rendered = renderFrame(model);
  hitboxes = rendered.hitboxes;
  grid = rendered.grid;
  const { cols, rows } = size();
  let out = '';
  for (let i = 0; i < rows; i += 1) {
    const line = rendered.lines[i] ?? '';
    if (prevLines[i] === line) continue;
    // Remembered either way, so the diff stays honest about what the office has
    // decided this row should say, whether or not it was allowed to say it.
    prevLines[i] = line;
    if (covered.has(i)) continue;
    // Only clear the tail when there is a tail. On a line that already fills the
    // row the cursor is sitting in the last column with a pending wrap, and an
    // erase-to-end-of-line there eats the character we just drew.
    out += `\x1b[${i + 1};1H${line}${width(line) < cols ? '\x1b[K' : ''}`;
  }
  if (out) process.stdout.write(out);
  paintPixels(model, rendered.regions);
}

// Turns the rectangles renderFrame volunteered into pixel layers. Runs after the
// text has gone out, never before: the cells have to be on the screen before an
// image is placed over them, or the first frame draws the picture and then paints
// the floor on top of it.
//
// The mapping lives here rather than in src/graphics.mjs because this is the only
// file that knows what the office is looking at. graphics.mjs moves pictures; it
// has no opinion about what they are of.
function paintPixels(model, regions) {
  const caps = graphics?.caps;
  const next = new Set();
  graphicsLog(
    `paint: graphics=${Boolean(graphics)} caps=${Boolean(caps)} visible=${caps?.visible} ` +
      `regions=[${(regions || []).map((r) => `${r.kind} ${r.w}x${r.h}+${r.x},${r.y}`).join('; ') || 'none'}]`,
  );
  if (caps && caps.visible) {
    const frames = [];
    for (const region of regions || []) {
      const drawn =
        region.kind === 'strip'
          ? // The WHOLE roster, not the filtered floor. The strip's entire job is to
            // say what is not on screen, and a filter is the commonest reason for
            // something not being on screen.
            attentionStrip(roster.people, selectedId, region.w, region.h, caps)
          : region.kind === 'board'
            ? timeChart(model.stats, region.w, region.h, caps)
            : null;
      // A chart that decided its rectangle was too small to say anything returns
      // null, and then the text it would have replaced simply stays.
      if (!drawn) {
        graphicsLog(`paint: ${region.kind} declined its ${region.w}x${region.h} rectangle`);
        continue;
      }
      frames.push({ id: `office.${region.kind}`, region, ...drawn });
      for (let y = region.y; y < region.y + region.h; y += 1) next.add(y);
    }
    graphics.sync(frames);
  }
  // A row that has just come out from behind a layer has to be written again. It was
  // deliberately skipped while it was covered, so the diff believes the terminal
  // already has it and would otherwise leave the picture sitting there.
  for (const y of covered) if (!next.has(y)) prevLines[y] = null;
  covered = next;
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

// What is on each desk's screen, for the two things the office takes off one: what a
// stuck desk is asking for, and how full every desk's head is.
//
// One read serves both, which is the whole reason they are in the same function. A stuck
// desk is read often, because the bubble over its head is the most useful thing on the
// floor and it is the thing a person is waiting on. Everybody else is read on a slow
// rotation for the gauge alone. A desk due for both is read once, and the per-pass cap
// counts only the desks that would not have been read anyway: the gauge is free on the
// desks that were already talking.
async function refreshScreens() {
  const dueAsks = roster.people.filter((p) => p.status === 'blocked' && roster.askAge(p.id) >= ASK_MS);
  const asking = new Set(dueAsks.map((p) => p.id));
  // Stalest first, so a floor with more desks than one pass allows rotates through them
  // fairly instead of starving the ones at the bottom. Every desk counts, not just the
  // working ones: an idle agent that is ninety per cent full is precisely the desk you
  // were about to hand the next job to.
  const dueGauges = HEAD
    ? roster.people
      .filter((p) => !asking.has(p.id) && roster.headAge(p.id) >= GAUGE_MS)
      .sort((a, b) => roster.headAge(b.id) - roster.headAge(a.id))
      .slice(0, GAUGE_PER_PASS)
    : [];
  const due = [...dueAsks, ...dueGauges];
  if (!due.length) return;
  await Promise.all(
    due.map(async (person) => {
      let text = null;
      try {
        const res = await api.request('agent.read', { target: person.id, source: 'visible' });
        text = res?.read?.text ?? '';
      } catch {
        // A desk that will not talk keeps whatever it last said.
      }
      if (asking.has(person.id) && text != null) {
        const lines = cleanOutput(text);
        roster.setAsk(person.id, bubbleText(lines), approvalChoice(lines));
      }
      if (HEAD) readHead(person, text);
    }),
  );
  if (!ONCE) draw();
}

// How full this desk's head is, off the screen we already have (see src/head.mjs for what
// is looked for and what is thrown away, which is everything else on that line).
//
// A read that failed and a screen that says nothing about its context window are recorded
// the same way, as null: both mean the office does not know, both stop the desk claiming a
// number it can no longer vouch for, and both are stored as answers so the same desk is
// not asked again on the next pass.
function readHead(person, text) {
  const before = roster.head(person.id);
  const after = text == null ? null : parseGauge(text, person.sessionId);
  roster.setHead(person.id, after);
  // A window that emptied itself, hung over the desk like any other piece of news. Worked
  // out here rather than in the roster because it is a fact about two readings, and the
  // roster only ever holds one.
  const news = compactionNews(before, after);
  if (news) roster.setEvent(person.id, news.label, news.kind);
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
  // One table for the whole pass. Read before the loop rather than inside it, so a
  // floor of four working desks is one `ps` and not four.
  const table = await readProcessTable();
  for (const person of due) {
    try {
      const res = await api.request('pane.process_info', { pane_id: person.id });
      roster.setCommand(person.id, runningCommand(paneProcesses(res?.process_info, table)));
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

// How much is uncommitted in each checkout, via `git status` (see src/dirt.mjs for what
// is run and why it cannot take a lock). Cached per working directory like the branch,
// stalest first, a couple at a time.
//
// Only ever asked about a directory `worktree.list` has already said is a repository.
// That is not an optimisation, it is the rule that keeps this contained: the office
// never runs git speculatively in a directory somebody's pane happens to be sitting in,
// only in checkouts the server has already told it are checkouts.
async function refreshDirt() {
  if (!GIT) return;
  const dirs = [...new Set(roster.people.filter((p) => p.cwd && p.repo).map((p) => p.cwd))]
    .filter((cwd) => roster.dirtAge(cwd) >= DIRT_MS)
    .sort((a, b) => roster.dirtAge(b) - roster.dirtAge(a))
    .slice(0, DIRT_PER_PASS);
  if (!dirs.length) return;
  for (const cwd of dirs) {
    // readDirt always resolves: a checkout that will not answer is recorded as having
    // nothing to say, so it is not asked again on the next pass.
    roster.setDirt(cwd, await readDirt(cwd));
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
    refreshScreens();
    refreshCommands();
    refreshBranches();
    refreshDirt();
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
// The last thing the stream complained about, so a subscription the server will never
// accept is said once rather than on every rebuild for the rest of the session.
let streamComplaint = '';
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
        lines: MATCH_LINES,
        strip_ansi: true,
      },
    ]),
  ];
  events
    .open(
      subs,
      (msg) => onServerEvent(msg),
      (err) => {
        // Force a resubscribe on the next poll if the stream dies.
        subscribedTo = '';
        // And say so, once, because this used to be discarded. The server rejects the
        // whole subscribe request if any one descriptor in it is bad and then closes
        // the stream, so a single renamed event name in a future protocol would leave
        // the office quietly poll-only with nothing on screen to suggest why. Not
        // fatal, which is why it is a note and not a quit: polling still works.
        if (err?.message && err.message !== streamComplaint) {
          streamComplaint = err.message;
          note(`events: ${err.message}`, 6000);
        }
      },
    )
    .catch((err) => note(`events: ${err.message}`));
}

// An event off the stream. Everything gets a poll scheduled, because the roster is
// the source of truth for state; an output match additionally puts a line of news
// over the desk it came from.
//
// The matched output is never drawn. newsFromEvent turns it into one of the office's
// own fixed labels or into nothing at all, so an error message with a path or a token
// in it cannot end up on the wall. It also owns reading the stream's envelope, which
// used to be done here and was wrong the whole time (see src/events.mjs).
function onServerEvent(msg) {
  const news = newsFromEvent(msg);
  if (news && roster.find(news.paneId)) {
    roster.setEvent(news.paneId, news.label, news.kind);
    draw();
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

// Reading a desk. The `visible` source is a plain screen snapshot and is what
// "what are you up to" means; the `recent` sources page through alternate-screen
// scrollback, which is more history than the question asked for, so they are a
// bonus on a quiet desk rather than the primary source.
//
// This used to say that a `recent` read against a busy agent could drop the
// connection outright. It does not: measured against herdr 0.9.0 on 2026-09-17,
// every source answers on a busy full-screen agent, at every line count up to the
// ~1000 lines the server keeps. What was really being seen is that the server
// closes the connection after every answer, whatever was asked. The try/catch
// stays because a read can still fail for ordinary reasons and scrollback is
// genuinely optional.
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

// agent.explain returns a huge rule-evaluation dump, tens of kilobytes for one
// desk, so it is fetched per card and cached rather than polled.
//
// It goes through the CLI, which is no longer required: the note here used to say
// the socket hung up mid-response on explain, and on herdr 0.9.0 on 2026-09-17 it
// answers fine. The CLI is kept because it works and because a dump this size is
// the one call worth keeping off the office's own socket, not because the socket
// cannot do it. describeDetection already reads either shape, so moving it back is
// a small change if the subprocess ever becomes the expensive part.
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
      // Run the demo through the real describeDetection, with a payload shaped like
      // a live one (evidence included, so the demo also proves it is not drawn).
      detection: describeDetection({
        state: person?.status || 'unknown',
        matched_rule: { id: `${person?.kind || 'agent'}_prompt_box`, priority: 950, region: 'bottom_non_empty_lines(5)', state: person?.status },
        evaluated_rules: [
          { id: 'tool_approval', matched: false, evidence: { region_preview: 'NEVER DRAWN: account 000000000000' } },
          { id: `${person?.kind || 'agent'}_prompt_box`, matched: true, evidence: { region_preview: 'NEVER DRAWN' } },
          { id: 'osc_title_idle', matched: false, evidence: { region_preview: 'NEVER DRAWN' } },
        ],
        visible_blocker: person?.status === 'blocked',
        visible_working: person?.status === 'working',
        visible_idle: person?.status === 'idle',
        manifest_source: `remote:/Users/you/.local/state/herdr/agent-detection/remote/${person?.kind || 'agent'}.toml`,
        manifest_version: '2026.09.01.1',
        remote_update_status: 'current',
      }),
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
      // herdr's own code if it gave one, because the code is the useful part on a
      // card: `agent_not_idle` and a socket that went away are different problems
      // and the difference is not visible from the outside. Which codes actually
      // turn up here is not known; the guess that used to be written down here
      // (agent_not_idle, from full-screen agents refusing scrollback) did not
      // survive being checked.
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
// The standing permission, armed but not granted.
//
// `y` answers one question and the next one comes back to you. This answers every
// question of that kind from now on, and the office is not the thing that gets to
// decide that quietly, so it is the only answer in here that takes two keys. What
// is held is the digit AND the words the menu used, because both are checked again
// at the last moment: the screen can change between arming and confirming, and a
// digit that was option 3 a second ago must not be sent into a menu that has
// since reordered.
let trust = null;

function cancelTrust() {
  if (!trust) return;
  trust = null;
  prevLines = [];
  draw();
}

// What the screen says right now, preferring the panel's read for the same reason
// respond() does: it is the fresher of the two.
function choiceFor(person) {
  return (detail?.id === person.id ? detail.choice : null) || person.choice;
}

function armTrust() {
  const person = roster.find(selectedId);
  if (!person) return;
  if (person.status !== 'blocked') return refuse(`${person.name} is not waiting on you`);
  const choice = choiceFor(person);
  if (!choice) return refuse(`still reading ${person.name}'s screen, try again in a second`);
  if (!choice.always) return refuse(`${person.name}'s prompt does not offer a "don't ask again"`);
  trust = { id: person.id, name: person.name, keys: choice.always.keys, label: choice.always.label };
  // The card comes open with it, so the menu this digit is aimed at is on the
  // screen before the confirm rather than being taken on trust.
  if (detail?.id !== person.id) loadDetail(person.id, { force: true });
  prevLines = [];
  draw();
}

// Checked again here rather than only at arming time, because the two are seconds
// apart and the agent's screen is not ours.
async function confirmTrust() {
  if (!trust) return;
  const armed = trust;
  const person = roster.find(armed.id);
  if (!person || person.status !== 'blocked') {
    trust = null;
    return refuse(`${armed.name} is not waiting on you any more`);
  }
  const now = choiceFor(person)?.always;
  if (!now || now.label !== armed.label || now.keys.join() !== armed.keys.join()) {
    trust = null;
    return refuse(`${armed.name}'s prompt changed, so nothing was sent`);
  }
  trust = null;
  if (DEMO) {
    note(`demo mode: would send ${armed.keys.join(' ')} to ${armed.name}`);
    draw();
    return;
  }
  try {
    await api.request('agent.send_keys', { target: armed.id, keys: armed.keys });
    clocks.answer();
    note(`granted: ${truncateNote(armed.label)}`);
    setTimeout(() => refresh(), 400);
    if (detail?.id === armed.id) setTimeout(() => loadDetail(armed.id, { force: true }), 600);
  } catch (err) {
    note(`could not answer ${armed.name}: ${err.code || err.message}`);
  }
  prevLines = [];
  draw();
}

async function respond(kind) {
  const person = roster.find(selectedId);
  if (!person) return;
  if (person.status !== 'blocked') {
    note(`${person.name} is not waiting on you`);
    return;
  }
  const choice = choiceFor(person);
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
  const person = scope === 'all' ? null : roster.find(selectedId);
  if (scope === 'one') {
    if (!person) return refuse(selectedId === HIRE_ID ? 'nobody sits there yet' : 'nobody selected');
    // herdr rejects a prompt to a blocked agent with agent_blocked, before any
    // input is sent. Saying so here is better than letting somebody type out a
    // paragraph first, and `s` is the key that does reach them.
    if (person.status === 'blocked') return refuse(`${person.name} has a hand up: press s to answer in words`);
  }
  // Answering in words. A waiting agent is the one case a prompt cannot reach, so
  // this goes in as keystrokes instead, which is also the only way to answer a
  // question that is not a yes or a no: "which of the two approaches" has no key.
  if (scope === 'reply') {
    if (!person) return refuse(selectedId === HIRE_ID ? 'nobody sits there yet' : 'nobody selected');
    if (person.status !== 'blocked') return refuse(`${person.name} is not waiting on you: press a to give them a job`);
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
    // What they asked, so the answer is typed with the question on the screen. It
    // is the desk's own bubble text, which is the short form of the ask.
    ask: scope === 'reply' ? person.ask || null : null,
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
  const replying = compose.scope === 'reply';
  compose = { ...compose, sending: true, confirm: false, error: null };
  prevLines = [];
  draw();
  let side = null;
  const failed = [];
  try {
    side = await new ApiClient().open();
    for (const person of to) {
      try {
        // A waiting agent takes typing, not a prompt. `pane.send_input` carries the
        // words and the enter in one request, which matters: two requests would
        // leave a window where half an answer is sitting in somebody's input box
        // waiting for a submit that failed.
        if (replying) await side.request('pane.send_input', { pane_id: person.id, text, keys: ['enter'] }, PROMPT_TIMEOUT_MS);
        else await side.request('agent.prompt', { target: person.id, text }, PROMPT_TIMEOUT_MS);
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
  if (!sent) note(replying ? `could not answer that: ${failed.join(', ')}` : `could not assign that: ${failed.join(', ')}`);
  else if (failed.length) note(`sent to ${sent} of ${to.length}; not ${failed.join(', ')}`);
  else if (replying) {
    note(`answered ${to[0].name}`);
    clocks.answer();
  } else note(to.length === 1 ? `${to[0].name} is on it` : `sent to all ${to.length}`);
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
  // Same bargain for an armed standing permission. The keyboard is already down to
  // enter and esc while one is armed, and leaving the mouse live would mean the [y]
  // still under the pointer could answer for you with the grant still armed behind
  // it, which is two answers to one question.
  if (trust) return;
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
    // An armed standing permission outranks everything else esc could close, because
    // it is the one piece of state where the next enter is irreversible.
    if (trust) return cancelTrust();
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

  // An armed standing permission has the keyboard, and only two keys mean anything.
  // Everything else is swallowed rather than falling through to the floor: walking
  // away with j while a grant is armed would leave it armed at a desk you are no
  // longer standing at, and the next enter would go somewhere you did not mean.
  if (trust) {
    if (str === '\r' || str === '\n') confirmTrust();
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
  else if (str === 'Y') armTrust();
  else if (str === 's') openCompose('reply');
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
    // Rotated slowly on purpose. Every desk changing status every twelve seconds
    // reads as a screensaver rather than an office, and it is shorter than it takes
    // to walk to a raised hand and open the card: the recording in the README kept
    // catching the desk it had just jumped to going idle underneath the panel.
    agent_status: cycle[(i + Math.floor(demoTick / 15)) % cycle.length],
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

// Uncommitted work, at every size the pile has: a clean checkout, a couple of files, a
// change nobody is going to enjoy reviewing, and one with a conflict in it. Null is in
// here too, because a directory git would not answer about is the ordinary case for
// anybody running the office over a pane that is not in a repository.
const DEMO_DIRT = [
  { files: 0, conflicts: 0 },
  { files: 2, conflicts: 0 },
  { files: 31, conflicts: 0 },
  null,
  { files: 7, conflicts: 1 },
  { files: 12, conflicts: 0 },
];

// How full each head is, at every band the gauge has: room to spare, half gone, tight,
// and one desk about to compact. Null is in here because an agent whose status line says
// nothing about its context window is the ordinary case for anything the parser in
// src/head.mjs does not recognise, and that desk has to look like a desk.
//
// The model names are real ones off the two families that print this, because the demo's
// job is to show what the office can actually produce.
const DEMO_HEADS = [
  { used: 22, model: 'opus' },
  { used: 58, model: 'opus-4.8' },
  { used: 81, model: 'sonnet' },
  null,
  { used: 93, model: 'opus' },
  { used: 47, model: 'haiku' },
];

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
    roster.setDirt(person.cwd, DEMO_DIRT[i % DEMO_DIRT.length]);
    if (HEAD) roster.setHead(person.id, DEMO_HEADS[i % DEMO_HEADS.length]);
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
  // Not for the cell size, which never changes, but for whether anybody is looking:
  // that flips when somebody switches tab, and nothing else in the office would
  // notice. It sits on the frame rather than the 2s poll because the delay this
  // controls is one a person sits through, watching a whiteboard that has no chart on
  // it yet. Throttles itself, swallows its own failures, and is never awaited, so a
  // server without graphics costs one question once and then stops being asked.
  graphics?.poll();
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

  // Before either path observes anything. `--once` restores but never saves: it is a
  // single printed frame, so it should show the same whiteboard the live office would,
  // and it has nothing of its own to add to it.
  openTheBooks();

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
      await refreshScreens();
      await refreshCommands();
      // Awaited here where the live office fires them off, because a single printed
      // frame is the thing used to look at the art: a branch and a pile of paper that
      // only ever arrive on the second poll would never be in it.
      await refreshBranches();
      await refreshDirt();
    }
    ensureSelection();
    if (argv.has('--detail') && selectedId) await loadDetail(selectedId, { force: true });
    // Written *and flushed* before the exit. Whenever this render is being diffed,
    // piped or read by a test, stdout is a pipe, and a pipe write is asynchronous on
    // macOS: a frame bigger than the pipe buffer is queued rather than issued, so an
    // exit on the next line truncates it. A frame is about 25KB against a 16KB buffer,
    // so it truncates every time. CI found it as a frame whose header arrived and whose
    // desks did not, on macOS and not on Linux, where a pipe write is synchronous.
    await new Promise((resolve) => process.stdout.write(renderFrame(view()).lines.join('\n') + '\n', resolve));
    api?.close();
    events?.close();
    process.exit(0);
  }

  enterTerminal();
  if (!DEMO) {
    saveTimer = setInterval(closeTheBooks, SAVE_MS);
    // The office should not be the reason a terminal will not close.
    saveTimer.unref?.();
  }
  // Asked once before the first frame, so the office either knows the cell size or
  // knows it is a text-only terminal by the time it has anything to draw. A pane id
  // is required and comes from the environment herdr started us in, so an office run
  // by hand outside herdr is simply text, which is correct.
  if (GRAPHICS && api && OWN_PANE) {
    graphics = new Graphics(api, OWN_PANE);
    await graphics.probe();
  }
  await refresh();
  draw();
}

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
process.on('uncaughtException', (err) => quit(1, `herdr-office crashed: ${err.stack}`));

main();
