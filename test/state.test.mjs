// The state file. There is exactly one thing on disk in this whole program, so what
// matters here is not that it round-trips (it is JSON, it round-trips) but that every
// way it can go wrong comes out as "no state", because the caller has no other branch:
// a punch clock that starts at zero is correct, and one that throws on boot takes the
// office with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, save, stateFile, today } from '../src/state.mjs';

const scratch = () => join(mkdtempSync(join(tmpdir(), 'herdr-office-state-')), 'punchclock.json');

const DAY = 86400e3;

test('what goes in comes back out, on the same day', () => {
  const file = scratch();
  const now = Date.parse('2026-09-17T11:20:00');
  assert.equal(save({ opened: 12345, answers: 3 }, now, file), true);
  const back = load(now + 60e3, file);
  assert.equal(back.opened, 12345);
  assert.equal(back.answers, 3);
  assert.equal(back.savedAt, now, 'when it was written, which the punch clock needs');
});

test('yesterday is not this morning', () => {
  // The rule the whole file exists to enforce. Opening the office on Thursday must
  // not add Thursday to Wednesday, and the alternative to a date stamp is a "today"
  // that silently means "since some point in the past week".
  const file = scratch();
  const now = Date.parse('2026-09-17T23:50:00');
  save({ opened: 1 }, now, file);
  assert.ok(load(now, file), 'still Thursday');
  assert.equal(load(now + DAY, file), null, 'Friday starts empty');
  assert.equal(load(now + 20 * 60e3, file), null, 'and so does twenty minutes later, past midnight');
});

test('a state file from another version is not read as this one', () => {
  const file = scratch();
  writeFileSync(file, JSON.stringify({ version: 99, day: today(), opened: 1 }));
  assert.equal(load(Date.now(), file), null);
});

test('every way the file can be wrong comes out as no file', () => {
  const file = scratch();
  // Never written.
  assert.equal(load(Date.now(), file), null);
  for (const junk of ['', 'not json', '{', 'null', '[]', '"a string"', '{"version":1}']) {
    writeFileSync(file, junk);
    assert.equal(load(Date.now(), file), null, `junk: ${JSON.stringify(junk)}`);
  }
  // A directory where the file should be, which is the shape of somebody else's
  // mistake rather than of ours.
  const dir = join(mkdtempSync(join(tmpdir(), 'herdr-office-state-')), 'punchclock.json');
  mkdirSync(dir);
  assert.equal(load(Date.now(), dir), null);
});

test('no state dir means no persistence, not an error', () => {
  // The ordinary case for an office run by hand outside herdr. Both halves have to
  // agree about it, or boot reads nothing and quit throws.
  assert.equal(stateFile(undefined), null);
  assert.equal(stateFile(''), null);
  assert.equal(load(Date.now(), null), null);
  assert.equal(save({ opened: 1 }, Date.now(), null), false);
});

test('a write that cannot happen is false, not a crash', () => {
  // An unwritable state dir is a real thing: a read-only home, a full disk, a
  // directory herdr made for a different user. The office is mid-quit when this
  // happens and has a terminal to hand back.
  const dir = mkdtempSync(join(tmpdir(), 'herdr-office-state-'));
  const file = join(dir, 'punchclock.json');
  chmodSync(dir, 0o500);
  try {
    assert.equal(save({ opened: 1 }, Date.now(), file), false);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('a failed write leaves no rubbish behind', () => {
  // The temp file is the price of the atomic rename, and the office writes every
  // fifteen seconds for as long as it is open. A .tmp left behind per failure would
  // turn one unwritable moment into a directory full of them.
  const dir = mkdtempSync(join(tmpdir(), 'herdr-office-state-'));
  const file = join(dir, 'sub', 'punchclock.json');
  mkdirSync(join(dir, 'sub'));
  chmodSync(join(dir, 'sub'), 0o500);
  try {
    assert.equal(save({ opened: 1 }, Date.now(), file), false);
  } finally {
    chmodSync(join(dir, 'sub'), 0o700);
  }
  assert.deepEqual(readdirSync(join(dir, 'sub')), []);
});

test('a rewrite replaces the file rather than appending to it', () => {
  const file = scratch();
  const now = Date.now();
  save({ opened: 1, answers: 9 }, now, file);
  save({ opened: 2 }, now, file);
  const raw = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw).opened, 2);
  assert.equal(JSON.parse(raw).answers, undefined, 'the old fields are gone, not merged');
  // And the rename left nothing beside it.
  assert.deepEqual(
    readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('the day stamp is local, because a working day is', () => {
  // Not UTC. An office in Sydney would roll its "today" over in the middle of the
  // afternoon, which is the one time of day it is most obviously wrong.
  const noon = new Date(2026, 8, 17, 12, 0, 0);
  assert.equal(today(noon.getTime()), '2026-09-17');
  assert.equal(today(new Date(2026, 0, 1, 0, 5, 0).getTime()), '2026-01-01');
  assert.equal(today(new Date(2026, 11, 31, 23, 55, 0).getTime()), '2026-12-31');
});
