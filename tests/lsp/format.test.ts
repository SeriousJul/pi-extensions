/**
 * The renderers: the exact text the model and the operator read. The
 * invariants pinned here are the ones the ticket depends on: severities
 * filtered, per-file headers, the size caps, the partial label, and the
 * three-line prompt note.
 */
import { describe, expect, it } from "vitest";

import {
	PARTIAL_NOTE,
	diagnosticKey,
	formatDiagnosticLine,
	promptNoteFor,
	renderDiagnosticGroups,
	renderFileGroup,
	renderSweepMessage,
	severitiesForFilter,
	type DiagnosticFileGroup,
} from "../../extensions/lsp/format.ts";
import type { LspDiagnostic } from "../../extensions/lsp/types.ts";

function d(line: number, character: number, message: string, severity = 1, code?: number | string): LspDiagnostic {
	return {
		range: { start: { line, character }, end: { line, character: character + 1 } },
		severity,
		code,
		message,
	};
}

describe("severitiesForFilter", () => {
	it("error passes only errors; warning passes errors and warnings", () => {
		expect([...severitiesForFilter("error")]).toEqual([1]);
		expect([...severitiesForFilter("warning")].sort()).toEqual([1, 2]);
	});
});

describe("diagnosticKey", () => {
	it("is stable for the same diagnostic and different when anything moves", () => {
		const a = d(3, 5, "boom");
		expect(diagnosticKey(a)).toBe(diagnosticKey(d(3, 5, "boom")));
		expect(diagnosticKey(d(4, 5, "boom"))).not.toBe(diagnosticKey(a));
		expect(diagnosticKey(d(3, 6, "boom"))).not.toBe(diagnosticKey(a));
		expect(diagnosticKey(d(3, 5, "bump"))).not.toBe(diagnosticKey(a));
		expect(diagnosticKey(d(3, 5, "boom", 1, 2322))).not.toBe(diagnosticKey(a));
	});
});

describe("formatDiagnosticLine", () => {
	it("is one line: letter, 1-based position, trimmed message, code", () => {
		expect(formatDiagnosticLine(d(3, 4, "  boom   ", 1, 2322))).toBe("E L4:5  boom (2322)");
		expect(formatDiagnosticLine(d(0, 0, "warn here", 2))).toBe("W L1:1  warn here");
	});

	it("caps a long message", () => {
		const line = formatDiagnosticLine(d(0, 0, "x".repeat(500)));
		const msgPart = line.slice(line.indexOf("L1:1") + 5).trim();
		expect(msgPart.length).toBeLessThanOrEqual(200);
		expect(msgPart.endsWith("...")).toBe(true);
	});
});

describe("renderFileGroup", () => {
	it("names the file, caps the lines, and summarizes the hidden rest", () => {
		const diags = Array.from({ length: 15 }, (_, i) => d(i, 0, `problem ${i}`));
		const lines = renderFileGroup("app.ts", diags, "warning", 100);
		expect(lines[0]).toBe("app.ts:");
		const diagLines = lines.filter((l) => l.startsWith("  E "));
		expect(diagLines).toHaveLength(10); // per-file cap
		expect(lines.some((l) => l.includes("+5 more in `app.ts`"))).toBe(true);
	});

	it("a clean file says so on its header line", () => {
		expect(renderFileGroup("ok.ts", [], "warning", 100)).toEqual(["ok.ts (no new diagnostics)"]);
	});

	it("the warning filter hides info and hint, the error filter hides warnings too", () => {
		const mixed = [d(0, 0, "e", 1), d(1, 0, "w", 2), d(2, 0, "i", 3), d(3, 0, "h", 4)];
		expect(renderFileGroup("a.ts", mixed, "warning", 100).filter((l) => l.startsWith("  "))).toHaveLength(2);
		expect(renderFileGroup("a.ts", mixed, "error", 100).filter((l) => l.startsWith("  "))).toHaveLength(1);
	});
});

describe("renderDiagnosticGroups", () => {
	it("totals the shown lines and stops at the overall cap", () => {
		const groups: DiagnosticFileGroup[] = Array.from({ length: 20 }, (_, i) => ({
			displayPath: `f${i}.ts`,
			diagnostics: [d(0, 0, `p${i}`, 1), d(1, 0, `q${i}`, 1)],
			edited: i === 0,
		}));
		const { text, shown } = renderDiagnosticGroups("LSP: header", groups, "warning");
		expect(shown).toBe(30); // the total cap, not the 40 available
		expect(text).toContain("(cap reached)");
	});
});

describe("PARTIAL_NOTE and the sweep message", () => {
	it("the partial note names the server and the uncertainty", () => {
		const note = PARTIAL_NOTE("TypeScript");
		expect(note).toContain("partial");
		expect(note).toContain("TypeScript");
	});

	it("the sweep message states the count and the server", () => {
		const text = renderSweepMessage(2, [{ displayPath: "a.ts", diagnostics: [d(0, 0, "x", 1), d(1, 0, "y", 1)], edited: false }], "warning", "TypeScript");
		expect(text).toContain("2 new error diagnostics");
		expect(text).toContain("TypeScript");
	});

	it("a single sweep diagnostic is singular", () => {
		const text = renderSweepMessage(1, [{ displayPath: "a.ts", diagnostics: [d(0, 0, "x", 1)], edited: false }], "warning", "TypeScript");
		expect(text).toContain("1 new error diagnostic since");
	});
});

describe("promptNoteFor", () => {
	it("is three lines, names the languages, and states the boundary", () => {
		const note = promptNoteFor(["TypeScript", "C/C++"]);
		const lines = note.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("TypeScript, C/C++");
		expect(note).toContain("lsp_diagnostics");
		expect(note).toContain("codegraph owns symbol search, file reading, and the call trail");
	});
});
