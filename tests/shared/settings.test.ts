import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentDir,
	DEFAULT_RESERVE_TOKENS,
	globalSettingsPath,
	parseBool,
	parseCount,
	projectSettingsPath,
	readReserveTokens,
	readSettingsJson,
	sectionOf,
	writeSettingsSection,
} from "../../extensions/shared/settings";

// The one place the two-file precedence, the malformed-value report, and the
// merge on write are written down. Three extensions read settings through this
// module (pruning, context-cap, output limits), and their own tests cover their
// own keys; what this file pins is the shared contract they all rely on, so a
// change here cannot quietly split the three readers apart.

let dirs: string[] = [];

function fresh(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `shared-settings-${label}-`));
	dirs.push(dir);
	return dir;
}

function writeJson(file: string, value: unknown): void {
	writeRaw(file, JSON.stringify(value));
}

function writeRaw(file: string, text: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("paths", () => {
	it("names the pair every reader walks", () => {
		expect(globalSettingsPath({ PI_CODING_AGENT_DIR: "/agent" })).toBe(join("/agent", "settings.json"));
		expect(projectSettingsPath("/work")).toBe(join("/work", ".pi", "settings.json"));
	});

	it("resolves the agent dir the way pi does", () => {
		expect(agentDir({})).toBe(join(process.env.HOME ?? "", ".pi", "agent"));
		expect(agentDir({ PI_CODING_AGENT_DIR: "/agent" })).toBe("/agent");
		// An empty variable is unset, not "the working directory": pi's own
		// reader treats it as absent, and a settings reader that disagreed would
		// look in a place pi never reads.
		expect(agentDir({ PI_CODING_AGENT_DIR: "" })).toBe(join(process.env.HOME ?? "", ".pi", "agent"));
		expect(agentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" })).toBe(join(process.env.HOME ?? "", "pi-agent"));
	});
});

describe("readSettingsJson", () => {
	it("treats an absent file as empty, not wrong", () => {
		expect(readSettingsJson(join(fresh("absent"), "settings.json"))).toEqual({ obj: null, error: null });
	});

	it("reports a file it cannot parse instead of throwing", () => {
		const dir = fresh("bad-json");
		writeFileSync(join(dir, "settings.json"), "{ not json");
		const read = readSettingsJson(join(dir, "settings.json"));
		expect(read.obj).toBeNull();
		expect(read.error).toContain("invalid JSON");
	});

	it("reports a top level that is not an object", () => {
		const dir = fresh("array");
		writeFileSync(join(dir, "settings.json"), "[1,2]");
		expect(readSettingsJson(join(dir, "settings.json")).error).toContain("must be an object");
	});

	it("gives nothing for a section that is not an object", () => {
		expect(sectionOf({ pruning: "yes" }, "pruning")).toBeNull();
		expect(sectionOf({ pruning: [1] }, "pruning")).toBeNull();
		expect(sectionOf(null, "pruning")).toBeNull();
	});
});

describe("value checks", () => {
	it("fall back and report, never throw", () => {
		const errors: string[] = [];
		expect(parseBool("sec", "enabled", "yes", true, errors)).toBe(true);
		expect(parseCount("sec", "maxLines", 0, 2_000, errors)).toBe(2_000);
		expect(errors).toEqual([
			"sec.enabled must be a boolean, got: \"yes\"",
			"sec.maxLines must be a positive integer, got: 0",
		]);
	});

	it("keeps a value that is in range and reports one that is not", () => {
		const errors: string[] = [];
		expect(parseCount("sec", "minOutputBytes", 4096, 1, errors)).toBe(4096);
		expect(parseCount("sec", "minOutputBytes", 4096.5, 1, errors)).toBe(1);
		expect(errors).toHaveLength(1);
	});
});

describe("readReserveTokens", () => {
	it("is pi's built-in default with nothing to read", () => {
		expect(readReserveTokens(fresh("a"), { PI_CODING_AGENT_DIR: fresh("b") })).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("lets the project file win over the global one, key by key", () => {
		const cwd = fresh("cwd");
		const agentDir = fresh("agent");
		writeJson(join(agentDir, "settings.json"), { compaction: { reserveTokens: 4096 } });
		writeJson(join(cwd, ".pi", "settings.json"), { other: 1 });
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(4096);
		writeJson(join(cwd, ".pi", "settings.json"), { compaction: { reserveTokens: 2048 } });
		expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: agentDir })).toBe(2048);
	});

	it("rejects a value that is not a positive number instead of trusting it", () => {
		const cwd = fresh("cwd");
		for (const bad of [0, -1, "8192", null, {}]) {
			writeJson(join(cwd, ".pi", "settings.json"), { compaction: { reserveTokens: bad } });
			expect(readReserveTokens(cwd, { PI_CODING_AGENT_DIR: fresh("agent") })).toBe(DEFAULT_RESERVE_TOKENS);
		}
	});
});

describe("writeSettingsSection", () => {
	it("writes the project file when one exists, and keeps every other key", () => {
		const cwd = fresh("cwd");
		const agentDir = fresh("agent");
		writeJson(join(cwd, ".pi", "settings.json"), { compaction: { reserveTokens: 4096 }, pruning: { enabled: false } });
		const written = writeSettingsSection(cwd, "pruning", { minResultTokens: 500 }, { PI_CODING_AGENT_DIR: agentDir });
		expect(written.ok).toBe(true);
		expect(written.ok && written.path).toBe(join(cwd, ".pi", "settings.json"));
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({
			compaction: { reserveTokens: 4096 },
			pruning: { enabled: false, minResultTokens: 500 },
		});
	});

	it("falls back to the global file when the project has none", () => {
		const cwd = fresh("cwd");
		const agentDir = fresh("agent");
		const written = writeSettingsSection(cwd, "outputLimits", { shareOfHeadroom: 0.1 }, { PI_CODING_AGENT_DIR: agentDir });
		expect(written.ok && written.path).toBe(join(agentDir, "settings.json"));
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).outputLimits).toEqual({ shareOfHeadroom: 0.1 });
	});

	it("writes a dotted key one level down, and merges the sub-section", () => {
		const cwd = fresh("cwd");
		writeJson(join(cwd, ".pi", "settings.json"), { outputLimits: { enabled: true, spill: { maxAgeDays: 3 } } });
		writeSettingsSection(cwd, "outputLimits", { "spill.maxTotalBytes": 1024 }, { PI_CODING_AGENT_DIR: fresh("agent") });
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).outputLimits).toEqual({
			enabled: true,
			spill: { maxAgeDays: 3, maxTotalBytes: 1024 },
		});
	});

	it("reports a file it would have corrupted instead of writing over it", () => {
		const cwd = fresh("cwd");
		writeRaw(join(cwd, ".pi", "settings.json"), "{ half a file");		const written = writeSettingsSection(cwd, "pruning", { enabled: true }, { PI_CODING_AGENT_DIR: fresh("agent") });
		expect(written.ok).toBe(false);
		expect(written.ok === false && written.error).toContain("invalid JSON");
		expect(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).toBe("{ half a file");
	});
});
