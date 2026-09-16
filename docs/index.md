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

Install from the git repository into user settings (default):

```bash
pi install https://github.com/SeriousJul/pi-extensions
```

Or into project settings, shared with the team:

```bash
pi install -l https://github.com/SeriousJul/pi-extensions
```

pi clones the repository and runs `npm install` for you, which also applies
the codegraph postinstall patch. Update with `pi update --extensions`.
Remove with `pi remove https://github.com/SeriousJul/pi-extensions`,
list with `pi list`.

### Develop

Work from a local checkout: run `npm install` in it (the postinstall step
applies the codegraph patch), then load it into a pi session without
installing:

```bash
pi -e /absolute/path/to/pi-extensions
```

```bash
npm install
npm run typecheck
npm test
```

The full walkthrough, including local install, is on the
[develop page](/develop).

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
| [compress](/extensions/compress) | Replaces finished turns in outgoing requests with one short standing-in message; the session file stays intact. |
