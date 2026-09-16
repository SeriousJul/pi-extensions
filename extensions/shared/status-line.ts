/**
 * Shared footer status line for pi-extensions (issue: footer layout).
 *
 * Pi renders one footer line for all extension statuses: the entries are
 * sorted by key and joined with a single space, left-aligned. Three of this
 * package's extensions want a different shape: ctx on the left, quota and
 * sync on the right, in the column above the provider/model text, and the
 * plain text in the footer's dim color (pi's chrome color), while semantic
 * colors (the sync arrows, quota FULL) keep their theme colors.
 *
 * This module owns the line. Extensions register a *piece* with a group
 * (left/right) instead of calling ctx.ui.setStatus; the module composes all
 * pieces into one line and publishes it under a single status key.
 *
 * Two pi constraints shape the implementation:
 * - The footer collapses ASCII space runs in status text, so the right
 *   alignment pad is built from no-break spaces (width 1, not collapsed).
 * - The footer pads and truncates at the TUI width, which pi resolves as
 *   process.stdout.columns || COLUMNS || 80 (the bun runtime reports 0 for
 *   columns). This module uses the same formula, so the pad always lines up
 *   with pi's own footer math.
 * - The footer's chrome is dimmed per part, because a color reset would
 *   clear an outer dim wrap. Here the line is wrapped in the dim code and
 *   every inner reset is re-asserted as dim, so plain text reads dim and
 *   colored segments keep their color.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export type StatusGroup = "left" | "right";

/** The single status key that carries the composed line. */
const OWNER_KEY = "pi-extensions";
/** Minimum visible gap between the left and the right group. */
const MIN_GAP = 2;
/** ASCII spaces are collapsed by the footer; NBSP is not. */
const PAD_CHAR = "\u00A0";
/** The foreground reset pi's theme.fg appends. */
const FG_RESET = "\x1b[39m";

interface Piece {
	text: string;
	group: StatusGroup;
}

interface LineState {
	pieces: Map<string, Piece>;
	/** The status key the composed line currently lives under. */
	publishedKey: string | undefined;
	/** The newest context, used for resize repaints. */
	ctx: ExtensionContext | undefined;
	resizeWired: boolean;
}

const STATE_KEY = Symbol.for("pi-extensions/status-line");

function state(): LineState {
	const global = globalThis as Record<symbol, LineState | undefined>;
	if (!global[STATE_KEY]) {
		global[STATE_KEY] = { pieces: new Map(), publishedKey: undefined, ctx: undefined, resizeWired: false };
	}
	return global[STATE_KEY]!;
}

/** Clear all pieces and the published line. For tests. */
export function resetStatusLine(): void {
	state().pieces.clear();
}

function groupText(pieces: Map<string, Piece>, group: StatusGroup): string {
	return [...pieces.entries()]
		.filter(([, piece]) => piece.group === group)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, piece]) => piece.text)
		.join(" ");
}

/** Compose the line, or undefined when no piece is present. */
function compose(pieces: Map<string, Piece>): string | undefined {
	const left = groupText(pieces, "left");
	const right = groupText(pieces, "right");
	if (left === "" && right === "") return undefined;
	if (left === "" || right === "") return left === "" ? right : left;
	// The same width pi's footer pads and truncates at.
	const width = process.stdout.columns || Number(process.env.COLUMNS) || 80;
	if (!Number.isFinite(width) || width <= 0) return `${left} ${right}`;
	const gap = Math.max(MIN_GAP, width - visibleWidth(left) - visibleWidth(right));
	return left + PAD_CHAR.repeat(gap) + right;
}

/** Dim the plain parts of the line; colored segments keep their color. */
function dimLine(ctx: ExtensionContext, line: string): string {
	const dim = ctx.ui.theme.fg("dim", "").replace(FG_RESET, "");
	return dim + line.split(FG_RESET).join(dim) + FG_RESET;
}

/** Repaint after a terminal resize. Wired once, on the first publish. */
function wireResize(s: LineState): void {
	if (s.resizeWired || typeof process.stdout.on !== "function" || !process.stdout.isTTY) return;
	s.resizeWired = true;
	process.stdout.on("resize", () => {
		if (s.ctx) publish(s.ctx);
	});
}

/** Republish the composed line from the current pieces. */
export function publish(ctx: ExtensionContext): void {
	const s = state();
	s.ctx = ctx;
	if (!ctx.hasUI) return;
	wireResize(s);
	const line = compose(s.pieces);
	if (line === undefined) {
		if (s.publishedKey !== undefined) ctx.ui.setStatus(s.publishedKey, undefined);
		s.publishedKey = undefined;
		return;
	}
	ctx.ui.setStatus(OWNER_KEY, ctx.mode === "tui" ? dimLine(ctx, line) : line);
	s.publishedKey = OWNER_KEY;
}

/**
 * Register (or clear, with undefined) one extension's piece and republish.
 * The piece text may carry theme colors; plain text is dimmed on publish.
 */
export function setPiece(ctx: ExtensionContext, key: string, group: StatusGroup, text: string | undefined): void {
	const s = state();
	if (text === undefined) s.pieces.delete(key);
	else s.pieces.set(key, { text, group });
	publish(ctx);
}
