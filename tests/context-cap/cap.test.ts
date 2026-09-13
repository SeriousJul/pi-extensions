import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { cappedModelConfigs, clampModelWindow, parseCap } from "../../extensions/context-cap/cap";

function model(partial: Partial<Model<any>> & { id: string; provider: string }): Model<Api> {
	return {
		name: partial.id,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128000,
		maxTokens: 8192,
		...partial,
	} as Model<Api>;
}

describe("parseCap", () => {
	it("accepts a positive integer", () => {
		expect(parseCap("32000")).toEqual({ ok: true, cap: 32000 });
	});

	it("trims surrounding whitespace", () => {
		expect(parseCap("  32000  ")).toEqual({ ok: true, cap: 32000 });
	});

	it.each(["", "abc", "0", "-5", "1.5", "1e6", "99999999999999999999"])(
		"rejects %j",
		(raw) => {
			const result = parseCap(raw);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("positive integer");
		},
	);
});

describe("cappedModelConfigs", () => {
	it("omits providers whose models all fit under the cap", () => {
		const configs = cappedModelConfigs(
			[model({ id: "small", provider: "p1" }), model({ id: "tiny", provider: "p2", contextWindow: 8000 })],
			32000,
		);
		expect(configs.has("p1")).toBe(true);
		expect(configs.has("p2")).toBe(false);
	});

	it("includes the full model list of a provider when one model exceeds the cap", () => {
		const configs = cappedModelConfigs(
			[
				model({ id: "big", provider: "p1", contextWindow: 200000 }),
				model({ id: "small", provider: "p1", contextWindow: 8000 }),
			],
			32000,
		);
		const list = configs.get("p1");
		expect(list?.map((entry) => entry.id).sort()).toEqual(["big", "small"]);
		expect(list?.find((entry) => entry.id === "big")?.contextWindow).toBe(32000);
		expect(list?.find((entry) => entry.id === "small")?.contextWindow).toBe(8000);
	});

	it("carries every model field into the replacement definition", () => {
		const source = model({
			id: "rich",
			provider: "p1",
			name: "Rich Model",
			contextWindow: 200000,
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: { minimal: null, low: "low" },
			samplingParams: { temperature: 0.3 },
			headers: { "x-beta": "on" },
		});
		const [config] = cappedModelConfigs([source], 32000).get("p1") ?? [];
		expect(config).toEqual({
			id: "rich",
			name: "Rich Model",
			api: source.api,
			baseUrl: source.baseUrl,
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: "low" },
			input: ["text", "image"],
			cost: source.cost,
			contextWindow: 32000,
			maxTokens: 8192,
			samplingParams: { temperature: 0.3 },
			headers: { "x-beta": "on" },
			compat: undefined,
		});
	});

	it("never grows a window below the cap", () => {
		const [config] = cappedModelConfigs([model({ id: "tiny", provider: "p1", contextWindow: 8000 })], 32000).get(
			"p1",
		) ?? [];
		// p1 has no model above the cap, so it is omitted entirely.
		expect(config).toBeUndefined();
	});
});

describe("clampModelWindow", () => {
	it("clamps a model above the cap and reports the change", () => {
		const m = model({ id: "a", provider: "p", contextWindow: 200000 });
		expect(clampModelWindow(m, 32000)).toBe(true);
		expect(m.contextWindow).toBe(32000);
	});

	it("leaves a model under the cap untouched", () => {
		const m = model({ id: "a", provider: "p", contextWindow: 8000 });
		expect(clampModelWindow(m, 32000)).toBe(false);
		expect(m.contextWindow).toBe(8000);
	});

	it("tolerates an undefined model", () => {
		expect(clampModelWindow(undefined, 32000)).toBe(false);
	});

	it("is idempotent after a clamp", () => {
		const m = model({ id: "a", provider: "p", contextWindow: 200000 });
		clampModelWindow(m, 32000);
		expect(clampModelWindow(m, 32000)).toBe(false);
	});
});
