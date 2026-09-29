/**
 * Bash no-match rewrite (ticket #113).
 *
 * A `tool_result` hook scoped to the bash tool. When the result is the
 * no-output marker with exit code 1 and the last `&&` segment of the
 * command is a search (rg, grep, egrep, fgrep), the hook returns the
 * result as a non-error with a "(no matches)" note, so a no-match search
 * costs the model no recovery turn. Everything else - exit codes other
 * than 1, any printed output, `;` lists, subshells, `ls` - stays exactly
 * as pi's bash tool produced it. The decision logic lives in the tested
 * pure classifier (core.ts); the hook only extracts the exit code from
 * the result text and the command from the call input.
 *
 * Ordering with the output-limits extension: this extension is a separate
 * module, not output-limits, and the two hooks do not interact in either
 * order. The rewritten result is under 100 bytes, so the output-limits
 * bound (which cuts only oversized results) never touches it, and this
 * hook fires only on the 39-byte no-output marker, a result output-limits
 * passes through untouched. No extension writes files, re-issues tool
 * calls, or alters commands in flight.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { classifyBashNoMatch, type NoMatchRewrite } from "./core.ts";

/** The exit code line of a bash result, or null when the text carries none. */
export function exitCodeFromText(text: string): number | null {
	const match = /(^|\n)Command exited with code (\d+)/.exec(text);
	return match !== null ? Number(match[2]) : null;
}

export default function bashNoMatchExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event): NoMatchRewrite | undefined => {
		if (event.toolName !== "bash" || !event.isError) return undefined;
		let text: string | null = null;
		for (const block of event.content) {
			if (block.type === "text" && typeof block.text === "string") {
				text = block.text;
				break;
			}
		}
		if (text === null) return undefined;
		const command = (event.input as { command?: unknown }).command;
		const rewrite = classifyBashNoMatch(exitCodeFromText(text), text, typeof command === "string" ? command : "");
		return rewrite === null ? undefined : rewrite;
	});
}
