/**
 * The per-call log.
 *
 * The instrument that answers the ticket's own question (issue #136): is
 * the loop worth its tokens? One append-only JSONL per project root, under
 * the extension's own state directory (`$PI_CODING_AGENT_DIR/lsp/`), never
 * leaving the machine, on the same rule as codegraph's usage log.
 *
 * Three record kinds:
 *   call        one lsp_* tool call: tool, language, server, outcome,
 *               duration, result size
 *   annotation  one post-edit annotation: the trigger, the files it named,
 *               how many new diagnostics, whether any was an error
 *   sweep       one turn-end sweep: whether it reported, and what
 *
 * A malformed or torn line is ignored by the reader, so a crash cannot make
 * the health report unreadable. Appends are one complete line each.
 */
import fs from "node:fs";
import path from "node:path";

import { agentDir } from "../shared/settings.ts";

/** The state directory name under the agent dir. */
export const LSP_STATE_DIRNAME = "lsp";
/** The log file name inside one project's state directory. */
export const LOG_NAME = "usage.jsonl";

export type LogKind = "call" | "annotation" | "sweep";

export interface LspLogRecord {
	ts: string;
	kind: LogKind;
	/** The tool for a call: lsp_diagnostics, lsp_references, lsp_hover. */
	tool?: string;
	/** The annotation trigger: edit, write, or sweep. */
	trigger?: string;
	/** The language the call or annotation served. */
	language?: string;
	/** The server binary name that served it. */
	server?: string;
	/** The project root the state directory is keyed by. */
	root: string;
	/** call: ok, error, timeout, refused, dead. annotation/sweep: reported or quiet. */
	outcome?: string;
	duration_ms?: number;
	/** The size of the text the model saw, for the token-cost side. */
	chars?: number;
	/** The files the annotation or sweep named. */
	files?: string[];
	/** The new diagnostics the annotation or sweep reported. */
	new_count?: number;
	/** Whether any reported diagnostic was an error. */
	has_error?: boolean;
}

/**
 * The state directory the logs of one project root live in. The root path
 * is percent-encoded into the directory name, the same rule pi's session
 * directories use: the path stays readable in listings and unique per root.
 */
export function projectLogDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), LSP_STATE_DIRNAME, encodeRoot(root));
}

/** The root path as a directory name: `--home-me-proj` for `/home/me/proj`. */
export function encodeRoot(root: string): string {
	const normalized = path.resolve(root);
	return normalized.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Append one record to the project log. A log failure never fails the call
 * that records it: the instrument is advisory.
 */
export function appendLspLog(root: string, record: Omit<LspLogRecord, "ts" | "root">, env: NodeJS.ProcessEnv = process.env): void {
	try {
		const dir = projectLogDir(root, env);
		fs.mkdirSync(dir, { recursive: true });
		const line: LspLogRecord = { ts: new Date().toISOString(), root, ...record };
		fs.appendFileSync(path.join(dir, LOG_NAME), `${JSON.stringify(line)}\n`, "utf-8");
	} catch {
		// advisory
	}
}

/**
 * Append raw server stderr to the project log, under a per-server file.
 * Advisory: a write failure never fails the call that captures it.
 */
export function appendServerStderr(root: string, label: string, chunk: string, env: NodeJS.ProcessEnv = process.env): void {
	try {
		const dir = projectLogDir(root, env);
		fs.mkdirSync(dir, { recursive: true });
		const name = label.replace(/[^A-Za-z0-9._-]/g, "-");
		fs.appendFileSync(path.join(dir, `server-${name}.stderr.log`), chunk, "utf-8");
	} catch {
		// advisory
	}
}

/** Parse one log line, or null when it is not a record we understand. */
export function parseLspLogLine(line: string): LspLogRecord | null {
	if (!line.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const r = parsed as Partial<LspLogRecord>;
	if (typeof r.ts !== "string" || typeof r.root !== "string") return null;
	if (r.kind !== "call" && r.kind !== "annotation" && r.kind !== "sweep") return null;
	return r as LspLogRecord;
}

/**
 * Every project state directory with a log, newest-first by directory name.
 * A directory without a log file is skipped: the extension only creates a
 * directory when it also writes its first line.
 */
export function listProjectLogDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	const base = path.join(agentDir(env), LSP_STATE_DIRNAME);
	let entries: string[];
	try {
		entries = fs.readdirSync(base);
	} catch {
		return [];
	}
	return entries
		.filter((name) => {
			try {
				return fs.statSync(path.join(base, name, LOG_NAME)).isFile();
			} catch {
				return false;
			}
		})
		.sort()
		.map((name) => path.join(base, name));
}
