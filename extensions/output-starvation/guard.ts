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
 * Two rules hold that the trigger names do not carry. The Fit lowers the
 * thinking budget that shared the ceiling, by pi's own room rule, so a
 * fitted request never carries a reasoning budget above its own ceiling. And
 * a refusal needs an anchor: with no Reported context to start from, the
 * estimate is the guard's own guess over the payload, and the guard never
 * aborts a turn on its own guess - it Fits when the guess leaves room and
 * stays silent when it does not.
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
 * (that is Llama refresh's ownership), and it adds no network call. It reads
 * the session only when the payload alone does not prove the request has
 * room: the session behind a request is handed to the decision as a thunk,
 * so a healthy request never rebuilds pi's session projection.
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
import { PI_CHARS_PER_TOKEN, PI_IMAGE_CHARGE_BYTES, type TokenMath, tokensFromBytes } from "../shared/token-math.ts";

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
 * The payload fields that carry a thinking (reasoning) budget alongside the
 * response ceiling. pi writes `thinking_token_budget` for any provider whose
 * compat says `supportsThinkingTokenBudget`, or under the compat's own
 * `thinkingTokenBudgetField` name; `thinking_budget` and `reasoning_budget`
 * are the names the same idea reaches other OpenAI-compatible servers with.
 * The chat-template kwargs (`chat_template_kwargs`, `chat_template_args`) and
 * Anthropic's nested `thinking.budget_tokens` carry it in their own shapes,
 * and every one of them shares the ceiling the Fit lowers.
 */
const THINKING_BUDGET_FIELDS = ["thinking_token_budget", "thinking_budget", "reasoning_budget"];
const THINKING_KWARG_FIELDS = ["chat_template_kwargs", "chat_template_args"];

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
 * pi's own rule for a thinking budget that shares a response ceiling:
 * `clampThinkingBudgetToAnswerRoom` in pi-ai's `api/simple-options` (pi
 * 0.87.1), `min(budget, max(0, ceiling - MIN_ANSWER_TOKENS))`. pi applies it
 * when it builds the payload; the Fit applies the same rule after it lowers
 * the ceiling, so a fitted request never carries a reasoning budget above
 * its own ceiling - the pair pi's clamp exists to stop, which some servers
 * reject outright and others answer with nothing. On the incident's figures
 * that is the difference between a `high` thinking budget of 16,384 and the
 * 15,873 ceiling the Fit chose.
 */
function thinkingRoom(ceiling: number): number {
	return Math.max(0, ceiling - PI_MIN_ANSWER_TOKENS);
}

/**
 * The payload with its output budget lowered to `budget`, and with any
 * thinking budget that shared the old ceiling lowered to the room the new
 * one leaves. The Fit writes the budget field the payload carries, whichever
 * one it is, and the thinking fields that share it, and no other field. It
 * never raises anything: a payload already inside the figures is returned
 * untouched, and a thinking budget left with no room at all is dropped, the
 * way pi drops it when its own clamp leaves it none.
 */
export function withBudget(payload: unknown, budget: number): unknown {
	const current = budgetOf(payload);
	if (current === undefined || budget >= current) return payload;
	const record = payload as Record<string, unknown>;
	const field = BUDGET_FIELDS.find((name) => typeof record[name] === "number" && Number.isFinite(record[name] as number));
	if (field === undefined) return payload;
	return withThinkingRoom({ ...record, [field]: budget }, budget);
}

/** The payload with its thinking budgets clamped inside `ceiling`. */
function withThinkingRoom(payload: Record<string, unknown>, ceiling: number): Record<string, unknown> {
	const room = thinkingRoom(ceiling);
	// What one thinking-budget field is worth under the new ceiling:
	// undefined leaves it alone, a number lowers it, and null drops it, the
	// way pi drops a thinking field its own clamp left no room for.
	const fit = (value: unknown): number | null | undefined => {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= room) return undefined;
		return room > 0 ? room : null;
	};
	const next: Record<string, unknown> = { ...payload };
	let changed = false;

	for (const field of THINKING_BUDGET_FIELDS) {
		const fitted = fit(next[field]);
		if (fitted === undefined) continue;
		if (fitted === null) delete next[field];
		else next[field] = fitted;
		changed = true;
	}

	for (const field of THINKING_KWARG_FIELDS) {
		const kwargs = next[field];
		if (typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)) continue;
		const kept: Record<string, unknown> = {};
		let kwargsChanged = false;
		for (const [key, value] of Object.entries(kwargs as Record<string, unknown>)) {
			// Only the thinking names share the ceiling. A kwarg that does not
			// name a reasoning budget (a seed, a temperature, a server's own
			// knob) is not the Fit's to touch.
			const fitted = THINKING_BUDGET_FIELDS.includes(key) ? fit(value) : undefined;
			if (fitted === undefined) {
				kept[key] = value;
				continue;
			}
			kwargsChanged = true;
			if (fitted !== null) kept[key] = fitted;
		}
		if (!kwargsChanged) continue;
		next[field] = kept;
		changed = true;
	}

	const thinking = next.thinking;
	if (typeof thinking === "object" && thinking !== null && !Array.isArray(thinking)) {
		const record = thinking as Record<string, unknown>;
		const fitted = fit(record.budget_tokens);
		if (fitted !== undefined) {
			const kept: Record<string, unknown> = { ...record };
			if (fitted === null) delete kept.budget_tokens;
			else kept.budget_tokens = fitted;
			next.thinking = kept;
			changed = true;
		}
	}

	return changed ? next : payload;
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
const CHARS_PER_TOKEN = PI_CHARS_PER_TOKEN;
const ESTIMATED_IMAGE_CHARS = PI_IMAGE_CHARGE_BYTES;

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
 * The Reported context of a session projection, and where it sits: pi's own
 * anchor rule over the projected messages (the last assistant response whose
 * usage still describes its prefix - a message inserted after the response,
 * such as a compaction summary, moves the anchor back to an earlier one).
 * Null when no usage block applies, which is what a fresh session looks like
 * before its first answer.
 *
 * The wire payload carries no usage block: pi's provider converts an
 * assistant message to `{role, content, tool_calls}` on the way out, so the
 * provider's own count lives only in the session entry pi stored for that
 * answer. The guard reads it there and applies it to the payload.
 *
 * The anchor carries its position with it on purpose. `answersAfterAnchor`
 * is how many answers the projection holds after the anchored one, which is
 * where the payload's uncounted trailing region starts. Reading that boundary
 * off the payload's own last answer instead would disagree with the anchor
 * whenever the payload carries an answer the anchor rule skipped (a later
 * answer that reported no usage survives in the payload but not as an
 * anchor), and everything between the two points would drop out of the
 * estimate.
 */
export interface ContextAnchor {
	/** The Reported context: the prompt size the provider counted for the
	 * anchored answer. */
	reportedContext: number;
	/** How many answers the projection carries after the anchored one. pi's
	 * `transform-messages` drops aborted and errored assistant messages from
	 * the payload, so only the answers it keeps are counted. */
	answersAfterAnchor: number;
}

export function contextAnchor(messages: readonly Message[]): ContextAnchor | null {
	const anchor = usageAnchor(messages);
	if (anchor === null) return null;
	let answersAfterAnchor = 0;
	for (let i = anchor.index + 1; i < messages.length; i++) {
		const message = messages[i];
		// Count only the answers pi puts back on the wire: pi-ai's
		// transform-messages drops an errored or aborted assistant message
		// from the payload outright (replaying one can be an API error), so
		// those answers are in the projection but never in the payload, and
		// counting them would point the boundary at a message that is not
		// there.
		if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error") answersAfterAnchor += 1;
	}
	return { reportedContext: usageTokens(anchor.usage), answersAfterAnchor };
}

// ---------------------------------------------------------------------------
// The payload, read directly: the Corrected estimate
// ---------------------------------------------------------------------------

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

/** Whether one payload message is an assistant answer, in wire shape. */
function isWireAssistant(message: unknown): boolean {
	return typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant";
}

/**
 * Where the payload's uncounted trailing region starts: the payload's copy
 * of the anchored answer. The projection says how many answers it holds after
 * the anchor, so the payload's answer that many places from the end is the
 * anchored one, and everything after it is what the provider has not counted.
 *
 * Returns null when the payload carries fewer answers than that, which means
 * the two views disagree (pi dropped an answer this guard expected to see);
 * the caller then estimates the whole payload rather than guessing a boundary.
 */
function anchorBoundaryInPayload(messages: readonly unknown[], anchor: ContextAnchor): number | null {
	let answers = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!isWireAssistant(messages[i])) continue;
		if (answers === anchor.answersAfterAnchor) return i;
		answers += 1;
	}
	return null;
}

/**
 * The whole payload at the Inflation-corrected rate: its messages and its
 * tool declarations, everything the guard can see on the wire. This is the
 * fresh-session estimate (nothing has been counted yet, so everything is
 * trailing), and it is also the cheap screen the decision runs before it
 * reads anything from the session.
 *
 * Returns null when the payload carries no messages the guard can read.
 */
export function wholePayloadTokens(payload: unknown, math: TokenMath): number | null {
	const messages = payloadMessages(payload);
	if (messages === null) return null;
	let chars = 0;
	for (const message of messages) chars += wireMessageChars(message);
	const tools = (payload as Record<string, unknown>).tools;
	if (Array.isArray(tools)) chars += safeJsonStringify(tools).length;
	return tokensFromBytes(chars, math);
}

/**
 * The Corrected estimate of the request a payload would carry: the Reported
 * context the provider counted for its last answer, plus an
 * Inflation-corrected estimate of everything the provider has not counted
 * yet - the payload's messages after that answer.
 *
 * The trailing boundary comes from the same anchor as the Reported context,
 * never from the payload's own last answer: the two rules disagreeing is how
 * an answer between them drops out of the estimate and lets an overrunning
 * request go out.
 *
 * `anchored` says which figure was used, and the decision acts on it. An
 * anchored estimate rests on a count the provider made. An unanchored one is
 * the guard's own guess over the whole payload, and the guard never refuses a
 * request on its own guess: ADR 0028 refuses on pi's arithmetic, and without
 * an anchor the payload's character count is neither pi's figure nor the
 * provider's.
 *
 * Returns null when the payload carries no messages the guard can read; the
 * caller then falls back to pi's own estimate rather than making an
 * unfamiliar payload worse.
 */
export interface CorrectedEstimate {
	tokens: number;
	/** True when the figure starts from a Reported context the provider
	 * counted, false when the whole payload was estimated. */
	anchored: boolean;
}

export function correctedEstimateTokens(payload: unknown, anchor: ContextAnchor | null, math: TokenMath): CorrectedEstimate | null {
	const messages = payloadMessages(payload);
	if (messages === null) return null;
	if (anchor !== null && Number.isFinite(anchor.reportedContext) && anchor.reportedContext > 0) {
		const boundary = anchorBoundaryInPayload(messages, anchor);
		if (boundary !== null) {
			let trailingChars = 0;
			for (let i = boundary + 1; i < messages.length; i++) trailingChars += wireMessageChars(messages[i]);
			return { tokens: anchor.reportedContext + tokensFromBytes(trailingChars, math), anchored: true };
		}
	}
	const whole = wholePayloadTokens(payload, math);
	if (whole === null) return null;
	return { tokens: whole, anchored: false };
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

/**
 * What the session behind a request says about it. The guard asks for this
 * only when the payload alone does not prove the request has room, because
 * reading it means rebuilding pi's session projection: pi already builds one
 * per request, and a second build per request on a long session is a real
 * cost the guard should not pay for a turn that is nowhere near the window.
 */
export interface SessionFacts {
	/** The Reported context anchor, or null when the session has no usage
	 * anchor yet. */
	anchor: ContextAnchor | null;
	/** pi's own estimate over the session projection: the figure the guard
	 * degrades to when the payload carries nothing it can read, and the one
	 * the refusal line names. */
	projectionEstimate: number;
}

export interface GuardInput {
	/** The payload pi built, exactly as the hook received it. */
	payload: unknown;
	/** The Effective window of the request's model, or 0 when the session
	 * carries no model to judge against. */
	window: number;
	/** The session behind the payload, read on demand. The decision calls it
	 * at most once, and never for a request the payload alone clears. */
	session: () => SessionFacts;
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
	 * is that this branch refuses exactly as the guard refuses today. Only
	 * reachable on an anchored estimate. */
	| "overrun";

export interface GuardDecision {
	outcome: GuardOutcome;
	/** The context estimate the decision judged: the Corrected estimate, or
	 * pi's own figure where the guard degrades to it. 0 when the guard never
	 * got as far as an estimate. */
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
 * 2. the payload alone, at the Inflation-corrected rate, leaves the budget
 *    room inside the window: silent, and the session is never read;
 * 3. the budget exceeds the room the Corrected estimate leaves in the
 *    Effective window, and that room minus pi's safety margin still clears
 *    the minimum answer budget: Output overrun, Fit downward, report one line;
 * 4. the budget exceeds the room and the margin leaves less than the minimum
 *    answer budget: refuse, because no answer fits. This branch refuses the
 *    way the first one does, and is reported with the same line; the figures
 *    it names (a budget above pi's floor, an estimate over the window) are
 *    what tell it from Output starvation.
 *
 * The refusal in branch 4 needs an anchor. Without one, the estimate is the
 * guard's own Inflation-corrected guess over the whole payload, and the guard
 * does not abort a turn on its own guess: pi's clamp and the provider are the
 * two arithmetic that get a vote there, and both are still reading the same
 * request. A fresh session that is already large is therefore Fitted when the
 * guess leaves room and left alone when it does not, which is what ADR 0028's
 * rule for the destructive path asks for.
 *
 * The Fit never raises a budget and never goes below pi's floor. A payload
 * with no readable budget, and a session with no window to judge against,
 * leave the request alone: the guard only ever refuses the collapsed budget
 * it can name.
 */
export function decide(input: GuardInput): GuardDecision {
	const budget = budgetOf(input.payload);
	if (budget === undefined) {
		return { outcome: "silent", estimate: 0, budget: null, fitted: null, payload: input.payload };
	}
	if (isStarved(input.payload)) {
		// The trigger is pi's clamp saturating, and the line names pi's own
		// figure, so this is one of the two paths that read the session.
		return { outcome: "starved", estimate: input.session().projectionEstimate, budget, fitted: null, payload: input.payload };
	}
	if (!(input.window > 0)) {
		return { outcome: "silent", estimate: 0, budget, fitted: null, payload: input.payload };
	}
	// The cheap screen, over the payload alone. The Inflation factor is what
	// makes it safe to skip the session read: the screen and the Corrected
	// estimate use the same rate, so an operator whose content a real
	// tokenizer reads denser than that raises one setting and tightens both.
	const payloadEstimate = wholePayloadTokens(input.payload, input.settings);
	if (payloadEstimate !== null && budget + payloadEstimate + input.settings.safetyMargin <= input.window) {
		return { outcome: "silent", estimate: payloadEstimate, budget, fitted: null, payload: input.payload };
	}
	const session = input.session();
	const corrected = correctedEstimateTokens(input.payload, session.anchor, input.settings);
	const estimate = corrected?.tokens ?? session.projectionEstimate;
	const room = input.window - estimate;
	if (budget <= room) {
		return { outcome: "silent", estimate, budget, fitted: null, payload: input.payload };
	}
	const answerRoom = room - input.settings.safetyMargin;
	if (answerRoom < input.settings.minAnswerTokens) {
		if (corrected !== null && !corrected.anchored) {
			// No anchor, so no count the provider made: the guard's own guess
			// is not grounds to abort a turn. pi's clamp and the provider judge
			// this request between themselves.
			return { outcome: "silent", estimate, budget, fitted: null, payload: input.payload };
		}
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
