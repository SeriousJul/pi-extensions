/**
 * Real-terminal capture: spawn a process in a pseudo-terminal at the pinned
 * grid size, feed scripted input, wait for the screen to settle, and return
 * the final screen.
 *
 * The pty's byte stream is accumulated and replayed into a persistent
 * @xterm/headless terminal, exactly as a real terminal would consume it. The
 * settled grid (cells) is what gets rendered to PNG; the raw byte stream is
 * also returned for diagnostics.
 *
 * Settle policy: the input script runs to the end first, then the screen
 * must stop changing for two consecutive polls. A content marker (a string
 * that must appear on the visible screen) gates the settle start, so a
 * capture never freezes on a transient frame.
 */
import pty from "node-pty";
import xtermHeadless from "@xterm/headless";

import { LOOK } from "./look.mjs";

const { Terminal: HeadlessTerminal } = xtermHeadless;

/**
 * Run one command in a pty and return the settled screen.
 *
 * @param {object} opts
 * @param {string} opts.file executable to spawn
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd] working directory
 * @param {NodeJS.ProcessEnv} [opts.env] extra environment (merged over process.env)
 * @param {Array<{data: string, delayMs?: number}>} [opts.input] scripted key input, sent in order
 * @param {string} [opts.marker] content that must appear on the screen before settle starts
 * @param {number} [opts.cols] grid width (default LOOK.cols)
 * @param {number} [opts.rows] grid height (default LOOK.rows)
 * @param {number} [opts.settleMs] one settle poll interval
 * @param {number} [opts.startupMs] wait for the process to come up before sending input
 * @param {number} [opts.timeoutMs] hard deadline for the whole capture
 * @returns {Promise<{bytes: string, rows: string[], cells: any[][]}>}
 *   bytes: raw pty output; rows: visible screen text lines (top row first);
 *   cells: per-row arrays of {ch, fg, bg, bold} for the visible grid.
 */
export async function captureTerminal({
	file,
	args = [],
	cwd = process.cwd(),
	env = {},
	input = [],
	marker,
	cols = LOOK.cols,
	rows = LOOK.rows,
	settleMs = 150,
	startupMs = 3000,
	timeoutMs = 120_000,
} = {}) {
	const shell = pty.spawn(file, args, {
		cwd,
		env: { ...process.env, ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		cols,
		rows,
	});

	const term = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
	let buffer = "";
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;
	let exited = null;
	shell.onData((chunk) => {
		buffer += chunk;
		term.write(chunk);
	});
	shell.onExit(({ exitCode }) => {
		exited = { exitCode, at: Date.now() };
	});

	// Give the process time to come up, then send the scripted input.
	await sleep(startupMs);
	for (const step of input) {
		shell.write(step.data);
		if (step.delayMs) await sleep(step.delayMs);
	}

	const screenText = () => {
		const out = [];
		const viewportY = term.buffer.active.viewportY;
		for (let y = 0; y < rows; y++) {
			const line = term.buffer.active.getLine(viewportY + y);
			let text = "";
			for (let x = 0; x < cols; x++) {
				const cell = line.getCell(x);
				text += cell ? cell.getChars() : " ";
			}
			out.push(text);
		}
		return out.join("\n");
	};

	const screenCells = () => {
		const out = [];
		const viewportY = term.buffer.active.viewportY;
		for (let y = 0; y < rows; y++) {
			const line = term.buffer.active.getLine(viewportY + y);
			const rowCells = [];
			for (let x = 0; x < cols; x++) {
				const cell = line.getCell(x);
				if (cell) {
					rowCells.push({
						ch: cell.getChars(),
						fgMode: cell.getFgColorMode(),
						fg: cell.getFgColor(),
						bgMode: cell.getBgColorMode(),
						bg: cell.getBgColor(),
						bold: cell.isBold() !== 0,
					});
				} else {
					rowCells.push({ ch: " ", fgMode: 0, fg: 0, bgMode: 0, bg: 0, bold: false });
				}
			}
			out.push(rowCells);
		}
		return out;
	};

	let lastText = "";
	let stablePolls = 0;
	for (;;) {
		if (exited && input.length === 0 && stablePolls > 0) break; // clean exit, screen stable
		if (Date.now() > deadline) {
			shell.kill();
			throw new Error(`terminal capture did not settle within ${timeoutMs}ms (exited=${exited ? exited.exitCode : "no"})`);
		}
		await sleep(settleMs);
		const text = screenText();
		const markerSeen = marker ? text.includes(marker) : true;
		if (markerSeen && text === lastText) {
			stablePolls++;
			if (stablePolls >= 2) break;
		} else {
			stablePolls = 0;
			lastText = text;
		}
	}

	shell.kill();
	term.dispose();
	return { bytes: buffer, rows: screenText().split("\n"), cells: screenCells(), exited };
}

export { pty, HeadlessTerminal };
