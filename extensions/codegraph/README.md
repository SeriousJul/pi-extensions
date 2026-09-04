# codegraph extension

Embeds the [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph)
library in-process (no MCP server, no daemon) and registers six
`codegraph_*` tools plus the `/codegraph` command.

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
   automatically on the
   bun RUNTIME (unless the user set it), because codegraph's fast-init
   path sets `journal_mode = MEMORY` from a second connection, which
   bun's SQLite engine rejects with "database is locked" - whether it is
   reached through `bun:sqlite` or through bun's `node:sqlite` shim.
   Node keeps fast-init.
2. **Worker threads in a Bun-compiled binary cannot resolve bare
   specifiers from on-disk `node_modules`** (the main thread can; plain
   bun can). codegraph's parse pool runs in worker threads and requires
   `web-tree-sitter` and `tree-sitter-wasms` from codegraph's nested
   `lib/node_modules` directory, so the workers crash on startup. The
   patch rewrites those requires (and codegraph's dynamic wasm subpath
   resolution) to absolute file paths, which resolve everywhere.

The patch is idempotent (patched files carry a marker comment) and uses
absolute paths, so the repo may not be moved after install; re-run
`npm install` if it is. On a runtime without `node:sqlite`, an
unpatched codegraph still fails with codegraph's own clear error, which
the extension reports as its standard unavailable line. The runtime
module's preflight (a temporary-database round trip through the shim)
runs once before the first query and reports a broken stack with an
actionable reason before a real index is at stake.

The Node floor is 22.5 (the first version with `node:sqlite`). On Node
22.5-22.15 the seed copy uses a WAL checkpoint + file copy instead of
the online backup API, which only exists on Node 22.16+ / 23.8+.

All pi install flows work: local path, git clone, and npm package
(tarball). A tarball install hoists the codegraph dependency out of the
package, so the postinstall also looks for it in ancestor
`node_modules` directories and patches it there.

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

## Tools

| Tool | Purpose |
| --- | --- |
| `codegraph_search` | Quick symbol search by name. Locations only, no code. |
| `codegraph_callers` | List functions that call a symbol. |
| `codegraph_callees` | List functions called by a symbol. |
| `codegraph_impact` | Show what could break if a symbol changes, by depth. |
| `codegraph_node` | Read a single file (line numbers, dependents header) or a single symbol (signature, body, top callers/callees). |
| `codegraph_explore` | Source, call paths, and relationships for an area in one call. |

There is no `projectPath` parameter on any tool. The index is always the one
for the worktree the call was made from, resolved automatically.
`codegraph_search.kind` accepts the upstream single-kind string or an array
of kinds.

## Per-worktree indexes

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
- **First use is blocking.** The first `codegraph_*` call in a worktree
  waits for the build or seed to finish. Progress is shown in the
  `codegraph` status slot.
- **Freshness.** On first use per session the index is reconciled once,
  then codegraph's own file watcher keeps it current. If watching is
  disabled (`CODEGRAPH_NO_WATCH=1`, or WSL2 under `/mnt/`) or degrades,
  the index is reconciled before every query instead, and a one-time
  warning is shown.
- **Staleness gate at emission.** `codegraph_node` symbol mode and
  `codegraph_explore` slice current on-disk bytes at indexed line ranges.
  When a file changed after its last index sync (inside the watcher's
  debounce window, or after a missed sync), those ranges can point at a
  different symbol's code. Every sliced file is therefore checked at
  emission against its indexed record (size + mtime, content hash on a
  mismatch - codegraph's own `isFileStaleOnDisk` test). A drifted file
  never emits a slice: a small one serves its full current source
  (Read-parity) with a stale notice, a large one serves a notice pointing
  at the file-read modes. File mode is unaffected - it always reads the
  whole file fresh.
- **Removed and re-added worktrees** are re-seeded from a sibling instead
  of serving a dead snapshot (the replaced-inode check in codegraph
  detects the new database file and reopens it).
- **Cross-process builds** are serialized by codegraph's per-root file
  lock. A process that finds a live build waits for it; a process that
  finds a crashed build adopts the on-disk state and converges it.

## Project root

The root for a call is the nearest initialized ancestor of the call's
working directory. A `file` argument to `codegraph_node` anchors the
lookup to that file, so a file in a monorepo sub-project resolves to that
sub-project's index. Outside git, the root falls back to the nearest
ancestor that contains a build manifest. The home directory and the
filesystem root are never indexed.

## /codegraph

| Verb | Effect |
| --- | --- |
| `/codegraph` | Show index status for the current directory. |
| `/codegraph init` | Force a full rebuild of the index. |
| `/codegraph seed [path]` | Re-seed the index from a named sibling worktree (or the default seed source), then reconcile. |
| `/codegraph uninit` | Remove the index for the current directory (asks for confirmation). |
| `/codegraph auto on\|off` | Toggle automatic index creation for the session. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `CODEGRAPH_PI_AUTO_INDEX` | `0`/`false`/`off` disables automatic index creation (tools return the fallback line until an index exists). |
| `CODEGRAPH_PI_SEEDING` | `0`/`false`/`off` disables seeding from sibling worktrees (first build is from scratch). |
| `CODEGRAPH_NO_WATCH` | `1` disables the file watcher (reconcile before every query). |
| `CODEGRAPH_PI_SQLITE_SHIM` | Set to `bun` to force the shim's `bun:sqlite` path (used by the bun-only test). |
| `CODEGRAPH_NO_FAST_INIT` | Set to `1` automatically on the bun runtime (any bun version) unless the user set it, because bun's SQLite engine rejects the fast-init journal-mode change (see Runtime and installation). |
| `CODEGRAPH_TELEMETRY` | Set to `0` by this extension unless already set. |
| `CODEGRAPH_NO_UPDATE_CHECK` | Set to `1` by this extension unless already set. |

## Failure contract

Every tool failure - no project, unsafe root, lock timeout, build error,
watcher failure - ends with the same line, which tells the model to fall
back to the built-in tools:

```
codegraph is unavailable (<reason>). Use the built-in read and grep tools instead.
```

## Layout

- `index.ts` - pi entrypoint: registers tools and the command, adds the
  system prompt note when the index is ready, closes instances on session
  shutdown.
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
  codegraph library's instance API, types, or schema (spec 0003). The real
  adapter wraps a library instance from `runtime.ts`; the session, the
  renderers, and the staleness gate call the adapter's operations and never
  see the library's shape.
- `factory-registry.ts` - the default `IndexAdapterFactory` registry
  (library-free): the entrypoint and the handlers register the real factory
  at load; a session resolves it without importing the adapter module.
- `sync-retry.ts` - the reconcile retry contract shared by both adapters
  (initial attempt + 2 retries at a 750 ms ramp; library-free).
- `root.ts` - project root resolution and the unsafe-root guard.
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
  single boundary every tool call goes through (`ensureReady`/`queryReady`).
  The state machine, instance cache, in-flight dedup, and notifications live
  here; all library access goes through the adapter. The marker, watcher,
  and meta protocols live in the modules above.
- `staleness.ts` - the point-of-emission staleness gate (size + mtime +
  content hash against the indexed record) that keeps the renderers from
  slicing a file that drifted after its last index sync.
- `format.ts` - rendering of query results.
- `handlers.ts` - the six tool definitions and the `/codegraph` command.
