/**
 * Settings for the pruning extension.
 *
 * Reads the `pruning` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws. The file plumbing, the value
 * checks, and the merge on write all live in `extensions/shared/settings.ts`,
 * so every extension here reads the same two files the same way.
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
import {
	DEFAULT_RESERVE_TOKENS,
	globalSettingsPath,
	parseBool,
	parseCount,
	projectSettingsPath,
	readReserveTokens,
	readSettingsJson,
	sectionOf,
	writeSettingsSection,
	type SettingsObject,
} from "../shared/settings.ts";

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

/** pi's built-in default for compaction.reserveTokens, and the shared reader
 * for it: this extension reads pi's value and never writes one. */
export { DEFAULT_RESERVE_TOKENS, readReserveTokens };

const SECTION = "pruning";

/** Read the pruning settings: project file overrides global, key by key.
 * Malformed values fall back to their defaults and are reported. */
export function readPruningSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: PruningSettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readSettingsJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readSettingsJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	// The project section wins, key by key: a key absent in the project file
	// falls back to the global value.
	const pick = (key: string): unknown => projectSection?.[key] ?? globalSection?.[key];
	return {
		settings: {
			enabled: parseBool(SECTION, "enabled", pick("enabled"), DEFAULT_ENABLED, errors),
			minResultTokens: parseCount(SECTION, "minResultTokens", pick("minResultTokens"), DEFAULT_MIN_RESULT_TOKENS, errors),
			protectCurrentTurn: parseBool(SECTION, "protectCurrentTurn", pick("protectCurrentTurn"), DEFAULT_PROTECT_CURRENT_TURN, errors),
		},
		errors,
	};
}

export type PruningSettingsWrite = { ok: true; path: string; settings: PruningSettings } | { ok: false; error: string };

/** Persist pruning settings (key by key, every other setting preserved) to
 * the project file when one exists, else the global file. Returns the
 * re-read effective settings. */
export function writePruningSettings(cwd: string, patch: Partial<PruningSettings>, env: NodeJS.ProcessEnv = process.env): PruningSettingsWrite {
	const written = writeSettingsSection(cwd, SECTION, patch as SettingsObject, env);
	if (!written.ok) return written;
	return { ok: true, path: written.path, settings: readPruningSettings(cwd, env).settings };
}

