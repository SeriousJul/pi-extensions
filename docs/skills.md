# Skill tree

The package ships a skill tree under `skills/`; pi loads it through the
`skills` entry in the `pi` manifest in `package.json` when the package is
installed (convention directories are not auto-discovered while a `pi`
manifest is present). Tracked skills are mirrored from upstream repos;
[the glossary](/glossary) holds the domain language (Skill tree, Skill
source, Shared directory, Source pin, Skill sync, Adopt, Upstream orphan,
Local tweak).

## Layout

`skills/<source-slug>/<upstream path>` for tracked skills, and
`skills/local/<name>` for local-only skills. The layout mirrors each
upstream repo, so a tracked skill's upstream path is read off its local
path. A source may root its mirror in its own `skills/` directory or in
the repo root, and may name shared directories its skills reference:

- `skills/addyosmani/skills/test-driven-development` - nested in the
  source's own `skills/` directory (upstream path
  `skills/test-driven-development`, mirrored from the repo root)
- `skills/addyosmani/references` - the source's shared directory: the
  repo-level checklists its skills link into
- `skills/anti-slop/antislop-ui` - flat (`antislop-ui` upstream)

## Sources

| Slug | Upstream | License | Local root |
| --- | --- | --- | --- |
| `addyosmani` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT, upstream `LICENSE` ships at `skills/addyosmani/LICENSE` | `skills/addyosmani/` |
| `anti-slop` | [miqdadbadjuber/Anti-Slop](https://github.com/miqdadbadjuber/Anti-Slop) | MIT, upstream `LICENSE` ships at `skills/anti-slop/LICENSE` | `skills/anti-slop/` |

The addyosmani source is the 25-skill lifecycle suite (spec, plan, build,
test, review, ship). It is mirrored from the repo root: the skills land
under `skills/addyosmani/skills/<name>/`, and the repo-level
`references/` directory - the shared checklists 12 of the skills link
into with relative paths - mirrors as a [Shared directory](/glossary) at
`skills/addyosmani/references/`. Its copies ship without local tweaks.

The anti-slop source is the suite of six skills: the core `antislop` plus
the `antislop-ui`, `antislop-copywriting`, `antislop-human`,
`antislop-layoutmobile`, and `antislop-code` satellites. It is tracked as
the second [Skill source](/glossary), not installed as a package: the
mirrored copies ship to every install of this package, and sync keeps
them in step. The upstream `LICENSE` at each source root is copied by
hand at adoption, because the sync ignores files that sit outside a
skill directory and a shared directory.

## Sync and adopt

`skills-manifest.json` holds one entry per skill source: repo URL, local
root, the upstream root it mirrors, any shared directories it mirrors,
and the Source pin (the upstream commit the whole tree last agreed on).

```
npm run skills:update                # fetch upstream, three-way-merge tracked skills and shared directories
npm run skills:add -- <slug>/<path>  # adopt a new upstream skill or shared directory, e.g. anti-slop/antislop-ui
```

`skills:update` merges every tracked file with `git merge-file` (base =
the pin, theirs = the fetched commit, ours = the local copy). Clean
merges apply automatically. A file both sides changed comes back with git
conflict markers; resolve it in place, and the pin advances on the next
clean sync. Upstream deletes of a skill or shared directory are reported
as orphans and kept in place. New upstream skills and shared directories
are listed as offers and adopted only by `skills:add`. The Source pin
advances only when a sync completes with no conflict and no orphan. The
tool never commits, pushes, deletes, or renames.

## Local tweaks

Tweaking a skill is editing the file in this repo. A skill sync merges
against the tweak, so an upstream change to a tweaked region comes back
as a conflict, never as a silent overwrite.

The vendored antislop core carries one deliberate local tweak
([ADR-0034](/adr/0034-the-vendored-antislop-copy-is-edited-for-a-tracked-tree)):
the First-Run Install Wizard and the update section are cut, and the mode
ladder resolves an unresolved mode to `during` with the notice
`antislop active: during (package default).` instead of ending the turn
to ask, so an unattended session never stalls on the mode question.
Steps 1 and 2 of the ladder stay upstream's: an operator who wants
`after` pins it the upstream way, with `npx antislop-ai --mode after`
for the machine, or by saying so for one session. The suite ships
available, not active: no prompt template, initial-context injection, or
factory wiring turns it on.
