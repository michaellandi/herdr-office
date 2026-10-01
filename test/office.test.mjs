// The office itself, running, against a herdr that is not real.
//
// Everything else in this suite tests a function in src/. office.mjs was tested
// only as text, by protocol.test.mjs reading it for method names, which meant the
// seam between the office and the wire was the one place a bug could live with the
// whole suite green. One did: every request issued straight after another went out
// twice, and the way it showed up was a standup delivered twice to most of the
// room. Nothing here could have caught that, because nothing here ran the office.
//
// So this file starts one, as a child process, pointed at a socket of our own. The
// fake herdr does what the real one does (answers once per connection and closes)
// and keystrokes go in on stdin, which works because office.mjs only asks for raw
// mode when stdin is a tty and honours COLUMNS/LINES when it is not.
//
// Nothing here touches a real agent, which is the point: `agent.prompt` and
// `agent.send_keys` cannot be tried against a live session, so until there was a
// fake herdr to send them to they were never tried at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// The pane the fake herdr hands back from `tab.create`. Not in any test's `agents` list, so
// a manager is always somebody who was not on the floor a moment ago.
const HIRED_PANE = 'w1:hired';

// A desk, as herdr describes one.
const desk = (id, status, i, extra = {}) => ({
  pane_id: id,
  agent: 'claude',
  agent_status: status,
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  cwd: '/somewhere/repo',
  terminal_title_stripped: `task ${i}`,
  focused: i === 0,
  state_change_seq: 1,
  ...extra,
});

// Start an office. `screen` is everything it has drawn, `asked` everything it has
// asked herdr for.
//
// The fake closes each connection with end() rather than destroy(), which is the
// polite half-close: anything written to that socket afterwards still arrives.
// Deliberate, and the reason these tests can see a duplicate at all. The real
// herdr resets instead, so on the machine this was found on the duplicate was
// dropped by the kernel and looked like nothing was wrong.
async function openOffice({ agents, cols = 110, rows = 32, args = [], screenText = 'all done here', worktrees = null, git = null, book = null, manifests = null, hireFails = null, settings = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-run-'));
  const sockPath = path.join(dir, 's');
  const gitLog = path.join(dir, 'git-calls');
  const configPath = path.join(dir, 'settings.json');
  const asked = [];
  let out = '';

  const answer = (method) =>
    ({
      'session.snapshot': {
        workspaces: [{ workspace_id: 'w1', label: 'main', number: 1 }],
        tabs: [{ tab_id: 'w1:t1', label: 'work', number: 1 }],
      },
      'tab.list': { tabs: [{ tab_id: 'w1:t1', label: 'work', number: 1 }] },
      'agent.list': { agents },
      'agent.read': { read: { text: screenText } },
      // Off by default: without it every desk has a cwd and no repository, which is
      // what most of these tests want. With it, the office knows the directory is a
      // checkout, which is the gate on running git in it at all.
      'worktree.list': worktrees ?? {},
      // Hiring. `manifests` off by default, so a test that did not ask for this gets a
      // machine that can start nothing, which is the honest answer for a fake herdr and
      // is also the failure the office has to survive.
      'server.agent_manifests': { manifests: (manifests ?? []).map((agent) => ({ agent })) },
      'tab.create': { root_pane: { pane_id: HIRED_PANE } },
    })[method] ?? {};

  const live = new Set();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        asked.push({ method: req.method, params: req.params });
        // The one method in here that fails on request, because the office's behaviour after
        // a hire that did not work is half of what there is to test about hiring: it must not
        // try again, and it must say what to press instead.
        if (req.method === hireFails) {
          sock.write(`${JSON.stringify({ id: req.id, error: { code: 'NOPE', message: 'no room at the inn' } })}\n`);
          sock.end();
          return;
        }
        // A started agent turns up in the next `agent.list`, which the real herdr does and a
        // lookup table cannot. Without it the office correctly decides the manager it just
        // hired is not on the floor, and the whole path stops one call short of interesting.
        if (req.method === 'agent.start' && req.params?.pane_id) {
          agents.push(desk(req.params.pane_id, 'idle', agents.length, { agent: req.params.kind, cwd: req.params.cwd || '/tmp/manager' }));
        }
        // The subscription is the one connection that stays open and pushes.
        if (req.method === 'events.subscribe') {
          sock.write(`${JSON.stringify({ id: req.id, result: { subscribed: (req.params?.subscriptions || []).length } })}\n`);
          continue;
        }
        sock.write(`${JSON.stringify({ id: req.id, result: answer(req.method) })}\n`);
        sock.end();
        return;
      }
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));

  // A deliberately bare environment. HERDR_PLUGIN_STATE_DIR is removed so a run
  // cannot write a punch clock anywhere real, and HERDR_BIN_PATH is pointed at
  // nothing so the explain path cannot shell out to a herdr that exists.
  const env = { ...process.env };
  delete env.HERDR_PLUGIN_STATE_DIR;
  delete env.HERDR_PANE_ID;
  delete env.HERDR_TAB_ID;
  delete env.HERDR_WORKSPACE_ID;
  Object.assign(env, {
    HERDR_SOCKET_PATH: sockPath,
    HERDR_BIN_PATH: path.join(dir, 'no-herdr-here'),
    COLUMNS: String(cols),
    LINES: String(rows),
  });

  // The fake git below is a Node script, so answering costs a whole interpreter start,
  // and the office gives a checkout 1.5 seconds before it writes it off. That is the
  // right budget for a wall display and the wrong one for a machine already running
  // thirteen test files, where the spawn alone can miss it: the count then never reaches
  // the card and the failure reads as a broken feature rather than a busy laptop. The
  // production default stays where it is and this run is simply allowed to be slow.
  env.HERDR_OFFICE_GIT_TIMEOUT_MS = '30000';

  // Settings, in a scratch file, always. Not only when a test asks for some: the card
  // writes on every flip, and a run that fell through to the real path would edit the
  // preferences of whoever is running the suite.
  env.HERDR_OFFICE_CONFIG = configPath;
  if (settings) fs.writeFileSync(configPath, JSON.stringify(settings));

  // An office that is opening for the second time today, with a real state file written
  // by a real earlier run. Seeded through the same file the office writes rather than
  // through an injected object, because every other part of this is the real thing: the
  // point of a test at this level is that the wiring from the file to the floor works,
  // and that is exactly the part a unit test cannot see.
  if (book) {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // Today, rather than the day `savedAt` lands on. The office throws away a book from
    // another day and it is right to, but a fixture that says "shut forty minutes ago" is
    // about the gap and not about midnight, and dating it off `savedAt` made this test fail
    // for the first forty minutes of every local day.
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    fs.writeFileSync(
      path.join(stateDir, 'punchclock.json'),
      JSON.stringify({
        version: 1,
        day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        savedAt: book.savedAt,
        desks: book.desks,
      }),
    );
    env.HERDR_PLUGIN_STATE_DIR = stateDir;
  }

  // A git that is not git: it records how it was called and prints whatever porcelain
  // the test asked for. So the assertion is about a real subprocess with real arguments,
  // and no repository on this machine is read to make it.
  if (git != null) {
    const fake = path.join(dir, 'fake-git');
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\n`
      + `require('fs').appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
      + `process.stdout.write(${JSON.stringify(git)});\n`,
    );
    fs.chmodSync(fake, 0o755);
    env.HERDR_OFFICE_GIT = fake;
  } else {
    // Nothing on the box should be able to answer, so a test that did not ask for git
    // cannot accidentally read a real checkout.
    env.HERDR_OFFICE_GIT = path.join(dir, 'no-git-here');
  }

  const child = spawn(process.execPath, ['office.mjs', ...args], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Once, at spawn time. A second `child.on('close')` added after the event has
  // already fired never resolves, which hangs the run rather than failing it.
  const closed = new Promise((resolve) => child.on('close', resolve));
  let errText = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  child.stderr.on('data', (c) => {
    errText += c;
  });

  const office = {
    asked,
    get stderr() {
      return errText;
    },
    screen: () => out.replace(ANSI, ''),
    sent: (method) => asked.filter((a) => a.method === method),
    // Whatever the settings card has written, or null if it has not written anything.
    settingsFile: () => (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null),
    // Every argument list the office handed to git, in order.
    gitCalls: () => (fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    type: (keys) => child.stdin.write(keys),
    // The screen as a terminal would be showing it, row by row. `screen()` is every frame
    // ever drawn concatenated, which is the right thing for "did this text appear" and no
    // use at all for "which row is it on". Every row the office draws is written with an
    // explicit move to column one of a known line, so replaying those moves in order
    // rebuilds the current frame. A test that wants to click something needs this.
    frame() {
      const rowsOut = [];
      const moves = /\x1b\[(\d+);1H((?:[^\x1b]|\x1b\[[0-9;]*m)*)/g;
      let m;
      while ((m = moves.exec(out))) rowsOut[Number(m[1]) - 1] = m[2].replace(ANSI, '');
      return rowsOut;
    },
    // Where something is, in the frame as it stands, or -1.
    at(text) {
      const rowsOut = office.frame();
      const y = rowsOut.findIndex((l) => (l || '').includes(text));
      return y < 0 ? { x: -1, y: -1 } : { x: rowsOut[y].indexOf(text), y };
    },
    // A left-button press and release in the same place, SGR, which is what the office
    // turns on and what a real terminal sends. Both halves, because the two things a click
    // can mean are decided at different moments: a button answers on the press, and opening
    // a desk waits for the release, since a press that travels was a drag rather than a
    // request to open anything. One write, because the office reads every report in a chunk.
    click: (x, y) => child.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`),
    // Poll rather than sleep: a fixed wait is either flaky or slow, and on a
    // failure the message has to say what the office was showing instead.
    async until(what, pred, ms = 8000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const tail = office.screen().split('\n').filter((l) => l.trim()).slice(-4).join(' | ');
      throw new Error(`timed out waiting for ${what}. asked: ${JSON.stringify(asked.map((a) => a.method))}. screen: ${tail.slice(0, 400)}`);
    },
    onScreen: (text) => office.screen().includes(text),
    // Keys typed before the office is reading stdin are simply lost, so every test
    // that presses one waits for this first. A frame on screen is not enough: the
    // first frame is drawn while the subscription and the first poll are still in
    // flight. One full poll after the subscription is the cheapest thing to
    // observe that means startup is genuinely over.
    async ready(firstFrame) {
      await office.until('the first frame', () => office.onScreen(firstFrame));
      await office.until('the office to finish starting up', () => office.sent('events.subscribe').length >= 1 && office.sent('agent.list').length >= 2);
    },
    exit: () => closed,
    async stop() {
      child.kill('SIGTERM');
      await closed;
      // Destroy the subscription connection too. server.close() only stops new
      // ones, so a socket still open here keeps the test runner alive.
      for (const sock of live) sock.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return office;
}

// Long enough for a duplicate to have arrived if one were coming. A duplicate is
// written in the same tick as the answer it follows, so this is generous: the
// assertion is "still exactly N", not "N so far".
const SETTLE = 500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE));

test('the office draws the desks herdr told it about', async () => {
  // The whole pipeline in one assertion: socket, roster, layout, cells. Also
  // proves the harness itself works, which the tests below depend on.
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)], args: ['--once'] });
  try {
    const code = await office.exit();
    assert.equal(code, 0, `--once did not exit cleanly: ${office.stderr}`);
    assert.equal(office.stderr.trim(), '', 'a clean run should say nothing on stderr');
    assert.ok(office.onScreen('2 desks'), 'the header did not count the desks');
    assert.ok(office.onScreen('task 0') && office.onScreen('task 1'), 'the pane titles did not reach the cards');
    // The last row of the frame, so this fails if the write is cut short rather than
    // rendered short. A frame is about 25KB and a pipe buffer on macOS is 16KB, so an
    // exit that does not wait for the flush loses everything below the header: the
    // assertions above pass and the bottom half of the office is simply gone.
    assert.ok(office.onScreen('hjkl walk'), 'the frame was truncated before its last row');
    // A render is a read. Nothing that changes anything should have been sent.
    assert.deepEqual(office.sent('agent.send_keys'), [], 'a single frame wrote to an agent');
    assert.deepEqual(office.sent('agent.prompt'), [], 'a single frame prompted an agent');
  } finally {
    await office.stop();
  }
});

test('a standup reaches every agent exactly once', async () => {
  // The load-bearing test in this file. This is the shape the duplicate showed up
  // in: a sequential loop of writes, one per person, each one issued the instant
  // the previous answer landed. With the old client this sent the same
  // instruction twice to everybody but the first person.
  const agents = [desk('w1:p1', 'idle', 0), desk('w1:p2', 'idle', 1), desk('w1:p3', 'idle', 2)];
  const office = await openOffice({ agents });
  try {
    await office.ready('3 desks');

    office.type('A');
    await office.until('the standup field', () => office.onScreen('enter to review who gets it'));
    office.type('standup');
    await office.until('the typed text', () => office.onScreen('standup'));

    // Reviewing who gets it must not send anything. This is the only place in the
    // office where one keypress reaches more than one agent, so the step that
    // exists to make you look before it does has to actually not send.
    office.type('\r');
    await office.until('the confirm step', () => office.onScreen('enter to send this to 3 people'));
    await settle();
    assert.deepEqual(office.sent('agent.prompt'), [], 'reviewing a standup already sent it');

    office.type('\r');
    await office.until('three prompts', () => office.sent('agent.prompt').length >= 3);
    await settle();

    const prompts = office.sent('agent.prompt');
    assert.equal(prompts.length, 3, `sent ${prompts.length} prompts to 3 people: ${JSON.stringify(prompts.map((p) => p.params.target))}`);
    assert.deepEqual(
      prompts.map((p) => p.params.target).sort(),
      ['w1:p1', 'w1:p2', 'w1:p3'],
      'the standup did not reach each desk exactly once',
    );
    for (const p of prompts) assert.equal(p.params.text, 'standup', 'the text got mangled on the way out');
  } finally {
    await office.stop();
  }
});

test('dropping a standup writes to nobody', async () => {
  // esc after typing is the ordinary way out of a field opened by accident, and
  // the office is one keystroke away from having broadcast it.
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'idle', 1)] });
  try {
    await office.ready('2 desks');
    office.type('A');
    await office.until('the standup field', () => office.onScreen('enter to review who gets it'));
    office.type('do not send this');
    await office.until('the typed text', () => office.onScreen('do not send this'));
    office.type('\x1b');
    await settle();
    assert.deepEqual(office.sent('agent.prompt'), [], 'a dropped standup was sent anyway');
  } finally {
    await office.stop();
  }
});

// A prompt that offers a standing permission, with the always option deliberately
// at 3 rather than 2, so a test that passed against a hardcoded digit fails here.
const MENU_WITH_ALWAYS = [
  'Bash command: rm -rf build',
  '',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently',
  "  3. Yes, and don't ask again for rm commands",
].join('\n');

test('answering in words types the answer and submits it in one call', async () => {
  // The case y/n cannot answer: a question that is not a yes or a no. herdr rejects
  // a prompt to a blocked agent outright (agent_blocked), so this is the only route
  // to a waiting desk, and it goes as one pane.send_input carrying the words and the
  // enter together rather than two calls with a gap in the middle.
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0)],
    screenText: 'Which approach do you want?\nDo you want me to use the existing helper? (y/n)',
  });
  try {
    await office.ready('NEEDS YOU');
    office.type('s');
    await office.until('the answer field', () => office.onScreen('type your answer'));
    office.type('use the existing helper');
    await office.until('the typed answer', () => office.onScreen('use the existing helper'));
    office.type('\r');
    await office.until('the answer', () => office.sent('pane.send_input').length >= 1);
    await settle();

    const sent = office.sent('pane.send_input');
    assert.equal(sent.length, 1, `sent ${sent.length} answers`);
    assert.equal(sent[0].params.pane_id, 'w1:p1');
    assert.equal(sent[0].params.text, 'use the existing helper');
    assert.deepEqual(sent[0].params.keys, ['enter'], 'the answer was typed but never submitted');
    // Not a prompt: agent.prompt to a blocked agent is refused before any input is
    // sent, so falling back to it here would look like the key doing nothing.
    assert.deepEqual(office.sent('agent.prompt'), [], 'a waiting desk was sent a prompt');
  } finally {
    await office.stop();
  }
});

test('dropping an answer writes to nobody', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0)],
    screenText: 'Do you want me to apply the patch? (y/n)',
  });
  try {
    await office.ready('NEEDS YOU');
    office.type('s');
    await office.until('the answer field', () => office.onScreen('type your answer'));
    office.type('never mind');
    await office.until('the typed answer', () => office.onScreen('never mind'));
    office.type('\x1b');
    await settle();
    assert.deepEqual(office.sent('pane.send_input'), [], 'a dropped answer was sent anyway');
  } finally {
    await office.stop();
  }
});

test('a standing permission takes two keys, and the first one sends nothing', async () => {
  // The most consequential thing the office can send: not an answer to this
  // question, but an answer to every question of this kind from here on. So Y arms
  // and enter grants, and the digit is the one read off the menu.
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], screenText: MENU_WITH_ALWAYS });
  try {
    await office.ready('NEEDS YOU');
    office.type('Y');
    await office.until('the confirmation', () => office.onScreen('never mind'));
    await settle();
    assert.deepEqual(office.sent('agent.send_keys'), [], 'arming a standing permission already granted it');
    // The menu's own words, so what is being agreed to is on the screen.
    assert.ok(office.onScreen("don't ask again for rm commands"), 'the grant did not say what it grants');

    office.type('\r');
    await office.until('the grant', () => office.sent('agent.send_keys').length >= 1);
    await settle();

    const keys = office.sent('agent.send_keys');
    assert.equal(keys.length, 1, `sent ${keys.length} times`);
    assert.equal(keys[0].params.target, 'w1:p1');
    // 3, not 2. Option 2 on this menu is "No, and tell Claude what to do
    // differently", so a hardcoded digit would deny the command under a key the
    // footer calls "always allow".
    assert.deepEqual(keys[0].params.keys, ['3'], 'the digit was not the one on the menu');
  } finally {
    await office.stop();
  }
});

test('backing out of a standing permission grants nothing', async () => {
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], screenText: MENU_WITH_ALWAYS });
  try {
    await office.ready('NEEDS YOU');
    office.type('Y');
    await office.until('the confirmation', () => office.onScreen('never mind'));
    office.type('\x1b');
    await settle();
    assert.deepEqual(office.sent('agent.send_keys'), [], 'esc granted a standing permission');
    // And the office is back on the floor rather than stuck in a state whose only
    // way out was the key that just cancelled it.
    assert.ok(office.onScreen('walk'), 'the floor hints did not come back');
  } finally {
    await office.stop();
  }
});

test('a prompt with no standing option cannot grant one', async () => {
  // A plain y/n has nothing to grant, so Y must refuse rather than sending a digit
  // into a prompt that would read it as something else entirely.
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0)],
    screenText: 'Do you want me to apply the patch? (y/n)',
  });
  try {
    await office.ready('NEEDS YOU');
    office.type('Y');
    await office.until('the refusal', () => office.onScreen('does not offer'));
    await settle();
    assert.deepEqual(office.sent('agent.send_keys'), [], 'a digit was sent to a y/n prompt');
  } finally {
    await office.stop();
  }
});

// A checkout, as `worktree.list` describes one, and a status for the fake git to print.
const WORKTREES = { source: { repo_name: 'repo' }, worktrees: [{ path: '/somewhere/repo', branch: 'refs/heads/feature/sso' }] };
const STATUS = ['UU src/render.mjs', ' M office.mjs', '?? notes/', 'M  src/dirt.mjs'].join('\n');

test('a checkout the office was told about gets counted, and read as a guest', async () => {
  // The seam this covers is the one src/dirt.mjs cannot: whether the office actually
  // runs the arguments that file promises, in the directories it says it will, having
  // first been told those directories are repositories. `worktree.list` is answered here
  // for the first time, so this also runs the branch path end to end.
  const office = await openOffice({
    agents: [desk('w1:p1', 'working', 0), desk('w1:p2', 'idle', 1)],
    args: ['--once', '--detail'],
    worktrees: WORKTREES,
    git: STATUS,
  });
  try {
    assert.equal(await office.exit(), 0, `--once did not exit cleanly: ${office.stderr}`);
    assert.equal(office.stderr.trim(), '', 'a clean run should say nothing on stderr');
    // The branch came off the socket and the count came off git, on the same card.
    assert.ok(office.onScreen('feature/sso'), 'the branch never reached the screen');
    assert.ok(office.onScreen('4 uncommitted · 1 conflicted'), `the count never reached the card: ${office.screen().slice(-600)}`);

    // Two desks, one checkout, one subprocess: this is cached against the directory
    // rather than the person, and a floor of twenty agents in one repo must not be
    // twenty gits.
    const calls = office.gitCalls();
    assert.equal(calls.length, 1, `ran git ${calls.length} times for one checkout`);
    // The flags dirt.mjs promises, verified where it counts: on a real argument vector
    // handed to a real process.
    assert.ok(calls[0].includes('--no-optional-locks'), calls[0].join(' '));
    assert.ok(calls[0].includes('core.fsmonitor=false'), calls[0].join(' '));
    assert.deepEqual(calls[0].slice(calls[0].indexOf('-C'), calls[0].indexOf('-C') + 2), ['-C', '/somewhere/repo']);
    // And nothing about the count went back to herdr. The office reads a checkout; it
    // does not tell anybody what it found.
    assert.deepEqual(office.sent('agent.send_keys'), []);
    assert.deepEqual(office.sent('agent.prompt'), []);
  } finally {
    await office.stop();
  }
});

test('no git runs in a directory nobody said was a checkout, or when asked not to', async () => {
  // Two gates, both worth having. The office is sitting in whatever directory a pane
  // happens to be in, which might be a home directory or somebody else's project, so it
  // only ever asks about directories the server has already called checkouts. And
  // --no-git turns the whole thing off for anybody who would rather it did not run.
  const bare = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    args: ['--once'],
    git: STATUS,
  });
  try {
    assert.equal(await bare.exit(), 0, bare.stderr);
    assert.deepEqual(bare.gitCalls(), [], 'git ran in a directory that was never called a repository');
  } finally {
    await bare.stop();
  }

  const off = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    args: ['--once', '--detail', '--no-git'],
    worktrees: WORKTREES,
    git: STATUS,
  });
  try {
    assert.equal(await off.exit(), 0, off.stderr);
    assert.deepEqual(off.gitCalls(), [], '--no-git ran git anyway');
    // The rest of the office is unaffected: the branch still comes off the socket, and
    // the card simply has no row about changes.
    assert.ok(off.onScreen('feature/sso'), 'the branch went missing with --no-git');
    assert.ok(!off.onScreen('uncommitted'), 'a card claimed something about a checkout nobody read');
  } finally {
    await off.stop();
  }
});

test('the office reads how full a head is off the screen, unless it is told not to', async () => {
  // The whole path, which no other test covers: a status line on a screen, through the
  // parser, onto a desk. The reading is the office's own inference rather than anything
  // herdr reports, and the screen is only read because something here asks for it, so
  // this is the only place that can tell whether the two halves are wired together.
  const GAUGE = 'Working on it\n  Opus | Context: 76% | session: 19h 03m';
  const on = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    args: ['--once', '--detail'],
    screenText: GAUGE,
  });
  try {
    assert.equal(await on.exit(), 0, on.stderr);
    assert.ok(on.sent('agent.read').length >= 1, 'nobody looked at a screen');
    assert.ok(on.onScreen('76% full'), 'the card did not say how full the head was');
    assert.ok(on.onScreen('opus'), 'the model off the status line did not reach the card');
    // And nothing else off that line did. The trailing field here stands in for the auth
    // countdown a real one carries, and the rule is that it never leaves the parser. It is
    // on screen, in the panel that quotes the screen back verbatim, and that is the user
    // looking at their own terminal and the whole point of that panel. What must not
    // happen is it turning up anywhere the office wrote itself, so every line it appears
    // on has to be the quoted status line and nothing else.
    for (const line of on.screen().split('\n')) {
      if (!line.includes('19h 03m')) continue;
      assert.match(line, /Opus \| Context: 76% \| session: 19h 03m/, `a field off a status line reached a row the office wrote: ${line.trim()}`);
    }
    // This is the one feature that looks at every desk rather than only the ones with a
    // hand up, so it is the one that had better not touch anything.
    assert.deepEqual(on.sent('agent.send_keys'), []);
    assert.deepEqual(on.sent('agent.prompt'), []);
  } finally {
    await on.stop();
  }

  const off = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    // No card, deliberately: an open card quotes the screen back and so reads one whatever
    // this flag says, which is a thing the user asked for by opening it. The flag is about
    // the reads nobody asked for, so the floor on its own is what has to be silent.
    args: ['--once', '--no-context'],
    screenText: GAUGE,
  });
  try {
    assert.equal(await off.exit(), 0, off.stderr);
    // Nothing drawn, and the stronger claim: nothing read. With the gauge off and no hand
    // up there is no reason to look at anybody's screen, and the opt-out is only worth
    // having if it is the reading it turns off rather than the drawing.
    assert.deepEqual(off.sent('agent.read'), [], '--no-context read a screen anyway');
    assert.ok(!off.onScreen('76%'), '--no-context drew a gauge anyway');
  } finally {
    await off.stop();
  }
});

test('answering a raised hand sends exactly one keystroke', async () => {
  // `y` is the most dangerous key in the office: it answers a prompt the user has
  // not necessarily read, on a real agent. Sending it twice would answer the next
  // question too, whatever that turned out to be.
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0)],
    screenText: 'Ran the suite\nDo you want me to apply the patch? (y/n)',
  });
  try {
    await office.ready('NEEDS YOU');
    office.type('y');
    await office.until('the keystroke', () => office.sent('agent.send_keys').length >= 1);
    await settle();

    const keys = office.sent('agent.send_keys');
    assert.equal(keys.length, 1, `sent ${keys.length} keystrokes, which is ${keys.length} answers to a prompt`);
    assert.equal(keys[0].params.target, 'w1:p1');
    // A literal y/n prompt takes the letter. If the shape read were wrong this
    // would be enter, which on a menu is whatever happened to be highlighted.
    assert.deepEqual(keys[0].params.keys, ['y'], 'the wrong key was sent for a y/n prompt');
  } finally {
    await office.stop();
  }
});

test('an office opening for the second time today picks the clocks back up', async () => {
  // The whole day book, through the real thing: a real state file, the real office
  // process, the real socket, and an assertion about pixels on a screen. The unit tests
  // prove the rule; this proves the rule is wired to something you can see.
  const savedAt = Date.now() - 40 * 60 * 1000;
  const office = await openOffice({
    agents: [
      // Blocked since breakfast and still blocked on the very same prompt, which is what
      // the unchanged sequence number says.
      desk('w1:p1', 'blocked', 0, { state_change_seq: 7 }),
      // Also in the book, but herdr has counted a change since. Nobody saw when.
      desk('w1:p2', 'idle', 1, { state_change_seq: 99 }),
    ],
    book: {
      savedAt,
      desks: [
        { id: 'w1:p1', status: 'blocked', since: savedAt - 2 * 60 * 60 * 1000, seq: 7, assumed: false },
        { id: 'w1:p2', status: 'working', since: savedAt - 2 * 60 * 60 * 1000, seq: 3, assumed: false },
        { id: 'w1:p9', status: 'idle', since: savedAt - 2 * 60 * 60 * 1000, seq: 1, assumed: false },
      ],
    },
  });
  try {
    await office.until('the floor', () => office.screen().includes('Ada'));
    // One desk held, one moved, one gone, and the office says so on the message line.
    await office.until(
      'the line about the gap',
      () => /shut for 40m\d\ds: 1 of 2 moved, 1 gone/.test(office.screen()),
    );

    const screen = office.screen();
    // Ada was stuck before the office shut and is stuck on the same thing now, so her
    // clock reads in hours and carries no `~`. Before the day book this said 0s.
    assert.match(screen, /2h4[01]m/, 'Ada lost the two hours she was already stuck for');
    assert.ok(!/~2h/.test(screen), 'a clock herdr just confirmed must not be hedged with a `~`');
  } finally {
    await office.stop();
  }
});

test('the manager notices two desks in one checkout, and m walks the list', async () => {
  // The chief of staff end to end (see src/notices.mjs). Every desk the harness makes
  // shares `/somewhere/repo`, so two working ones is a real collision built out of
  // nothing but what herdr said, and the gauge on the shared screen makes both of them
  // nearly full as well. Three notices, so `m` has somewhere to go and the counter on
  // the footer is the proof that it went there.
  const office = await openOffice({
    agents: [desk('w1:p1', 'working', 0), desk('w1:p2', 'working', 1), desk('w1:p3', 'idle', 2)],
    screenText: 'Working on it\n  Opus | Context: 94% | session: 19h 03m',
    cols: 200,
  });
  try {
    await office.ready('3 desks');
    await office.until('the notice', () => /Ada and Bo are both in repo/.test(office.screen()));
    // Only the last segment of the path, on a line that gets screen-shared.
    assert.ok(!office.onScreen('/somewhere/repo'), 'the whole path reached the footer');
    // The idle desk is sitting still, so it is not named as being in the way.
    assert.ok(!/Ada, Bo and Cass/.test(office.screen()), 'a desk that has stopped was counted as in the room');
    assert.ok(/1\/3/.test(office.screen()), 'the footer did not say which of three notices it was showing');

    // The first press takes you to the notice already on the footer, so the one on
    // screen when you reached for the key is not the one it skips.
    const at = () => (office.screen().match(/(\d)\/3(?!\d)/g) || []).slice(-1)[0];
    office.type('m');
    await office.until('the second notice', () => at() === '2/3');
    assert.ok(/Ada is 94% full and still working/.test(office.screen()), 'the second notice was not drawn');
    office.type('m');
    await office.until('the third notice', () => at() === '3/3');
    assert.ok(/Bo is 94% full and still working/.test(office.screen()), 'the third notice was not drawn');
    // And round, rather than off the end.
    office.type('m');
    await office.until('the list to come round', () => at() === '1/3');

    // All of which was a read. That is the entire claim this first version of a
    // manager makes about itself, so it is asserted rather than assumed.
    assert.deepEqual(office.sent('agent.send_keys'), [], 'the manager wrote to an agent');
    assert.deepEqual(office.sent('agent.prompt'), [], 'the manager prompted an agent');
    assert.deepEqual(office.sent('pane.send_input'), [], 'the manager typed into a pane');
    assert.deepEqual(office.sent('pane.focus'), [], "the manager moved somebody else's focus");
  } finally {
    await office.stop();
  }
});

test('the first press takes you to the notice on screen rather than past it', async () => {
  // The desk the office opens on is idle and so is in none of the notices, which is the
  // only arrangement that can tell the two readings of `m` apart. Advancing first would
  // mean the notice sitting on the footer when the reader reached for the key is the one
  // notice the key never shows them, so the count has to stay where it is and the
  // selection has to be what moves.
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1), desk('w1:p3', 'working', 2)],
    screenText: 'Working on it\n  Opus | Context: 94% | session: 19h 03m',
    cols: 200,
  });
  try {
    await office.ready('3 desks');
    const at = () => (office.screen().match(/(\d)\/3(?!\d)/g) || []).slice(-1)[0];
    await office.until('three notices', () => at() === '1/3');
    office.type('m');
    await settle();
    assert.equal(at(), '1/3', 'the first press skipped the notice it was showing');
    // And the second one moves, so the key is not simply doing nothing.
    office.type('m');
    await office.until('the second notice', () => at() === '2/3');
  } finally {
    await office.stop();
  }
});

test('the manager has a desk, and every key that writes refuses at it', async () => {
  // The desk is drawn in the middle of the grid, next to desks where y sends a
  // keystroke to a real agent and a sends a real prompt. So the claim that it is
  // read-only is not a property of src/manager.mjs, which obviously cannot reach a
  // socket; it is a property of the whole running office with that desk selected.
  //
  // A quiet floor on purpose: two idle desks in one checkout is not a collision, so
  // there is nothing to report, and `m` on a floor with nothing to say is what walks
  // you to the desk. Which is also the answer to the original complaint: the key that
  // used to print "nothing worth mentioning" and leave you standing where you were now
  // takes you to somebody sitting there doing the watching.
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'idle', 1)] });
  try {
    await office.ready('2 desks');
    // Drawn before anything is pressed, which is the whole point of the desk: a manager
    // with nothing to report is visibly sitting there rather than absent.
    assert.ok(office.onScreen('THE MANAGER'), 'the desk was not on the quiet floor');
    assert.ok(office.onScreen('WATCHING'), 'the desk did not say what it was doing');
    assert.ok(office.onScreen('nothing needs you right now'));

    // Walk to it, then open its card, which is the one panel in the office with no
    // buttons on it. A wait between the two keys and not an `until`: everything `m`
    // changes was already on this screen before it was pressed, so any predicate about
    // the manager is already true and returns in the same tick, which lets `m` and the
    // return key reach the office as the single string "m\r". That matches no key at all,
    // and this test failed roughly one run in eight on exactly that. The card appearing is
    // itself the proof `m` landed: return at anybody else's desk opens their detail panel,
    // which says nothing about reading the floor.
    office.type('m');
    await settle();
    office.type('\r');
    await office.until('the card', () => office.onScreen('it reads the floor and writes lines'));
    assert.ok(office.onScreen('nothing, which is the good outcome'));

    // Now every key that can reach an agent, from that desk, with the card open. One at
    // a time with a wait between: stdin arrives in chunks, and six keys written in one
    // tick reach the office as the single string "nYasf", which matches no key at all
    // and would make this pass without having pressed anything.
    office.type('y');
    await office.until('a refusal', () => office.onScreen('the manager does not take jobs'));
    // The rest one per write, with a gap between: stdin arrives in chunks, and four keys
    // written in one tick reach the office as the single string "nYas", which matches no
    // key at all and would make this pass without having pressed anything.
    //
    // No screen assertion per key, deliberately. All five refuse with the same sentence
    // and draw() writes only the rows that changed, so the second identical refusal paints
    // nothing; counting them is a race against the clock in the header rather than a fact
    // about the office. What is asserted instead is below, and it is the stronger claim:
    // nothing went out, and neither field these keys can open ever appeared.
    for (const key of ['n', 'Y', 'a', 's']) {
      office.type(key);
      await settle();
    }
    // And the key that walks you to somebody's terminal, which fails differently: there
    // is no pane behind this desk to walk to. Matched on the front of the sentence,
    // because the footer shares its row with the key hints and cuts the tail.
    office.type('f');
    await office.until('the pane refusal', () => office.onScreen('the manager has no pane'));
    await settle();

    assert.deepEqual(office.sent('agent.send_keys'), [], 'the manager sent keystrokes to an agent');
    assert.deepEqual(office.sent('agent.prompt'), [], 'the manager prompted an agent');
    assert.deepEqual(office.sent('pane.send_input'), [], 'the manager typed into a pane');
    assert.deepEqual(office.sent('pane.focus'), [], "the manager moved somebody else's focus");
    assert.deepEqual(office.sent('pane.swap'), [], 'the manager moved a pane');
    assert.deepEqual(office.sent('pane.close'), [], 'the manager closed a pane');
    assert.deepEqual(office.sent('agent.start'), [], 'the manager hired somebody');
    assert.deepEqual(office.sent('worktree.create'), [], 'the manager made a worktree');
    // And no key opened a field to write in. `a` opens a job field and `s` an answer
    // field at any desk with somebody at it, so their absence over everything the office
    // has drawn is what says those two keys were read and turned down.
    assert.ok(!office.onScreen('enter to review who gets it'), 'a opened a job field at the manager\'s desk');
    assert.ok(!office.onScreen('type your answer'), 's opened an answer field at the manager\'s desk');
    // And it said why each time rather than swallowing the key, which is the whole
    // difference between a desk that is quiet and a desk that looks broken.
    assert.ok(office.onScreen('it only reports'));
  } finally {
    await office.stop();
  }
});

/* ------------------------------------------ hiring a manager without being asked */

// The one thing the office does that starts a real agent without anybody pressing a key, so
// it is the one thing most worth running against a herdr that is not real. `M` can be tried
// by hand on a live floor and this cannot: it fires on a card opening, which is exactly what
// somebody trying it out would do, and if the gate is wrong the failure is a pile of agent
// sessions somebody is paying for.

test('opening the manager card hires a manager, of the kind the floor is mostly made of', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0, { agent: 'codex' }), desk('w1:p2', 'working', 1, { agent: 'codex' }), desk('w1:p3', 'idle', 2)],
    manifests: ['claude', 'codex', 'gemini'],
    args: ['--board'],
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the hire', () => office.sent('agent.start').length === 1);
    const started = office.sent('agent.start')[0].params;
    assert.equal(started.kind, 'codex', 'it did not hire the kind the floor is made of');
    assert.equal(started.pane_id, HIRED_PANE, 'it started an agent somewhere other than the tab it made');

    // A plain tab, not a worktree. A manager never reads code, so the smallest thing that
    // will hold one is an empty directory, and an empty directory is a smaller blast radius
    // than the throwaway branch `M` defaults to: there is no repository there to damage.
    assert.equal(office.sent('worktree.create').length, 0, 'it made a worktree for somebody who never reads code');
    const tab = office.sent('tab.create')[0].params;
    assert.equal(tab.focus, false, 'it took the reader off the card it was drawing');
    assert.ok(tab.cwd.startsWith(os.tmpdir()), `it sat the manager somewhere permanent: ${tab.cwd}`);
    assert.ok(fs.existsSync(tab.cwd), 'the directory it named does not exist');
    assert.ok(!fs.existsSync(path.join(tab.cwd, '.git')), 'the manager room is a repository');
    // And not where the desks are. The hand hire takes its cwd from whoever is focused, which
    // is the right default for somebody who is going to write code and the wrong one for
    // somebody who is going to read a paragraph.
    assert.notEqual(tab.cwd, '/somewhere/repo', 'it sat the manager in a checkout somebody is working in');

    // And it is trusted with nothing. `trust_repository` is never sent, by either hire path.
    assert.ok(!('trust_repository' in tab), 'the office pre-trusted a repository');

    // Named on the card as a person, like every other desk: the kind is what was started and
    // the name is who is sitting there, and the card is about the latter.
    await office.until('the card to name them', () => /\w+ · (nothing asked yet|reading the floor now)/.test(office.screen()));
    assert.ok(!office.onScreen('nobody hired'), 'the card still said nobody was hired');
    // The manager is not a desk the office reports on. It arrived on the floor a moment ago
    // and a stall notice about the office's own manager would go into the manager's own next
    // digest, which is the office summarizing its own report.
    await office.until('the first ask', () => office.sent('agent.prompt').length === 1);
    const prompt = office.sent('agent.prompt')[0];
    assert.equal(prompt.params.target, HIRED_PANE);
    assert.ok(!prompt.params.text.includes(HIRED_PANE), 'the manager was told about itself');
  } finally {
    await office.stop();
  }
});

test('nobody is hired for a card nobody opened', async () => {
  // The gate, and the whole reason this is affordable. Without it every office run anywhere
  // starts an agent, and the office is a wall display as often as it is a tool.
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    cols: 140,
  });
  try {
    await office.ready('2 desks');
    await settle();
    assert.deepEqual(office.sent('agent.start'), [], 'it hired somebody for a floor plan');
    assert.deepEqual(office.sent('tab.create'), [], 'it opened a tab nobody asked for');
    assert.deepEqual(office.sent('server.agent_manifests'), [], 'it went looking for kinds it had no use for');
  } finally {
    await office.stop();
  }
});

test('--no-manager opens the card and hires nobody', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    args: ['--board', '--no-manager'],
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the card', () => office.onScreen('nobody hired'));
    await settle();
    assert.deepEqual(office.sent('agent.start'), [], 'the flag did not stop the hire');
    // And it still says which key would, because this is the office as it shipped.
    assert.ok(office.onScreen('M hires a manager'));
  } finally {
    await office.stop();
  }
});

test('a hire that fails says what to press instead, and is not tried again', async () => {
  // The loop this guards against is the expensive one: a card open that retries would start
  // a tab and an agent every time somebody looked at the card.
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    hireFails: 'agent.start',
    args: ['--board'],
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the failure on the card', () => office.onScreen('could not hire a manager'));
    assert.ok(office.onScreen('M hires one by hand'));
    // Walk away and come back. `esc` closes the card and leaves the selection on the manager's
    // desk, so `\r` reopens it, which is the keystroke that hires: if the one-attempt flag were
    // missing this is where the second tab and the second agent would be started.
    const failed = office.sent('agent.start').length;
    office.type('\x1b');
    await settle();
    // Measured from here rather than against the whole screen, because `office.screen()` is
    // everything the office has ever drawn and the first card is still in it. Anything found
    // past this mark was drawn after the reopen.
    const mark = office.screen().length;
    office.type('\r');
    await office.until('the card to come back', () => office.screen().slice(mark).includes('could not hire a manager'));
    await settle();
    assert.equal(office.sent('agent.start').length, failed, 'it tried to hire again');
    assert.equal(office.sent('tab.create').length, 1, 'it opened a second tab for a second try');
    assert.deepEqual(office.sent('agent.prompt'), [], 'it asked a manager it never hired');
  } finally {
    await office.stop();
  }
});

test('a machine that can start nothing is told so rather than asked to start nothing', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    args: ['--board'],
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the card to give up', () => office.onScreen('could not hire a manager'));
    assert.deepEqual(office.sent('tab.create'), [], 'it opened a tab for an agent it could not name');
    assert.deepEqual(office.sent('agent.start'), [], 'it started an agent with no kind');
  } finally {
    await office.stop();
  }
});

/* -------------------------------------------------------------- the settings card */

test('a comma opens the switches, and esc puts them away', async () => {
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0)] });
  try {
    await office.ready('1 desk');
    assert.ok(!office.onScreen('hire a manager'), 'the card was open before anybody asked');
    office.type(',');
    await office.until('the card', () => office.onScreen('hire a manager'));
    // All six, through the real office rather than a rendered view model.
    for (const label of ['read how full each head is', 'count what is uncommitted', 'say when somebody needs you', 'draw the pixel charts', 'set the window title']) {
      assert.ok(office.onScreen(label), `${label} is not on the card`);
    }
    // And where it is being kept, which is a real path on this machine.
    assert.ok(office.onScreen('kept in'), 'the card does not say where this is kept');

    const before = office.screen().length;
    office.type('\x1b');
    await office.until('the card to close', () => !office.screen().slice(before).includes('hire a manager'));
  } finally {
    await office.stop();
  }
});

test('a switch flipped on the card is on disk before the next keystroke', async () => {
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0)], args: ['--settings'] });
  try {
    await office.ready('1 desk');
    assert.equal(office.settingsFile(), null, 'something was written before anybody flipped anything');
    office.type(' ');
    await office.until('the file', () => office.settingsFile()?.manager === false);
    // Only the disagreement. Five switches nobody argued about stay out of the file so a
    // better default can still reach this office later.
    assert.deepEqual(office.settingsFile(), { manager: false });
    await office.until('the card to say so', () => /hire a manager\s+off/.test(office.screen()));

    // Down two and off, which is the git switch: the arrows move the cursor rather than
    // walking the floor behind the card. One key per write, because a chunk of stdin is one
    // keystroke to the office and `jj` is not a key.
    // One at a time, with a wait between: two writes in the same tick arrive as one chunk
    // of stdin, and a chunk is one keystroke to the office.
    office.type('j');
    await office.until('the first move', () => /▌ read how full each head is/.test(office.screen()));
    office.type('j');
    await office.until('the cursor', () => /▌ count what is uncommitted/.test(office.screen()));
    office.type(' ');
    await office.until('the second switch', () => office.settingsFile()?.git === false);
    assert.deepEqual(office.settingsFile(), { manager: false, git: false });

    // And back on, which takes it out of the file rather than writing `true`.
    office.type(' ');
    await office.until('the file to forget it', () => office.settingsFile()?.git === undefined);
    assert.deepEqual(office.settingsFile(), { manager: false });
  } finally {
    await office.stop();
  }
});

test('an office that was told once does not hire a manager again', async () => {
  // The whole point of the file. Last time this pane was open somebody turned the manager
  // off on the card; this time the card opens and nobody is hired, with no flag involved.
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    args: ['--board'],
    settings: { manager: false },
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the card', () => office.onScreen('nobody hired'));
    await settle();
    assert.deepEqual(office.sent('agent.start'), [], 'the saved setting did not stop the hire');
    assert.deepEqual(office.sent('tab.create'), [], 'a tab was opened for a manager nobody wanted');
  } finally {
    await office.stop();
  }
});

test('a switch says it is off because of a flag, and the flag does not rewrite the file', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0)],
    args: ['--settings', '--no-git'],
    settings: { manager: false },
  });
  try {
    await office.ready('1 desk');
    await office.until('the card', () => office.onScreen('count what is uncommitted'));
    assert.ok(/count what is uncommitted\s+off\s+--no-git this run/.test(office.screen()), 'the card does not say the flag is why');
    // The saved setting is still drawn as saved, with nothing said about a flag.
    assert.ok(/hire a manager\s+off\s{2,}$/m.test(office.screen().split('\n').map((l) => l.replace(/\s+│.*$/, '')).join('\n')) || /hire a manager\s+off/.test(office.screen()));
    assert.ok(!office.onScreen('--no-manager this run'), 'a flag nobody passed was blamed');
    // And nothing was written, because a flag is about this run.
    await settle();
    assert.deepEqual(office.settingsFile(), { manager: false });
  } finally {
    await office.stop();
  }
});

test('turning git off stops the office running git', async () => {
  // The one setting whose effect is a subprocess, so this is the only place the claim can
  // be checked: a real fake git, really spawned, and then really not spawned again.
  const office = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    worktrees: WORKTREES,
    git: ' M one.js\n M two.js\n?? three.js\n',
    cols: 140,
    rows: 46,
  });
  try {
    await office.ready('1 desk');
    await office.until('git to have run', () => office.gitCalls().length >= 1);
    // Into the compact list, which is the one view that says the count in words a test can
    // read: on the floor plan the same fact is a pile of paper on a desk.
    office.type('z');
    await office.until('the count to reach the list', () => office.at('+3').y >= 0);

    office.type(',');
    await office.until('the card', () => office.onScreen('count what is uncommitted'));
    // One at a time, with a wait between: two writes in the same tick arrive as one chunk
    // of stdin, and a chunk is one keystroke to the office.
    office.type('j');
    await office.until('the first move', () => /▌ read how full each head is/.test(office.screen()));
    office.type('j');
    await office.until('the cursor', () => /▌ count what is uncommitted/.test(office.screen()));
    office.type(' ');
    await office.until('the switch', () => office.settingsFile()?.git === false);

    // Long enough for several passes of the thing that was running it.
    const ran = office.gitCalls().length;
    await settle();
    await settle();
    assert.equal(office.gitCalls().length, ran, 'git was run after somebody said not to');

    // And the count is off the floor. It was true when it was read and nobody is reading
    // it again, so leaving it up is an office drawing a number it has stopped maintaining,
    // which is the one thing it cannot do.
    office.type('\x1b');
    await office.until('the card to close', () => office.at('kept in').y < 0);
    await office.until('the count to leave the floor', () => office.at('+3').y < 0);
  } finally {
    await office.stop();
  }
});

test('turning the head readings off stops the reads and takes the gauges down', async () => {
  // The companion to the git test, and the same argument: the switch is the one that
  // decides whether this pane looks at the screen of a desk nobody has their hand up at,
  // so it has to stop the reads, and the readings it already has have to come off the
  // floor rather than age in silence.
  const office = await openOffice({
    agents: [desk('w1:p1', 'working', 0)],
    // A status bar, which is the only line this is ever read off: a bare percentage
    // anywhere else is test coverage or a download. See "How full their head is".
    screenText: 'claude · context: 73% · main',
    cols: 140,
    rows: 46,
  });
  try {
    await office.ready('1 desk');
    office.type('z');
    await office.until('the gauge to reach the list', () => office.at('73%').y >= 0);

    office.type(',');
    await office.until('the card', () => office.onScreen('read how full each head is'));
    office.type('j');
    await office.until('the cursor', () => /▌ read how full each head is/.test(office.screen()));
    office.type(' ');
    await office.until('the switch', () => office.settingsFile()?.context === false);

    const read = office.sent('agent.read').length;
    office.type('\x1b');
    await office.until('the card to close', () => office.at('kept in').y < 0);
    await office.until('the gauge to leave the list', () => office.at('73%').y < 0);
    await settle();
    await settle();
    assert.equal(office.sent('agent.read').length, read, 'a desk was read after somebody said not to');
  } finally {
    await office.stop();
  }
});

test('a key meant for a switch cannot answer somebody else prompt', async () => {
  // The card takes the keyboard exclusively, which matters more here than in the hire menu:
  // a `y` falling through would approve a shell command at a desk nobody is looking at.
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0)],
    screenText: 'Allow this command? (y/n)',
  });
  try {
    await office.ready('1 desk');
    office.type(',');
    await office.until('the card', () => office.onScreen('hire a manager'));
    office.type('yYnsaA+Mmfz/rb');
    await settle();
    assert.deepEqual(office.sent('agent.send_keys'), [], 'a keystroke aimed at the card reached an agent');
    assert.deepEqual(office.sent('agent.prompt'), [], 'a keystroke aimed at the card prompted an agent');
    assert.deepEqual(office.sent('agent.start'), [], 'a keystroke aimed at the card hired somebody');
    // And it is still the card, because nothing in there closed it either.
    assert.ok(office.onScreen('hire a manager'));
    // A second comma is the way out, which is the one key that is allowed to do something.
    office.type(',');
    const before = office.screen().length;
    await office.until('the card to close', () => !office.screen().slice(before).includes('set the window title'));
  } finally {
    await office.stop();
  }
});

test('turning the window title off hands the window back', async () => {
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], args: ['--settings'] });
  try {
    await office.ready('1 desk');
    await office.until('the title', () => office.sent('client.window_title.set').length >= 1);
    assert.deepEqual(office.sent('client.window_title.clear'), [], 'the window was handed back before anybody asked');

    // Down to the last switch and off.
    for (const label of ['read how full each head is', 'count what is uncommitted', 'say when somebody needs you', 'draw the pixel charts', 'set the window title']) {
      office.type('j');
      await office.until(`the cursor on ${label}`, () => office.screen().includes(`▌ ${label}`));
    }
    office.type(' ');
    // The flip is already believed by the time the clear is sent, which is the whole reason
    // `clearTitle` takes a force: without it the last title the office set would sit on
    // somebody's window for the rest of the session.
    await office.until('the window to be handed back', () => office.sent('client.window_title.clear').length >= 1);

    const set = office.sent('client.window_title.set').length;
    await settle();
    assert.equal(office.sent('client.window_title.set').length, set, 'the title was set after somebody said not to');
    assert.deepEqual(office.settingsFile(), { title: false });
  } finally {
    await office.stop();
  }
});

test('turning the manager off lets the one you have go, and leaves their pane alone', async () => {
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    args: ['--board'],
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the hire', () => office.sent('agent.start').length >= 1);
    office.type(',');
    await office.until('the card', () => office.onScreen('hire a manager'));
    office.type(' ');
    await office.until('the file', () => office.settingsFile()?.manager === false);

    // Exactly what `X` does, for the same reason: the cost of a manager is the asking, and
    // the pane belongs to whoever is going to close it.
    assert.ok(office.onScreen('not the manager any more'), 'the office did not say the manager was let go');
    assert.deepEqual(office.sent('pane.close'), [], 'the office closed somebody pane');
    const started = office.sent('agent.start').length;
    await settle();
    assert.equal(office.sent('agent.start').length, started, 'another manager was hired after somebody said no');
  } finally {
    await office.stop();
  }
});

test('a switch can be clicked, and clicking one does not walk you off your desk', async () => {
  // The only mouse test in this file, and it is here rather than in switches.test.mjs
  // because what it is about is the wiring: `renderFrame` can be asked what the hitboxes
  // are, and whether a press on one of them reaches `flipSetting` is a question only a
  // running office can answer.
  const office = await openOffice({ agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'idle', 1)], args: ['--settings'] });
  try {
    await office.ready('2 desks');
    await office.until('the card', () => office.at('count what is uncommitted').y >= 0);

    // On the label itself, which is inside the row's hitbox and nowhere near the word that
    // says which way the switch is. The whole row is the target, and that is the point.
    const spot = office.at('count what is uncommitted');
    office.click(spot.x, spot.y);
    await office.until('the switch to have flipped', () => office.settingsFile()?.git === false);
    assert.deepEqual(office.settingsFile(), { git: false }, 'a click flipped something it was not aimed at');

    // And the floor behind the card is where it was. A switch is not a desk: selecting one
    // would leave the office pointed at a seat that does not exist, so the next `enter`
    // would open nothing at all.
    office.type('\x1b');
    await office.until('the card to close', () => office.at('count what is uncommitted').y < 0);
    office.type('\r');
    await office.until(
      'the desk to open',
      () => office.asked.some((a) => a.method === 'agent.read' && a.params?.source === 'recent_unwrapped'),
    );
    const read = office.asked.find((a) => a.method === 'agent.read' && a.params?.source === 'recent_unwrapped');
    assert.equal(read.params.target, 'w1:p1', 'the office opened a desk nobody had selected');
  } finally {
    await office.stop();
  }
});

test('turning the manager back on lets the next card open hire one', async () => {
  // The other half of the switch. Off is a manager let go; on is not a hire, because the
  // card being open is the manager's card being shut and there is nothing on screen to
  // hire into. What it does is give the run its one attempt back, and the proof is that
  // opening the manager's card afterwards starts somebody.
  const office = await openOffice({
    agents: [desk('w1:p1', 'idle', 0), desk('w1:p2', 'working', 1)],
    manifests: ['claude'],
    args: ['--board'],
    settings: { manager: false },
    cols: 140,
    rows: 46,
  });
  try {
    await office.until('the card', () => office.onScreen('nobody hired'));
    await settle();
    assert.deepEqual(office.sent('agent.start'), [], 'the saved setting did not stop the hire');

    office.type(',');
    await office.until('the switches', () => office.onScreen('hire a manager'));
    office.type(' ');
    await office.until('the file to forget it', () => office.settingsFile()?.manager === undefined);
    // Not yet. Nothing is hired from the card itself.
    await settle();
    assert.deepEqual(office.sent('agent.start'), [], 'the card hired somebody with its own panel on screen');

    // Back to the floor, then open the manager's card, which is the whole gate. Clicked
    // rather than walked to, because one press is one event and cannot be coalesced with
    // the keystroke before it the way two writes to stdin can.
    office.type('\x1b');
    await office.until('the floor', () => office.at('kept in').y < 0);
    const manager = office.at('THE MANAGER');
    assert.ok(manager.y >= 0, 'the manager desk is not on the floor');
    office.click(manager.x, manager.y);
    await office.until('the hire', () => office.sent('agent.start').length >= 1);
  } finally {
    await office.stop();
  }
});

test('an office told not to touch the window title never sets one', async () => {
  // Not the same claim as the one above it. That test is about a flip taking the title
  // back; this is about the gate on the way out, and without it an office started with
  // the switch off would still stamp its count on somebody's window.
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], settings: { title: false } });
  try {
    await office.ready('1 desk');
    await settle();
    assert.deepEqual(office.sent('client.window_title.set'), [], 'the title was set by an office told not to');
    // And nothing to hand back either, because nothing was ever taken.
    assert.deepEqual(office.sent('client.window_title.clear'), []);
  } finally {
    await office.stop();
  }
});
