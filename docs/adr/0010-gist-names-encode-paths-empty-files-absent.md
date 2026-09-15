# Gist names percent-encode sync paths, and empty files are absent

GitHub gists are flat and text-only: a file name cannot contain `/`, and a
file cannot hold empty content (create fails with HTTP 422; on update, GitHub
deletes a file set to `""`). The Gist Backend therefore stores each
home-relative path under its percent-encoded name, leaving only
`[A-Za-z0-9._-]` literal, so `.pi/agent/settings.json` travels as
`.pi%2Fagent%2Fsettings.json`. The mapping is one-to-one and decoded on
fetch, so paths survive the round trip while root files like `AGENTS.md`
stay human-readable in the GitHub UI. Zero-byte files are skipped at
collection time with a warning and are absent from the Snapshot: an empty
file has nothing to carry, and truncating a file to empty reads as a
deletion in the three-way merge.

Considered options: a delimiter token for `/` (collides with real names, not
reversible); a path-to-name mapping stored in the manifest (fetch must
derive the path from the name alone, before any config is trusted); a
placeholder for empty content (breaks the content hash and shows up in the
GitHub UI).
