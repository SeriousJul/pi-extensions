import { describe, expect, it } from "vitest";
import { Ledger } from "../../extensions/output-limits/ledger";

// The Ledger is what makes the batch real: the usage pi reports cannot include
// a sibling call that has not finished, so the extension keeps the per-message
// total itself. These cases are that bookkeeping, with no pi and no clock.

const ALLOWANCE = 12_000;

function opened(calls: number): Ledger {
	const ledger = new Ledger();
	ledger.begin("m1", calls, 48_000, ALLOWANCE);
	return ledger;
}

describe("begin", () => {
	it("writes the baseline on the first call of a batch and reuses it after", () => {
		const ledger = new Ledger();
		ledger.begin("m1", 3, 48_000, 12_000);
		// A sibling arriving later with a different Headroom figure must not
		// move the batch: the baseline is the one the batch opened on.
		ledger.begin("m1", 3, 99_999, 99_999);
		expect(ledger.latest()).toMatchObject({ allowanceTokens: 12_000, headroomTokens: 48_000 });
	});

	it("keeps the larger call count when a sibling reads the message late", () => {
		// Probe 2: the first call may not see the assistant message yet.
		const ledger = new Ledger();
		ledger.begin("m1", 0, 48_000, 12_000);
		expect(ledger.view("m1")!.remainingCalls).toBe(1);
		ledger.begin("m1", 4, 48_000, 12_000);
		expect(ledger.view("m1")!.remainingCalls).toBe(4);
	});

	it("starts a new batch on a new message", () => {
		const ledger = opened(2);
		ledger.record("m1", 6_000);
		ledger.begin("m2", 2, 48_000, ALLOWANCE);
		expect(ledger.view("m2")).toMatchObject({ entry: { admittedTokens: 0, admittedCalls: 0 } });
		expect(ledger.view("m2")!.remainingAllowanceTokens).toBe(ALLOWANCE);
	});

	it("keeps only the last few batches, so a long session cannot grow it", () => {
		const ledger = new Ledger();
		for (let i = 0; i < 12; i += 1) ledger.begin(`m${i}`, 1, 48_000, ALLOWANCE);
		expect(ledger.view("m0")).toBeUndefined();
		expect(ledger.view("m11")).toBeDefined();
	});
});

describe("view", () => {
	it("divides what is left by the calls left to come", () => {
		const ledger = opened(3);
		expect(ledger.view("m1")!.remainingCalls).toBe(3);
		expect(ledger.view("m1")!.remainingAllowanceTokens).toBe(ALLOWANCE);
		ledger.record("m1", 4_000);
		expect(ledger.view("m1")!.remainingCalls).toBe(2);
		expect(ledger.view("m1")!.remainingAllowanceTokens).toBe(8_000);
		ledger.record("m1", 4_000);
		expect(ledger.view("m1")!.remainingCalls).toBe(1);
		expect(ledger.view("m1")!.remainingAllowanceTokens).toBe(4_000);
	});

	it("rolls a sibling's unused share forward to the calls that follow", () => {
		const ledger = opened(3);
		// The first call needed almost nothing, so its share is still there.
		ledger.record("m1", 500);
		const view = ledger.view("m1")!;
		expect(view.remainingAllowanceTokens).toBe(11_500);
		expect(view.remainingCalls).toBe(2);
		// Two calls left for 11.5k is more than the original 4k share: that is
		// the roll forward, and the reason the batch is not four fixed slices.
		expect(view.remainingAllowanceTokens / view.remainingCalls).toBeGreaterThan(ALLOWANCE / 3);
	});

	it("never reports a negative remainder once the allowance is spent", () => {
		const ledger = opened(2);
		ledger.record("m1", 20_000);
		expect(ledger.view("m1")!.remainingAllowanceTokens).toBe(0);
		// A batch that is already over never divides by zero: the last call
		// still sees one, so the floor is what governs it, not a negative share.
		expect(ledger.view("m1")!.remainingCalls).toBe(1);
	});

	it("is undefined for a message that never opened a batch", () => {
		expect(opened(2).view("nope")).toBeUndefined();
	});

	it("falls back to the accumulation alone when the call count did not read", () => {
		const ledger = new Ledger();
		ledger.begin("m1", 0, 48_000, ALLOWANCE);
		expect(ledger.view("m1")!.remainingCalls).toBe(1);
		ledger.record("m1", 5_000);
		// With no count the batch cannot divide; each call reaches what is
		// left, and the accumulation is what bounds the total.
		expect(ledger.view("m1")!.remainingCalls).toBe(1);
		expect(ledger.view("m1")!.remainingAllowanceTokens).toBe(7_000);
	});
});

describe("record and invalidate", () => {
	it("counts every admitted call, cut or not", () => {
		const ledger = opened(2);
		ledger.record("m1", 100);
		ledger.record("m1", 0);
		expect(ledger.latest()).toMatchObject({ admittedCalls: 2, admittedTokens: 100 });
	});

	it("ignores a negative or unknown record", () => {
		const ledger = opened(1);
		ledger.record("m1", -5_000);
		expect(ledger.latest()!.admittedTokens).toBe(0);
		ledger.record("ghost", 5_000);
		expect(ledger.latest()!.admittedTokens).toBe(0);
	});

	it("drops every batch on invalidate, so no stale baseline survives a compaction", () => {
		const ledger = opened(2);
		ledger.record("m1", 6_000);
		ledger.invalidate();
		expect(ledger.latest()).toBeUndefined();
		expect(ledger.view("m1")).toBeUndefined();
	});

	it("re-opens a fresh baseline after an invalidate", () => {
		const ledger = opened(2);
		ledger.record("m1", 6_000);
		ledger.invalidate();
		ledger.begin("m1", 2, 20_000, 5_000);
		expect(ledger.view("m1")).toMatchObject({ remainingAllowanceTokens: 5_000, remainingCalls: 2 });
	});
});
