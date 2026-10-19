# tool-headers extension

Every Tool row sits in the same colored block, and the block says nothing
about which tool it holds. A `bash` and a `powershell` row print only
`$ <command>`; a `codemode` row prints a JSON blob; a `bash` and a `bash_bg`
row are identical in shape. This extension draws one line above each row's
call line - the **Tool row header**: the tool name and its Origin tag, set
in a rule - so the tool and the unit that supplied it are told at a glance.

## Screenshot

The same session, once without the extension and once with it: the only
difference is the header line above each call line. The `note_search` row in
both images is a capture-only fixture extension that stands in for an
extension's row: it registers one tool with fixed arguments and fixed
output, so the pair is byte-stable, while a real `bash_bg` row would carry a
job id, pid, and log path that never are.

| Without tool-headers | With tool-headers |
| --- | --- |
| ![Tool rows without headers](./tool-headers-before.png) | ![Tool rows with headers](./tool-headers.png) |

## The header line

The header is the fieldset legend of the row: the tool name in the theme's
`toolTitle` (bold), followed by its Origin tag in `muted` (unbold), set in a
rule of `─` in `borderMuted`, running to the right edge of the box's content
area. The name and the tag are joined by a `·` separator in `borderMuted`,
like the rule. The name stays the only bold thing on the line, so the name
stays the payload. The line is always exactly one row.

```
(blank)
  ── read · built-in ─────────────────────────────────────────────────────
  read src/auth/session.ts (1-40)
  42 lines
(blank)
```

### The Origin tag

The tag tells the Tool origin - the unit that supplied the tool (ADR 0045).
There are three tags:

- `built-in` for pi's own tools, including the tools of pi's built-in
  extensions (`codemode`, `tool_search`). Built-ins are tagged on purpose:
  it keeps "no tag" meaning exactly one thing.
- `mcp` for an MCP server's tool. The row's name already carries the server
  (`server/tool`), so repeating the server in the tag would say nothing new.
- The extension's own name for an extension's tool: `bash_bg` wears
  `background-jobs`, `codegraph_search` wears `codegraph`. The tag names the
  extension, not the package - a git-installed package path carries no
  package-name segment, and one name per package would say `pi-extensions`
  on most rows without ever saying which extension.

The origin comes from the shared classifier
(`extensions/shared/tool-origin.ts`), which answers the fact, not the
rendering: the origin's kind plus its tag text. The classifier reads pi's
per-tool source metadata, and one name rule that overrides it: pi's own
built-in MCP extension reports its tools as built-in, so only pi's
`mcp__<server>__<tool>` name rule can say `mcp` - the same rule the header
already uses for its `server/tool` name. A tool pi does not report - an MCP
row in a resumed session before its server connected - gets the name rule
and nothing else. No tag is never a guess, and `unknown` is a word the
operator cannot act on, so it is not printed.

The classifier's answer for a tool name is read once from
`pi.getAllTools()` and memoized for the life of the extension instance,
because the registry call rebuilds its array and `renderCall` runs on every
repaint of every row. A reload re-runs the extension factory and re-reads
the registry, so the only stale case is one tool name claimed by two
extensions inside one session, which pi resolves by load order anyway. The
same classifier serves the `/tools` list, which keeps its compact
convention of no tag for a built-in.

### The width ladder

When the width is tight, the line spends the rule first, then the tag, then
the name (ADR 0038's ladder, extended in one order):

1. the trailing rule collapses to zero (`── <name> · <tag>`), the tag still
   whole;
2. the whole tag and its separator disappear together - never a shortened
   form of the tag - leaving exactly the ADR 0038 line (`── <name>` filled
   with `─`, or `── <name>` when the rule is gone);
3. only if the name alone no longer fits is the name truncated, ending in
   `…`.

Below the point where the tag no longer fits, the line is exactly the one
ADR 0038 described.

## Scope

The header lands on every Tool row: the built-ins (`read`, `bash`,
`powershell`, `edit`, `write`, `grep`, `find`, `ls`), this package's tools
(`codegraph_*`, `bash_bg`, `job_wait`, `job_status`, `skill`, `codemode`),
`tool_search`, and MCP tools. The rows that look alike today are exactly the
ones that carry the value:

- A `bash` row and a `bash_bg` row are identical in shape; the header is what
  finally tells one from the other. The `bash_bg` call line stays `$ <command>`
  with no background marker ([ADR 0024](/adr/0024-bash-bg-tool-row-shows-the-plain-command-line)).
- An MCP row's header shows `server/tool`, dropping pi's `mcp__` spelling,
  the same form the row's call line uses, so the two agree. Every other row
  shows the tool's raw name.
- A tool that ships no renderer of its own keeps its stock call line (the
  shape pi's fallback draws) and gains the header above it.

The `edit` row sets its own shell and draws its diff preview instead of the
green box; its header goes above that preview, inside the self shell.
Uniformity is the point: a row that skipped the header would be the row the
operator misreads.

## How it works

The mechanism is a `pi.registerToolRenderer()` resolver that calls `next()`
first and wraps whatever pi or another extension would draw, prepending the
header. Wrapping reaches built-in tools, this package's tools, and MCP tools
through one path, and it composes with pi's own MCP resolver and with
`bash_bg`'s renderer instead of shadowing either
([ADR 0038](/adr/0038-tool-row-headers-wrap-pi-tool-renderers)). The resolver
never registers a tool: it changes a picture, not an execution.

- A `next()` of `undefined` (a tool pi knows no renderer for) yields
  `undefined`, leaving the row exactly as pi draws it.
- The wrapper keeps pi's inner component in per-row state and hands it back as
  `context.lastComponent`, so pi's built-in renderers keep their caches: the
  `edit` diff preview, the `write` highlight, the `bash` timer and truncation
  footer all still update, and click-to-expand and inline images keep working.
- The header's Origin tag comes from the shared classifier (above), and the
  row's result block, its shell, and its padding line are untouched: the tag
  is the only thing the row gains besides the name.
- The renderer serves the interactive transcript and the HTML export alike;
  the header, tag and all, draws in both.

## Always on

The extension is always on, with no setting and no command. It is a rendering
opinion in a personal package; the way to opt out is to not load the file.
