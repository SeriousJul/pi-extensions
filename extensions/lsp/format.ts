/**
 * The renderers. Pure functions: they turn the extension's state into the
 * exact text the model and the operator read. Every shape that reaches the
 * model is size-bounded here, so one broken file cannot flood the window.
 */
import type { LspDiagnostic } from "./types.ts";

/** Severity letter per LSP DiagnosticSeverity. */
export const SEVERITY_LETTERS: Record<number, string> = { 1: "E", 2: "W", 3: "I", 4: "H" };
export const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

/** The severities one filter passes. v1 never shows info or hint. */
export function severitiesForFilter(filter: "warning" | "error"): Set<number> {
	return filter === "error" ? new Set([1]) : new Set([1, 2]);
}

/** A diagnostic's stable identity: where it is and what it says. */
export function diagnosticKey(d: LspDiagnostic): string {
	const severity = d.severity ?? 1;
	const code = d.code === undefined ? "" : String(d.code);
	return `${severity}:${d.range.start.line}:${d.range.start.character}:${code}:${d.message}`;
}

/** True when the diagnostic passes the filter (error and warning by default). */
export function passesSeverity(d: LspDiagnostic, filter: "warning" | "error"): boolean {
	const severity = d.severity ?? 1;
	if (severity === 1) return true;
	if (severity === 2) return filter === "warning";
	return false;
}

/** The one-line form of a diagnostic: letter, position, message, code. */
export function formatDiagnosticLine(d: LspDiagnostic): string {
	const letter = SEVERITY_LETTERS[d.severity ?? 1] ?? "?";
	const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
	let message = d.message.replace(/\s+/g, " ").trim();
	if (message.length > 200) message = message.slice(0, 197) + "...";
	const code = d.code === undefined ? "" : ` (${d.code})`;
	return `${letter} ${pos}  ${message}${code}`;
}

const MAX_PER_FILE = 10;
const MAX_TOTAL = 30;

/**
 * One file's diagnostics rendered under the caps: a file header line, at
 * most MAX_PER_FILE diagnostic lines, then the "+N more in `path`" summary
 * line. The header names the file, so a multi-file answer never mixes
 * files together.
 */
export function renderFileGroup(displayPath: string, diags: LspDiagnostic[], filter: "warning" | "error", capLeft: number): string[] {
	const shown = diags.filter((d) => passesSeverity(d, filter));
	if (shown.length === 0) return [`${displayPath} (no new diagnostics)`];
	const lines: string[] = [`${displayPath}:`];
	const budget = Math.min(shown.length, MAX_PER_FILE, Math.max(0, capLeft));
	for (let i = 0; i < budget; i += 1) lines.push(`  ${formatDiagnosticLine(shown[i])}`);
	const hiddenInFile = shown.length - Math.min(shown.length, MAX_PER_FILE);
	if (hiddenInFile > 0) lines.push(`  +${hiddenInFile} more in \`${displayPath}\``);
	const hiddenByCap = Math.min(shown.length, MAX_PER_FILE) - budget;
	if (hiddenByCap > 0) lines.push(`  +${hiddenByCap} more in \`${displayPath}\` (result cap)`);
	return lines;
}

export interface DiagnosticFileGroup {
	/** The path shown to the model, relative to the server root when possible. */
	displayPath: string;
	/** The new diagnostics, already filtered by severity. */
	diagnostics: LspDiagnostic[];
	/** This is the file the edit or write touched. */
	edited: boolean;
}

/**
 * The text block an annotation or tool result carries. Returns the lines
 * and how many diagnostic lines were shown, so the caller can log the size.
 */
export function renderDiagnosticGroups(
	header: string,
	groups: DiagnosticFileGroup[],
	filter: "warning" | "error",
): { text: string; shown: number } {
	const lines: string[] = [header];
	let shown = 0;
	for (const group of groups) {
		if (shown >= MAX_TOTAL) {
			// The cap is spent: name the file, show nothing of it.
			lines.push(`${group.displayPath} (cap reached)`);
			continue;
		}
		const body = renderFileGroup(group.displayPath, group.diagnostics, filter, MAX_TOTAL - shown);
		lines.push(...body);
		const added = body.filter((l) => l.startsWith("  E ") || l.startsWith("  W ") || l.startsWith("  I ") || l.startsWith("  H ")).length;
		shown += added;
	}
	return { text: lines.join("\n"), shown };
}

export const PARTIAL_NOTE = (serverLabel: string): string =>
	`partial - ${serverLabel} is still working on the file; the answer may be incomplete`;

/**
 * The three-line prompt note (issue #136). It states the boundary: what the
 * LSP tools do, and what codegraph keeps. It is one block; the first line
 * names the languages that run.
 */
export function promptNoteFor(languages: string[]): string {
	const list = languages.join(", ");
	return [
		`LSP: language servers run for this project (${list}). After an edit or write, the new diagnostics from the real language server are attached to the tool result.`,
		"- lsp_diagnostics: the current diagnostics of a file. lsp_references: the exact call sites of a symbol given a file, line, character. lsp_hover: the real type behind a symbol.",
		"- codegraph owns symbol search, file reading, and the call trail. Use an LSP tool only where a language server clearly beats it.",
	].join("\n");
}

/** The sweep message that opens the agent's next turn. */
export function renderSweepMessage(newErrorCount: number, groups: DiagnosticFileGroup[], filter: "warning" | "error", serverLabel: string): string {
	const body = renderDiagnosticGroups(
		`LSP sweep: ${newErrorCount} new ${newErrorCount === 1 ? "error diagnostic" : "error diagnostics"} since the last check (${serverLabel})`,
		groups,
		filter,
	);
	return body.text;
}
