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

export class Roster {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.people = [];
    this.workspaceNames = new Map();
    this.tabNames = new Map();
    this.focusedPaneId = null;
    this.states = new Map(); // pane_id -> { status, since, seq }
    this.asks = new Map(); // pane_id -> { text, at }, only while blocked
  }

  setWorkspaces(workspaces = []) {
    for (const ws of workspaces) {
      // session.snapshot calls it `label`; older payloads used `name`.
      if (ws?.workspace_id) this.workspaceNames.set(ws.workspace_id, ws.label || ws.name || ws.workspace_id);
    }
  }

  // Tab labels are what the human actually named the work ("sso-login"), which
  // beats a pane's terminal title for telling desks apart at a glance.
  setTabs(tabs = []) {
    for (const tab of tabs) {
      if (tab?.tab_id) this.tabNames.set(tab.tab_id, tab.label || String(tab.number ?? ''));
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
        const prev = this.states.get(id);
        const changed = !prev || prev.status !== status || (seq != null && prev.seq !== seq);
        const since = changed ? now : prev.since;
        // The API reports state, not when it was entered, so the first sighting
        // of an agent gives us a floor on the duration, not the real one.
        const assumed = changed ? !prev : prev.assumed;
        if (status === 'blocked' && prev?.status !== 'blocked') newlyBlocked.push(id);
        this.states.set(id, { status, since, seq, assumed });
        // Once they are unstuck the question is gone, so the bubble goes too.
        if (status !== 'blocked') this.asks.delete(id);

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
          choice: this.asks.get(id)?.choice || null,
          focused: Boolean(a.focused),
          cwd: a.cwd || '',
          title: sanitize(a.terminal_title_stripped || a.terminal_title || ''),
          sessionId: a.agent_session?.value || null,
        };
      })
      .sort((x, y) => paneSortKey(x.id).localeCompare(paneSortKey(y.id)));

    this.people.forEach((person, i) => {
      person.name = nickname(i);
    });

    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
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
}
