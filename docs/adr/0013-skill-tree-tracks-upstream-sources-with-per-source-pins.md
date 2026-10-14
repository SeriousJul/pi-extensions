# The skill tree tracks upstream sources with per-source pins

The package ships a skill tree of full skill copies. Tracked skills come
from upstream repos (Matt Pocock's skills repo today, MIT licensed). Local
tweaks are edits to the copies in place. A skill sync three-way-merges each
tracked file - base is the file at the Source pin, theirs is the file at
the fetched commit, ours is the local copy - and advances the pin only when
the whole source merges clean. The tracking unit is the repo, not the file:
one pin per Skill source.

## Considered options

- **Per-skill commit pins.** Each skill records its own last-synced commit,
  so every merge base is as fresh as possible for that skill. Rejected: the
  sync state doubles, and a partially completed sync leaves a spread of pins
  that no single upstream commit represents. Following a repo is the unit
  the user wants to reason about; one pin that names "the commit where the
  whole tree last agreed" is simpler to inspect and to trust.
- **Patch files (quilt-style).** Pristine upstream copies plus per-skill
  `.patch` files applied with `git apply --3way`. Rejected: patches and
  content live in two places, patch files break often as upstream moves,
  and every upstream change costs a rebase.
- **Git subtree of the upstream repo plus patched copies.** Git-native
  history, but merging upstream movement into the patched copies is a
  manual, unstructured diff between two trees. No per-file conflict against
  the copies the user actually edits.
- **Overlay (pristine copies plus whole-file overrides).** Rejected: it
  cannot express a line-level instruction tweak without replacing the whole
  file, and upstream updates to an overridden file are silently dropped.
- **Pi extension with an in-pi update command.** Rejected: updating skills
  is a repo chore, not an agent function. A plain script in the repo is the
  right shape, and pi loads the tree by itself through the conventional
  `skills/` directory.

## Consequences

- The layout is the manifest: `skills/<source-slug>/<upstream bucket>/<name>`.
  A tracked skill's upstream path is read off its local path, so the
  manifest holds one entry per source - repo URL, local root, pin. Local-only
  skills live under `skills/local/` and are invisible to sync.
- Pin advancement is all-or-nothing per source. One unresolved conflict holds
  the pin for the whole source, so the pin always names a commit at which
  every tracked skill is in agreement.
- Conflicts surface as git conflict markers in the file, resolved in a normal
  session, and the pin advances on the next clean sync.
- The tool never commits or pushes. Publishing is the user's act.
- A second upstream repo is one manifest entry and one `skills/<source>/`
  root, not a redesign.
