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
function install(name: string): void {
	const p = path.join(bin, name);
	fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(p, 0o755);
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
		expect(ts.reason).toBe("typescript-language-server not found on PATH");
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
