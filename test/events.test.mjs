// Reading office events off agent output.
//
// The lines below are real-shaped: test summaries, cargo and gradle output, git
// telling you what it did. Several of them carry exactly what must never reach a
// screen (a home directory, a token in a URL, an assertion with data in it), and
// the test that matters most is the one asserting the office says its own fixed
// words instead of quoting any of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, eventFromMatch, WATCHES, WATCH_PATTERN } from '../src/events.mjs';

test('a failure is a failure even when most of the run passed', () => {
  assert.deepEqual(classify('Tests:  1 failed, 42 passed, 43 total'), { kind: 'broke', label: 'tests failed' });
  assert.equal(classify('FAIL src/auth.test.ts')?.label, 'tests failed');
  // The one that is easy to get backwards: `0 failed` is a green run, and a
  // pattern of `\d+ failed` would call every passing test suite a disaster.
  assert.deepEqual(classify('42 passed, 0 failed'), { kind: 'good', label: 'tests passed' });
  assert.deepEqual(classify('# fail 3'), null, 'node --test totals are not one of the phrases');
  assert.equal(classify('2 failing')?.label, 'tests failed');
  assert.equal(classify('FAILED (failures=2)')?.label, 'tests failed');
  assert.equal(classify('assertion failed: left == right')?.label, 'tests failed');
});

test('a broken build reads as broken however it broke', () => {
  assert.equal(classify('error[E0308]: mismatched types')?.label, 'the build broke');
  assert.equal(classify("thread 'main' panicked at src/lib.rs:14:5")?.label, 'the build broke');
  assert.equal(classify('Traceback (most recent call last):')?.label, 'the build broke');
  assert.equal(classify('BUILD FAILED in 3s')?.label, 'the build broke');
  assert.equal(classify('compilation error: unexpected token')?.label, 'the build broke');
});

test('the good news, and the news that is neither', () => {
  assert.deepEqual(classify('42 passed, 0 failed'), { kind: 'good', label: 'tests passed' });
  assert.equal(classify('BUILD SUCCESSFUL in 12s')?.label, 'build is green');
  assert.equal(classify('compiled successfully.')?.label, 'build is green');
  assert.equal(classify(' 3 files changed, 41 insertions(+), 8 deletions(-)')?.label, 'committed');
  assert.equal(classify('To github.com:someone/their-private-repo.git')?.label, 'pushed');
  assert.equal(classify("branch 'office/thing' set up to track 'origin/office/thing'.")?.label, 'pushed');
  // Ordinary chatter is not an event. An office that announced every line would
  // be an office nobody could read.
  for (const dull of ['', null, undefined, 'Reading files...', 'npm warn deprecated', 'Compiling serde v1.0.197', 'passed the buck']) {
    assert.equal(classify(dull), null, JSON.stringify(dull));
  }
});

test('nothing off the wire can reach the screen', () => {
  // Every label the office can draw is one of the fixed strings in the table, so
  // a line carrying a path, a token or an assertion payload contributes nothing
  // but which of those strings gets picked.
  const labels = new Set(WATCHES.map((w) => w.label));
  const nasty = [
    'FAIL /Users/someone/Desktop/private-project/src/auth.test.ts',
    'assertion failed: expected "hunter2" to equal "correct horse battery staple"',
    'error[E0308]: mismatched types in /Users/someone/secrets/keys.rs',
    '1 failed: GET https://api.internal.example.com/v1/keys?token=AKIAIOSFODNN7EXAMPLE',
    'To git@github.com:acme/very-secret-service.git',
    ' 9 files changed, 2 insertions(+) in ~/.aws/credentials',
  ];
  for (const line of nasty) {
    const hit = classify(line);
    assert.ok(hit, `should have matched: ${line}`);
    assert.ok(labels.has(hit.label), `invented a label: ${hit.label}`);
    for (const bad of ['/', '@', 'token', 'hunter2', 'AKIA', 'Users', 'secret', 'aws']) {
      assert.ok(!hit.label.includes(bad), `${hit.label} leaked ${bad}`);
    }
  }
});

test('the label comes off the matched line, or the tail of the screen', () => {
  assert.equal(eventFromMatch({ matched_line: '3 files changed, 1 insertion(+)' })?.label, 'committed');
  // A server that sends the read without saying which line matched still gets
  // read, but only its last few lines: an old failure scrolled halfway up the
  // screen is not news.
  const screen = ['1 failed, 2 passed', 'ok, moving on', '', 'a', 'b', 'c', 'd', '12 passed'].join('\n');
  assert.equal(eventFromMatch({ read: { text: screen } })?.label, 'tests passed');
  const stale = ['1 failed, 2 passed', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
  assert.equal(eventFromMatch({ read: { text: stale } }), null, 'too far up the screen to still be news');
  // The matched line wins over the screen, because it is the thing that fired.
  assert.equal(eventFromMatch({ matched_line: 'BUILD FAILED', read: { text: '12 passed' } })?.label, 'the build broke');
  for (const empty of [null, {}, { matched_line: null }, { read: null }, { read: { text: '' } }]) {
    assert.equal(eventFromMatch(empty), null, JSON.stringify(empty));
  }
});

test('the subscription pattern is one regex, and the same one', () => {
  // The server compiles this string with Rust's regex crate, which has no
  // lookaround and no backreferences, so neither may appear here. And every
  // phrase the office can classify has to be in it, or the event would never
  // arrive to be classified.
  assert.ok(WATCH_PATTERN.startsWith('(?im)'), WATCH_PATTERN);
  assert.ok(!/\(\?[=!<]/.test(WATCH_PATTERN), 'no lookaround: Rust regex cannot compile it');
  assert.ok(!/\\[1-9]/.test(WATCH_PATTERN), 'no backreferences: Rust regex cannot compile it');
  const whole = new RegExp(WATCH_PATTERN.slice(5), 'im');
  for (const line of ['1 failed', 'BUILD FAILED', 'CONFLICT (content): merge conflict in a.txt', '12 passed', 'BUILD SUCCESSFUL', '2 files changed', 'To git@github.com:a/b.git']) {
    assert.ok(whole.test(line), `the subscription would not have fired on: ${line}`);
    assert.ok(classify(line), `fired but could not classify: ${line}`);
  }
  assert.ok(!whole.test('Compiling serde v1.0.197'), 'would fire on ordinary chatter');
});
