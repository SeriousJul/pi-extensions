/**
 * TUI view for the initial-context breakdown. A row table with per-row
 * token counts, percentages, bars, and the tool's call count in the usage
 * window; expandable rows show the exact text; copy puts the row (or the
 * whole breakdown) on the clipboard.
 *
 * Keys: j/k (or up/down) move or scroll, e expands and collapses,
 * c copies, w cycles the usage window, esc/q closes.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	barFor,
	formatStatusText,
	renderContextText,
	rowLabel,
	type InitialContextReport,
	type InitialContextRow,
} from "./context.ts";
import { TOOL_USAGE_WINDOWS, usesForLabel, type ToolUsageSource } from "./tool-usage.ts";

const INT = new Intl.NumberFormat("en-US");

/** Dependencies injected so the view stays testable. */
export interface ContextTuiDeps {
	tui: TUI;
	theme: Theme;
	report: InitialContextReport;
	/** The live tool usage source: window, counts, and change events. */
	usage: ToolUsageSource;
	/** Copy text to the clipboard. Errors are swallowed by the view. */
	copy: (text: string) => Promise<void>;
	/** How many table rows fit in the viewport right now. */
	viewport: () => number;
	/** Close the dialog. */
	close: () => void;
}

export interface ContextTuiComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	/** Drop the usage subscription. Call when the dialog closes. */
	dispose(): void;
}

/** Word-wrap text to a fixed width for the expand pane. */
export function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length <= width) {
			out.push(line);
			continue;
		}
		let rest = line;
		while (rest.length > width) {
			let cut = rest.lastIndexOf(" ", width);
			if (cut <= 0) cut = width;
			out.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^ /, "");
		}
		out.push(rest);
	}
	return out;
}

export function createContextTui(deps: ContextTuiDeps): ContextTuiComponent {
	const { theme, tui, report } = deps;
	const dim = (text: string): string => theme.fg("dim", text);
	const accent = (text: string): string => theme.fg("accent", text);
	const rows = report.rows;

	let cursor = 0;
	let expanded = false;
	let scroll = 0;
	let copied = false;
	let lastWidth = 80;
	let disposed = false;
	const unsubscribe = deps.usage.subscribe(() => {
		if (!disposed) tui.requestRender();
	});

	const readyCounts = (): Record<string, number> | undefined => {
		const snapshot = deps.usage.snapshot();
		return snapshot.phase === "ready" ? (snapshot.counts ?? {}) : undefined;
	};

	const paneHeight = (): number => Math.max(3, Math.min(12, deps.viewport() - 6));

	const expandedLines = (width: number): string[] => {
		const row = rows[cursor];
		if (!row) return [];
		const out: string[] = [];
		const snapshot = deps.usage.snapshot();
		if (row.kind === "tool" && snapshot.phase === "ready") {
			const counts = snapshot.counts ?? {};
			out.push(`uses (${snapshot.window}): ${usesForLabel(row.label, row.kind, counts) ?? 0}`);
			if (row.label === "mcp") {
				const subs = Object.entries(counts)
					.filter(([key]) => key.startsWith("mcp:"))
					.sort((a, b) => b[1] - a[1]);
				for (const [key, n] of subs) out.push(`${key.slice("mcp:".length).padEnd(24)} ${INT.format(n)}`);
			}
		}
		out.push(...wrapText(row.text, Math.max(8, width - 4)));
		return out;
	};

	const render = (width: number): string[] => {
		lastWidth = width;
		const lines: string[] = [];

		const usage = deps.usage.snapshot();
		const counts = readyCounts();

		lines.push(accent("initial context"));
		const suffix =
			usage.phase === "ready"
				? ` - uses: ${usage.window}`
				: usage.phase === "scanning"
					? ` - counting usage${usage.scanned !== undefined && usage.files !== undefined ? ` ${usage.scanned}/${usage.files}` : ""}`
				: ` - usage: error`;
		lines.push(dim(formatStatusText(report.totalTokens, report.windowPercent) + suffix));
		lines.push("");

		const maxLabel = Math.max("TOTAL".length, ...rows.map((row) => rowLabel(row).length));
		const labelWidth = Math.min(Math.max(8, Math.floor(width * 0.4)), maxLabel);
		const sourceWidth = Math.max(3, ...rows.map((row) => row.source.length));
		const tokenWidth = Math.max(
			4,
			INT.format(report.totalTokens).length,
			...rows.map((row) => INT.format(row.tokens).length),
		);
		const window = report.contextWindow;

		const usesText = (row: InitialContextRow): string =>
			counts !== undefined ? String(usesForLabel(row.label, row.kind, counts) ?? "-") : "-";
		const usesWidth = Math.max(4, ...rows.map((row) => usesText(row).length));
		let totalUses = 0;
		for (const row of rows) {
			if (row.kind === "tool") totalUses += usesForLabel(row.label, row.kind, counts ?? {}) ?? 0;
		}

		const rowLine = (row: InitialContextRow | "TOTAL", index: number): string => {
			const isTotal = row === "TOTAL";
			const label = isTotal ? "TOTAL" : rowLabel(row);
			const source = isTotal ? "" : row.source;
			const tokens = isTotal ? report.totalTokens : row.tokens;
			const marker = !isTotal && index === cursor ? (expanded ? "\u25be" : "\u25b8") : " ";
			const ctxPct = report.totalTokens > 0 ? `${((tokens / report.totalTokens) * 100).toFixed(1)}%` : "0.0%";
			const winPct = window && window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : "-";
			const uses = isTotal ? (counts !== undefined ? INT.format(totalUses) : "-") : usesText(row);
			const bar = barFor(report.totalTokens > 0 ? (tokens / report.totalTokens) * 100 : 0);
			const line =
				`${marker} ${label.slice(0, labelWidth).padEnd(labelWidth)}  ${source.padEnd(sourceWidth)}  ` +
				`${INT.format(tokens).padStart(tokenWidth)}  ${ctxPct}  ${winPct}  ${uses.padStart(usesWidth)}` +
				(bar ? `  ${bar}` : "");
			return isTotal ? dim(line.trimEnd()) : line.trimEnd();
		};

		const pane = expanded ? expandedLines(width) : [];
		const paneH = pane.length > 0 ? paneHeight() : 0;
		const room = Math.max(1, deps.viewport() - paneH - (pane.length > 0 ? 1 : 0));
		const top = Math.max(0, Math.min(Math.max(0, cursor - room + 1), Math.max(0, rows.length - room)));

		rows.forEach((row, index) => {
			if (index < top || index >= top + room) return;
			lines.push(rowLine(row, index));
			if (index === cursor && expanded && pane.length > 0) {
				const visible = pane.slice(scroll, scroll + paneH);
				for (const textLine of visible) lines.push(`  ${dim(textLine)}`);
				const first = scroll + 1;
				const last = scroll + visible.length;
				lines.push(dim(`  [${first}-${last} of ${pane.length} lines \u00b7 e to collapse]`));
			}
		});

		lines.push(rowLine("TOTAL", -1));
		if (report.providerInputTokens !== undefined) {
			lines.push(dim(`provider report (first call): ${INT.format(report.providerInputTokens)} input tokens`));
		}
		lines.push("");
		lines.push(dim(`j/k move  e expand  c copy  w window  esc/q close${copied ? "  copied" : ""}`));

		return lines;
	};

	const doCopy = async (): Promise<void> => {
		const row = rows[cursor];
		const text = expanded && row ? row.text : renderContextText(report);
		try {
			await deps.copy(text);
			copied = true;
			tui.requestRender();
			setTimeout(() => {
				copied = false;
				tui.requestRender();
			}, 2000);
		} catch {
			// Clipboard unavailable; the view stays open.
		}
	};

	const handleInput = (data: string): void => {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			deps.close();
			return;
		}
		if (data === "c" || data === "C") {
			void doCopy();
			return;
		}
		if (data === "w" || data === "W") {
			const next = TOOL_USAGE_WINDOWS[(TOOL_USAGE_WINDOWS.indexOf(deps.usage.window) + 1) % TOOL_USAGE_WINDOWS.length];
			deps.usage.setWindow(next);
			return; // the usage subscription re-renders
		}
		if (expanded) {
			const pane = expandedLines(lastWidth);
			const paneH = paneHeight();
			if (matchesKey(data, "down") || data === "j") {
				scroll = Math.min(Math.max(0, pane.length - paneH), scroll + 1);
			} else if (matchesKey(data, "up") || data === "k") {
				scroll = Math.max(0, scroll - 1);
			} else if (data === "e" || data === "E" || matchesKey(data, "enter")) {
				expanded = false;
				scroll = 0;
			} else {
				return;
			}
		} else {
			if (matchesKey(data, "down") || data === "j") {
				cursor = Math.min(rows.length - 1, cursor + 1);
			} else if (matchesKey(data, "up") || data === "k") {
				cursor = Math.max(0, cursor - 1);
			} else if (data === "e" || data === "E" || matchesKey(data, "enter")) {
				expanded = true;
				scroll = 0;
			} else {
				return;
			}
		}
		tui.requestRender();
	};

	const invalidate = (): void => {
		// Static report; nothing to recompute.
	};

	const dispose = (): void => {
		disposed = true;
		unsubscribe();
	};

	return { render, handleInput, invalidate, dispose };
}
