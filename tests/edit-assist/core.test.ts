/**
 * Unit tests for the edit assist core (ticket #84). Fixtures are seeded
 * from real failing edit calls extracted from pi session data: the stock
 * error texts and call arguments are the recorded ones; the file contents
 * are reconstructed so the recorded oldTexts occur the recorded number of
 * times (the original worktrees no longer exist).
 */
import { describe, expect, it } from "vitest";

import {
	ambiguousDiagnosis,
	appendDiagnosis,
	isAmbiguousEditError,
	isEditValidationError,
	malformedEditHint,
	occurrenceLineNumbers,
} from "../../extensions/edit-assist/core.ts";
import { realValidationError } from "./fixtures.ts";

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
			"Edit assist: edits must be an array of {oldText, newText} objects; a JSON string is not accepted. Send the array itself.",
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
