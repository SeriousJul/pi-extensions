/**
 * Prune gate (pure): the decision at the moment pi is about to compact.
 *
 * The gate acts only when the compaction reason is "threshold" - a manual
 * /compact and an overflow recovery always fall through to the second
 * level. It cancels the compaction exactly when the context estimate
 * after pruning, `tokensBefore - prunedSavings`, falls to at most the
 * window minus twice reserveTokens; otherwise it returns nothing and pi's
 * default compaction runs unchanged. A few numbers in, one decision out,
 * so the two-level policy is table-testable at its boundary.
 */

/** What triggered the compaction, as carried by the pi event. */
export type CompactionReason = "manual" | "threshold" | "overflow";

export interface GateInput {
	/** pi's usage-backed context size at compaction time (the event's preparation). */
	tokensBefore: number;
	/** Estimated pruning savings from a fresh prune pass over the current messages. */
	prunedSavings: number;
	/** The model's effective context window (cap included). */
	contextWindow: number;
	/** pi's compaction.reserveTokens. */
	reserveTokens: number;
	/** The compaction reason from the pi event. */
	reason: CompactionReason;
}

export interface GateDecision {
	/** True when pruning wins and the compaction is cancelled. */
	cancel: boolean;
	/** `contextWindow - 2 * reserveTokens`: the estimate pruning must reach. */
	threshold: number;
	/** `tokensBefore - prunedSavings`: the estimated size after pruning. */
	estimatedAfter: number;
}

export function pruneGate(input: GateInput): GateDecision {
	const threshold = input.contextWindow - 2 * input.reserveTokens;
	const estimatedAfter = input.tokensBefore - input.prunedSavings;
	const cancel = input.reason === "threshold" && estimatedAfter <= threshold;
	return { cancel, threshold, estimatedAfter };
}
