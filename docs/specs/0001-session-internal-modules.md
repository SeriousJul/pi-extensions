# Spec 0001: Split CodegraphSession into internal modules

Status: implemented. Source: architecture review, 2026-09-04, candidate 1.

## Background

`CodegraphSession` (`extensions/codegraph/session.ts`, 1022 lines) is the deep
module of the codegraph extension. Its interface is small: tools cross it via
`queryReady`/`ensureReady`, the `/codegraph` command via `rebuild`, `reseed`,
`uninit`, `statusFor`, and the prompt note via `isReadyFor`.

The implementation does not match the interface. Four internal protocols live
in the one class, mixed with the create/seed/build state machine:

1. **Marker protocol** (cross-process build coordination): the build marker
   file, pid liveness, and the wait loop. Touched by 7 methods:
   `isReadyFor`, `prepareUnderLock`, `waitForBuild`, `awaitBuildMarker`,
   `rebuildCore`, `reseedCore`, `runBuildOrSeed`.
2. **Watcher policy**: the disabled reasons (`CODEGRAPH_NO_WATCH=1`, WSL2
   `/mnt` detection), watcher start, degradation, and the sync-complete
   callback that writes the meta record.
3. **Index meta records**: the per-Index `pi-codegraph-meta.json` file
   (`seedSource`, `seededAt`, `lastReconcileAt`, `lastReconcileChanged`),
   written by 4 methods and read by `statusFor`.
4. **Raw schema reads**: `diskStats` opens the index database directly and
   names the library's internal tables (`files`, `nodes`, `edges`,
   `project_metadata`). This is a leak across the seam to the library;
   spec 0003 owns its removal.

In addition, the post-seed block is duplicated: the seed branch of
`reseedCore` and the seed branch of `runBuildOrSeed` are a verbatim
duplicate (status, reconcile, changed count, meta write, notification,
watcher start, `ReadyInfo` with `justSeeded`).

## Goals

- Locality: each protocol lives in one internal module. A change to the
  marker protocol must not require reading the state machine, and the
  reverse.
- Depth is preserved: `CodegraphSession` keeps its current interface.
  Callers and tests cross the same seam as today.
- Delete the duplicated post-seed / post-build block.
- New unit tests target the extracted modules directly, without a full
  index build.

## Non-goals

- No change to the public interface of `CodegraphSession`.
- No change to the library adapter seam (spec 0003).
- No change to the runtime compatibility stack (spec 0002).
- No change to behavior, file formats, timing, or user-facing text.

## Target design

Three new internal modules. Names are proposals; the design conversation
settles them. All are internal to the extension's implementation: they are
not part of the extension's interface.

### marker module

Owns the cross-process build marker contract:

- The marker file format (`pi-codegraph-build.json`: pid, startedAt, mode
  `build` | `seed`).
- Read, write, clear.
- Peer liveness: is the marker's pid alive in this process or another.
- The wait loop: block while a live peer builds, adopt on a dead marker,
  fail on timeout. Takes a status notifier and the timeout as inputs so the
  module stays free of session state.

The `MARKER_NAME` export moves here. Tests that simulate a peer build
(`tests/codegraph/prompt.test.ts` today writes raw marker JSON and spawns a
`sleep` process) use this module's writer instead of re-stating the format.

### watcher module

Owns the watcher policy:

- Disabled reasons: `CODEGRAPH_NO_WATCH=1`, WSL2 `/mnt` drive detection.
- Watcher start with the current options (debounce 1000 ms).
- Degradation handling: thrown start, `onDegraded` callback, the
  `getWatcherDegradedReason` fallback.
- The sync-complete callback, which writes the meta record through the
  index-meta module.

Returns the `WatcherState` (`active` | `degraded` | `disabled` | `off`) plus
the reason. The session keeps the per-instance state field.

### index-meta module

Owns the per-Index meta file:

- The `Meta` shape and `pi-codegraph-meta.json` location.
- Read (missing file is an empty record).
- Write is advisory: failures are swallowed, never failing a query.
- Record updates: seed record (`seedSource`, `seededAt`), reconcile record
  (`lastReconcileAt`, `lastReconcileChanged`), seed record removal (the
  rebuild path deletes seed fields).

### Shared post-sync completion

The duplicated block becomes one internal function, used by both the manual
reseed path and the auto create-or-seed path. Inputs: the instance entry,
the seed source, the reconcile result. Effects: meta seed record, the
`seeded:` notification, `firstSyncDone`, watcher start, and the `ReadyInfo`
with `justSeeded`.

`diskStats` stays in the session for this spec. Spec 0003 moves it to the
Index adapter.

## Behavior freeze

These facts are contracts. They move across files but do not change:

- Marker file name, JSON shape, and location under the index directory.
- Meta file name, JSON shape, location.
- Timing constants: lock retry 500 ms, lock timeout 10 min, build wait
  timeout 30 min, sync retry (2 attempts, 750 ms ramp), wait poll 300 ms.
- `notifyOnce` keys: `unsafe-root:`, `seeded:`, `build-failed:`,
  `build-wait-timeout:`, `sync-failed:`, `watcher-disabled:`,
  `watcher-degraded:`. Deduplication depends on them.
- All notification message text.
- Loader compatibility: the modules must load under jiti (Node), tsx, bun,
  and vitest, as the extension files do today.

## Tests

Survive unchanged (they cross the public interface):

- `tests/codegraph/session.test.ts` - the state machine, seed, rebuild,
  uninit, cross-process cases.
- `tests/codegraph/prompt.test.ts` - the prompt note gate. Updated to use
  the marker module's writer where it today hand-writes marker JSON.
- `tests/codegraph/tools.test.ts`, `tests/codegraph/staleness.test.ts` -
  rendering and staleness, unaffected.

New, fast, no full index build required:

- Marker module: write/read/clear round trip; a dead pid (a pid that does
  not exist) reads as dead; a live pid (this process or a spawned process)
  reads as live; the wait loop returns on marker removal and on peer death,
  and fails on timeout with a short injected timeout.
- Index-meta module: missing file reads as empty; write/read round trip;
  advisory write failure does not throw; seed record set then removed.
- Watcher module: `CODEGRAPH_NO_WATCH=1` yields `disabled` with the
  documented reason; WSL detection via the documented env signals.

## Migration steps

1. Extract the index-meta module (pure file I/O, no dependencies on the
   class).
2. Extract the marker module (needs only fs, the pid liveness check, and a
   notifier callback).
3. Extract the watcher module (needs the meta module for the sync-complete
   write).
4. Replace the duplicated post-seed block with the shared function.
5. Move `MARKER_NAME` to the marker module; update the test import.
6. Run the full suite; the behavior freeze above is the acceptance check.

Each step is a pure move: the diff should show moved code, not rewritten
code. A step that requires rewriting logic is a signal the seam is in the
wrong place.

## Ordering

Independent of specs 0002 and 0003. Recommended first: it is the largest
module and the other two are cheaper once the session's internals are local.

## ADR alignment

No conflict. ADR-0001 (in-process embed) and ADR-0002 (per-worktree index,
seeded from a sibling) are untouched: the Seed path, the Reconcile
semantics, and the sibling preference are unchanged. The cross-process
safety model (per-root file lock, build marker, in-flight dedup) is
preserved; only the location of its code changes.
