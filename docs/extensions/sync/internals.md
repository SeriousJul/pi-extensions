# sync internals

The internal reference for the sync extension: the manifest, the merge
semantics, the token lifecycle, the Gist backend, and the module map. For
the onboarding wizard and the commands, see the
[sync page](/extensions/sync/).

## The token lifecycle (ADR 0007)

| Token form | How it is managed |
| --- | --- |
| **Managed** (device flow) | Stored as JSON in `<state-dir>/token` (mode 600) with `accessToken`, `refreshToken`, and expiry. The tool **renews it while it lives**: proactively when a run starts inside the 5-minute skew window, and reactively when a request gets a 401/403 (the request retries once with the fresh token). Bounds: at most one proactive refresh at run start, plus at most one reactive refresh or one device-flow re-run on a mid-operation 401/403; the device flow re-run needs a terminal, so a headless run reports the fix instead of looping. |
| **Hand-written** (plain text file or `PI_SYNC_TOKEN`) | Respected but **never managed**: no refresh, no device flow, no rewrites. A dead hand-written token produces the plain "token rejected" error. |

A 404 (gist not found, not a permission problem) never enters renewal:
it is a plain error. In pi, nothing on session start ever triggers the
device flow: startup work is read-only.

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
advisory: the operation still runs. This implements the spec's
"detect and warn" for cross-references that would dangle after a sync.

## The Gist backend

- One **secret** gist holds the whole tree: one entry per file, plus two
  tool-managed entries - `.pi-sync-manifest.json` (the manifest) and
  `.pi-sync-base-state.json` (the shared base).
- **Limits are enforced locally, before any request:** 20 files max
  (the gist file cap), 10 MB total (the gist body cap).
- **Transport is a seam.** `GistTransport` is one `request` function
  (method, url, headers, optional body). Production uses the global
  `fetch` against `https://api.github.com` (overridable by
  `PI_SYNC_GITHUB_BASE_URL`); tests stub it, the CLI E2E stands up a
  loopback server, and the real API is covered by the opt-in e2e.
- **Updates use `PATCH /gists/{id}`.** The legacy `PUT` alias is not in
  the fine-grained PAT endpoint list, and GitHub answers it with a 404
  that reads as "gist not found".
- Every request carries `Authorization: Bearer <token>`; the token is
  never logged, and failure reports carry the GitHub message without
  credentials. A 401/403 on an authenticated request gives the auth
  session one chance to renew the managed token and retry the request
  once.

## Token and state

| Location | Purpose |
| --- | --- |
| `~/.pi/sync/token` (or `$PI_SYNC_STATE_DIR/token`) | The GitHub token, mode 600: managed JSON (device flow) or hand-written plain text. A group/world-readable file produces a warning in every report (CLI and pi commands). |
| `PI_SYNC_TOKEN` | Overrides the file for one run. Never managed. |
| `~/.pi/sync/oauth-client.json` | The public OAuth client id, written by `scripts/setup-sync-wizard.sh`. |
| `PI_SYNC_OAUTH_CLIENT_ID` | Overrides the client id file for one run. |
| `~/.pi/sync/manifest.json` | The device's manifest copy (carries the local gist id). |
| `~/.pi/sync/base-state.json` | The device's last-synced Base (owner-only). |
| `PI_SYNC_HOME` / `PI_SYNC_STATE_DIR` / `PI_SYNC_GITHUB_BASE_URL` | Relocate home, state dir, and API base for scripted runs. |

## Module map

| File | Role |
| --- | --- |
| `types.ts` | The seams: `SyncManifest`, `Snapshot`, `BaseState`, `Backend`. |
| `manifest.ts` | Manifest parse/validate/serialize, glob matching, `walkRoots`. |
| `hash.ts` | sha256 hex and the strict UTF-8 check. |
| `localfs.ts` | Local collect (symlink and dir-name guards), plan apply with backups, manifest + base-state files. |
| `merge.ts` | The pure three-way merge. |
| `refs.ts` | The cross-reference scanner. |
| `token.ts` | Token file: managed JSON vs hand-written plain text, resolution, warnings. |
| `config.ts` | The OAuth client id resolution (env wins, then the wizard-written file). |
| `deviceflow.ts` | The GitHub OAuth device flow: request code, poll, one retry, persist. |
| `refresh.ts` | The token refresh: proactive skew check and the reactive exchange. |
| `auth.ts` | The auth session: resolves a token, owns the renewal bounds (one proactive refresh at run start, one reactive renewal per run). |
| `backends.ts` | Backend registry. |
| `backends/github-gist.ts` | The Gist backend over the `GistTransport` seam; 401/403 hands back to the auth session for one renewal + retry. |
| `ops.ts` | The five operations; one `SyncRuntime` for CLI and pi. |
| `cli.ts` / `cli.mjs` | The `pi-sync` CLI (jiti-loaded TS, no build step). |
| `index.ts` | The pi extension: `/sync`, the TUI wizard, the startup notice. |

## Tests

```bash
npx vitest run tests/sync                          # no network
PI_SYNC_TOKEN=<gist token> node tests/sync/e2e-gist.mjs          # opt-in, real GitHub, PAT mode
PI_SYNC_OAUTH_CLIENT_ID=<id> node tests/sync/e2e-gist.mjs --device-flow   # opt-in, real GitHub, device flow
```

- `manifest.test.ts` - glob semantics, validation, canonical serialization.
- `merge.test.ts` - every merge case from the spec table.
- `refs.test.ts` - scanner coverage and caps.
- `token.test.ts` - managed vs hand-written tokens, precedence, warnings.
- `deviceflow.test.ts` - the device flow states (success, one retry on
  expiry, denial, abort), the refresh paths, and the auth session
  bounds (hand-written tokens never managed; at most one renewal per
  run; 404 never renews).
- `ops.test.ts` - the operations on real temp homes against the in-memory
  fake backend, including the multi-device stale-base scenarios and the
  consent gates on both init paths.
- `gist-backend.test.ts` - the Gist backend against a stubbed transport.
- `cli.test.ts` - the CLI E2E: a loopback server speaks the Gist API
  and the OAuth endpoints, two homes sync through the real HTTP stack.
- `onboarding-e2e.test.ts` - the onboarding proof (issue #40): the real
  CLI in a real terminal (a pty via util-linux `script`), a loopback
  stub playing GitHub, the test playing the human (entering the device
  code by flipping the stub, confirming with y), from a clean home to a
  joined device, plus the decline path that writes nothing.
- `e2e-gist.mjs` - the opt-in live run against the real GitHub (PAT or
  device flow mode), timed for human actions; it records the human
  action count and deletes the gist on exit.
