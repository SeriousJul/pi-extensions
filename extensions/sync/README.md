# sync extension

Cross-device sync of pi config files (issue #32). One shared tree of
user-chosen home files (the `AGENTS.md`, `OPINIONS.md`, and dotfile set
named in a sync manifest) stays in sync across all the user's machines,
through a pluggable Backend. v1 ships exactly one backend: a **secret
GitHub Gist**. The Backend is a single seam, so a later backend (S3,
Syncthing, rsync) is a new implementation, not a redesign.

## Onboarding (one command per device)

The whole setup is a guided wizard. Each human action is either one
browser page or one key press.

**Once per account (the only account-level step):**

```bash
scripts/setup-sync-wizard.sh
```

The bash wizard opens the GitHub OAuth app page, walks the form (name,
a `http://127.0.0.1` callback URL that is never used, the **Use
expiring tokens** checkbox that ADR 0007 needs, and the **device flow
opt-in** box that GitHub now requires on every app), and stores the
public **client id** in `<state-dir>/oauth-client.json`. Before it stores
the id it verifies it against GitHub: a live id gets a throwaway device
code, a typo is caught on the spot, and an app that left the device flow
off is named by GitHub's own `device_flow_disabled` refusal - the wizard
opens the settings page where the opt-in box lives (offline or without
`curl` the check degrades to a warning and a confirm). A client secret is
never created or stored: the device flow does not use one. Scripted
contexts can set `PI_SYNC_OAUTH_CLIENT_ID` instead.

**On each device:**

```bash
pi-sync init              # first device: creates the shared secret gist
pi-sync init <gist-id>    # every later device: joins that gist
```

What `init` does, step by step:

1. **Auth.** With no token on the device, the CLI runs the GitHub
   **OAuth device flow** (ADR 0007): it prints a short code and the
   verification URL (`github.com/login/device`), and polls. You open
   the URL in a browser and enter the code; the token it stores carries
   only the `gist` scope. On expiry or denial it offers exactly one
   fresh retry, or cancels. It never fails silently and never retries
   without you.
2. **Preview.** Before anything is written, the wizard prints the
   preview: which files are in scope, which files would be sent or
   replaced, and which files would arrive. The gist is created, and a
   device joins, only after you confirm with `y`. Declining writes
   nothing (the stored token excepted, if the flow already finished).
3. **Report.** The create path prints the gist id and the exact join
   command for the other devices. The join path prints the files it
   adopted.

In pi, the same wizard runs as `/sync init [gist-id]`: the device flow
is a TUI dialog, and the preview confirm is a TUI dialog.

### Flags

| Flag | Effect |
| --- | --- |
| `--yes` | Confirm the preview without prompting; the preview is still shown. Non-tty runs (CI, scripts) need this. |
| `--force` | Re-init an already-joined device without prompting. The shared tree re-adopts; the local manifest keeps its gist id. |

### The token lifecycle (ADR 0007)

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

## Operations

All five exist as pi commands (`/sync ...`, with a TUI status dialog)
and as CLI verbs (same code, `extensions/sync/ops.ts`):

| Verb | Effect |
| --- | --- |
| `pi-sync init` (no id) | The create path: on auth, preview, and confirm, it creates the shared secret gist from this device's tree. |
| `pi-sync init <gist-id>` | The join path: on auth, preview, and confirm, this device adopts the shared tree and records the gist id. On an already-joined device it re-adopts like a pull (the preview lists what will be replaced; local edits are kept) and confirms again; `--force` skips the confirm. |
| `pi-sync push` | Merge local + remote, upload the merged tree, then apply the merge to the local tree. On a device that never ran `init`, push is a plain error pointing at `pi-sync init`: it never creates. |
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
- **Updates use `PATCH /gists/{id}`.** The legacy `PUT` alias is not
  in the fine-grained PAT endpoint list, and GitHub answers it with a
  404 that reads as "gist not found".
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

## pi integration

`/sync init [gist-id]`, `/sync push`, `/sync pull`, and `/sync status`
open a TUI dialog with the full report (in print and RPC modes the
report goes to the stream); `/sync` alone prints the usage. `/sync init`
runs the same wizard as the CLI: the device flow as a TUI dialog (it
only starts in the TUI, never in print or RPC modes), the preview
confirm as a dialog. On session start the extension runs a read-only
probe in the background (5 s timeout) and, on drift, puts a footer
status line up:

```
sync: ↑2 ↓1
```

A green up-arrow plus count when ahead, a red down-arrow plus count when
behind, both when the device drifts both ways. The line sits on the right
of the shared footer status line (see `shared/status-line.ts`), in the
column above the provider and model.

When a token exists but this device has not joined a gist yet, the line
nudges instead of staying empty:

```
sync: not joined - run /sync init
```

No token, zero drift, or a failed read: the line stays empty. The probe
only reports - it never starts a re-authentication or device flow - and
nothing on startup ever mutates the tree or the backend.

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
