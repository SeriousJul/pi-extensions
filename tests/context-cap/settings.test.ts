import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RESERVE_TOKENS, readReserveTokens } from "../../extensions/context-cap/settings";

const dirs: string[] = [];

function makeCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-cap-"));
	dirs.push(dir);
	return dir;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function cleanup(): void {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(cleanup);

describe("readReserveTokens", () => {
	it("falls back to the built-in default when no settings exist", () => {
		const cwd = makeCwd();
		const env = { PI_CODING_AGENT_DIR: makeCwd() };
		expect(readReserveTokens(cwd, env)).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("reads the global settings file", () => {
		const cwd = makeCwd();
		const agentDir = makeCwd();
		writeJson(join(agentDir, "settings.json"), { compaction: { reserveTokens: 4096 } });
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(4096);
	});

	it("lets the project settings override the global ones", () => {
		const cwd = makeCwd();
		const agentDir = makeCwd();
		writeJson(join(agentDir, "settings.json"), { compaction: { reserveTokens: 4096 } });
		writeJson(join(cwd, ".pi", "settings.json"), { compaction: { reserveTokens: 2048 } });
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(2048);
	});

	it("ignores unreadable or malformed files", () => {
		const cwd = makeCwd();
		const agentDir = makeCwd();
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "[1,2");
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("ignores non-numeric reserveTokens values", () => {
		const cwd = makeCwd();
		const agentDir = makeCwd();
		writeJson(join(agentDir, "settings.json"), { compaction: { reserveTokens: "lots" } });
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(DEFAULT_RESERVE_TOKENS);
	});
});
