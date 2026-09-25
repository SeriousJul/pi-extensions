/**
 * Settings for the output limits extension.
 *
 * Reads the `outputLimits` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`), key
 * by key. A malformed value falls back to its default and is reported in the
 * returned error list; it never throws. The section is read once per session
 * and re-read on reload. The file plumbing, the value checks, and the merge on
 * write all live in `extensions/shared/settings.ts`, so this file states only
 * which keys exist and what each one means.
 *
 * The escape hatch is the environment: `PI_OUTPUT_LIMITS=off` turns the
 * extension off without touching a file. It wins over both settings files,
 * because an escape hatch that a stale project setting can undo is not one.
 *
 * Also reads pi's own `compaction.reserveTokens` the way pi resolves it, for
 * the model the session is on: a current-model `modelOverrides` entry first,
 * then the plain setting, then pi's built-in default, and a reserve of 0 is the
 * value pi accepts. Headroom is the Effective window minus that reserve minus
 * the usage pi reports. The extension never sets it (out of scope).
 *
 * `maxOutputTokens` defaults to pi's own per-call figure plus the slack pi's
 * own notice adds past it, expressed in tokens, so the extension is always on
 * and still invisible until Headroom gets tight. `maxLines` defaults to naming
 * no figure at all, which means each tool's own line ceiling from pi plus the
 * same notice allowance: pi cuts bash and read by line and cuts grep, find, and
 * ls by bytes alone, so one global 2000-line ceiling was stricter than pi on
 * three of the five tools for a reason unrelated to the window.
 */
import {
	DEFAULT_RESERVE_TOKENS,
	globalSettingsPath,
	parseBool,
	parseCount,
	parseNames,
	parseNullableCount,
	parseRatio,
	projectSettingsPath,
	readReserveTokens,
	readSettingsJson,
	sectionOf,
	writeSettingsSection,
} from "../shared/settings.ts";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	type TokenMath,
} from "./core.ts";

export interface OutputLimitsSettings {
	/** Turn the extension on or off. */
	enabled: boolean;
	/** The per-call outer max, in tokens. */
	maxOutputTokens: number;
	/** The per-call line max, or `null` for each tool's own figure from pi. */
	maxLines: number | null;
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

/**
 * The default line max: `null`, meaning each tool's own figure from pi.
 *
 * pi does not cut every tool by line. `bash` and `read` get
 * `core/tools/truncate.ts` DEFAULT_MAX_LINES; `grep`, `find`, and `ls` hand
 * their own cutter `maxLines: Number.MAX_SAFE_INTEGER` because their match,
 * result, and entry limits already cap the rows (ADR 0026, the one-directional
 * rule). A
 * single 2000-line ceiling here was therefore stricter than pi on three of the
 * five tools for a reason that had nothing to do with the context window, which
 * inverts the one-directional rule. Naming a number in settings is a deliberate
 * ceiling and applies to every bounded tool.
 */
export const DEFAULT_MAX_LINES: number | null = null;
export const DEFAULT_INFLATION = 2.0;
export const DEFAULT_BYTES_PER_CHAR = 4;
export const DEFAULT_SHARE_OF_HEADROOM = 0.25;
export const DEFAULT_MIN_OUTPUT_BYTES = 4096;
export const DEFAULT_TOOLS = ["bash", "read", "grep", "find", "ls"];
export const DEFAULT_SPILL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SPILL_MAX_AGE_DAYS = 7;

/** pi's own compaction reserveTokens default, from the shared reader. */
export { DEFAULT_RESERVE_TOKENS, readReserveTokens };

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
	const { obj: globalObj, error: globalError } = readSettingsJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readSettingsJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj, SECTION);
	const projectSection = sectionOf(projectObj, SECTION);
	// The section that WINS for a key wins for its value too, even when that
	// value is an explicit null: `null` is a real answer for a nullable key like
	// `maxLines`, meaning "auto", and it must not quietly fall through to the
	// other file.
	const pick = <T>(key: string, fallback: T): T | null | undefined => {
		const source = projectSection && key in projectSection ? projectSection : globalSection && key in globalSection ? globalSection : undefined;
		return source === undefined ? fallback : (source[key] as T);
	};
	const spillGlobal = sectionOf(globalSection, "spill");
	const spillProject = sectionOf(projectSection, "spill");
	const pickSpill = <T>(key: string, fallback: T): T | undefined => {
		const value = spillProject?.[key] ?? spillGlobal?.[key];
		return value === undefined ? fallback : (value as T);
	};

	const settings: OutputLimitsSettings = {
		enabled: envDisabled(env) ? false : parseBool(SECTION, "enabled", pick<boolean>("enabled", DEFAULT_ENABLED), DEFAULT_ENABLED, errors),
		maxOutputTokens: parseCount(SECTION, "maxOutputTokens", pick<number>("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS), DEFAULT_MAX_OUTPUT_TOKENS, errors),
		maxLines: parseNullableCount(SECTION, "maxLines", pick<number | null>("maxLines", DEFAULT_MAX_LINES), DEFAULT_MAX_LINES, errors),
		inflation: parseRatio(SECTION, "inflation", pick<number>("inflation", DEFAULT_INFLATION), DEFAULT_INFLATION, Number.POSITIVE_INFINITY, errors),
		bytesPerChar: parseRatio(SECTION, "bytesPerChar", pick<number>("bytesPerChar", DEFAULT_BYTES_PER_CHAR), DEFAULT_BYTES_PER_CHAR, Number.POSITIVE_INFINITY, errors),
		shareOfHeadroom: parseRatio(SECTION, "shareOfHeadroom", pick<number>("shareOfHeadroom", DEFAULT_SHARE_OF_HEADROOM), DEFAULT_SHARE_OF_HEADROOM, 1, errors),
		minOutputBytes: parseCount(SECTION, "minOutputBytes", pick<number>("minOutputBytes", DEFAULT_MIN_OUTPUT_BYTES), DEFAULT_MIN_OUTPUT_BYTES, errors),
		tools: parseNames(SECTION, "tools", pick<string[]>("tools", DEFAULT_TOOLS), DEFAULT_TOOLS, errors),
		spill: {
			maxTotalBytes: parseCount(SECTION, "spill.maxTotalBytes", pickSpill<number>("maxTotalBytes", DEFAULT_SPILL_MAX_TOTAL_BYTES), DEFAULT_SPILL_MAX_TOTAL_BYTES, errors),
			maxAgeDays: parseCount(SECTION, "spill.maxAgeDays", pickSpill<number>("maxAgeDays", DEFAULT_SPILL_MAX_AGE_DAYS), DEFAULT_SPILL_MAX_AGE_DAYS, errors),
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
	/** `null` writes pi's own per-tool default back over a number. */
	maxLines: number | null;
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
 * effective settings. A dotted patch key writes one level down, which is how
 * `spill.maxAgeDays` reaches the `spill` sub-section. */
export function writeOutputLimitsSettings(
	cwd: string,
	patch: SettingsPatch,
	env: NodeJS.ProcessEnv = process.env,
): OutputLimitsSettingsWrite {
	const written = writeSettingsSection(cwd, SECTION, patch as Record<string, unknown>, env);
	if (!written.ok) return written;
	return { ok: true, path: written.path, settings: readOutputLimitsSettings(cwd, env).settings };
}

