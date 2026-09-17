/**
 * TUI tests for the initial-context view: rendering, cursor movement,
 * expand/collapse with scrolling, copy, and close. Uses a fake theme and a
 * fake TUI, so the tests run without a terminal.
 */
import { describe, expect, it } from "vitest";
import { buildInitialContext, emptyCaptured, type InitialContextReport } from "../../extensions/initial-context/context.ts";
import { createContextTui, wrapText, type ContextTuiComponent } from "../../extensions/initial-context/tui.ts";
import type { ToolUsageSource, ToolUsageWindow } from "../../extensions/initial-context/tool-usage.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const baseOptions = {
	cwd: "/tmp/project",
	appendSystemPrompt: "Always test.",
	contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Project instructions here." }],
	skills: [],
} as const;

const fakeTheme: Theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

interface Rig {
	component: ContextTuiComponent;
	copied: string[];
	closed: { count: number };
	rendered: () => string[];
	usage: ToolUsageSource;
}

export function makeFakeUsage(opts: { counts?: Record<string, number>; phase?: "scanning" | "ready" } = {}): ToolUsageSource {
	let window: ToolUsageWindow = "30d";
	const listeners = new Set<() => void>();
	return {
		get window() {
			return window;
		},
		setWindow(next: ToolUsageWindow): void {
			window = next;
			for (const l of [...listeners]) l();
		},
		counts: async () => ({ window, counts: opts.counts ?? {}, files: 1, scanned: 0 }),
		snapshot: () =>
			opts.phase === "scanning"
				? { phase: "scanning" as const, window, scanned: 0, files: 4 }
				: { phase: "ready" as const, window, counts: opts.counts ?? {}, files: 4, scanned: 4 },
		subscribe: (fn: () => void) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
}

function makeRig(report: InitialContextReport, usage: ToolUsageSource = makeFakeUsage({ counts: { bash: 3, read: 5 } })): Rig {
	const rig: Rig = {
		component: undefined as unknown as ContextTuiComponent,
		copied: [],
		closed: { count: 0 },
		rendered: () => {
			throw new Error("render not called");
		},
		usage,
	};
	const tui = {
		terminal: { rows: 40, columns: 120 },
		requestRender: () => {},
	};
	rig.component = createContextTui({
		tui: tui as never,
		theme: fakeTheme,
		report,
		usage,
		copy: async (text) => {
			rig.copied.push(text);
		},
		viewport: () => 12,
		close: () => {
			rig.closed.count += 1;
		},
	});
	rig.rendered = () => rig.component.render(120);
	return rig;
}

function fixtureReport(): InitialContextReport {
	const captured = emptyCaptured();
	captured.providerInputTokens = 44900;
	return buildInitialContext(
		{ ...baseOptions, contextFiles: [...baseOptions.contextFiles], appendSystemPrompt: baseOptions.appendSystemPrompt } as never,
		captured,
		200000,
	);
}

const key = (name: "down" | "up" | "enter" | "escape"): string => {
	return name === "down" ? "\u001b[B" : name === "up" ? "\u001b[A" : name === "enter" ? "\r" : "\u001b";
};

describe("initial context TUI", () => {
	it("renders the header, rows, total, reference, and legend", () => {
		const rig = makeRig(fixtureReport());
		const lines = rig.rendered();
		expect(lines[0]).toBe("initial context");
		expect(lines[1]).toMatch(/^ctx: .+ \(\d+\.\d%\) - uses: 30d$/);
		expect(lines).toContain("j/k move  e expand  c copy  w window  esc/q close");
		const baseLine = lines.find((l) => l.includes("base prompt")) as string;
		expect(baseLine).toContain("builtin");
		expect(lines.some((l) => l.includes("append text"))).toBe(true);
		expect(lines.some((l) => l.includes("cwd"))).toBe(true);
		expect(lines.some((l) => l.includes("provider report (first call): 44,900 input tokens"))).toBe(true);
		const total = lines.find((l) => l.includes("TOTAL")) as string;
		expect(total).toContain("100.0%");
		// Bars are present on the data rows.
		expect(lines.filter((l) => l.includes("█")).length).toBeGreaterThan(3);
	});

	it("shows the uses and waste columns: counts on tool rows, tokens per use, the never mark, dashes on sections", () => {
		const rig = makeRig(fixtureReport());
		const lines = rig.rendered();
		// Section rows carry no count and no waste value; dashes sit where the
		// columns are.
		const baseLine = lines.find((l) => l.includes("base prompt")) as string;
		expect(baseLine).toMatch(/  -  + -  █/);
		// Tool rows show their call count and the derived waste: tokens per
		// use for a tool the window saw (bash 3, read 5), the never mark for
		// one it did not (edit, write 0).
		const bashLine = lines.find((l) => /\bbash\b/.test(l)) as string;
		expect(bashLine).toMatch(/ 3  +[\d,.]+\/u(  █+)?$/);
		const readLine = lines.find((l) => /\bread\b/.test(l)) as string;
		expect(readLine).toMatch(/ 5  +[\d,.]+\/u(  █+)?$/);
		const editLine = lines.find((l) => /\bedit\b/.test(l)) as string;
		expect(editLine).toMatch(/ 0  +never(  █+)?$/);
		// TOTAL sums the tool calls and carries no waste value.
		const total = lines.find((l) => l.includes("TOTAL")) as string;
		expect(total).toMatch(/ 8  +-  █/);
	});

	it("w cycles the usage window 30d -> 90d -> all", () => {
		const rig = makeRig(fixtureReport());
		rig.component.handleInput("w");
		expect(rig.usage.window).toBe("90d");
		rig.component.handleInput("w");
		expect(rig.usage.window).toBe("all");
		rig.component.handleInput("w");
		expect(rig.usage.window).toBe("30d");
		expect(rig.rendered()[1]).toContain("uses: 30d");
	});

	it("shows counting status and dashes while the scan runs", () => {
		const rig = makeRig(fixtureReport(), makeFakeUsage({ phase: "scanning" }));
		const lines = rig.rendered();
		expect(lines[1]).toContain("counting usage 0/4");
		const bashLine = lines.find((l) => l.includes("bash")) as string;
		expect(bashLine).toContain("  - ");
	});

	it("dispose stops the usage subscription from re-rendering", () => {
		let renders = 0;
		const usage = makeFakeUsage({ counts: { bash: 3 } });
		const component = createContextTui({
			tui: { requestRender: () => renders++ } as never,
			theme: fakeTheme,
			report: fixtureReport(),
			usage,
			copy: async () => {},
			viewport: () => 12,
			close: () => {},
		});
		usage.setWindow("90d");
		expect(renders).toBe(1);
		component.dispose();
		usage.setWindow("all");
		expect(renders).toBe(1);
	});

	it("moves the cursor with j and k and marks the cursor row", () => {
		const rig = makeRig(fixtureReport());
		const first = rig.rendered();
		expect(first.some((l) => l.startsWith("\u25b8"))).toBe(true);
		rig.component.handleInput("j");
		const second = rig.rendered();
		// The marker moved to the next row.
		const marked = second.map((l, i) => (l.startsWith("\u25b8") ? i : -1)).filter((i) => i >= 0);
		const markedBefore = first.map((l, i) => (l.startsWith("\u25b8") ? i : -1)).filter((i) => i >= 0);
		expect(marked[0]).toBe(markedBefore[0] + 1);
		rig.component.handleInput("k");
		expect(rig.rendered().map((l) => (l.startsWith("\u25b8") ? 1 : 0)).indexOf(1)).toBe(markedBefore[0]);
		// The cursor never leaves the table.
		rig.component.handleInput("k");
		rig.component.handleInput("k");
		const clamped = rig.rendered();
		expect(clamped.filter((l) => l.startsWith("\u25b8")).length).toBe(1);
	});

	it("expands a row to the exact text and collapses again", () => {
		const rig = makeRig(fixtureReport());
		rig.component.handleInput("e");
		const lines = rig.rendered();
		expect(lines.some((l) => l.startsWith("\u25be"))).toBe(true);
		// The expanded base prompt text is visible, wrapped.
		expect(lines.some((l) => l.includes("You are an expert coding assistant operating inside pi"))).toBe(true);
		expect(lines.some((l) => l.includes("e to collapse"))).toBe(true);
		// Enter also collapses.
		rig.component.handleInput(key("enter"));
		expect(rig.rendered().some((l) => l.startsWith("\u25be"))).toBe(false);
	});

	it("scrolls the expanded pane with j and k", () => {
		const rig = makeRig(fixtureReport());
		rig.component.handleInput("e");
		const before = rig.rendered();
		const indicator = before.find((l) => /\[\d+-\d+ of \d+ lines/.test(l)) as string;
		expect(indicator).toMatch(/\[\d+-\d+ of \d+ lines/);
		const firstBefore = indicator.match(/\[(\d+)-/)?.[1];
		rig.component.handleInput("j");
		rig.component.handleInput("j");
		const after = rig.rendered();
		const indicatorAfter = after.find((l) => /\[\d+-\d+ of \d+ lines/.test(l)) as string;
		const firstAfter = indicatorAfter.match(/\[(\d+)-/)?.[1];
		expect(Number(firstAfter)).toBe(Number(firstBefore) + 2);
		// Scrolling up clamps at the top.
		rig.component.handleInput("k");
		rig.component.handleInput("k");
		rig.component.handleInput("k");
		const clamped = rig.rendered().find((l) => /\[\d+-\d+ of \d+ lines/.test(l)) as string;
		expect(clamped).toMatch(/\[1-/);
	});

	it("copies the whole breakdown, and the row text when expanded", async () => {
		const rig = makeRig(fixtureReport());
		rig.component.handleInput("c");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(rig.copied).toHaveLength(1);
		expect(rig.copied[0]).toMatch(/^initial context: [\d,]+ tokens/);
		expect(rig.copied[0]).toContain("provider report (first call): 44,900 input tokens");
		expect(rig.rendered().some((l) => l.includes("copied"))).toBe(true);

		rig.component.handleInput("e");
		rig.component.handleInput("c");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(rig.copied).toHaveLength(2);
		// The expanded row is the base prompt.
		expect(rig.copied[1].startsWith("You are an expert coding assistant operating inside pi")).toBe(true);
		expect(rig.closed.count).toBe(0);
	});

	it("closes on escape and q", () => {
		const rig = makeRig(fixtureReport());
		rig.component.handleInput(key("escape"));
		expect(rig.closed.count).toBe(1);
		rig.component.handleInput("q");
		expect(rig.closed.count).toBe(2);
	});

	it("ignores unknown keys", () => {
		const rig = makeRig(fixtureReport());
		const before = rig.rendered();
		rig.component.handleInput("x");
		rig.component.handleInput("c"); // copy is allowed
		const after = rig.rendered();
		expect(after.filter((l, i) => l !== before[i]).length).toBeLessThanOrEqual(1);
	});
});

describe("wrapText", () => {
	it("wraps long lines at word boundaries and keeps blank lines", () => {
		const lines = wrapText("aa bb cc dd ee ff gg\n\nshort", 10);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
		expect(lines.join("\n")).toBe("aa bb cc\ndd ee ff\ngg\n\nshort");
	});

	it("hard-breaks words longer than the width", () => {
		const lines = wrapText("x".repeat(25), 10);
		expect(lines).toEqual(["x".repeat(10), "x".repeat(10), "xxxxx"]);
	});
});
