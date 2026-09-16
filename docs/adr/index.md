# Architecture Decision Records

The decisions that shape this project. Each ADR records the context, the
chosen option, and the options that were considered.

| ADR | Decision |
| --- | --- |
| [0001](/adr/0001-embed-codegraph-in-process) | Embed codegraph in-process, not via daemon or CLI. |
| [0002](/adr/0002-per-worktree-index-seeded-from-sibling) | Per-worktree index, seeded from a sibling worktree. |
| [0003](/adr/0003-named-project-roots-for-dependency-sources) | Named project roots for dependency sources. |
| [0004](/adr/0004-context-window-cap-via-provider-reregistration) | Context window cap via provider re-registration. |
| [0005](/adr/0005-quota-owns-chatgpt-token-refresh) | Quota extension refreshes the ChatGPT token itself. |
| [0006](/adr/0006-model-router-resumes-via-user-message) | Model router resumes a quota-halted turn with a synthetic user message. |
| [0007](/adr/0007-sync-uses-oauth-device-flow-with-expiring-tokens) | Sync authenticates with the OAuth device flow and expiring tokens. |
| [0008](/adr/0008-usage-report-derived-from-session-scan) | Usage reports are derived from session files, not a stored index. |
| [0009](/adr/0009-usage-events-counted-once-per-distinct-line) | Usage events are counted once, keyed by the full session line. |
| [0010](/adr/0010-gist-names-encode-paths-empty-files-absent) | Gist names percent-encode sync paths, and empty files are absent. |
| [0011](/adr/0011-pruning-is-a-request-projection) | Pruning is a request-level projection; the session file is the store. |
| [0012](/adr/0012-resource-toggles-write-native-settings-patterns) | Resource toggles write the native settings override patterns. |
| [0013](/adr/0013-skill-tree-tracks-upstream-sources-with-per-source-pins) | The skill tree tracks upstream sources with per-source pins. |
| [0014](/adr/0014-tool-usage-counts-cached-session-scan) | Tool usage counts are derived from a session scan with a per-file stat-keyed cache. |
| [0015](/adr/0015-compression-is-a-request-time-view) | Compression is a request-time view; the compressed form is text. |
| [0016](/adr/0016-dependency-indexes-build-on-first-query) | Dependency indexes build on first query, with streamed progress. |
