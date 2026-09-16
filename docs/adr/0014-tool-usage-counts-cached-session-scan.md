# Tool usage counts are derived from a session scan with a per-file stat-keyed cache

/ctx shows how often each tool was called, so the token cost of a tool can
be weighed against its use. The session JSONL files already record every
tool call (a `toolCall` item inside an assistant message), so the counts are
derived from the session files: the same source of truth as the Usage scan.
A forked session copies its ancestor's lines byte-identical, so a line
counts once per distinct line (ADR 0009).

Unlike the Usage report (ADR 0008: no stored aggregate, every report pays a
full scan), the tool usage scan keeps a per-file cache keyed on mtime and
size. /ctx opens interactively: the dialog must render while the scan runs,
and a window switch (30d, 90d, all) must not re-scan. The cache stores, per
file, the all-time counts, the `(ts, tool)` events inside the newest 90
days, and the hashes of the lines that carried a tool call (the dedupe keys,
surviving across scan passes so a fork never double-counts after a restart).

The cache is a pure function of the session files. Every entry is invalid
the moment its file's mtime or size changes, a file that leaves the tree
drops its entry, and deleting the cache file costs exactly one re-scan. It
never decides a count on its own, so it is a cache in the strict sense,
not a second source of truth. It lives at
`~/.pi/agent/tool-usage-cache.json`, next to (never inside) the sessions
tree, and `PI_TOOL_USAGE_CACHE` points it elsewhere.

## Considered options

- **No cache, a full scan on every open (ADR 0008's rule).** Correct and
  simple, but every first open stalls the dialog for the scan's duration
  (about 2.5 seconds at 900 MB of sessions) and every window switch would
  re-scan. The dialog renders a counting state while the scan runs, which
  masks the first scan; the cache then makes all later opens and switches
  near instant.
- **A live append ledger written by the extension while sessions run.**
  Instant reads, but a second source of truth that misses calls made in
  sessions the extension did not watch (other machines, the extension
  disabled) and drifts from the session files. The codegraph Usage log is
  different: it records facts the session files do not carry (outcome,
  duration, result size) for the index that owns it.

## Consequences

- The first /ctx after a cache miss pays a full scan (about 2.5 seconds at
  900 MB) in the background; the dialog shows the counting state. Every
  later open is near instant, and switching windows is a filter on cached
  events.
- A count is complete for the sessions present on this machine. The scan
  sees only the local sessions tree, same as the Usage scan.
- If pi ever stops writing `toolCall` items to the session files, the
  counts silently go to zero; the e2e on a fixture session tree guards the
  shape.
