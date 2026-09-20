/**
 * E2E for the background jobs extension.
 *
 * A real pi process in RPC mode, pointed at only this extension, runs one
 * live turn in which the agent starts a real one-second job with bash_bg
 * and waits on it with job_wait. The tool events prove the tools executed
 * in a live session; the assistant reply must report the exit code
 * job_wait returned.
 *
 * The pi run uses the real HOME so it starts with a working model config.
 * --no-extensions keeps only the extension under test.
 *
 *   node tests/background-jobs/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "background-jobs", "index.ts");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

const projectDir = mkdtempSync(join(tmpdir(), "background-jobs-e2e-"));

function startRpc() {
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extensionPath], {
		cwd: projectDir,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const extensionErrors = [];
	const toolEnds = [];
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
				if (record.type === "tool_execution_end") toolEnds.push(record);
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
		toolEnds,
		extensionErrors,
		getStderr: () => stderr,
		close() {
			child.kill();
			rmSync(projectDir, { recursive: true, force: true });
		},
	};
}

// The prompt response is an ack; poll for the assistant text to learn that
// the turn really completed.
async function awaitAssistantText(rpc, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await rpc.request("get_last_assistant_text");
		if (!record.success) throw new Error(`get_last_assistant_text: ${JSON.stringify(record)}`);
		if (record.data?.text) return record.data.text;
		if (Date.now() > deadline) throw new Error(`no assistant text within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

const rpc = startRpc();
try {
	const chat = await rpc.request("prompt", {
		message:
			"Use the bash_bg tool to start this exact command: sleep 1 && echo BG_JOB_MARKER. " +
			"Then use job_wait to wait for the job it returns, with a timeout of 30 seconds. " +
			"Do not use any other tools. After job_wait returns, reply with exactly: CODE <exit code>, " +
			"where <exit code> is the number job_wait reported.",
	});
	if (!chat.success) fail(`prompt: ${JSON.stringify(chat)}`);

	const text = await awaitAssistantText(rpc, 120_000);
	if (!/CODE 0/.test(text)) fail(`assistant reply does not report exit code 0: ${JSON.stringify(text)}`);
	console.log("ok: the agent started a real one-second job and waited on it");

	const names = rpc.toolEnds.map((r) => r.toolName);
	if (!names.includes("bash_bg")) fail(`bash_bg did not execute in the live session: ${JSON.stringify(names)}`);
	if (!names.includes("job_wait")) fail(`job_wait did not execute in the live session: ${JSON.stringify(names)}`);
	const waitEnd = rpc.toolEnds.find((r) => r.toolName === "job_wait");
	if (JSON.stringify(waitEnd?.result ?? "").includes("still running")) {
		fail(`job_wait timed out on the one-second job: ${JSON.stringify(waitEnd)}`);
	}
	console.log("ok: both tools executed in the live session, and the wait returned the exit, not a timeout");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

console.log("background-jobs E2E passed");
