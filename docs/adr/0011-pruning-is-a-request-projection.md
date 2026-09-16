# Pruning is a request-level projection; the session file is the store

The pruning extension shrinks large tool outputs out of the active context
when the context nears `ctx - reserveTokens`, and defers to pi's native
compaction when pruning cannot free enough headroom (the prune gate). pi's
session file is an append-only tree and a compaction entry can only replace
a whole span with one summary, so pruning cannot persist per-output
shrinking into the session. Instead, pruning is a projection re-derived
every turn in the `context` hook: the request sees a file pointer or a shell
summary, and the session file keeps the full outputs as the only store. The
recall tool resolves a recall reference (session file line number, entry id
when the session is ephemeral) back to the full output.

Rejected alternatives: sidecar offload files next to the session duplicate
the data and need a cleanup policy; freezing the omission list in a
compaction entry's `details` (the pi-blackhole approach) ties pruning to
compaction events, while our trigger is a threshold evaluated every turn.

Cost accepted: the pruning projection is a pure function of the current
messages and thresholds, recomputed on every request, and the session file
keeps the full outputs and grows accordingly. (The engagement decision -
whether to run the pass at all - is session state that sticks until a reset,
not a pure function of the current request. ADR 0018.)
