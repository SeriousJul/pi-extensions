# pi-extensions

A pi package that bundles pi extensions. Documentation lives on the
[docs site](https://seriousjul.github.io/pi-extensions/), built with
VitePress from the [`docs/`](docs/) folder.

- **codegraph** - semantic code index for the agent. The main extension.
- **tools** - the `/tools` command to enable and disable tools per session.
- **context-cap** - `--context-window <tokens>` caps the session's context window so compaction fires early.
- **model-router** - recovers a session from a provider usage-limit halt (switch to a fallback or wait for the reset, then resume).
- **llama-refresh** - self-heals the context window of a session that resolved a local llama.cpp model while it was asleep.
- **quota** - monitors the OpenAI ChatGPT plan quota: a footer line with the used windows, and a `/quota` detail view.
- **resource-toggle** - `/resources`, `/enable`, `/disable`, `/inherit`: enable and disable extensions, skills, prompt templates, and themes from inside a running session.
- **usage** - token and cost reporting across all pi sessions: the `/usage` TUI view, the `usage_report` agent tool, and the `pi-usage` CLI.
- **sync** - cross-device pi config sync: `/sync` plus the `pi-sync` CLI, three-way merge, v1 backend a secret GitHub Gist.
- **compress** - replaces finished turns in outgoing requests with one short standing-in message; the session file stays intact.
- **pruning** - two-level context control: prunes large tool outputs out of the request at pi's compaction threshold, and lets the prune gate cancel the compaction when pruning alone frees enough headroom.
- **output-limits** - bounds the size of a tool result before pi stores it, against a share of the session's headroom, and keeps the whole result in a spill file so the cut is lossless.
- **edit-assist** - corrects and diagnoses built-in edit calls: an oldText that differs from the file only in leading whitespace is corrected before execution, and the success result carries a one-line honesty note naming the line; a no-match failure gets the Nearest region with a unified diff, an ambiguous match gets the occurrence line numbers, a malformed call gets one targeted hint, and the stock error text is always kept.
- **background-jobs** - `bash_bg`, `job_wait`, `job_status`: run long commands in the background and wait on them once, instead of sleep-and-tail loops.
- **skills** - a curated skill tree loaded by pi from the package's `skills/` directory, with `npm run skills:update` to three-way-merge upstream changes into the copies. The `mattpocock/` skills come from [mattpocock/skills](https://github.com/mattpocock/skills), MIT licensed (the upstream `LICENSE` ships at `skills/mattpocock/LICENSE`).

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
| pruning | [docs](https://seriousjul.github.io/pi-extensions/extensions/pruning.html) |
| output-limits | [docs](https://seriousjul.github.io/pi-extensions/extensions/output-limits.html) |
| edit-assist | [docs](https://seriousjul.github.io/pi-extensions/extensions/edit-assist.html) |
| background-jobs | [docs](https://seriousjul.github.io/pi-extensions/extensions/background-jobs.html) |

## Skills

The package ships a skill tree under `skills/`; pi loads it through the
`skills` entry in the `pi` manifest in `package.json` when the package is
installed (convention directories are not auto-discovered while a `pi`
manifest is present). Layout is the manifest:

- `skills/mattpocock/<bucket>/<name>` - skills tracked against the upstream
  [mattpocock/skills](https://github.com/mattpocock/skills) repo, mirroring
  its `skills/<bucket>/<name>` layout.
- `skills/local/<name>` - local-only skills. Sync never reads, merges, or
  reports them.

Tweaking a skill is editing the file in this repo. `skills-manifest.json`
holds one entry per skill source: repo URL, local root, and the Source pin
(the upstream commit the whole tree last agreed on).

```
npm run skills:update            # fetch upstream, three-way-merge tracked skills
npm run skills:add -- <bucket>/<name>   # adopt a new upstream skill
```

`skills:update` merges every tracked file with `git merge-file` (base = the
pin, theirs = the fetched commit, ours = the local copy). Clean merges apply
automatically. A file both sides changed comes back with git conflict
markers; resolve it in place, and the pin advances on the next clean sync.
Upstream deletes of a skill are reported as orphans and kept in place. New
upstream skills are listed as offers and adopted only by `skills:add`.
The Source pin advances only when a sync completes with no conflict and no
orphan. The tool never commits, pushes, deletes, or renames.

The tree also stays compatible with `npx skills@latest add
SeriousJul/pi-extensions`.

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
│   ├── resource-toggle/  # multi-file extension, entry point at resource-toggle/index.ts
│   ├── usage/        # multi-file extension, entry point at usage/index.ts, plus the pi-usage CLI
│   ├── sync/         # multi-file extension, entry point at sync/index.ts, plus the pi-sync CLI
│   ├── codegraph/    # multi-file extension, entry point at codegraph/index.ts
│   ├── compress/     # multi-file extension, entry point at compress/index.ts
│   └── pruning/      # multi-file extension, entry point at pruning/index.ts
├── docs/             # VitePress site root, canonical source for all documentation
│   ├── .vitepress/   # site config; its own package.json + lockfile for site tooling
│   ├── adr/          # architecture decision records
│   └── agents/       # agent skill files (excluded from the site navigation)
├── CONTEXT.md        # the domain glossary, single source (published on the site)
├── scripts/          # postinstall patch for the embedded codegraph library
│   └── skills/       # skill sync (skills:update) and adopt (skills:add) tools
├── skills/           # the skill tree pi loads from the package (mattpocock/ + local/)
├── skills-manifest.json  # one entry per skill source: repo, local root, Source pin
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
pi -e /absolute/path/to/pi-extensions/extensions/tools.ts
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
