// Unit tests for the engine-free output-starvation guard core (ADR 0028).
// The core owns the trigger - "the payload's output budget is pi's
// saturated floor" - and the one-line report; the pi wiring (index.ts)
// only binds events. Every test runs over plain payload objects, no
// process, no pi.

import { describe, expect, it } from "vitest";

import type { Api, AssistantMessage, ImageContent, Model, SystemMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	budgetOf,
	estimateProjectionTokens,
	isStarved,
	PI_OUTPUT_FLOOR,
	starvationLine,
	type StarvationFacts,
} from "../../extensions/output-starvation/guard.ts";

// A model just enough for pi's clamp: the window and the budget the model
// asks for.
const model = (contextWindow: number, maxTokens: number) => ({ contextWindow, maxTokens }) as Model<Api>;

// A context pi's estimator reads as `tokens` big: plain text at 4 chars per
// token, the estimator's own rate. The package-boundary type bridge stands
// in one place, here.
const overFullContext = (tokens: number) =>
	({ messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 0 }] }) as unknown as TranscriptContext;

describe("PI_OUTPUT_FLOOR", () => {
	it("is the value pi's own clamp floors at today", () => {
		expect(PI_OUTPUT_FLOOR).toBe(1);
	});

	it("is what pi's clamp returns for an over-full context, whatever the model asks for", () => {
		for (const maxTokens of [1, 8192, 131072]) {
			expect(clampMaxTokensToContext(model(100_000, maxTokens), overFullContext(200_000), maxTokens)).toBe(PI_OUTPUT_FLOOR);
		}
	});

	it("is below every healthy budget pi's clamp can produce", () => {
		const healthy = clampMaxTokensToContext(model(100_000, 8192), overFullContext(10_000), 8192);
		expect(healthy).toBeGreaterThan(PI_OUTPUT_FLOOR);
	});
});

describe("budgetOf", () => {
	it("reads the budget from each provider field pi writes", () => {
		expect(budgetOf({ max_tokens: 7 })).toBe(7);
		expect(budgetOf({ max_completion_tokens: 7 })).toBe(7);
		expect(budgetOf({ max_output_tokens: 7 })).toBe(7);
	});

	it("prefers the fields in pi's own order when a payload carries several", () => {
		expect(budgetOf({ max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3 })).toBe(1);
		expect(budgetOf({ max_completion_tokens: 2, max_output_tokens: 3 })).toBe(2);
	});

	it("returns undefined when the payload carries no budget", () => {
		expect(budgetOf({ temperature: 0.5 })).toBeUndefined();
		expect(budgetOf(undefined)).toBeUndefined();
		expect(budgetOf(null)).toBeUndefined();
		expect(budgetOf("max_tokens: 7")).toBeUndefined();
		expect(budgetOf(7)).toBeUndefined();
	});

	it("ignores budget fields that are not finite numbers", () => {
		expect(budgetOf({ max_tokens: "7" })).toBeUndefined();
		expect(budgetOf({ max_tokens: NaN })).toBeUndefined();
		expect(budgetOf({ max_tokens: Infinity })).toBeUndefined();
		expect(budgetOf({ max_tokens: undefined, max_completion_tokens: 4 })).toBe(4);
	});
});

describe("isStarved", () => {
	it("is true when the budget is pi's floor, on any of the provider fields", () => {
		expect(isStarved({ max_tokens: PI_OUTPUT_FLOOR })).toBe(true);
		expect(isStarved({ max_completion_tokens: PI_OUTPUT_FLOOR })).toBe(true);
		expect(isStarved({ max_output_tokens: PI_OUTPUT_FLOOR })).toBe(true);
	});

	it("is false for a healthy budget, however small", () => {
		expect(isStarved({ max_tokens: PI_OUTPUT_FLOOR + 1 })).toBe(false);
		expect(isStarved({ max_tokens: 100 })).toBe(false);
	});

	it("is false when the payload carries no budget the guard can read", () => {
		expect(isStarved({ temperature: 0.5 })).toBe(false);
		expect(isStarved(undefined)).toBe(false);
		expect(isStarved(null)).toBe(false);
	});
});

describe("estimateProjectionTokens", () => {
	// The mirror must stay line-for-line with pi-ai's own estimator, so the
	// tripwire compares it against the real function (importable here, in
	// the test process, where pi-ai's subpaths resolve) over sessions that
	// exercise every branch of the estimator.
	let clock = 0;
	const user = (content: string | ImageContent[]): UserMessage => {
		clock += 1000;
		return { role: "user", content, timestamp: clock };
	};
	const system = (content: string): SystemMessage => {
		clock += 1000;
		return { role: "system", content, timestamp: clock };
	};
	const assistant = (usage: { totalTokens: number }, stopReason: AssistantMessage["stopReason"]): AssistantMessage => {
		clock += 1000;
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
			provider: "llama.cpp",
			model: "m1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: usage.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: clock,
		};
	};

	// A summary written last and placed first: its new timestamp sits ahead
	// of the response it now precedes, which is the insertion the anchor
	// logic must see.
	const reordered: TranscriptContext["messages"] = (() => {
		const q1 = user("q1");
		const a1 = assistant({ totalTokens: 50 }, "stop");
		const q2 = user("q2");
		const summary = system("summary");
		return [summary, q1, a1, q2];
	})();

	const sessions: Array<[string, TranscriptContext["messages"]]> = [
		["empty session", []],
		[
			"one answered turn and a trailing prompt",
			[user("q1"), assistant({ totalTokens: 50 }, "stop"), user("f".repeat(400))],
		],
		[
			"two answered turns: the anchor is the last response",
			[user("q1"), assistant({ totalTokens: 50 }, "stop"), user("q2"), assistant({ totalTokens: 700 }, "stop"), user("g".repeat(200))],
		],
		[
			"an aborted response carries no anchor; an earlier one does",
			[user("q1"), assistant({ totalTokens: 50 }, "stop"), user("q2"), assistant({ totalTokens: 900 }, "aborted"), user("q3")],
		],
		[
			"an errored response carries no anchor",
			[user("q1"), assistant({ totalTokens: 50 }, "error"), user("q2")],
		],
		[
			"a zero-usage response carries no anchor",
			[user("q1"), assistant({ totalTokens: 0 }, "stop"), user("q2")],
		],
		[
			"an image rides along at the estimator's flat image cost",
			[user("q1"), user([ { type: "image", data: "aGVsbG8=", mimeType: "image/png" } ]), assistant({ totalTokens: 50 }, "stop"), user("q2")],
		],
		[
			"a response inserted before a later user message keeps its anchor; a message timestamp before it does not",
			[user("q1"), assistant({ totalTokens: 50 }, "stop"), user("q2"), assistant({ totalTokens: 60 }, "stop"), user("q3")],
		],
		[
			"a summary written later and placed first invalidates the anchor of a response before it",
			reordered,
		],
	];

	for (const [name, messages] of sessions) {
		it(`matches pi-ai's estimateContextTokens: ${name}`, () => {
			expect(estimateProjectionTokens(messages)).toBe(estimateContextTokens(messages).tokens);
		});
	}
});

describe("starvationLine", () => {
	const facts: StarvationFacts = { provider: "llama.cpp", modelId: "m1", window: 40192, estimate: 38435, budget: 1 };

	it("is one line naming provider, model, the context estimate, the Effective window, and the budget", () => {
		expect(starvationLine(facts)).toBe(
			"output starvation: refused (llama.cpp/m1): context estimate 38435, Effective window 40192, output budget 1",
		);
	});

	it("names every fact, so a report that drops one fails the test", () => {
		const line = starvationLine(facts);
		expect(line).toContain("output starvation: refused");
		expect(line).toContain("llama.cpp/m1");
		expect(line).toContain("context estimate 38435");
		expect(line).toContain("Effective window 40192");
		expect(line).toContain("output budget 1");
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\u2014");
	});
});
