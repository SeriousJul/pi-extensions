import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import {
	buildNotice,
	buildPointer,
	bytesFromTokens,
	countLines,
	countResultLines,
	computeBound,
	computeHeadroom,
	cutBlocks,
	DEFAULT_MAX_OUTPUT_TOKENS,
	fitsWithinBudget,
	floorTokensOf,
	formatBytes,
	formatTokens,
	IMAGE_CHARGE_BYTES,
	measureBlocks,
	type ContentBlock,
	PI_MAX_OUTPUT_BYTES,
	PI_MAX_OUTPUT_LINES,
	type BoundSettings,
	splitReadNotice,
	tokensFromBytes,
} from "../../extensions/output-limits/core";

// The pure Bound, Headroom, and cut math. The cutters are pi's own real
// functions, handed in exactly the way the wiring hands them over: the plan
// is what this file tests, and pi's semantics come free.
const MATH = { bytesPerChar: 4, inflation: 2.0 };
const CUTTERS = { head: truncateHead, tail: truncateTail };

function settings(over: Partial<BoundSettings> = {}): BoundSettings {
	return {
		shareOfHeadroom: 0.25,
		minOutputBytes: 4096,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		maxLines: PI_MAX_OUTPUT_LINES,
		math: MATH,
		...over,
	};
}

function text(content: string): ContentBlock {
	return { type: "text", text: content };
}

function image(): ContentBlock {
	return { type: "image", data: "AAAA", mimeType: "image/png" };
}

const known = (tokens: number) => ({ known: true as const, tokens, effectiveWindow: 150_000, reserveTokens: 16_384, usedTokens: 0 });

function plan(blocks: ContentBlock[], over: Partial<Parameters<typeof cutBlocks>[0]> = {}) {
	return cutBlocks({
		blocks,
		budgetBytes: 1_000_000,
		maxLines: PI_MAX_OUTPUT_LINES,
		direction: "head",
		cutters: CUTTERS,
		pointer: "[p]",
		notice: "",
		...over,
	});
}

/** The text a plan publishes, notice excluded. */
function published(plan: ReturnType<typeof cutBlocks>): string {
	return plan.blocks
		.map((block) => (block.kind === "pointer" ? "[p]" : block.kind === "image" ? "<image>" : block.text))
		.join("|");
}

// ---------------------------------------------------------------------------
// The pi figures the defaults are pinned to
// ---------------------------------------------------------------------------

describe("pi's own figures", () => {
	it("restates pi's per-call limits exactly, so a pi change fails here instead of shifting every Bound", () => {
		expect(PI_MAX_OUTPUT_BYTES).toBe(DEFAULT_MAX_BYTES);
		expect(PI_MAX_OUTPUT_LINES).toBe(DEFAULT_MAX_LINES);
	});

	it("defaults the outer max so pi's own output is never re-cut here", () => {
		// Always on, and still invisible until Headroom gets tight: the outer
		// max is pi's figure plus the slack pi's own notice adds past it.
		expect(bytesFromTokens(DEFAULT_MAX_OUTPUT_TOKENS, MATH)).toBeGreaterThanOrEqual(DEFAULT_MAX_BYTES);
		expect(tokensFromBytes(DEFAULT_MAX_BYTES, MATH)).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_TOKENS);
	});
});

// ---------------------------------------------------------------------------
// Token math
// ---------------------------------------------------------------------------

describe("token math", () => {
	it("is pi's chars/4 estimate times the Inflation factor", () => {
		expect(tokensFromBytes(4, { bytesPerChar: 4, inflation: 1.0 })).toBe(1);
		expect(tokensFromBytes(4, MATH)).toBe(2);
		expect(tokensFromBytes(0, MATH)).toBe(0);
		expect(tokensFromBytes(-10, MATH)).toBe(0);
	});

	it("rounds the byte budget down, so a plan never believes a cut fits", () => {
		expect(bytesFromTokens(3, MATH)).toBe(6);
		expect(bytesFromTokens(0, MATH)).toBe(0);
		const tokens = tokensFromBytes(5_001, MATH);
		expect(tokensFromBytes(bytesFromTokens(tokens, MATH), MATH)).toBeLessThanOrEqual(tokens);
	});

	it("catches multi-byte text, where pi's length-based estimate runs three to four times low", () => {
		const cjk = "中".repeat(1_000); // 3000 UTF-8 bytes, 1000 UTF-16 units
		expect(tokensFromBytes(Buffer.byteLength(cjk, "utf8"), MATH)).toBe(1_500);
		expect(Math.ceil(cjk.length / 4)).toBe(250);
	});
});

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

describe("computeHeadroom", () => {
	it("is the Effective window minus pi's reserve minus the usage pi reports", () => {
		expect(computeHeadroom({ effectiveWindow: 150_000, reserveTokens: 16_384, usedTokens: 110_000 })).toEqual({
			known: true,
			tokens: 23_616,
			effectiveWindow: 150_000,
			reserveTokens: 16_384,
			usedTokens: 110_000,
		});
	});

	it("never goes negative once the session is past the threshold", () => {
		expect(computeHeadroom({ effectiveWindow: 150_000, reserveTokens: 16_384, usedTokens: 200_000 })).toMatchObject({ known: true, tokens: 0 });
	});

	it("is blind with no resolved window", () => {
		expect(computeHeadroom({ effectiveWindow: undefined, reserveTokens: 16_384, usedTokens: 1000 })).toEqual({ known: false });
		expect(computeHeadroom({ effectiveWindow: 0, reserveTokens: 16_384, usedTokens: 1000 })).toEqual({ known: false });
	});

	it("is blind right after a compaction, when pi reports no usage yet", () => {
		expect(computeHeadroom({ effectiveWindow: 150_000, reserveTokens: 16_384, usedTokens: null })).toEqual({ known: false });
		expect(computeHeadroom({ effectiveWindow: 150_000, reserveTokens: 16_384, usedTokens: undefined })).toEqual({ known: false });
	});
});

// ---------------------------------------------------------------------------
// Bound
// ---------------------------------------------------------------------------

describe("computeBound", () => {
	it("is the share of the Headroom for a single call", () => {
		const bound = computeBound({ headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 16_000, remainingCalls: 1 });
		expect(bound.tokens).toBe(16_000);
		expect(bound.allowanceTokens).toBe(16_000);
		expect(bound.bytes).toBe(bytesFromTokens(16_000, MATH));
	});

	it("divides the allowance across the calls one assistant message asked for", () => {
		expect(computeBound({ headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 16_000, remainingCalls: 4 }).tokens).toBe(4_000);
	});

	it("rolls forward what the finished siblings left unused", () => {
		// Three calls against a 12k allowance, the first two spent only 1k, so
		// the last call reaches the 11k that is left.
		expect(computeBound({ headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 11_000, remainingCalls: 1 }).tokens).toBe(11_000);
	});

	it("never raises above pi's own figure, however much Headroom is left", () => {
		// The one-directional invariant: the hook runs after pi's cut, so a
		// raise is neither available nor wanted.
		const bound = computeBound({ headroom: known(1_000_000), settings: settings(), remainingAllowanceTokens: 1_000_000, remainingCalls: 1 });
		expect(bound.tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(bound.blind).toBe(false);
	});

	it("never drops below the floor, however tight the Headroom", () => {
		const bound = computeBound({ headroom: known(100), settings: settings(), remainingAllowanceTokens: 1, remainingCalls: 8 });
		expect(bound.tokens).toBe(bound.floorTokens);
		expect(bound.bytes).toBeGreaterThanOrEqual(4096);
	});

	it("is blind to pi's own figure and enforces no byte budget at all", () => {
		const bound = computeBound({ headroom: { known: false }, settings: settings(), remainingAllowanceTokens: 0, remainingCalls: 3 });
		expect(bound.blind).toBe(true);
		expect(bound.tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(bound.bytes).toBe(Number.POSITIVE_INFINITY);
	});

	it("lets the floor win over a contradictory outer max", () => {
		const tight = settings({ maxOutputTokens: 2_000, minOutputBytes: 8_192 });
		const bound = computeBound({ headroom: known(64_000), settings: tight, remainingAllowanceTokens: 16_000, remainingCalls: 1 });
		// A floor the clamp could undercut would starve a call outright, and
		// the floor is what keeps an error result diagnosable.
		expect(bound.floorTokens).toBe(floorTokensOf(tight));
		expect(bound.tokens).toBe(bound.floorTokens);
	});
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

describe("measurement", () => {
	it("counts UTF-8 bytes, not UTF-16 units", () => {
		expect(measureBlocks([text("中中")])).toBe(6);
		expect(measureBlocks([text("ab")])).toBe(2);
	});

	it("charges an image at pi's fixed figure instead of its base64 length", () => {
		expect(measureBlocks([{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" }])).toBe(IMAGE_CHARGE_BYTES);
	});

	it("counts a trailing newline as a terminator, not an empty line", () => {
		expect(countLines("a\nb\n")).toBe(2);
		expect(countLines("a\nb")).toBe(2);
		expect(countLines("")).toBe(0);
		expect(countResultLines([text("a\n"), image(), text("b\nc")])).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

describe("cutBlocks", () => {
	it("leaves a result that fits alone, with nothing appended", () => {
		const result = plan([text("one\ntwo\nthree")], { budgetBytes: 1_000 });
		expect(result.fits).toBe(true);
		expect(result.blocks).toEqual([{ kind: "keep", text: "one\ntwo\nthree" }]);
		expect(result.droppedBytes).toBe(0);
	});

	it("asks the pass-through question without the notice, so a fitting result stays pi's own", () => {
		expect(fitsWithinBudget([text("1234567890")], 10, 2_000)).toBe(true);
		expect(fitsWithinBudget([text("1234567890")], 9, 2_000)).toBe(false);
		expect(fitsWithinBudget([text("a\nb\nc")], 1_000, 2)).toBe(false);
	});

	it("keeps the head for a head-direction tool", () => {
		const result = plan([text("aaa\nbbb\nccc")], { budgetBytes: 8 });
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "aaa\nbbb" });
	});

	it("keeps the tail for bash", () => {
		const result = plan([text("aaa\nbbb\nccc")], { budgetBytes: 8, direction: "tail" });
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "bbb\nccc" });
	});

	it("keeps the crossing block and turns every later text block into a pointer", () => {
		const result = plan([text("111\n222"), text("333\n444"), text("555")], { budgetBytes: 12 });
		expect(result.blocks.map((block) => block.kind)).toEqual(["cut", "pointer", "pointer"]);
		expect(result.droppedBytes).toBeGreaterThan(0);
		expect(result.droppedLines).toBeGreaterThan(0);
	});

	it("reserves the notice and the pointers, so the Admitted text lands inside the Bound", () => {
		const pointer = "[p]";
		const notice = "[output-limits: capped to 13B (7 tokens) of the 1k token headroom]";
		const noticeBytes = Buffer.byteLength(notice, "utf8");
		const budget = 100;
		const result = plan([text("a".repeat(70)), text("b".repeat(70))], { budgetBytes: budget, pointer, notice });
		// The crossing block is cut, the later block becomes a pointer, and the
		// wiring appends "\n\n" plus the notice to the crossing block. Every
		// one of those bytes is charged to the Bound, because "Admitted text"
		// means what the model receives, notices included.
		const published = result.keptBytes + Buffer.byteLength(pointer, "utf8") + 2 + noticeBytes;
		expect(result.blocks.map((block) => block.kind)).toEqual(["cut", "pointer"]);
		expect(published).toBeLessThanOrEqual(budget);
	});

	it("never collapses a result into a single block", () => {
		const result = plan([text("aaa"), image(), text("bbb"), text("ccc")], { budgetBytes: 8 });
		expect(result.blocks).toHaveLength(4);
		expect(result.blocks[1]).toMatchObject({ kind: "image" });
	});

	it("charges an image against the budget and never cuts it", () => {
		// The image costs IMAGE_CHARGE_BYTES, so the text is what pays.
		const result = plan([image(), text("x".repeat(9_000))], { budgetBytes: IMAGE_CHARGE_BYTES + 100 });
		expect(result.blocks[0]).toMatchObject({ kind: "image" });
		expect(result.blocks[1]!.kind).toBe("cut");
		expect(Buffer.byteLength((result.blocks[1] as { text: string }).text, "utf8")).toBeLessThanOrEqual(100);
	});

	it("applies the line budget as well as the byte budget", () => {
		const result = plan([text("a\nb\nc\nd\ne")], { budgetBytes: 10_000, maxLines: 2 });
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "a\nb" });
	});

	it("keeps pi's own tail notice inside a cut bash result, because it stays true", () => {
		const body = `${"out\n".repeat(40)}[Showing lines 31-70 of 70. Full output: /tmp/pi-bash-1f2e.log]`;
		const result = plan([text(body)], { budgetBytes: 120, direction: "tail" });
		expect(result.blocks[0]!.kind).toBe("cut");
		expect((result.blocks[0] as { text: string }).text).toContain("Full output: /tmp/pi-bash-1f2e.log]");
	});

	it("cuts on a UTF-8 boundary, never mid-character", () => {
		const result = plan([text("中中中\n中中中\n中中中")], { budgetBytes: 11 });
		const kept = (result.blocks[0] as { text: string }).text;
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(11);
		expect(kept).toBe("中中中");
	});

	it("reports the numbers a patched truncation record needs", () => {
		const result = plan([text("aaa\nbbb\nccc\nddd")], { budgetBytes: 8 });
		expect(result.cut).not.toBeNull();
		expect(result.cut!.outputLines).toBe(2);
		expect(result.cut!.outputBytes).toBe(7);
		expect(result.keptLines).toBe(2);
		expect(result.keptBytes).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// read's continuation notice
// ---------------------------------------------------------------------------

describe("splitReadNotice", () => {
	it("takes pi's continuation off the end and reports the first line shown", () => {
		expect(splitReadNotice("body\n\n[Showing lines 41-411 of 9000. Use offset=412 to continue.]")).toEqual({
			body: "body",
			startLine: 41,
			removed: true,
		});
	});

	it("handles the byte-limit variant", () => {
		expect(splitReadNotice("body\n\n[Showing lines 1-2000 of 9000 (50.0KB limit). Use offset=2001 to continue.]")).toMatchObject({ startLine: 1, removed: true });
	});

	it("handles the user-limit variant, which names no start line", () => {
		expect(splitReadNotice("body\n\n[312 more lines in file. Use offset=412 to continue.]")).toMatchObject({ removed: true, startLine: undefined });
	});

	it("leaves a notice with no continuation alone, because no offset is knowable", () => {
		const block = "body\n\n[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' f | head -c 51200]";
		expect(splitReadNotice(block)).toEqual({ body: block, startLine: undefined, removed: false });
	});

	it("rewrites read's continuation to the smaller cut", () => {
		// pi showed lines 1-40; the Bound keeps 2, so the continuation must
		// say offset 3 or the model re-reads lines it already has.
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = plan([text(`${lines}\n\n[Showing lines 1-40 of 400. Use offset=41 to continue.]`)], {
			budgetBytes: 13,
			rewriteReadNotice: true,
		});
		expect(result.readStartLine).toBe(1);
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "line 1\nline 2" });
		expect(result.droppedBytes).toBeGreaterThan(0);
	});

	it("publishes pi's notice alone when stripping it already closes the gap", () => {
		const body = "a\nb\n\n[Showing lines 1-2 of 400. Use offset=3 to continue.]";
		const result = plan([text(body)], { budgetBytes: 20, rewriteReadNotice: true });
		expect(result.blocks[0]).toMatchObject({ kind: "keep", text: "a\nb" });
	});
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe("buildNotice", () => {
	it("names the real Bound, the Headroom it came from, and the Spill", () => {
		expect(
			buildNotice({
				boundBytes: 8_192,
				boundTokens: 4_100,
				headroomTokens: 16_000,
				calls: 3,
				continueOffset: undefined,
				displayPath: "~/.pi/agent/output-limits/sess/4-bash-c1d2e3f4.log",
			}),
		).toBe(
			"[output-limits: capped to 8KB (4.1k tokens) of the 16k token headroom left for this message (3 calls); full output: ~/.pi/agent/output-limits/sess/4-bash-c1d2e3f4.log]",
		);
	});

	it("says nothing about the batch for a single call", () => {
		expect(buildNotice({ boundBytes: 8_192, boundTokens: 4_100, headroomTokens: 16_000, calls: 1, continueOffset: undefined, displayPath: "/p" })).not.toContain("left for this message");
	});

	it("ends with read's rewritten continuation instead of a Spill", () => {
		expect(buildNotice({ boundBytes: 8_192, boundTokens: 4_100, headroomTokens: 16_000, calls: 1, continueOffset: 412, displayPath: undefined })).toBe(
			"[output-limits: capped to 8KB (4.1k tokens) of the 16k token headroom; use offset=412 to continue]",
		);
	});

	it("is one line", () => {
		expect(buildNotice({ boundBytes: 100, boundTokens: 50, headroomTokens: 200, calls: 2, continueOffset: undefined, displayPath: "/p" })).not.toContain("\n");
	});

	it("names no path when there is neither a Spill nor an offset", () => {
		expect(buildNotice({ boundBytes: 100, boundTokens: 50, headroomTokens: 200, calls: 1, continueOffset: undefined, displayPath: undefined })).toBe(
			"[output-limits: capped to 100B (50 tokens) of the 200 token headroom]",
		);
	});
});

describe("buildPointer", () => {
	it("names the Spill the dropped text lives in", () => {
		expect(buildPointer("~/a/1-grep-abcd.log")).toBe("[output-limits: text dropped, full output: ~/a/1-grep-abcd.log]");
	});

	it("says only that text was dropped when there is no Spill", () => {
		expect(buildPointer(undefined)).toBe("[output-limits: text dropped]");
	});
});

describe("formatBytes and formatTokens", () => {
	it("drops the needless .0 and keeps pi's units", () => {
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(8_192)).toBe("8KB");
		expect(formatBytes(8_397)).toBe("8.2KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2MB");
		expect(formatTokens(800)).toBe("800");
		expect(formatTokens(4_100)).toBe("4.1k");
		expect(formatTokens(16_000)).toBe("16k");
	});

	it("says unbounded rather than printing Infinity", () => {
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unbounded");
		expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("unbounded");
	});
});
