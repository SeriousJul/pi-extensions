/**
 * Compression runner: runs one compression job through pi's model registry.
 *
 * The call is a normal, fresh conversation: a new session ID and no cache
 * retention, so the session's prompt cache is never touched and the call
 * bills on its own. `maxTokens` caps the form at the span cap (in tokens);
 * a form that hits the cap is truncated by the provider, which is the
 * intended behavior of a hard cap.
 *
 * The runner is constructed with the resolved model, so the core and the
 * tests never see the registry.
 */
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, UserMessage, Usage } from "@earendil-works/pi-ai";
import type { CompressionJob } from "./core.ts";

/** The system prompt, with the form's token cap filled in. */
export function compressionSystemPrompt(capTokens: number): string {
	return [
		"You compress one finished turn of a coding-agent session into a short standing-in note.",
		"The note replaces the turn in later requests; the full original messages stay in the session file.",
		"",
		"Output exactly these four sections, in order, as plain text:",
		"What was asked: the user's instructions from this turn, reproduced verbatim.",
		"What was done: files touched, commands run, tools used.",
		"Key results: the outcomes, with the error strings from any failure, quoted as shown in the input.",
		"Open items: anything unfinished or needing follow-up.",
		"",
		"Rules:",
		"- Reproduce user instructions verbatim.",
		"- Quote error strings exactly as shown in the input; never invent or shorten them.",
		"- Be dense and factual; no pleasantries, no commentary.",
		`- Stay within about ${capTokens} tokens.`,
	].join("\n");
}

/**
 * Headroom added to the form cap for a thinking model's internal reasoning.
 * Without it, a thinking model that runs past the cap returns a thinking
 * block and no note, so the call fails on "no text". The form itself is
 * still trimmed back to the cap after extraction.
 */
export const THINKING_RESERVE_TOKENS = 1024;

/** The estimator scale used across pi: 4 characters per token. */
const CHARS_PER_TOKEN = 4;

export interface CompressionResult {
	/** The compressed form text. */
	text: string;
	/** The compression call's usage. */
	usage: Usage;
}

export interface CompressionRunner {
	compress(job: CompressionJob): Promise<CompressionResult>;
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function createModelRunner(model: Model<Api>, registry: ModelRegistry): CompressionRunner {
	return {
		async compress(job: CompressionJob): Promise<CompressionResult> {
			const message: AssistantMessage = await registry.complete(
				model,
				{
					systemPrompt: compressionSystemPrompt(job.capTokens),
					messages: [{ role: "user", content: job.input, timestamp: Date.now() } as UserMessage],
				},
				{
					maxTokens: job.capTokens + THINKING_RESERVE_TOKENS,
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			if (message.stopReason === "error") {
				throw new Error(message.errorMessage ?? "compression call failed");
			}
			let text = extractText(message);
			if (text.length === 0) throw new Error("compression model returned no text");
			// The request carried thinking headroom; trim the form back to the
			// cap, as a provider truncation at the cap would have done.
			const capChars = job.capTokens * CHARS_PER_TOKEN;
			if (text.length > capChars) text = text.slice(0, capChars);
			return { text, usage: message.usage };
		},
	};
}
