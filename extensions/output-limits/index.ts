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
	boundSettingsOf,
	buildNotice,
	buildPointer,
	bytesFromTokens,
	computeBound,
	computeHeadroom,
	type ContentBlock,
	type CutDirection,
	type CutResult,
	cutToBudget,
	fitsWithinBudget,
	floorTokensOf,
	formatBytes,
	formatTokens,
	lineCeilingOf,
	measureBlocks,
	messageAllowanceTokens,
	type NoticeFacts,
	noLineCeiling,
	PI_CUT_POLICIES,
	PI_MAX_OUTPUT_BYTES,
	PI_NOTICE_SLACK_BYTES,
	renderPlan,
	rewriteSpillPath,
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
	tokenMathOf,
} from "./settings.ts";
import { agentDir as agentDirOf, modelKey as piModelKey } from "../shared/settings.ts";
import { mkdirPrivate, spillDir, spillFootprint, spillName, spillRoot, sweepSpills, type SpillWrite, writeSpill } from "./spill.ts";

/**
 * The direction one result is cut at.
 *
 * pi's own direction per tool, read off `PI_CUT_POLICIES` (ADR 0026), except
 * that an error result keeps its tail whoever produced it (decision 18): the
 * line that says why something failed sits at the end, as bash's "Command
 * exited with code 1" and pi's own thrown messages both show, and a failed
 * test's stack trace is often the largest thing in a turn. ADR 0026 states the
 * per-tool rule and names no exception; the decision table it records does, so
 * the exception is taken from the decision and is visible here rather than
 * buried in a caller.
 */
function directionOf(toolName: string, isError: boolean): CutDirection {
	return isError ? "tail" : PI_CUT_POLICIES[toolName]!.direction;
}

/** The tools that keep a Spill. read is bounded without one (decision 11). */
const SPILLING = new Set(["bash", "grep", "find", "ls"]);

interface OutputLimitsState {
	settings: OutputLimitsSettings;
	reserveTokens: number;
	agentDir: string;
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
	/**
	 * Cuts the Headroom did not cause: calls where the Bound had already reached
	 * the outer max, so whatever was dropped was dropped by a ceiling and not by
     * pressure near the window. `status` names it because a nonzero figure here
     * means the extension is no longer invisible in an open session, which is
     * the one state it must never be in.
	 */
	ceilingCuts: number;
}

/**
 * The module-level state, and why one is enough.
 *
 * pi runs one session per process and the extension is loaded once per
 * process, so `session_start` builds this object and `session_shutdown` drops
 * it. Two loaded instances of this extension in one process would contend for
 * the Ledger, the Spill sequence number, and the once-per-session failure
 * notice, because each would hold its own state object while writing to the one
 * session. That is not a supported shape: this repo's extensions all take the
 * same posture, and a second instance would be a duplicate policy, not a
 * second view of it.
 */
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
 * (implementation probe 2), so this reads the branch defensively. When no
 * entry carries this `toolCallId`, the batch is reported with `calls: 0` and
 * the count is unknown, but the key is still one the siblings of the same
 * message share: the newest assistant entry in the branch. That matters, because
 * with no count the Ledger lets each call reach the whole remaining allowance,
 * and the accumulation is what bounds the batch. A per-call key would give
 * every sibling a batch of one and leave the message unbounded.
 *
 * The error this can make is a merge with an older message, which only ever
 * tightens a Bound: an older batch has already spent its allowance, so the
 * remainder the merge reports is smaller, never larger.
 */
function readBatch(entries: SessionEntry[], toolCallId: string): { messageId: string; calls: number } {
	// The walk is over the whole branch, newest first, and it stops at the
	// message that asked for this call, which for a live session is the last
	// assistant entry: one or two messages of work in practice. It degrades to
	// the full list only when no entry carries the call id at all, which is
	// probe 2's shape. If sessions ever grow to where that is common, the fix is
	// to remember the last assistant entry across calls rather than to search.
	let newestAssistantWithCalls: string | undefined;
	let newestAssistant: string | undefined;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		if (newestAssistant === undefined) newestAssistant = entry.id;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) continue;
		if (calls.some((block) => block.id === toolCallId)) return { messageId: entry.id, calls: calls.length };
		if (newestAssistantWithCalls === undefined) newestAssistantWithCalls = entry.id;
	}
	// Nothing in the branch carries this call, so the batch is keyed on the
	// newest thing its siblings can still agree about: the message that asked
	// for calls, then any assistant message, then the leaf entry, then one
	// session-wide bucket. A per-call key would give every sibling a batch of
	// one, and with no call count each sibling reaches the whole remaining
	// allowance: the message would be unbounded, which is what the Ledger
	// exists to prevent. Merging two batches by mistake can only tighten a
	// Bound, never loosen one.
	const shared = entries.length > 0 ? entries[entries.length - 1].id : "no-entries";
	return { messageId: `unbatched:${newestAssistantWithCalls ?? newestAssistant ?? shared}`, calls: 0 };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Bound one tool result. Returns a patch, or undefined to let pi's result
 * through unchanged.
 *
 * The order is the design, and it exists to keep both promises at once. Read
 * the Headroom, open the batch and take this call's share of its allowance,
 * name the Spill this call would own without writing it, measure the result
 * against the Bound with that path and these notices in it, and only then
 * write. So every way out that leaves pi's result alone leaves it alone with
 * nothing moved: a cut that cannot be made to fit, a Spill that cannot be
 * written, and a blind call all publish pi's own text with pi's own paths
 * still pointing at files that exist. Lossless or no cut, and one live path.
 *
 * The Ledger records what the session really grew by on every way out, cut or
 * not, because the usage pi reports cannot include a sibling still running.
 */
function boundResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
	const s = state;
	if (!s || !s.settings.enabled || envDisabled()) return undefined;
	if (PI_CUT_POLICIES[event.toolName] === undefined || !s.settings.tools.includes(event.toolName)) return undefined;
	const settings = boundSettingsOf(s.settings);
	const math = settings.math;

	// Blind: no resolved window, or no usage yet. The Bound is pi's own figure
	// and no byte budget is enforced, so a blind call publishes exactly what pi
	// produced, exactly like pi today.
	const usage = ctx.getContextUsage();
	const headroom = computeHeadroom({
		effectiveWindow: ctx.model?.contextWindow,
		reserveTokens: s.reserveTokens,
		usedTokens: usage?.tokens,
	});
	const batch = readBatch(ctx.sessionManager.buildContextEntries(), event.toolCallId);
	// The allowance is a per-message figure, written once and reused by every
	// sibling. A blind call writes no baseline: the batch takes one from the
	// first sibling that can read a Headroom, so a blind first call cannot
	// freeze the whole message at the outer max.
	s.ledger.begin(
		batch.messageId,
		batch.calls,
		headroom.known ? { headroomTokens: headroom.tokens, allowanceTokens: messageAllowanceTokens(headroom, settings) } : null,
	);
	const view = s.ledger.view(batch.messageId);
	if (!view) return undefined;

	const bound = computeBound({
		toolName: event.toolName,
		headroom,
		settings,
		remainingAllowanceTokens: view.remainingAllowanceTokens,
		remainingCalls: view.remainingCalls,
	});
	s.lastBound = { toolName: event.toolName, tokens: bound.tokens, bytes: bound.bytes, blind: bound.blind };
	const received = event.content as ContentBlock[];
	const receivedBytes = measureBlocks(received);
	if (bound.blind) {
		// Inert, but not invisible to the batch: this call still grew the
		// session by pi's whole result, and a sibling that does find a Headroom
		// has to divide what is left of the message, not all of it.
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}
	if (fitsWithinBudget(received, bound.bytes, bound.maxLines)) {
		// The unbounded case: the result fits inside its Bound, so nothing is
		// copied anywhere and nothing is stored for it.
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}

	// The Spill is named now and written last. Its path is part of the notice
	// the model reads, so the cut has to be planned against it before it
	// exists, and a call that never publishes one leaves no file behind.
	const spill = SPILLING.has(event.toolName) ? reserveSpill(s, event) : undefined;
	const shown = spill === undefined ? undefined : displayPath(s.agentDir, spill.path);
	const pointer = buildPointer(shown);
	// One live path: adopting pi's log moves the file pi named inside its own
	// notice, so that name is rewritten to the Spill that will hold the bytes.
	// The rewrite happens before any measuring, so the Bound is charged for
	// the longer path it costs.
	const adoptedFrom = spill === undefined ? undefined : adoptedLogPath(event);
	const blocks =
		spill === undefined || adoptedFrom === undefined || shown === undefined
			? received
			: rewriteSpillPath(received, adoptedFrom, shown).blocks;
	const cutDirection = directionOf(event.toolName, event.isError);

	// The notice the model reads counts against the Bound, so every cut is
	// planned with its bytes reserved and then verified against the published
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
			blocks,
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

	if (plan.fits) {
		// Nothing was cut. Either the received result fit inside its Bound, or it
		// came inside it only because pi's own continuation notice was not charged
		// against the budget -- and that line is read's only recovery pointer, still
		// exactly true because no content was dropped. So pi's own text stands in
		// both shapes: publishing the stripped body instead would hand the model a
		// read result with no `offset`, no notice, and no Spill, which is the one
		// way this extension can lose text outright (decisions 11 and 22). The cost
		// is at most pi's own notice past the Bound, and the Ledger is charged the
		// size that really went into the session.
		s.ledger.record(batch.messageId, tokensFromBytes(receivedBytes, math));
		return undefined;
	}

	const content = toPiBlocks(renderPlan(plan, pointer, buildNotice(facts)));
	const admittedBytes = measureBlocks(content as ContentBlock[]);
	if (!fitsWithinBudget(content as ContentBlock[], bound.bytes, bound.maxLines)) {
		// The Bound is a promise, so a plan that could not be made to fit is
		// not published: pi's own result stands, and the Ledger records the
		// size that really went in. Reaching this line means the budget settle
		// loop ran out of passes, which the floor makes impossible in practice;
		// it is here so the invariant is checked rather than hoped, and it is
		// checked before the Spill is written so nothing has moved yet.
		s.ledger.record(batch.messageId, tokensFromBytes(measureBlocks(blocks), math));
		return undefined;
	}

	// Lossless or no cut, and last: the whole result is on disk before the cut
	// text is published, so a write that cannot be made leaves pi's result
	// alone rather than publishing a cut whose other half is missing.
	if (spill !== undefined) {
		const written = spillWrite(event, spill);
		if (!written.ok) {
			s.spillFailure = written.error;
			notifySpillFailureOnce(ctx, s);
			s.ledger.record(batch.messageId, tokensFromBytes(measureBlocks(blocks), math));
			return undefined;
		}
	}
	s.ledger.record(batch.messageId, tokensFromBytes(admittedBytes, math));
	s.cuts.calls += 1;
	s.cuts.droppedBytes += plan.droppedBytes;
	// The Headroom was not what bound this call: the Bound had already reached
	// the outer max, so a ceiling did. That is worth counting, because the
	// extension promises to be invisible while the window is open.
	if (bound.tokens >= settings.maxOutputTokens) s.ceilingCuts += 1;

	const details = patchDetails(event, plan, bound.bytes, bound.maxLines, spill?.path);
	return { content, details };
}

/** The Spill file one call will own, named before it is written. */
interface ReservedSpill {
	dir: string;
	name: string;
	path: string;
}

function reserveSpill(s: OutputLimitsState, event: ToolResultEvent): ReservedSpill {
	const name = spillName(s.seq, event.toolName, event.toolCallId);
	s.seq += 1;
	return { dir: s.spillDir, name, path: path.join(s.spillDir, name) };
}

/**
 * pi's own throwaway log for this result, when it wrote one and it is there.
 *
 * For bash the hook receives `details.fullOutputPath`, the command's whole
 * output including the part pi dropped, which is the only place those bytes
 * exist. Adopting it is what makes a spilled bash result complete, so the
 * notice names the Spill instead of the file this extension moved.
 */
function adoptedLogPath(event: ToolResultEvent): string | undefined {
	if (event.toolName !== "bash") return undefined;
	const details = event.details as { fullOutputPath?: unknown } | undefined;
	const logPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	if (logPath === undefined || logPath.length === 0) return undefined;
	try {
		return fs.existsSync(logPath) ? logPath : undefined;
	} catch {
		return undefined;
	}
}

/** This extension's structural blocks in pi's shape, order preserved. */
function toPiBlocks(blocks: readonly ContentBlock[]): (TextContent | ImageContent)[] {
	return blocks.map((block) =>
		block.type === "image"
			? { type: "image", data: block.data, mimeType: block.mimeType }
			: { type: "text", text: block.text },
	) as (TextContent | ImageContent)[];
}

/** The first line a read result showed, from the call's own arguments. */
function readStartLineOf(event: ToolResultEvent): number | undefined {
	const input = event.input as Record<string, unknown> | undefined;
	const offset = input?.offset;
	if (typeof offset === "number" && Number.isFinite(offset) && offset >= 1) return Math.floor(offset);
	return 1;
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
 * Write the whole received result to the Spill file this call reserved.
 *
 * For bash, pi's own throwaway log is moved into the Spill directory instead
 * of being left behind, so one call has one complete file (decision 9). The
 * result text is handed over lazily: when the log is adopted it already holds
 * those bytes and more, and building a second copy of a 50KB result to throw it
 * away is a cost the adopt path should not have to pay.
 */
function spillWrite(event: ToolResultEvent, spill: ReservedSpill): SpillWrite {
	return writeSpill(spill.dir, spill.name, () => `${textOf(event.content)}\n`, adoptedLogPath(event));
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
		reserveTokens: readReserveTokens(ctx.cwd, process.env, piModelKey(ctx.model)),
		agentDir,
		spillDir: dir,
		seq,
		sweep,
		ledger: new Ledger(),
		spillFailureNotified: false,
		spillFailure: undefined,
						lastBound: null,
		cuts: { calls: 0, droppedBytes: 0 },
		ceilingCuts: 0,
	};
}

/**
 * The next Spill sequence number: one past the highest file already there. */
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
	const math = tokenMathOf(s.settings);
	const floorTokens = floorTokensOf({ minOutputBytes: s.settings.minOutputBytes, math });
	const footprint = spillFootprint(s.spillDir);
	// The outer max stated in the bytes it buys, and pi's own content figure
	// named beside it: the two differ by the notice allowance, and `status` is
	// where a user finds out what the extension actually caps at.
	const outerBytes = bytesFromTokens(s.settings.maxOutputTokens, math);
	const piBytes = PI_MAX_OUTPUT_BYTES + PI_NOTICE_SLACK_BYTES;
	return [
		`output-limits: ${s.settings.enabled && !envDisabled() ? "on" : "off"}`,
		`tools: ${s.settings.tools.join(", ")}`,
		`Bound: shareOfHeadroom=${s.settings.shareOfHeadroom}, minOutputBytes=${s.settings.minOutputBytes} (${formatBytes(s.settings.minOutputBytes)} ~${formatTokens(floorTokens)}), maxOutputTokens=${s.settings.maxOutputTokens} (${formatBytes(outerBytes)} ~${formatTokens(s.settings.maxOutputTokens)}; pi's own cut is ${formatBytes(PI_MAX_OUTPUT_BYTES)} of content plus its notice, ${formatBytes(piBytes)} here)`,
		`token math: bytesPerChar ${s.settings.bytesPerChar}, inflation ${s.settings.inflation}, maxLines ${maxLinesText(s.settings.maxLines)}`,
		headroom.known
			? `Headroom: ${formatTokens(headroom.tokens)} = window ${formatTokens(headroom.effectiveWindow)} - reserve ${formatTokens(headroom.reserveTokens)} - used ${formatTokens(headroom.usedTokens)}`
			: "Headroom: blind, no usage to read, so results keep pi's own figures",
		s.lastBound
			? `last Bound: ${s.lastBound.toolName} ${formatBytes(s.lastBound.bytes)} (${formatTokens(s.lastBound.tokens)})`
			: "last Bound: none yet",
		`batch: ${describeBatch(s)}`,
		`Spill: ${s.cuts.calls} cut${s.cuts.calls === 1 ? "" : "s"}, ${formatBytes(s.cuts.droppedBytes)} dropped, ${footprint.files} file(s) ${formatBytes(footprint.bytes)} in ${displayPath(s.agentDir, s.spillDir)}`,
		// The tripwire the review asked for. A cut whose Bound had already reached
		// the outer max was not caused by the window: a ceiling did it, which is
		// the one state this extension must never be in. Every cut of an open
		// session used to land here silently.
		// The tripwire the review asked for. A cut whose Bound had already reached
		// the outer max was not caused by the window: a ceiling did it, and that is
		// the one state this extension must never be in. Every cut of an open
		// session used to land here silently.
		`ceiling cuts: ${s.ceilingCuts} cut(s) bound by maxOutputTokens or maxLines rather than by the Headroom${s.ceilingCuts === 0 ? " (as intended)" : " -- a ceiling is cutting what pi blessed"}`,
		`sweep at start: removed ${s.sweep.removed} file(s), freed ${formatBytes(s.sweep.bytesFreed)}; limits ${formatBytes(s.settings.spill.maxTotalBytes)} and ${s.settings.spill.maxAgeDays} day(s)`,
	].join("\n");
}

/**
 * The `maxLines` setting as `status` states it. `null` is the default and means
 * each tool's own figure from pi, which is two different answers across the
 * five tools, so the line names both rather than inventing one.
 */
function maxLinesText(maxLines: number | null): string {
	if (maxLines !== null) return String(maxLines);
	const tools = Object.keys(PI_CUT_POLICIES);
	const capped = tools.filter((tool) => !noLineCeiling(lineCeilingOf(tool, null)));
	const uncapped = tools.filter((tool) => noLineCeiling(lineCeilingOf(tool, null)));
	const figures = capped.map((tool) => `${tool} ${lineCeilingOf(tool, null)}`).join("/");
	return `pi's own per tool: ${figures}${uncapped.length > 0 ? `, ${uncapped.join("/")} none` : ""}`;
}

function describeBatch(s: OutputLimitsState): string {
	const entry = s.ledger.latest();
	if (!entry) return "no batch seen yet";
	const calls = entry.calls > 0 ? `${entry.calls} call(s)` : "call count unread";
	if (entry.headroomTokens === 0) {
		// Every call so far was blind, so the batch has no allowance yet: it is
		// open, and it takes its baseline from the first call that reads one.
		return `${calls}, blind so far: no allowance set, ${formatTokens(entry.admittedTokens)} admitted`;
	}
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
	// carry across it (ADR 0026, accepted cost). A model switch also changes
	// which `compaction.modelOverrides` entry, if any, answers for the reserve.
	pi.on("session_compact", async () => state?.ledger.invalidate());
	pi.on("model_select", async (event, ctx) => {
		// `event.model` is the model pi just switched to; `ctx.model` is not
		// promised to have moved yet in the same tick.
		if (state) state.reserveTokens = readReserveTokens(ctx.cwd, process.env, piModelKey(event.model));
		state?.ledger.invalidate();
	});
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
		`outputLimits.maxLines=${settings.maxLines ?? "auto"}`,
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
	if (key === "maxLines") {
		// `auto` is the default and the only way back to it from a number: it
		// writes null, which the reader reads as "each tool's own figure from pi".
		if (raw === "auto" || raw === "null") patch.maxLines = null;
		else if (!Number.isInteger(Number(raw)) || Number(raw) <= 0) return `outputLimits.maxLines must be a positive integer or auto, got: ${raw}`;
		else patch.maxLines = Number(raw);
		return;
	}	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return `outputLimits.${key} must be a positive number, got: ${raw}`;
	switch (key) {
		case "maxOutputTokens":
			if (!Number.isInteger(value)) return "outputLimits.maxOutputTokens must be an integer";
			patch.maxOutputTokens = value;
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
