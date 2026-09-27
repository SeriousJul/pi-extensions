# Output-starvation guard refuses a collapsed output budget

ADR 0027 heals a wrong window, but a window - right or wrong - is not the only
way a request's output budget collapses to pi's floor. pi's
`clampMaxTokensToContext` computes `contextWindow - estimateContextTokens(context)
- 4096` and floors the result at `MIN_MAX_TOKENS = 1`. Any estimate over the
window minus 4096 saturates the clamp, whatever the window is: a stale provider
usage that outlived the content it described, a context that grew past the
window between compactions, a model whose max output is the floor itself. The
incident this guards is the ADR 0027 session (window 40192, estimate over-full,
`max_tokens: 1` on the wire, one thinking token back, `stopReason: "length"`,
repeated every turn), but the guard keys on the clamp, not on that incident, so
no route to a collapsed budget is left unguarded. The guard's name for the
state is Output starvation.

The guard reads the payload pi has already built in the `before_provider_request`
hook and refuses the request when the payload's budget is pi's saturated floor.
The trigger is keyed on pi's clamp saturating, not on a threshold this repo
chooses: the payload's budget is compared to `PI_OUTPUT_FLOOR`, read back from
pi's own clamp through the branch that returns `max(MIN_MAX_TOKENS, maxTokens)`
(a non-positive window, an empty context, and maxTokens 1 leave exactly the
floor). pi-ai keeps the constant module-private, so the read-back is the
contract: if pi moves the floor, this one expression moves with it, and the
unit test that pins the current value (1) is the tripwire. A token threshold
invented here would silently disagree with pi whenever pi's arithmetic moves.

The refusal is one report line and the run's own abort, because that is the
loudest refusal the hook can express. pi's `before_provider_request` handler may
inspect and replace the payload, and it cannot stop the request: the extension
runner swallows a thrown handler, reports it as an `extension_error`, and sends
the last good payload. Raising the budget upward is refused by design; it would
trade the garbage turn for a provider error the user cannot read, which is the
same failure mode with a different sound. The abort kills the request on the
already-aborted signal before any byte leaves the process, the turn ends as an
abort instead of a one-token `length` answer, and pi never retries an abort.
The line names the facts, one line, in the glossary's vocabulary:
`output starvation: refused (llama.cpp/m1): context estimate 13757, Effective
window 16000, output budget 1`. The estimate is pi's own estimator over the
session projection, so the line names the figure that collapsed the budget.

The budget of the guard itself: at most one refusal per turn. The flag resets
on every `turn_start` and on `session_start`, so a refusal can never become a
retry storm and nothing survives a model selection. The guard reads a payload
that already exists, adds no per-turn network call, never rewrites a budget,
and never touches the window, which stays Llama refresh's ownership. It is a
separate module from llama-refresh and it changes nothing about the pruning
gate.

The e2e against the shared mock router proved the behavior end to end and
recorded the compaction visibility the spec asks for. A healthy turn goes out
untouched with a real budget (9972 at window 16000) and the guard says nothing.
A starved turn is refused verbatim, the provider is never contacted, and the
turn ends aborted, never `length`. The next starved turn gets its own single
refusal, once per turn, no storm. With auto-compaction on, a stale-usage
session is compacted on load and the first request goes out with a healthy
budget, so the guard stays silent: compaction still rescues when it is enabled,
and the guard registers no compaction hook, so it cannot stand in the way. With
Pruning loaded on the same stale session, the first level stays out (the
resumed session's runtime system prompt breaks Pruning's entry alignment) and
the request is still starved on the usage the clamp reads, so the guard
refuses: a layer that prunes the outgoing context cannot undo the usage pi's
estimate reads.

One finding the e2e forced into the open: in the starved runs, pi's compaction
never fired, so the pruning gate got no chance to cancel anything. The
pre-request compaction check runs only at a next-turn boundary inside a run
(`prepareNextTurnWithContext`, and only when a turn has completed), never on a
fresh prompt, and a refused turn completes nothing. A starved session therefore
cannot reach the compaction that would end it, and the gate's protection is
vacuous in exactly the state where it is needed. Whether that is the silence
ADR 0027 recorded (its failing session never compacted) cannot be settled from
this repro, because the mock's fixed small usage means no completed turn can
carry a stale anchor, so the gate-cancels-compaction band (pruned character
estimate at or under window minus twice the reserve while the usage-based
estimate is over window minus 4096) is argued from pi's source here, not
observed. It is recorded, not fixed: a third ticket, only if the gate's decision
criterion is ever changed to see the saturation it currently cannot.

Three pi facts stand behind the design (pi 0.87.1). First, the live-catalog
window is cached with no TTL or invalidation when the server relaunches, so a
right window today is not a right window tomorrow (ADR 0027 owns that one).
Second, the output clamp floors at 1 token, so a collapsed budget is a silent
non-answer, not an error: nothing upstream reports the state, which is why the
report line exists here. Third, pi's projected-context estimate
(`estimateProjectedContextTokens` in pi-coding-agent's compaction) does not
trust a usage captured before a later `context_edit` or compaction entry, and a
failed recovery writes such an edit, so the usage-backed estimate the threshold
check reads can fall back to the character estimate of a much smaller context
and miss the very compaction that would end the starvation.

**Considered options**: a repo-chosen token threshold (refuse when the budget is
under N tokens) - rejected because it invents a second truth about pi's
arithmetic and silently disagrees whenever pi's floor or its 4096 safety margin
moves; the spec's user story 9 names this trade-off directly. Rewriting the
budget in the hook - rejected because raising it trades the non-answer for an
unreadable provider error, and lowering it changes nothing (the payload already
carries the floor). A `session_before_compact` gate change so the pruning gate
sees the saturation - rejected out of scope: it is a separate ticket and the
gate is another extension's decision. An upstream pi fix (a real refusal or a
reported floor) - deliberately not pursued, so the extension carries the whole
burden, as ADR 0027 already decided for the window.

**Consequences**: a starved request costs one line and an aborted turn instead
of a one-token answer and a confused agent. The transcript records `aborted`,
so a human can tell the guard spoke from a provider failure. At most one
refusal per turn bounds the cost to the line itself. The guard can refuse a
request that pi's own arithmetic would have called legal for a model whose max
output is 1 on a healthy context; the spec accepts that trade-off, because the
floor is the floor and the answer would be a non-answer either way. Nothing
goes upstream.
