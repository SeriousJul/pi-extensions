import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, ToolCall, Usage, UserMessage } from "@earendil-works/pi-ai";
import { BRANCH_SUMMARY_PREAMBLE, BRANCH_SUMMARY_PROMPT, SUMMARIZATION_SYSTEM_PROMPT } from "../../extensions/safe-branch-summary/prompts.ts";
import {
	MAX_SUMMARY_OUTPUT_TOKENS,
	NO_CONTENT_SUMMARY,
	decideSafeBranchSummary,
	finalizeBranchSummary,
	type SafeBranchSummaryInput,
} from "../../extensions/safe-branch-summary/core.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USAGE: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

function assistant(content: (TextContent | ToolCall)[], stopReason: "stop" | "error" | "aborted" | "length" = "stop"): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: USAGE,
		stopReason,
		...(stopReason === "error" ? { errorMessage: "boom" } : {}),
		timestamp: clock,
	} as AssistantMessage;
}

function textOf(s: string): TextContent {
	return { type: "text", text: s };
}

let callId = 0;
function writeCall(path: string, content: string): ToolCall {
	callId += 1;
	return { type: "toolCall", id: `call-${callId}`, name: "write", arguments: { path, content } };
}

const BASE: Omit<SafeBranchSummaryInput, "entries"> = {
	contextWindow: 8192,
	maxOutputTokens: 16384,
	reserveTokens: 2048,
	inflationFactor: 2.0,
};

function entriesFor(...texts: string[]): ReturnType<SessionManager["getEntries"]> {
	const sm = SessionManager.inMemory("/tmp");
	for (const text of texts) {
		sm.appendMessage(user(`task: ${text.slice(0, 8)}`));
		sm.appendMessage(assistant([textOf(text)]));
	}
	return sm.getEntries();
}

// ---------------------------------------------------------------------------
// Degenerate cases
// ---------------------------------------------------------------------------

describe("degenerate cases", () => {
	it("an empty branch yields no summary entry", () => {
		expect(decideSafeBranchSummary({ ...BASE, entries: [] })).toEqual({ kind: "no-branch" });
	});

	it("a window at or below the reserve soft-skips", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("some content here"), contextWindow: 2048 });
		expect(decision.kind).toBe("soft-skip");
		if (decision.kind === "soft-skip") expect(decision.notice).toContain("at or below the reserved margin");
	});

	it("a missing window soft-skips", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("some content here"), contextWindow: undefined });
		expect(decision.kind).toBe("soft-skip");
	});

	it("a zero safe budget soft-skips instead of selecting with no limit", () => {
		// window - reserve = 1, factor 2.0 -> floor(0.5) = 0; pi's preparation
		// treats a 0 budget as unlimited, so the core must refuse the call.
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("some content here"), contextWindow: 2049 });
		expect(decision.kind).toBe("soft-skip");
		if (decision.kind === "soft-skip") expect(decision.notice).toContain("zero");
	});

	it("a non-empty branch with nothing that fits yields the built-in's no-content entry", () => {
		// The single newest message (50k chars = 12500 estimated tokens)
		// alone exceeds the 3072-token budget, so the selection is empty.
		const big = "x".repeat(50_000);
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor(big) });
		expect(decision).toEqual({ kind: "no-content" });
		expect(NO_CONTENT_SUMMARY).toBe("No content to summarize");
	});
});

// ---------------------------------------------------------------------------
// Budget math
// ---------------------------------------------------------------------------

describe("budget math", () => {
	it("safe budget is (window - reserve) / factor, floored", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("a", "b") });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.budgetTokens).toBe(Math.floor((8192 - 2048) / 2.0));
		}
	});

	it("the floor is visible for a non-integral division", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("a"), contextWindow: 8195, reserveTokens: 2048, inflationFactor: 3 });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			// (8195 - 2048) / 3 = 2049
			expect(decision.budgetTokens).toBe(2049);
		}
	});

	it("the output cap is the smaller of 4096 and the model's max output", () => {
		const capped = decideSafeBranchSummary({ ...BASE, entries: entriesFor("a"), maxOutputTokens: 1000 });
		expect(capped.kind).toBe("summarize");
		if (capped.kind === "summarize") expect(capped.maxTokens).toBe(1000);
		const uncapped = decideSafeBranchSummary({ ...BASE, entries: entriesFor("a"), maxOutputTokens: undefined });
		if (uncapped.kind === "summarize") expect(uncapped.maxTokens).toBe(MAX_SUMMARY_OUTPUT_TOKENS);
	});
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("selection", () => {
	it("a branch that fits the safe budget is summarized in full", () => {
		const a = `alpha-${"a".repeat(400)}`;
		const b = `beta-${"b".repeat(400)}`;
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor(a, b) });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.userText).toContain(a);
			expect(decision.userText).toContain(b);
		}
	});

	it("an oversized branch keeps the newest content and drops the oldest", () => {
		// Each reply is 4500 chars = 1125 estimated tokens; the safe budget
		// is (8192 - 2048) / 2 = 3072, so exactly the two newest replies fit.
		const oldest = `oldest-${"c".repeat(4493)}`;
		const middle = `middle-${"d".repeat(4493)}`;
		const newest = `newest-${"e".repeat(4493)}`;
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor(oldest, middle, newest) });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.userText).toContain(newest);
			expect(decision.userText).toContain(middle);
			expect(decision.userText).not.toContain(oldest);
			// The selection stays in chronological order: the kept middle
			// reply comes before the kept newest reply.
			expect(decision.userText.indexOf(middle)).toBeLessThan(decision.userText.indexOf(newest));
		}
	});
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

describe("prompt assembly", () => {
	it("wraps the serialized conversation and appends the default branch prompt", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("hello world") });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
			expect(decision.userText).toContain("<conversation>");
			expect(decision.userText).toContain("[User]: task: hello wo");
			expect(decision.userText).toContain("[Assistant]: hello world");
			expect(decision.userText.endsWith(BRANCH_SUMMARY_PROMPT)).toBe(true);
			expect(decision.userText).toContain("## Goal");
		}
	});

	it("appends custom focus instructions after the default prompt", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("hello world"), customInstructions: "Focus on the bug fix" });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.userText).toContain(BRANCH_SUMMARY_PROMPT);
			expect(decision.userText).toContain("Additional focus: Focus on the bug fix");
		}
	});

	it("the replace variant uses the custom instructions alone", () => {
		const decision = decideSafeBranchSummary({
			...BASE,
			entries: entriesFor("hello world"),
			customInstructions: "Just say what the branch did.",
			replaceInstructions: true,
		});
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.userText.endsWith("Just say what the branch did.")).toBe(true);
			expect(decision.userText).not.toContain("Create a structured summary");
		}
	});

	it("replace without custom instructions keeps the default prompt", () => {
		const decision = decideSafeBranchSummary({ ...BASE, entries: entriesFor("hello world"), replaceInstructions: true });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") expect(decision.userText.endsWith(BRANCH_SUMMARY_PROMPT)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// File sections
// ---------------------------------------------------------------------------

describe("file sections", () => {
	it("reports the read and modified files of the selected content", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("read and write stuff"));
		sm.appendMessage(
			assistant([
				writeCall("src/edit-me.ts", `m-${"m".repeat(200)}`),
				{ type: "toolCall", id: "call-r", name: "read", arguments: { path: "src/only-read.ts" } },
				{ type: "toolCall", id: "call-r2", name: "read", arguments: { path: "src/both.ts" } },
			]),
		);
		const decision = decideSafeBranchSummary({ ...BASE, entries: sm.getEntries() });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.modifiedFiles).toEqual(["src/edit-me.ts"]);
			expect(decision.readFiles).toEqual(["src/both.ts", "src/only-read.ts"]);
		}
	});

	it("carries the file lists of nested branch summaries", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("first work"));
		sm.appendMessage(assistant([textOf(`did first work ${"a".repeat(100)}`)]));
		sm.branchWithSummary(sm.getLeafId(), "earlier summary", { readFiles: ["src/carried.ts"], modifiedFiles: ["src/carried-edit.ts"] }, false);
		sm.appendMessage(user("second work"));
		sm.appendMessage(assistant([textOf(`did second work ${"b".repeat(100)}`)]));
		const decision = decideSafeBranchSummary({ ...BASE, entries: sm.getEntries() });
		expect(decision.kind).toBe("summarize");
		if (decision.kind === "summarize") {
			expect(decision.readFiles).toContain("src/carried.ts");
			expect(decision.modifiedFiles).toContain("src/carried-edit.ts");
		}
	});

	it("finalize assembles preamble, summary, and file sections", () => {
		const summary = finalizeBranchSummary("## Goal\ndid a thing", ["src/a.ts"], ["src/b.ts"]);
		expect(summary.startsWith(BRANCH_SUMMARY_PREAMBLE)).toBe(true);
		expect(summary).toContain("## Goal\ndid a thing");
		expect(summary).toContain("<read-files>\nsrc/a.ts\n</read-files>");
		expect(summary).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
	});

	it("finalize appends nothing without file ops", () => {
		expect(finalizeBranchSummary("text", [], [])).toBe(BRANCH_SUMMARY_PREAMBLE + "text");
	});
});
