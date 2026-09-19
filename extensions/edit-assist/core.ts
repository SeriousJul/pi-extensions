/**
 * Edit assist core: the Diagnosis for the two failure classes that never
 * reached the file's matching step cleanly - ambiguous (the oldText matched
 * the file in several places) and malformed-argument (the call failed
 * argument validation and never executed at all).
 *
 * Pure module: no pi API, no filesystem. The wiring (index.ts) reads the
 * file and calls these functions. Every output is a size-bounded Diagnosis
 * block (CONTEXT.md): the block re-entries into the model context on every
 * later call until compaction.
 *
 * The stock error text is never rewritten; a Diagnosis is appended after it
 * (ADR 0020). The ambiguous Diagnosis re-derives pi's own occurrence set and
 * checks it against the count in the stock error. pi's countOccurrences
 * normalizes both the file content and the oldText through the fuzzy
 * normalization before counting, so the stock count is the fuzzy count in
 * both of pi's replacement modes. This module derives the lines in fuzzy
 * mode; when that count differs from the stock count, the file changed after
 * execution (or the normalization mirror drifted), and it re-derives the
 * lines in raw mode against the non-fuzzy LF-normalized content, listing the
 * literal matches in the current file. It gives up (stock error only) when
 * neither derivation reproduces the stock count.
 */

/** Max occurrence lines shown in an ambiguous Diagnosis (ticket #84). */
export const MAX_OCCURRENCES = 10;

/** One context line is capped so a long file line cannot blow the budget. */
const MAX_CONTEXT_LINE = 120;

/**
 * pi's fuzzy-match normalization (mirrored, not imported: the function is
 * not exported from the pi-coding-agent package). Per line: NFKC, trailing
 * whitespace stripped, smart quotes/dashes/spaces mapped to ASCII.
 */
export function normalizeFuzzyLine(line: string): string {
	return (
		line
			.normalize("NFKC")
			.trimEnd()
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Dashes/hyphens/minus → -
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** Strip a leading BOM, mirroring the built-in edit's read path. */
function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Normalize line endings to LF, mirroring the built-in edit's match path. */
function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The matching mode: "fuzzy" applies pi's fuzzy normalization per line
 * (mirroring pi's countOccurrences); "raw" matches the LF-normalized text
 * exactly. pi always reports the fuzzy count, so "raw" is only the fallback
 * used to re-derive the lines when the file no longer reproduces the stock
 * count.
 */
export type OccurrenceMode = "fuzzy" | "raw";

/**
 * The non-overlapping occurrence lines of oldText in fileText under a
 * per-line normalization. Line structure stays intact, so a match in the
 * joined normalized text maps to exact lines of the file.
 */
function occurrenceLineNumbersWith(fileText: string, oldText: string, normalizeLine: (line: string) => string): number[] {
	const fileLines = stripBom(normalizeToLF(fileText))
		.split("\n")
		.map(normalizeLine);
	const needle = normalizeToLF(oldText)
		.split("\n")
		.map(normalizeLine)
		.join("\n");
	if (needle.length === 0) return [];
	const haystack = fileLines.join("\n");
	const lines: number[] = [];
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) break;
		lines.push(haystack.slice(0, index).split("\n").length);
		from = index + needle.length;
	}
	return lines;
}

/**
 * 1-based line numbers where oldText matches fileText in file order.
 * Non-overlapping, mirroring pi's countOccurrences.
 */
export function occurrenceLineNumbers(fileText: string, oldText: string, mode: OccurrenceMode = "fuzzy"): number[] {
	const normalizeLine = mode === "fuzzy" ? normalizeFuzzyLine : (line: string) => line;
	return occurrenceLineNumbersWith(fileText, oldText, normalizeLine);
}

/**
 * The Extended match's per-line normalization (ADR 0020): pi's fuzzy
 * normalization with the leading whitespace stripped. The strip runs after
 * the fuzzy normalization, so special spaces already folded to ASCII spaces
 * also drop off the line start.
 */
export function normalizeExtendedLine(line: string): string {
	return normalizeFuzzyLine(line).replace(/^[ \t]*/, "");
}

/**
 * 1-based line numbers where oldText Extended-matches fileText in file
 * order: pi's fuzzy normalization plus a leading-whitespace-insensitive
 * comparison.
 */
export function extendedOccurrenceLineNumbers(fileText: string, oldText: string): number[] {
	return occurrenceLineNumbersWith(fileText, oldText, normalizeExtendedLine);
}

/** Leading whitespace in the raw diff test: spaces and tabs. */
function stripLeadingWhitespace(line: string): string {
	return line.replace(/^[ \t]*/, "");
}

/**
 * The Whitespace-only diff test (ADR 0020): the same line count and every
 * line pair differing only in leading whitespace. The raw lines compare, so
 * any character drift fails the test, even when pi's fuzzy normalization
 * would fold the character away.
 */
export function isWhitespaceOnlyDiff(oldText: string, fileText: string): boolean {
	const a = normalizeToLF(oldText).split("\n");
	const b = fileText.split("\n");
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (stripLeadingWhitespace(a[i]) !== stripLeadingWhitespace(b[i])) return false;
	}
	return true;
}

/** One corrected edit of a call: which edit, and the line it starts on. */
export interface Correction {
	editIndex: number;
	line: number;
}

/**
 * The Input correction for one edit (ADR 0020), or null when the call is
 * left alone: an oldText that already exact-matches is never touched, zero
 * or several Extended matches never correct, and a difference with any
 * character drift degrades to the Diagnosis. The returned oldText is the
 * file's actual text at the match, so the built-in tool exact-matches it.
 */
export function correctionForEdit(fileText: string, oldText: string): { oldText: string; line: number } | null {
	const file = stripBom(normalizeToLF(fileText));
	const needle = normalizeToLF(oldText);
	if (needle.length === 0) return null;
	if (file.indexOf(needle) !== -1) return null;
	const occurrences = extendedOccurrenceLineNumbers(file, needle);
	if (occurrences.length !== 1) return null;
	const start = occurrences[0] - 1;
	const lines = file.split("\n");
	const region = lines.slice(start, start + needle.split("\n").length).join("\n");
	if (!isWhitespaceOnlyDiff(needle, region)) return null;
	return { oldText: region, line: occurrences[0] };
}

/**
 * The honesty notes for a corrected call (ADR 0020): one line per corrected
 * edit, naming the line and saying the edit ran with the whitespace-
 * normalized old text. Naming follows pi's own error style: the single edit
 * is unnamed, the i-th edit of a multi-edit call is edits[i].
 */
export function honestyNotes(corrections: Correction[], totalEdits: number): string[] {
	return corrections.map(({ editIndex, line }) =>
		totalEdits === 1
			? `Edit assist: the edit was applied at line ${line} with whitespace normalization of its old text.`
			: `Edit assist: edits[${editIndex}] was applied at line ${line} with whitespace normalization of its old text.`,
	);
}

/** True when the text is the built-in edit's ambiguous-match error. */
export function isAmbiguousEditError(text: string): boolean {
	return /^Found \d+ occurrences of (?:the text|edits\[\d+\]) in /m.test(text);
}

/** True when the text is an argument-validation failure of the edit tool. */
export function isEditValidationError(text: string): boolean {
	return text.startsWith('Validation failed for tool "edit":');
}

/**
 * The count the stock error names, or null when the text does not carry one.
 */
function stockOccurrenceCount(errorText: string): number | null {
	const match = /Found (\d+) occurrences of /.exec(errorText);
	return match !== null ? Number(match[1]) : null;
}

/**
 * The Diagnosis for an ambiguous failure, or null when the input does not
 * carry the failing oldText or the file no longer reproduces the stock
 * count. errorText selects the failing edit: the stock error names it as
 * edits[i] for multi-edit calls and leaves it out for single-edit calls.
 */
export function ambiguousDiagnosis(errorText: string, input: unknown, fileText: string): string | null {
	const parsed = parseEditInput(input);
	if (!parsed) return null;
	const named = /edits\[(\d+)\]/.exec(errorText);
	const editIndex = named !== null ? Number(named[1]) : 0;
	const oldText = parsed.edits[editIndex];
	if (typeof oldText !== "string") return null;
	const stockCount = stockOccurrenceCount(errorText);
	let lines: number[] | null = occurrenceLineNumbers(fileText, oldText, "fuzzy");
	if (stockCount !== null && lines.length !== stockCount) {
		const rawLines = occurrenceLineNumbers(fileText, oldText, "raw");
		lines = rawLines.length === stockCount ? rawLines : null;
	}
	if (lines === null || lines.length === 0) return null;
	const shown = lines.slice(0, MAX_OCCURRENCES);
	const context = fileLines(fileText);
	const rows = shown.map((line, i) => {
		const raw = context[line - 1] ?? "";
		const capped = raw.length > MAX_CONTEXT_LINE ? raw.slice(0, MAX_CONTEXT_LINE) + "…" : raw;
		return `  ${line}: ${capped}`;
	});
	if (lines.length > shown.length) {
		rows.push(`  … and ${lines.length - shown.length} more occurrence(s)`);
	}
	const head = `Edit assist: the old text matches ${lines.length} ${lines.length === 1 ? "place" : "places"} in the file:`;
	return [head, ...rows].join("\n");
}

/**
 * The one-line hint for a malformed-argument failure, or null. The stock
 * error already prints the received arguments; this parses them back out
 * and hints only on the two shapes a model can fix in one retry:
 * a read-tool-shaped call (path with offset and limit, no edits) and an
 * edits value sent as a string. Any other shape gets no hint.
 */
export function malformedEditHint(errorText: string): string | null {
	if (!isEditValidationError(errorText)) return null;
	const args = parseReceivedArguments(errorText);
	if (args === null) return null;
	if (typeof args.edits === "string") {
		return "Edit assist: edits was sent as a string and pi could not parse it as the edits array. Send edits as an array of {oldText, newText} objects.";
	}
	if (isReadToolShaped(args)) {
		return "Edit assist: a path with offset and limit and no edits is the read tool call. Use read to view the file, and edit with a path and an edits array to change it.";
	}
	return null;
}

/** Parse the edit call's arguments out of a tool call input. */
function parseEditInput(input: unknown): { edits: unknown[] } | null {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
	const edits = (input as Record<string, unknown>).edits;
	if (!Array.isArray(edits)) return null;
	const oldTexts = edits.map((edit) =>
		edit !== null && typeof edit === "object" ? (edit as Record<string, unknown>).oldText : undefined,
	);
	return { edits: oldTexts };
}

/** Read-tool shape: a path with offset and limit, and no edits at all. */
function isReadToolShaped(args: Record<string, unknown>): boolean {
	if (typeof args.path !== "string") return false;
	if ("edits" in args) return false;
	return typeof args.offset === "number" && typeof args.limit === "number";
}

/**
 * The arguments the built-in validation error printed. pi prints them with
 * JSON.stringify(arguments, null, 2) after the "Received arguments:" line.
 */
function parseReceivedArguments(errorText: string): Record<string, unknown> | null {
	const marker = "Received arguments:\n";
	const start = errorText.indexOf(marker);
	if (start === -1) return null;
	try {
		const parsed: unknown = JSON.parse(errorText.slice(start + marker.length));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The file's lines in LF form, for context lookups. */
function fileLines(fileText: string): string[] {
	return stripBom(normalizeToLF(fileText)).split("\n");
}

/**
 * Append a Diagnosis block to the stock error text. The stock text is kept
 * verbatim (a trailing newline is folded into the separator).
 */
export function appendDiagnosis(stockError: string, diagnosis: string): string {
	return stockError.replace(/\n+$/, "") + "\n\n" + diagnosis;
}
