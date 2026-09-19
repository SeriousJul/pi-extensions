/**
 * Edit assist extension wiring: diagnoses failing built-in edit calls
 * (ADR 0020). This slice (ticket #84) covers the two classes that the
 * Diagnosis does not anchor in a diff:
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
	isAmbiguousEditError,
	isEditValidationError,
	malformedEditHint,
} from "./core.ts";

/** The ADR 0020 file guards: beyond these the Diagnosis is skipped. */
const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILE_LINES = 20_000;

/**
 * The file's line count the way the ADR guard means it: a trailing newline
 * ends the last line, it does not start a new one.
 */
function countLines(text: string): number {
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
async function readTargetFile(cwd: string, input: unknown): Promise<string | null> {
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
