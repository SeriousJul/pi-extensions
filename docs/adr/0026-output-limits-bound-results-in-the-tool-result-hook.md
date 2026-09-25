# Output limits bounds tool results in the tool_result hook, and only downward

pi cuts every tool result at a number nobody can set. `core/tools/truncate.ts`
hardcodes 2000 lines and 50 KB, whichever lands first, and each built-in tool
applies those defaults to its own result -- though not the same ones: `bash` and
`read` pass both figures to the cutter, while `grep`, `find`, and `ls` pass
`maxLines: Number.MAX_SAFE_INTEGER` and let only the byte figure bind, because
their own match, result, and entry limits already cap the rows. The tool
factories
(`createReadTool`, `createBashTool`, `createGrepTool`, `createFindTool`,
`createLsTool`) accept `operations`, `commandPrefix`, `shellPath`, `spawnHook`,
and image options, but no `limits`, and pi has no setting for output size. The
limit is also per call, with no view of the window: pi's own guard is a check
of the projected context that runs only after a finished tool batch is already
appended. So an assistant message that asks for four parallel calls can add
about 50k tokens in one step, which crosses pi's compaction threshold and
forces a lossy summary, and crosses the window outright when pi's chars/4
estimate undershoots the provider tokenizer. That estimate under-counts
multi-byte text by three to four times, because `text.length` counts UTF-16
units, and code by about 18 percent.

We bound results in the `tool_result` hook, and we only ever bound them
downward. The hook fires after the tool's own cut, so the whole pi-sized text
is in hand at that moment, and pi persists whatever the hook returns: the
runner takes `hookResult?.content ?? result.content`, normalizes images, then
emits the final tool result message. The Bound is
`clamp(shareOfHeadroom * Headroom, minOutputBytes, maxOutputTokens)`, measured
in tokens from UTF-8 bytes through pi's chars/4 estimate times the Inflation
factor, the same correction the Safe branch summary applies to that estimate.
Headroom reads the Effective window, so the llama refresh heal and the Context
window cap clamp are already in it. One assistant message's calls share the
Bound: the extension counts the `toolCall` blocks of the current assistant
message (pi guarantees `ctx.sessionManager` is synchronized through it) and
tracks what it has admitted in the Ledger, because the usage pi reports cannot
include a sibling that has not finished. Five tools are in scope, named in a
settings list, with pi's own cut direction per tool: tail for bash, head for
read, grep, find, and ls. An error result keeps its tail whoever produced it,
which is decision 18 and the one exception to that per-tool rule: the line that
says why something failed sits at the end, so the visible case is a failing
`grep`. read is bounded without a Spill, because pi's notice
already names the file and the offset to continue from, and a second copy of
file content that is already on disk answers no need. That is also why the
notice is never merely removed: for read that line is the recovery mechanism
itself, so a result whose body survived with no pointer is the one outcome where
this extension could lose text outright. When a read result fits inside its
Bound once pi's own notice line is set aside, nothing was dropped, pi's offset is
still the true one, and the extension publishes nothing: pi's text stands whole,
notice included. The admitted cost there is at most pi's own notice past the
Bound, which is the same allowance the outer max already carries for it, and the
Ledger is charged the size that really went into the session.

Two invariants govern the mechanism. It is one-directional, and the rule covers
both units at once: no Bound, in bytes or in lines, rises above what pi itself
published for a result. Those bytes are gone before the hook runs, and we chose
not to pursue the upstream change that would plumb `limits` into the tool
options. And because pi truncates its content to its byte figure AND its line
figure before it appends its own notice, the outer max carries an allowance in
each unit rather than in bytes alone: pi's content figure, plus the bytes and the
two lines that notice costs. The line half of that is per tool, because pi's
line figure is. `bash` and `read` hand their cutter DEFAULT_MAX_LINES, while
`grep`, `find`, and `ls` hand it `Number.MAX_SAFE_INTEGER`, because their match,
result, and entry limits already
cap the rows and only the byte figure is left to bind. One global 2000-line
ceiling was therefore stricter than pi on three of the five tools for a reason
unrelated to the context window, which is the same inversion an outer max set to
exactly 50 KB produced on the byte axis: in a session with the window nearly open
it re-cut a result pi had already blessed, spilled it, and announced a cap
nothing needed. Both halves are answered the same way. A `maxLines` the user
names is a deliberate ceiling and binds every bounded tool; the default mirrors
pi per tool, and no line ceiling is enforced where pi enforces none. The
invariant holds at the boundary that matters, which is pi's published result,
not pi's internal constant. It is lossless or it does not cut: when a Spill
write fails, the extension leaves pi's result alone, reports once per session,
and still records
the real admitted size, so a disk-full run costs context instead of losing
text. Where pi already wrote its own throwaway for a cut bash result, the
extension moves that file into the Spill directory and adopts it as the Spill,
so one call has one file and the copy holds everything, including the part pi
dropped. Nothing is appended to it: pi's log is a superset of the text the hook
received, so copying that text in again would double the file to state nothing
new. The move is a rename when the two directories share a device and a copy
when they do not, which is the ordinary case on Linux, where `/tmp` is its own
filesystem and the Spill root sits beside the sessions; a device boundary that
the rename alone could not cross would otherwise fail the one thing the ticket
asked for. Because that move takes the file pi's own notice points at, the
extension rewrites the path pi named to the Spill that now holds the bytes, and
charges those bytes to the Bound: one result leaves exactly one live path in
front of the model. There is no reader tool for a Spill: the agent has bash, and
`rg` over one bounded file is the case that matters.

Rejected alternatives. Overriding the six tools by registering their names, so
the Bound works in both directions and the capture is native: it forks pi's
tool logic, including the eight result shapes the UI and session code depend
on, to buy a raise nobody asked for, since the driver was a large file crushing
the window near the threshold. Waiting on an upstream fix: the correct fix is a
pre-request budget for tool results, which is pi's decision to make and not
worth blocking a mitigation on. Folding this into Pruning: Pruning is a
request-time projection that never writes, and this is an execution-time policy
that changes what gets stored. Different trigger, different owner, and Pruning
has no reason to learn about file retention. Reusing the Recall tool for
recovery: Recall resolves a session entry, and the cut text never enters the
session file. A reader tool of our own: it costs a permanent schema in every
session to do what bash already does. Pressure gating on the model of Pruning's
Engagement: with `maxOutputTokens` set to pi's own figure, always-on produces
the same result as a sticky engaged state, and it needs no reset rule and no
cache-shape argument to maintain.

Costs accepted. The session file no longer holds full tool outputs, so Recall
cannot reach past a Bound and Pruning's glossary entry had to lose the
sentence that promised it. Images count against the Bound but cannot be cut,
because pi normalizes them after the hook, so a batch of image reads squeezes a
sibling's text down to the floor. Error results are bounded too, since a failed
test's stack trace is often the largest thing in a turn, and the floor is what
keeps them diagnosable. Headroom subtracts pi's `compaction.reserveTokens`, read
the way pi resolves it, a current-model `modelOverrides` entry included, and it
accepts a reserve of 0 because pi does: a reader that demanded a positive number
would overstate the usage side of every Bound by the reserve it refused to
believe. The extension reads the context figure once per
assistant message rather than once per call, and invalidates that baseline on
compaction, model switch, and tree navigation, because each changes the
projection. A blind call writes no baseline at all, because the outer max is a
clamp and not an allowance: freezing a batch on it would let every later sibling
of the message reach the whole window, so the batch takes its baseline from the
first call that can read a Headroom and keeps what the blind ones already
admitted. When the call count does not read, the siblings still share one batch
key, taken from the newest assistant entry in the branch, because with no count
each call may reach the whole remainder and the accumulation is the only thing
bounding them. No system prompt line advertises the Bound: pi's per-result notice
stays true and the extension's own notice names the real number for that call.
The Admitted text carries the extension's notice and its pointer lines, so
those bytes are reserved out of the Bound before the cut runs rather than added
after it: the Bound is what the model receives, notices included, and a budget
that covered only the result text would over-admit by the size of its own
announcement.
