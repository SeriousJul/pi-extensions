/**
 * Settings for the Safe branch summary extension.
 *
 * Reads the `safeBranchSummary` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws. There is no settings
 * command in v1: the file is edited by hand.
 *
 * Also reads pi's own `branchSummary.reserveTokens` from the same merged
 * settings, the same way pi reads it, so the two paths never disagree about
 * the margin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SafeBranchSummarySettings {
	/** Turn the extension on or off. Off: pi's built-in summarizer runs. */
	enabled: boolean;
	/** The Inflation factor dividing the safe budget out of the window margin. */
	inflationFactor: number;
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_INFLATION_FACTOR = 2.0;

/** pi's built-in default for branchSummary.reserveTokens. */
export const DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS = 16384;

export const DEFAULTS: SafeBranchSummarySettings = {
	enabled: DEFAULT_ENABLED,
	inflationFactor: DEFAULT_INFLATION_FACTOR,
};

const SECTION = "safeBranchSummary";

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

function sectionOf(obj: Record<string, unknown> | null, name: string): Record<string, unknown> | null {
	if (!obj) return null;
	const section = obj[name];
	if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
	return section as Record<string, unknown>;
}

function parseBool(key: string, value: unknown, fallback: boolean, errors: string[]): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	errors.push(`${SECTION}.${key} must be a boolean, got: ${JSON.stringify(value)}`);
	return fallback;
}

function parseInflationFactor(key: string, value: unknown, fallback: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	errors.push(`${SECTION}.${key} must be a positive number, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** Read the extension settings: project file overrides global, key by key.
 * Malformed values fall back to their default and are reported. */
export function readSafeBranchSummarySettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: SafeBranchSummarySettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);

	return {
		settings: {
			enabled: parseBool("enabled", projectSection?.enabled ?? globalSection?.enabled, DEFAULT_ENABLED, errors),
			inflationFactor: parseInflationFactor(
				"inflationFactor",
				projectSection?.inflationFactor ?? globalSection?.inflationFactor,
				DEFAULT_INFLATION_FACTOR,
				errors,
			),
		},
		errors,
	};
}

/**
 * Read pi's own branchSummary.reserveTokens the way pi merges settings:
 * project file overrides global file, which defaults to the built-in
 * 16384. A missing or malformed value falls through to the default.
 */
export function readBranchSummaryReserveTokens(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
	const { obj: globalObj } = readJson(globalSettingsPath(env));
	const { obj: projectObj } = readJson(projectSettingsPath(cwd));
	for (const section of [sectionOf(projectObj, "branchSummary"), sectionOf(globalObj, "branchSummary")]) {
		const value = section?.reserveTokens;
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS;
}
