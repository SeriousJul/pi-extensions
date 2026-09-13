/**
 * Quota halt classifier: a small pure function over error text.
 *
 * A Quota halt is an assistant message with stopReason "error" whose error
 * text matches one of the observed terminal usage-limit shapes. Matching is
 * provider-agnostic text: new provider error shapes are added here and
 * tested without pi internals.
 *
 * Deliberately not matched: transient throttles and overloads
 * ("Our servers are currently overloaded...", "rate limited, retry in..."),
 * context overflow, expired-token 401s, and WebSocket close codes - those
 * stay with pi's built-in agent-level retry (see the spec's Out of Scope).
 */

const QUOTA_HALT_PATTERNS: RegExp[] = [
	// Observed shapes from openai-codex session logs:
	/usage limit has been reached/i, // WebSocket path: "Codex error: The usage limit has been reached"
	/hit your chatgpt usage limit/i, // HTTP path: pi rewrites the 429 body into "You have hit your ChatGPT usage limit (...)"
	// pi's own generic terminal rate-limit patterns (non-retryable by design):
	/GoUsageLimitError/i,
	/FreeUsageLimitError/i,
	/monthly usage limit reached/i,
	/available balance/i,
	/insufficient_quota/i,
	/quota exceeded/i,
	/out of budget/i,
	/billing/i,
];

/**
 * True when the error text of a settled assistant message is a terminal
 * usage-limit failure, i.e. a Quota halt that starts a Recovery.
 */
export function isQuotaHaltError(text: string | undefined | null): boolean {
	if (!text) return false;
	return QUOTA_HALT_PATTERNS.some((pattern) => pattern.test(text));
}
