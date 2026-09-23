import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULTS,
	DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS,
	readBranchSummaryReserveTokens,
	readSafeBranchSummarySettings,
} from "../../extensions/safe-branch-summary/settings";

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
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-branch-summary-settings-"));
	project = path.join(tmp, "project");
	agentDir = path.join(tmp, "agent");
	fs.mkdirSync(project, { recursive: true });
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Extension settings
// ---------------------------------------------------------------------------

describe("readSafeBranchSummarySettings", () => {
	it("returns the defaults when no settings files exist", () => {
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("reads the global section", () => {
		writeJson(globalPath(), { safeBranchSummary: { enabled: false, inflationFactor: 1.5 } });
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		expect(settings).toEqual({ enabled: false, inflationFactor: 1.5 });
		expect(errors).toEqual([]);
	});

	it("project settings override global, key by key", () => {
		writeJson(globalPath(), { safeBranchSummary: { enabled: false, inflationFactor: 1.5 } });
		writeJson(projectPath(), { safeBranchSummary: { inflationFactor: 3 } });
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		// The project key wins; the absent key falls back to global.
		expect(settings).toEqual({ enabled: false, inflationFactor: 3 });
		expect(errors).toEqual([]);
	});

	it("a malformed value falls back to the default and is reported", () => {
		writeJson(globalPath(), { safeBranchSummary: { enabled: "yes", inflationFactor: 0 } });
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("safeBranchSummary.enabled");
		expect(errors[1]).toContain("safeBranchSummary.inflationFactor");
	});

	it("negative and non-finite inflation factors fall back and are reported", () => {
		writeJson(globalPath(), { safeBranchSummary: { inflationFactor: -2 } });
		expect(readSafeBranchSummarySettings(project, env).settings).toEqual(DEFAULTS);
		writeJson(globalPath(), { safeBranchSummary: { inflationFactor: "2" } });
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(1);
	});

	it("a broken project file is reported and the global file still applies", () => {
		fs.mkdirSync(path.dirname(projectPath()), { recursive: true });
		fs.writeFileSync(projectPath(), "{ not json", "utf8");
		writeJson(globalPath(), { safeBranchSummary: { inflationFactor: 2.5 } });
		const { settings, errors } = readSafeBranchSummarySettings(project, env);
		expect(settings.inflationFactor).toBe(2.5);
		expect(errors.some((e) => e.includes(projectPath()))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// pi's own reserve margin
// ---------------------------------------------------------------------------

describe("readBranchSummaryReserveTokens", () => {
	it("defaults to the built-in 16384", () => {
		expect(readBranchSummaryReserveTokens(project, env)).toBe(DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS);
	});

	it("reads branchSummary.reserveTokens from the global file", () => {
		writeJson(globalPath(), { branchSummary: { reserveTokens: 4096 } });
		expect(readBranchSummaryReserveTokens(project, env)).toBe(4096);
	});

	it("the project file wins over the global file", () => {
		writeJson(globalPath(), { branchSummary: { reserveTokens: 4096 } });
		writeJson(projectPath(), { branchSummary: { reserveTokens: 8192 } });
		expect(readBranchSummaryReserveTokens(project, env)).toBe(8192);
	});

	it("a malformed value falls through to the default", () => {
		writeJson(globalPath(), { branchSummary: { reserveTokens: "lots" } });
		expect(readBranchSummaryReserveTokens(project, env)).toBe(DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS);
	});
});
