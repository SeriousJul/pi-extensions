# The fallback window self-heals via a one-shot re-resolution

Superseded by [ADR 0027](/adr/0027-the-live-catalog-comparison-heals-the-window)
on its trigger (the sentinel match) and its one-Attempt-per-selection budget; the
rest stands, including the post-Wake timing, the one-shot bound, and the
rejections of a static pin and a per-turn check.

The llama.cpp provider derives a model's context window from the live server.
A loaded model exposes its true `n_ctx`; an asleep model exposes nothing, and
the provider falls back to a fixed 128000. A session that resolves the model
while it is asleep pins that fallback window: pi's session holds the resolved
model object, and a catalog refresh updates only the registry, not the running
session. The session then compacts at a window up to 60 percent smaller than
the model's real one until a human re-selects the model by hand.

Llama refresh repairs this per model selection. After each agent turn, if the
active model is a llama.cpp model carrying the fallback window and this
selection has not yet spent its Attempt, the extension forces a catalog
refresh limited to the llama.cpp provider, re-resolves the model, and
re-applies it only if the window changed. The Wake happens during the first
request, so the check after the first turn sees the true `n_ctx`. One Attempt
per selection and one re-application per Attempt bound the repair by
construction.

Rejected alternatives: pinning the window in the user's models config is
deterministic and simple, but static - it goes stale whenever the server is
relaunched with a different context size and must be maintained per model,
while self-heal keeps the server as the single source of truth. Checking at
session start or before the first turn is useless: the model is still asleep
then, so the catalog still shows the fallback window and the check cannot
change anything. A per-turn check re-queries the local server on every turn of
a session whose window is already correct.

Cost accepted: the re-application appends one model change entry to the
session transcript - the cost ADR 0004 rejected for every start and every
switch. Here it fires at most once per model selection, and only when the
window actually changed. The first turn of a selection that starts asleep runs
at the fallback window; that turn is short, so its compaction risk is
negligible. A model genuinely loaded with a 128000 context is indistinguishable
from the fallback at resolution time; the Attempt re-resolves it, sees the same
value, and stays silent, so the sentinel costs nothing in that case.
