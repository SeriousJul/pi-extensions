import type { Look } from "./look.mjs";

/** One settled terminal cell. */
export interface ScreenCell {
	ch: string;
	fgMode: number;
	fg: number;
	bgMode: number;
	bg: number;
	bold: boolean;
}

/**
 * Replay a terminal byte stream into a headless terminal and return the
 * settled visible grid (top row first).
 */
export declare function screenToGrid(
	data: string,
	opts?: { cols?: number; rows?: number },
): Promise<ScreenCell[][]>;

/** Replay a terminal byte stream and return the settled visible rows. */
export declare function screenToText(
	data: string,
	opts?: { cols?: number; rows?: number },
): Promise<string[]>;

/** Serialize one grid to the SVG the rasterizer draws. */
export declare function gridToSvg(grid: ScreenCell[][], look?: Look): string;

/**
 * Render one screen to a PNG. `data` is the terminal byte stream; the
 * result is the exact PNG bytes the capture pipeline commits.
 */
export declare function renderScreenToPng(data: string, look?: Look): Promise<Uint8Array>;
