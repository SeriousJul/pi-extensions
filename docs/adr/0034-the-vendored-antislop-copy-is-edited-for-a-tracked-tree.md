# The vendored antislop copy is edited for a tracked tree

antislop (`miqdadbadjuber/Anti-Slop`, MIT) becomes the second Skill source
under ADR-0013: six skills mirrored under `skills/anti-slop/`, one Source
pin, three-way merge on every skill sync. Its core `SKILL.md` opens with a
First-Run Install Wizard that tells the agent to fetch the missing skill
folders and append an antislop pointer block to the project's entry file,
and it carries an update section pointing at `npx antislop-ai --update`,
`npx skills update`, and seven plugin commands. Read inside a tracked tree
those instructions are wrong, and one is destructive: `--update` replaces
every antislop folder wholesale, which bypasses the three-way merge and
discards Local tweaks, and the pointer block writes into the operator's
`AGENTS.md` for skills pi already loads. The same file's mode resolution
ends the turn to ask "during or after?" whenever no preference exists,
which stalls an unattended session. We decided: edit the local copy in
place, in exactly two places, and leave every other byte identical to
upstream.

## Considered options

- **Keep the copy byte-identical to upstream.** Rejected: the copy then
  instructs every session that loads it to write into the project's entry
  file and to run an updater that overwrites the tracked copies. That is
  not a cosmetic mismatch; it fights the tracking model ADR-0013 rests on.
- **Ship a settings file along with the skills.** Rejected: the skill reads
  only the platform path (`~/.config/antislop/settings.json`, or
  `%APPDATA%\antislop\settings.json` on Windows), shared across agents and
  projects and independent of install location. A file inside the Skill
  tree is never read by anything.
- **Write that global settings file on the operator's machine.** Rejected:
  it is per-machine invisible state, absent on a fresh install and in CI,
  and it would have our package write a third party's global config
  unprompted.
- **Leave the mode question and accept the stall.** Rejected: the skill
  says to end the response and wait for the answer "before any UI review,
  planning, or concept, even for read-only requests", and the factory runs
  cycles with no human in the terminal.
- **Also rewrite `${CLAUDE_SKILL_DIR}` in `antislop-human`.** Rejected:
  upstream already says to point the script path at the skill's own folder
  when that variable is absent, and pi's prompt resolves relative paths
  against the skill directory. The command degrades correctly on its own,
  and every byte left unchanged merges clean on the next sync.
- **Ask upstream to gate the install wizard per loader.** Deferred:
  upstream has no way to know that a loader tracks the copy rather than
  installing it by folder, so the cut is ours to own. If upstream ever
  gates it, the sync brings the gate back as a conflict to resolve by
  taking theirs.

## Consequences

- The divergence is one file, two places: the core's
  `## First-Run Install Wizard` and
  `### Already installed, and the user asks how to update` sections are
  cut, and step 3 of `## Two Usage Modes` resolves an unresolved mode to
  `during` with the notice `antislop active: during (package default).`
  instead of asking, which retires the question block below it. Nothing
  outside the cut sections refers to them, so the cut leaves no dangling
  text.
- Steps 1 and 2 of the mode ladder stay upstream's: an explicit session
  instruction, then the global settings file. An operator who wants
  `after` as a machine default still gets it the upstream way, with
  `npx antislop-ai --mode after`, and an operator who wants it for one
  session just says so.
- The other five skills stay byte-identical, as does everything the sync
  carries: the frontmatter (`allowed-tools` is unknown to pi and ignored;
  `disable-model-invocation` is not set, so all six stay model-invocable),
  and the extra files inside the skill folders (`VERSION`,
  `contrast-check.py`, `contrast-mcp.py`). Deleting the unused MCP server
  would stick only until upstream edits that file, and would cost a
  conflict.
- An upstream change to a cut region surfaces as a conflict in
  `skills:update`, with this ADR as the reason, and the Source pin holds
  until it is resolved.
- The upstream `LICENSE` at the source root is copied by hand at adoption:
  the skill sync ignores files that sit outside a skill directory.
