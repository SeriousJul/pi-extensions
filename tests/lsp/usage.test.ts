/**
 * The per-call log: append, parse, and the health reader's tolerance. A
 * torn or malformed line must never make the log unreadable, and a
 * directory without a log is not a project.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	LOG_NAME,
	appendLspLog,
	encodeRoot,
	listProjectLogDirs,
	parseLspLogLine,
	projectLogDir,
} from "../../extensions/lsp/usage.ts";

let agent: string;
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-usage-"));
	agent = path.join(tmp, "agent");
	root = path.join(tmp, "project");
	fs.mkdirSync(agent, { recursive: true });
	fs.mkdirSync(root, { recursive: true });
	env = { ...process.env, PI_CODING_AGENT_DIR: agent };
});

afterEach(() => {
	fs.rmSync(path.dirname(agent), { recursive: true, force: true });
});

describe("encodeRoot / projectLogDir", () => {
	it("encodes the root path into a safe directory name", () => {
		const encoded = encodeRoot("/home/me/my project");
		expect(encoded).not.toContain("/");
		expect(encoded).not.toContain(" ");
		expect(projectLogDir("/home/me/my project", env)).toBe(path.join(agent, "lsp", encoded));
	});

	it("distinct roots get distinct directories", () => {
		expect(encodeRoot("/a/b")).not.toBe(encodeRoot("/a/c"));
	});
});

describe("appendLspLog / parseLspLogLine", () => {
	it("round-trips a record through the file", () => {
		appendLspLog(root, { kind: "call", tool: "lsp_diagnostics", language: "typescript", outcome: "ok", duration_ms: 12, chars: 80 }, env);
		const file = path.join(projectLogDir(root, env), LOG_NAME);
		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = parseLspLogLine(lines[0]);
		expect(record?.kind).toBe("call");
		expect(record?.tool).toBe("lsp_diagnostics");
		expect(record?.root).toBe(root);
		expect(typeof record?.ts).toBe("string");
	});

	it("a torn line is ignored by the reader", () => {
		appendLspLog(root, { kind: "call", tool: "lsp_hover", outcome: "ok" }, env);
		const file = path.join(projectLogDir(root, env), LOG_NAME);
		fs.appendFileSync(file, '{"kind":"call","tool":"lsp_', "utf-8"); // crash mid-write
		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		expect(parseLspLogLine(lines[0])).not.toBeNull();
		expect(parseLspLogLine(lines[1])).toBeNull();
	});

	it("a line that is not a record is ignored", () => {
		expect(parseLspLogLine("")).toBeNull();
		expect(parseLspLogLine("not json")).toBeNull();
		expect(parseLspLogLine(JSON.stringify({ kind: "bogus", ts: "t", root: "r" }))).toBeNull();
		expect(parseLspLogLine(JSON.stringify({ kind: "call" }))).toBeNull();
	});

	it("appends never throw, even when the directory cannot be made", () => {
		// A file where the state directory's parent must be: mkdir fails
		// with ENOTDIR for every user, so the fallback is exercised.
		const blocker = path.join(agent, "blocker");
		fs.writeFileSync(blocker, "x");
		expect(() => appendLspLog(root, { kind: "call" }, { ...env, PI_CODING_AGENT_DIR: blocker })).not.toThrow();
	});
});

describe("listProjectLogDirs", () => {
	it("lists only directories that hold a log", () => {
		appendLspLog(root, { kind: "call", outcome: "ok" }, env);
		const emptyDir = path.join(agent, "lsp", "a-project-without-a-log");
		fs.mkdirSync(emptyDir, { recursive: true });
		const dirs = listProjectLogDirs(env);
		expect(dirs).toHaveLength(1);
		expect(dirs[0]).toBe(projectLogDir(root, env));
	});

	it("is empty when the state directory does not exist", () => {
		expect(listProjectLogDirs(env)).toEqual([]);
	});
});
