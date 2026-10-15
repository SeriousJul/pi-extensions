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
	) {}
	render(width: number): string[] {
		return [paintToolRowHeader(this.displayName, width, this.paint)];
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
	) {
		super();
		this.header = new HeaderLine(displayName, paint);
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
 */
export function wrapToolRenderers(toolName: string, inner: ToolRenderers | undefined): ToolRenderers | undefined {
	if (!inner) return undefined;
	const displayName = mcpDisplayName(toolName);
	const wrapped: ToolRenderers = { ...inner };
	const callRenderer = inner.renderCall;
	wrapped.renderCall = (args, theme, context) => {
		const painter: ToolRowHeaderPainter = {
			fg: (color, text) => theme.fg(color, text),
			bold: (text) => theme.bold(text),
		};
		const entry = rowState(context.state);
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
		if (!entry.wrapper) entry.wrapper = new HeaderedComponent(displayName, painter);
		entry.wrapper.setInner(innerComponent);
		return entry.wrapper;
	};
	return wrapped;
}

export function registerToolHeaders(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => wrapToolRenderers(toolName, next()));
}

export default function (pi: ExtensionAPI): void {
	registerToolHeaders(pi);
}
