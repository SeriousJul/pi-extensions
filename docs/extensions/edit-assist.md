# edit-assist extension

Corrects and diagnoses failing edit tool calls around the built-in edit tool
([ADR 0020](/adr/0020-edit-assist-corrects-by-mutating-tool-call-input)).
The shipped slice is the no-match Diagnosis. When an edit call fails because
an oldText is not found in the file, the result the model receives keeps the
stock error verbatim and gains one size-bounded Diagnosis per unmatched edit:
the line range of the Nearest region, a unified diff between the model's
oldText and what the file actually holds, and an explicit note when the
difference is a Whitespace-only diff.

## Behavior

- **Trigger.** A `tool_result` hook scoped to the edit tool. Only the stock
  no-match errors (`Could not find ...`) are touched; ambiguous-match,
  empty-oldText, and file-read errors go out unchanged, and a successful edit
  is never touched.
- **The Diagnosis.** One block per edit the built-in could not find with its
  exact or fuzzy step. This includes an edit that reaches only the
  leading-whitespace-insensitive Extended match, which the built-in does not
  apply, so a leading-whitespace drift still fails and still gets a
  Diagnosis. Each block names the Nearest region line range, states a
  Whitespace-only difference explicitly when the only difference is leading
  whitespace on the same line count, and carries the unified diff between the
  oldText and the region's real text. When no part of the file resembles the
  oldText, the block says `No candidate region`.
- **Size bounds.** One diff is capped at 40 lines and 1200 characters; a
  longer diff is cut and marked `... (diff truncated)`. Diff inputs longer
  than 300 lines per side are head-capped before the diff runs. A file window
  below a 0.5 line-similarity score is not a candidate region.
- **Large-file guard.** Files over 300 KB or 20,000 lines run stock: the
  stock error stands alone. A file exactly at either limit still gets the
  Diagnosis; the trailing newline of a normal file does not count as a line.
- **Off switch.** The extension is on by default; disabled, the result is
  the stock error alone.

## Settings

The `edit-assist` section of `settings.json`. The project
`<cwd>/.pi/settings.json` overrides the global settings file, key by key.

| Key       | Type      | Default | Meaning                                     |
| --------- | --------- | ------- | ------------------------------------------- |
| `enabled` | `boolean` | `true`  | Append the Diagnosis to no-match failures.  |

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
  against fixtures extracted from real pi sessions. `settings.ts` reads the
  settings section. `index.ts` is the thin pi wiring.

## Out of scope

Input correction of Whitespace-only edit calls and the Diagnosis for
ambiguous and malformed calls are later slices of ADR 0020.
