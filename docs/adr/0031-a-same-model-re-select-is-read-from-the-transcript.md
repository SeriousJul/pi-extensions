# A same-model re-select is read from the transcript

ADR 0027 wrote down that `modelsAreEqual` in pi-ai compares only `id` and
`provider`, so pi emits no `model_select` for a re-set to the model the session
already holds. That made the re-select the one selection event the extension
could not see, and `/llama-window` the only way to force a compare after it. The
operator's case showed the cost in daily use: a llama.cpp model whose live
`n_ctx` no longer matched the window the session held (the report: 160k on the
server, 130k in the session), and `/model` used to pick that same model again did
nothing at all. We decided: the extension reads the re-select from the
transcript. pi
appends a `model_change` entry on every `setModel`, equal model or not, so that
entry is the record that a selection happened. The wiring keeps the id of the
newest `model_change` entry it has accounted for - a select pi reported through
`model_select`, or a re-apply this extension made itself - and treats a newer
entry at the next `turn_start` as the operator's re-select of the current model.
It re-arms both Attempts through a new core entry point, `onReSelect`, before the
pre-request compare runs, so the first request of that turn carries the healed
window. The wiring accounts for the entry its own re-apply appends the moment
`pi.setModel` resolves, so a heal can never re-arm the budget it just spent.

## Considered options

- **Transcript detection (chosen).** It needs no change outside this repo, works
  in every pi mode, and rests on the one fact pi guarantees: `setModel` appends
  the entry before it decides whether to emit the event. Rejected cost: the
  earliest boundary that can read the entry is the next `turn_start`, so the heal
  lands one boundary later than the selection and the report line appears with
  the next turn, not at the moment of the re-select.
- **Change pi so `_emitModelSelect` fires for an equal model.** It would re-arm
  through the existing `model_select` handler and report at selection time.
  Rejected because it changes what `model_select` means for every extension, for
  the benefit of one, and because ADR 0027 already chose that this extension
  carries the burden of a stale cached window rather than pushing it upstream.
- **Treat any new `model_change` entry as a re-select, with no self-guard.**
  Rejected because the extension's own re-apply writes exactly that entry. It
  would re-arm the Attempt the heal just spent and run a compare every turn
  forever, which is the loop the one-shot budget exists to prevent. The e2e
  asserts the guard.
- **Keep `/llama-window` as the only recovery.** Rejected because it asks the
  operator to know the internal reason their obvious recovery did nothing. The
  command stays, for the case it actually covers: a window moved with no
  re-select at all.

## Consequences

- A re-select is a selection event like any other, so the budget rule from ADR
  0027 is unchanged: two Attempts per selection, one per Heal moment, and a
  re-select re-arms both. It cannot loop, because a re-select spends what it
  re-armed.
- The heal for a re-select lands at the next `turn_start`, not at selection time.
  The operator sees the line at the start of the next turn, and that turn's
  request is already built on the healed window.
- The wiring now reads the session transcript (`sessionManager.getEntries`) at
  every `turn_start`, the same pattern the model router uses. It scans backward
  for the newest `model_change` entry and stops at the first hit.
- ADR 0027's sentence that a re-select "re-arms nothing" holds only for the
  `model_select` event. The selection itself reaches the core through the
  transcript.
