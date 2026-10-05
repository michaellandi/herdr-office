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
async function openOffice({ agents, cols = 110, rows = 32, args = [], screenText = 'all done here', worktrees = null, git = null, book = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-run-'));
  const sockPath = path.join(dir, 's');
  const gitLog = path.join(dir, 'git-calls');
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
      // A function when a test needs the screen to change under the office, which is
      // the one thing a fixed string cannot do and is exactly the hazard a cursor menu
      // has: its keys are a walk from where the cursor was when we last looked.
      'agent.read': { read: { text: typeof screenText === 'function' ? screenText() : screenText } },
      // Off by default: without it every desk has a cwd and no repository, which is
      // what most of these tests want. With it, the office knows the directory is a
      // checkout, which is the gate on running git in it at all.
      'worktree.list': worktrees ?? {},
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

  // An office that is opening for the second time today, with a real state file written
  // by a real earlier run. Seeded through the same file the office writes rather than
  // through an injected object, because every other part of this is the real thing: the
  // point of a test at this level is that the wiring from the file to the floor works,
  // and that is exactly the part a unit test cannot see.
  if (book) {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const d = new Date(book.savedAt);
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
    // Every argument list the office handed to git, in order.
    gitCalls: () => (fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    type: (keys) => child.stdin.write(keys),
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

// A menu with no numbers on it, the shape a full-screen agent TUI draws: a cursor on the
// row enter would take, siblings lined up under it, a rule and a footer saying which keys
// move. Hand-written, so it is about the shape rather than about anybody's terminal.
const cursorMenuAt = (row) =>
  ['  Tool: write_file requires approval', '', '  write_file  src/app.js', '']
    .concat(['Allow', 'Always allow', 'Deny', 'Always deny'].map((label, i) => (i === row ? `  ❯ ${label}` : `    ${label}`)))
    .concat([`  ${'─'.repeat(28)}`, '  esc to close · ↑↓ to navigate · ↵ to select · Tab to edit'])
    .join('\n');

test('a cursor menu is answered by walking the cursor, not by guessing a letter', async () => {
  // The whole reason n stopped working against a full-screen agent: there is no letter
  // and no digit on this menu, and esc is what its own footer calls close, so the office
  // used to cancel the prompt under a key labelled deny.
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], screenText: cursorMenuAt(0) });
  try {
    await office.ready('NEEDS YOU');
    office.type('n');
    await office.until('the keystroke', () => office.sent('agent.send_keys').length >= 1);
    await settle();

    const keys = office.sent('agent.send_keys');
    assert.equal(keys.length, 1, `sent ${keys.length} keystrokes, which is ${keys.length} answers to a prompt`);
    assert.deepEqual(keys[0].params.keys, ['down', 'down', 'enter'], 'deny was not the walk onto Deny');
    // Past Always allow and stopping on Deny. Landing one row short is a standing grant.
    assert.notDeepEqual(keys[0].params.keys, ['down', 'enter']);
  } finally {
    await office.stop();
  }
});

test('a cursor that moved since the last read is recounted, not replayed', async () => {
  // These keys are a walk from where the cursor was sitting when the screen was read,
  // and that was a poll ago on a screen the office does not own. So the walk is worked
  // out again off a read taken at the moment of sending.
  let row = 0;
  const office = await openOffice({ agents: [desk('w1:p1', 'blocked', 0)], screenText: () => cursorMenuAt(row) });
  try {
    await office.ready('NEEDS YOU');
    const readsAtKeypress = office.sent('agent.read').length;
    row = 2; // somebody at the pane pressed down twice
    office.type('y');
    await office.until('the keystroke', () => office.sent('agent.send_keys').length >= 1);
    await settle();

    const keys = office.sent('agent.send_keys');
    assert.deepEqual(keys[0].params.keys, ['up', 'up', 'enter'], 'the walk was replayed from a stale cursor');
    // And it was a fresh read it was counted from: there is one between the keypress and
    // the keys going out, rather than the office trusting the one it already had.
    const sendAt = office.asked.findIndex((a) => a.method === 'agent.send_keys');
    const readsBeforeSend = office.asked.slice(0, sendAt).filter((a) => a.method === 'agent.read').length;
    assert.ok(readsBeforeSend > readsAtKeypress, 'nothing was re-read before the keys went out');
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

test('B briefs the manager once, after an enter, and esc sends nothing', async () => {
  // Pinned by id, since this fake herdr has one tab and it is not called office-manager.
  const office = await openOffice({
    agents: [desk('w1:p1', 'blocked', 0), desk('w1:p2', 'working', 1), desk('w1:p3', 'idle', 2)],
    args: ['--manager=w1:p3'],
    screenText: 'Do you want me to apply the patch? (y/n)',
  });
  try {
    await office.ready('Manager');
    office.type('B');
    await office.until('the confirm', () => office.onScreen('enter sends the whole office brief'));
    office.type('\x1b');
    await settle();
    assert.deepEqual(office.sent('agent.prompt'), [], 'esc on a brief sent it anyway');

    office.type('B');
    await office.until('the confirm again', () => office.onScreen('brief · Manager'));
    office.type('\r');
    await office.until('the brief', () => office.sent('agent.prompt').length >= 1);
    await settle();
    const prompts = office.sent('agent.prompt');
    assert.equal(prompts.length, 1, 'the brief went more than once');
    assert.equal(prompts[0].params.target, 'w1:p3', 'the brief went to somebody other than the manager');
    const text = prompts[0].params.text;
    assert.ok(text.includes('office manager') && text.includes('1 needs you'), text);
    // One line on the wire, and nothing read off the stuck desk's screen.
    assert.ok(!text.includes('\n'), 'the brief went out as more than one line');
    assert.ok(!text.includes('apply the patch'), 'an ask went into the brief');
    assert.deepEqual(office.sent('agent.send_keys'), [], 'a brief typed keys at somebody');
  } finally {
    await office.stop();
  }
});

test('a hired manager does not take the notices key away from m', async () => {
  // The guard for a bug that merged without a conflict. Two features arrived separately
  // and both wanted `m`: one to walk what the office has noticed, one to brief the
  // manager. Each tested its own key on a floor the other feature was absent from, so
  // both suites passed while the first handler in onInput silently won and the other key
  // became dead code.
  //
  // Asserted on the brief panel rather than on the notice counter, because the counter
  // only renders once there are two notices and it shares the footer slot with any
  // message, so keying the test to it would make it fail for reasons that are not this
  // bug. Under the bug `m` opens the brief, which is unambiguous.
  const office = await openOffice({
    agents: [desk('w1:p1', 'working', 0), desk('w1:p2', 'working', 1), desk('w1:p3', 'idle', 2)],
    args: ['--manager=w1:p3'],
    screenText: 'Working on it\n  Opus | Context: 94% | session: 19h 03m',
    cols: 200,
  });
  try {
    await office.ready('Manager');
    office.type('m');
    await settle();
    assert.ok(!office.onScreen('enter sends the whole office brief'), 'm opened the brief');
    assert.deepEqual(office.sent('agent.prompt'), [], 'm briefed the manager');
    // And the key the brief did move to still works, so this is a rebind and not a
    // feature quietly dropped to resolve the clash.
    office.type('B');
    await office.until('the brief', () => office.onScreen('enter sends the whole office brief'));
  } finally {
    await office.stop();
  }
});
