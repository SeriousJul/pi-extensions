/**
 * Unit tests that pin the Tool row header painter (issue #137, ADR 0038).
 *
 * The painter is pure and theme-light, so the tests drive it with a fake
 * painter and assert the exact line: the short-name form, the shrunk rule and
 * the `…` truncation at a narrow width, the MCP name form, and the theme
 * calls. No pi or TUI is loaded.
 */
import { describe, expect, it } from "vitest";
import {
	formatFallbackCallLine,
	mcpDisplayName,
	paintToolRowHeader,
	type ToolRowHeaderPainter,
} from "../../extensions/tool-headers/render.ts";

/** A painter that records its calls and returns the plain text, like a theme
 * that emits no escape codes. */
function recordingPainter() {
	const calls: Array<{ color: string; text: string } | { bold: string }> = [];
	const paint: ToolRowHeaderPainter = {
		fg: (color, text) => {
			calls.push({ color, text });
			return text;
		},
		bold: (text) => {
			calls.push({ bold: text });
			return text;
		},
	};
	return { paint, calls };
}

describe("paintToolRowHeader", () => {
	it("paints the short-name form: name in a rule filled to the content edge", () => {
		const { paint } = recordingPainter();
		// "read" is 4 cells; width 98 leaves 90 rule cells after `── read `.
		const line = paintToolRowHeader("read", 98, paint);
		expect(line).toBe(`── read ${"─".repeat(90)}`);
	});

	it("shrinks the trailing rule to zero before it touches the name", () => {
		const { paint } = recordingPainter();
		// 7-cell name at width 10: `── abcdefg` fills it exactly, no rule left.
		expect(paintToolRowHeader("abcdefg", 10, paint)).toBe("── abcdefg");
		// 6 cells at width 10: the line is shorter than the width, no rule.
		expect(paintToolRowHeader("abcdef", 10, paint)).toBe("── abcdef");
	});

	it("truncates the name with a trailing ellipsis only when the name alone does not fit", () => {
		const { paint } = recordingPainter();
		// 8-cell name at width 10: `── ` leaves 7 cells; the name becomes 6 + `…`.
		expect(paintToolRowHeader("abcdefgh", 10, paint)).toBe("── abcdef…");
		// A very long name at a narrow width keeps the prefix, ends in `…`.
		const long = "a".repeat(40);
		expect(paintToolRowHeader(long, 12, paint)).toBe(`── ${"a".repeat(8)}…`);
	});

	it("is always exactly one line", () => {
		const { paint } = recordingPainter();
		for (const width of [1, 4, 10, 50, 98]) {
			const line = paintToolRowHeader("a".repeat(30), width, paint);
			expect(line.includes("\n")).toBe(false);
		}
	});

	it("styles the rule in borderMuted and the name bold in toolTitle", () => {
		const { paint, calls } = recordingPainter();
		paintToolRowHeader("read", 20, paint);
		// `── read ` is 8 cells; the fill is 12 rule cells.
		expect(calls).toEqual([
			{ color: "borderMuted", text: "──" },
			{ bold: "read" },
			{ color: "toolTitle", text: "read" },
			{ color: "borderMuted", text: "─".repeat(12) },
		]);
	});
});

describe("mcpDisplayName", () => {
	it("drops pi's mcp__ spelling for an MCP tool", () => {
		expect(mcpDisplayName("mcp__github__searchIssue")).toBe("github/searchIssue");
	});

	it("keeps the non-greedy server split, matching pi's own rule", () => {
		expect(mcpDisplayName("mcp__github__search__issue")).toBe("github/search__issue");
	});

	it("keeps the raw name for every non-MCP tool", () => {
		expect(mcpDisplayName("bash")).toBe("bash");
		expect(mcpDisplayName("bash_bg")).toBe("bash_bg");
		expect(mcpDisplayName("mcp__solo")).toBe("mcp__solo");
	});
});

describe("formatFallbackCallLine", () => {
	const paint: ToolRowHeaderPainter = {
		fg: (_color, text) => text,
		bold: (text) => text,
	};

	it("shows the title alone when there are no arguments", () => {
		expect(formatFallbackCallLine("tool_search", undefined, paint, false)).toBe("tool_search");
	});

	it("shows collapsed key=value arguments on the title line", () => {
		expect(formatFallbackCallLine("job_wait", { jobId: "jb-1", timeout: 5 }, paint, false)).toBe(
			"job_wait jobId=\"jb-1\" timeout=5",
		);
	});

	it("shows one key: value line per argument when expanded", () => {
		expect(formatFallbackCallLine("job_wait", { jobId: "jb-1" }, paint, true)).toBe("job_wait\n  jobId: jb-1");
	});
});
