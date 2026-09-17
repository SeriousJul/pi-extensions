import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
	createLlamaRefresh,
	FALLBACK_WINDOW,
	LLAMA_CPP_PROVIDER,
	type LlamaRefresh,
	type RefreshDecision,
} from "../../extensions/llama-refresh/refresh";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function model(provider: string, id: string, contextWindow: number): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	} as Model<Api>;
}

const LA = LLAMA_CPP_PROVIDER;
const TRUE_WINDOW = 200192;

interface Harness {
	llamaRefresh: LlamaRefresh;
	/** Read-backs the registry serves, keyed by provider/id. */
	registry: Map<string, Model<Api>>;
	refreshCalls: number;
	applied: Model<Api>[];
	setRegistry(provider: string, id: string, window: number | undefined): void;
	setRefreshOk(ok: boolean): void;
	/** A hook the fake refresh runs before it resolves, to land a select mid-check. */
	setOnRefresh(fn: (() => void) | undefined): void;
	/** Make the fake registry read-back throw, as a stale session's getter would. */
	setResolveThrows(throws: boolean): void;
	start(): void;
	select(provider: string, id: string): void;
	settled(provider: string, id: string, window: number): Promise<RefreshDecision>;
}

function makeHarness(): Harness {
	const registry = new Map<string, Model<Api>>();
	let refreshOk = true;
	let refreshCalls = 0;
	let onRefresh: (() => void) | undefined;
	let resolveThrows = false;
	const applied: Model<Api>[] = [];

	const llamaRefresh = createLlamaRefresh({
		refreshCatalog: async () => {
			refreshCalls += 1;
			onRefresh?.();
			return refreshOk;
		},
		resolveModel: (ref) => {
			if (resolveThrows) throw new Error("stale session");
			return registry.get(`${ref.provider}/${ref.id}`);
		},
		applyModel: async (m) => {
			applied.push(m);
			return true;
		},
	});

	return {
		llamaRefresh,
		registry,
		get refreshCalls() {
			return refreshCalls;
		},
		applied,
		setRegistry(provider: string, id: string, window: number | undefined) {
			if (window === undefined) {
				registry.delete(`${provider}/${id}`);
			} else {
				registry.set(`${provider}/${id}`, model(provider, id, window));
			}
		},
		setRefreshOk(ok: boolean) {
			refreshOk = ok;
		},
		setOnRefresh(fn) {
			onRefresh = fn;
		},
		setResolveThrows(throws) {
			resolveThrows = throws;
		},
		start: () => llamaRefresh.onSessionStart(),
		select: (provider, id) => llamaRefresh.onModelSelect({ provider, id }),
		settled: (provider, id, window) => llamaRefresh.onTurnEnd({ provider, id, contextWindow: window }),
	};
}

// ---------------------------------------------------------------------------
// Eligibility and the heal
// ---------------------------------------------------------------------------

describe("eligible turn end", () => {
	it("re-applies the re-resolved model exactly once when the window changed", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "re-apply", model: expect.objectContaining({ contextWindow: TRUE_WINDOW }) });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]?.contextWindow).toBe(TRUE_WINDOW);
	});

	it("re-applies the model exactly as the registry resolved it, not a copy", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision.kind).toBe("re-apply");
		if (decision.kind === "re-apply") {
			expect(h.applied[0]).toBe(decision.model);
		}
		expect(h.applied[0]).toBe(h.registry.get(`${LA}/m1`));
	});

	it("does not re-apply when the refresh confirms the Fallback window", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", FALLBACK_WINDOW);

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "re-resolve" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);
	});

	it("keeps a model genuinely loaded at 128000 silent, and spends its Attempt", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", FALLBACK_WINDOW);

		const first = await h.settled(LA, "m1", FALLBACK_WINDOW);
		const second = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(first).toEqual({ kind: "re-resolve" });
		expect(second).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);
	});

	it("does nothing when the refresh no longer lists the model", async () => {
		const h = makeHarness();
		// Asleep catalog: the model is absent from the persisted store.
		h.setRegistry(LA, "m1", undefined);

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "re-resolve" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);
	});

	it("does nothing a second time once the Attempt is spent", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);

		await h.settled(LA, "m1", FALLBACK_WINDOW);
		const second = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(second).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Ineligibility
// ---------------------------------------------------------------------------

describe("ineligible turn end", () => {
	it("ignores non-llama.cpp models", async () => {
		const h = makeHarness();
		h.setRegistry("cloud", "gpt", TRUE_WINDOW);

		const decision = await h.settled("cloud", "gpt", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(0);
		expect(h.applied).toHaveLength(0);
	});

	it("ignores a llama.cpp model already on its true window", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);

		const decision = await h.settled(LA, "m1", TRUE_WINDOW);

		expect(decision).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(0);
		expect(h.applied).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The Attempt
// ---------------------------------------------------------------------------

describe("attempt", () => {
	it("retries on the next turn end when a refresh fails, without spending the Attempt", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRefreshOk(false);

		const first = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(first).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);

		h.setRefreshOk(true);
		const second = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(second.kind).toBe("re-apply");
		expect(h.refreshCalls).toBe(2);
		expect(h.applied).toHaveLength(1);
	});

	it("retries every turn end while the server stays down, and heals when it comes back", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRefreshOk(false);

		await h.settled(LA, "m1", FALLBACK_WINDOW);
		await h.settled(LA, "m1", FALLBACK_WINDOW);
		h.setRefreshOk(true);
		const third = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(third.kind).toBe("re-apply");
		expect(h.refreshCalls).toBe(3);
		expect(h.applied).toHaveLength(1);
	});

	it("re-arms on a new model selection", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRegistry(LA, "m2", TRUE_WINDOW);

		await h.settled(LA, "m1", FALLBACK_WINDOW);
		h.select(LA, "m2");
		const decision = await h.settled(LA, "m2", FALLBACK_WINDOW);

		expect(decision.kind).toBe("re-apply");
		expect(h.applied.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("re-arms a switch away and back, so a return after a sleep still heals", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRegistry(LA, "m2", TRUE_WINDOW);

		await h.settled(LA, "m1", FALLBACK_WINDOW); // m1 spends its Attempt
		h.select(LA, "m2");
		h.select(LA, "m1"); // back to m1 - fresh selection
		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision.kind).toBe("re-apply");
		expect(h.applied.map((m) => m.id)).toEqual(["m1", "m1"]);
	});

	it("keys the Attempt per selection, so one spent selection never blocks another", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRegistry(LA, "m2", TRUE_WINDOW);

		await h.settled(LA, "m1", FALLBACK_WINDOW); // m1 spends its Attempt
		const m2 = await h.settled(LA, "m2", FALLBACK_WINDOW);
		const m1Again = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(m2.kind).toBe("re-apply");
		expect(m1Again).toEqual({ kind: "skip" });
		expect(h.applied.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("re-arms on a new session start", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);

		await h.settled(LA, "m1", FALLBACK_WINDOW); // spends the Attempt
		h.start();
		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision.kind).toBe("re-apply");
		expect(h.applied).toHaveLength(2);
	});

	it("re-arms after a restart of a session whose stored window is still the Fallback window", async () => {
		// Fresh core instance, as the wiring rebuilds on session start; the
		// persisted catalog still carries the Fallback window written while
		// the model was asleep.
		const before = makeHarness();
		before.setRegistry(LA, "m1", FALLBACK_WINDOW);
		await before.settled(LA, "m1", FALLBACK_WINDOW);
		expect(before.applied).toHaveLength(0);

		const after = makeHarness();
		after.setRegistry(LA, "m1", TRUE_WINDOW); // the wake is done; the refresh now sees it
		const decision = await after.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision.kind).toBe("re-apply");
		expect(after.applied).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// In-flight selects and failure-proof
// ---------------------------------------------------------------------------

describe("a select during the check", () => {
	it("skips the re-apply when the user selects a different model during the in-flight refresh", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRegistry(LA, "m2", TRUE_WINDOW);
		h.setOnRefresh(() => h.select(LA, "m2")); // the user selects mid-refresh

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "skip" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);
	});

	it("still lets the user's new selection heal on its own Attempt", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setRegistry(LA, "m2", TRUE_WINDOW);
		let selected = false;
		// The user selects once, during the first refresh.
		h.setOnRefresh(() => {
			if (!selected) {
				selected = true;
				h.select(LA, "m2");
			}
		});

		await h.settled(LA, "m1", FALLBACK_WINDOW); // the m1 check is voided by the select
		const decision = await h.settled(LA, "m2", FALLBACK_WINDOW); // the user's model heals

		expect(decision.kind).toBe("re-apply");
		expect(h.applied.map((m) => m.id)).toEqual(["m2"]);
	});

	it("skips the re-apply even when the user re-selects the checked model", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setOnRefresh(() => h.select(LA, "m1")); // the select moves the generation either way

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "skip" });
		expect(h.applied).toHaveLength(0);
	});
});

describe("failure-proof", () => {
	it("degrades to silence when the registry read-back throws, and spends the Attempt", async () => {
		const h = makeHarness();
		h.setRegistry(LA, "m1", TRUE_WINDOW);
		h.setResolveThrows(true);

		const decision = await h.settled(LA, "m1", FALLBACK_WINDOW);

		expect(decision).toEqual({ kind: "re-resolve" });
		expect(h.refreshCalls).toBe(1);
		expect(h.applied).toHaveLength(0);

		// The Attempt is spent: a late read failure does not retry.
		h.setResolveThrows(false);
		const second = await h.settled(LA, "m1", FALLBACK_WINDOW);
		expect(second).toEqual({ kind: "skip" });
	});
});
