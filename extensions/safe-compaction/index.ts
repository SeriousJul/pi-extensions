/**
 * Safe compaction extension entrypoint (ADR 0044).
 *
 * Takes over the compaction summary on `session_before_compact` when the
 * session's thinking level is on for a reasoning model: pi's own summarizer
 * would send that level to the summary request, whose output budget (a share
 * of the compaction reserve) then pays for thinking and for the summary at
 * once, and a long-thinking model stops mid-summary and fails the whole
 * compaction. The handler re-runs pi's own compaction with thinking
 * disabled - identical prompts, budgets, and split-turn handling - and
 * degrades to the deterministic checkpoint when even that run cannot write
 * a summary, so the session never strands in an ever-growing context.
 *
 * The handler must never throw: an unhandled error would hand the request
 * back to the built-in summarizer with thinking still on, which is exactly
 * the path this extension exists to fix. Every failure maps to either a
 * cancel (the user aborted) or a checkpoint (the compaction completes
 * without an LLM summary, with a notice).
 */
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compact, type CompactionResult, type FileOperations } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { buildCheckpoint, shouldTakeOverSummarization, type CheckpointFileOps, type CheckpointMessage } from "./core.ts";
import { readSafeCompactionSettings } from "./settings.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];

/** The slice of the event context the handler needs. */
export interface BeforeCompactContext {
	cwd: string;
	model: Model<any> | undefined;
	modelRegistry: {
		getApiKeyAndHeaders(
			model: Model<any>,
		): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | undefined>; baseUrl?: string; env?: Record<string, string> } | { ok: false; error: string }>;
	};
	thinkingLevel?: string;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function stringHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** The extractive fallback compaction: pi's own preparation, no LLM call.
 * The previous summary rides through verbatim, so nothing already
 * summarized is lost. */
export function checkpointResult(preparation: Preparation): CompactionResult {
	const fileOps = preparation.fileOps as unknown as FileOperations | undefined;
	const messages: readonly CheckpointMessage[] = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const modified = new Set<string>([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
	const readFiles = [...(fileOps?.read ?? [])].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	const checkpointFileOps: CheckpointFileOps | undefined = fileOps
		? { read: fileOps.read, written: fileOps.written, edited: fileOps.edited }
		: undefined;
	const summary = buildCheckpoint({
		previousSummary: preparation.previousSummary,
		messages,
		fileOps: checkpointFileOps,
	});
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
	};
}

/** Build the handler so the wiring tests can drive it with fakes. */
export function createBeforeCompactHandler(env: NodeJS.ProcessEnv) {
	return async (event: SessionBeforeCompactEvent, ctx: BeforeCompactContext): Promise<{ cancel?: boolean; compaction?: CompactionResult } | undefined> => {
		const signal = event.signal;
		const cancel = (): { cancel: true } => ({ cancel: true });
		const checkpoint = (reason: string): { compaction: CompactionResult } => {
			try {
				ctx.ui.notify(`safe-compaction: ${reason}; wrote the deterministic checkpoint instead`, "warning");
			} catch {
				// A dead UI must not stop the fallback.
			}
			return { compaction: checkpointResult(event.preparation) };
		};
		try {
			const { settings, errors } = readSafeCompactionSettings(ctx.cwd || process.cwd(), env);
			for (const error of errors) {
				try {
					ctx.ui.notify(`safe-compaction: ${error}`, "error");
				} catch {
					// A dead UI must not stop the guard from working.
				}
			}
			if (!settings.enabled) return; // disabled: the built-in summarizer runs

			// The native call is safe when the model does not reason or the
			// session's thinking level is off. With no model at all the native
			// call cannot run either, so the checkpoint below is the honest
			// outcome. Everything past this point takes over.
			const model = ctx.model;
			if (model && !shouldTakeOverSummarization({ enabled: true, modelReasoning: model.reasoning, thinkingLevel: ctx.thinkingLevel })) {
				return; // no thinking on the native call: it is the safe path
			}
			if (signal?.aborted) return cancel();
			if (!model) return checkpoint("no session model, so the summary cannot be written");

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (signal?.aborted) return cancel();
			if (!auth.ok) return checkpoint(`no request auth for ${model.provider}/${model.id}`);

			// The only difference from the native path: the summarization
			// runs with thinking disabled, so the reserve-derived output
			// budget pays for summary text only.
			const callModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			try {
				const result = await compact(
					event.preparation,
					callModel,
					auth.apiKey,
					stringHeaders(auth.headers),
					event.customInstructions,
					signal,
					"off",
					undefined,
					auth.env,
				);
				if (signal?.aborted) return cancel();
				return { compaction: result };
			} catch (err) {
				if (signal?.aborted) return cancel();
				return checkpoint(`the thinking-free summary failed: ${errorText(err)}`);
			}
		} catch (err) {
			if (signal?.aborted) return cancel();
			// A handler that throws hands the native path back, thinking
			// and all. The checkpoint is the last resort.
			try {
				ctx.ui.notify(`safe-compaction: unexpected error (${errorText(err)}); wrote the deterministic checkpoint instead`, "warning");
			} catch {
				// A dead UI must not stop the fallback.
			}
			return { compaction: checkpointResult(event.preparation) };
		}
	};
}

export default function (pi: ExtensionAPI): void {
	const handler = createBeforeCompactHandler(process.env);
	pi.on("session_before_compact", (event, ctx) => handler(event, ctx as unknown as BeforeCompactContext));
}
