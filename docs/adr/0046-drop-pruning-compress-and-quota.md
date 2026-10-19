# Drop the pruning, compress, and quota extensions

The package no longer ships the Pruning, Compress, and Quota extensions.
Twelve weeks of session evidence (2,842 sessions, 252k tool results)
showed none of the three in use: Pruning was disabled in the user's
settings with zero activity across the whole corpus; Compress was used in
one two-day burst (10 compression spans, Sep 18-19) and then disabled;
Quota was disabled in both the package filter and the global extension
list, with zero `/quota` invocations, and it monitors only the OpenAI
ChatGPT plan while the user's OpenAI traffic is Codex, which the Quota
source does not read. The user maintained, type-checked, and installed
roughly 3,300 lines of extensions, tests, docs pages, ADRs, and glossary
terms in every session on every machine for tools that do not run.

The three extension directories, their docs pages and screenshots, their
capture pipeline entries, and their test directories are deleted, and the
`e2e:quota` (and, with the pruning probe, the `e2e:pruning`) manifest
scripts are removed. The Quota source module - the ChatGPT plan token
refresh, the usage read, the Quota window and usage snapshot types, the
read contract, and the provider-id and endpoint constants - moves into
the model-router extension as `extensions/model-router/source.ts`. The
router's wait strategy and switch-back read the plan's quota windows
through it, and the extension entry point builds it; both now import from
the router's own directory. The module's contract is unchanged: one read
of the plan's quota windows, never throws, and the token refresh stays
one owned module with its documented behavior (refresh on expiry or 401,
read-modify-write on pi's auth store, one retry after a re-read before
declaring the login dead).

This ADR supersedes ADR 0005 (the Quota extension refreshes the ChatGPT
token itself; model-router now owns the refresh), ADR 0011 (pruning as a
request-level projection), ADR 0015 (compression as a request-time view),
and ADR 0018 (sticky pruning engagement). The superseded files stay in
the index, marked superseded, as the record of why those designs were
made and what they guaranteed.

## Consequences

- No surviving extension changes behavior: outside model-router the diff
  is imports, test fixtures, docs, and deletions. The usage scan still
  counts `compress-span` entries that old sessions recorded, and the
  model-router's wait strategy reads the plan's windows exactly as before,
  now from its own module.
- The glossary's Pruning and Compression sections are deleted; the Quota
  terms (Quota window, Usage snapshot, Quota source, and the
  model-router's Quota halt vocabulary) live under the Model router
  section.
- The docs site, README, and screenshot pipeline describe only the
  shipped set, so the `npm run docs:screenshots` and VitePress build
  gates pass with the dropped views gone.
- The user's own settings carry stale lines the repo cannot delete: three
  package-filter entries (`extensions/pruning|compress|quota/index.ts`
  disable lines), an orphaned global disable of the quota extension, and
  the `compress` and `pruning` config blocks. They are deleted by hand
  after the merge; the drift check's stale-entry class surfaces any that
  remain.
