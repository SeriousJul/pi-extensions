/**
 * Edit assist: corrects and diagnoses failing edit calls around the
 * built-in edit tool (ADR 0020).
 *
 * This slice: the no-match Diagnosis. When an edit call fails because an
 * oldText is not found in the file, a tool_result hook scoped to the edit
 * tool appends a size-bounded Diagnosis to the stock error: for each
 * unmatched edit, the line range of the Nearest region and a unified diff
 * between the model's oldText and what the file actually holds, with a
 * Whitespace-only difference stated explicitly. Files over 300 KB or
 * 20,000 lines run stock.
 *
 * This file is thin pi wiring around the pure core (`core.ts`) and the
 * settings reader (`settings.ts`).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	diagnoseNoMatch,
	isOversized,
	normalizeToLF,
	splitBom,
	type EditSpec,
} from "./core.ts";
import { readEditAssistSettings } from "./settings.ts";

/** The stock error text the built-in edit emits for a no-match failure. */
const NO_MATCH_ERROR = /Could not find /;

function editsFromInput(input: Record<string, unknown>): EditSpec[] | null {
	let edits = input.edits;
	if (typeof edits === "string") {
		try {
			const parsed: unknown = JSON.parse(edits);
			edits = Array.isArray(parsed) ? parsed : null;
		} catch {
			edits = null;
		}
	}
	if (!Array.isArray(edits)) return null;
	const specs: EditSpec[] = [];
	for (const edit of edits) {
		if (typeof edit !== "object" || edit === null) return null;
		const { oldText, newText } = edit as Record<string, unknown>;
		if (typeof oldText !== "string" || typeof newText !== "string") return null;
		specs.push({ oldText, newText });
	}
	return specs.length > 0 ? specs : null;
}

/** Run the Diagnosis for one failed edit result. Returns the content to
 * patch into the result, or undefined to leave the stock error alone. */
export async function diagnoseEditResult(
	event: Pick<ToolResultEvent, "input" | "content" | "isError">,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ content: ToolResultEvent["content"] } | undefined> {
	if (!event.isError) return undefined;
	const text = event.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (!NO_MATCH_ERROR.test(text)) return undefined;
	// The off switch: disabled means the stock error stands alone.
	if (!readEditAssistSettings(cwd, env).settings.enabled) return undefined;
	const input = event.input;
	const displayPath = typeof input.path === "string" ? input.path : null;
	const edits = editsFromInput(input);
	if (!displayPath || !edits) return undefined;

	const absolutePath = path.isAbsolute(displayPath) ? displayPath : path.join(cwd, displayPath);
	let buffer: Buffer;
	try {
		buffer = await fs.readFile(absolutePath);
	} catch {
		return undefined;
	}
	if (isOversized(buffer.byteLength, buffer.toString("utf8").split("\n").length)) return undefined;
	const { text: raw } = splitBom(buffer.toString("utf8"));
	const diagnosis = diagnoseNoMatch({ path: displayPath, fileText: normalizeToLF(raw), edits });
	if (!diagnosis) return undefined;
	return { content: [...event.content, { type: "text", text: diagnosis }] };
}

export default function editAssistExtension(pi: ExtensionAPI): void {
	// After execution: append the Diagnosis to every edit call that still
	// fails with a no-match error. The built-in error text stays verbatim;
	// the Diagnosis is a new text block after it.
	pi.on("tool_result", async (event, _ctx: ExtensionContext) => {
		if (event.toolName !== "edit") return undefined;
		return diagnoseEditResult(event, _ctx.cwd);
	});
}
