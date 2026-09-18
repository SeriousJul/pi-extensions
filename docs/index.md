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

## Extensions

| Extension | What it does |
| --- | --- |
| [codegraph](/extensions/codegraph/) | Semantic code index for the agent: four tools plus `/codegraph`, one index per git worktree, dependency sources via `projectRoot`. |
| [tools](/extensions/tools) | The `/tools` command to enable and disable tools per session. |
| [context-cap](/extensions/context-cap) | `--context-window <tokens>` caps the session's context window so compaction fires early. |
| [initial-context](/extensions/initial-context) | `/ctx` shows the token breakdown of the agent's initial context, with per-tool usage. |
| [model-router](/extensions/model-router) | Recovers a session from a provider usage-limit halt (switch to a fallback or wait for the reset, then resume). |
| [llama-refresh](/extensions/llama-refresh) | Self-heals the context window of a session that resolved a local llama.cpp model while it was asleep. |
| [quota](/extensions/quota) | Monitors the OpenAI ChatGPT plan quota: a footer line with the used windows, and a `/quota` detail view. |
| [sync](/extensions/sync/) | Cross-device pi config sync: `/sync` plus the `pi-sync` CLI, three-way merge, v1 backend a secret GitHub Gist. |
| [usage](/extensions/usage) | The `pi-usage` CLI and the usage report: token and cost usage across all pi sessions. |
| [compress](/extensions/compress) | Replaces finished turns in outgoing requests with one short standing-in message; the session file stays intact. |
