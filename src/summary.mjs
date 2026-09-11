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

export function approvalChoice(lines) {
  const tail = (lines || []).slice(-40);
  if (tail.some((line) => YES_NO.test(line))) {
    return { shape: 'y/n', approve: ['y'], deny: ['n'] };
  }
  if (tail.some((line) => MENU_YES.test(line))) {
    return { shape: 'menu', approve: ['1'], deny: ['esc'] };
  }
  if (tail.some((line) => MENU_ANY.test(line))) {
    // A numbered menu whose first entry we cannot read as a yes. Enter takes
    // whatever is highlighted, which is the agent's own default.
    return { shape: 'menu?', approve: ['enter'], deny: ['esc'] };
  }
  return { shape: 'unknown', approve: ['enter'], deny: ['esc'] };
}

// Two or three lines describing the person, in the order a human would want
// them: what they are stuck on first, then what they were last saying.
export function summarize(person, outputLines) {
  const out = [];
  if (person?.status === 'blocked') {
    const ask = findAsk(outputLines);
    out.push(ask ? `stuck on: ${ask}` : 'stuck waiting on you (could not spot the question)');
  }
  if (person?.title) out.push(`pane title: ${person.title}`);
  const substantive = outputLines.filter((line) => line.length > 16 && !isNoise(line));
  const prose = substantive.filter(isProse);
  for (const line of (prose.length ? prose : substantive).slice(-2)) out.push(`last said: ${line}`);
  if (!out.length) out.push('nothing to report');
  return out;
}

export function describeDetection(explain) {
  if (!explain || typeof explain !== 'object') return [];
  const body = explain.explain || explain.detection || explain;
  const rule = body.matched_rule;
  const lines = [];
  if (body.state) lines.push(`state ${body.state}${rule ? ` via rule ${rule.id}` : ''}`);
  const flags = ['visible_blocker', 'visible_working', 'visible_idle'].filter((k) => body[k]);
  if (flags.length) lines.push(`signals: ${flags.map((f) => f.replace('visible_', '')).join(', ')}`);
  if (body.warning) lines.push(`warning: ${body.warning}`);
  if (body.fallback_reason) lines.push(`fallback: ${body.fallback_reason}`);
  return lines;
}
