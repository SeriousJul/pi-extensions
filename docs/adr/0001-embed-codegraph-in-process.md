# Embed codegraph in-process, not via daemon or CLI

The pi extension needs the codegraph query API and a file watcher for the
lifetime of a pi session. We decided to embed the `@colbymchenry/codegraph`
npm library directly in the pi process instead of talking to a codegraph
daemon or shelling out to the `codegraph` CLI.

## Considered Options

- **In-process library embed (chosen).** The package re-exports the full
  `CodeGraph` API for exactly this case. It runs on the host Node runtime
  (needs Node 22.5+ for `node:sqlite`; pi runs newer). The watcher lives in
  the session process, so freshness tracking has zero IPC. SQLite WAL plus
  codegraph's own `FileLock` make concurrent multi-session use safe.
- **Attach to a codegraph daemon.** The daemon exists to let many MCP clients
  share one long-lived index process. For a single in-process consumer it
  adds a process to manage (spawn, health, socket) for no gain.
- **CLI subprocess per call.** Needs a global install, pays process startup
  per query, and cannot hold a persistent watcher between calls.

## Consequences

- The extension pins a codegraph version as an npm dependency (the
  per-platform package carries the Rust kernel and all tree-sitter WASM
  grammars, ~293 MB unpacked on linux-x64). Upgrades are a dependency bump.
- Swapping the transport later (for example to a shared daemon) means
  re-plumbing every tool call and the watcher lifecycle. That is the
  lock-in this ADR records.
