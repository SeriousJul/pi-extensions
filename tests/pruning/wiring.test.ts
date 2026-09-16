import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import pruningExtension from "../../extensions/pruning/index";
import { resolveRecall, type RecallSource } from "../../extensions/pruning/recall";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const WINDOW = 20000;
const RESERVE = 1000;
const BIG_BASH = Array.from({ length: 300 }, (_, i) => `test log line ${i + 1}`).join("\n");
const BIG_READ = Array.from({ length: 400 }, (_, i) => `source line ${i + 1} ${"x".repeat(20)}`).join("\n");

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 19500, // usage-backed estimate above window - reserve (19000)
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

function assistant(toolCall: { id: string; name: string; arguments: Record<string, unknown> } | null, usage: Usage = { ...USAGE, totalTokens: 0 }): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: toolCall ? [{ type: "toolCall", ...toolCall }] : [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage,
		stopReason: "stop",
		timestamp: clock,
	} as AssistantMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	clock += 1000;
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: clock };
}

type ContextHandler = (event: { type: "context"; messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined;
type CompactHandler = (event: {
	type: "session_before_compact";
	preparation: { tokensBefore: number };
	branchEntries: SessionEntry[];
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}) => { cancel?: boolean } | undefined;

interface Captured {
	sessionStart: ((event: { type: "session_start"; reason: string }, ctx: ExtensionContext) => void) | undefined;
	context: ContextHandler | undefined;
	sessionBeforeCompact: CompactHandler | undefined;
	notifications: Array<{ type: string; message: string }>;
}

/** Load the real extension against a fake pi API and return the captured
 * handlers plus the notification log. */
function loadExtension(cwd: string, sm: SessionManager): Captured {
	const captured: Captured = { sessionStart: undefined, context: undefined, sessionBeforeCompact: undefined, notifications: [] };
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "session_start") captured.sessionStart = handler as Captured["sessionStart"];
			if (event === "context") captured.context = handler as ContextHandler;
			if (event === "session_before_compact") captured.sessionBeforeCompact = handler as CompactHandler;
		},
		registerTool: () => {},
		registerCommand: () => {},
	};
	pruningExtension(pi as never);
	const ctx = fakeContext(cwd, sm, captured);
	captured.sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
	return captured;
}

function fakeContext(cwd: string, sm: SessionManager, captured: Captured): ExtensionContext {
	return {
		ui: {
			notify: (message: string, type?: string) => captured.notifications.push({ type: type ?? "info", message }),
			setStatus: () => {},
		},
		mode: "rpc",
		hasUI: true,
		cwd,
		sessionManager: sm,
		model: { contextWindow: WINDOW },
		modelRegistry: {},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Fixture session
// ---------------------------------------------------------------------------

let cwd: string;
let agentDir: string;
let sessionDir: string;
let sm: SessionManager;
let file: string;

/** Build the fixture session: two large tool outputs in an old turn, a final
 * assistant message whose usage backs a context size above the threshold,
 * and a last user message. Written to a file, then re-opened. */
function buildFixture(): void {
	const builder = SessionManager.create(cwd, sessionDir);
	builder.appendMessage(user("q1"));
	builder.appendMessage(assistant({ id: "c1", name: "bash", arguments: { command: "npm test" } }));
	builder.appendMessage(toolResult("c1", "bash", BIG_BASH));
	builder.appendMessage(assistant({ id: "c2", name: "read", arguments: { path: "src/core/foo.ts", offset: 10 } }));
	builder.appendMessage(toolResult("c2", "read", BIG_READ));
	builder.appendMessage(assistant(null, USAGE));
	builder.appendMessage(user("q2"));
	file = builder.getSessionFile()!;
	sm = SessionManager.open(file, sessionDir, cwd);
}

function recallSource(target: SessionManager): RecallSource {
	return {
		getEntryByLine: (line) => {
			const entries = target.getEntries();
			return line >= 2 ? entries[line - 2] : undefined;
		},
		getEntryById: (id) => target.getEntry(id),
	};
}

/** Every recall reference carried by a pruned message list, in order. */
function referencesOf(messages: AgentMessage[]): string[] {
	const refs: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			const m = /recall (\S+) for/.exec(part.text);
			if (m) refs.push(m[1]);
		}
	}
	return refs;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pruning-wiring-"));
	agentDir = mkdtempSync(join(tmpdir(), "pruning-wiring-agent-"));
	sessionDir = join(agentDir, "sessions");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: RESERVE } }));
	buildFixture();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The context handler
// ---------------------------------------------------------------------------

describe("context handler", () => {
	it("prunes the fixture's large outputs and every recall reference resolves to the full original", () => {
		const captured = loadExtension(cwd, sm);
		const messages = sm.buildSessionContext().messages;
		const result = captured.context!({ type: "context", messages });
		expect(result).toBeDefined();
		const out = result!.messages;

		expect(referencesOf(out)).toHaveLength(2);
		// Resolve each reference in the uncapped form to the full original
		// output; the default (capped) form is checked below for the one that
		// exceeds the cap.
		const full = referencesOf(out).map((ref) => resolveRecall(`${ref}:full`, recallSource(sm)));
		expect(full.map((r) => (r.ok ? r.text : null))).toEqual([BIG_BASH, BIG_READ]);
		const refs = referencesOf(out);
		const cappedRead = resolveRecall(refs[1], recallSource(sm));
		expect(cappedRead.ok && cappedRead.truncated).toBe(true);
		if (cappedRead.ok) expect(cappedRead.text).toBe(BIG_READ.slice(0, 12000) + `\n\n... [truncated at 12000 characters. Use "${refs[1]}:full" for the full output.]`);
		const cappedBash = resolveRecall(refs[0], recallSource(sm));
		expect(cappedBash.ok && cappedBash.truncated).toBe(false);

		// The marker shapes carry the per-tool facts.
		const bashMarker = (out[2] as ToolResultMessage).content[0] as { type: "text"; text: string };
		expect(bashMarker.text).toContain(`[bash pruned: "npm test", exit 0, 300 lines,`);
		const readMarker = (out[4] as ToolResultMessage).content[0] as { type: "text"; text: string };
		expect(readMarker.text).toContain(`[read pruned: src/core/foo.ts, lines 10-409,`);
		expect(readMarker.text).toContain("Re-read with the read tool.");

		// Tool call and result pairing survives: same order and ids.
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant", "user"]);
		expect((out[2] as ToolResultMessage).toolCallId).toBe("c1");
		expect((out[4] as ToolResultMessage).toolCallId).toBe("c2");

		// The session file was never modified: the full outputs are intact.
		const fresh = SessionManager.open(file, sessionDir, cwd);
		const freshMessages = fresh.buildSessionContext().messages;
		expect((freshMessages[2] as ToolResultMessage).content[0]).toEqual({ type: "text", text: BIG_BASH });
		expect((freshMessages[4] as ToolResultMessage).content[0]).toEqual({ type: "text", text: BIG_READ });
	});

	it("re-derives the pruned view identically on repeated requests (no saved state)", () => {
		const captured = loadExtension(cwd, sm);
		const messages = sm.buildSessionContext().messages;
		const first = captured.context!({ type: "context", messages });
		const second = captured.context!({ type: "context", messages });
		expect(second).toEqual(first);
	});

	it("sends the request through unchanged below the threshold", () => {
		const builder = SessionManager.create(cwd, sessionDir);
		builder.appendMessage(user("hello"));
		const small = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
		const captured = loadExtension(cwd, small);
		expect(captured.context!({ type: "context", messages: small.buildSessionContext().messages })).toBeUndefined();
	});

	it("notifies once when pruning first activates, then stays quiet", () => {
		const captured = loadExtension(cwd, sm);
		const messages = sm.buildSessionContext().messages;
		captured.context!({ type: "context", messages });
		captured.context!({ type: "context", messages });
		captured.context!({ type: "context", messages });
		const activations = captured.notifications.filter((n) => n.message.includes("first level active"));
		expect(activations).toHaveLength(1);
		expect(activations[0].type).toBe("info");
	});

	it("stays out of the way when pruning is disabled", () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ pruning: { enabled: false }, compaction: { reserveTokens: RESERVE } }));
		const captured = loadExtension(cwd, sm);
		expect(captured.context!({ type: "context", messages: sm.buildSessionContext().messages })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The session_before_compact handler (the prune gate)
// ---------------------------------------------------------------------------

describe("prune gate handler", () => {
	it("cancels a threshold compaction when pruning covers the margin", () => {
		const captured = loadExtension(cwd, sm);
		const result = captured.sessionBeforeCompact!({
			type: "session_before_compact",
			preparation: { tokensBefore: 19500 },
			branchEntries: sm.getBranch(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ cancel: true });
	});

	it("passes a threshold compaction when pruning does not cover the margin", () => {
		const captured = loadExtension(cwd, sm);
		const result = captured.sessionBeforeCompact!({
			type: "session_before_compact",
			preparation: { tokensBefore: 100000 },
			branchEntries: sm.getBranch(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		expect(result).toBeUndefined();
	});

	it("never cancels manual or overflow compactions", () => {
		const captured = loadExtension(cwd, sm);
		for (const reason of ["manual", "overflow"] as const) {
			const result = captured.sessionBeforeCompact!({
				type: "session_before_compact",
				preparation: { tokensBefore: 19500 },
				branchEntries: sm.getBranch(),
				reason,
				willRetry: false,
				signal: new AbortController().signal,
			});
			expect(result, reason).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Ephemeral sessions
// ---------------------------------------------------------------------------

describe("ephemeral session", () => {
	it("carries entry ids instead of line numbers when there is no session file", () => {
		const mem = SessionManager.inMemory(cwd);
		mem.appendMessage(user("q1"));
		mem.appendMessage(assistant({ id: "c1", name: "bash", arguments: { command: "npm test" } }));
		const bigEntryId = mem.appendMessage(toolResult("c1", "bash", BIG_BASH));
		mem.appendMessage(assistant(null, USAGE));
		mem.appendMessage(user("q2"));

		const captured = loadExtension(cwd, mem);
		const result = captured.context!({ type: "context", messages: mem.buildSessionContext().messages });
		expect(result).toBeDefined();
		expect(referencesOf(result!.messages)).toEqual([bigEntryId]);
		const resolved = resolveRecall(bigEntryId, {
			getEntryByLine: () => undefined,
			getEntryById: (id) => mem.getEntry(id),
		});
		expect(resolved.ok && resolved.text).toBe(BIG_BASH);
	});
});
