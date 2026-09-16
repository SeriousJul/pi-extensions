/**
 * Engagement (pure state-machine step): whether the pruning first level is
 * active for the session right now.
 *
 * Engagement sticks once the context estimate crosses pi's own compaction
 * threshold. A pruned request reports the smaller pruned usage, so the next
 * usage-backed estimate drops back below the threshold and a stateless check
 * would let the next request go out raw: the outgoing prefix flaps between
 * the pruned and the raw shape, and every switch invalidates the provider's
 * prompt cache (a full re-bill of the whole context). Holding engagement on
 * until a reset pays one cache miss at the crossing, and every later request
 * then hits the cache on the stable pruned prefix.
 *
 * A reset event - a compaction ran, or the session restarted - clears the
 * stickiness, so a shrunken session can run raw again until it re-crosses.
 * Crossing the threshold always wins over the carried state, so a session
 * that is still above the threshold right after a reset re-engages at once.
 *
 * The step is total and stateless: a few numbers and the carried state in,
 * one state out, so the whole transition is table-testable at its boundary
 * without a pi runtime (the same shape as the prune gate).
 */

/** The inputs to one engagement step. */
export interface EngagementInput {
	/** The engaged state carried from the previous request (session state). */
	engaged: boolean;
	/** The usage-backed context estimate of the current request. */
	estimate: number;
	/** pi's own compaction threshold: the context window minus reserveTokens. */
	threshold: number;
	/** A reset event just occurred: a compaction ran, or the session restarted. */
	reset: boolean;
}

/** Step the sticky engagement state machine and return the new engaged state. */
export function nextEngagement(input: EngagementInput): boolean {
	// Crossing the threshold engages, and re-engages right after a reset.
	if (input.estimate > input.threshold) return true;
	// A reset clears the stickiness, so a shrunken session runs raw again.
	if (input.reset) return false;
	// Otherwise hold the carried state: the pruned prefix stays stable.
	return input.engaged;
}
