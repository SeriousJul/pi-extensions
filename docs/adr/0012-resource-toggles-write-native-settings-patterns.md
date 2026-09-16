# Resource toggles write the native settings override patterns

The resource-toggle extension must persist enable/disable state where pi reads it before resources load, and it must stay interchangeable with pi's own `pi config` tool. We decided: the extension writes the native override patterns (`+path` force-include, `-path` force-exclude) into the `extensions`, `skills`, `prompts`, and `themes` arrays of the settings files, in global or project scope, and applies changes with an in-session reload. No private config file of its own.

## Considered Options

- **Native settings patterns (chosen).** The only storage pi consults during resource resolution, so a disabled resource is fully unloaded at load time with no hook in between. The state is visible to and writable by `pi config`, so both tools share one source of truth. A workspace-level disable of a global resource uses pi's own shadowing: a plain path plus a pattern in the project settings re-registers the resource at project scope, which wins the precedence deduplication.
- **Private toggle file.** No load-time hook reads such a file, so the extension would have to translate it into settings patterns before every resolve. That is the same write with one extra indirection, plus a second source of truth that `pi config` cannot see.
- **Runtime suppression.** An extension cannot prevent another extension's factory from running, and registered commands cannot be unregistered, so suppression would leave half of a disabled extension live.
