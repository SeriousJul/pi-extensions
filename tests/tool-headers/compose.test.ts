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

function makeContext(state: object, lastComponent: unknown) {
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
	} as never;
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
});
