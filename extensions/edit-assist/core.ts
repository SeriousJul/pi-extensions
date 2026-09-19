/**
 * Edit assist core: the Diagnosis for the two failure classes that never
 * reached the file's matching step cleanly - ambiguous (the oldText matched
 * the file in several places) and malformed-argument (the call failed
 * argument validation and never executed at all).
 *
 * It also holds the no-match class (ticket #81): for each edit the
 * built-in could not find with its exact or fuzzy step, the Nearest
 * region's line range and a unified diff against the file's real text.
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

/**
 * The same normalization applied to a whole text, line by line. NFKC and
 * the character mappings never cross a line boundary, so per-line
 * application is identical to normalizing the joined text.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text.split("\n").map(normalizeFuzzyLine).join("\n");
}

/** Strip a leading BOM, mirroring the built-in edit's read path. */
export function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Normalize line endings to LF, mirroring the built-in edit's match path. */
export function normalizeToLF(text: string): string {
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

// The leading-whitespace strips in this file use [ \t] on purpose, not all
// Unicode whitespace: the built-in's fuzzy step trims trailing whitespace
// the same narrow way, and the Whitespace-only note must mean the same
// thing, so a future edit must not widen the class.
function stripLeadingWhitespace(line: string): string {
	return line.replace(/^[ \t]*/, "");
}

/** The same strip over a whole text, line by line. */
function stripLeadingWhitespaceText(text: string): string {
	return text.split("\n").map(stripLeadingWhitespace).join("\n");
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

// ---------------------------------------------------------------------------
// No-match class: the Nearest region Diagnosis (ticket #81)
// ---------------------------------------------------------------------------

/** Files with more bytes than this skip the Diagnosis and run stock. */
export const MAX_FILE_BYTES = 300 * 1024;
/** Files with more lines than this skip the Diagnosis and run stock. */
export const MAX_FILE_LINES = 20_000;
/** Diff inputs longer than this (lines per side) are head-capped before diffing. */
const DIFF_INPUT_LINE_CAP = 300;
/** Sliding-window work budget for the region search before stride sampling kicks in. */
const REGION_WORK_BUDGET = 4_000_000;

/**
 * Split text into lines without counting a trailing newline as a new line:
 * the final "\n" of a normal file ends the last line, so the split does not
 * gain a phantom empty element. The same rule lineCount applies for the
 * large-file guard, so the region search and the guard agree on the line
 * count.
 */
function contentLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * The line count of a decoded file text: empty text is 0 lines, and a
 * trailing newline does not start a new line, so a 20,000-line file with a
 * final newline (the normal case) counts 20,000, not 20,001.
 */
export function lineCount(raw: string): number {
	if (raw === "") return 0;
	return contentLines(raw).length;
}

/** True when the file is too large for a Diagnosis; such files run stock. */
export function isOversized(sizeBytes: number, lineCount: number): boolean {
	return sizeBytes > MAX_FILE_BYTES || lineCount > MAX_FILE_LINES;
}

export interface EditSpec {
	oldText: string;
	newText: string;
}

export interface DiagnosisLimits {
	/** Maximum lines in one edit's unified diff, including headers. */
	maxDiffLines: number;
	/** Maximum characters in one edit's unified diff. */
	maxDiffChars: number;
	/** A window below this line-similarity score is not a candidate region. */
	minRegionScore: number;
}

export const LIMITS: DiagnosisLimits = {
	maxDiffLines: 40,
	maxDiffChars: 1200,
	minRegionScore: 0.5,
};

/** How an oldText matches the file: exact, the built-in fuzzy step, the
 * leading-whitespace-insensitive Extended match, or none at all. */
export type MatchKind = "exact" | "fuzzy" | "extended" | "none";

/** The two derived views of a file the match ladder needs, computed once
 * per call so a multi-edit failure normalizes the file a single time. */
interface NormalizedFile {
	fuzzy: string;
	extended: string;
}

function normalizedFile(fileText: string): NormalizedFile {
	const fuzzy = normalizeForFuzzyMatch(fileText);
	return { fuzzy, extended: stripLeadingWhitespaceText(fuzzy) };
}

function matchKindNormalized(fileText: string, file: NormalizedFile, oldText: string): MatchKind {
	if (oldText.length === 0) return "none";
	if (fileText.includes(oldText)) return "exact";
	const fuzzyOld = normalizeForFuzzyMatch(oldText);
	if (fuzzyOld.length > 0 && file.fuzzy.includes(fuzzyOld)) return "fuzzy";
	const extendedOld = stripLeadingWhitespaceText(fuzzyOld);
	if (extendedOld.length > 0 && file.extended.includes(extendedOld)) return "extended";
	return "none";
}

export function matchKind(fileText: string, oldText: string): MatchKind {
	return matchKindNormalized(fileText, normalizedFile(fileText), oldText);
}

export interface Region {
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	/** Average line similarity between the window and the oldText (0..1). */
	score: number;
}

function lineKey(line: string): string {
	return stripLeadingWhitespace(normalizeForFuzzyMatch(line));
}

/** Multiset of character bigrams with per-bigram counts. */
function bigramCounts(s: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const bg = s.slice(i, i + 2);
		counts.set(bg, (counts.get(bg) ?? 0) + 1);
	}
	return counts;
}

/** Dice coefficient over character bigrams: 0..1, high for near-duplicates. */
function bigramDice(a: string, b: string): number {
	const ca = bigramCounts(a);
	const cb = bigramCounts(b);
	let intersection = 0;
	for (const [bg, count] of ca) {
		const other = cb.get(bg) ?? 0;
		if (other > 0) intersection += Math.min(count, other);
	}
	const total = [...ca.values()].reduce((s, n) => s + n, 0) + [...cb.values()].reduce((s, n) => s + n, 0);
	return total === 0 ? 0 : (2 * intersection) / total;
}

/** Similarity of two lines for the region search: 1 for an exact (key) hit,
 * a bigram fraction for the near-miss lines that no-match failures are made
 * of, 0 otherwise. */
function lineSimilarity(aKey: string, bKey: string): number {
	if (aKey === bKey) return 1;
	if (aKey.length < 2 || bKey.length < 2) return 0;
	return bigramDice(aKey, bKey);
}

/**
 * Find the Nearest region: the file window, the oldText's own line count
 * tall, with the most lines in common with the oldText. Windows below
 * `limits.minRegionScore` are not a candidate and the search returns null.
 * Ties go to the earliest window.
 */
export function nearestRegion(fileText: string, oldText: string, limits: DiagnosisLimits = LIMITS): Region | null {
	if (oldText.replace(/[ \t\n]+/g, "") === "") return null;
	// A trailing newline does not start a new line, for the file and for the
	// oldText: otherwise the split's phantom empty element takes part in the
	// window search and a region at the end of a file can land on lines that
	// do not exist.
	const oldLines = contentLines(oldText);
	const fileLines = contentLines(fileText);
	const n = oldLines.length;
	const m = fileLines.length;
	if (n === 0 || n > m) return null;

	const oldKeys = oldLines.map(lineKey);
	const fileKeys = fileLines.map(lineKey);
	const windowCount = m - n + 1;
	// Bound the work: score every window until the budget runs out, then
	// sample at a stride that keeps the work inside it.
	const stride = Math.max(1, Math.ceil((windowCount * n) / REGION_WORK_BUDGET));

	let bestStart = -1;
	let bestScore = 0;
	for (let i = 0; i < windowCount; i += stride) {
		let sum = 0;
		for (let k = 0; k < n; k++) {
			sum += lineSimilarity(oldKeys[k], fileKeys[i + k]);
		}
		const score = sum / n;
		if (score > bestScore) {
			bestScore = score;
			bestStart = i;
			if (bestScore === 1) break;
		}
	}
	if (bestStart === -1 || bestScore < limits.minRegionScore) return null;
	return { startLine: bestStart + 1, endLine: bestStart + n, score: bestScore };
}

interface DiffOp {
	type: " " | "-" | "+";
	/** 0-based line index in the old side (for " " and "-"). */
	aIndex?: number;
	/** 0-based line index in the new side (for " " and "+"). */
	bIndex?: number;
	line: string;
}

/** LCS-based line diff of two texts, both head-capped to DIFF_INPUT_LINE_CAP.
 * Returns the ops plus a note when a side was capped. */
function diffLines(aText: string, bText: string): { ops: DiffOp[]; note: string | null } {
	let a = aText.split("\n");
	let b = bText.split("\n");
	let note: string | null = null;
	if (a.length > DIFF_INPUT_LINE_CAP || b.length > DIFF_INPUT_LINE_CAP) {
		a = a.slice(0, DIFF_INPUT_LINE_CAP);
		b = b.slice(0, DIFF_INPUT_LINE_CAP);
		note = `diff input capped to the first ${DIFF_INPUT_LINE_CAP} lines per side`;
	}
	const n = a.length;
	const m = b.length;
	const table = new Uint16Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
		}
	}
	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: " ", aIndex: i, bIndex: j, line: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
			ops.push({ type: "-", aIndex: i, line: a[i] });
			i++;
		} else {
			ops.push({ type: "+", bIndex: j, line: b[j] });
			j++;
		}
	}
	while (i < n) {
		ops.push({ type: "-", aIndex: i, line: a[i] });
		i++;
	}
	while (j < m) {
		ops.push({ type: "+", bIndex: j, line: b[j] });
		j++;
	}
	return { ops, note };
}

/** Render the ops as unified-diff hunk lines with the given context. */
function renderHunks(ops: DiffOp[], context: number): string[] {
	const keep = ops.map((op) => op.type !== " ");
	const ranges: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < ops.length; i++) {
		if (!keep[i]) continue;
		const start = Math.max(ranges.length > 0 ? ranges[ranges.length - 1].start : 0, i - context);
		const end = Math.min(ops.length - 1, i + context);
		const last = ranges[ranges.length - 1];
		if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
		else ranges.push({ start, end });
	}
	const out: string[] = [];
	for (const range of ranges) {
		let aStart = ops[range.start].aIndex ?? 0;
		let aCount = 0;
		let bStart = ops[range.start].bIndex ?? 0;
		let bCount = 0;
		for (let k = range.start; k <= range.end; k++) {
			const op = ops[k];
			if (op.type === " " || op.type === "-") aCount++;
			if (op.type === " " || op.type === "+") bCount++;
		}
		out.push(`@@ -${aStart + 1}${aCount === 1 ? "" : `,${aCount}`} +${bStart + 1}${bCount === 1 ? "" : `,${bCount}`} @@`);
		for (let k = range.start; k <= range.end; k++) {
			const op = ops[k];
			out.push(op.type === " " ? ` ${op.line}` : `${op.type}${op.line}`);
		}
	}
	if (out.length === 0) out.push(" (no differences)");
	return out;
}

/**
 * A unified diff between two texts: the standard two-line header, then hunks
 * of changed lines with `context` lines around each change. The result is
 * size-bounded by `limits`; truncation is marked in the text.
 */
export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string, limits: DiagnosisLimits = LIMITS): string {
	const { ops, note } = diffLines(aText, bText);
	const lines: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`, ...renderHunks(ops, 3)];
	if (note) lines.push(`... (${note})`);
	const lineMarker = (hidden: number) => `... (diff truncated: ${hidden} more lines)`;
	if (lines.length > limits.maxDiffLines) {
		// The marker takes the last slot, so the cap stays a hard bound.
		const keep = limits.maxDiffLines - 1;
		const hidden = lines.length - keep;
		lines.length = keep;
		lines.push(lineMarker(hidden));
	}
	const charMarker = "\n... (diff truncated)";
	let text = lines.join("\n");
	if (text.length > limits.maxDiffChars) {
		text = text.slice(0, limits.maxDiffChars - charMarker.length).replace(/\n[^\n]*$/, "") + charMarker;
	}
	return text;
}

export interface NoMatchDiagnosisInput {
	/** The path as the model passed it, for display. */
	path: string;
	/** The file's current content, LF-normalized and BOM-stripped. */
	fileText: string;
	/** Every edit in the failed call. */
	edits: EditSpec[];
}

/**
 * Build the Diagnosis for a no-match edit failure: one block per edit the
 * built-in could not find (its exact or fuzzy step) - including edits that
 * reach only the Extended match, which the built-in does not apply. Each
 * block names the Nearest
 * region's line range, states a Whitespace-only diff explicitly when that is
 * what the difference is, and carries the unified diff between the model's
 * oldText and the file's real text. Returns null when every edit still
 * matches, so the stock error stands alone.
 */
export function diagnoseNoMatch(input: NoMatchDiagnosisInput, limits: DiagnosisLimits = LIMITS): string | null {
	const file = normalizedFile(input.fileText);
	const blocks: string[] = [];
	for (let i = 0; i < input.edits.length; i++) {
		const oldText = normalizeToLF(input.edits[i].oldText);
		if (oldText.length === 0) continue;
		// Unmatched by the built-in: the built-in finds an edit only by its
		// exact or fuzzy step. An edit that reaches only the Extended match
		//(leading-whitespace drift) still fails and gets a Diagnosis.
		const kind = matchKindNormalized(input.fileText, file, oldText);
		if (kind === "exact" || kind === "fuzzy") continue;
		blocks.push(diagnoseOneEdit(input.path, oldText, input.fileText, `edits[${i}]`, limits));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function diagnoseOneEdit(path: string, rawOldText: string, fileText: string, label: string, limits: DiagnosisLimits): string {
	// The oldText's trailing newline does not start a new line, the same rule
	// the file side gets from contentLines: otherwise the phantom empty element
	// suppresses the whitespace-only note and adds a phantom line to the diff.
	const oldText = contentLines(rawOldText).join("\n");
	const head = `Diagnosis for ${label} in ${path}:`;
	const region = nearestRegion(fileText, oldText, limits);
	if (!region) {
		return `${head}\nNo candidate region: no part of the file resembles this oldText.`;
	}
	const regionText = contentLines(fileText)
		.slice(region.startLine - 1, region.endLine)
		.join("\n");
	const lines: string[] = [head, `Nearest region: lines ${region.startLine}-${region.endLine}`];
	if (isWhitespaceOnlyDiff(oldText, regionText)) {
		lines.push("The difference is a whitespace-only difference: same line count, leading whitespace only.");
	}
	lines.push(unifiedDiff(oldText, regionText, `${label}.oldText`, `file (lines ${region.startLine}-${region.endLine})`, limits));
	return lines.join("\n");
}
