# Safe compaction extension

Takes over the compaction summary when the session's thinking level would break it.

pi budgets the compaction summary's output as a share of
`compaction.reserveTokens`: 0.8x for the history summary, 0.5x for a split
turn's prefix, capped by the model's output ceiling. The budget counts
thinking tokens the same way it counts summary text. A reasoning model at an
effort level can spend the whole budget thinking and stop mid-summary. pi
then fails the compaction with "generation hit the token cap and the summary
is incomplete", records no entry, and the session keeps growing with every
failed retry (the **Thinking overflow**).

## Behavior

- When the model reasons and the session's thinking level is on, the
  extension re-runs pi's own compaction on the before-compact event: the
  same prompts, budgets, and split-turn handling, thinking disabled, and the
  user's retry policy from the same settings files. The compaction entry is
  extension-provided.
- When even the thinking-free run cannot write a summary (the engine is
  down, the engine fails the request, the model cannot finish), the
  extension degrades to the deterministic **Checkpoint**: the previous
  summary verbatim, the original request, a capped index of the turn's text
  and tool activity, and the read and modified file lists. The compaction
  completes, and the session never strands in an ever-growing context.
- A transient stream drop in the thinking-free run spends the user's retry
  budget before the checkpoint: the `retry` section of the settings files,
  read with pi's own merge and defaults.
- The guard stands aside and pi's built-in summarizer runs when the
  extension is disabled, the model does not reason, or the session's
  thinking level is off.
- A user abort cancels the compaction. The handler never throws: an
  unhandled error would hand the unsafe native path back, which is the path
  this extension exists to fix.

## Settings

The `safeCompaction` section of the settings files: the project
`<cwd>/.pi/settings.json` overrides the global
`$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`), key
by key. A malformed value falls back to its default and is reported in a
notification; it never throws. There is no settings command: the file is
edited by hand.

| Key | Default | Meaning |
| --- | --- | --- |
| `safeCompaction.enabled` | `true` | `false` hands compaction back to pi's built-in summarizer, thinking level and all. |

The `retry` section is pi's own section. The extension reads it to forward
pi's retry policy to the re-run (defaults `enabled: true`,
`maxRetries: 3`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60000`) and never
writes it.

## How it works

The decision logic, the file-list derivation, and the Checkpoint builder
live in the engine-free core module (`extensions/safe-compaction/core.ts`);
the settings reader (`settings.ts`) parses the `safeCompaction` and `retry`
sections of the settings files; the pi wiring (`index.ts`) registers the
before-compact handler and re-runs pi's own `compact()` with thinking
disabled. See [ADR 0044](/adr/0044-safe-compaction-reruns-the-summary-without-thinking).

## Tests

- `tests/safe-compaction/core.test.ts` - the takeover decision, the file
  lists, and the checkpoint budgets.
- `tests/safe-compaction/settings.test.ts` - the merge, the retry defaults,
  the fallbacks, and the reports.
- `tests/safe-compaction/wiring.test.ts` - the real handler against fakes:
  the stand-aside paths, the takeover, the checkpoint fallback, and the
  dead-UI and malformed-settings paths.
- `npm run e2e:safe-compaction` - a real `pi` session against a mock engine
  that mirrors the recorded failure: a thinking-carrying summarization runs
  to the cap, a thinking-free one completes. One scenario locks the
  reporter's exact error, one locks the retry budget, one the checkpoint.

## Limitations

- The re-run streams through pi's built-in handler for the model's API. A
  session with a custom stream function (SDK, or a provider registered with
  `streamSimple`) runs its re-run through the built-in handler instead of
  its own function, and that function's provider-level transport settings
  (`retry.provider`) do not apply to the re-run.
- The Checkpoint is extractive and lossy in detail: it stands in for the
  model's narrative until the next successful compaction summarizes it
  away.
- A session with no model degrades straight to the **Checkpoint**: the
  summary cannot be written without one.
