# Skill tool extension

Lets a model load a skill **by name** - the missing half of how the
shipped skills talk to each other.

The tracked skills reference each other by name: `grill-with-docs` says
"call the Skill tool twice, for 'grilling' and 'domain-modeling'", and
most of the engineering and productivity suite does the same. The
wording comes from the upstream's home environment, which has a Skill
tool. pi does not: the model only learns where a skill lives from the
skills section of the system prompt, so a name reference makes the model
re-type the long install path by hand. It guesses - a sibling bucket, a
mangled directory name - and the read dies with ENOENT
([issue #143](https://github.com/SeriousJul/pi-extensions/issues/143)).

## Behavior

- The extension registers one tool, `skill`, with one parameter: the
  skill name.
- The name resolves against the skill list **pi itself loaded into the
  run**, captured at each run's start. The tool can only ever point at a
  skill the model was told about; it never scans the filesystem.
- A hit returns the skill's body with the frontmatter stripped, wrapped
  in the same block shape pi's `/skill:` expansion records: the tag with
  the name and the file location, and the line that names the base
  directory the skill's relative file references resolve against. pi
  normalizes a file's line endings before it parses the frontmatter, and
  the tool mirrors that, so a CRLF file returns the same body pi
  records.
- A miss - a name pi does not know - comes back as an error carrying
  every loaded name, so the model corrects itself in one retry.
- A file that vanished after the run started (a `/reload` race) reports
  the reload hint instead of a bare ENOENT.

## How it works

One pure core module (`extensions/skill-tool/core.ts`) owns the name
lookup, the frontmatter strip, and the result text; the pi wiring
(`index.ts`) registers the tool and captures the registry from
`before_agent_start`. See
[ADR 0035](/adr/0035-the-skill-tool-loads-referenced-skills-by-name).

## Limitations

The tool serves the skills of the run it was captured in: skills
added or removed by a `/reload` appear from the next run on. If pi ever
ships its own `skill` tool, the name collision is the one thing to
revisit; until then the tool degrades to nothing on a pi that lacks the
`systemPromptOptions.skills` field.
