/**
 * Settings for the pruning extension.
 *
 * Reads the `pruning` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws.
 *
 * Also reads `compaction.reserveTokens` the same way: pi's own setting,
 * read-only here. Pruning engages at pi's own compaction threshold
 * (window minus reserveTokens) and the prune gate compares against the
 * window minus twice reserveTokens.
 *
 * The `/pruning settings` command persists values through
 * `writePruningSettings`, which writes to the project file when one exists
 * and to the global file otherwise, preserving every other setting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PruningSettings {
	/** Turn the first level on or off. */
	enabled: boolean;
	/** A tool output smaller than this (in estimated tokens) is never pruned. */
	minResultTokens: number;
	/** Never prune outputs after the last user message. */
	protectCurrentTurn: boolean;
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_MIN_RESULT_TOKENS = 1000;
export const DEFAULT_PROTECT_CURRENT_TURN = true;

export const DEFAULTS: PruningSettings = {
	enabled: DEFAULT_ENABLED,
	minResultTokens: DEFAULT_MIN_RESULT_TOKENS,
	protectCurrentTurn: DEFAULT_PROTECT_CURRENT_TURN,
};

/** pi's built-in default for compaction.reserveTokens. */
export const DEFAULT_RESERVE_TOKENS = 16384;

const SECTION = "pruning";

function globalSettingsPath(env: NodeJS.ProcessEnv): string {
	return path.join(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

function readJson(file: string): { obj: Record<string, unknown> | null; error: string | null } {
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
		return { obj: parsed as Record<string, unknown>, error: null };
	} catch (err) {
		return { obj: null, error: `invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function sectionOf(obj: Record<string, unknown> | null, section: string): Record<string, unknown> | null {
	if (!obj) return null;
	const value = obj[section];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function parseBool(key: string, value: unknown, fallback: boolean, errors: string[]): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	errors.push(`${SECTION}.${key} must be a boolean, got: ${JSON.stringify(value)}`);
	return fallback;
}

function parseCount(key: string, value: unknown, fallback: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	errors.push(`${SECTION}.${key} must be a positive integer, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** Read the pruning settings: project file overrides global, key by key.
 * Malformed values fall back to their defaults and are reported. */
export function readPruningSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: PruningSettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	// The project section wins, key by key: a key absent in the project file
	// falls back to the global value.
	return {
		settings: {
			enabled: parseBool("enabled", projectSection?.enabled ?? globalSection?.enabled, DEFAULT_ENABLED, errors),
			minResultTokens: parseCount("minResultTokens", projectSection?.minResultTokens ?? globalSection?.minResultTokens, DEFAULT_MIN_RESULT_TOKENS, errors),
			protectCurrentTurn: parseBool("protectCurrentTurn", projectSection?.protectCurrentTurn ?? globalSection?.protectCurrentTurn, DEFAULT_PROTECT_CURRENT_TURN, errors),
		},
		errors,
	};
}

export type PruningSettingsWrite = { ok: true; path: string; settings: PruningSettings } | { ok: false; error: string };

/** Persist pruning settings (key by key, every other setting preserved) to
 * the project file when one exists, else the global file. Returns the
 * re-read effective settings. */
export function writePruningSettings(cwd: string, patch: Partial<PruningSettings>, env: NodeJS.ProcessEnv = process.env): PruningSettingsWrite {
	const projectPath = projectSettingsPath(cwd);
	const target = fs.existsSync(projectPath) ? projectPath : globalSettingsPath(env);
	const { obj, error } = readJson(target);
	if (error) return { ok: false, error };
	const next = obj ?? {};
	const section = { ...(sectionOf(obj, SECTION) ?? {}) };
	if (patch.enabled !== undefined) section.enabled = patch.enabled;
	if (patch.minResultTokens !== undefined) section.minResultTokens = patch.minResultTokens;
	if (patch.protectCurrentTurn !== undefined) section.protectCurrentTurn = patch.protectCurrentTurn;
	next[SECTION] = section;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");
	} catch (err) {
		return { ok: false, error: `could not write ${target}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, path: target, settings: readPruningSettings(cwd, env).settings };
}

/** Read the effective compaction.reserveTokens the way pi merges settings:
 * project file overrides global, which defaults to the built-in default. */
export function readReserveTokens(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
	const globalSection = sectionOf(readJson(globalSettingsPath(env)).obj, "compaction");
	const projectSection = sectionOf(readJson(projectSettingsPath(cwd)).obj, "compaction");
	for (const section of [projectSection, globalSection]) {
		const value = section?.reserveTokens;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return DEFAULT_RESERVE_TOKENS;
}
