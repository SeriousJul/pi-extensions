/**
 * initial-context: shows the full token breakdown of the running agent's
 * initial context (the system prompt and the tool definitions, which are
 * resent to the model on every LLM call).
 *
 * /ctx opens the breakdown: a row per prompt section and per tool, with
 * token counts, percentages, and bars; rows expand to the exact text.
 * A footer status keeps the total visible without opening the view.
 * Print and RPC modes get the same breakdown as plain text.
 *
 * Pure observer: registers no tools, no prompt text, and no prompt notes
 * of its own, so its own overhead is zero. It captures the system prompt
 * and tool entries from the provider request payloads (read only, never
 * mutated) and estimates tokens with pi's own estimator.
 */
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	buildInitialContext,
	emptyCaptured,
	estimateInitialContextTotal,
	formatStatusText,
	parseProviderPayload,
	renderContextText,
	type CapturedContext,
} from "./context.ts";
import { createContextTui } from "./tui.ts";
import { createToolUsageSource, parseToolUsageWindow, type ToolUsageSource } from "./tool-usage.ts";
import { setPiece } from "../shared/status-line.ts";

export default function (pi: ExtensionAPI): void {
	let captured: CapturedContext = emptyCaptured();
	let lastOptions: BuildSystemPromptOptions | undefined;
	// The usage source starts its scan on the first /ctx, never at load.
	let usageSource: ToolUsageSource | undefined;
	const getUsageSource = (): ToolUsageSource => (usageSource ??= createToolUsageSource());

	const refreshStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const { totalTokens, windowPercent } = estimateInitialContextTotal({
			basePrompt: ctx.getSystemPrompt(),
			options: lastOptions,
			cwd: ctx.cwd,
			captured,
			contextWindow: ctx.model?.contextWindow,
		});
		setPiece(ctx, "ctx", "left", formatStatusText(totalTokens, windowPercent));
	};

	pi.on("session_start", (_event, ctx) => {
		captured = emptyCaptured();
		lastOptions = undefined;
		refreshStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		lastOptions = event.systemPromptOptions;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const parsed = parseProviderPayload(event.payload);
		if (parsed.system !== undefined) captured.sentSystem = parsed.system;
		if (parsed.tools.length > 0) captured.tools = parsed.tools;
		refreshStatus(ctx);
	});

	pi.on("message_end", (event) => {
		if (captured.providerInputTokens !== undefined) return;
		const message = event.message as { role: string; usage?: { input?: unknown } };
		if (message.role === "assistant" && typeof message.usage?.input === "number") {
			captured.providerInputTokens = message.usage.input;
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.registerCommand("ctx", {
		description: "Show the breakdown of the running agent's initial context, with tool usage (window: 30d, 90d, or all)",
		handler: async (args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			lastOptions = options;
			const report = buildInitialContext(options, captured, ctx.model?.contextWindow);
			refreshStatus(ctx);

			const usage = getUsageSource();
			const arg = args?.trim();
			if (arg) {
				const window = parseToolUsageWindow(arg);
				if (!window) {
					const note = `unknown window: ${arg} (use 30d, 90d, or all)`;
					if (ctx.hasUI) ctx.ui.notify(note, "error");
					else console.error(note);
					return;
				}
				usage.setWindow(window);
			}

			if (ctx.hasUI && ctx.mode === "tui") {
				// Re-kick the scan so a previously failed run retries; the dialog
				// shows the counting state until it settles.
				void usage.counts().catch(() => {
					// The snapshot carries the error; the dialog renders it.
				});
				let component: ReturnType<typeof createContextTui> | undefined;
				await ctx.ui.custom((tui, theme, _keybindings, done) => {
					component = createContextTui({
						tui,
						theme,
						report,
						usage,
						copy: (text) => copyToClipboard(text),
						viewport: () => Math.max(6, Math.min(tui.terminal.rows - 10, 24)),
						close: () => done(undefined),
					});
					return component;
				});
				component?.dispose();
				return;
			}

			let usageView: { window: string; counts: Record<string, number> } | undefined;
			try {
				const settled = await usage.counts();
				usageView = { window: settled.window, counts: settled.counts };
			} catch {
				// A failed scan drops the column; the breakdown still renders.
			}
			const text = renderContextText(report, usageView);
			if (ctx.hasUI && ctx.mode === "rpc") {
				ctx.ui.notify(text, "info");
			} else {
				console.log(text);
			}
		},
	});
}
