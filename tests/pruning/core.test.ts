import { describe, expect, it } from "vitest";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { alignMessages, formatSize, headTail, prune } from "../../extensions/pruning/core";
import type { PruneInput, PruneSettings } from "../../extensions/pruning/core";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

function assistantText(text: string): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage: USAGE,
		stopReason: "stop",
		timestamp: clock,
	} as AssistantMessage;
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage: USAGE,
		stopReason: "stop",
		timestamp: clock,
	} as AssistantMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	clock += 1000;
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: clock,
	};
}

function bashExecution(command: string, output: string, exitCode?: number): AgentMessage {
	clock += 1000;
	return {
		role: "bashExecution",
		command,
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		timestamp: clock,
	};
}

let entrySeq = 0;
function entryFor(message: AgentMessage): SessionEntry {
	entrySeq += 1;
	return { type: "message", id: `e${entrySeq}`, parentId: null, timestamp: new Date(clock).toISOString(), message };
}

/** A session whose entries project exactly the given messages, in order, with
 * ids e1..eN in list order. */
function sessionOf(messages: AgentMessage[]): SessionEntry[] {
	return messages.map((message, i) => ({ type: "message", id: `e${i + 1}`, parentId: null, timestamp: new Date(clock).toISOString(), message }));
}

const BASE_SETTINGS: PruneSettings = { enabled: true, minResultTokens: 1000, protectCurrentTurn: true };

/** A prune input that engages: a tiny window forces the estimate over the
 * threshold, and a fake list estimate keeps the test exact. */
function makeInput(overrides: Partial<PruneInput> & { messages: AgentMessage[] }): PruneInput {
	const messages = overrides.messages;
	const entries = overrides.entries ?? sessionOf(messages);
	const referenceFor = overrides.referenceFor ?? ((entry: SessionEntry) => `#${entries.indexOf(entry) + 2}`);
	return {
		contextWindow: 1000,
		reserveTokens: 100,
		settings: BASE_SETTINGS,
		entries,
		referenceFor,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

describe("engagement", () => {
	it("does not engage at or below the threshold and returns the input list", () => {
		const messages = [user("hi"), assistantText("hello")];
		const input = makeInput({ messages, estimateList: () => 900 }); // threshold: 900
		const result = prune(input);
		expect(result.engaged).toBe(false);
		expect(result.messages).toBe(messages);
		expect(result.prunedCount).toBe(0);
	});

	it("engages above the threshold", () => {
		const big = "x".repeat(8000); // 2000 tokens
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "yes" }), toolResult("c1", "bash", big), assistantText("done"), user("q2")];
		const input = makeInput({ messages, estimateList: () => 1100 }); // threshold: 900
		const result = prune(input);
		expect(result.engaged).toBe(true);
		expect(result.prunedCount).toBe(1);
	});

	it("does not engage when the setting is disabled", () => {
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "yes" }), toolResult("c1", "bash", "x".repeat(8000)), user("q2")];
		const result = prune(makeInput({ messages, settings: { ...BASE_SETTINGS, enabled: false }, estimateList: () => 1100 }));
		expect(result.engaged).toBe(false);
		expect(result.prunedCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("eligibility", () => {
	it("never touches outputs at or below minResultTokens", () => {
		const small = "x".repeat(3000); // 750 tokens
		const messages = [user("q1"), assistantToolCall("c1", "grep", {}), toolResult("c1", "grep", small), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("prunes tool results and bash execution messages above the floor", () => {
		const messages = [
			user("q1"),
			assistantToolCall("c1", "bash", { command: "npm test" }),
			toolResult("c1", "bash", "o".repeat(8000)),
			bashExecution("make", "m".repeat(8000), 0),
			assistantText("ok"),
			user("q2"),
		];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(2);
		expect(result.records.map((r) => r.toolName)).toEqual(["bash", "bash"]);
	});

	it("never prunes outputs after the last user message when protectCurrentTurn is set", () => {
		const messages = [
			user("q1"),
			assistantToolCall("c1", "bash", { command: "yes" }),
			toolResult("c1", "bash", "o".repeat(8000)), // old turn: prunable
			assistantText("thinking..."),
			user("q2"),
			assistantToolCall("c2", "bash", { command: "more" }),
			toolResult("c2", "bash", "n".repeat(8000)), // current turn: protected
		];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		expect(result.records[0].toolName).toBe("bash");
		// The current turn's output stays raw: it is not replaced by a marker.
		const current = result.messages[6] as ToolResultMessage;
		expect((current.content[0] as TextContent).text).toBe("n".repeat(8000));
		// The old turn's output is replaced.
		expect((result.messages[2] as ToolResultMessage).content[0]?.type).toBe("text");
		expect(((result.messages[2] as ToolResultMessage).content[0] as TextContent).text).toContain("[bash pruned");
	});

	it("prunes the current turn's outputs when protectCurrentTurn is off", () => {
		const messages = [
			user("q1"),
			user("q2"),
			assistantToolCall("c2", "bash", { command: "more" }),
			toolResult("c2", "bash", "n".repeat(8000)),
		];
		const result = prune(makeInput({ messages, settings: { ...BASE_SETTINGS, protectCurrentTurn: false }, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
	});

	it("leaves image content parts untouched and replaces only the text", () => {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [
				{ type: "text", text: "t".repeat(8000) },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: clock,
		};
		const messages = [user("q1"), assistantToolCall("c1", "read", { path: "img.png" }), message, user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[2] as ToolResultMessage;
		expect(out.content[0]?.type).toBe("text");
		expect((out.content[1] as { type: string }).type).toBe("image");
	});

	it("skips an images-only result: there is no text to replace", () => {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "image", data: "bG9yZW0=", mimeType: "image/png" }],
			isError: false,
			timestamp: clock,
		};
		const messages = [user("q1"), assistantToolCall("c1", "read", { path: "two.png" }), message, user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Marker shapes
// ---------------------------------------------------------------------------

describe("marker shapes", () => {
	it("carries the file pointer for read outputs: path, line range, size, re-read hint, recall reference", () => {
		const content = Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n"); // 400 lines
		const messages = [user("q1"), assistantToolCall("c1", "read", { path: "src/core/foo.ts", offset: 10, limit: 400 }), toolResult("c1", "read", content), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[2] as ToolResultMessage;
		const text = (out.content[0] as TextContent).text;
		expect(text).toMatch(/^\[read pruned: src\/core\/foo\.ts, lines 10-409, ~\d+(\.\d+)?k tokens\. Re-read with the read tool\. recall #4 for this exact output\.\]$/);
	});

	it("falls back to a plain marker when the read tool call is not found", () => {
		const messages = [user("q1"), toolResult("orphan", "read", "f".repeat(8000)), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[1] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toMatch(/^\[read pruned: ~\d+(\.\d+)?k tokens\. recall #3 for this exact output\.\]$/);
	});

	it("carries the shell summary for bash outputs: command, exit code, line count, size, head, omission, tail, recall reference", () => {
		const lines = Array.from({ length: 312 }, (_, i) => `out ${i + 1} ${"x".repeat(10)}`);
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "npm test" }), toolResult("c1", "bash", lines.join("\n")), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[2] as ToolResultMessage;
		const text = (out.content[0] as TextContent).text;
		const expected =
			`[bash pruned: "npm test", exit 0, 312 lines, ${formatSize(Math.ceil(lines.join("\n").length / 4))} tokens.\n` +
			lines.slice(0, 10).join("\n") +
			`\n... 292 lines omitted ...\n` +
			lines.slice(302).join("\n") +
			`\nrecall #4 for full output.]`;
		expect(text).toBe(expected);
	});

	it("omits the omission note when the output fits head plus tail", () => {
		// Long lines push the output past the floor while staying under 20 lines.
		const lines = Array.from({ length: 15 }, (_, i) => `out ${i + 1} ${"x".repeat(300)}`);
		const text = lines.join("\n");
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "ls" }), toolResult("c1", "bash", text), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		const out = result.messages[2] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toContain(`exit 0, 15 lines`);
		expect((out.content[0] as TextContent).text).not.toContain("lines omitted");
	});

	it("reads the exit code from a failing bash tool result", () => {
		const messages = [
			user("q1"),
			assistantToolCall("c1", "bash", { command: "npm test" }),
			{ ...toolResult("c1", "bash", "e".repeat(8000) + "\n\nCommand exited with code 1"), isError: true },
			user("q2"),
		];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		const out = result.messages[2] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toContain(`"npm test", exit 1,`);
	});

	it("summarizes bash execution messages the same way", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `log ${i + 1} ${"x".repeat(90)}`);
		const messages = [user("q1"), bashExecution("make", lines.join("\n"), 0), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[1] as Extract<AgentMessage, { role: "bashExecution" }>;
		expect(out.output).toContain(`[bash pruned: "make", exit 0, 50 lines,`);
		expect(out.output).toContain("... 30 lines omitted ...");
		expect(out.output).toContain("recall #3 for full output.");
		expect(out.command).toBe("make");
	});

	it("carries the plain marker for other tools: name, size, recall reference", () => {
		const messages = [user("q1"), assistantToolCall("c1", "grep", {}), toolResult("c1", "grep", "g".repeat(15200)), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		const out = result.messages[2] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toBe(`[grep pruned: ${formatSize(3800)} tokens. recall #4 for full output.]`);
	});

	it("points a pruned recall result at the original entry via the tool call's reference", () => {
		const messages = [
			user("q1"),
			assistantToolCall("c1", "recall", { ref: "#7" }),
			toolResult("c1", "recall", "r".repeat(8000)),
			user("q2"),
		];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const out = result.messages[2] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toBe(`[recall pruned: ${formatSize(2000)} tokens. recall #7 for full output.]`);
	});

	it("keeps tool call and result pairing: same role, id, and position", () => {
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "x" }), toolResult("c1", "bash", "o".repeat(8000)), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		const out = result.messages[2] as ToolResultMessage;
		expect(out.role).toBe("toolResult");
		expect(out.toolCallId).toBe("c1");
		expect(out.toolName).toBe("bash");
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});
});

// ---------------------------------------------------------------------------
// References and savings
// ---------------------------------------------------------------------------

describe("references and savings", () => {
	it("carries the reference the resolver gives for each entry", () => {
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "x" }), toolResult("c1", "bash", "o".repeat(8000)), user("q2")];
		const entries = sessionOf(messages);
		const result = prune(makeInput({ messages, entries, referenceFor: () => "my-entry-id", estimateList: () => 1100 }));
		const out = result.messages[2] as ToolResultMessage;
		expect((out.content[0] as TextContent).text).toContain("recall my-entry-id for full output.");
	});

	it("sums per-output savings as original minus marker, never negative", () => {
		const a = "a".repeat(8000); // 2000 tokens
		const b = "b".repeat(4000); // 1000 tokens exactly: not pruned (floor)
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "x" }), toolResult("c1", "bash", a), assistantToolCall("c2", "grep", {}), toolResult("c2", "grep", b), user("q2")];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(1);
		const record = result.records[0];
		expect(record.originalTokens).toBe(2000);
		expect(record.markerTokens).toBeLessThan(record.originalTokens);
		expect(result.savingsTokens).toBe(record.savingsTokens);
		expect(record.savingsTokens).toBe(Math.max(0, record.originalTokens - record.markerTokens));
	});

	it("is idempotent: a pruned list re-prunes to itself", () => {
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "x" }), toolResult("c1", "bash", "o".repeat(8000)), user("q2")];
		const first = prune(makeInput({ messages, estimateList: () => 1100 }));
		const second = prune(makeInput({ messages: first.messages, entries: sessionOf(first.messages), estimateList: () => 1100 }));
		expect(second.prunedCount).toBe(0);
		expect(second.messages).toBe(first.messages);
	});

	it("does not touch assistant, user, or compaction summary messages", () => {
		const messages: AgentMessage[] = [
			user("q1"),
			assistantText("a".repeat(8000)),
			{ role: "compactionSummary", summary: "s".repeat(8000), tokensBefore: 100, timestamp: clock },
			user("q2"),
		];
		const result = prune(makeInput({ messages, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(0);
		expect(result.messages).toBe(messages);
	});
});

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

describe("alignment", () => {
	it("maps each outgoing message to its projecting entry", () => {
		const messages = [user("q1"), assistantText("a1"), user("q2")];
		const entries = sessionOf(messages);
		const aligned = alignMessages(entries, messages, (e) => (e.type === "message" ? [e.message] : []));
		expect(aligned).not.toBeNull();
		expect(aligned!.map((e) => e?.id)).toEqual(["e1", "e2", "e3"]);
	});

	it("tolerates a failed assistant message pi removed from state", () => {
		const failed: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "boom" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku",
			usage: USAGE,
			stopReason: "error",
			errorMessage: "boom",
			timestamp: clock,
		} as AssistantMessage;
		const messages = [user("q1"), assistantText("a1"), user("q2")];
		const entries = sessionOf([messages[0], failed, messages[1], messages[2]]);
		const aligned = alignMessages(entries, messages, (e) => (e.type === "message" ? [e.message] : []));
		expect(aligned).not.toBeNull();
	});

	it("returns null on any other divergence, so the pass stays out of the way", () => {
		const messages = [user("q1"), assistantText("a1"), user("q2")];
		const entries = sessionOf(messages);
		const tampered = [...messages, assistantText("ghost")];
		expect(alignMessages(entries, tampered, (e) => (e.type === "message" ? [e.message] : []))).toBeNull();
		const missing = messages.slice(0, 2);
		expect(alignMessages(entries, missing, (e) => (e.type === "message" ? [e.message] : []))).toBeNull();
	});

	it("prune returns the input list unchanged when the alignment fails", () => {
		const messages = [user("q1"), assistantToolCall("c1", "bash", { command: "x" }), toolResult("c1", "bash", "o".repeat(8000)), user("q2")];
		const orphanEntries: SessionEntry[] = [entryFor(user("different"))];
		const result = prune(makeInput({ messages, entries: orphanEntries, estimateList: () => 1100 }));
		expect(result.prunedCount).toBe(0);
		expect(result.messages).toBe(messages);
	});
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("headTail", () => {
	it("splits head, tail, and omitted count", () => {
		const output = Array.from({ length: 312 }, (_, i) => `l${i + 1}`).join("\n");
		expect(headTail(output)).toEqual({
			head: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n"),
			tail: Array.from({ length: 10 }, (_, i) => `l${303 + i}`).join("\n"),
			totalLines: 312,
			omittedLines: 292,
		});
	});

	it("carries the whole short output with no omission", () => {
		expect(headTail("a\nb")).toEqual({ head: "a\nb", tail: "", totalLines: 2, omittedLines: 0 });
	});
});

describe("formatSize", () => {
	it("rounds to k with one decimal above 1000", () => {
		expect(formatSize(5200)).toBe("~5.2k");
		expect(formatSize(900)).toBe("~900");
	});
});
