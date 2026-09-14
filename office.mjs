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
import { spawn } from 'node:child_process';
import { ApiClient, EventStream, resolveSocketPath } from './src/socket.mjs';
import { Roster } from './src/roster.mjs';
import { renderFrame } from './src/render.mjs';
import { cleanOutput, summarize, describeDetection, bubbleText, approvalChoice } from './src/summary.mjs';
import { parseMouse, nextDrag } from './src/mouse.mjs';
import { width } from './src/text.mjs';

const argv = new Set(process.argv.slice(2));
const DEMO = argv.has('--demo');
const ONCE = argv.has('--once');
// Toasts are on by default. The whole reason to watch the office is to find out
// that somebody is waiting on you, and a default that has to be switched on by
// editing an installed plugin's manifest is a default nobody ever gets.
// `--notify` still parses, because it used to be the way to ask for this.
const NOTIFY = !argv.has('--quiet');

const ANIM_MS = 320;
const POLL_MS = 2000;
const DETAIL_MS = 2500;
// A bubble is one screen read per stuck desk, so it is cheap but not free: only
// blocked desks are read, and only when their bubble has gone stale.
const ASK_MS = 6000;

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
let api = null;
let events = null;
let selectedId = null;
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
  api?.close();
  leaveTerminal();
  if (msg) process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------ drawing */

function view() {
  if (message && Date.now() > messageUntil) message = '';
  return {
    people: roster.people,
    counts: roster.counts(),
    selectedId,
    detail,
    frame,
    now: Date.now(),
    size: size(),
    message,
    drag,
    busy,
  };
}

let hitboxes = [];
let grid = { cols: 0, rows: 0, ids: [] };

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

function ensureSelection() {
  if (selectedId && roster.find(selectedId)) return;
  const raised = roster.people.find((p) => p.status === 'blocked');
  selectedId = (raised || roster.people[0])?.id ?? null;
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

// Feeds the roster everything it needs to seat people where their panes really
// are. Order matters: the layouts refer to workspaces and tabs by id, so the
// numbers have to be in hand before the geometry is read.
function seat(snapshot, tabs) {
  const snap = snapshot?.snapshot;
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
    for (const person of roster.people) {
      if (person.status === 'blocked') roster.setAsk(person.id, 'apply the patch?', approvalChoice(['apply the patch? (y/n)']));
    }
    ensureSelection();
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
    ensureSelection();
    syncSubscriptions();
    refreshAsks();
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
  const subs = [...GLOBAL_EVENTS, ...ids.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))];
  events
    .open(
      subs,
      () => scheduleRefresh(),
      () => {
        // Force a resubscribe on the next poll if the stream dies.
        subscribedTo = '';
      },
    )
    .catch((err) => note(`events: ${err.message}`));
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
  const ids = grid.ids.length ? grid.ids : roster.people.map((p) => p.id);
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
    // Walking off the edge of the visible floor moves through the full roster,
    // which is what makes paging work with only arrow keys.
    const all = roster.people.map((p) => p.id);
    const globalIdx = all.indexOf(selectedId) + (dx || dy * cols);
    if (globalIdx >= 0 && globalIdx < all.length) selectedId = all[globalIdx];
    return;
  }
  selectedId = ids[next];
}

function nextRaisedHand() {
  const raised = roster.people.filter((p) => p.status === 'blocked');
  if (!raised.length) {
    note('nobody has a hand up');
    return;
  }
  const idx = raised.findIndex((p) => p.id === selectedId);
  selectedId = raised[(idx + 1) % raised.length].id;
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
  const { drag: next, act } = nextDrag(drag, ev, hitboxes);
  drag = next;
  if (!act) return;
  if (act.id) selectedId = act.id;
  if (act.type === 'answer') respond(act.action);
  else if (act.type === 'open') loadDetail(act.id, { force: true });
  else if (act.type === 'swap') {
    selectedId = act.from;
    swapDesks(act.from, act.to);
  } else if (act.type === 'cancel') note('put it back');
  // A desk that has been in the air has left pale borders and lifted rows behind
  // it, so the cheap line-diff repaint cannot be trusted for this frame.
  if (act.type === 'swap' || act.type === 'cancel') prevLines = [];
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
    detail = null;
    prevLines = [];
    draw();
    return;
  }
  if (str === '\x1b[A' || str === 'k') move(0, -1);
  else if (str === '\x1b[B' || str === 'j') move(0, 1);
  else if (str === '\x1b[D' || str === 'h') move(-1, 0);
  else if (str === '\x1b[C' || str === 'l') move(1, 0);
  else if (str === '\t') move(1, 0);
  else if (str === '\r' || str === '\n' || str === ' ') {
    if (selectedId) loadDetail(selectedId, { force: true });
  } else if (str === 'y') respond('approve');
  else if (str === 'n') respond('deny');
  else if (str === 'f') jumpToPane();
  else if (str === 'b') nextRaisedHand();
  else if (str === 'r') {
    refresh();
    if (detail) loadDetail(detail.id, { force: true });
    note('refreshed');
  } else return;

  if (detail && selectedId && detail.id !== selectedId) loadDetail(selectedId, { force: true });
  draw();
}

/* --------------------------------------------------------------------- demo */

let demoTick = 0;
const DEMO_TABS = ['socket-client', 'login-flow', 'flaky-tests', 'deps', 'office-plugin', 'triage', 'null-hunt'];
function demoAgents() {
  demoTick += 1;
  roster.setTabs(DEMO_TABS.map((label, i) => ({ tab_id: `w1:t${i + 1}`, label })));
  const cycle = ['working', 'working', 'blocked', 'idle', 'done', 'unknown'];
  return [
    ['w1:p1', 'claude', 'refactor the socket client'],
    ['w1:p2', 'kiro', 'rewrite the login flow'],
    ['w1:p3', 'codex', 'fix a flaky test'],
    ['w1:p4', 'opencode', 'bump deps'],
    ['w1:p5', 'claude', 'write the office plugin'],
    ['w1:p6', 'gemini', 'triage the bug queue'],
    ['w1:p7', 'kiro', 'chase a null pointer'],
  ].map(([pane_id, agent, title], i) => ({
    pane_id,
    agent,
    agent_status: cycle[(i + Math.floor(demoTick / 6)) % cycle.length],
    workspace_id: 'w1',
    tab_id: `w1:t${i + 1}`,
    cwd: '/Users/you/Desktop/projects/herdr-office',
    terminal_title_stripped: title,
    focused: i === 0,
    state_change_seq: 1,
  }));
}

/* --------------------------------------------------------------------- boot */

const anim = setInterval(() => {
  frame += 1;
  if (detail) loadDetail(detail.id);
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
      for (const person of roster.people) {
        if (person.status === 'blocked') roster.setAsk(person.id, 'apply the patch?', approvalChoice(['apply the patch? (y/n)']));
      }
    } else {
      const snapshot = await api.request('session.snapshot', {}).catch(() => null);
      const tabs = await api.request('tab.list', {}).catch(() => null);
      seat(snapshot, tabs);
      const list = await api.request('agent.list', {});
      roster.update(list.agents || []);
      await refreshAsks();
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
