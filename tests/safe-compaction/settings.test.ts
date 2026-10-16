import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETRY_DEFAULTS, DEFAULTS, readSafeCompactionSettings } from "../../extensions/safe-compaction/settings";

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

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-compaction-settings-"));
	project = path.join(tmp, "project");
	agentDir = path.join(tmp, "agent");
	fs.mkdirSync(project, { recursive: true });
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readSafeCompactionSettings", () => {
	it("returns the defaults when no settings files exist", () => {
		const { settings, errors } = readSafeCompactionSettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("reads the global section", () => {
		writeJson(globalPath(), { safeCompaction: { enabled: false } });
		const { settings, errors } = readSafeCompactionSettings(project, env);
		expect(settings).toEqual({ enabled: false });
		expect(errors).toEqual([]);
	});

	it("project settings override global", () => {
		writeJson(globalPath(), { safeCompaction: { enabled: false } });
		writeJson(projectPath(), { safeCompaction: { enabled: true } });
		const { settings, errors } = readSafeCompactionSettings(project, env);
		expect(settings).toEqual({ enabled: true });
		expect(errors).toEqual([]);
	});

	it("a malformed value falls back to the default and is reported", () => {
		writeJson(globalPath(), { safeCompaction: { enabled: "yes" } });
		const { settings, errors } = readSafeCompactionSettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("safeCompaction.enabled");
	});

	it("a broken project file is reported and the global file still applies", () => {
		fs.mkdirSync(path.dirname(projectPath()), { recursive: true });
		fs.writeFileSync(projectPath(), "{ not json", "utf8");
		writeJson(globalPath(), { safeCompaction: { enabled: false } });
		const { settings, errors } = readSafeCompactionSettings(project, env);
		expect(settings.enabled).toBe(false);
		expect(errors.some((e) => e.includes(projectPath()))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The retry policy: pi's own section, forwarded to the re-run
// ---------------------------------------------------------------------------

describe("readSafeCompactionSettings retry policy", () => {
	it("returns pi's retry defaults when no retry section exists", () => {
		const { retry, errors } = readSafeCompactionSettings(project, env);
		expect(retry).toEqual(RETRY_DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("reads the global retry section", () => {
		writeJson(globalPath(), { retry: { maxRetries: 5 } });
		const { retry } = readSafeCompactionSettings(project, env);
		expect(retry).toEqual({ ...RETRY_DEFAULTS, maxRetries: 5 });
	});

	it("project retry values override global, key by key", () => {
		writeJson(globalPath(), { retry: { enabled: false, maxRetries: 5 } });
		writeJson(projectPath(), { retry: { maxRetries: 1 } });
		const { retry } = readSafeCompactionSettings(project, env);
		expect(retry).toEqual({ ...RETRY_DEFAULTS, enabled: false, maxRetries: 1 });
	});

	it("a malformed retry value falls back to the default and is reported", () => {
		writeJson(globalPath(), { retry: { baseDelayMs: "fast" } });
		const { retry, errors } = readSafeCompactionSettings(project, env);
		expect(retry).toEqual(RETRY_DEFAULTS);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("retry.baseDelayMs");
	});

	it("a non-object retry section is ignored, like pi does", () => {
		writeJson(globalPath(), { retry: [1, 2, 3] });
		const { retry, errors } = readSafeCompactionSettings(project, env);
		expect(retry).toEqual(RETRY_DEFAULTS);
		expect(errors).toEqual([]);
	});
});
