import { describe, expect, it } from "vitest";
import { pruneGate } from "../../extensions/pruning/gate";

// window 20000, reserve 1000: the threshold is 18000.

const BASE = { contextWindow: 20000, reserveTokens: 1000, reason: "threshold" as const };

describe("prune gate", () => {
	it("cancels exactly when the pruned estimate reaches the window minus twice reserve", () => {
		// estimatedAfter = tokensBefore - prunedSavings.
		const rows: Array<[number, number, boolean]> = [
			[19000, 1000, true], // 18000 = threshold: cancel
			[19001, 1000, false], // 18001: pass
			[20000, 2000, true], // 18000: cancel
			[20000, 1999, false], // 18001: pass
			[100000, 82000, true], // 18000: cancel
			[100000, 81999, false], // 18001: pass
			[5000, 1000, true], // 4000: deep below: cancel
			[18500, 0, false], // no savings: pass
		];
		for (const [tokensBefore, prunedSavings, cancel] of rows) {
			const decision = pruneGate({ ...BASE, tokensBefore, prunedSavings });
			expect(decision.cancel, `tokensBefore=${tokensBefore} savings=${prunedSavings}`).toBe(cancel);
		}
	});

	it("exposes the threshold and the pruned estimate", () => {
		const decision = pruneGate({ ...BASE, tokensBefore: 19500, prunedSavings: 1500 });
		expect(decision.threshold).toBe(18000);
		expect(decision.estimatedAfter).toBe(18000);
		expect(decision.cancel).toBe(true);
	});

	it("never cancels a manual compaction, even when pruning covers the margin", () => {
		const decision = pruneGate({ contextWindow: 20000, reserveTokens: 1000, tokensBefore: 19000, prunedSavings: 5000, reason: "manual" });
		expect(decision.cancel).toBe(false);
	});

	it("never cancels an overflow compaction, even when pruning covers the margin", () => {
		const decision = pruneGate({ contextWindow: 20000, reserveTokens: 1000, tokensBefore: 19000, prunedSavings: 5000, reason: "overflow" });
		expect(decision.cancel).toBe(false);
	});

	it("handles a threshold where reserve is zero", () => {
		const decision = pruneGate({ contextWindow: 20000, reserveTokens: 0, tokensBefore: 20000, prunedSavings: 1, reason: "threshold" });
		expect(decision.threshold).toBe(20000);
		expect(decision.cancel).toBe(true); // 19999 <= 20000
	});
});
