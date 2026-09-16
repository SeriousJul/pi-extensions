# tools extension

The `/tools` command opens a TUI list of every tool in the session.
Toggle a tool to enable or disable it; the change applies immediately.
The selection persists in the session (a `tools-config` entry) and is
restored on session start and branch navigation, so it respects the
session tree. Non-built-in tools show a tag with their origin (package
name or file name), so you can see which extension provides each tool.

The command requires TUI mode; in print or RPC modes it reports that.
