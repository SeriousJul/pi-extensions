import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextBaseline } from "../../extensions/compress/index";

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

function assistant(text: string, stopReason: "stop" | "error" | "aborted" = "stop"): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage: USAGE,
		stopReason,
		timestamp: clock,
	} as AssistantMessage;
}

function roles(messages: AgentMessage[]): string[] {
	return messages.map((m) => m.role);
}

// ---------------------------------------------------------------------------
// Baseline rebuild: pi's own context projection, verified against the real
// SessionManager
// ---------------------------------------------------------------------------

describe("contextBaseline", () => {
	it("equals pi's session context for a plain branch", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("a1"));
		sm.appendMessage(user("q2"));
		sm.appendMessage(assistant("a2"));
		expect(contextBaseline(sm)).toEqual(sm.buildSessionContext().messages);
	});

	it("matches pi's context for a compacted branch with a retained tail", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("a1"));
		const kept = sm.appendMessage(user("q2"));
		sm.appendMessage(assistant("a2"));
		sm.appendCompaction("summary of the first half", kept, 1000);
		sm.appendMessage(user("q3"));
		sm.appendMessage(assistant("a3"));

		const pi = sm.buildSessionContext().messages;
		expect(contextBaseline(sm)).toEqual(pi);
		// The retained tail and the post-compaction entries follow the
		// compaction summary; the summarized prefix is gone.
		expect(roles(pi)).toEqual(["compactionSummary", "user", "assistant", "user", "assistant"]);
	});

	it("keeps a plain interrupted (aborted) assistant message, as pi does in state", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("partial answer", "aborted"));

		const baseline = contextBaseline(sm);
		expect(baseline).toEqual(sm.buildSessionContext().messages);
		const last = baseline.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.stopReason).toBe("aborted");
	});

	it("drops assistant error messages that pi removed from agent state on auto-retry", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("ok answer"));
		sm.appendMessage(assistant("boom", "error"));

		const baseline = contextBaseline(sm);
		expect(baseline).toEqual(
			sm.buildSessionContext().messages.filter((m) => !(m.role === "assistant" && m.stopReason === "error")),
		);
		expect(JSON.stringify(baseline)).not.toContain("boom");
		expect(roles(baseline)).toEqual(["user", "assistant"]);
	});

	it("projects custom_message entries into the baseline, as pi does", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		const content: TextContent[] = [{ type: "text", text: "a note" }];
		sm.appendCustomMessageEntry("note", content, true);

		const baseline = contextBaseline(sm);
		expect(baseline).toEqual(sm.buildSessionContext().messages);
		expect(roles(baseline)).toEqual(["user", "custom"]);
	});
});
