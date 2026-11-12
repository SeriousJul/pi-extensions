# The llama-refresh extension is dropped

The operator asked for the llama-refresh extension to be removed. It existed
to repair the context window a pi session holds for a local llama.cpp model:
pi caches the window the provider reported, a model that wakes or a server
that relaunches with a different `n_ctx` leaves the session with a stale
value, and the extension's two heal moments compared the catalog before and
after one forced refresh and re-applied the model when the window moved. The
heals were working (the operator's session logs carry the extension's
`llama window:` report lines); the drop removes a working feature on the
operator's judgment, not a broken one.

Dropped: the extension (`extensions/llama-refresh/`), its docs page, its
tests, and the `e2e:llama-refresh` manifest script. Moved: the
context-window-cap record the extension read
(`extensions/shared/context-window-cap.ts`) now lives in the context-cap
extension (`extensions/context-cap/cap.ts`), which is its only remaining
owner; it stays a process-global `Symbol.for` record, so a double-loaded copy
of the extension still sees the cap. Kept: `tests/shared/llama-mock-router.mjs`,
the mock llama.cpp router the output-starvation e2e still runs against.

This ADR supersedes
[ADR 0019](/adr/0019-llama-refresh-self-heals-the-fallback-window),
[ADR 0027](/adr/0027-the-live-catalog-comparison-heals-the-window), and
[ADR 0031](/adr/0031-a-same-model-re-select-is-read-from-the-transcript). The
superseded files stay in the index, marked superseded, as the record of why
those designs were made and what they guaranteed.

## Consequences

- A session that resolves a local llama.cpp model while it is asleep, or
  whose server relaunches mid-session, keeps the window it resolved: nothing
  re-reads the catalog or re-applies the model. The Context window cap still
  clamps that window at every boundary the window is consumed.
- The operator's pi loads the package with no llama-refresh exclusion or
  setting to remove: the extension registered no flag and read no setting,
  and its `/llama-window` command simply stops existing.
- The context-cap extension's behavior is unchanged.
