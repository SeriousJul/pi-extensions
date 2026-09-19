# edit-assist extension

Corrects and diagnoses failing edit tool calls around the built-in edit tool
([ADR 0020](/adr/0020-edit-assist-corrects-by-mutating-tool-call-input)).
The built-in edit fails about one call in seven in measured sessions, most
often on a leading-whitespace difference in a re-typed oldText. The
extension fixes the safe cases before execution and diagnoses the rest
after execution. Every output is size-bounded: a Diagnosis re-enters the
model context on every later call until compaction. The extension never
writes a file itself; every write goes through the built-in tool. The stock
error text is always kept; a Diagnosis is appended after it, never
replaces it.

## Behavior

- **Input correction.** A `tool_call` hook reads the target file before the
  built-in edit runs. For each edit whose oldText does not exact-match, it
  runs the Extended match: pi's fuzzy normalization plus a
  leading-whitespace-insensitive comparison. When the match is unique and
  the raw difference is a Whitespace-only diff, the hook replaces that
  edit's oldText with the file's actual text in `event.input`. The
  built-in tool then executes the corrected input, and the success result
  gains one honesty line naming the corrected line, so the transcript
  (which shows the model's original arguments) and the file agree. An
  edit with zero or several Extended matches, or with any character drift,
  is left alone and the built-in's own exact and fuzzy paths still run on
  it.
- **No-match Diagnosis.** A `tool_result` hook scoped to the edit tool
  reacts to the stock no-match errors (`Could not find the exact text in
  ...` and `Could not find edits[i] in ...`). One block per edit the
  built-in could not find with its exact or fuzzy step - including an edit
  that reaches only the Extended match, which the built-in does not apply,
  so a leading-whitespace drift that was never corrected (several Extended
  matches) still fails and still gets a Diagnosis. Each block names the
  Nearest region line range (a trailing newline does not start a new line,
  so the range never names a line past the end of the file), states a
  Whitespace-only difference explicitly when the only difference is leading
  whitespace on the same line count, and carries the unified diff between
  the oldText and the region's real text. When no part of the file
  resembles the oldText, the block says `No candidate region`.
- **Ambiguous Diagnosis.** When the oldText matched the file in several
  places, the stock error is kept and the occurrence line numbers are
  appended, max 10, each with one context line. The extension re-derives
  the occurrence set and gives up (stock error only) when the file no
  longer reproduces the stock count.
- **Malformed-argument hint.** A call that fails argument validation never
  executes, so pi fires no `tool_result` hook for it. The hint rides on the
  `message_end` event of the toolResult message instead: a read-tool-shaped
  call (path with offset and limit, no edits) is told to use the read
  tool, and an edits value sent as a string gets a shape hint. Any other
  malformed shape is left unchanged.
- **Size bounds.** One no-match diff is capped at 40 lines and 1200
  characters; a longer diff is cut and marked `... (diff truncated)`.
  Diff inputs longer than 300 lines per side are head-capped before the
  diff runs. A file window below a 0.5 line-similarity score is not a
  candidate region.
- **Large-file guard.** Files over 300 KB or 20,000 lines run stock: the
  built-in's behavior stands alone. A file exactly at either limit still
  gets the Diagnosis; the trailing newline of a normal file does not count
  as a line.
- **Off switch.** The extension is on by default; disabled, the built-in
  edit tool runs stock: no correction, no honesty note, no Diagnosis, no
  hint.

## Settings

The `edit-assist` section of `settings.json`. The project
`<cwd>/.pi/settings.json` overrides the global settings file, key by key.

| Key       | Type      | Default | Meaning                                                        |
| --------- | --------- | ------- | -------------------------------------------------------------- |
| `enabled` | `boolean` | `true`  | Enable the whole extension; disabled runs the built-in stock.   |

Example:

```json
{
  "edit-assist": {
    "enabled": false
  }
}
```

A malformed value falls back to its default and is reported with one startup
notification per error.

## How it works

- **Seam.** The decision logic lives in `core.ts`, which is engine-free
  (matching, region search, diffing, formatting) and fully unit-tested
  against fixtures extracted from real pi sessions. `settings.ts` reads
  the settings section. `index.ts` is the thin pi wiring around the
  `tool_call`, `tool_result`, and `message_end` hooks.
- **Out of scope.** Extending the input correction beyond the
  Whitespace-only diff class: the model composes its newText against the
  text it believed to exist, so a character drift risks replacing the
  wrong thing silently; those cases get a Diagnosis instead, and the model
  resends a corrected oldText.
