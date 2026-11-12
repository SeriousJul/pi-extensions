# The output-limits and output-starvation extensions are dropped

The operator asked to remove both extensions. Output limits bounded a tool
result to a share of the session's headroom and kept the whole result in a
spill file; the output-starvation guard refused a request whose output
budget had collapsed to pi's floor and fitted one the window could not pay
for. The operator no longer wants either protection: pi's own tool-result
cut and its own output clamp are the only bounds a session sees now.

Dropped: the extensions (`extensions/output-limits/`,
`extensions/output-starvation/`), their docs pages, their tests, the
`e2e:output-limits` and `e2e:output-starvation` manifest scripts, the
shared token-math module (`extensions/shared/token-math.ts`) whose only
readers were the two extensions, the `parseNullableCount` helper in the
shared settings module whose only caller was output limits' `maxLines`, and
the mock llama.cpp router (`tests/shared/llama-mock-router.mjs`) that [ADR
0048](/adr/0048-drop-llama-refresh) kept alive for the output-starvation
e2e. Moved: the Effective window glossary term that lived in the Output
limits section now lives in a Context cap section, beside the only
extension that still produces the value.

This ADR supersedes
[ADR 0026](/adr/0026-output-limits-bound-results-in-the-tool-result-hook)
and
[ADR 0028](/adr/0028-output-starvation-guard-refuses-a-collapsed-output-budget).
The superseded files stay in the index, marked superseded, as the record of
why those designs were made and what they guaranteed.

## Consequences

- Tool results are bounded only by pi's own cut (2000 lines or 50KB). The
  whole result no longer survives in a spill file, and no share of the
  session's headroom limits a call.
- A request whose output budget collapses to pi's floor goes out and draws
  a one-token `length` answer; a request the window cannot pay for is
  rejected by the provider before it answers. Nothing refuses or fits it.
- The operator's pi loads the package with nothing to remove: neither
  extension registers a tool, command, or flag, and an `outputLimits` or
  `outputStarvation` section in the settings files simply stops being read.
- The glossary loses the terms Bound, Headroom, Output starvation, Output
  overrun, Reported context, Corrected estimate, Inflation factor, Fit,
  Spill, Ledger, and Admitted text; the Effective window term moves to the
  new Context cap section.
