/**
 * Off-screen capture of extension TUI components.
 *
 * The extension component - the exact object its /command creates - is
 * mounted into a real TuiAltScreen whose terminal is a capture stub. The
 * TUI's differential output (the bytes a real terminal would receive) is
 * replayed into @xterm/headless to recover the final cell grid, which the
 * renderer turns into a PNG.
 *
 * Waiting for settle: components render async state (a scan finishing, a
 * list loading). The capture polls the stub until the byte stream stops
 * growing, so the PNG shows the final frame without a fixed sleep.
 */
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";

import { screenToGrid, screenToText } from "./render-png.mjs";

/** A pi-tui Terminal stub that records every write. */
export class CapturingTerminal {
	constructor(cols, rows) {
		this._cols = cols;
		this._rows = rows;
		this.chunks = [];
	}
	start() {}
	stop() {}
	drainInput() {
		return Promise.resolve();
	}
	write(data) {
		this.chunks.push(data);
	}
	get columns() {
		return this._cols;
	}
	get rows() {
		return this._rows;
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	get bytes() {
		return this.chunks.join("");
	}
}

/**
 * Mount one component into an alt-screen TUI and capture the settled frame
 * as terminal bytes.
 *
 * @param build (tui: TuiAltScreen) => pi-tui Component (render/invalidate/handleInput)
 * @param opts { cols, rows, settleMs, maxWaitMs }
 */
export async function captureComponentBytes(build, { cols, rows, settleMs = 50, maxWaitMs = 5000 } = {}) {
	const terminal = new CapturingTerminal(cols, rows);
	const tui = new TuiAltScreen(terminal, false, undefined, {});
	// The alt screen renders its layout root, so the component mounts in a
	// plain container as the whole screen.
	const root = new Container();
	const component = await build(tui);
	root.addChild(component);
	tui.setLayoutRoot(root);
	tui.setFocus(component);
	tui.start();
	tui.renderNow(true);

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	let lastLen = -1;
	let stableFor = 0;
	const startedAt = Date.now();
	for (;;) {
		await sleep(settleMs);
		const len = terminal.bytes.length;
		if (len === lastLen) {
			stableFor += settleMs;
			if (stableFor >= 2 * settleMs) break;
		} else {
			stableFor = 0;
		}
		lastLen = len;
		if (Date.now() - startedAt > maxWaitMs) {
			throw new Error(`capture did not settle within ${maxWaitMs}ms`);
		}
	}
	// Snapshot the bytes while the alt screen is still active: stop() exits
	// the alt screen, and a replay must end on the same screen it drew on.
	const bytes = terminal.bytes;
	tui.stop({ preserveScreen: true });
	component.dispose?.();
	return bytes;
}

/** Mount, settle, and return the final visible rows as plain text. */
export async function captureComponentText(build, opts = {}) {
	return screenToText(await captureComponentBytes(build, opts), { cols: opts.cols, rows: opts.rows });
}

/** Mount, settle, and return the final cell grid. */
export async function captureComponentGrid(build, opts = {}) {
	return screenToGrid(await captureComponentBytes(build, opts), { cols: opts.cols, rows: opts.rows });
}
