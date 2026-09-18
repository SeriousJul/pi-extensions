/** The context every capture setup receives from the orchestrator. */
export interface CaptureContext {
	repoRoot: string;
	/** The port of the local mock LLM server. */
	modelPort: number;
	/** Register a gist on the local mock Gist API and get its port. */
	serveGist: (gist: import("./mock-gist.mjs").GistShape) => Promise<{ port: number }>;
}

/** One docs screenshot, declarative. */
export interface CaptureDefinition {
	id: string;
	/** Committed PNG path, relative to the repo root. */
	out: string;
	kind: "offscreen" | "pty";
	/** True when the capture is fast enough for the unit test suite. */
	fast?: boolean;
	/** offscreen: mount the component for one capture. */
	build?: (tui: unknown) => unknown | Promise<unknown>;
	/** pty: build the terminal capture spec (the executable is always given). */
	setup?: (ctx: CaptureContext) => Promise<
		Partial<import("./terminal-capture.mjs").TerminalCaptureOptions> & { file: string }
	>;
}

/** Every docs screenshot, in render order. */
export declare const CAPTURES: CaptureDefinition[];
