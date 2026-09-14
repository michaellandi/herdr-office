// Branch names and the menu cursor. The branch name is the only free text the
// office has, and it ends up as a directory and a git ref on the user's disk, so
// what survives sanitizing is worth being explicit about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeBranch, typeChunk, sanitizeBranch, defaultBranch, nextIndex } from '../src/hire.mjs';

test('typing a branch name keeps what a branch name can hold', () => {
  const typed = (keys, start = '') => [...keys].reduce((acc, k) => typeBranch(acc, k), start);
  assert.equal(typed('fix-login'), 'fix-login');
  assert.equal(typed('feature/thing_2.0'), 'feature/thing_2.0');
  // A space is what people press between words, and a branch cannot hold one.
  assert.equal(typed('fix the login'), 'fix-the-login');
  // Everything git would refuse, or a shell would find interesting, is dropped.
  assert.equal(typed('fix~^:?*[]\\ok'), 'fixok');
  // Each dropped character leaves nothing behind, and each space is still a
  // hyphen, so this is harmless rather than clever.
  assert.equal(typed('a$(rm -rf /)b'), 'arm--rf-/b');
  assert.equal(sanitizeBranch(typed('a$(rm -rf /)b')), 'arm--rf-/b');
  assert.equal(typeBranch('abc', '\x7f'), 'ab');
  assert.equal(typeBranch('', '\x7f'), '');
  // Escape sequences arrive as one string, not one character, and must not land
  // in the field as text.
  assert.equal(typeBranch('abc', '\x1b[A'), 'abc');
  assert.equal(typeBranch('abc', ''), 'abc');
});

test('a chunk of stdin is one keystroke at a time, and a return ends the edit', () => {
  // stdin arrives in chunks, not keystrokes: a paste is one string, and so is an
  // arrow key. Getting this wrong puts "[A" in a branch name, or worse, lets a
  // pasted newline commit something nobody read.
  assert.deepEqual(typeChunk('', 'fix-login'), { branch: 'fix-login', done: false });
  assert.deepEqual(typeChunk('fix', '-login'), { branch: 'fix-login', done: false });
  // A return anywhere ends the edit, and what came before it is still typed.
  assert.deepEqual(typeChunk('', 'fix-login\r'), { branch: 'fix-login', done: true });
  assert.deepEqual(typeChunk('', 'fix\rmore'), { branch: 'fix', done: true });
  assert.deepEqual(typeChunk('a', '\n'), { branch: 'a', done: true });
  // Escape sequences are not text. Not one character of them.
  assert.deepEqual(typeChunk('abc', '\x1b[A'), { branch: 'abc', done: false });
  assert.deepEqual(typeChunk('abc', '\x1b[200~pasted\x1b[201~'), { branch: 'abc', done: false });
  assert.deepEqual(typeChunk('abc', ''), { branch: 'abc', done: false });
  // And a pasted line of shell is still filtered one character at a time.
  assert.deepEqual(typeChunk('', '; rm -rf ~'), { branch: '-rm--rf-', done: false });
  assert.equal(typeChunk('', 'a'.repeat(200)).branch.length, 80);
  assert.deepEqual(typeChunk(null, 'x'), { branch: 'x', done: false });
});

test('a branch field cannot grow without limit', () => {
  const long = 'a'.repeat(80);
  assert.equal(typeBranch(long, 'b').length, 80);
});

test('the name that gets sent is one git will accept', () => {
  // A field is typeable mid-name, so it can hold things that are only illegal at
  // the ends. This is the last thing between that and a failed hire.
  assert.equal(sanitizeBranch('feature/'), 'feature');
  assert.equal(sanitizeBranch('/leading'), 'leading');
  assert.equal(sanitizeBranch('a..b'), 'a.b');
  assert.equal(sanitizeBranch('a//b'), 'a/b');
  assert.equal(sanitizeBranch('thing.lock'), 'thing');
  assert.equal(sanitizeBranch('trailing.'), 'trailing');
  assert.equal(sanitizeBranch('-dashed'), 'dashed');
  assert.equal(sanitizeBranch(''), '');
  assert.equal(sanitizeBranch(null), '');
  assert.equal(sanitizeBranch('...'), '');
  assert.equal(sanitizeBranch('fix login'), 'fix-login');
  assert.equal(sanitizeBranch('a'.repeat(200)).length, 80);
  // Already fine, left alone.
  assert.equal(sanitizeBranch('office/claude-0914-1502'), 'office/claude-0914-1502');
});

test('sanitizing is idempotent', () => {
  // It runs on the way out, and a name that changes every time it is checked is a
  // name nobody can predict.
  for (const raw of ['feature/', 'a..b', '  spaced  ', '///', 'ok-name', '.lock']) {
    assert.equal(sanitizeBranch(sanitizeBranch(raw)), sanitizeBranch(raw), raw);
  }
});

test('the offered branch name is grouped and stamped', () => {
  const at = new Date(2026, 8, 14, 15, 2);
  assert.equal(defaultBranch('claude', at), 'office/claude-0914-1502');
  assert.equal(defaultBranch('kiro', at), 'office/kiro-0914-1502');
  // Single digits are padded, so the names sort.
  assert.equal(defaultBranch('amp', new Date(2026, 0, 2, 3, 4)), 'office/amp-0102-0304');
  // And whatever it produces is already sendable.
  assert.equal(sanitizeBranch(defaultBranch('claude', at)), defaultBranch('claude', at));
  assert.ok(defaultBranch(undefined, at).startsWith('office/agent-'));
});

test('the menu cursor stays inside the cells that are drawn', () => {
  // limit is what is on the screen, which on a short pane is fewer than the kinds
  // that exist.
  assert.equal(nextIndex(0, 1, 0, 4, 10), 1);
  assert.equal(nextIndex(0, 0, 1, 4, 10), 4);
  assert.equal(nextIndex(0, -1, 0, 4, 10), 0); // nowhere to the left of the first
  assert.equal(nextIndex(9, 1, 0, 4, 10), 9); // nor past the last
  assert.equal(nextIndex(8, 0, 1, 4, 10), 8); // the row below the last one
  assert.equal(nextIndex(4, 0, -1, 4, 10), 0);
  // A cursor already past the end (the pane just got shorter) is pulled back in.
  assert.equal(nextIndex(9, 1, 0, 4, 3), 2);
  assert.equal(nextIndex(0, 1, 0, 4, 0), 0);
  assert.equal(nextIndex(0, 0, 1, 0, 10), 1); // no columns known yet: one at a time
});
