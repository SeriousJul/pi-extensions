# Skill tree

The package ships a skill tree under `skills/`; pi loads it through the
`skills` entry in the `pi` manifest in `package.json` when the package is
installed (convention directories are not auto-discovered while a `pi`
manifest is present). Tracked skills are mirrored from upstream repos;
[the glossary](/glossary) holds the domain language (Skill tree, Skill
source, Source pin, Skill sync, Adopt, Upstream orphan, Local tweak).

## Layout

`skills/<source-slug>/<upstream path>` for tracked skills, and
`skills/local/<name>` for local-only skills. The layout mirrors each
upstream repo, so a tracked skill's upstream path is read off its local
path. A source may bucket its skills or hold them flat:

- `skills/mattpocock/engineering/tdd` - bucketed (`engineering/tdd`
  upstream)
- `skills/anti-slop/antislop-ui` - flat (`antislop-ui` upstream)

## Sources

| Slug | Upstream | License | Local root |
| --- | --- | --- | --- |
| `mattpocock` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT, upstream `LICENSE` ships at `skills/mattpocock/LICENSE` | `skills/mattpocock/` |
| `anti-slop` | [miqdadbadjuber/Anti-Slop](https://github.com/miqdadbadjuber/Anti-Slop) | MIT, upstream `LICENSE` ships at `skills/anti-slop/LICENSE` | `skills/anti-slop/` |

The anti-slop source is the suite of six skills: the core `antislop` plus
the `antislop-ui`, `antislop-copywriting`, `antislop-human`,
`antislop-layoutmobile`, and `antislop-code` satellites. It is tracked as
a second [Skill source](/glossary), not installed as a package: the
mirrored copies ship to every install of this package, and sync keeps
them in step. The upstream `LICENSE` at each source root is copied by
hand at adoption, because the sync ignores files that sit outside a
skill directory.

## Sync and adopt

`skills-manifest.json` holds one entry per skill source: repo URL, local
root, the upstream root it mirrors, and the Source pin (the upstream
commit the whole tree last agreed on).

```
npm run skills:update                # fetch upstream, three-way-merge tracked skills
npm run skills:add -- <slug>/<path>  # adopt a new upstream skill, e.g. anti-slop/antislop-ui
```

`skills:update` merges every tracked file with `git merge-file` (base =
the pin, theirs = the fetched commit, ours = the local copy). Clean
merges apply automatically. A file both sides changed comes back with git
conflict markers; resolve it in place, and the pin advances on the next
clean sync. Upstream deletes of a skill are reported as orphans and kept
in place. New upstream skills are listed as offers and adopted only by
`skills:add`. The Source pin advances only when a sync completes with no
conflict and no orphan. The tool never commits, pushes, deletes, or
renames.

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
