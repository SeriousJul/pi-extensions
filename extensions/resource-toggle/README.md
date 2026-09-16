# Resource Toggle

Enable and disable extensions, skills, prompt templates, and themes from
inside a running session. The state lives in pi's native settings override
patterns - the same files and format `pi config` uses (ADR 0012) - so the
two tools are interchangeable and a change made in one shows up in the
other.

## Commands

| Command | What it does |
| --- | --- |
| `/resources` | Interactive list in TUI mode; a text table in headless modes. `/resources --project` prints the project view. |
| `/enable <name>` | Enable one resource. Default global mode; `--project` for project mode. |
| `/disable <name>` | Disable one resource. Same scope flags. |
| `/inherit <name>` | Clear the project override of one resource so it returns to the global state. Project mode only. |

`<name>` is the display name of the resource (a skill's frontmatter name,
an extension's file or folder name). An exact name match wins; otherwise a
unique name prefix, then a unique path fragment, resolves the row. An
ambiguous or missing name is reported with the candidates, nothing is
written.

## Write modes

The extension writes the override patterns, never the files:

- **Global mode** (default): the pattern goes to the global settings
  (`~/.pi/agent/settings.json`).
- **Project mode**: the pattern goes to the project settings
  (`.pi/settings.json`). A project-mode change of a global resource
  writes a shadow pair - the absolute path and a negated absolute path -
  to the project file, leaving the global file untouched. The project
  file wins, so the resource loads or unloads in this project only.
- **Inherit**: removes the resource's entries from the project file.

A write touches only the arrays the operation changed, and the native
writer merges those into a fresh read of the file under a lock, so
concurrent pi sessions do not clobber each other's entries. A write to
the project file in an untrusted project is refused by the native trust
assertion; the error is shown, not retried.

## Reload and the self-guard

Every successful change writes the settings and then reloads the session,
so the effect is immediate. A reload rebinds every extension, so the
in-session state of other extensions resets (their persisted state, like
session settings, survives). The extension refuses to disable itself:
removing it would remove the toggle commands and the tool. Package
resources are shown dimmed and read-only in the list.

## resource_toggle (agent tool)

The agent path mirrors the commands: `action: list` returns the text
tables, `enable`, `disable`, and `inherit` plus a `name` apply the change
with the same scope rules. With no arguments it opens the interactive
list for the user. A change made through the tool cannot reload directly,
so the reload rides on an internal `/resource-reload` command queued as a
follow-up message.

## The interactive list

Opens in global mode; `Tab` switches to project mode.

| Key | What it does |
| --- | --- |
| `tab` | Switch between global mode and project mode |
| `space` | Toggle the row. Global mode: enable/disable. Project mode: cycle inherit, load, unload on global resources |
| up / down | Move the cursor |
| typing | Filter by name, path, or type |
| `esc` | Close the list |

Project mode renders inherited global resources dimmed and shows the
override state: `[x]` / `[ ]` inherited, `[+]` project load, `[-]`
project unload. Every toggle writes the settings at once; if anything
changed, one reload runs on close.

## Tests

- `npm test` runs the unit suite: the state machine, the resolver, the
  matcher, the writer, and the TUI component.
- `npm run e2e:resource-toggle` drives a real pi process in RPC mode in a
  sandboxed home and asserts on the settings files and the live command
  and tool lists through a full disable/enable, shadow, and inherit
  cycle.
