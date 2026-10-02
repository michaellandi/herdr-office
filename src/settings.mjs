// The six decisions the office used to make you re-make every morning.
//
// Every one of these already existed as a command line flag, and a flag is the wrong
// shape for all of them. The office runs as a herdr plugin pane, which means it is
// started by a manifest somebody wrote once and then opened by clicking a thing: there
// is no command line in front of you at the moment you decide you would rather it did
// not hire a manager. `--no-manager` was a preference you could only express in the one
// place you were not standing.
//
// So the flags stay and a file joins them. Three rules:
//
// 1. **A flag only ever turns something off.** All six are opt-outs, which is not an
//    accident: each one is a thing the office does by default because it is the answer
//    to a question people actually have, and each one costs something somebody might
//    not want to spend. That makes the precedence trivial. There is no flag that can
//    turn a setting on, so a flag and the file can never disagree about anything except
//    whether this particular run is quieter than usual.
// 2. **The file is the default and the flag is this run.** Saved settings decide what
//    the office is; a flag overrides one of them until you quit. Toggling on the card
//    writes the file and takes effect immediately, including over a flag, because a
//    keystroke aimed at a switch you are looking at is the most deliberate statement
//    about that switch anybody has made.
// 3. **Only what differs from the default is written.** A file that records all six
//    every time is a file that pins all six forever, and then an office that learns a
//    better default can never give it to anybody who once opened this card. What is on
//    disk is the list of places you disagreed with it.
//
// Nothing in here reads or writes anything by itself: `load` and `save` take a path and
// every failure means the same thing it means in src/state.mjs, which is that this is a
// convenience on top of a working office and does not get to break one.
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The table, in the order the card draws it: what it costs you, most first. The manager
// is the only one that spends money, the two reads after it are what the office puts on
// the wire and in your repositories, and the bottom three are taste.
//
// `help` is a sentence about the cost, not about the feature. A switch whose explanation
// is "draws the pixel charts" tells you what you can already see on the card; what you
// came to the card to find out is what it is doing to your machine when it is on.
export const SETTINGS = [
  {
    // Opt-out because the card is a summary and without somebody to write one it is a list
    // of notices with a heading. Opt-out at all because it is the only thing in the office
    // that starts a real agent without a keystroke aimed at it, and an agent costs tokens.
    // Off is not a smaller office, it is the same office with the starting done by hand.
    key: 'manager',
    flag: '--no-manager',
    label: 'hire a manager',
    help: 'Opening the manager\'s card starts an agent and asks it to read the floor. That spends tokens, every twenty seconds at most, and only while the card is open. Off, the card draws the accounts itself and M still hires one by hand.',
  },
  {
    // Opt-out because it is the question a floor of agents cannot otherwise answer, and
    // opt-out at all because of what it costs on the wire: this is the one feature that
    // reads the visible screen of every desk on a rotation rather than only the desks with
    // their hands up. Nothing off those screens is drawn or kept, and somebody who would
    // still rather this pane were not looking gets to say so.
    key: 'context',
    flag: '--no-context',
    label: 'read how full each head is',
    help: 'One screen read per desk on a rotation, so a monitor can say how much context an agent has left. The only thing here that looks at a desk nobody has their hand up at.',
  },
  {
    // Opt-out because it is the answer to the question people actually have about a floor
    // of agents, and because what it runs is a read that cannot take a lock (see
    // src/dirt.mjs). Opt-out at all because it is the one thing the office does that is not
    // a socket call: somebody watching agents on a machine where git is expensive, or who
    // would simply rather this pane never shelled out into their repositories, gets to
    // say no.
    key: 'git',
    flag: '--no-git',
    label: 'count what is uncommitted',
    help: 'Runs git status in each checkout a desk is sitting in. The one thing the office does that is not a socket call, and the only reason it ever touches your repositories.',
  },
  {
    // On by default because the whole reason to watch the office is to find out that
    // somebody is waiting on you, and a default that has to be switched on by editing an
    // installed plugin's manifest is a default nobody ever gets.
    key: 'notify',
    flag: '--quiet',
    label: 'say when somebody needs you',
    help: 'A herdr notification the moment a hand goes up, so the office is worth leaving open behind whatever you are actually doing. Never sent about a hand already on your screen.',
  },
  {
    // Opt-out for the same reason the toasts are: the pane is asked once whether it can
    // draw at all, and a terminal that says no is never asked again, so there is nothing
    // here for a default to break. What it is opt-out *for* is taste: some people want a
    // terminal to be only text, and that is a preference, not a capability.
    key: 'graphics',
    flag: '--no-graphics',
    label: 'draw the pixel charts',
    help: 'The attention strip and the day chart as images rather than as text. A terminal that cannot show them is asked once and then left alone, so this is taste rather than capability.',
  },
  {
    // The window title is the office's only presence outside its own pane, which is exactly
    // why it is opt-out: it is somebody else's window, and a title is a shared surface that
    // other things may also care about.
    key: 'title',
    flag: '--no-title',
    label: 'set the window title',
    help: 'Puts the headline count on the window itself, so the office is legible from a tab bar with its pane nowhere in sight. The only mark it leaves outside its own pane.',
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

// All six on, which is the office as it ships. Not a constant object: callers mutate
// what they get back, and a shared default would make one office's toggle another's.
export const defaults = () => Object.fromEntries(SETTINGS.map((s) => [s.key, true]));

// Where the file lives. Deliberately not `HERDR_PLUGIN_STATE_DIR`, which is where the
// punchclock goes: that is scratch, scoped to a day, and thrown away the moment it does
// not parse. These are the user's, they are expected to outlive a plugin reinstall, and
// `~/.config` is where somebody who wants to edit one by hand would think to look.
//
// `HERDR_OFFICE_CONFIG` is a whole path rather than a directory, so a test or a second
// office can be pointed at a file of its own without inventing a directory for it.
export function configFile(env = process.env) {
  if (env?.HERDR_OFFICE_CONFIG) return env.HERDR_OFFICE_CONFIG;
  const base = env?.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'herdr-office', 'settings.json');
}

// The path as it goes on the card. The home directory is collapsed because this pane gets
// screen-shared, and `/Users/somebody/.config/herdr-office/settings.json` is both longer than
// the card has room for and more personal than the fact anybody wanted off it.
export function shortPath(file, home = homedir()) {
  const path = String(file || '');
  if (!path) return '';
  if (home && path === home) return '~';
  // The separator is required, so a home of `/Users/sam` does not turn `/Users/sammy/x` into
  // `~my/x`, which is a wrong path that looks like a right one.
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

// Whatever is on disk, as a partial map of the keys this version knows about. Null is
// not a failure and is not distinguished from one: no file, an unreadable file, a file
// of JSON that is not an object, and a file full of keys from a version that does not
// exist yet all mean "no opinion recorded", which is the ordinary case.
//
// Deliberately unversioned, unlike src/state.mjs. The shape is a flat map of booleans
// and there is no incompatible change available to it: a key that goes away stops being
// read, a key that arrives has a default, and a value that is not a boolean is not a
// value. Versioning it would only buy the ability to throw somebody's preferences away.
export function load(file = configFile()) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!BY_KEY.has(key) || typeof value !== 'boolean') continue;
      out[key] = value;
    }
    return out;
  } catch {
    // A file the office cannot read is a file the office does not have.
    return null;
  }
}

// Writes the disagreements and nothing else, so an office that improves a default gives
// it to everybody who never argued about that switch. An empty object is still written
// rather than the file being deleted: "I have been here and I agree with all of it" and
// "I have never opened this card" are the same settings and a different fact, and the
// file is the only place the second one could be recorded.
//
// Temporary name and a rename, like the punchclock, for the same reason: a half-written
// JSON file is what you get by quitting during the write, and this one is written in the
// middle of a keystroke rather than on a timer.
export function save(values, file = configFile()) {
  const out = {};
  for (const s of SETTINGS) if (values?.[s.key] === false) out[s.key] = false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing left to try, and nothing worth saying.
    }
    return false;
  }
}

// What this run is actually running with, and where each answer came from.
//
// `source` exists for one row of the card. A switch that reads `off` when you know you
// saved it as on is the office looking broken, and the true explanation is one word
// long: the flag this pane was started with. Without somewhere to say that, the only
// way to find out would be to read the plugin manifest.
export function settle(saved, argv = []) {
  const flags = new Set(argv);
  const values = defaults();
  const source = {};
  for (const s of SETTINGS) {
    source[s.key] = 'default';
    // The typeof check rather than a truthiness one, because this is an exported function
    // and the file it is usually handed has already been through `load`. Something that is
    // not a boolean is not an answer, and taking one would put a string on the card where a
    // switch should be.
    if (saved && typeof saved[s.key] === 'boolean') {
      values[s.key] = saved[s.key];
      source[s.key] = 'saved';
    }
    // Last, and only ever downward. The flag is about this run and the file is about
    // the office, so a `--no-manager` pane is a quiet pane without rewriting anybody's
    // preferences, and closing it leaves them exactly as they were.
    if (flags.has(s.flag)) {
      values[s.key] = false;
      source[s.key] = 'flag';
    }
  }
  return { values, source };
}

// One switch, flipped. Returns a new pair rather than mutating, and the source becomes
// `you` rather than `saved`: it is about to be saved, and until the write lands saying
// it came from the file would be claiming something that is not true yet.
export function toggle({ values, source }, key) {
  if (!BY_KEY.has(key)) return { values, source };
  return {
    values: { ...values, [key]: !values[key] },
    source: { ...source, [key]: 'you' },
  };
}

// The setting a key names, for the card and for anything that wants its label.
export const setting = (key) => BY_KEY.get(key) || null;
