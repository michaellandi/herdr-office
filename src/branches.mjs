// Which branch a desk is on, read off `worktree.list`.
//
// The office already tells you who is working and what they are running. This is
// the other half of the question you actually have when you look at a floor of
// agents: which of them is about to write to the branch you care about. Two desks
// in the same repo, one on `main` and one on a throwaway, look identical without
// it.
//
// `worktree.list` is the only thing in the API that knows a branch. It is asked per
// working directory, because that is the only key it takes that is guaranteed to be
// there: `workspace_id` returned nothing on a real session where every pane had a
// cwd. **`trust_repository` is never sent**, the same rule as hiring into a
// worktree: prompting somebody to trust a repository is a decision for them to make
// in front of the repository, not something a wall display should ask for on their
// behalf. An untrusted repo simply has no branch on its desks.
import { sanitize } from './text.mjs';

// Long enough for `feature/some-real-branch-name`, short enough that it cannot be
// used to smuggle a paragraph onto a screen somebody is sharing. Branch names are
// author-controlled text, exactly like tab names and terminal titles, both of which
// the office already draws, so the rule here is the same: one line, no control
// characters, bounded length.
export const MAX_BRANCH = 32;

// Git will let you put almost anything in a ref name. What comes out of here is one
// plain line or nothing: a name that arrives with a newline in it is a name that
// would have moved a row of the grid, and a blank one is not news.
export function cleanBranch(name) {
  const str = sanitize(String(name ?? ''))
    .replace(/^refs\/heads\//, '')
    .replace(/\s+/g, ' ')
    .trim();
  return str ? str.slice(0, MAX_BRANCH) : null;
}

// The repo's own name, for the room label. Same treatment, shorter: it is a
// directory name, not a sentence.
export function cleanRepo(name) {
  const str = sanitize(String(name ?? '')).replace(/\s+/g, ' ').trim();
  return str ? str.slice(0, 24) : null;
}

// True when `path` contains `cwd`: either the same directory, or an ancestor of it.
// String comparison rather than anything clever, and the separator has to be there,
// so /foo/bar-baz is not treated as living inside /foo/bar.
const contains = (path, cwd) => cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`);

// The branch for one working directory, out of a `worktree.list` payload.
//
// A repo with several worktrees checked out returns all of them, so the answer is
// the *deepest* one that contains the directory: a linked worktree inside the main
// checkout's tree would otherwise lose to its own parent and every desk in the repo
// would claim to be on `main`.
export function branchFromList(payload, cwd) {
  const dir = String(cwd ?? '');
  if (!dir) return { branch: null, repo: null };
  const trees = Array.isArray(payload?.worktrees) ? payload.worktrees : [];
  const repo = cleanRepo(payload?.source?.repo_name);
  let best = null;
  for (const tree of trees) {
    const path = String(tree?.path || '');
    if (!path || !contains(path, dir)) continue;
    if (!best || path.length > String(best.path).length) best = tree;
  }
  // A detached HEAD or a bare repo has no branch to name. Nothing is drawn rather
  // than a commit hash: a desk labelled `a3f19c2` tells you less than a desk with
  // nothing on it, because at least the empty one does not look like a branch.
  if (!best || best.is_bare || best.is_detached) return { branch: null, repo };
  return { branch: cleanBranch(best.branch), repo };
}
