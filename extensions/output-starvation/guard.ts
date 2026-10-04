/**
 * The output-starvation guard core (ADR 0028): the decision over one
 * provider request payload, and the one place the guard's report lines
 * exist.
 *
 * The guard judges the payload pi has already built, which is the exact
 * thing going out: its messages, its system prompt, its tool declarations,
 * and its output budget. Two states can be wrong there, and the guard
 * answers each in its own way.
 *
 * Output starvation. pi-ai's `clampMaxTokensToContext` computes
 * `contextWindow - estimateContextTokens(context) - 4096` and floors the
 * result at its own minimum, so an estimate over the window minus that
 * margin leaves the clamp nothing to give: the request goes out carrying
 * that floor as its `max_tokens`, the model answers one token, the
 * transcript records `stopReason: "length"`, and the agent reads a
 * non-answer as an answer. The guard refuses that request (ADR 0028).
 *
 * Output overrun. The opposite state: the payload carries an output budget
 * the Effective window cannot pay for, on the estimate the provider's own
 * counting supports. The provider rejects the whole request rather than
 * answering it. The guard applies a Fit: it lowers the payload's budget to
 * the room the Corrected estimate leaves, and the request goes out and gets
 * answered instead of being rejected. The Corrected estimate is the figure
 * pi's arithmetic is missing: it anchors at the Reported context (the
 * prompt size the provider itself counted for its last answer) and adds an
 * Inflation-corrected estimate of everything the provider has not counted
 * yet. It is the same correction Output limits and Safe branch summary
 * apply to pi's chars/4 estimate, applied to the request instead of to a
 * tool result.
 *
 * Both triggers are keyed on pi's own arithmetic, not on thresholds this
 * repo chooses (user story 9): the floor, the clamp's safety margin, and
 * the answer room pi itself insists on are pinned as the constants below,
 * and the tests that pin them against pi's own code are the tripwire. A
 * figure invented here would silently disagree with pi whenever pi's
 * arithmetic moves.
 *
 * The module owns the request and nothing else: it reads the payload pi has
 * already built, it never raises a budget, it never touches the window
 * (that is Llama refresh's ownership), and it adds no network call.
 *
 * The core is engine-free: the decision runs over a plain payload object
 * captured from the wire, so the decision seam is testable without a
 * process. The pi wiring (index.ts) binds it to the before_provider_request
 * event and owns the notice, the refusal, and the abort.
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
 * pi's own safety margin: the tokens pi's clamp always leaves for the
 * answer, `CONTEXT_SAFETY_TOKENS` in pi-ai's `api/simple-options` (pi
 * 0.87.1). The Fit spends the same margin pi spends, because a margin
 * invented here would silently disagree with pi whenever pi's arithmetic
 * moves; the unit test pins this constant against pi's own clamp the way
 * the floor is pinned.
 */
export const PI_SAFETY_MARGIN = 4096;

/**
 * pi's own minimum answer room: `MIN_ANSWER_TOKENS` in pi-ai's
 * `api/simple-options` (pi 0.87.1), the tokens pi always leaves for an
 * answer when a thinking budget shares the response ceiling. It is the
 * default for the guard's `minAnswerTokens` setting, and the unit test
 * pins it against pi's own constant.
 */
export const PI_MIN_ANSWER_TOKENS = 1024;

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
 * The payload with its output budget lowered to `budget`. The Fit writes
 * the same field the guard already reads, whichever one the payload
 * carries, and no other field. It never raises a budget: a caller that
 * asks for more than the payload carries gets the payload unchanged.
 */
export function withBudget(payload: unknown, budget: number): unknown {
	const current = budgetOf(payload);
	if (current === undefined || budget >= current) return payload;
	const record = payload as Record<string, unknown>;
	const field = BUDGET_FIELDS.find((name) => typeof record[name] === "number" && Number.isFinite(record[name] as number));
	if (field === undefined) return payload;
	return { ...record, [field]: budget };
}

/**
 * The guard's first trigger: the payload's output budget is pi's saturated
 * floor, so pi's clamp computed "no room" and the request would come back
 * as a one-token non-answer. A budget above the floor - however small - is
 * pi's arithmetic working as designed, and the guard says nothing.
 */
export function isStarved(payload: unknown): boolean {
	const budget = budgetOf(payload);
	return budget !== undefined && budget === PI_OUTPUT_FLOOR;
}

// ---------------------------------------------------------------------------
// pi's estimator, mirrored: the figure pi's clamp reads
// ---------------------------------------------------------------------------

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
 * pi's usage anchor over the projected messages: the last assistant
 * response whose usage still describes its prefix - a message inserted
 * after the response, such as a compaction summary, moves the anchor back
 * to an earlier response - and the index it sits at.
 */
function usageAnchor(messages: readonly Message[]): { usage: Usage; index: number } | null {
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
	return usage === undefined ? null : { usage, index: usageIndex };
}

/**
 * pi's estimate of the context a request would carry, over the projected
 * messages. Anchored at the last assistant usage block that still
 * describes its prefix plus a character estimate of the messages after
 * it. Returns the same figure pi's clamp reads, or a plain character
 * estimate when no usage block applies.
 */
export function estimateProjectionTokens(messages: readonly Message[]): number {
	const anchor = usageAnchor(messages);
	if (anchor !== null) {
		let trailing = 0;
		for (let i = anchor.index + 1; i < messages.length; i++) trailing += messageEstimate(messages[i]);
		return usageTokens(anchor.usage) + trailing;
	}
	let tokens = 0;
	for (const message of messages) tokens += messageEstimate(message);
	return tokens;
}

/**
 * The Reported context of a session projection: the prompt size the
 * provider itself counted for the last answer it gave, read from that
 * answer's usage block through pi's own anchor rule. Null when no usage
 * block applies, which is what a fresh session looks like before its first
 * answer.
 *
 * The wire payload carries no usage block: pi's provider converts an
 * assistant message to `{role, content, tool_calls}` on the way out, so
 * the provider's own count lives only in the session entry pi stored for
 * that answer. The guard reads it there and applies it to the payload.
 */
export function reportedContextTokens(messages: readonly Message[]): number | null {
	const anchor = usageAnchor(messages);
	return anchor === null ? null : usageTokens(anchor.usage);
}

// ---------------------------------------------------------------------------
// The payload, read directly: the Corrected estimate
// ---------------------------------------------------------------------------

/** The token math the guard estimates with: pi's rate, Inflation-corrected. */
export interface TokenMath {
	/** The characters per token pi's own estimate assumes. */
	bytesPerChar: number;
	/** The Inflation factor on pi's chars/4 estimate. */
	inflation: number;
}

/** pi's chars/4 estimate of a byte count, corrected by the Inflation factor. */
export function inflatedTokens(chars: number, math: TokenMath): number {
	return Math.ceil((chars * math.inflation) / math.bytesPerChar);
}

/** The characters one content block of a wire message contributes. */
function wireBlockChars(block: unknown): number {
	if (typeof block === "string") return block.length;
	if (typeof block !== "object" || block === null) return 0;
	const record = block as Record<string, unknown>;
	if (record.type === "image" || record.type === "image_url") return ESTIMATED_IMAGE_CHARS;
	for (const key of ["text", "thinking", "reasoning", "input"]) {
		const value = record[key];
		if (typeof value === "string") return value.length;
	}
	return safeJsonStringify(record).length;
}

/** The characters one tool call of a wire assistant message contributes. */
function wireToolCallChars(call: unknown): number {
	if (typeof call !== "object" || call === null) return 0;
	const record = call as Record<string, unknown>;
	const fn = typeof record.function === "object" && record.function !== null ? (record.function as Record<string, unknown>) : record;
	let chars = 0;
	if (typeof fn.name === "string") chars += fn.name.length;
	const args = fn.arguments;
	if (typeof args === "string") chars += args.length;
	else if (args !== undefined && args !== null) chars += safeJsonStringify(args).length;
	return chars;
}

/** The characters one wire message contributes, in pi-ai's counting shape. */
function wireMessageChars(message: unknown): number {
	if (typeof message === "string") return message.length;
	if (typeof message !== "object" || message === null) return 0;
	const record = message as Record<string, unknown>;
	let chars = 0;
	const content = record.content;
	if (typeof content === "string") {
		chars += content.length;
	} else if (Array.isArray(content)) {
		for (const block of content) chars += wireBlockChars(block);
	} else if (content !== undefined && content !== null) {
		chars += safeJsonStringify(content).length;
	}
	if (Array.isArray(record.tool_calls)) {
		for (const call of record.tool_calls) chars += wireToolCallChars(call);
	}
	if (typeof record.name === "string") chars += record.name.length;
	return chars;
}

/** The messages a provider payload carries, or null when it carries none
 * this guard can read. */
export function payloadMessages(payload: unknown): readonly unknown[] | null {
	if (typeof payload !== "object" || payload === null) return null;
	const messages = (payload as Record<string, unknown>).messages;
	return Array.isArray(messages) ? (messages as readonly unknown[]) : null;
}

/** The index of the last assistant answer in the payload's messages, or -1
 * when the payload carries none. */
function lastAnswerIndex(messages: readonly unknown[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant") return i;
	}
	return -1;
}

/**
 * A usage block a payload message carries, in pi-ai's own arithmetic.
 * pi's providers strip usage off the wire, so this reads nothing today;
 * it stands so a payload that does carry its own Reported context is
 * judged on it rather than on a session figure.
 */
function payloadUsageTokens(message: unknown): number | null {
	if (typeof message !== "object" || message === null) return null;
	const usage = (message as Record<string, unknown>).usage;
	if (typeof usage !== "object" || usage === null) return null;
	const record = usage as Record<string, unknown>;
	for (const key of ["totalTokens", "total_tokens"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	let total = 0;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "prompt_tokens", "completion_tokens"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) total += value;
	}
	return total > 0 ? total : null;
}

/**
 * The Corrected estimate of the request a payload would carry: the
 * Reported context the provider counted for its last answer, plus an
 * Inflation-corrected estimate of everything the provider has not counted
 * yet - the payload's messages after that answer.
 *
 * The anchor is a usage block on the payload's own last answer when it
 * carries one, else the Reported context the wiring read from the session.
 * With no anchor at all, the whole payload is estimated with the same
 * correction, tool declarations included, which is the fresh-session case:
 * nothing has been counted yet, so everything is trailing.
 *
 * Returns null when the payload carries no messages the guard can read;
 * the caller then falls back to pi's own estimate rather than making an
 * unfamiliar payload worse.
 */
export function correctedEstimateTokens(payload: unknown, reportedContext: number | null, math: TokenMath): number | null {
	const messages = payloadMessages(payload);
	if (messages === null) return null;
	const anchorIndex = lastAnswerIndex(messages);
	const carried = anchorIndex >= 0 ? payloadUsageTokens(messages[anchorIndex]) : null;
	const reported = carried ?? (reportedContext !== null && Number.isFinite(reportedContext) && reportedContext > 0 ? reportedContext : null);
	if (reported !== null) {
		let trailingChars = 0;
		for (let i = anchorIndex + 1; i < messages.length; i++) trailingChars += wireMessageChars(messages[i]);
		return reported + inflatedTokens(trailingChars, math);
	}
	let chars = 0;
	for (const message of messages) chars += wireMessageChars(message);
	const tools = (payload as Record<string, unknown>).tools;
	if (Array.isArray(tools)) chars += safeJsonStringify(tools).length;
	return inflatedTokens(chars, math);
}

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

/** The settings the decision reads. */
export interface GuardSettings extends TokenMath {
	/** pi's clamp safety margin: the room the Fit leaves unbudgeted. */
	safetyMargin: number;
	/** The smallest answer budget the guard will send. Below it, the guard
	 * refuses instead of fitting, because the answer would be a non-answer. */
	minAnswerTokens: number;
}

export interface GuardInput {
	/** The payload pi built, exactly as the hook received it. */
	payload: unknown;
	/** The Effective window of the request's model, or 0 when the session
	 * carries no model to judge against. */
	window: number;
	/** The Reported context, or null when the session has no usage anchor. */
	reportedContext: number | null;
	/** pi's own estimate over the session projection: the figure the guard
	 * degrades to when the payload carries nothing it can read. */
	projectionEstimate: number;
	settings: GuardSettings;
}

export type GuardOutcome =
	/** Nothing the guard owns is wrong: the request goes out as pi built it. */
	| "silent"
	/** Output starvation: the budget is pi's floor. Refuse (ADR 0028). */
	| "starved"
	/** Output overrun: the budget is fitted downward. */
	| "fit"
	/** Output overrun with no answer room left: refuse, and report it with
	 * the same line the collapsed budget is refused with - the spec's rule
	 * is that this branch refuses exactly as the guard refuses today. */
	| "overrun";

export interface GuardDecision {
	outcome: GuardOutcome;
	/** The context estimate the decision judged: the Corrected estimate, or
	 * pi's own figure where the guard degrades to it. */
	estimate: number;
	/** The output budget the payload carried, or null when it carried none. */
	budget: number | null;
	/** The budget the Fit chose; null for every other outcome. */
	fitted: number | null;
	/** What to send: the payload with its budget fitted, else the payload
	 * exactly as it arrived. */
	payload: unknown;
}

/**
 * The decision table over one payload, in this order:
 *
 * 1. the budget is pi's floor: Output starvation, refuse (unchanged, ADR 0028);
 * 2. the budget exceeds the room the Corrected estimate leaves in the
 *    Effective window, and that room minus pi's safety margin still clears
 *    the minimum answer budget: Output overrun, Fit downward, report one line;
 * 3. the budget exceeds the room and the margin leaves less than the minimum
 *    answer budget: refuse, because no answer fits. This branch refuses the
 *    way the first one does, and is reported with the same line; the figures
 *    it names (a budget above pi's floor, an estimate over the window) are
 *    what tell it from Output starvation.
 *
 * The Fit never raises a budget and never goes below pi's floor. A payload
 * with no readable budget, and a session with no window to judge against,
 * leave the request alone: the guard only ever refuses the collapsed budget
 * it can name.
 */
export function decide(input: GuardInput): GuardDecision {
	const budget = budgetOf(input.payload);
	if (budget === undefined) {
		return { outcome: "silent", estimate: input.projectionEstimate, budget: null, fitted: null, payload: input.payload };
	}
	if (budget === PI_OUTPUT_FLOOR) {
		return { outcome: "starved", estimate: input.projectionEstimate, budget, fitted: null, payload: input.payload };
	}
	if (!(input.window > 0)) {
		return { outcome: "silent", estimate: input.projectionEstimate, budget, fitted: null, payload: input.payload };
	}
	const estimate = correctedEstimateTokens(input.payload, input.reportedContext, input.settings) ?? input.projectionEstimate;
	const room = input.window - estimate;
	if (budget <= room) {
		return { outcome: "silent", estimate, budget, fitted: null, payload: input.payload };
	}
	const answerRoom = room - input.settings.safetyMargin;
	if (answerRoom < input.settings.minAnswerTokens) {
		return { outcome: "overrun", estimate, budget, fitted: null, payload: input.payload };
	}
	const fitted = Math.max(PI_OUTPUT_FLOOR, Math.min(answerRoom, budget));
	return { outcome: "fit", estimate, budget, fitted, payload: withBudget(input.payload, fitted) };
}

// ---------------------------------------------------------------------------
// The report lines
// ---------------------------------------------------------------------------

/** The facts the starvation refusal names: who, the window, the estimate, the budget. */
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
 * A refusal's report line. One line, in the glossary's vocabulary,
 * naming provider, model, the Effective window, the context estimate, and
 * the budget the payload carried (user stories 2, 3, 16). Built here, in
 * exactly one place, so a test can assert the line verbatim.
 *
 * Both refusal branches share this line: the collapsed budget (Output
 * starvation) and the overrun whose room cannot hold an answer are refused
 * the same way and read the same way, and the figures they name tell them
 * apart - the first names pi's floor as the budget, the second names the
 * budget pi chose and a Corrected estimate the window cannot pay for.
 */
export function starvationLine(facts: StarvationFacts): string {
	return `output starvation: refused (${facts.provider}/${facts.modelId}): context estimate ${facts.estimate}, Effective window ${facts.window}, output budget ${facts.budget}`;
}

/** The facts an overrun names: who, the window, the Corrected estimate,
 * the budget the payload carried, and the budget the Fit chose. */
export interface OverrunFacts extends StarvationFacts {
	/** The budget the Fit chose; absent on a refusal, where no budget fits. */
	fitted?: number;
}

/**
 * The Fit's report line: one line naming the Effective window, the
 * Corrected estimate, and the budget the payload carried against the budget
 * the guard sent (user stories 5, 6, 16). Built here, in exactly one place.
 */
export function fitLine(facts: OverrunFacts): string {
	return `output overrun: fitted budget (${facts.provider}/${facts.modelId}): context estimate ${facts.estimate}, Effective window ${facts.window}, output budget ${facts.budget} -> ${facts.fitted}`;
}

/** The facts the reserve disagreement names: who, pi's effective reserve,
 * and the model's output ceiling. */
export interface ReserveFacts {
	provider: string;
	modelId: string;
	/** pi's effective `compaction.reserveTokens` for this model. */
	reserve: number;
	/** The model's output ceiling. */
	ceiling: number;
}

/**
 * The once-per-session notice that pi's compaction reserve sits below the
 * model's output ceiling, so pi's own threshold permits a prompt the
 * provider must reject. It names the setting to change and changes nothing
 * (user story 17): the reserve is pi's setting, and the Effective window
 * stays Llama refresh's and Context cap's ownership.
 */
export function reserveDisagreementLine(facts: ReserveFacts): string {
	return `output starvation: reserve disagreement (${facts.provider}/${facts.modelId}): compaction reserve ${facts.reserve}, model output ceiling ${facts.ceiling}; set compaction.reserveTokens to ${facts.ceiling} or more`;
}
