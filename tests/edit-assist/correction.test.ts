/**
 * Unit tests for the edit assist Input correction (ticket #83). The
 * corrected-retry pairs are recorded from real pi session data: a failing
 * edit call whose oldText was wrong only in leading whitespace, followed in
 * the same session by a successful retry with the file's real text. The
 * retry's oldText is the file's actual text at the match, so the fixture
 * files place it at a known line and fill the rest with distinct lines.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
	correctionForEdit,
	extendedOccurrenceLineNumbers,
	honestyNotes,
	isWhitespaceOnlyDiff,
	normalizeExtendedLine,
} from "../../extensions/edit-assist/core.ts";
import { countLines, readTargetFile } from "../../extensions/edit-assist/index.ts";

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

// --- Real corrected-retry seeds -------------------------------------------

// Recorded 2026-09-01 in my-little-software-factory
// (factory-12-show-task-type-badges-in-the-ticket-list). The failing call's
// oldText used two-tab indentation; the file held the block at three tabs.
const appTestRetryOldText =
	"\t\t\t// Shrink the terminal mid-session, across a width where the badge\n\t\t\t// no longer fits.\n\t\t\tsetup.resize(60, 12);\n\t\t\tconst small = await awaitFrame(\n\t\t\t\tsetup,\n\t\t\t\t(f) =>\n\t\t\t\t\trowsOf(f).length === 12 &&\n\t\t\t\t\trowsOf(f).every((row) => row.length === 60) &&\n\t\t\t\t\tf.includes(\"Tickets\") &&\n\t\t\t\t\tf.includes(\"Detail\"),\n\t\t\t\t\"the frame to take the new size\",\n\t\t\t);";
const appTestFailedOldText =
	"\t\t// Shrink the terminal mid-session, across a width where the badge\n\t\t// no longer fits.\n\t\tsetup.resize(60, 12);\n\t\tconst small = await awaitFrame(\n\t\t\tsetup,\n\t\t\t(f) =>\n\t\t\t\trowsOf(f).length === 12 &&\n\t\t\t\trowsOf(f).every((row) => row.length === 60) &&\n\t\t\t\tf.includes(\"Tickets\") &&\n\t\t\t\tf.includes(\"Detail\"),\n\t\t\t\"the frame to take the new size\",\n\t\t);";
const appTestFile = buildFileWithSpans([[20, appTestRetryOldText]]);

// Recorded 2026-09-01 in my-little-software-factory
// (factory-16-give-override-text-fields-standard-editing-and-terminal-paste),
// edits[5] of a multi-edit call on src/components/override-panel.ts. The
// failing oldText used five tabs; the file held the lines at four.
const overridePanelRetryOldText =
	"\t\t\t\ttextColor: selected ? COLORS.textBright : COLORS.text,\n\t\t\t\tbackgroundColor: \"transparent\",\n\t\t\t\tfocusedBackgroundColor: \"transparent\",";
const overridePanelFailedOldText =
	"\t\t\t\t\ttextColor: selected ? COLORS.textBright : COLORS.text,\n\t\t\t\t\tbackgroundColor: \"transparent\",\n\t\t\t\t\tfocusedBackgroundColor: \"transparent\",";
const overridePanelFile = buildFileWithSpans([[8, overridePanelRetryOldText]]);

// Recorded 2026-09-01 in my-little-software-factory
// (factory-19-add-durable-interactive-consultations) on src/components/app.ts.
// Single line, eight tabs in the call, seven in the file.
const appRetryOldText = "\t\t\t\t\t\t\tvisibleRows: Math.max(1, detailGeometry.visibleRows - (responseEditor ? 3 : 0)),";
const appFailedOldText =
	"\t\t\t\t\t\t\t\tvisibleRows: Math.max(1, detailGeometry.visibleRows - (responseEditor ? 3 : 0)),";
const appFile = buildFileWithSpans([[5, appRetryOldText]]);

// Recorded 2026-09-01 in my-little-software-factory
// (factory-13-add-interactive-consultations-to-the-control-plane) on
// src/config.ts. The failing oldText carried an extra closing brace (}),
// the file held ) - character drift, never corrected.
const configDriftFailedOldText =
	"\t\t}),\n\t\t\"auto-handoff\": config.autoHandoff,\n\t\t\"max-parallel-agents\": config.maxParallelAgents,\n";
const configFile = [
	"export function buildSettings(config: Settings) {",
	"\treturn {",
	"\t\t...defaults,",
	"\t\t),",
	"\t\t\"auto-handoff\": config.autoHandoff,",
	"\t\t\"max-parallel-agents\": config.maxParallelAgents,",
	"\t};",
	"}",
].join("\n");

describe("normalizeExtendedLine", () => {
	it("strips leading whitespace and applies pi's fuzzy folding", () => {
		expect(normalizeExtendedLine("\t\t  x = 1;")).toBe("x = 1;");
		expect(normalizeExtendedLine("\t\u00A0“q”")).toBe('"q"');
		expect(normalizeExtendedLine("  a – b")).toBe("a - b");
	});
});

describe("extendedOccurrenceLineNumbers", () => {
	const file = [
		"export function a() {",
		"\tconst box = scrollBox();", // line 2
		"  const box = scrollBox();", // line 3, different indentation
		"\t\tconst box = scrollBox();", // line 4, different indentation
		"}",
	].join("\n");

	it("counts every occurrence regardless of leading whitespace", () => {
		expect(extendedOccurrenceLineNumbers(file, "const box = scrollBox();")).toEqual([2, 3, 4]);
		expect(extendedOccurrenceLineNumbers(file, "\tconst box = scrollBox();")).toEqual([2, 3, 4]);
		expect(extendedOccurrenceLineNumbers(file, "  const box = scrollBox();")).toEqual([2, 3, 4]);
	});
	it("folds fuzzy characters on top of the whitespace blindness", () => {
		expect(extendedOccurrenceLineNumbers("x – y\nx - y\n", "  x - y")).toEqual([1, 2]);
	});
	it("returns nothing when the extended needle does not occur", () => {
		expect(extendedOccurrenceLineNumbers(file, "const other = 0;")).toEqual([]);
		expect(extendedOccurrenceLineNumbers(file, "   ")).toEqual([]);
	});
});

describe("isWhitespaceOnlyDiff", () => {
	it("accepts the same lines with any leading-whitespace difference", () => {
		expect(isWhitespaceOnlyDiff("\t\treturn n;", "  return n;")).toBe(true);
		expect(
			isWhitespaceOnlyDiff(
				"\tlet a = 1;\n  let b = 2;",
				"\t\tlet a = 1;\n\tlet b = 2;",
			),
		).toBe(true);
	});
	it("rejects a different line count", () => {
		expect(isWhitespaceOnlyDiff("\treturn n;\n", "  return n;")).toBe(false);
		expect(isWhitespaceOnlyDiff("\treturn n;", "  return n;\n  x;")).toBe(false);
	});
	it("rejects any character drift, even a character the fuzzy normalization folds", () => {
		expect(isWhitespaceOnlyDiff("  x - y", "\tx – y")).toBe(false);
		expect(isWhitespaceOnlyDiff("  }),", "\t),")).toBe(false);
	});
	it("rejects a trailing-whitespace difference: the raw diff is not leading-only", () => {
		expect(isWhitespaceOnlyDiff("  return n;  ", "\treturn n;")).toBe(false);
	});
});

describe("correctionForEdit", () => {
	it("corrects the real app.test.ts pair: the file's real text at the real line", () => {
		expect(correctionForEdit(appTestFile, appTestFailedOldText)).toEqual({ oldText: appTestRetryOldText, line: 20 });
	});
	it("corrects the real override-panel.ts pair (edits[5] of a multi-edit call)", () => {
		expect(correctionForEdit(overridePanelFile, overridePanelFailedOldText)).toEqual({ oldText: overridePanelRetryOldText, line: 8 });
	});
	it("corrects the real single-line app.ts pair", () => {
		expect(correctionForEdit(appFile, appFailedOldText)).toEqual({ oldText: appRetryOldText, line: 5 });
	});
	it("never touches an oldText that already exact-matches, even with several Extended matches", () => {
		const file = "  const box = scrollBox();\n\tconst box = scrollBox();\n";
		expect(correctionForEdit(file, "  const box = scrollBox();")).toBeNull();
		expect(correctionForEdit(file, "\tconst box = scrollBox();")).toBeNull();
	});
	it("never corrects when the Extended match occurs several times", () => {
		const file = "export function a() {\n\tconst box = scrollBox();\n}\nexport function b() {\n  const box = scrollBox();\n}\n";
		expect(correctionForEdit(file, "const box = scrollBox();")).toBeNull();
		expect(correctionForEdit(file, "\tconst box = scrollBox();")).toBeNull();
	});
	it("never corrects character drift: the real }), versus ), seed", () => {
		expect(correctionForEdit(configFile, configDriftFailedOldText)).toBeNull();
	});
	it("never corrects a unique Extended match whose raw diff has any character drift", () => {
		// The en dash folds to a hyphen, so the Extended match is unique, but
		// the raw difference is not leading whitespace.
		expect(correctionForEdit("x – y\n", "  x - y")).toBeNull();
		expect(correctionForEdit("x - y\n", "\tx – y")).toBeNull();
	});
	it("never corrects when the Extended match does not occur at all", () => {
		expect(correctionForEdit("x - y\n", "  x - z")).toBeNull();
	});
	it("returns null for an empty oldText", () => {
		expect(correctionForEdit("x - y\n", "")).toBeNull();
		expect(correctionForEdit("x - y\n", "  \t ")).toBeNull();
	});
	it("corrects against BOM and CRLF the way the built-in tool reads the file", () => {
		const file = "\uFEFFexport function a() {\r\n\t\tconst box = scrollBox();\r\n}\r\n";
		expect(correctionForEdit(file, "  const box = scrollBox();")).toEqual({ oldText: "\t\tconst box = scrollBox();", line: 2 });
	});
	it("reports the 1-based line where the corrected region starts", () => {
		const file = buildFileWithSpans([[41, "\t\treturn n;"]]);
		expect(correctionForEdit(file, "  return n;")).toEqual({ oldText: "\t\treturn n;", line: 41 });
	});
});

describe("honestyNotes", () => {
	it("names the line and the single edit", () => {
		expect(honestyNotes([{ editIndex: 0, line: 4 }], 1)).toEqual([
			"Edit assist: the edit was applied at line 4 with whitespace normalization of its old text.",
		]);
	});
	it("names edits[i] in a multi-edit call, one line per corrected edit", () => {
		expect(honestyNotes([{ editIndex: 1, line: 12 }, { editIndex: 3, line: 30 }], 5)).toEqual([
			"Edit assist: edits[1] was applied at line 12 with whitespace normalization of its old text.",
			"Edit assist: edits[3] was applied at line 30 with whitespace normalization of its old text.",
		]);
	});
});

describe("the ADR file guards (wiring)", () => {
	it("counts lines the way the guard means: a trailing newline ends, not starts", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("one")).toBe(1);
		expect(countLines("one\n")).toBe(1);
		expect(countLines("one\ntwo\n")).toBe(2);
	});
	it("skips files over 300 KB or 20,000 lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "edit-assist-guard-"));
		try {
			const okFile = join(dir, "ok.ts");
			writeFileSync(okFile, "x".repeat(300 * 1024)); // exactly 300 KB: still intercepted
			expect(await readTargetFile(dir, { path: "ok.ts" })).toBe("x".repeat(300 * 1024));
			const bigFile = join(dir, "big.ts");
			writeFileSync(bigFile, "x".repeat(300 * 1024 + 1));
			expect(await readTargetFile(dir, { path: "big.ts" })).toBeNull();
			const longFile = join(dir, "long.ts");
			writeFileSync(longFile, Array.from({ length: 20_001 }, (_, i) => `line ${i}`).join("\n"));
			expect(await readTargetFile(dir, { path: "long.ts" })).toBeNull();
			expect(await readTargetFile(dir, { path: "missing.ts" })).toBeNull();
			expect(await readTargetFile(dir, { path: "." })).toBeNull();
			expect(await readTargetFile(dir, { path: 7 })).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
