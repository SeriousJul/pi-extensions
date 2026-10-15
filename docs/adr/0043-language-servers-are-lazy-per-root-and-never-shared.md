# Language servers are lazy, per root, and never shared

Issue #136 has to decide what a Language server costs. Servers are heavy and
slow to warm: rust-analyzer and gopls index for tens of seconds and can hold
hundreds of megabytes, and an answer taken mid-index is partial.

**One server per (language, root) pair, started by the first call that needs
it, alive for the session, closed idempotently at `session_shutdown`.** The
root is the nearest marker walking up from the file (`Cargo.toml`, `go.mod`,
`tsconfig.json` or `package.json`, `pyproject.toml`,
`compile_commands.json` or `compile_flags.txt`), falling back to the session
root. A **Concurrent server bound** of four servers per session evicts the
idlest server and its Open documents. Servers are never spawned for a
Dependency source or a Named root, and never spawned when the project is not
trusted unless the settings say otherwise.

**Considered options.** A persistent daemon shared across sessions, which is
what the existing agent-LSP products run, survives restarts and shares one
index between concurrent agents. It is rejected for v1 because it adds a
process this package must find, health-check, version-match, and upgrade;
because a server's state would then outlive the session whose settings,
trust decision, and working set produced it; and because the eviction and
memory story gets harder when several sessions own one process. Spawning per
call is impossible in practice: a real server takes longer to index than the
call can wait. Starting every detected language eagerly at `session_start`
makes a C++ session pay for rust-analyzer.

**Consequences.** The first call in a language pays the server's start and
index, so results during that window are labeled partial, and the Post-edit
annotation never blocks past a short budget waiting for them. A server that
dies is restarted once and then marked dead, with the reason in the tool
result and in `/lsp`. Multi-root workspaces are not used: a monorepo gets one
server per package root the agent actually touches, which is the same map
code and the only way a workspace with several crates answers against the
right package.
