// The office manager. One real agent whose job is the rest of the floor, and the
// one rule the whole feature hangs on: it is the first card, at every size, in
// every view, wherever its pane actually sits. Then the order the clipboard puts
// everybody else in, and what the brief it is sent does and does not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Roster } from '../src/roster.mjs';
import { renderFrame, TILE_W } from '../src/render.mjs';
import { broadcastTargets } from '../src/compose.mjs';
import { width } from '../src/text.mjs';
import { MANAGER_TAB, MANAGER_NAME, pickManager, managerFirst, priorities, headline, officeBrief, briefingPrompt } from '../src/manager.mjs';
import { SIZES, FRAMES, viewOf, stripAnsi } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A floor with the manager deliberately in the LAST pane of the last tab, so
// anything that put it first by accident of seating would fail here.
function floor(statuses = ['idle', 'working', 'blocked', 'done', 'unknown', 'working'], managerStatus = 'working') {
  const roster = new Roster();
  roster.setWorkspaces([{ workspace_id: 'w1', label: 'main', number: 1 }]);
  roster.setTabs([
    ...statuses.map((_, i) => ({ tab_id: `w1:t${i + 1}`, label: `job-${i + 1}`, number: i + 1 })),
    { tab_id: 'w1:t99', label: MANAGER_TAB, number: 99 },
  ]);
  roster.update([
    ...statuses.map((status, i) => ({
      pane_id: `w1:p${i + 1}`,
      agent: 'claude',
      agent_status: status,
      workspace_id: 'w1',
      tab_id: `w1:t${i + 1}`,
      cwd: '/Users/you/repo',
      terminal_title_stripped: `task ${i}`,
      state_change_seq: 1,
    })),
    {
      pane_id: 'w1:p99',
      agent: 'codex',
      agent_status: managerStatus,
      workspace_id: 'w1',
      tab_id: 'w1:t99',
      cwd: '/Users/you/repo',
      state_change_seq: 1,
    },
  ]);
  const stuck = roster.people.find((p) => p.status === 'blocked' && !p.manager);
  if (stuck) roster.setAsk(stuck.id, 'run rm -rf build?', { shape: 'y/n', approve: ['y'], deny: ['n'] });
  return roster;
}

test('the office-manager tab is the manager, and it is seated first', () => {
  const roster = floor();
  assert.equal(roster.people[0].id, 'w1:p99');
  assert.equal(roster.people[0].manager, true);
  assert.equal(roster.people[0].name, MANAGER_NAME);
  assert.equal(roster.manager().id, 'w1:p99');
  assert.equal(roster.people.filter((p) => p.manager).length, 1);
});

test('the people doing the work keep the names they would have had', () => {
  // Ada is Ada because she sits first among the workers, not first on the floor.
  const roster = floor();
  assert.deepEqual(roster.people.slice(1, 4).map((p) => p.name), ['Ada', 'Bo', 'Cass']);
});

test('no office-manager tab, no manager, and the floor is untouched', () => {
  const roster = new Roster();
  roster.update([
    { pane_id: 'w1:p2', agent: 'claude', agent_status: 'idle', workspace_id: 'w1' },
    { pane_id: 'w1:p1', agent: 'claude', agent_status: 'blocked', workspace_id: 'w1' },
  ]);
  assert.equal(roster.manager(), null);
  assert.deepEqual(roster.people.map((p) => p.id), ['w1:p1', 'w1:p2']);
  assert.deepEqual(roster.people.map((p) => p.name), ['Ada', 'Bo']);
});

test('--manager pins a pane by id, over any tab name', () => {
  const roster = new Roster();
  roster.managerPin = 'w1:p3';
  roster.setTabs([{ tab_id: 't1', label: MANAGER_TAB }]);
  roster.update([
    { pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', workspace_id: 'w1', tab_id: 't1' },
    { pane_id: 'w1:p3', agent: 'claude', agent_status: 'idle', workspace_id: 'w1' },
  ]);
  assert.equal(roster.people[0].id, 'w1:p3');
  assert.equal(roster.manager().id, 'w1:p3');
});

test('two office-manager tabs still make exactly one manager', () => {
  const people = [{ id: 'a', tabName: 'Office-Manager ' }, { id: 'b', tabName: MANAGER_TAB }];
  assert.equal(pickManager(people), 'a');
  assert.equal(pickManager(people, 'nobody-by-that-id'), 'a');
  assert.deepEqual(managerFirst([{ id: 'x' }, { id: 'b' }, { id: 'y' }], 'b').map((p) => p.id), ['b', 'x', 'y']);
  assert.deepEqual(managerFirst([{ id: 'x' }], null).map((p) => p.id), ['x']);
});

test('priorities: hands first, then work in progress, then done, then idle', () => {
  const roster = floor();
  const order = priorities(roster.people).map(({ person }) => person.status);
  assert.deepEqual(order, ['blocked', 'working', 'working', 'done', 'idle', 'unknown']);
  // The manager is never on its own clipboard.
  assert.ok(!priorities(roster.people).some(({ person }) => person.manager));
});

test('inside a tier, risk and then the longest wait come first', () => {
  const now = 1_000_000;
  const people = [
    { id: 'calm', status: 'working', since: now - 50_000 },
    { id: 'conflicted', status: 'working', since: now - 1_000, dirt: { files: 3, conflicts: 1 } },
    { id: 'old-hand', status: 'blocked', since: now - 90_000 },
    { id: 'new-hand', status: 'blocked', since: now - 1_000 },
    { id: 'full-head', status: 'working', since: now - 1_000, head: { used: 95 } },
  ];
  assert.deepEqual(priorities(people, { now }).map(({ person }) => person.id), ['old-hand', 'new-hand', 'conflicted', 'full-head', 'calm']);
});

test('the reasons and the headline read like a clipboard', () => {
  const roster = floor();
  const { headline: top, items } = officeBrief(roster.people);
  assert.equal(top, '1 needs you · 2 working · 1 done · 1 idle · 1 unsure');
  assert.equal(items[0].why, 'approve: run rm -rf build?');
  assert.equal(headline([]), 'nobody else on the floor');
});

test('the brief the agent is sent leaves the ask off the screen out', () => {
  // A bubble is a line off somebody's screen; the human sees it on the wall, but it
  // is not handed from one agent to another.
  const roster = floor();
  const prompt = briefingPrompt(roster.people, { managerId: roster.manager().id });
  assert.ok(!prompt.includes('rm -rf'), 'an ask went into the manager prompt');
  assert.ok(prompt.includes('waiting on an approval from the human'));
  assert.ok(prompt.includes('Office right now: 1 needs you'));
  // Listed in the same order the card draws, and without the manager in it.
  const listed = prompt.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(listed.length, roster.people.length - 1);
  assert.ok(listed[0].includes(': blocked'), listed[0]);
  assert.ok(!prompt.includes(`${MANAGER_NAME} (`));
});

test('a standup does not reach the manager', () => {
  const roster = floor(['idle', 'done'], 'idle');
  const { to } = broadcastTargets(roster.people);
  assert.deepEqual(to.map((p) => p.name), ['Ada', 'Bo']);
});

test('the manager is the first card on the floor plan and in the list, at every size', () => {
  const people = floor().people;
  for (const [cols, rows] of SIZES) {
    for (const zoom of ['auto', 'list', 'cubicle']) {
      for (const frame of FRAMES) {
        const view = viewOf({ people, cols, rows, frame, zoom });
        const { lines, hitboxes } = renderFrame(view);
        assert.equal(lines.length, rows);
        lines.forEach((line, i) => assert.equal(width(line), cols, `${cols}x${rows} ${zoom}: line ${i} is ${width(line)} cells`));
        const desks = hitboxes.filter((h) => !h.action);
        if (desks.length) assert.equal(desks[0].id, 'w1:p99', `${cols}x${rows} ${zoom}: first desk is ${desks[0].id}`);
      }
    }
  }
});

test('the card carries the headline and the most urgent desk', () => {
  const people = floor().people;
  const { lines } = renderFrame(viewOf({ people, cols: 140, rows: 46, selectedId: 'w1:p1' }));
  const text = lines.map(stripAnsi);
  const firstCard = text.map((l) => l.slice(0, TILE_W + 2)).join('\n');
  assert.ok(firstCard.includes(MANAGER_NAME), firstCard);
  assert.ok(firstCard.includes('1 needs you'), firstCard);
  assert.ok(firstCard.includes('Cass   approve: run'), firstCard);
});

test('a manager with its own hand up still shows it, and has no [y] [n] to misclick', () => {
  const people = floor(['working', 'idle'], 'blocked').people;
  const { hitboxes, lines } = renderFrame(viewOf({ people, cols: 140, rows: 46, frame: 2 }));
  assert.ok(!hitboxes.some((h) => h.id === 'w1:p99' && h.action), 'the clipboard took answer clicks');
  lines.forEach((line) => assert.equal(width(line), 140));
});

test('a long floor puts "+N more" on the last clipboard line', () => {
  const roster = floor(new Array(12).fill('working'));
  const text = renderFrame(viewOf({ people: roster.people, cols: 140, rows: 46 })).lines.map(stripAnsi).join('\n');
  assert.ok(text.includes('+6 more'), text);
});

test('node office.mjs --demo puts the manager first', async () => {
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['office.mjs', '--demo', '--once', '--no-title'], {
      cwd: ROOT,
      env: { ...process.env, COLUMNS: '140', LINES: '46' },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}`))));
  });
  const nameplates = stripAnsi(out).split('\n').filter((l) => l.includes('▌') && /claude|codex|kiro|gemini|opencode/.test(l));
  assert.ok(nameplates.length, out);
  // The first nameplate row has the manager in its leftmost card.
  assert.match(nameplates[0], /^\s*│\s+▌ Manager\b/);
});
