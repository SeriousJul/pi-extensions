/**
 * TUI view for the initial-context breakdown. A row table with per-row
 * token counts, percentages, and bars; expandable rows show the exact
 * text; copy puts the row (or the whole breakdown) on the clipboard.
 *
 * Keys: j/k (or up/down) move or scroll, e expands and collapses,
 * c copies, esc/q closes.
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

const INT = new Intl.NumberFormat("en-US");

/** Dependencies injected so the view stays testable. */
export interface ContextTuiDeps {
	tui: TUI;
	theme: Theme;
	report: InitialContextReport;
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

	const paneHeight = (): number => Math.max(3, Math.min(12, deps.viewport() - 6));

	const expandedLines = (width: number): string[] => {
		const row = rows[cursor];
		if (!row) return [];
		return wrapText(row.text, Math.max(8, width - 4));
	};

	const render = (width: number): string[] => {
		lastWidth = width;
		const lines: string[] = [];

		lines.push(accent("initial context"));
		lines.push(dim(formatStatusText(report.totalTokens, report.windowPercent)));
		lines.push("");

		const maxLabel = Math.max("TOTAL".length, ...rows.map((row) => rowLabel(row).length));
		const labelWidth = Math.min(Math.max(8, Math.floor(width * 0.4)), maxLabel);
		const tokenWidth = Math.max(
			4,
			INT.format(report.totalTokens).length,
			...rows.map((row) => INT.format(row.tokens).length),
		);
		const window = report.contextWindow;

		const rowLine = (row: InitialContextRow | "TOTAL", index: number): string => {
			const isTotal = row === "TOTAL";
			const label = isTotal ? "TOTAL" : rowLabel(row);
			const tokens = isTotal ? report.totalTokens : row.tokens;
			const marker = !isTotal && index === cursor ? (expanded ? "\u25be" : "\u25b8") : " ";
			const ctxPct = report.totalTokens > 0 ? `${((tokens / report.totalTokens) * 100).toFixed(1)}%` : "0.0%";
			const winPct = window && window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : "-";
			const bar = barFor(report.totalTokens > 0 ? (tokens / report.totalTokens) * 100 : 0);
			const line =
				`${marker} ${label.slice(0, labelWidth).padEnd(labelWidth)}  ` +
				`${INT.format(tokens).padStart(tokenWidth)}  ${ctxPct}  ${winPct}` +
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
		lines.push(dim(`j/k move  e expand  c copy  esc/q close${copied ? "  copied" : ""}`));

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

	return { render, handleInput, invalidate };
}
