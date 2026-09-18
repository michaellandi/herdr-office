// Reading how much is uncommitted in a checkout, and the two promises that come with
// running git in somebody else's repository: it cannot take a lock, and no path ever
// comes back out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDirt, dirtArgs, dirtBadge, dirtWords, pile, readDirt, PILE_MAX, DIRT_MAX_SHOWN } from '../src/dirt.mjs';

// One of everything porcelain v1 says, off a real-looking tree: staged, unstaged, both,
// added, deleted, renamed, copied, untracked.
const PORCELAIN = [
  ' M src/render.mjs',
  'M  src/dirt.mjs',
  'MM office.mjs',
  'A  test/dirt.test.mjs',
  ' D old/gone.mjs',
  'R  src/was.mjs -> src/is.mjs',
  'C  src/copy.mjs -> src/copied.mjs',
  '?? notes/',
  '?? scratch.txt',
].join('\n');

test('every kind of change counts once', () => {
  assert.deepEqual(countDirt(PORCELAIN), { files: 9, conflicts: 0 });
});

test('a rename counts as one change, not two paths', () => {
  // `R  old -> new` is one record with two paths in it. Counting paths rather than
  // records would report every rename twice, and a rebase is mostly renames.
  assert.deepEqual(countDirt('R  a.mjs -> b.mjs\n'), { files: 1, conflicts: 0 });
});

test('conflicts are counted as well as included', () => {
  // A conflict is still a change, so it is in both numbers. The office says the second
  // one out loud anyway, because nothing else is going to happen in that checkout until
  // somebody deals with it.
  const out = ['UU src/render.mjs', 'AA src/new.mjs', 'DD src/gone.mjs', 'AU src/mine.mjs', 'UD src/theirs.mjs', ' M src/fine.mjs'].join('\n');
  assert.deepEqual(countDirt(out), { files: 6, conflicts: 5 });
});

test('nothing at all is a clean tree, not an unknown one', () => {
  // git says nothing when a checkout is clean, and that is an answer: zero, which the
  // card reads as clean. Distinct from null, which is what the reader returns when git
  // would not answer at all.
  assert.deepEqual(countDirt(''), { files: 0, conflicts: 0 });
  assert.deepEqual(countDirt(undefined), { files: 0, conflicts: 0 });
});

test('anything that is not a record is not counted', () => {
  // A hint, a warning on stdout, a truncated last line, a blank. None of them are
  // changes, and a parser that counted lines rather than records would report a repo
  // with a chatty git as busier than it is.
  const out = ['', 'fatal: not a git repository', 'hint: use --porcelain', 'M', ' M', 'x', '?? real.txt'].join('\n');
  assert.deepEqual(countDirt(out), { files: 1, conflicts: 0 });
});

test('a path is never parsed, however much it looks like a status code', () => {
  // The path is the part of each record this deliberately does not read. A file
  // genuinely called `UU whatever` inside a directory is one change, not two.
  assert.deepEqual(countDirt('?? weird/ M not-a-record\n'), { files: 1, conflicts: 0 });
});

test('no path ever comes back out', () => {
  // The rule the whole file exists under, asserted rather than promised. Counting is the
  // only thing that happens to this output: the office draws a number, and the way to
  // see which files is the tool that was already going to tell you.
  const secret = ' M /Users/somebody/private-project/src/credentials.mjs';
  const counts = countDirt([secret, '?? .env.production', 'A  ~/notes/acquisition-plan.md'].join('\n'));
  assert.deepEqual(Object.keys(counts).sort(), ['conflicts', 'files']);
  for (const value of Object.values(counts)) assert.equal(typeof value, 'number');
  const serialized = JSON.stringify(counts);
  for (const leak of ['somebody', 'credentials', 'env.production', 'acquisition']) {
    assert.ok(!serialized.includes(leak), `${leak} survived the count`);
  }
});

test('the flags say the office is a guest in this repository', () => {
  const args = dirtArgs('/somewhere/repo');

  // The load-bearing one. Without it `git status` refreshes the index and writes it
  // back, which means taking index.lock, which means a poll from a wall display can be
  // why somebody's agent could not commit.
  assert.ok(args.includes('--no-optional-locks'), 'the office could take a lock in somebody else\'s repo');
  // And this one leaves nothing behind: a status in a repo configured for fsmonitor can
  // start a daemon.
  assert.ok(args.includes('core.fsmonitor=false'), 'the office could leave a daemon running');

  // Pinned rather than defaulted, because these are ordinarily the user's settings and
  // reading a tree through them gives a different answer per machine:
  // showUntrackedFiles=no would report a new file as nothing at all, and quotePath=false
  // would put a real newline in a path and split one change into several.
  assert.ok(args.includes('--untracked-files=normal'));
  assert.ok(args.includes('core.quotePath=true'));
  // The format this parser was written against, by version. `--porcelain` alone follows
  // whatever the default becomes.
  assert.ok(args.includes('--porcelain=v1'));

  // Every main option has to come before the sub-command or git refuses it.
  const status = args.indexOf('status');
  assert.ok(status > 0, 'no status sub-command');
  for (const flag of ['--no-optional-locks', '-c', '-C']) {
    assert.ok(args.indexOf(flag) < status, `${flag} is after the sub-command`);
  }
  // The directory is passed with -C rather than by running in it, so the office's own
  // working directory is never what decides which repository gets read.
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', '/somewhere/repo']);
});

test('nothing in the arguments can write to the repository', () => {
  // A read is the whole contract. Anything on this list would make it something else.
  const args = dirtArgs('/somewhere/repo').join(' ');
  for (const verb of ['add', 'commit', 'checkout', 'reset', 'clean', 'stash', 'gc', 'fetch', 'pull', 'push', '--write', 'index.lock']) {
    assert.ok(!args.split(/[\s=]/).includes(verb), `${verb} is in the arguments`);
  }
});

test('the pile grows with the work and then stops', () => {
  assert.equal(pile(0), 0, 'a clean desk has no paper on it');
  assert.equal(pile(null), 0);
  assert.equal(pile(1), 1);
  // Roughly doubling: the difference between one file and three is worth a cell, the
  // difference between forty and forty-five is not.
  let last = 0;
  for (let n = 0; n <= 500; n += 1) {
    const cells = pile(n);
    assert.ok(cells >= last, `the pile shrank between ${n - 1} and ${n}`);
    assert.ok(cells <= PILE_MAX, `${n} files made a pile of ${cells} cells`);
    last = cells;
  }
  assert.equal(pile(500), PILE_MAX);
});

test('the badge is a number, and never wider than its column', () => {
  assert.equal(dirtBadge(0), '', 'a clean checkout says nothing rather than +0');
  assert.equal(dirtBadge(null), '');
  assert.equal(dirtBadge(1), '+1');
  assert.equal(dirtBadge(12), '+12');
  // The cap is a promise about width, not a claim about the repository: the branch and
  // this share whatever the compact list has spare, so a column that could be six
  // digits wide would jump about as an agent worked.
  assert.equal(dirtBadge(DIRT_MAX_SHOWN + 1), `+${DIRT_MAX_SHOWN}`);
  assert.equal(dirtBadge(999999), `+${DIRT_MAX_SHOWN}`);
  for (const n of [0, 1, 9, 10, 99, 100, 999, 1000, 1e9]) assert.ok(dirtBadge(n).length <= 4);
});

test('the card says it in words, and says clean out loud', () => {
  assert.equal(dirtWords(null), null, 'an unread checkout has no row at all');
  assert.equal(dirtWords({}), null);
  // Zero is an answer, and often the one you were hoping for.
  assert.equal(dirtWords({ files: 0, conflicts: 0 }), 'nothing uncommitted');
  assert.equal(dirtWords({ files: 1, conflicts: 0 }), '1 uncommitted');
  assert.equal(dirtWords({ files: 31, conflicts: 0 }), '31 uncommitted');
  assert.equal(dirtWords({ files: 7, conflicts: 2 }), '7 uncommitted · 2 conflicted');
  // The row is labelled `changes`, so the words do not repeat it.
  assert.ok(!dirtWords({ files: 3 }).includes('changes'));
});

// A fake `execFile`: records how it was called, answers however the test says.
const fakeExec = (reply) => {
  const calls = [];
  const exec = (file, args, opts, done) => {
    calls.push({ file, args, opts });
    setImmediate(() => reply(done));
  };
  return { exec, calls };
};

test('a checkout that answers is counted', async () => {
  const { exec, calls } = fakeExec((done) => done(null, PORCELAIN));
  assert.deepEqual(await readDirt('/somewhere/repo', { exec, git: 'git' }), { files: 9, conflicts: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'git');
  assert.deepEqual(calls[0].args, dirtArgs('/somewhere/repo'));
  // Bounded in both directions, so neither a huge repository nor a hung filesystem can
  // be why the office stopped drawing.
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.timeout <= 3000, `timeout was ${calls[0].opts.timeout}`);
  assert.ok(calls[0].opts.maxBuffer > 0);
});

test('a checkout that will not answer says nothing, rather than nothing-is-wrong', async () => {
  // Not a repository, no git on PATH, no permission. All of them have to be
  // distinguishable from a clean tree, or every pane sitting in a home directory would
  // draw as a tidy checkout.
  const notARepo = fakeExec((done) => done(Object.assign(new Error('fatal: not a git repository'), { code: 128 }), ''));
  assert.equal(await readDirt('/not/a/repo', { exec: notARepo.exec }), null);

  const noGit = fakeExec((done) => done(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), ''));
  assert.equal(await readDirt('/somewhere/repo', { exec: noGit.exec }), null);

  const timedOut = fakeExec((done) => done(Object.assign(new Error('timed out'), { killed: true }), ''));
  assert.equal(await readDirt('/somewhere/repo', { exec: timedOut.exec }), null);
});

test('a partial read is still a count', async () => {
  // Overrunning the buffer is what an enormous repository does, and it comes back as an
  // error with output attached. That output has already counted past every threshold the
  // office draws, so it is used rather than thrown away.
  const { exec } = fakeExec((done) => done(new Error('stdout maxBuffer length exceeded'), PORCELAIN));
  assert.deepEqual(await readDirt('/somewhere/repo', { exec }), { files: 9, conflicts: 0 });
});

test('nothing about a checkout can throw', async () => {
  // The reader is called from the poll. Whatever it hits, it resolves: an office that
  // stopped drawing because a directory was strange would be a worse office than one
  // that stopped drawing paper.
  const throws = { exec: () => { throw new Error('no such thing'); } };
  assert.equal(await readDirt('/somewhere/repo', throws), null);
  assert.equal(await readDirt('', throws), null);
  assert.equal(await readDirt(null, throws), null);
  assert.equal(await readDirt(undefined, throws), null);
});

test('no git is run for a pane with no directory', async () => {
  // The office only asks about checkouts the server has already called checkouts, and
  // the last gate is here: no cwd, no subprocess.
  const { exec, calls } = fakeExec((done) => done(null, ''));
  assert.equal(await readDirt('', { exec }), null);
  assert.deepEqual(calls, [], 'git was run without a directory to run it in');
});
