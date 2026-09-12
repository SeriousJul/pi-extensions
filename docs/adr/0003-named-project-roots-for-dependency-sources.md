# Named project roots for dependency sources

The agent reads dependency source through the opensrc cache, outside the
session root. Before this decision only `codegraph_node` file mode could reach
it, by accident: an absolute path outside the session root built an index in a
tree nobody asked about, served it with no label, and `codegraph_explore`
answered the same path from the wrong project. We decided that all six tools
take an optional `projectRoot`, that a call naming one is served from it and
labeled with its name and version, that building there is allowed only under a
Trusted root, and that serving an index which already exists is allowed
anywhere.

## The decision

- All six tools take an optional `projectRoot`. It is the call's anchor: file
  arguments resolve inside it and never move it.
- Building an index in a Named root is allowed only under a Trusted root:
  `$OPENSRC_HOME` or `~/.opensrc`, plus `CODEGRAPH_PI_TRUSTED_ROOTS`, plus
  `/codegraph add <path>` for the session. Serving an existing index is not
  gated: the act that needs consent is the one with a cost and a side effect.
- One root serves one call. No call spans two roots, because the graph is
  per-root and edges exist only inside one index.
- A Named path inside a cache entry snaps up to that entry, so one fetched
  source has one complete index instead of one partial index per member crate.
- A Dependency source gets no watcher and no prewarm. It reconciles before each
  query, which measured about 22 ms per 1 000 files.
- A version mismatch stays visible instead of being detected. opensrc's cache
  can hold a version the project does not use; the label is what lets the agent
  see it.

## Considered Options

- **A name parameter resolved through opensrc.** Rejected on evidence.
  `opensrc path <name>` resolves against a registry, not against the cache:
  `opensrc path crates:accesskit` fetched 0.25.0 over the network and rewrote
  the cache manifest while 0.24.1 sat cached, and `--cwd` did not switch the
  registry for a Rust project (`Package "accesskit" not found on npm`). Its
  lockfile detection is npm-only, and otherwise it uses the latest published
  version. A name therefore cannot be resolved offline to the version a project
  pins, and resolving it inside a tool would put a network fetch in a search
  call. The agent already holds the absolute path: `opensrc path` runs in bash,
  in the open.
- **Anchor inference** - extend `codegraph_node`'s file anchor to all six
  tools, so any path-shaped argument moves the root. Rejected. It reverses the
  rule that a `file` used to disambiguate a symbol never moves the anchor, and
  `codegraph_explore`'s query is free text, so inference there is guesswork.
- **A central index cache outside the tree.** Not possible. `CODEGRAPH_DIR`
  renames the index directory but it must stay a single path segment inside the
  root; a separator, `..`, or an absolute path is ignored. A symlink re-opens
  the lockfile and inode-replacement problems ADR 0002 rejected, and copying
  the source would make every emitted path a lie. The index lives in-tree, so
  `opensrc remove` and `opensrc clean` remove it with the source - the right
  lifetime for an index that is disposable and rebuildable in seconds.

## Consequences

- This reverses "there is no `projectPath` parameter on any tool" in the
  extension README and the assertion in `tests/codegraph/tools.test.ts`. Both
  are rewritten, not deleted: the parameter is bounded, and the bound is the
  point. Upstream's word stays out of the schema, because upstream's parameter
  is unbounded.
- Results from a Named root must be labeled, since two roots both contain
  `src/lib.rs`. The label comes from `opensrc list --json`: longest path prefix
  wins, all names on one path are shown, and a root that matches no entry falls
  back to a path form. A missing label never fails a call. One module names
  opensrc, the way `indexAdapter.ts` names the codegraph library.
- Measured cost of a build: 1.3 s and 34.6 MB for 390 files (egui 0.36.1),
  2.4 s and 99 MB for 1 218 files (pi 0.84.4). Disk is 3-5x the source, which
  is why the Trusted-root bound exists and why no prewarm was added.
- The prompt note gains one policy line, and only when a Trusted root exists on
  disk. Where no call can build, the note must not advertise one.
