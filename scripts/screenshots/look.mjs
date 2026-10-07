/**
 * The pinned terminal look for every docs screenshot (ADR 0017).
 *
 * One grid size, one theme, one font, one background, one timezone. Every
 * render - local or CI - uses these exact values, so a committed screenshot
 * is byte-stable across machines and a drift check can compare bytes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));

/** The theme the user sees by default: pi's bundled dark theme, not a copy. */
export function darkThemePath() {
	// The package "exports" map hides package.json, so resolve the main
	// entry URL and walk down to the theme file.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "modes", "interactive", "theme", "dark.json");
}

/**
 * Resolve one dark.json color value to the hex the PNG renderer draws.
 *
 * A value is a var name (followed through "vars"), or a literal color: hex,
 * OKLCH, or OKHSL. pi's theme loader turns the same value into a truecolor
 * SGR, and colorToHex reports the same RGB it puts in that escape, so the
 * pinned background and default foreground match what pi actually paints.
 */
function themeHex(value, json) {
	let current = value;
	while (typeof current === "string" && Object.hasOwn(json.vars ?? {}, current)) {
		current = json.vars[current];
	}
	if (typeof current !== "string" || current === "") {
		throw new Error(`dark.json color value is not a resolvable color: ${JSON.stringify(value)}`);
	}
	return colorToHex(parseColor(current));
}

const darkJson = JSON.parse(readFileSync(darkThemePath(), "utf8"));

/** pi's dark theme export.pageBg, as the hex the renderer fills the page with. */
const PAGE_BG = themeHex(darkJson.export?.pageBg, darkJson);
/** pi's dark theme "text" color, as the hex the renderer draws default text with. */
const TEXT_FG = themeHex(darkJson.colors.text, darkJson);

export const LOOK = {
	/** The terminal grid every screenshot renders into. */
	cols: 100,
	rows: 30,
	/**
	 * The font family all cells are drawn with. This is the family name in the
	 * committed TTFs' name tables (fc-scan), not the file names: resvg matches
	 * SVG font-family against the family name of every loaded font, so the
	 * name must equal what the file declares.
	 */
	fontFamily: "MesloLGLDZ Nerd Font Mono",
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
	background: PAGE_BG,
	/** pi's dark theme "text" color: the default foreground. */
	defaultFg: TEXT_FG,
	/** The default background (cells with no explicit bg). */
	defaultBg: PAGE_BG,
	/** PNG pixel size of one screenshot. */
	widthPx: Math.round(100 * 7.8),
	heightPx: Math.round(30 * 17),
};

/**
 * Environment pins every capture run with. UTC keeps clock-derived strings
 * ("resets Thu 14:00") machine-independent; FORCE_COLOR=3 makes chalk emit
 * bold/italic/underline codes outside a TTY, the way pi's theme emits them
 * in a real terminal; COLORTERM=truecolor makes pi's theme loader pick the
 * truecolor mode regardless of the rendering terminal.
 */
export function applyEnvPins(env = process.env) {
	env.TZ = "UTC";
	env.FORCE_COLOR = "3";
	env.COLORTERM = "truecolor";
}

// Pi's theme loader reads these at module load (initTheme, called from
// views.mjs's top level), so the pins must be in effect before any capture
// module body runs. look.mjs is the first import of every entry point and a
// dependency of views.mjs, which makes this the one guaranteed hook.
applyEnvPins();

/**
 * The fixed working root. Captures never use mktemp: a fixed path keeps
 * fixture-derived strings (repo paths, session roots) byte-identical, and
 * every run starts from the same clean state. The fixed path is also the
 * weak spot: two concurrent runs (capture pipeline and test suite, or two
 * pipelines) share and wipe each other's state. Run them sequentially on
 * one machine; there is no lock by design.
 */
export const WORK_ROOT = "/tmp/pi-extensions-capture";
