# codegraph extension

The codegraph extension embeds the
[`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph)
library in-process (no MCP server, no daemon). It gives the agent transparent
semantic code search over the current project and over dependency sources.
Each git worktree gets its own index, so results always reflect the branch
being edited.

[Internals](/extensions/codegraph/internals): the runtime patch, the full
index lifecycle, root resolution, labels, and the module map.

## Tools

| Tool | Purpose |
| --- | --- |
| `codegraph_search` | Quick symbol search by name. Locations only, no code. |
| `codegraph_impact` | Show what could break if a symbol changes, by depth. The prompt note tells the agent to call it before a refactor of a symbol. |
| `codegraph_node` | Read a file (line numbers, dependents header) or a symbol (signature, body, top callers and callees). File mode behaves like the built-in `read`, plus which files depend on it. |
| `codegraph_explore` | Source, call paths, and relationships for an area in one call. The default first tool for "how does X work" questions. The call trail carries the caller and callee information the dedicated tools used to give. |

The caller and callee tools (`codegraph_callers`, `codegraph_callees`) keep
their definitions in the handlers module but are not registered (issue #72):
`codegraph_explore` carries their information in its call trail, and the
measurement showed the agent answered those jobs with explore. Re-adding
either is one line in the `TOOL` map, a registration change, not a
re-implementation.

Every tool takes an optional `projectRoot` argument. Without it, the call is
served from the worktree the call was made in, resolved automatically.
`codegraph_search` also takes `kind` (a single kind string or an array).

## Per-worktree indexes

Every git worktree gets its own index under `<worktree>/.codegraph/`:

- **Borrowed indexes are never served.** If the nearest initialized index
  lives in another worktree, it is not used; the worktree gets its own
  index instead.
- **Seeding.** A new worktree copies the index database from a sibling
  worktree of the same repository (shared common git dir) and reconciles,
  instead of building from scratch.
- **Prewarm.** The first agent turn of a session starts a background build
  for a worktree that has no index. The first `codegraph_*` call waits for
  that build and is served from it, so the build is never paid twice. A
  background failure never becomes a tool result.
- **Freshness.** The index is reconciled on first use per session, then the
  file watcher keeps it current. If watching is disabled, the index is
  reconciled before every query.
- **Staleness gate at emission.** Sliced source is checked against its
  indexed record before it is emitted. A drifted file never emits a slice;
  a small one serves its full current source instead.

The full lifecycle (prewarm internals, watcher degradation, cross-process
build locks, the staleness gate) is on the
[internals](/extensions/codegraph/internals) page.

## Querying dependency sources (`projectRoot`)

A `projectRoot` argument serves the call from a **dependency source**: the
source tree of one version of one dependency, typically in the opensrc cache
home. The argument takes the path rule (absolute, `~`, or relative to the
working directory). Rules:

- **Trusted roots gate the build.** An index for a named root is built only
  at or under a trusted root: the opensrc cache home (`OPENSRC_HOME`, else
  `~/.opensrc`, when it exists), the `CODEGRAPH_PI_TRUSTED_ROOTS` entries,
  and the roots `/codegraph add` stores for the session. A build outside
  every trusted root is refused with a reason that names the command to
  run. An index that already exists is served wherever it lives.
- **Labels.** Every result from a named root is prefaced with one line:
  `Project: <name> @<version> - <absolute path>`. The label comes from the
  opensrc cache manifest. It makes a wrong version visible and gives the
  agent the path to hand to its next read or grep.
- **Snapping.** A directory inside a cache entry serves that entry's tree,
  so a sub-directory of a dependency works.
- **On demand, always finished.** A named root is built on demand, and a call
  that starts the build waits for it and always finishes: no timeout, no
  "retry later". While the build runs, its progress (the file counts the
  adapter reports) streams to the caller as tool updates, so the wait is
  visible and bounded instead of a silent hang. Later calls pay only the
  reconcile. The root is reconciled before every query, cached per root for
  the session, and never prewarmed, seeded, or watched.
- **Missing sources.** A named directory that does not exist fails with
  `no such directory (<abs>)` plus a hint that names the `opensrc fetch`
  for the dependency. The extension never fetches on the agent's behalf.

### Real example with opensrc

Say the agent edits code that calls into the `herdr` library, and its source
is in the opensrc cache. The agent finds the cache directory and queries it:

```bash
$ opensrc path herdr
/home/seriousjul/.opensrc/repos/github.com/ogulcancelik/herdr/0.0.0
```

Then it passes that directory as `projectRoot`:

```
codegraph_explore(
  query: "worktree create",
  projectRoot: "/home/seriousjul/.opensrc/repos/github.com/ogulcancelik/herdr/0.0.0"
)
```

The first call builds the index for that cache entry (a full build, since
named roots are not prewarmed); later calls in the session hit the cache.
Every result is labeled, so the agent never confuses herdr symbols with
symbols of the project it edits:

```
Project: herdr @0.0.0 - /home/seriousjul/.opensrc/repos/github.com/ogulcancelik/herdr/0.0.0
...symbols, call paths, and source slices from the dependency...
```

One `projectRoot` serves one call. To read the dependency's text that is not
a symbol (comments, config, log strings), the agent greps the same path:

```bash
rg "pattern" $(opensrc path herdr)
```

## Recommended global `AGENTS.md` section

The system prompt note (below) teaches the agent about codegraph inside each
session. For dependency sources, add this section to your global
`~/AGENTS.md` so every agent of every project learns the pattern, including
the grep form the prompt note does not cover:

````markdown
## Source Code Reference

Source code for dependencies is cached at `~/.opensrc/`. A dependency is
indexed on first use: the first codegraph call to its cache directory builds
the index inline, may wait a few seconds, and reports progress as it builds.
Later calls pay only the reconcile. To explore a dependency, use the
codegraph tools with `projectRoot` set to its cache directory
(`opensrc path <package>`). Use `codegraph_explore` for symbol source and
call paths, `codegraph_search` for symbol names, and `codegraph_node` to
read a file. Use grep for text that is not a symbol (comments, config
values, log strings):

```bash
rg "pattern" $(opensrc path <package>)
```
````

The block only pays off when the opensrc cache exists, because the prompt
note's dependency line appears only when at least one trusted root exists
on disk.

## System prompt note

Every agent turn appends one note to the system prompt: a first line that
states the index state (ready, building, or none), then fixed policy lines
that say which tool fits which job. It is the only codegraph steering text
in the prompt, so it is the single place to change policy. The impact line
targets the trigger the agent actually meets (a refactor of a symbol, not
every change), and the dependency-source line carries the first-use promise
(the first call to a dependency builds its index and may wait, and the build
reports progress). A dependency-source line joins the block only when at
least one trusted root exists on disk. The note carries no per-dependency
state, so the system prompt stays stable turn to turn and the provider
cache stays warm. The note appears only when at least one `codegraph_*` tool
is active, a call can actually be served from the working directory, and the
runtime stack passes its preflight check.

## `/codegraph` command

| Verb | Effect |
| --- | --- |
| `/codegraph` | Index status for the current directory, the named roots this session opened, and the trusted roots with their origin. |
| `/codegraph status [path]` | Index status of the named root the path names, or the session root without a path. |
| `/codegraph init [path]` | Force a full rebuild of the index for the given root (trust-gated), or the session root. |
| `/codegraph seed [path]` | Re-seed the session index from a sibling worktree, or seed the named root a path names. Then reconcile. |
| `/codegraph uninit [path]` | Remove the index for the given root (or the session root), with its usage log. Asks for confirmation. |
| `/codegraph add <path>` | Trust a directory for named-root builds for the rest of the session. |
| `/codegraph auto on\|off` | Toggle automatic index creation for the session. |

Status shows local usage from `<worktree>/.codegraph/usage.jsonl`: per-tool
counts, successful and failed calls, time since the last call, and the reason
of the newest failure. The log is append-only, never leaves the machine, and
is removed with the index by `/codegraph uninit`. Delete the file to start
the counts over.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CODEGRAPH_PI_AUTO_INDEX` | `0`/`false`/`off` disables automatic index creation (tools return the fallback line until an index exists). |
| `CODEGRAPH_PI_PREWARM` | `0` disables the first-turn background build. Existing indexes are never prewarmed. |
| `CODEGRAPH_PI_SEEDING` | `0`/`false`/`off` disables seeding from sibling worktrees (first build is from scratch). |
| `CODEGRAPH_NO_WATCH` | `1` disables the file watcher (reconcile before every query instead). |
| `CODEGRAPH_PI_SQLITE_SHIM` | Set to `bun` to force the shim's `bun:sqlite` path (used by the bun-only test). |
| `CODEGRAPH_PI_TRUSTED_ROOTS` | PATH-style list of trusted roots for named-root builds. Entries that do not exist are ignored. |
| `OPENSRC_HOME` | The dependency cache home. When it exists it is a trusted root and the source of project labels and fetch hints. When set but missing, the extension behaves as if opensrc were absent. |
| `CODEGRAPH_NO_FAST_INIT` | Set to `1` automatically on the bun runtime unless the user set it (bun's SQLite engine rejects the fast-init journal-mode change). |
| `CODEGRAPH_TELEMETRY` | Set to `0` by this extension unless already set. |
| `CODEGRAPH_NO_UPDATE_CHECK` | Set to `1` by this extension unless already set. |

## Failure contract

Every tool failure ends with the same line, which tells the model to fall
back to the built-in tools:

```
codegraph is unavailable (<reason>). Use the built-in read and grep tools instead.
```

The reason is recorded in the worktree's usage log, so `/codegraph status`
shows it after the tool result has scrolled away. The extension never turns a
codegraph failure into a session error.
