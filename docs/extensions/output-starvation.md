# Output-starvation guard extension

Refuses a request whose output budget has collapsed to pi's floor.

pi's output clamp computes the Effective window minus the context estimate
minus a safety margin, and floors the result at its own minimum. Any estimate
over the window minus that margin saturates the clamp: the payload goes out
carrying the floor as its max tokens, the provider answers a one-token
non-answer, and the transcript records `stopReason: "length"`. That state is
Output starvation, and a starved request is a failure, not a request.

## Behavior

- On every provider request, the guard reads the payload pi has already built.
  When the payload's budget is pi's saturated floor, it refuses: one report
  line and the run's abort. The provider is never contacted, the turn ends
  aborted instead of a one-token `length` answer, and pi never retries an
  abort.
- The refusal is at most once per turn. The flag resets on every turn start,
  so a refusal can never become a retry storm.
- A healthy budget - however small - goes out untouched, and the guard says
  nothing.
- The report line names provider, model, the context estimate, the Effective
  window, and the budget pi computed:
  - `output starvation: refused (llama.cpp/m1): context estimate 13757, Effective window 16000, output budget 1`

The estimate is pi's own estimator over the session projection, so the line
names the figure that collapsed the budget. A failure to compute it degrades to
0 in the line; the trigger is the payload, never the estimate.

## How it works

The decision lives in the engine-free core module
(`extensions/output-starvation/guard.ts`): the trigger is the payload's budget
compared to pi's floor, read back from pi's own clamp, and the one place the
report line exists. The pi wiring (`index.ts`) only binds the
`before_provider_request`, `turn_start`, and `session_start` events and owns
the refusal. The guard registers no compaction hook, so it cannot stand in the
way of a compaction that would rescue the session, and it never touches the
window, which stays Llama refresh's ownership.
See [ADR 0028](/adr/0028-output-starvation-guard-refuses-a-collapsed-output-budget).
