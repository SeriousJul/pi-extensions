# The live catalog comparison heals the window, not the fallback sentinel

ADR 0019 gates its self-heal on one value: the check runs only when the session's
model reports exactly the 128000 Fallback window. That gate is the reason a
session died quietly. A llama.cpp service relaunched between two days carries a
different `n_ctx` (the failing pair: 40192 from a launch on Sep 24, 160000 from
the same preset on Sep 25), pi caches the derived window in its model store, and
nothing revalidates that cache unless an extension forces a refresh. A session
that selects the model from the cache holds a Cached window from a server launch
that no longer exists. pi's `clampMaxTokensToContext` then computes
`contextWindow - estimateContextTokens(context) - 4096`, floors it at
`MIN_MAX_TOKENS = 1`, and sends `max_tokens: 1`. The model answered one thinking
token, the turn recorded `stopReason: "length"`, and the next turn repeated it.
The sentinel never matched, because 40192 is not 128000, so the heal bailed on
every turn of that session. The Fallback window is one cause of a wrong window,
not a test for it.

We compare instead of matching. At each of the two fixed Heal moments of a model
selection, before its first request and after that request settles, llama refresh
snapshots the registry's copy of the model, forces one catalog refresh scoped to
the llama.cpp provider, reads the model back, and re-applies it when the value
moved. The Live window arrives through pi's own provider, so this repo derives no
`n_ctx` and mirrors no constant. `FALLBACK_WINDOW` leaves the module entirely;
the term stays in the glossary as the name of the degenerate cached value. The
compare applies a window in either direction: a server that comes back smaller
shrinks the session, because a window we refuse to shrink is the same quiet lie
that took an evening of journal reading to find.

Comparing the registry against itself is what makes this safe beside the
context-cap extension. That extension caps at both layers: it re-registers each
provider with `contextWindow: Math.min(cap, model.contextWindow)`, and it clamps
the session's already-resolved model object in place. No extension-facing read
returns a pre-cap window, so "compare the raw catalog value with the live value"
has no raw operand. A before-and-after compare of the registry copy keeps both
sides under the same cap, so a cap that hides drift is a cap doing its job, and a
cap above a drifted window still shows the move.

One-shot budgeting cannot loop, and the reason is a pi detail worth writing down:
`modelsAreEqual` in pi-ai compares only `id` and `provider`. The heal's own
re-apply therefore emits no `model_select` for a same-model re-set, so a
comparison-based trigger cannot re-arm the Attempt it just spent. A selection
gets one Attempt per Heal moment, two in total, and a new selection re-arms both.
A turn that ends `stopReason: "length"` with a near-empty output may spend an
unspent Attempt on an extra compare, and can never re-arm one. A refresh that
fails or times out spends nothing, exactly as before, so the second moment keeps
the information the first one could not get.

**Considered options**: read the live `meta.n_ctx` straight from the server for
detection, using the model's own `baseUrl`, and force pi's refresh only when a
drift shows - rejected because it duplicates the provider's derivation
(`n_ctx ?? n_ctx_train ?? 128000`) and adds a second HTTP client to keep in sync,
which is the fragility ADR 0019 already named once. Rejected with its cost: a
forced refresh rewrites every llama model's cached window, so any model asleep at
that instant gets 128000 written over its previous value; the post-request moment
exists precisely to repair that case, so the cost is bounded by the mechanism we
already trust. Sentinel plus an added trigger - rejected because it is the design
that just failed, with a second trigger bolted on; every non-sentinel drift stays
unhealed. A per-turn compare and a static window pin in the user's models config
stay rejected for the reasons ADR 0019 gives.

**Consequences**: up to two `model_change` entries per selection instead of one,
since either moment can apply, and the transcript cost ADR 0019 accepted grows by
the same amount. Every applied heal and every command run reports one line,
`llama window: 40192 -> 160000 (unsloth/qwen3.8-27b-dflash)`, because the failure
this replaces was invisible until a journal was read by hand. A `/llama-window`
command forces one compare, because pi emits no `model_select` when the same
model is selected again, so the obvious human recovery from this bug spends and
re-arms nothing; the doc comments that claim a re-select re-arms an Attempt are
corrected with this change. Nothing goes upstream by deliberate choice, so the
extension carries the whole burden of a stale cached window. Two related facts are
recorded here but not solved by it: pi's own compaction threshold never fired on
the failing session even though every reading of 0.87.0 says it should have, and
`_omitRecoveryAttempt` writes a `context_edit` that invalidates the usage-backed
compaction estimate, which makes a truncation suppress the compaction that would
end it. The guard for a starved output budget, and the answer to that silence, are
a separate module and a separate ADR.
