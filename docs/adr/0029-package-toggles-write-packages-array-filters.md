# Package toggles write packages-array filters, not resource-array patterns

ADR 0012 sends every toggle into the settings resource arrays as override
patterns. For a package-bundled resource that write is a no-op: pi applies
resource-array patterns only to top-level resources and loads package
resources from the package manifest alone, so a `-` pattern for a bundled
extension reported a successful disable while the extension kept running. Its
footer kept painting, and the list derived from the patterns showed the
resource disabled. We decided: for a package resource, the toggle writes pi's
own package filter - the packages entry becomes object form carrying a
per-resource-type pattern array relative to the package root, exactly the
write `pi config` performs - and the settings resource arrays carry no
package-relative pattern. The top-level behavior of ADR 0012 is unchanged.

## Considered Options

- **Packages-array filter (chosen).** pi's native mechanism for the case:
  `pi config` writes it, the package manager applies it during resolution,
  and the patterns stay relative to the package root, so the settings file
  remains portable. It keeps ADR 0012's interchangeability promise intact for
  package resources instead of breaking it.
- **Resource-array pattern (the old write).** pi ignores it for package
  files. A write that reports a disable that never happens is worse than no
  write.
- **User-scope shadow entry.** A plain absolute path plus a `-` pattern in a
  settings resource array re-registers the package file at user scope, which
  beats the package entry in pi's precedence dedupe; verified to disable.
  Rejected because it puts machine-specific absolute paths into the settings
  and diverges from the write `pi config` makes, so the two tools would no
  longer agree about the file.

## Consequences

- The toggle's settings state grows the packages array beside the four
  resource arrays, and its state machine must mirror `pi config`'s write,
  including collapsing an emptied filter back to the plain string entry.
- A project-scope package filter replaces, not merges, the global packages
  entry for the same package identity: pi's dedupe keeps the winning entry
  whole.
- The old no-op pattern is not state. The next toggle of the resource
  migrates the intent into the filter and removes the pattern from the
  resource array, so a settings file harmed by the old write heals itself.
