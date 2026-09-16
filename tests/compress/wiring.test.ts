import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { reconcileContext } from "../../extensions/compress/index";

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

function assistant(text: string, stopReason: "stop" | "error" | "aborted" | "length" = "stop"): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage: USAGE,
		stopReason,
		...(stopReason === "error" ? { errorMessage: text } : {}),
		timestamp: clock,
	} as AssistantMessage;
}

function roles(messages: AgentMessage[]): string[] {
	return messages.map((m) => m.role);
}

function flattenedMessages(request: { preamble: { messages: AgentMessage[] }; turns: { messages: AgentMessage[] }[] }): AgentMessage[] {
	return [request.preamble, ...request.turns].flatMap((t) => t.messages);
}

// pi's own context projection, the stand-in for what pi holds in agent
// state: buildSessionContext() over the session file. The tests model pi's
// state removals by filtering the projection the way pi does.
function piContext(sm: SessionManager): AgentMessage[] {
	return sm.buildSessionContext().messages;
}

// ---------------------------------------------------------------------------
// Reconciliation: pi's own context projection, verified against the real
// SessionManager
// ---------------------------------------------------------------------------

describe("reconcileContext", () => {
	it("equals pi's session context for a plain branch", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("a1"));
		sm.appendMessage(user("q2"));
		sm.appendMessage(assistant("a2"));

		const request = reconcileContext(sm.buildContextEntries(), piContext(sm));
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(piContext(sm));
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

		const pi = piContext(sm);
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
		// The retained tail and the post-compaction entries follow the
		// compaction summary; the summarized prefix is gone.
		expect(roles(pi)).toEqual(["compactionSummary", "user", "assistant", "user", "assistant"]);
	});

	it("keeps a plain interrupted (aborted) assistant message, as pi does in state", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("partial answer", "aborted"));

		const pi = piContext(sm);
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		const last = flattenedMessages(request!).at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.stopReason).toBe("aborted");
	});

	it("reconciles when pi removed an auto-retried error message from state", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("ok answer"));
		const errorEntryId = sm.appendMessage(assistant("boom", "error"));

		// pi's state after _prepareRetry: the error message is gone, the
		// entry stays in the file.
		const pi = piContext(sm).filter((m) => !(m.role === "assistant" && m.stopReason === "error"));
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
		expect(JSON.stringify(flattenedMessages(request!))).not.toContain("boom");
		// Span identity follows the full projection: the removed error
		// entry's ID stays in the turn, so prewarm and the context hook
		// compute the same span key.
		expect(request!.turns[0].entryIds).toContain(errorEntryId);
	});

	it("keeps an assistant error message pi did not auto-retry, as pi does in state", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("ok answer"));
		sm.appendMessage(assistant("401 invalid api key", "error"));

		// A non-retryable provider error: pi keeps the message in state and
		// sends it on the next request.
		const pi = piContext(sm);
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
		const last = flattenedMessages(request!).at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.stopReason).toBe("error");
	});

	it("reconciles a mixed branch: one error retried away, one kept", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("rate limited", "error"));
		sm.appendMessage(assistant("ok answer"));
		sm.appendMessage(assistant("401 invalid api key", "error"));
		sm.appendMessage(user("q2"));
		sm.appendMessage(assistant("a2"));

		// pi's state: the first error was auto-retried away, the second
		// (non-retryable) stays.
		const all = piContext(sm);
		const pi = all.filter((m, i) => !(m.role === "assistant" && m.stopReason === "error" && i === 1));
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
	});

	it("reconciles a truncated (length) message pi removed on overflow recovery", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("truncated answer", "length"));
		sm.appendMessage(assistant("ok answer"));

		const pi = piContext(sm).filter((m) => !(m.role === "assistant" && m.stopReason === "length"));
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
	});

	it("projects custom_message entries into the request, as pi does", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		const content: TextContent[] = [{ type: "text", text: "a note" }];
		sm.appendCustomMessageEntry("note", content, true);

		const pi = piContext(sm);
		const request = reconcileContext(sm.buildContextEntries(), pi);
		expect(request).not.toBeNull();
		expect(flattenedMessages(request!)).toEqual(pi);
		expect(roles(flattenedMessages(request!))).toEqual(["user", "custom"]);
	});

	it("returns null when a non-failed message differs from pi's state", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));
		sm.appendMessage(assistant("a1"));

		const tampered = piContext(sm).map((m) =>
			m.role === "assistant" && m.content.length > 0 ? { ...m, content: [...m.content, { type: "text" as const, text: "extra" }] } : m,
		);
		expect(reconcileContext(sm.buildContextEntries(), tampered)).toBeNull();
	});

	it("returns null when pi's state carries a message the entries do not project", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("q1"));

		const extra = [...piContext(sm), assistant("ghost")];
		expect(reconcileContext(sm.buildContextEntries(), extra)).toBeNull();
	});

	it("returns null when the branch is empty but pi's state is not", () => {
		expect(reconcileContext([], [user("q1")])).toBeNull();
	});
});
