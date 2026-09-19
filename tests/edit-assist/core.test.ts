import { describe, expect, it } from "vitest";
import {
	LIMITS,
	MAX_FILE_BYTES,
	MAX_FILE_LINES,
	diagnoseNoMatch,
	isOversized,
	isWhitespaceOnlyDiff,
	lineCount,
	matchKind,
	nearestRegion,
	normalizeToLF,
	splitBom,
	unifiedDiff,
} from "../../extensions/edit-assist/core";
import { NO_MATCH_FIXTURES } from "./fixtures";

// ---------------------------------------------------------------------------
// Real no-match fixtures, extracted from pi session data
// ---------------------------------------------------------------------------

describe("real no-match fixtures", () => {
	for (const fixture of NO_MATCH_FIXTURES) {
		it(`finds the unique Nearest region for ${fixture.name}`, () => {
			const region = nearestRegion(fixture.file, fixture.oldText);
			expect(region).not.toBeNull();
			expect(region?.startLine).toBe(fixture.regionStart);
			expect(region?.endLine).toBe(fixture.regionEnd);
		});

		it(`classifies ${fixture.name} oldText as unmatched by the built-in`, () => {
			// A leading-whitespace drift reaches the Extended match; the built-in
			// still fails it, and the Diagnosis carries the whitespace-only note.
			const expected = fixture.name === "leading-whitespace-drift" ? "extended" : "none";
			expect(matchKind(fixture.file, fixture.oldText)).toBe(expected);
		});

		it(`diagnoses ${fixture.name} with the region range and a unified diff`, () => {
			const diagnosis = diagnoseNoMatch({
				path: "src/example.ts",
				fileText: fixture.file,
				edits: [{ oldText: fixture.oldText, newText: fixture.newText }],
			});
			expect(diagnosis).not.toBeNull();
			const lines = (diagnosis as string).split("\n");
			expect(lines[0]).toBe("Diagnosis for edits[0] in src/example.ts:");
			expect(lines).toContain(`Nearest region: lines ${fixture.regionStart}-${fixture.regionEnd}`);
			// The unified diff shows the model's oldText and the file's real text.
			expect(diagnosis).toContain(`--- edits[0].oldText`);
			expect(diagnosis).toContain(`+++ file (lines ${fixture.regionStart}-${fixture.regionEnd})`);
			expect(diagnosis).toMatch(/\n-/m);
			expect(diagnosis).toMatch(/\n\+/m);
		});
	}
});

it("states a whitespace-only difference explicitly (real leading-whitespace case)", () => {
	const fixture = NO_MATCH_FIXTURES.find((f) => f.name === "leading-whitespace-drift");
	expect(fixture).toBeDefined();
	const diagnosis = diagnoseNoMatch({
		path: "test/app.test.ts",
		fileText: fixture!.file,
		edits: [{ oldText: fixture!.oldText, newText: fixture!.newText }],
	});
	expect(diagnosis).toContain(
		"The difference is a whitespace-only difference: same line count, leading whitespace only.",
	);
});

it("does not state the whitespace-only note for a character drift (real brace case)", () => {
	const fixture = NO_MATCH_FIXTURES.find((f) => f.name === "brace-drift");
	expect(fixture).toBeDefined();
	const diagnosis = diagnoseNoMatch({
		path: "src/config.ts",
		fileText: fixture!.file,
		edits: [{ oldText: fixture!.oldText, newText: fixture!.newText }],
	});
	expect(diagnosis).not.toContain("whitespace-only");
	// The single-character drift is visible in the diff: the model's brace and
	// the file's real line.
	expect(diagnosis).toContain("-\t\t}),");
	expect(diagnosis).toContain("+\t\t),");
});

// ---------------------------------------------------------------------------
// Nearest region
// ---------------------------------------------------------------------------

describe("nearestRegion", () => {
	const FILE = [
		"function alpha(): void {",
		"\t// setup",
		"\trunAlpha();",
		"}",
		"",
		"function beta(): void {",
		"\t// setup",
		"\trunBeta();",
		"}",
	].join("\n");

	it("picks the more similar region when two candidates compete", () => {
		const oldText = "function beta(): void {\n\t// setup\n\trunBeta();\n}";
		const region = nearestRegion(FILE, oldText);
		expect(region).toEqual({ startLine: 6, endLine: 9, score: 1 });
	});

	it("returns the earliest window on a score tie", () => {
		const tied = "one\ntwo\none\ntwo\n";
		const region = nearestRegion(tied, "one\ntwo");
		expect(region).toEqual({ startLine: 1, endLine: 2, score: 1 });
	});

	it("returns null when no region reaches the similarity floor", () => {
		const region = nearestRegion(FILE, "const zebra = 42;");
		expect(region).toBeNull();
	});

	it("returns null when the oldText is taller than the file", () => {
		const region = nearestRegion("a\nb", "a\nb\nc\nd");
		expect(region).toBeNull();
	});

	it("returns null for an empty oldText", () => {
		expect(nearestRegion(FILE, "")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// matchKind
// ---------------------------------------------------------------------------

describe("matchKind", () => {
	const FILE = "\tconst answer = 42;\n";

	it("reports an exact match", () => {
		expect(matchKind(FILE, "const answer = 42;")).toBe("exact");
	});

	it("reports a built-in fuzzy match for smart quotes", () => {
		expect(matchKind("let a = \u201chello\u201d;\n", 'let a = "hello";')).toBe("fuzzy");
	});

	it("reports an extended match when only leading whitespace differs", () => {
		expect(matchKind(FILE, "  const answer = 42;")).toBe("extended");
	});

	it("reports none when the text is absent", () => {
		expect(matchKind(FILE, "const answer = 43;")).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// whitespace-only classification
// ---------------------------------------------------------------------------

describe("isWhitespaceOnlyDiff", () => {
	it("is true for the same lines with different leading whitespace", () => {
		expect(isWhitespaceOnlyDiff("\ta\n  b", "\t\ta\nb")).toBe(true);
	});

	it("is false when a character differs", () => {
		expect(isWhitespaceOnlyDiff("\ta\nb", "\ta\nc")).toBe(false);
	});

	it("is false when the line counts differ", () => {
		expect(isWhitespaceOnlyDiff("\ta\nb", "\ta\nb\nc")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// size bounds
// ---------------------------------------------------------------------------

describe("size bounds", () => {
	it("caps the diff line count and marks the truncation", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} with some content`);
		const oldText = lines.map((line) => line.replace("line", "old")).join("\n");
		const diff = unifiedDiff(oldText, lines.join("\n"), "a", "b", LIMITS);
		const diffLines = diff.split("\n");
		expect(diffLines.length).toBeLessThanOrEqual(LIMITS.maxDiffLines);
		expect(diff).toContain("diff truncated");
	});

	it("caps the diff character count and marks the truncation", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1} ${"x".repeat(120)}`);
		const oldText = lines.map((line) => line.replace("line", "old")).join("\n");
		const diff = unifiedDiff(oldText, lines.join("\n"), "a", "b", { ...LIMITS, maxDiffLines: 1000, maxDiffChars: 400 });
		expect(diff.length).toBeLessThanOrEqual(400);
		expect(diff).toContain("diff truncated");
	});

	it("keeps a small diff intact, with no truncation marker", () => {
		const diff = unifiedDiff("a\nb\nc", "a\nB\nc", "a", "b", LIMITS);
		expect(diff).toBe("--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
	});
});

// ---------------------------------------------------------------------------
// the large-file guard
// ---------------------------------------------------------------------------

describe("isOversized", () => {
	it("lets a file exactly at the limits through", () => {
		expect(isOversized(MAX_FILE_BYTES, MAX_FILE_LINES)).toBe(false);
	});

	it("stops a file over the byte limit", () => {
		expect(isOversized(MAX_FILE_BYTES + 1, 10)).toBe(true);
	});

	it("stops a file over the line limit", () => {
		expect(isOversized(100, MAX_FILE_LINES + 1)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// lineCount: the large-file guard's line side, on the real counting path
// ---------------------------------------------------------------------------

describe("lineCount", () => {
	it("counts 0 for empty text", () => {
		expect(lineCount("")).toBe(0);
	});

	it("does not count the empty tail of a trailing newline", () => {
		expect(lineCount("a\nb\n")).toBe(2);
	});

	it("counts a final line without a trailing newline", () => {
		expect(lineCount("a\nb")).toBe(2);
	});

	it("lets a file of exactly MAX_FILE_LINES with a trailing newline through the guard", () => {
		const file = Array.from({ length: MAX_FILE_LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		expect(isOversized(Buffer.byteLength(file), lineCount(file))).toBe(false);
	});

	it("stops a file of MAX_FILE_LINES + 1 with a trailing newline", () => {
		const file = Array.from({ length: MAX_FILE_LINES + 1 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		expect(isOversized(Buffer.byteLength(file), lineCount(file))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// diagnoseNoMatch
// ---------------------------------------------------------------------------

describe("diagnoseNoMatch", () => {
	it("diagnoses each unmatched edit of a multi-edit call", () => {
		const file = [
			"const one = 1;",
			"const two = 2;",
			"",
			"const three = 3;",
			"const four = 4;",
		].join("\n");
		const diagnosis = diagnoseNoMatch({
			path: "src/num.ts",
			fileText: file,
			edits: [
				{ oldText: "const two = 2;", newText: "x" }, // matches: no diagnosis
				{ oldText: "const three = 999;", newText: "x" },
				{ oldText: "const four = 4;", newText: "x" }, // matches: no diagnosis
				{ oldText: "zebra quantum flux;", newText: "x" },
			],
		});
		expect(diagnosis).toContain("Diagnosis for edits[1] in src/num.ts:");
		expect(diagnosis).toContain("Nearest region: lines 4-4");
		expect(diagnosis).toContain("Diagnosis for edits[3] in src/num.ts:");
		expect(diagnosis).toContain("No candidate region");
		expect(diagnosis).not.toContain("edits[0]");
		expect(diagnosis).not.toContain("edits[2]");
	});

	it("returns null when every edit still matches", () => {
		const file = "const two = 2;\n";
		const diagnosis = diagnoseNoMatch({
			path: "src/num.ts",
			fileText: file,
			edits: [{ oldText: "const two = 2;", newText: "x" }],
		});
		expect(diagnosis).toBeNull();
	});

	it("normalizes CRLF and strips a BOM before matching", () => {
		const fileText = normalizeToLF(splitBom("\ufeffconst a = 1;\r\nconst b = 2;\r\n").text);
		const diagnosis = diagnoseNoMatch({
			path: "src/win.ts",
			fileText,
			edits: [{ oldText: "const a = 1;\r\nconst b = 999;\r\n", newText: "x" }],
		});
		expect(diagnosis).toContain("Nearest region: lines 1-3");
	});
});

describe("unifiedDiff", () => {
	it("keeps full context for a change in a small file", () => {
		const a = "a1\na2\nb\na4\na5".split("\n");
		const b = "a1\na2\nB\na4\na5".split("\n");
		const diff = unifiedDiff(a.join("\n"), b.join("\n"), "old", "new", LIMITS);
		expect(diff).toBe("--- old\n+++ new\n@@ -1,5 +1,5 @@\n a1\n a2\n-b\n+B\n a4\n a5");
	});

it("omits the count in a hunk header when a side touches exactly one line", () => {
	const diff = unifiedDiff("b", "B", "old", "new", LIMITS);
	expect(diff).toBe("--- old\n+++ new\n@@ -1 +1 @@\n-b\n+B");
	});
});
