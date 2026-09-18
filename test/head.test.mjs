// Reading a context gauge off an agent's own status line.
//
// The fixtures below are the shape of two real status lines, off the two families of
// agent that print one, captured from a live session. Shape and not transcript, and in two
// places deliberately so. The trailing field on a real line is whatever that agent thought
// worth telling its owner, and on the machine these came from it was an auth countdown,
// which is the point of the "nothing that is not a number or a model name" test below
// rather than something to tidy away: a stand-in of the same shape sits there instead and
// the test proves the field never leaves the parser whatever is in it. The leading field is
// an agent's own name, and a neutral token stands in for the same reason. Both are shapes
// the parser has to cope with rather than content it is allowed to read, so what is written
// in them does not matter to any assertion here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGauge,
  pressure,
  headBadge,
  headWords,
  compactionNews,
  COMPACT_DROP,
  FILLING,
  HOT,
  BRIMMING,
} from '../src/head.mjs';

// The word, with the model in front of it and a field behind it.
const WORDED = '  Opus | Context: 65% | session: 19h 03m';
// The other family draws the same fact as a moon that fills up, and names its model in
// full. Three real readings: most of a window gone, a third of it, and one that has
// barely started.
const MOONED = ' agent · claude-opus-4.8 · ◑ 58% · session: 19h 3m';
const MOONED_MID = ' agent · auto · ◑ 33% ·';
const MOONED_FRESH = ' agent · auto · ◔ 4% ·';

// A screen, as the server hands one over: the status line at the bottom, under an input
// box and a row of hints, with the agent's actual output above it.
const screen = (status, { below = ['', '> ', '  ? for shortcuts'], above = ['I have finished the refactor.', ''] } = {}) =>
  [...above, status, ...below].join('\n');

test('both families of status line are read, and the number means used', () => {
  assert.deepEqual(parseGauge(screen(WORDED)), { used: 65, model: 'opus', session: null });
  assert.deepEqual(parseGauge(screen(MOONED)), { used: 58, model: 'opus-4.8', session: null });
  // `auto` is not a model this recognises, and a card with no model row on it is the
  // right outcome: the alternative is putting whatever token sits in that field on a
  // card, which is the one thing this parser is not allowed to do.
  assert.deepEqual(parseGauge(screen(MOONED_MID)), { used: 33, model: null, session: null });
  // The freshest desk on a floor reads four, not ninety-six. This is the reading that
  // settled which way round the number goes, so it is the one worth keeping.
  assert.equal(parseGauge(screen(MOONED_FRESH)).used, 4);
});

test('the session id is carried through untouched, because the next reading needs it', () => {
  assert.equal(parseGauge(screen(WORDED), 'abc-123').session, 'abc-123');
  assert.equal(parseGauge(screen(WORDED), '').session, null);
});

test('escape codes do not hide the gauge', () => {
  // Every real status line is coloured, and the colour changes mid-field: between the
  // moon and its number is exactly where an agent would put one.
  const painted = ' agent · \x1b[2mclaude-opus-4.8\x1b[0m · \x1b[33m◑\x1b[0m \x1b[1m58%\x1b[0m ·';
  assert.equal(parseGauge(screen(painted)).used, 58);
});

test('only an anchored percentage counts', () => {
  // All of these are percentages on a line with a separator on it, and none of them is a
  // context window. A gauge that read any of them would be a desk reporting somebody's
  // test output as the truth about an agent.
  for (const line of [
    'tests: 142 passed | 94% covered',
    'src/render.mjs | 87% of statements',
    'downloading | 99% | 2.1MB/s',
    'diff --git a/x b/x | similarity index 95%',
  ]) {
    assert.equal(parseGauge(screen(line)), null, line);
  }
  // And a percentage that is not one at all.
  assert.equal(parseGauge(screen('Opus | Context: 420% | x')), null);
});

test('a line with no separator on it is not a status bar', () => {
  // The strictness is the trade: an agent that prints its gauge alone on a line is an
  // agent the office says nothing about, which is the same outcome as one this does not
  // recognise at all. src/summary.mjs throws these lines away for having the separator,
  // and requiring it here is what keeps the two files agreeing about which line is chrome.
  assert.equal(parseGauge(screen('Context: 65%')), null);
});

test('the bottom-most gauge wins, and scrollback is not a status bar', () => {
  // Two on one screen: one that scrolled up out of the status bar and into the transcript,
  // and the live one. The live one is the lower.
  const both = screen('Opus | Context: 65% | session: 19h 03m', {
    above: ['Opus | Context: 12% | session: 20h 00m', 'some output', ''],
  });
  assert.equal(parseGauge(both).used, 65);
  // And a gauge far enough up the screen is transcript rather than status, so it is not
  // read at all: the window this looks at clears an agent's own chrome and stops.
  const buried = ['Opus | Context: 65% | session: 19h 03m', ...new Array(24).fill('output')].join('\n');
  assert.equal(parseGauge(buried), null);
});

test('nothing that is not a number or a model name comes back', () => {
  // The rule the whole file exists to keep. A real status line carries an auth countdown,
  // a spend figure, a branch, a path, and whatever else that agent felt like printing, on
  // a display that gets screen shared. So this is asserted against the parser's entire
  // output rather than against the fields it is known to have.
  const loaded = 'Opus | Context: 65% | auth: 19h 03m | $4.12 | /Users/somebody/secret-project | feature/acquisition';
  const out = parseGauge(screen(loaded), 'abc-123');
  assert.deepEqual(Object.keys(out).sort(), ['model', 'session', 'used']);
  const drawn = JSON.stringify(out);
  for (const secret of ['auth', '19h', '4.12', 'somebody', 'secret-project', 'acquisition']) {
    assert.ok(!drawn.includes(secret), `${secret} escaped the parser: ${drawn}`);
  }
});

test('an unrecognised model is no model, and a silly version cannot overflow a card', () => {
  assert.equal(parseGauge(screen('some-local-thing | Context: 65% | x')).model, null);
  const long = `Opus-${'9'.repeat(40)} | Context: 65% | x`;
  assert.ok(parseGauge(screen(long)).model.length <= 16, 'a version string reached a card unclipped');
});

test('a screen that says nothing, or nothing at all, is null rather than a guess', () => {
  for (const text of ['', null, undefined, 'no gauge here', '\n\n\n', '\x00\x01 | \x02']) {
    assert.equal(parseGauge(text), null, JSON.stringify(text));
  }
});

test('the bands are where they say they are, on both sides of every line', () => {
  assert.deepEqual(
    [0, FILLING - 1, FILLING, HOT - 1, HOT, BRIMMING - 1, BRIMMING, 100].map(pressure),
    ['calm', 'calm', 'filling', 'filling', 'hot', 'hot', 'brimming', 'brimming'],
  );
  // Not knowing and having room share the calm band, which is safe because the band only
  // decides the alarm and neither of them raises one. What tells the two apart is the
  // number, and that is headBadge's job rather than this one.
  for (const nothing of [null, undefined, NaN, '', 'sixty']) assert.equal(pressure(nothing), 'calm');
});

test('the chip says every reading there is, and nothing when there is none', () => {
  // Every number the office has, calm ones included. The bands decide what colour it is
  // drawn in and whether the monitor looks strained; they do not decide whether it is said.
  assert.equal(headBadge(0), '0%');
  assert.equal(headBadge(FILLING - 1), '49%');
  assert.equal(headBadge(FILLING), '50%');
  assert.equal(headBadge(76), '76%');
  assert.equal(headBadge(100), '100%');
  // The one empty case, and the reason it has to stay empty: it is what draws the
  // difference between a desk with room and a desk nobody has read.
  for (const nothing of [null, undefined, '', NaN, 'sixty']) assert.equal(headBadge(nothing), '', JSON.stringify(nothing));
});

test('the card says it in words at every band, including the calm one', () => {
  assert.equal(headWords(null), null);
  assert.equal(headWords({}), null);
  assert.equal(headWords({ used: 31 }), '31% full');
  assert.equal(headWords({ used: 65 }), '65% full');
  assert.equal(headWords({ used: 81 }), '81% full · not much room left');
  assert.equal(headWords({ used: 93 }), '93% full · about to compact');
});

test('a window that empties itself is news, once, and only when it really emptied', () => {
  const news = compactionNews({ used: 91 }, { used: 18 });
  assert.deepEqual(news, { label: 'compacted', kind: 'snag' });
  // The label is one of the office's own strings and the kind is a real one.
  assert.ok(['good', 'broke', 'snag'].includes(news.kind));
  // Ordinary movement, in both directions, is not news. The number climbs a point at a
  // time all day and there is no ordinary event that takes it down at all.
  assert.equal(compactionNews({ used: 60 }, { used: 61 }), null);
  assert.equal(compactionNews({ used: 60 }, { used: 60 - COMPACT_DROP + 1 }), null);
  assert.deepEqual(compactionNews({ used: 60 }, { used: 60 - COMPACT_DROP }), { label: 'compacted', kind: 'snag' });
  // A reading the office does not have is not a drop to zero.
  assert.equal(compactionNews(null, { used: 18 }), null);
  assert.equal(compactionNews({ used: 91 }, null), null);
  assert.equal(compactionNews({ used: 91 }, {}), null);
});

test('a different agent in the same pane is a restart, not a compaction', () => {
  // Somebody deliberately started something new here. The window is empty because it is a
  // new window, and announcing that would be the office reporting the user to themselves.
  assert.equal(compactionNews({ used: 91, session: 'a' }, { used: 3, session: 'b' }), null);
  assert.deepEqual(compactionNews({ used: 91, session: 'a' }, { used: 3, session: 'a' }), { label: 'compacted', kind: 'snag' });
  // Only some agents report a session at all, so a pair with nothing to compare still
  // reads as a compaction. That is the documented mislabel: where the server cannot tell
  // us, the common cause wins, and a compaction is several times an afternoon against a
  // restart somebody had to do on purpose.
  assert.deepEqual(compactionNews({ used: 91 }, { used: 3 }), { label: 'compacted', kind: 'snag' });
});
