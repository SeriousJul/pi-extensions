/**
 * E2E probe for the output limits extension (issue #107). Runs inside the
 * real pi process and registers a scripted provider ("e2ol") so the e2e can
 * drive real tool calls without a live LLM.
 *
 * The driver is a file on disk (path in the E2E_CASE_FILE env var):
 * `{ runId, calls: [{ id, name, arguments }], inputTokens }`. The first model
 * call of a runId answers with one assistant message carrying every scripted
 * tool call, so a case with two calls drives pi's real parallel batch. Every
 * later call of the run answers with plain "done" text, so the turn ends.
 *
 * `inputTokens` is how full the scripted provider says the context is. It is
 * the knob that sets the Headroom the Bound is computed from, which is the
 * whole point of the extension: the same command output is bounded in a tight
 * session and left alone in an open one.
 */
import { readFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "e2ol";
const MODEL_ID = "e2e-1";
const CONTEXT_WINDOW = 150_000;

interface ScriptedCase {
	runId: number;
	calls: Array<{ id: string; name: string; arguments: JsonObject }>;
	inputTokens: number;
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
function assistantMessage(content: AssistantMessage["content"], inputTokens: number, stopReason: "toolUse" | "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL_ID,
		usage: {
			input: inputTokens,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * A minimal well-formed stream: one start event, then the terminal done event
 * carrying the final message. The agent loop treats intermediate delta events
 * as optional, so the terminal message is the contract.
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
		name: "E2E Scripted Output Limits",
		baseUrl: "http://localhost:0",
		apiKey: "e2e-scripted",
		api: "openai-completions",
		streamSimple: (_model, _context, options) => {
			const nextCase = readCase();
			if (nextCase === null) {
				return scriptedStream(assistantMessage([{ type: "text", text: "no e2e case scripted" }], 0, "stop"), options);
			}
			if (nextCase.runId !== lastRunId) {
				lastRunId = nextCase.runId;
				callsInRun = 0;
			}
			const callNumber = callsInRun;
			callsInRun += 1;
			if (callNumber === 0) {
				const blocks: AssistantMessage["content"] = nextCase.calls.map((call) => ({
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				} satisfies ToolCall));
				return scriptedStream(assistantMessage(blocks, nextCase.inputTokens, "toolUse"), options);
			}
			return scriptedStream(assistantMessage([{ type: "text", text: "done" }], nextCase.inputTokens, "stop"), options);
		},
		models: [
			{
				id: MODEL_ID,
				name: "E2E Scripted Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: CONTEXT_WINDOW,
				maxTokens: 16_384,
			},
		],
	});
}
