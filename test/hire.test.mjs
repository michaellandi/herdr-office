// Branch names and the menu cursor. The branch name is the only free text the
// office has, and it ends up as a directory and a git ref on the user's disk, so
// what survives sanitizing is worth being explicit about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeBranch, typeChunk, sanitizeBranch, defaultBranch, nextIndex, managerKind } from '../src/hire.mjs';

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

/* ------------------------------------------ hiring a manager without being asked */

const desk = (kind) => ({ id: `w1:${kind}`, name: kind, kind });
const KINDS = ['amp', 'claude', 'codex', 'gemini'];

test('the manager is whichever kind the floor is already mostly made of', () => {
  // The whole reason the picker can be skipped. A manager reads a digest and writes three
  // sentences, so the choice does not matter except in the one way it does: the kind you
  // already have six of is the kind you are logged into and have paid for.
  assert.equal(managerKind([desk('codex'), desk('codex'), desk('claude')], KINDS), 'codex');
  assert.equal(managerKind([desk('gemini')], KINDS), 'gemini');
});

test('a tie picks the same one every time, because a default that wanders is not one', () => {
  // `agentKinds` hands this list back sorted, so first-listed is alphabetical and stable. Two
  // opens of the same floor have to hire the same kind or the feature looks like it is
  // choosing for itself.
  const floor = [desk('codex'), desk('gemini')];
  assert.equal(managerKind(floor, KINDS), managerKind(floor, KINDS));
  assert.equal(managerKind(floor, KINDS), 'codex');
  assert.equal(managerKind([...floor].reverse(), KINDS), 'codex', 'and the order the desks came in is not the tiebreak');
});

test('a kind this machine cannot start is not hired however much of the floor it is', () => {
  // The floor is whatever herdr reports, and `kinds` is what herdr says it can start, which
  // is the shorter list. Hiring off the first list would be an `agent.start` that fails for a
  // reason nobody could see on the card.
  assert.equal(managerKind([desk('droid'), desk('droid'), desk('claude')], KINDS), 'claude');
  assert.equal(managerKind([desk('droid'), desk('droid')], KINDS), 'amp', 'and a floor of nothing offerable falls back');
});

test('an empty floor still gets a manager, and a machine with no agents does not', () => {
  assert.equal(managerKind([], KINDS), 'amp');
  assert.equal(managerKind(null, KINDS), 'amp');
  // Nothing to start means nothing to hire, and the caller has to be able to tell: a string
  // here would become an `agent.start` for an agent that does not exist.
  assert.equal(managerKind([desk('claude')], []), null);
  assert.equal(managerKind([desk('claude')], null), null);
});

test('junk on the floor is not a candidate', () => {
  assert.equal(managerKind([null, undefined, {}, { name: 'no kind' }, desk('gemini')], KINDS), 'gemini');
  assert.equal(managerKind([null, {}], KINDS), 'amp');
});

test('junk in the manifest list is not a candidate either', () => {
  // The fallback is the head of the list, so a blank at the front of it is the one place an
  // empty kind can reach `agent.start`. Asserted off an empty floor for exactly that reason:
  // with a desk to count, the tally picks a real kind and the blank is never looked at.
  assert.equal(managerKind([], [null, 'claude']), 'claude');
  assert.equal(managerKind([], ['', 'claude']), 'claude');
  assert.equal(managerKind([desk('claude')], [null, '', 'claude']), 'claude');
  assert.equal(managerKind([], [null, '']), null, 'a list of nothing is a machine that can start nothing');
});
