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
 * pi's own floor, pinned as the constant below. Any future change to
 * pi's floor is visible at this one point - the constant, the test that
 * pins it, and nothing else. A token threshold we invented would
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
import {
	getSystemMessageText,
	type ImageContent,
	type Message,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";

/**
 * pi's saturated output floor: the budget pi's clamp
 * (clampMaxTokensToContext) returns when the context is estimated
 * over-full. The clamp floors its result at pi-ai's private
 * MIN_MAX_TOKENS, which is 1 in pi 0.87.1. The clamp's own module is not
 * importable from an extension - pi's extension loader aliases only the
 * package entry points, and its alias for the pi-ai entry swallows every
 * pi-ai subpath - so the floor is pinned to the value pi 0.87.1 gives it,
 * and the unit test pins this constant against pi's own clamp. If pi moves
 * the floor, that test is the tripwire.
 */
export const PI_OUTPUT_FLOOR = 1;

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

/**
 * A mirror of pi-ai's estimateContextTokens - the exact estimator pi's
 * output clamp reads when it builds the payload this guard judges. The
 * function itself is not importable from an extension (the same loader
 * rule that pins PI_OUTPUT_FLOOR above), so this mirror stands in its
 * place. It must stay line-for-line with pi-ai's estimateContextTokens
 * and estimateMessageTokens (pi-ai 0.87.1, utils/estimate.ts); the unit
 * test that compares the mirror against the real function over fixture
 * sessions is the tripwire. The constants are pi-ai's, not this repo's.
 */
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTextAndImageContentChars(content: string | readonly (TextContent | ImageContent)[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

function estimateToolsTokens(tools: unknown): number {
	if (!tools || (tools as { length: number }).length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

/** One projected message, in pi-ai's own per-message arithmetic. */
function messageEstimate(message: Message): number {
	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user" || message.role === "toolResult") {
		return Math.ceil(estimateTextAndImageContentChars(message.content) / CHARS_PER_TOKEN);
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The token total a usage block reports, in pi-ai's own arithmetic. */
function usageTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * pi's estimate of the context a request would carry, over the projected
 * messages. Anchored at the last assistant usage block that still
 * describes its prefix - a message inserted after the response, such as a
 * compaction summary, moves the anchor back to an earlier response - plus
 * a character estimate of the messages after it. Returns the same figure
 * pi's clamp reads, or a plain character estimate when no usage block
 * applies.
 */
export function estimateProjectionTokens(messages: readonly Message[]): number {
	let usage: Usage | undefined;
	let usageIndex = -1;
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (
			message.role === "assistant" &&
			message.timestamp >= latestPrefixTimestamp &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			usageTokens(message.usage) > 0
		) {
			usage = message.usage;
			usageIndex = i;
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	if (usage !== undefined) {
		let trailing = 0;
		for (let i = usageIndex + 1; i < messages.length; i++) trailing += messageEstimate(messages[i]);
		return usageTokens(usage) + trailing;
	}
	let tokens = 0;
	for (const message of messages) tokens += messageEstimate(message);
	return tokens;
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
