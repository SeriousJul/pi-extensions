# Context window cap via provider re-registration

Amended by [ADR 0027](/adr/0027-the-live-catalog-comparison-heals-the-window) for
live-catalog providers: the re-registration is skipped for a provider that
re-fetches its model list from the server (it exposes `refreshModels`),
because the composer replaces the live list with the static one and the
window stops moving in either direction. For those providers the cap is
enforced by clamping the session's model in place at every boundary the
window is consumed. The rest stands.

The `context-cap` extension limits a session's effective context window so
auto-compaction fires early. pi has no cap concept; the only source of truth is
`model.contextWindow` on the model object the session resolves. We apply the
cap by re-registering each provider's model list (with capped
`contextWindow`) through the extension `registerProvider` API, instead of
hooking `session_start`/`model_select` and calling `setModel` with a capped
copy.

The hook path was rejected because `setModel` appends a `model_change` entry
to the session transcript on every call (polluting every session start and
switch) and because the `/model` picker would keep showing the true window
while compaction acted on the capped one. The registry path makes the capped
window the value pi resolves everywhere: initial model, resume, model
switches, picker, footer. The composer keeps base auth, streaming, and model
refresh for re-registered providers, so no provider behavior changes except
the window.

Cost accepted: the extension copies every model field at load and must keep
that copy complete when pi's model shape grows.
