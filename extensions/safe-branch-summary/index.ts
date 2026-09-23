/**
 * Safe branch summary extension entrypoint (ADR 0025).
 *
 * Replaces pi's built-in branch summarizer on `/tree` navigation: one
 * handler on `session_before_tree`, always providing the summary when the
 * user asked for one. The built-in runs only while the extension is
 * disabled in settings. The handler is a thin adapter over the pure core
 * (core.ts): settings, the effective window, and the standalone completion
 * call live here; the budget, the selection, and the prompt assembly live
 * in the core.
 *
 * The handler must never throw: an unhandled error would hand the request
 * back to the built-in summarizer, which is exactly the path this
 * extension exists to fix. Every failure maps to either a cancel (the user
 * aborted) or a soft-skip (the navigation completes without a summary
 * entry, with a notice).
 */
import type { ExtensionAPI, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, Usage, UserMessage } from "@earendil-works/pi-ai";
import { NO_CONTENT_SUMMARY, decideSafeBranchSummary, finalizeBranchSummary } from "./core.ts";
import { readBranchSummaryReserveTokens, readSafeBranchSummarySettings } from "./settings.ts";

/** The result shape of the `session_before_tree` handler (pi's SessionBeforeTreeResult). */
export interface BeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

/** The slice of the event context the handler needs. */
export interface BeforeTreeContext {
	cwd: string;
	model: Model<Api> | undefined;
	modelRegistry: {
		complete(
			model: Model<Api>,
			context: { systemPrompt?: string; messages: UserMessage[] },
			options: { signal: AbortSignal; maxTokens: number },
		): Promise<AssistantMessage>;
	};
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Build the handler so the wiring tests can drive it with fakes. */
export function createBeforeTreeHandler(env: NodeJS.ProcessEnv) {
	return async (event: SessionBeforeTreeEvent, ctx: BeforeTreeContext): Promise<BeforeTreeResult | undefined> => {
		const { preparation, signal } = event;
		// The soft-skip form: an empty summary suppresses the built-in while
		// letting the navigation complete without a summary entry.
		const softSkip = (): BeforeTreeResult => {
			return { summary: { summary: "" } };
		};
		try {
			const { settings, errors } = readSafeBranchSummarySettings(ctx.cwd, env);
			for (const error of errors) ctx.ui.notify(`safe-branch-summary: ${error}`, "error");
			if (!settings.enabled) return; // disabled: the built-in summarizer runs
			if (!preparation.userWantsSummary) return; // nothing was asked

			const decision = decideSafeBranchSummary({
				entries: preparation.entriesToSummarize,
				contextWindow: ctx.model?.contextWindow,
				maxOutputTokens: ctx.model?.maxTokens,
				reserveTokens: readBranchSummaryReserveTokens(ctx.cwd, env),
				inflationFactor: settings.inflationFactor,
				customInstructions: preparation.customInstructions,
				replaceInstructions: preparation.replaceInstructions,
			});

			// An empty branch gets no entry from either path: the built-in
			// would not run, and the extension adds nothing.
			if (decision.kind === "no-branch") return;
			if (decision.kind === "no-content") {
				return { summary: { summary: NO_CONTENT_SUMMARY } };
			}
			if (decision.kind === "soft-skip") {
				ctx.ui.notify(`safe-branch-summary: ${decision.notice}`, "warning");
				return softSkip();
			}
			if (ctx.model === undefined) {
				ctx.ui.notify("safe-branch-summary: no session model; no branch summary written", "warning");
				return softSkip();
			}

			let response: AssistantMessage;
			try {
				response = await ctx.modelRegistry.complete(
					ctx.model,
					{
						systemPrompt: decision.systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: decision.userText }], timestamp: Date.now() }],
					},
					{ signal, maxTokens: decision.maxTokens },
				);
			} catch (err) {
				if (signal.aborted) return { cancel: true };
				ctx.ui.notify(`safe-branch-summary: ${errorText(err)}; navigation continued without a summary`, "warning");
				return softSkip();
			}
			if (signal.aborted || response.stopReason === "aborted") return { cancel: true };
			if (response.stopReason === "error") {
				ctx.ui.notify(
					`safe-branch-summary: ${response.errorMessage ?? "branch summarization failed"}; navigation continued without a summary`,
					"warning",
				);
				return softSkip();
			}
			if (response.content.some((block) => block.type === "toolCall")) {
				ctx.ui.notify("safe-branch-summary: summary attempt called a tool; navigation continued without a summary", "warning");
				return softSkip();
			}
			const summary = finalizeBranchSummary(extractText(response), decision.readFiles, decision.modifiedFiles);
			return {
				summary: {
					summary,
					usage: response.usage,
					details: { readFiles: decision.readFiles, modifiedFiles: decision.modifiedFiles },
				},
			};
		} catch (err) {
			// Never let an unexpected error fall through to the built-in.
			if (signal.aborted) return { cancel: true };
			ctx.ui.notify(`safe-branch-summary: ${errorText(err)}; navigation continued without a summary`, "warning");
			return softSkip();
		}
	};
}

export default function (pi: ExtensionAPI): void {
	const handler = createBeforeTreeHandler(process.env);
	pi.on("session_before_tree", (event, ctx) => handler(event, ctx));
}
