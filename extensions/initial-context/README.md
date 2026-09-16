# Initial context

The token breakdown of the running agent's initial context: the system
prompt and the tool definitions, which are resent to the model on every LLM
call. One row per section and per tool, with token counts, percentages,
and bars.

## /ctx (TUI)

Opens the breakdown. Rows appear in a fixed block order:

1. base prompt (or custom prompt)
2. append text
3. project instruction files, one row per file
4. skills, one row per skill
5. cwd line
6. prompt injection, when other extensions appended to the prompt
7. tools, sorted by estimated size, largest first

Every row shows its token count, its share of the initial context total,
its share of the context window, and a bar.

| Key | Action |
| --- | --- |
| `j` / `k` | move the cursor (scroll the pane when expanded) |
| `e` | expand the row to the exact text, or collapse |
| `c` | copy the expanded row, or the whole breakdown |
| `esc` / `q` | close |

A footer status line keeps the total visible without opening the view:
`ctx: 45.2K (11.3%)`. The count is compact and uses the system locale's
number format.

In headless modes the command prints the same breakdown as plain text:
a notify record in RPC mode, the console in print mode.

## How the numbers are built

The prompt rows come from the same structured inputs pi uses to build the
system prompt (base template, append text, project files, skills, cwd).
Tool rows come from the tool entries actually sent to the provider,
captured read-only from the last provider request payload. Before the
first call, built-in schemas are rebuilt from pi's exported tool factories
and marked `built-in schema`; tools that cannot be resolved are listed by
name with `waiting for first call`.

Token counts use pi's own estimator (chars / 4), so every row shares one
consistent scale. The first assistant response also records the input
tokens the provider reported, shown as a reference line. It is display
only: the bar and percentages stay comparable across rows.

If other extensions append to the prompt, an injection row shows the
suffix; anything else that changes the prompt is flagged
`modified by extension`.

This extension registers no tools, no prompt text, and no prompt notes of
its own, so its own overhead is zero.

## Files

- `context.ts` pure core: row construction, payload parsing, injection
  detection, token estimation, plain-text rendering
- `tui.ts` the TUI view
- `index.ts` event wiring and the `/ctx` command
