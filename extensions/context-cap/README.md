# context-cap

Caps the effective context window for a pi session, so auto-compaction fires
early and prompts stay small.

```sh
pi --context-window 32000
# or
PI_CONTEXT_WINDOW=32000 pi
```

The flag wins over the env var. The value is a token count, not a percentage.

## Behavior

- The cap is a ceiling: the effective window is the smaller of the cap and the
  model's resolved window (after `models.json` `modelOverrides`). It never
  grows a window.
- It is session-wide: the initial model, model switches, scoped-model cycling,
  and resume all operate under the cap. The `/model` picker and the footer
  context percentage show the capped window.
- Compaction timing, overflow detection, and the footer percentage all use the
  capped window, because pi reads one field: `model.contextWindow`.
- A one-time notice confirms the active cap at startup.

## Rejection

pi reports an error and runs uncapped when:

- the value is not a positive integer, or
- the cap is at or below `compaction.reserveTokens` (default 16384). A cap
  that small would compact every turn.

## How it works

See `docs/adr/0004-context-window-cap-via-provider-reregistration.md`. On
session start the extension re-registers each provider that has a model above
the cap with capped copies of its full model list, and clamps the model
objects the session already resolved in place.

## Known edges

- Providers whose model list pi refreshes from the network after startup
  (for example a local llama.cpp server) keep the capped list taken at session
  start until the next session.
- A model with no configured auth is left untouched.
