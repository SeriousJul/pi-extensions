# compress extension

Compresses finished turns out of outgoing LLM requests without touching the
session file. A turn that falls out of the keep window is replaced in every
outgoing request by one short synthetic user message carrying a compressed
form of the turn. The full original messages stay in the session file, and
each compressed span is persisted as a `compress-span` custom session entry
([ADR 0015](/adr/0015-compression-is-a-request-time-view)).

Compression is opt-in: the extension does nothing until a compression model
is set with `/compression-model`.

## Behavior

- **Keep window.** The last `keepTurns` finished turns, plus the turn in
  progress, always go out raw. Every older finished turn is a span.
- **Prewarm.** After each turn ends, the extension compresses every uncached
  span that is at least `minSpanTokens` tokens, one call at a time in the
  background. Small spans never earn a call.
- **The form.** One call to the compression model: the turn serialized with
  pi's role labels, every tool result cut to head + tail (2000 characters
  total, so a failure's error line at the tail survives), and a prompt that
  keeps user instructions verbatim and quotes error strings exactly as
  shown. The form is capped at `spanCapTokens`; the request's token budget
  is the cap plus a 1024-token thinking reserve, so a thinking model can
  reason before writing the note, and the form is trimmed back to the cap
  afterwards.
- **The swap.** The next outgoing request replaces each cached span with one
  user message: a fixed lossy-view frame, then the form. The extension
  rewrites a request only when it can reconcile pi's exact message list from
  the session entries: every message must match in order, and only failed
  assistant messages (the ones pi removes from its state while retrying a
  call) may be absent. Anything else it cannot reproduce goes out
  untouched, and the check re-runs on every request.
- **Failure.** A failed compression call leaves the span raw and retries
  after the next turn, with one warning per span. A span that fails three
  calls in a row stops earning calls and stays raw for the session; changing
  the compression model resets the counter. A span whose serialized input
  does not fit the compression model's context window (input plus the cap
  plus a 1k-token margin) never earns a call.
- **Startup retry.** If the configured model is not in the registry at
  session start, compression starts off and the resolution re-runs after each
  turn. A local provider registers its models on demand, so a model that is
  still loading or asleep at start resolves later in the session. When it
  resolves, compression turns on from that turn and the failure counters
  restart.
- **Restart.** Spans already have their persisted form, so no compression is
  re-run after a restart.
- **Usage.** Each compression call is a normal LLM event: its usage is in
  the span entry and counts in the Usage report under the compression
  model.

## Command

`/compression-model [off | provider/model-id]`

- No args: shows the current model, span count, and tokens saved, then opens
  a model picker (an `off` entry disables).
- `off`: disables compression and persists it.
- `provider/model-id`: sets the model directly. A model that is missing or
  has no configured auth is rejected.

The choice persists to the project `.pi/settings.json` when that file
exists, else to the global settings file.

## Settings

The `compress` section of `settings.json`. Project `<cwd>/.pi/settings.json`
overrides global, key by key.

| Key             | Type            | Default  | Meaning                                                             |
| --------------- | --------------- | -------- | ------------------------------------------------------------------- |
| `enabled`       | `boolean`       | `true`   | Turn the extension on or off.                                       |
| `model`         | `"provider/model-id"` or `null` | `null` | The compression model. `null`: compression off.                  |
| `keepTurns`     | `number` ≥ 0    | `2`      | Recent finished turns that always go out raw.                       |
| `spanCapTokens` | `number` > 0    | `500`    | Cap for one compressed form, in tokens.                             |
| `minSpanTokens` | `number` > 0    | `1000`   | A span smaller than this never earns a compression call.            |

Example:

```json
{
  "compress": {
    "model": "anthropic/claude-haiku",
    "keepTurns": 2,
    "spanCapTokens": 500,
    "minSpanTokens": 1000
  }
}
```

A malformed value falls back to its default and is reported with one startup
notification.

## Status

While spans are compressed, the status line shows the span count and the
tokens saved, for example `compress: 3 spans, 12.4k saved`.

## How it works

- **Seam.** The decision logic lives in `core.ts`, which is engine-free and
  fully tested with an injected token estimator and serializer: given the
  turns and the cache, it produces the outgoing message list and the
  compression jobs. `serializer.ts` turns one turn into the compression
  model's input. `settings.ts` reads and writes the settings section.
  `runner.ts` runs one job through pi's model registry as a fresh
  conversation (new session ID, no cache retention). `index.ts` is the thin
  pi wiring.

## Out of scope

Recompressing a span when the compression model changes (the first form
stays), mid-conversation compaction of the keep window, and per-tool output
shrinking.
