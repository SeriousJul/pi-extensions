/**
 * Output limits core (pure): the Headroom, the Bound, and the cut.
 *
 * This module owns the math and nothing else: no pi runtime, no file system,
 * no clock. The two byte cutters are injected, so the wiring hands over pi's
 * own `truncateHead` and `truncateTail` and the cut keeps pi's exact
 * semantics (complete lines only, whichever limit lands first, with pi's one
 * tail edge case) without this module importing pi at all. That is the same
 * seam shape `pruning/core.ts` uses for its estimates.
 *
 * Units, stated once. The Bound is named in tokens and enforced in bytes.
 * The conversion is the extension's own conservative estimate,
 * `ceil(bytes * inflation / bytesPerChar)`, which is pi's chars/4 estimate
 * times the Inflation factor: the correction that catches multi-byte text,
 * where pi's estimate runs three to four times low, and code by about 18
 * percent (ADR 0026). Because the Bound is named in one unit and enforced in
 * the other, the byte budget is the inverse conversion,
 * `floor(tokens * bytesPerChar / inflation)`, rounded down so the estimate
 * never says a cut fits when it does not.
 *
 * Where the spec's `clamp(shareOfHeadroom x Headroom, minOutputBytes,
 * maxOutputTokens)` meets the per-batch rule (decision 8): the Headroom share
 * is the allowance for one assistant message, the Ledger divides what is left
 * of that allowance by the calls still to come, and the clamp lands on the
 * per-call Bound. That holds both invariants at once: the Bound is a share of
 * the Headroom, and no call is ever bounded above pi's own per-call figure.
 *
 * The one-directional rule, stated once here and covering BOTH units: no Bound
 * rises above what pi itself published for that result, in bytes or in lines.
 * pi cuts its content to `PI_MAX_OUTPUT_BYTES` and `PI_MAX_OUTPUT_LINES` and
 * then appends its own notice, so what pi published sits past both figures by
 * that notice, and the extension's outer max is pi's figure plus the slack in
 * whichever unit it names (`PI_NOTICE_SLACK_BYTES`, `PI_NOTICE_SLACK_LINES`).
 * The line half of the rule is per tool as well, because pi's line figure is:
 * it cuts bash and read by line and cuts grep, find, and ls by bytes alone
 * (`lineCeilingOf`).
 */

/** pi's own per-call byte figure, `core/tools/truncate.ts` DEFAULT_MAX_BYTES. */
export const PI_MAX_OUTPUT_BYTES = 50 * 1024;

/** pi's own per-call line figure, `core/tools/truncate.ts` DEFAULT_MAX_LINES. */
export const PI_MAX_OUTPUT_LINES = 2000;

/**
 * pi's own sentinel for "no line limit", the figure `grep`, `find`, and `ls`
 * hand `truncateHead` because their match, result, and entry limits already
 * cap the rows and only the byte limit is left to bind. It is pi's number, not
 * this extension's invention, so a patched `details.truncation.maxLines` says
 * exactly what pi would have said for the same result.
 */
export const PI_NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * What pi adds past its own content cut, in each of the two units: the notice
 * it appends after truncating, for example "[Showing lines 11-2010 of 5000
 * (50.0KB limit). Full output: /tmp/pi-bash-1f2e.log]", which is one blank line
 * and one notice line on top of a content figure it has already filled. The
 * outer max in each unit is pi's content figure plus this slack, for the reason
 * the header states: without the allowance this extension re-cuts output pi had
 * already blessed.
 */
export const PI_NOTICE_SLACK_BYTES = 1024;
export const PI_NOTICE_SLACK_LINES = 2;

/**
 * pi's own cut policy for the tools in scope: the end its cutter keeps, and
 * the line figure it cuts at. Only bash and read cut by line; grep, find, and
 * ls hand their cutter `PI_NO_LINE_LIMIT` (ADR 0026, the one-directional
 * rule), so a line ceiling on those three would bind below pi for a
 * reason that has nothing to do with the context window. The ceiling is charged
 * per tool for exactly that reason, and `DIRECTIONS` in the wiring is read off
 * this table so the two cannot drift.
 */
export const PI_CUT_POLICIES: Record<string, { direction: CutDirection; maxLines: number }> = {
	bash: { direction: "tail", maxLines: PI_MAX_OUTPUT_LINES },
	read: { direction: "head", maxLines: PI_MAX_OUTPUT_LINES },
	grep: { direction: "head", maxLines: PI_NO_LINE_LIMIT },
	find: { direction: "head", maxLines: PI_NO_LINE_LIMIT },
	ls: { direction: "head", maxLines: PI_NO_LINE_LIMIT },
};

/**
 * The line ceiling one call enforces.
 *
 * `configured` is the `maxLines` setting, or `null` when the user named none,
 * which is the default and means: pi's own figure for this tool, lifted by the
 * notice allowance so a result pi blessed is admitted untouched. A figure the
 * user does name applies to every bounded tool, because then the ceiling is a
 * choice rather than a mirror of pi.
 */
export function lineCeilingOf(toolName: string, configured: number | null): number {
	if (configured !== null && Number.isFinite(configured)) return configured;
	const policy = PI_CUT_POLICIES[toolName];
	if (!policy) return PI_MAX_OUTPUT_LINES + PI_NOTICE_SLACK_LINES;
	return piLineCeiling(policy.maxLines);
}

/** pi's own line figure as the model received it: content plus its notice. */
function piLineCeiling(contentLines: number): number {
	return contentLines >= PI_NO_LINE_LIMIT ? contentLines : contentLines + PI_NOTICE_SLACK_LINES;
}

/**
 * Whether one line ceiling cuts nothing at all, so a caller can say "none"
 * instead of printing pi's internal sentinel as if it were a figure the user
 * could set. `Number.MAX_SAFE_INTEGER` is a real ceiling; it is just not one
 * any tool result reaches.
 */
export function noLineCeiling(maxLines: number): boolean {
	return maxLines >= PI_NO_LINE_LIMIT;
}

/**
 * The charge for one image block. pi counts an image as 4800 characters in
 * its own estimate (`ESTIMATED_IMAGE_CHARS` in
 * `core/compaction/compaction.ts`); the extension charges the same figure in
 * bytes so it keeps pi's scale and picks up the Inflation correction. Images
 * are charged and never cut, because pi normalizes image blocks after the
 * hook runs, so there is nothing here to cut them into.
 */
export const IMAGE_CHARGE_BYTES = 4800;

/** The default outer max: pi's own per-call figure, plus pi's own notice. */
export const DEFAULT_MAX_OUTPUT_TOKENS = tokensFromBytes(PI_MAX_OUTPUT_BYTES + PI_NOTICE_SLACK_BYTES, { bytesPerChar: 4, inflation: 2 });

/** A tool result content block, structurally pi's TextContent. */
export interface TextBlock {
	type: "text";
	text: string;
}

/** A tool result content block, structurally pi's ImageContent. */
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/** The record pi's `truncateHead` and `truncateTail` return. */
export interface CutResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

/** One of pi's byte cutters. */
export type Cutter = (content: string, options: { maxLines?: number; maxBytes?: number }) => CutResult;

export interface Cutters {
	head: Cutter;
	tail: Cutter;
}

/** The two knobs of the byte-to-token estimate. */
export interface TokenMath {
	bytesPerChar: number;
	inflation: number;
}

/** Bytes to tokens: pi's chars/4 estimate times the Inflation factor. */
export function tokensFromBytes(bytes: number, math: TokenMath): number {
	if (bytes <= 0) return 0;
	return Math.ceil((bytes * math.inflation) / math.bytesPerChar);
}

/** Tokens to bytes: the inverse of `tokensFromBytes`, rounded down. */
export function bytesFromTokens(tokens: number, math: TokenMath): number {
	if (tokens <= 0) return 0;
	return Math.floor((tokens * math.bytesPerChar) / math.inflation);
}

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

/**
 * The Headroom, or blind. Blind is what happens with no resolved window and
 * right after a compaction that has no usage yet: `ctx.getContextUsage()`
 * returns nothing, or returns a null token count.
 */
export type Headroom =
	| { known: false }
	| { known: true; tokens: number; effectiveWindow: number; reserveTokens: number; usedTokens: number };

export interface HeadroomInput {
	/** The Effective window: pi's model window, heal and cap included. */
	effectiveWindow: number | undefined;
	/** pi's compaction.reserveTokens, read from pi's own settings. */
	reserveTokens: number;
	/** The context tokens pi reports, or nothing when pi reports none. */
	usedTokens: number | null | undefined;
}

/** Headroom = Effective window - pi's reserveTokens - the usage pi reports. */
export function computeHeadroom(input: HeadroomInput): Headroom {
	const window = input.effectiveWindow;
	if (window === undefined || !Number.isFinite(window) || window <= 0) return { known: false };
	if (input.usedTokens === undefined || input.usedTokens === null || !Number.isFinite(input.usedTokens)) return { known: false };
	const tokens = Math.max(0, Math.floor(window - input.reserveTokens - input.usedTokens));
	return { known: true, tokens, effectiveWindow: window, reserveTokens: input.reserveTokens, usedTokens: input.usedTokens };
}

// ---------------------------------------------------------------------------
// Bound
// ---------------------------------------------------------------------------

export interface BoundSettings {
	/** The share of the Headroom one assistant message may spend. */
	shareOfHeadroom: number;
	/** The per-call floor, in bytes: a call is never cut below it. */
	minOutputBytes: number;
	/** The per-call outer max, in tokens. Defaults to pi's own figure. */
	maxOutputTokens: number;
	/** The per-call line max, or `null` for this tool's own figure from pi. */
	maxLines: number | null;
	/** The byte-to-token estimate knobs. */
	math: TokenMath;
}

export interface BoundInput {
	/** The tool this Bound is for: it decides the line ceiling. */
	toolName: string;
	headroom: Headroom;
	settings: BoundSettings;
	/** What the Ledger says is left of the message allowance, in tokens. */
	remainingAllowanceTokens: number;
	/** The calls this message still has to spend, this one included. */
	remainingCalls: number;
}

/** One call's Bound, with the numbers the notice, `details`, and status use. */
export interface Bound {
	/** True when there was no Headroom to read. */
	blind: boolean;
	/** The per-call Bound, in tokens. */
	tokens: number;
	/** The per-call Bound, in bytes: what the cut enforces. */
	bytes: number;
	/** The per-call floor in tokens, from `minOutputBytes`. */
	floorTokens: number;
	/** The per-call line max the cut enforces. */
	maxLines: number;
}

/**
 * The `BoundSettings` for the knobs a settings section names, so the wiring
 * does not restate the shape and the two cannot drift. `maxLines` stays `null`
 * when the user named none: the line ceiling is a per-tool figure, so it is
 * resolved per call by `computeBound`, not here.
 */
export function boundSettingsOf(input: {
	shareOfHeadroom: number;
	minOutputBytes: number;
	maxOutputTokens: number;
	maxLines: number | null;
	bytesPerChar: number;
	inflation: number;
}): BoundSettings {
	return {
		shareOfHeadroom: input.shareOfHeadroom,
		minOutputBytes: input.minOutputBytes,
		maxOutputTokens: input.maxOutputTokens,
		maxLines: input.maxLines,
		math: { bytesPerChar: input.bytesPerChar, inflation: input.inflation },
	};
}

/**
 * The whole message allowance: the share of the Headroom one assistant message
 * may spend, lifted to the floor so a call is never starved by a clamp that
 * contradicts the floor.
 *
 * This is the per-message figure the Ledger opens a batch on and then divides,
 * so the wiring and the Bound cannot state it differently: `computeBound` takes
 * the remainder of it from the Ledger rather than recomputing it. A blind
 * Headroom has no allowance to divide yet: it reads 0, which tells the Ledger to
 * open the batch unbaselined rather than to freeze it at the outer max (see
 * `ledger.ts`).
 */
export function messageAllowanceTokens(headroom: Headroom, settings: BoundSettings): number {
	if (!headroom.known) return 0;
	return Math.max(floorTokensOf(settings), Math.floor(headroom.tokens * settings.shareOfHeadroom));
}

/** The per-call floor, in tokens, from the byte figure settings name. */
export function floorTokensOf(settings: Pick<BoundSettings, "minOutputBytes" | "math">): number {
	return Math.max(1, tokensFromBytes(settings.minOutputBytes, settings.math));
}

/**
 * The Bound for one call: the part of the message allowance still unspent,
 * divided by the calls still to come, clamped to the floor and the outer max.
 *
 * Blind: the Bound is `maxOutputTokens` and the enforced byte budget is
 * unbounded, because with no Headroom there is nothing to bound downward
 * against. A blind call therefore passes whatever pi produced, exactly like
 * pi today.
 *
 * The line ceiling comes from the tool, not from the Headroom: see
 * `lineCeilingOf`. It is resolved here so there is one source for it.
 */
export function computeBound(input: BoundInput): Bound {
	const settings = input.settings;
	const floorTokens = floorTokensOf(settings);
	const maxLines = lineCeilingOf(input.toolName, settings.maxLines);
	if (!input.headroom.known) {
		return {
			blind: true,
			tokens: settings.maxOutputTokens,
			bytes: Number.POSITIVE_INFINITY,
			floorTokens,
			maxLines,
		};
	}
	const remainingCalls = Math.max(1, Math.trunc(input.remainingCalls));
	const share = Math.max(0, input.remainingAllowanceTokens) / remainingCalls;
	const tokens = Math.max(floorTokens, Math.min(Math.floor(share), settings.maxOutputTokens));
	return {
		blind: false,
		tokens,
		bytes: bytesFromTokens(tokens, settings.math),
		floorTokens,
		maxLines,
	};
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** UTF-8 byte length of one block; an image carries pi's fixed charge. */
export function blockBytes(block: ContentBlock): number {
	if (block.type === "image") return IMAGE_CHARGE_BYTES;
	return Buffer.byteLength(block.text, "utf8");
}

/** The byte size of a whole result, images charged at their fixed figure. */
export function measureBlocks(blocks: readonly ContentBlock[]): number {
	let bytes = 0;
	for (const block of blocks) bytes += blockBytes(block);
	return bytes;
}

/**
 * Complete lines in a text. A trailing newline is a line terminator, not an
 * extra empty line, which is how pi's own counter works.
 */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lines += 1;
	}
	if (text.endsWith("\n")) lines -= 1;
	return lines;
}

/** The text lines of a whole result. Image blocks carry no lines. */
export function countResultLines(blocks: readonly ContentBlock[]): number {
	let lines = 0;
	for (const block of blocks) {
		if (block.type === "text") lines += countLines(block.text);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// pi's continuation notice, which only read has
// ---------------------------------------------------------------------------

/**
 * pi's trailing continuation notice, as `core/tools/read.ts` writes it:
 * `[Showing lines 41-411 of 9000. Use offset=412 to continue.]`, or the
 * `(50.0KB limit)` variant, or `[312 more lines in file. Use offset=412 to
 * continue.]`. Only read has one, and read is bounded without a Spill, so a
 * Bound that cuts read has to rewrite this line to its own smaller cut
 * (decision 11) rather than leave a stale offset in front of the model.
 */
const READ_NOTICE = /\n*\[([^\n]*)\]\s*$/;

export interface ReadNotice {
	/** The text with pi's continuation notice removed. */
	body: string;
	/** The first line pi showed, 1-indexed, when the notice named one. */
	startLine: number | undefined;
	/** True when a continuation notice was found and removed. */
	removed: boolean;
}

/**
 * Split pi's continuation notice off a read result, when there is one. A
 * trailing notice that carries no `Use offset=` (pi's "this line is too big"
 * fallback, which points at a bash command instead) stays where it is: there
 * is nothing to continue to, so rewriting it would invent an offset this
 * extension cannot know.
 */
export function splitReadNotice(text: string): ReadNotice {
	const match = READ_NOTICE.exec(text);
	if (!match) return { body: text, startLine: undefined, removed: false };
	const inner = match[1];
	if (!/\bUse offset=\d+ to continue\./.test(inner)) return { body: text, startLine: undefined, removed: false };
	const shown = /Showing lines (\d+)-\d+/.exec(inner);
	return { body: text.slice(0, match.index), startLine: shown ? Number(shown[1]) : undefined, removed: true };
}

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

export type CutDirection = "head" | "tail";

export interface CutInput {
	blocks: readonly ContentBlock[];
	/** The whole byte budget for the Admitted text, notices included. */
	budgetBytes: number;
	/** The line budget for the Admitted text. */
	maxLines: number;
	/** pi's own direction for this tool: tail for bash, head for the rest. */
	direction: CutDirection;
	cutters: Cutters;
	/** The one-line pointer that replaces a dropped text block. */
	pointer: string;
	/** The notice line the wiring appends when a cut runs. */
	notice: string;
	/**
	 * When set, pi's own continuation notice comes off the text first and the
	 * appended notice replaces it. Only read does this.
	 */
	rewriteReadNotice?: boolean;
}

/** One block of a planned result. */
export type PlannedBlock =
	| { kind: "keep"; text: string }
	| { kind: "image"; block: ImageBlock }
	| { kind: "cut"; text: string; cut: CutResult }
	| { kind: "pointer" };

export interface CutPlan {
	/** True when the result fits and nothing was cut. */
	fits: boolean;
	/** The planned blocks, in the original order. Never collapsed. */
	blocks: PlannedBlock[];
	/** Bytes of result text dropped, pointer and notice excluded. */
	droppedBytes: number;
	/** Lines of result text dropped, pointer and notice excluded. */
	droppedLines: number;
	/** The cut that produced the crossing block, or null when none ran. */
	cut: CutResult | null;
	/** Complete text lines kept, excluding pointer and notice lines. */
	keptLines: number;
	/** Bytes the kept blocks cost, excluding pointer and notice lines. */
	keptBytes: number;
	/** The line a rewritten read continuation starts from, 1-indexed. */
	readStartLine: number | undefined;
}

/**
 * Fit a result inside its budget, and prove it did.
 *
 * `cutBlocks` reserves the notice and the pointer lines before it cuts, but
 * the reservation is only as exact as the line count the cutter kept: a cut
 * that lands on a line boundary can leave the published text a little over or
 * under a figure. So the published result is rendered, measured in BOTH of its
 * units, bytes and lines, and the budget is tightened by whatever overflowed,
 * until the result really is inside its Bound in both or no further tightening
 * can help. This is what makes the Bound a promise rather than an estimate.
 */
export function cutToBudget(input: CutInput): CutPlan {
	let budgetBytes = input.budgetBytes;
	let budgetLines = input.maxLines;
	let plan = cutBlocks({ ...input, budgetBytes, maxLines: budgetLines });
	for (let pass = 0; pass < 8; pass += 1) {
		if (plan.fits) return plan;
		const published = measurePublished(plan, input.pointer, input.notice);
		const overBytes = published.bytes - input.budgetBytes;
		const overLines = published.lines - input.maxLines;
		if (overBytes <= 0 && overLines <= 0) return plan;
		// Tighten the axis that overflowed, and always make progress on it: a
		// budget that cannot shrink would otherwise spin. The extra byte and line
		// is the slack between what the cutter counted and what the rendered
		// notice costs. An axis that did not overflow is left alone, because
		// shaving a ceiling nothing crossed only cuts content for nothing.
		const nextBytes = overBytes > 0 ? Math.max(0, budgetBytes - Math.ceil(overBytes) - 1) : budgetBytes;
		const nextLines = overLines > 0 ? Math.max(0, budgetLines - Math.ceil(overLines) - 1) : budgetLines;
		if (nextBytes >= budgetBytes && nextLines >= budgetLines) return plan;
		budgetBytes = nextBytes;
		budgetLines = nextLines;
		plan = cutBlocks({ ...input, budgetBytes, maxLines: budgetLines });
	}
	return plan;
}

/**
 * The blocks a plan publishes: every kept block in order, the pointers that
 * replace dropped text, and the notice appended to the crossing block.
 *
 * This is the Admitted text, so it is what the budget is measured against and
 * what the wiring hands pi. Keeping the render in one place is what lets
 * `cutToBudget` verify the size of the thing it is promising.
 */
export function renderPlan(plan: CutPlan, pointer: string, notice: string): ContentBlock[] {
	const out: ContentBlock[] = [];
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
				out.push({ type: "text", text: notice.length > 0 ? `${block.text}\n\n${notice}` : block.text });
				noticePlaced = true;
				break;
			case "keep":
				out.push({ type: "text", text: block.text });
				break;
		}
	}
	// A result whose kept blocks are all images, or all pointers, has nowhere
	// to carry the notice, so the line travels as its own block.
	if (!noticePlaced && notice.length > 0) out.push({ type: "text", text: notice });
	return out;
}

/**
 * Replace one path with another through a result's text.
 *
 * The one live-path rule the notices have to obey: when the extension moves
 * pi's own throwaway log into the Spill directory, the path pi named inside its
 * notice stops existing, and a model that follows it gets "No such file". So
 * the path in the text is rewritten to the Spill it now points at, and the
 * rewrite happens before any measuring so the Bound is charged for the bytes
 * the longer path costs.
 */
export function rewriteSpillPath(blocks: readonly ContentBlock[], from: string, to: string): { blocks: ContentBlock[]; changed: boolean } {
	if (from.length === 0 || from === to) return { blocks: [...blocks], changed: false };
	let changed = false;
	const out: ContentBlock[] = [];
	for (const block of blocks) {
		if (block.type === "image" || !block.text.includes(from)) {
			out.push(block);
			continue;
		}
		out.push({ type: "text", text: block.text.split(from).join(to) });
		changed = true;
	}
	return { blocks: out, changed };
}

/**
 * The exact size of what a plan publishes: the rendered Admitted text, notice
 * and pointers included, in bytes and in lines.
 */
export function measurePublished(plan: CutPlan, pointer: string, notice: string): { bytes: number; lines: number } {
	const rendered = renderPlan(plan, pointer, notice);
	return { bytes: measureBlocks(rendered), lines: countResultLines(rendered) };
}

/**
 * Fit a result inside its budget.
 *
 * Blocks are walked in the direction the tool keeps, so the surviving end is
 * the end pi keeps: bash keeps its tail, and read, grep, find, and ls keep
 * their head. The block where the budget runs out is cut inside it; every
 * text block past it becomes one fixed pointer line. Image blocks are kept
 * whole and charged. The result is never collapsed into a single block
 * (decision 16).
 *
 * The notice and the pointer lines are reserved before the cut runs, so the
 * Admitted text lands inside the Bound with its notices counted, which is
 * what the glossary means by "Admitted text". Use `cutToBudget` to have that
 * reservation verified after the fact.
 */
export function cutBlocks(input: CutInput): CutPlan {
	// The pass-through question, asked before any notice exists: a result
	// that fits inside the Bound is published exactly as pi produced it, with
	// nothing appended and nothing spilled.
	if (fitsWithinBudget(input.blocks, input.budgetBytes, input.maxLines)) {
		return { ...planFrom(input, undefined), fits: true };
	}

	// Prepare the blocks. read's continuation notice comes off the end first,
	// because the Bound's own line replaces it and pi's would then state an
	// offset that no longer points at anything.
	const sources: ContentBlock[] = [];
	let readStartLine: number | undefined;
	for (const block of input.blocks) {
		if (input.rewriteReadNotice && block.type === "text") {
			const split = splitReadNotice(block.text);
			if (split.removed) {
				if (split.startLine !== undefined) readStartLine = split.startLine;
				sources.push({ type: "text", text: split.body });
				continue;
			}
		}
		sources.push(block);
	}
	// Stripping pi's notice may have closed the gap on its own: the notice is
	// text the model does not need twice.
	const prepared: CutInput = { ...input, blocks: sources };
	if (fitsWithinBudget(sources, prepared.budgetBytes, prepared.maxLines)) {
		// Stripping pi's notice closed the gap on its own, so no byte of real
		// content was dropped and pi's own continuation line is still exactly
		// true. The plan therefore keeps pi's blocks, that line included, and
		// `fits` is the whole promise. A caller that published the stripped body
		// instead would hand the model a read result with no pointer at all, and
		// read is bounded without a Spill, so pi's line is the only recovery
		// there is: publishing it would be the one way this extension can lose
		// text outright. The admitted cost is at most pi's own notice past the
		// Bound, which is the same allowance the outer max already carries.
		return { ...planFrom(input, readStartLine), fits: true };
	}

	// Reserve the notice, with the blank line the wiring appends ahead of it,
	// plus one pointer for every text block but one: with more than one block
	// the worst case is that all of them but the crossing block are dropped.
	// Over-reserving is the safe direction, and the common shape (one text
	// block) reserves the notice alone.
	const pointerBytes = Buffer.byteLength(input.pointer, "utf8");
	const textBlocks = sources.filter((block) => block.type === "text").length;
	const reserve = Buffer.byteLength(input.notice, "utf8") + (input.notice.length > 0 ? 2 : 0) + (textBlocks > 1 ? (textBlocks - 1) * pointerBytes : 0);
	let leftBytes = Math.max(0, input.budgetBytes - reserve);
	let leftLines = input.maxLines;

	const order: number[] = [];
	for (let i = 0; i < sources.length; i += 1) order.push(i);
	if (input.direction === "tail") order.reverse();

	const decided = new Map<number, PlannedBlock>();
	let cut: CutResult | null = null;
	let spent = false;
	let droppedBytes = 0;
	let droppedLines = 0;
	let keptBytes = 0;
	let keptLines = 0;

	for (const index of order) {
		const block = sources[index];
		if (block.type === "image") {
			// Charged against the Bound, never cut: pi normalizes image
			// blocks after this hook, so there is no smaller image to write.
			const charge = blockBytes(block);
			leftBytes = Math.max(0, leftBytes - charge);
			decided.set(index, { kind: "image", block });
			keptBytes += charge;
			continue;
		}
		if (spent) {
			droppedBytes += Buffer.byteLength(block.text, "utf8");
			droppedLines += countLines(block.text);
			decided.set(index, { kind: "pointer" });
			continue;
		}
		const bytes = Buffer.byteLength(block.text, "utf8");
		const lines = countLines(block.text);
		if (bytes <= leftBytes && lines <= leftLines) {
			decided.set(index, { kind: "keep", text: block.text });
			leftBytes -= bytes;
			leftLines -= lines;
			keptBytes += bytes;
			keptLines += lines;
			continue;
		}
		// The crossing block: cut inside it, at this tool's own direction.
		const cutter = input.direction === "tail" ? input.cutters.tail : input.cutters.head;
		const result = cutter(block.text, { maxBytes: Math.max(0, Math.floor(leftBytes)), maxLines: Math.max(0, Math.floor(leftLines)) });
		cut = result;
		decided.set(index, { kind: "cut", text: result.content, cut: result });
		const keptOfBlock = Buffer.byteLength(result.content, "utf8");
		keptBytes += keptOfBlock;
		keptLines += result.outputLines;
		droppedBytes += Math.max(0, bytes - keptOfBlock);
		droppedLines += Math.max(0, lines - result.outputLines);
		spent = true;
		leftBytes = 0;
		leftLines = 0;
	}

	const blocks: PlannedBlock[] = [];
	for (let i = 0; i < sources.length; i += 1) {
		const plan = decided.get(i);
		if (plan) {
			blocks.push(plan);
			continue;
		}
		const block = sources[i];
		blocks.push(block.type === "image" ? { kind: "image", block } : { kind: "keep", text: block.text });
	}
	return { fits: false, blocks, droppedBytes, droppedLines, cut, keptLines, keptBytes, readStartLine };
}

/**
 * The blocks a plan would publish, without the notice and pointer lines.
 * Used to ask whether a result fits before its notices have a number to
 * state, which is the pass-through question: a result that fits inside the
 * Bound is published exactly as pi produced it, with nothing appended.
 */
export function fitsWithinBudget(blocks: readonly ContentBlock[], budgetBytes: number, maxLines: number): boolean {
	return measureBlocks(blocks) <= budgetBytes && countResultLines(blocks) <= maxLines;
}

/** A plan for blocks that need no content cut: every block kept as arrived. */
function planFrom(input: CutInput, readStartLine: number | undefined): CutPlan {
	return {
		fits: true,
		blocks: input.blocks.map((block) => (block.type === "image" ? { kind: "image", block } : { kind: "keep", text: block.text })),
		droppedBytes: 0,
		droppedLines: 0,
		cut: null,
		keptLines: countResultLines(input.blocks),
		keptBytes: measureBlocks(input.blocks),
		readStartLine,
	};
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** The facts one notice line states. */
export interface NoticeFacts {
	/** The Bound this call enforced, in bytes. */
	boundBytes: number;
	/** The Bound this call enforced, in tokens. */
	boundTokens: number;
	/** The Headroom the allowance came from, in tokens. */
	headroomTokens: number;
	/** The calls this assistant message asked for. */
	calls: number;
	/** read's rewritten continuation, when read was cut. */
	continueOffset: number | undefined;
	/** The Spill path, as the notice shows it. */
	displayPath: string | undefined;
}

/**
 * The appended notice line. pi's own notice stays ahead of it, because it
 * remains true, and this line adds the real numbers (decision 22).
 *
 * A spilling tool's line ends with the Spill path. read's ends with pi's own
 * continuation, rewritten to the smaller cut.
 */
export function buildNotice(facts: NoticeFacts): string {
	const head = `capped to ${formatBytes(facts.boundBytes)} (${formatTokens(facts.boundTokens)} tokens) of the ${formatTokens(facts.headroomTokens)} token headroom`;
	const calls = facts.calls > 1 ? ` left for this message (${facts.calls} calls)` : "";
	const tail = facts.continueOffset !== undefined
		? `; use offset=${facts.continueOffset} to continue`
		: facts.displayPath
			? `; full output: ${facts.displayPath}`
			: "";
	return `[output-limits: ${head}${calls}${tail}]`;
}

/** The one-line pointer that replaces a dropped later text block. */
export function buildPointer(displayPath: string | undefined): string {
	return displayPath ? `[output-limits: text dropped, full output: ${displayPath}]` : "[output-limits: text dropped]";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Bytes as pi names them, with the needless `.0` dropped: `8KB`, `512B`. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return "unbounded";
	if (bytes < 1024) return `${Math.round(bytes)}B`;
	if (bytes < 1024 * 1024) return `${trimNumber(bytes / 1024)}KB`;
	return `${trimNumber(bytes / (1024 * 1024))}MB`;
}

/** Tokens the way this repo names them: `800`, `4.1k`, `16k`. */
export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) return "unbounded";
	if (tokens >= 1000) return `${trimNumber(tokens / 1000)}k`;
	return String(Math.round(tokens));
}

function trimNumber(value: number): string {
	const text = value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}
