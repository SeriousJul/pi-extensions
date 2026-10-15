// Type declarations for scripts/lsp-health.mjs.

/** One line of a project's usage.jsonl, as the extension writes it. */
export interface LspLogRecord {
	ts: string;
	/** The project root the state directory is keyed by. */
	root: string;
	kind: "call" | "annotation" | "sweep";
	/** The tool for a call: lsp_diagnostics, lsp_references, lsp_hover. */
	tool?: string;
	/** call: ok, error, timeout, refused, dead. annotation/sweep: reported or quiet. */
	outcome?: string;
	language?: string;
	server?: string;
	/** The size of the text the model saw, for a call. */
	chars?: number;
	duration_ms?: number;
	/** The new diagnostics an annotation or sweep reported. */
	new_count?: number;
	has_error?: boolean;
}

/** One project state directory holding a usage.jsonl. */
export interface LspProjectDir {
	dir: string;
	name: string;
	file: string;
}

/** A normalized log record as scanStateDir keeps it. */
export interface ScannedLspRecord {
	kind: "call" | "annotation" | "sweep";
	tool?: string;
	outcome?: string;
	language?: string;
	server?: string;
	root: string;
	chars: number;
	durationMs?: number;
	newCount: number;
	hasError: boolean;
	/** The files an annotation or sweep named, as the model saw them. */
	files: string[];
	/** The record timestamp in milliseconds, or undefined when unparseable. */
	tsMs?: number;
}

/** One edit or write call extracted from a project's session files. */
export interface EditEvent {
	/** The file the call names, as the agent typed it. */
	path: string;
	tool: "edit" | "write";
	/** The call timestamp in milliseconds, or undefined when unparseable. */
	tsMs?: number;
}

/** One persisted per-server stderr log. */
export interface LspStderrLog {
	file: string;
	server: string;
	size: number;
}

/** The follow-up judgment over the reported-error annotations and sweeps. */
export interface LspFollowUps {
	/** The judged records: timed, file-naming, and backed by session files. */
	total: number;
	/** The ones the agent acted on: a re-edit of a named file within the window. */
	acted: number;
	unacted: number;
	/** Reported-error records without a timestamp: not judged. */
	untimed: number;
	/** Reported-error records whose project has no session files: not judged. */
	noSessions: number;
}

/** The report block for a set of scanned records. */
export interface LspHealthStats {
	calls: {
		total: number;
		byTool: Record<string, number>;
		byOutcome: Record<string, number>;
		/** The average answer duration, or undefined when no call timed. */
		avgDurationMs?: number;
		chars: number;
	};
	annotations: {
		total: number;
		reported: number;
		newCount: number;
		errors: number;
	};
	sweeps: {
		total: number;
		reported: number;
		newCount: number;
	};
	followUps: LspFollowUps;
	projects: {
		total: number;
		list: Array<{ root: string; calls: number; annotations: number; sweeps: number }>;
	};
	stderr: {
		total: number;
		nonEmpty: number;
		logs: LspStderrLog[];
	};
}

/** The call outcomes, in report order; anything else counts as "other". */
export declare const OUTCOMES: readonly string[];

/** The next-calls window of the follow-up metric. */
export declare const FOLLOW_UP_CALLS: number;

/** Environment variable that points the scan at another state directory. */
export declare const STATE_DIR_ENV: string;

/** Environment variable that points the follow-up scan at another sessions tree. */
export declare const SESSIONS_DIR_ENV: string;

export declare function parseLspLogLine(line: string): LspLogRecord | null;
export declare function listProjectDirs(stateDir: string): LspProjectDir[];
export declare function scanStateDir(stateDir: string): ScannedLspRecord[];
export declare function listStderrLogs(stateDir: string): LspStderrLog[];
/** The session directory name pi gives a working directory. */
export declare function piSessionDirName(root: string): string;
export declare function listRootSessionFiles(sessionsRoot: string, root: string): string[];
export declare function scanEditEvents(sessionsRoot: string, root: string): EditEvent[];
export declare function correlateFollowUps(records: Iterable<ScannedLspRecord>, sessionsRoot: string): LspFollowUps;
export declare function aggregateLspRecords(records: Iterable<ScannedLspRecord>, stderrLogs: LspStderrLog[], followUps?: LspFollowUps): LspHealthStats;
export declare function filterWindow(records: ScannedLspRecord[], fromMs: number, toMs: number): ScannedLspRecord[];
export declare function parseLastWindow(spec: string): number | undefined;
export declare function defaultStateRoot(env?: Record<string, string | undefined>): string;
export declare function defaultSessionsRoot(env?: Record<string, string | undefined>): string;
export declare function usage(): string;
export declare function main(argv: string[]): Promise<number>;
