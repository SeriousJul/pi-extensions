---
layout: home
title: Home
hero:
  name: pi-extensions
  text: A pi package that bundles pi extensions
  tagline:
    Semantic code search, quota recovery, and cross-device config sync for
    the pi coding agent.
  actions:
    - theme: brand
      text: codegraph
      link: /extensions/codegraph/
    - theme: alt
      text: Develop an extension
      link: /develop
---

## Install

Install into user settings (default):

```bash
pi install /absolute/path/to/pi-extensions
```

Or into project settings, shared with the team:

```bash
pi install -l /absolute/path/to/pi-extensions
```

Git URLs work too. Remove with `pi remove <package>`, list with `pi list`.

After any install, run `npm install` in the package directory once. The
`postinstall` step prepares the pinned codegraph package for the runtime pi
embeds.

### Develop

Test a package or a single extension in a pi session without installing:

```bash
pi -e /absolute/path/to/pi-extensions
```

```bash
npm install
npm run typecheck
npm test
```

## Extensions

| Extension | What it does |
| --- | --- |
| [codegraph](/extensions/codegraph/) | Semantic code index for the agent: six tools plus `/codegraph`, one index per git worktree, dependency sources via `projectRoot`. |
| [tools](/extensions/tools) | The `/tools` command to enable and disable tools per session. |
| [context-cap](/extensions/context-cap) | `--context-window <tokens>` caps the session's context window so compaction fires early. |
| [initial-context](/extensions/initial-context) | `/ctx` shows the token breakdown of the agent's initial context, with per-tool usage. |
| [model-router](/extensions/model-router) | Recovers a session from a provider usage-limit halt (switch to a fallback or wait for the reset, then resume). |
| [quota](/extensions/quota) | Monitors the OpenAI ChatGPT plan quota: a footer line with the used windows, and a `/quota` detail view. |
| [sync](/extensions/sync/) | Cross-device pi config sync: `/sync` plus the `pi-sync` CLI, three-way merge, v1 backend a secret GitHub Gist. |
| [usage](/extensions/usage) | The `pi-usage` CLI and the usage report: token and cost usage across all pi sessions. |
| hello | A minimal example extension, covered by the [develop](/develop) page. |
