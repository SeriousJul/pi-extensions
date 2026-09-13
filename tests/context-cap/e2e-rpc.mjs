/**
 * E2E for the context-cap extension.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory, points it at
 * this repository's extension, and asserts the window pi actually resolves -
 * the same value compaction and the footer read:
 *
 *   1. capped run: the session's initial model resolves at the cap
 *   2. capped run: the model catalogue (registry) is capped, and a model
 *      switched to mid-session resolves at the cap
 *   3. capped run: a live prompt completes on the switched model, proving
 *      auth, headers, and streaming survive the provider re-registration
 *   4. control run: without the flag the model resolves at its true window
 *   5. invalid value: rejected, session runs uncapped
 *
 * Any extension_error event fails the run.
 *
 *   node tests/context-cap/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "context-cap", "index.ts");
const CAP = 32000;
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function startRpc(extraArgs) {
	const cwd = mkdtempSync(join(tmpdir(), "context-cap-e2e-"));
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--extension", extensionPath, ...extraArgs], {
		cwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
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
				if (record.type === "extension_error") {
					extensionErrors.push(record);
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
		extensionErrors,
		close() {
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

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

// 1 + 2: capped run
const capped = startRpc(["--context-window", String(CAP)]);
try {
	const stats = await capped.request("get_session_stats");
	if (!stats.success) fail(`capped run: ${JSON.stringify(stats)}`);
	const initialWindow = stats.data?.contextUsage?.contextWindow;
	if (initialWindow !== CAP) fail(`capped run: initial contextWindow is ${initialWindow}, expected ${CAP}`);
	console.log(`ok: initial model resolves contextWindow=${initialWindow}`);

	const prompt = await capped.request("prompt", { message: "Reply with exactly: OK" });
	if (!prompt.success) fail(`capped run: ${JSON.stringify(prompt)}`);
	const text = await awaitAssistantText(capped, 120_000);
	if (!/OK/.test(text)) fail(`capped run: unexpected assistant reply ${JSON.stringify(text)}`);
	console.log("ok: live prompt completed on the capped initial model");

	const models = await capped.request("get_available_models");
	if (!models.success) fail(`capped run: ${JSON.stringify(models)}`);
	const cappedModels = (models.data?.models ?? []).filter((model) => model.contextWindow === CAP);
	if (cappedModels.length === 0) fail("capped run: no model in the catalogue resolves at the cap");
	console.log(`ok: ${cappedModels.length} catalogue model(s) resolve at the cap`);

	const state = await capped.request("get_state");
	if (!state.success) fail(`capped run: ${JSON.stringify(state)}`);
	const current = state.data?.model;
	const target =
		cappedModels.find((model) => model.provider !== current?.provider || model.id !== current?.id) ??
		cappedModels[0];
	const switched = await capped.request("set_model", { provider: target.provider, modelId: target.id });
	if (!switched.success) fail(`capped run: ${JSON.stringify(switched)}`);
	if (switched.data?.contextWindow !== CAP) {
		fail(`capped run: switched model contextWindow is ${switched.data?.contextWindow}, expected ${CAP}`);
	}
	console.log(`ok: switched model ${target.provider}/${target.id} resolves contextWindow=${CAP}`);
} finally {
	if (capped.extensionErrors.length > 0) fail(`capped run: ${JSON.stringify(capped.extensionErrors)}`);
	capped.close();
}

// 3: control run
const control = startRpc([]);
let trueWindow;
try {
	const stats = await control.request("get_session_stats");
	if (!stats.success) fail(`control run: ${JSON.stringify(stats)}`);
	trueWindow = stats.data?.contextUsage?.contextWindow;
	if (trueWindow === undefined) fail("control run: no contextUsage in response");
	if (trueWindow <= CAP) fail(`control run: contextWindow ${trueWindow} is not above the cap; test model too small`);
	console.log(`ok: control run resolves contextWindow=${trueWindow} (uncapped)`);
} finally {
	if (control.extensionErrors.length > 0) fail(`control run: ${JSON.stringify(control.extensionErrors)}`);
	control.close();
}

// 4: invalid value is rejected, session runs uncapped
const invalid = startRpc(["--context-window", "abc"]);
try {
	const stats = await invalid.request("get_session_stats");
	if (!stats.success) fail(`invalid run: ${JSON.stringify(stats)}`);
	const window = stats.data?.contextUsage?.contextWindow;
	if (window !== trueWindow) fail(`invalid run: contextWindow ${window} changed; expected the cap to be rejected`);
	console.log(`ok: invalid value is rejected, contextWindow stays ${window}`);
} finally {
	if (invalid.extensionErrors.length > 0) fail(`invalid run: ${JSON.stringify(invalid.extensionErrors)}`);
	invalid.close();
}

console.log("context-cap E2E passed");
