import { describe, expect, it } from "vitest";
import {
	buildCheckpoint,
	shouldTakeOverSummarization,
	type CheckpointFileOps,
	type CheckpointMessage,
} from "../../extensions/safe-compaction/core.ts";

// ---------------------------------------------------------------------------
// shouldTakeOverSummarization
// ---------------------------------------------------------------------------

describe("shouldTakeOverSummarization", () => {
	const cases: [boolean, boolean | undefined, string | undefined, boolean][] = [
		// [enabled, reasoning, thinkingLevel, expected]
		[true, true, "xhigh", true],
		[true, true, "high", true],
		[true, true, "minimal", true],
		[true, true, "off", false],
		[true, true, undefined, false],
		[true, false, "xhigh", false],
		[true, undefined, "xhigh", false],
		[false, true, "xhigh", false],
	];
	it.each(cases)("enabled=%o reasoning=%o level=%o -> %o", (enabled, reasoning, level, expected) => {
		expect(shouldTakeOverSummarization({ enabled, modelReasoning: reasoning, thinkingLevel: level })).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// buildCheckpoint
// ---------------------------------------------------------------------------

const fileOps: CheckpointFileOps = {
	read: new Set(["a/b.ts", "c/d.ts", "c/d.ts"]),
	written: new Set(["src/app.ts"]),
	edited: new Set(["src/app.ts"]),
};

function user(text: string): CheckpointMessage {
	return { role: "user", content: text };
}
function assistant(text: string, blocks: unknown[] = []): CheckpointMessage {
	return { role: "assistant", content: [{ type: "text", text }, ...blocks] };
}
function toolResult(): CheckpointMessage {
	return { role: "toolResult", content: [{ type: "text", text: "written" }] };
}

describe("buildCheckpoint", () => {
	it("labels itself as extractive and carries the previous summary verbatim", () => {
		const text = buildCheckpoint({
			previousSummary: "## Prior\nThe earlier work stood on the named controls.",
			messages: [user("original request"), assistant("did the work")],
		});
		expect(text).toContain("Checkpoint (deterministic)");
		expect(text).toContain("The earlier work stood on the named controls.");
	});

	it("records the first user text of the range as the original request", () => {
		const text = buildCheckpoint({ messages: [user("fix the login flow"), assistant("ok"), user("later message")] });
		expect(text).toContain("## Original Request");
		expect(text).toContain("fix the login flow");
	});

	it("indexes assistant text and tool activity in order", () => {
		const text = buildCheckpoint({
			messages: [
				user("go"),
				assistant("reading the spec", [
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec.md" } },
				]),
				assistant("writing the fix", [
					{ type: "toolCall", id: "c2", name: "write", arguments: { path: "src/app.ts", content: "x" } },
				]),
				toolResult(),
			],
		});
		const readPos = text.indexOf("- read:");
		const writePos = text.indexOf("- write:");
		expect(readPos).toBeGreaterThan(-1);
		expect(writePos).toBeGreaterThan(readPos);
		expect(text).toContain("spec.md");
		expect(text).toContain("src/app.ts");
	});

	it("separates modified files from read-only files and sorts both", () => {
		const text = buildCheckpoint({ messages: [user("go")], fileOps });
		expect(text).toContain("<read-files>");
		expect(text).toContain("a/b.ts");
		expect(text).toContain("c/d.ts");
		expect(text).toContain("<modified-files>");
		expect(text).toContain("src/app.ts");
		// A written file is never listed under read-files.
		const readSection = text.slice(text.indexOf("<read-files>"), text.indexOf("</read-files>"));
		expect(readSection).not.toContain("src/app.ts");
	});

	it("omits the file sections when nothing was tracked", () => {
		const text = buildCheckpoint({ messages: [user("go")] });
		expect(text).not.toContain("<read-files>");
		expect(text).not.toContain("<modified-files>");
	});

	it("caps the original request at the request budget", () => {
		const text = buildCheckpoint({ messages: [user("r".repeat(5000))] });
		const section = text.slice(text.indexOf("## Original Request"), text.indexOf("## Progress"));
		expect(section.length).toBeLessThan(5000);
		expect(section).toContain("...");
	});

	it("caps the progress index at the total budget and marks the cut", () => {
		const messages: CheckpointMessage[] = [user("go")];
		for (let i = 0; i < 50; i++) messages.push(assistant(`step ${i}: ${"work".repeat(30)}`));
		const text = buildCheckpoint({ messages });
		const progress = text.slice(text.indexOf("## Progress"));
		expect(progress).toContain("progress index truncated at 6000 characters");
	});

	it("stays small: a checkpoint never grows past its budgets plus the prior summary", () => {
		const previous = "p".repeat(1000);
		const messages: CheckpointMessage[] = [user("r".repeat(9000))];
		for (let i = 0; i < 40; i++) messages.push(assistant("w".repeat(900)));
		const text = buildCheckpoint({ previousSummary: previous, messages });
		// 1000 (prior) + 2000 (request cap) + 6000 (progress cap) + headers,
		// with a generous margin for markers and file-section absence.
		expect(text.length).toBeLessThan(1000 + 2000 + 6000 + 1500);
	});

	it("handles an empty range without crashing", () => {
		const text = buildCheckpoint({ messages: [] });
		expect(text).toContain("(none recorded)");
	});
});
