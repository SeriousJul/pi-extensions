# Resource Toggle

Enable and disable extensions, skills, prompt templates, and themes from
inside a running session. The state lives in pi's native settings - the
same files and format `pi config` uses (ADR 0012): override patterns in
the resource arrays for top-level resources, and the packages-array
filter for package-bundled resources (ADR 0029). So the two tools are
interchangeable and a change made in one shows up in the other.

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
removing it would remove the toggle commands and the tool.

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

## Package resources

Package-bundled resources are listed with a `(package)` label and toggle
like any row. Their state does not live in a resource array - pi ignores
package-relative patterns there. It lives in the packages array of the
settings, where the package's entry becomes object form carrying a
per-resource-type filter, with patterns relative to the package root:

```json
{ "source": "git:github.com/acme/pkg", "extensions": ["-extensions/usage/index.ts"] }
```

- **Global mode** writes the filter into the packages entry of the
  settings file the resource resolves from.
- **Project mode** writes it into the project packages entry, which
  replaces the global entry for the same package - pi dedupes by source
  and does not merge. A local source is rewritten relative to the
  project directory so the project file stays portable.
- **Inherit** removes the resource's filter patterns from the project
  entry; an entry that loses its last filter collapses back to the plain
  source string.

Local package sources resolve with pi's rules: a leading `~` expands to
the home directory and a `file:` URL to its path, before the source
resolves against the settings directory of its scope. Two local sources
that resolve to the same path name the same package.

An empty per-type array is never written, because in pi it disables the
whole type. When a transition touches a package resource, it also removes
the old no-op package-relative pattern the previous code wrote into the
resource arrays, so a harmed settings file heals itself on first use. The
self-heal removes a pattern only when no top-level resource relies on it:
the same string can also be the own-scope pattern of a top-level resource
at the same relative path, and that one is real.

A toggle of a resource from a single-file package source is refused with
a clear message: pi loads a single-file source unconditionally and never
applies a packages-array filter to it, so its state cannot be toggled.

## Settings drift

The lists also report settings drift (ADR 0047): lines in the settings
that express intent that does nothing. The check rides on the same
resource resolution the lists perform and reports three classes:

- **Stale entry**: an override pattern in a resource array, or an entry of
  a package filter, that matches no loaded resource and, where it names a
  file, names no file on disk. A package filter left behind when a sibling
  package is dropped is a stale entry.
- **Conflicting entries**: one array that force-includes and
  force-excludes the same target.
- **Configured while disabled**: an extension that is disabled while a
  top-level settings key equal to its name in camelCase (`model-router`
  to `modelRouter`) exists in the settings. The key match is a name guess,
  so this class is reported as possible, never as a hard error.

Each finding names its scope - global, project, or the package source - so
the fix lands in the right file. An untrusted project covers the global
scope only, matching the rest of the resource view. Findings are
deduplicated and sorted, so the notice and the tables are stable across
runs and modes.

The findings render as a read-only Drift group at the top of the
interactive list, as a section of the headless tables, and in the
`resource_toggle` tool's list output. One notice at session start reports
the finding count and points at `/resources` when the findings are
non-empty; clean settings produce no group, no section, and no notice. The
check names the drift; deleting the line is the user's edit.

## Tests

- `npm test` runs the unit suite: the state machine, the resolver, the
  matcher, the writer, the drift check, and the TUI component.
- `npm run e2e:resource-toggle` drives a real pi process in RPC mode in a
  sandboxed home and asserts on the settings files and the live command
  and tool lists through a full disable/enable, shadow, and inherit
  cycle, plus a package cycle that starts from the harmed settings shape
  (an old no-op pattern) and asserts the self-heal, and a drift cycle that
  seeds a stale package-filter entry and a disabled extension under a
  settings key and asserts the headless tables, the tool output, and the
  once-per-process session-start notice.
