/**
 * E2E for the quota extension.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory, points it
 * at this repository's extension, and lets it read the real ChatGPT usage
 * endpoint with the openai-codex login from the global auth store. This
 * needs a working openai-codex login; without one the extension stays
 * silent and the run fails, which is the signal to log in again.
 *
 * Asserts:
 *
 *   1. the footer status line appears and carries both windows
 *   2. /quota runs a fresh read without an extension error
 *   3. a fresh login is read, not refreshed: the auth file is untouched
 *   4. no extension_error event at any point
 *
 *   node tests/quota/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "quota", "index.ts");
const authPath = join(process.env.HOME, ".pi", "agent", "auth.json");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

if (!existsSync(authPath) || !JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"]) {
	fail("no openai-codex login in ~/.pi/agent/auth.json; log in first");
}

const authBefore = readFileSync(authPath, "utf8");

function startRpc() {
	const cwd = mkdtempSync(join(tmpdir(), "quota-e2e-"));
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--extension", extensionPath], {
		cwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const uiRequests = [];
	const extensionErrors = [];
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (record.type === "extension_error") extensionErrors.push(record);
				if (record.type === "extension_ui_request" && record.method === "setStatus" && record.statusKey === "quota") {
					uiRequests.push(record);
				}
				if (record.type === "response" && record.id && pending.has(record.id)) {
					const waiter = pending.get(record.id);
					pending.delete(record.id);
					waiter(record);
				}
			} catch {
				// Non-JSONL startup noise; the protocol is JSONL after that.
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const request = (command, fields = {}) =>
		new Promise((resolve, reject) => {
			const id = `req-${nextId++}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timed out waiting for ${command}\nstderr:\n${stderr}`));
			}, TIMEOUT_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve(record);
			});
			child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n");
		});
	return {
		request,
		uiRequests,
		extensionErrors,
		getStderr: () => stderr,
		close() {
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function stripAnsi(text) {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const rpc = startRpc();
try {
	// 1: the session-start read lands and the footer status appears.
	let footer;
	const deadline = Date.now() + 30_000;
	for (;;) {
		footer = rpc.uiRequests[rpc.uiRequests.length - 1];
		if (footer?.statusText) break;
		if (Date.now() > deadline) fail(`no quota footer status within 30s; stderr:\n${rpc.getStderr()}`);
		await sleep(500);
	}
	// Windows are labeled by their length: "5h" and "7d" on the ChatGPT
	// plans, "30d" on the free plan. The line carries whatever windows the
	// account has, so the shape is checked, not the exact labels.
	const line = stripAnsi(footer.statusText);
	if (!/^GPT \d+[hd] (\d+%|FULL)( · \d+[hd] (\d+%|FULL))?$/.test(line)) {
		fail(`unexpected footer line: ${JSON.stringify(line)}`);
	}
	console.log(`ok: footer line: ${line}`);

	// 2: /quota runs a fresh read.
	const quota = await rpc.request("prompt", { message: "/quota" });
	if (!quota.success) fail(`/quota: ${JSON.stringify(quota)}`);
	await sleep(2000); // give the read and the footer update time to settle
	const footerAfter = stripAnsi(rpc.uiRequests[rpc.uiRequests.length - 1]?.statusText ?? "");
	if (!footerAfter.startsWith("GPT ")) fail(`footer missing after /quota: ${JSON.stringify(footerAfter)}`);
	console.log("ok: /quota completed, footer still present");

	// 3: a fresh login is read, not refreshed.
	const authAfter = readFileSync(authPath, "utf8");
	if (authBefore !== authAfter) fail("the auth file changed; a fresh token must not be refreshed");
	console.log("ok: auth file untouched by a fresh read");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

console.log("quota E2E passed");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
