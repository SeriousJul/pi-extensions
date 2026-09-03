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
   Node and emulates the same surface over `bun:sqlite` on bun, so one
   installed tree works in both runtimes. On bun, the shim also sets
   `CODEGRAPH_NO_FAST_INIT=1` automatically (unless the user set it),
   because codegraph's fast-init path sets `journal_mode = MEMORY` from a
   second connection, which `bun:sqlite` rejects with "database is
   locked". Node keeps fast-init.
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
the extension reports as its standard unavailable line.

### Tests

- `npm test` - vitest suite; runs on Node or bun
  (`bun node_modules/vitest/vitest.mjs run`).
- `bun test tests/codegraph/shim-bun.test.cts` - bun-only test that runs
  a real codegraph index build and query over the `bun:sqlite` shim
  path.
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

## Per-worktree indexes

Every git worktree gets its own index under `<worktree>/.codegraph/`:

- **Borrowed indexes are never served.** If the nearest initialized index
  lives in another worktree, it is not used; the worktree gets its own
  index instead.
- **Seeding.** When a worktree has no index but a sibling worktree of the
  same repository (shared common git dir, discovered via
  `git worktree list`) does, the sibling's index database is copied into
  the new worktree (SQLite online backup) and reconciled. The reconcile is
  a full walk that converges the copy to the worktree's own tree, so a
  symbol that exists only in the sibling is removed and one that exists
  only in this worktree is added.
- **First use is blocking.** The first `codegraph_*` call in a worktree
  waits for the build or seed to finish. Progress is shown in the
  `codegraph` status slot.
- **Freshness.** On first use per session the index is reconciled once,
  then codegraph's own file watcher keeps it current. If watching is
  disabled (`CODEGRAPH_NO_WATCH=1`, or WSL2 under `/mnt/`) or degrades,
  the index is reconciled before every query instead, and a one-time
  warning is shown.
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
| `CODEGRAPH_NO_FAST_INIT` | Set to `1` automatically on the `bun:sqlite` shim path unless the user set it (see Runtime and installation). |
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
- `env.ts` - telemetry/update-check environment defaults, imported before
  the codegraph library loads.
- `sqlite-shim.cjs` - the `node:sqlite` compatibility shim used by the
  patched codegraph tree (pure CJS so every loader parses it).
- `root.ts` - project root resolution and the unsafe-root guard.
- `git.ts` - git worktree helpers (sibling discovery).
- `seed.ts` - seed source discovery and the database copy.
- `session.ts` - `CodegraphSession`: the per-session index manager and the
  single boundary every tool call goes through (`ensureReady`/`queryReady`).
- `format.ts` - rendering of query results.
- `handlers.ts` - the six tool definitions and the `/codegraph` command.
