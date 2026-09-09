# Codegraph Extension

A pi extension that embeds the codegraph library in-process, giving the agent
transparent semantic code search over the current project. Each git worktree
gets its own index, so results always reflect the branch being edited.

## Language

**Index**:
The `.codegraph/` directory and its `codegraph.db` for one project root.
Disposable and rebuildable. Never a source of truth for file content.
_Avoid_: graph database, cache (too generic)

**Index adapter**:
The one module that names the codegraph library's instance API, types,
or schema. The session and the renderers call its operations and never see
the library's shape. A second in-memory adapter sits at the same seam, so
the state machine tests in milliseconds without the native library.
_Avoid_: wrapper (too generic), client (implies a remote service)

**Project root**:
The directory that holds an index. For a git worktree, this is the worktree
itself, not the main checkout.
_Avoid_: repo root, workspace

**Anchor**:
The directory a call's root resolution starts from: the call's working
directory, or the location of the named file when the tool reads a file
(`codegraph_node` file mode). A `file` argument used only to disambiguate a
symbol never moves the anchor. The root-relative form of an anchored file is
decided once, together with the root.
_Avoid_: base, cwd, anchor file (the anchor is a directory, not the file)

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

**Prewarm**:
Background creation of a worktree's index, started on the first agent turn of
a session when the worktree has no index yet. Makes the first tool call and
the first prompt note both find a nearly-ready index. Attempted once per root
per session. A tool call that arrives mid-prewarm waits for it and then takes
its own path, so a prewarm failure never becomes a tool result.
_Avoid_: prebuild (implies the index is finished before the session starts),
warmup (too generic)

**Prompt note**:
The one codegraph block the extension appends to the system prompt on an agent
turn: a first line stating the index state, then the fixed policy lines saying
which tool fits which job. It appears only when a codegraph call can be served
from the working directory, so it never promises what a call cannot deliver.
_Avoid_: system prompt injection (generic), steering text (the note is the only
one, so the shorter name is unambiguous)

**Usage log**:
The `.codegraph/usage.jsonl` file: one line per codegraph tool call, with
time, tool, outcome, duration, and result size. Lives and dies with the
index. A record of a call that failed before an index existed still creates the
index directory, which then carries codegraph's own ignore rule so git never
stages the log. Never leaves the machine.
_Avoid_: telemetry (implies data leaves the machine), metrics (metrics are
aggregates; this is an event log)

**Source section**:
The one structured block a renderer may serve as the source of a file at
its indexed line ranges: a numbered slice of the current bytes (fresh
file), the numbered full current source (small drifted file), an omission
(large drifted file), or a missing-file decision (file gone). The renderers
own wording and layout only; the drift gate, the whole-file caps, and the
short-TTL memo live with the section, so a new source renderer inherits the
never-a-drifted-slice guarantee by construction.
_Avoid_: code block, snippet, file view
