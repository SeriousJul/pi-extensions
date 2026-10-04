# Output-starvation guard refuses a collapsed output budget

Amended for issue #122; see "Amendment: the guard's second trigger, Output
overrun (issue #122)" below. The rule this ADR stated as "the guard never
rewrites a budget" reads "the guard never *raises* a budget", and the guard
now answers a second state, Output overrun, with a Fit instead of a refusal.
Everything below stands as written, including the reasoning for refusing to
raise a budget.

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
chooses: the payload's budget is compared to `PI_OUTPUT_FLOOR`, pi's floor.
pi-ai keeps the floor (`MIN_MAX_TOKENS`) module-private, and pi's extension
loader aliases only the package entry points - its alias for the pi-ai entry
is a prefix and swallows every pi-ai subpath, so the clamp's own module
cannot be imported from an extension at all. The floor is therefore pinned
to the value pi 0.87.1 gives it (1), and the unit test that pins the
constant against pi's own clamp (run against the npm package, where the
subpath is importable) is the tripwire: if pi moves the floor, that test is
where it shows up. A token threshold invented here would silently disagree
with pi whenever pi's arithmetic moves. The same loader rule applies to the
estimator: the context figure the report line names is computed by a
line-for-line mirror of pi-ai's `estimateContextTokens` (the function pi's
clamp reads), and the unit test compares the mirror against the real
function over fixture sessions, so any divergence from pi's arithmetic fails
the suite.

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
window 16000, output budget 1`. The estimate is the mirror of pi-ai's
estimator (the function pi's clamp reads) over the session projection, so
the line names the figure that collapsed the budget.

The budget of the guard itself: at most one refusal per turn. The flag resets
on every `turn_start` and on `session_start`, so a refusal can never become a
retry storm and nothing survives a model selection. The guard reads a payload
that already exists, adds no per-turn network call, never raises a budget,
and never touches the window, which stays Llama refresh's ownership. It is a
separate module from llama-refresh and it changes nothing about the pruning
gate.

## Amendment: the guard's second trigger, Output overrun (issue #122)

ADR 0028 said the guard never rewrites a budget. It now says the guard never
*raises* a budget, and the difference is a second trigger and a remedy.
Output starvation is a budget that collapsed to pi's floor: the request goes
out and answers nothing. **Output overrun** is the opposite state: the payload
carries an output budget the Effective window cannot pay for on the estimate
the provider's own counting supports, and the provider rejects the whole
request before it answers anything. The guard refuses the first and **Fits**
the second: it lowers the payload's budget to the room the **Corrected
estimate** leaves, and the request goes out and gets answered. The incident
this answers measured window 200,000, Reported context 170,685, budget 32,768
on the wire, and the provider's own rejection: `prompt (170685 tokens) + max
tokens (32768) exceeds the context (200000)`. The session was 29,000 tokens
*under* the window; what did not fit was the prompt plus the budget pi asked
the provider to reserve for the answer.

The Corrected estimate is the figure pi's arithmetic is missing. It anchors at
the **Reported context** - the prompt size the provider itself counted for its
last answer - and adds an Inflation-corrected estimate of everything the
provider has not counted yet. pi's clamp reads a character estimate at four
characters per token; on the incident's 42,721-character tool result the real
tokenizer counted 19,183 tokens where pi counted 10,680, at 2.23 characters
per token. pi's estimate was 8,503 tokens low, and that one figure drove both
guards at once: the compaction threshold stayed uncrossed, and the clamp saw
33,722 tokens of room and left the budget at the model's full ceiling. The
anchor is what makes the correction honest: the provider has already counted
everything up to its answer exactly, and the character rate is what fails on
the content after it. The same Inflation correction Output limits and Safe
branch summary already apply to a tool result, applied to the request.

The guard judges the payload, not the session projection. The payload is the
exact thing going out: its messages, its system prompt, its tool declarations,
and its budget. One finding the implementation forced into the open: pi strips
the usage block on the way out - its provider converts an assistant message to
`{role, content, tool_calls}` - so the payload carries no Reported context to
read. The guard reads it from the session entry pi stored for that answer,
through pi's own anchor rule (the last assistant response whose usage still
describes its prefix), and applies it to the payload; a payload that does
carry its own usage block is judged on that instead. With no anchor at all - a
fresh session that is already large - the whole payload is estimated with the
same correction, tool declarations included.

The Fit is pi's own arithmetic with one better input: `Effective window -
Corrected estimate - pi's safety margin`, floored at pi's floor and never
raised. The margin is pi's `CONTEXT_SAFETY_TOKENS` (4,096), pinned the way
`PI_OUTPUT_FLOOR` is pinned, with the same tripwire test against pi's own
constant; the default minimum answer budget is pi's `MIN_ANSWER_TOKENS`
(1,024), pinned the same way. A figure invented here would silently disagree
with pi whenever pi's arithmetic moves. The Inflation factor (default 2.0, the
default Output limits and Safe branch summary use) and the characters-per-token
figure are settings with the same names those extensions use, in the guard's
own `outputStarvation` section, with an environment escape hatch that turns
the guard off so the operator can compare pi's raw behavior against ours.
The fit is conservative by design: on the incident's figures it lands at about
23,000 tokens where the provider's own error named 29,307 as the largest
budget that would have fit. A Fit cannot cool the provider's prompt cache,
because the budget is a sampling field and not part of the cached prefix.

When the room left cannot hold a real answer, the guard refuses rather than
Fits: a fit under the minimum answer budget is a request the provider will
reject anyway, and a reasoning operator can raise that floor to thinking plus
a usable reply. That branch refuses exactly as the collapsed budget is refused
and is reported with the same line; the figures tell them apart. Output
starvation names pi's floor as the budget. The overrun refusal names the
budget pi chose and a Corrected estimate over the window. Three states stay
three things in the glossary - Output starvation, Output overrun, Overflow -
and the transcript carries two shapes: the fit line and the refusal line.

The per-turn budget changes shape rather than growing. The flag still caps
refusals at one per turn. A Fit is not a refusal: it applies to every request
in the turn, because a retry must not go out with the budget that just failed,
while the notice stays capped at one line per turn. Both flags reset on
`turn_start` and `session_start`, and nothing survives a model selection,
which is what changes the window, the output ceiling, and the reserve.

The reserve disagreement is named, never fixed. pi's compaction reserve
(default 16,384) and a model's output ceiling (32,768 on the incident's model)
are independent settings, and with the reserve below the ceiling pi's own
threshold permits a prompt the provider must reject. The guard reports the
disagreement once per session and names the setting to change
(`compaction.reserveTokens`); it writes no setting it does not own. Raising
the reserve is the operator's fix, and on the incident's model a reserve at
the ceiling moves pi's threshold to 167,232 and makes the summarization
request fit with room to spare. The invariant itself belongs upstream and is
reported there separately.

The proximate trigger of the incident was this repo's own: `job_status` listed
630 Background jobs with no bound, and cost about 19,000 real tokens in one
call. The Background job listing now carries a bound of its own
(`MAX_LISTED_JOBS`, a constant, not a setting): newest first, the total still
stated, and one line naming how many the bound left out and where the rest
lives (the Job root). The live listing an unknown job id answers with is
bounded the same way and with the same wording, and it stays running jobs
only, so a typo cannot pull the machine's job history into the context. That
is closed here regardless of what the guard does.

What the e2e against the shared mock router now proves, on top of the five
scenarios above: a session whose Reported context plus one dense trailing tool
result overruns the window goes out *fitted* (15,873 tokens against a Corrected
estimate of 180,031 in a 200,000 window) and the provider is contacted - the
same request without the guard is the provider's rejection - and pi's own
threshold compaction then fires in the same run on the count the provider
reported for the fitted request, so the fitted request is the last thing the
operator sees before pi's normal recovery path runs. A healthy session goes
out untouched and unmentioned. The same shape with the anchor pushed past the
window is refused with the refusal line, the provider is never contacted, and
the turn ends aborted. A tool-calling turn has both of its requests fitted,
each on its own Corrected estimate, with one notice per turn. The mock router
grew two things for this: a scripted answer reports the prompt size the
provider counted, and a scripted answer can ask for real tool calls.

Two things this amendment does not do. pi's compaction summarization request
does not pass through `before_provider_request` at all (pi hands the
compaction module the agent's stream function with its own options), so the
guard cannot Fit it directly; taking over compaction through
`session_before_compact` the way Safe branch summary took over branch
summaries (ADR 0025) stays out of scope, because the Fit makes it unnecessary
in the common case - the fitted request lets pi's own threshold fire on the
provider's real count while there is still room for the summary. And the
proxy's own `fit_max_tokens` option is not the answer: it fixes the 400
server-side, leaves pi estimating a context the provider has already refused,
and leaves no line in the transcript.

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
moves; the spec's user story 9 names this trade-off directly. Raising the
budget in the hook - rejected then and still rejected: it trades the
non-answer for an unreadable provider error, and in the starvation state
lowering changes nothing either (the payload already carries the floor). The
Fit is the other direction in the other state, where the payload carries a
budget the window cannot pay for, and it is what the rejecting provider itself
suggests. A `session_before_compact` gate change so the pruning gate
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

After the amendment: an overrunning request costs one line and a shorter
answer instead of a provider rejection and a session that cannot compact. The
Fit spends the window's room, so the answer really is shorter, and the line
says so with the window, the estimate, and both budgets - an operator who sees
a short answer knows the session is tight. The guard now owns one owner's
worth of "the payload's output budget against the Effective window": no second
extension judges that figure. The cost is a second estimate per request (the
payload read directly, no network call) and one more setting an operator can
tune wrong, which is why the margin, the floor, and the estimator mirror all
carry tripwire tests against pi's own code. The Background job listing's bound
cuts a wall of text out of the context the guard is trying to protect. And the
reserve disagreement notice means the settings fix is visible: the guard
expects to be made unnecessary on a given machine, once, by an operator
raising one number.
