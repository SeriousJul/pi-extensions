// Unit tests for the engine-free output-starvation guard core (ADR 0028).
// The core owns the trigger - "the payload's output budget is pi's
// saturated floor" - and the one-line report; the pi wiring (index.ts)
// only binds events. Every test runs over plain payload objects, no
// process, no pi.

import { describe, expect, it } from "vitest";

import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { budgetOf, isStarved, PI_OUTPUT_FLOOR, starvationLine, type StarvationFacts } from "../../extensions/output-starvation/guard.ts";

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
