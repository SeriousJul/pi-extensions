import type { ScreenCell } from "./render-png.mjs";

export interface CaptureOptions {
	cols?: number;
	rows?: number;
	settleMs?: number;
	maxWaitMs?: number;
}

/**
 * Mount one component into an alt-screen TUI and capture the settled
 * frame as terminal bytes. `build` receives the TuiAltScreen and returns
 * the component (or a Promise of it; extension view builders may load
 * asynchronously).
 */
export declare function captureComponentBytes(
	build: (tui: unknown) => unknown | Promise<unknown>,
	opts?: CaptureOptions,
): Promise<string>;

/** Mount, settle, and return the final visible rows as plain text. */
export declare function captureComponentText(
	build: (tui: unknown) => unknown | Promise<unknown>,
	opts?: CaptureOptions,
): Promise<string[]>;

/** Mount, settle, and return the final cell grid. */
export declare function captureComponentGrid(
	build: (tui: unknown) => unknown | Promise<unknown>,
	opts?: CaptureOptions,
): Promise<ScreenCell[][]>;
