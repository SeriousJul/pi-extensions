# codegraph internals

The internal reference for the codegraph extension: the runtime patch, the
index lifecycle, root resolution, labels, and the module map. For what you
configure and what the agent sees, see the
[codegraph page](/extensions/codegraph/).

## Runtime and installation

Run `npm install` in the pi-extensions repo. The `postinstall` step
(`scripts/patch-codegraph.mjs`) prepares the pinned
`@colbymchenry/codegraph@1.6.0` for the runtime pi embeds. pi is a
Bun-compiled binary, and two things in codegraph break under it:

1. **`node:sqlite` does not exist in the embedded Bun.** The patch
   rewrites codegraph's `require('node:sqlite')` calls to this repo's
   shim (`sqlite-shim.cjs`). The shim uses the real `node:sqlite` on
   Node and on bun >= 1.4 (bun provides it), and emulates the same
   surface over `bun:sqlite` on older bun, so one installed tree works
   in every runtime. The env defaults (`runtime.ts`, which runs them
   before the library loads in file order) set `CODEGRAPH_NO_FAST_INIT=1`
   automatically on the bun runtime (unless the user set it), because
   codegraph's fast-init path sets `journal_mode = MEMORY` from a second
   connection, which bun's SQLite engine rejects with "database is
   locked" - whether it is reached through `bun:sqlite` or through bun's
   `node:sqlite` shim. Node keeps fast-init.
2. **Worker threads in a Bun-compiled binary cannot resolve bare
   specifiers from on-disk `node_modules`** (the main thread can; plain
   bun can). codegraph's parse pool runs in worker threads and requires
   `web-tree-sitter` and `tree-sitter-wasms` from codegraph's nested
   `lib/node_modules` directory, so the workers crash on startup. The
   patch rewrites those requires (and codegraph's dynamic wasm subpath
   resolution) to absolute file paths, which resolve everywhere.

The patch is idempotent (patched files carry a marker comment) and uses
absolute paths, so the repo may not be moved after install; re-run
`npm install` if it is. On a runtime without `node:sqlite`, an unpatched
codegraph still fails with codegraph's own clear error, which the
extension reports as its standard unavailable line. The runtime module's
preflight (a temporary-database round trip through the shim) runs once
before the first query and reports a broken stack with an actionable
reason before a real index is at stake.

The Node floor is 22.5 (the first version with `node:sqlite`). On Node
22.5-22.15 the seed copy uses a WAL checkpoint + file copy instead of
the online backup API, which only exists on Node 22.16+ / 23.8+.

All pi install flows work: local path, git clone, and npm package
(tarball). A tarball install hoists the codegraph dependency out of the
package, so the postinstall also looks for it in ancestor `node_modules`
directories and patches it there.

### Tests

- `npm test` - vitest suite; runs on Node or bun
  (`bun node_modules/vitest/vitest.mjs run`).
- `npm run smoke:node` - plain-Node smoke test: loads the extension
  through jiti exactly like pi does (npm install mode), builds a real
  index on a fixture repository, and runs real tool handlers. Guards
  against Node ESM breakage that the in-process vitest suite masks
  (codegraph's npm entry is a CJS re-export whose named exports Node
  ESM cannot detect).
- `bun test tests/codegraph/shim-bun.test.cts` - bun-only test that runs
  a real codegraph index build and query over the `bun:sqlite` shim
  path.
- `bun test tests/codegraph/runtime-bun.test.cts` - bun-only test that
  the runtime module reports the `bun:sqlite` backend when forced by
  `CODEGRAPH_PI_SQLITE_SHIM=bun`, and that its preflight passes on it.
- `npx tsc --noEmit` - typecheck.

## Index lifecycle

Every git worktree gets its own index under `<worktree>/.codegraph/`:

- **Borrowed indexes are never served.** If the nearest initialized index
  lives in another worktree, it is not used; the worktree gets its own
  index instead.
- **Seeding.** When a worktree has no index but a sibling worktree of the
  same repository (shared common git dir, discovered via
  `git worktree list`) does, the sibling's index database is copied into
  the new worktree (SQLite online backup; a WAL checkpoint + file copy on
  Node 22.5-22.15, which lack the backup API) and reconciled. The
  reconcile is a full walk that converges the copy to the worktree's own
  tree, so a symbol that exists only in the sibling is removed and one
  that exists only in this worktree is added.
- **First use is prewarmed.** When automatic indexing is on, at least one
  codegraph tool is active, and the runtime passes its preflight check, the
  first agent turn starts a background build for a fresh worktree. The first
  `codegraph_*` call waits for that build and is served from it, so the build
  is never paid twice. Progress is shown in the `codegraph` status slot. A
  background failure never becomes a tool result: the first call takes its
  own path and retries, and the failure is reported as one warning. A
  prewarm that is still building when the session shuts down cannot be
  aborted, but its result is never adopted: the session closes the index it
  opened and starts no watcher for it. Existing indexes are never prewarmed -
  the per-call reconcile is the only staleness recovery path.
- **Freshness.** On first use per session the index is reconciled once, then
  codegraph's own file watcher keeps it current. If watching is disabled
  (`CODEGRAPH_NO_WATCH=1`, or WSL2 under `/mnt/`) or degrades, the index is
  reconciled before every query instead, and a one-time warning is shown.
- **Staleness gate at emission.** `codegraph_node` symbol mode and
  `codegraph_explore` slice current on-disk bytes at indexed line ranges.
  When a file changed after its last index sync (inside the watcher's
  debounce window, or after a missed sync), those ranges can point at a
  different symbol's code. Every sliced file is therefore checked at
  emission against its indexed record (size + mtime, content hash on a
  mismatch - codegraph's own `isFileStaleOnDisk` test). A drifted file never
  emits a slice: a small one serves its full current source (Read-parity)
  with a stale notice, a large one serves a notice pointing at the
  file-read modes. File mode is unaffected - it always reads the whole file
  fresh.
- **Removed and re-added worktrees** are re-seeded from a sibling instead
  of serving a dead snapshot (the replaced-inode check in codegraph
  detects the new database file and reopens it).
- **Cross-process builds** are serialized by codegraph's per-root file
  lock. A process that finds a live build waits for it; a process that
  finds a crashed build adopts the on-disk state and converges it.

## System prompt note

Every agent turn appends one note to the system prompt: the first line
states the index state (ready, building, or none) and six fixed policy
lines say which tool fits which job. It is the only codegraph steering
text in the prompt, so the note is the single place to change policy. The
impact line targets a refactor of a symbol, the trigger the agent actually
meets (issue #72). The text is contract (issue #9).

A seventh line - the dependency-source line that tells the model to pass a
dependency's directory as `projectRoot` - joins the block when at least one
trusted root (Named project roots, below) exists on disk, and is absent
otherwise: a note must not advertise a query form every call would refuse.
The line carries one static sentence with the first-use promise (issue
#72 / ADR 0016): the first call to a dependency builds its index and may
wait, and the build reports progress. No per-dependency state ever joins
the note, so the system prompt stays stable turn to turn.

The note appears only when all three conditions hold:

- at least one `codegraph_*` tool is active in the session (a disabled
  toolset must not be advertised),
- a codegraph call can actually be served from the working directory: a
  project root resolves there and is one the extension agrees to index,
  and, when no index exists yet, automatic indexing is on, and
- the runtime compatibility stack passes its preflight check.

The second gate matters because the "none" line promises that the agent's
first call builds the index. Where no call can ever build one, the note
would send the agent to a tool that only fails, and the agent would learn
to ignore it.

The third gate suppresses the note in every state, including ready. Every
entry asserts the runtime before it serves a query, so on a machine where
the stack is broken no call can answer even when the index on disk is
perfect. That check is cached per process, so it costs one temporary
database open for the whole session, not one per turn. Deciding the note
never warns: the actionable runtime notice belongs to the first call (or
to the prewarm), which reports it once.

## Project root

The root for a call is the nearest initialized ancestor of the call's
working directory. A `codegraph_node` call that reads a file (a `file`
argument with no `symbol`) anchors on that file instead: the root is the
nearest initialized ancestor of the named file, so a file in a monorepo
sub-project resolves to that sub-project's index. A `file` argument used
only to disambiguate a symbol never moves the root: it stays the call's
working directory. The root-relative form of an anchored file is carried
by the ready index result, so the tool never rewrites its own parameters.
Outside git, the root falls back to the nearest ancestor that contains a
build manifest. The home directory and the filesystem root are never
indexed. A `file` argument of a named call (`projectRoot` given) resolves
inside the named root, never against the working directory, and a form
that escapes the named root is refused: outside it there is no index that
could answer.

## Named project roots

A `projectRoot` argument queries a **dependency source**: the source of a
cached dependency, for example under the opensrc cache home (`opensrc
path <pkg>` prints it). The argument applies the path rule (an absolute
path, a `~` path, or a path relative to the working directory), and the
root it names is honored the way the session root is - with one bound: an
index for a named root is built only at or under a **trusted root**.

- **Trusted roots.** The cache home (an explicit `OPENSRC_HOME`, else
  `~/.opensrc`, when it exists), the `CODEGRAPH_PI_TRUSTED_ROOTS` entries
  (PATH-style, existing directories only), and the roots `/codegraph add`
  stores for the session. A build outside every trusted root is refused
  with a reason that names the command to run, and the refusal writes
  nothing: no index directory, no ledger line.
- **Labels.** A result from a named root is prefaced with one line -
  `Project: <names> @<version> - <absolute root path>` - and status and
  progress lines use the same label where one exists. The label comes from
  the cache's manifest (every name on the path, one version, re-read only
  when the manifest changes on disk) and falls back to the last two path
  segments (or the basename alone). A missing label never fails a call.
- **Snapping.** A named directory that lies inside a cache entry serves
  that entry's tree; a directory outside every entry is honored as-is
  through the normal root policy.
- **No prewarm, no seeding, no watcher.** A named root is built on demand
  at the cost of a full build (disk is the real cost, which is why the
  bound exists), reconciled before every query, and cached per root for
  the session. Instances of named roots are never capped.
- **Missing sources.** A named directory that does not exist fails with
  `no such directory (<abs>)`; under a trusted root the failure adds a
  hint that names the `opensrc fetch` for the dependency. The extension
  never fetches on the agent's behalf and never resolves a package name.

Root resolution never leaves the project the session started in (spec
0008). The session root - the project the call's working directory
resolves to - is resolved first and is the anchor of record for the call.
An anchored root may be the session root or a descendant of it (the
monorepo sub-project case above), compared on realpaths so a symlinked
working directory and its target do not look like two projects. A `file`
that points at any other project fails with the standard unavailable line,
with a reason that names both paths: `file <x> is outside this project
(<session root>)`. The refusal writes nothing - no index, no ledger, no
directory in a tree the user did not ask about - and its visible record is
one warning per session.

## `/codegraph` command

| Verb | Effect |
| --- | --- |
| `/codegraph` | Show index status for the current directory, then the named roots this session opened (label, path, state, counts, last call) and the trusted roots with their origin. |
| `/codegraph status [path]` | Show the index status of the named root the path names (the path rule applies), or the session root without a path. |
| `/codegraph init [path]` | Force a full rebuild of the index for the given root (trust-gated), or the session root without a path. |
| `/codegraph seed [path]` | With no path, re-seed the session index from a sibling worktree. With a path, re-seed that sibling (a worktree of the same repository with an index) or seed the named root it names. Then reconcile. |
| `/codegraph uninit [path]` | Remove the index for the given root (or the session root), with its usage log (asks for confirmation). |
| `/codegraph add <path>` | Trust a directory for named-root builds for the rest of the session (the path rule applies; the directory must exist). A session add expires with the session; there is no `remove` verb. |
| `/codegraph auto on\|off` | Toggle automatic index creation for the session. |

The three verbs that change an index (`init`, `seed`, `uninit`) refuse to
run while this session's own background first-use build is still running,
and say so. The build marker guards other processes, not that build, so
without the guard `uninit` could delete a directory a build is writing
into.

`/codegraph` status also shows local usage from
`<worktree>/.codegraph/usage.jsonl`: per-tool counts, successful and
failed calls, time since the last call, and the reason of the newest
failure. The per-tool row lists the four registered tools in a fixed order, then
any other tool name the ledger holds (including the unregistered caller
and callee tools), so a recorded call can never be missing from the row
that explains the totals above it. The file is append-only
and is removed by `/codegraph uninit` with the rest of the index -
including in a worktree that never got an index, where the ledger is all
that is there. A worktree with no index gets an ignore file with its
ledger, so `git add -A` can never stage a usage log out of a directory
that was only created to record why a call failed. That ignore file is the
one thing git can see in the index directory, which is codegraph's own
convention for an index directory: its default ignore rule keeps just that
file visible. The file this extension writes carries upstream's own header
marker, so codegraph still recognizes it as its own and can upgrade it in
place if its default rules ever change.

The ledger is never rewritten or compacted, so the counts stay cumulative
across sessions of the worktree; the read cost is bounded instead. A
status call folds only the lines appended since the previous read (the
running summary is held in memory, keyed by the ledger path, and
re-parsed from scratch when the file is replaced, truncated, or deleted).
A torn or malformed line is skipped, never counted, and read again once
it is complete. Delete the file to start the counts over.

## Module map

- `index.ts` - pi entrypoint: registers tools and the command, adds the
  tri-state system prompt note when codegraph tools are active and a call
  can be served from the working directory, starts the first-turn prewarm
  (one project root resolution for the turn's note-and-prewarm decision,
  shared by both), and closes instances on session shutdown. Its second
  argument is the entrypoint's test seam for the Index factory.
- `runtime.ts` - the runtime compatibility stack in one module, in file
  order (the order is the contract): the env defaults (telemetry,
  update-check, fast-init), the single import point for the codegraph
  library (CJS require - Node ESM cannot see the named exports of the
  package's CJS re-export), the sqlite-shim re-exports, the
  once-per-process preflight (temporary-database round trip), and the
  runtime-gap error classification with its frozen unavailable strings.
- `sqlite-shim.cjs` - the `node:sqlite` compatibility shim used by the
  patched codegraph tree (pure CJS so every loader parses it).
- `indexAdapter.ts` - the Index adapter: the only module that names the
  codegraph library's instance API, types, or schema (spec 0003). The
  real adapter wraps a library instance from `runtime.ts`; the session,
  the renderers, and the source-section gate call the adapter's
  operations and never see the library's shape.
- `factory-registry.ts` - the default `IndexAdapterFactory` registry
  (library-free): the entrypoint and the handlers register the real
  factory at load; a session resolves it without importing the adapter
  module.
- `sync-retry.ts` - the reconcile retry contract shared by both adapters
  (initial attempt + 2 retries at a 750 ms ramp; library-free).
- `root.ts` - project root resolution, the unsafe-root guard, the path
  rule (absolute, `~`, relative) shared by every path argument, the
  named-root resolution (snapping, the file-argument boundary), and the
  session-root containment rule (spec 0008): an anchored root must stay
  inside the project the session's working directory resolves to.
- `opensrc.ts` - the dependency-source module (spec 0009): the only place
  in the extension that names opensrc. The cache home, the trusted roots
  from the environment, the cache manifest (re-read only when it changes
  on disk), project labels, the path-form label, and the fetch hint.
  Everything else in the extension speaks of named roots, trusted roots,
  and labels.
- `git.ts` - git worktree helpers (sibling discovery).
- `seed.ts` - seed source discovery (the database copy is the adapter's
  `seedFrom` operation).
- `marker.ts` - the cross-process build marker: file format, read/write/
  clear, pid liveness, and the wait-for-peer-build loop. Operates on the
  index directory.
- `index-meta.ts` - the per-index advisory meta record (seed source, last
  reconcile) in `pi-codegraph-meta.json`. Operates on the index directory.
- `watcher.ts` - the watcher policy: disabled reasons (`CODEGRAPH_NO_WATCH`,
  WSL2 `/mnt`), start, and degradation handling.
- `session.ts` - `CodegraphSession`: the per-session index manager and the
  single ready boundary every tool call and every test crosses
  (`ensureReady`). The state machine, instance cache, in-flight dedup, and
  notifications live here; all library access goes through the adapter.
  The marker, watcher, and meta protocols live in the modules above.
- `sourceSection.ts` - the trustworthy source-section entry (spec 0005):
  it owns the point-of-emission drift gate, its short memo, and the
  whole-file caps, so renderers never slice a file that drifted after its
  last index sync.
- `format.ts` - rendering of query results.
- `handlers.ts` - the tool definitions (four registered, the caller and
  callee tools defined but unregistered), the usage ledger wrapper, and the
  `/codegraph` command.
- `usage.ts` - the append-only local `usage.jsonl` ledger, the ignore
  file that keeps it out of git, and the incremental reader that folds it
  into the status summary.

## Specs

The design specs (0001-0009) live as GitHub issues on this repository;
the issue titles carry the spec numbers, and the `spec 000X` references
in code comments point to them. The closed issues are the implemented
history; the open ones are ready for the next agent pass.
