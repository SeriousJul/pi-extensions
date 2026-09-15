# Usage reports are derived from session files, not a stored index

pi already records complete usage on every assistant message, tool result
that did nested LLM work, and compaction entry in the session JSONL files.
Every Usage report is therefore derived on demand by a Usage scan over those
files, and the extension keeps no live log or stored aggregate.

## Considered options

- **Live append log written by the extension while sessions run.** Faster,
  but a second source of truth that misses events pi recorded without the
  extension (or on another machine) and drifts from the session files it
  would duplicate.
- **Stored index rebuilt incrementally.** The same duplication problem, plus
  a cache to invalidate.

## Consequences

- A report is always complete and consistent with what pi shows per session,
  even for sessions that predate the extension.
- Every report pays a full scan. At about 900 MB of session data the scan
  takes roughly 1.5 seconds, which is the accepted price for a single source
  of truth. If that ever stops being cheap, the scan is the thing to
  optimize, not to replace.
