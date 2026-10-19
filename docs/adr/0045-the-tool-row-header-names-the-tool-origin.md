# The Tool row header names the Tool origin

ADR 0038 drew a header carrying the tool name and nothing else. Issue #154
widens it: the header now carries the tool name and its Origin tag, so a row
says who supplied its tool - `built-in` for pi's own tool, `mcp` for an MCP
server's tool, and the extension's own name for an extension's tool. The
split between pi and an extension comes from pi's own per-tool source
metadata, but that metadata reports the tools of pi's built-in MCP extension
as built-in too, so the MCP case can only come from pi's own
`mcp__<server>__<tool>` name rule, which the header already parses for its
`server/tool` name.

**Considered options**: a static list of built-in tool names breaks on every
pi rename and can never name an extension; naming the package instead of the
extension says `pi-extensions` on most of this package's rows while never
saying which of its extensions a tool came from, and a git-installed package
path carries no package-name segment for the existing `/tools` rule to find,
which is why `/tools` today labels every directory-style extension `index`;
an SDK origin of its own was left out, because that origin only appears in
embedded runs, which never draw a Tool row in the TUI this extension serves.

## Consequences

- One classifier answers the fact, and the two surfaces show it differently
  on purpose: the transcript names the Tool origin on every row, while the
  `/tools` list keeps its compact convention of no tag for a built-in. Naming
  the extension rather than the package also changes `/tools`: a
  directory-style extension of a git package is labeled by its own name
  instead of `index`.
- The tag is all or nothing. A row too narrow for it loses the tag and its
  separator and draws exactly the line ADR 0038 described, so the ladder that
  spends the rule first, then the name, is unchanged underneath.
- A row whose tool pi does not report - an MCP row in a resumed session
  before its server connected - gets the name rule and nothing else. No tag
  means the origin is unknown, never a guess, which is why built-ins are
  tagged rather than left silent.
- The origin of one tool name is read once and memoized for the life of the
  extension instance. A reload re-runs every extension factory and re-reads
  the registry, so the only stale case is one tool name claimed by two
  extensions inside one session, which pi already resolves by load order.
