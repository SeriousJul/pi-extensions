/**
 * Unit tests for the edit assist core (tickets #81 and #84). Fixtures are
 * seeded from real failing edit calls extracted from pi session data: the
 * stock error texts and call arguments are the recorded ones; the file
 * contents are reconstructed so the recorded oldTexts occur the recorded
 * number of times (the original worktrees no longer exist).
 */

import { describe, expect, it } from "vitest";

import {
	LIMITS,
	MAX_FILE_BYTES,
	MAX_FILE_LINES,
	ambiguousDiagnosis,
	appendDiagnosis,
	diagnoseNoMatch,
	isAmbiguousEditError,
	isEditValidationError,
	isOversized,
	isWhitespaceOnlyDiff,
	lineCount,
	malformedEditHint,
	matchKind,
	nearestRegion,
	normalizeToLF,
	occurrenceLineNumbers,
	stripBom,
	unifiedDiff,
} from "../../extensions/edit-assist/core";
import { NO_MATCH_FIXTURES, realValidationError } from "./fixtures";


// --- Real session seed: multi-edit call, edits[2] matched twice -----------
// Recorded 2026-09-01 in my-little-software-factory
// (factory-13-add-interactive-consultations-to-the-control-plane).
const handoffError =
	"Found 2 occurrences of edits[2] in src/handoff.ts. Each oldText must be unique. Please provide more context to make it unique.";
const handoffInput = {
	path: "src/handoff.ts",
	edits: [
		{
			oldText: "\tconst id = jsonResultField(created, \"workspace\", \"workspace_id\");\n\tif (id === null) {\n",
			newText:
				"\tconst id = jsonResultField(created, \"workspace\", \"workspace_id\");\n\tif (id !== null) ctx.onResource?.(\"workspace\", id, true, \"live workspace\");\n\tif (id === null) {\n",
		},
		{
			oldText:
				"\tif (paneId === null || tabId === null) {\n\t\treturn failed(\"herdr tab create returned no pane id\", ctx);\n\t}\n",
			newText:
				"\tif (tabId !== null) ctx.onResource?.(\"tab\", tabId, true, \"Consultation tab\");\n\tif (paneId === null || tabId === null) {\n\t\treturn failed(\"herdr tab create returned no pane id\", ctx);\n\t}\n",
		},
		{
			oldText: "\tconst workspaceId = jsonResultField(created, \"workspace\", \"workspace_id\");\n\tif (workspaceId === null) {\n",
			newText:
				"\tconst workspaceId = jsonResultField(created, \"workspace\", \"workspace_id\");\n\tif (workspaceId !== null) ctx.onResource?.(\"worktree\", workspaceId, true, \"worktree workspace\");\n\tif (workspaceId === null) {\n",
		},
		{
			oldText:
				"\tconst paneId = jsonResultField(created, \"root_pane\", \"pane_id\");\n\tconst tabId = jsonResultField(created, \"tab\", \"tab_id\");\n\tif (paneId === null || tabId === null) {\n\t\tawait removeWorktreeCheckout(workspaceId, ctx);\n",
			newText:
				"\tconst paneId = jsonResultField(created, \"root_pane\", \"pane_id\");\n\tconst tabId = jsonResultField(created, \"tab\", \"tab_id\");\n\tif (tabId !== null) ctx.onResource?.(\"tab\", tabId, true, \"worktree tab\");\n\tif (paneId === null || tabId === null) {\n\t\tawait removeWorktreeCheckout(workspaceId, ctx);\n",
		},
	],
};
/** File with the recorded edits[2] oldText starting at lines 20 and 41. */
const handoffFile = buildFileWithSpans([[20, handoffInput.edits[2].oldText], [41, handoffInput.edits[2].oldText]]);

// --- Real session seed: multi-edit call, edits[4] matched three times -----
// Recorded 2026-09-01 in my-little-software-factory
// (factory-11-add-smooth-accelerated-ticket-detail-scrolling).
const ticketDetailError =
	"Found 3 occurrences of edits[4] in src/components/ticket-detail.ts. Each oldText must be unique. Please provide more context to make it unique.";
const ticketDetailInput = {
	path: "src/components/ticket-detail.ts",
	edits: [
		{ oldText: "import { type MouseEvent, type ScrollBoxRenderable } from \"@opentui/core\";", newText: "import type { MouseEvent, ScrollBoxRenderable } from \"@opentui/core\";" },
		{ oldText: "\tconst resetBurst = () => {\n\t\tresetWheelBurst(burstRef.current);\n\t};", newText: "\tconst resetBurst = useCallback(() => {\n\t\tresetWheelBurst(burstRef.current);\n\t}, []);" },
		{ oldText: "\t\t[geometry.visibleRows],", newText: "\t\t[geometry.visibleRows, moveBy, toEnd, toStart]," },
		{ oldText: "\t}, [ticket?.identity]);", newText: "\t}, [ticket?.identity, toStart]);" },
		{ oldText: "\t\tconst box = scrollBox();", newText: "\t\tconst box = scrollboxRef.current;" },
	],
};
/** File with the recorded edits[4] oldText starting at lines 7, 30, and 88. */
const ticketDetailFile = buildFileWithSpans([[7, ticketDetailInput.edits[4].oldText], [30, ticketDetailInput.edits[4].oldText], [88, ticketDetailInput.edits[4].oldText]]);

/**
 * Build a file where each (line, text) span starts at the given 1-based
 * line; multi-line texts occupy consecutive lines. Everything else is a
 * distinct filler line so no accidental match can form.
 */
function buildFileWithSpans(spans: [number, string][]): string {
	const spanAt = new Map<number, string[]>();
	for (const [startLine, text] of spans) spanAt.set(startLine, text.split("\n"));
	const out: string[] = [];
	let line = 1;
	for (;;) {
		const span = spanAt.get(line);
		if (span) {
			out.push(...span);
			line += span.length;
			spanAt.delete(line - span.length);
		} else {
			out.push(`// filler line ${line}`);
			line += 1;
			if (spanAt.size === 0) break;
		}
	}
	return out.join("\n");
}

describe("isAmbiguousEditError", () => {
	it("accepts the single-edit and multi-edit stock forms", () => {
		expect(isAmbiguousEditError("Found 3 occurrences of the text in src/x.ts. The text must be unique. Please provide more context to make it unique.")).toBe(true);
		expect(isAmbiguousEditError(handoffError)).toBe(true);
	});
	it("rejects the other edit failure classes", () => {
		expect(isAmbiguousEditError("Could not find the exact text in src/x.ts. The old text must match exactly including all whitespace and newlines.")).toBe(false);
		expect(isAmbiguousEditError('Validation failed for tool "edit":\n  - edits: must have required properties edits')).toBe(false);
		expect(isAmbiguousEditError("Could not edit file: src/x.ts. Error code: ENOENT.")).toBe(false);
		expect(isAmbiguousEditError("edits[0] and edits[1] overlap in src/x.ts. Merge them into one edit or target disjoint regions.")).toBe(false);
	});
});

describe("isEditValidationError", () => {
	it("accepts the edit validation error and rejects the rest", () => {
		expect(isEditValidationError(realValidationError({ path: "src/x.ts", offset: 10, limit: 20 }))).toBe(true);
		expect(isEditValidationError("Found 2 occurrences of edits[0] in src/x.ts. Each oldText must be unique. Please provide more context to make it unique.")).toBe(false);
		expect(isEditValidationError('Validation failed for tool "read":\n  - path: must have required properties path')).toBe(false);
	});
});

describe("occurrenceLineNumbers", () => {
	const file = [
		"export function a() {",
		"\tconst box = scrollBox();", // line 2
		"}",
		"export function b() {",
		"\tconst box = scrollBox();", // line 5
		"}",
		"",
		"\tconst box = scrollBox();", // line 8
	].join("\n");

	it("finds every non-overlapping fuzzy occurrence by file line", () => {
		expect(occurrenceLineNumbers(file, "\tconst box = scrollBox();")).toEqual([2, 5, 8]);
	});
	it("treats trailing whitespace, smart quotes, and dashes as pi's fuzzy match does", () => {
		const quoted = "a “quoted” line   \nb “quoted” line\n";
		expect(occurrenceLineNumbers(quoted, "a “quoted” line")).toEqual([1]);
		expect(occurrenceLineNumbers(quoted, "a “quoted” line   ")).toEqual([1]);
		expect(occurrenceLineNumbers("x – y\nx - y\n", "x - y")).toEqual([1, 2]);
	});
	it("keeps line numbers honest across CRLF endings and a BOM", () => {
		expect(occurrenceLineNumbers("\uFEFFone\r\ntwo\r\n", "two")).toEqual([2]);
	});
	it("returns nothing for an empty or absent needle", () => {
		expect(occurrenceLineNumbers(file, "")).toEqual([]);
		expect(occurrenceLineNumbers(file, "nope")).toEqual([]);
	});
	it("raw mode matches the exact LF-normalized text only", () => {
		expect(occurrenceLineNumbers("x – y\nx - y\n", "x - y", "raw")).toEqual([2]);
		expect(occurrenceLineNumbers("a “q” line\na \"q\" line\n", "a \"q\" line", "raw")).toEqual([2]);
		expect(occurrenceLineNumbers("\uFEFFone\r\ntwo\r\n", "two", "raw")).toEqual([2]);
	});
});

describe("ambiguousDiagnosis", () => {
	it("lists the real handoff.ts failure: two occurrences, each with its context line", () => {
		expect(ambiguousDiagnosis(handoffError, handoffInput, handoffFile)).toBe(
			[
				"Edit assist: the old text matches 2 places in the file:",
				"  20: " + handoffInput.edits[2].oldText.split("\n")[0],
				"  41: " + handoffInput.edits[2].oldText.split("\n")[0],
			].join("\n"),
		);
	});
	it("lists the real ticket-detail.ts failure: three occurrences", () => {
		const diagnosis = ambiguousDiagnosis(ticketDetailError, ticketDetailInput, ticketDetailFile);
		expect(diagnosis).toBe(
			[
				"Edit assist: the old text matches 3 places in the file:",
				"  7: " + ticketDetailInput.edits[4].oldText,
				"  30: " + ticketDetailInput.edits[4].oldText,
				"  88: " + ticketDetailInput.edits[4].oldText,
			].join("\n"),
		);
	});
	it("uses the first edit for the single-edit stock form", () => {
		const file = "const x = 1;\nconst x = 1;\n";
		const text = "Found 2 occurrences of the text in f.ts. The text must be unique. Please provide more context to make it unique.";
		expect(ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "const x = 1;", newText: "const y = 2;" }] }, file)).toBe(
			"Edit assist: the old text matches 2 places in the file:\n  1: const x = 1;\n  2: const x = 1;",
		);
	});
	it("caps the list at 10 lines and says how many more", () => {
		const file = Array.from({ length: 12 }, (_, i) => `dup line ${i}`).join("\n");
		const text = "Found 12 occurrences of edits[0] in f.ts. Each oldText must be unique. Please provide more context to make it unique.";
		const diagnosis = ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "dup line", newText: "" }] }, file);
		const lines = diagnosis!.split("\n");
		expect(lines[0]).toBe("Edit assist: the old text matches 12 places in the file:");
		expect(lines).toHaveLength(12); // head + 10 rows
		expect(lines[11]).toBe("  … and 2 more occurrence(s)");
	});
	it("caps one context line at 120 characters", () => {
		const longLine = "x".repeat(198) + "zz";
		const file = `zz\n${longLine}\nzz`;
		const text = "Found 3 occurrences of the text in f.ts. The text must be unique. Please provide more context to make it unique.";
		const diagnosis = ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "zz", newText: "" }] }, file);
		const rows = diagnosis!.split("\n");
		expect(rows[2]).toBe("  2: " + "x".repeat(120) + "…");
	});
	it("returns null when the input carries no matching oldText", () => {
		expect(ambiguousDiagnosis(handoffError, { path: "src/handoff.ts" }, handoffFile)).toBeNull();
		expect(ambiguousDiagnosis(handoffError, { path: "src/handoff.ts", edits: "a string" }, handoffFile)).toBeNull();
		expect(ambiguousDiagnosis("Found 2 occurrences of edits[9] in f.ts. Each oldText must be unique. Please provide more context to make it unique.", { path: "f.ts", edits: [{ oldText: "a", newText: "" }] }, "a\na\n")).toBeNull();
	});
	it("returns null when the file no longer reproduces the match", () => {
		expect(ambiguousDiagnosis(handoffError, handoffInput, "nothing like that here\n")).toBeNull();
	});
	it("keeps the fuzzy lines when the fuzzy count matches the stock count", () => {
		// Line 2 differs from the needle only by an en dash, which the fuzzy
		// normalization folds away. The stock count (3) is the fuzzy count,
		// so all three lines are listed.
		const file = "x - y\nx – y\nx - y\n";
		const text = "Found 3 occurrences of the text in f.ts. The text must be unique. Please provide more context to make it unique.";
		expect(ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "x - y", newText: "" }] }, file)).toBe(
			"Edit assist: the old text matches 3 places in the file:\n  1: x - y\n  2: x – y\n  3: x - y",
		);
	});
	it("re-derives the lines in raw mode when only the raw count matches the stock count", () => {
		// Exact matches on lines 1 and 3; line 2 differs only by an en dash.
		// The fuzzy count (3) does not reproduce the stock count (2), so the
		// lines come from the raw derivation against the literal text and
		// skip line 2.
		const file = "x - y\nx – y\nx - y\n";
		const text = "Found 2 occurrences of the text in f.ts. The text must be unique. Please provide more context to make it unique.";
		expect(ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "x - y", newText: "" }] }, file)).toBe(
			"Edit assist: the old text matches 2 places in the file:\n  1: x - y\n  3: x - y",
		);
	});
	it("returns null when neither derivation reproduces the stock count", () => {
		// One exact occurrence and one that differs only in trailing
		// whitespace: the fuzzy count is 2, the raw count is 1, the stock
		// count is 3. A stock error only rather than a dishonest diagnosis.
		const file = "const x = 1;\nconst x = 1;   \n";
		const text = "Found 3 occurrences of the text in f.ts. The text must be unique. Please provide more context to make it unique.";
		expect(ambiguousDiagnosis(text, { path: "f.ts", edits: [{ oldText: "const x = 1;", newText: "" }] }, file)).toBeNull();
	});
});

describe("malformedEditHint", () => {
	it("hints the real read-tool-shaped call (path, offset, limit, no edits)", () => {
		const stock = realValidationError({ path: "src/components/app.ts", offset: 1185, limit: 40 });
		expect(malformedEditHint(stock)).toBe(
			"Edit assist: a path with offset and limit and no edits is the read tool call. Use read to view the file, and edit with a path and an edits array to change it.",
		);
	});
	it("hints the real edits-as-string call", () => {
		// Recorded 2026-09-01 in my-little-software-factory: the model sent
		// edits as a JSON-ish string that pi's argument preparation could
		// not repair (unparseable), so validation saw a string.
		const stock = realValidationError({ edits: "\n[{\"newText\": * One row of complete key hints, packed from the control catalogue: the\n * control module owns the content" });
		expect(stock).toContain("- edits.0: must be object");
		expect(malformedEditHint(stock)).toBe(
			"Edit assist: edits was sent as a string and pi could not parse it as the edits array. Send edits as an array of {oldText, newText} objects.",
		);
	});
	it("gives no hint to any other malformed shape", () => {
		expect(malformedEditHint(realValidationError({ path: "crates/app/src/app.rs" }))).toBeNull();
		expect(malformedEditHint(realValidationError({ command: "cargo fmt --all", timeout: 120 }))).toBeNull();
		expect(malformedEditHint(realValidationError({ path: "src/x.ts", line_start: 1195, limit: 55 }))).toBeNull();
		expect(malformedEditHint(realValidationError({ path: "src/x.ts", symbol: "SharedFieldProps" }))).toBeNull();
		expect(malformedEditHint(realValidationError({ path: "src/x.ts", edits: [{ oldText: "a" }] }))).toBeNull();
		expect(malformedEditHint(realValidationError({ edits: [{ new_text: "a" }] }))).toBeNull();
	});
	it("gives no hint outside validation errors or when the arguments cannot be read back", () => {
		expect(malformedEditHint("Could not find the exact text in src/x.ts. The old text must match exactly including all whitespace and newlines.")).toBeNull();
		expect(malformedEditHint('Validation failed for tool "edit":\n  - edits: must have required properties edits\n\nReceived arguments:\n{not json')).toBeNull();
	});
});

describe("appendDiagnosis", () => {
	it("keeps the stock error text and adds the diagnosis after it", () => {
		const stock = "Found 2 occurrences of edits[2] in src/handoff.ts. Each oldText must be unique. Please provide more context to make it unique.";
		const out = appendDiagnosis(stock, "Edit assist: the old text matches 2 places in the file:\n  20: …");
		expect(out.startsWith(stock)).toBe(true);
		expect(out).toBe(stock + "\n\nEdit assist: the old text matches 2 places in the file:\n  20: …");
	});
	it("folds a trailing newline of the stock text into one separator", () => {
		const out = appendDiagnosis("stock error text\n", "Diagnosis line");
		expect(out).toBe("stock error text\n\nDiagnosis line");
	});
});

// ---------------------------------------------------------------------------
// No-match class (ticket #81): real fixtures from pi session data
// ---------------------------------------------------------------------------

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

it("keeps the whitespace-only note and a clean diff when the oldText ends with a newline", () => {
	// Models copy old blocks with the trailing newline. That newline must not
	// become a phantom empty line on the oldText side: it would lose the note
	// (the line counts diverge) and add a phantom empty line to the diff.
	const diagnosis = diagnoseNoMatch({
		path: "src/example.ts",
		fileText: "a b\nc d\ne f\n",
		edits: [{ oldText: "  a b\nc d\ne f\n", newText: "a b\nc d\ne f\n" }],
	});
	expect(diagnosis).toContain(
		"The difference is a whitespace-only difference: same line count, leading whitespace only.",
	);
	const lines = (diagnosis as string).split("\n");
	expect(lines).toContain("Nearest region: lines 1-3");
	// The hunk names the three real lines of both sides, and the body is the
	// one drifted line plus the two unchanged lines: no empty line, nothing
	// past the region.
	expect(lines).toContain("@@ -1,3 +1,3 @@");
	expect(lines.slice(lines.indexOf("@@ -1,3 +1,3 @@") + 1)).toEqual(["-  a b", "+a b", " c d", " e f"]);
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

	it("keeps a region at the end of a file with a trailing newline on real lines", () => {
		// The file's trailing newline and the oldText's trailing newline must
		// not split into phantom empty elements: the true region is the file's
		// last three lines, and no window may land on a line past the end.
		const file = "p q\nr s\nt u\nv w\nx y\n";
		const region = nearestRegion(file, "t u\nv w\nx y\n");
		expect(region).toEqual({ startLine: 3, endLine: 5, score: 1 });
	});

	it("never names a line past the real line count of a file with a trailing newline", () => {
		const file = "p q\nr s\nt u\nv w\nx y\n";
		for (const oldText of ["t u\nv w\nX y\n", "x y\n", "x y\n\n"]) {
			const region = nearestRegion(file, oldText);
			if (region) expect(region.endLine).toBeLessThanOrEqual(5);
		}
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
		const fileText = normalizeToLF(stripBom("\ufeffconst a = 1;\r\nconst b = 2;\r\n"));
		const diagnosis = diagnoseNoMatch({
			path: "src/win.ts",
			fileText,
			edits: [{ oldText: "const a = 1;\r\nconst b = 999;\r\n", newText: "x" }],
		});
		// The file has two lines; the trailing newlines of file and oldText
		// do not start a phantom third line.
		expect(diagnosis).toContain("Nearest region: lines 1-2");
	});

	it("keeps the region range and the diff inside a file with a trailing newline", () => {
		const file = "p q\nr s\nt u\nv w\nx y\n";
		const diagnosis = diagnoseNoMatch({
			path: "src/tail.ts",
			fileText: file,
			edits: [{ oldText: "t u\nv w\nX y\n", newText: "x" }],
		});
		expect(diagnosis).toContain("Nearest region: lines 3-5");
		// The diff shows the region's three real lines; the phantom line 6
		// appears neither in the range nor in the region label.
		expect(diagnosis).toContain("+++ file (lines 3-5)");
		expect(diagnosis).not.toContain("line 6");
		expect(diagnosis).not.toMatch(/lines \d+-6/);
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
