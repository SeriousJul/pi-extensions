import { describe, expect, it } from "vitest";
import { cutToolResultText, serializeTurn, TOOL_RESULT_MAX_CHARS } from "../../extensions/compress/serializer";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2000,
	} as AgentMessage;
}

function assistantToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2000,
	} as AgentMessage;
}

function toolResult(text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3000,
	};
}

// ---------------------------------------------------------------------------
// cutToolResultText
// ---------------------------------------------------------------------------

describe("cutToolResultText", () => {
	it("leaves short text untouched", () => {
		expect(cutToolResultText("hello")).toBe("hello");
		expect(cutToolResultText("x".repeat(TOOL_RESULT_MAX_CHARS))).toBe("x".repeat(TOOL_RESULT_MAX_CHARS));
	});

	it("cuts long text to head and tail within the budget", () => {
		const head = "HEAD-MARKER line one";
		const tail = "TAIL-MARKER: Error: the actual failure";
		const middle = "m".repeat(5000);
		const text = `${head}\n${middle}\n${tail}`;
		const cut = cutToolResultText(text);
		expect(cut.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
		expect(cut.startsWith(head)).toBe(true);
		expect(cut.endsWith(tail)).toBe(true);
		// A region that lies in the cut middle, far from both kept ends.
		expect(cut).not.toContain(middle.slice(1500, 2500));
		const cutCount = text.length - TOOL_RESULT_MAX_CHARS;
		expect(cut).toContain(`${cutCount} middle characters cut`);
	});

	it("respects a custom budget", () => {
		const cut = cutToolResultText("a".repeat(1000), 100);
		expect(cut.length).toBeLessThanOrEqual(100);
		expect(cut).toContain("900 middle characters cut");
	});
});

// ---------------------------------------------------------------------------
// serializeTurn
// ---------------------------------------------------------------------------

describe("serializeTurn", () => {
	it("labels every message with its role", () => {
		const text = serializeTurn([user("do the thing"), assistant("on it"), assistantToolCall("bash", { command: "ls" }), toolResult("total 0")]);
		expect(text).toContain("[User]: do the thing");
		expect(text).toContain("[Assistant]: on it");
		expect(text).toContain("[Assistant tool calls]: bash(command=\"ls\")");
		expect(text).toContain("[Tool result]: total 0");
	});

	it("carries the user's instructions verbatim", () => {
		const instruction = "Fix the bug in src/foo.ts but do NOT touch src/bar.ts.\nKeep the public API: `export function run(x: string): number`.";
		const text = serializeTurn([user(instruction), assistant("done")]);
		expect(text).toContain(instruction);
	});

	it("keeps the head and tail of a long tool result and cuts the middle", () => {
		const head = "line 0: first output";
		const tail = "line 99: Error: boom (exit code 1)";
		const middle = "line mid: " + "x".repeat(4000);
		const text = serializeTurn([user("run it"), assistant("running"), toolResult(`${head}\n${middle}\n${tail}`)]);
		expect(text).toContain("[Tool result]:");
		expect(text).toContain(head);
		expect(text).toContain(tail);
		// The kept head and tail together hold under 2000 chars, so a run of
		// 2000 middle chars cannot survive the cut.
		expect(text).not.toContain("x".repeat(2000));
		expect(text).toContain("middle characters cut");
	});

	it("does not cut short tool results", () => {
		const text = serializeTurn([user("run it"), assistant("running"), toolResult("short output")]);
		expect(text).toContain("short output");
		expect(text).not.toContain("middle characters cut");
	});

	it("skips non-LLM messages", () => {
		const bashExecution = {
			role: "bashExecution",
			command: "ls",
			output: "SHOULD-NOT-APPEAR",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1500,
		} as AgentMessage;
		const text = serializeTurn([user("do it"), bashExecution, assistant("done")]);
		expect(text).toContain("[User]: do it");
		expect(text).toContain("[Assistant]: done");
		expect(text).not.toContain("SHOULD-NOT-APPEAR");
	});

	it("serializes an empty turn to empty text", () => {
		expect(serializeTurn([])).toBe("");
	});
});
