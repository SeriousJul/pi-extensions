# The addyosmani agent-skills source replaces the mattpocock source

The skill tree tracked the mattpocock/skills source: 38 skills under
`skills/mattpocock/`. Issue #138 replaces it with
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills): a
25-skill lifecycle suite (spec, plan, build, test, review, ship) that
supersedes the mattpocock workflow skills. The addyosmani repo also
carries a repo-level `references/` directory of shared checklists that
12 of its 25 skills link into with relative paths
(`../../references/...`); upstream tracks the resulting portability gap
for per-skill installs as its own issue (#361).

We decided: drop the `mattpocock` source wholesale, adopt the addyosmani
suite wholesale, and mirror the source from its repo root
(`upstreamRoot: "."`) so the skills land at
`skills/addyosmani/skills/<name>/` and every relative link resolves
inside the tree. The repo-level `references/` directory mirrors at
`skills/addyosmani/references/` and is tracked as a Shared directory: a
new per-source manifest field `shared` names directories that are not
skills but that skills reference. The sync mirrors a shared directory
and three-way-merges its files exactly like a skill's files, and
`skills:add` adopts one like a skill. The upstream `LICENSE` is copied by
hand at the source root, as with the other sources.

## Considered options

- **Mirror only the source's `skills/` directory.** Rejected: the
  relative `../../references/` links in 12 of the 25 skills would dangle,
  and an agent following those skills loses the checklists they point at.
- **Copy `references/` by hand, untracked.** Rejected: it goes stale the
  moment upstream moves the checklists, and nothing reports the drift.
- **Mirror the whole repo as untracked copies.** Rejected: it loses the
  per-file three-way merge and conflict visibility ADR-0013 rests on.
- **Keep both sources side by side.** Rejected: two workflow suites with
  overlapping triggers (code review, TDD, spec, planning) compete for the
  same work; the point of the swap is one workflow vocabulary.

## Consequences

- The mattpocock source and its 38 skills are deleted from the tree.
  mattpocock skills with no addyosmani counterpart (codebase-design,
  domain-modeling, prototype, research, wizard, writing-for-agents, the
  in-progress suite, and the misc skills) retire with the source;
  bringing one back is a Local-only skill under `skills/local/`, not a
  source.
- The new source's layout is `skills/addyosmani/skills/<name>/` for the
  skills and `skills/addyosmani/references/` for the shared directory;
  both read off the local path as upstream paths, so ADR-0013's
  layout-is-the-manifest property holds.
- `shared` is per source in the manifest; a source that needs no shared
  directory omits it. Files that are neither skill nor shared directory
  (the `LICENSE` at a source root, other root entries) stay unmirrored.
- A Shared directory declared in the manifest but absent locally is
  offered like a new unit and adopted with `skills:add <slug>/<dir>`; one
  that upstream deleted is an orphan that holds the pin until the local
  copy goes.
- The addyosmani copies ship without local tweaks; a sync conflict in one
  is an upstream change to take or to fight over in place.
