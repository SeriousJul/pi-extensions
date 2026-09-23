# Safe branch summary extension

Writes the branch summary on `/tree` navigation in place of pi's built-in
summarizer, budgeting the request so it fits the window the server serves.

pi budgets the built-in branch summary request at `contextWindow -
reserveTokens`, measured in its own chars/4 estimate. Code-heavy branches
tokenize up to about 1.85x denser than that estimate, so a branch that fits
the budget still overflows the window the server serves: the request is
rejected with `exceed_context_size_error`, the navigation dies, and no
summary is written.

## Behavior

- On every summarized `/tree` navigation, the extension writes the summary
  itself. The budget for the branch content is the Effective window minus
  pi's own `branchSummary.reserveTokens`, divided by the Inflation factor
  (default 2.0), so the worst-case tokenization of code content still fits
  the window.
- The summary request is standalone: the system prompt, the branch prompt,
  and the preamble are verbatim copies of pi 0.86.1, so the written summary
  has the same structure as the built-in's. The output is capped at 4096
  tokens, and the usage of the request is recorded on the summary entry.
- The read and modified file sections come from the summarized content,
  including the file lists carried by nested branch summaries.
- When the summary cannot be written (the window is at or below the
  reserve margin, the request fails, the response is not usable, or the
  branch has nothing that fits), the navigation degrades to a Soft-skip: it
  completes without a branch summary entry, with a notice. The abandoned
  branch stays reachable through `/tree`.
- A user abort cancels the navigation, the same as the built-in.
- With the extension disabled in settings, pi's built-in summarizer runs
  instead, unchanged.

## Settings

Both keys go in `settings.json` (project overrides global, per pi's usual
merge):

| Key | Default | Meaning |
| --- | --- | --- |
| `safeBranchSummary.enabled` | `true` | `false` hands summarized navigation back to pi's built-in summarizer. |
| `safeBranchSummary.inflationFactor` | `2.0` | The Inflation factor: how many estimated tokens one real token is budgeted for. Raise it for denser content (CJK, heavy symbol names); lower it to keep more branch content per summary. |

The reserve margin is pi's own `branchSummary.reserveTokens` (default
16384); the extension reads it from the same settings and does not add a
second margin.

## How it works

The decision logic lives in the engine-free core module
(`extensions/safe-branch-summary/core.ts`): the budget math, the selection
of the branch content, and the prompt assembly. The pi wiring (`index.ts`)
registers one handler on the before-tree event and supplies the real
dependencies (settings, the session's model, the model registry
completion). The prompts (`prompts.ts`) are verbatim copies of pi 0.86.1,
pinned by their source version.
See [ADR 0025](/adr/0025-safe-branch-summary-replaces-the-built-in).

## Limitations

Content denser than 2 chars per token (for example CJK) is not covered by
the default factor 2.0 and can still overflow the window; the Soft-skip
then degrades the navigation to summary-less instead of failing it. If pi
changes its branch summary prompts, the copies drift silently: the format
stays model-readable, and the extension keeps working.
