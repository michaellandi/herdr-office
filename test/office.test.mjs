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
async function openOffice({ agents, cols = 110, rows = 32, args = [], screenText = 'all done here' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-run-'));
  const sockPath = path.join(dir, 's');
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
