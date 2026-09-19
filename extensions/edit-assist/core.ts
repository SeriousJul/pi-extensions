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
 * checks it against the count in the stock error: pi counts non-overlapping
 * matches in fuzzy-normalized content when any edit in the call fuzzy-matches
 * and in raw LF-normalized content otherwise. This module derives the lines
 * in fuzzy mode first, re-derives them in raw mode when the fuzzy count
 * differs from the stock count, and gives up (stock error only) when neither
 * derivation reproduces it. That keeps the line numbers naming exactly the
 * occurrences the stock error counts.
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
 * (mirroring pi's countOccurrences), "raw" matches only the LF-normalized
 * text exactly (the count pi takes when no edit in the call fuzzy-matched).
 */
export type OccurrenceMode = "fuzzy" | "raw";

/**
 * 1-based line numbers where oldText matches fileText in file order.
 * Line-by-line normalization keeps line structure intact, so a match in the
 * joined normalized text maps to an exact line of the file.
 * Non-overlapping, mirroring pi's countOccurrences.
 */
export function occurrenceLineNumbers(fileText: string, oldText: string, mode: OccurrenceMode = "fuzzy"): number[] {
	const normalizeLine = mode === "fuzzy" ? normalizeFuzzyLine : (line: string) => line;
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
		return "Edit assist: edits must be an array of {oldText, newText} objects; a JSON string is not accepted. Send the array itself.";
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
