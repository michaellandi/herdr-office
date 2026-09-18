// How much has changed in a checkout and not been committed.
//
// The office can say who is working, what they are running and which branch they are
// on. This is the last thing you want to know looking at a floor of agents and could
// not get: how much they have actually written. A desk that has been working for
// twenty minutes with nothing uncommitted has been reading; a desk with forty files
// changed has been busy in a way somebody is going to have to review.
//
// It is not in the socket API. `worktree.list` knows a path and a branch and nothing
// about the state of the tree (checked against the published `WorktreeInfo` at
// protocol 22: `branch`, `is_bare`, `is_detached`, `is_prunable`, `is_linked_worktree`,
// `label`, `path`, `open_workspace_id`), and there is no other method that comes close.
// So this is the office's second and last subprocess, after the `ps` in src/ps.mjs.
//
// Two rules govern it, and both are about being a guest in somebody else's repository
// while an agent is working in it.
//
// **It must not take a lock.** `git status` ordinarily refreshes the index and writes
// it back, which means taking `index.lock`. Doing that on a timer, in a checkout where
// an agent is committing, is a way to make somebody else's `git commit` fail with a
// message about a lock file, and the office would be the last place anybody thought to
// look for the cause. `--no-optional-locks` exists for exactly this caller and is not
// optional here. `core.fsmonitor=false` is the same rule one step further out: a status
// in a repo configured for it can *start a daemon*, and a wall display has no business
// leaving a process behind in somebody's repository.
//
// **No path ever leaves this file.** Same rule as src/process.mjs, for the same reason:
// what comes out of here is counts. Not a file name, not a directory, not the first few
// entries. A repository's file names are as private as its contents and this office
// gets screen-shared, so the only thing drawn is how many, and the way to see which is
// the tool that was already going to tell you.

import { execFile } from 'node:child_process';

// Long enough for a big repository on a cold cache, short enough that a wall display
// never visibly stalls. A checkout that cannot answer in this is one the office says
// nothing about, which is the same outcome as a directory that is not a repository.
const GIT_TIMEOUT_MS = 1500;

// A repository with more changes than this fills the buffer instead of the answer, and
// that is fine: an overrun still yields the partial output, which still counts past
// every threshold below. "More than the cap" and "a great deal more than the cap" draw
// identically, so there is nothing to be gained by reading the rest.
const GIT_MAX_BYTES = 1024 * 1024;

// Conflict states in a porcelain status code: both sides touched it, or one side
// deleted what the other changed. `git status` marks all of them with a `U` except the
// two where both sides did the same thing.
const CONFLICTED = /^(?:U.|.U|AA|DD)$/;

// What the office runs, as an argument list, exported so a test can hold the flags to
// the reasoning in the header rather than trusting a comment about them.
//
// `--porcelain=v1` is pinned to the version rather than left to default, because
// `--porcelain` follows whatever the default format becomes and this parser is written
// against v1. `--untracked-files=normal` and `core.quotePath=true` are both pinned for
// the same reason and it is a sharper one: they are ordinarily *the user's* settings.
// A repository with `status.showUntrackedFiles=no` would report every new file an agent
// wrote as nothing at all, and one with `core.quotePath=false` would put a real newline
// in a path and turn one strange file name into several changes. Neither is a setting
// the office should be reading somebody's tree through.
export function dirtArgs(cwd) {
  return [
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.quotePath=true',
    '-C',
    String(cwd),
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ];
}

// Counts, off porcelain v1. One record per line: two status characters, a space, and a
// path that this deliberately never looks at.
//
// The count is of entries git reports, which is not quite a count of files: an
// untracked *directory* collapses to a single `?? dir/` record however much is in it.
// That is the right unit anyway. The number is there to say how much is going on in a
// checkout, and one new directory is one new thing, however many files somebody's
// build tool put in it.
export function countDirt(stdout) {
  let files = 0;
  let conflicts = 0;
  for (const line of String(stdout || '').split('\n')) {
    // Two status characters and a space, at minimum, before anything is a record.
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (!/^[ MADRCU?!]{2}$/.test(code)) continue;
    files += 1;
    if (CONFLICTED.test(code)) conflicts += 1;
  }
  return { files, conflicts };
}

// The pile of paper on a desk, in cells.
//
// Buckets rather than a number, because the desk art has no room for digits and does
// have room for a pile that visibly grows: one cell is "they have touched something",
// five is "this is a large change and somebody is going to have to read it". The exact
// number is a row in the card, which is where you go when the pile makes you curious.
//
// Roughly doubling, which is the shape of the question. The difference between one file
// and three matters; the difference between forty and forty-five does not, and a scale
// that gave it a cell would spend the whole desk on it.
export const PILE_MAX = 5;
export function pile(files) {
  const n = Number(files) || 0;
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 10) return 3;
  if (n <= 20) return 4;
  return PILE_MAX;
}

// The badge for a one-line row: `+12`, next to the branch it belongs to.
//
// Capped at three digits, and the cap is a promise about width rather than a claim
// about the repository: the compact list gives the branch and this together whatever is
// spare after the question and the pane title, so a number that could be six digits
// wide would be a column that jumped about. Nothing real gets past 999 without the
// answer being "an enormous amount" either way.
export const DIRT_MAX_SHOWN = 999;
export function dirtBadge(files) {
  const n = Number(files) || 0;
  if (n <= 0) return '';
  return `+${Math.min(n, DIRT_MAX_SHOWN)}`;
}

// The card's version, in words, where there is room for the real number.
//
// A clean checkout is said out loud rather than left blank. It is a real answer to the
// question and often the one you were hoping for, and unlike the missing-branch case
// there is no ambiguity to apologise for: the office only ever draws this row for a
// directory git has already answered about.
//
// The row is labelled `changes`, so the words here do not repeat it.
export function dirtWords(dirt) {
  if (!dirt || dirt.files == null) return null;
  const files = Number(dirt.files) || 0;
  if (files <= 0) return 'nothing uncommitted';
  const parts = [`${files} uncommitted`];
  // Conflicts are a different kind of news from a big diff: nothing else is going to
  // happen in that checkout until somebody deals with them, so they get said even
  // though they are already counted in the number in front of them.
  const conflicts = Number(dirt.conflicts) || 0;
  if (conflicts > 0) parts.push(`${conflicts} conflicted`);
  return parts.join(' · ');
}

// One checkout's counts, or null if there is nothing safe to say about it.
//
// Always resolves. Not a repository, not readable, no git on PATH, too slow, or a
// version of git that answered in some shape this cannot parse all come out the same
// way: null, which the caller stores as "asked, nothing to say" so the directory is not
// re-asked every two seconds for the rest of the afternoon.
export function readDirt(cwd, { exec = execFile, git = process.env.HERDR_OFFICE_GIT || 'git' } = {}) {
  return new Promise((resolve) => {
    if (!cwd) return resolve(null);
    try {
      exec(
        git,
        dirtArgs(cwd),
        { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BYTES, encoding: 'utf8', windowsHide: true },
        (err, stdout) => {
          // A partial read is still a count (see GIT_MAX_BYTES), so output is preferred
          // to the error whenever there is any. An error with nothing to show for it is
          // a directory the office has no business guessing about.
          if (err && !stdout) return resolve(null);
          resolve(countDirt(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}
