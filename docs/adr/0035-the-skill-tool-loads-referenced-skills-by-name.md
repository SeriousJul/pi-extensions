# The skill tool loads referenced skills by name

The shipped skills reference each other by name: `grill-with-docs` says
"call the Skill tool twice, for 'grilling' and 'domain-modeling'", and
fourteen more skills in the tracked suite carry the same shape. The
wording comes from the upstream's home environment, where a Skill tool
exists. pi has no such tool: the model learns where a skill lives from
the skills section of the system prompt, so a name reference makes it
re-type the long install path by hand. In the session behind issue #143
(01a13a4d), the model guessed the wrong bucket (`engineering/grilling`
instead of `productivity/grilling`) and a mangled directory name
(`pi-extock`), and two reads died with ENOENT before the model recovered
by finding the tree.

We decided: a small extension, skill-tool, registers one `skill` tool
that takes a skill name and loads that skill. The name list is pi's own
registry, captured from `before_agent_start`'s `systemPromptOptions.skills`
at every run, so the tool can only ever point at a skill pi loaded into
the run, and a name pi does not know gets back the loaded names to
correct against. The tool returns the same block shape pi's `/skill:`
expansion records - the tag with name and location, the base-directory
line, the body with the frontmatter stripped - so a name-based load and
an explicit command land the model in the same place. The extension never
scans the filesystem and never re-implements discovery: like
skill-command, which normalizes input and lets pi own the expansion
(ADR 0033), the tool only resolves a name against what pi already told
the model.

## Considered options

- **Edit the vendored skill text to point at file paths.** Rejected: the
  suite carries the cross-reference in roughly fifteen files, so the
  edits scatter across tracked upstream copies; repo-root-relative paths
  do not resolve in the "references are relative to the skill directory"
  context the injection declares; and the next skill sync merges every
  edit against upstream. The first draft of the fix for #144 did exactly
  this for one file and got all three of those wrong.
- **Parse the rendered system prompt's `<available_skills>` section.**
  Rejected: `before_agent_start` already hands the extension the typed
  `skills` array that section renders from. Parsing pi's text format
  would break on a pi change; trusting the typed list cannot.
- **Scan the skill directories ourselves.** Rejected: it duplicates pi's
  discovery and can disagree with it (name collisions, disabled skills,
  toggles). Capturing the registry keeps the tool pinned to what the
  model was actually told.
- **Patch pi upstream to ship the tool.** May happen; this extension
  closes the gap on the pi versions in use today, and if pi ships its own
  `skill` tool the name collision is the one thing to revisit.

## Consequences

- Every install of the package gains one active tool - one prompt line,
  by design: the tool must be present for the model to follow a skill's
  instructions, so it cannot be a user-only tool.
- The tool loads only skills pi loaded into the run. A name the model
  was never told about fails with the loaded list; a file that vanished
  after the run started (a `/reload` race) reports a reload hint instead
  of a bare ENOENT.
- `disable-model-invocation` skills stay out of the model's own
  selection; the tool loads one only if the model reaches for the name,
  as a user-invoked skill's instructions may direct.
- The tool's result is byte-for-byte the shape of pi's expansion block,
  so a session that loaded a skill by name reads to the model like a
  session that commanded it.
