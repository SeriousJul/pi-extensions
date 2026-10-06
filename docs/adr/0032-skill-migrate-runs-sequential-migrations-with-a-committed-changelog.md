# skill-migrate runs sequential migrations with a committed changelog

The upstream skills renamed the domain docs layout (`CONTEXT.md` to
`GLOSSARY.md`, `CONTEXT-MAP.md` to `GLOSSARY-MAP.md`, `CONTEXT-FORMAT.md` to
`GLOSSARY-FORMAT.md`), so every underlying repo that still ships the
old layout disagrees with what the skills expect. Editing
the repos by hand would leave no trace of which structure version each carries,
and the next structural change would start the same chore over. We decided: a
deterministic extension, skill-migrate, owns the migrations. Each Target repo
carries a committed, append-only Migration changelog under `.pi/`. The runner
applies named, numbered migrations in strict order (void to 1, 1 to 2, ...),
checks preconditions before and postconditions after each, and records the
version, the migration name, the pi-extensions commit that applied it, and the
UTC date time for every step.

## Considered options

- **A one-off, LLM-driven pass per repo.** Rejected because it is not replayable
  across repos, leaves no auditable record of a repo's structure version, and
  hands the same judgment call to a model on every run.
- **Self-migration: the extension notices a stale repo and migrates it on its
  own.** Rejected because the operator drives structure changes at will, and a
  silent structural rewrite of the working tree is not what an agent does
  unprompted. The extension exposes exactly two verbs: status and migrate.
- **Per-migration backups with in-tool rollback.** Rejected because every target
  repo is git. A failed migration appends nothing to the changelog and points
  the operator at `git restore` plus a re-run, which keeps the engine small and
  deterministic. Precondition checks make the re-run safe: a migration refuses
  to start unless the tree is in the state it expects.
- **A top-level current version in the changelog file.** Rejected because it
  duplicates the last record, and two copies of one version drift.
- **Rewrite references to the format file without renaming the file.**
  Rejected because the reference rewrite would then point at a file that no
  longer exists: the upstream rename covers `CONTEXT-FORMAT.md`, so the root
  format file is renamed like the glossary and the map, and the old and new
  names present together is ambiguous state like any other root pair.

## Consequences

- Once a repo carries a changelog, its shape is fixed: an append-only
  migrations array, four fields per record, and the pi-extensions commit as the
  extension identity. Changing the format later is itself a migration.
- A failed migration can leave the tree partly changed with the changelog
  untouched. That is deliberate: the audit file records only completed steps,
  and git is the rollback layer.
- A repo that never had the old files still passes the glossary rename, because
  the renames are conditional on presence and the reference rewrite runs either
  way.
- Migrations are defined once in the extension and applied to many repos. A new
  structural expectation is one new numbered step; the runner never changes.
- The extension identity is anchored to the checkout's own git toplevel:
  the commit SHA is recorded only when the checkout is the toplevel. A package
  installed inside a consumer git repo records its package version, not the
  consumer's SHA.
- A repo whose changelog is ahead of the registry is up to date: it has no
  pending migration. `status` and `migrate` report its actual version and
  change nothing.
- Files that document the rename itself (this ADR, the glossary terms) carry
  the old names as historical data. The rewrite cannot tell a reference from
  history; where a rewrite touched such a file, the historical wording was
  repaired by hand.
