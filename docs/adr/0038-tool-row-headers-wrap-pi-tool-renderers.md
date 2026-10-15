# Tool row headers wrap pi's tool renderers

Every Tool row sits in the same green block, and the block says nothing
about which tool it holds: the `bash` and `powershell` rows print only
`$ <command>`, a `codemode` row prints a JSON blob, and an MCP row prints
whatever its server's renderer chose. So one extension adds a Tool row
header - the tool name set in a rule, one line above the call line - by
registering a tool-renderer resolver that calls `next()` first and
prepends the header to whatever pi or another extension would have drawn.
Wrapping reaches built-in tools, this package's own tools, and MCP tools
through one code path, and it composes with pi's MCP resolver and with
`bash_bg`'s own renderer instead of shadowing either. The header names the
tool and nothing else: the call line already carries the argument, and the
block's background already carries the pending, success, and error states.

**Considered options**: re-registering each built-in tool with new
renderers (pi's own example pattern) covers only the tools named, and it
re-registers execution to change a picture; a theme cannot add a line;
drawing a full fieldset frame with side rules and a bottom rule needs
`renderShell: "self"`, which hands the extension pi's whole row shell -
background state, the click-to-expand mouse region, inline images, and
empty-row hiding - to rebuild and to re-break on every pi change; owning
each call line to avoid the repeated tool name inherits pi's per-tool
formatting (read's compact classification, write's highlighting, bash's
timers) forever.

## Consequences

- The tool name appears twice in a `read`, `edit`, `write`, `grep`, `find`,
  or `ls` row: once in the header, once in pi's call line. This is
  deliberate. Removing it means parsing pi's styled output, which pi
  changes without notice.
- The header is one extra line per row. The block already spends a blank
  line above and below, and the only zero-cost shape is an inline prefix,
  which is the owned-call-line design again.
- A `bash_bg` row is now labeled `bash_bg`. ADR 0024 still governs the
  call line: it stays `$ <command>` with no background marker. The header
  is a different layer, and it is what finally tells a `bash` row from a
  `bash_bg` row.
- The wrapper must keep pi's inner component in its own state key and hand
  it back as `context.lastComponent`, because pi's built-in renderers call
  `setText` on that component and would crash on the wrapper.
- An MCP row's header drops pi's `mcp__` spelling and shows `server/tool`,
  the same rule pi's MCP extension uses for that row's call line, so the
  two agree.
- The header draws in HTML export as well as the terminal: the renderer
  slots carry no mode flag to tell them apart.
- A row whose wrapped renderer draws nothing shows the header alone. No
  built-in tool does this today.
- The extension is always on with no setting and no command. It is a
  rendering opinion in a personal package; the way to opt out is to not
  load the file.
