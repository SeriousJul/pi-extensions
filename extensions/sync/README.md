# sync extension

Cross-device sync of pi config files (issue #32). One shared tree of
user-chosen home files (the `AGENTS.md`, `OPINIONS.md`, and dotfile set
named in a sync manifest) stays in sync across all the user's machines,
through a pluggable Backend. v1 ships exactly one backend: a **secret
GitHub Gist**. The Backend is a single seam, so a later backend (S3,
Syncthing, rsync) is a new implementation, not a redesign.

## What gets synced

The manifest is an owner-only JSON file in the sync state dir
(`~/.pi/sync/manifest.json` by default). It is **default-deny**: only
paths matched by an `include` glob are synced.

| Key | Default | Meaning |
| --- | --- | --- |
| `v` | `1` | Manifest format version. |
| `include` | `.pi/agent/settings.json`, `.pi/agent/extensions/**`, `.pi/agent/skills/**`, `.pi/agent/themes/**`, `.pi/agent/models.json`, `.pi/agent/models-store.json`, `.pi/web-search.json`, `AGENTS.md`, `OPINIONS.md`, `VOICE.md` | Globs relative to the home. `**` crosses directories; `*` does not; `?` is one non-`/` character. |
| `exclude` | `.pi/agent/auth.json`, `.pi/agent/sessions/**`, `.pi/agent/npm/**`, `.pi/agent/git/**`, `.pi/agent/bin/**`, `.pi/agent/trust.json`, `.pi/agent/*-debug.log` | Globs that beat every include: credentials, sessions, caches, and logs never sync. |
| `backend` | `github-gist` | Registered backend id. |
| `backendOptions.gistId` | `""` | Device-local: the gist id this device syncs. A new device is told the id at init; the shared manifest itself carries none. |

Files that do not match are invisible to the tool - it never reads,
hashes, or backs them up. Walking skips symlinks and the directories
`node_modules` and `.git`.

## Operations

All four exist as pi commands (`/sync ...`, with a TUI status dialog) and
as CLI verbs (same code, `extensions/sync/ops.ts`):

| Verb | Effect |
| --- | --- |
| `pi-sync init <gist-id>` | Join a new device: fetch the shared tree, adopt the files this device lacks, and record the gist id locally. |
| `pi-sync push` | Merge local + remote, upload the merged tree, then apply the merge to the local tree. |
| `pi-sync pull` | Merge local + remote and apply to the local tree. |
| `pi-sync status` | The merge without side effects: ahead / behind / conflict. |

`push` uploads **first**: a network failure leaves the local tree
untouched. Unreadable files and non-text files are skipped with a
warning line in the report, so a partial or binary-laden tree never
silently goes out wrong. The device-local base is recorded only after
the local apply succeeds, so a push whose apply fails cannot leave a
half-merged tree labeled "in sync".

## Merge semantics

The merge is a pure function (`extensions/sync/merge.ts`) over three
snapshots: **base**, **local**, **remote**.

- **Base is device-local.** Each device caches the Base of its last sync
  in `<state-dir>/base-state.json` (owner-only). The shared base in the
  gist advances with every push, so a device that has not pulled must
  merge against the base *it last saw*, not the newest one - otherwise
  every quiet file on the stale device reads as "changed by both sides".
  After a pull the cache is the newest shared base; after a push it is
  the base the device just wrote.
- **Unchanged + unchanged:** no action.
- **One side changed:** take the changed side.
- **Both changed, same content:** converged. The file is rewritten with
  the shared content and its mtime is normalized (no backup).
- **Both changed, different content:** conflict. The newer file mtime
  wins; on an equal mtime the **local** side wins, so a pull never
  clobbers an edit made at the same second it ran.
- **Deleted one side, changed the other:** the change wins. Deleted on
  both sides: stays deleted.
- **New on one side:** appears on the other.
- **Not covered by either manifest:** unmanaged. Files the shared tree
  holds that no manifest pattern covers (for example hand-added in the
  GitHub UI) never enter the merge: no device applies them locally and
  they never reach the base state.

Every file the merge overwrites gets a backup named
`<path>.<millis>.bak` next to it. The collector skips `*.bak`, so
backups never enter a snapshot. The tool never deletes user files that
the manifest no longer matches.

A joining device (init) adopts every manifest-covered shared file it
lacks. The tool-managed manifest is never adopted by the merge; the
init operation writes it explicitly, which keeps the local copy's gist
id intact.

**Hand-added files are protected.** A gist file the tool never managed
(for example one added in the GitHub UI at a path no pattern covers) is
never deleted by a push: the backend leaves it in place, and every push
reports it, so the user can delete it deliberately in the GitHub UI.

## Reference scanner

Before init, pull, and push, the local markdown files are scanned for
references to paths outside the manifest: `~/...` tokens and markdown
link targets. The scanner dedupes by (file, resolved path) pair; each
distinct uncovered pair produces one warning line. The warnings are
advisory: the operation still runs. This
implements the spec's "detect and warn" for cross-references that would
dangle after a sync.

## The Gist backend

- One **secret** gist holds the whole tree: one entry per file, plus two
  tool-managed entries - `.pi-sync-manifest.json` (the manifest) and
  `.pi-sync-base-state.json` (the shared base).
- **Limits are enforced locally, before any request:** 20 files max
  (the gist file cap), 10 MB total (the gist body cap).
- **Transport is a seam.** `GistTransport` is one `request` function
  (method, url, headers, optional body). Production uses the global
  `fetch` against
  `https://api.github.com` (overridable by `PI_SYNC_GITHUB_BASE_URL`);
  tests stub it, the CLI E2E stands up a loopback server, and the real
  API is covered by the opt-in e2e.
- Every request carries `Authorization: Bearer <token>`; the token is
  never logged, and failure reports carry the GitHub message without
  credentials.

## Token and state

| Location | Purpose |
| --- | --- |
| `~/.pi/sync/token` (or `$PI_SYNC_STATE_DIR/token`) | GitHub token, mode 600. A group/world-readable file produces a warning in every report (CLI and pi commands). |
| `PI_SYNC_TOKEN` | Overrides the file for one run. |
| `~/.pi/sync/manifest.json` | The device's manifest copy (carries the local gist id). |
| `~/.pi/sync/base-state.json` | The device's last-synced Base (owner-only). |
| `PI_SYNC_HOME` / `PI_SYNC_STATE_DIR` / `PI_SYNC_GITHUB_BASE_URL` | Relocate home, state dir, and API base for scripted runs. |

## pi integration

`/sync push`, `/sync pull`, and `/sync status` open a TUI dialog with the
full report (in print and RPC modes the report goes to the stream);
`/sync` alone prints the usage. On session start, when this device is
already joined, the extension runs a read-only status in the background
(5 s timeout) and, on drift, puts a footer status line up:

```
sync: 2 ahead, 1 behind
```

No token, not joined, zero drift, or a failed read: the line stays
empty. Nothing on startup ever mutates the tree or the backend.

## Module map

| File | Role |
| --- | --- |
| `types.ts` | The seams: `SyncManifest`, `Snapshot`, `BaseState`, `Backend`. |
| `manifest.ts` | Manifest parse/validate/serialize, glob matching, `walkRoots`. |
| `hash.ts` | sha256 hex and the strict UTF-8 check. |
| `localfs.ts` | Local collect (symlink and dir-name guards), plan apply with backups, manifest + base-state files. |
| `merge.ts` | The pure three-way merge. |
| `refs.ts` | The cross-reference scanner. |
| `token.ts` | Token resolution, home/state-dir locations. |
| `backends.ts` | Backend registry. |
| `backends/github-gist.ts` | The Gist backend over the `GistTransport` seam. |
| `ops.ts` | The four operations; one `SyncRuntime` for CLI and pi. |
| `cli.ts` / `cli.mjs` | The `pi-sync` CLI (jiti-loaded TS, no build step). |
| `index.ts` | The pi extension: `/sync`, the startup notice. |

## Tests

```bash
npx vitest run tests/sync     # unit + CLI E2E (loopback fake API), no network
PI_SYNC_TOKEN=<gist token> node tests/sync/e2e-gist.mjs   # opt-in real API
```

- `manifest.test.ts` - glob semantics, validation, canonical serialization.
- `merge.test.ts` - every merge case from the spec table.
- `refs.test.ts` - scanner coverage and caps.
- `token.test.ts` - token precedence and state-dir overrides.
- `ops.test.ts` - the operations on real temp homes against the in-memory
  fake backend, including the multi-device stale-base scenarios.
- `gist-backend.test.ts` - the Gist backend against a stubbed transport.
- `cli.test.ts` - the CLI E2E: a loopback server speaks the Gist API,
  two homes sync through the real HTTP stack.
