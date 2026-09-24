import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULTS,
	DEFAULT_MIN_OUTPUT_BYTES,
	DEFAULT_RESERVE_TOKENS,
	DEFAULT_SHARE_OF_HEADROOM,
	envDisabled,
	readOutputLimitsSettings,
	readReserveTokens,
	writeOutputLimitsSettings,
} from "../../extensions/output-limits/settings";
import { DEFAULT_MAX_OUTPUT_TOKENS, PI_MAX_OUTPUT_BYTES } from "../../extensions/output-limits/core";

// The settings seam, on the same conventions as `pruning/settings.ts`: the
// project `.pi/settings.json` overrides `$PI_CODING_AGENT_DIR/settings.json`
// key by key, a malformed value falls back to its default and is reported,
// and nothing here ever throws.

let cwd: string;
let agentDir: string;

function writeGlobal(section: Record<string, unknown> | null): void {
	if (section === null) {
		rmSync(join(agentDir, "settings.json"), { force: true });
		return;
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputLimits: section }));
}

function writeProject(section: Record<string, unknown> | null): void {
	if (section === null) {
		rmSync(join(cwd, ".pi", "settings.json"), { force: true });
		return;
	}
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ outputLimits: section }));
}

function writeProjectRaw(text: string): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), text);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "output-limits-settings-"));
	agentDir = mkdtempSync(join(tmpdir(), "output-limits-settings-agent-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OUTPUT_LIMITS", "");
	writeProject(null);
	writeGlobal(null);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("defaults", () => {
	it("are the settled table", () => {
		expect(DEFAULTS).toEqual({
			enabled: true,
			maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
			maxLines: 2000,
			inflation: 2.0,
			bytesPerChar: 4,
			shareOfHeadroom: DEFAULT_SHARE_OF_HEADROOM,
			minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
			tools: ["bash", "read", "grep", "find", "ls"],
			spill: { maxTotalBytes: 512 * 1024 * 1024, maxAgeDays: 7 },
		});
	});

	it("make the extension inert by default: the outer max is pi's own per-call figure", () => {
		// Expressed in tokens at the default math, and never below pi's bytes.
		expect(PI_MAX_OUTPUT_BYTES).toBe(50 * 1024);
		expect(DEFAULTS.maxOutputTokens).toBeGreaterThanOrEqual(PI_MAX_OUTPUT_BYTES / 4);
	});
});

describe("readOutputLimitsSettings", () => {
	it("returns the defaults when neither file has the section", () => {
		const { settings, errors } = readOutputLimitsSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("lets the project file override the global file key by key", () => {
		writeGlobal({ shareOfHeadroom: 0.5, minOutputBytes: 1024 });
		writeProject({ shareOfHeadroom: 0.1 });
		const { settings } = readOutputLimitsSettings(cwd);
		// The project wins for the key it names; the global value still holds
		// for the key it does not.
		expect(settings.shareOfHeadroom).toBe(0.1);
		expect(settings.minOutputBytes).toBe(1024);
	});

	it("falls back to the default and reports a malformed value", () => {
		writeProject({ shareOfHeadroom: "0.5" });
		const { settings, errors } = readOutputLimitsSettings(cwd);
		expect(settings.shareOfHeadroom).toBe(DEFAULT_SHARE_OF_HEADROOM);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("outputLimits.shareOfHeadroom must be a number greater than 0 and at most 1");
	});

	it("rejects a share of zero and a share above one", () => {
		writeProject({ shareOfHeadroom: 0 });
		expect(readOutputLimitsSettings(cwd).errors).toHaveLength(1);
		writeProject({ shareOfHeadroom: 1.5 });
		expect(readOutputLimitsSettings(cwd).errors).toHaveLength(1);
		writeProject({ shareOfHeadroom: 1 });
		expect(readOutputLimitsSettings(cwd).errors).toEqual([]);
	});

	it("rejects a zero or fractional count", () => {
		writeProject({ maxOutputTokens: 0 });
		expect(readOutputLimitsSettings(cwd).errors[0]).toContain("maxOutputTokens must be a positive integer");
		writeProject({ maxLines: 1.5 });
		expect(readOutputLimitsSettings(cwd).errors[0]).toContain("maxLines must be a positive integer");
	});

	it("rejects an empty or non-string tools list", () => {
		writeProject({ tools: [] });
		expect(readOutputLimitsSettings(cwd).errors[0]).toContain("tools must be a non-empty array");
		writeProject({ tools: "bash" });
		expect(readOutputLimitsSettings(cwd).errors[0]).toContain("tools must be a non-empty array");
	});

	it("takes a tools list and drops duplicates", () => {
		writeProject({ tools: ["bash", "bash", "grep"] });
		const { settings, errors } = readOutputLimitsSettings(cwd);
		expect(settings.tools).toEqual(["bash", "grep"]);
		expect(errors).toEqual([]);
	});

	it("reads the spill sub-section and reports a malformed sub-key", () => {
		writeProject({ spill: { maxTotalBytes: 1000, maxAgeDays: "7" } });
		const { settings, errors } = readOutputLimitsSettings(cwd);
		expect(settings.spill.maxTotalBytes).toBe(1000);
		expect(settings.spill.maxAgeDays).toBe(7);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("spill.maxAgeDays must be a positive integer");
	});

	it("merges a global spill sub-section with a project one, key by key", () => {
		writeGlobal({ spill: { maxTotalBytes: 2048, maxAgeDays: 3 } });
		writeProject({ spill: { maxAgeDays: 9 } });
		const { settings } = readOutputLimitsSettings(cwd);
		expect(settings.spill).toEqual({ maxTotalBytes: 2048, maxAgeDays: 9 });
	});

	it("reports broken JSON without throwing", () => {
		writeProjectRaw("{ not json");
		const { settings, errors } = readOutputLimitsSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(errors.some((error) => error.includes("invalid JSON"))).toBe(true);
	});

	it("keeps every other setting in the file untouched", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 4096 }, other: { keep: true } }));
		const { settings } = readOutputLimitsSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(readReserveTokens(cwd)).toBe(4096);
	});

	it("honours the env escape hatch over both files", () => {
		// An escape hatch a stale project setting could undo is not one.
		writeProject({ enabled: true });
		writeGlobal({ enabled: true });
		expect(readOutputLimitsSettings(cwd, { PI_OUTPUT_LIMITS: "off" } as NodeJS.ProcessEnv).settings.enabled).toBe(false);
		expect(readOutputLimitsSettings(cwd, {} as NodeJS.ProcessEnv).settings.enabled).toBe(true);
	});
});

describe("envDisabled", () => {
	it("matches only the literal off, case and space tolerant", () => {
		expect(envDisabled({ PI_OUTPUT_LIMITS: "off" })).toBe(true);
		expect(envDisabled({ PI_OUTPUT_LIMITS: " OFF " })).toBe(true);
		expect(envDisabled({ PI_OUTPUT_LIMITS: "on" })).toBe(false);
		expect(envDisabled({ PI_OUTPUT_LIMITS: "0" })).toBe(false);
		expect(envDisabled({})).toBe(false);
	});
});

describe("writeOutputLimitsSettings", () => {
	it("writes the project file when one exists and preserves the rest", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 4096 } }));
		const result = writeOutputLimitsSettings(cwd, { shareOfHeadroom: 0.1 });
		expect(result.ok).toBe(true);
		const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(written.compaction.reserveTokens).toBe(4096);
		expect(written.outputLimits.shareOfHeadroom).toBe(0.1);
	});

	it("writes the global file when there is no project file", () => {
		const result = writeOutputLimitsSettings(cwd, { enabled: false });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.path).toBe(join(agentDir, "settings.json"));
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).outputLimits.enabled).toBe(false);
	});

	it("returns the re-read effective settings", () => {
		writeGlobal({ minOutputBytes: 1024 });
		const result = writeOutputLimitsSettings(cwd, { shareOfHeadroom: 0.4 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.settings.shareOfHeadroom).toBe(0.4);
		expect(result.settings.minOutputBytes).toBe(1024);
	});

	it("writes the spill sub-section without dropping its sibling keys", () => {
		writeProjectRaw(JSON.stringify({ outputLimits: { spill: { maxAgeDays: 3 } } }));
		const result = writeOutputLimitsSettings(cwd, { "spill.maxTotalBytes": 4096 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.settings.spill).toEqual({ maxTotalBytes: 4096, maxAgeDays: 3 });
	});

	it("refuses a file whose JSON is broken, rather than overwriting it", () => {
		writeProjectRaw("{ broken");
		const result = writeOutputLimitsSettings(cwd, { enabled: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("invalid JSON");
		expect(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).toBe("{ broken");
	});
});

describe("readReserveTokens", () => {
	it("is pi's built-in default when neither file names one", () => {
		expect(readReserveTokens(cwd)).toBe(DEFAULT_RESERVE_TOKENS);
		expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
	});

	it("lets the project file win, key for key", () => {
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 1000 } }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2000 } }));
		expect(readReserveTokens(cwd)).toBe(2000);
	});

	it("ignores a malformed value", () => {
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: "1000" } }));
		expect(readReserveTokens(cwd)).toBe(DEFAULT_RESERVE_TOKENS);
	});
});
