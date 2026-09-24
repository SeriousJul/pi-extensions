/**
 * Settings for the output limits extension.
 *
 * Reads the `outputLimits` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`), key
 * by key. A malformed value falls back to its default and is reported in the
 * returned error list; it never throws. The section is read once per session
 * and re-read on reload.
 *
 * The escape hatch is the environment: `PI_OUTPUT_LIMITS=off` turns the
 * extension off without touching a file. It wins over both settings files,
 * because an escape hatch that a stale project setting can undo is not one.
 *
 * Also reads pi's own `compaction.reserveTokens` the same way pi reads it,
 * read-only here: Headroom is the Effective window minus that reserve minus
 * the usage pi reports. The extension never sets it (out of scope).
 *
 * `maxOutputTokens` defaults to pi's own per-call figure expressed in tokens,
 * so the extension is always on and still invisible until Headroom gets
 * tight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	PI_MAX_OUTPUT_LINES,
	type TokenMath,
} from "./core.ts";

export interface OutputLimitsSettings {
	/** Turn the extension on or off. */
	enabled: boolean;
	/** The per-call outer max, in tokens. */
	maxOutputTokens: number;
	/** The per-call line max. */
	maxLines: number;
	/** The Inflation factor on pi's chars/4 estimate. */
	inflation: number;
	/** The characters per token pi's own estimate assumes. */
	bytesPerChar: number;
	/** The share of the Headroom one assistant message may spend. */
	shareOfHeadroom: number;
	/** The per-call floor, in bytes. */
	minOutputBytes: number;
	/** The tools this extension bounds. */
	tools: string[];
	/** The Spill retention limits. */
	spill: { maxTotalBytes: number; maxAgeDays: number };
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_MAX_LINES = PI_MAX_OUTPUT_LINES;
export const DEFAULT_INFLATION = 2.0;
export const DEFAULT_BYTES_PER_CHAR = 4;
export const DEFAULT_SHARE_OF_HEADROOM = 0.25;
export const DEFAULT_MIN_OUTPUT_BYTES = 4096;
export const DEFAULT_TOOLS = ["bash", "read", "grep", "find", "ls"];
export const DEFAULT_SPILL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SPILL_MAX_AGE_DAYS = 7;

/** pi's own compaction reserveTokens default. */
export const DEFAULT_RESERVE_TOKENS = 16384;

export const DEFAULTS: OutputLimitsSettings = {
	enabled: DEFAULT_ENABLED,
	maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	maxLines: DEFAULT_MAX_LINES,
	inflation: DEFAULT_INFLATION,
	bytesPerChar: DEFAULT_BYTES_PER_CHAR,
	shareOfHeadroom: DEFAULT_SHARE_OF_HEADROOM,
	minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
	tools: DEFAULT_TOOLS,
	spill: { maxTotalBytes: DEFAULT_SPILL_MAX_TOTAL_BYTES, maxAgeDays: DEFAULT_SPILL_MAX_AGE_DAYS },
};

/** The env var that turns the extension off regardless of both settings files. */
export const OFF_ENV_VAR = "PI_OUTPUT_LIMITS";

const SECTION = "outputLimits";

export function tokenMathOf(settings: OutputLimitsSettings): TokenMath {
	return { bytesPerChar: settings.bytesPerChar, inflation: settings.inflation };
}

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

function parseRatio(key: string, value: unknown, fallback: number, max: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max) return value;
	errors.push(`${SECTION}.${key} must be a number greater than 0 and at most ${max}, got: ${JSON.stringify(value)}`);
	return fallback;
}

function parseTools(key: string, value: unknown, fallback: string[], errors: string[]): string[] {
	if (value === undefined || value === null) return fallback;
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) {
		return [...new Set(value as string[])];
	}
	errors.push(`${SECTION}.${key} must be a non-empty array of tool names, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** True when the environment escape hatch turns the extension off. */
export function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[OFF_ENV_VAR];
	return typeof value === "string" && value.trim().toLowerCase() === "off";
}

/** Read the extension settings: project file overrides global, key by key.
 * Malformed values fall back to their default and are reported. */
export function readOutputLimitsSettings(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): { settings: OutputLimitsSettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	// The project section wins, key by key: a key absent in the project file
	// falls back to the global value, then to the default.
	const pick = <T>(key: string, fallback: T): T | undefined => {
		const value = projectSection?.[key] ?? globalSection?.[key];
		return value === undefined ? fallback : (value as T);
	};
	const spillGlobal = sectionOf(globalSection, "spill");
	const spillProject = sectionOf(projectSection, "spill");
	const pickSpill = <T>(key: string, fallback: T): T | undefined => {
		const value = spillProject?.[key] ?? spillGlobal?.[key];
		return value === undefined ? fallback : (value as T);
	};

	const settings: OutputLimitsSettings = {
		enabled: envDisabled(env) ? false : parseBool("enabled", pick<boolean>("enabled", DEFAULT_ENABLED), DEFAULT_ENABLED, errors),
		maxOutputTokens: parseCount("maxOutputTokens", pick<number>("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS), DEFAULT_MAX_OUTPUT_TOKENS, errors),
		maxLines: parseCount("maxLines", pick<number>("maxLines", DEFAULT_MAX_LINES), DEFAULT_MAX_LINES, errors),
		inflation: parseRatio("inflation", pick<number>("inflation", DEFAULT_INFLATION), DEFAULT_INFLATION, Number.POSITIVE_INFINITY, errors),
		bytesPerChar: parseRatio("bytesPerChar", pick<number>("bytesPerChar", DEFAULT_BYTES_PER_CHAR), DEFAULT_BYTES_PER_CHAR, Number.POSITIVE_INFINITY, errors),
		shareOfHeadroom: parseRatio("shareOfHeadroom", pick<number>("shareOfHeadroom", DEFAULT_SHARE_OF_HEADROOM), DEFAULT_SHARE_OF_HEADROOM, 1, errors),
		minOutputBytes: parseCount("minOutputBytes", pick<number>("minOutputBytes", DEFAULT_MIN_OUTPUT_BYTES), DEFAULT_MIN_OUTPUT_BYTES, errors),
		tools: parseTools("tools", pick<string[]>("tools", DEFAULT_TOOLS), DEFAULT_TOOLS, errors),
		spill: {
			maxTotalBytes: parseCount("spill.maxTotalBytes", pickSpill<number>("maxTotalBytes", DEFAULT_SPILL_MAX_TOTAL_BYTES), DEFAULT_SPILL_MAX_TOTAL_BYTES, errors),
			maxAgeDays: parseCount("spill.maxAgeDays", pickSpill<number>("maxAgeDays", DEFAULT_SPILL_MAX_AGE_DAYS), DEFAULT_SPILL_MAX_AGE_DAYS, errors),
		},
	};
	// A malformed sub-key must not poison the section it lives in: the spill
	// errors name `spill.<key>`, so report them with the section prefix they
	// already carry.
	return { settings, errors };
}

export type OutputLimitsSettingsWrite =
	| { ok: true; path: string; settings: OutputLimitsSettings }
	| { ok: false; error: string };

/** The keys `/output-limits settings` can write. */
export type SettingsPatch = Partial<{
	enabled: boolean;
	maxOutputTokens: number;
	maxLines: number;
	inflation: number;
	bytesPerChar: number;
	shareOfHeadroom: number;
	minOutputBytes: number;
	tools: string[];
	"spill.maxTotalBytes": number;
	"spill.maxAgeDays": number;
}>;

/** Persist settings (key by key, every other setting preserved) to the
 * project file when one exists, else the global file. Returns the re-read
 * effective settings. */
export function writeOutputLimitsSettings(
	cwd: string,
	patch: SettingsPatch,
	env: NodeJS.ProcessEnv = process.env,
): OutputLimitsSettingsWrite {
	const target = fs.existsSync(projectSettingsPath(cwd)) ? projectSettingsPath(cwd) : globalSettingsPath(env);
	const { obj, error } = readJson(target);
	if (error) return { ok: false, error };
	const next = obj ?? {};
	const section = { ...(sectionOf(obj, SECTION) ?? {}) } as Record<string, unknown>;
	const spill = { ...(sectionOf(section, "spill") ?? {}) } as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (key === "spill.maxTotalBytes") spill.maxTotalBytes = value;
		else if (key === "spill.maxAgeDays") spill.maxAgeDays = value;
		else section[key] = value;
	}
	if (Object.keys(spill).length > 0) section.spill = spill;
	next[SECTION] = section;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");
	} catch (err) {
		return { ok: false, error: `could not write ${target}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, path: target, settings: readOutputLimitsSettings(cwd, env).settings };
}

/**
 * Read the effective `compaction.reserveTokens` the way pi reads it: project
 * file overrides global file, which defaults to the built-in 16384. The
 * extension reads pi's value; it never sets one (out of scope).
 */
export function readReserveTokens(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
	const globalSection = sectionOf(readJson(globalSettingsPath(env)).obj, "compaction");
	const projectSection = sectionOf(readJson(projectSettingsPath(cwd)).obj, "compaction");
	for (const section of [projectSection, globalSection]) {
		const value = section?.reserveTokens;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return DEFAULT_RESERVE_TOKENS;
}
