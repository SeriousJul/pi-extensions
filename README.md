# pi-extensions

A pi package that bundles pi extensions. Documentation lives on the
[docs site](https://seriousjul.github.io/pi-extensions/), built with
VitePress from the [`docs/`](docs/) folder.

- **codegraph** - semantic code index for the agent. The main extension.
- **tools** - the `/tools` command to enable and disable tools per session.
- **context-cap** - `--context-window <tokens>` caps the session's context window so compaction fires early.
- **model-router** - recovers a session from a provider usage-limit halt (switch to a fallback or wait for the reset, then resume).
- **quota** - monitors the OpenAI ChatGPT plan quota: a footer line with the used windows, and a `/quota` detail view.
- **resource-toggle** - `/resources`, `/enable`, `/disable`, `/inherit`: enable and disable extensions, skills, prompt templates, and themes from inside a running session.
- **usage** - `/usage`: LLM token and cost reporting across all pi sessions, plus the `pi-usage` CLI.
- **sync** - cross-device pi config sync: `/sync` plus the `pi-sync` CLI, three-way merge, v1 backend a secret GitHub Gist.
- **usage** - token and cost reporting across all sessions, as a TUI view, a CLI, and a `/usage` agent tool.
- **compress** - replaces finished turns in outgoing requests with one short standing-in message; the session file stays intact.
- **hello** - a minimal example extension.

See the [pi packages docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and the [extensions docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Extensions

| Extension | Docs |
| --- | --- |
| codegraph | [user page](https://seriousjul.github.io/pi-extensions/extensions/codegraph/) / [internals](https://seriousjul.github.io/pi-extensions/extensions/codegraph/internals.html) |
| tools | [docs](https://seriousjul.github.io/pi-extensions/extensions/tools.html) |
| context-cap | [docs](https://seriousjul.github.io/pi-extensions/extensions/context-cap.html) |
| initial-context | [docs](https://seriousjul.github.io/pi-extensions/extensions/initial-context.html) |
| model-router | [docs](https://seriousjul.github.io/pi-extensions/extensions/model-router.html) |
| quota | [docs](https://seriousjul.github.io/pi-extensions/extensions/quota.html) |
| sync | [user page](https://seriousjul.github.io/pi-extensions/extensions/sync/) / [internals](https://seriousjul.github.io/pi-extensions/extensions/sync/internals.html) |
| usage | [docs](https://seriousjul.github.io/pi-extensions/extensions/usage.html) |
| compress | [docs](https://seriousjul.github.io/pi-extensions/extensions/compress.html) |
| hello | covered by the [develop page](https://seriousjul.github.io/pi-extensions/develop.html) |

## Layout

```
.
├── package.json      # pi manifest under the "pi" key, pi-package keyword
├── tsconfig.json     # type checking only. pi loads .ts via jiti, no build step
├── extensions/       # every .ts file (or subdirectory with index.ts) is an extension
│   ├── hello.ts
│   ├── tools.ts
│   ├── context-cap/  # multi-file extension, entry point at context-cap/index.ts
│   ├── model-router/ # multi-file extension, entry point at model-router/index.ts
│   ├── quota/        # multi-file extension, entry point at quota/index.ts
│   ├── resource-toggle/  # multi-file extension, entry point at resource-toggle/index.ts
│   ├── usage/        # multi-file extension, entry point at usage/index.ts, plus the pi-usage CLI
│   ├── sync/         # multi-file extension, entry point at sync/index.ts, plus the pi-sync CLI
│   ├── codegraph/    # multi-file extension, entry point at codegraph/index.ts
│   └── compress/     # multi-file extension, entry point at compress/index.ts
├── docs/             # VitePress site root, canonical source for all documentation
│   ├── .vitepress/   # site config; its own package.json + lockfile for site tooling
│   ├── adr/          # architecture decision records
│   └── agents/       # agent skill files (excluded from the site navigation)
├── CONTEXT.md        # the domain glossary, single source (published on the site)
├── scripts/          # postinstall patch for the embedded codegraph library
└── tests/            # vitest suite
```

`extensions/` is a convention directory: every `.ts` file in it is loaded as
an extension. Multi-file extensions go in a subdirectory with an `index.ts`
entry point. You can also add `skills/`, `prompts/`, and `themes/`
directories and list them in the `pi` manifest in `package.json`.

## Install

Install from the git repository into user settings (default):

```bash
pi install https://github.com/SeriousJul/pi-extensions
```

Or into project settings, shared with the team:

```bash
pi install -l https://github.com/SeriousJul/pi-extensions
```

pi clones the repository to
`~/.pi/agent/git/github.com/SeriousJul/pi-extensions`
(`.pi/git/github.com/SeriousJul/pi-extensions` for project settings) and
runs `npm install` for you. The `postinstall` step
(`scripts/patch-codegraph.mjs`) prepares the pinned
`@colbymchenry/codegraph` package for the runtime pi embeds. See the
[codegraph internals page](https://seriousjul.github.io/pi-extensions/extensions/codegraph/internals.html)
for what the patch does and why.

Update with `pi update --extensions`. Remove with
`pi remove https://github.com/SeriousJul/pi-extensions`, list with `pi list`.

To develop from a local checkout instead, see [Develop](#develop).

### Develop

Work from a local checkout. Install its dependencies once; the
`postinstall` step applies the codegraph patch. The patch is idempotent and
uses absolute paths, so re-run `npm install` if you move the checkout.

```bash
npm install
```

Test the package or a single extension in a pi session without installing:

```bash
pi -e /absolute/path/to/pi-extensions
pi -e /absolute/path/to/pi-extensions/extensions/hello.ts
```

Or install the checkout into settings. pi does not copy local paths, so the
checkout stays in use where it is:

```bash
pi install /absolute/path/to/pi-extensions      # user settings
pi install -l /absolute/path/to/pi-extensions   # project settings
```

```bash
npm run typecheck
npm test
```

The full developer walkthrough (minimal example, multi-file layout, local
install, test commands) is on the [develop page](https://seriousjul.github.io/pi-extensions/develop.html).

### Docs site

The site is built from `docs/` with VitePress and deployed to the
`gh-pages` branch on every push to `main` (`.github/workflows/deploy-docs.yml`).
Site tooling lives in `docs/package.json` with its own lockfile; the root
manifest only delegates `npm run docs:dev` and `npm run docs:build`, so the
site build tools never enter the package that `pi install` users install.

```bash
npm run docs:dev    # local dev server
npm run docs:build  # production build (also run by CI on every PR)
```
