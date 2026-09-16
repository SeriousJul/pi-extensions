/**
 * Compression runner: runs one compression job through pi's model registry.
 *
 * The call is a normal, fresh conversation: a new session ID and no cache
 * retention, so the session's prompt cache is never touched and the call
 * bills on its own. `maxTokens` caps the form at the span cap (in tokens);
 * the token estimator is chars/4, so the maxTokens bound is the cap times
 * four.
 *
 * The runner is constructed with the resolved model, so the core and the
 * tests never see the registry.
 */
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, UserMessage, Usage } from "@earendil-works/pi-ai";
import type { CompressionJob } from "./core.ts";

/** The chars/4 estimator: one token is four characters. */
export const CHARS_PER_TOKEN = 4;

/** The system prompt, with the form's token cap filled in. */
export function compressionSystemPrompt(capTokens: number): string {
	return [
		"You compress one finished turn of a coding-agent session into a short standing-in note.",
		"The note replaces the turn in later requests; the full original messages stay in the session file.",
		"",
		"Output exactly these four sections, in order, as plain text:",
		"What was asked: the user's instructions from this turn, reproduced verbatim.",
		"What was done: files touched, commands run, tools used.",
		"Key results: the outcomes, with exact error strings from any failure.",
		"Open items: anything unfinished or needing follow-up.",
		"",
		"Rules:",
		"- Reproduce user instructions and error strings verbatim.",
		"- Be dense and factual; no pleasantries, no commentary.",
		`- Stay within about ${capTokens} tokens.`,
	].join("\n");
}

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
					maxTokens: job.capTokens * CHARS_PER_TOKEN,
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			if (message.stopReason === "error") {
				throw new Error(message.errorMessage ?? "compression call failed");
			}
			const text = extractText(message);
			if (text.length === 0) throw new Error("compression model returned no text");
			return { text, usage: message.usage };
		},
	};
}
