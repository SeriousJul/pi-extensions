# Llama refresh extension

Heals any context-window drift of a local llama.cpp model against the live
catalog.

A session can hold a wrong context window for any reason its model
selection saw a stale catalog: the model was asleep (the catalog gives it a
Fallback window), the server relaunched with a different `n_ctx` and the
cached catalog never revalidated, or a context-cap interaction moved the
value. The Fallback window is one cause of a wrong window, not a test for
it, so the extension compares instead of matching.

## Behavior

- At two fixed moments of each model selection - before its first request
  is built and after that request settles - the extension snapshots the
  registry's copy of the active model, forces one catalog refresh scoped to
  the llama.cpp provider, reads the model back, and re-applies it when the
  window moved, in either direction (a server that comes back smaller
  shrinks the session).
- A turn that ends `length` with a near-empty answer (the signature of a
  starved output budget) may spend an unspent Attempt on an extra compare,
  and can never re-arm one.
- A selection gets one Attempt per moment, two in total, and a new
  selection re-arms both. Because pi emits no `model_select` when the same
  model is selected again, a re-select re-arms nothing; the
  `/llama-window` command re-arms the pre-request Attempt and runs one
  compare on demand.
- Every applied heal reports one line, and every command run reports one
  line:
  - `llama window: 40192 -> 160000 (llama.cpp/model)` - an applied heal
  - `llama window: 160000 (llama.cpp/model)` - a command that confirmed an
    unchanged window
  - `llama window: check failed (llama.cpp/model)` - a command whose check
    could not finish
  - `llama window: no model selected` - a command run with no model
- A refresh that fails or times out spends nothing, so the next moment
  retries and a down server degrades to silence. Every catalog read carries
  a hard five-second budget: the pre-request moment sits before the request
  is built, so a slow server may delay the first request by at most that
  long, and the settled and symptom moments run awaited, so the budget also
  bounds how long they may delay the settle.
- The refresh persists the corrected catalog, so later sessions start
  corrected even when this session would not re-heal.
- The extension never clobbers: a model select that lands while a compare
  is in flight wins, and a compare that outlived its session (a
  replacement or reload) skips its re-apply. Two compares never run for
  the same selection at once.
- The check stays safe beside the context-cap extension: the cap skips
  live-catalog providers (a static capped list would freeze the live
  window) and clamps the session model in place at every boundary the
  window is consumed. A drift that stays above the cap reports a cosmetic
  heal line per moment the cap undoes at its boundary; a drift that
  crosses below the cap heals for real. Load this extension before
  context-cap, so the cap's clamp of a boundary lands after this
  extension's re-apply in that boundary.
- Non-llama.cpp models are ignored entirely.

## How it works

The decision logic lives in the engine-free core module
(`extensions/llama-refresh/refresh.ts`); the pi wiring (`index.ts`) only
binds events and supplies the real dependencies (registry refresh, registry
read-back, `pi.setModel`, the currency probe). The notify lines are built
in the core module in exactly one place, so a test can assert a line
verbatim.
See [ADR 0027](/adr/0027-the-live-catalog-comparison-heals-the-window).
