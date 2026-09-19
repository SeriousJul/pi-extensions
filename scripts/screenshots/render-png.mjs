/**
 * Render a terminal screen to a deterministic PNG.
 *
 * The input is the exact byte stream a real terminal received (a full TUI
 * frame or captured PTY output). The stream is replayed into an
 * @xterm/headless terminal, the final cell grid is read, and each cell is
 * drawn into an SVG (one rect per background run, one text run per styled
 * run, one line per underline). resvg rasterizes the SVG with the pinned
 * font from look.mjs. resvg loads exactly the committed font files
 * (fontFiles is a list of file paths, system fonts disabled), and the
 * font-family in the SVG is the family name inside those files, so the
 * pixels come from the committed TTFs on every machine.
 *
 * Every choice is fixed: the grid size, the font, the font metrics, the
 * palette. Two runs over the same byte stream produce identical PNG bytes.
 */
import pkg from "@xterm/headless";
import resvgJs from "@resvg/resvg-js";

import { LOOK } from "./look.mjs";

const { Terminal } = pkg;
const { Resvg } = resvgJs;

/** xterm's default 16-color palette (vts-1.98 default theme). */
const PALETTE = [
	"#000000", "#cd3131", "#0dbc79", "#e5e510",
	"#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
	"#555555", "#f14c4c", "#23d18b", "#f5f543",
	"#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
];

/**
 * Replay the byte stream into a headless terminal and return the final
 * visible grid as cell objects. `data` is a string, Buffer, or Uint8Array.
 */
export async function screenToGrid(data, { cols = LOOK.cols, rows = LOOK.rows } = {}) {
	const term = new Terminal({ cols, rows, allowProposedApi: true });
	term.onData(() => {});
	// Resolve when the terminal has fully consumed the input, not after a
	// fixed sleep.
	await new Promise((resolve) => term.write(data, resolve));
	const active = term.buffer.active;
	const viewportY = active.viewportY;
	const grid = [];
	for (let y = 0; y < rows; y++) {
		const line = active.getLine(viewportY + y);
		const cells = [];
		for (let x = 0; x < cols; x++) {
			const cell = line.getCell(x);
			const ch = cell.getChars();
			let fg = null;
			if (cell.isFgRGB()) {
				fg = "#" + cell.getFgColor().toString(16).padStart(6, "0");
			} else if (cell.isFgPalette()) {
				fg = PALETTE[cell.getFgColor() & 0xff] ?? null;
			}
			let bg = null;
			if (cell.isBgRGB()) {
				bg = "#" + cell.getBgColor().toString(16).padStart(6, "0");
			}
			cells.push({
				ch,
				fg,
				bg,
				bold: Boolean(cell.isBold()),
				dim: Boolean(cell.isDim()),
				italic: Boolean(cell.isItalic()),
				underline: Boolean(cell.isUnderline()),
			});
		}
		grid.push(cells);
	}
	term.dispose();
	return grid;
}

/** Replay the byte stream and return the visible rows as plain text (for assertions). */
export async function screenToText(data, opts = {}) {
	const grid = await screenToGrid(data, opts);
	return grid.map((row) => row.map((cell) => cell.ch).join(""));
}

function escapeXml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build the SVG for one cell grid. Runs of one style collapse into a single
 * <text> element; runs of one background collapse into a single <rect>.
 */
export function gridToSvg(grid, look = LOOK) {
	const parts = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${look.widthPx}" height="${look.heightPx}" viewBox="0 0 ${look.widthPx} ${look.heightPx}">`,
	);
	parts.push(`<rect x="0" y="0" width="${look.widthPx}" height="${look.heightPx}" fill="${look.background}"/>`);

	for (let y = 0; y < grid.length; y++) {
		const row = grid[y];
		// Background runs first (under the text).
		let x = 0;
		while (x < row.length) {
			const bg = row[x].bg;
			if (!bg) {
				x++;
				continue;
			}
			let end = x + 1;
			while (end < row.length && row[end].bg === bg) end++;
			parts.push(
				`<rect x="${(x * look.cellW).toFixed(2)}" y="${(y * look.cellH).toFixed(2)}" width="${((end - x) * look.cellW).toFixed(2)}" height="${look.cellH}" fill="${bg}"/>`,
			);
			x = end;
		}
		// Text runs, split by any style change.
		x = 0;
		while (x < row.length) {
			const c = row[x];
			if (c.ch === "" || c.ch === " ") {
				x++;
				continue;
			}
			let end = x + 1;
			while (
				end < row.length &&
				row[end].ch !== "" &&
				row[end].ch !== " " &&
				sameStyle(row[end], c)
			) {
				end++;
			}
			const text = row.slice(x, end).map((cell) => cell.ch).join("");
			const weight = c.bold ? "700" : "400";
			const style = c.italic ? " font-style=\"italic\";" : "";
			const opacity = c.dim ? ` opacity="0.6"` : "";
			parts.push(
				`<text x="${(x * look.cellW).toFixed(2)}" y="${(y * look.cellH + look.baseline).toFixed(2)}" font-family="${escapeXml(look.fontFamily)}" font-size="${look.fontSizePx}" font-weight="${weight}"${style} fill="${c.fg ?? look.defaultFg}"${opacity}>${escapeXml(text)}</text>`,
			);
			if (c.underline) {
				parts.push(
					`<rect x="${(x * look.cellW).toFixed(2)}" y="${((y + 1) * look.cellH - 2).toFixed(2)}" width="${((end - x) * look.cellW).toFixed(2)}" height="1" fill="${c.fg ?? look.defaultFg}"/>`,
				);
			}
			x = end;
		}
	}
	parts.push("</svg>");
	return parts.join("\n");
}

function sameStyle(a, b) {
	return a.fg === b.fg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline;
}

/**
 * Build the resvg options for one render: the committed font files only,
 * no system fonts. `fontFiles` takes file paths; the family fallbacks all
 * point at the pinned family so no machine font can be picked up.
 */
export function resvgOptions(look = LOOK) {
	return {
		background: look.background,
		font: {
			loadSystemFonts: false,
			fontFiles: look.fontFiles,
			defaultFontFamily: look.fontFamily,
			monospaceFamily: look.fontFamily,
		},
	};
}

/**
 * Render one screen to a PNG buffer. `data` is the terminal byte stream.
 */
export async function renderScreenToPng(data, look = LOOK) {
	const grid = await screenToGrid(data, { cols: look.cols, rows: look.rows });
	const svg = gridToSvg(grid, look);
	const resvg = new Resvg(svg, resvgOptions(look));
	return resvg.render().asPng();
}

/**
 * Render one screen with no font files at all (system fonts disabled, so
 * resvg falls back to its built-in font). Used by the golden test to prove
 * the committed TTFs are what the normal render rasterizes: the two outputs
 * must differ, and the normal one must carry the real glyphs.
 */
export async function renderScreenToPngWithoutFontFiles(data, look = LOOK) {
	const grid = await screenToGrid(data, { cols: look.cols, rows: look.rows });
	const svg = gridToSvg(grid, look);
	const resvg = new Resvg(svg, {
		background: look.background,
		font: { loadSystemFonts: false },
	});
	return resvg.render().asPng();
}
