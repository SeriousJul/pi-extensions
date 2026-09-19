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

export declare const FAILURE_CLASSES: readonly FailureClass[];

/** Environment variable that points the scan at another sessions tree. */
export declare const SESSIONS_DIR_ENV: string;

export declare function classifyEditFailure(text: string): FailureClass;
export declare function extractEditResult(record: unknown): EditResult | undefined;
export declare function aggregateEditResults(results: Iterable<EditResult | undefined>): EditStats;
export declare function defaultSessionsRoot(env?: Record<string, string | undefined>): string;
export declare function listSessionFiles(root: string): string[];
export declare function scanSessions(root: string): EditResult[];
export declare function filterWindow(results: EditResult[], fromMs: number, toMs: number): EditResult[];
export declare function parseLastWindow(spec: string): number | undefined;
export declare function usage(): string;
export declare function main(argv: string[]): Promise<number>;
