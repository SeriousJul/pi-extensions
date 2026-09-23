/**
 * E2E probe for the edit assist extension (ticket #84). Runs inside the
 * real pi process and registers a scripted provider ("e2efa") so the e2e
 * can drive real edit tool calls without a live LLM.
 *
 * The driver script is a file on disk (path in the E2E_CASE_FILE env var):
 * { runId, toolCall: { id, name, arguments } }. The first model call of a
 * runId answers with that tool call; every later call of the run answers
 * with a plain "done" text so the turn ends. The driver rewrites the file
 * between cases, so the probe re-reads it on every call and re-arms when
 * the runId changes.
 */
import { readFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type FauxContentBlock,
	type JsonObject,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "e2efa";
const MODEL_ID = "e2e-1";

interface ScriptedCase {
	runId: number;
	toolCall: { id: string; name: string; arguments: JsonObject };
}

let lastRunId: number | null = null;
let callsInRun = 0;

function readCase(): ScriptedCase | null {
	const path = process.env.E2E_CASE_FILE;
	if (!path) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ScriptedCase;
	} catch {
		return null;
	}
}

/** A complete assistant message on the scripted provider's identity. */
function assistantMessage(content: FauxContentBlock[], stopReason: "toolUse" | "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * A minimal well-formed stream: one start event, then the terminal done
 * event carrying the final message. The agent loop treats intermediate
 * delta events as optional, so the terminal message is the contract.
 */
function scriptedStream(message: AssistantMessage, options: unknown): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		try {
			const opts = options as {
				onPayload?: (payload: unknown, model: unknown) => unknown;
				onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => unknown;
			};
			opts.onPayload?.({ model: MODEL_ID }, undefined);
			opts.onResponse?.({ status: 200, headers: {} }, undefined);
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end(message);
		} catch (error) {
			const failed: AssistantMessage = { ...message, stopReason: "error", errorMessage: String(error) };
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end(failed);
		}
	});
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		name: "E2E Scripted",
		baseUrl: "http://localhost:0",
		apiKey: "e2e-scripted",
		api: "openai-completions",
		streamSimple: (_model, _context, options) => {
			const nextCase = readCase();
			if (nextCase === null) {
				return scriptedStream(assistantMessage([{ type: "text", text: "no e2e case scripted" }], "stop"), options);
			}
			if (nextCase.runId !== lastRunId) {
				lastRunId = nextCase.runId;
				callsInRun = 0;
			}
			const callNumber = callsInRun;
			callsInRun += 1;
			if (callNumber === 0) {
				const toolCall: ToolCall = {
					type: "toolCall",
					id: nextCase.toolCall.id,
					name: nextCase.toolCall.name,
					arguments: nextCase.toolCall.arguments,
				};
				return scriptedStream(assistantMessage([toolCall], "toolUse"), options);
			}
			return scriptedStream(assistantMessage([{ type: "text", text: "done" }], "stop"), options);
		},
		models: [
			{
				id: MODEL_ID,
				name: "E2E Scripted Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			},
		],
	});
}
