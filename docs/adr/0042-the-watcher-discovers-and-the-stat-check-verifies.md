# The watcher discovers and the stat check verifies

Issue #136 needs the Language server to hold the same bytes the agent just
wrote. pi edits files on disk and holds no buffer, and an agent moves files
in ways pi's edit tools never see: a Python script with a search-and-replace
loop, `sed`, a build that regenerates sources, a codemode script, or another
agent in a sibling worktree. Disk is the only truth, so Document sync cannot
be built on mirroring pi's own edits.

**A recursive file watcher is the discovery mechanism and a stat check is
the correctness gate.** One watcher per served root records the Changed set:
which paths moved since the last pass. Before any answer is served from a
document, its mtime and size are checked against the record and the document
is re-synced when they moved. The watcher decides what to look at; it never
decides what is current.

**A watcher event is not proof.** Events can be dropped on queue overflow,
coalesced, delivered before the writer finishes, or missed for an atomic
temp-plus-rename save. codegraph already runs this exact pairing on the same
roots: it watches, and it reconciles, and it reconciles before every query
when the watcher is degraded. This extension copies that policy, including
the 1000 ms debounce, the WSL2 `/mnt` rule, and an env opt-out
(`LSP_NO_WATCH=1`).

**Considered options.** Stat-only (no watcher) needs a `git status` sweep to
find files changed outside the Open documents, which is wrong in a non-git
directory and pays a subprocess per turn. Watcher-only was the tempting
answer to "one mechanism solves both", and it is the one that can serve an
answer from a half-written file. Reusing codegraph's watcher through
`pi.events` would run one watcher per root for the whole package, but
codegraph's callbacks report change counts rather than paths, and it would
make the LSP extension depend on codegraph being loaded and watching. That
option is recorded in the spec as the thing to revisit once both extensions
exist.

**Consequences.** When the watcher degrades, the extension falls back to the
stat pass over the Open documents plus a bounded `git status` sweep, so it
never loses the ability to see a change, it only pays more for it. The
watcher's scope is the roots the extension actually serves, never the home
directory, and it excludes `.git`, `node_modules`, `target`, `build`,
`dist`, `.venv`, `__pycache__`, and `.codegraph`. A change event for a file
the server does not have open only enters the Changed set: opening a
document makes the server analyze it, so files outside the agent's working
set are not opened until the Sweep decides they are worth the cap.
