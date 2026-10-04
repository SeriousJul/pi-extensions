// Settings tests for the output-starvation guard (issue #122). The guard
// reads its own `outputStarvation` section through the shared settings
// reader: the project `.pi/settings.json` overrides
// `$PI_CODING_AGENT_DIR/settings.json` key by key, a malformed value falls
// back to its default and is reported, and nothing here ever throws. The
// environment escape hatch wins over both files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULTS,
	DEFAULT_BYTES_PER_CHAR,
	DEFAULT_INFLATION,
	DEFAULT_MIN_ANSWER_TOKENS,
	DEFAULT_SAFETY_MARGIN,
	envDisabled,
	readOutputStarvationSettings,
} from "../../extensions/output-starvation/settings";
import { PI_MIN_ANSWER_TOKENS, PI_SAFETY_MARGIN } from "../../extensions/output-starvation/guard";

let cwd: string;
let agentDir: string;

function writeGlobal(section: Record<string, unknown> | null): void {
	if (section === null) {
		rmSync(join(agentDir, "settings.json"), { force: true });
		return;
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputStarvation: section }));
}

function writeProject(section: Record<string, unknown> | null): void {
	if (section === null) {
		rmSync(join(cwd, ".pi", "settings.json"), { force: true });
		return;
	}
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ outputStarvation: section }));
}

function writeProjectRaw(text: string): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), text);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "output-starvation-settings-"));
	agentDir = mkdtempSync(join(tmpdir(), "output-starvation-settings-agent-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OUTPUT_STARVATION", "");
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
			inflation: 2.0,
			bytesPerChar: 4,
			safetyMargin: PI_SAFETY_MARGIN,
			minAnswerTokens: PI_MIN_ANSWER_TOKENS,
		});
		expect(DEFAULT_INFLATION).toBe(2.0);
		expect(DEFAULT_BYTES_PER_CHAR).toBe(4);
	});

	it("carry pi's own figures for the margin and the answer room", () => {
		// The guard spends pi's clamp margin and pi's answer room rather than
		// inventing numbers of its own; the guard-core test pins the constants
		// against pi's code, and this pins that the defaults are those constants.
		expect(DEFAULT_SAFETY_MARGIN).toBe(PI_SAFETY_MARGIN);
		expect(DEFAULT_MIN_ANSWER_TOKENS).toBe(PI_MIN_ANSWER_TOKENS);
		expect(DEFAULT_SAFETY_MARGIN).toBe(4096);
		expect(DEFAULT_MIN_ANSWER_TOKENS).toBe(1024);
	});
});

describe("readOutputStarvationSettings", () => {
	it("returns the defaults when neither file has the section", () => {
		const { settings, errors } = readOutputStarvationSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});

	it("lets the project file override the global file key by key", () => {
		writeGlobal({ inflation: 3, minAnswerTokens: 2048 });
		writeProject({ inflation: 1.5 });
		const { settings } = readOutputStarvationSettings(cwd);
		expect(settings.inflation).toBe(1.5);
		expect(settings.minAnswerTokens).toBe(2048);
	});

	it("reads every key the guard owns", () => {
		writeProject({ enabled: false, inflation: 1, bytesPerChar: 3, safetyMargin: 1024, minAnswerTokens: 512 });
		const { settings, errors } = readOutputStarvationSettings(cwd);
		expect(settings).toEqual({ enabled: false, inflation: 1, bytesPerChar: 3, safetyMargin: 1024, minAnswerTokens: 512 });
		expect(errors).toEqual([]);
	});

	it("falls back to the default and reports a malformed value", () => {
		writeProject({ inflation: "2", safetyMargin: 0, minAnswerTokens: 1.5, enabled: "yes" });
		const { settings, errors } = readOutputStarvationSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toHaveLength(4);
		expect(errors.some((error) => error.includes("outputStarvation.inflation must be a number greater than 0"))).toBe(true);
		expect(errors.some((error) => error.includes("outputStarvation.safetyMargin must be a positive integer"))).toBe(true);
		expect(errors.some((error) => error.includes("outputStarvation.minAnswerTokens must be a positive integer"))).toBe(true);
		expect(errors.some((error) => error.includes("outputStarvation.enabled must be a boolean"))).toBe(true);
	});

	it("reports broken JSON without throwing", () => {
		writeProjectRaw("{ not json");
		const { settings, errors } = readOutputStarvationSettings(cwd);
		expect(settings).toEqual(DEFAULTS);
		expect(errors.some((error) => error.includes("invalid JSON"))).toBe(true);
	});

	it("leaves pi's own settings alone", () => {
		// The guard reads `compaction.reserveTokens` and never writes it, and a
		// malformed guard value never reaches pi's section.
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 32768 }, outputStarvation: { inflation: -1 } }));
		const { settings, errors } = readOutputStarvationSettings(cwd);
		expect(settings.inflation).toBe(DEFAULT_INFLATION);
		expect(errors).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).compaction.reserveTokens).toBe(32768);
	});

	it("honours the env escape hatch over both files", () => {
		// An escape hatch a stale project setting could undo is not one.
		writeProject({ enabled: true });
		writeGlobal({ enabled: true });
		expect(readOutputStarvationSettings(cwd, { PI_OUTPUT_STARVATION: "off", PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv).settings.enabled).toBe(false);
		expect(readOutputStarvationSettings(cwd, { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv).settings.enabled).toBe(true);
	});
});

describe("envDisabled", () => {
	it("matches only the literal off, case and space tolerant", () => {
		expect(envDisabled({ PI_OUTPUT_STARVATION: "off" })).toBe(true);
		expect(envDisabled({ PI_OUTPUT_STARVATION: " OFF " })).toBe(true);
		expect(envDisabled({ PI_OUTPUT_STARVATION: "on" })).toBe(false);
		expect(envDisabled({ PI_OUTPUT_STARVATION: "0" })).toBe(false);
		expect(envDisabled({})).toBe(false);
	});
});
