# Dependency indexes build on first query, with streamed progress

ADR 0003 gave every tool a `projectRoot` and, on the measured build cost
(1.3 s for 390 files, 2.4 s for 1 218 files), gave a Dependency source no
watcher and no prewarm. Three promises went unkept around that decision. The
note's `projectRoot` line never said the first call builds and waits. The cold
call streamed no progress, because the handlers ignore the update callback, so
a building call looks like a hang to a human and like a failure risk to a model.
And the operator's global instruction claimed "each cache directory is indexed
by codegraph", which the machine did not do: on 2026-09-16 the cache held
795 MB of dependency trees and zero indexes. The data matched the gap: 314
`opensrc path` calls and 987 other opensrc bash calls across about 15
dependencies, but 15 `projectRoot` calls in the same period, all against one
dependency. The agent had learned to grep.

## The decision

- A `projectRoot` call on a tree with no index builds the index inline and
  waits for it. This was already the behavior; it is now the stated contract,
  and a call that starts a build always finishes it.
- The build streams progress through the tool's update callback (file counts,
  as the adapter reports them), so the wait is visible and bounded instead of
  silent.
- The note's `projectRoot` line gains one static sentence: the first call to a
  dependency builds its index and may wait. The note carries no per-dependency
  state, so the system prompt stays stable and the provider cache stays warm.
- The operator instruction changes from "each cache directory is indexed" to
  "a dependency is indexed on first use; the first codegraph call may wait for
  the build". The promise and the machine now agree.
- There is no prewarm and no background build state for a dependency tree.

## Considered Options

- **Prewarm on bash reference** - watch bash commands, detect `opensrc path`
  or a cache path, start the build in the background. Rejected. It adds a
  second trigger to parse and maintain, and the price of lazy is a 1.3-2.4 s
  build paid by the one agent that actually asks the question.
- **Index the whole cache on session start** - 33 trees, 795 MB, a first pass
  of minutes and 3-5x disk per ADR 0003's measurement. Rejected. It indexes
  dependencies no running work uses, from every session on the machine.
- **Time out the cold call** - fail after a cap with "still building, retry
  later". Rejected. It forces the build to outlive the call in a background
  state, which is a prewarm by another name. A build is bounded in seconds;
  the simpler contract is that the call finishes.

## Consequences

- After a cache update, the first agent to query a dependency waits one build
  (seconds); every other agent, and every later call, pays the reconcile
  (about 22 ms per 1 000 files per ADR 0003). The DB lives in the cache tree,
  so the cost is shared machine-wide per update cycle. Racing builds converge:
  the library runs WAL with `busy_timeout` set first, and the reconcile
  re-extracts only what changed.
- The note line appears only when a Trusted root exists, as ADR 0003 set it;
  the new sentence rides on that existing bound.
- The review metric for this decision is the ratio the analysis used: opensrc
  references against `projectRoot` calls. If the ratio does not move after the
  note and the progress stream land, the problem is the note's wording, not
  the warm-up, and the next change is to the sentence, not to the machinery.
