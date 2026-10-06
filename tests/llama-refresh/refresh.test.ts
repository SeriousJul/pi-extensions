// Unit tests for the engine-free llama-refresh decision core (ADR 0027).
// The core owns attempt accounting across both Heal moments, the symptom
// trigger, the command re-arm, and the guards; the pi wiring (index.ts)
// only binds events. Every dependency is faked here.

import { describe, expect, it } from "vitest";

import {
	createLlamaRefresh,
	NEAR_EMPTY_OUTPUT_TOKENS,
	NO_MODEL_LINE,
	type LlamaRefresh,
	type LlamaRefreshDeps,
	type ModelRef,
	REFRESH_TIMEOUT_MS,
	windowCheckFailedLine,
	windowConfirmedLine,
	windowReappliedLine,
} from "../../extensions/llama-refresh/refresh.ts";

const REF: ModelRef = { provider: "llama.cpp", id: "test-model" };
const OTHER: ModelRef = { provider: "openai", id: "gpt" };

// The core only reads contextWindow off a model and hands the model object
// to applyModel, so a fake needs nothing else.
const model = (contextWindow: number) => ({ contextWindow }) as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
	core: LlamaRefresh;
	/** The window the registry currently reports; tests mutate it through the onRefresh hook. */
	registry: { window: number | undefined };
	/** Runs as the catalog refresh completes, before the read-back. */
	onRefresh: () => void;
	refreshCount: () => number;
	/** The refresh options the last refreshCatalog call received. */
	lastRefreshOpts: () => { timeoutMs?: number } | undefined;
	/** Fail the next n refreshes (server down). */
	failNext: (n: number) => void;
	/** Make the next refresh take n ms (models a slow server; the pre-request timeout fails it). */
	delayNext: (ms: number) => void;
	applied: () => number[];
	/** Flip the isCurrent probe (a session replacement or reload). */
	setCurrent: (current: boolean) => void;
	/** Set the active Context window cap (undefined clears it). */
	setCap: (cap: number | undefined) => void;
	/** Refuse the next apply (pi.setModel declined). */
	refuseNextApply: () => void;
}

function makeHarness(): Harness {
	const registry: Harness["registry"] = { window: 40192 };
	let failuresLeft = 0;
	let delayMs = 0;
	let current = true;
	let refuseApply = false;
	let cap: number | undefined;
	let refreshes = 0;
	let opts: { timeoutMs?: number } | undefined;
	const appliedWindows: number[] = [];

	const deps: LlamaRefreshDeps = {
		refreshCatalog: async (nextOpts) => {
			opts = nextOpts;
			refreshes += 1;
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				return false;
			}
			if (delayMs > 0) {
				const duration = delayMs;
				delayMs = 0;
				await sleep(1);
				// Model the wiring's hard deadline: a refresh that cannot
				// finish inside its budget fails.
				if (nextOpts?.timeoutMs !== undefined && duration > nextOpts.timeoutMs) return false;
			}
			harness.onRefresh();
			return true;
		},
		resolveModel: (ref) => {
			if (ref.provider !== REF.provider || ref.id !== REF.id) return undefined;
			return registry.window === undefined ? undefined : model(registry.window);
		},
		applyModel: async (m) => {
			if (refuseApply) {
				refuseApply = false;
				return false;
			}
			appliedWindows.push((m as { contextWindow: number }).contextWindow);
			return true;
		},
		isCurrent: () => current,
		windowCap: () => cap,
	};

	const harness: Harness = {
		core: createLlamaRefresh(deps),
		registry,
		onRefresh: () => undefined,
		refreshCount: () => refreshes,
		lastRefreshOpts: () => opts,
		failNext: (n) => {
			failuresLeft = n;
		},
		delayNext: (ms) => {
			delayMs = ms;
		},
		applied: () => appliedWindows,
		setCurrent: (v) => {
			current = v;
		},
		setCap: (v) => {
			cap = v;
		},
		refuseNextApply: () => {
			refuseApply = true;
		},
	};
	return harness;
}

describe("llama-refresh core", () => {
	it("heals drift at the pre-request moment and reports the move", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(1);
		expect(h.applied()).toEqual([160000]);
	});

	it("heals drift at the post-request moment when the model was asleep at selection", async () => {
		const h = makeHarness();
		h.registry.window = 128000;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		// The first refresh still sees the model asleep; the Wake completes
		// during the first request, so the second refresh sees the true value.
		h.onRefresh = () => {
			if (h.refreshCount() >= 2) h.registry.window = 160000;
		};

		const pre = await h.core.onPreRequest(REF);
		expect(pre).toEqual({ kind: "unchanged", window: 128000 });
		expect(h.applied()).toEqual([]);

		const post = await h.core.onPostRequest(REF);
		expect(post).toEqual({ kind: "re-apply", from: 128000, to: 160000, model: model(160000) });
		expect(h.applied()).toEqual([160000]);
		// The settled moment runs awaited inside its boundary, so its
		// catalog read carries the hard budget.
		expect(h.lastRefreshOpts()).toEqual({ timeoutMs: REFRESH_TIMEOUT_MS });
	});

	it("shrinks a window the server came back with smaller, in either direction", async () => {
		const h = makeHarness();
		h.registry.window = 160000;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 40192;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "re-apply", from: 160000, to: 40192, model: model(40192) });
		expect(h.applied()).toEqual([40192]);
	});

	it("spends one Attempt per Heal moment and skips once spent", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);

		expect((await h.core.onPreRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(1);
		// The pre-request Attempt is spent: a later turn start skips without
		// refreshing.
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(1);
		// The post-request Attempt is still unspent and runs its own compare.
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(2);
		expect((await h.core.onPostRequest(REF)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(2);
	});

	it("a new selection re-arms both Attempts", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);
		await h.core.onPostRequest(REF);
		expect(h.refreshCount()).toBe(2);

		// A selection of a different model re-arms its own Attempts; the
		// old selection stays spent.
		h.core.onModelSelect(OTHER);
		h.core.onModelSelect(REF);
		expect((await h.core.onPreRequest(REF)).kind).toBe("unchanged");
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(4);
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
	});

	it("a same-model re-select re-arms both Attempts", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);
		await h.core.onPostRequest(REF);
		expect(h.refreshCount()).toBe(2);
		// Both Attempts of the selection are spent: a moment now skips.
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");

		// pi emits no model_select for an equal model, so the wiring reports
		// the re-select it read from the transcript. It re-arms both Attempts
		// exactly like a new selection.
		h.core.onReSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};
		expect(await h.core.onPreRequest(REF)).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(3);
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(4);
		// The re-armed selection spends its budget again, so a re-select can
		// never loop a compare on its own.
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
	});

	it("a re-select bumps the generation so an in-flight compare skips its re-apply", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.delayNext(20);
		let reselected = false;
		h.onRefresh = () => {
			h.registry.window = 160000;
			// The operator re-selects the model while the refresh is in flight.
			if (!reselected) {
				reselected = true;
				h.core.onReSelect(REF);
			}
		};

		const decision = await h.core.onPreRequest(REF);

		// The re-select moved the selection: the in-flight compare skips its
		// re-apply, and the re-armed selection re-evaluates from scratch.
		expect(decision.kind).toBe("skip");
		expect(h.applied()).toEqual([]);
		expect(await h.core.onPreRequest(REF)).toEqual({ kind: "unchanged", window: 160000 });
		expect(h.refreshCount()).toBe(2);
	});

	it("a failed refresh spends nothing, so the next moment retries", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.failNext(1);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};

		// The pre-request refresh fails: no Attempt spent, no report.
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(1);
		expect(h.applied()).toEqual([]);
		// The pre-request moment retries on the next turn start and heals.
		const decision = await h.core.onPreRequest(REF);
		expect(decision).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(2);
	});

	it("the symptom trigger spends an unspent Attempt and never re-arms", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		// The pre-request compare confirms the window (no drift yet), so the
		// pre Attempt is spent and the post Attempt is not.
		await h.core.onPreRequest(REF);
		// The server drifts between the request and the truncated answer.
		h.onRefresh = () => {
			h.registry.window = 160000;
		};

		// The truncated turn spends the unspent post-request Attempt on an
		// extra compare and heals.
		const symptom = await h.core.onTruncatedTurn(REF, 1);
		expect(symptom).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(2);
		// The symptom compare runs awaited inside the turn boundary, so its
		// catalog read carries the hard budget.
		expect(h.lastRefreshOpts()).toEqual({ timeoutMs: REFRESH_TIMEOUT_MS });
		// The settled moment finds its Attempt spent and skips.
		expect((await h.core.onPostRequest(REF)).kind).toBe("skip");
		// A later truncated turn re-arms nothing: both Attempts are spent.
		expect((await h.core.onTruncatedTurn(REF, 1)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(2);
	});

	it("the symptom trigger takes an unspent pre Attempt the post refresh left behind", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		// The pre-request refresh failed (server down): its Attempt is still
		// unspent, and the post Attempt has not run yet either.
		h.failNext(1);
		await h.core.onPreRequest(REF);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};

		// The truncated turn spends the unspent post-request Attempt first.
		const symptom = await h.core.onTruncatedTurn(REF, 1);
		expect(symptom).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(2);
		// The pre Attempt was never spent: a later truncated turn may spend
		// it - spending an unspent Attempt is not re-arming one.
		expect((await h.core.onTruncatedTurn(REF, 1)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(3);
	});

	it("the symptom trigger ignores a non-near-empty truncated answer", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);

		const decision = await h.core.onTruncatedTurn(REF, NEAR_EMPTY_OUTPUT_TOKENS + 1);

		expect(decision.kind).toBe("skip");
		expect(h.refreshCount()).toBe(1);
	});

	it("the pre-request timeout fails the refresh and spends nothing", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};
		h.delayNext(REFRESH_TIMEOUT_MS + 1000);

		// The pre-request moment enforces its hard budget: a refresh that
		// cannot finish in time fails and spends nothing.
		expect(h.lastRefreshOpts()).toBeUndefined();
		const decision = await h.core.onPreRequest(REF);
		expect(decision.kind).toBe("skip");
		expect(h.lastRefreshOpts()).toEqual({ timeoutMs: REFRESH_TIMEOUT_MS });
		expect(h.applied()).toEqual([]);
		// The next moment retries inside its budget and heals.
		const retry = await h.core.onPreRequest(REF);
		expect(retry).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
	});

	it("the command re-arms the pre-request Attempt and runs one compare", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);
		await h.core.onPostRequest(REF);
		expect(h.refreshCount()).toBe(2);

		// The server drifted since; the command re-arms one Attempt and the
		// compare heals.
		h.registry.window = 40192;
		h.onRefresh = () => {
			h.registry.window = 160000;
		};
		const decision = await h.core.onCommand(REF);
		expect(decision).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(3);
	});

	it("the command reports an unchanged confirm and a check failure", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);

		const confirm = await h.core.onCommand(REF);
		expect(confirm).toEqual({ kind: "unchanged", window: 40192 });

		h.failNext(1);
		h.core.onModelSelect(REF);
		const failed = await h.core.onCommand(REF);
		expect(failed.kind).toBe("skip");
	});

	it("the command keeps the post-request Attempt's state", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);
		expect(h.refreshCount()).toBe(1);

		// The post Attempt is still unspent: the command re-arms only the
		// pre Attempt, and the settled moment keeps its own compare.
		await h.core.onCommand(REF);
		expect(h.refreshCount()).toBe(2);
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(3);
	});

	it("the command skips a non-llama model without a refresh", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(OTHER);

		expect((await h.core.onCommand(OTHER)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(0);
	});

	it("a non-llama selection skips every moment without a refresh", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(OTHER);

		expect((await h.core.onPreRequest(OTHER)).kind).toBe("skip");
		expect((await h.core.onPostRequest(OTHER)).kind).toBe("skip");
		expect((await h.core.onTruncatedTurn(OTHER, 1)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(0);
	});

	it("the generation guard rejects a re-apply after a mid-flight select", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.delayNext(20);
		let selected = false;
		h.onRefresh = () => {
			h.registry.window = 160000;
			// A manual select lands while the first refresh is in flight.
			if (!selected) {
				selected = true;
				h.core.onModelSelect(REF);
			}
		};

		const inFlight = h.core.onPreRequest(REF);
		const decision = await inFlight;

		// The user's choice wins: the in-flight compare skips its re-apply,
		// and the re-armed selection re-evaluates from scratch: its Attempts
		// are unspent, so the next moment runs a fresh compare (the registry
		// is already healed, so it confirms and stays silent).
		expect(decision.kind).toBe("skip");
		expect(h.applied()).toEqual([]);
		const retry = await h.core.onPreRequest(REF);
		expect(retry).toEqual({ kind: "unchanged", window: 160000 });
		expect(h.refreshCount()).toBe(2);
	});

	it("the isCurrent guard rejects a re-apply after a session replacement", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.delayNext(20);
		h.onRefresh = () => {
			h.registry.window = 160000;
			h.setCurrent(false);
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision.kind).toBe("skip");
		expect(h.applied()).toEqual([]);
	});

	it("an apply refusal spends the Attempt and reports nothing", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 160000;
		};
		h.refuseNextApply();

		const decision = await h.core.onPreRequest(REF);

		expect(decision.kind).toBe("skip");
		expect(h.applied()).toEqual([]);
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(1);
	});

	it("the registry losing the model degrades to silence", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = undefined;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision.kind).toBe("skip");
		expect(h.applied()).toEqual([]);
		expect((await h.core.onPostRequest(REF)).kind).toBe("skip");
		expect(h.refreshCount()).toBe(2);
	});

	it("a restored selection reads as unspent without a model_select", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		// No onModelSelect: pi resolves a restored session's model without
		// emitting model_select.
		h.onRefresh = () => {
			h.registry.window = 160000;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
	});

	it("a session start clears spent Attempts", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		await h.core.onPreRequest(REF);
		expect(h.refreshCount()).toBe(1);

		// A new session re-evaluates the selection from scratch.
		h.core.onSessionStart();
		h.onRefresh = () => {
			h.registry.window = 160000;
		};
		const decision = await h.core.onPreRequest(REF);
		expect(decision).toEqual({ kind: "re-apply", from: 40192, to: 160000, model: model(160000) });
		expect(h.refreshCount()).toBe(2);
	});

	it("two moments never compare the same selection at once", async () => {
		const h = makeHarness();
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.delayNext(20);

		const pre = h.core.onPreRequest(REF);
		// While the pre-request compare is in flight, the settled moment
		// finds the selection busy and skips; it does not queue behind it.
		expect((await h.core.onPostRequest(REF)).kind).toBe("skip");
		const decision = await pre;
		expect(decision.kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(1);
		// The post-request Attempt survived the busy skip and still runs.
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
		expect(h.refreshCount()).toBe(2);
	});
});

describe("the context window cap", () => {
	it("a cap that hides the drift moves nothing and says nothing", async () => {
		const h = makeHarness();
		h.setCap(32000);
		// The session holds the cap; the catalog drifts while staying above
		// it, so the clamped value never moves.
		h.registry.window = 32000;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 40192;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "unchanged", window: 32000 });
		expect(h.applied()).toEqual([]);
		// The Attempt was spent on the confirm; no later moment re-runs it.
		expect((await h.core.onPreRequest(REF)).kind).toBe("skip");
		expect((await h.core.onPostRequest(REF)).kind).toBe("unchanged");
	});

	it("a cap above the drifted value still shows the move", async () => {
		const h = makeHarness();
		h.setCap(64000);
		// The session holds the cap, clamped from a stale 160000; the live
		// value drifts to 40192, below the cap, so the clamped value moves.
		h.registry.window = 64000;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 40192;
		};

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "re-apply", from: 64000, to: 40192, model: model(40192) });
		expect(h.applied()).toEqual([40192]);
	});

	it("a drift from below the cap to above it heals to the clamped value", async () => {
		const h = makeHarness();
		h.setCap(32000);
		// The session runs at the live 24000 (below the cap); the server
		// comes back at 40192, above the cap, so the session moves to the
		// cap, not to the raw live value.
		h.registry.window = 24000;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);
		h.onRefresh = () => {
			h.registry.window = 40192;
		};

		const decision = await h.core.onPreRequest(REF);

		// The re-apply passes the registry's model as pi resolved it; the
		// cap's boundary clamp finalizes the session at the cap, and the
		// line reports the clamped move.
		expect(decision).toEqual({ kind: "re-apply", from: 24000, to: 32000, model: model(40192) });
		expect(h.applied()).toEqual([40192]);
	});

	it("the clamp applies to an uncapped registry copy the session never clamped", async () => {
		const h = makeHarness();
		h.setCap(32000);
		// The refresh replaced the registry's object before the cap's clamp
		// ran, so the copy reads the uncapped 40192 while the session holds
		// the cap: the compare must still see no move.
		h.registry.window = 40192;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);

		const decision = await h.core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "unchanged", window: 32000 });
		expect(h.applied()).toEqual([]);
	});

	it("the command confirms the clamped window, not the raw registry value", async () => {
		const h = makeHarness();
		h.setCap(32000);
		// The registry copy is uncapped (a refresh landed since the last
		// clamp); the session holds the cap.
		h.registry.window = 40192;
		h.core.onSessionStart();
		h.core.onModelSelect(REF);

		const decision = await h.core.onCommand(REF);

		expect(decision).toEqual({ kind: "unchanged", window: 32000 });
		expect(h.applied()).toEqual([]);
	});

	it("a throwing cap probe degrades to the uncapped compare", async () => {
		// The probe throws (an impossible state, but the core never errors):
		// the compare degrades to no cap, the pre-amendment behavior, and
		// still heals the raw move.
		let registryWindow = 32000;
		const core = createLlamaRefresh({
			refreshCatalog: async () => {
				registryWindow = 40192;
				return true;
			},
			resolveModel: () => model(registryWindow),
			applyModel: async () => true,
			isCurrent: () => true,
			windowCap: () => {
				throw new Error("no cap record");
			},
		});
		core.onSessionStart();
		core.onModelSelect(REF);

		const decision = await core.onPreRequest(REF);

		expect(decision).toEqual({ kind: "re-apply", from: 32000, to: 40192, model: model(40192) });
	});
});

describe("report lines", () => {
	it("builds every line in exactly one place", () => {
		expect(windowReappliedLine(40192, 160000, REF)).toBe("llama window: 40192 -> 160000 (llama.cpp/test-model)");
		expect(windowConfirmedLine(160000, REF)).toBe("llama window: 160000 (llama.cpp/test-model)");
		expect(windowCheckFailedLine(REF)).toBe("llama window: check failed (llama.cpp/test-model)");
		expect(NO_MODEL_LINE).toBe("llama window: no model selected");
	});
});
