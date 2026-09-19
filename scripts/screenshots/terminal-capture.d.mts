/** Options for one real-terminal capture. */
export interface TerminalCaptureOptions {
	/** Executable to spawn in the pseudo-terminal. */
	file: string;
	args?: string[];
	cwd?: string;
	/** Extra environment, merged over process.env. */
	env?: Record<string, string>;
	/** Scripted key input, sent in order after startup. */
	input?: Array<{ data: string; delayMs?: number }>;
	/** Content that must appear on the screen before settle starts. */
	marker?: string;
	cols?: number;
	rows?: number;
	/** One settle poll interval. */
	settleMs?: number;
	/** Wait for the process to come up before sending input. */
	startupMs?: number;
	/** Hard deadline for the whole capture. */
	timeoutMs?: number;
}

/** The settled screen of one capture. */
export interface TerminalCaptureResult {
	/** Raw pty output byte stream. */
	bytes: string;
	/** Visible screen text lines, top row first. */
	rows: string[];
	/** Per-row cell arrays for the visible grid. */
	cells: Array<Array<{ ch: string; fgMode: number; fg: number; bgMode: number; bg: number; bold: boolean }>>;
	/** Set when the process exited on its own. */
	exited: { exitCode: number; at: number } | null;
}

/**
 * Run one command in a pseudo-terminal at the pinned grid, feed scripted
 * input, wait for the screen to settle, and return the final screen.
 */
export declare function captureTerminal(
	opts: TerminalCaptureOptions,
): Promise<TerminalCaptureResult>;
