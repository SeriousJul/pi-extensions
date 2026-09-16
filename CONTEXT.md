# Pi Extensions

Extensions for the pi coding agent. Five today: Codegraph (semantic code
search over the current project), Quota (subscription quota monitor), Model
router (automatic recovery from quota exhaustion), Sync (device file
sync), and Usage (token and cost reporting across all sessions). The
package also ships a Skill tree, kept in step with upstream repos by the
skill sync script.

## Language

### Codegraph

**Index**:
The `.codegraph/` directory and its `codegraph.db` for one project root.
Disposable and rebuildable. Never a source of truth for file content.
_Avoid_: graph database, cache (too generic)

**Index adapter**:
The one module that names the codegraph library's instance API, types,
or schema. The session and the renderers call its operations and never see
the library's shape. A second in-memory adapter sits at the same seam, so
the state machine tests in milliseconds without the native library.
_Avoid_: wrapper (too generic), client (implies a remote service)

**Project root**:
The directory that holds an index. For a git worktree, this is the worktree
itself, not the main checkout.
_Avoid_: repo root, workspace

**Session root**:
The project root the session's own working directory resolves to. One per
session. Every other root a call is served from is a Named root.
_Avoid_: workspace, current project, main root

**Dependency source**:
The source tree of one version of one dependency, fetched into a cache outside
the Session root. Read-only in practice: nothing the agent does edits it.
Its index lives inside it, so removing the cache removes the index.
_Avoid_: external project (implies a project you edit), third-party code,
vendored code, opensrc project (names a tool, not the concept)

**Named root**:
A project root a call names itself, instead of the one the working directory
chose. Served like any other root, and always labeled in its results, so a
symbol can never be mistaken for one from the Session root.
_Avoid_: external root (says where it lives, not what it is), guest root,
projectPath (upstream's word for the same parameter)

**Trusted root**:
A directory the extension may build an index in without asking first: the
source cache home, plus any root the user adds for the session or by an
environment variable. The bound gates building only. An index that already
exists is served wherever it lives.
_Avoid_: allowlist (generic), source root, cache root (a Trusted root need not
be a cache), safe root (unsafe has a different meaning here: home and the
filesystem root)

**Anchor**:
The directory a call's root resolution starts from: the call's working
directory, or the location of the named file when the tool reads a file
(`codegraph_node` file mode). A `file` argument used only to disambiguate a
symbol never moves the anchor. The root-relative form of an anchored file is
decided once, together with the root.
_Avoid_: base, cwd, anchor file (the anchor is a directory, not the file)

**Sibling worktree**:
Another git worktree of the same repository, identified by a shared common
git dir. Includes worktrees created by herdr under `~/.herdr/worktrees/` and
PR checkouts under `/tmp/`.
_Avoid_: clone (a clone is a different repository, not a sibling), branch

**Seed**:
Copy a sibling worktree's index DB into a new worktree's index before the
first reconcile. Makes a new worktree usable without a full rebuild.
_Avoid_: clone the index, sync (sync is not copying between worktrees)

**Reconcile**:
One sync pass over a worktree that verifies every file against the index and
re-extracts only the changed set. Runs after every seed and on first use.
_Avoid_: rebuild (a rebuild starts from an empty index), refresh

**Borrowed index**:
A query that resolves to a different worktree's index, so results reflect
another branch. The state this extension must never serve silently.
Term adopted from upstream codegraph.
_Avoid_: stale index (stale means old content in the same worktree; that is a
different failure)

**Prewarm**:
Background creation of a worktree's index, started on the first agent turn of
a session when the worktree has no index yet. Makes the first tool call and
the first prompt note both find a nearly-ready index. Attempted once per root
per session. A tool call that arrives mid-prewarm waits for it and then takes
its own path, so a prewarm failure never becomes a tool result.
_Avoid_: prebuild (implies the index is finished before the session starts),
warmup (too generic)

**Prompt note**:
The one codegraph block the extension appends to the system prompt on an agent
turn: a first line stating the index state, then the fixed policy lines saying
which tool fits which job. It appears only when a codegraph call can be served
from the working directory, so it never promises what a call cannot deliver.
_Avoid_: system prompt injection (generic), steering text (the note is the only
one, so the shorter name is unambiguous)

**Usage log**:
The `.codegraph/usage.jsonl` file: one line per codegraph tool call, with
time, tool, outcome, duration, and result size. Lives and dies with the
index. A record of a call that failed before an index existed still creates the
index directory, which then carries codegraph's own ignore rule so git never
stages the log. Never leaves the machine.
_Avoid_: telemetry (implies data leaves the machine), metrics (metrics are
aggregates; this is an event log)

**Source section**:
The one structured block a renderer may serve as the source of a file at
its indexed line ranges: a numbered slice of the current bytes (fresh
file), the numbered full current source (small drifted file), an omission
(large drifted file), or a missing-file decision (file gone). The renderers
own wording and layout only; the drift gate, the whole-file caps, and the
short-TTL memo live with the section, so a new source renderer inherits the
never-a-drifted-slice guarantee by construction.
_Avoid_: code block, snippet, file view

**Context window cap**:
The per-session ceiling on a model's context window, set by the user. Every behavior that reads the window (compaction timing, overflow detection, usage display) acts as if the window were the smaller of the cap and the model's declared window. It only shrinks a window, never grows one.
_Avoid_: context limit (ambiguous with the window itself), max context, window shrink

**Project label**:
The one line above a result from a Named root: the project's name and version,
and the absolute path of its root. It makes a wrong version visible instead of
trying to detect one, and it gives the agent the path to hand to its next read
or grep.
_Avoid_: header (the file headers stay root-relative and unchanged), banner,
project line

### Initial context

**Initial context**:
The context resent to the model on every LLM call: the system prompt and the
tool definitions. Everything else (user messages, tool results, assistant
replies) is the session context, which grows with the conversation.
_Avoid_: system prompt (only one part), base prompt, fixed context

**Prompt injection**:
Text another extension appends to the system prompt via
`before_agent_start`. It is distinguished from a modified prompt, where the
extension replaced or rewrote the prompt and no suffix can be detected.
_Avoid_: prompt modification (too generic), suffix

**Provider reference**:
The input tokens the provider reported on the first assistant message of the
session. Display only: the bars and percentages stay on the estimator's
character scale, so the reference stays comparable with the rows.
_Avoid_: true token count, ground truth, correction

### Quota

**Quota window**:
One rolling usage budget reported by a subscription plan: a used fraction and
a reset time. The OpenAI ChatGPT plan reports two: the 5-hour window and the
weekly window.
_Avoid_: rate limit (a request-rate ceiling, not a budget), bucket, period

**Usage snapshot**:
The latest successful read of a plan's quota windows, stamped with the time it
was fetched. It becomes stale the moment a later read fails; a stale snapshot
is still shown, marked, rather than hidden.
_Avoid_: cache (too generic), state, sample

**Quota source**:
One subscription plan the Quota extension reads windows from. Examples: the
OpenAI ChatGPT plan, the Qwen token plan.
_Avoid_: provider (pi's word for a model API), backend, account

### Model router

**Quota halt**:
The state in which the active model's provider reported a terminal usage
limit error and pi's own retries gave up on the turn. The event that starts a
Recovery.
_Avoid_: rate limit (also covers recoverable non-terminal throttling),
quota error (generic)

**Recovery**:
The router's automated response to a Quota halt: run strategies in
Precedence order until the session runs again or the chain is exhausted.
_Avoid_: retry (pi's built-in backoff; recovery is what happens when retrying
is not possible), fallback (too narrow: one strategy), failover (implies the
original model is abandoned)

**Recovery strategy**:
One step of a Recovery. v1 has exactly two: switch to a Fallback model, and
wait for the quota to reset.
_Avoid_: mode, plan (clashes with subscription plan), step

**Precedence**:
The configured ordered list of Recovery strategies to run on a Quota halt.
_Avoid_: priority (ambiguous: a high/low scalar instead of an ordered list),
order (too generic)

**Fallback model**:
One entry (provider and model) of the configured ordered list that the
router tries in sequence during the switch strategy.
_Avoid_: backup (implies it only holds state), secondary (implies a fixed
pair)

**Switch-back**:
The router returning the session to its original model after the quota
windows recovered. A manual model change cancels the pending switch-back.
_Avoid_: restore (clashes with session restore), revert (too generic),
roll back

**Pending recovery**:
A Recovery that started but did not finish, recorded in the session so a
restart can re-arm it.
_Avoid_: recovery state (state is a general word), saved recovery

**Binding reset**:
The latest reset time among the exhausted Quota windows. The earliest moment
waiting can pay off.
_Avoid_: reset time (ambiguous: there are several windows), quota reset (does
not say it is the maximum across windows)

**Recovery message**:
The one synthetic user message the router sends to resume the halted turn.
_Avoid_: resume prompt, continuation (generic), retry message (a retry is a
different concept)

### Resource toggle

**Resource**:
One unit pi loads from disk: an extension, a skill, a prompt template, or a theme. A resource has a location, a scope (global or project), and a Toggle state.
_Avoid_: plugin (pi's word is extension), feature, component

**Top-level resource**:
A resource loaded from an auto-discovered location or a settings array entry, instead of one bundled in a package. The toggle writes the state of a top-level resource; a package resource is display-only in v1.
_Avoid_: local resource, installed resource

**Override pattern**:
An entry in a settings resource array that starts with `+`, `-`, or `!`. `+path` force-includes a resource, `-path` force-excludes it, and `!pattern` excludes by glob. Pi applies them during resource resolution, so a disabled resource is fully unloaded: no factory run, no tools, no commands, no prompt entry.
_Avoid_: flag (a flag is a boolean setting), toggle bit, exclude rule

**Toggle state**:
The effective state of one resource: enabled, disabled, or a project override of inherit, load, or unload over the global state. Derived from the override patterns in the settings files, never stored as a separate field.
_Avoid_: enabled flag (only two of the states), on/off (hides the override layer)

**Shadow entry**:
A plain path plus a `+` or `-` pattern for the same path, written together into the project settings. It re-registers a global resource at project scope, where it wins over the global copy, so the project decides the resource's state without touching the global file.
_Avoid_: alias (implies the path stays one resource), per-project copy, override rule

### Sync

**Sync wizard**:
The guided first run that makes a device useful: secure a Gist-only token, then create the shared tree or join an existing one, preview the local changes, confirm them, and report. Re-running it with no id on a joined device is always a plain error. Re-running it with a gist id on a joined device re-joins the tree behind the preview confirm; --force skips only that confirm.
_Avoid_: setup (generic), install, first run

**Pairing**:
Joining a device to a shared tree that already exists: the device fetches the tree, the user confirms what arrives, and the device records which tree it belongs to. Its counterpart is the first device creating the tree. "Join" is the verb for the act; "pairing" is the noun.
_Avoid_: attach, link

**Gist-only token**:
The device-local GitHub credential the Gist Backend uses, limited to creating and updating gists. The tool issues it, renews it while it lives, and re-issues it when it dies. A token the user writes by hand is respected but never managed.
_Avoid_: PAT (a GitHub type, not this role), gist credential, API token

**Sync manifest**:
The config that names the sync Backend and the include and exclude
patterns for which files sync. Default deny: only files an include pattern
matches are in scope, and an exclude pattern wins over an include. The
manifest is itself part of the Snapshot, so one copy serves every device.
_Avoid_: config (too generic), include list (only half of it), sync config

**Snapshot**:
The full set of files one sync run moves, selected by the Sync manifest.
An empty file is absent from the Snapshot: the shared tree carries no
empty files, and truncating a file to empty reads as a deletion.
_Avoid_: backup (a backup exists to restore after loss), export, bundle

**Backend**:
The pluggable storage target a Snapshot is fetched from and pushed to.
v1 is a GitHub Gist.
_Avoid_: provider (pi's word for a model API), remote (implies a network
peer), store (too generic)

**Base state**:
The tool-managed record of a synced tree: per-file modification time
and content hash. It is the "before" side of every three-way merge. It
exists in two copies: each device caches the Base of its last sync
(owner-only, in the state directory) and merges against that cache, so a
stale device never reads quiet files as both-sides changes; the newest
shared Base lives in the Backend and advances with every push. A device
that lost its cache falls back to the shared Base.
_Avoid_: metadata (generic), manifest (clashes with Sync manifest), state
(too generic)

### Skill tree

**Skill tree**:
The package's `skills/` directory, laid out as
`skills/<source-slug>/<upstream bucket>/<name>` for tracked skills and
`skills/local/<name>` for Local-only skills. The layout mirrors each
upstream repo, so a tracked skill's upstream path is read off its local
path.
_Avoid_: pool (generic), skillset, bundle (a bundle is a pi package)

**Skill source**:
One upstream git repo whose skills are tracked: a repo URL, a local root
in the Skill tree, and one Source pin. Matt Pocock's skills repo is the
only source today.
_Avoid_: provider (names the vendor, not the tracked unit), upstream
(too generic), feed

**Source pin**:
The last upstream commit at which every tracked skill of one source is
in agreement with the local copy. A skill sync advances it only when it
completes with no unresolved conflict, so the pin always names a commit
where the whole tree merged. It is the merge base of the next sync.
_Avoid_: tag, version, sync stamp, base state (the Sync extension's per-file
record; the pin is one commit per source)

**Skill sync**:
One run of the update over one source: fetch upstream, three-way merge
every tracked skill (base = the Source pin, theirs = the fetched commit,
ours = the local copy), apply clean merges, report conflicts with marked
hunks, and advance the pin when everything is clean or finalized.
_Avoid_: pull (git's one-way word), refresh (too generic), update (the user's
word for the whole chore, not one pass)

**Adopt**:
Taking a new upstream skill into the Skill tree by the user's choice.
A skill sync reports new upstream skills but never adopts one on its own.
_Avoid_: install (the package word), import, subscribe

**Local-only skill**:
A skill under `skills/local/` with no Skill source. A skill sync never
reads, merges, or reports it.
_Avoid_: private skill, homegrown (implies authorship, not tracking state)

**Upstream orphan**:
A tracked skill that upstream deleted or renamed: present locally, absent
at its upstream path. Its pin holds, the skill keeps working, and every
skill sync reports it until the user deletes it or accepts the rename.
_Avoid_: stale skill (stale is a content word, this is a presence word),
dangling skill, ghost

### Usage

**Usage event**:
One LLM call's recorded usage in a session file: the token counts, cost,
provider, model, and time of a single assistant reply, a tool's nested LLM
work, a compaction summary, or a compression call.
_Avoid_: request (implies network), sample, token count (that is one field)

**Usage scan**:
One pass over every session file that extracts every Usage event exactly
once. A forked session copies its parent's history byte-identical, so an
event is counted by its full line and a fork never double-counts its
parent's past.
_Avoid_: indexer (implies stored state), crawl, telemetry

**Canonical identity**:
The (provider, model) pair after the alias rules: spelling variants of one
provider merge to one name, and a model ID is folded (lowercased, quantization
suffix dropped, `-GGUF` infix dropped). A name no rule touches stays raw.
_Avoid_: normalization (generic), dedup (the scan's job), account (a Quota word)

**Usage report**:
A bucketed, grouped view of LLM token and cost usage across all sessions:
one row per time bucket and Canonical identity, with the token columns, cost,
and a grand total. Derived on demand by a Usage scan; never stored.
_Avoid_: usage log (codegraph's per-call log), usage snapshot (Quota's plan
read), metrics (implies stored aggregates)

### Pruning

**Pruning**:
The first level of the two-level context control: replacing large tool
outputs in the request context with short references. Applied per request on
the message list, re-derived every turn, and never written to the session
file. The session file always keeps the full outputs.
_Avoid_: compaction (that is the second level, pi's native summarization),
offloading (implies the content moves to another store), truncation
(implies the content is lost)

**Recall reference**:
The pointer a pruned output carries: the line number of the entry in the
session file, resolved by the recall tool back to the full output. When no
session file exists, the reference is the entry id instead.
_Avoid_: link (implies a URL or file path), citation, pointer (too generic)

**Recall**:
The tool that resolves a Recall reference to the full text of one pruned
tool output. Direct lookup by session file line number or entry id, not
search.
_Avoid_: search (implies ranking), retrieval (too generic), drill-down
(blackhole's word for its richer tool)

**Prune gate**:
The decision made when pi is about to compact: estimate the context size
after pruning. Pruning wins, and the compaction is cancelled, only when the
estimate falls to at most the context window minus twice the reserve. Any
other outcome lets pi's native compaction run.
_Avoid_: threshold check (that is pi's own single-level check), two-stage
compact (the levels are pruning and compaction, not two compactions)

### Compression

**Compression model**:
The auxiliary model that writes the compressed form of a compression span.
It is a separate choice from the active model, so a small cheap model can
serve a large expensive one.
_Avoid_: reference model (in the prompt-compression literature the reference
model is the LLM that receives the compressed prompt), backup model,
summarizer (compaction summarizes into the session; this writes outside it)

**Compression span**:
A finished turn that has fallen out of the keep window. Outgoing requests
carry the span's compressed form instead of the original messages. The
session keeps the originals, so the compression is reversible at any time.
_Avoid_: compaction (compaction rewrites the session, compression never does),
window, summary

**Keep window**:
The recent finished turns that outgoing requests carry as-is, plus the turn
in progress. A turn that leaves the window becomes a compression span.
_Avoid_: recent context, raw tail, tail

**Compressed form**:
The short text a compression span carries in outgoing requests in place of
its original messages. The compression model writes it once, and every later
request reuses the same text, so the prefix stays stable for the provider's
cache. User instructions inside the span appear in it verbatim.
_Avoid_: summary (a summary is what compaction writes into the session), gist
(gist tokens are the research form of soft-prompt compression; this works in
text), digest
