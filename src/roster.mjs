// The office roster: turns raw agent records from the Herdr API into the
// "people" the floor plan draws, and remembers how long each one has been in
// its current state (the API reports state, not when it was entered).
import { sanitize } from './text.mjs';

// Who gets hired. Short, generic, and deliberately nobody in particular: a desk
// labelled with a real colleague's name invites you to read something into what
// that agent is doing. Alphabetical, twice through, which is enough for a busy
// office and keeps the order obvious.
const NAMES = [
  'Ada', 'Bo', 'Cass', 'Dev', 'Ede', 'Fen', 'Gus', 'Hana', 'Ines', 'Jo',
  'Kit', 'Lex', 'Mo', 'Nils', 'Oona', 'Pim', 'Quinn', 'Rae', 'Sol', 'Tao',
  'Uma', 'Vic', 'Wren', 'Xan', 'Yuri', 'Zed', 'Ari', 'Bex', 'Cleo', 'Dax',
  'Ezra', 'Fay', 'Gil', 'Hux', 'Ivo', 'Juno', 'Kai', 'Lior', 'Mika', 'Nix',
];

// Names go by seat, not by pane id: that is what makes the front row read Ada,
// Bo, Cass. The cost is that inserting a pane earlier in the floor shuffles the
// names after it; looks and colours still follow the pane id.
function nickname(index) {
  const lap = Math.floor(index / NAMES.length);
  return NAMES[index % NAMES.length] + (lap ? String(lap + 1) : '');
}

function paneSortKey(paneId) {
  const [ws, pane] = String(paneId).split(':');
  return [ws || '', (pane || '').padStart(4, '0')].join(':');
}

// Sorts high, so anything we have no number for lands after everything we do
// rather than jumping to the front of the office.
// How long a piece of news stays over somebody's head. Long enough to read from
// across the floor, short enough that a room full of stale announcements never
// builds up: "tests passed" from two minutes ago is not news, it is clutter.
export const EVENT_MS = 12000;

const eventOf = (entry, now) => (entry && now - entry.at < EVENT_MS ? { label: entry.label, kind: entry.kind } : null);

const UNKNOWN = 9999;
const pad = (n) => String(Math.max(0, Math.min(UNKNOWN, Math.round(n)))).padStart(4, '0');

// Where a desk sits on the floor, in reading order, mirroring where the pane
// actually is in Herdr: workspace, then tab, then top-to-bottom, then
// left-to-right, with the pane id as the last resort so the order is total and
// stable. Without the geometry (demo mode, or a server that returned no
// layouts) every desk scores the same and it falls back to pane id alone,
// which is the order the office has always used.
function seatKey(person, seats) {
  const seat = seats.get(person.id);
  if (!seat) return `${pad(UNKNOWN)}|${pad(UNKNOWN)}|${pad(UNKNOWN)}|${pad(UNKNOWN)}|${paneSortKey(person.id)}`;
  return [pad(seat.workspaceOrder), pad(seat.tabOrder), pad(seat.y), pad(seat.x), paneSortKey(person.id)].join('|');
}

// Where something sits in its bar, which is not the same thing as what it is
// called. Both tabs and workspaces can be dragged to a new position (`tab.move`
// and `workspace.move`, both taking an `insert_index`), and neither one renumbers
// when that happens: `number` is the stable shortcut you reach a tab by, baked
// into its id, so a tab created fourteenth answers to 14 wherever it ends up
// sitting. Ordering the floor by `number` therefore drew the office in creation
// order and quietly stopped matching the bar the moment anything was moved. The
// position in the list is the thing that matches, so that is what seats a desk,
// and `number` is kept only for a server that lists nothing at all.
function orderOf(positions, numbers, id) {
  return positions.get(id) ?? numbers.get(id) ?? UNKNOWN;
}

// Positions are rebuilt from the list rather than merged into what was there
// before, because an index only means anything relative to the list it came out
// of: mixing one call's indices with another's would interleave two different
// bars. A list with nothing in it says nothing about order, so it leaves the
// last known one alone.
function positionsOf(items, key, into) {
  if (!items.length) return;
  into.clear();
  items.forEach((item, i) => {
    if (item?.[key]) into.set(item[key], i);
  });
}

export class Roster {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.people = [];
    this.workspaceNames = new Map();
    this.workspaceNumbers = new Map();
    this.workspacePositions = new Map(); // workspace_id -> where it sits in the bar
    this.tabNames = new Map();
    this.tabNumbers = new Map();
    this.tabPositions = new Map(); // tab_id -> where it sits in the tab bar
    this.seats = new Map(); // pane_id -> { workspaceOrder, tabOrder, x, y }
    this.focusedPaneId = null;
    this.states = new Map(); // pane_id -> { status, since, seq }
    // What the last run of the office today left behind, and what became of it. Null
    // for a first run, which is most of them. See `restoreStates`.
    this.reopen = null;
    this.asks = new Map(); // pane_id -> { text, at }, only while blocked
    this.commands = new Map(); // pane_id -> { label, at }, what the pane is running
    this.events = new Map(); // pane_id -> { label, kind, at }, news, and short-lived
    // Keyed by working directory rather than by pane, because that is the question
    // `worktree.list` answers: two desks in the same checkout share one answer and
    // therefore one call.
    this.branches = new Map(); // cwd -> { branch, repo, at }
    // Keyed by working directory for a stronger reason than the branches are: how much
    // is uncommitted is a fact about the checkout and not about the person. Two agents
    // in one checkout genuinely do share a pile of paper, and drawing them the same is
    // the truth about a situation somebody probably wants to know they are in.
    this.dirt = new Map(); // cwd -> { counts: { files, conflicts } | null, at }
    // How full each agent's context window is (see src/head.mjs). Keyed by pane, unlike
    // the two above: this is the one fact here that is genuinely about the agent rather
    // than about the checkout it is sitting in. Kept as the parse returned it, `session`
    // and all, because the previous reading is what turns the next one into news.
    this.heads = new Map(); // pane_id -> { gauge: { used, model, session } | null, at }
  }

  setWorkspaces(workspaces = []) {
    positionsOf(workspaces, 'workspace_id', this.workspacePositions);
    for (const ws of workspaces) {
      if (!ws?.workspace_id) continue;
      // session.snapshot calls it `label`; older payloads used `name`.
      this.workspaceNames.set(ws.workspace_id, ws.label || ws.name || ws.workspace_id);
      if (ws.number != null) this.workspaceNumbers.set(ws.workspace_id, ws.number);
    }
  }

  // Tab labels are what the human actually named the work ("sso-login"), which
  // beats a pane's terminal title for telling desks apart at a glance.
  setTabs(tabs = []) {
    positionsOf(tabs, 'tab_id', this.tabPositions);
    for (const tab of tabs) {
      if (!tab?.tab_id) continue;
      this.tabNames.set(tab.tab_id, tab.label || String(tab.number ?? ''));
      if (tab.number != null) this.tabNumbers.set(tab.tab_id, tab.number);
    }
  }

  // Where every pane physically is, from `session.snapshot`'s `layouts`. This is
  // what lets the floor match the room: seats are laid out in the same order the
  // panes are, so swapping two panes visibly swaps two desks instead of
  // rearranging the real session behind an unchanged picture. The tab and the
  // workspace come in by id, which is why the lists have to be read first: the
  // geometry says where a pane sits inside its tab and nothing about where that
  // tab sits in the bar.
  setLayouts(layouts = []) {
    this.seats.clear();
    for (const layout of layouts) {
      const workspaceOrder = orderOf(this.workspacePositions, this.workspaceNumbers, layout?.workspace_id);
      const tabOrder = orderOf(this.tabPositions, this.tabNumbers, layout?.tab_id);
      for (const pane of layout?.panes || []) {
        if (!pane?.pane_id) continue;
        this.seats.set(pane.pane_id, {
          workspaceOrder,
          tabOrder,
          x: pane.rect?.x ?? UNKNOWN,
          y: pane.rect?.y ?? UNKNOWN,
        });
      }
    }
  }

  // What a blocked person is asking for, so their desk can say it out loud, and
  // the keys that answer it. Both come from the same screen read, which is why
  // they are stored together: answering from the floor needs the keys without
  // opening the desk first.
  setAsk(id, text, choice = null) {
    this.asks.set(id, { text, choice, at: this.clock() });
    const person = this.find(id);
    if (person) {
      person.ask = text;
      person.choice = choice;
    }
  }

  // What the pane's foreground process is, in as many words as it is safe to put
  // on a screen (see src/process.mjs). A null label is stored as well as a real
  // one: it is the difference between "nothing running" and "not asked yet",
  // which is what stops the poll asking the same quiet desk twice a second.
  setCommand(id, label) {
    this.commands.set(id, { label: label || null, at: this.clock() });
    const person = this.find(id);
    if (person) person.command = label || null;
  }

  // Something that just happened at this desk (see src/events.mjs): the tests
  // went green, the build broke, a rebase hit a conflict. It is news rather than
  // state, so it expires on its own after EVENT_MS instead of waiting for the
  // agent's status to change, and the label is always one of the office's own
  // fixed strings, never anything the agent printed.
  setEvent(id, label, kind) {
    if (!label) return;
    this.events.set(id, { label, kind: kind || 'good', at: this.clock() });
    const person = this.find(id);
    if (person) person.event = { label, kind: kind || 'good' };
  }

  // Drops anything that has gone stale, and reports whether the floor changed, so
  // the caller only repaints when there is a reason to.
  expireEvents(now = this.clock()) {
    let changed = false;
    for (const [id, entry] of [...this.events]) {
      if (now - entry.at < EVENT_MS) continue;
      this.events.delete(id);
      const person = this.find(id);
      if (person) person.event = null;
      changed = true;
    }
    return changed;
  }

  // Which branch a working directory is on (see src/branches.mjs). A null branch is
  // stored the same way a null command is: "asked, nothing to say" has to be
  // distinguishable from "not asked yet", or a detached checkout gets re-asked on
  // every single pass forever.
  setBranch(cwd, { branch = null, repo = null } = {}) {
    if (!cwd) return;
    this.branches.set(cwd, { branch: branch || null, repo: repo || null, at: this.clock() });
    for (const person of this.people) {
      if (person.cwd !== cwd) continue;
      person.branch = branch || null;
      person.repo = repo || null;
    }
  }

  branchAge(cwd) {
    const entry = this.branches.get(cwd);
    return entry ? this.clock() - entry.at : Infinity;
  }

  // How much is uncommitted in a working directory (see src/dirt.mjs). `null` counts as
  // an answer, exactly as a null branch does: "git would not tell us" has to be
  // distinguishable from "not asked yet", or every directory that is not a repository
  // gets a subprocess spent on it on every pass forever.
  setDirt(cwd, counts = null) {
    if (!cwd) return;
    const clean = counts && Number.isFinite(Number(counts.files))
      ? { files: Math.max(0, Math.floor(Number(counts.files))), conflicts: Math.max(0, Math.floor(Number(counts.conflicts) || 0)) }
      : null;
    this.dirt.set(cwd, { counts: clean, at: this.clock() });
    for (const person of this.people) {
      if (person.cwd !== cwd) continue;
      person.dirt = clean;
    }
  }

  dirtAge(cwd) {
    const entry = this.dirt.get(cwd);
    return entry ? this.clock() - entry.at : Infinity;
  }

  // How full one agent's head is (see src/head.mjs). `null` is an answer here for the
  // same reason it is for a branch and for a checkout, and it does more work: a screen
  // that says nothing about its context window and a read that failed both land here as
  // null, which both rate limits the retry and takes the tint off a monitor the office
  // can no longer vouch for. An agent that exits and leaves a shell behind in its pane
  // stops reporting, and one read later its desk stops claiming to know.
  setHead(id, gauge = null) {
    if (!id) return;
    const clean = gauge && Number.isFinite(Number(gauge.used))
      ? {
        used: Math.max(0, Math.min(100, Math.round(Number(gauge.used)))),
        model: gauge.model || null,
        session: gauge.session || null,
      }
      : null;
    this.heads.set(id, { gauge: clean, at: this.clock() });
    const person = this.find(id);
    if (person) person.head = clean;
  }

  headAge(id) {
    const entry = this.heads.get(id);
    return entry ? this.clock() - entry.at : Infinity;
  }

  // The last reading, for the caller that wants to compare it with the next one.
  head(id) {
    return this.heads.get(id)?.gauge || null;
  }

  commandAge(id) {
    const entry = this.commands.get(id);
    return entry ? this.clock() - entry.at : Infinity;
  }

  askAge(id) {
    const entry = this.asks.get(id);
    return entry ? this.clock() - entry.at : Infinity;
  }

  // Returns the people who just started asking for help, so the caller can
  // decide whether to make noise about it.
  update(agents = []) {
    const now = this.clock();
    const seen = new Set();
    const newlyBlocked = [];

    this.people = agents
      .filter((a) => a && a.pane_id)
      .map((a) => {
        const id = a.pane_id;
        seen.add(id);
        const status = a.agent_status || 'unknown';
        const seq = a.state_change_seq ?? null;
        const stored = this.states.get(id);
        // A line in the day book is a claim about a stretch of time the office was not
        // watching, so it gets checked before it is believed: see `believe`. One that does
        // not check out is dropped right here, which leaves this desk looking exactly like
        // a desk the office has never met before, because that is what it is.
        const prev = stored?.restored ? this.believe(stored, status, seq) : stored;
        const changed = !prev || prev.status !== status || (seq != null && prev.seq !== seq);
        const since = changed ? now : prev.since;
        // The API reports state, not when it was entered, so the first sighting
        // of an agent gives us a floor on the duration, not the real one.
        const assumed = changed ? !prev : prev.assumed;
        if (status === 'blocked' && prev?.status !== 'blocked') newlyBlocked.push(id);
        this.states.set(id, { status, since, seq, assumed });
        // Once they are unstuck the question is gone, so the bubble goes too.
        if (status !== 'blocked') this.asks.delete(id);
        // A desk that has stopped working is no longer running anything, and a
        // stale "npm test" on an idle monitor would be a lie the office told.
        if (status !== 'working') this.commands.delete(id);

        return {
          id,
          name: '', // filled in below, once the floor order is settled
          kind: a.agent || 'agent',
          status,
          since,
          statusMs: now - since,
          assumedSince: Boolean(assumed),
          firstSeen: !prev,
          workspaceId: a.workspace_id || '',
          workspaceName: this.workspaceNames.get(a.workspace_id) || a.workspace_id || '',
          tabId: a.tab_id || '',
          tabName: this.tabNames.get(a.tab_id) || '',
          ask: this.asks.get(id)?.text || '',
          command: this.commands.get(id)?.label || null,
          event: eventOf(this.events.get(id), now),
          choice: this.asks.get(id)?.choice || null,
          focused: Boolean(a.focused),
          cwd: a.cwd || '',
          branch: this.branches.get(a.cwd || '')?.branch || null,
          repo: this.branches.get(a.cwd || '')?.repo || null,
          dirt: this.dirt.get(a.cwd || '')?.counts || null,
          head: this.heads.get(id)?.gauge || null,
          title: sanitize(a.terminal_title_stripped || a.terminal_title || ''),
          sessionId: a.agent_session?.value || null,
        };
      })
      .sort((x, y) => seatKey(x, this.seats).localeCompare(seatKey(y, this.seats)));

    this.people.forEach((person, i) => {
      person.name = nickname(i);
    });

    // Settle the reopening, once, on the first look after it. Anything still flagged as
    // restored was in the book and is not on the floor, so that desk went while the
    // office was shut, and the loop below drops it along with every other desk that has
    // gone. After this the flag cannot survive, so `believe` runs once per desk.
    if (this.reopen && !this.reopen.settled) {
      for (const entry of this.states.values()) if (entry.restored) this.reopen.gone += 1;
      this.reopen.settled = true;
    }

    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
    // Pane keyed caches go with the pane. The cwd keyed ones do not: a checkout outlives
    // the desk that was sitting in it, and the next desk to open there inherits an answer
    // that is still true. A context window does not work like that, and a stale one left
    // behind under a reused pane id would be somebody else's number entirely.
    for (const id of [...this.heads.keys()]) if (!seen.has(id)) this.heads.delete(id);
    return newlyBlocked.filter((id) => seen.has(id));
  }

  counts() {
    const tally = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
    for (const p of this.people) tally[p.status] = (tally[p.status] ?? 0) + 1;
    return tally;
  }

  find(id) {
    return this.people.find((p) => p.id === id) || null;
  }

  /* ------------------------------------------------------------------- the day book */

  // Every desk's clock is thrown away when the pane closes, which is why reopening the
  // office used to announce that a desk which had been blocked since breakfast had been
  // blocked for one second. The punch clock already survives the day (src/state.mjs), but
  // it keeps office totals, and "Cass has been stuck for two hours" is the number that
  // actually makes somebody get up. So the desks get a book of their own.
  //
  // What makes it honest is that a saved clock is a claim about time nobody watched, and
  // `state_change_seq` can check that claim. Herdr moves that number every time it changes
  // a desk's state, so the number the office wrote down before it shut is proof of a
  // negative: nothing happened to this desk while nobody was looking, and the clock saved
  // next to it is still running on the very interval it was running on. A different number
  // is proof of a transition the office missed. A missing number is proof of nothing.
  //
  // Only the first of those three gets believed. The other two get the answer a desk the
  // office has never met gets, which is to start the clock now and admit it with a `~`,
  // because the rule here is the same one the punch clock is built on: never claim time
  // the office did not watch.

  // Returns a plain entry when the line holds, and nothing when it does not, so that the
  // caller's ordinary "never seen this desk before" path handles everything else.
  believe(stored, status, seq) {
    const held = seq != null && seq === stored.seq && status === stored.status;
    if (this.reopen) this.reopen[held ? 'held' : 'missed'] += 1;
    if (!held) return undefined;
    return { status: stored.status, since: stored.since, seq: stored.seq, assumed: stored.assumed };
  }

  // Where each desk's clock had got to, for src/state.mjs to hand back on the next open
  // today. Reading it changes nothing, so it is safe on a timer.
  //
  // Desks herdr gave no sequence number for are left out, because that number is the only
  // thing that can prove the clock still means anything after a gap: such a line could
  // never be believed, so keeping it would produce the same answer as not having it, one
  // poll later and after a trip through the filesystem.
  snapshotStates() {
    const book = [];
    for (const [id, entry] of this.states) {
      if (entry.seq == null) continue;
      book.push({
        id,
        status: entry.status,
        since: entry.since,
        seq: entry.seq,
        assumed: Boolean(entry.assumed),
      });
    }
    return book;
  }

  // Adopt the book from earlier today. Returns how many lines were taken, which is not
  // the same as how many will be believed: each one is checked against herdr on the next
  // look, and `awayReport` says how that went.
  //
  // Bad lines are dropped on the way in rather than being allowed to fail later, one at a
  // time rather than rejecting the file, for the reason the punch clock restores field by
  // field: a book that has lost one desk is still right about the other four.
  restoreStates(saved, savedAt = 0, now = this.clock()) {
    const shut = Number.isFinite(savedAt) && savedAt > 0 && savedAt <= now ? now - savedAt : 0;
    let kept = 0;
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      if (entry.seq == null) continue;
      if (typeof entry.status !== 'string' || !entry.status) continue;
      // A stored clock that runs past now is a machine whose clock moved between the two
      // runs, and believing it would draw a desk that has been idle for minus four
      // minutes. The office has no way to tell which of the two readings was wrong, so it
      // trusts neither and starts this desk over.
      if (!Number.isFinite(entry.since) || entry.since > now) continue;
      this.states.set(entry.id, {
        status: entry.status,
        since: entry.since,
        seq: entry.seq,
        assumed: Boolean(entry.assumed),
        restored: true,
      });
      kept += 1;
    }
    if (kept) this.reopen = { shut, kept, held: 0, missed: 0, gone: 0, settled: false };
    return kept;
  }

  // What became of the book, for the one line that tells you. Null until the first look
  // since reopening has settled, and null again once it has been read, because this is
  // news and news is only news once. Same contract as the blocked list `update` returns.
  awayReport() {
    if (!this.reopen?.settled) return null;
    const report = this.reopen;
    this.reopen = null;
    return report;
  }
}
