/**
 * Pure core for the Edit assist no-match Diagnosis.
 *
 * No pi API in here: matching, region search, diffing, and formatting are
 * plain functions over text, so the core is unit-testable against fixtures
 * extracted from real pi sessions. See ADR 0020.
 */

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

/** Files with more bytes than this skip the Diagnosis and run stock. */
export const MAX_FILE_BYTES = 300 * 1024;
/** Files with more lines than this skip the Diagnosis and run stock. */
export const MAX_FILE_LINES = 20_000;
/** Diff inputs longer than this (lines per side) are head-capped before diffing. */
const DIFF_INPUT_LINE_CAP = 300;
/** Sliding-window work budget for the region search before stride sampling kicks in. */
const REGION_WORK_BUDGET = 4_000_000;

/** Strip a leading UTF-8 BOM, keeping the rest verbatim. */
export function splitBom(raw: string): { bom: string; text: string } {
	if (raw.charCodeAt(0) === 0xfeff) return { bom: "\ufeff", text: raw.slice(1) };
	return { bom: "", text: raw };
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when the file is too large for a Diagnosis; such files run stock. */
export function isOversized(sizeBytes: number, lineCount: number): boolean {
	return sizeBytes > MAX_FILE_BYTES || lineCount > MAX_FILE_LINES;
}

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

/**
 * The same normalization the built-in edit's fuzzy step applies: NFKC,
 * per-line trailing whitespace stripped, smart quotes and dashes mapped to
 * ASCII, special spaces mapped to the space character.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

// The leading-whitespace strips in this file use [ \t] on purpose, not all
// Unicode whitespace: the built-in's fuzzy step trims trailing whitespace
// the same narrow way, and the Whitespace-only note must mean the same
// thing, so a future edit must not widen the class.
function stripLeadingWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^[ \t]+/, ""))
		.join("\n");
}

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
	return { fuzzy, extended: stripLeadingWhitespace(fuzzy) };
}

function matchKindNormalized(fileText: string, file: NormalizedFile, oldText: string): MatchKind {
	if (oldText.length === 0) return "none";
	if (fileText.includes(oldText)) return "exact";
	const fuzzyOld = normalizeForFuzzyMatch(oldText);
	if (fuzzyOld.length > 0 && file.fuzzy.includes(fuzzyOld)) return "fuzzy";
	const extendedOld = stripLeadingWhitespace(fuzzyOld);
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
	return normalizeForFuzzyMatch(line).replace(/^[ \t]+/, "");
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

/**
 * Whitespace-only diff: the same line count, with every line differing only
 * in leading whitespace. The only difference class the Input correction
 * (a later slice) is allowed to fix.
 */
export function isWhitespaceOnlyDiff(oldText: string, fileText: string): boolean {
	const a = oldText.split("\n");
	const b = fileText.split("\n");
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].replace(/^[ \t]+/, "") !== b[i].replace(/^[ \t]+/, "")) return false;
	}
	return true;
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

function diagnoseOneEdit(path: string, oldText: string, fileText: string, label: string, limits: DiagnosisLimits): string {
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
