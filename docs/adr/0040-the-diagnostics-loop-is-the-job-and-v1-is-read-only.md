# The diagnostics loop is the job, and v1 is read-only

Issue #136 asks whether LSP tooling helps an agent at all. The market answer
is navigation: every LSP bridge exposes go-to-definition, references, hover,
and symbols, and this repo already has a code-intelligence extension that
owns symbol search, file reading, and the call trail. Measurement says the
navigation pitch is weak for agents: `ianbarber/lsps-for-llms` gave seven
models LSP tools over a grep-and-read baseline and the models largely
declined the operations they were offered; gains needed a prompt, training,
or a gate. What shipped systems report as wins (Hermes Agent, LSPSteer,
Kilocode) is the other shape: after an edit, the real language server
reports what the edit broke, and the agent sees it in the same result. pi
has no compiler-in-the-loop today.

**The extension's primary job is Post-edit diagnostics, and v1 is
read-only.** Navigation is taken only where a Language server clearly beats
codegraph: exact references and the real type behind a symbol. Three tools
exist (`lsp_diagnostics`, `lsp_references`, `lsp_hover`); there is no
`lsp_symbols`, no `lsp_definition`, and no call hierarchy. The Post-edit
annotation is attached in the `tool_result` hook on `edit` and `write`, so
it reaches the model without the model deciding to ask, and the Sweep at
turn end covers edits made outside pi's edit tools.

**The turn-end message never requests a continuation.** `turn_end` may
append a `custom_message` and ask for one more model request; this extension
appends the message and returns nothing, so the agent reads it at the start
of its next turn. An unconditional continuation can loop, and a diagnostics
report is not a reason to start a turn by itself.

**Considered options.** Navigation-first, like the MCP bridges, buys tools
the agent will not call and duplicates codegraph. A diagnostics tool alone
was rejected on the same measurement: an offered check is a check the agent
can skip. Write operations (`textDocument/rename`, code actions,
formatting) are deferred to the v2 ticket rather than cut forever: they make
the Language server a writer in a session where the agent expects its own
edit tools to be the only writer, and they collide with edit-assist, so they
need their own design for confirmation and undo.

**Consequences.** The extension can be useful with all three tools
inactive, because the annotation is a hook and not a tool. The prompt note
appears only when a Language server is available for the project, so a repo
with no server on the machine pays no context and is never steered at a tool
that would fail. The boundary against codegraph is stated in the note and in
the docs, because two code-intelligence extensions in one package otherwise
compete for the same call.
