import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildNotice,
	buildPointer,
	bytesFromTokens,
	countLines,
	countResultLines,
	computeBound,
	computeHeadroom,
	cutBlocks,
	cutToBudget,
	DEFAULT_MAX_OUTPUT_TOKENS,
	fitsWithinBudget,
	floorTokensOf,
	formatBytes,
	formatTokens,
	IMAGE_CHARGE_BYTES,
	lineCeilingOf,
	measureBlocks,
	measurePublished,
	messageAllowanceTokens,
	noLineCeiling,
	renderPlan,
	rewriteSpillPath,
	type ContentBlock,
	PI_MAX_OUTPUT_BYTES,
	PI_MAX_OUTPUT_LINES,
	PI_NO_LINE_LIMIT,
	PI_NOTICE_SLACK_BYTES,
	PI_NOTICE_SLACK_LINES,
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
		// A named figure here, not `null`: the per-tool default is what the
		// `lineCeilingOf` cases below test, and the cut cases want a fixed
		// ceiling that does not depend on which tool is named.
		maxLines: PI_MAX_OUTPUT_LINES + PI_NOTICE_SLACK_LINES,
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

/** The same, with the budget verified against the published result. */
function budgetPlan(blocks: ContentBlock[], over: Partial<Parameters<typeof cutToBudget>[0]> = {}) {
	return cutToBudget({
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

	it("restates pi's own line figure per tool, from pi's shipped tool source", () => {
		// The line half of the one-directional rule depends on which tools hand
		// their cutter a line figure at all. pi does not export that table, so
		// the restatement is pinned against the source it comes from: a pi
		// change to who is line-cut fails here instead of making this extension
		// quietly stricter than pi on a search tool.
		// The package exports only its entry, so the tool modules are found by
		// walking back from what the resolver did return rather than by naming a
		// subpath it does not publish.
		const toolsDir = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core", "tools");
		const toolSource = (name: string) => readFileSync(join(toolsDir, `${name}.js`), "utf8");
		// bash cuts its accumulated output with pi's line default...
		expect(toolSource("output-accumulator")).toContain("options.maxBytes ?? DEFAULT_MAX_BYTES");
		expect(toolSource("output-accumulator")).toContain("options.maxLines ?? DEFAULT_MAX_LINES");
		// ...read applies truncateHead with its defaults, which are the same two
		// figures...
		expect(toolSource("read")).toMatch(/truncateHead\(selectedContent\)/);
		// ...and grep, find, and ls pass pi's own "no line limit" sentinel, so
		// only the byte figure binds them.
		for (const tool of ["grep", "find", "ls"]) {
			expect(toolSource(tool), tool).toContain(`maxLines: Number.MAX_SAFE_INTEGER`);
		}
		expect(PI_NO_LINE_LIMIT).toBe(Number.MAX_SAFE_INTEGER);
	});
});

// ---------------------------------------------------------------------------
// The line ceiling, per tool
// ---------------------------------------------------------------------------

describe("lineCeilingOf", () => {
	it("lifts pi's line figure by its own notice allowance, so a blessed result is admitted untouched", () => {
		// pi truncates content to 2000 lines and THEN appends `\n\n[notice]`, so
		// a result pi calls in bounds is 2002 lines. A ceiling of exactly 2000
		// re-cut it, which is the byte-axis bug on the other unit.
		expect(PI_NOTICE_SLACK_LINES).toBe(2);
		expect(lineCeilingOf("bash", null)).toBe(PI_MAX_OUTPUT_LINES + PI_NOTICE_SLACK_LINES);
		expect(lineCeilingOf("read", null)).toBe(PI_MAX_OUTPUT_LINES + PI_NOTICE_SLACK_LINES);
	});

	it("applies no line ceiling to the tools pi applies none to", () => {
		// grep, find, and ls cap their rows with their own match, result, and
		// entry limits and hand their cutter pi's no-line-limit sentinel, so a
		// 2000-line ceiling here was stricter than pi at ANY Headroom.
		for (const tool of ["grep", "find", "ls"]) {
			expect(lineCeilingOf(tool, null)).toBe(PI_NO_LINE_LIMIT);
			expect(noLineCeiling(lineCeilingOf(tool, null))).toBe(true);
		}
		expect(noLineCeiling(lineCeilingOf("bash", null))).toBe(false);
	});

	it("honours a line max the user names, for every bounded tool", () => {
		// A named figure is a choice rather than a mirror of pi, so it binds the
		// search tools too, and the default is the only thing that stays pi's.
		expect(lineCeilingOf("grep", 500)).toBe(500);
		expect(lineCeilingOf("bash", 500)).toBe(500);
		expect(lineCeilingOf("bash", Number.POSITIVE_INFINITY)).not.toBe(500);
	});

	it("is the figure the Bound carries, so the cut and the ceiling cannot disagree", () => {
		const bound = computeBound({ toolName: "grep", headroom: known(64_000), settings: settings({ maxLines: null }), remainingAllowanceTokens: 16_000, remainingCalls: 1 });
		expect(bound.maxLines).toBe(PI_NO_LINE_LIMIT);
		expect(computeBound({ toolName: "bash", headroom: known(64_000), settings: settings({ maxLines: null }), remainingAllowanceTokens: 16_000, remainingCalls: 1 }).maxLines).toBe(2002);
	});

	it("admits a result at pi's own line ceiling whole, however many lines it is", () => {
		// The ample-Headroom promise, on the line axis: 2000 content lines of
		// pi's own tail cut plus pi's notice is a result pi produced, so nothing
		// here may cut it or spill it.
		const bound = computeBound({ toolName: "bash", headroom: known(129_616), settings: settings({ maxLines: null }), remainingAllowanceTokens: 129_616, remainingCalls: 1 });
		const rows = Array.from({ length: 2000 }, (_, i) => `row ${3001 + i}`).join("\n");
		const blessed = `${rows}\n\n[Showing lines 3001-5000 of 5000. Full output: /tmp/pi-bash-1f2e.log]`;
		expect(countResultLines([text(blessed)])).toBe(2002);
		expect(fitsWithinBudget([text(blessed)], bound.bytes, bound.maxLines)).toBe(true);
		const result = cutToBudget({
			blocks: [text(blessed)],
			budgetBytes: bound.bytes,
			maxLines: bound.maxLines,
			direction: "tail",
			cutters: CUTTERS,
			pointer: "[p]",
			notice: "",
		});
		expect(result.fits).toBe(true);
		expect(result.droppedLines).toBe(0);
	});

	it("admits a many-line grep result whole, where pi applies no line ceiling at all", () => {
		// 2500 short rows is under pi's byte figure and over pi's line figure for
		// the tools that HAVE one. pi publishes it as it stands, so this
		// extension must too, at any Headroom the byte budget leaves alone.
		const rows = Array.from({ length: 2500 }, (_, i) => `f${i}.ts:${i + 1}: match`).join("\n");
		const bound = computeBound({ toolName: "grep", headroom: known(129_616), settings: settings({ maxLines: null }), remainingAllowanceTokens: 129_616, remainingCalls: 1 });
		expect(Buffer.byteLength(rows, "utf8")).toBeLessThan(bound.bytes);
		expect(fitsWithinBudget([text(rows)], bound.bytes, bound.maxLines)).toBe(true);
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
		const bound = computeBound({ toolName: "bash", headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 16_000, remainingCalls: 1 });
		expect(bound.tokens).toBe(16_000);
		expect(bound.bytes).toBe(bytesFromTokens(16_000, MATH));
	});

	it("states the message allowance once, for the wiring and the Bound alike", () => {
		// The figure the Ledger opens a batch on is the one `computeBound`
		// divides, so neither side can restate it and drift.
		expect(messageAllowanceTokens(known(64_000), settings())).toBe(16_000);
		expect(messageAllowanceTokens(known(100), settings())).toBe(floorTokensOf(settings()));
		// A blind Headroom has no allowance: the batch stays unbaselined rather
		// than freezing at the outer max.
		expect(messageAllowanceTokens({ known: false }, settings())).toBe(0);
	});

	it("divides the allowance across the calls one assistant message asked for", () => {
		expect(computeBound({ toolName: "bash", headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 16_000, remainingCalls: 4 }).tokens).toBe(4_000);
	});

	it("rolls forward what the finished siblings left unused", () => {
		// Three calls against a 12k allowance, the first two spent only 1k, so
		// the last call reaches the 11k that is left.
		expect(computeBound({ toolName: "bash", headroom: known(64_000), settings: settings(), remainingAllowanceTokens: 11_000, remainingCalls: 1 }).tokens).toBe(11_000);
	});

	it("never raises above pi's own figure, however much Headroom is left", () => {
		// The one-directional invariant: the hook runs after pi's cut, so a
		// raise is neither available nor wanted.
		const bound = computeBound({ toolName: "bash", headroom: known(1_000_000), settings: settings(), remainingAllowanceTokens: 1_000_000, remainingCalls: 1 });
		expect(bound.tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(bound.blind).toBe(false);
	});

	it("never drops below the floor, however tight the Headroom", () => {
		const bound = computeBound({ toolName: "bash", headroom: known(100), settings: settings(), remainingAllowanceTokens: 1, remainingCalls: 8 });
		expect(bound.tokens).toBe(bound.floorTokens);
		expect(bound.bytes).toBeGreaterThanOrEqual(4096);
	});

	it("is blind to pi's own figure and enforces no byte budget at all", () => {
		const bound = computeBound({ toolName: "bash", headroom: { known: false }, settings: settings(), remainingAllowanceTokens: 0, remainingCalls: 3 });
		expect(bound.blind).toBe(true);
		expect(bound.tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(bound.bytes).toBe(Number.POSITIVE_INFINITY);
	});

	it("lets the floor win over a contradictory outer max", () => {
		const tight = settings({ maxOutputTokens: 2_000, minOutputBytes: 8_192 });
		const bound = computeBound({ toolName: "bash", headroom: known(64_000), settings: tight, remainingAllowanceTokens: 16_000, remainingCalls: 1 });
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
		expect(Buffer.byteLength((result.blocks[1] as Textish).text, "utf8")).toBeLessThanOrEqual(100);
	});

	it("applies the line budget as well as the byte budget", () => {
		const result = plan([text("a\nb\nc\nd\ne")], { budgetBytes: 10_000, maxLines: 2 });
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "a\nb" });
	});

	it("keeps pi's own tail notice inside a cut bash result, because it stays true", () => {
		const body = `${"out\n".repeat(40)}[Showing lines 31-70 of 70. Full output: /tmp/pi-bash-1f2e.log]`;
		const result = plan([text(body)], { budgetBytes: 120, direction: "tail" });
		expect(result.blocks[0]!.kind).toBe("cut");
		expect((result.blocks[0] as Textish).text).toContain("Full output: /tmp/pi-bash-1f2e.log]");
	});

	it("cuts on a UTF-8 boundary, never mid-character", () => {
		const result = plan([text("中中中\n中中中\n中中中")], { budgetBytes: 11 });
		const kept = (result.blocks[0] as Textish).text;
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
// The budget, verified: cutToBudget
// ---------------------------------------------------------------------------

describe("cutToBudget", () => {
	const notice = "[output-limits: capped to 8KB (4.1k tokens) of the 16.4k token headroom; full output: ~/s/1-bash-c1.log]";
	const shortNotice = "[output-limits: capped to 200B (100 tokens) of the 1k token headroom]";

	it("publishes inside the byte Bound with its own notice counted", () => {
		const body = `${"out\n".repeat(2_000)}tail`;
		const budgetBytes = 4_000;
		const result = budgetPlan([text(body)], { budgetBytes, notice });
		const published = measurePublished(result, "[p]", notice);
		expect(published.bytes).toBeLessThanOrEqual(budgetBytes);
		expect(result.fits).toBe(false);
	});

	it("publishes inside the line Bound too, which the reservation alone misses", () => {
		// The notice and the blank line before it are two more lines on top of
		// what the cutter kept, so a plan that only respected the line budget
		// while cutting would publish over it. This is the case where the byte
		// budget is never crossed at all.
		const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const maxLines = 8;
		const result = budgetPlan([text(body)], { budgetBytes: 100_000, maxLines, notice });
		const published = measurePublished(result, "[p]", notice);
		expect(published.lines).toBeLessThanOrEqual(maxLines);
		expect(countResultLines(renderPlan(result, "[p]", notice))).toBeLessThanOrEqual(maxLines);
		expect(result.keptLines).toBeLessThan(maxLines);
	});

	it("counts every pointer line as well", () => {
		// Three blocks against a budget that holds one notice and two pointers:
		// the reservation charges the worst case, which is every block but the
		// crossing one dropped, so the published result still fits.
		const rows = (n: number) => Array.from({ length: 20 }, (_, i) => `row ${n}${i}`).join("\n");
		const blocks = [text(rows(1)), text(rows(2)), text(rows(3))];
		const pointer = "[pointer to the spill file]";
		const budgetBytes = 200;
		const result = budgetPlan(blocks, { budgetBytes, pointer, notice: shortNotice });
		const published = measurePublished(result, pointer, shortNotice);
		expect(published.bytes).toBeLessThanOrEqual(budgetBytes);
		expect(result.blocks.filter((block) => block.kind === "pointer")).toHaveLength(2);
	});

	it("renders what it measures, so the promise is about the published text", () => {
		const result = budgetPlan([text("a".repeat(500))], { budgetBytes: 120, notice });
		const rendered = renderPlan(result, "[p]", notice);
		expect(measureBlocks(rendered)).toBe(measurePublished(result, "[p]", notice).bytes);
		expect(rendered[rendered.length - 1]!.type).toBe("text");
		expect((rendered[rendered.length - 1] as Textish).text).toContain("[output-limits: capped to");
	});

	it("leaves a result that fits alone, and does not announce a notice for it", () => {
		const result = budgetPlan([text("one\ntwo")], { budgetBytes: 100, notice });
		expect(result.fits).toBe(true);
		expect(result.blocks).toEqual([{ kind: "keep", text: "one\ntwo" }]);
	});
});

// ---------------------------------------------------------------------------
// One live path: pi's own notice repointed at the Spill
// ---------------------------------------------------------------------------

describe("rewriteSpillPath", () => {
	it("repoints the path pi named at the Spill that now holds the bytes", () => {
		const body = "out\n\n[Showing lines 31-70 of 70 (50.0KB limit). Full output: /tmp/pi-bash-1f2e.log]";
		const rewritten = rewriteSpillPath([text(body)], "/tmp/pi-bash-1f2e.log", "~/.pi/agent/output-limits/s/1-bash-c1.log");
		expect(rewritten.changed).toBe(true);
		expect((rewritten.blocks[0] as Textish).text).toBe(
			"out\n\n[Showing lines 31-70 of 70 (50.0KB limit). Full output: ~/.pi/agent/output-limits/s/1-bash-c1.log]",
		);
		// The moved file's name is gone from the text, so the model cannot
		// follow it into a "No such file".
		expect((rewritten.blocks[0] as Textish).text).not.toContain("/tmp/");
	});

	it("repoints every occurrence across every text block, and touches no image", () => {
		const picture: ContentBlock = { type: "image", data: "/tmp/pi-bash-1f2e.log", mimeType: "image/png" };
		const rewritten = rewriteSpillPath([text("a /tmp/pi-bash-1f2e.log b /tmp/pi-bash-1f2e.log"), picture], "/tmp/pi-bash-1f2e.log", "/s/1.log");
		expect((rewritten.blocks[0] as Textish).text).toBe("a /s/1.log b /s/1.log");
		expect(rewritten.blocks[1]).toBe(picture);
		expect(rewritten.changed).toBe(true);
	});

	it("says nothing changed when the path appears nowhere", () => {
		const rewritten = rewriteSpillPath([text("plain output")], "/tmp/pi-bash-1f2e.log", "/s/1.log");
		expect(rewritten.changed).toBe(false);
		expect(rewritten.blocks).toEqual([text("plain output")]);
	});

	it("is a no-op when the path did not move", () => {
		const same = rewriteSpillPath([text("/s/1.log")], "/s/1.log", "/s/1.log");
		expect(same.changed).toBe(false);
		const empty = rewriteSpillPath([text("x")], "", "/s/1.log");
		expect(empty.changed).toBe(false);
	});
});

/** The text of one block, for the casts these cases need. */
type Textish = { text: string };

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

	it("keeps pi's continuation when stripping it is all the budget needed", () => {
		// The unsafe shape this pins: a read body that fits and pi's notice line
		// that does not. Stripping the line closes the gap in bytes but takes
		// away the only recovery read has, because read keeps no Spill. So the
		// plan publishes pi's text as it arrived, stale line unstripped and all:
		// no content was cut, so the offset pi named is still exactly right.
		const body = "a\nb\n\n[Showing lines 1-2 of 400. Use offset=3 to continue.]";
		const result = plan([text(body)], { budgetBytes: 20, rewriteReadNotice: true });
		expect(result.fits).toBe(true);
		expect(result.blocks).toEqual([{ kind: "keep", text: body }]);
		expect(result.droppedBytes).toBe(0);
		// And the first line pi showed is still reported, so a caller that does
		// need a continuation can build one.
		expect(result.readStartLine).toBe(1);
	});

	it("cuts and rewrites when the body itself is what crosses", () => {
		// The other shape: the body does not fit either, so a real cut runs and
		// pi's stale offset is replaced by the extension's own line, computed
		// from what the cut kept.
		const rows = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");
		const body = `${rows}\n\n[Showing lines 1-6 of 400. Use offset=7 to continue.]`;
		const result = plan([text(body)], { budgetBytes: 14, rewriteReadNotice: true });
		expect(result.fits).toBe(false);
		expect(result.blocks[0]).toMatchObject({ kind: "cut", text: "line 1\nline 2" });
		expect(result.readStartLine).toBe(1);
		expect(result.keptLines).toBe(2);
	});

	it("never publishes a read plan whose body survived without a pointer", () => {
		// The invariant, stated as a check over both shapes: for every plan that
		// keeps read's text, either pi's own continuation is still in it, or a
		// cut ran and the caller has the numbers to write one.
		const rows = Array.from({ length: 4 }, (_, i) => `l${i}`).join("\n");
		const body = `${rows}\n\n[Showing lines 1-4 of 9. Use offset=5 to continue.]`;
		for (const budgetBytes of [Buffer.byteLength(body, "utf8"), Buffer.byteLength(rows, "utf8"), 12, 1]) {
			const result = plan([text(body)], { budgetBytes, rewriteReadNotice: true });
			if (result.fits) {
				// Nothing was cut, so pi's line is untouched and still true.
				expect(result.blocks.map((block) => (block.kind === "keep" ? block.text : "")).join("|")).toContain("Use offset=5 to continue");
			} else {
				// A cut ran, so the caller owns the continuation and has the two
				// numbers it needs to state one: where the text started, and how
				// many lines survived.
				expect(result.readStartLine).toBeDefined();
				expect(result.keptLines).toBeGreaterThanOrEqual(0);
			}
		}
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
