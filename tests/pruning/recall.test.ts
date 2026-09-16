import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RECALL_CAP, parseRecallRef, recallText, resolveRecall, type RecallSource } from "../../extensions/pruning/recall";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 } as UserMessage,
	};
}

function toolResultEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		} as ToolResultMessage,
	};
}

function bashEntry(id: string, output: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "bashExecution",
			command: "make",
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		},
	};
}

function assistantEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		} as AssistantMessage,
	};
}

/** A source over a fixed entry list, line number = index + 2 (line 1 is the header). */
function sourceOf(entries: SessionEntry[]): RecallSource {
	return {
		getEntryByLine: (line) => (line >= 2 ? entries[line - 2] : undefined),
		getEntryById: (id) => entries.find((e) => e.id === id),
	};
}

// ---------------------------------------------------------------------------
// Reference parsing
// ---------------------------------------------------------------------------

describe("parseRecallRef", () => {
	it("parses line references", () => {
		expect(parseRecallRef("#412")).toEqual({ kind: "line", line: 412, full: false });
		expect(parseRecallRef("#412:full")).toEqual({ kind: "line", line: 412, full: true });
	});

	it("parses id references", () => {
		expect(parseRecallRef("01J5ABCDEF12345678")).toEqual({ kind: "id", id: "01J5ABCDEF12345678", full: false });
		expect(parseRecallRef("abc-def_123:full")).toEqual({ kind: "id", id: "abc-def_123", full: true });
	});

	it("rejects malformed references", () => {
		expect(parseRecallRef("#")).toMatchObject({ kind: "invalid" });
		expect(parseRecallRef("#0")).toMatchObject({ kind: "invalid" });
		expect(parseRecallRef("#1")).toMatchObject({ kind: "invalid" }); // the header line is not an entry
		expect(parseRecallRef("#4.2")).toMatchObject({ kind: "invalid" });
		expect(parseRecallRef(":full")).toMatchObject({ kind: "invalid" });
		expect(parseRecallRef("")).toMatchObject({ kind: "invalid" });
		expect(parseRecallRef("has space")).toMatchObject({ kind: "invalid" });
	});
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveRecall", () => {
	const big = "z".repeat(20000);
	const entries = [userEntry("u1", "q"), toolResultEntry("t1", big), bashEntry("b1", "log line")];
	const source = sourceOf(entries);

	it("resolves a line reference to the full original output", () => {
		const outcome = resolveRecall("#3", source, 50000);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.text).toBe(big);
	});

	it("resolves an entry id reference to the same output", () => {
		const outcome = resolveRecall("t1", source, 50000);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.text).toBe(big);
	});

	it("resolves a bash execution entry to its output", () => {
		const outcome = resolveRecall("#4", source, 50000);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.text).toBe("log line");
	});

	it("caps the default answer at the cap and points at the full form", () => {
		const outcome = resolveRecall("#3", source, 12000);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.truncated).toBe(true);
			expect(outcome.text.length).toBeLessThan(20000);
			expect(outcome.text).toContain(`... [truncated at 12000 characters. Use "#3:full" for the full output.]`);
			expect(outcome.text.startsWith("z".repeat(12000))).toBe(true);
		}
	});

	it("applies no cap to the :full form", () => {
		const outcome = resolveRecall("#3:full", source);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.truncated).toBe(false);
			expect(outcome.text).toBe(big);
		}
	});

	it("applies no cap to a short answer", () => {
		const outcome = resolveRecall("#4", source);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.truncated).toBe(false);
	});

	it("errors when the entry is not a tool result", () => {
		expect(resolveRecall("#2", source).ok).toBe(false);
		expect(resolveRecall("u1", source).ok).toBe(false);
		expect(resolveRecall("a1", assistantOnly()).ok).toBe(false);
		function assistantOnly(): RecallSource {
			return sourceOf([assistantEntry("a1", "a")]);
		}
	});

	it("errors for a compaction or label entry", () => {
		const entries: SessionEntry[] = [
			{ type: "compaction", id: "cmp1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: "s", firstKeptEntryId: "u1", tokensBefore: 1 },
			{ type: "label", id: "lbl1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", targetId: "u1", label: "x" },
		];
		expect((resolveRecall("cmp1", sourceOf(entries)) as { error: string }).error).toContain("not a tool result");
		expect((resolveRecall("lbl1", sourceOf(entries)) as { error: string }).error).toContain("not a tool result");
	});

	it("errors for missing lines and ids", () => {
		expect((resolveRecall("#99", source) as { error: string }).error).toContain("line 99");
		expect((resolveRecall("nope", source) as { error: string }).error).toContain("nope");
	});

	it("errors for malformed references", () => {
		expect((resolveRecall("bogus ref!", source) as { error: string }).error).toContain("invalid reference");
	});

	it("uses the default cap of 12000 characters", () => {
		expect(DEFAULT_RECALL_CAP).toBe(12000);
		const outcome = resolveRecall("#3", source);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.text.length).toBe(12000 + 2 + `... [truncated at 12000 characters. Use "#3:full" for the full output.]`.length);
	});
});

describe("recallText", () => {
	it("joins the text parts of a tool result and notes excluded images", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "t2",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "read",
				content: [
					{ type: "text", text: "part one" },
					{ type: "text", text: "part two" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 0,
			} as ToolResultMessage,
		};
		expect(recallText(entry)).toBe("part one\npart two\n\n[1 image part(s) not included in this recall]");
	});

	it("returns undefined for non-tool-result entries", () => {
		expect(recallText(userEntry("u1", "q"))).toBeUndefined();
		expect(recallText(assistantEntry("a1", "a"))).toBeUndefined();
	});
});
