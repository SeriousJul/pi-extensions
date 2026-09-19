/**
 * Settings for the Edit assist extension.
 *
 * Reads the `edit-assist` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EditAssistSettings {
	/** Enable the whole extension. Disabled, the built-in edit tool runs
	 * stock: no input correction, no honesty note, no Diagnosis, no hint. */
	enabled: boolean;
}

export const DEFAULT_ENABLED = true;

export const DEFAULTS: EditAssistSettings = {
	enabled: DEFAULT_ENABLED,
};

const SECTION = "edit-assist";

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

/** Read the Edit assist settings: project file overrides global, key by key.
 * Malformed values fall back to their defaults and are reported. */
export function readEditAssistSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: EditAssistSettings; errors: string[] } {
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
		},
		errors,
	};
}
