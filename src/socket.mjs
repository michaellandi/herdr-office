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

// Request/response connection. Keep this one separate from the event stream:
// events.subscribe holds its connection open and pushes unsolicited lines.
//
// The connection reconnects itself: some reads (recent-source reads against a
// busy full-screen agent) make the server hang up mid-response, and one bad
// desk should not take the whole office down.
//
// Requests go out one at a time. On herdr 0.9.0 the server tolerates two
// in-flight requests on a connection and hangs up on the third, so a
// Promise.all of three calls silently loses the last one: the symptom is a
// field that is simply always empty. Queueing here costs a round trip per call
// and makes every caller safe, rather than asking each one to remember.
export class ApiClient {
  #sock = null;
  #pending = new Map();
  #seq = 0;
  #connecting = null;
  #tail = Promise.resolve();

  async open() {
    await this.#ensure();
    return this;
  }

  #ensure() {
    if (this.#sock) return Promise.resolve(this.#sock);
    if (this.#connecting) return this.#connecting;
    this.#connecting = openSocket({
      onLine: (msg) => this.#dispatch(msg),
      onClose: () => {
        this.#sock = null;
        this.#failAll(Object.assign(new Error('herdr socket closed'), { retryable: true }));
      },
    })
      .then((sock) => {
        this.#sock = sock;
        this.#connecting = null;
        return sock;
      })
      .catch((err) => {
        this.#connecting = null;
        throw err;
      });
    return this.#connecting;
  }

  #dispatch(msg) {
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const err = new Error(msg.error.message || 'herdr api error');
      err.code = msg.error.code;
      entry.reject(err);
    } else {
      entry.resolve(msg.result ?? {});
    }
  }

  #failAll(err) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }

  request(method, params = {}, timeoutMs = 8000) {
    // Chain onto the tail so callers can fire whatever they like concurrently
    // and still reach the server in single file. A failed request must not
    // break the chain, hence the bare catch on the link we hand to the next
    // caller.
    const result = this.#tail.then(() => this.#attempt(method, params, timeoutMs));
    this.#tail = result.catch(() => {});
    return result;
  }

  async #attempt(method, params, timeoutMs) {
    try {
      return await this.#send(method, params, timeoutMs);
    } catch (err) {
      if (!err.retryable) throw err;
      return this.#send(method, params, timeoutMs);
    }
  }

  async #send(method, params, timeoutMs) {
    const sock = await this.#ensure();
    const id = `office-${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const err = new Error(`timeout waiting for ${method}`);
        err.code = 'timeout';
        reject(err);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    this.#sock?.destroy();
    this.#sock = null;
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
