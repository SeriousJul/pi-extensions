# pi-extensions

A pi package that bundles pi extensions. This package contains:

- **codegraph** - semantic code index for the agent. The main extension.
- **tools** - the `/tools` command to enable and disable tools per session.
- **context-cap** - `--context-window <tokens>` caps the session's context window so compaction fires early.
- **model-router** - recovers a session from a provider usage-limit halt (switch to a fallback or wait for the reset, then resume).
- **quota** - monitors the OpenAI ChatGPT plan quota: a footer line with the used windows, and a `/quota` detail view.
- **sync** - cross-device pi config sync: `/sync` plus the `pi-sync` CLI, three-way merge, v1 backend a secret GitHub Gist.
- **hello** - a minimal example extension.

See the [pi packages docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and the [extensions docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Layout

```
.
├── package.json      # pi manifest under the "pi" key, pi-package keyword
├── tsconfig.json     # type checking only. pi loads .ts via jiti, no build step
├── extensions/       # every .ts file (or subdirectory with index.ts) is an extension
│   ├── hello.ts
│   ├── tools.ts
│   ├── context-cap/  # multi-file extension, entry point at context-cap/index.ts
│   ├── model-router/ # multi-file extension, entry point at model-router/index.ts
│   ├── quota/        # multi-file extension, entry point at quota/index.ts
│   ├── sync/         # multi-file extension, entry point at sync/index.ts, plus the pi-sync CLI
│   └── codegraph/    # multi-file extension, entry point at codegraph/index.ts
├── docs/adr/         # architecture decision records
├── scripts/          # postinstall patch for the embedded codegraph library
└── tests/            # vitest suite
```

`extensions/` is a convention directory: every `.ts` file in it is loaded as
an extension. Multi-file extensions go in a subdirectory with an `index.ts`
entry point. You can also add `skills/`, `prompts/`, and `themes/`
directories and list them in the `pi` manifest in `package.json`.

## Install

Install into user settings (default):

```bash
pi install /absolute/path/to/pi-extensions
```

Or into project settings, shared with the team:

```bash
pi install -l /absolute/path/to/pi-extensions
```

Git URLs work too. Remove with `pi remove <package>`, list with `pi list`.

After any install, run `npm install` in the package directory once. The
`postinstall` step (`scripts/patch-codegraph.mjs`) prepares the pinned
`@colbymchenry/codegraph` package for the runtime pi embeds. The patch is
idempotent and uses absolute paths, so re-run `npm install` if you move the
repo. See `extensions/codegraph/README.md` for what the patch does and why.

### Develop

Test a package or a single extension in a pi session without installing:

```bash
pi -e /absolute/path/to/pi-extensions
pi -e /absolute/path/to/pi-extensions/extensions/hello.ts
```

```bash
npm install
npm run typecheck
npm test
```

# codegraph extension

The codegraph extension embeds the
[`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph)
library in-process (no MCP server, no daemon). It gives the agent transparent
semantic code search over the current project and over dependency sources.
Each git worktree gets its own index, so results always reflect the branch
being edited.

Full internal documentation (state machine, freshness guarantees, module map)
lives in [`extensions/codegraph/README.md`](extensions/codegraph/README.md).
This section covers what you configure and what the agent sees.

## Tools

| Tool | Purpose |
| --- | --- |
| `codegraph_search` | Quick symbol search by name. Locations only, no code. |
| `codegraph_callers` | List functions that call a symbol. |
| `codegraph_callees` | List functions called by a symbol. |
| `codegraph_impact` | Show what could break if a symbol changes, by depth. |
| `codegraph_node` | Read a file (line numbers, dependents header) or a symbol (signature, body, top callers and callees). File mode behaves like the built-in `read`, plus which files depend on it. |
| `codegraph_explore` | Source, call paths, and relationships for an area in one call. The default first tool for "how does X work" questions. |

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
- **On demand.** A named root is built on demand, reconciled before every
  query, cached per root for the session, and never prewarmed, seeded, or
  watched.
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

Source code for dependencies is cached at `~/.opensrc/`. Each cache
directory is indexed by codegraph. To explore a dependency, use the
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
in the prompt, so it is the single place to change policy. A dependency-source
line joins the block only when at least one trusted root exists on disk. The
note appears only when at least one `codegraph_*` tool is active, a call can
actually be served from the working directory, and the runtime stack passes
its preflight check.

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

# tools extension

The `/tools` command opens a TUI list of every tool in the session. Toggle a
tool to enable or disable it; the change applies immediately. The selection
persists in the session (a `tools-config` entry) and is restored on session
start and branch navigation, so it respects the session tree. Non-built-in
tools show a tag with their origin (package name or file name), so you can
see which extension provides each tool.

# context-cap extension

Caps the effective context window for a pi session, so auto-compaction fires
early and prompts stay small:

```bash
pi --context-window 32000
# or
PI_CONTEXT_WINDOW=32000 pi
```

The cap is a ceiling (`min(cap, model window)`), it is session-wide (initial
model, switches, resume), and the picker and footer show the capped window.
pi reports an error and runs uncapped when the value is not a positive
integer or is at or below `compaction.reserveTokens`. See
[`extensions/context-cap/README.md`](extensions/context-cap/README.md) and
[ADR 0004](docs/adr/0004-context-window-cap-via-provider-reregistration.md).

# model-router extension

Recovers a session from a provider usage-limit (quota) halt, so an
unattended run survives a ChatGPT plan limit instead of dying at an error.
When a turn settles with a terminal usage-limit error, the router runs the
configured strategies in order: switch to the first usable fallback model, or
wait for the quota window to reset. It resumes the halted turn with one
synthetic user message, and switches back to the original model once the
quota recovers and the session is idle.

Configuration is the `modelRouter` section of `settings.json`. Project
`<cwd>/.pi/settings.json` overrides global `~/.pi/agent/settings.json`, key
by key:

```json
{
  "modelRouter": {
    "precedence": ["switch", "wait"],
    "fallbacks": ["anthropic/claude-sonnet-4-5", "google/gemini-3.5-flash"],
    "maxWaitMinutes": 360
  }
}
```

| Key              | Default             | Meaning                                                       |
| ---------------- | ------------------- | ------------------------------------------------------------- |
| `enabled`        | `true`              | Turn the router on or off.                                    |
| `precedence`     | `["switch","wait"]` | Strategy order on a halt.                                     |
| `fallbacks`      | `[]`                | Ordered `"provider/model-id"` entries the switch strategy tries. |
| `maxWaitMinutes` | `360`               | Only wait when the binding reset is within this many minutes. |

The wait strategy and the switch-back only apply to the `openai-codex`
(ChatGPT plan) provider, because that is what the Quota source reads; for any
other provider only switch applies. User input cancels a pending wait; a
manual model change cancels the wait and the pending switch-back. Recovery is
bounded to three strategy cycles per failed prompt, and a pending recovery
survives a restart. Transient throttles and overloads stay with pi's built-in
retry. See
[`extensions/model-router/README.md`](extensions/model-router/README.md).

### Real example: a fallback chain walk

Observed in a live session on 2026-09-14. The user typed `test` on
`qwen-token-plan-individual/qwen3.8-max` while the token plan was
exhausted. The error body carries `insufficient_quota`, which the
classifier matches:

```
13:06:38  ASSIST qwen3.8-max  stop=error
          429: {"message":"Your token-plan 1-week quota has been
          exhausted. The quota will reset at 09-19 15:43:00 UTC.",
          "type":"insufficient_quota","code":"insufficient_quota"}
          -> router switched to qwen3.8-flash
13:07:15  ASSIST qwen3.8-flash  stop=error (same 429)
          -> persisted recovery: {"phase":"on-fallback",
             "original":"qwen-token-plan-individual/qwen3.8-max",
             "chainPos":2,
             "fallbackInUse":"qwen-token-plan-individual/qwen3.8-flash",
             "cycles":1}
          -> router sent the Recovery message; flash halted on it
          -> chain advanced: chainPos 3,
             fallbackInUse llama.cpp/unsloth/qwen3.8-27b, cycles 2
          -> router sent the Recovery message on the local model
13:07:24  ASSIST llama.cpp (unsloth/qwen3.8-27b) ran the resumed turn
```

The wait strategy did not run: it applies only to `openai-codex`, so this
recovery was a pure switch walk until the local model took over. The
`model-router-pending` session entries above are also what re-arms the
recovery if the session restarts mid-walk.

# quota extension

Monitors the OpenAI ChatGPT plan quota, so the user sees the remaining
budget before a 5-hour or weekly limit is hit mid-task. A footer line
always shows the plan's quota windows as used percentages (`GPT 5h 42% · 7d
18%`, `FULL` in the error color when exhausted, `stale` when the last read
failed). `/quota` forces a fresh read and shows plan type, account email,
reset times, and time left. The quota is read at session start and every 5
minutes (a fixed constant, not configurable). It works from any session and
refreshes the ChatGPT access token itself when it expires (ADR 0005). See
[`extensions/quota/README.md`](extensions/quota/README.md).

# sync extension

Keeps the user's pi config (the files named in a default-deny sync
manifest) in sync across devices through a pluggable Backend. v1 ships
one backend: a secret GitHub Gist. `push` and `pull` run a three-way
merge (the device's last-synced base, local, remote); a same-second
conflict keeps the local side, and every overwritten file gets a
`<path>.<millis>.bak` backup. `push` uploads the merged tree before it
touches the local tree, so a network failure leaves the tree intact.

```bash
pi-sync init <gist-id>   # first device on a new machine
pi-sync push             # upload this device's changes (merged)
pi-sync pull             # take the other devices' changes
pi-sync status           # ahead / behind / conflict, no side effects
```

In a session: `/sync status`, `/sync pull`, `/sync push` (TUI dialogs).
At startup, a joined device gets a footer line with the ahead/behind
counts when the tree has moved. The token lives in `~/.pi/sync/token` (mode 600) or
`PI_SYNC_TOKEN` for one run. See
[`extensions/sync/README.md`](extensions/sync/README.md) for the merge
semantics, the manifest, and the module map.

# hello extension

A minimal example extension: registers a `/hello` command that shows a
notification. Use it as a starting point.

## Writing an extension

An extension is a TypeScript module with a default export:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("loaded", "info");
  });

  pi.registerCommand("my-cmd", {
    description: "Do a thing",
    handler: async (args, ctx) => {
      ctx.ui.notify(args || "hi", "info");
    },
  });
}
```

Core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`) are bundled by pi at runtime. List the
ones you import in `peerDependencies` with a `"*"` range, and do not bundle
them. If an extension needs third party npm packages, add them to
`dependencies` in `package.json` and run `npm install`. Runtime installs are
production installs, so `devDependencies` are not available when the package
is installed by pi.

## Test

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest suite; runs on Node or bun
npm run smoke:node  # plain-Node smoke test: loads the extension through jiti
                    # exactly like pi does, builds a real index on a fixture
                    # repository, and runs real tool handlers
```

Bun-only tests for the SQLite shim path:

```bash
bun test tests/codegraph/shim-bun.test.cts
bun test tests/codegraph/runtime-bun.test.cts
```

## Documentation

- [`extensions/codegraph/README.md`](extensions/codegraph/README.md) - the
  full internal reference for the codegraph extension: the runtime patch,
  index lifecycle, root resolution, labels, and the module map.
- [`extensions/sync/README.md`](extensions/sync/README.md) - the sync
  extension reference: manifest, merge semantics, Gist backend, module map.
- [`CONTEXT.md`](CONTEXT.md) - the domain glossary (index, project root,
  named root, trusted root, seed, reconcile, prewarm, and the rest).
- [`docs/adr/`](docs/adr/) - the architecture decisions behind the design.
- Design specs 0001-0009 live as GitHub issues on this repository; the
  issue titles carry the spec numbers, and `spec 000X` references in code
  comments point to them.
