/**
 * E2E for the initial-context extension.
 *
 * 1. A real pi process in RPC mode, pointed at a throwaway project with an
 *    AGENTS.md file, one skill, and appended prompt text, runs /ctx before
 *    the first LLM call. The notify record must break the prompt down by
 *    section (base, append, project file, skill, cwd) and list the tools
 *    with rebuilt built-in schemas.
 * 2. A real prompt runs one LLM call, so the extension captures the sent
 *    system prompt, the sent tool entries, and the provider-reported input
 *    tokens.
 * 3. /ctx again must now show the captured tool entries (no rebuilt schemas)
 *    and the provider reference line, and must NOT flag an injection: the
 *    reconstruction of pi's default prompt must match what pi actually sent.
 *
 * The pi run uses the real HOME so it starts with a working model config.
 *
 *   node tests/initial-context/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "initial-context", "index.ts");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

// --- fixture project ----------------------------------------------------------

const projectDir = mkdtempSync(join(tmpdir(), "initial-context-e2e-"));
writeFileSync(join(projectDir, "AGENTS.md"), "E2E project instructions for the initial context test.\n");
const skillDir = join(projectDir, "e2e-skill");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
	join(skillDir, "SKILL.md"),
	[
		"---",
		"name: e2e-skill",
		"description: A skill used by the initial context E2E test.",
		"---",
		"Skill body text.",
		"",
	].join("\n"),
);

const appendText = "E2E APPEND MARKER";

// --- pi RPC ---------------------------------------------------------------------

function startRpc() {
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--extension", extensionPath, "--skill", skillDir, "--no-skills", "--append-system-prompt", appendText],
		{ cwd: projectDir, stdio: ["pipe", "pipe", "pipe"] },
	);
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const notifies = [];
	const statuses = [];
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
				if (record.type === "extension_ui_request" && record.method === "notify") notifies.push(record);
				if (record.type === "extension_ui_request" && record.method === "setStatus" && record.statusKey === "ctx") {
					statuses.push(record);
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
		notifies,
		statuses,
		extensionErrors,
		getStderr: () => stderr,
		close() {
			child.kill();
			rmSync(projectDir, { recursive: true, force: true });
		},
	};
}

// The prompt response is an ack; poll for the assistant text to learn that
// the turn really completed (context-cap e2e uses the same pattern).
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

async function waitFor(predicate, what, getStderr) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const found = predicate();
		if (found) return found;
		if (Date.now() > deadline) fail(`no ${what} within 30s; stderr:\n${getStderr()}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const rpc = startRpc();
try {
	// --- Phase 1: /ctx before the first LLM call --------------------------------

	const first = await rpc.request("prompt", { message: "/ctx" });
	if (!first.success) fail(`/ctx (first): ${JSON.stringify(first)}`);

	const firstNote = await waitFor(() => rpc.notifies[rpc.notifies.length - 1], "/ctx notify record", rpc.getStderr);
	const firstMessage = firstNote.message ?? "";
	if (!firstMessage.match(/^initial context: [\d,]+ tokens \(\d+\.\d% of [\d,]+ window\)$/m)) {
		fail(`/ctx missing the totals header:\n${firstMessage}`);
	}
	for (const expected of ["base prompt", "append text", "AGENTS.md", "e2e-skill", "cwd", "(built-in schema)", "TOTAL"]) {
		if (!firstMessage.includes(expected)) fail(`/ctx (first) missing ${expected}:\n${firstMessage}`);
	}
	if (firstMessage.includes("provider report")) fail(`/ctx (first) should not have a provider reference yet:\n${firstMessage}`);
	if (firstMessage.includes("injection")) fail(`/ctx (first) should not flag an injection:\n${firstMessage}`);
	console.log("ok: /ctx before the first call breaks down the prompt and lists built-in tool schemas");

	const status = await waitFor(
		() => rpc.statuses[rpc.statuses.length - 1],
		"footer status",
		rpc.getStderr,
	);
	if (!/ctx: [\d,]+ \(\d+\.\d% of window\)/.test(status.statusText ?? "")) {
		fail(`footer status is not the expected shape: ${JSON.stringify(status)}`);
	}
	console.log("ok: the footer status shows the total and window share");

	// --- Phase 2: one real LLM call --------------------------------------------

	const chat = await rpc.request("prompt", { message: "Reply with exactly: OK" });
	if (!chat.success) fail(`prompt: ${JSON.stringify(chat)}`);
	const text = await awaitAssistantText(rpc, 120_000);
	if (!/OK/.test(text)) fail(`unexpected assistant reply ${JSON.stringify(text)}`);
	console.log("ok: the first LLM call ran");

	// --- Phase 3: /ctx after the first call ------------------------------------

	const seen = rpc.notifies.length;
	const second = await rpc.request("prompt", { message: "/ctx" });
	if (!second.success) fail(`/ctx (second): ${JSON.stringify(second)}`);
	const secondNote = await waitFor(
		() => (rpc.notifies.length > seen ? rpc.notifies[rpc.notifies.length - 1] : undefined),
		"second /ctx notify record",
		rpc.getStderr,
	);
	const secondMessage = secondNote.message ?? "";
	if (secondMessage.includes("built-in schema")) {
		fail(`/ctx (second) still shows rebuilt schemas:\n${secondMessage}`);
	}
	if (!secondMessage.includes("provider report (first call):")) {
		fail(`/ctx (second) missing the provider reference:\n${secondMessage}`);
	}
	if (secondMessage.includes("injection") || secondMessage.includes("modified by extension")) {
		fail(`/ctx (second) flags an injection; the reconstruction does not match pi:\n${secondMessage}`);
	}
	console.log("ok: /ctx after the first call shows captured tools and the provider reference, with no injection");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

console.log("initial-context E2E passed");
