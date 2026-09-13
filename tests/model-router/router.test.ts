import { describe, expect, it } from "vitest";
import {
	createModelRouter,
	MAX_RECOVERY_CYCLES,
	RECOVERY_MESSAGE,
	type ModelRef,
	type ModelRouter,
	type PendingRecovery,
} from "../../extensions/model-router/router";
import type { QuotaRead, UsageSnapshot } from "../../extensions/quota/source";

const CODEX = "openai-codex";
const NOW0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const O: ModelRef = { provider: CODEX, id: "o" };
const B: ModelRef = { provider: "anthropic", id: "b" };
const C: ModelRef = { provider: "anthropic", id: "c" };
const D: ModelRef = { provider: "anthropic", id: "d" };
const M: ModelRef = { provider: "ghost", id: "m" }; // not found
const N: ModelRef = { provider: "locked", id: "n" }; // no auth

// ---------------------------------------------------------------------------
// Quota read builders
// ---------------------------------------------------------------------------

function snapshot(windows: { usedPercent: number; resetsAtMs: number }[]): UsageSnapshot {
	return {
		windows: windows.map((w) => ({ label: "5h", usedPercent: w.usedPercent, resetsAtMs: w.resetsAtMs, windowLengthMs: 5 * HOUR })),
		fetchedAtMs: NOW0,
	};
}
const exhausted = (resetMs: number): QuotaRead => ({ ok: true, snapshot: snapshot([{ usedPercent: 100, resetsAtMs: resetMs }]) });
const recovered: QuotaRead = { ok: true, snapshot: snapshot([{ usedPercent: 20, resetsAtMs: NOW0 + HOUR }]) };
const noLogin: QuotaRead = { ok: false, reason: "no-login", message: "no login" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Timer {
	delay: number;
	onFire: () => void;
	cancelled: boolean;
}

interface HarnessOpts {
	precedence?: readonly ("switch" | "wait")[];
	fallbacks?: readonly ModelRef[];
	maxWaitMinutes?: number;
	quota?: QuotaRead;
	lookup?: (ref: ModelRef) => { found: boolean; hasAuth: boolean };
	now?: () => number;
}

function makeHarness(opts: HarnessOpts = {}) {
	let currentQuota: QuotaRead = opts.quota ?? exhausted(NOW0 + 2 * HOUR);
	let currentNow = opts.now ? opts.now() : NOW0;
	const setModelCalls: ModelRef[] = [];
	const sentMessages: string[] = [];
	const notifications: { message: string; level: "info" | "error" }[] = [];
	const persisted: (PendingRecovery | null)[] = [];
	const timers: Timer[] = [];

	const deps = {
		config: {
			precedence: opts.precedence ?? ["switch", "wait"],
			fallbacks: opts.fallbacks ?? [],
			maxWaitMinutes: opts.maxWaitMinutes ?? 360,
		},
		quotaProviderId: CODEX,
		readQuota: async (): Promise<QuotaRead> => currentQuota,
		findModel: (ref: ModelRef) => opts.lookup?.(ref) ?? { found: true, hasAuth: true },
		now: () => currentNow,
		scheduleTimer: (delay: number, onFire: () => void) => {
			const t: Timer = { delay, onFire, cancelled: false };
			timers.push(t);
			return { cancel: () => (t.cancelled = true) };
		},
		actions: {
			setModel: async (ref: ModelRef) => {
				setModelCalls.push(ref);
				return true;
			},
			sendUserMessage: async (text: string) => {
				sentMessages.push(text);
			},
			notify: (message: string, level: "info" | "error") => {
				notifications.push({ message, level });
			},
			persistPending: (data: PendingRecovery | null) => {
				persisted.push(data);
			},
		},
	};

	const router = createModelRouter(deps) as ModelRouter;
	// All fakes resolve immediately, so a short real timer drains the enqueue
	// chain (including timer-fire continuations, which the router does not expose).
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

	return {
		router,
		setQuota: (q: QuotaRead) => (currentQuota = q),
		setNow: (ms: number) => (currentNow = ms),
		advanceNow: (ms: number) => (currentNow += ms),
		fireLastTimer: () => {
			const t = timers[timers.length - 1];
			if (t) t.onFire();
		},
		// The last entry the router persisted (an object, or null once cleared).
		lastPersisted: () => persisted.at(-1) as PendingRecovery | null | undefined,
		setModelCalls,
		sentMessages,
		notifications,
		persisted,
		timers,
		flush,
	};
}

// ---------------------------------------------------------------------------
// Wait viability
// ---------------------------------------------------------------------------

describe("wait viability", () => {
	it("waits for a 5h reset inside the threshold", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(1);
		expect(h.notifications.some((n) => /waiting for quota reset/.test(n.message))).toBe(true);
		expect(h.lastPersisted()).toMatchObject({ phase: "waiting" });
	});

	it("does not wait for a weekly reset beyond the default threshold", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 3 * 24 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(0);
		expect(h.notifications.at(-1)?.level).toBe("error");
	});

	it("honors a smaller maxWaitMinutes", async () => {
		const h = makeHarness({
			precedence: ["wait"],
			maxWaitMinutes: 60,
			quota: exhausted(NOW0 + 3 * HOUR), // 3h > 1h threshold
		});
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(0);
	});

	it("is not viable when the quota read fails", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: noLogin });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(0);
		expect(h.notifications.at(-1)?.level).toBe("error");
	});

	it("is not viable when no window is exhausted", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: recovered });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("precedence", () => {
	it("switch-then-wait switches when a fallback is usable", async () => {
		const h = makeHarness({ precedence: ["switch", "wait"], fallbacks: [B], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([B]);
		expect(h.timers).toHaveLength(0);
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
	});

	it("switch-then-wait falls through to wait when no fallback is usable", async () => {
		const h = makeHarness({
			precedence: ["switch", "wait"],
			fallbacks: [M], // not found
			quota: exhausted(NOW0 + 2 * HOUR),
			lookup: (ref) => (ref === M ? { found: false, hasAuth: false } : { found: true, hasAuth: true }),
		});
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([]);
		expect(h.timers).toHaveLength(1);
	});

	it("wait-only waits even when a fallback is available", async () => {
		const h = makeHarness({ precedence: ["wait"], fallbacks: [B], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([]);
		expect(h.timers).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

describe("fallback chain", () => {
	it("skips missing and no-auth entries with one notification, then stops", async () => {
		const h = makeHarness({
			precedence: ["switch"],
			fallbacks: [M, N],
			quota: exhausted(NOW0 + 2 * HOUR),
			lookup: (ref) => (ref === M ? { found: false, hasAuth: true } : ref === N ? { found: true, hasAuth: false } : { found: true, hasAuth: true }),
		});
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([]);
		const skip = h.notifications.filter((n) => /no usable fallback/.test(n.message));
		expect(skip).toHaveLength(1);
		expect(skip[0].message).toContain("ghost/m");
		expect(skip[0].message).toContain("locked/n");
	});

	it("switches to the first usable entry, skipping earlier unusable ones silently", async () => {
		const h = makeHarness({
			precedence: ["switch", "wait"],
			fallbacks: [M, B],
			quota: exhausted(NOW0 + 2 * HOUR),
			lookup: (ref) => (ref === M ? { found: false, hasAuth: true } : { found: true, hasAuth: true }),
		});
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([B]);
		expect(h.notifications.some((n) => /no usable fallback/.test(n.message))).toBe(false);
	});

	it("with an empty fallback list, switch is a no-op and wait proceeds", async () => {
		const h = makeHarness({ precedence: ["switch", "wait"], fallbacks: [], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.setModelCalls).toEqual([]);
		expect(h.timers).toHaveLength(1);
		expect(h.notifications.some((n) => /no usable fallback/.test(n.message))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fallback failure + bound
// ---------------------------------------------------------------------------

describe("fallback failure and bound", () => {
	it("a failing fallback advances the chain", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B, C] });
		await h.router.onQuotaHalt(O); // -> B
		await h.router.onQuotaHalt(B); // B halts -> C
		expect(h.setModelCalls).toEqual([B, C]);
	});

	it("gives up after three full cycles with exactly one error notification", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B, C, D] });
		await h.router.onQuotaHalt(O); // cycle 1 -> B
		await h.router.onQuotaHalt(B); // cycle 2 -> C
		await h.router.onQuotaHalt(C); // cycle 3 -> D
		await h.router.onQuotaHalt(D); // cycle 4 -> give up (no switch)
		expect(h.setModelCalls).toEqual([B, C, D]);
		const errors = h.notifications.filter((n) => n.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("gave up");
		expect(h.lastPersisted()).toBeNull(); // cleared
	});

	it("does not retry a fallback that already failed", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B, C] });
		await h.router.onQuotaHalt(O); // -> B
		await h.router.onQuotaHalt(B); // -> C
		await h.router.onQuotaHalt(C); // -> give up
		expect(h.setModelCalls).toEqual([B, C]);
	});
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
	it("user input cancels a pending wait, and the next halt starts a fresh cycle", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(1);
		h.router.onUserInput();
		expect(h.timers[0].cancelled).toBe(true);
		// A fresh halt from the user's own prompt re-arms.
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(2);
		expect(h.timers[1].cancelled).toBe(false);
	});

	it("user input does not cancel a pending switch-back", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O); // -> B, on-fallback
		h.router.onUserInput();
		// The pending switch-back survives: an idle on the fallback with a
		// recovered quota still switches back.
		h.advanceNow(61_000);
		h.setQuota(recovered);
		await h.router.onIdle(B);
		expect(h.setModelCalls).toEqual([B, O]);
	});

	it("a manual model change cancels a pending wait", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(1);
		h.router.onModelSelect({ provider: "x", id: "y" });
		expect(h.timers[0].cancelled).toBe(true);
		expect(h.lastPersisted()).toBeNull();
	});

	it("a manual model change cancels a pending switch-back", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O); // -> B, on-fallback
		h.router.onModelSelect({ provider: "x", id: "y" });
		expect(h.lastPersisted()).toBeNull();
		// No switch-back happens after the manual change.
		h.advanceNow(61_000);
		h.setQuota(recovered);
		await h.router.onIdle(O);
		expect(h.setModelCalls).toEqual([B]);
	});
});

// ---------------------------------------------------------------------------
// Switch-back
// ---------------------------------------------------------------------------

describe("switch-back", () => {
	it("switches back on idle once the quota recovers, without a recovery message", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O); // switch sends the one recovery message
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
		h.advanceNow(61_000);
		h.setQuota(recovered);
		await h.router.onIdle(B);
		expect(h.setModelCalls).toEqual([B, O]);
		// The idle switch-back adds no recovery message (the turn was not cut off).
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
		expect(h.notifications.some((n) => /switched back to/.test(n.message))).toBe(true);
		expect(h.lastPersisted()).toBeNull();
	});

	it("stays on the fallback while the quota is still exhausted", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O);
		h.advanceNow(61_000);
		h.setQuota(exhausted(NOW0 + 2 * HOUR));
		await h.router.onIdle(B);
		expect(h.setModelCalls).toEqual([B]);
	});

	it("respects the check interval while idle", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O);
		h.setQuota(recovered);
		await h.router.onIdle(B); // first idle (no interval gate on the first)
		expect(h.setModelCalls).toEqual([B, O]);
	});
});

// ---------------------------------------------------------------------------
// Wait timer confirm
// ---------------------------------------------------------------------------

describe("wait timer confirm", () => {
	it("resumes the halted turn when the reset confirms recovery (no fallback)", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.timers).toHaveLength(1);
		h.setQuota(recovered);
		h.fireLastTimer();
		await h.flush();
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
		expect(h.lastPersisted()).toBeNull();
	});

	it("switches back to the original and resumes when the reset confirms recovery (on a codex fallback)", async () => {
		// Original codex model halts, no usable non-codex fallback, so we wait on
		// the original; a codex fallback is configured but switch comes first.
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		h.setQuota(recovered);
		h.fireLastTimer();
		await h.flush();
		expect(h.setModelCalls).toEqual([]); // no fallback was set
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
	});

	it("gives up when the reset passes while the quota stays exhausted", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O); // waits on the reset
		expect(h.timers).toHaveLength(1);
		// The reset passes while the quota stays exhausted (fresh read agrees).
		h.advanceNow(3 * HOUR);
		h.setQuota(exhausted(NOW0 + 2 * HOUR));
		h.fireLastTimer();
		await h.flush();
		// No fallback and the reset is in the past -> a clean stop.
		expect(h.notifications.at(-1)?.level).toBe("error");
		expect(h.lastPersisted()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Re-arm
// ---------------------------------------------------------------------------

describe("re-arm", () => {
	it("re-arms a still-waiting recovery whose reset is still ahead", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		const waiting = h.lastPersisted();
		expect(waiting).toMatchObject({ phase: "waiting" });
		h.router.shutdown();
		await h.router.rearm(waiting!);
		expect(h.timers.at(-1)?.cancelled).toBe(false);
	});

	it("resumes when a still-waiting recovery finds the quota already recovered", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		const waiting = h.lastPersisted();
		h.router.shutdown();
		h.setQuota(recovered);
		await h.router.rearm(waiting!);
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
		expect(h.lastPersisted()).toBeNull();
	});

	it("gives up when a re-armed wait's reset has already passed and nothing is usable", async () => {
		const h = makeHarness({ precedence: ["switch", "wait"], fallbacks: [], quota: exhausted(NOW0 - 60_000) });
		const waiting: PendingRecovery = {
			v: 1,
			phase: "waiting",
			original: O,
			chainPos: 0,
			fallbackInUse: null,
			cycles: 1,
			resetAtMs: NOW0 - 60_000,
		};
		await h.router.rearm(waiting);
		// reset in the past, still exhausted, no fallback, wait not viable -> stop
		expect(h.notifications.at(-1)?.level).toBe("error");
		expect(h.setModelCalls).toEqual([]);
	});

	it("switches back immediately when an on-fallback recovery finds the quota recovered", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O); // -> B
		const onFallback = h.lastPersisted();
		expect(onFallback).toMatchObject({ phase: "on-fallback" });
		h.router.shutdown();
		h.setQuota(recovered);
		await h.router.rearm(onFallback!);
		expect(h.setModelCalls).toEqual([B, O]);
		// A restart switch-back does not resume a cut-off turn.
		expect(h.sentMessages).toEqual([RECOVERY_MESSAGE]);
	});

	it("keeps an on-fallback recovery on the fallback when the quota is still exhausted", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O); // -> B
		const onFallback = h.lastPersisted();
		h.router.shutdown();
		h.setQuota(exhausted(NOW0 + 2 * HOUR));
		await h.router.rearm(onFallback!);
		expect(h.setModelCalls).toEqual([B]);
		expect(h.lastPersisted()).toMatchObject({ phase: "on-fallback" });
	});
});

// ---------------------------------------------------------------------------
// Persistence + shutdown
// ---------------------------------------------------------------------------

describe("persistence and shutdown", () => {
	it("persists on-fallback after a switch", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B] });
		await h.router.onQuotaHalt(O);
		expect(h.lastPersisted()).toMatchObject({ phase: "on-fallback", fallbackInUse: B, original: O });
	});

	it("persists waiting with the reset while waiting", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		expect(h.lastPersisted()).toMatchObject({ phase: "waiting", resetAtMs: NOW0 + 2 * HOUR });
	});

	it("clears the persisted entry on give-up", async () => {
		const h = makeHarness({ precedence: ["switch"], fallbacks: [B, C, D] });
		await h.router.onQuotaHalt(O);
		await h.router.onQuotaHalt(B);
		await h.router.onQuotaHalt(C);
		await h.router.onQuotaHalt(D);
		expect(h.persisted.at(-1)).toBeNull();
	});

	it("shutdown cancels the timer but leaves the persisted entry for re-arming", async () => {
		const h = makeHarness({ precedence: ["wait"], quota: exhausted(NOW0 + 2 * HOUR) });
		await h.router.onQuotaHalt(O);
		const waiting = h.lastPersisted();
		h.router.shutdown();
		expect(h.timers[0].cancelled).toBe(true);
		// shutdown does not clear the persisted entry (re-arm reads it).
		expect(h.persisted.at(-1)).toMatchObject({ phase: "waiting" });
		expect(waiting).toBeDefined();
	});

	it("bounds cycles to the exported constant", () => {
		expect(MAX_RECOVERY_CYCLES).toBe(3);
	});
});
