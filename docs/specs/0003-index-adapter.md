# Spec 0003: Put a deep Index adapter over the codegraph library

Status: implemented. Source: architecture review, 2026-09-04, candidate 3.

## Background

The codegraph library's instance API is used directly in several modules:

- `session.ts` - instance methods `close`, `getStats`, `getIndexState`,
  `getWatcherDegradedReason`, `indexAll`, `reopenIfReplaced`, `sync`,
  `watch`; statics `CodeGraph.init`, `CodeGraph.open`,
  `CodeGraph.recreate`.
- `format.ts` - the six renderers call `searchNodes`, `getNodesByName`,
  `getFiles`, `getNodesInFile`, `getFileDependents`, `getCallers`,
  `getCallees`, `getImpactRadius`, `findRelevantContext`.
- `staleness.ts` - the emission gate calls `getFile`.
- `session.ts` (`diskStats`) - opens the raw database through the shim and
  names the library's internal tables (`files`, `nodes`, `edges`,
  `project_metadata`). The comment already calls this a known coupling.
- `seed.ts` - the static path helpers `getDatabasePath`, `isInitialized`.

Consequences:

- The lock-in recorded by ADR-0001 is not contained at one seam. A library
  bump re-plumbs several files, and the schema read breaks quietly on an
  upstream schema change.
- The session state machine (wait / adopt / build / seed, in-flight dedup,
  dead-snapshot reseed, sync lock contention) is only testable through the
  real native library: a 293 MB dependency, real index builds, a single
  fork test pool, 240 s timeouts. The subtle logic has no fast test path.

## Goals

- Locality: one module (the Index adapter) is the only module that names
  the library's instance API, its types, or its schema. A library bump or a
  schema change touches that one module.
- Testability: a second adapter (in-memory) sits at the same seam, so the
  state machine is testable in milliseconds without the native library.
  Two adapters make the seam real.
- Depth: the adapter is deep - the session and the renderers call a small
  set of operations and never see the library's shape.

## Non-goals

- No change to the tool interface: names, parameters, descriptions, and
  output text of the six tools are frozen.
- No change to the session's public interface, except that the static type
  of `ReadyInfo.cg` becomes the adapter type.
- No change to the runtime compatibility stack (spec 0002) - the adapter
  obtains its instances from the runtime module, it does not load the
  library itself.
- No transport change. The library stays in-process (ADR-0001). The seam
  is internal to the extension's implementation; it is not an escape hatch
  for a daemon or a CLI.

## Target design

One new internal module (name proposal: `indexAdapter.ts`). It is the only
module that imports the library (through the runtime module) and the shim
(for the schema read).

### Operations the adapter must cover

Lifecycle (used by the session):

- Open an existing Index; create an empty Index; recreate an Index (full
  rebuild).
- Full build with a progress callback.
- Reconcile (sync) with the current lock-contention contract: a result of
  zero checked files means the per-root lock was not acquired; the
  adapter retries (2 attempts, 750 ms ramp) and then reports the
  contention.
- Watch start with the current options and callbacks; degraded-reason
  query; close; reopen-if-replaced.
- Stats (`fileCount`, `nodeCount`, `edgeCount`), index state, and the raw
  schema read that `diskStats` performs today (counts and index state
  without an open instance).

Queries (used by the renderers and the staleness gate):

- Node search (fuzzy, with kind filter, limit, offset).
- Nodes by exact name.
- File list, nodes in a file, file record (for the staleness gate),
  file dependents.
- Callers and callees of a node.
- Impact radius.
- Relevant-context traversal (the explore query).

Library types (`Node`, `Edge`, `Subgraph`, `NodeKind`, `SyncResult`,
`IndexProgress`, `GraphStats`) are re-exported from the adapter module.
`session.ts`, `format.ts`, and `staleness.ts` stop importing the library
directly.

### The in-memory adapter (test adapter)

Implements the same interface, backed by plain data:

- Configurable reconcile result, including the zero-checked-files lock
  contention case.
- Configurable build success/failure.
- Configurable watch outcome (active, degraded with reason).
- Configurable reopen-if-replaced.
- Stats, index state, and file records from an in-memory table.

The in-memory adapter must honor the documented contracts of the real
adapter (the lock-contention contract above first); a fake that drifts
from those contracts tests the fake, not the state machine.

### What the session keeps

The state machine, the instance cache, the in-flight dedup, the
notification logic, and (until spec 0001 lands) the marker and meta
protocols. It calls the adapter; it no longer names `CodeGraph`.

## Behavior freeze

- Tool output text, byte for byte. The renderers' text is the contract
  with the model.
- Reconcile policy: first-use reconcile always; reconcile on every query
  when the watcher is not active; watcher-active fast path skipped.
- The standard unavailable contract on failure.
- The schema read's graceful failure: an unreadable database yields
  "counts unavailable" in the status, never a crash.

## Tests

Survive unchanged (they cross the public interface with the real library):

- `tests/codegraph/tools.test.ts` - renderer output.
- `tests/codegraph/staleness.test.ts` - the emission gate.
- `tests/codegraph/session.test.ts` - end-to-end state machine, kept as
  the integration guard.

New, fast, no native library:

- In-flight dedup: two concurrent `ensureReady` calls for one root run
  one build.
- Dead marker: a crashed peer's marker is cleared and the on-disk Index
  is adopted.
- Live marker: the call waits; with a short injected timeout it fails with
  the unavailable contract.
- Dead snapshot: the database file vanishes from under an open instance;
  the instance is dropped and the create-or-seed path runs again
  (the fix from the "borrowed index" guard era).
- Lock contention: the reconcile reports zero checked files twice; the
  call fails with the unavailable contract after the documented retries.
- Watcher degradation: a degraded watcher forces reconcile-on-use.
- Build failure: a failed build drops the instance and reports the
  unavailable contract with the build error detail.
- Schema read: the adapter returns counts and index state from the
  in-memory tables; the unreadable case returns the graceful "no counts"
  result.

## Migration steps

1. Keep the operation list above as the source of truth; verify it against
   the call inventory in the Background section.
2. Create the adapter with the pass-through implementation (real library
   behind it). Mechanical work.
3. Route `session.ts` through the adapter; move `diskStats` into it.
4. Route `format.ts` and `staleness.ts` through the adapter; change
   `ReadyInfo.cg` to the adapter type; update `handlers.ts` (the
   `getStats` calls in the init and seed notifications).
5. Build the in-memory adapter; add the fast state-machine tests.
6. Remove direct library imports from `session.ts`, `format.ts`,
   `staleness.ts`. Grep for the library package name: only the runtime
   module and the adapter may name it.
7. Full suite, old and new.

## Ordering

Independent of specs 0001 and 0002. Best after 0001: the session is
smaller, so steps 3 and 6 touch less code. It is the largest of the three;
the in-memory adapter and its tests are the bulk of the work.

## ADR alignment

No conflict. ADR-0001 chose the in-process embed and records the
lock-in: swapping the transport later means re-plumbing every tool call
and the watcher lifecycle. This spec does not swap the transport; it
contains that lock-in at one seam, so the re-plumbing cost the ADR warns
about is bounded to the adapter instead of spread across the extension.
ADR-0002 (per-worktree index, sibling seed) is untouched: the seed and
reconcile semantics are unchanged; only the module that issues the
library calls changes.
