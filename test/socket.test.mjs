// The wire. Every call the office makes goes through ApiClient, and until this
// file existed nothing tested it: the class was written against a description of
// how the herdr socket behaves, and that description was wrong in three places at
// once. What was actually measured against herdr 0.9.0 on 2026-09-17 is simpler
// and stranger than what the comments said:
//
//   the server answers exactly ONE request per connection and then closes it,
//   whether or not anything was concurrent.
//
// A second request written to the same socket gets EPIPE. That single fact was
// previously read as three separate hazards (recent-source reads dropping the
// connection, agent.explain doing the same, and a two-concurrent-request limit),
// because each one was noticed in a different place.
//
// So the tests below hold ApiClient to working over a server that behaves that
// way, and over one that does not, since the office cannot tell which it has and
// must not care.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiClient, EventStream } from '../src/socket.mjs';

// A herdr-shaped server whose manners are a parameter. `answer` decides what to
// send back for a request, and `closeAfter` how many answers a connection gets
// before it hangs up: 1 is what the real server does.
//
// It records which connection each request arrived on, because that is the only
// way to tell single-file requests from pipelined ones from the outside.
async function fakeHerdr({ answer, closeAfter = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-'));
  const sockPath = path.join(dir, 's');
  const seen = [];
  let conns = 0;

  const server = net.createServer((sock) => {
    const conn = ++conns;
    let served = 0;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        seen.push({ conn, method: req.method, id: req.id });
        const reply = answer(req, { conn, served });
        if (reply !== null) sock.write(`${JSON.stringify(reply)}\n`);
        served += 1;
        if (closeAfter && served >= closeAfter) {
          sock.end();
          return;
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(sockPath, resolve));
  const prev = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sockPath;

  return {
    seen,
    get connections() {
      return conns;
    },
    stop() {
      if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = prev;
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ok = (req) => ({ id: req.id, result: { method: req.method } });

test('a server that closes after every answer still serves every call', async () => {
  // The measured behaviour of herdr 0.9.0, and the reason ApiClient reconnects
  // rather than holding one socket open. Four calls, four connections, four
  // answers: the reconnect is not a recovery path here, it is the normal path.
  const server = await fakeHerdr({ answer: ok, closeAfter: 1 });
  try {
    const api = await new ApiClient().open();
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(await api.request('tab.list'), { method: 'tab.list' }, `call ${i} did not come back`);
    }
    api.close();
    assert.equal(server.seen.length, 4, 'the server should have seen all four');
    assert.ok(server.connections >= 4, `one connection per call, saw ${server.connections}`);
  } finally {
    server.stop();
  }
});

test('callers can fire concurrently and the wire stays single file', async () => {
  // The queue's whole job. Against a one-answer-per-connection server, two
  // requests written to the same socket means the second gets EPIPE and is lost
  // silently, which is what a bare Promise.all used to do. Every request must
  // arrive on a connection of its own, in the order it was asked for.
  const server = await fakeHerdr({ answer: ok, closeAfter: 1 });
  try {
    const api = await new ApiClient().open();
    const results = await Promise.all([
      api.request('tab.list'),
      api.request('agent.list'),
      api.request('session.snapshot'),
      api.request('pane.read'),
    ]);
    api.close();
    assert.deepEqual(
      results.map((r) => r.method),
      ['tab.list', 'agent.list', 'session.snapshot', 'pane.read'],
      'a concurrent caller lost a result',
    );
    assert.deepEqual(
      server.seen.map((s) => s.method),
      ['tab.list', 'agent.list', 'session.snapshot', 'pane.read'],
      'requests reached the server out of order',
    );
    // The point: no connection ever carried two requests.
    const perConn = new Map();
    for (const s of server.seen) perConn.set(s.conn, (perConn.get(s.conn) || 0) + 1);
    assert.deepEqual([...new Set(perConn.values())], [1], `a connection carried more than one request: ${JSON.stringify([...perConn])}`);
  } finally {
    server.stop();
  }
});

test('a server that keeps its connection open is served just as well', async () => {
  // The office must not depend on the close either way. A server that would
  // happily take a second request still never gets one, because guessing which
  // kind of server is on the other end is how the old duplicate got written.
  const server = await fakeHerdr({ answer: ok, closeAfter: 0 });
  try {
    const api = await new ApiClient().open();
    const out = await Promise.all([api.request('tab.list'), api.request('agent.list'), api.request('tab.list')]);
    api.close();
    assert.equal(out.length, 3);
    assert.equal(server.seen.length, 3, 'every call has to arrive exactly once');
    assert.ok(server.connections >= 3, 'a request is never written to a socket that has already been used');
  } finally {
    server.stop();
  }
});

test('an error response rejects with the code herdr gave it', async () => {
  // The code is what the office draws on a desk it could not read, so it has to
  // survive the trip: `agent_not_idle` on the card is a different message from a
  // generic failure.
  const server = await fakeHerdr({
    answer: (req) => ({ id: req.id, error: { code: 'agent_not_idle', message: 'agent is mid-turn' } }),
  });
  try {
    const api = await new ApiClient().open();
    await assert.rejects(() => api.request('agent.read'), (err) => {
      assert.equal(err.code, 'agent_not_idle');
      assert.equal(err.message, 'agent is mid-turn');
      return true;
    });
    api.close();
  } finally {
    server.stop();
  }
});

test('a request is delivered once, even when the answer never comes', async () => {
  // The load-bearing test in this file, and the one that would have caught the
  // duplicate. A request that has reached the server may have been acted on, so
  // a dropped connection is reported, never retried: `agent.send_keys` and
  // `agent.prompt` go down this path, and a second delivery is a second
  // keystroke into somebody's real agent.
  const server = await fakeHerdr({ answer: () => null, closeAfter: 1 });
  try {
    const api = await new ApiClient().open();
    await assert.rejects(() => api.request('agent.send_keys'), /herdr socket closed/);
    assert.equal(server.seen.length, 1, `sent ${server.seen.length} times, which for send_keys is that many keystrokes`);
    api.close();
  } finally {
    server.stop();
  }
});

test('one failed call does not block the calls behind it', async () => {
  // The queue chains every request onto the last one, so a rejection that broke
  // the chain would wedge the office permanently: no desk would ever refresh
  // again. Worth its own test because the guard is a bare catch that is easy to
  // drop in a rewrite.
  const server = await fakeHerdr({
    answer: (req) => (req.method === 'boom' ? { id: req.id, error: { code: 'nope', message: 'no' } } : ok(req)),
  });
  try {
    const api = await new ApiClient().open();
    const [bad, good] = await Promise.allSettled([api.request('boom'), api.request('tab.list')]);
    assert.equal(bad.status, 'rejected');
    assert.equal(good.status, 'fulfilled', 'the call behind a failure never went out');
    api.close();
  } finally {
    server.stop();
  }
});

test('a server that never answers times out with a code the office can show', async () => {
  const server = await fakeHerdr({ answer: () => null, closeAfter: 0 });
  try {
    const api = await new ApiClient().open();
    await assert.rejects(() => api.request('tab.list', {}, 120), (err) => {
      assert.equal(err.code, 'timeout');
      assert.match(err.message, /tab\.list/, 'the message has to name the call that hung');
      return true;
    });
    api.close();
  } finally {
    server.stop();
  }
});

test('the event stream swallows the ack and pushes everything after it', async () => {
  // The first line back is the answer to events.subscribe and is not an event.
  // Delivering it as one puts a line with no `event` name through the decoder,
  // and the office would treat the subscription itself as news.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-ev-'));
  const sockPath = path.join(dir, 's');
  const prev = process.env.HERDR_SOCKET_PATH;
  let subscribed = null;
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (line) => {
      subscribed = JSON.parse(line.trim()).params.subscriptions;
      sock.write(`${JSON.stringify({ id: 'office-events', result: { subscribed: subscribed.length } })}\n`);
      sock.write(`${JSON.stringify({ event: 'pane.output_matched', data: { pane_id: 'w1:p1' } })}\n`);
      sock.write(`${JSON.stringify({ event: 'agent_status_changed', data: { pane_id: 'w1:p2' } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  process.env.HERDR_SOCKET_PATH = sockPath;
  try {
    const got = [];
    const stream = await new EventStream().open(
      ['agent_status_changed', { type: 'pane.output_matched', pane_id: 'w1:p1' }],
      (msg) => got.push(msg),
      () => {},
    );
    // Give the two pushed lines a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 120));
    stream.close();
    assert.deepEqual(
      got.map((m) => m.event),
      ['pane.output_matched', 'agent_status_changed'],
      `the ack leaked into the events, or an event went missing: ${JSON.stringify(got)}`,
    );
    // A bare string subscription is sent as a descriptor, because that is the
    // only form the server accepts, and one bad entry rejects the whole batch.
    assert.deepEqual(subscribed[0], { type: 'agent_status_changed' });
    assert.deepEqual(subscribed[1], { type: 'pane.output_matched', pane_id: 'w1:p1' });
  } finally {
    if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prev;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected subscription is reported instead of looking like silence', async () => {
  // One invalid entry rejects the whole events.subscribe, and the stream then
  // sits there forever saying nothing. The office needs to hear about that, or
  // the news feature looks like it simply does not work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-office-ev2-'));
  const sockPath = path.join(dir, 's');
  const prev = process.env.HERDR_SOCKET_PATH;
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', () => {
      sock.write(`${JSON.stringify({ id: 'office-events', error: { code: 'bad_subscription', message: 'unknown event' } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  process.env.HERDR_SOCKET_PATH = sockPath;
  try {
    const errors = [];
    const events = [];
    const stream = await new EventStream().open(['not_a_real_event'], (m) => events.push(m), (err) => errors.push(err.message));
    await new Promise((resolve) => setTimeout(resolve, 120));
    stream.close();
    assert.deepEqual(events, [], 'a rejection is not an event');
    assert.ok(errors.some((m) => /unknown event/.test(m)), `the rejection was not reported: ${JSON.stringify(errors)}`);
  } finally {
    if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prev;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
