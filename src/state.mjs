// The one thing the office remembers between runs.
//
// herdr hands every plugin a `HERDR_PLUGIN_STATE_DIR` and until now the office
// ignored it, which made the whiteboard quietly dishonest: it is the only part of
// the office that says what *happened* rather than what is happening, and it forgot
// the entire morning every time the pane was reopened. "open since 11:20" after a
// restart is not a smaller true number, it is a wrong one.
//
// Three rules, and they are the same three the graphics layer runs on, for the same
// reason: this is a convenience on top of a working office, so it does not get to
// break one.
//
// 1. **A day, not forever.** The file carries the local date it was written on and a
//    file from another day is discarded rather than added to. src/punchclock.mjs
//    says a "today" that spanned midnight would be a worse lie than a small true
//    number, and it is right. Reopening the pane at 11:20 continues this morning;
//    opening it tomorrow starts tomorrow.
// 2. **Never invent time the office did not watch.** The gap between quitting and
//    reopening is not counted as anything. See `Clocks.restore`.
// 3. **A broken state file is no state file.** Every read and write is wrapped, a
//    file that will not parse is thrown away, and an office with no state dir simply
//    does not persist. There is no failure mode here that is allowed to be visible.
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Bumped when the shape below changes incompatibly, which throws away one morning's
// numbers rather than reading last version's fields as this version's.
const VERSION = 1;
const FILE = 'punchclock.json';

// The local date, which is the only sensible boundary for "today" in a tool that
// sits in front of somebody working a day. Deliberately not UTC: an office in
// Sydney would roll over mid-afternoon.
export function today(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Null when there is nowhere to write, which is the ordinary case for an office run
// by hand outside herdr. Callers treat that as "do not persist" rather than as an
// error, so nothing has to branch on it twice.
export function stateFile(dir = process.env.HERDR_PLUGIN_STATE_DIR) {
  return dir ? join(dir, FILE) : null;
}

// Whatever was written today, or null. Null covers every failure: no state dir, no
// file, unreadable file, unparseable file, a file from another day, a file from
// another version. All of those mean the same thing to the caller, which is that
// this is a fresh morning.
export function load(now = Date.now(), file = stateFile()) {
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.version !== VERSION) return null;
    // The day check is the whole reason the date is stored. An office left open over
    // midnight is a separate problem and belongs to whoever is reading the numbers;
    // an office *reopened* the next day must not add today to yesterday.
    if (raw?.day !== today(now)) return null;
    return raw;
  } catch {
    // A file the office cannot read is a file the office does not have.
    return null;
  }
}

// Returns true when it actually wrote, so a caller can tell "no state dir" from
// "wrote it" without inspecting the environment itself.
//
// Written to a temporary name and renamed, because the office writes this on a timer
// and on the way out, and a half-written JSON file is exactly what you would get by
// quitting during the write. Rename is atomic on both platforms this ships to, so a
// reader either sees the whole previous file or the whole new one.
export function save(payload, now = Date.now(), file = stateFile()) {
  if (!file) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: VERSION, day: today(now), savedAt: now, ...payload }));
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      // Leaving a .tmp behind on every failed write would fill the state dir with
      // them, and the office is never told about any of this.
      unlinkSync(tmp);
    } catch {
      // Nothing left to try, and nothing worth saying.
    }
    return false;
  }
}
