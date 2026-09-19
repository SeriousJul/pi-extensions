/**
 * E2E for the Edit assist extension.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory and forces
 * a no-match edit without a live LLM: a probe extension registers pi-ai's
 * faux provider with a scripted response - one edit tool call whose oldText
 * is a leading-whitespace drift, then a final message. The built-in edit
 * tool runs for real and fails; the extension's tool_result hook must
 * append the Diagnosis to the stock error. Asserts:
 *
 *   1. enabled run (default): the edit result is the stock error verbatim,
 *      followed by a Diagnosis naming the Nearest region, stating the
 *      whitespace-only difference, and carrying a unified diff
 *   2. disabled run (settings off switch): the edit result is the stock
 *      error alone
 *
 * Any extension_error event fails the run.
 *
 *   node tests/edit-assist/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const piAiPath = join(repoRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
const extensionPath = join(repoRoot, "extensions", "edit-assist", "index.ts");
const TIMEOUT_MS = 60_000;

const FILE_CONTENT = [
	"const one = 1;",
	"\tconst two = 2;",
	"\tconst three = 3;",
	"\tconst four = 4;",
	"const five = 5;",
].join("\n") + "\n";
const OLD_TEXT = "  const two = 2;\n  const three = 3;\n  const four = 4;";
const STOCK_ERROR_PREFIX = "Could not find the exact text in";
const EXPECTED_REGION = "Nearest region: lines 2-4";

const probeSource = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(piAiPath)};

export default function (pi) {
	const file = process.env.E2E_EDIT_FILE;
	const oldText = process.env.E2E_EDIT_OLD_TEXT;
	const faux = fauxProvider({
		models: [{ id: "stub", contextWindow: 32000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("edit", { path: file, edits: [{ oldText, newText: "replacement" }] }),
		]),
		fauxAssistantMessage("done"),
	]);
	pi.registerProvider(faux.provider);
}
`;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function startRpc(cwd, env) {
	const probePath = join(cwd, "e2e-probe.ts");
	writeFileSync(probePath, probeSource);
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--extension", extensionPath, "--extension", probePath],
		{ cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
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
		events,
		extensionErrors,
		close() {
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function awaitAssistantText(rpc, text, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await rpc.request("get_last_assistant_text");
		if (!record.success) throw new Error(`get_last_assistant_text: ${JSON.stringify(record)}`);
		if (record.data?.text === text) return;
		if (Date.now() > deadline) {
			throw new Error(`assistant text ${JSON.stringify(text)} not reached within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

async function run(label, settings, assertResult) {
	const cwd = mkdtempSync(join(tmpdir(), `edit-assist-e2e-${label}-`));
	writeFileSync(join(cwd, "target.ts"), FILE_CONTENT);
	if (settings) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	}
	const rpc = startRpc(cwd, { E2E_EDIT_FILE: "target.ts", E2E_EDIT_OLD_TEXT: OLD_TEXT });
	try {
		const model = await rpc.request("set_model", { provider: "faux", modelId: "stub" });
		if (!model.success) fail(`${label}: set_model: ${JSON.stringify(model)}`);

		const prompt = await rpc.request("prompt", { message: "make the edit" });
		if (!prompt.success) fail(`${label}: prompt: ${JSON.stringify(prompt)}`);
		await awaitAssistantText(rpc, "done", TIMEOUT_MS);

		const entries = await rpc.request("get_entries");
		if (!entries.success) fail(`${label}: get_entries: ${JSON.stringify(entries)}`);
		const editResult = (entries.data?.entries ?? []).find(
			(entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "edit",
		);
		if (!editResult) fail(`${label}: no edit tool result in the session`);
		const texts = (editResult.message.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text);
		assertResult(texts, editResult.message);
	} finally {
		if (rpc.extensionErrors.length > 0) fail(`${label}: extension errors: ${JSON.stringify(rpc.extensionErrors)}`);
		rpc.close();
	}
}

// 1: enabled run - the Diagnosis is appended after the stock error
await run(
	"enabled",
	null,
	(texts) => {
		if (texts.length !== 2) fail(`enabled: expected stock error + diagnosis, got ${texts.length} text block(s)`);
		if (!texts[0].startsWith(STOCK_ERROR_PREFIX)) fail(`enabled: stock error changed: ${JSON.stringify(texts[0])}`);
		const diagnosis = texts[1];
		if (!diagnosis.includes("Diagnosis for edits[0] in target.ts:"))
			fail(`enabled: missing diagnosis header: ${JSON.stringify(diagnosis)}`);
		if (!diagnosis.includes(EXPECTED_REGION)) fail(`enabled: missing nearest region: ${JSON.stringify(diagnosis)}`);
		if (!diagnosis.includes("whitespace-only difference: same line count, leading whitespace only."))
			fail(`enabled: missing whitespace-only note: ${JSON.stringify(diagnosis)}`);
		if (!diagnosis.includes("edits[0].oldText") || !diagnosis.includes("+\tconst two = 2;") || !diagnosis.includes("-  const two = 2;"))
			fail(`enabled: missing unified diff: ${JSON.stringify(diagnosis)}`);
		console.log(`ok: enabled run - stock error verbatim, Diagnosis with ${EXPECTED_REGION} and whitespace-only note`);
	},
);

// 2: disabled run - the off switch leaves the stock error alone
await run(
	"disabled",
	{ "edit-assist": { enabled: false } },
	(texts) => {
		if (texts.length !== 1) fail(`disabled: expected only the stock error, got ${texts.length} text block(s)`);
		if (!texts[0].startsWith(STOCK_ERROR_PREFIX)) fail(`disabled: stock error changed: ${JSON.stringify(texts[0])}`);
		if (texts[0].includes("Diagnosis")) fail(`disabled: diagnosis present despite the off switch`);
		console.log("ok: disabled run - off switch leaves the stock error unchanged");
	},
);

console.log("e2e: edit-assist ok");
