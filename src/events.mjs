// Things that happen in an office, read off what the agents print.
//
// A status tells you an agent is working; a command tells you what it is running.
// Neither tells you how it went. This does: when a test run fails, a build goes
// green or a rebase hits a conflict, that moment goes up over the person's head
// for a few seconds, so the room reads as an office where things happen rather
// than a dashboard of five states.
//
// Two rules shape everything below.
//
// **The matched output is never shown.** herdr hands back the line that matched,
// and that line is somebody's real terminal output: a file path, a failing
// assertion with data in it, an error containing a URL with a token in the query
// string. So the line is used to *pick* one of the fixed labels in the table
// below, and the label is what gets drawn. Nothing that came off the wire is ever
// rendered.
//
// **One pattern per pane, not one per phrase.** Every entry's pattern is joined
// into a single regex for the subscription, so watching for eight things costs
// one subscription per desk instead of eight. The same strings compile locally to
// classify the line afterwards, which is the only way the server-side match and
// the label cannot drift apart.

// Patterns are written in the subset both the server (Rust `regex`) and JS agree
// on: alternation, non-capturing groups, `\b`, `\d`, inline case-insensitivity.
// No lookaround and no backreferences, because Rust's engine has neither.
//
// Order is significance, not chance: the first entry whose pattern matches wins,
// and failure comes before success because `1 failed, 42 passed` is a failure.
export const WATCHES = [
  {
    kind: 'broke',
    label: 'tests failed',
    // `[1-9]\d*` rather than `\d+`, because `0 failed` is the happy path and an
    // office that called it a failure would be wrong on every green test run.
    // Rust's regex crate has no lookahead, so there is no `(?!0)` to reach for.
    //
    // Capped at four digits, which is not fussiness: watching a live pane, this fired
    // on `kill: kill 53041 failed: no such process` and would have hung "tests failed"
    // over a desk that had run no tests. A process id is five or six digits and a test
    // count almost never is, so the cap costs a suite of ten thousand cases (which
    // still matches on `tests failed` and on `FAILED (`) and buys back every line
    // about a pid. `\b` before the digits is what makes the cap work: it will not
    // match the last four digits of a longer number.
    pattern: '^FAIL\\b|\\b[1-9]\\d{0,3} (?:tests? )?(?:failed|failing)\\b|\\btests? failed\\b|\\bassertion failed\\b|\\bFAILED \\(',
  },
  {
    kind: 'broke',
    label: 'the build broke',
    pattern: '\\bbuild failed\\b|\\bcompilation (?:failed|error)\\b|\\berror\\[E\\d|\\bpanicked at\\b|\\bTraceback \\(most recent call last\\)',
  },
  {
    kind: 'snag',
    label: 'merge conflict',
    pattern: '\\bCONFLICT \\(|\\bmerge conflict\\b|\\bfix conflicts and then\\b',
  },
  {
    kind: 'good',
    label: 'tests passed',
    pattern: '\\b[1-9]\\d* (?:tests? )?(?:passed|passing)\\b|\\ball tests passed\\b|\\btests? passed\\b',
  },
  {
    kind: 'good',
    label: 'build is green',
    pattern: '\\bbuild succeeded\\b|\\bcompiled successfully\\b|\\bBUILD SUCCESSFUL\\b',
  },
  {
    kind: 'good',
    label: 'committed',
    pattern: '\\b\\d+ files? changed\\b|\\b\\d+ insertions?\\(\\+\\)',
  },
  {
    kind: 'good',
    label: 'pushed',
    // git's push output is `To <remote>` on a line of its own, and the remote can
    // be an ssh shorthand, a URL or a path, so the shape is the whole line being
    // one word rather than any particular scheme. Prose beginning "To fix this..."
    // has a space in it and does not match.
    pattern: '^To [^ ]+$|\\b(?:branch|tag) .{1,40} set up to track\\b',
  },
];

// One pattern for the whole watchlist, for the `pane.output_matched`
// subscription. The flags are inline because the subscription carries a pattern
// string and nothing else: `i` because nobody agrees on the case of BUILD FAILED,
// and `m` so `^` means the start of a line rather than the start of the whole
// screen the server is matching against.
export const WATCH_PATTERN = `(?im)${WATCHES.map((w) => `(?:${w.pattern})`).join('|')}`;

const COMPILED = WATCHES.map((w) => ({ ...w, re: new RegExp(w.pattern, 'i') }));

// Which of the fixed labels this line earns, or null. The line itself goes no
// further than this function: what comes back is an entry from the table above,
// so nothing off the wire can reach the screen even if the server's regex and
// this one disagree about what matched.
export function classify(line) {
  const text = String(line ?? '');
  if (!text) return null;
  for (const w of COMPILED) {
    if (w.re.test(text)) return { kind: w.kind, label: w.label };
  }
  return null;
}

// The label off an `output_matched` event, or null if there is nothing worth
// putting over somebody's head. The matched line is preferred because it is one
// line; the visible screen is the fallback for a server that sends the read
// without saying which line did it, and only its last few lines are considered so
// an old failure further up the screen cannot resurface.
export function eventFromMatch(payload) {
  const direct = classify(payload?.matched_line);
  if (direct) return direct;
  const text = String(payload?.read?.text ?? '');
  if (!text) return null;
  const lines = text.split('\n').filter((l) => l.trim());
  for (const line of lines.slice(-6).reverse()) {
    const hit = classify(line);
    if (hit) return hit;
  }
  return null;
}

// A whole message off the event stream, turned into news for one desk or into
// nothing. Returns `{ paneId, kind, label }`.
//
// This lives here rather than in the office's stream handler because that is where it
// was, and where it was wrong for the entire life of the feature. The live envelope is
//
//     { event: "pane.output_matched", data: { matched_line, pane_id, read } }
//
// so the name is a STRING at the top level and the payload is under `data` with no
// `type` of its own. The handler read it as `msg.result || msg.event || msg`, which
// yields that string, and then asked the string for a `.type`: false on every event,
// forever, on every pane. Nobody noticed because the one file in the office with no
// unit tests was the one doing the parsing. Hence this function, and hence
// test/events.test.mjs asserting on the envelope as observed on the wire.
//
// The bundled schema does not settle the shape: what it documents under
// `output_matched` is the request/response variant, not the subscription envelope. The
// two fallbacks below cover the other shapes it allows for, so a server that moves the
// name onto the payload keeps working.
export function newsFromEvent(msg) {
  const name = typeof msg?.event === 'string' ? msg.event : msg?.type;
  const payload = msg?.data || msg?.result || (typeof msg?.event === 'object' ? msg.event : msg);
  if (!payload || typeof payload !== 'object') return null;
  if (name !== 'pane.output_matched' && payload.type !== 'output_matched') return null;
  if (!payload.pane_id) return null;
  const news = eventFromMatch(payload);
  return news ? { paneId: payload.pane_id, kind: news.kind, label: news.label } : null;
}
