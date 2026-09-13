# model-router

Recovers a pi session from a provider usage-limit (quota) halt without the
user re-running the prompt. When the active model's provider reports a
terminal usage-limit error and pi's own retries give up, the router runs the
configured strategies in order: switch to a fallback model, or wait for the
quota window to reset. When the session runs again, the halted turn resumes
through one synthetic user message.

Works from any session. It reads the OpenAI ChatGPT plan's quota windows
through the Quota source module (`extensions/quota/source.ts`, issue #28),
which owns the ChatGPT token refresh (ADR 0005).

## Behavior

- **Quota halt detection.** After a turn settles with an error, the router
  classifies the assistant message's error text. Only terminal usage-limit
  shapes start a Recovery; transient throttles and overloads stay with pi's
  built-in retry.
- **Strategies, in Precedence order.** `switch` moves the session to the first
  usable fallback model. `wait` arms a timer for the binding reset (the latest
  reset among the exhausted windows) and resumes when it confirms the quota is
  back.
- **Bound.** At most three full strategy cycles per failed prompt, then one
  error notification and a clean stop. A fallback that fails with its own
  usage limit advances the chain.
- **Switch-back.** While on a fallback the router set, the router switches back
  to the original model once the quota recovers and the session is idle.
- **Cancel.** User input cancels a pending wait. A manual model change cancels
  both the pending wait and the pending switch-back.
- **Restart.** A pending recovery is persisted in the session and re-armed on
  the next start, so waiting does not depend on the terminal staying open.

## Settings

The `modelRouter` section of `settings.json`. Project
`<cwd>/.pi/settings.json` overrides global, key by key.

| Key              | Type                         | Default             | Meaning                                                       |
| ---------------- | ---------------------------- | ------------------- | ------------------------------------------------------------- |
| `enabled`        | `boolean`                    | `true`              | Turn the router on or off.                                    |
| `precedence`     | `("switch" \| "wait")[]`     | `["switch","wait"]` | Strategy order on a halt.                                     |
| `fallbacks`      | `"provider/model-id"[]`      | `[]`                | Ordered fallbacks the switch strategy tries.                  |
| `maxWaitMinutes` | `number` greater than 0      | `360`               | Only wait when the binding reset is within this many minutes. |

Example:

```json
{
  "modelRouter": {
    "precedence": ["switch", "wait"],
    "fallbacks": ["anthropic/claude-sonnet-4-5", "google/gemini-3.5-flash"],
    "maxWaitMinutes": 360
  }
}
```

A malformed value falls back to its default and is reported with one startup
notification. A fallback entry whose model is missing or has no configured auth
is skipped; if none are usable the router moves to the next strategy.

## How it works

- **Resume.** pi has no re-run-the-failed-turn API, so the router resumes the
  halted turn with one fixed user message (ADR 0006). That message is the only
  visible trace of a recovery.
- **Token refresh.** The Quota source refreshes an expired ChatGPT access token
  before reading, retries once after a 401, and otherwise reports the read
  failure. The router treats an unreadable quota as "wait not viable".
- **Seam.** The decision logic lives in `router.ts`, which is engine-free and
  fully tested with injected quota reads, clock, timers, model lookups, and an
  action sink. `index.ts` is the thin pi wiring.

## Notifications

Exactly four recovery-transition points, plus one per skipped-fallback summary:

1. Wait starts, with the ETA.
2. Switch to a fallback.
3. Switch back to the original.
4. Recovery gave up (error level).

## Out of scope

Transient throttles and overloads (pi's own retry), context overflow, and
non-ChatGPT quota plans (the Quota source covers the ChatGPT plan in v1).
