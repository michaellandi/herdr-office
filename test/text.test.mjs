// The width helpers, which every other invariant in the office is built on. If
// width() is wrong then padEnd() is wrong, and then every row is the wrong size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { width, stripAnsi, sanitize, truncate, padEnd, center, formatDuration } from '../src/text.mjs';

test('width counts cells, not characters', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width(''), 0);
  assert.equal(width('日本語'), 6, 'CJK is two cells per glyph');
  assert.equal(width('🚀'), 2, 'emoji are two cells');
  assert.equal(width('é'), 1, 'a combining accent adds nothing');
  assert.equal(width('\x1b[31mred\x1b[0m'), 3, 'escapes are zero width');
});

test('the box drawing and blocks the office is made of are one cell each', () => {
  for (const ch of '─│╭╮╰╯├┤┬┼┌┐└┘▀▁▂▃▄▌▔▘█▒') {
    assert.equal(width(ch), 1, `${ch} should be one cell`);
  }
});

test('truncate never returns more than it was asked for', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef', 'short enough is left alone');
  assert.equal(truncate('abcdef', 6), 'abcdef', 'exactly fitting is left alone');
  assert.equal(truncate('abcdef', 3), 'ab…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate('abc', -1), '');
  // The ellipsis is one cell, so a cut always leaves room for it.
  for (const max of [1, 2, 3, 4, 5]) {
    assert.ok(width(truncate('日本語のタブ名', max)) <= max, `wide text cut to ${max} should not exceed it`);
  }
});

test('padEnd is exactly the width asked for, whatever goes in', () => {
  for (const input of ['', 'ab', 'abcdefghij', '日本語', '🚀🚀🚀', '\x1b[31mred\x1b[0m']) {
    for (const max of [0, 1, 4, 8, 20]) {
      assert.equal(width(padEnd(input, max)), max, `padEnd(${JSON.stringify(input)}, ${max})`);
    }
  }
});

test('center is exactly the width asked for too', () => {
  for (const input of ['', 'ab', 'abcdefghij', '日本語']) {
    for (const max of [0, 1, 4, 8, 20]) {
      assert.equal(width(center(input, max)), max, `center(${JSON.stringify(input)}, ${max})`);
    }
  }
});

test('sanitize drops what would wreck the grid', () => {
  assert.equal(sanitize('build 🚀 the thing'), 'build the thing', 'emoji go');
  assert.equal(sanitize('a → b'), 'a b', 'arrows go');
  assert.equal(sanitize('tabs\tand\nnewlines'), 'tabs and newlines');
  assert.equal(sanitize('\x1b[31mred\x1b[0m'), 'red', 'escapes go');
  assert.equal(sanitize('  padded  '), 'padded');
  assert.equal(sanitize('日本語'), '日本語', 'CJK stays: it is wide but it is honest about it');
});

test('a sanitized pane title is safe to measure', () => {
  const nasty = '🚀 ✅ ▪ → build \x1b[1;31m the \x1b[0m thing ';
  const clean = sanitize(nasty);
  assert.equal(width(clean), [...clean].length, 'everything left should be one cell wide');
});

test('formatDuration', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m00s');
  assert.equal(formatDuration(3_599_000), '59m59s');
  assert.equal(formatDuration(3_600_000), '1h00m');
  assert.equal(formatDuration(7_260_000), '2h01m');
});

test('stripAnsi leaves the text alone', () => {
  assert.equal(stripAnsi('\x1b[38;2;1;2;3mx\x1b[0m'), 'x');
  assert.equal(stripAnsi('\x1b[?25lx'), 'x');
  assert.equal(stripAnsi('plain'), 'plain');
});
