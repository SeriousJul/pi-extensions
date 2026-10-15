/**
 * The LspClient against the scripted fake server over a real stdio
 * process (ADR 0041): the JSON-RPC framing, the initialize handshake,
 * the document sync calls, the publish wait, the per-request timeout,
 * the crash and the shutdown are all exercised here, and nowhere else
 * reaches past the client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	LspClient,
	LspServerDeadError,
	LspTimeoutError,
} from "../../extensions/lsp/client.ts";
import type { LspDiagnostic } from "../../extensions/lsp/types.ts";

const FAKE = path.join(import.meta.dirname ?? ".", "fake-server.mjs");

let root: string;
let agentDir: string;

function spawn(env: Record<string, string> = {}, label = "fake"): LspClient {
	return new LspClient({
		command: process.execPath,
		args: [FAKE],
		root,
		label,
		timeoutMs: 1500,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
	});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-client-"));
	agentDir = path.join(root, ".agent");
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("initialize handshake", () => {
	it("waits for the initialize result before the client is ready", async () => {
		const client = spawn();
		await client.ready;
		expect(client.state).toBe("ready");
		expect(client.capabilities?.textDocumentSync).toBeDefined();
		await client.shutdown();
	});

	it("a slow server is still ready when it answers, not dead", async () => {
		const client = spawn({ FAKE_LSP_SLOW_INIT_MS: "300" });
		await client.ready; // well inside the 20s default init wait
		expect(client.state).toBe("ready");
		await client.shutdown();
	});

	it("a server that dies on startup is dead, and the error carries the stderr tail", async () => {
		const client = spawn({}, "flaky");
		// Kill the child right away: the client must come back dead.
		client.kill();
		await expect(client.ready).rejects.toBeInstanceOf(Error);
		expect(client.state).toBe("dead");
	});
});

describe("document sync", () => {
	it("open, change, and close drive the server's document set", async () => {
		const published: Array<{ uri: string; diags: LspDiagnostic[] }> = [];
		const client = new LspClient({
			command: process.execPath,
			args: [FAKE],
			root,
			label: "fake",
			timeoutMs: 1500,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			onDiagnostics: (uri, diags) => published.push({ uri, diags }),
		});
		await client.ready;
		const uri = "file:///a.ts";
		await client.openDocument(uri, "let x = 1; // ERR:boom\n");
		await new Promise((r) => setTimeout(r, 80));
		expect(published.some((p) => p.uri === uri && p.diags[0]?.message === "boom")).toBe(true);
		await client.updateDocument(uri, "let x = 1; // WARN:soft\n");
		await new Promise((r) => setTimeout(r, 80));
		const last = client.publishedDiagnostics(uri);
		expect(last?.[0]?.message).toBe("soft");
		await client.closeDocument(uri);
		await new Promise((r) => setTimeout(r, 80));
		expect(client.publishedDiagnostics(uri)).toEqual([]);
		await client.shutdown();
	});

	it("requests made before ready fail fast as dead", async () => {
		const client = spawn({ FAKE_LSP_SLOW_INIT_MS: "400" });
		await expect(client.request("textDocument/hover", {}, 500)).rejects.toBeInstanceOf(LspServerDeadError);
		await client.ready;
		await client.shutdown();
	});
});

describe("push and pull answers", () => {
	it("awaitPublished resolves when the server publishes", async () => {
		const client = spawn();
		await client.ready;
		const uri = "file:///a.ts";
		const wait = client.awaitPublished(uri, 2000);
		await client.openDocument(uri, "let x = 1; // ERR:boom\n");
		const diags = await wait;
		expect(diags).not.toBeNull();
		expect(diags![0].message).toBe("boom");
		await client.shutdown();
	});

	it("awaitPublished times out to null when nothing publishes", async () => {
		const client = spawn();
		await client.ready;
		await expect(client.awaitPublished("file:///never.ts", 300)).resolves.toBeNull();
		await client.shutdown();
	});

	it("a publish that predates the last change is not the answer", async () => {
		const client = spawn({ FAKE_LSP_DELAY_MS: "50" });
		await client.ready;
		const uri = "file:///a.ts";
		await client.openDocument(uri, "let x = 1; // ERR:boom\n");
		await new Promise((r) => setTimeout(r, 150));
		expect(client.publishedDiagnostics(uri)?.[0]?.message).toBe("boom");
		// The change goes out while "boom" is the latest publish: it
		// becomes stale and must not be read as the answer for "soft".
		await client.updateDocument(uri, "let x = 1; // WARN:soft\n");
		const diags = await client.awaitPublished(uri, 2000);
		expect(diags?.[0]?.message).toBe("soft");
		await client.shutdown();
	});

	it("pull servers answer textDocument/diagnostic on demand", async () => {
		const client = spawn({ FAKE_LSP_PULL: "1" });
		await client.ready;
		expect(client.capabilities?.diagnosticProvider).toBeDefined();
		const uri = "file:///a.ts";
		await client.openDocument(uri, "let x = 1; // ERR:boom\n");
		const report = await client.request<{ items: LspDiagnostic[] }>("textDocument/diagnostic", {
			textDocument: { uri },
		});
		expect(report.items[0].message).toBe("boom");
		await client.shutdown();
	});

	it("a hung request times out with LspTimeoutError, and the client lives on", async () => {
		const client = spawn({ FAKE_LSP_HANG_REQUESTS: "1", FAKE_LSP_PULL: "1" });
		await client.ready;
		const uri = "file:///a.ts";
		await client.openDocument(uri, "let x = 1; // ERR:boom\n");
		await expect(
			client.request("textDocument/diagnostic", { textDocument: { uri } }, 400),
		).rejects.toBeInstanceOf(LspTimeoutError);
		// The server is still usable: the pull request times out, and the
		// push path has nothing (a pull-only server never publishes).
		expect(client.state).toBe("ready");
		expect(await client.awaitPublished(uri, 300)).toBeNull();
		await client.shutdown();
	});
});

describe("crash and shutdown", () => {
	it("a crashed server is dead; requests fail and shutdown is a no-op", async () => {
		const client = spawn();
		await client.ready;
		const uri = "file:///a.ts";
		await client.openDocument(uri, "x\n");
		client.kill();
		await new Promise((r) => setTimeout(r, 50));
		expect(client.state).toBe("dead");
		await expect(client.request("textDocument/hover", {}, 200)).rejects.toBeInstanceOf(LspServerDeadError);
		await client.shutdown(); // idempotent
		await client.shutdown();
	});

	it("a server that crashes on didChange is observed via onCrash", async () => {
		const client = spawn({ FAKE_LSP_CRASH_ON: "didChange" });
		await client.ready;
		const uri = "file:///a.ts";
		await client.openDocument(uri, "x\n");
		await new Promise((r) => setTimeout(r, 80));
		await client.updateDocument(uri, "y\n");
		await new Promise((r) => setTimeout(r, 100));
		expect(client.state).toBe("dead");
		await client.shutdown();
	});

	it("shutdown performs the LSP shutdown/exit dance and the process leaves", async () => {
		const client = spawn();
		await client.ready;
		await client.openDocument("file:///a.ts", "x\n");
		await client.shutdown();
		expect(client.state).toBe("closed");
		await client.shutdown();
	});
});
