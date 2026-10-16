/**
 * Settings for the Safe compaction extension.
 *
 * Reads the `safeCompaction` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws. There is no settings
 * command in v1: the file is edited by hand.
 *
 * The reader also parses the top-level `retry` section of the same files,
 * the same section pi's settings manager reads. The wiring forwards the
 * result to pi's `compact()`, so the thinking-free re-run honors the user's
 * retry budget: a transient stream drop retries before the guard degrades
 * to the checkpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RetryPolicy } from "@earendil-works/pi-ai";

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
const RETRY_SECTION = "retry";

/** pi's own defaults for the `retry` section, per pi's settings manager. */
export const RETRY_DEFAULTS: Required<RetryPolicy> = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

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

function parseBool(section: string, key: string, value: unknown, fallback: boolean, errors: string[]): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	errors.push(`${section}.${key} must be a boolean, got: ${JSON.stringify(value)}`);
	return fallback;
}

function parseNumber(section: string, key: string, value: unknown, fallback: number, errors: string[]): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	errors.push(`${section}.${key} must be a number, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** Read the extension settings and pi's retry policy: the project file
 * overrides the global file, key by key. Malformed values fall back to
 * their defaults and are reported. */
export function readSafeCompactionSettings(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): { settings: SafeCompactionSettings; retry: Required<RetryPolicy>; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	const globalRetry = sectionOf(globalObj, RETRY_SECTION);
	const projectRetry = sectionOf(projectObj, RETRY_SECTION);
	return {
		settings: {
			enabled: parseBool(SECTION, "enabled", projectSection?.enabled ?? globalSection?.enabled, DEFAULT_ENABLED, errors),
		},
		retry: {
			enabled: parseBool(RETRY_SECTION, "enabled", projectRetry?.enabled ?? globalRetry?.enabled, RETRY_DEFAULTS.enabled, errors),
			maxRetries: parseNumber(RETRY_SECTION, "maxRetries", projectRetry?.maxRetries ?? globalRetry?.maxRetries, RETRY_DEFAULTS.maxRetries, errors),
			baseDelayMs: parseNumber(RETRY_SECTION, "baseDelayMs", projectRetry?.baseDelayMs ?? globalRetry?.baseDelayMs, RETRY_DEFAULTS.baseDelayMs, errors),
			maxAgentDelayMs: parseNumber(RETRY_SECTION, "maxAgentDelayMs", projectRetry?.maxAgentDelayMs ?? globalRetry?.maxAgentDelayMs, RETRY_DEFAULTS.maxAgentDelayMs, errors),
		},
		errors,
	};
}
