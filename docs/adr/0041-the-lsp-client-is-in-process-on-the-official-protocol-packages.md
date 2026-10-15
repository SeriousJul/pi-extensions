# The LSP client is in-process, on the official protocol packages

Issue #136 needs a client that speaks the Language Server Protocol to a
server process for the lifetime of a pi session, and that can attach results
to pi's own tool results. Three shapes were on the table.

**The extension speaks LSP itself, in the pi process, on
`vscode-jsonrpc` plus `vscode-languageserver-protocol`.** The two packages
are the protocol's own definition: framing, request and notification
plumbing, and the typed message shapes. They are pure JavaScript with no
native code, which matters in a package that already carries one heavy
native dependency (codegraph). The client lives in the session process, so
the `tool_result` hook, the Sweep, the settings, and the server lifecycle all
sit in one place.

**Considered options.** Registering an existing MCP LSP bridge through
`pi.registerMcpServer()` is the obvious shortcut, and it is wrong here for
three reasons: those bridges expose 50 to 65 tools, which is the context
cost this package spends real effort avoiding; the Post-edit annotation
needs a `tool_result` handler over pi's own `edit` and `write`, which an
external server cannot install; and an external binary takes the Server
registry, the settings, and the failure reporting out of this repo's reach.
Hand-rolling JSON-RPC framing and the message types saves two dependencies
and buys a permanent maintenance tax on a protocol with a maintained
implementation. A daemon shared between sessions is rejected in ADR 0043.

**Consequences.** The protocol packages are pinned as npm dependencies of
this package, so an LSP spec version bump is a dependency bump rather than a
rewrite, and the extension's message handling is checked against their
types. The dependency pair is small enough that swapping to a hand-rolled
client later stays possible; the lock-in this ADR actually records is the
decision to stay in-process, which is what makes the `tool_result` hook and
the server lifecycle one design instead of two.
