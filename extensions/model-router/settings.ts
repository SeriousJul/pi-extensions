/**
 * model-router configuration, read from pi's settings.json following the
 * context-cap precedent: project <cwd>/.pi/settings.json overrides global
 * $PI_CODING_AGENT_DIR/settings.json (default ~/.pi/agent/settings.json),
 * key by key. The `modelRouter` section has exactly four keys:
 *
 *   enabled         boolean, default true
 *   precedence      ("switch" | "wait")[], default ["switch", "wait"]
 *   fallbacks       "provider/model-id"[], default []
 *   maxWaitMinutes  number > 0, default 360
 *
 * Nothing else is configurable. A malformed value falls back to its default
 * and is reported in `errors` (the wiring shows one notification).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StrategyName = "switch" | "wait";

export interface FallbackEntry {
	provider: string;
	id: string;
	/** The raw "provider/model-id" string as configured. */
	raw: string;
}

export interface ModelRouterSettings {
	enabled: boolean;
	precedence: StrategyName[];
	fallbacks: FallbackEntry[];
	maxWaitMinutes: number;
}

export const DEFAULT_PRECEDENCE: readonly StrategyName[] = ["switch", "wait"];
export const DEFAULT_MAX_WAIT_MINUTES = 360;

const STRATEGY_NAMES: readonly StrategyName[] = ["switch", "wait"];

interface SettingsShape {
	modelRouter?: unknown;
}

export function readModelRouterSettings(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): { settings: ModelRouterSettings; errors: string[] } {
	const project = readSettingsSectionAt(join(cwd, ".pi", "settings.json"));
	const global = readSettingsSectionAt(
		env.PI_CODING_AGENT_DIR
			? join(env.PI_CODING_AGENT_DIR, "settings.json")
			: join(homedir(), ".pi", "agent", "settings.json"),
	);
	const errors: string[] = [];

	const settings: ModelRouterSettings = {
		enabled: readKey(project, global, (section) => section?.enabled, (raw) => {
			if (typeof raw !== "boolean") {
				errors.push(`modelRouter.enabled must be a boolean; using ${true}`);
				return true;
			}
			return raw;
		}, true),
		precedence: readKey(project, global, (section) => section?.precedence, (raw) =>
			parsePrecedence(raw, errors), [...DEFAULT_PRECEDENCE],
		),
		fallbacks: readKey(project, global, (section) => section?.fallbacks, (raw) =>
			parseFallbacks(raw, errors), [],
		),
		maxWaitMinutes: readKey(project, global, (section) => section?.maxWaitMinutes, (raw) =>
			parseMaxWaitMinutes(raw, errors), DEFAULT_MAX_WAIT_MINUTES,
		),
	};
	return { settings, errors };
}

/** Per-key merge: project value, then global value, then the default. A key
 * absent from both files resolves to the default with no error; a key present
 * but malformed is reported and also resolves to the default. */
function readKey<T>(
	project: Record<string, unknown> | undefined,
	global: Record<string, unknown> | undefined,
	pick: (section: Record<string, unknown> | undefined) => unknown,
	parse: (raw: unknown) => T,
	defaultValue: T,
): T {
	const raw = pick(project) ?? pick(global);
	if (raw === undefined) return defaultValue;
	return parse(raw);
}

function readSettingsSectionAt(path: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SettingsShape;
		const section = parsed?.modelRouter;
		return typeof section === "object" && section !== null ? (section as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function parsePrecedence(raw: unknown, errors: string[]): StrategyName[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		errors.push(`modelRouter.precedence must be a non-empty array of "switch" and "wait"; using ${JSON.stringify(DEFAULT_PRECEDENCE)}`);
		return [...DEFAULT_PRECEDENCE];
	}
	for (const entry of raw) {
		if (!STRATEGY_NAMES.includes(entry as StrategyName)) {
			errors.push(`modelRouter.precedence contains unknown strategy ${JSON.stringify(entry)}; using ${JSON.stringify(DEFAULT_PRECEDENCE)}`);
			return [...DEFAULT_PRECEDENCE];
		}
	}
	// Deduplicate, keeping first position.
	return [...new Set(raw as StrategyName[])];
}

function parseFallbacks(raw: unknown, errors: string[]): FallbackEntry[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		errors.push("modelRouter.fallbacks must be an array of \"provider/model-id\" strings; using []");
		return [];
	}
	const entries: FallbackEntry[] = [];
	for (const item of raw) {
		const parsed = parseFallbackEntry(item);
		if (!parsed) {
			errors.push(`modelRouter.fallbacks contains invalid entry ${JSON.stringify(item)}; skipped`);
			continue;
		}
		entries.push(parsed);
	}
	return entries;
}

function parseFallbackEntry(raw: unknown): FallbackEntry | undefined {
	if (typeof raw !== "string") return undefined;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) return undefined;
	const provider = raw.slice(0, slash).trim();
	const id = raw.slice(slash + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id, raw };
}

function parseMaxWaitMinutes(raw: unknown, errors: string[]): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		errors.push(`modelRouter.maxWaitMinutes must be a number greater than 0; using ${DEFAULT_MAX_WAIT_MINUTES}`);
		return DEFAULT_MAX_WAIT_MINUTES;
	}
	return raw;
}
