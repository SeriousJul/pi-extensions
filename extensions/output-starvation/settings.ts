/**
 * Settings for the output-starvation guard.
 *
 * Reads the `outputStarvation` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws. The section is read once per
 * session and re-read on reload. The file plumbing, the value checks, and
 * the merge on write all live in `extensions/shared/settings.ts`, so this
 * file states only which keys exist and what each one means.
 *
 * The escape hatch is the environment: `PI_OUTPUT_STARVATION=off` turns the
 * guard off without touching a file, the way Output limits' does. It wins
 * over both settings files, because an escape hatch that a stale project
 * setting can undo is not one.
 *
 * `inflation` and `bytesPerChar` carry the same names, and the same
 * defaults, as the keys Output limits and Safe branch summary read, so one
 * mental model covers all three extensions: the guard's Corrected estimate
 * is pi's chars/4 figure times the Inflation factor.
 *
 * `safetyMargin` and `minAnswerTokens` default to pi's own figures - the
 * margin its output clamp always leaves and the answer room it always
 * insists on - pinned in `guard.ts` and pinned again against pi's code in
 * the tests. The guard spends pi's margin rather than inventing one, so a
 * Fit and pi's own clamp disagree only about the estimate, never about the
 * room they leave.
 *
 * pi's `compaction.reserveTokens` is read the way pi resolves it, for the
 * model the session is on, to name the reserve disagreement once per
 * session. The guard reads it and never writes it (out of scope).
 */
import {
	parseBool,
	parseCount,
	parseRatio,
	globalSettingsPath,
	projectSettingsPath,
	readSettingsJson,
	sectionOf,
} from "../shared/settings.ts";
import { PI_MIN_ANSWER_TOKENS, PI_SAFETY_MARGIN } from "./guard.ts";

export interface OutputStarvationSettings {
	/** Turn the guard on or off. */
	enabled: boolean;
	/** The Inflation factor on pi's chars/4 estimate. */
	inflation: number;
	/** The characters per token pi's own estimate assumes. */
	bytesPerChar: number;
	/** The room the Fit leaves unbudgeted, in tokens. pi's own clamp margin. */
	safetyMargin: number;
	/** The smallest answer budget the guard will send. Below it the guard
	 * refuses instead of fitting. */
	minAnswerTokens: number;
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_INFLATION = 2.0;
export const DEFAULT_BYTES_PER_CHAR = 4;
export const DEFAULT_SAFETY_MARGIN = PI_SAFETY_MARGIN;
export const DEFAULT_MIN_ANSWER_TOKENS = PI_MIN_ANSWER_TOKENS;

export const DEFAULTS: OutputStarvationSettings = {
	enabled: DEFAULT_ENABLED,
	inflation: DEFAULT_INFLATION,
	bytesPerChar: DEFAULT_BYTES_PER_CHAR,
	safetyMargin: DEFAULT_SAFETY_MARGIN,
	minAnswerTokens: DEFAULT_MIN_ANSWER_TOKENS,
};

/** The env var that turns the guard off regardless of both settings files. */
export const OFF_ENV_VAR = "PI_OUTPUT_STARVATION";

const SECTION = "outputStarvation";

/** True when the environment escape hatch turns the guard off. */
export function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[OFF_ENV_VAR];
	return typeof value === "string" && value.trim().toLowerCase() === "off";
}

/** Read the guard's settings: project file overrides global, key by key.
 * Malformed values fall back to their default and are reported. */
export function readOutputStarvationSettings(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): { settings: OutputStarvationSettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readSettingsJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readSettingsJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	// The section that WINS for a key wins for its value too: a project file
	// that names a key wrongly falls back to the default, not to the global
	// file's value for the same key.
	const pick = <T>(key: string, fallback: T): T | undefined => {
		const source = projectSection && key in projectSection ? projectSection : globalSection && key in globalSection ? globalSection : undefined;
		return source === undefined ? fallback : (source[key] as T);
	};

	const settings: OutputStarvationSettings = {
		enabled: envDisabled(env) ? false : parseBool(SECTION, "enabled", pick<boolean>("enabled", DEFAULT_ENABLED), DEFAULT_ENABLED, errors),
		inflation: parseRatio(SECTION, "inflation", pick<number>("inflation", DEFAULT_INFLATION), DEFAULT_INFLATION, Number.POSITIVE_INFINITY, errors),
		bytesPerChar: parseRatio(SECTION, "bytesPerChar", pick<number>("bytesPerChar", DEFAULT_BYTES_PER_CHAR), DEFAULT_BYTES_PER_CHAR, Number.POSITIVE_INFINITY, errors),
		safetyMargin: parseCount(SECTION, "safetyMargin", pick<number>("safetyMargin", DEFAULT_SAFETY_MARGIN), DEFAULT_SAFETY_MARGIN, errors),
		minAnswerTokens: parseCount(SECTION, "minAnswerTokens", pick<number>("minAnswerTokens", DEFAULT_MIN_ANSWER_TOKENS), DEFAULT_MIN_ANSWER_TOKENS, errors),
	};
	return { settings, errors };
}
