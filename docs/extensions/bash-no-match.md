# bash-no-match extension

Returns a no-match search to the agent as a normal result instead of an
error (ticket #113).

pi's bash tool merges stdout and stderr into one stream and marks every
non-zero exit as an error. For a search command, exit 1 with an empty
stream is the normal "no lines matched" outcome, not a failure - and the
error flag costs a small local model a recovery turn on a result that needs
no recovery. The extension rewrites exactly that one case and nothing
wider: in measured sessions, 55 of 86 no-output exit-1 bash errors were
search no-matches, and the rewrite covers all of them.

## Behavior

- On every bash tool result, the classifier checks the (exit code, result
  text, command) triple. It rewrites only when all three hold:
  - the result text is the no-output marker with the exit code line, byte
    for byte: `(no output)\n\nCommand exited with code 1`. The marker alone
    proves both streams were empty, so any preceding segment that printed
    output disqualifies the command by itself;
  - the exit code line says 1. Exit 2 and every other code stay errors,
    which also keeps the 7 observed exit-2 cases as errors;
  - the first word of the last `&&` segment of the command is a search
    command: `rg`, `grep`, `egrep`, or `fgrep`. A single command is a
    one-segment chain.
- The rewrite keeps the stock marker and exit line, appends one "(no
  matches)" note, and clears the error flag. The rewritten result stays
  under 100 bytes.
- Never rewritten: `;` lists, subshells, `ls` (the observed `ls` failures
  carried error messages and were real errors), commands with any output,
  and every exit code other than 1. A failing `cargo test` keeps its error
  status and its stock text, byte for byte.
- No extension writes files, re-issues tool calls, or alters commands in
  flight.

## How it works

The decision lives in the engine-free classifier
(`extensions/bash-no-match/core.ts`): a pure function over the
(exit code, result text, command) triple, unit-tested on the observed
failure shapes. The pi wiring (`index.ts`) is one `tool_result` hook scoped
to the bash tool: it extracts the exit code from the result text and the
command from the call input, and returns the classifier's rewrite or
nothing.

Ordering with the output-limits extension: the two hooks do not interact in
either order. This module is a separate extension, not output-limits, and
the rewritten result is under 100 bytes, so the output-limits bound (which
cuts only oversized results) never touches it; this hook fires only on the
39-byte no-output marker, a result output-limits passes through untouched.

Out of scope (ticket #113): `kill`/`pkill` no-match rewriting. They are
legitimate exit-1-with-no-output cases, but a wider masking surface;
revisit if the data says so.
