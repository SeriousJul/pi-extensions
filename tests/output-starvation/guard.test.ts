// Unit tests for the engine-free output-starvation guard core (ADR 0028).
// The core owns the trigger - "the payload's output budget is pi's
// saturated floor" - and the one-line report; the pi wiring (index.ts)
// only binds events. Every test runs over plain payload objects, no
// process, no pi.

import { describe, expect, it } from "vitest";

import type { Api, AssistantMessage, ImageContent, Model, SystemMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext, clampThinkingBudgetToAnswerRoom, MIN_ANSWER_TOKENS } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	budgetOf,
	correctedEstimateTokens,
	decide,
	estimateProjectionTokens,
	fitLine,
	inflatedTokens,
	isStarved,
	payloadMessages,
	PI_MIN_ANSWER_TOKENS,
	PI_OUTPUT_FLOOR,
	PI_SAFETY_MARGIN,
	reportedContextTokens,
	reserveDisagreementLine,
	starvationLine,
	withBudget,
	type GuardSettings,
	type OverrunFacts,
	type ReserveFacts,
	type StarvationFacts,
	type TokenMath,
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

describe("PI_SAFETY_MARGIN", () => {
	it("is the room pi's own clamp always leaves between the estimate and the window", () => {
		// pi's clamp computes `contextWindow - estimate - CONTEXT_SAFETY_TOKENS`.
		// Reading the margin off the clamp's own output is the tripwire: if pi
		// moves the figure, the Fit would disagree with pi about the room it
		// leaves, and this is where that shows up.
		expect(clampMaxTokensToContext(model(100_000, 8192), overFullContext(90_000), 8192)).toBe(100_000 - 90_000 - PI_SAFETY_MARGIN);
	});

	it("is the same margin whatever the model asks for", () => {
		for (const maxTokens of [8192, 60_000, 131_072]) {
			expect(clampMaxTokensToContext(model(100_000, maxTokens), overFullContext(90_000), maxTokens)).toBe(100_000 - 90_000 - PI_SAFETY_MARGIN);
		}
	});

	it("is pi's 4096 today", () => {
		expect(PI_SAFETY_MARGIN).toBe(4096);
	});
});

describe("PI_MIN_ANSWER_TOKENS", () => {
	it("is pi's own minimum answer room", () => {
		expect(PI_MIN_ANSWER_TOKENS).toBe(MIN_ANSWER_TOKENS);
	});

	it("is what pi leaves for an answer when a thinking budget shares the ceiling", () => {
		expect(clampThinkingBudgetToAnswerRoom(20_000, 20_000)).toBe(20_000 - PI_MIN_ANSWER_TOKENS);
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

// ---------------------------------------------------------------------------
// The Reported context: the provider's own count, read from the session
// ---------------------------------------------------------------------------

describe("reportedContextTokens", () => {
	let clock = 0;
	const user = (content: string): UserMessage => {
		clock += 1000;
		return { role: "user", content, timestamp: clock };
	};
	const assistant = (totalTokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => {
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
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: clock,
		} as AssistantMessage;
	};

	it("is null for a session with no answered turn", () => {
		expect(reportedContextTokens([user("q1")])).toBeNull();
	});

	it("is the usage the provider reported for its last answer", () => {
		expect(reportedContextTokens([user("q1"), assistant(50), user("q2"), assistant(170_685), user("q3")])).toBe(170_685);
	});

	it("falls back to an earlier answer when the last one carries no usable usage", () => {
		// pi's own anchor rule: an aborted, errored, or zero-usage response
		// does not describe the context, so the last one that does answers.
		expect(reportedContextTokens([user("q1"), assistant(500), user("q2"), assistant(900, "aborted"), user("q3")])).toBe(500);
		expect(reportedContextTokens([user("q1"), assistant(500), user("q2"), assistant(0), user("q3")])).toBe(500);
	});
});

// ---------------------------------------------------------------------------
// The Corrected estimate: the payload read directly
// ---------------------------------------------------------------------------

const MATH: TokenMath = { bytesPerChar: 4, inflation: 2 };

/** A wire payload of the shape pi's OpenAI-compatible providers send: the
 * system prompt as a message, the tool declarations beside it, and the
 * budget the guard owns. */
const wirePayload = (messages: unknown[], extra: Record<string, unknown> = {}) =>
	({ model: "m1", messages, stream: true, max_tokens: 32_768, ...extra }) as unknown;

const wireSystem = (chars: number) => ({ role: "system", content: "s".repeat(chars) });
const wireUser = (chars: number) => ({ role: "user", content: [{ type: "text", text: "u".repeat(chars) }] });
const wireAssistant = (extra: Record<string, unknown> = {}) => ({ role: "assistant", content: "done", ...extra });
const wireTool = (chars: number) => ({ role: "tool", tool_call_id: "c1", content: "t".repeat(chars) });

describe("payloadMessages", () => {
	it("reads the messages a payload carries", () => {
		expect(payloadMessages(wirePayload([wireSystem(10), wireUser(10)]))?.length).toBe(2);
	});

	it("is null for a payload this guard cannot read", () => {
		expect(payloadMessages({ max_tokens: 100 })).toBeNull();
		expect(payloadMessages(undefined)).toBeNull();
		expect(payloadMessages({ messages: "not an array" })).toBeNull();
	});
});

describe("inflatedTokens", () => {
	it("is pi's chars/4 estimate times the Inflation factor", () => {
		expect(inflatedTokens(4000, MATH)).toBe(2000);
		expect(inflatedTokens(4001, MATH)).toBe(2001);
		expect(inflatedTokens(4000, { bytesPerChar: 4, inflation: 1 })).toBe(1000);
	});
});

describe("correctedEstimateTokens", () => {
	it("anchors at the Reported context and inflates only what follows the last answer", () => {
		// The system prompt and the earlier turns are inside the Reported
		// context: the provider already counted them, so they are not
		// estimated a second time.
		const payload = wirePayload([wireSystem(400), wireUser(400), wireAssistant(), wireTool(40_000)]);
		expect(correctedEstimateTokens(payload, 10_000, MATH)).toBe(10_000 + 20_000);
	});

	it("prefers a usage block the payload's own answer carries", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant({ usage: { total_tokens: 12_345 } }), wireTool(40_000)]);
		expect(correctedEstimateTokens(payload, 10_000, MATH)).toBe(12_345 + 20_000);
	});

	it("estimates the whole payload, tool declarations included, when no anchor applies", () => {
		const tools = [{ type: "function", function: { name: "bash", description: "d".repeat(200) } }];
		const messages = [
			wireSystem(400),
			wireUser(400),
			{ role: "assistant", content: "", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
			wireTool(800),
		];
		const chars = 400 + 400 + "bash".length + '{"command":"ls"}'.length + 800 + JSON.stringify(tools).length;
		expect(correctedEstimateTokens(wirePayload(messages, { tools }), null, MATH)).toBe(inflatedTokens(chars, MATH));
	});

	it("charges an image block at pi's own flat image cost", () => {
		const image = { role: "user", content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }] };
		const payload = wirePayload([wireSystem(400), wireAssistant(), image]);
		expect(correctedEstimateTokens(payload, 1000, MATH)).toBe(1000 + inflatedTokens(4800, MATH));
	});

	it("is the incident's figure: the provider's count plus the dense tool result, corrected", () => {
		// The session the ticket records: the provider counted 170,685, and a
		// 42,721-character tool result followed that answer. Here the trailing
		// result is 4,354 characters, which at the default math is the 172,862
		// the ticket's report line names.
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(4354)]);
		expect(correctedEstimateTokens(payload, 170_685, MATH)).toBe(172_862);
	});

	it("is null when the payload carries nothing readable, so the caller degrades", () => {
		expect(correctedEstimateTokens({ max_tokens: 32_768 }, 5_000, MATH)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

const SETTINGS: GuardSettings = {
	inflation: 2,
	bytesPerChar: 4,
	safetyMargin: PI_SAFETY_MARGIN,
	minAnswerTokens: PI_MIN_ANSWER_TOKENS,
};

describe("decide", () => {
	it("refuses a budget at pi's floor as Output starvation, and leaves the payload alone", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(4000)], { max_tokens: PI_OUTPUT_FLOOR });
		const decision = decide({ payload, window: 200_000, reportedContext: 1000, projectionEstimate: 12_345, settings: SETTINGS });
		expect(decision.outcome).toBe("starved");
		// The starvation line keeps naming pi's own figure, exactly as ADR 0028
		// has it: the trigger is pi's clamp, not the guard's estimate.
		expect(decision.estimate).toBe(12_345);
		expect(decision.budget).toBe(PI_OUTPUT_FLOOR);
		expect(decision.payload).toBe(payload);
	});

	it("stays silent for a payload that carries no budget", () => {
		const payload = { model: "m1", messages: [], temperature: 0.5 } as unknown;
		const decision = decide({ payload, window: 200_000, reportedContext: 1000, projectionEstimate: 1000, settings: SETTINGS });
		expect(decision.outcome).toBe("silent");
		expect(decision.budget).toBeNull();
		expect(decision.payload).toBe(payload);
	});

	it("stays silent when there is no Effective window to judge against", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(40_000)], { max_tokens: 32_768 });
		const decision = decide({ payload, window: 0, reportedContext: 170_000, projectionEstimate: 190_000, settings: SETTINGS });
		expect(decision.outcome).toBe("silent");
		expect(decision.payload).toBe(payload);
	});

	it("stays silent while the budget fits the room the Corrected estimate leaves", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(1000)], { max_tokens: 20_000 });
		const decision = decide({ payload, window: 200_000, reportedContext: 1000, projectionEstimate: 1500, settings: SETTINGS });
		expect(decision.outcome).toBe("silent");
		expect(decision.estimate).toBe(1500);
		expect(decision.payload).toBe(payload);
	});

	it("fits the incident's request to the room the Corrected estimate leaves", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(4354)], { max_tokens: 32_768 });
		const decision = decide({ payload, window: 200_000, reportedContext: 170_685, projectionEstimate: 162_182, settings: SETTINGS });
		expect(decision.outcome).toBe("fit");
		expect(decision.estimate).toBe(172_862);
		expect(decision.budget).toBe(32_768);
		// 200000 - 172862 - 4096: the ticket's fitted budget.
		expect(decision.fitted).toBe(23_042);
		const sent = decision.payload as { max_tokens: number; model: string; messages: unknown[]; stream: boolean };
		expect(sent.max_tokens).toBe(23_042);
		// The Fit owns one field of the payload and nothing else.
		expect(sent.model).toBe("m1");
		expect(sent.stream).toBe(true);
		expect(sent.messages.length).toBe(3);
	});

	it("refuses rather than fits when the room left cannot hold any real answer", () => {
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(60_022)], { max_tokens: 32_768 });
		const decision = decide({ payload, window: 200_000, reportedContext: 170_000, projectionEstimate: 186_000, settings: SETTINGS });
		expect(decision.outcome).toBe("overrun");
		expect(decision.estimate).toBe(200_011);
		expect(decision.fitted).toBeNull();
		expect(decision.payload).toBe(payload);
	});

	it("refuses rather than fits when the fit would fall under the minimum answer budget", () => {
		// A reasoning operator raises minAnswerTokens so a fit never leaves
		// less than thinking plus a usable reply; the same branch refuses.
		const payload = wirePayload([wireSystem(400), wireAssistant(), wireTool(4354)], { max_tokens: 32_768 });
		const roomy = decide({ payload, window: 200_000, reportedContext: 170_685, projectionEstimate: 162_182, settings: SETTINGS });
		expect(roomy.outcome).toBe("fit");
		const tight = decide({
			payload,
			window: 200_000,
			reportedContext: 170_685,
			projectionEstimate: 162_182,
			settings: { ...SETTINGS, minAnswerTokens: 24_000 },
		});
		expect(tight.outcome).toBe("overrun");
	});

	it("degrades to pi's own estimate when the payload carries nothing readable", () => {
		const payload = { model: "m1", max_tokens: 32_768 } as unknown;
		const decision = decide({ payload, window: 200_000, reportedContext: null, projectionEstimate: 190_000, settings: SETTINGS });
		expect(decision.outcome).toBe("fit");
		expect(decision.estimate).toBe(190_000);
		expect(decision.fitted).toBe(200_000 - 190_000 - PI_SAFETY_MARGIN);
	});

	it("never sends a budget below pi's floor", () => {
		const payload = wirePayload([wireSystem(0), wireAssistant()], { max_tokens: 5 });
		const decision = decide({
			payload,
			window: 1000,
			reportedContext: 1000,
			projectionEstimate: 1000,
			settings: { inflation: 2, bytesPerChar: 4, safetyMargin: 0, minAnswerTokens: 0 },
		});
		expect(decision.outcome).toBe("fit");
		expect(decision.fitted).toBe(PI_OUTPUT_FLOOR);
	});

	it("writes whichever budget field the payload carries", () => {
		for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
			const payload = { model: "m1", messages: [wireSystem(400), wireAssistant(), wireTool(4354)], stream: true, [field]: 32_768 } as unknown;
			const decision = decide({ payload, window: 200_000, reportedContext: 170_685, projectionEstimate: 162_182, settings: SETTINGS });
			expect(decision.outcome).toBe("fit");
			expect((decision.payload as Record<string, unknown>)[field]).toBe(23_042);
		}
	});
});

describe("withBudget", () => {
	it("never raises a budget: a payload already at or under the figure is returned untouched", () => {
		const at = { max_tokens: 100 };
		expect(withBudget(at, 5_000)).toBe(at);
		const equal = { max_tokens: 100 };
		expect(withBudget(equal, 100)).toBe(equal);
	});

	it("leaves a payload with no readable budget untouched", () => {
		const none = { temperature: 0.5 };
		expect(withBudget(none, 10)).toBe(none);
	});

	it("changes one field and keeps the rest of the payload", () => {
		const payload = { model: "m1", messages: [{ role: "user", content: "q" }], max_completion_tokens: 8000, temperature: 0.3 };
		const fitted = withBudget(payload, 1234) as Record<string, unknown>;
		expect(fitted.max_completion_tokens).toBe(1234);
		expect(fitted.max_tokens).toBeUndefined();
		expect(fitted.model).toBe("m1");
		expect(fitted.temperature).toBe(0.3);
		expect(payload.max_completion_tokens).toBe(8000);
	});
});

// ---------------------------------------------------------------------------
// The report lines
// ---------------------------------------------------------------------------

describe("fitLine", () => {
	const facts: OverrunFacts = { provider: "strata", modelId: "model", window: 200_000, estimate: 172_862, budget: 32_768, fitted: 23_042 };

	it("is one line naming the Corrected estimate, the Effective window, and the budget it fitted", () => {
		expect(fitLine(facts)).toBe(
			"output overrun: fitted budget (strata/model): context estimate 172862, Effective window 200000, output budget 32768 -> 23042",
		);
	});

	it("is one line, and never an em dash", () => {
		const line = fitLine(facts);
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\u2014");
	});
});

describe("the two refusals read as one line", () => {
	const overrunFacts: OverrunFacts = { provider: "llama.cpp", modelId: "m1", window: 200_000, estimate: 200_011, budget: 9_042 };

	it("refuses an overrun that leaves no answer room with the line the collapsed budget is refused with", () => {
		// The spec's rule: this branch refuses exactly as the guard refuses
		// today, so the transcript carries one refusal shape to learn.
		expect(starvationLine(overrunFacts)).toBe(
			"output starvation: refused (llama.cpp/m1): context estimate 200011, Effective window 200000, output budget 9042",
		);
	});

	it("tells the two refusals apart by the figures it names, not by new words", () => {
		// Output starvation names pi's floor as the budget; Output overrun
		// names the budget pi chose and an estimate the window cannot pay for.
		const starved = starvationLine({ ...overrunFacts, estimate: 162_182, budget: PI_OUTPUT_FLOOR });
		expect(starved).toContain(`output budget ${PI_OUTPUT_FLOOR}`);
		expect(starvationLine(overrunFacts)).not.toContain(`output budget ${PI_OUTPUT_FLOOR}`);
		// And neither refusal line is the fit line: a Fit is reported as what
		// it is, and an operator who sees one reads both.
		expect(fitLine({ ...overrunFacts, fitted: 23_042 })).toContain("output overrun: fitted budget");
		expect(fitLine({ ...overrunFacts, fitted: 23_042 })).not.toContain("refused");
	});
});

describe("reserveDisagreementLine", () => {
	const facts: ReserveFacts = { provider: "strata", modelId: "model", reserve: 16_384, ceiling: 32_768 };

	it("names both figures and the setting to change, once, in one line", () => {
		expect(reserveDisagreementLine(facts)).toBe(
			"output starvation: reserve disagreement (strata/model): compaction reserve 16384, model output ceiling 32768; set compaction.reserveTokens to 32768 or more",
		);
	});

	it("changes nothing in its own words: it names a setting, it does not write one", () => {
		const line = reserveDisagreementLine(facts);
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\u2014");
		expect(line).toContain("compaction.reserveTokens");
	});
});
