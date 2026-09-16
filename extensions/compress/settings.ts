/**
 * Settings for the compress extension.
 *
 * Reads the `compress` section of the settings files: the project
 * `<cwd>/.pi/settings.json` overrides the global
 * `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`),
 * key by key. A malformed value falls back to its default and is reported
 * in the returned error list; it never throws.
 *
 * The `/compression-model` command persists the model through
 * `writeCompressModel`, which writes to the project file when one exists and
 * to the global file otherwise, preserving every other setting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRef } from "./core.ts";

export interface CompressSettings {
	/** Turn the extension on or off. */
	enabled: boolean;
	/** The compression model. Null: compression is off. */
	model: ModelRef | null;
	keepTurns: number;
	spanCapTokens: number;
	minSpanTokens: number;
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_MODEL: ModelRef | null = null;
export const DEFAULT_KEEP_TURNS = 2;
export const DEFAULT_SPAN_CAP_TOKENS = 500;
export const DEFAULT_MIN_SPAN_TOKENS = 1000;

export const DEFAULTS: CompressSettings = {
	enabled: DEFAULT_ENABLED,
	model: DEFAULT_MODEL,
	keepTurns: DEFAULT_KEEP_TURNS,
	spanCapTokens: DEFAULT_SPAN_CAP_TOKENS,
	minSpanTokens: DEFAULT_MIN_SPAN_TOKENS,
};

const SECTION = "compress";

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

function sectionOf(obj: Record<string, unknown> | null): Record<string, unknown> | null {
	if (!obj) return null;
	const section = obj[SECTION];
	if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
	return section as Record<string, unknown>;
}

function parseModel(value: unknown): { model: ModelRef | null; error: string | null } {
	if (value === null || value === undefined) return { model: null, error: null };
	if (typeof value !== "string" || value.trim() === "") {
		return { model: null, error: `${SECTION}.model must be "provider/model-id", null, or absent` };
	}
	const ref = value.trim();
	const slash = ref.indexOf("/");
	const provider = slash > 0 ? ref.slice(0, slash) : "";
	const id = slash > 0 ? ref.slice(slash + 1) : "";
	if (provider === "" || id === "") {
		return { model: null, error: `${SECTION}.model must be "provider/model-id": ${value}` };
	}
	return { model: { provider, id }, error: null };
}

function parseBool(key: string, value: unknown, fallback: boolean, errors: string[]): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	errors.push(`${SECTION}.${key} must be a boolean, got: ${JSON.stringify(value)}`);
	return fallback;
}

function parseCount(key: string, value: unknown, fallback: number, errors: string[], allowZero: boolean): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && (allowZero ? value >= 0 : value > 0)) return value;
	const min = allowZero ? "a non-negative integer" : "a positive integer";
	errors.push(`${SECTION}.${key} must be ${min}, got: ${JSON.stringify(value)}`);
	return fallback;
}

/** Read the compress settings: project file overrides global, key by key.
 * Errors are reported per malformed value, which falls back to its default. */
export function readCompressSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: CompressSettings; errors: string[] } {
	const errors: string[] = [];
	const { obj: globalObj, error: globalError } = readJson(globalSettingsPath(env));
	const { obj: projectObj, error: projectError } = readJson(projectSettingsPath(cwd));
	if (globalError) errors.push(globalError);
	if (projectError) errors.push(projectError);
	const globalSection = sectionOf(globalObj);
	const projectSection = sectionOf(projectObj);

	// The project section wins, key by key: a key absent in the project file
	// falls back to the global value.
	const model = (() => {
		if (projectSection && "model" in projectSection) {
			const { model, error } = parseModel(projectSection.model);
			if (error) {
				errors.push(error);
				return null;
			}
			return model;
		}
		if (globalSection && "model" in globalSection) {
			const { model, error } = parseModel(globalSection.model);
			if (error) {
				errors.push(error);
				return null;
			}
			return model;
		}
		return DEFAULT_MODEL;
	})();

	return {
		settings: {
			enabled: parseBool("enabled", projectSection?.enabled ?? globalSection?.enabled, DEFAULT_ENABLED, errors),
			model,
			keepTurns: parseCount("keepTurns", projectSection?.keepTurns ?? globalSection?.keepTurns, DEFAULT_KEEP_TURNS, errors, true),
			spanCapTokens: parseCount("spanCapTokens", projectSection?.spanCapTokens ?? globalSection?.spanCapTokens, DEFAULT_SPAN_CAP_TOKENS, errors, false),
			minSpanTokens: parseCount("minSpanTokens", projectSection?.minSpanTokens ?? globalSection?.minSpanTokens, DEFAULT_MIN_SPAN_TOKENS, errors, false),
		},
		errors,
	};
}

export type CompressModelWrite = { ok: true; path: string } | { ok: false; error: string };

/** Persist the compression model (null: disabled) to the project file when
 * one exists, else the global file. Every other setting is preserved. */
export function writeCompressModel(cwd: string, model: ModelRef | null, env: NodeJS.ProcessEnv = process.env): CompressModelWrite {
	const projectPath = projectSettingsPath(cwd);
	const target = fs.existsSync(projectPath) ? projectPath : globalSettingsPath(env);
	const { obj, error } = readJson(target);
	if (error) return { ok: false, error };
	const obj2 = obj ?? {};
	const section = sectionOf(obj as Record<string, unknown> | null) ?? {};
	obj2[SECTION] = { ...section, model: model ? `${model.provider}/${model.id}` : null };
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(obj2, null, 2) + "\n", "utf8");
	} catch (err) {
		return { ok: false, error: `could not write ${target}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, path: target };
}
