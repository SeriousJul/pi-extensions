# Output limits bounds tool results in the tool_result hook, and only downward

pi cuts every tool result at a number nobody can set. `core/tools/truncate.ts`
hardcodes 2000 lines and 50 KB, whichever lands first, and each built-in tool
applies those defaults to its own result. The tool factories
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
file content that is already on disk answers no need.

Two invariants govern the mechanism. It is one-directional: a Bound above what
pi itself published for a result is not available, because those bytes are gone
before the hook runs, and we chose not to pursue the upstream change that would
plumb `limits` into the tool options. The outer max is therefore pi's content
figure plus the slack pi's own notice adds past it, since pi truncates its
content to 50 KB and then appends its notice line: a result pi itself calls in
bounds sits a little past the figure, and an outer max set to exactly 50 KB
would re-cut it and stop being invisible while the Headroom is ample. The
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
keeps them diagnosable. The extension reads the context figure once per
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
