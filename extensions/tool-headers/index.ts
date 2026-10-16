/**
 * Tool row headers (issue #137, ADR 0038).
 *
 * Every Tool row sits in the same green block, and the block says nothing
 * about which tool it holds: a `bash` and a `powershell` row print only
 * `$ <command>`, a `codemode` row a JSON blob. This extension draws one line
 * above each row's call line - the tool name set in a rule - so the tool is
 * told at a glance. The `bash` and `bash_bg` rows, identical in shape, are
 * the rows that carry the value: the header is what finally tells one from
 * the other (ADR 0024 keeps the `bash_bg` call line marker-free).
 *
 * The mechanism is a `pi.registerToolRenderer()` resolver that calls `next()`
 * first and wraps whatever pi or another extension would draw, prepending the
 * header. Wrapping reaches built-in tools, this package's tools, and MCP tools
 * through one path, and it composes with pi's MCP resolver instead of
 * shadowing it. The resolver never calls `pi.registerTool`: it changes a
 * picture, not an execution.
 *
 * Always on, with no setting and no command. It is a rendering opinion in a
 * personal package; the way to opt out is to not load the file.
 *
 * Self-shell rows (`renderShell: "self"`, today only `edit`) are drawn by pi
 * in a plain container that carries no background, so their header paints
 * that background itself. It follows the body's color: pi's edit box paints
 * its lines from its diff-preview state, and the header reads that same
 * state at paint time, so header and body always agree. A self-shell tool
 * without that state falls back to the row's pending/success/error color.
 * Every header starts one cell in, like the shell-box rows' headers.
 */
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

import {
	formatFallbackCallLine,
	mcpDisplayName,
	paintToolRowHeader,
	type ToolRowHeaderPainter,
} from "./render.ts";

/** The one line a row draws above its call line: the name in a rule. Rendered
 * at the box's content width, so the rule fills to the content edge. */
class HeaderLine implements Component {
	constructor(
		private readonly displayName: string,
		private readonly paint: ToolRowHeaderPainter,
		private readonly indent = 0,
	) {}
	render(width: number): string[] {
		return [paintToolRowHeader(this.displayName, width, this.paint, this.indent)];
	}
	invalidate(): void {}
}

/**
 * A row's content: the header line above the wrapped renderer's component.
 * Extends Container so mouse events forward to the inner component with the
 * header's one-line offset, and so click-to-expand (pi wraps the row in its
 * own MouseRegion) keeps working through the wrapper.
 */
class HeaderedComponent extends Container {
	private readonly header: HeaderLine;
	private inner: Component | undefined;

	constructor(
		displayName: string,
		paint: ToolRowHeaderPainter,
		indent = 0,
	) {
		super();
		this.header = new HeaderLine(displayName, paint, indent);
		this.addChild(this.header);
	}

	/** Swap the inner component, keeping the header first. */
	setInner(inner: Component): void {
		if (this.inner === inner) return;
		if (this.inner) this.removeChild(this.inner);
		this.inner = inner;
		this.addChild(inner);
	}
}

/** Per-row wrapper state, kept on pi's shared renderer state under one key.
 * The inner component is pi's own (the wrapped renderer's), handed back to it
 * as `lastComponent`; the wrapper is this extension's, returned to pi. */
const ROW_STATE_KEY = Symbol.for("pi-extensions.tool-headers.row");
interface RowState {
	inner?: Component;
	wrapper?: HeaderedComponent;
	/** The row state the header's background falls back to. Updated on every
	 * render, so a repaint after a state change repaints the background. */
	line?: { isPartial: boolean; isError: boolean };
}
function rowState(state: unknown): RowState {
	const holder = (state ?? {}) as Record<symbol, unknown>;
	const existing = holder[ROW_STATE_KEY] as RowState | undefined;
	if (existing) return existing;
	const created: RowState = {};
	holder[ROW_STATE_KEY] = created;
	return created;
}

/**
 * The wrapped renderer set for one tool: `next()`'s result, with a header
 * prepended to its call line. `renderShell` is preserved, so `edit` keeps its
 * self shell; `renderResult` is left untouched, so the row's result - and the
 * caches the result renderer owns - render exactly as pi would draw them.
 *
 * A self-shell row is drawn by pi in a plain container that carries no
 * background, so the header paints that background itself. It follows the
 * body's color: pi's edit box is the inner component, it keeps its diff
 * preview state on itself, and the header reads that state at paint time -
 * the same mapping pi's box uses - so header and body always share one
 * background. A self-shell tool without that state falls back to the row's
 * pending, success, and error colors. The header starts one cell in,
 * matching the shell-box rows' indent.
 */
export function wrapToolRenderers(toolName: string, inner: ToolRenderers | undefined): ToolRenderers | undefined {
	if (!inner) return undefined;
	const displayName = mcpDisplayName(toolName);
	const wrapped: ToolRenderers = { ...inner };
	const callRenderer = inner.renderCall;
	const selfShell = inner.renderShell === "self";
	wrapped.renderCall = (args, theme, context) => {
		const painter: ToolRowHeaderPainter = {
			fg: (color, text) => theme.fg(color, text),
			bold: (text) => theme.bold(text),
		};
		const entry = rowState(context.state);
		if (!entry.line) entry.line = { isPartial: true, isError: false };
		entry.line.isPartial = context.isPartial;
		entry.line.isError = context.isError;
		if (selfShell) {
			painter.bg = (text: string) => theme.bg(headerBgColor(entry), text);
		}
		let innerComponent: Component;
		if (callRenderer) {
			// Hand the wrapped renderer its own previous component, not the
			// wrapper: pi's built-in renderers setText on it, and the wrapper
			// would throw on the second render of a streaming call.
			innerComponent = callRenderer(args, theme, { ...context, lastComponent: entry.inner });
		} else {
			// No renderer of its own: keep the row's stock call line (the
			// shape pi's fallback draws) and add the header above it.
			const text = (entry.inner as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFallbackCallLine(toolName, args, painter, context.expanded));
			innerComponent = text;
		}
		entry.inner = innerComponent;
		if (!entry.wrapper) entry.wrapper = new HeaderedComponent(displayName, painter, selfShell ? 1 : 0);
		entry.wrapper.setInner(innerComponent);
		return entry.wrapper;
	};
	return wrapped;
}

/**
 * The self-shell header's background, read at paint time so it follows the
 * body within the same frame. pi's edit box keeps its state on itself:
 * once the diff preview lands it owns the color (green, or red on a preview
 * error), exactly as pi's box maps it; before that, or on a settled
 * execution error, its `settledError` flag does. Any other inner component
 * has neither field: the row's own state applies.
 */
function headerBgColor(entry: RowState): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	const inner = entry.inner as { preview?: unknown; settledError?: boolean } | undefined;
	const preview = inner?.preview;
	if (preview) return "error" in (preview as object) ? "toolErrorBg" : "toolSuccessBg";
	if (inner && typeof inner.settledError === "boolean") {
		return inner.settledError ? "toolErrorBg" : "toolPendingBg";
	}
	const row = entry.line!;
	return row.isPartial ? "toolPendingBg" : row.isError ? "toolErrorBg" : "toolSuccessBg";
}

export function registerToolHeaders(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => wrapToolRenderers(toolName, next()));
}

export default function (pi: ExtensionAPI): void {
	registerToolHeaders(pi);
}
