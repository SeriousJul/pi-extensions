import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULTS,
	DEFAULT_RESERVE_TOKENS,
	readPruningSettings,
	readReserveTokens,
	writePruningSettings,
} from "../../extensions/pruning/settings";

let cwd: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pruning-settings-project-"));
	agentDir = mkdtempSync(join(tmpdir(), "pruning-settings-agent-"));
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function projectSettings(obj: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(obj));
}

function globalSettings(obj: unknown): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
}

describe("readPruningSettings", () => {
	it("returns the defaults when no settings exist", () => {
		const { settings, errors } = readPruningSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("reads the pruning section from the global file", () => {
		globalSettings({ pruning: { minResultTokens: 500 } });
		const { settings } = readPruningSettings(cwd, env);
		expect(settings).toEqual({ enabled: true, minResultTokens: 500, protectCurrentTurn: true });
	});

	it("lets the project file override the global file, key by key", () => {
		globalSettings({ pruning: { enabled: false, minResultTokens: 500, protectCurrentTurn: false } });
		projectSettings({ pruning: { minResultTokens: 2000 } });
		const { settings, errors } = readPruningSettings(cwd, env);
		expect(settings).toEqual({ enabled: false, minResultTokens: 2000, protectCurrentTurn: false });
		expect(errors).toEqual([]);
	});

	it("falls back to the default and reports an error for each malformed value", () => {
		globalSettings({ pruning: { enabled: "yes", minResultTokens: -3, protectCurrentTurn: 1 } });
		const { settings, errors } = readPruningSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(3);
		expect(errors.join("\n")).toContain("pruning.enabled must be a boolean");
		expect(errors.join("\n")).toContain("pruning.minResultTokens must be a positive integer");
		expect(errors.join("\n")).toContain("pruning.protectCurrentTurn must be a boolean");
	});

	it("reports and survives an invalid JSON file", () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		const { settings, errors } = readPruningSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors.some((e) => e.includes("invalid JSON"))).toBe(true);
	});

	it("survives a non-object pruning section", () => {
		globalSettings({ pruning: "on" });
		const { settings, errors } = readPruningSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});
});

describe("writePruningSettings", () => {
	it("writes to the global file when no project file exists, preserving other settings", () => {
		globalSettings({ compaction: { reserveTokens: 999 } });
		const result = writePruningSettings(cwd, { minResultTokens: 777 }, env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.path).toBe(join(agentDir, "settings.json"));
			expect(result.settings.minResultTokens).toBe(777);
		}
		const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(written.compaction).toEqual({ reserveTokens: 999 });
		expect((written.pruning as Record<string, unknown>).minResultTokens).toBe(777);
	});

	it("writes to the project file when one exists", () => {
		projectSettings({});
		const result = writePruningSettings(cwd, { enabled: false }, env);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe(join(cwd, ".pi", "settings.json"));
	});

	it("patches key by key, keeping the other keys", () => {
		globalSettings({ pruning: { minResultTokens: 500 } });
		writePruningSettings(cwd, { enabled: false }, env);
		const { settings } = readPruningSettings(cwd, env);
		expect(settings).toEqual({ enabled: false, minResultTokens: 500, protectCurrentTurn: true });
	});
});

describe("readReserveTokens", () => {
	it("returns pi's built-in default when no settings exist", () => {
		expect(readReserveTokens(cwd, env)).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("reads the global value", () => {
		globalSettings({ compaction: { reserveTokens: 4096 } });
		expect(readReserveTokens(cwd, env)).toBe(4096);
	});

	it("lets the project file win", () => {
		globalSettings({ compaction: { reserveTokens: 4096 } });
		projectSettings({ compaction: { reserveTokens: 8192 } });
		expect(readReserveTokens(cwd, env)).toBe(8192);
	});

	it("falls back to the default for a malformed value", () => {
		globalSettings({ compaction: { reserveTokens: "lots" } });
		expect(readReserveTokens(cwd, env)).toBe(DEFAULT_RESERVE_TOKENS);
	});
});
