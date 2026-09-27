/**
 * The output-starvation guard core (ADR 0028): the decision over one
 * provider request payload - "is this request's output budget the value pi's
 * clamp floors at?" - and the one place the report line exists.
 *
 * A request whose context is estimated over-full for its Effective window
 * leaves pi's output clamp with nothing to give: pi-ai's
 * clampMaxTokensToContext computes
 * contextWindow - estimateContextTokens(context) - 4096 and floors the
 * result at its own minimum, and the request goes out carrying that floor
 * as its max_tokens. The model then answers one token, the transcript
 * records stopReason: "length", and the agent reads a non-answer as an
 * answer. This module calls that state Output starvation and treats a
 * starved request as a failure, not as a request.
 *
 * The trigger is keyed on pi's clamp saturating, not on a threshold this
 * repo chooses (user story 9): the budget in the payload is compared to
 * pi's own floor, read back from pi's own clamp below. Any future change
 * to pi's floor is visible at this one point - this constant, the test
 * that pins it, and nothing else. A token threshold we invented would
 * silently disagree with pi whenever pi's arithmetic moves.
 *
 * The module owns the request and nothing else: it reads the payload pi has
 * already built, it never rewrites a budget, it never touches the window
 * (that is Llama refresh's ownership), and it adds no network call.
 *
 * The core is engine-free: the predicate runs over a plain payload object
 * captured from the wire, so the decision seam is testable without a
 * process. The pi wiring (index.ts) binds it to the
 * before_provider_request event and owns the refusal.
 */
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

/**
 * pi's saturated output floor: the budget clampMaxTokensToContext returns
 * when the context is estimated over-full. pi-ai keeps the constant
 * (MIN_MAX_TOKENS) module-private, so it is read back from pi's own clamp
 * through the branch that returns max(MIN_MAX_TOKENS, maxTokens): a
 * non-positive window, an empty context, and maxTokens 1 leave exactly the
 * floor, whatever value pi gives it. If pi moves the floor, this expression
 * is the one that moves.
 */
export const PI_OUTPUT_FLOOR = clampMaxTokensToContext(
	{ contextWindow: 0 } as Model<Api>,
	{ messages: [] } as unknown as TranscriptContext,
	1,
);

/**
 * The provider payload fields that carry the clamped output budget, in the
 * order pi-ai writes them: the OpenAI-compatible field (the llama.cpp
 * provider and most others), the OpenAI Responses field, and the
 * generation-config field. A payload with none of them carries no budget
 * this guard can read, and the guard stays silent.
 */
const BUDGET_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

/**
 * The clamped output budget a provider payload carries, or undefined when
 * the payload carries none. Pure: it runs over the plain object the
 * wire payload is, so a test pins it with captured payloads.
 */
export function budgetOf(payload: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	for (const field of BUDGET_FIELDS) {
		const value = record[field];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/**
 * The guard's trigger: the payload's output budget is pi's saturated
 * floor, so pi's clamp computed "no room" and the request would come back
 * as a one-token non-answer. A budget above the floor - however small -
 * is pi's arithmetic working as designed, and the guard says nothing.
 */
export function isStarved(payload: unknown): boolean {
	const budget = budgetOf(payload);
	return budget !== undefined && budget === PI_OUTPUT_FLOOR;
}

/** The facts the report line names: who, the window, the estimate, the budget. */
export interface StarvationFacts {
	/** The provider of the request's model. */
	provider: string;
	/** The id of the request's model. */
	modelId: string;
	/** The Effective window of the request's model at the moment of the request. */
	window: number;
	/** pi's context estimate for the request, in tokens. */
	estimate: number;
	/** The clamped output budget the payload carried (pi's floor). */
	budget: number;
}

/**
 * The refusal's report line. One line, in the glossary's vocabulary,
 * naming provider, model, the Effective window, the context estimate, and
 * the budget pi computed (user stories 2, 3, 16). Built here, in exactly
 * one place, so a test can assert the line verbatim.
 */
export function starvationLine(facts: StarvationFacts): string {
	return `output starvation: refused (${facts.provider}/${facts.modelId}): context estimate ${facts.estimate}, Effective window ${facts.window}, output budget ${facts.budget}`;
}
