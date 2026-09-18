/**
 * Compress extension: request-time compression of finished turns.
 *
 * Finished turns that fall out of the keep window are replaced in outgoing
 * LLM requests by one synthetic user message carrying a short compressed
 * form. The session file is never rewritten; each finished span is persisted
 * as a `compress-span` custom entry, and its usage counts as a Usage event.
 * The compressed form is computed in the background after each turn (see
 * ADR 0015).
 *
 * This file is thin pi wiring around the pure core (`core.ts`), the turn
 * serializer (`serializer.ts`), the settings reader (`settings.ts`), and the
 * model runner (`runner.ts`).
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens as estimateMessageTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createCompressionCore,
	SPAN_FRAME,
	type CompressionCore,
	type CompressionJob,
	type ModelRef,
	type SpanRecord,
	type Turn,
	type TurnRequest,
} from "./core.ts";
import { serializeTurn } from "./serializer.ts";
import { readCompressSettings, writeCompressModel, type CompressSettings } from "./settings.ts";
import { createModelRunner, type CompressionRunner } from "./runner.ts";

/** The custom session entry type that persists one finished span. */
const SPAN_ENTRY_TYPE = "compress-span";

interface SessionState {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	settings: CompressSettings;
	core: CompressionCore;
	model: Model<Api> | null;
	runner: CompressionRunner | null;
	/** Span keys with a compression call scheduled or running. */
	inFlight: Set<string>;
	/** Span keys already warned about, so a failing span warns once. */
	warned: Set<string>;
	/** Failed compression attempts per span key. */
	attempts: Map<string, number>;
	/** Span keys that will not earn another call this session: the input
	 * does not fit the compression model's context window, or the retry cap
	 * was hit. Cleared when the compression model changes. */
	gaveUp: Set<string>;
	/** True once the baseline mismatch was reported, so it warns once. The
	 * check itself re-runs on every request; nothing latches off. */
	mismatchWarned: boolean;
	/** True once session_shutdown fired: queued jobs must not start a call
	 * or touch the session file after that. */
	closed: boolean;
	/** The background queue: one compression call at a time. */
	queue: Promise<void>;
}

let state: SessionState | null = null;

/** A span that fails this many calls in a row stops earning calls for the
 * session; its turn stays raw until the compression model changes. */
const MAX_COMPRESS_ATTEMPTS = 3;
/** Headroom for the system prompt and call overhead when a span's
 * serialized input is checked against the compression model's context
 * window. */
const CONTEXT_MARGIN_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Session context reconciliation
//
// The context hook must know exactly which messages pi is about to send, or
// it stays out of the way. Rebuild the context from the session entries with
// pi's own projection (buildContextEntries plus sessionEntryToContextMessages:
// compaction-aware with the retained tail, custom messages projected in, null
// content normalized), then reconcile it against the event's message list.
//
// One rule comes from pi's agent state instead of the session file: while
// recovering from a failed call, pi removes the failed assistant message
// from state (it keeps it in the file for history). A retried error is
// removed when the auto-retry starts; a truncated response is removed on
// overflow recovery. A non-retryable error is kept in state and goes out on
// the next request. Which variant applied to a given message is not
// knowable from the session file, so the reconciliation accepts either per
// message: every projected message must match pi's outgoing list in order,
// and only a failed assistant message (stopReason "error" or "length") may
// be absent. Plain interrupted ("aborted") messages must match: pi keeps
// those in state. When the reconciliation holds, the kept messages are
// exactly pi's outgoing list, so the swap only ever replaces whole span
// ranges inside it.
//
// Cost: the check stringifies the projection and the outgoing list, so it
// is O(session size) per request. That is fine at current session sizes;
// if it stops being, cache the projection string per immutable entry ID.
// ---------------------------------------------------------------------------

function isFailedAssistantMessage(message: AgentMessage): boolean {
	return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "length");
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Reconcile the entries' projection with pi's outgoing messages and split
 * the kept messages into the preamble and the user-started turns, in
 * original order.
 *
 * Returns null on any divergence other than missing failed assistant
 * messages (see above). Span identity follows the full projection: an entry
 * that projected any message keeps its ID in the turn, even when pi removed
 * all of its messages, so a span's key is the same whether the request came
 * from prewarm (full projection) or from the context hook. Returns null
 * when the branch is empty.
 *
 * Exported for the wiring regression tests. */
export function reconcileContext(entries: SessionEntry[], outgoing: AgentMessage[]): TurnRequest | null {
	if (entries.length === 0) return null;
	const preamble: Turn = { entryIds: [], messages: [] };
	const turns: Turn[] = [];
	let current: Turn | null = null;
	let j = 0;
	for (const entry of entries) {
		const projected = sessionEntryToContextMessages(entry);
		if (projected.length === 0) continue;
		const kept: AgentMessage[] = [];
		for (const message of projected) {
			if (j < outgoing.length && sameMessage(message, outgoing[j])) {
				kept.push(message);
				j += 1;
			} else if (!isFailedAssistantMessage(message)) {
				return null;
			}
			// else: pi removed this failed message from agent state
		}
		if (entry.type === "message" && entry.message.role === "user") {
			current = { entryIds: [entry.id], messages: kept };
			turns.push(current);
		} else if (current) {
			current.entryIds.push(entry.id);
			current.messages.push(...kept);
		} else {
			preamble.entryIds.push(entry.id);
			preamble.messages.push(...kept);
		}
	}
	if (j !== outgoing.length) return null;
	return { preamble, turns };
}

/** The request over the full projection: every projected message kept. Used
 * where pi's outgoing list is not available (prewarm, the startup prune). */
function fullRequest(entries: SessionEntry[]): TurnRequest | null {
	return reconcileContext(entries, entries.flatMap((entry) => sessionEntryToContextMessages(entry)));
}

// ---------------------------------------------------------------------------
// Span persistence
// ---------------------------------------------------------------------------

function isSpanRecord(value: unknown): value is SpanRecord {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v.v === 1 &&
		Array.isArray(v.entryIds) &&
		(v.entryIds as unknown[]).every((id) => typeof id === "string") &&
		typeof v.text === "string" &&
		typeof v.tokensBefore === "number" &&
		typeof v.tokensAfter === "number" &&
		typeof v.model === "object" &&
		v.model !== null &&
		typeof (v.model as Record<string, unknown>).provider === "string" &&
		typeof (v.model as Record<string, unknown>).id === "string" &&
		typeof v.usage === "object" &&
		v.usage !== null &&
		typeof (v.usage as Record<string, unknown>).totalTokens === "number"
	);
}

/** The spans persisted on the current branch, for the cache rebuild. */
function restoredSpans(ctx: ExtensionContext): SpanRecord[] {
	const spans: SpanRecord[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SPAN_ENTRY_TYPE) continue;
		if (isSpanRecord(entry.data)) spans.push(entry.data);
	}
	return spans;
}

function appendSpanEntry(pi: ExtensionAPI, span: SpanRecord): void {
	pi.appendEntry(SPAN_ENTRY_TYPE, span);
}

// ---------------------------------------------------------------------------
// Status and notifications
// ---------------------------------------------------------------------------

function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function updateStatus(): void {
	const s = state;
	if (!s || !s.ctx.hasUI) return;
	const { spans, tokensSaved } = s.core.stats();
	if (spans === 0) {
		s.ctx.ui.setStatus("compress", undefined);
		return;
	}
	s.ctx.ui.setStatus("compress", `${spans} span${spans === 1 ? "" : "s"}, ${formatTokens(tokensSaved)} saved`);
}

function shortMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function warnSpan(s: SessionState, message: string): void {
	if (s.ctx.hasUI) {
		s.ctx.ui.notify(message, "warning");
	}
}

// ---------------------------------------------------------------------------
// Background compression
// ---------------------------------------------------------------------------

function configOf(settings: CompressSettings) {
	return {
		keepTurns: settings.keepTurns,
		spanCapTokens: settings.spanCapTokens,
		minSpanTokens: settings.minSpanTokens,
	};
}

/** Release the span's queue slot. Done in every outcome: a cached span is
 * skipped by isCached, and a span that left and came back through a branch
 * round trip must not stay suppressed by a stale key. */
function releaseSlot(s: SessionState, job: CompressionJob): void {
	s.inFlight.delete(job.spanKey);
}

/** Run one compression job on the queue. Resolves when the call settles, so
 * the queue runs one call at a time. */
async function runJob(s: SessionState, job: CompressionJob): Promise<void> {
	const runner = s.runner;
	const model = s.model;
	// A shut-down state must not start a call or touch the session file.
	if (s.closed || !runner || !model) return releaseSlot(s, job);
	if (s.core.isCached(job.spanKey)) return releaseSlot(s, job);
	try {
		const result = await runner.compress(job);
		// The session may have shut down while the call ran; the span entry
		// would land in a file this state no longer owns.
		if (s.closed) return releaseSlot(s, job);
		const span: SpanRecord = {
			v: 1,
			entryIds: job.entryIds,
			text: result.text,
			model: { provider: model.provider, id: model.id },
			usage: result.usage,
			tokensBefore: job.spanTokens,
			tokensAfter: estimateMessageTokens({ role: "user", content: `${SPAN_FRAME}\n\n${result.text}`, timestamp: 0 }),
		};
		s.core.record(span);
		appendSpanEntry(s.pi, span);
		s.warned.delete(job.spanKey);
		s.attempts.delete(job.spanKey);
		updateStatus();
	} catch (err) {
		if (s.closed) return releaseSlot(s, job);
		const attempts = (s.attempts.get(job.spanKey) ?? 0) + 1;
		s.attempts.set(job.spanKey, attempts);
		if (attempts >= MAX_COMPRESS_ATTEMPTS) {
			// The retry cap was hit: the span stays raw and stops earning
			// calls for the session, so a call that always fails never pays
			// again. Changing the compression model resets the counters.
			s.gaveUp.add(job.spanKey);
			warnSpan(s, `compress: compression failed ${attempts} calls in a row; the affected turn stays raw and will not be retried (${shortMessage(err)})`);
		} else if (!s.warned.has(job.spanKey)) {
			// The span stays raw and retries on the next turn_end. Warn once
			// per span so a persistently failing model does not spam.
			s.warned.add(job.spanKey);
			warnSpan(s, `compress: compression call failed; the affected turn stays raw until a retry succeeds (${shortMessage(err)})`);
		}
	}
	return releaseSlot(s, job);
}

/** Queue the jobs for every uncached span, after each finished turn. */
function prewarm(s: SessionState): void {
	const model = s.model;
	if (!model) return;
	const request = fullRequest(s.ctx.sessionManager.buildContextEntries());
	if (!request) return;
	const plan = s.core.plan(request, configOf(s.settings));
	for (const job of plan.jobs) {
		if (s.inFlight.has(job.spanKey) || s.gaveUp.has(job.spanKey)) continue;
		const inputTokens = estimateMessageTokens({ role: "user", content: job.input, timestamp: 0 });
		if (inputTokens + job.capTokens + CONTEXT_MARGIN_TOKENS > model.contextWindow) {
			// The span's input will never fit the compression model's context
			// window, so a call would always fail: stop paying for it and
			// say so once.
			s.gaveUp.add(job.spanKey);
			warnSpan(s, "compress: one turn is larger than the compression model's context window; it stays raw");
			continue;
		}
		s.inFlight.add(job.spanKey);
		s.queue = s.queue.then(() => runJob(s, job));
	}
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

function parseModelRef(value: string): ModelRef | null {
	const slash = value.indexOf("/");
	if (slash <= 0) return null;
	const provider = value.slice(0, slash);
	const id = value.slice(slash + 1);
	if (provider === "" || id === "") return null;
	return { provider, id };
}

function modelRefString(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** The compression model options for the picker and completions. */
function modelOptions(ctx: ExtensionContext): Model<Api>[] {
	const available = ctx.modelRegistry.getAvailable();
	const withAuth = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
	return withAuth.length > 0 ? withAuth : available;
}

/**
 * Resolve the configured compression model from the registry.
 *
 * A local provider may register its models only after session start
 * (on-demand load, wake from sleep), so a startup miss is not final: the
 * caller retries after every turn until the model resolves. Exported for
 * the wiring regression tests.
 */
export function resolveCompressionModel(
	ctx: ExtensionContext,
	settings: { enabled: boolean; model: ModelRef | null },
): { model: Model<Api> | null; runner: CompressionRunner | null; error: "missing" | "auth" | null } {
	if (!settings.enabled || !settings.model) return { model: null, runner: null, error: null };
	const found = ctx.modelRegistry.find(settings.model.provider, settings.model.id);
	if (!found) return { model: null, runner: null, error: "missing" };
	if (!ctx.modelRegistry.hasConfiguredAuth(found)) return { model: null, runner: null, error: "auth" };
	return { model: found, runner: createModelRunner(found, ctx.modelRegistry), error: null };
}

async function setModel(ctx: ExtensionContext, ref: ModelRef | null): Promise<void> {
	const s = state;
	if (!s) return;
	let model: Model<Api> | null = null;
	let runner: CompressionRunner | null = null;
	if (ref) {
		const found = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!found) {
			ctx.ui.notify(`compress: model ${modelRefString(ref)} not found`, "error");
			return;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
			ctx.ui.notify(`compress: no auth configured for ${modelRefString(ref)}`, "error");
			return;
		}
		model = found;
		runner = createModelRunner(found, ctx.modelRegistry);
	}
	s.settings = { ...s.settings, model: ref };
	s.model = model;
	s.runner = runner;
	// A new compression model gets a fresh start: the old model's failures
	// say nothing about this one.
	s.warned.clear();
	s.attempts.clear();
	s.gaveUp.clear();
	const result = writeCompressModel(ctx.cwd, ref);
	if (!result.ok) {
		ctx.ui.notify(`compress: model applied for this session, but the setting could not be saved: ${result.error}`, "error");
	} else {
		ctx.ui.notify(ref ? `compress: model set to ${modelRefString(ref)}` : "compress: compression disabled", "info");
	}
	updateStatus();
}

function showState(ctx: ExtensionContext): void {
	const s = state;
	if (!s) return;
	const { spans, tokensSaved } = s.core.stats();
	const modelText = s.model ? modelRefString({ provider: s.model.provider, id: s.model.id }) : "off";
	ctx.ui.notify(`compress: model ${modelText}, ${spans} span${spans === 1 ? "" : "s"}, ${formatTokens(tokensSaved)} tokens saved`, "info");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function compressExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		state = null;
		const { settings, errors } = readCompressSettings(ctx.cwd);
		for (const error of errors) ctx.ui.notify(`compress: ${error}`, "error");
		const core = createCompressionCore({
			estimateTokens: (messages) => messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
			serializeTurn,
		});
		core.restore(restoredSpans(ctx));
		// Prune restored spans whose entries left the branch before the first
		// status update, so the line does not show spans the first plan will
		// drop.
		const startupRequest = fullRequest(ctx.sessionManager.buildContextEntries());
		if (startupRequest) core.plan(startupRequest, configOf(settings));

		// A startup miss is not final: a local provider can register its
		// models after session start, so turn_end retries the resolution.
		const resolved = resolveCompressionModel(ctx, settings);
		if (resolved.error === "missing" && settings.model) {
			ctx.ui.notify(`compress: configured model ${modelRefString(settings.model)} not found yet; retrying after each turn`, "error");
		} else if (resolved.error === "auth" && settings.model) {
			ctx.ui.notify(`compress: no auth configured for ${modelRefString(settings.model)}; retrying after each turn`, "error");
		}
		state = {
			pi,
			ctx,
			settings,
			core,
			model: resolved.model,
			runner: resolved.runner,
			inFlight: new Set(),
			warned: new Set(),
			attempts: new Map(),
			gaveUp: new Set(),
			mismatchWarned: false,
			closed: false,
			queue: Promise.resolve(),
		};
		updateStatus();
	});

	// Rewrite outgoing requests: cached spans become their form message. The
	// reconciliation re-runs on every request and never latches off; a
	// mismatch only pauses compression for that request.
	pi.on("context", (event) => {
		const s = state;
		if (!s || !s.model) return;
		const request = reconcileContext(s.ctx.sessionManager.buildContextEntries(), event.messages);
		if (!request) {
			// Stay out of the way, but do not fail silently: report once.
			if (!s.mismatchWarned) {
				s.mismatchWarned = true;
				warnSpan(s, "compress: the rebuilt session context does not match pi's outgoing messages; compression is paused until they match again");
			}
			return;
		}
		// The hook discards the jobs; skipping their emission keeps the
		// check from re-serializing every raw span on every request.
		const plan = s.core.plan(request, configOf(s.settings), { emitJobs: false });
		if (plan.compressed === 0) return;
		return { messages: plan.messages };
	});

	// After each finished turn, compress the spans that are still raw.
	pi.on("turn_end", (_event, ctx) => {
		const s = state;
		if (!s) return;
		// Self-heal a startup model miss: the provider may have registered
		// the model meanwhile. Once it resolves, compression starts on this
		// turn and the failure counters restart for the new model.
		if (!s.model && s.settings.model) {
			const resolved = resolveCompressionModel(s.ctx, s.settings);
			if (resolved.model && resolved.runner) {
				s.model = resolved.model;
				s.runner = resolved.runner;
				s.warned.clear();
				s.attempts.clear();
				s.gaveUp.clear();
				ctx.ui.notify(`compress: model ${modelRefString(s.settings.model)} is available; compression on`, "info");
			}
		}
		prewarm(s);
	});

	pi.on("session_shutdown", () => {
		// Mark the state closed before dropping it so a queued job that is
		// still draining after the shutdown stays out of the session file and
		// does not start a new call.
		if (state) state.closed = true;
		state = null;
	});

	pi.registerCommand("compression-model", {
		description: "Show or set the compression model: no args shows state and opens the picker, 'off' disables, 'provider/model-id' sets directly",
		getArgumentCompletions: (prefix) => {
			const s = state;
			if (!s) return null;
			const items = [
				{ value: "off", label: "off", description: "Disable compression" },
				...modelOptions(s.ctx).map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, description: m.name })),
			];
			const p = prefix.trim().toLowerCase();
			return p === "" ? items : items.filter((item) => item.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				showState(ctx);
				if (!ctx.hasUI) return;
				const options = ["off (disable compression)", ...modelOptions(ctx).map((m) => `${m.provider}/${m.id}`)];
				const choice = await ctx.ui.select("Compression model", options);
				if (choice === undefined) return;
				if (choice.startsWith("off")) {
					await setModel(ctx, null);
					return;
				}
				const ref = parseModelRef(choice);
				if (!ref) {
					ctx.ui.notify(`compress: invalid model selection: ${choice}`, "error");
					return;
				}
				await setModel(ctx, ref);
				return;
			}
			if (arg.toLowerCase() === "off") {
				await setModel(ctx, null);
				return;
			}
			const ref = parseModelRef(arg);
			if (!ref) {
				ctx.ui.notify(`compress: usage: /compression-model [off | provider/model-id]`, "error");
				return;
			}
			await setModel(ctx, ref);
		},
	});
}
