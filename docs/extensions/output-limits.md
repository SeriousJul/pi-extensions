# output-limits extension

Bounds the size of a tool result before pi writes it into the session, and
keeps the whole result in a **Spill** file. The ceiling, the **Bound**, is
computed per call from the session's **Headroom**, so a session close to its
context window stops swallowing 50KB tool outputs, while a session with plenty
of room sees no change ([ADR 0026](/adr/0026-output-limits-bound-results-in-the-tool-result-hook)).

pi cuts every tool result at a number nobody can set: 2000 lines or 50KB,
whichever lands first. That cut is a hard failure risk, because pi's own guard
is a projection check that runs *after* the finished tool batch is appended,
and parallel tool execution means one assistant message asking for four calls
can add roughly 50k tokens in a single step. It is also lossy for four of the
five text tools, and the loss is unreachable at read time, because pi's prompt
cache needs a stable prefix. So the size has to be controlled as the result is
produced. This extension does that, and only ever bounds downward.

## Behavior

- **Bound.** `clamp(shareOfHeadroom x Headroom, minOutputBytes, maxOutputTokens)`,
  named in tokens and enforced in bytes. It is a per-call figure, and it never
  rises above what pi itself published for a result: the hook runs after pi's
  cut, so the larger bytes are not in hand, and a raise is not what this is for.
  The outer max is set so that a result pi called in bounds is left exactly as
  pi produced it, which is pi's own content figure plus the slack pi's notice
  line adds past it.
- **Headroom.** The **Effective window** minus pi's `compaction.reserveTokens`
  minus the usage pi reports. The Effective window already carries the llama
  refresh heal and the Context window cap clamp, so all three extensions
  compose for free. Headroom reads pi's values; it never sets them.
- **Token math.** The extension's own conservative conversion,
  `ceil(bytes x inflation / bytesPerChar)`. This is pi's chars/4 estimate times
  the Inflation factor, and it is the correction that catches CJK, where pi's
  estimate runs three to four times low because `text.length` counts UTF-16
  units.
- **Per batch, not per call.** The calls one assistant message requested are
  counted and the allowance is divided among them, with the **Ledger** tracking
  what has already been admitted for that message, because the usage pi reports
  cannot include a sibling that has not finished. A call that needs less than
  its share leaves the difference for the calls that come after it. When the
  count does not read cleanly, the siblings still share one batch, so the
  accumulation is what bounds them.
- **Spill.** The complete result goes to a file under the agent dir, with
  retention and a sweep at session start. bash, grep, find, and ls spill. read
  does not: its source is already a file, so its Bound cuts and rewrites pi's
  own `Use offset=N to continue` notice to the smaller cut.
- **Fidelity, stated exactly.** The Spill holds everything the hook received,
  which is not always everything the tool produced. For bash the hook receives
  `details.fullOutputPath`, pi's log of the command's whole output, so the
  Spill holds the whole output: pi's throwaway is moved into the Spill
  directory rather than left behind, and one call has one complete file. The
  move crosses a device boundary by copy when a rename cannot, which is the
  ordinary case: `/tmp` is its own filesystem and the Spill root sits beside the
  sessions. For
  grep, find, and ls pi has already dropped the tail past its own 50KB before
  the hook runs, so their Spill holds pi's result and the user's loss becomes
  one cut preserved in a file instead of two cuts that are not.
- **One live path.** A capped result names one file, and that file exists. When
  this extension moves pi's log into the Spill, the path pi wrote inside its own
  notice is rewritten to the Spill that holds those bytes now, so the model is
  never sent to read a moved file. The rewrite is charged to the Bound, like
  every other byte the model receives.
- **Blind.** When `ctx.getContextUsage()` returns nothing, which happens with
  no resolved window and right after a compaction that has no usage yet, the
  Bound is `maxOutputTokens` and nothing is cut: a blind call behaves exactly
  like pi today. A blind call opens no batch baseline either. The outer max is a
  clamp, not an allowance, so the batch takes its figures from the first call
  that can read a Headroom, and what the blind calls passed through still counts
  against it.
- **Images and errors.** Image blocks are charged against the Bound and never
  cut, because pi normalizes images after the hook. Error results are bounded
  too, and an error keeps its tail whoever produced it, because the line that
  says why something failed sits at the end and a failed test's stack trace is
  often the largest thing in a turn.
- **Lossless or no cut.** If a Spill write fails, the extension leaves pi's
  result alone, records the size that really went in, and says so once per
  session. A disk-full run costs context instead of losing text.

## What you see

The model's view of a capped result keeps pi's own notice, with the path it
names repointed at the Spill, and adds one line with the real numbers:

```
[Showing lines 1-148 of 4000 (50.0KB limit). Full output:
~/.pi/agent/output-limits/<session-id>/4-bash-c1d2e3f4.log]

[output-limits: capped to 8KB (4.1k tokens) of the 16k token headroom left for
this message (3 calls); full output:
~/.pi/agent/output-limits/<session-id>/4-bash-c1d2e3f4.log]
```

One result, one path, and the file is there. When pi's log for a bash cut is
moved into the Spill, the path pi named would otherwise lead to a file that no
longer exists, so it is rewritten to the file that now holds those bytes.

For read, the second half is pi's continuation instead, rewritten to the
smaller cut:

```
[output-limits: capped to 8KB (4.1k tokens) of the 16k token headroom; use
offset=412 to continue]
```

`details.truncation.maxBytes` and `maxLines` are patched to the real values, so
pi's built-in renderer reports the extension's Bound rather than pi's default,
and bash's `details.fullOutputPath` points at the extension's file. There is no
reader tool: the agent has bash, and `rg` over one bounded file is the case that
matters.

No tool description is rewritten and no system prompt line is added. The Bound's
value depends on live Headroom, so a static prompt sentence would state a number
that is false on most calls.

## Settings

The `outputLimits` section of the settings files. The project
`<cwd>/.pi/settings.json` overrides the global `$PI_CODING_AGENT_DIR/settings.json`,
key by key. A malformed value falls back to its default and is reported in a
notification; it never throws. The section is read once per session and re-read
on reload.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the extension on or off. |
| `maxOutputTokens` | pi's own 50KB content cut plus the slack its notice adds past it, in tokens | The outer max. Always on, and still invisible until Headroom gets tight. |
| `maxLines` | `2000` | The line max, matching pi. |
| `inflation` | `2.0` | The factor on pi's chars/4 estimate, matching the Safe branch summary. |
| `bytesPerChar` | `4` | pi's own `CHARS_PER_TOKEN`. |
| `shareOfHeadroom` | `0.25` | The share of the Headroom one assistant message may spend. |
| `minOutputBytes` | `4096` | The per-call floor. A call is never cut below it. |
| `tools` | `bash, read, grep, find, ls` | The tools this extension bounds. |
| `spill.maxTotalBytes` | `512MB` | The Spill footprint the session-start sweep enforces. |
| `spill.maxAgeDays` | `7` | The Spill age the session-start sweep enforces. |

`compaction.reserveTokens` stays pi's own setting, read here and never written.
The extension does not touch pi's compaction threshold or `keepRecentTokens`.

Spill files live in `~/.pi/agent/output-limits/<session-id>/`, beside the
sessions, because the agent dir is already private. Files are mode 0600 in a
directory at 0700, and named `<seq>-<tool>-<callid8>.log`. The sweep governs
this directory only: pi's own `/tmp/pi-bash-*.log` files, left by calls this
extension never touched, are not its business.

### Escape hatch

`PI_OUTPUT_LIMITS=off` turns the extension off regardless of both settings
files. It wins over them, because an escape hatch a stale project setting could
undo is not one.

## Command

`/output-limits status|settings|off|on`

- `status` (also the bare form): the active Bound inputs and the Spill
  directory footprint. It does not enumerate Spill files for the model; that is
  what bash is for.
- `settings [key=value ...]`: shows the keys, or writes the named ones and
  persists them to the project settings file when one exists, else the global
  file. Every other setting is preserved.
- `off` / `on`: writes `enabled` and reloads the session state.

## How it composes

The Bound is computed from what pi is about to store, so the extension changes
the input to both other levels of context control rather than competing with
them. Pruning and Compression are request-time projections and never rewrite
the session file, so a tool result that is too large can only be bounded as it
is produced. What the Bound leaves out of the session is out of Recall's reach
too: Recall resolves a session entry, and the cut text lives in the Spill
instead.

## Tests

- `tests/output-limits/core.test.ts` - the pure Headroom, Bound, and cut math.
- `tests/output-limits/ledger.test.ts` - the per-message batch bookkeeping.
- `tests/output-limits/settings.test.ts` - the merge, the fallbacks, and the
  reports.
- `tests/output-limits/wiring.test.ts` - the real extension against a fake
  `ExtensionAPI`, a real `SessionManager`, and a fake `ExtensionContext`: the
  Bound, the Ledger, the cut, the Spill, the `details` patch, and the
  pass-through rules.
- `npm run e2e:output-limits` - a real `pi` process in RPC mode with a scripted
  provider, driving real `bash`, `read`, and `grep` calls. This is the seam that
  proves the session file holds the capped text and the Spill holds the rest.
  One of its runs puts the agent dir on the home filesystem, which is a
  different device from the `/tmp` pi logs bash spills to, so the move that
  cannot be a rename is proved to be a copy.
