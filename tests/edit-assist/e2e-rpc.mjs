/**
 * E2E for the edit assist extension (tickets #81, #83, and #84).
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * extension loaded and no live LLM: a probe extension registers a scripted
 * provider that answers each prompt with one real edit tool call taken
 * from the case file, then a "done" text. Cases are seeded from real
 * session failures and a real corrected-retry pair. Asserts:
 *
 *   1. no extension error at load or during the cases
 *   2. an indentation-wrong edit (whitespace-only difference) succeeds
 *      through the built-in tool: the success text carries the one-line
 *      honesty note naming the line, and the replacement lands at the
 *      file's real text location
 *   3. an already exact-matching edit succeeds with no honesty note
 *   4. character drift is never corrected by the extension: a drift the
 *      fuzzy match folds runs pi's own fuzzy path without a note, and a
 *      drift it does not fold fails with the stock error plus the Nearest
 *      region Diagnosis (line range and unified diff)
 *   5. an oldText with several Extended matches is never corrected; it
 *      fails with the stock error plus the Nearest region Diagnosis that
 *      states the whitespace-only difference explicitly
 *   6. an ambiguous failure returns the stock error plus the occurrence
 *      line numbers, each with one context line
 *   7. a read-tool-shaped call gets the one-line hint naming the read
 *      tool, an edits-as-string call gets the one-line shape hint, and
 *      any other malformed shape comes back without an invented hint
 *   8. a no-match oldText nothing in the file resembles gets the stock
 *      error plus the "No candidate region" line
 *   9. the results keep their stock text first, errors stay errors, and
 *      the file on disk holds exactly what the built-in tool wrote
 *  10. a disabled run (settings off switch) leaves the built-in behavior
 *      stock: the whitespace-only edit is not corrected and the no-match
 *      failure carries the stock error alone
 *
 *   node tests/edit-assist/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "edit-assist", "index.ts");
const probePath = join(repoRoot, "tests", "edit-assist", "e2e-probe.ts");
const TIMEOUT_MS = 60_000;

// The target file. Line 4 is the corrected edit's target, line 5 the
// exact-match case's, line 12 the fuzzy-drift case's, and lines 3 and 7
// hold the ambiguous oldText.
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
	"",
	"export function note() {",
	"\t// total - 100",
	"\treturn 0;",
	"}",
].join("\n");

// After cases 1-3 the built-in tool has rewritten lines 4, 5, and 12; the
// uncorrected cases 4-6 change nothing.
const FINAL_FILE = [
	"export function demo() {",
	"\tlet n = 0;",
	"\tconst dup = 1;",
	"  n += dup; // step",
	"\treturn n; // done",
	"}",
	"\tconst dup = 1;",
	"",
	"export default demo;",
	"",
	"export function note() {",
	"\t// total - 100, final",
	"\treturn 0;",
	"}",
].join("\n");

const AMBIGUOUS_STOCK =
	"Found 2 occurrences of the text in target.ts. The text must be unique. Please provide more context to make it unique.";
const READ_SHAPE_HINT =
	"Edit assist: a path with offset and limit and no edits is the read tool call. Use read to view the file, and edit with a path and an edits array to change it.";
const STRING_EDITS_HINT =
	"Edit assist: edits was sent as a string and pi could not parse it as the edits array. Send edits as an array of {oldText, newText} objects.";
const HONESTY_LINE_4 = "Edit assist: the edit was applied at line 4 with whitespace normalization of its old text.";
const NOMATCH_STOCK = "Could not find the exact text in target.ts. The old text must match exactly including all whitespace and newlines.";
const WHITESPACE_ONLY_NOTE = "The difference is a whitespace-only difference: same line count, leading whitespace only.";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

/** The cases, in order. `expectError` asserts the result's error flag. */
const CASES = [
	{
		name: "whitespace-only: the corrected call succeeds with the honesty line",
		toolCall: {
			id: "e2e-ws",
			name: "edit",
			// Recorded shape from the app.test.ts corrected-retry pair: the
			// model typed the block with the wrong indentation.
			arguments: { path: "target.ts", edits: [{ oldText: "  n += dup;", newText: "  n += dup; // step" }] },
		},
		expectError: false,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith("Successfully replaced 1 block(s) in target.ts.")) {
				throw new Error(`success text missing:\n${text}`);
			}
			if (!text.includes(HONESTY_LINE_4)) throw new Error(`honesty line missing:\n${text}`);
			if (text.split("\n").filter((line) => line.startsWith("Edit assist:")).length !== 1) {
				throw new Error(`honesty note is not one line:\n${text}`);
			}
		},
	},
	{
		name: "exact match: succeeds and is never touched, no honesty note",
		toolCall: {
			id: "e2e-exact",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\treturn n;", newText: "\treturn n; // done" }] },
		},
		expectError: false,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith("Successfully replaced 1 block(s) in target.ts.")) {
				throw new Error(`success text missing:\n${text}`);
			}
			if (text.includes("Edit assist:")) throw new Error(`invented honesty note present:\n${text}`);
		},
	},
	{
		name: "character drift the fuzzy match folds: pi's own path runs, no note",
		toolCall: {
			id: "e2e-drift",
			name: "edit",
			// The en dash folds to the file's hyphen, so the Extended match
			// is unique, but the raw difference is not leading whitespace.
			arguments: { path: "target.ts", edits: [{ oldText: "\t// total — 100", newText: "\t// total - 100, final" }] },
		},
		expectError: false,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith("Successfully replaced 1 block(s) in target.ts.")) {
				throw new Error(`success text missing:\n${text}`);
			}
			if (text.includes("Edit assist:")) throw new Error(`invented honesty note present:\n${text}`);
		},
	},
	{
		name: "no-match character drift: never corrected, stock error plus Nearest region Diagnosis",
		toolCall: {
			id: "e2e-nomatch",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst dup = 2;", newText: "\tconst dup = 3;" }] },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NOMATCH_STOCK)) throw new Error(`stock error not kept:\n${text}`);
			if (!text.includes("Diagnosis for edits[0] in target.ts:")) {
				throw new Error(`diagnosis header missing:\n${text}`);
			}
			if (!text.includes("Nearest region: lines 3-3")) throw new Error(`nearest region missing:\n${text}`);
			if (!text.includes("-\tconst dup = 2;") || !text.includes("+\tconst dup = 1;")) {
				throw new Error(`unified diff missing:\n${text}`);
			}
			if (text.includes(WHITESPACE_ONLY_NOTE)) throw new Error(`invented whitespace-only note:\n${text}`);
			if (text.includes("Edit assist:")) throw new Error(`invented prefix line:\n${text}`);
		},
	},
	{
		name: "several Extended matches: never corrected, stock error plus the whitespace-only note",
		toolCall: {
			id: "e2e-multiext",
			name: "edit",
			// Two spaces match neither occurrence exactly; the Extended match
			// hits lines 3 and 7, so the correction must not run.
			arguments: { path: "target.ts", edits: [{ oldText: "  const dup = 1;", newText: "  const dup = 2;" }] },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NOMATCH_STOCK)) throw new Error(`stock error not kept:\n${text}`);
			if (!text.includes("Diagnosis for edits[0] in target.ts:")) {
				throw new Error(`diagnosis header missing:\n${text}`);
			}
			if (!text.includes("Nearest region: lines 3-3")) throw new Error(`nearest region missing:\n${text}`);
			if (!text.includes(WHITESPACE_ONLY_NOTE)) throw new Error(`whitespace-only note missing:\n${text}`);
			if (!text.includes("-  const dup = 1;") || !text.includes("+\tconst dup = 1;")) {
				throw new Error(`unified diff missing:\n${text}`);
			}
		},
	},
	{
		name: "ambiguous: stock error plus occurrence lines with context",
		toolCall: {
			id: "e2e-amb",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst dup = 1;", newText: "\tconst dup = 2;" }] },
		},
		expectError: true,
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
		expectError: true,
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
		expectError: true,
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
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith('Validation failed for tool "edit":')) throw new Error(`stock error not kept:\n${text}`);
			if (text.includes("Edit assist:")) throw new Error(`invented hint present:\n${text}`);
		},
	},
	{
		name: "no-match nothing resembles: stock error plus the no-candidate line",
		toolCall: {
			id: "e2e-nomatch2",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst nowhere = 0;", newText: "" }] },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NOMATCH_STOCK)) throw new Error(`stock error not kept:\n${text}`);
			if (!text.includes("No candidate region")) throw new Error(`no-candidate line missing:\n${text}`);
			if (text.includes("Edit assist:")) throw new Error(`invented prefix line:\n${text}`);
		},
	},
];

// The disabled run: the same whitespace-only and no-match calls, but with
// `edit-assist.enabled: false` the extension must stay out of the way - no
// correction, no note, no Diagnosis.
const DISABLED_CASES = [
	{
		name: "disabled: the whitespace-only edit is not corrected, stock error alone",
		toolCall: {
			id: "e2e-d-ws",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "  n += dup;", newText: "  n += dup; // step" }] },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (!text.startsWith(NOMATCH_STOCK)) throw new Error(`stock error not kept:\n${text}`);
			if (text.includes("Edit assist:") || text.includes("Diagnosis") || text.includes("Nearest region")) {
				throw new Error(`extension output present despite the off switch:\n${text}`);
			}
		},
	},
	{
		name: "disabled: the no-match failure carries the stock error alone",
		toolCall: {
			id: "e2e-d-nomatch",
			name: "edit",
			arguments: { path: "target.ts", edits: [{ oldText: "\tconst dup = 2;", newText: "\tconst dup = 3;" }] },
		},
		expectError: true,
		expect: (result) => {
			const text = result.content[0].text;
			if (text !== NOMATCH_STOCK) throw new Error(`stock error changed:\n${text}`);
		},
	},
];

async function runSession(label, settings, cases, checkFile) {
	const cwd = mkdtempSync(join(tmpdir(), `edit-assist-e2e-${label}-`));
	const caseFile = join(cwd, "e2e-case.json");
	const targetFile = join(cwd, "target.ts");
	writeFileSync(targetFile, TARGET_FILE);
	if (settings !== null) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	}
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

		for (const [index, test] of cases.entries()) {
			writeFileSync(caseFile, JSON.stringify({ runId: index + 1, toolCall: test.toolCall }));
			const prompt = await request("prompt", { message: `run case ${index + 1}` });
			if (!prompt.success)
				fail(`case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}\nstderr:\n${stderr}`);
			const result = await waitFor(
				(message) => message.role === "toolResult" && message.toolCallId === test.toolCall.id,
				`the ${test.toolCall.id} tool result`
			);
			if (result.isError !== test.expectError) {
				fail(`case ${index + 1} (${test.name}): result error flag is ${result.isError}, expected ${test.expectError}`);
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

		if (checkFile) {
			const expected = label === "enabled" ? FINAL_FILE : TARGET_FILE;
			if (readFileSync(targetFile, "utf8") !== expected) {
				fail(`the file on disk is not what the run leaves:\n${readFileSync(targetFile, "utf8")}`);
			}
			console.log("ok: the file on disk holds exactly what the built-in tool wrote");
		}
	} finally {
		child.kill();
		rmSync(cwd, { recursive: true, force: true });
	}
	if (extensionErrors.length > 0) fail(`extension errors: ${JSON.stringify(extensionErrors)}`);
	console.log(`ok: no extension errors (${label} run)`);
}

const main = async () => {
	await runSession("enabled", null, CASES, true);
	await runSession("disabled", { "edit-assist": { enabled: false } }, DISABLED_CASES, true);
	console.log("edit assist e2e: PASS");
};

main().catch((error) => fail(String(error)));
