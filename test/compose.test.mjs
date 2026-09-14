// Assigning work. `agent.prompt` makes a real agent act on real text and there is
// no undo, so what the field accepts and exactly who a broadcast reaches are both
// worth pinning down here rather than discovering in somebody's terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typePromptChunk, cleanPrompt, wrapField, broadcastTargets, describeTargets, MAX_PROMPT } from '../src/compose.mjs';
import { width } from '../src/text.mjs';

const typed = (keys, start = '') => keys.reduce((acc, k) => typePromptChunk(acc, k).text, start);

test('typing a prompt keeps prose and drops what would wreck the grid', () => {
  assert.deepEqual(typePromptChunk('', 'rebase onto main'), { text: 'rebase onto main', done: false });
  assert.deepEqual(typePromptChunk('rebase', ' onto main'), { text: 'rebase onto main', done: false });
  // Punctuation is prose. None of it is filtered, because a prompt is not a branch
  // name and "don't touch config.yaml (yet)" has to be typeable.
  assert.equal(typed(["don't touch config.yaml (yet); ask me first"]), "don't touch config.yaml (yet); ask me first");
  // Ambiguous-width glyphs would break the panel they are drawn in.
  assert.equal(typed(['ship it 🚀']), 'ship it ');
  // A tab, and any run of whitespace, is one space.
  assert.equal(typed(['a\t\tb']), 'a b');
  assert.equal(typed(['a   b']), 'a b');
  // Escape sequences are not text.
  assert.deepEqual(typePromptChunk('abc', '\x1b[A'), { text: 'abc', done: false });
  assert.deepEqual(typePromptChunk('abc', '\x1b[200~pasted\x1b[201~'), { text: 'abc', done: false });
  assert.deepEqual(typePromptChunk('abc', ''), { text: 'abc', done: false });
  assert.deepEqual(typePromptChunk(null, 'x'), { text: 'x', done: false });
});

test('a return submits, and takes only what was typed before it', () => {
  assert.deepEqual(typePromptChunk('', 'go\r'), { text: 'go', done: true });
  assert.deepEqual(typePromptChunk('', 'go\rand then stop'), { text: 'go', done: true });
  assert.deepEqual(typePromptChunk('go', '\n'), { text: 'go', done: true });
  // A pasted paragraph submits at its first newline rather than sending the rest as
  // one run-on line nobody read.
  assert.deepEqual(typePromptChunk('', 'first line\nsecond line\n'), { text: 'first line', done: true });
});

test('the field can be edited, not just appended to', () => {
  assert.equal(typePromptChunk('abc', '\x7f').text, 'ab');
  assert.equal(typePromptChunk('', '\x7f').text, '');
  // ctrl-u clears, ctrl-w takes the last word. A four-hundred character field with
  // only backspace is a field nobody uses twice.
  assert.equal(typePromptChunk('rebase onto main', '\x15').text, '');
  assert.equal(typePromptChunk('rebase onto main', '\x17').text, 'rebase onto');
  assert.equal(typePromptChunk('rebase onto main ', '\x17').text, 'rebase onto');
  assert.equal(typePromptChunk('one', '\x17').text, '');
  assert.equal(typePromptChunk('', '\x17').text, '');
});

test('the field cannot grow without limit', () => {
  const full = 'a'.repeat(MAX_PROMPT);
  assert.equal(typePromptChunk(full, 'b').text.length, MAX_PROMPT);
  // A paste longer than the room left is cut, not dropped and not overflowed.
  assert.equal(typePromptChunk('a'.repeat(MAX_PROMPT - 3), 'bbbbbbbb').text.length, MAX_PROMPT);
  assert.equal(typePromptChunk('', 'b'.repeat(MAX_PROMPT * 2)).text.length, MAX_PROMPT);
});

test('what gets sent is trimmed, collapsed and never blank by accident', () => {
  assert.equal(cleanPrompt('  rebase onto main  '), 'rebase onto main');
  assert.equal(cleanPrompt('a\t b'), 'a b');
  // Empty means "send nothing", which the caller has to honour. A blank prompt is
  // a keystroke sent to an agent for no reason.
  assert.equal(cleanPrompt(''), '');
  assert.equal(cleanPrompt('   '), '');
  assert.equal(cleanPrompt(null), '');
  assert.equal(cleanPrompt('🚀'), '');
  assert.equal(cleanPrompt('a'.repeat(MAX_PROMPT + 50)).length, MAX_PROMPT);
  // Idempotent: what is shown as the outgoing text is what goes out.
  assert.equal(cleanPrompt(cleanPrompt(' a  b ')), cleanPrompt(' a  b '));
});

test('the field wraps to the panel, and shows the end of what you typed', () => {
  const lines = wrapField('rebase onto main and then run the tests', 20, 3);
  for (const l of lines) assert.ok(width(l) <= 20, `"${l}" is ${width(l)} cells`);
  assert.ok(lines.length <= 3);
  // The cursor is at the end, so the end is what has to be visible.
  assert.ok(lines[lines.length - 1].endsWith('tests'), lines.join('|'));
  // Short text is one line, and an empty field is still one (empty) line, because a
  // panel row that vanished would change the panel's height as you type.
  assert.deepEqual(wrapField('go', 20, 3), ['go']);
  assert.deepEqual(wrapField('', 20, 3), ['']);
  assert.deepEqual(wrapField(null, 20, 3), ['']);
  // A word longer than the field is broken rather than allowed to overflow.
  for (const l of wrapField('a'.repeat(95), 20, 3)) assert.ok(width(l) <= 20, l);
  assert.equal(wrapField('a'.repeat(95), 20, 3).length, 3);
  // Never more rows than it was given, never fewer than one, at any width.
  for (const cols of [1, 2, 5, 20, 100]) {
    for (const n of [1, 2, 3, 5]) {
      const got = wrapField('rebase onto main and then run the whole test suite twice', cols, n);
      assert.ok(got.length >= 1 && got.length <= n, `${cols}x${n} gave ${got.length}`);
      for (const l of got) assert.ok(width(l) <= Math.max(1, cols), `${cols}: "${l}"`);
    }
  }
});

const roster = [
  { id: 'w1:p1', name: 'Ada', status: 'idle' },
  { id: 'w1:p2', name: 'Bo', status: 'blocked' },
  { id: 'w1:p3', name: 'Cass', status: 'working' },
  { id: 'w1:p4', name: 'Dev', status: 'done' },
  { id: 'w1:p5', name: 'Ede', status: 'unknown' },
];

test('a broadcast skips the people it must not reach, and says so', () => {
  const { to, skipped } = broadcastTargets(roster);
  // Blocked is rejected by the server before anything is sent, so listing it as a
  // recipient would be a lie. Working is mid-turn, and barging in on five agents
  // at once is not something one keystroke gets to do.
  assert.deepEqual(to.map((p) => p.name), ['Ada', 'Dev', 'Ede']);
  assert.deepEqual(skipped, { blocked: 1, working: 1 });
  assert.deepEqual(broadcastTargets([]), { to: [], skipped: { blocked: 0, working: 0 } });
  assert.deepEqual(broadcastTargets(null).to, []);
  // A roster of nothing but hands up and busy hands reaches nobody at all.
  assert.deepEqual(broadcastTargets(roster.filter((p) => p.status !== 'idle' && p.status !== 'done' && p.status !== 'unknown')).to, []);
  // Junk in the roster is not a recipient.
  assert.deepEqual(broadcastTargets([null, { status: 'idle', name: 'Ok' }]).to.map((p) => p.name), ['Ok']);
});

test('the recipients are named, and the sentence fits the panel', () => {
  const to = broadcastTargets(roster).to;
  assert.equal(describeTargets(to, 60), 'Ada, Dev and Ede');
  assert.equal(describeTargets([to[0]], 60), 'Ada');
  assert.equal(describeTargets([], 60), 'nobody is free to take this right now');
  // Too narrow to name everybody: names give way to a count, one at a time, and
  // the line always fits.
  for (const cols of [4, 8, 12, 16, 20, 40]) {
    const line = describeTargets(to, cols);
    assert.ok(width(line) <= cols || cols < width('5 people'), `${cols}: "${line}"`);
  }
  const many = new Array(30).fill(0).map((_, i) => ({ name: `Person${i}`, status: 'idle' }));
  assert.ok(width(describeTargets(many, 60)) <= 60, describeTargets(many, 60));
  assert.ok(/more$/.test(describeTargets(many, 60)), describeTargets(many, 60));
});
