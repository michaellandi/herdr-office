// Newline-delimited JSON client for the Herdr socket API.
// Transport: one JSON request per line over a unix socket (named pipe on Windows).
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function resolveSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = path.join(os.homedir(), '.config', 'herdr');
  const session = process.env.HERDR_SESSION;
  return session
    ? path.join(base, 'sessions', session, 'herdr.sock')
    : path.join(base, 'herdr.sock');
}

function openSocket({ onLine, onClose, onError }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(resolveSocketPath());
    let buf = '';
    let settled = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          onLine(JSON.parse(line));
        } catch (err) {
          onError?.(err);
        }
      }
    });
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      onError?.(err);
    });
    sock.on('close', () => onClose?.());
    sock.once('connect', () => {
      settled = true;
      resolve(sock);
    });
  });
}

// Request/response calls. Keep this separate from the event stream: only
// events.subscribe holds a connection open and pushes unsolicited lines.
//
// One connection per request, because that is what the server does. Measured
// against herdr 0.9.0 on 2026-09-17: it answers exactly one request and then
// closes the connection, whether or not anything was concurrent. A second
// request written to the same socket gets EPIPE, even when written in the same
// tick as the first reply arriving.
//
// This one fact used to be written down here as three different hazards (reads
// with a `recent` source dropping the connection, agent.explain doing the same,
// and a limit of two concurrent requests), because it was met three times in
// three places and diagnosed freshly each time. None of the three reproduce:
// every read source answers fine against a busy full-screen agent, and so does
// explain. The connection simply never survives an answer.
//
// The previous shape here held one socket open and reconnected when it dropped,
// which worked, but a request issued before that drop had been noticed went into
// the socket the server had already closed, and only then got retried on a fresh
// one. So calls issued back to back went out twice: a sequential loop of awaits,
// each call leaving the moment the previous answer landed, which is exactly what
// a broadcast and the hire sequence are. A call after any idle gap was fine,
// which is why pressing a key was never affected and this went unnoticed. On this
// build the duplicate is refused by the kernel and never reaches herdr, but that
// is luck about the timing of a reset: `agent.send_keys` and `agent.prompt` are on
// this path, and a duplicate that did land is two keystrokes, or the same
// instruction typed at somebody's agent twice. Opening a connection per request
// costs the same round trip and cannot do that.
//
// Requests still go out single file, so callers can fire whatever they like
// concurrently without opening a socket per caller or reordering the wire.
export class ApiClient {
  #seq = 0;
  #tail = Promise.resolve();
  #live = new Set();

  // Nothing to hold open, but the caller wants to hear about a missing socket
  // now rather than on the first desk it tries to draw, so make the connection
  // and drop it. A bare connect assumes no method, which is the point: it
  // answers "is herdr there", not "does herdr still speak this protocol".
  async open() {
    const sock = await openSocket({ onLine: () => {} });
    sock.destroy();
    return this;
  }

  request(method, params = {}, timeoutMs = 8000) {
    // Chain onto the tail so callers can fire whatever they like concurrently
    // and still reach the server in single file. A failed request must not
    // break the chain, hence the bare catch on the link we hand to the next
    // caller: without it, one failed read would wedge every later call and the
    // office would quietly stop refreshing.
    const result = this.#tail.then(() => this.#send(method, params, timeoutMs));
    this.#tail = result.catch(() => {});
    return result;
  }

  // One socket, one request, one answer, then done. No retry: a request that has
  // been written may have been acted on, and sending it again is exactly the
  // duplicate this class exists to avoid. A read that fails is redrawn by the
  // next poll; a write that fails says so on screen.
  #send(method, params, timeoutMs) {
    const id = `office-${++this.#seq}`;
    return new Promise((resolve, reject) => {
      let sock = null;
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sock) {
          this.#live.delete(sock);
          sock.destroy();
        }
        fn(arg);
      };
      const timer = setTimeout(() => {
        const err = new Error(`timeout waiting for ${method}`);
        err.code = 'timeout';
        done(reject, err);
      }, timeoutMs);

      openSocket({
        onLine: (msg) => {
          if (msg.error) {
            const err = new Error(msg.error.message || 'herdr api error');
            err.code = msg.error.code;
            done(reject, err);
            return;
          }
          done(resolve, msg.result ?? {});
        },
        onClose: () => done(reject, new Error('herdr socket closed before it answered')),
        onError: (err) => done(reject, err),
      })
        .then((opened) => {
          if (settled) {
            opened.destroy();
            return;
          }
          sock = opened;
          this.#live.add(sock);
          sock.write(`${JSON.stringify({ id, method, params })}\n`);
        })
        .catch((err) => done(reject, err));
    });
  }

  close() {
    for (const sock of this.#live) sock.destroy();
    this.#live.clear();
  }
}

// Long-lived subscription connection. The first line back is the ack; every
// line after it is a pushed event.
export class EventStream {
  #sock = null;

  // `subs` entries are either an event-name string (for the global events) or a
  // full descriptor object such as { type, pane_id } for per-pane events.
  async open(subs, onEvent, onError) {
    let acked = false;
    this.#sock = await openSocket({
      onLine: (msg) => {
        if (!acked) {
          acked = true;
          if (msg.error) onError?.(new Error(msg.error.message));
          return;
        }
        onEvent(msg);
      },
      onClose: () => onError?.(new Error('event stream closed')),
      onError,
    });
    const subscriptions = subs.map((s) => (typeof s === 'string' ? { type: s } : s));
    this.#sock.write(
      `${JSON.stringify({ id: 'office-events', method: 'events.subscribe', params: { subscriptions } })}\n`,
    );
    return this;
  }

  close() {
    this.#sock?.destroy();
    this.#sock = null;
  }
}
