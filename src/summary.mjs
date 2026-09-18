// Turning a terminal scrape into "what are you up to?".
// Agent CLIs draw boxes, spinners and rules; none of that is a status update,
// so it gets filtered out before we guess at a gist.
import { sanitize } from './text.mjs';

const CHROME_ONLY = /^[\s─━│┃╭╮╯╰┌┐└┘═║╔╗╚╝▀▄█░▒▓▪▫•·◦∙◐◑◒◓✳✶✻*_=~+\-.]+$/u;
const GUTTER = /^\s*[│┃|>»⏵]\s?/u;

// The real question, if there is one. Strong patterns are things only a prompt
// says; weak ones are a fallback when nothing strong is on screen.
const ASK_STRONG = [
  /\((?:y|yes)\/(?:n|no)[^)]*\)/i,
  /\[y\/n\]/i,
  /do you want\b/i,
  /would you like\b/i,
  /requires? (?:your )?approval/i,
  /waiting for (?:your )?(?:approval|input|response)/i,
  /needs? (?:your )?(?:approval|permission|confirmation)/i,
  /allow .{0,40}\?/i,
  /permission to\b/i,
  /safety check/i,
  /\?\s*$/,
];

const ASK_WEAK = [/approve/i, /continue\?/i, /press enter/i, /confirm/i, /trust/i];

// Keybinding hints and status footers look like questions to a regex but tell
// you nothing. They also make terrible "last said" lines.
const UI_NOISE = [
  /\b(?:esc|enter|ctrl|cmd|opt|alt|shift|tab)\b[^.]{0,24}\bto\b/i,
  /\bto (?:confirm|cancel|exit|quit|interrupt|toggle|select|submit|expand|collapse)\b/i,
  /^[?/]\s*(?:for|to)\b/i,
  /shortcuts?$/i,
  /^\s*[·•]\s*$/,
  /tokens?\s*(?:used|left)/i,
  /^\s*\d+\s*(?:lines?|tokens?)\b/i,
  /^[›>»$❯]/, // prompt gutters
  /\bctrl\+[a-z]\b/i,
  /\btype to (?:steer|reply)\b/i,
  /^\.\.\.\s*\+\d+\s*lines/i,
  /·.*·.*·/, // status bars: model · mode · context · branch
  /\|.*\|/, // ... and the pipe-separated flavour of the same thing
  /\bcontext:\s*\d+%/i,
  /\bauto-compact\b/i,
  /^tip:/i,
];

// Shell commands and flag soup are what the agent ran, not what it said.
const SHELLY = /(&&|\|\||;\s|\s>>?\s|\$\(|^\s*(?:sh|bash|zsh|npm|npx|pnpm|yarn|node|python3?|cargo|go|make|git|cd|rm|ls|cat|tail|grep|rg)\b)/;

// Wrapped source and one-liner scripts still read as several words, so also
// weigh how much of the line is punctuation. Prose barely uses any; code is
// mostly brackets, quotes and semicolons.
const codeDensity = (line) => (line.match(/[{}[\]();=<>|$`'"]/g) || []).length / Math.max(1, line.length);

const isProse = (line) =>
  /[a-z]/.test(line) && line.trim().split(/\s+/).length >= 4 && !SHELLY.test(line) && codeDensity(line) < 0.08;

const isNoise = (line) => UI_NOISE.some((re) => re.test(line));

export function cleanOutput(text) {
  return String(text || '')
    .split('\n')
    .map((line) => sanitize(line.replace(GUTTER, '')))
    .filter((line) => line && !CHROME_ONLY.test(line));
}

export function findAsk(lines) {
  const tail = lines.slice(-40).filter((line) => line.length >= 4 && line.length <= 240 && !isNoise(line));
  for (const set of [ASK_STRONG, ASK_WEAK]) {
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (set.some((re) => re.test(tail[i]))) return tail[i];
    }
  }
  return null;
}

// The short version of the ask, for the speech bubble over a stuck person's
// head. A desk has about twenty cells to say it in, so the trailing "(y/n)" and
// any leading gutter junk come off; the renderer truncates whatever is left.
export function bubbleText(lines) {
  const ask = findAsk(lines);
  if (!ask) return 'needs your OK';
  const short = ask
    .replace(/\s*[[(](?:y|yes)\s*\/\s*(?:n|no)[^)\]]*[)\]]\s*$/i, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return short || 'needs your OK';
}

// How to answer this particular prompt. Agents do not agree on what an approval
// looks like, so the keys come from the screen rather than from a guess: a
// literal y/n prompt takes a letter, a numbered menu takes the digit (which
// picks the plain "yes", never the "and stop asking" variant), and anything we
// do not recognise falls back to enter/esc. The caller shows the resolved keys
// before sending them, so a wrong read is visible rather than silent.
const YES_NO = /[[(]\s*y(?:es)?\s*\/\s*n(?:o)?/i;
const MENU_YES = /^\s*[❯>▶*·\s]*1[.)]\s*(?:yes|allow|approve|proceed|continue|ok\b)/i;
const MENU_ANY = /^\s*[❯>▶*·\s]*1[.)]\s+\S/;

// The "yes, and stop asking me" option, which is a different promise from yes.
//
// Yes answers this one question. This one changes what the agent will do without
// asking for the rest of the session, and sometimes for every session after it, so
// it is never what `approve` resolves to and never what a misread digit can reach
// by accident: it is only ever offered when this line is genuinely on the screen,
// and the caller shows the line before sending anything.
//
// The digit is captured rather than assumed to be 2. It usually is, but reading it
// off the menu costs nothing and a hardcoded 2 aimed at a menu that ordered its
// options differently would pick some unrelated option, which is the one failure
// this feature must not have.
const MENU_ALWAYS = /^\s*[❯>▶*·\s]*(\d)[.)]\s*(?=.*(?:don'?t ask again|do not ask again|and don'?t ask|always allow|allow always|stop asking))(.*)$/i;

// A yes of some kind has to be the start of it. "3. No, and don't ask again" is a
// deny that stops asking, which is a real option in some menus and emphatically
// not the one this key is for.
const ALWAYS_IS_YES = /^\s*(?:yes|allow|approve|proceed|continue|ok\b|always)/i;

export function alwaysOption(lines) {
  for (const line of (lines || []).slice(-40)) {
    const m = MENU_ALWAYS.exec(line);
    if (!m) continue;
    const label = m[2].replace(/\s+/g, ' ').trim();
    if (!ALWAYS_IS_YES.test(label)) continue;
    return { keys: [m[1]], label };
  }
  return null;
}

export function approvalChoice(lines) {
  const tail = (lines || []).slice(-40);
  // Offered alongside whatever shape the prompt turns out to be, because a menu
  // that has this option still has a plain yes at 1 and that is what `y` sends.
  const always = alwaysOption(tail);
  if (tail.some((line) => YES_NO.test(line))) {
    return { shape: 'y/n', approve: ['y'], deny: ['n'], always };
  }
  if (tail.some((line) => MENU_YES.test(line))) {
    return { shape: 'menu', approve: ['1'], deny: ['esc'], always };
  }
  if (tail.some((line) => MENU_ANY.test(line))) {
    // A numbered menu whose first entry we cannot read as a yes. Enter takes
    // whatever is highlighted, which is the agent's own default.
    //
    // No always here even if a line matched. If the menu is unreadable enough that
    // the first option cannot be identified as a yes, a digit read out of the same
    // menu is not trustworthy enough to grant a standing permission with.
    return { shape: 'menu?', approve: ['enter'], deny: ['esc'], always: null };
  }
  return { shape: 'unknown', approve: ['enter'], deny: ['esc'], always: null };
}

// The label goes on the first of the said lines and the rest are indented under it,
// which is the only reason this is a constant rather than a string in place: the
// indent has to be exactly as wide as the label or the block does not line up.
const SAID = 'last said: ';

// How many of them. Three reads as a paragraph, which is what the tail of an agent's
// output is; two read as a pair of unrelated remarks.
const SAID_LINES = 3;

// A few lines describing the person, in the order a human would want them: what they
// are stuck on first, then what they were last saying.
//
// The said lines are labelled once, not once each. Repeating "last said:" down the
// block spent eleven cells per line saying a thing already said, on the narrowest
// column in the office, and read as three separate utterances rather than as the tail
// of one.
export function summarize(person, outputLines) {
  const out = [];
  if (person?.status === 'blocked') {
    const ask = findAsk(outputLines);
    out.push(ask ? `stuck on: ${ask}` : 'stuck waiting on you (could not spot the question)');
  }
  if (person?.title) out.push(`pane title: ${person.title}`);
  const substantive = outputLines.filter((line) => line.length > 16 && !isNoise(line));
  const prose = substantive.filter(isProse);
  const said = (prose.length ? prose : substantive).slice(-SAID_LINES);
  said.forEach((line, i) => out.push(i === 0 ? `${SAID}${line}` : `${' '.repeat(SAID.length)}${line}`));
  if (!out.length) out.push('nothing to report');
  return out;
}

// Why the office thinks what it thinks, off `agent explain`.
//
// The office asserts five states and a raised hand, and until this line existed
// you had to take its word for all of it. A desk reading idle while its agent is
// plainly working is the question this answers: which rule fired, what it was
// looking at, and whether detection was even running.
//
// It is also a safety problem wearing a debugging feature's clothes. The explain
// payload is a full rule evaluation, and every rule in it carries an `evidence`
// block whose `region_preview` is raw screen text. Reading one off a live session
// produced an AWS account id and a paragraph of somebody's private reasoning, in
// the first desk tried. So the rule here is the rule that governs the news on the
// wall and the job on the monitor: the payload is used to say WHY, and nothing
// that came off the wire is drawn.
//
// Concretely: `evidence` is never read at all, and every value that does get drawn
// has to pass a shape check first. herdr's own identifiers (states, rule ids,
// regions, manifest names) are bare tokens, so a bare token is what is allowed.
// Anything longer or stranger is data wearing an identifier's name, and it is
// dropped rather than trimmed.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
// Regions are named like `whole_recent` or `bottom_non_empty_lines(5)`.
const REGION = /^[A-Za-z0-9_]{1,32}(\([0-9]{1,3}\))?$/;
const MANIFEST = /^[A-Za-z0-9._-]{1,32}$/;

const token = (value) => (typeof value === 'string' && TOKEN.test(value) ? value : null);
const counted = (value) => (Number.isFinite(value) && value >= 0 && value <= 9999 ? Math.floor(value) : null);

// Ordered by how much each line explains, because the panel clips this section
// from the bottom to keep the answer keys on screen: whichever rule fired matters
// more than which file the rules came from.
export function describeDetection(explain) {
  if (!explain || typeof explain !== 'object') return [];
  const body = explain.explain || explain.detection || explain;
  if (!body || typeof body !== 'object') return [];
  const lines = [];

  const state = token(body.state);
  const rule = body.matched_rule && typeof body.matched_rule === 'object' ? body.matched_rule : null;
  const ruleId = rule ? token(rule.id) : null;
  if (state) lines.push(`state ${state}${ruleId ? ` via rule ${ruleId}` : ''}`);
  else if (ruleId) lines.push(`matched rule ${ruleId}`);

  // herdr's warnings and fallback reasons are free text, so they can carry a path,
  // a URL, or a version of the screen. A bare token is an enum and safe to repeat;
  // anything else is only acknowledged, with a pointer at the CLI that can print
  // the whole thing safely because it is not a wall display.
  for (const [label, value] of [
    ['warning', body.warning],
    ['fallback', body.fallback_reason],
    ['update skipped', body.skipped_update_reason],
  ]) {
    if (!value) continue;
    const bare = token(value);
    lines.push(bare ? `${label}: ${bare}` : `${label} reported (run: herdr agent explain)`);
  }

  // The reasons a state can disagree with the screen in front of you. These are
  // the whole point of the section, so they sit above the arithmetic.
  if (body.screen_detection_skipped === true) lines.push('screen detection skipped');
  if (body.skip_state_update === true) lines.push('state held, not being updated');
  if (body.local_override_shadowing_remote === true) lines.push('a local manifest overrides the published one');
  const status = token(body.remote_update_status);
  if (status && status !== 'current') lines.push(`manifest update ${status}`);

  // The rule's own terms: priority says what it beat, region says where on the
  // screen it was looking.
  if (rule) {
    const parts = [];
    const priority = counted(rule.priority);
    const region = typeof rule.region === 'string' && REGION.test(rule.region) ? rule.region : null;
    if (priority !== null) parts.push(`priority ${priority}`);
    if (region) parts.push(`looking at ${region}`);
    if (parts.length) lines.push(parts.join(', '));
  }

  // How close the call was. One match is a clear read; four means several rules
  // recognised that screen and the priority above is what settled it.
  const rules = Array.isArray(body.evaluated_rules) ? body.evaluated_rules : [];
  if (rules.length) {
    const matched = rules.filter((r) => r && r.matched === true).length;
    lines.push(`${rules.length} rules checked, ${matched} matched`);
  }

  const flags = ['visible_blocker', 'visible_working', 'visible_idle'].filter((k) => body[k] === true);
  if (flags.length) lines.push(`signals: ${flags.map((f) => f.replace('visible_', '')).join(', ')}`);

  // Which manifest was in force, by name and version only. `manifest_source` is an
  // absolute path under somebody's home directory, so the basename is all that is
  // ever drawn, and the scheme in front of it says where it came from.
  const source = typeof body.manifest_source === 'string' ? body.manifest_source : '';
  const scheme = /^([a-z]{1,12}):/.exec(source);
  const file = source.replace(/^[a-z]{1,12}:/, '').split('/').pop();
  const version = token(body.manifest_version);
  if (file && MANIFEST.test(file)) {
    const where = scheme ? ` (${scheme[1]})` : '';
    lines.push(`rules from ${file}${version ? ` ${version}` : ''}${where}`);
  }

  return lines;
}
