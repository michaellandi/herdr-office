// The settings file and the three rules above it (see src/settings.mjs). Two of those
// rules are the whole reason this module exists rather than a `JSON.parse` at the top of
// office.mjs, and both are invisible until something asserts them: that a flag can only
// ever turn a thing off, and that what lands on disk is the list of places you disagreed
// with the office rather than a snapshot of all six.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS, defaults, configFile, shortPath, load, save, settle, toggle, setting } from '../src/settings.mjs';

const scratch = () => join(mkdtempSync(join(tmpdir(), 'herdr-office-settings-')), 'settings.json');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('every setting is a key, a label, an opt-out flag and a sentence about what it costs', () => {
  assert.ok(SETTINGS.length >= 1);
  for (const s of SETTINGS) {
    assert.match(s.key, /^[a-z]+$/, `${s.key} is not a plain key`);
    assert.ok(s.label && s.label.length <= 30, `${s.label} will not fit a switch row`);
    // Every one of them is a `--no-` or a `--quiet`, never a `--with-`. That is rule one,
    // and it is what makes the precedence in `settle` a single downward move.
    assert.match(s.flag, /^--(no-|quiet)/, `${s.flag} is a flag that turns something on`);
    assert.ok(s.help && s.help.length > 40, `${s.key} has no sentence about what it costs`);
    assert.equal(setting(s.key), s, 'a setting cannot be looked up by its own key');
  }
  assert.equal(new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length, 'two settings share a key');
  assert.equal(new Set(SETTINGS.map((s) => s.flag)).size, SETTINGS.length, 'two settings share a flag');
  assert.equal(setting('nothing-like-this'), null);
});

test('the office ships with all of them on', () => {
  const d = defaults();
  for (const s of SETTINGS) assert.equal(d[s.key], true, `${s.key} ships off`);
  // A fresh object every time, because the caller mutates what it gets.
  assert.notEqual(defaults(), defaults());
});

test('the file is somewhere a person would look, and somewhere a test can point at', () => {
  assert.equal(configFile({ HERDR_OFFICE_CONFIG: '/tmp/x.json' }), '/tmp/x.json', 'the explicit path lost');
  assert.equal(configFile({ XDG_CONFIG_HOME: '/cfg' }), '/cfg/herdr-office/settings.json');
  assert.equal(configFile({}), join(homedir(), '.config', 'herdr-office', 'settings.json'));
  // The explicit path wins over XDG, because it is the more specific of the two.
  assert.equal(configFile({ HERDR_OFFICE_CONFIG: '/a.json', XDG_CONFIG_HOME: '/cfg' }), '/a.json');
});

test('the path on the card is short, and is not a different path', () => {
  assert.equal(shortPath('/Users/sam/.config/x.json', '/Users/sam'), '~/.config/x.json');
  assert.equal(shortPath('/Users/sam', '/Users/sam'), '~');
  assert.equal(shortPath('/etc/x.json', '/Users/sam'), '/etc/x.json');
  // The one that matters: a prefix match without the separator would turn somebody else's
  // home into `~my/x.json`, which is a wrong path that looks like a right one.
  assert.equal(shortPath('/Users/sammy/x.json', '/Users/sam'), '/Users/sammy/x.json');
  assert.equal(shortPath('', '/Users/sam'), '');
  assert.equal(shortPath(null, '/Users/sam'), '');
});

test('a file that is not there is not an error', () => {
  assert.equal(load(join(tmpdir(), 'herdr-office-nothing-here', 'settings.json')), null);
});

test('every way the file can be wrong comes out as no opinion recorded', () => {
  const file = scratch();
  for (const junk of ['', 'not json', 'null', '[]', '"manager"', '42']) {
    writeFileSync(file, junk);
    assert.equal(load(file), null, `${JSON.stringify(junk)} was read as settings`);
  }
});

test('only the keys this office knows, and only booleans', () => {
  const file = scratch();
  writeFileSync(file, JSON.stringify({ manager: false, git: 'no', pizza: false, title: 1, notify: true }));
  // `git: 'no'` is not an answer, `pizza` is not a switch, and `title: 1` is not a boolean,
  // so the only two things that survive are the two that were actually said.
  assert.deepEqual(load(file), { manager: false, notify: true });
});

test('what goes on disk is the disagreements and nothing else', () => {
  const file = scratch();
  assert.equal(save({ ...defaults(), git: false }, file), true);
  // Not all six. A file that pins everything is a file that can never be given a better
  // default, and five of these were never argued about.
  assert.deepEqual(read(file), { git: false });
});

test('agreeing with all of it is still written down', () => {
  const file = scratch();
  assert.equal(save(defaults(), file), true);
  // "I have been here and I agree" and "I have never opened this card" are the same
  // settings and a different fact, and this file is the only place the second can be kept.
  assert.deepEqual(read(file), {});
});

test('a file that cannot be written says so instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-office-ro-'));
  const kept = join(dir, 'kept');
  mkdirSync(kept);
  chmodSync(kept, 0o500);
  try {
    assert.equal(save(defaults(), join(kept, 'settings.json')), false);
  } finally {
    chmodSync(kept, 0o700);
  }
});

test('a saved setting round-trips through the file', () => {
  const file = scratch();
  save({ ...defaults(), manager: false, graphics: false }, file);
  const { values, source } = settle(load(file), []);
  assert.equal(values.manager, false);
  assert.equal(values.graphics, false);
  assert.equal(values.git, true);
  assert.equal(source.manager, 'saved');
  assert.equal(source.git, 'default');
});

test('nothing saved is all six on, and every one of them says so', () => {
  const { values, source } = settle(null, []);
  for (const s of SETTINGS) {
    assert.equal(values[s.key], true);
    assert.equal(source[s.key], 'default');
  }
});

test('a setting that is in the file came from the file, even when it agrees', () => {
  // `save` only writes the disagreements, so a `true` in there is somebody who edited it by
  // hand, and that is still a thing they said rather than a default they never touched.
  const { values, source } = settle({ notify: true }, []);
  assert.equal(values.notify, true);
  assert.equal(source.notify, 'saved');
  assert.equal(source.git, 'default', 'a key nobody wrote was reported as saved');
  // And something that is not an answer is not taken as one. `load` drops these, but this
  // is an exported function and the guard is the one that would be missed.
  const junk = settle({ git: 'no', title: 1, manager: null }, []);
  for (const key of ['git', 'title', 'manager']) {
    assert.equal(junk.values[key], true, `${key} was set from something that is not a boolean`);
    assert.equal(junk.source[key], 'default');
  }
});

test('a flag is about this run, and the card can say that is why', () => {
  const { values, source } = settle(null, ['--demo', '--no-manager']);
  assert.equal(values.manager, false);
  assert.equal(source.manager, 'flag');
  assert.equal(values.notify, true, 'a flag reached a setting it does not name');
});

test('a flag outranks the file, and only ever downward', () => {
  const on = settle({ manager: false }, ['--no-git']);
  assert.equal(on.values.manager, false, 'the file was ignored');
  assert.equal(on.source.manager, 'saved');
  assert.equal(on.values.git, false);
  assert.equal(on.source.git, 'flag');

  // The case rule one exists for: a pane started with `--no-manager` by somebody who had
  // already saved it off is still off, and still says it was the flag, because the flag is
  // the more recent statement and there is no flag that could have said otherwise.
  const both = settle({ manager: false }, ['--no-manager']);
  assert.equal(both.values.manager, false);
  assert.equal(both.source.manager, 'flag');
});

test('a flag cannot turn anything on, whatever the file says', () => {
  // There is no `--manager`, so there is nothing to assert about one. What is assertable is
  // that passing every flag the table knows leaves nothing on, and passing their opposites
  // leaves nothing changed.
  const off = settle(null, SETTINGS.map((s) => s.flag));
  for (const s of SETTINGS) assert.equal(off.values[s.key], false, `${s.key} survived its own flag`);
  const guesses = settle({ manager: false }, SETTINGS.map((s) => s.flag.replace('--no-', '--').replace('--quiet', '--notify')));
  assert.equal(guesses.values.manager, false);
  assert.equal(guesses.values.git, true, 'an invented flag changed a setting');
});

test('flipping a switch is the most deliberate thing anybody has said about it', () => {
  const was = settle(null, ['--no-manager']);
  const now = toggle(was, 'manager');
  assert.equal(now.values.manager, true, 'a flag outranked the keystroke aimed at the switch');
  // `you` rather than `saved`: it is about to be written, and until the write lands saying
  // it came from the file would be claiming something that is not true yet.
  assert.equal(now.source.manager, 'you');
  // And the old pair is untouched, because the card re-renders from whichever one it holds.
  assert.equal(was.values.manager, false);
  assert.equal(was.source.manager, 'flag');
});

test('flipping something that is not a switch changes nothing', () => {
  const was = settle(null, []);
  const after = toggle(was, 'pizza');
  // The same objects, not merely equal ones: an unknown key is a caller mistake and must
  // not even cost a copy, let alone invent a seventh switch to hold the answer.
  assert.equal(after.values, was.values);
  assert.equal(after.source, was.source);
});

test('a flip and a save and a reload is the same office', () => {
  const file = scratch();
  let prefs = settle(load(file), []);
  prefs = toggle(prefs, 'manager');
  assert.equal(prefs.values.manager, false);
  save(prefs.values, file);
  // Which is the whole feature: the thing you turned off on the card is off the next time
  // the pane opens, without anybody editing a plugin manifest.
  assert.equal(settle(load(file), []).values.manager, false);
  prefs = toggle(prefs, 'manager');
  save(prefs.values, file);
  assert.equal(settle(load(file), []).values.manager, true);
  assert.deepEqual(read(file), {});
});
