import { describe, expect, it } from "vitest";
import { nextEngagement } from "../../extensions/pruning/engagement";

// A threshold that mirrors the reproduction session: window 199,680, reserve
// 16,384, so the compaction threshold is 183,296. Below it the session runs
// raw; above it (or once it has been crossed) pruning engages.

const THRESHOLD = 183_296;
const RAW = 184_000; // a raw request's usage-backed estimate
const PRUNED = 141_000; // a pruned request's usage-backed estimate

describe("sticky engagement", () => {
	it("engages the first time the estimate crosses the threshold", () => {
		expect(nextEngagement({ engaged: false, estimate: THRESHOLD, threshold: THRESHOLD, reset: false })).toBe(false); // at the threshold: not yet
		expect(nextEngagement({ engaged: false, estimate: THRESHOLD + 1, threshold: THRESHOLD, reset: false })).toBe(true); // just above: engages
	});

	it("stays disengaged while the estimate is below the threshold", () => {
		expect(nextEngagement({ engaged: false, estimate: PRUNED, threshold: THRESHOLD, reset: false })).toBe(false);
	});

	it("keeps engaging below the threshold once engaged (the pruned steady state)", () => {
		// A pruned request reports the smaller pruned usage, so the next
		// estimate falls below the threshold; stickiness holds it engaged.
		expect(nextEngagement({ engaged: true, estimate: PRUNED, threshold: THRESHOLD, reset: false })).toBe(true);
	});

	it("re-engages above the threshold regardless of the carried state", () => {
		expect(nextEngagement({ engaged: false, estimate: RAW, threshold: THRESHOLD, reset: false })).toBe(true);
	});

	it("clears the stickiness on a reset below the threshold", () => {
		expect(nextEngagement({ engaged: true, estimate: PRUNED, threshold: THRESHOLD, reset: true })).toBe(false);
	});

	it("re-engages the moment the estimate crosses again after a reset", () => {
		// Crossing the threshold wins over the reset, so a session still above
		// the threshold right after a compaction re-engages at once.
		expect(nextEngagement({ engaged: true, estimate: RAW, threshold: THRESHOLD, reset: true })).toBe(true);
	});

	it("keeps engaging across the pruned/raw alternation (the flap is gone)", () => {
		// Walk the reproduction's alternation: the raw estimate crosses, then
		// the pruned estimate drops back below the threshold on every other
		// request. A stateless check flaps; the sticky check holds.
		let engaged = false;
		const out: boolean[] = [];
		for (const estimate of [RAW, PRUNED, PRUNED, RAW, PRUNED, PRUNED]) {
			engaged = nextEngagement({ engaged, estimate, threshold: THRESHOLD, reset: false });
			out.push(engaged);
		}
		expect(out).toEqual([true, true, true, true, true, true]);
	});
});
