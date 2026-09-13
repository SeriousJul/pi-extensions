# Model router resumes a quota-halted turn with a synthetic user message

pi has no extension API to re-run a failed turn: the only way an extension can
start agent work again is `pi.sendUserMessage()`, which appends a real user
message to the transcript. The Model router therefore sends one fixed Recovery
message after a wait or a model switch, telling the model that the previous
turn was cut off by a usage limit and to resume the task.

Rejected alternatives: provider-level retry, because pi's own settings docs
warn it can block the agent until the quota resets; manual re-trigger, because
it defeats the unattended workflow the router exists for; and waiting on an
upstream retry-turn API, which does not exist today. One visible user message
per recovery in the transcript is the accepted cost.
