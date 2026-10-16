/**
 * The registry: language-by-extension, binary lookup on a test PATH, and
 * the three resolved states (ready, disabled, absent) with their reasons.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	BUILTIN_REGISTRY,
	languageForPath,
	resetBinaryCache,
	resolveRegistry,
} from "../../extensions/lsp/registry.ts";
import { DEFAULTS } from "../../extensions/lsp/settings.ts";
import type { LspSettings } from "../../extensions/lsp/types.ts";

let root: string;
let bin: string;

/** Install a fake executable named `name` in the test PATH dir. */
function install(name: string, body = "#!/bin/sh\nexit 0\n"): void {
	const p = path.join(bin, name);
	fs.writeFileSync(p, body);
	fs.chmodSync(p, 0o755);
}

/**
 * A project tree that installs typescript at the given major version: the
 * package.json the detection reads, plus the tsc bin it would spawn.
 */
function installLocalTypeScript(dir: string, major: number): void {
	const pkg = path.join(dir, "node_modules", "typescript");
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "typescript", version: `${major}.0.2` }));
	const binDir = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const tsc = path.join(binDir, "tsc");
	fs.writeFileSync(tsc, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(tsc, 0o755);
}

/** A test PATH: the fake bin dir in front of the real one. */
function testPath(): NodeJS.ProcessEnv {
	return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-registry-"));
	bin = path.join(root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	resetBinaryCache();
});

afterEach(() => {
	resetBinaryCache();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("languageForPath", () => {
	it("maps the served extensions to their languages", () => {
		expect(languageForPath("a/b/file.ts")).toBe("typescript");
		expect(languageForPath("file.tsx")).toBe("typescript");
		expect(languageForPath("file.mjs")).toBe("typescript");
		expect(languageForPath("file.cpp")).toBe("c-cpp");
		expect(languageForPath("file.hpp")).toBe("c-cpp");
		expect(languageForPath("file.rs")).toBe("rust");
		expect(languageForPath("file.pyi")).toBe("python");
		expect(languageForPath("file.go")).toBe("go");
	});

	it("returns null for unknown extensions and for extensionless files", () => {
		expect(languageForPath("file.xyz")).toBeNull();
		expect(languageForPath("Makefile")).toBeNull();
		expect(languageForPath(".ts")).toBeNull();
	});

	it("matches on the final extension only", () => {
		expect(languageForPath("archive.ts.bak")).toBeNull();
		expect(languageForPath("weird.go.ts")).toBe("typescript");
	});
});

describe("resolveRegistry", () => {
	it("reports ready with the found command when the binary is on PATH", () => {
		install("typescript-language-server");
		const resolved = resolveRegistry(DEFAULTS, testPath());
		const ts = resolved.find((r) => r.lang === "typescript");
		expect(ts?.status).toBe("ready");
		if (ts?.status !== "ready") throw new Error("unreachable");
		expect(ts.command).toBe(path.join(bin, "typescript-language-server"));
  expect(ts.args).toEqual(["--stdio"]);
	});

	it("reports absent, naming every binary it looked for", () => {
		const empty = path.join(root, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const env = { ...process.env, PATH: empty };
		const resolved = resolveRegistry(DEFAULTS, env);
		const ts = resolved.find((r) => r.lang === "typescript");
		expect(ts?.status).toBe("absent");
		if (ts?.status !== "absent") throw new Error("unreachable");
		expect(ts.reason).toBe("typescript-language-server or tsc or tsgo not found on PATH");
		const py = resolved.find((r) => r.lang === "python");
		expect(py?.status).toBe("absent");
		if (py?.status !== "absent") throw new Error("unreachable");
		expect(py.reason).toBe("basedpyright or pyright not found on PATH");
	});

	it("prefers the first installed binary of a preference list, in order", () => {
		install("pyright");
		let resolved = resolveRegistry(DEFAULTS, testPath());
		let py = resolved.find((r) => r.lang === "python");
		expect(py?.status).toBe("ready");
		if (py?.status !== "ready") throw new Error("unreachable");
		expect(py.command).toBe(path.join(bin, "pyright"));

		install("basedpyright");
		resetBinaryCache();
		resolved = resolveRegistry(DEFAULTS, testPath());
		py = resolved.find((r) => r.lang === "python");
		expect(py?.status).toBe("ready");
		if (py?.status !== "ready") throw new Error("unreachable");
		expect(py.command).toBe(path.join(bin, "basedpyright"));
	});

	it("an override command wins and its args replace the defaults", () => {
		install("my-ts-server");
		const settings: LspSettings = {
			...DEFAULTS,
			servers: { typescript: { command: "my-ts-server", args: ["--stdio"] } },
		};
		const resolved = resolveRegistry(settings, testPath());
		const ts = resolved.find((r) => r.lang === "typescript");
		expect(ts?.status).toBe("ready");
		if (ts?.status !== "ready") throw new Error("unreachable");
		expect(ts.command).toBe(path.join(bin, "my-ts-server"));
		expect(ts.args).toEqual(["--stdio"]);
	});

	it("a disabled language is reported disabled, whatever is on PATH", () => {
		install("typescript-language-server");
		const settings: LspSettings = { ...DEFAULTS, servers: { typescript: { disabled: true } } };
		const resolved = resolveRegistry(settings, testPath());
		const ts = resolved.find((r) => r.lang === "typescript");
		expect(ts?.status).toBe("disabled");
	});

	describe("the TypeScript 7 native server", () => {
		const v7 = "#!/bin/sh\necho 'Version 7.0.2'\n";
		const v5 = "#!/bin/sh\necho 'Version 5.9.3'\n";

		it("finds a TypeScript 7 project from the session root, ahead of any PATH binary", () => {
			install("typescript-language-server");
			const project = path.join(root, "project");
			installLocalTypeScript(project, 7);
			const resolved = resolveRegistry(DEFAULTS, testPath(), project);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(project, "node_modules", ".bin", "tsc"));
			expect(ts.args).toEqual(["--lsp", "--stdio"]);
		});

		it("finds the project's native tsc when no PATH binary exists at all", () => {
			const project = path.join(root, "project");
			installLocalTypeScript(project, 7);
			const empty = path.join(root, "empty");
			fs.mkdirSync(empty, { recursive: true });
			const resolved = resolveRegistry(DEFAULTS, { ...process.env, PATH: empty }, project);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.args).toEqual(["--lsp", "--stdio"]);
		});

		it("walks up from the session root to a workspace-level install", () => {
			const workspace = path.join(root, "workspace");
			installLocalTypeScript(workspace, 7);
			const pkg = path.join(workspace, "packages", "app");
			fs.mkdirSync(pkg, { recursive: true });
			const resolved = resolveRegistry(DEFAULTS, testPath(), pkg);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(workspace, "node_modules", ".bin", "tsc"));
		});

		it("a nearer classic install stops the walk: the classic server stays the pick", () => {
			install("typescript-language-server");
			const workspace = path.join(root, "workspace");
			installLocalTypeScript(workspace, 7);
			const pkg = path.join(workspace, "packages", "app");
			installLocalTypeScript(pkg, 5);
			const resolved = resolveRegistry(DEFAULTS, testPath(), pkg);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(bin, "typescript-language-server"));
			expect(ts.args).toEqual(["--stdio"]);
		});

		it("finds a global TypeScript 7 tsc on PATH, with the native arguments", () => {
			install("tsc", v7);
			const empty = path.join(root, "empty");
			fs.mkdirSync(empty, { recursive: true });
			const resolved = resolveRegistry(DEFAULTS, { ...process.env, PATH: `${empty}:${bin}` });
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(bin, "tsc"));
			expect(ts.args).toEqual(["--lsp", "--stdio"]);
		});

		it("rejects a pre-7 tsc on PATH: the 5.x CLI is not a language server", () => {
			install("tsc", v5);
			const empty = path.join(root, "empty");
			fs.mkdirSync(empty, { recursive: true });
			const env = { ...process.env, PATH: `${empty}:${bin}` };
			const resolved = resolveRegistry(DEFAULTS, env);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("absent");
			if (ts?.status !== "absent") throw new Error("unreachable");
			expect(ts.reason).toContain(path.join(bin, "tsc"));
			expect(ts.reason).toContain("below 7");
		});

		it("a global tsgo is the native preview and needs no version probe", () => {
			install("tsgo");
			const empty = path.join(root, "empty");
			fs.mkdirSync(empty, { recursive: true });
			const resolved = resolveRegistry(DEFAULTS, { ...process.env, PATH: `${empty}:${bin}` });
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(bin, "tsgo"));
			expect(ts.args).toEqual(["--lsp", "--stdio"]);
		});

		it("a native tsc on PATH beats typescript-language-server only when the project has no local typescript", () => {
			install("typescript-language-server");
			install("tsc", v7);
			const project = path.join(root, "project");
			fs.mkdirSync(project, { recursive: true });
			const resolved = resolveRegistry(DEFAULTS, testPath(), project);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(bin, "typescript-language-server"));
			expect(ts.args).toEqual(["--stdio"]);
		});

		it("a command override without args gets the native arguments when it names tsc", () => {
			install("my-tsc", v7);
			install("tsc", v7);
			const empty = path.join(root, "empty");
			fs.mkdirSync(empty, { recursive: true });
			const env = { ...process.env, PATH: `${empty}:${bin}` };
			const settings: LspSettings = { ...DEFAULTS, servers: { typescript: { command: "my-tsc" } } };
			const resolved = resolveRegistry(settings, env);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.args).toEqual(["--stdio"]); // an unknown name keeps the classic defaults

			const settings2: LspSettings = { ...DEFAULTS, servers: { typescript: { command: "tsc" } } };
			const resolved2 = resolveRegistry(settings2, env);
			const ts2 = resolved2.find((r) => r.lang === "typescript");
			expect(ts2?.status).toBe("ready");
			if (ts2?.status !== "ready") throw new Error("unreachable");
			expect(ts2.args).toEqual(["--lsp", "--stdio"]);
		});

		it("resolves a relative command override against the session root", () => {
			const project = path.join(root, "project");
			installLocalTypeScript(project, 7);
			const settings: LspSettings = {
				...DEFAULTS,
				servers: { typescript: { command: "node_modules/.bin/tsc" } },
			};
			const resolved = resolveRegistry(settings, testPath(), project);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("ready");
			if (ts?.status !== "ready") throw new Error("unreachable");
			expect(ts.command).toBe(path.join(project, "node_modules", ".bin", "tsc"));
			expect(ts.args).toEqual(["--lsp", "--stdio"]);
		});

		it("reports a missing relative command with the session root it looked from", () => {
			const project = path.join(root, "project");
			fs.mkdirSync(project, { recursive: true });
			const settings: LspSettings = {
				...DEFAULTS,
				servers: { typescript: { command: "node_modules/.bin/tsc", args: ["--lsp", "--stdio"] } },
			};
			const resolved = resolveRegistry(settings, testPath(), project);
			const ts = resolved.find((r) => r.lang === "typescript");
			expect(ts?.status).toBe("absent");
			if (ts?.status !== "absent") throw new Error("unreachable");
			expect(ts.reason).toContain("node_modules/.bin/tsc");
			expect(ts.reason).toContain("looked on PATH and from");
		});
	});

	it("the built-in table names five languages with disjoint extensions", () => {
		const exts = new Set<string>();
		for (const spec of BUILTIN_REGISTRY) {
			for (const ext of spec.extensions) {
				expect(exts.has(ext)).toBe(false);
				exts.add(ext);
			}
		}
		expect(BUILTIN_REGISTRY).toHaveLength(5);
	});
});
