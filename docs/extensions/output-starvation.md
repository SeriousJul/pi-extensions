# Output-starvation guard extension

Judges one provider request's output budget against the Effective window: it
refuses a budget that has collapsed to pi's floor, and it Fits a budget the
window cannot pay for.

pi's output clamp computes the Effective window minus the context estimate
minus a safety margin, and floors the result at its own minimum. Two different
things can go wrong with the budget that comes out, and the guard answers each
in its own way ([ADR 0028](/adr/0028-output-starvation-guard-refuses-a-collapsed-output-budget)).

- **Output starvation.** Any estimate over the window minus that margin
  saturates the clamp: the payload goes out carrying the floor as its max
  tokens, the provider answers a one-token non-answer, and the transcript
  records `stopReason: "length"`. The guard refuses that request.
- **Output overrun.** The opposite state. The payload carries a budget the
  Effective window cannot pay for, on the estimate the provider's own counting
  supports, and the provider rejects the whole request before it answers:
  `prompt (170685 tokens) + max tokens (32768) exceeds the context (200000)`.
  The guard Fits it: it lowers the budget to the room the Corrected estimate
  leaves, and the request goes out and gets answered.

## Behavior

- On every provider request, the guard reads the payload pi has already built:
  its messages, its system prompt, its tool declarations, and its budget.
- **Refusal.** When the payload's budget is pi's saturated floor, the guard
  refuses: one report line and the run's abort. The provider is never
  contacted, the turn ends aborted instead of a one-token `length` answer, and
  pi never retries an abort.
- **Fit.** When the budget exceeds the room the Corrected estimate leaves in
  the window, and that room minus pi's safety margin still clears the minimum
  answer budget, the guard lowers the budget to that room and returns the
  payload. It writes only the budget field the payload carries
  (`max_tokens`, `max_completion_tokens`, or `max_output_tokens`) and nothing
  else. It never raises a budget and never goes below pi's floor.
- **Refusal instead of a Fit.** When the room left cannot hold a real answer,
  the guard refuses rather than fitting, so the operator is never charged for a
  one-token non-answer. That branch refuses exactly as the collapsed budget is
  refused, with the same line; the figures tell them apart.
- **Per-turn budget.** At most one refusal per turn, and at most one fit notice
  per turn. A Fit is not a refusal: it applies to every request in the turn,
  because a retry must not go out with the budget that just failed. Both flags
  reset on every turn start and on a session start, and nothing survives a
  model selection.
- A healthy budget - however small - goes out untouched, and the guard says
  nothing.
- The guard registers no compaction hook, so it cannot stand in the way of the
  compaction a fitted request lets pi's own threshold reach. It never touches
  the window, which stays Llama refresh's and Context window cap's ownership.

## What you see

Two lines, one shape, in the glossary's vocabulary:

- `output overrun: fitted budget (strata/model): context estimate 172862, Effective window 200000, output budget 32768 -> 23042`
- `output starvation: refused (llama.cpp/m1): context estimate 13757, Effective window 16000, output budget 1`

The fit line is an `info` notice: the request went out and got answered, with
a shorter answer. The refusal line is an `error` notice and the turn ends
aborted. Both name the Effective window, so a Context window cap or a Llama
refresh heal is already reflected in what is read.

Once per session, when pi's compaction reserve sits below the model's output
ceiling, the guard names the settings disagreement that makes an overrun
possible and says what to change. It changes nothing:

- `output starvation: reserve disagreement (strata/model): compaction reserve 16384, model output ceiling 32768; set compaction.reserveTokens to 32768 or more`

## The Corrected estimate

pi's clamp reads a character estimate at four characters per token. On a dense
tool result that is badly low: a 42,721-character result the real tokenizer
counted at 19,183 tokens was estimated at 10,680, at 2.23 characters per token.
One low figure drives both guards at once - the compaction threshold stays
uncrossed, and the clamp sees room that is not there and leaves the budget at
the model's ceiling.

The Corrected estimate is the figure pi's arithmetic is missing:

```
Corrected estimate = Reported context + Inflation x (chars the provider has not counted / 4)
```

- **Reported context**: the prompt size the provider itself counted for its
  last answer. The provider has already counted everything up to that answer
  exactly, so the estimate starts from its number rather than re-counting it.
  pi strips the usage block off the wire, so the guard reads it from the
  session entry pi stored for that answer, through pi's own anchor rule (the
  last assistant response whose usage still describes its prefix).
- **Everything after it**: the payload's messages after that answer, at pi's
  chars/4 rate times the Inflation factor. That is where the character rate
  fails, and it is the part the provider has not counted.
- With no usage anchor at all - a fresh session that is already large - the
  whole payload is estimated with the same correction, tool declarations
  included.
- When the payload carries nothing the guard can read, it degrades to pi's own
  estimate rather than making an unfamiliar provider payload worse.

The Fit spends the same margin pi's clamp spends (`CONTEXT_SAFETY_TOKENS`,
4,096), pinned to pi's own constant, and the default minimum answer budget is
pi's `MIN_ANSWER_TOKENS` (1,024), pinned the same way. A figure invented here
would silently disagree with pi whenever pi's arithmetic moves. The fit is
conservative by design: on the incident's figures it lands near 23,000 tokens
where the provider's own error named 29,307 as the largest budget that would
have fit.

A Fit cannot cool the provider's prompt cache: the budget is a sampling field,
not part of the cached prefix.

## Settings

The `outputStarvation` section of the settings files. The project
`<cwd>/.pi/settings.json` overrides the global `$PI_CODING_AGENT_DIR/settings.json`,
key by key. A malformed value falls back to its default and is reported in a
notification; it never throws. The section is read once per session and re-read
on reload.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the guard on or off. |
| `inflation` | `2.0` | The Inflation factor on pi's chars/4 estimate, the same default Output limits and Safe branch summary use. |
| `bytesPerChar` | `4` | pi's own `CHARS_PER_TOKEN`. |
| `safetyMargin` | pi's own 4096 | The room the Fit leaves unbudgeted, the same margin pi's clamp leaves. |
| `minAnswerTokens` | pi's own 1024 | The smallest answer budget the guard will send. Below it, the guard refuses instead of fitting. Raise it on a reasoning model to thinking plus a usable reply. |

`compaction.reserveTokens` stays pi's own setting, read here and never
written. It is read the way pi resolves it: this model's
`compaction.modelOverrides[provider/id].reserveTokens` first, then the plain
setting, then pi's built-in default. The guard reports the disagreement when
that reserve sits below the model's output ceiling; raising it is the
operator's fix, and it is the one that ends the whole failure mode on a given
machine.

### Escape hatch

`PI_OUTPUT_STARVATION=off` turns the guard off regardless of both settings
files, so the operator can compare pi's raw behavior against ours. It wins
over them, because an escape hatch a stale project setting could undo is not
one.

## How it works

The decision lives in the engine-free core module
(`extensions/output-starvation/guard.ts`): the decision table over the payload,
the Corrected estimate, the Fit, and the one place the report lines exist. The
pi wiring (`index.ts`) only binds `before_provider_request`, `turn_start`,
`session_start`, and `model_select`, and owns the notice, the refusal, and the
abort. The mirror of pi-ai's estimator, the floor, and the safety margin are
pinned against pi's own code in the tests, because pi's clamp and estimator
modules are not importable from an extension.

The guard is the one owner of "the payload's output budget against the
Effective window": no second extension judges that figure.

## Tests

Three seams. The highest is the e2e RPC run against the shared mock llama.cpp
router: a healthy turn goes out untouched and unmentioned; a starved turn is
refused verbatim with the provider never contacted; the refusal is once per
turn; compaction still rescues a stale-usage session; a starved session with
Pruning loaded is still refused. The overrun scenarios then show a session
whose Reported context plus one dense trailing tool result overruns the window
going out *fitted* with the provider contacted, and pi's own threshold
compaction firing in the same run on the count the provider reported for the
fitted request; the same shape with the anchor past the window refused with the
provider never contacted; and a tool-calling turn whose every request is
fitted, each on its own Corrected estimate, with one notice per turn. The
wiring seam asserts the returned payload's budget and the notice text against
a real `SessionManager`. The core seam runs the decision table over captured
payloads, and pins the estimator mirror, the floor, and the margin against
pi's own code.
