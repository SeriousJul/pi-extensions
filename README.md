# pi-extensions

A pi package that bundles extensions. See the [pi packages docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and the [extensions docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Layout

```
.
├── package.json      # pi manifest under the "pi" key, pi-package keyword
├── tsconfig.json     # type checking only. pi loads .ts via jiti, no build step
└── extensions/       # one .ts file per extension (or a subdirectory with index.ts)
    └── hello.ts
```

`extensions/` is a convention directory: every `.ts` file in it is loaded as an extension. You can also add `skills/`, `prompts/`, and `themes/` directories and list them in the `pi` manifest in `package.json`.

## Develop

```bash
npm install
npm run typecheck
```

Core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`) are bundled by pi at runtime. List the
ones you import in `peerDependencies` with a `"*"` range, and do not bundle
them. For local type checking they are installed as devDependencies.

## Test

Load this package in a pi session without installing:

```bash
pi -e /absolute/path/to/pi-extensions
```

Or test a single extension file:

```bash
pi -e /absolute/path/to/pi-extensions/extensions/hello.ts
```

In the session, run `/hello` to verify the command works.

## Install

Install into user settings (default):

```bash
pi install /absolute/path/to/pi-extensions
```

Or into project settings, shared with the team:

```bash
pi install -l /absolute/path/to/pi-extensions
```

Remove with `pi remove /absolute/path/to/pi-extensions`, list with `pi list`.

## Writing an extension

An extension is a TypeScript module with a default export:

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

Multi-file extensions go in a subdirectory with an `index.ts` entry point:

```
extensions/
└── my-extension/
    ├── index.ts    # exports the default function
    └── utils.ts
```

If an extension needs third party npm packages, add them to `dependencies`
in `package.json` and run `npm install`. Runtime installs are production
installs, so `devDependencies` are not available when the package is
installed by pi.
