// Type declarations for scripts/edit-health.mjs.

export type FailureClass = "no-match" | "ambiguous" | "validation" | "other";

/** One edit call extracted from a session record. */
export interface EditResult {
	/** The result timestamp in milliseconds, or undefined when unparseable. */
	tsMs?: number;
	isError: boolean;
	/** The result text; carries the error message for failures. */
	text: string;
}

/** The report block for a set of edit calls. */
export interface EditStats {
	total: number;
	failures: {
		total: number;
		byClass: Record<FailureClass, number>;
	};
}

/** One python-heredoc bash call extracted from a session record. */
export interface BashPythonHeredocCall {
	/** The call timestamp in milliseconds, or undefined when unparseable. */
	tsMs?: number;
	command: string;
}

/** The python-heredoc block of a report. */
export interface PythonHeredocStats {
	total: number;
	patchScripts: number;
}

export declare const FAILURE_CLASSES: readonly FailureClass[];

/** Environment variable that points the scan at another sessions tree. */
export declare const SESSIONS_DIR_ENV: string;

export declare function classifyEditFailure(text: string): FailureClass;
export declare function isPythonHeredocCommand(command: unknown): boolean;
export declare function isPatchScript(command: unknown): boolean;
export declare function extractEditResult(record: unknown): EditResult | undefined;
export declare function extractBashPythonHeredocs(record: unknown): BashPythonHeredocCall[];
export declare function aggregateEditResults(results: Iterable<EditResult | undefined>): EditStats;
export declare function aggregatePythonHeredocs(calls: Iterable<BashPythonHeredocCall | undefined>): PythonHeredocStats;
export declare function defaultSessionsRoot(env?: Record<string, string | undefined>): string;
export declare function listSessionFiles(root: string): string[];
export declare function scanTree(root: string): { editResults: EditResult[]; pythonHeredocs: BashPythonHeredocCall[] };
export declare function scanSessions(root: string): EditResult[];
export declare function scanPythonHeredocs(root: string): BashPythonHeredocCall[];
export declare function filterWindow(results: EditResult[], fromMs: number, toMs: number): EditResult[];
export declare function parseLastWindow(spec: string): number | undefined;
export declare function usage(): string;
export declare function main(argv: string[]): Promise<number>;
