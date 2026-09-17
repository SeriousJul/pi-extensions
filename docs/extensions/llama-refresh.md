# Llama refresh extension

Self-heals the context window of a session that resolved a local llama.cpp
model while the model was asleep.

A llama.cpp model reports its true context window only while it is loaded:
an asleep model exposes no `n_ctx`, and the provider gives it a fixed
128000 (the Fallback window). A session that resolves the model while it is
asleep keeps that window for its whole life, compacting far earlier than the
model's real window requires, until a human re-selects the model by hand.

## Behavior

- After each agent turn, if the active model is a llama.cpp model carrying
  the Fallback window and this model selection has not yet spent its
  Attempt, the extension forces a catalog refresh scoped to the llama.cpp
  provider, re-resolves the model, and re-applies it only when the window
  changed. The first request already woke the model, so the refresh sees
  the true `n_ctx`.
- The repair costs at most one catalog refresh per model selection and at
  most one model change transcript entry per selection, and only when the
  window actually changed. A model genuinely loaded with a 128000 context
  is confirmed by the refresh and left untouched, so the check stays
  silent.
- The refresh also persists the corrected catalog, so later sessions start
  corrected even when this session would not re-heal.
- A refresh that fails (server down, aborted) is absorbed: the selection
  retries on the next turn end, so a down server degrades to today's
  behavior instead of erroring every turn.
- Non-llama.cpp models are ignored entirely.

## How it works

The decision logic lives in the engine-free core module
(`extensions/llama-refresh/refresh.ts`); the pi wiring (`index.ts`) only
binds events and supplies the real dependencies (registry refresh, registry
read-back, `pi.setModel`).
See [ADR 0019](/adr/0019-llama-refresh-self-heals-the-fallback-window).
