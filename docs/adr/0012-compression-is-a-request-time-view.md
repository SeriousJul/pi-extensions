# Compression is a request-time view; the compressed form is text

The compress extension replaces finished turns that fall out of the keep
window with one short standing-in message in outgoing LLM requests. The
session file is never rewritten. The request list is re-derived every time
in the `context` hook from the session entries plus the span cache (ADR
0011's projection pattern). Each compressed form is computed once, in the
background after the turn ends, and persisted as a `compress-span` custom
session entry. A span's identity is its list of session entry IDs: it is
stable across requests, survives restarts, and a restored cache means a paid
compression is never re-run for a span that already has a form.

The compressed form is plain text, not soft tokens or a provider-native
context edit. The hosted chat APIs pi talks through (OpenAI Responses,
Anthropic Messages) give no path to hand the model a reference to the
original messages, so the standing-in message must be self-contained text
any model can read. It is one synthetic user message carrying a fixed
lossy-view frame plus the form, which keeps the prefix stable for the
provider's prompt cache.

Rejected alternatives: a compaction entry cannot hold one form per finished
turn - it replaces a whole span with one summary and rewrites what a later
request sees from that point on. Rewriting the append-only session tree to
shrink turns in place breaks fork identity and the Usage scan's
once-per-distinct-line counting (ADR 0009). A sidecar store for the forms
duplicates data the session file already can hold in a custom entry.

Cost accepted: a failed compression leaves the span raw, warns once, and
retries on the next turn end; the outgoing request until then carries the
full span.
