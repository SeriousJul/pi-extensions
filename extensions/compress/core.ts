/**
 * Compression core (pure): owns the keep-window boundary, span eligibility,
 * the span cache, and the outgoing message plan.
 *
 * Given the session turns (each a list of messages with its session entry
 * IDs), a config, and the cache, `plan` produces the outgoing message list
 * and the list of compression jobs. Finished turns that sit before the keep
 * window are spans: a cached span is replaced by one synthetic user message
 * carrying its compressed form; an uncached span stays raw and, when it
 * passes the min span gate, yields a job. The last turn is the turn in
 * progress and is never a span. `record` adds one finished span to the
 * cache; `restore` rebuilds it after a restart.
 *
 * No pi imports: the token estimator and the turn serializer are injected,
 * and every input is plain data, so the plan/record seam is testable in
 * milliseconds without a pi runtime or the network.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage, Usage } from "@earendil-works/pi-ai";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface CompressionConfig {
	/** Recent finished turns carried verbatim (the keep window), plus the turn in progress. */
	keepTurns: number;
	/** Cap for one compressed form, in tokens. */
	spanCapTokens: number;
	/** A span smaller than this never earns a compression call. */
	minSpanTokens: number;
}

/** One turn: the messages it carries on the wire, and the session entry IDs
 * that identify it. A user-started turn holds one user message plus the
 * assistant and tool-result messages of the exchange. */
export interface Turn {
	entryIds: string[];
	messages: AgentMessage[];
}

/** The session context split for planning: the messages before the first
 * user turn (e.g. a compaction summary) and the user-started turns in
 * original order. The last turn is the turn in progress. */
export interface TurnRequest {
	preamble: Turn;
	turns: Turn[];
}

/** One compression job: the serialized input plus the numbers the runner
 * and the cache need. */
export interface CompressionJob {
	spanKey: string;
	entryIds: string[];
	input: string;
	/** Estimated tokens of the span's raw messages. */
	spanTokens: number;
	/** Cap for the compressed form, in tokens. */
	capTokens: number;
}

/** One finished span, exactly as persisted in the custom session entry. */
export interface SpanRecord {
	v: 1;
	entryIds: string[];
	/** The compressed form text. */
	text: string;
	/** The compression model that wrote the form. */
	model: ModelRef;
	/** The compression call's usage, counted as a Usage event. */
	usage: Usage;
	/** Estimated tokens of the span's raw messages. */
	tokensBefore: number;
	/** Estimated tokens of the outgoing form message. */
	tokensAfter: number;
}

export interface PlanResult {
	/** The outgoing message list: raw messages plus one form message per cached span. */
	messages: AgentMessage[];
	/** Jobs for uncached spans that pass the min span gate. */
	jobs: CompressionJob[];
	/** Finished turns that fell out of the keep window. */
	spans: number;
	/** Spans replaced by a cached form. */
	compressed: number;
	/** Tokens saved by the cached forms so far. */
	tokensSaved: number;
}

/** The span's cache key: its entry IDs in original order. */
export const spanKeyOf = (entryIds: string[]): string => entryIds.join("|");

/** The label every form message carries: the block is a lossy view, and the
 * full history stays in the session file. Fixed wording keeps the outgoing
 * prefix stable so the provider's prompt cache keeps working. */
export const SPAN_FRAME =
	"Lossy compressed view of finished turns. The full original messages are retained in the session file; re-read sources when you need detail.";

/** The outgoing content of one cached span's form message. */
export function spanMessageContent(span: SpanRecord): string {
	return `${SPAN_FRAME}\n\n${span.text}`;
}

/** The one synthetic user message that stands in for a cached span. The
 * timestamp comes from the span's first message so it is stable across
 * requests. */
export function spanMessage(span: SpanRecord, firstMessage: AgentMessage): UserMessage {
	return {
		role: "user",
		content: spanMessageContent(span),
		timestamp: firstMessage?.timestamp ?? 0,
	};
}

export interface CoreDeps {
	/** Estimate the tokens of a message list (the production wiring uses pi's estimator). */
	estimateTokens: (messages: AgentMessage[]) => number;
	/** One finished turn to the compression model's input text. */
	serializeTurn: (messages: AgentMessage[]) => string;
}

export interface CompressionCore {
	/** Produce the outgoing message list and the compression jobs. */
	plan(request: TurnRequest, config: CompressionConfig): PlanResult;
	/** Add one finished span to the cache. */
	record(span: SpanRecord): void;
	/** Rebuild the cache from persisted spans (session start). */
	restore(spans: SpanRecord[]): void;
	isCached(spanKey: string): boolean;
	/** Span count and tokens saved, for the status bar. */
	stats(): { spans: number; tokensSaved: number };
}

export function createCompressionCore(deps: CoreDeps): CompressionCore {
	const cache = new Map<string, SpanRecord>();

	/** Drop cached spans whose entries left the branch (compaction, branch
	 * switch), so the stats stop counting them. */
	function prune(request: TurnRequest): void {
		const present = new Set<string>();
		for (const turn of [request.preamble, ...request.turns]) {
			for (const id of turn.entryIds) present.add(id);
		}
		for (const span of cache.values()) {
			const alive = span.entryIds.length > 0 && span.entryIds.every((id) => present.has(id));
			if (!alive) cache.delete(spanKeyOf(span.entryIds));
		}
	}

	function plan(request: TurnRequest, config: CompressionConfig): PlanResult {
		prune(request);
		const { preamble, turns } = request;
		const messages: AgentMessage[] = [...preamble.messages];
		const jobs: CompressionJob[] = [];
		let spans = 0;
		let compressed = 0;
		// Finished turns are every turn but the last (the turn in progress).
		// The keep window is the last `keepTurns` of those.
		const keepStart = Math.max(0, turns.length - 1 - config.keepTurns);
		for (let i = 0; i < turns.length; i += 1) {
			const turn = turns[i];
			if (i < keepStart) {
				spans += 1;
				const key = spanKeyOf(turn.entryIds);
				const cached = cache.get(key);
				if (cached) {
					messages.push(spanMessage(cached, turn.messages[0]));
					compressed += 1;
					continue;
				}
				const spanTokens = deps.estimateTokens(turn.messages);
				if (spanTokens >= config.minSpanTokens) {
					jobs.push({
						spanKey: key,
						entryIds: turn.entryIds,
						input: deps.serializeTurn(turn.messages),
						spanTokens,
						capTokens: config.spanCapTokens,
					});
				}
			}
			messages.push(...turn.messages);
		}
		return { messages, jobs, spans, compressed, tokensSaved: stats().tokensSaved };
	}

	function record(span: SpanRecord): void {
		cache.set(spanKeyOf(span.entryIds), span);
	}

	function restore(spans: SpanRecord[]): void {
		for (const span of spans) record(span);
	}

	function stats(): { spans: number; tokensSaved: number } {
		let tokensSaved = 0;
		for (const span of cache.values()) {
			tokensSaved += Math.max(0, span.tokensBefore - span.tokensAfter);
		}
		return { spans: cache.size, tokensSaved };
	}

	return {
		plan,
		record,
		restore,
		isCached: (spanKey: string) => cache.has(spanKey),
		stats,
	};
}
