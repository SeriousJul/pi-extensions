import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_WAIT_MINUTES,
	readModelRouterSettings,
	type ModelRouterSettings,
} from "../../extensions/model-router/settings";

let cwd: string;
let agentDir: string;
let dirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "model-router-settings-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	dirs = [root];
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(settings?: unknown): { settings: ModelRouterSettings; errors: string[] } {
	if (settings !== undefined) writeJson(join(agentDir, "settings.json"), { modelRouter: settings });
	return readModelRouterSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
}

function readProject(settings: unknown): { settings: ModelRouterSettings; errors: string[] } {
	writeJson(join(cwd, ".pi", "settings.json"), { modelRouter: settings });
	return readModelRouterSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
}

describe("readModelRouterSettings", () => {
	it("returns all defaults when nothing is configured", () => {
		const { settings, errors } = read();
		expect(settings.enabled).toBe(true);
		expect(settings.precedence).toEqual(["switch", "wait"]);
		expect(settings.fallbacks).toEqual([]);
		expect(settings.maxWaitMinutes).toBe(DEFAULT_MAX_WAIT_MINUTES);
		expect(errors).toEqual([]);
	});

	it("reads the global section", () => {
		const { settings } = read({ fallbacks: ["anthropic/claude-x"] });
		expect(settings.fallbacks).toEqual([{ provider: "anthropic", id: "claude-x", raw: "anthropic/claude-x" }]);
	});

	it("merges key by key: project overrides global, global fills the rest", () => {
		writeJson(join(agentDir, "settings.json"), {
			modelRouter: { precedence: ["wait"], fallbacks: ["a/1"], maxWaitMinutes: 60 },
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			modelRouter: { maxWaitMinutes: 120 },
		});
		const { settings } = readModelRouterSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
		expect(settings.precedence).toEqual(["wait"]); // from global
		expect(settings.fallbacks.map((e) => e.raw)).toEqual(["a/1"]); // from global
		expect(settings.maxWaitMinutes).toBe(120); // project wins
	});

	it("project section wins for the same key even when global is malformed", () => {
		writeJson(join(agentDir, "settings.json"), { modelRouter: { enabled: "yes" } });
		writeJson(join(cwd, ".pi", "settings.json"), { modelRouter: { enabled: false } });
		const { settings, errors } = readModelRouterSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
		expect(settings.enabled).toBe(false);
		expect(errors).toEqual([]); // project value is used, global is not even parsed
	});

	it("falls back to the default and reports an error for a malformed boolean", () => {
		const { settings, errors } = read({ enabled: "yes" });
		expect(settings.enabled).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("enabled");
	});

	it("dedupes precedence and preserves order", () => {
		const { settings, errors } = read({ precedence: ["wait", "switch", "wait"] });
		expect(settings.precedence).toEqual(["wait", "switch"]);
		expect(errors).toEqual([]);
	});

	it("rejects an empty or unknown precedence with a default and error", () => {
		expect(read({ precedence: [] }).settings.precedence).toEqual(["switch", "wait"]);
		expect(read({ precedence: ["nope"] }).errors).toHaveLength(1);
		expect(read({ precedence: ["nope"] }).settings.precedence).toEqual(["switch", "wait"]);
	});

	it("parses fallbacks, skipping invalid entries with an error", () => {
		const { settings, errors } = read({ fallbacks: ["anthropic/claude-x", "no-slash", "/x", "y/", ""] });
		expect(settings.fallbacks).toEqual([{ provider: "anthropic", id: "claude-x", raw: "anthropic/claude-x" }]);
		expect(errors).toHaveLength(4);
	});

	it("allows a model id that contains slashes after the provider", () => {
		const { settings } = read({ fallbacks: ["openrouter/meta/llama-3"] });
		expect(settings.fallbacks).toEqual([
			{ provider: "openrouter", id: "meta/llama-3", raw: "openrouter/meta/llama-3" },
		]);
	});

	it("falls back to the default and reports an error for a non-positive maxWaitMinutes", () => {
		expect(read({ maxWaitMinutes: 0 }).settings.maxWaitMinutes).toBe(DEFAULT_MAX_WAIT_MINUTES);
		expect(read({ maxWaitMinutes: 0 }).errors).toHaveLength(1);
		expect(read({ maxWaitMinutes: -5 }).settings.maxWaitMinutes).toBe(DEFAULT_MAX_WAIT_MINUTES);
		expect(read({ maxWaitMinutes: "six" }).errors).toHaveLength(1);
	});

	it("ignores a missing or unreadable settings file", () => {
		const { settings, errors } = read();
		expect(errors).toEqual([]);
		expect(settings.enabled).toBe(true);
	});

	it("ignores a non-object modelRouter section", () => {
		writeJson(join(agentDir, "settings.json"), { modelRouter: "nope" });
		const { settings, errors } = readModelRouterSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
		expect(settings.enabled).toBe(true);
		expect(errors).toEqual([]);
	});
});
