/**
 * The types the lsp extension shares between its modules. Kept in one file
 * so settings, registry, session, and format name the same shapes.
 */

/** A per-language override from the settings `servers` section. */
export interface LspServerOverride {
	/** Replace the registry's binary (name on PATH or absolute path). */
	command?: string;
	/** Replace the registry's default arguments. */
	args?: string[];
	/** Disable this language: no server starts for it, ever, on this machine. */
	disabled?: boolean;
}

/** The `lsp` settings section, resolved and default-filled. */
export interface LspSettings {
	/** Kill switch. Disabled: no server, no tools, no note, no annotation. */
	enabled: boolean;
	/** Per-language overrides, keyed by the registry language key. */
	servers: Record<string, LspServerOverride | undefined>;
	/** Lowest severity the reports show: "warning" means error plus warning. */
	severity: "warning" | "error";
	/** The per-server Open document LRU cap. */
	maxOpenDocuments: number;
	/** The Concurrent server bound. */
	maxServers: number;
	/** The per-request timeout; the timeout error names the server. */
	timeoutMs: number;
	/** Attach post-edit diagnostics to edit/write results. */
	annotate: boolean;
}

/** One LSP diagnostic, in the shape the servers send it (LSP 3.17+). */
export interface LspDiagnostic {
	/** 0-based. */
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	/** 1 error, 2 warning, 3 information, 4 hint. */
	severity?: number;
	code?: number | string;
	message: string;
	sources?: string;
}

/** How one diagnostics answer arrived. */
export type DiagnosticOrigin = "pull" | "push" | "none";

/** One diagnostics answer for one document, with its honesty labels. */
export interface DiagnosticAnswer {
	diagnostics: LspDiagnostic[];
	/**
	 * True when the answer may be incomplete: the request timed out, or the
	 * server answered empty before it had time to analyze the document. The
	 * reader must not read a partial answer as a clean one.
	 */
	partial: boolean;
	origin: DiagnosticOrigin;
}
