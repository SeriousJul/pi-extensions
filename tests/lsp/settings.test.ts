/**
 * Settings: the `lsp` section, project-over-global key by key, malformed
 * values falling back to defaults with an error, and the trust exception
 * (only the project file's `enabled: true` counts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readLspSettings } from "../../extensions/lsp/settings.ts";

let cwd: string;
let agent: string;
let env: NodeJS.ProcessEnv;

function writeJson(p: string, value: unknown): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, value === null ? "{ not json" : `${JSON.stringify(value, null, 2)}\n`);
}

function project(value: unknown): void {
	writeJson(path.join(cwd, ".pi", "settings.json"), value);
}

function global(value: unknown): void {
	writeJson(path.join(agent, "settings.json"), value);
}

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-settings-"));
	cwd = path.join(root, "project");
	agent = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	env = { ...process.env, PI_CODING_AGENT_DIR: agent };
});

afterEach(() => {
	const root = path.dirname(cwd);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("readLspSettings", () => {
	it("returns the defaults with no errors when no settings file exists", () => {
		const { settings, errors, projectExplicitlyEnabled } = readLspSettings(cwd, env);
		expect(settings).toEqual({
			enabled: true,
			servers: {},
			severity: "warning",
			maxOpenDocuments: 32,
			maxServers: 4,
			timeoutMs: 20_000,
			annotate: true,
		});
		expect(errors).toEqual([]);
		expect(projectExplicitlyEnabled).toBe(false);
	});

	it("the project file overrides the global file key by key", () => {
		global({ lsp: { severity: "error", maxServers: 2, annotate: false } });
		project({ lsp: { severity: "warning" } });
		const { settings, errors } = readLspSettings(cwd, env);
		expect(errors).toEqual([]);
		expect(settings.severity).toBe("warning"); // project wins
		expect(settings.maxServers).toBe(2); // falls back to global
		expect(settings.annotate).toBe(false); // falls back to global
		expect(settings.enabled).toBe(true); // default
	});

	it("a malformed value falls back to its default and is reported", () => {
		project({ lsp: { maxServers: "many", timeoutMs: -5, severity: "loud" } });
		const { settings, errors } = readLspSettings(cwd, env);
		expect(settings.maxServers).toBe(4);
		expect(settings.timeoutMs).toBe(20_000);
		expect(settings.severity).toBe("warning");
		expect(errors).toHaveLength(3);
	});

	it("an unparseable file is reported and its section ignored", () => {
		project(null);
		global(null);
		const { settings, errors, projectExplicitlyEnabled } = readLspSettings(cwd, env);
		expect(settings.enabled).toBe(true);
		expect(projectExplicitlyEnabled).toBe(false);
		expect(errors.some((e) => e.includes(".pi/settings.json"))).toBe(true);
	});

	it("per-language overrides win whole, per key", () => {
		global({ lsp: { servers: { typescript: { command: "global-cmd", args: ["-g"] }, python: { disabled: true } } } });
		project({ lsp: { servers: { typescript: { command: "project-cmd" } } } });
		const { settings } = readLspSettings(cwd, env);
		expect(settings.servers.typescript).toEqual({ command: "project-cmd" });
		expect(settings.servers.python).toEqual({ disabled: true });
	});

	it("an unknown language key is an error", () => {
		project({ lsp: { servers: { cobol: { command: "cobo" } } } });
		const { errors } = readLspSettings(cwd, env);
		expect(errors.some((e) => e.includes("cobol"))).toBe(true);
	});

	it("only the project file's enabled:true is the trust exception", () => {
		global({ lsp: { enabled: true } });
		expect(readLspSettings(cwd, env).projectExplicitlyEnabled).toBe(false);
		project({ lsp: { enabled: true } });
		expect(readLspSettings(cwd, env).projectExplicitlyEnabled).toBe(true);
		project({ lsp: { enabled: false } });
		expect(readLspSettings(cwd, env).projectExplicitlyEnabled).toBe(false);
	});

	it("a disabled global and an enabled project compose: the project wins", () => {
		global({ lsp: { enabled: false } });
		project({ lsp: { enabled: true } });
		const { settings, projectExplicitlyEnabled } = readLspSettings(cwd, env);
		expect(settings.enabled).toBe(true);
		expect(projectExplicitlyEnabled).toBe(true);
	});
});
