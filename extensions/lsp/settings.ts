/**
 * Settings for the lsp extension.
 *
 * Reads the `lsp` section of the settings files through the shared reader
 * (extensions/shared/settings.ts): the project `<cwd>/.pi/settings.json`
 * overrides the global `$PI_CODING_AGENT_DIR/settings.json` key by key. A
 * malformed value falls back to its default and is reported in the returned
 * error list; a read never throws.
 *
 * The section:
 *   enabled             kill switch. Disabled: no server starts, no tools
 *                       activate, no note, no annotation, no status line.
 *   servers             per-language overrides: { command, args, disabled }
 *   severity            lowest severity reported: "warning" (default) means
 *                       error and warning, "error" means error only
 *   maxOpenDocuments    the per-server Open document LRU cap (default 32)
 *   maxServers          the Concurrent server bound (default 4)
 *   timeoutMs           per-request timeout; the error names the server
 *                       (default 20000, ADR 0043)
 *   annotate            attach post-edit diagnostics to edit/write results
 *                       (default true); the lsp_* tools work either way
 *
 * `projectExplicitlyEnabled` is true when the project settings file names
 * `enabled: true` itself: that explicit operator decision is the exception
 * that lets servers run in a project pi does not trust (ADR 0040).
 */
import type { LspSettings } from "./types.ts";
import {
	agentDir,
	parseBool,
	parseCount,
	readSettingsJson,
	sectionOf,
} from "../shared/settings.ts";
import path from "node:path";

export const SECTION = "lsp";

/** The lowest severity the diagnostics report shows, inclusive. */
export type SeverityFilter = "warning" | "error";

export const DEFAULTS: LspSettings = {
	enabled: true,
	servers: {},
	severity: "warning",
	maxOpenDocuments: 32,
	maxServers: 4,
	timeoutMs: 20_000,
	annotate: true,
};

/** The language keys settings may name, in registry order. */
export const SERVER_KEYS = ["typescript", "c-cpp", "rust", "python", "go"] as const;
export type ServerKey = (typeof SERVER_KEYS)[number];

interface ServerOverride {
	command?: unknown;
	args?: unknown;
	disabled?: unknown;
}

/**
 * Read the lsp settings for one working directory. Project file wins key by
 * key; a per-language override wins whole (a project `servers.typescript`
 * replaces the global one, it does not merge into it), because a half
 * command line is more likely to be a mistake than an intent.
 */
export function readLspSettings(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): { settings: LspSettings; errors: string[]; projectExplicitlyEnabled: boolean } {
	const errors: string[] = [];
	const globalPath = path.join(agentDir(env), "settings.json");
	const projectPath = path.join(cwd, ".pi", "settings.json");
	const global = readSettingsJson(globalPath);
	const project = readSettingsJson(projectPath);
	if (global.error) errors.push(global.error);
	if (project.error) errors.push(project.error);
	const globalSection = sectionOf(global.obj, SECTION);
	const projectSection = sectionOf(project.obj, SECTION);
	// Project wins key by key; a key absent in the project file falls back
	// to the global value, which falls back to the default.
	const settingOf = (section: Record<string, unknown> | null, key: string): unknown =>
		section === null ? undefined : section[key];

	const merged: Record<string, unknown> = {};
	for (const key of ["enabled", "severity", "maxOpenDocuments", "maxServers", "timeoutMs", "annotate"] as const) {
		merged[key] = settingOf(projectSection, key) ?? settingOf(globalSection, key);
	}
	const servers: Record<string, unknown> = { ...(settingOf(globalSection, "servers") as Record<string, unknown> | undefined) };
	const projectServers = sectionOf(projectSection, "servers");
	if (projectServers) {
		for (const [lang, value] of Object.entries(projectServers)) {
			servers[lang] = value;
		}
	}
	const enabled = parseBool(SECTION, "enabled", merged.enabled, DEFAULTS.enabled, errors);
	const annotate = parseBool(SECTION, "annotate", merged.annotate, DEFAULTS.annotate, errors);
	const severity = merged.severity;
	let severityFilter: SeverityFilter = DEFAULTS.severity;
	if (severity !== undefined && severity !== null) {
		if (severity === "warning" || severity === "error") severityFilter = severity;
		else {
			errors.push(`${SECTION}.severity must be "warning" or "error", got: ${JSON.stringify(severity)}`);
		}
	}
	const maxOpenDocuments = parseCount(SECTION, "maxOpenDocuments", merged.maxOpenDocuments, DEFAULTS.maxOpenDocuments, errors);
	const maxServers = parseCount(SECTION, "maxServers", merged.maxServers, DEFAULTS.maxServers, errors);
	const timeoutMs = parseCount(SECTION, "timeoutMs", merged.timeoutMs, DEFAULTS.timeoutMs, errors);

	const serverOverrides: LspSettings["servers"] = {};
	for (const key of SERVER_KEYS) {
		const value = servers[key];
		if (value === undefined) continue;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			errors.push(`${SECTION}.servers.${key} must be an object, got: ${JSON.stringify(value)}`);
			continue;
		}
		const override: ServerOverride = value;
		const out: { command?: string; args?: string[]; disabled?: boolean } = {};
		if (override.command !== undefined) {
			if (typeof override.command === "string" && override.command.length > 0) out.command = override.command;
			else errors.push(`${SECTION}.servers.${key}.command must be a non-empty string, got: ${JSON.stringify(override.command)}`);
		}
		if (override.args !== undefined) {
			if (Array.isArray(override.args) && override.args.every((a) => typeof a === "string")) out.args = override.args;
			else errors.push(`${SECTION}.servers.${key}.args must be an array of strings, got: ${JSON.stringify(override.args)}`);
		}
		if (override.disabled !== undefined) {
			if (typeof override.disabled === "boolean") out.disabled = override.disabled;
			else errors.push(`${SECTION}.servers.${key}.disabled must be a boolean, got: ${JSON.stringify(override.disabled)}`);
		}
		serverOverrides[key] = out;
	}
	// An unknown language key is a settings error, not a silent extra server.
	for (const key of Object.keys(servers)) {
		if (!(SERVER_KEYS as readonly string[]).includes(key)) {
			errors.push(`${SECTION}.servers.${key} is not a known language (known: ${SERVER_KEYS.join(", ")})`);
		}
	}

	// The trust exception (ADR 0040): only the project file counts. The
	// global file's enabled: true is the default state, not a decision about
	// one project.
	const projectEnabledRaw = projectSection === null ? undefined : projectSection.enabled;
	const projectExplicitlyEnabled = projectEnabledRaw === true;

	return {
		settings: {
			enabled,
			servers: serverOverrides,
			severity: severityFilter,
			maxOpenDocuments,
			maxServers,
			timeoutMs,
			annotate,
		},
		errors,
		projectExplicitlyEnabled,
	};
}
