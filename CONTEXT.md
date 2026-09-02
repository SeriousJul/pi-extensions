# Codegraph Extension

A pi extension that embeds the codegraph library in-process, giving the agent
transparent semantic code search over the current project. Each git worktree
gets its own index, so results always reflect the branch being edited.

## Language

**Index**:
The `.codegraph/` directory and its `codegraph.db` for one project root.
Disposable and rebuildable. Never a source of truth for file content.
_Avoid_: graph database, cache (too generic)

**Project root**:
The directory that holds an index. For a git worktree, this is the worktree
itself, not the main checkout.
_Avoid_: repo root, workspace

**Sibling worktree**:
Another git worktree of the same repository, identified by a shared common
git dir. Includes worktrees created by herdr under `~/.herdr/worktrees/` and
PR checkouts under `/tmp/`.
_Avoid_: clone (a clone is a different repository, not a sibling), branch

**Seed**:
Copy a sibling worktree's index DB into a new worktree's index before the
first reconcile. Makes a new worktree usable without a full rebuild.
_Avoid_: clone the index, sync (sync is not copying between worktrees)

**Reconcile**:
One sync pass over a worktree that verifies every file against the index and
re-extracts only the changed set. Runs after every seed and on first use.
_Avoid_: rebuild (a rebuild starts from an empty index), refresh

**Borrowed index**:
A query that resolves to a different worktree's index, so results reflect
another branch. The state this extension must never serve silently.
Term adopted from upstream codegraph.
_Avoid_: stale index (stale means old content in the same worktree; that is a
different failure)
