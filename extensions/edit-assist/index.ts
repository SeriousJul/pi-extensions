/**
 * Edit assist extension wiring (ADR 0020).
 *
 * Before execution (ticket #83): the tool_call hook reads the target file
 * and, for each edit whose oldText does not exact-match, runs the Extended
 * match (fuzzy normalization plus leading-whitespace-insensitive
 * comparison). When the match is unique and the raw difference is a
 * Whitespace-only diff, the hook replaces that edit's oldText with the
 * file's actual text in event.input, which pi documents as mutable in
 * place. The built-in tool then executes the corrected input, and the
 * tool_result hook adds one honesty line per corrected edit to the
 * successful result, naming the line. The extension never writes a file
 * itself; every write goes through the built-in tool.
 *
 * After execution (ticket #84): the Diagnosis for the two classes that
 * never reached the file's matching step cleanly - ambiguous (the oldText
 * matched the file in several places) and malformed-argument (the call
 * failed argument validation and never executed at all):
 *
 * - Ambiguous: the oldText matched the file in several places. The stock
 *   error is kept and the occurrence line numbers are appended, max 10,
 *   each with one context line. Reached through the `tool_result` hook:
 *   the call executed, so the hook sees the error.
 *
 * - Malformed arguments: the call failed argument validation and never
 *   executed. pi skips the `tool_result` hook for these (the tool never
 *   prepared), so this class is reached through the `message_end` hook on
 *   the toolResult message instead. One targeted hint line: a
 *   read-tool-shaped call (path with offset and limit, no edits) is told
 *   to use the read tool, and an edits value sent as a string gets a
 *   shape hint. Any other malformed shape is left unchanged.
 *
 * The no-match class (Nearest region diff) is ticket #81's slice and
 * passes through unchanged here. Every Diagnosis is appended to, never
 * replaces, the stock error text, and the result stays marked as an
 * error. Decision logic lives in the tested pure core (core.ts).
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	ambiguousDiagnosis,
	appendDiagnosis,
	correctionForEdit,
	honestyNotes,
	isAmbiguousEditError,
	isEditValidationError,
	malformedEditHint,
	type Correction,
} from "./core.ts";

/** The ADR 0020 file guards: beyond these the Diagnosis is skipped. */
const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILE_LINES = 20_000;

/**
 * The file's line count the way the ADR guard means it: a trailing newline
 * ends the last line, it does not start a new one.
 */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	const newlines = (text.match(/\n/g) ?? []).length;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

/** The first text block of a tool result, or null. */
function firstText(content: { type: string; text?: string }[] | undefined): string | null {
	for (const block of content ?? []) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return null;
}

/**
 * Read the file an edit call targeted, or null when it cannot be read.
 * The path resolves against the session cwd exactly like the built-in
 * tool. The ADR guards apply: an oversized file gets the stock error.
 */
export async function readTargetFile(cwd: string, input: unknown): Promise<string | null> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
	const path = (input as Record<string, unknown>).path;
	if (typeof path !== "string" || path.length === 0) return null;
	const resolved = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		const info = await stat(resolved);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
		const text = await readFile(resolved, "utf8");
		if (countLines(text) > MAX_FILE_LINES) return null;
		return text;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI): void {
	// The corrections of the in-flight calls, by tool call id. The tool_call
	// hook records them, the tool_result hook consumes them once, so a call
	// that never produces a result leaves no state behind past its id.
	const correctedCalls = new Map<string, Correction[]>();

	// Input correction: before the built-in edit runs, replace the oldText of
	// every correctable edit with the file's actual text. The mutation is in
	// place on event.input; the built-in tool executes the corrected input
	// under its own file-mutation queue. An uncorrectable edit is left
	// alone, so pi's own exact and fuzzy paths still run on it.
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (event.toolName !== "edit") return;
		const fileText = await readTargetFile(ctx.cwd, event.input);
		if (fileText === null) return;
		const edits = (event.input as { edits?: unknown }).edits;
		if (!Array.isArray(edits)) return;
		const corrections: Correction[] = [];
		for (let i = 0; i < edits.length; i += 1) {
			const edit = edits[i];
			if (edit === null || typeof edit !== "object") continue;
			const oldText = (edit as { oldText?: unknown }).oldText;
			if (typeof oldText !== "string") continue;
			const correction = correctionForEdit(fileText, oldText);
			if (correction === null) continue;
			(edit as { oldText: string }).oldText = correction.oldText;
			corrections.push({ editIndex: i, line: correction.line });
		}
		if (corrections.length > 0) correctedCalls.set(event.toolCallId, corrections);
	});

	// Honesty note: a corrected call succeeds through the built-in tool, and
	// the transcript shows the model's original arguments. The note in the
	// success text is the bridge: it names the line and says the edit ran
	// with the whitespace-normalized old text. A corrected call that still
	// fails (the file moved between the read and the write) gets no note.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "edit") return;
		const corrections = correctedCalls.get(event.toolCallId);
		if (corrections === undefined) return;
		correctedCalls.delete(event.toolCallId);
		if (event.isError) return;
		const totalEdits = (event.input as { edits?: unknown[] }).edits;
		const notes = honestyNotes(corrections, Array.isArray(totalEdits) ? totalEdits.length : corrections.length);
		const content = [...event.content];
		for (let i = 0; i < content.length; i += 1) {
			const block = content[i];
			if (block.type === "text" && typeof block.text === "string") {
				content[i] = { ...block, text: appendDiagnosis(block.text, notes.join("\n")) };
				break;
			}
		}
		return { content };
	});

	// Ambiguous failures: the call executed, so the tool_result hook sees
	// the stock error. Append the occurrence line numbers.
	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		if (event.toolName !== "edit" || !event.isError) return;
		const text = firstText(event.content);
		if (text === null || !isAmbiguousEditError(text)) return;
		const fileText = await readTargetFile(ctx.cwd, event.input);
		if (fileText === null) return;
		const diagnosis = ambiguousDiagnosis(text, event.input, fileText);
		if (diagnosis === null) return;
		return {
			content: [{ type: "text", text: appendDiagnosis(text, diagnosis) }],
			isError: true,
		};
	});

	// Malformed-argument failures: validation rejects the call before it
	// prepares, so pi never fires the tool_result hook for it. The
	// toolResult message event is the one seam that still carries it.
	// Append the targeted hint where one applies; leave everything else.
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "toolResult" || message.toolName !== "edit" || !message.isError) return;
		const text = firstText(message.content);
		if (text === null || !isEditValidationError(text)) return;
		const hint = malformedEditHint(text);
		if (hint === null) return;
		const content = [...message.content];
		for (let i = 0; i < content.length; i += 1) {
			const block = content[i];
			if (block.type === "text" && block.text === text) {
				content[i] = { type: "text", text: appendDiagnosis(text, hint) };
				break;
			}
		}
		return { message: { ...message, content } };
	});
}
