/**
 * Unit tests that pin the Tool row header composition (issue #137, ADR 0038).
 *
 * `wrapToolRenderers` is the whole resolver: it calls `next()` first (here
 * passed in as `inner`), spreads the result, and prepends the header to the
 * call line. These tests pin the composition rules without a live pi:
 * `renderShell` from `next()` is preserved, the wrapped renderer receives its
 * own component back as `context.lastComponent` on the second render, a
 * `next()` of `undefined` yields `undefined`, and a tool with no renderer
 * gains a header above its stock call line.
 */
import { describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";

import { wrapToolRenderers } from "../../extensions/tool-headers/index.ts";

/** A theme that emits no escape codes, so the painted text is plain. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

/** A one-line inner component the wrapped renderer stands in for. */
function fakeComponent(lines: string[] = ["inner-line"]): Component {
	return { render: () => lines, invalidate: () => {} } as unknown as Component;
}

function makeContext(state: object, lastComponent: unknown, overrides: object = {}) {
	return {
		args: {},
		toolCallId: "t1",
		invalidate: () => {},
		lastComponent,
		state,
		cwd: ".",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	} as never;
}

/** A theme that records the background colors it is asked to paint. */
function recordingTheme() {
	const bgs: Array<{ color: string; text: string }> = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (color: string, text: string) => {
			bgs.push({ color, text });
			return text;
		},
	} as never;
	return { theme, bgs };
}

describe("wrapToolRenderers", () => {
	it("returns undefined when next() returns undefined, leaving the row to pi", () => {
		expect(wrapToolRenderers("unknown-tool", undefined)).toBeUndefined();
	});

	it("preserves renderShell from next(), so edit keeps its self shell", () => {
		const wrapped = wrapToolRenderers("edit", {
			renderShell: "self",
			renderCall: () => fakeComponent(),
		} as never);
		expect(wrapped).not.toBeUndefined();
		expect(wrapped!.renderShell).toBe("self");
	});

	it("hands the wrapped renderer its own component as lastComponent on the second render", () => {
		const inner = fakeComponent();
		const seen: unknown[] = [];
		const wrapped = wrapToolRenderers("bash", {
			renderCall: (_args: unknown, _theme: unknown, context: { lastComponent: unknown }) => {
				seen.push(context.lastComponent);
				return inner;
			},
		} as never);
		const state: object = {};
		// First render: pi has no previous component to pass.
		const first = wrapped!.renderCall!({}, theme, makeContext(state, undefined)) as Component;
		// Second render: pi passes back the component the renderer returned.
		const second = wrapped!.renderCall!({}, theme, makeContext(state, first)) as Component;
		expect(seen[0]).toBeUndefined();
		expect(seen[1]).toBe(inner); // the renderer's own component, not the wrapper
		expect(first).not.toBe(inner); // what pi receives is the wrapper
		expect(second).toBe(first); // the wrapper is reused across renders
	});

	it("adds the header above the stock call line when the tool has no renderer", () => {
		const wrapped = wrapToolRenderers("tool_search", {} as never);
		expect(wrapped).not.toBeUndefined();
		expect(wrapped!.renderCall).toBeDefined();
		expect(wrapped!.renderResult).toBeUndefined();
		const component = wrapped!.renderCall!({ jobId: "jb-1" }, theme, makeContext({}, undefined)) as Component;
		const lines = component.render(60);
		expect(lines[0]).toContain("tool_search"); // the header line
		expect(lines[1].trim()).toBe('tool_search jobId="jb-1"'); // pi's stock call line
	});

	it("paints a self-shell header from the row state when the inner component carries no edit state", () => {
		const { theme: recTheme, bgs } = recordingTheme();
		const wrapped = wrapToolRenderers("edit", {
			renderShell: "self",
			renderCall: () => fakeComponent(["edit line"]),
		} as never);
		const component = wrapped!.renderCall!({}, recTheme, makeContext({}, undefined)) as Component;
		const lines = component.render(40);
		// Settled, not an error: the success background spans the whole line,
		// starting one cell in, like the shell-box rows' header. The blank
		// line ahead of the rule is the padding pi's shell box paints above
		// the other rows' headers; the self-shell container paints none.
		expect(lines[0]).toBe(" ".repeat(40));
		expect(lines[1]).toBe(` ── edit ${"─".repeat(31)}`);
		expect(bgs).toEqual([
			{ color: "toolSuccessBg", text: " ".repeat(40) },
			{ color: "toolSuccessBg", text: lines[1] },
		]);
		expect(lines[2]).toBe("edit line"); // the tool's own lines keep their own framing
	});

	it("follows the edit box's preview state: header and body share one background", () => {
		const { theme: recTheme, bgs } = recordingTheme();
		// The stand-in keeps pi's edit box state shape on itself.
		const box = {
			preview: undefined as undefined | { diff?: string; error?: string },
			settledError: false,
			render: () => ["body-line"],
			invalidate: () => {},
		};
		const wrapped = wrapToolRenderers("edit", {
			renderShell: "self",
			renderCall: () => box as unknown as Component,
		} as never);
		const state: object = {};
		const component = wrapped!.renderCall!({}, recTheme, makeContext(state, undefined)) as Component;
		component.render(40); // no preview yet: the pending color, like the body
		box.preview = { diff: "-foo\n+baz" };
		wrapped!.renderCall!({}, recTheme, makeContext(state, undefined));
		component.render(40); // the preview lands: green before the result does
		box.preview = { error: "text not found" };
		wrapped!.renderCall!({}, recTheme, makeContext(state, undefined));
		component.render(40); // a preview error: red
		box.preview = undefined;
		box.settledError = true;
		wrapped!.renderCall!({}, recTheme, makeContext(state, undefined));
		component.render(40); // a settled execution error without a preview: red
		// Each render paints two lines - the padding line and the rule - both
		// in the shared state color.
		expect(bgs.map((b) => b.color)).toEqual([
			"toolPendingBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolSuccessBg",
			"toolErrorBg",
			"toolErrorBg",
			"toolErrorBg",
			"toolErrorBg",
		]);
	});

	it("paints no background for a shell-box row, whose shell box carries it", () => {
		const { theme: recTheme, bgs } = recordingTheme();
		const wrapped = wrapToolRenderers("bash", { renderCall: () => fakeComponent(["$ ls"]) } as never);
		const component = wrapped!.renderCall!({}, recTheme, makeContext({}, undefined)) as Component;
		const lines = component.render(40);
		expect(lines[0]).toBe(`── bash ${"─".repeat(32)}`); // no indent, no background
		expect(bgs).toEqual([]);
	});
});
