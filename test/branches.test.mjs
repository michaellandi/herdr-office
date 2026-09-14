// Branch names. Two things are being defended here: the grid (a name with a newline
// in it would move a row) and the truth (a desk claiming to be on `main` when it is
// in a linked worktree is worse than a desk with nothing written on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchFromList, cleanBranch, cleanRepo, MAX_BRANCH } from '../src/branches.mjs';

const payload = (worktrees, repo = 'herdr-office') => ({
  type: 'worktree_list',
  source: { repo_key: '/repo/.git', repo_name: repo, repo_root: '/repo', source_checkout_path: '/repo' },
  worktrees,
});

const tree = (path, branch, over = {}) => ({
  path,
  branch,
  is_bare: false,
  is_detached: false,
  is_prunable: false,
  is_linked_worktree: false,
  label: path.split('/').pop(),
  ...over,
});

test('the branch of the directory you are actually in', () => {
  const list = payload([tree('/repo', 'main')]);
  assert.deepEqual(branchFromList(list, '/repo'), { branch: 'main', repo: 'herdr-office' });
  // A subdirectory of the checkout is still the checkout.
  assert.equal(branchFromList(list, '/repo/src/deep/inside').branch, 'main');
  // And a sibling that merely starts with the same letters is not.
  assert.equal(branchFromList(list, '/repo-other').branch, null);
  assert.equal(branchFromList(list, '').branch, null);
});

test('the deepest worktree wins', () => {
  // The bug this prevents: a linked worktree living inside the main checkout's tree
  // loses to its own parent, and every desk in the repo claims to be on main.
  const list = payload([
    tree('/repo', 'main'),
    tree('/repo/.worktrees/sso', 'feature/sso', { is_linked_worktree: true }),
  ]);
  assert.equal(branchFromList(list, '/repo/.worktrees/sso/src').branch, 'feature/sso');
  assert.equal(branchFromList(list, '/repo/src').branch, 'main');
  // Order in the payload must not decide it either way.
  const reversed = payload([...list.worktrees].reverse());
  assert.equal(branchFromList(reversed, '/repo/.worktrees/sso/src').branch, 'feature/sso');
});

test('nothing is drawn rather than something misleading', () => {
  // A detached HEAD has no branch. A commit hash on a nameplate reads as a branch
  // called a3f19c2, which tells you less than an empty nameplate does.
  assert.equal(branchFromList(payload([tree('/repo', null, { is_detached: true })]), '/repo').branch, null);
  assert.equal(branchFromList(payload([tree('/repo', 'main', { is_bare: true })]), '/repo').branch, null);
  assert.equal(branchFromList(payload([tree('/repo', null)]), '/repo').branch, null);
  assert.equal(branchFromList(payload([]), '/repo').branch, null);
  // The repo name survives all of that, because the room label still wants it.
  assert.equal(branchFromList(payload([]), '/repo').repo, 'herdr-office');
  // And a payload that is not one at all cannot throw.
  assert.deepEqual(branchFromList(null, '/repo'), { branch: null, repo: null });
  assert.deepEqual(branchFromList({ worktrees: 'nope' }, '/repo'), { branch: null, repo: null });
});

test('a ref name cannot reach the grid', () => {
  // Git will let you put a lot into a ref name. One line, bounded, or nothing.
  assert.equal(cleanBranch('refs/heads/main'), 'main');
  assert.equal(cleanBranch('feature/sso   login'), 'feature/sso login');
  assert.equal(cleanBranch('  spaced  '), 'spaced');
  assert.equal(cleanBranch(''), null);
  assert.equal(cleanBranch(null), null);
  assert.equal(cleanBranch('   '), null);
  assert.equal(cleanBranch('x'.repeat(MAX_BRANCH + 20)).length, MAX_BRANCH);
  const nasty = cleanBranch('one\ntwo\u001b]0;pwned\u0007three');
  // Not one control character, so the name cannot terminate the sequence that is
  // drawing it, and not one newline, so it cannot move a row of the grid. What is
  // left of somebody's cleverness is inert text on a single line, which is all a
  // nameplate ever draws.
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/.test(nasty), JSON.stringify(nasty));
  assert.equal(nasty.split('\n').length, 1);
  assert.ok(nasty.length <= MAX_BRANCH, nasty);
  assert.equal(cleanRepo('herdr-office'), 'herdr-office');
  assert.equal(cleanRepo(undefined), null);
});
