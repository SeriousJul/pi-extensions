import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULTS, readEditAssistSettings } from "../../extensions/edit-assist/settings";

let cwd: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "edit-assist-settings-project-"));
	agentDir = mkdtempSync(join(tmpdir(), "edit-assist-settings-agent-"));
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

describe("readEditAssistSettings", () => {
	it("is on by default when no settings exist", () => {
		const { settings, errors } = readEditAssistSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(settings.enabled).toBe(true);
		expect(errors).toEqual([]);
	});

	it("reads the edit-assist section from the global file", () => {
		globalSettings({ "edit-assist": { enabled: false } });
		const { settings, errors } = readEditAssistSettings(cwd, env);
		expect(settings).toEqual({ enabled: false });
		expect(errors).toEqual([]);
	});

	it("lets the project file override the global file", () => {
		globalSettings({ "edit-assist": { enabled: false } });
		projectSettings({ "edit-assist": { enabled: true } });
		const { settings } = readEditAssistSettings(cwd, env);
		expect(settings).toEqual({ enabled: true });
	});

	it("falls back to the default and reports an error for a malformed value", () => {
		globalSettings({ "edit-assist": { enabled: "yes" } });
		const { settings, errors } = readEditAssistSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual(["edit-assist.enabled must be a boolean, got: \"yes\""]);
	});

	it("ignores other settings sections", () => {
		globalSettings({ pruning: { enabled: false }, compress: { enabled: false } });
		const { settings, errors } = readEditAssistSettings(cwd, env);
		expect(settings).toEqual(DEFAULTS);
		expect(errors).toEqual([]);
	});
});
