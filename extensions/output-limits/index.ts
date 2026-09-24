/**
 * Output limits extension: bound tool results against the Headroom,
 * losslessly (ADR 0026).
 *
 * One `tool_result` hook puts a ceiling on the size of a tool result before
 * pi writes it into the session, and keeps the whole result in a Spill file.
 * The ceiling, the Bound, is `clamp(shareOfHeadroom x Headroom,
 * minOutputBytes, maxOutputTokens)` in tokens, computed per call from the
 * session's live Headroom, so a session near its context window stops
 * swallowing 50KB tool outputs while a session with plenty of room sees no
 * change.
 *
 * The hook is the last moment at which the size is still controllable: pi
 * calls it after the tool finishes and before it appends the result, and it
 * persists exactly what the hook returns. The Bound therefore only ever
 * bounds downward, because the hook runs after pi's own cut and there is
 * nothing larger in hand. Raising a limit is out of scope.
 *
 * This file is thin pi wiring. The Headroom, the Bound, and the cut live in
 * `core.ts`; the per-message admitted state lives in `ledger.ts`; the Spill
 * files and their retention live in `spill.ts`; the settings reader lives in
 * `settings.ts`. The wiring owns what only pi can supply: `ctx.model` for the
 * Effective window, `ctx.getContextUsage()` for the usage pi reports, the
 * session for the calls the current assistant message asked for, and pi's own
 * `truncateHead` and `truncateTail` for the byte cut.
 *
 * Four rules the wiring enforces and the pure core cannot:
 * - Lossless or no cut. A failed Spill write leaves pi's result alone,
 *   records the true admitted size anyway, and is announced once per session.
 * - Blind is inert. With no Headroom to read the call keeps pi's own result.
 * - Images are charged against the Bound and never cut, because pi
 *   normalizes image blocks after this hook. No all-image result is
 *   special-cased.
 * - The extension never re-reads or rewrites the session file. It changes
 *   what gets stored, which is all Pruning and Compression can ever see.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	truncateHead,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type ToolResultEvent,
	type ToolResultEventResult,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	buildNotice,
	buildPointer,
	computeBound,
	computeHeadroom,
	type CutDirection,
	cutToBudget,
	fitsWithinBudget,
	type CutResult,
	formatBytes,
	formatTokens,
	measureBlocks,
	type NoticeFacts,
	PI_MAX_OUTPUT_BYTES,
	type PlannedBlock,
	type ContentBlock,
	tokensFromBytes,
} from "./core.ts";
import { Ledger } from "./ledger.ts";
import {
	envDisabled,
	readOutputLimitsSettings,
	readReserveTokens,
	type OutputLimitsSettings,
	writeOutputLimitsSettings,
	type SettingsPatch,
} from "./settings.ts";
import { mkdirPrivate, spillDir, spillFootprint, spillName, spillRoot, sweepSpills, writeSpill } from "./spill.ts";

/** The five tools in scope, each with pi's own cut direction (ADR 0026). */
const DIRECTIONS: Record<string, CutDirection> = {
	bash: "tail",
	read: "head",
	grep: "head",
	find: "head",
	ls: "head",
};

/**
 * The direction one result is cut at.
 *
 * pi's own direction per tool, except that an error result keeps its tail
 * whoever produced it (decision 18): the line that says why something failed
 * sits at the end, as bash's "Command exited with code 1" and pi's own thrown
 * messages both show, and a failed test's stack trace is often the largest
 * thing in a turn. ADR 0026 states the per-tool rule and names no exception;
 * the decision table it records does, so the exception is taken from the
 * decision and is visible here rather than buried in a caller.
 */
function directionOf(toolName: string, isError: boolean): CutDirection {
	return isError ? "tail" : DIRECTIONS[toolName];
}

/** The tools that keep a Spill. read is bounded without one (decision 11). */
const SPILLING = new Set(["bash", "grep", "find", "ls"]);

interface OutputLimitsState {
	settings: OutputLimitsSettings;
	reserveTokens: number;
	agentDir: string;
	sessionId: string;
	spillDir: string;
	/** The next Spill sequence number for this session. */
	seq: number;
	/** What the session-start sweep removed, for `status`. */
	sweep: { removed: number; bytesFreed: number };
	ledger: Ledger;
	/** True once the Spill-failure notification went out this session. */
	spillFailureNotified: boolean;
	/** The last Spill write error, for the one-per-session notice. */
	spillFailure: string | undefined;
	/** The last Bound this session enforced, for `status`. */
	lastBound: { toolName: string; tokens: number; bytes: number; blind: boolean } | null;
	/** What this session has bounded, for `status`. */
	cuts: { calls: number; droppedBytes: number };
}

let state: OutputLimitsState | null = null;

// ---------------------------------------------------------------------------
// The batch: what the current assistant message asked for
// ---------------------------------------------------------------------------

/**
 * The assistant message that asked for one call: its identity and its call
 * count.
 *
 * pi documents `ctx.sessionManager` as current through the assistant message
 * for `tool_call` and does not promise the same for `tool_result`
 * (implementation probe 2), so this reads the branch defensively and falls
 * back: the walk looks for the message carrying this `toolCallId`, and when
 * it finds none the batch is reported with `calls: 0` and the Ledger divides
 * on its own accumulation instead. The Ledger is authoritative either way.
 */
function readBatch(entries: SessionEntry[], toolCallId: string): { messageId: string; calls: number } {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) continue;
		if (!calls.some((block) => block.id === toolCallId)) continue;
		return { messageId: entry.id, calls: calls.length };
	}
	return { messageId: `unbatched:${toolCallId}`, calls: 0 };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Bound one tool result. Returns a patch, or undefined to let pi's result
 * through unchanged.
 *
 * The order is the design: read the Headroom, open the batch and take this
 * call's share of its allowance, measure the result against it, write the
 * Spill before publishing the cut (lossless or no cut), then let the Ledger
 * record what the session actually grew by.
 */
function boundResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
	const s = state;
	if (!s || !s.settings.enabled || envDisabled()) return undefined;
	const direction = DIRECTIONS[event.toolName];
	if (direction === undefined || !s.settings.tools.includes(event.toolName)) return undefined;
	const cutDirection = directionOf(event.toolName, event.isError);

	// Blind: no resolved window, or no usage yet. The Bound is pi's own
	// figure, so a blind call behaves exactly like pi today and is inert.
	const usage = ctx.getContextUsage();
	const headroom = computeHeadroom({
		effectiveWindow: ctx.model?.contextWindow,
		reserveTokens: s.reserveTokens,
		usedTokens: usage?.tokens,
	});
	const math = { bytesPerChar: s.settings.bytesPerChar, inflation: s.settings.inflation };

	const batch = readBatch(ctx.sessionManager.buildContextEntries(), event.toolCallId);
	const floorTokens = Math.max(1, tokensFromBytes(s.settings.minOutputBytes, math));
	// The allowance is a per-message figure, written once and reused by every
	// sibling, because the usage pi reports cannot include a sibling that has
	// not finished. Blind leaves it at the outer max, which is inert.
	const allowanceTokens = headroom.known ? Math.max(floorTokens, Math.floor(headroom.tokens * s.settings.shareOfHeadroom)) : s.settings.maxOutputTokens;
	s.ledger.begin(batch.messageId, batch.calls, headroom.known ? headroom.tokens : 0, allowanceTokens);
	const view = s.ledger.view(batch.messageId);
	if (!view) return undefined;

	const bound = computeBound({
		headroom,
		settings: {
			shareOfHeadroom: s.settings.shareOfHeadroom,
			minOutputBytes: s.settings.minOutputBytes,
			maxOutputTokens: s.settings.maxOutputTokens,
			maxLines: s.settings.maxLines,
			math,
		},
		remainingAllowanceTokens: view.remainingAllowanceTokens,
		remainingCalls: view.remainingCalls,
	});
	s.lastBound = { toolName: event.toolName, tokens: bound.tokens, bytes: bound.bytes, blind: bound.blind };
	if (bound.blind) return undefined;

	const receivedBytes = measureBlocks(event.content as ContentBlock[]);
	if (fitsWithinBudget(event.content as ContentBlock[], bound.bytes, bound.maxLines)) {
		// The unbounded case: nothing is copied anywhere, so nothing is
		// stored for it. The Ledger still learns what the session grew by.
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}

	// Lossless or no cut: the Spill is written first, and a failure means
	// pi's result is published as it arrived.
	const spills = SPILLING.has(event.toolName);
	const written = spills ? spillWrite(s, event) : undefined;
	const spillPath = written?.path;
	const adopted = written?.adopted ?? false;
	if (spills && written === undefined) {
		notifySpillFailureOnce(ctx, s);
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}

	const shown = spillPath === undefined ? undefined : displayPath(s.agentDir, spillPath);
	const pointer = buildPointer(shown);
	// The notice the model reads counts against the Bound, so every cut is
	// planned with its bytes reserved, then verified against the published
	// size. read needs its continuation offset before the notice is final, so
	// read settles that number against the plan too.
	const facts: NoticeFacts = {
		boundBytes: bound.bytes,
		boundTokens: bound.tokens,
		headroomTokens: headroom.known ? headroom.tokens : 0,
		calls: batch.calls,
		continueOffset: undefined,
		displayPath: shown,
	};
	const planInput = (notice: string) =>
		cutToBudget({
			blocks: event.content as ContentBlock[],
			budgetBytes: bound.bytes,
			maxLines: bound.maxLines,
			direction: cutDirection,
			cutters: { head: truncateHead, tail: truncateTail },
			pointer,
			notice,
			rewriteReadNotice: event.toolName === "read",
		});

	let plan = planInput(buildNotice(facts));
	if (event.toolName === "read") {
		// The continuation offset depends on how many lines the cut keeps, and
		// the notice that states it changes size with the digits it carries,
		// which changes what the cut keeps. Settle the two together: re-plan
		// with each new offset until the number stops moving, so the line the
		// model reads names the offset the published text really continues at.
		const startLine = plan.readStartLine ?? readStartLineOf(event);
		if (startLine !== undefined) {
			for (let pass = 0; pass < 6; pass += 1) {
				const offset = startLine + plan.keptLines;
				if (facts.continueOffset === offset) break;
				facts.continueOffset = offset;
				plan = planInput(buildNotice(facts));
			}
		}
	}

	if (plan.fits && !plan.rewritten) {
		// The reservation closed the gap on its own: no byte was dropped, so
		// nothing is announced and nothing is spilled. The Spill is only
		// removed when this extension wrote it: when it adopted pi's log, that
		// file holds output pi already dropped from the session, and deleting
		// it would be the data loss this extension exists to prevent.
		if (spillPath !== undefined && !adopted) removeSpill(spillPath);
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}
	if (plan.fits) {
		// read's stale continuation line was the only thing over budget. It is
		// published without that line and with nothing appended: the offset pi
		// named pointed past the Bound, so leaving it would send the model to
		// re-read content it already has.
		const stripped = plan.blocks.map((block) => (block.kind === "image"
			? { type: "image", data: block.block.data, mimeType: block.block.mimeType }
			: { type: "text", text: block.kind === "pointer" ? pointer : block.text }));
		const strippedBytes = measureBlocks(stripped as ContentBlock[]);
		s.ledger.record(batch.messageId, tokensFromBytes(strippedBytes, math));
		if (strippedBytes === receivedBytes) return undefined;
		return { content: stripped as (TextContent | ImageContent)[] };
	}

	const content = renderPlan(plan, facts, pointer);
	const admittedBytes = measureBlocks(content as ContentBlock[]);
	if (Number.isFinite(bound.bytes) && admittedBytes > bound.bytes) {
		// The Bound is a promise, so a plan that could not be made to fit is
		// not published: pi's own result stands, and the Ledger records the
		// size that really went in. Reaching this line would mean the budget
		// settle loop ran out of passes, which the floor makes impossible in
		// practice; it is here so the invariant is enforced rather than hoped.
		if (spillPath !== undefined && !adopted) removeSpill(spillPath);
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}
	s.ledger.record(batch.messageId, tokensFromBytes(admittedBytes, math));
	s.cuts.calls += 1;
	s.cuts.droppedBytes += plan.droppedBytes;

	const details = patchDetails(event, plan, bound.bytes, bound.maxLines, spills ? spillPath : undefined);
	return { content: content as (TextContent | ImageContent)[], details };
}

/**
 * Drop a Spill the cut did not need after all. A result that fits inside the
 * Bound is never kept in a second copy, so an over-eager reservation is
 * undone rather than left behind.
 */
function removeSpill(spillPath: string): void {
	try {
		fs.rmSync(spillPath, { force: true });
	} catch {
		// An undeletable empty Spill is a footprint wart, not a data loss.
	}
}

/** The first line a read result showed, from the call's own arguments. */
function readStartLineOf(event: ToolResultEvent): number | undefined {
	const input = event.input as Record<string, unknown> | undefined;
	const offset = input?.offset;
	if (typeof offset === "number" && Number.isFinite(offset) && offset >= 1) return Math.floor(offset);
	return 1;
}

/**
 * The blocks the model receives.
 *
 * Kept blocks stay in order and the result is never collapsed. The crossing
 * block carries the appended notice line after the text that survived pi's
 * own cut and this one; a dropped text block becomes the one-line pointer;
 * image blocks are emitted untouched, because pi normalizes them after this
 * hook and cutting one would only lose bytes the session never had.
 */
function renderPlan(plan: { blocks: PlannedBlock[] }, facts: NoticeFacts, pointer: string): (TextContent | ImageContent)[] {
	const notice = buildNotice(facts);
	const out: (TextContent | ImageContent)[] = [];
	let noticePlaced = false;
	for (const block of plan.blocks) {
		switch (block.kind) {
			case "image":
				out.push({ type: "image", data: block.block.data, mimeType: block.block.mimeType });
				break;
			case "pointer":
				out.push({ type: "text", text: pointer });
				break;
			case "cut":
				out.push({ type: "text", text: `${block.text}\n\n${notice}` });
				noticePlaced = true;
				break;
			case "keep":
				out.push({ type: "text", text: block.text });
				break;
		}
	}
	// A result whose kept blocks are all images, or all pointers, has nowhere
	// to carry the notice, so the line travels as its own block.
	if (!noticePlaced) out.push({ type: "text", text: notice });
	return out;
}

/**
 * The patched `details`.
 *
 * `truncation.maxBytes` and `maxLines` carry the extension's own figures, so
 * pi's built-in renderer names the real Bound instead of pi's default
 * (decision 22). Every other field of the record comes from the cut that
 * actually ran, so the renderer's line and byte counts stay coherent with the
 * text it is rendering. For bash, `fullOutputPath` points at the Spill file
 * instead of pi's throwaway, which this extension moved.
 *
 * The record keeps pi's shape, `content` included, even though no renderer
 * reads that field: pi's own tools store it, and a patched record that dropped
 * it would be a different shape from the one the session already holds from
 * calls this extension never touched.
 */
function patchDetails(
	event: ToolResultEvent,
	plan: { cut: CutResult | null; keptBytes: number; keptLines: number; droppedBytes: number; droppedLines: number },
	boundBytes: number,
	boundMaxLines: number,
	spillPath: string | undefined,
): Record<string, unknown> {
	const details = { ...(event.details as Record<string, unknown> | undefined) };
	const cut = plan.cut ?? syntheticCut(plan, boundBytes, boundMaxLines);
	details.truncation = {
		...(cut as TruncationResult),
		maxLines: boundMaxLines,
		maxBytes: Math.floor(boundBytes),
	};
	if (spillPath !== undefined && event.toolName === "bash") details.fullOutputPath = spillPath;
	return details;
}

/**
 * A truncation record for a plan whose crossing block was dropped whole, so
 * pi's cutter never ran. The numbers are the truth of the call: the received
 * result as the total, the kept blocks as the output.
 */
function syntheticCut(plan: { keptBytes: number; keptLines: number; droppedBytes: number; droppedLines: number }, boundBytes: number, maxLines: number): CutResult {
	const totalBytes = plan.keptBytes + plan.droppedBytes;
	return {
		content: "",
		truncated: true,
		truncatedBy: plan.keptLines >= maxLines ? "lines" : "bytes",
		totalLines: plan.keptLines + plan.droppedLines,
		totalBytes,
		outputLines: plan.keptLines,
		outputBytes: plan.keptBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes: Math.floor(boundBytes),
	};
}

/** The path a notice shows, `~`-abbreviated so it fits one terminal line. */
function displayPath(agentDir: string, filePath: string): string {
	const home = os.homedir();
	if (filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
	if (filePath.startsWith(`${agentDir}/`)) return `${agentDir}/${filePath.slice(agentDir.length + 1)}`;
	return filePath;
}

// ---------------------------------------------------------------------------
// Spill writing
// ---------------------------------------------------------------------------

/**
 * Write the whole received result to a Spill file. Returns the path, or
 * undefined when the write failed.
 *
 * For bash, pi's own throwaway log is moved into the Spill directory instead
 * of being left behind, and the result text follows it in the same file, so
 * one call has one complete file (decision 9).
 */
function spillWrite(s: OutputLimitsState, event: ToolResultEvent): { path: string; adopted: boolean } | undefined {
	const details = event.details as { fullOutputPath?: string } | undefined;
	const adopt = event.toolName === "bash" ? details?.fullOutputPath : undefined;
	const name = spillName(s.seq, event.toolName, event.toolCallId);
	s.seq += 1;
	const text = `${textOf(event.content)}\n`;
	const result = writeSpill(s.spillDir, name, text, adopt);
	if (result.ok) return { path: result.path, adopted: result.adopted };
	s.spillFailure = result.error;
	return undefined;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else parts.push(`[image ${block.mimeType}, ${(Buffer.byteLength(block.data, "utf8") / 1024).toFixed(1)}KB base64]`);
	}
	return parts.join("\n\n");
}

function notifySpillFailureOnce(ctx: ExtensionContext, s: OutputLimitsState): void {
	if (s.spillFailureNotified) return;
	s.spillFailureNotified = true;
	ctx.ui.notify(`output-limits: could not write a Spill file (${s.spillFailure ?? "unknown error"}); results are left unbounded`, "warning");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The agent directory, the way pi names it: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
function agentDirOf(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/**
 * Read the settings, open the Spill directory, and sweep.
 *
 * The sequence number restarts from what is already on disk, so a resumed
 * session never overwrites a Spill an earlier run named in a notice.
 */
function openState(ctx: ExtensionContext): OutputLimitsState {
	const { settings, errors } = readOutputLimitsSettings(ctx.cwd);
	for (const error of errors) ctx.ui.notify(`output-limits: ${error}`, "error");
	const agentDir = agentDirOf();
	const dir = spillDir(agentDir, ctx.sessionManager.getSessionId());
	let sweep = { removed: 0, bytesFreed: 0 };
	let seq = 1;
	if (settings.enabled) {
		try {
			mkdirPrivate(dir);
			seq = nextSeq(dir);
			sweep = sweepSpills(spillRoot(agentDir), settings.spill);
		} catch (err) {
			ctx.ui.notify(
				`output-limits: could not open the Spill directory (${err instanceof Error ? err.message : String(err)}); results are left unbounded`,
				"warning",
			);
		}
	}
	return {
		settings,
		reserveTokens: readReserveTokens(ctx.cwd),
		agentDir,
		sessionId: ctx.sessionManager.getSessionId(),
		spillDir: dir,
		seq,
		sweep,
		ledger: new Ledger(),
		spillFailureNotified: false,
		spillFailure: undefined,
		lastBound: null,
		cuts: { calls: 0, droppedBytes: 0 },
	};
}

/** The next Spill sequence number: one past the highest file already there. */
function nextSeq(dir: string): number {
	if (!fs.existsSync(dir)) return 1;
	let max = 0;
	for (const name of fs.readdirSync(dir)) {
		const match = /^(\d+)-/.exec(name);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** The active Bound inputs and the Spill footprint. Not a file listing: the
 * model reads a Spill with bash (out of scope: a `list` view). */
function statusText(s: OutputLimitsState, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const headroom = computeHeadroom({
		effectiveWindow: ctx.model?.contextWindow,
		reserveTokens: s.reserveTokens,
		usedTokens: usage?.tokens,
	});
	const math = { bytesPerChar: s.settings.bytesPerChar, inflation: s.settings.inflation };
	const floorTokens = tokensFromBytes(s.settings.minOutputBytes, math);
	const footprint = spillFootprint(s.spillDir);
	const outerBytes = Math.floor((s.settings.maxOutputTokens * s.settings.bytesPerChar) / s.settings.inflation);
	return [
		`output-limits: ${s.settings.enabled && !envDisabled() ? "on" : "off"}`,
		`tools: ${s.settings.tools.join(", ")}`,
		`Bound: shareOfHeadroom=${s.settings.shareOfHeadroom}, minOutputBytes=${s.settings.minOutputBytes} (${formatBytes(s.settings.minOutputBytes)} ~${formatTokens(floorTokens)}), maxOutputTokens=${s.settings.maxOutputTokens} (${formatBytes(outerBytes)} ~${formatTokens(s.settings.maxOutputTokens)}; pi's own is ${formatBytes(PI_MAX_OUTPUT_BYTES)})`,
		`token math: bytesPerChar ${s.settings.bytesPerChar}, inflation ${s.settings.inflation}, maxLines ${s.settings.maxLines}`,
		headroom.known
			? `Headroom: ${formatTokens(headroom.tokens)} = window ${formatTokens(headroom.effectiveWindow)} - reserve ${formatTokens(headroom.reserveTokens)} - used ${formatTokens(headroom.usedTokens)}`
			: "Headroom: blind, no usage to read, so results keep pi's own figures",
		s.lastBound
			? `last Bound: ${s.lastBound.toolName} ${formatBytes(s.lastBound.bytes)} (${formatTokens(s.lastBound.tokens)})`
			: "last Bound: none yet",
		`batch: ${describeBatch(s)}`,
		`Spill: ${s.cuts.calls} cut${s.cuts.calls === 1 ? "" : "s"}, ${formatBytes(s.cuts.droppedBytes)} dropped, ${footprint.files} file(s) ${formatBytes(footprint.bytes)} in ${displayPath(s.agentDir, s.spillDir)}`,
		`sweep at start: removed ${s.sweep.removed} file(s), freed ${formatBytes(s.sweep.bytesFreed)}; limits ${formatBytes(s.settings.spill.maxTotalBytes)} and ${s.settings.spill.maxAgeDays} day(s)`,
	].join("\n");
}

function describeBatch(s: OutputLimitsState): string {
	const entry = s.ledger.latest();
	if (!entry) return "no batch seen yet";
	const calls = entry.calls > 0 ? `${entry.calls} call(s)` : "call count unread";
	return `${calls}, admitted ${formatTokens(entry.admittedTokens)} against ${formatTokens(entry.allowanceTokens)} allowance`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function outputLimitsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		state = openState(ctx);
	});

	pi.on("session_shutdown", async () => {
		state = null;
	});

	// A compaction, a model switch, or a tree navigation changes the
	// projection the Headroom was read from, so no stored batch baseline may
	// carry across it (ADR 0026, accepted cost).
	pi.on("session_compact", async () => state?.ledger.invalidate());
	pi.on("model_select", async () => state?.ledger.invalidate());
	pi.on("session_tree", async () => state?.ledger.invalidate());

	pi.on("tool_result", async (event, ctx) => boundResult(event, ctx));

	pi.registerCommand("output-limits", {
		description: "Bound tool results: /output-limits status|settings|off|on",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "The active Bound inputs and the Spill footprint" },
				{ value: "settings", label: "settings", description: "Show or edit the outputLimits keys" },
				{ value: "off", label: "off", description: "Stop bounding tool results" },
				{ value: "on", label: "on", description: "Bound tool results again" },
			];
			const p = prefix.trim().toLowerCase();
			return p === "" ? items : items.filter((item) => item.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0] ?? "status";
			if (verb === "status") {
				if (!state) state = openState(ctx);
				ctx.ui.notify(statusText(state, ctx), "info");
				return;
			}
			if (verb === "settings") {
				const pairs = parts.slice(1);
				if (!state) state = openState(ctx);
				if (pairs.length === 0) {
					ctx.ui.notify(formatSettings(state.settings), "info");
					return;
				}
				const patch: SettingsPatch = {};
				for (const pair of pairs) {
					const error = parsePair(pair, patch);
					if (error) {
						ctx.ui.notify(`output-limits: ${error}`, "error");
						return;
					}
				}
				const written = writeOutputLimitsSettings(ctx.cwd, patch);
				if (!written.ok) {
					ctx.ui.notify(`output-limits: ${written.error}`, "error");
					return;
				}
				state = openState(ctx);
				ctx.ui.notify(`output-limits: settings saved to ${written.path}\n${formatSettings(state.settings)}`, "info");
				return;
			}
			if (verb === "off" || verb === "on") {
				const written = writeOutputLimitsSettings(ctx.cwd, { enabled: verb === "on" });
				if (!written.ok) {
					ctx.ui.notify(`output-limits: ${written.error}`, "error");
					return;
				}
				state = openState(ctx);
				ctx.ui.notify(
					verb === "on"
						? "output-limits: bounding tool results again (saved to " + written.path + ")"
						: "output-limits: leaving tool results alone (saved to " + written.path + ")",
					"info",
				);
				return;
			}
			ctx.ui.notify("output-limits: usage: /output-limits status|settings|off|on", "error");
		},
	});
}

function formatSettings(settings: OutputLimitsSettings): string {
	return [
		`outputLimits.enabled=${settings.enabled}`,
		`outputLimits.maxOutputTokens=${settings.maxOutputTokens}`,
		`outputLimits.maxLines=${settings.maxLines}`,
		`outputLimits.inflation=${settings.inflation}`,
		`outputLimits.bytesPerChar=${settings.bytesPerChar}`,
		`outputLimits.shareOfHeadroom=${settings.shareOfHeadroom}`,
		`outputLimits.minOutputBytes=${settings.minOutputBytes}`,
		`outputLimits.tools=${settings.tools.join(",")}`,
		`outputLimits.spill.maxTotalBytes=${settings.spill.maxTotalBytes}`,
		`outputLimits.spill.maxAgeDays=${settings.spill.maxAgeDays}`,
	].join("\n");
}

/** Apply one `key=value` pair to a settings patch. Returns an error string. */
function parsePair(kv: string, patch: SettingsPatch): string | undefined {
	const eq = kv.indexOf("=");
	if (eq <= 0) return `invalid setting: ${kv} (expected key=value)`;
	const key = kv.slice(0, eq);
	const raw = kv.slice(eq + 1);
	if (key === "enabled") {
		if (raw === "true" || raw === "false") patch.enabled = raw === "true";
		else return `outputLimits.enabled must be true or false, got: ${raw}`;
		return;
	}
	if (key === "tools") {
		const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
		if (names.length === 0) return "outputLimits.tools must name at least one tool";
		patch.tools = names;
		return;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return `outputLimits.${key} must be a positive number, got: ${raw}`;
	switch (key) {
		case "maxOutputTokens":
			if (!Number.isInteger(value)) return "outputLimits.maxOutputTokens must be an integer";
			patch.maxOutputTokens = value;
			return;
		case "maxLines":
			if (!Number.isInteger(value)) return "outputLimits.maxLines must be an integer";
			patch.maxLines = value;
			return;
		case "minOutputBytes":
			if (!Number.isInteger(value)) return "outputLimits.minOutputBytes must be an integer";
			patch.minOutputBytes = value;
			return;
		case "inflation":
			patch.inflation = value;
			return;
		case "bytesPerChar":
			patch.bytesPerChar = value;
			return;
		case "shareOfHeadroom":
			if (value > 1) return "outputLimits.shareOfHeadroom must be at most 1";
			patch.shareOfHeadroom = value;
			return;
		case "spill.maxTotalBytes":
			if (!Number.isInteger(value)) return "outputLimits.spill.maxTotalBytes must be an integer";
			patch["spill.maxTotalBytes"] = value;
			return;
		case "spill.maxAgeDays":
			if (!Number.isInteger(value)) return "outputLimits.spill.maxAgeDays must be an integer";
			patch["spill.maxAgeDays"] = value;
			return;
		default:
			return `unknown outputLimits setting: ${key} (expected enabled, maxOutputTokens, maxLines, inflation, bytesPerChar, shareOfHeadroom, minOutputBytes, tools, spill.maxTotalBytes, or spill.maxAgeDays)`;
	}
}

// The two pi figures this extension's defaults are pinned to live in
// `core.ts` as `PI_MAX_OUTPUT_BYTES` and `PI_MAX_OUTPUT_LINES`, restated
// rather than imported from pi's tool module so the pure core stays free of
// pi. `core.test.ts` asserts the restatement against pi's own exports, so a
// pi change fails a test instead of silently shifting every Bound.
