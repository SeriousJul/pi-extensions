# The Safe branch summary extension is dropped

The operator asked to remove the Safe branch summary extension. It
replaced pi's built-in branch summarizer on `/tree` navigation and
budgeted the summary request against the Effective window divided by the
Inflation factor, degrading to a soft-skip when nothing fitted, so a
code-heavy branch no longer died with `exceed_context_size_error`. The
operator no longer wants the replacement: pi's built-in branch
summarizer handles navigation again.

Dropped: the extension (`extensions/safe-branch-summary/`), its docs
page, its tests, and the `e2e:safe-branch-summary` manifest script.
Moved: the Effective window and Inflation factor glossary terms that
lived in the extension's section now live in the Output limits section,
which with Output starvation still uses both.

This ADR supersedes [ADR 0025](/adr/0025-safe-branch-summary-replaces-the-built-in). The
superseded file stays in the index, marked superseded, as the record of
why that design was made and what it guaranteed.

## Consequences

- `/tree` navigation falls back to pi's built-in branch summarizer: its
  summary request is no longer budgeted against the window, so a
  code-heavy branch can again die with `exceed_context_size_error`.
- The operator's pi carries no safe-branch-summary exclusion or setting
  to remove; the extension read only its own `safeBranchSummary`
  section, which the operator does not set.
- Output limits and Output starvation keep their `inflation` settings;
  the shared default (2.0) loses its third reader, and the Inflation
  factor glossary term now names the two that remain.
