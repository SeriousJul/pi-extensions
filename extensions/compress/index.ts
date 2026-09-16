/**
 * Compress extension: request-time compression of finished turns.
 *
 * Finished turns that fall out of the keep window are replaced in outgoing
 * LLM requests by one synthetic user message carrying a short compressed
 * form. The session file is never rewritten; each finished span is persisted
 * as a `compress-span` custom entry, and its usage counts as a Usage event.
 * The compressed form is computed in the background after each turn (see
 * ADR 0012).
 *
 * This file is thin pi wiring around the pure core (`core.ts`), the turn
 * serializer (`serializer.ts`), the settings reader (`settings.ts`), and the
 * model runner (`runner.ts`).
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";
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
	/** The background queue: one compression call at a time. */
	queue: Promise<void>;
}

let state: SessionState | null = null;

// ---------------------------------------------------------------------------
// Session context rebuild
//
// The context hook must know exactly which messages pi is about to send, or
// it stays out of the way. Rebuild the context from the session entries with
// the same rules pi applies (compaction-aware, failed assistant messages
// dropped, custom entries projected away), then require a byte-for-byte
// match with the event's message list before rewriting anything.
// ---------------------------------------------------------------------------

function toTimestampMs(timestamp: string): number {
	return new Date(timestamp).getTime();
}

function isContextMessage(message: AgentMessage): boolean {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}

function entryToContextMessages(entry: SessionEntry): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return isContextMessage(entry.message) ? [entry.message] : [];
		case "compaction":
			return [
				{
					role: "compactionSummary",
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					timestamp: toTimestampMs(entry.timestamp),
				},
				...((entry as { retainedTail?: AgentMessage[] }).retainedTail ?? []).filter(isContextMessage),
			];
		case "branch_summary":
			return entry.summary
				? [
						{
							role: "branchSummary",
							summary: entry.summary,
							fromId: entry.fromId,
							timestamp: toTimestampMs(entry.timestamp),
						},
					]
				: [];
		default:
			return [];
	}
}

/** Split the session context into the preamble (messages before the first
 * user turn) and the user-started turns, in original order. Returns null
 * when the session manager is unavailable. */
function buildTurnRequest(ctx: ExtensionContext): TurnRequest | null {
	const path = ctx.sessionManager.getBranch();
	if (path.length === 0) return null;
	let compactionIndex = -1;
	for (let i = path.length - 1; i >= 0; i -= 1) {
		if (path[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	const entries = compactionIndex >= 0 ? [path[compactionIndex], ...path.slice(compactionIndex + 1)] : path;

	const preamble: Turn = { entryIds: [], messages: [] };
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (const entry of entries) {
		const messages = entryToContextMessages(entry);
		if (messages.length === 0) continue;
		if (entry.type === "message" && entry.message.role === "user") {
			current = { entryIds: [entry.id], messages };
			turns.push(current);
		} else if (current) {
			current.entryIds.push(entry.id);
			current.messages.push(...messages);
		} else {
			preamble.entryIds.push(entry.id);
			preamble.messages.push(...messages);
		}
	}
	return { preamble, turns };
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

/** Run one compression job on the queue. Resolves when the call settles, so
 * the queue runs one call at a time. */
async function runJob(s: SessionState, job: CompressionJob): Promise<void> {
	const runner = s.runner;
	const model = s.model;
	if (!runner || !model) return;
	if (s.core.isCached(job.spanKey)) return;
	try {
		const result = await runner.compress(job);
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
		updateStatus();
	} catch (err) {
		// The span stays raw and retries on the next turn_end. Warn once per
		// span so a persistently failing model does not spam.
		s.inFlight.delete(job.spanKey);
		if (!s.warned.has(job.spanKey)) {
			s.warned.add(job.spanKey);
			if (s.ctx.hasUI) {
				s.ctx.ui.notify(`compress: compression call failed; the affected turn stays raw until a retry succeeds (${shortMessage(err)})`, "warning");
			}
		}
	}
}

/** Queue the jobs for every uncached span, after each finished turn. */
function prewarm(s: SessionState): void {
	const request = buildTurnRequest(s.ctx);
	if (!request) return;
	const plan = s.core.plan(request, configOf(s.settings));
	for (const job of plan.jobs) {
		if (s.inFlight.has(job.spanKey)) continue;
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
	s.warned.clear();
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

		let model: Model<Api> | null = null;
		let runner: CompressionRunner | null = null;
		if (settings.enabled && settings.model) {
			const found = ctx.modelRegistry.find(settings.model.provider, settings.model.id);
			if (!found) {
				ctx.ui.notify(`compress: configured model ${modelRefString(settings.model)} not found; compression is off`, "error");
			} else if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
				ctx.ui.notify(`compress: no auth configured for ${modelRefString(settings.model)}; compression is off`, "error");
			} else {
				model = found;
				runner = createModelRunner(found, ctx.modelRegistry);
			}
		}
		state = {
			pi,
			ctx,
			settings,
			core,
			model,
			runner,
			inFlight: new Set(),
			warned: new Set(),
			queue: Promise.resolve(),
		};
		updateStatus();
	});

	// Rewrite outgoing requests: cached spans become their form message.
	pi.on("context", (event) => {
		const s = state;
		if (!s || !s.model) return;
		const request = buildTurnRequest(s.ctx);
		if (!request) return;
		const baseline = [request.preamble, ...request.turns].flatMap((t) => t.messages);
		if (JSON.stringify(baseline) !== JSON.stringify(event.messages)) return;
		const plan = s.core.plan(request, configOf(s.settings));
		if (plan.compressed === 0) return;
		return { messages: plan.messages };
	});

	// After each finished turn, compress the spans that are still raw.
	pi.on("turn_end", () => {
		const s = state;
		if (!s || !s.model) return;
		prewarm(s);
	});

	pi.on("session_shutdown", () => {
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
