# Pruning engagement is sticky for the session

The first level of the two-level context control engages on a per-request
check of the usage-backed context estimate against pi's own compaction
threshold (`contextWindow - reserveTokens`). The estimate anchors on the last
assistant usage. Once the estimate crosses the threshold the request goes out
pruned, and the pruned request reports the smaller pruned usage. The next
request's estimate then drops back below the threshold, so a stateless check
lets that request go out raw, whose larger usage pushes the next estimate back
above the threshold, and so on: pruned and raw requests alternate for the rest
of the session, the outgoing prefix switches shape on every request, and every
switch invalidates the provider's prompt cache (a full re-bill of the whole
context). The intended steady state - every request pruned, one stable prefix,
cache hits - is never reached.

Engagement is made sticky per session. The state machine keeps one boolean:
once the estimate crosses the threshold it engages, and it stays engaged on
every later request until a reset event, regardless of where the estimate
sits. The prefix switches to the pruned shape exactly once, pays one cache
miss, and every later request hits the cache on the stable pruned prefix. A
reset event is a compaction that runs (the raw size drops, so the session may
run raw again until it re-crosses) or a session start. Crossing the threshold
always wins over the carried state, so a session still above the threshold
right after a compaction re-engages at once. The step is a small pure function
(previous state, estimate, threshold, reset event in; state out), held in the
wiring's session state, so the transition is table-testable without a pi
runtime.

This refines ADR 0011, whose "cost accepted" describes the pruning state as a
pure function of the current messages and thresholds. What stays a pure
function is the projection: which outputs are replaced by markers, re-derived
on every request, idempotent, and never written to the session file. What
becomes session state is only the engagement decision - whether to run the
pass at all - which is now sticky across requests until a reset. The session
file is still the only store and is still never modified.

Rejected alternatives: anchoring the estimate on the raw session size instead
of the last usage reaches the same steady state but with more machinery, and
the raw size never comes back below the threshold once it has crossed, so the
extra state would buy nothing. Keeping the check stateless and accepting the
flap was the original behavior; it costs a full cache miss on every other
request for the rest of the session, which is the defect this decision fixes.

Cost accepted: the engagement decision carries one boolean of session state,
so a request that is below the threshold but still sticky re-runs the pruning
pass and re-derives the same pruned prefix - the same work a crossing request
does, and idempotent. A manual `/compact` or an overflow recovery resets the
flag, so a session the operator shrinks by hand can run raw again from that
point on.
