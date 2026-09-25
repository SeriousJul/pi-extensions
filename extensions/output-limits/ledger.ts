/**
 * The Ledger: what one assistant message has admitted so far against its
 * Bound.
 *
 * The usage pi reports cannot include a sibling call that has not finished,
 * so the extension keeps the per-message total itself (ADR 0026). One
 * message's calls are preflighted and then run concurrently, and pi calls
 * the `tool_result` hook per call in completion order, so the Ledger is the
 * only place where the batch is visible.
 *
 * The Ledger is a pure state holder: no pi, no file system, no clock. The
 * wiring feeds it the message identity it read from the session, and the
 * Headroom it read from pi, and it answers the two questions the hook asks:
 * what is this call's share, and what did the session just grow by.
 *
 * Roll-forward is what makes the batch useful rather than merely divided:
 * the allowance is a running total, not a per-call subscription, so a call
 * that admits less than its share leaves the difference for the calls that
 * come after it in the same message.
 *
 * When the wiring cannot read the call count for the current assistant
 * message cleanly (implementation probe 2: pi does not promise the session is
 * current through the assistant message at `tool_result` time in parallel
 * mode), the Ledger falls back to the accumulation alone: `remainingCalls`
 * is 1, so each call may take whatever the batch has left, clamped by the
 * floor and the outer max. The Ledger is authoritative either way, no call
 * ever gets more than `maxOutputTokens`, and the accumulation is what bounds
 * the batch, so an unbaselined or uncounted batch is still a batch.
 */

/** One message's running batch state. */
export interface LedgerEntry {
	/** The identity of the assistant message the batch belongs to. */
	messageId: string;
	/** The calls that message asked for, or 0 when it did not read cleanly. */
	calls: number;
	/**
	 * The Headroom tokens the allowance was computed from, or 0 when the batch
	 * is still unbaselined because every call so far was blind.
	 */
	headroomTokens: number;
	/** The message allowance in tokens, floor and outer max included. */
	allowanceTokens: number;
	/** Tokens already admitted to the session for this message. */
	admittedTokens: number;
	/** Calls already admitted for this message. */
	admittedCalls: number;
}

/** The per-message figures a batch is opened on: see `Ledger.begin`. */
export interface BatchBaseline {
	headroomTokens: number;
	allowanceTokens: number;
}

export interface LedgerView {
	entry: LedgerEntry;
	/** The allowance tokens still unspent. */
	remainingAllowanceTokens: number;
	/** The calls still to come, this one included. */
	remainingCalls: number;
}

export class Ledger {
	private entries = new Map<string, LedgerEntry>();
	/** The order messages were seen in, so stale batches can be dropped. */
	private order: string[] = [];

	/**
	 * Open (or return) the batch for one assistant message.
	 *
	 * `baseline` is the message allowance and the Headroom it came from.
	 * `computeBound` divides what is left of it, so it is a per-message figure
	 * written once and reused by every sibling: the usage pi reports cannot
	 * include a sibling that has not finished, and a baseline that moved
	 * mid-batch would make the batch's total depend on call order. That is the
	 * once-per-message figure ADR 0026 accepts.
	 *
	 * A `null` baseline means this call was blind, and a blind call writes no
	 * baseline at all: the outer max is not an allowance, and freezing a batch
	 * on it would leave every later sibling of the message dividing the whole
	 * window. An unbaselined batch takes its baseline from the first call that
	 * can read a Headroom, and keeps what the blind calls already admitted, so
	 * the pass-through cost is still charged to the message.
	 */
	begin(messageId: string, calls: number, baseline: BatchBaseline | null): LedgerEntry {
		const existing = this.entries.get(messageId);
		if (existing) {
			// The count can arrive late: the first sibling ran before the
			// session read cleanly, a later one finds the message. Take the
			// larger figure so the division is never worse than the truth.
			if (calls > existing.calls) existing.calls = calls;
			if (baseline !== null && existing.headroomTokens === 0) {
				existing.headroomTokens = baseline.headroomTokens;
				existing.allowanceTokens = baseline.allowanceTokens;
			}
			return existing;
		}
		const entry: LedgerEntry = {
			messageId,
			calls: Math.max(0, calls),
			headroomTokens: baseline?.headroomTokens ?? 0,
			allowanceTokens: baseline?.allowanceTokens ?? 0,
			admittedTokens: 0,
			admittedCalls: 0,
		};
		this.entries.set(messageId, entry);
		this.order.push(messageId);
		// A session can hold many finished batches; only the current one and
		// its immediate predecessor matter, so keep the map small.
		while (this.order.length > 4) {
			const oldest = this.order.shift();
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return entry;
	}

	/** The view one call needs to compute its Bound. */
	view(messageId: string): LedgerView | undefined {
		const entry = this.entries.get(messageId);
		if (!entry) return undefined;
		const remainingAllowanceTokens = Math.max(0, entry.allowanceTokens - entry.admittedTokens);
		// The count reads cleanly: divide what is left by what is left to come.
		// It does not: let this call reach the whole remainder, and let the
		// clamp cap what it may actually take. The remainder is what bounds the
		// batch then, so the siblings must share one key for it to be a batch.
		const remainingCalls = entry.calls > 0 ? Math.max(1, entry.calls - entry.admittedCalls) : 1;
		return { entry, remainingAllowanceTokens, remainingCalls };
	 }

	/** Record what one call admitted, in tokens. Always runs, cut or not. */
	record(messageId: string, tokens: number): void {
		const entry = this.entries.get(messageId);
		if (!entry) return;
		entry.admittedTokens += Math.max(0, tokens);
		entry.admittedCalls += 1;
	}

	/** Drop every batch. A compaction, a model switch, or a tree navigation
	 * changes the projection, so a stored baseline must not carry over. */
	invalidate(): void {
		this.entries.clear();
		this.order = [];
	}

	/** The live batch, newest first. `status` reports it. */
	latest(): LedgerEntry | undefined {
		for (let i = this.order.length - 1; i >= 0; i -= 1) {
			const entry = this.entries.get(this.order[i]);
			if (entry) return entry;
		}
		return undefined;
	}
}
