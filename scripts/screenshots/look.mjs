/**
 * The pinned terminal look for every docs screenshot (ADR 0017).
 *
 * One grid size, one theme, one font, one background, one timezone. Every
 * render - local or CI - uses these exact values, so a committed screenshot
 * is byte-stable across machines and a drift check can compare bytes.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The theme the user sees by default: pi's bundled dark theme, not a copy. */
export function darkThemePath() {
	// The package "exports" map hides package.json, so resolve the main
	// entry URL and walk down to the theme file.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "modes", "interactive", "theme", "dark.json");
}

export const LOOK = {
	/** The terminal grid every screenshot renders into. */
	cols: 100,
	rows: 30,
	/** The font family all cells are drawn with. */
	fontFamily: "MesloLGMDZNFMono",
	/** Font files, checked into the repo so CI renders the same glyphs. */
	fontFiles: [
		join(here, "fonts", "MesloLGMDZNFMono-Regular.ttf"),
		join(here, "fonts", "MesloLGMDZNFMono-Bold.ttf"),
		join(here, "fonts", "MesloLGMDZNFMono-Italic.ttf"),
		join(here, "fonts", "MesloLGMDZNFMono-BoldItalic.ttf"),
	],
	/**
	 * Points. The cell width is the font's measured glyph advance at this
	 * size (7.8px for both weights), so text sits where a real terminal puts
	 * it. The cell height is the pinned line height (17px = 13px font at a
	 * 1.31 line height).
	 */
	fontSizePx: 13,
	cellW: 7.8,
	cellH: 17,
	/** Baseline offset from the top of a cell, in px. */
	baseline: 12.6,
	/** pi's dark theme export.pageBg: the terminal background. */
	background: "#18181e",
	/** pi's dark theme "text" color: the default foreground. */
	defaultFg: "#d4d4d4",
	/** The default background (cells with no explicit bg). */
	defaultBg: "#18181e",
	/** PNG pixel size of one screenshot. */
	widthPx: Math.round(100 * 7.8),
	heightPx: Math.round(30 * 17),
};

/**
 * Environment pins every capture run with. UTC keeps clock-derived strings
 * ("resets Thu 14:00") machine-independent; FORCE_COLOR=3 makes chalk emit
 * bold/italic/underline codes outside a TTY, the way pi's theme emits them
 * in a real terminal.
 */
export function applyEnvPins(env = process.env) {
	env.TZ = "UTC";
	env.FORCE_COLOR = "3";
}

/**
 * The fixed working root. Captures never use mktemp: a fixed path keeps
 * fixture-derived strings (repo paths, session roots) byte-identical, and
 * every run starts from the same clean state.
 */
export const WORK_ROOT = "/tmp/pi-extensions-capture";
