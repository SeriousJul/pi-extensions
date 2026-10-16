/**
 * Safe compaction core (ADR 0044).
 *
 * Pure decision and checkpoint logic, no pi imports: the wiring (index.ts)
 * keeps the settings read, the auth resolution, and the re-run of pi's own
 * compaction with thinking disabled and the user's retry policy; the core
 * owns the takeover decision and the deterministic checkpoint the wiring
 * writes when no LLM summary can be written.
 *
 * Why the takeover: pi's compaction summarizes with the session's thinking
 * level, but budgets the summary's output as a share of the compaction
 * reserve (0.8x for the history, 0.5x for a split turn's prefix). The budget
 * counts thinking tokens the same way it counts summary text, so a reasoning
 * model at an effort level can spend the whole budget thinking and stop
 * mid-summary. pi then fails the compaction with "generation hit the token
 * cap and the summary is incomplete", and the session keeps growing with
 * every failed retry. Running the same summarization with thinking disabled
 * keeps pi's prompts, budgets, and split-turn handling verbatim while the
 * output goes to summary text only.
 *
 * Why the checkpoint: when even the thinking-free run cannot write a summary
 * (the engine is down, the model cannot finish), the extension still
 * completes the compaction with an extractive checkpoint built from the
 * transcript. The session never strands in an ever-growing context; the
 * checkpoint carries the previous summary verbatim, so nothing already
 * summarized is lost.
 */

/** A transcript message in the shape the checkpoint reads. Structural, so
 * the core never imports pi's message types. */
export interface CheckpointMessage {
	role: string;
	content?: unknown;
	toolName?: string;
}

/** The file-operation sets pi's prepareCompaction already extracted. */
export interface CheckpointFileOps {
	read: ReadonlySet<string>;
	written: ReadonlySet<string>;
	edited: ReadonlySet<string>;
}

/** The file lists of a checkpoint range. Computed once and reused for both
 * the summary text and the compaction result's details, so the two can
 * never diverge. */
export interface CheckpointFileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CheckpointInput {
	/** The summary of the previous compaction, carried over verbatim. */
	previousSummary?: string;
	/** The messages being compacted away (history plus turn prefix, in order). */
	messages: readonly CheckpointMessage[];
	/** The file-operation sets to derive the file lists from. Ignored when
	 * `fileLists` is provided. */
	fileOps?: CheckpointFileOps;
	/** Precomputed file lists, reused for the summary text and the caller's
	 * result details. */
	fileLists?: CheckpointFileLists;
	limits?: CheckpointLimits;
}

export interface CheckpointLimits {
	/** Max characters for the original request block. */
	requestChars?: number;
	/** Total character budget for the progress index (text plus tool lines). */
	progressChars?: number;
	/** Max characters quoted from one text block in the progress index. */
	blockChars?: number;
	/** Max characters quoted from one tool call's arguments. */
	argChars?: number;
}

export const CHECKPOINT_LIMITS: Required<CheckpointLimits> = {
	requestChars: 2000,
	progressChars: 6000,
	blockChars: 240,
	argChars: 140,
};

/** Derive the file lists from pi's file-operation sets: read files that
 * were never modified, and files written or edited, both sorted. */
export function computeFileLists(fileOps: CheckpointFileOps | undefined): CheckpointFileLists {
	if (!fileOps) return { readFiles: [], modifiedFiles: [] };
	const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

/** The takeover decision: the native compaction is unsafe exactly when the
 * model reasons and the session's thinking level is on, because the level
 * rides the summarization request and the summary's output budget does not
 * pay for it. */
export function shouldTakeOverSummarization(input: {
	enabled: boolean;
	modelReasoning: boolean | undefined;
	thinkingLevel: string | undefined;
}): boolean {
	return input.enabled && input.modelReasoning === true && input.thinkingLevel !== undefined && input.thinkingLevel !== "off";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const candidate = block as { type?: unknown; text?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
		}
	}
	return parts.join(" ").trim();
}

function toolCallLines(content: unknown, argChars: number): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
		if (call.type !== "toolCall" || typeof call.name !== "string") continue;
		let args = "";
		try {
			args = JSON.stringify(call.arguments ?? {});
		} catch {
			args = String(call.arguments);
		}
		// Cap the arguments before the line budget is applied, so one call
		// with a huge argument (a write with a big content field) cannot
		// spend the whole line budget on itself.
		args = oneLine(args, argChars);
		lines.push(`- ${call.name}: ${args}`);
	}
	return lines;
}

function oneLine(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, maxChars - 3)}...`;
}

function fileSections(lists: CheckpointFileLists): string {
	const sections: string[] = [];
	if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	if (lists.modifiedFiles.length > 0) sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/** The deterministic checkpoint: what the transcript itself records, without
 * an LLM pass. The previous summary rides through verbatim; the original
 * request and a condensed progress index stand in for the model's narrative. */
export function buildCheckpoint(input: CheckpointInput): string {
	const limits: Required<CheckpointLimits> = { ...CHECKPOINT_LIMITS, ...input.limits };
	const lines: string[] = [
		"**Checkpoint (deterministic)**: the summarizer could not write a summary, so this checkpoint is extracted from the transcript.",
		"",
	];

	lines.push("## Prior Summary");
	lines.push(input.previousSummary?.trim() ? input.previousSummary.trim() : "No prior history.");
	lines.push("");

	// Original request: the first user text in the compacted range.
	let request = "";
	for (const message of input.messages) {
		if (message.role !== "user") continue;
		request = textOf(message.content);
		if (request) break;
	}
	lines.push("## Original Request");
	lines.push(request ? oneLine(request, limits.requestChars) : "(none recorded in the compacted range)");
	lines.push("");

	// Progress index: assistant text and tool activity, in order, capped.
	const progress: string[] = [];
	let used = 0;
	let truncated = false;
	const append = (line: string): void => {
		const cost = line.length + 1;
		if (used + cost > limits.progressChars) {
			truncated = true;
			return;
		}
		used += cost;
		progress.push(line);
	};

	for (const message of input.messages) {
		const text = textOf(message.content);
		if (message.role === "assistant" && text) append(oneLine(text, limits.blockChars));
		for (const line of toolCallLines(message.content, limits.argChars)) append(oneLine(line, limits.blockChars));
		if (truncated) break;
	}
	lines.push("## Progress");
	if (progress.length > 0) lines.push(...progress);
	else lines.push("(none recorded)");
	if (truncated) lines.push(`[... progress index truncated at ${limits.progressChars} characters]`);
	lines.push("");

	const fileLists = input.fileLists ?? computeFileLists(input.fileOps);
	const files = fileSections(fileLists);
	if (files) lines.push(files.trimEnd());

	return lines.join("\n").trimEnd() + "\n";
}
