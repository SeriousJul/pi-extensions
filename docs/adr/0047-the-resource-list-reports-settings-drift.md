# The resource list reports settings drift

Settings express intent: the resource arrays, the package filters, the
extension-named keys. When a line does nothing, the intent dies silently:
the user's model-router sat disabled by the package filter with a full
fallback list and wait budget under its settings key, and the drift was
found by hand in a retrospective over 12 weeks of sessions. The sibling
drop of pruning, compress, and quota (ADR 0046) left the user's settings
with package-filter entries naming files pi no longer loads. The unmet need
is not toggling - the state commands show zero recorded use in the same
corpus - it is knowing when the settings lie.

resource-toggle already owns the Toggle state of every resource: it
resolves the whole resource catalog and reads both raw settings documents
on every command. We decided: the drift check is part of the extension's
job. A new pure module inside resource-toggle computes the findings from
the raw settings documents and the resolved catalog, and the findings
render as a read-only Drift group at the top of the interactive list, as a
section of the headless tables and the `resource_toggle` tool output, and
as one session-start notice when the findings are non-empty. Clean
settings produce no group and no notice.

v1 reports exactly three classes:

- **Stale entry**: an override pattern in a settings resource array, or
  any entry of a package filter, whose target matches no loaded resource
  and, where it resolves to a file path, names no file on disk. The
  matching uses the state machine's own pattern rules, resolved against
  the entry's base (the scope base for a resource-array entry, the
  package root for a filter entry), so a line pi ignores is what gets
  named.
- **Conflicting entries**: two entries in one array with the same target
  and opposite polarity, one force-including the resource the other
  force-excludes.
- **Configured while disabled**: an extension disabled in the effective
  view while a top-level settings key equal to its name in camelCase
  (`model-router` to `modelRouter`, single-word names to themselves)
  exists in a settings document. The key match is a name guess, not
  proof, so the finding is flagged possible: first-party extensions that
  break the convention degrade to this soft finding, and a settings key
  that merely shares a disabled extension's name does not read as a hard
  error.

## Considered Options

- **A check inside resource-toggle (chosen).** The extension already does
  the resolution and reads both raw documents on every command, so the
  check rides on existing seams: no new settings read, no new pi API, one
  pure module testable without a live session. The findings share the
  exact rendering surfaces the user already opens, and the state
  commands, the picker, the Toggle state machine, and the settings write
  path are untouched.
- **A separate extension.** A new extension would redo the resolution or
  reach into resource-toggle's internals, and a second surface reporting
  the same settings would drift from the list. The drift question has one
  answer: what the resource catalog says about the settings files.
- **Pi core diagnostics.** Pi validates the settings format, not resource
  semantics: whether a pattern matches a loaded resource, and which
  top-level keys belong to which extension, are questions only the
  resolver plus the catalog can answer.

## Consequences

- The resolution carries the raw settings documents (not just the
  resource arrays) so the soft class can read the extension-named keys
  without a new settings read.
- An untrusted project covers the global scope only, matching what the
  rest of the resource view can read: the project file is unreadable, and
  its entries and keys are not findings.
- The camelCase heuristic is exact on the mapped name. Until a v2
  settings-key registry lets extensions declare the keys they read, a
  finding of this class stays possible: a registry would turn possible
  findings into definitive ones and surface the orphaned keys of deleted
  extensions, which v1 does not name.
- Findings are deduplicated and sorted by class, scope, then text, so the
  notice and the tables are stable across runs and modes. Each finding
  names its scope - global, project, or the package source - so the fix
  lands in the right file.
- The session-start notice fires once per pi process and points at
  /resources. The check names the drift; deleting the line is the user's
  edit. An in-session fix action is a v2 question.
- Pi core settings unrelated to resources (compaction, theme, model
  blocks) are not checked: only resource arrays, package filters, and
  extension-named keys are in scope.
