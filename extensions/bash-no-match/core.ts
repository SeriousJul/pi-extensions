/**
 * Bash no-match rewrite core (ticket #113): the pure classifier over the
 * (exit code, result text, command string) triple of one bash tool result.
 *
 * pi's bash tool merges stdout and stderr into one stream and emits the
 * exact text `(no output)\n\nCommand exited with code N` when that stream
 * was empty and the command exited N. For a search command, exit 1 with an
 * empty stream is the normal "no lines matched" outcome, not a failure -
 * and the isError flag costs a small local model a recovery turn. The
 * classifier rewrites exactly that one case and nothing wider:
 *
 *   - the result text is the no-output marker with the exit code line,
 *     which alone proves both streams were empty, so any preceding segment
 *     that printed output disqualifies the command by itself;
 *   - the exit code line says 1 (exit 2 and every other code stay errors);
 *   - the first word of the last `&&` segment of the command is a search
 *     command (a single command is a one-segment chain).
 *
 * `;` lists, pipelines whose first word of the last segment is not a
 * search, subshells, and `ls` (the observed `ls` failures carried error
 * messages and were real errors) never match the rule. The module is pure:
 * no pi API, no filesystem. The wiring (index.ts) extracts the exit code
 * from the result text and calls this.
 */

/** The commands whose exit 1 with an empty stream means "no matches". */
export const SEARCH_COMMANDS = ["rg", "grep", "egrep", "fgrep"];

/**
 * The exact result text pi's bash tool emits when both streams were empty
 * and the command exited non-zero: the no-output marker plus the exit code
 * line. The no-match case is this text with code 1, byte for byte.
 */
export function noOutputText(exitCode: number): string {
	return `(no output)\n\nCommand exited with code ${exitCode}`;
}

/**
 * The note appended to the rewritten result. It marks the empty stream as
 * a search no-match instead of an error, in the model's words: (no
 * matches). The rewritten result - marker, exit line, and note - stays
 * under 100 bytes, so the output-limits bound (see the module header in
 * index.ts for the ordering) never cuts it.
 */
export const NO_MATCH_NOTE = "(no matches): the search found nothing; not an error.";

/** A rewrite of one tool result: the new content and the new error flag. */
export interface NoMatchRewrite {
	content: { type: "text"; text: string }[];
	isError: false;
}

/**
 * The first word of the last `&&` segment of the command, "" when the
 * command is empty. A single command is a one-segment chain. `;` lists and
 * subshells are not split: `cmd; rg` has one segment whose first word is
 * `cmd;`, and `(rg x)` has first word `(rg`, so neither is a search.
 */
export function lastSegmentFirstWord(command: string): string {
	const last = command.split("&&").pop() ?? command;
	for (const word of last.trim().split(/\s+/)) {
		if (word.length > 0) return word;
	}
	return "";
}

/**
 * The classifier. Returns the rewrite - the marker with the note appended,
 * as a non-error - or null to leave the result untouched.
 */
export function classifyBashNoMatch(exitCode: number | null, resultText: string, command: string): NoMatchRewrite | null {
	const marker = /^Command exited with code (\d+)$/.exec(resultText.replace(/\s+$/, "").split("\n").pop() ?? "");
	if (marker === null || marker[1] !== "1") return null;
	if (resultText.trim() !== noOutputText(1)) return null;
	if (exitCode !== 1) return null;
	if (!SEARCH_COMMANDS.includes(lastSegmentFirstWord(command))) return null;
	return { content: [{ type: "text", text: `${noOutputText(1)}\n\n${NO_MATCH_NOTE}` }], isError: false };
}
