# The TypeScript 7 native server is found per root, ahead of every other pick

TypeScript 7 is the native Go rewrite of the compiler. It dropped
`tsserver`, and `typescript-language-server` therefore cannot serve a
TypeScript 7 project. TypeScript 7 carries its own Language server inside
the compiler binary: `tsc --lsp --stdio`. A TypeScript 7 project is a
project whose `node_modules` installs `typescript@7`, usually with no
TypeScript server on `PATH` at all. Before this ADR the registry reported
such a project absent, and an operator override of
`node_modules/.bin/tsc` only worked when pi happened to start in exactly
that project root.

**Detection walks up from the session root for the project's own
`typescript` package and reads its version.** Major 7 or newer is the
native compiler: its `node_modules/.bin/tsc` serves the root with the
arguments `--lsp --stdio`, ahead of every machine-level binary, because it
is the project's real compiler and no other server can drive it. A nearer
install below major 7 stops the walk: for that tree the classic
`typescript-language-server` remains the right server even when an outer
directory holds a newer one. A file whose own root carries a `typescript@7`
the session-root walk cannot see is still served by that root's local
`tsc`. A `tsc` on `PATH` is accepted only after a version probe, cached
per command, reports 7 or newer: the 5.x and 6.x `tsc` is a compiler CLI
that rejects `--lsp`. `tsgo` on `PATH` is the native preview and counts
without a probe.

**Server commands resolve to absolute paths before the spawn.** A settings
`command` is first looked up on `PATH`, then resolved against the session
root. The server process then runs from its root with an absolute command,
so a hoisted `node_modules` and a session started anywhere both work.

**Considered options.** Pinning a `typescript-language-server` version that
understands TypeScript 7. Rejected: no such server exists, because the
node-based language service TypeScript 7 removed is what that server
drives. Detecting TypeScript 7 only through a settings override. Rejected:
it leaves the default experience broken on the most common shape of a
TypeScript 7 machine, where nothing is on `PATH` and the project carries
its own compiler. Probing every candidate with `tsc --lsp --stdio`
(handshake and kill) instead of reading the package version. Rejected: a
real spawn per registry resolution, and the registry resolves on nearly
every hook.

**Consequences.** One machine can serve a TypeScript 5 project with
`typescript-language-server` and a TypeScript 7 project with the native
`tsc` in the same session: the pick is per root, and a project that pins
an older TypeScript keeps the classic server. A `typescript@7` install
without its `tsc` bin is a broken install and is reported absent, not
worked around. The version probe runs at most once per command per
session. The `--lsp` flag is hidden from `tsc --help` upstream; the
two-flag form `--lsp --stdio` is the only form that runs, and the
extension always sends both. An operator `command` override always wins
over the auto-detection, and an override that names `tsc` or `tsgo`
without `args` receives the native arguments.
