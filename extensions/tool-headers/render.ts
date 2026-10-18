/**
 * Tool row headers display module: the header line and the fallback call
 * line (issue #137, ADR 0038).
 *
 * Pure and engine-free: it knows no theme object and no pi API. The header
 * is the tool name set in a rule, one line above the call line. The rule is
 * `borderMuted`, the name is bold `toolTitle`; the name carries nothing
 * else, and the rule is exactly one row at any width. Self-shell headers
 * add one blank background line ahead of the rule. The extension wiring
 * (index.ts) applies the theme and builds the component, so the exact line
 * is unit tested here.
 */

/** The least of a theme the header and the fallback call line need. The
 * real Theme satisfies it structurally, so the wiring passes it through
 * without a cast. */
export interface ToolRowHeaderPainter {
	fg: (color: "toolTitle" | "borderMuted" | "muted", text: string) => string;
	bold: (text: string) => string;
	/** Paints the row's state background over full-width text. Present only on
	 * self-shell rows, which pi draws in a plain container that carries no
	 * background or padding: the header paints the same state colors pi's
	 * shell box would have applied, plus the box's blank padding line above
	 * the rule. */
	bg?: (text: string) => string;
}

const RULE = "─"; // U+2500, the character pi uses for its editor scroll border.
const PREFIX = "── "; // Two rule cells plus a space, ahead of the name.
const PREFIX_LEN = 3;

/**
 * The header line: `indent` spaces, then `── <name> ` filled with `─` to
 * the right edge of the area the painter is given, which is `width`.
 *
 * Shrinking spends the rule first, then the name: the trailing rule
 * collapses to zero (`── <name>`), and only if the name alone no longer
 * fits is the name truncated, ending in `…`. The name is the payload, so it
 * truncates last. The rule is always exactly one row.
 *
 * When the painter carries a `bg`, the line is padded to the full `width`
 * before the background is applied, so the state background reaches the box
 * edge on the shorter rule forms. The same painter also gets one more line
 * ahead: a blank line painted over the full `width`. Pi's shell box paints
 * that padding line above every other row's header; the self-shell row's
 * plain container paints none, so the header paints its own.
 */
export function paintToolRowHeader(
	displayName: string,
	width: number,
	paint: ToolRowHeaderPainter,
	indent = 0,
): string[] {
	const available = Math.max(0, width - indent);
	const line = paintRuleLine(displayName, available, paint);
	const prefix = " ".repeat(indent);
	if (!paint.bg) return [prefix + line];
	const padded = line + " ".repeat(Math.max(0, available - line.length));
	return [paint.bg(" ".repeat(width)), paint.bg(prefix + padded)];
}

/** The rule line itself: `── <name>` filled with `─` to `width` cells. */
function paintRuleLine(displayName: string, width: number, paint: ToolRowHeaderPainter): string {
	const nameLen = displayName.length;
	// `── <name> ` plus at least one rule cell: the full rule form.
	if (nameLen <= width - PREFIX_LEN - 2) {
		const fill = width - PREFIX_LEN - 1 - nameLen;
		return (
			paint.fg("borderMuted", RULE.repeat(2)) +
			" " +
			paint.fg("toolTitle", paint.bold(displayName)) +
			" " +
			paint.fg("borderMuted", RULE.repeat(fill))
		);
	}
	// The rule is gone; the name still fits after the prefix.
	if (nameLen <= width - PREFIX_LEN) {
		return paint.fg("borderMuted", RULE.repeat(2)) + " " + paint.fg("toolTitle", paint.bold(displayName));
	}
	// Truncate the name, keeping the ellipsis inside the width budget.
	const maxName = width - PREFIX_LEN;
	const truncated = displayName.slice(0, Math.max(0, maxName - 1)) + "…";
	return paint.fg("borderMuted", RULE.repeat(2)) + " " + paint.fg("toolTitle", paint.bold(truncated));
}

/**
 * The MCP header name: pi spells its tools `mcp__<server>__<tool>`; the
 * header drops that spelling and shows `server/tool`, the same form the
 * row's call line uses, so the two agree. Every other tool keeps its raw
 * name. The rule is pi's own, from its MCP extension.
 */
export function mcpDisplayName(toolName: string): string {
	const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
	return match ? `${match[1]}/${match[2]}` : toolName;
}

/**
 * The generic tool call line for a tool that ships no renderer of its own:
 * the bold title followed by the arguments, mirroring the shape pi's
 * fallback draws, so the row keeps its stock content and gains only the
 * header above it. Collapsed, the arguments are `key=value` pairs cut to
 * 100 cells; expanded, each is a `key: value` line below the title.
 */
export function formatFallbackCallLine(
	title: string,
	args: unknown,
	paint: ToolRowHeaderPainter,
	expanded: boolean,
): string {
	const header = paint.fg("toolTitle", paint.bold(title));
	if (args == null) return header;
	const entries = typeof args === "object" && !Array.isArray(args) ? (Object.entries(args) as [string, unknown][]) : [["args", args]];
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${paint.fg("muted", lines.join("\n"))}`;
	}
	const COLLAPSED_ARGS_CHARS = 100;
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${paint.fg("muted", preview)}`;
}
