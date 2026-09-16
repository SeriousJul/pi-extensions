/**
 * Recall module: one agent tool that resolves a recall reference back to
 * the full text of one pruned tool output.
 *
 * The resolver is pure: it takes a reference string and a source of
 * session entries, and returns text or an error. The reference is either
 * `#<line>` (a physical line of the session JSONL file, line 1 being the
 * header) or an entry id - the marker carries whichever form the session
 * supports, and the tool accepts both regardless. The default answer is
 * capped (12000 characters plus a hint pointing at the full form); the
 * `:full` suffix lifts the cap.
 *
 * Only tool result entries resolve: a tool result message and a bash
 * execution message. Any other entry type is an error.
 */
import { Type } from "typebox";
import { defineTool, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The default recall answer cap, in characters. */
export const DEFAULT_RECALL_CAP = 12000;

/** The entry lookups the resolver needs. */
export interface RecallSource {
	/** The entry on one physical line of the session file, if any. */
	getEntryByLine(line: number): SessionEntry | undefined;
	/** The entry with one id, if any. */
	getEntryById(id: string): SessionEntry | undefined;
}

export type ParsedRef =
	| { kind: "line"; line: number; full: boolean }
	| { kind: "id"; id: string; full: boolean }
	| { kind: "invalid"; error: string };

/** Parse a recall reference: `#<line>`, `#<line>:full`, `<id>`, or `<id>:full`. */
export function parseRecallRef(ref: string): ParsedRef {
	const trimmed = ref.trim();
	if (trimmed === "") return { kind: "invalid", error: "empty reference" };
	const full = trimmed.endsWith(":full");
	const body = full ? trimmed.slice(0, -":full".length) : trimmed;
	if (full && body === "") return { kind: "invalid", error: "missing reference before :full" };
	if (body.startsWith("#")) {
		const line = Number(body.slice(1));
		if (!Number.isInteger(line) || line < 2) {
			return { kind: "invalid", error: `invalid line reference: ${ref} (use #<line> where line is a physical line of the session file, or an entry id)` };
		}
		return { kind: "line", line, full };
	}
	if (body.length === 0 || !/^[\w-]+$/.test(body)) {
		return { kind: "invalid", error: `invalid reference: ${ref} (use #<line> or an entry id)` };
	}
	return { kind: "id", id: body, full };
}

/** The full text of one pruned tool output, or undefined when the entry is
 * not a tool result (tool result message or bash execution message). */
export function recallText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "toolResult") {
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const images = message.content.filter((part) => part.type === "image").length;
		return images > 0 ? `${text}\n\n[${images} image part(s) not included in this recall]` : text;
	}
	if (message.role === "bashExecution") return message.output;
	return undefined;
}

export type RecallOutcome = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };

/** Resolve one recall reference to the full (or capped) output text. */
export function resolveRecall(ref: string, source: RecallSource, cap: number = DEFAULT_RECALL_CAP): RecallOutcome {
	const parsed = parseRecallRef(ref);
	if (parsed.kind === "invalid") return { ok: false, error: `recall: ${parsed.error}` };
	const entry = parsed.kind === "line" ? source.getEntryByLine(parsed.line) : source.getEntryById(parsed.id);
	if (entry === undefined) {
		const what = parsed.kind === "line" ? `line ${parsed.line}` : `entry ${parsed.id}`;
		return { ok: false, error: `recall: no ${what} in this session` };
	}
	const text = recallText(entry);
	if (text === undefined) {
		return { ok: false, error: `recall: ${parsed.kind === "line" ? `line ${parsed.line}` : `entry ${parsed.id}`} is not a tool result` };
	}
	if (!parsed.full && text.length > cap) {
		const fullForm = parsed.kind === "line" ? `#${parsed.line}:full` : `${parsed.id}:full`;
		return { ok: true, text: `${text.slice(0, cap)}\n\n... [truncated at ${cap} characters. Use "${fullForm}" for the full output.]`, truncated: true };
	}
	return { ok: true, text, truncated: false };
}

/** The registered recall tool. Resolves against the caller's session, so
 * references work across branches: line numbers are permanent and entry
 * ids are branch-independent. */
export function createRecallTool() {
	return defineTool({
		name: "recall",
		label: "recall",
		description:
			"Retrieve the full output of one pruned tool result by its recall reference. References appear in pruned output markers, e.g. 'recall #412 for this exact output'. Accepts '#<line>' (a line of the session file) or an entry id; append ':full' for the uncapped output (the default answer is capped).",
		promptSnippet: "recall: retrieve the exact full output of a pruned tool result by reference (#<line> or entry id).",
		parameters: Type.Object({
			ref: Type.String({ description: "The recall reference: '#<line>' (default, capped) or '#<line>:full' (uncapped), or an entry id with the same optional ':full' suffix." }),
		}),
		// The call context carries the session the tool serves, so references
		// resolve across branches: line numbers are permanent, entry ids are
		// branch-independent.
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const sm = ctx.sessionManager;
			const source: RecallSource = {
				getEntryByLine: (line) => {
					// getEntries() is the file order, and line 1 is the header.
					const entries = sm.getEntries();
					return line >= 2 ? entries[line - 2] : undefined;
				},
				getEntryById: (id) => sm.getEntry(id),
			};
			const outcome = resolveRecall(params.ref, source);
			if (!outcome.ok) return { content: [{ type: "text" as const, text: outcome.error }], details: undefined };
			return { content: [{ type: "text" as const, text: outcome.text }], details: { truncated: outcome.truncated } };
		},
	});
}
