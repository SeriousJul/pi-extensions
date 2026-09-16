# Develop

How to add an extension to this package: the minimal example, the
multi-file layout, how to use the package from a local checkout, and the
test commands.

## Layout

```
.
├── package.json      # pi manifest under the "pi" key, pi-package keyword
├── tsconfig.json     # type checking only. pi loads .ts via jiti, no build step
├── extensions/       # every .ts file (or subdirectory with index.ts) is an extension
│   ├── tools.ts
│   ├── context-cap/  # multi-file extension, entry point at context-cap/index.ts
│   ├── model-router/ # multi-file extension, entry point at model-router/index.ts
│   ├── quota/        # multi-file extension, entry point at quota/index.ts
│   ├── sync/         # multi-file extension, entry point at sync/index.ts, plus the pi-sync CLI
│   └── codegraph/    # multi-file extension, entry point at codegraph/index.ts
├── docs/adr/         # architecture decision records
├── scripts/          # postinstall patch for the embedded codegraph library
└── tests/            # vitest suite
```

`extensions/` is a convention directory: every `.ts` file in it is
loaded as an extension. Multi-file extensions go in a subdirectory with
an `index.ts` entry point. You can also add `skills/`, `prompts/`, and
`themes/` directories and list them in the `pi` manifest in
`package.json`.

## The minimal example

A minimal extension registers a command that shows a notification.
Use the code below as a starting point. An extension is a TypeScript
module with a default export:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("loaded", "info");
  });

  pi.registerCommand("my-cmd", {
    description: "Do a thing",
    handler: async (args, ctx) => {
      ctx.ui.notify(args || "hi", "info");
    },
  });
}
```

Core packages (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are
bundled by pi at runtime. List the ones you import in
`peerDependencies` with a `"*"` range, and do not bundle them. If an
extension needs third party npm packages, add them to `dependencies` in
`package.json` and run `npm install`. Runtime installs are production
installs, so `devDependencies` are not available when the package is
installed by pi.

## Local install

Work from a checkout instead of the git install. Install the dependencies
once; the `postinstall` step applies the codegraph patch. The patch is
idempotent and uses absolute paths, so re-run `npm install` if you move the
checkout.

```bash
npm install
```

Load the checkout into a pi session without installing:

```bash
pi -e /absolute/path/to/pi-extensions                    # whole package
pi -e /absolute/path/to/pi-extensions/extensions/hello.ts  # one extension
```

Or point settings at the checkout. pi does not copy local paths, so the
checkout stays in use where it is:

```bash
pi install /absolute/path/to/pi-extensions     # user settings
pi install -l /absolute/path/to/pi-extensions  # project settings
```

## Test

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest suite; runs on Node or bun
npm run smoke:node  # plain-Node smoke test: loads the extension through jiti
                    # exactly like pi does, builds a real index on a fixture
                    # repository, and runs real tool handlers
```

Bun-only tests for the SQLite shim path:

```bash
bun test tests/codegraph/shim-bun.test.cts
bun test tests/codegraph/runtime-bun.test.cts
```

## Documentation

The [glossary](/glossary) (the repo-root `CONTEXT.md`) is the single
source of the domain language: index, project root, named root, trusted
root, seed, reconcile, prewarm, and the rest. The
[ADRs](/adr/) record the architecture decisions behind the design.
Design specs live as GitHub issues on this repository; the issue titles
carry the spec numbers, and `spec 000X` references in code comments
point to them.
