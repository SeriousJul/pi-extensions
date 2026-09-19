# Edit assist corrects failing edit calls by mutating tool input, never writing files

The built-in edit tool fails about one call in seven in measured sessions
(14.5 percent of 12,545 calls over 7.5 weeks; 12.7 percent in the last week
of measurement). Three quarters of the failures are no-match: the model
re-typed a multi-line oldText from memory with a small error, most often a
leading-whitespace difference. The stock error message says nothing about
where the text is or what differs, so the model spends two extra round trips
recovering: a re-read or grep to learn the file's real text, then a retry.

Edit assist corrects this with two hooks around the built-in tool. Before
execution, a `tool_call` hook reads the file and, for each edit that does not
exact-match, runs an Extended match: pi's fuzzy normalization plus
leading-whitespace-insensitive comparison. When the match is unique and the
raw difference is a Whitespace-only diff, the hook rewrites that edit's
oldText to the file's actual text in `event.input`, which pi documents as
mutable in place. The built-in tool then executes the corrected input and
exact-matches it by construction, so the session records a successful edit.
After execution, a `tool_result` hook appends a bounded Diagnosis to the
error of every call that still fails (nearest-region diff for no-match,
occurrence list for ambiguous, one targeted hint for validation errors) and
adds one honesty line to the success of a corrected call. pi skips the
`tool_result` hook for validation failures: the call never executes, so no
tool result event fires for it. The validation-error hint therefore rides on
the `message_end` event of the toolResult message instead; every other
Diagnosis, including the ambiguous occurrence list, rides on `tool_result`
as described.

The governing invariant: the extension never writes a file. Every write goes
through the built-in tool, under pi's per-path file-mutation queue, so a
correction can never race a parallel edit or write to the same path, and the
transcript, the TUI diff, and the file bookkeeping all agree.

Rejected alternatives. Writing the file from inside the `tool_result`
handler (report plus auto-apply): the handler runs outside the file-mutation
queue, so a handler write can race a parallel call to the same path, and the
transcript would show a failed tool call next to a changed file. Report-only:
safe, but it leaves the retry round trip on the table; 61 percent of measured
no-match failures fall in the safe Whitespace-only diff class, where the
retry is pure waste. Extending the auto-fix to small character drift (for
example `}),` versus `),`): the model composes its newText against the text
it believed to exist, so a semantic difference risks replacing the wrong
thing silently; those cases get a Diagnosis instead, and the model resends a
corrected oldText. Stale-read detection (flagging a file that changed since
the model's last read): measured incidence is 0.5 percent of no-match
failures, not worth read-tracking state.

Not importing pi's internal matcher (`applyEditsToNormalizedContent` is not
exported from the package): the extension needs only positive knowledge. A
rewritten oldText is the file's real text, so the built-in exact-matches it;
a wrong "no match" verdict is harmless because the hook leaves the input
alone and pi's own exact and fuzzy paths still run.

Costs accepted. Every edit call, including the roughly 85 percent that would
have succeeded, pays one extra file read and one match pass before execution;
files over 300 KB or 20,000 lines skip the hook and run stock. The transcript
of a corrected call shows the model's original arguments with a successful
result; the honesty line in the success text is the bridge. The Diagnosis
enters the model context and is resent on every later call until compaction,
so every block is size-bounded.
