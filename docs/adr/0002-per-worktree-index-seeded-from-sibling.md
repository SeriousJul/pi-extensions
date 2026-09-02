# Per-worktree index, seeded from a sibling worktree

A git worktree holds a different branch, so a shared codegraph index would
answer queries with another branch's symbols. Upstream codegraph calls this
the "borrowed index" problem and its only built-in fix is a full reindex per
worktree (`codegraph init -i`), which the user rejected as too slow. We
decided: every worktree owns its own index, and a new worktree's index is
**seeded** by copying a sibling worktree's `codegraph.db` (SQLite online
backup), followed by one **reconcile** pass that re-extracts only the files
that actually differ on this branch.

## Why seeding works

Codegraph stores file paths relative to the project root and keys files by
content hash. Git checkout rewrites mtime on every file it writes, so after a
seed the reconcile's size/mtime pre-filter lets every file through to the
hash check, and only genuinely changed files are re-extracted. The seeded
index therefore converges to the exact state a from-scratch build would
reach, at the cost of one file copy plus a read/hash pass.

## Considered Options

- **Per-worktree index with sibling seed (chosen).** Per-branch truth, no
  full rebuild, and it matches upstream's own model: a worktree-local index
  is the blessed state, so upstream's borrowed-index warning never fires.
- **One shared index for the repo** (stored outside the trees, e.g. next to
  the common `.git`). One build total, but the graph reflects only one
  branch. Queries from any other worktree return wrong-branch symbols, which
  the model would cite confidently. Rejected on correctness.
- **Symlink `.codegraph` into new worktrees.** Same wrong-branch problem as
  sharing, plus it breaks the daemon lockfile and codegraph's
  inode-replacement detection. Rejected.

## Consequences

- Sibling discovery is git-native (`git worktree list` plus the shared
  common git dir). Worktrees created anywhere - herdr under
  `~/.herdr/worktrees/`, PR checkouts under `/tmp/`, hand-made - need no
  special casing.
- Seed source: prefer the main worktree if it has an index, otherwise any
  indexed sibling; a partial (incomplete) sibling index is accepted because
  the post-seed reconcile is a full file walk and converges either way.
- The create-or-seed decision happens under codegraph's per-root `FileLock`,
  so two concurrent sessions in the same new worktree build once.
- Diverged branches pay "re-extract only the diff". If a repo grows branches
  that differ by thousands of files, the seed source can be refined to the
  closest-HEAD sibling; not done until measured.
