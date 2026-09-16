import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, readCompressSettings, writeCompressModel } from "../../extensions/compress/settings";

// ---------------------------------------------------------------------------
// Fixture: a temp home with a global settings dir, and a temp project cwd.
// ---------------------------------------------------------------------------

let tmp: string;
let project: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

function globalPath(): string {
	return path.join(agentDir, "settings.json");
}

function projectPath(): string {
	return path.join(project, ".pi", "settings.json");
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compress-settings-"));
	project = path.join(tmp, "project");
	agentDir = path.join(tmp, "agent");
	fs.mkdirSync(project, { recursive: true });
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("readCompressSettings", () => {
	it("returns the defaults when no settings files exist", () => {
		const { settings, errors } = readCompressSettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("reads the global section", () => {
		writeJson(globalPath(), {
			compress: { model: "anthropic/claude-haiku", keepTurns: 5 },
			other: { keep: true },
		});
		const { settings, errors } = readCompressSettings(project, env);
		expect(errors).toEqual([]);
		expect(settings.model).toEqual({ provider: "anthropic", id: "claude-haiku" });
		expect(settings.keepTurns).toBe(5);
		// Keys absent from the file keep their defaults.
		expect(settings.enabled).toBe(DEFAULTS.enabled);
		expect(settings.spanCapTokens).toBe(DEFAULTS.spanCapTokens);
		expect(settings.minSpanTokens).toBe(DEFAULTS.minSpanTokens);
	});

	it("overrides global, key by key, with the project file", () => {
		writeJson(globalPath(), { compress: { model: "anthropic/claude-haiku", keepTurns: 5, spanCapTokens: 900 } });
		writeJson(projectPath(), { compress: { model: "openai/gpt-5-mini", spanCapTokens: 250 } });
		const { settings, errors } = readCompressSettings(project, env);
		expect(errors).toEqual([]);
		expect(settings.model).toEqual({ provider: "openai", id: "gpt-5-mini" });
		expect(settings.spanCapTokens).toBe(250);
		// keepTurns comes from the global file (absent in the project file).
		expect(settings.keepTurns).toBe(5);
	});

	it("treats a project model of null as disabling, overriding a global model", () => {
		writeJson(globalPath(), { compress: { model: "anthropic/claude-haiku" } });
		writeJson(projectPath(), { compress: { model: null } });
		const { settings, errors } = readCompressSettings(project, env);
		expect(errors).toEqual([]);
		expect(settings.model).toBe(null);
	});

	it("allows model IDs with slashes after the provider", () => {
		writeJson(globalPath(), { compress: { model: "openai/gpt-5/preview" } });
		const { settings, errors } = readCompressSettings(project, env);
		expect(errors).toEqual([]);
		expect(settings.model).toEqual({ provider: "openai", id: "gpt-5/preview" });
	});

	it("keeps the defaults and reports an error for each malformed value", () => {
		writeJson(globalPath(), {
			compress: { model: "no-slash-here", enabled: "yes", keepTurns: -1, spanCapTokens: 0, minSpanTokens: 1.5 },
		});
		const { settings, errors } = readCompressSettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(5);
		expect(errors.join("\n")).toContain("compress.model");
		expect(errors.join("\n")).toContain("compress.enabled");
		expect(errors.join("\n")).toContain("compress.keepTurns");
		expect(errors.join("\n")).toContain("compress.spanCapTokens");
		expect(errors.join("\n")).toContain("compress.minSpanTokens");
	});

	it("reports an unreadable project file as an error, falling back to the global values", () => {
		writeJson(globalPath(), { compress: { model: "anthropic/claude-haiku" } });
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		fs.writeFileSync(projectPath(), "{ not json", "utf8");
		const { settings, errors } = readCompressSettings(project, env);
		expect(settings.model).toEqual({ provider: "anthropic", id: "claude-haiku" });
		expect(errors.join("\n")).toContain("invalid JSON");
	});

	it("allows keepTurns of 0", () => {
		writeJson(globalPath(), { compress: { keepTurns: 0 } });
		const { settings, errors } = readCompressSettings(project, env);
		expect(errors).toEqual([]);
		expect(settings.keepTurns).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("writeCompressModel", () => {
	it("writes to the global file when the project file does not exist", () => {
		const result = writeCompressModel(project, { provider: "anthropic", id: "claude-haiku" }, env);
		expect(result).toEqual({ ok: true, path: globalPath() });
		const global = readJson(globalPath());
		expect(global.compress).toEqual({ model: "anthropic/claude-haiku" });
		expect(fs.existsSync(projectPath())).toBe(false);
	});

	it("writes to the project file when it exists, leaving the global file untouched", () => {
		writeJson(globalPath(), { compress: { model: "global/model" }, usage: { level: "all" } });
		writeJson(projectPath(), { other: { keep: true } });
		const result = writeCompressModel(project, { provider: "openai", id: "gpt-5-mini" }, env);
		expect(result.ok).toBe(true);
		expect(readJson(projectPath())).toEqual({ other: { keep: true }, compress: { model: "openai/gpt-5-mini" } });
		expect(readJson(globalPath())).toEqual({ compress: { model: "global/model" }, usage: { level: "all" } });
	});

	it("persists null to disable, keeping the other compress keys", () => {
		writeJson(globalPath(), { compress: { model: "old/model", keepTurns: 3 } });
		const result = writeCompressModel(project, null, env);
		expect(result.ok).toBe(true);
		expect(readJson(globalPath()).compress).toEqual({ model: null, keepTurns: 3 });
	});

	it("preserves unrelated settings", () => {
		writeJson(globalPath(), { theme: "dark", modelRouter: { fallbacks: ["a/b"] } });
		writeCompressModel(project, { provider: "p", id: "m" }, env);
		const global = readJson(globalPath());
		expect(global.theme).toBe("dark");
		expect(global.modelRouter).toEqual({ fallbacks: ["a/b"] });
	});

	it("reports an error and does not clobber a malformed target file", () => {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(globalPath(), "{ not json", "utf8");
		const result = writeCompressModel(project, { provider: "p", id: "m" }, env);
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(globalPath(), "utf8")).toBe("{ not json");
	});
});
