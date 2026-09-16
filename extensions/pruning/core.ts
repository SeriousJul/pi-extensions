/**
 * Prune core (pure): the first level of the two-level context control.
 *
 * Given the request message list and the session branch entries that
 * project it, `prune` returns the outgoing message list plus a pruning
 * record. It engages only while the context estimate exceeds
 * `contextWindow - reserveTokens` (pi's own compaction threshold, so the
 * context window cap composes automatically). Eligible outputs - tool
 * results and bash executions above `minResultTokens`, never the current
 * turn, never image parts - are replaced in the outgoing list by a short
 * marker carrying a recall reference to the full output. The session file
 * is never touched; the projection is re-derived on every request
 * (ADR 0011).
 *
 * The core is a pure function of its input: no session state, no I/O, no
 * clock. The message projection, the token estimates, and the reference
 * resolver are injected, so the seam is testable in milliseconds without a
 * pi runtime.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

/** The three pruning settings the core reads. */
export interface PruneSettings {
	enabled: boolean;
	minResultTokens: number;
	protectCurrentTurn: boolean;
}

/** One pruned output and the numbers the state line reports. */
export interface PruneRecord {
	/** The recall reference the marker carries ("#412" or an entry id). */
	reference: string;
	/** The tool that produced the output ("read", "bash", or the tool name). */
	toolName: string;
	/** Estimated tokens of the original output. */
	originalTokens: number;
	/** Estimated tokens of the replacement marker. */
	markerTokens: number;
	/** Tokens saved by this replacement (never negative). */
	savingsTokens: number;
}

/** The result of one prune pass over one request. */
export interface PruneResult {
	/** True when the threshold was exceeded and pruning applied. */
	engaged: boolean;
	/** The outgoing message list (input list when nothing was pruned). */
	messages: AgentMessage[];
	/** One record per replaced output. */
	records: PruneRecord[];
	/** Number of outputs replaced. */
	prunedCount: number;
	/** Sum of per-output savings, in estimated tokens. */
	savingsTokens: number;
}

export interface PruneInput {
	/** The request message list, exactly as pi would send it. */
	messages: AgentMessage[];
	/** The session branch entries that project the messages. */
	entries: SessionEntry[];
	/** The model's effective context window (cap included). */
	contextWindow: number;
	/** pi's compaction.reserveTokens. */
	reserveTokens: number;
	settings: PruneSettings;
	/** Resolve the recall reference carried by a marker for one entry. */
	referenceFor: (entry: SessionEntry) => string;
	/** Project one session entry to its context messages (default: pi's). */
	projectEntry?: (entry: SessionEntry) => AgentMessage[];
	/** Estimate one message's tokens (default: pi's chars/4 heuristic). */
	estimate?: (message: AgentMessage) => number;
	/** Estimate a message list's total tokens. Default: the sum of the
	 * per-message estimates (the character-based fallback). The wiring
	 * injects the usage-backed estimate, which agrees with pi's own
	 * accounting. */
	estimateList?: (messages: AgentMessage[]) => number;
}

/** Format an estimated token size for a marker: "~5.2k" or "~900". */
export function formatSize(tokens: number): string {
	if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
	return `~${Math.max(0, Math.round(tokens))}`;
}

/** The recall clause every marker ends with. */
export function recallClause(reference: string, word: "this exact output" | "full output"): string {
	return `recall ${reference} for ${word}.`;
}

interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

/** Map every assistant tool call in the list to its id, for the marker's
 * file pointer and shell summary. */
function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") {
				calls.set(block.id, { name: block.name, arguments: (block.arguments ?? {}) as Record<string, unknown> });
			}
		}
	}
	return calls;
}

function isFailedAssistantMessage(message: AgentMessage): boolean {
	return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "length");
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Align the entries' projection with the request's outgoing messages.
 * Returns the projecting entry per outgoing message, or null when the two
 * diverge (a pruned request, a removed non-failed message): the caller
 * must then stay out of the way, because no recall reference can be built.
 * A failed assistant message (error, truncated) may be absent, as pi
 * removes it from state on retry and overflow recovery. */
export function alignMessages(
	entries: SessionEntry[],
	messages: AgentMessage[],
	projectEntry: (entry: SessionEntry) => AgentMessage[],
): (SessionEntry | null)[] | null {
	const out: (SessionEntry | null)[] = new Array(messages.length).fill(null);
	let j = 0;
	for (const entry of entries) {
		for (const message of projectEntry(entry)) {
			if (j < messages.length && sameMessage(message, messages[j])) {
				out[j] = entry;
				j += 1;
			} else if (!isFailedAssistantMessage(message)) {
				return null;
			}
		}
	}
	return j === messages.length ? out : null;
}

/** The bash facts a shell summary marker carries, from either carrier:
 * the `bash` tool result (command from the paired tool call) or the
 * `!bash` execution message. */
function bashFacts(
	message: Extract<AgentMessage, { role: "toolResult" } | { role: "bashExecution" }>,
	call: ToolCallInfo | undefined,
): { command: string; exit: string; output: string } {
	if (message.role === "bashExecution") {
		let exit: string;
		if (message.cancelled) exit = "exit cancelled";
		else if (message.exitCode === undefined || message.exitCode === null) exit = "exit unknown";
		else exit = `exit ${message.exitCode}`;
		return { command: message.command, exit, output: message.output };
	}
	const output = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	let exit = message.isError ? "exit error" : "exit 0";
	const m = /Command exited with code (\d+)/.exec(output);
	if (m) exit = `exit ${m[1]}`;
	const command = typeof call?.arguments.command === "string" ? (call.arguments.command as string) : "";
	return { command, exit, output };
}

/** A summary line longer than this is cut, so one long line can never
 * make the marker as large as the output it stands in for. */
export const MAX_SUMMARY_LINE_CHARS = 200;

/** The head/tail split a shell summary marker carries. Summary lines are
 * capped at MAX_SUMMARY_LINE_CHARS. */
export function headTail(output: string, headLines = 10, tailLines = 10): { head: string; tail: string; totalLines: number; omittedLines: number } {
	const lines = output === "" ? [] : output.split("\n");
	const total = lines.length;
	const cut = (line: string) => (line.length > MAX_SUMMARY_LINE_CHARS ? `${line.slice(0, MAX_SUMMARY_LINE_CHARS)}...` : line);
	if (total <= headLines + tailLines) {
		return { head: lines.map(cut).join("\n"), tail: "", totalLines: total, omittedLines: 0 };
	}
	return {
		head: lines.slice(0, headLines).map(cut).join("\n"),
		tail: lines.slice(total - tailLines).map(cut).join("\n"),
		totalLines: total,
		omittedLines: total - headLines - tailLines,
	};
}

/** Build the marker that replaces one pruned output. */
function buildMarker(
	message: Extract<AgentMessage, { role: "toolResult" } | { role: "bashExecution" }>,
	reference: string,
	size: number,
	calls: Map<string, ToolCallInfo>,
): string {
	if (message.role === "bashExecution") {
		const facts = bashFacts(message, undefined);
		return shellMarker(facts.command, facts.exit, facts.output, size, reference);
	}
	if (message.toolName === "read") {
		const call = calls.get(message.toolCallId);
		const path = typeof call?.arguments.path === "string" ? (call.arguments.path as string) : undefined;
		if (path === undefined) {
			return `[read pruned: ${formatSize(size)} tokens. ${recallClause(reference, "this exact output")}]`;
		}
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const startLine = typeof call?.arguments.offset === "number" ? (call.arguments.offset as number) : 1;
		const limit = typeof call?.arguments.limit === "number" ? (call.arguments.limit as number) : undefined;
		const endLine = limit !== undefined ? startLine + limit - 1 : startLine + Math.max(0, text.split("\n").length - 1);
		return `[read pruned: ${path}, lines ${startLine}-${Math.max(startLine, endLine)}, ${formatSize(size)} tokens. Re-read with the read tool. ${recallClause(reference, "this exact output")}]`;
	}
	if (message.toolName === "bash") {
		const call = calls.get(message.toolCallId);
		const facts = bashFacts(message, call);
		return shellMarker(facts.command, facts.exit, facts.output, size, reference);
	}
	if (message.toolName === "recall") {
		// A recall result is prune-eligible like any other output; its marker
		// points at the original entry, via the reference the tool call
		// carried, so the chain never dangles.
		const call = calls.get(message.toolCallId);
		const originalRef = typeof call?.arguments.ref === "string" ? (call.arguments.ref as string) : reference;
		return `[recall pruned: ${formatSize(size)} tokens. recall ${originalRef} for full output.]`;
	}
	return `[${message.toolName} pruned: ${formatSize(size)} tokens. ${recallClause(reference, "full output")}]`;
}

function shellMarker(command: string, exit: string, output: string, size: number, reference: string): string {
	const { head, tail, totalLines, omittedLines } = headTail(output);
	const commandPart = command === "" ? "" : `"${command}", `;
	const omitted = omittedLines > 0 ? `\n... ${omittedLines} lines omitted ...` : "";
	const tailPart = tail === "" ? "" : `\n${tail}`;
	return `[bash pruned: ${commandPart}${exit}, ${totalLines} lines, ${formatSize(size)} tokens.\n${head}${omitted}${tailPart}\n${recallClause(reference, "full output")}]`;
}

/** The prune pass. Stateless and idempotent: the same input yields the
 * same output, and a pruned list re-prunes to itself (the markers are far
 * below `minResultTokens`). */
export function prune(input: PruneInput): PruneResult {
	const projectEntry = input.projectEntry ?? sessionEntryToContextMessages;
	const estimate = input.estimate ?? estimateTokens;
	const estimateList = input.estimateList ?? ((messages) => messages.reduce((sum, message) => sum + estimate(message), 0));
	const identity: PruneResult = { engaged: false, messages: input.messages, records: [], prunedCount: 0, savingsTokens: 0 };
	if (!input.settings.enabled) return identity;

	// Engagement: pi's own compaction threshold.
	const threshold = input.contextWindow - input.reserveTokens;
	if (estimateList(input.messages) <= threshold) return identity;

	// Reference mapping: without the aligning entry no recall reference can
	// be built, so the pass stays out of the way.
	const entryFor = alignMessages(input.entries, input.messages, projectEntry);
	if (entryFor === null) return identity;

	const calls = collectToolCalls(input.messages);
	let lastUserIndex = -1;
	for (let i = input.messages.length - 1; i >= 0; i -= 1) {
		if (input.messages[i].role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	const messages: AgentMessage[] = [...input.messages];
	const records: PruneRecord[] = [];
	let savings = 0;
	for (let i = 0; i < input.messages.length; i += 1) {
		const message = input.messages[i];
		if (message.role !== "toolResult" && message.role !== "bashExecution") continue;
		if (input.settings.protectCurrentTurn && i > lastUserIndex) continue;
		const originalTokens = estimate(message);
		if (originalTokens <= input.settings.minResultTokens) continue;
		if (message.role === "toolResult" && message.content.every((part) => part.type === "image")) continue; // images only: never replaced
		const entry = entryFor[i];
		if (entry === null) continue;
		const reference = input.referenceFor(entry);
		const marker = buildMarker(message, reference, originalTokens, calls);
		const markerTokens = estimate({ role: "user", content: marker, timestamp: 0 } as AgentMessage);
		if (message.role === "toolResult") {
			// Image parts are never replaced: the marker takes the text
			// parts' place, the images stay.
			const images = message.content.filter((part) => part.type === "image");
			messages[i] = { ...message, content: [{ type: "text", text: marker }, ...images] };
		} else {
			messages[i] = { ...message, output: marker };
		}
		const saved = Math.max(0, originalTokens - markerTokens);
		savings += saved;
		records.push({ reference, toolName: message.role === "toolResult" ? message.toolName : "bash", originalTokens, markerTokens, savingsTokens: saved });
	}
	if (records.length === 0) return { engaged: true, messages: input.messages, records, prunedCount: 0, savingsTokens: 0 };
	return { engaged: true, messages, records, prunedCount: records.length, savingsTokens: savings };
}
