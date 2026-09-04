# Spec 0002: Fold the runtime compatibility stack into one module

Status: implemented. Source: architecture review, 2026-09-04, candidate 2.

## Background

"Make codegraph run under pi's runtimes" is spread over five files with an
invisible load-order rule:

- `env.ts` - sets `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`,
  and `CODEGRAPH_NO_FAST_INIT=1` (bun only). Must load before the codegraph
  library initializes. Six files import it for the side effect only:
  `codegraph.ts`, `format.ts`, `index.ts`, `root.ts`, `seed.ts`,
  `session.ts`.
- `codegraph.ts` - loads the library through CJS `createRequire` (the
  package's CJS re-export shape breaks ESM named imports under plain Node
  and tsx) and re-exports its values and types. The single import point for
  the library.
- `sqlite-shim.cjs` - the `node:sqlite` surface over the runtime that is
  actually present: real `node:sqlite` on Node, an emulation over
  `bun:sqlite` on pi's bun runtime.
- `scripts/patch-codegraph.mjs` - postinstall rewriter: rewrites the
  installed package's `require('node:sqlite')` to the shim and bare
  requires to absolute paths (bun worker threads cannot resolve bare
  specifiers).
- `session.ts` (`classifyError`) - detects a broken runtime by matching
  error text: `/node:sqlite|No such built-in module/i`. The session thus
  carries a string that belongs to the shim's failure mode.

Problems:

- The load-order rule exists only as a comment. A new file that imports the
  library without `env.ts` breaks telemetry silencing silently.
- Runtime knowledge is not local: the fix instruction ("run `npm install`
  in the pi-extensions repo, then restart pi") is built from an error text
  produced by a different file.
- Nothing verifies at load time that the installed package is wired to the
  shim. The patch script is best-effort and only warns at install time.

## Goals

- One runtime module owns the whole compatibility stack: env defaults,
  library loading, shim wiring, and runtime gap detection.
- The load-order rule becomes structural: env defaults and the library
  load happen in one file, in file order.
- The session no longer carries runtime error strings.
- A preflight check reports a runtime gap with an actionable reason before
  the first query, instead of after the first failure.

## Non-goals

- No change to `sqlite-shim.cjs` internals or its
  `CODEGRAPH_PI_SQLITE_SHIM=bun` test switch.
- No change to the patch script's behavior (it stays postinstall,
  idempotent, best-effort).
- No change to tool output, the prompt note, or user-facing message text.
- No transport change. ADR-0001's in-process embed stands.

## Target design

One new module (name proposal: `runtime.ts`) in `extensions/codegraph/`.
It absorbs `env.ts` and `codegraph.ts`. `env.ts` and `codegraph.ts` are
deleted; the six side-effect imports and the six `./codegraph` imports
become imports of the runtime module.

The module owns, in this order (the order is the contract):

1. **Env defaults** - the current `env.ts` body, unchanged, including
   user-settings-wins.
2. **Library load** - the current `codegraph.ts` body: CJS `createRequire`,
   the value re-exports (`CodeGraph`, `FileLock`, `findNearestCodeGraphRoot`,
   `getDatabasePath`, `getCodeGraphDir`, `isInitialized`) and the type
   re-exports.
3. **Shim export** - re-export of the shim (`DatabaseSync`, `backup`,
   `backupFile`, `backend`), so `seed.ts` and the tests import the shim
   through one place.
4. **Preflight** - runs once, lazily, on first use; the result is cached.
   Checks:
   - the library require succeeded;
   - the shim backend is a known value (`node:sqlite` or `bun:sqlite`);
   - a functional round trip: open a temporary database through the shim,
     run one query, close it. This catches a broken shim wiring (for
     example, a moved shim file) before a real index is at stake.
   On failure it returns an actionable reason. On success it returns ok.
5. **Runtime error classification** - moves out of `session.ts`
   (`classifyError`). The module knows its own failure vocabulary: the
   shim's error prefix and the `No such built-in module` text of an
   unpatched package. It maps a thrown value to an
   `CodegraphUnavailable` with the current, unchanged reason text, or
   passes other errors through. The session keeps the `notifyOnce` call
   with the existing `runtime-sqlite` key.

The patch script's relationship is documented in the module header: the
script is the install-time writer, the runtime module is the load-time
owner. A package that was never patched fails at the first database open
and is classified with the existing fix instruction.

## Behavior freeze

- Env variable names, defaults, and precedence (user settings win).
- The `CODEGRAPH_PI_SQLITE_SHIM=bun` switch and its semantics.
- The `runtime-sqlite` notification message and the unavailable reason
  string, byte for byte.
- The standard fallback line for unavailable tools (built by
  `unavailableText` in `format.ts`, unchanged).
- Loader matrix: the module must load under jiti (Node), tsx, bun, and
  vitest. The plain-node smoke test is the guard.

## Tests

Survive unchanged:

- `tests/codegraph/shim.test.ts` - the shim surface (imports the shim via
  the runtime module).
- `tests/codegraph/shim-bun.test.cts` - the bun round trip.
- `tests/codegraph/smoke.test.ts` - the plain-node load path.
- `tests/codegraph/session.test.ts` - the unavailable contract cases.

New, fast, no index build:

- Preflight: ok on the current runtime (temporary database round trip);
  the result is computed once (second call returns the cache without a
  second round trip).
- Env defaults: set when unset; preserved when the user set them.
- Classification: the shim error prefix and the `No such built-in module`
  text map to `CodegraphUnavailable` with the frozen reason; an unrelated
  error passes through unchanged.
- Backend: reports the active backend; with
  `CODEGRAPH_PI_SQLITE_SHIM=bun` it reports `bun:sqlite` (bun test file).

## Migration steps

1. Create the runtime module: env body, then library load, then shim
   export. Run the suite (nothing imported it yet).
2. Add the preflight and the classification; unit-test them before wiring.
3. Point `session.ts`, `root.ts`, `format.ts`, `seed.ts`, `index.ts`,
   `handlers.ts` (type imports) at the runtime module; delete the
   `./env` and `./codegraph` imports.
4. Replace `classifyError`'s regex branch with the runtime classification;
   keep the `notifyOnce` key and message.
5. Delete `env.ts` and `codegraph.ts`. Update the smoke test if it names
   them (it does not; it loads the extension entry).
6. Full suite plus the plain-node smoke test.

## Ordering

Independent of specs 0001 and 0003. Recommended second: after the session
split, the classification move in step 4 touches a smaller file.

## ADR alignment

No conflict. ADR-0001 records that upgrades are a dependency bump and that
the in-process embed is the chosen transport. This spec changes neither;
it contains the embed's failure surface at one module, so the ADR's
consequences (pinning a version, the patch step) are owned and verified in
one place instead of five.
