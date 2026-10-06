# Skill Migrate

Deterministic repo-structure migrations with a committed changelog
(ADR 0032). The extension migrates a Target repo's structure in strict
incremental steps. Each repo carries a committed, append-only Migration
changelog at `.pi/skill-migrate_changelog.json`; a failed migration appends
nothing and points the operator at `git restore` plus a re-run.

## Verbs

| Invocation | What it does |
| --- | --- |
| `skill-migrate status [repo]` | Report the repo's current structure version. Changes nothing. |
| `skill-migrate migrate [repo]` | Apply every pending migration, in order, to the latest known version. |
| `/migrate [status]` (in pi) | The same two verbs on the session's project repo. |

The repo path defaults to the current directory. Run it from pi-extensions
with `npm run skill-migrate -- <verb> [repo]`.

## The changelog

`.pi/skill-migrate_changelog.json`: one object holding an append-only
`migrations` array. Each record carries the target version, the migration
name, the extension identity (the pi-extensions git commit SHA, or the
package version when the checkout is not git), and the UTC date time
(ISO-8601). The current version is the last record's version, or void when
the file is absent. The file is written atomically and only ever appended.

## Migrations

| Version | Name | What it does |
| --- | --- | --- |
| 1 | `create-changelog` | Creates the changelog carrying only its own record. |
| 2 | `glossary-rename` | Renames the root `CONTEXT.md` to `GLOSSARY.md` and the root `CONTEXT-MAP.md` to `GLOSSARY-MAP.md` when present, plus each per-context `CONTEXT.md` the map references by the local path exactly as written in the map. Then rewrites every exact reference to the three old file names across the repo's text files, skipping `.git`, dependency and build directories, binary files, and lock files. Renames are conditional on presence, so a repo without the old files still migrates its references. |

## Adding a migration

One new numbered step in `extensions/skill-migrate/migrations.ts` with its
own preconditions and postconditions. The runner never changes.

Ambiguous state (both the old and the new file present) aborts with an
error; the runner never guesses what was meant.
