/**
 * The shared settings-file reader.
 *
 * pi reads its settings from two files: the project `<cwd>/.pi/settings.json`
 * and the global `$PI_CODING_AGENT_DIR/settings.json` (or
 * `~/.pi/agent/settings.json`), and the project file wins key by key. Every
 * extension in this repo that reads a setting of its own has to answer that
 * same question, so the precedence, the JSON reads, and the value checks live
 * here once. `shared/sessions.ts` and `shared/status-line.ts` are the same
 * idea for the session tree and the status line.
 *
 * The rules the extensions agree on, and this module is the only place they
 * are written down:
 * - A malformed value falls back to its default and is reported in the error
 *   list the caller shows. A settings read never throws.
 * - A file that is absent is not an error; a file that cannot be read or
 *   parsed is.
 * - A write targets the project file when one exists, else the global file,
 *   and preserves every setting that was not named.
 *
 * Nothing in this module imports pi: it reads the same two files pi does, not
 * pi's in-memory settings.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** pi's built-in default for `compaction.reserveTokens`. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/** One settings object, as JSON gives it back. */
export type SettingsObject = Record<string, unknown>;

/** A settings file read: the object, or the reason there is not one. */
export interface SettingsRead {
	obj: SettingsObject | null;
	error: string | null;
}

/** A settings file write: the file that was written, or why it was not. */
export type SettingsWrite = { ok: true; path: string } | { ok: false; error: string };

/**
 * The agent directory, the way pi resolves it: `$PI_CODING_AGENT_DIR` when it
 * names anything at all, else `~/.pi/agent`. An empty value counts as unset and a
 * leading `~` is expanded, because that is what pi's own agent-dir reader does,
 * and a reader that disagreed with it would look for settings in the working
 * directory while pi reads them from the home.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return path.join(os.homedir(), ".pi", "agent");
	if (configured === "~") return os.homedir();
	if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured;
}

/** The global settings file, inside `agentDir`. */
export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), "settings.json");
}

/** The project settings file for one working directory. */
export function projectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

/** Read one settings file. A file that is not there reads empty, not wrong. */
export function readSettingsJson(file: string): SettingsRead {
	if (!fs.existsSync(file)) return { obj: null, error: null };
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { obj: null, error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { obj: null, error: `invalid settings in ${file}: top level must be an object` };
		}
		return { obj: parsed as SettingsObject, error: null };
	} catch (err) {
		return { obj: null, error: `invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** One section of a settings object, or nothing when it is not an object. */
export function sectionOf(obj: SettingsObject | null, section: string): SettingsObject | null {
	if (!obj) return null;
	const value = obj[section];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as SettingsObject;
}

// ---------------------------------------------------------------------------
// Value checks: each one falls back and reports, none of them throws
// ---------------------------------------------------------------------------

/** A boolean, or the fallback with a report. */
export function parseBool(section: string, key: string, value: unknown, fallback: boolean, errors: string[]): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	errors.push(`${section}.${key} must be a boolean, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** A positive integer, or the fallback with a report. */
export function parseCount(section: string, key: string, value: unknown, fallback: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	errors.push(`${section}.${key} must be a positive integer, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** A positive number not above `max`, or the fallback with a report. */
export function parseRatio(section: string, key: string, value: unknown, fallback: number, max: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max) return value;
	errors.push(`${section}.${key} must be a number greater than 0 and at most ${max}, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** A non-empty array of non-empty names, de-duplicated, or the fallback. */
export function parseNames(section: string, key: string, value: unknown, fallback: string[], errors: string[]): string[] {
	if (value === undefined || value === null) return fallback;
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) {
		return [...new Set(value as string[])];
	}
	errors.push(`${section}.${key} must be a non-empty array of tool names, got: ${JSON.stringify(value)}`);
	return fallback;
}

// ---------------------------------------------------------------------------
// The two questions every reader asks the same way
// ---------------------------------------------------------------------------

/**
 * The effective `compaction.reserveTokens`, the way pi merges it: the project
 * file beats the global file, and a file that names nothing, or names a value
 * that is not a positive finite number, falls to pi's built-in default.
 *
 * pi's own compaction reserve, which several extensions read to work out how
 * full a session is. Every one of them reads it the same way, so only this
 * module knows how.
 */
export function readReserveTokens(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
	const globalSection = sectionOf(readSettingsJson(globalSettingsPath(env)).obj, "compaction");
	const projectSection = sectionOf(readSettingsJson(projectSettingsPath(cwd)).obj, "compaction");
	for (const section of [projectSection, globalSection]) {
		const value = section?.reserveTokens;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return DEFAULT_RESERVE_TOKENS;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Merge one section of a settings file.
 *
 * The target is the project file when one exists, else the global file. A key
 * whose name holds a dot writes one level down (`spill.maxAgeDays` becomes
 * `{ spill: { maxAgeDays } }`), so a flat patch can address a nested section
 * without an extension rewriting this merge. Every other key of the file and
 * of the section is preserved.
 */
export function writeSettingsSection(cwd: string, section: string, patch: SettingsObject, env: NodeJS.ProcessEnv = process.env): SettingsWrite {
	const project = projectSettingsPath(cwd);
	const target = fs.existsSync(project) ? project : globalSettingsPath(env);
	const { obj, error } = readSettingsJson(target);
	if (error) return { ok: false, error };
	const next: SettingsObject = obj ?? {};
	const values = { ...(sectionOf(obj, section) ?? {}) };
	const nested = new Map<string, SettingsObject>();
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const dot = key.indexOf(".");
		if (dot <= 0) {
			values[key] = value;
			continue;
		}
		const head = key.slice(0, dot);
		const tail = key.slice(dot + 1);
		const group = nested.get(head) ?? { ...(sectionOf(values, head) ?? {}) };
		group[tail] = value;
		nested.set(head, group);
	}
	for (const [head, group] of nested) values[head] = group;
	next[section] = values;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");
	} catch (err) {
		return { ok: false, error: `could not write ${target}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, path: target };
}
