# Skill command extension

Makes pi recognize a skill command whose name and arguments are separated
by a newline, instead of only a space.

pi expands `/skill:name args` by parsing the name up to the first space.
An injected command whose name and arguments sit on separate lines - the
shape the software factory's consultation templates use, where the command
is the first line and the body below it - therefore fails the lookup: the
parsed "name" is the name plus the newlines plus the start of the argument
text, nothing matches, and the text passes through unexpanded. The model
then sees a literal `/skill:` line and, for skills that carry
`disable-model-invocation: true` (absent from the prompt's skills
section), no pointer to the file at all.

## Behavior

- On every submitted prompt, the extension checks the text. When it starts
  with `/skill:name` and the whitespace between the name and the arguments
  contains a newline, that separator becomes a single space. The arguments
  keep their remaining bytes; pi trims them when it expands, so the
  recorded message is what a space-separated command would have produced.
- pi's built-in expansion runs on the normalized text. The lookup, the
  SKILL.md read, the frontmatter strip, and the recorded `<skill
  name=... location=...>` block are all pi's; the extension never reads a
  SKILL.md and adds no setting.
- Commands pi already parses (space separator, bare name) and all
  non-skill text pass through untouched. An unknown skill name with a
  newline separator is normalized but still fails pi's lookup and passes
  through, as before.
- A tab-only separator is out of scope: pi does not claim that shape
  either, and no producer injects it.

## How it works

The rewrite is one pure function in the engine-free core module
(`extensions/skill-command/core.ts`); the pi wiring (`index.ts`) registers
a single handler on the input event, which fires on every submitted prompt
before pi's own skill and template expansion.
See [ADR 0033](/adr/0033-skill-command-normalizes-the-injected-skill-command-separator).

## Limitations

If pi changes how it expands skill commands - for example to accept
newline separators natively - the rewrite becomes invisible: it produces
the form pi parses today, which a more tolerant pi still parses. If pi
changes the `/skill:` invocation syntax, the regex in the core module needs
to follow.
