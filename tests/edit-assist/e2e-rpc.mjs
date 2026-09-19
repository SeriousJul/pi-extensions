/**
 * E2E for the edit assist extension (ticket #84).
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * extension loaded and no live LLM: a probe extension registers a scripted
 * provider that answers each prompt with one real edit tool call taken
 * from the case file, then a "done" text. Cases are seeded from real
 * session failures (ambiguous multi-occurrence calls; read-tool-shaped and
 * edits-as-string validation failures). Asserts:
 *
 *   1. no extension error at load or during the cases
 *   2. an ambiguous failure returns the stock error plus the occurrence
 *      line numbers, each with one context line
 *   3. a read-tool-shaped call gets the one-line hint naming the read tool
 *   4. an edits-as-string call gets the one-line shape hint
 *   5. any other malformed shape, and the no-match class (ticket #81),
 *      come back unchanged, without an invented hint
 *   6. the result stays an error and the file on disk is never touched
 *
 *   node tests/edit-assist/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "edit-assist", "index.ts");
const probePath = join(repoRoot, "tests", "edit-assist", "e2e-probe.ts");
const TIMEOUT_MS = 60_000;

// The target file: the ambiguous oldText occurs exactly on lines 3 and 7.
const TARGET_FILE = [
	"export function demo() {",
	"\tlet n = 0;",
	"\tconst dup = 1;",
	"\tn += dup;",
	"\treturn n;",
	"}",
	"\tconst dup = 1;",
	"",
	"export default demo;",
].join("\n");

const AMBIGUOUS_STOCK =
	"Found 2 occurrences of the text in target.ts. The text must be unique. Please provide more context to make it unique.";
const READ_SHAPE_HINT =
	"Edit assist: a path with offset and limit and no edits is the read tool call. Use read to view the file, and edit with a path and an edits array to change it.";
const STRING_EDITS_HINT =
	"Edit assist: edits was sent as a string and pi could not parse it as the edits array. Send edits as an array of {oldText, newText} objects.";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

/** The cases, in order. `expect` is asserted after the turn settles. */
const CASES = [
	{
		name: "ambiguous: stock error plus occurrence lines with context",
		toolCall: {
			id: "e2e-amb",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst dup = 1;", newText: "\tconst dup = 2;" }] },
		},
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(AMBIGUOUS_STOCK)) throw new Error(`stock error not kept:\n${text}`);
			if (!text.includes("Edit assist: the old text matches 2 places in the file:")) {
				throw new Error(`occurrence list missing:\n${text}`);
			}
			if (!text.includes("  3: \tconst dup = 1;")) throw new Error(`line 3 context missing:\n${text}`);
			if (!text.includes("  7: \tconst dup = 1;")) throw new Error(`line 7 context missing:\n${text}`);
		},
	},
	{
		name: "malformed read-tool shape: one-line hint naming the read tool",
		toolCall: { id: "e2e-read", name: "edit", arguments: { path: "target.ts", offset: 1, limit: 20 } },
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith('Validation failed for tool "edit":')) throw new Error(`stock error not kept:\n${text}`);
			if (!text.endsWith(READ_SHAPE_HINT)) throw new Error(`read hint missing:\n${text}`);
			if (text.split("\n").filter((line) => line.startsWith("Edit assist:")).length !== 1) {
				throw new Error(`hint is not one line:\n${text}`);
			}
		},
	},
	{
		name: "malformed edits-as-string: one-line shape hint",
		// Seeded from a real session failure: an unparseable JSON-ish string.
		toolCall: {
			id: "e2e-str",
			name: "edit",
			arguments: { edits: '\n[{"newText": * One row of complete key hints, packed from the control catalogue' },
		},
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith('Validation failed for tool "edit":')) throw new Error(`stock error not kept:\n${text}`);
			if (!text.endsWith(STRING_EDITS_HINT)) throw new Error(`shape hint missing:\n${text}`);
			if (text.split("\n").filter((line) => line.startsWith("Edit assist:")).length !== 1) {
				throw new Error(`hint is not one line:\n${text}`);
			}
		},
	},
	{
		name: "any other malformed shape: unchanged, no invented hint",
		toolCall: { id: "e2e-bare", name: "edit", arguments: { path: "target.ts" } },
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith('Validation failed for tool "edit":')) throw new Error(`stock error not kept:\n${text}`);
			if (text.includes("Edit assist:")) throw new Error(`invented hint present:\n${text}`);
		},
	},
	{
		name: "no-match (ticket #81's class): unchanged in this slice",
		toolCall: {
			id: "e2e-nomatch",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst nowhere = 0;", newText: "" }] },
		},
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith("Could not find the exact text in target.ts.")) throw new Error(`stock error not kept:\n${text}`);
			if (text.includes("Edit assist:")) throw new Error(`invented diagnosis present:\n${text}`);
		},
	},
];

async function main() {
	const cwd = mkdtempSync(join(tmpdir(), "edit-assist-e2e-"));
	const caseFile = join(cwd, "e2e-case.json");
	const targetFile = join(cwd, "target.ts");
	writeFileSync(targetFile, TARGET_FILE);
	writeFileSync(caseFile, JSON.stringify({ runId: 0, toolCall: { id: "none", name: "noop", arguments: {} } }));

	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--extension", extensionPath, "--extension", probePath],
		{ cwd, env: { ...process.env, E2E_CASE_FILE: caseFile }, stdio: ["pipe", "pipe", "pipe"] },
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
				reject(new Error(`timed out waiting for ${command}\nevents:\n${events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\nstderr:\n${stderr}`));
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
		};
	};

	try {
		await new Promise((resolve) => setTimeout(resolve, 6000)); // session start has run by now
		const setModel = await request("set_model", { provider: "e2efa", modelId: "e2e-1" });
		if (!setModel.success) fail(`set_model: ${JSON.stringify(setModel)}\nstderr:\n${stderr}`);

		for (const [index, test] of CASES.entries()) {
			writeFileSync(caseFile, JSON.stringify({ runId: index + 1, toolCall: test.toolCall }));
			const prompt = await request("prompt", { message: `run case ${index + 1}` });
			if (!prompt.success) fail(`case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}\nstderr:\n${stderr}`);
			const result = await waitFor(
				(message) => message.role === "toolResult" && message.toolCallId === test.toolCall.id,
				`the ${test.toolCall.id} tool result`,
			);
			if (result.isError !== true) fail(`case ${index + 1} (${test.name}): result is not marked as an error`);
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

		if (readFileSync(targetFile, "utf8") !== TARGET_FILE) fail("the edit tool or the extension modified the target file");
		console.log("ok: the target file is untouched");
	} finally {
		child.kill();
		rmSync(cwd, { recursive: true, force: true });
	}
	if (extensionErrors.length > 0) fail(`extension errors: ${JSON.stringify(extensionErrors)}`);
	console.log("ok: no extension errors");
	console.log("edit assist e2e: PASS");
}

main().catch((error) => fail(String(error)));
