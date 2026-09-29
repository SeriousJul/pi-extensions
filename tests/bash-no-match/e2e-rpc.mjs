/**
 * E2E for the bash no-match extension (ticket #113).
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * extension loaded and no live LLM: the shared probe extension registers
 * a scripted provider that answers each prompt with one real bash tool
 * call taken from the case file, then a "done" text. Cases:
 *
 *   1. a `rg` that finds nothing returns a non-error result: the stock
 *      no-output marker with the "(no matches)" note
 *   2. a `cd <dir> && rg` that finds nothing is rewritten the same way:
 *      the last && segment is the search
 *   3. a failing cargo-style command (exit 1 with output) keeps its error
 *      status and its stock text, byte for byte
 *
 * Asserts: no extension error at load or during the cases, and the
 * rewritten result text stays under 100 bytes so the output-limits bound
 * never cuts it.
 *
 *   node tests/bash-no-match/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "bash-no-match", "index.ts");
const probePath = join(repoRoot, "tests", "shared", "e2e-scripted-probe.ts");
const TIMEOUT_MS = 60_000;

const NO_OUTPUT_EXIT_1 = "(no output)\n\nCommand exited with code 1";
const NO_MATCH_NOTE = "(no matches): the search found nothing; not an error.";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

// The cases, in order. `expectError` asserts the result's error flag.
const CASES = [
	{
		name: "rg that finds nothing: non-error result with the note",
		toolCall: { id: "e2e-rg", name: "bash", arguments: { command: "rg nonexistent-token-zzz" } },
		expectError: false,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NO_OUTPUT_EXIT_1)) throw new Error(`no-output marker not kept:\n${text}`);
			if (!text.includes(NO_MATCH_NOTE)) throw new Error(`no-match note missing:\n${text}`);
			if (text.length >= 100) throw new Error(`rewritten result is not under 100 bytes (is ${text.length}):\n${text}`);
		},
	},
	{
		name: "cd <dir> && rg that finds nothing: the last && segment is the search",
		toolCall: {
			id: "e2e-cd-rg",
			name: "bash",
			arguments: { command: "cd subdir && rg nonexistent-token-zzz" },
		},
		expectError: false,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NO_OUTPUT_EXIT_1)) throw new Error(`no-output marker not kept:\n${text}`);
			if (!text.includes(NO_MATCH_NOTE)) throw new Error(`no-match note missing:\n${text}`);
		},
	},
	{
		name: "cargo-style failure: exit 1 with output keeps its error status and stock text",
		toolCall: {
			id: "e2e-fail",
			name: "bash",
			arguments: { command: "echo boom && false" },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			// echo's trailing newline is part of the output, so the status line
			// sits two blank lines below it.
			if (text !== "boom\n\n\nCommand exited with code 1") throw new Error(`stock text changed:\n${text}`);
			if (text.includes(NO_MATCH_NOTE)) throw new Error(`invented no-match note present:\n${text}`);
		},
	},
];

async function runSession() {
	// The case file lives outside the session directory: the search cases
	// run rg over the session cwd, and the file holds the search pattern.
	const stateDir = mkdtempSync(join(tmpdir(), "bash-no-match-e2e-state-"));
	const cwd = mkdtempSync(join(tmpdir(), "bash-no-match-e2e-"));
	const caseFile = join(stateDir, "e2e-case.json");
	// The searches run over real files: rg on an empty tree exits 2 with a
	// "no files were searched" message, which is not the no-match case.
	writeFileSync(join(cwd, "sample.txt"), "just a sample line\n");
	mkdirSync(join(cwd, "subdir"));
	writeFileSync(join(cwd, "subdir", "sample.txt"), "another sample line\n");
	writeFileSync(caseFile, JSON.stringify({ runId: 0, toolCall: { id: "none", name: "noop", arguments: {} } }));

	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--extension", extensionPath, "--extension", probePath],
		{ cwd, env: { ...process.env, E2E_CASE_FILE: caseFile }, stdio: ["pipe", "pipe", "pipe"] }
	);
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const events = [];
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
				events.push(record);
				if (record.type === "extension_error") extensionErrors.push(record);
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
				reject(
					new Error(
						`timed out waiting for ${command}\nevents:\n${events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\nstderr:\n${stderr}`
					)
				);
			}, TIMEOUT_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve(record);
			});
			child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n");
		});
	const waitFor = async (predicate, what, timeoutMs = TIMEOUT_MS) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const record = await request("get_messages");
			if (!record.success) throw new Error(`get_messages: ${JSON.stringify(record)}`);
			const found = (record.data?.messages ?? []).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstderr:\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	};

	try {
		await new Promise((resolve) => setTimeout(resolve, 6000)); // session start has run by now
		const setModel = await request("set_model", { provider: "e2efa", modelId: "e2e-1" });
		if (!setModel.success) fail(`set_model: ${JSON.stringify(setModel)}\nstderr:\n${stderr}`);

		for (const [index, test] of CASES.entries()) {
			writeFileSync(caseFile, JSON.stringify({ runId: index + 1, toolCall: test.toolCall }));
			const prompt = await request("prompt", { message: `run case ${index + 1}` });
			if (!prompt.success)
				fail(`case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}\nstderr:\n${stderr}`);
			const result = await waitFor(
				(message) => message.role === "toolResult" && message.toolCallId === test.toolCall.id,
				`the ${test.toolCall.id} tool result`
			);
			if (result.isError !== test.expectError) {
				fail(`case ${index + 1} (${test.name}): result error flag is ${result.isError}, expected ${test.expectError}\ntext: ${JSON.stringify(result.content)}`);
			}
			if (!Array.isArray(result.content) || result.content.length === 0 || typeof result.content[0]?.text !== "string") {
				fail(`case ${index + 1} (${test.name}): no text content in the result`);
			}
			try {
				test.expect(result);
			} catch (error) {
				fail(`case ${index + 1} (${test.name}): ${error.message}`);
			}
			console.log(`ok: case ${index + 1}: ${test.name}`);
		}
	} finally {
		child.kill();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
	if (extensionErrors.length > 0) fail(`extension errors: ${JSON.stringify(extensionErrors)}`);
	console.log("ok: no extension errors");
}

const main = async () => {
	await runSession();
	console.log("bash no-match e2e: PASS");
};

main().catch((error) => fail(String(error)));
