# Resource descriptions are read from the source file

The toggle's lists, the new resource picker, and the argument completion
must show what a resource does, not only its name. pi carries a standard
description for two of the four kinds: a skill's SKILL.md frontmatter
`description`, and a prompt template's frontmatter `description` with the
first non-empty line as the fallback. Themes have no description field, and
extensions have no description anywhere in pi. We decided: the toggle derives
one Resource description per resource from the source file itself - the
frontmatter for a skill, the frontmatter or first line for a prompt template,
nothing for a theme, and the leading block comment of the entry file for an
extension. The text is read only: the toggle never writes it.

## Considered Options

- **Source-file derivation (chosen).** It works for disabled resources and
  untrusted projects, adds no file format, and matches the two kinds pi
  already standardizes. For an extension, the leading block comment is the
  first thing an author writes about the file, so it serves as the
  description without a new convention to teach.
- **A README beside the entry file.** A README is documentation, not a
  one-liner; choosing which line is the description is arbitrary, and most
  extensions carry no README at all.
- **Runtime registrations (the commands and tools the extension registers).**
  They exist only while the extension is loaded, so a disabled extension -
  exactly the row a user is about to disable - has nothing to show.
- **No description.** The state before this decision: name and path alone,
  which do not say what disabling removes.

## Consequences

- The leading block comment of an extension entry file becomes a soft
  contract: it is the description the lists, the picker, and the completion
  show. An author who wants a description writes the comment; an author who
  does not gets none, never a wrong one.
- Extraction is display-side only. The description is not settings state,
  not part of the state machine, and never written to a file.
- A skill description may run to 1024 chars, so the resolver keeps the full
  collapsed text and every display surface caps what it prints.
