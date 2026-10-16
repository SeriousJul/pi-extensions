/**
 * Settings for the Safe compaction extension.
 *
 * Reads the `safeCompaction` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws. There is no settings
 * command in v1: the file is edited by hand.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SafeCompactionSettings {
	/** Turn the extension on or off. Off: pi's built-in summarizer runs
	 * unmodified, thinking level and all. */
	enabled: boolean;
}

export const DEFAULT_ENABLED = true;

export const DEFAULTS: SafeCompactionSettings = {
	enabled: DEFAULT_ENABLED,
};

const SECTION = "safeCompaction";

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

/** Read the extension settings: project file overrides global, key by key.
 * Malformed values fall back to their default and are reported. */
export function readSafeCompactionSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: SafeCompactionSettings; errors: string[] } {
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
		},
		errors,
	};
}
