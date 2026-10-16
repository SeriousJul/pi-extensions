/**
 * E2E for the lsp extension (issue #136).
 *
 * A real pi process in RPC mode with the extension loaded and no live LLM:
 * the scripted probe answers each prompt with real tool calls taken from a
 * case file. The fixture is a small TypeScript project and the real
 * typescript-language-server (pinned as a devDependency) runs in-process
 * behind the extension's client - the only seam the tests reach is the
 * machine, which is exactly what the ticket asks to be proven.
 *
 * Three runs:
 *
 *   enabled   a trusted project with the TypeScript server available:
 *             1. a read seeds the Open documents; the server settles the
 *                Diagnostic baseline for the pre-existing error
 *             2. an edit that breaks the file: the result keeps pi's stock
 *                text in its own block, and the annotation block reports
 *                only the new diagnostic - the pre-existing error is not
 *                reported again
 *             3. lsp_diagnostics answers from the real server
 *             4. a clean edit, then an external write to another open file:
 *                the Sweep at turn end reports it as one custom message,
 *                and the turn does not continue because of it
 *             5. lsp_hover returns the real type from the server
 *             6. lsp_reports no references when there are none
 *             and the file on disk holds exactly what the built-in tool
 *             wrote
 *   disabled  the same project with the server disabled by settings: no
 *             annotation, no note, the edit result is stock alone
 *   untrusted the same project, the run untrusted: nothing lsp runs
 *   ts7       the same loop over a TypeScript 7 project: the fixture
 *             installs typescript@7, and the extension must find the
 *             project's own native tsc (tsc --lsp --stdio) without any
 *             settings: typescript-language-server is on no PATH and
 *             could not serve TS7 anyway (ADR 0044)
 *
 *   node tests/lsp/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "lsp", "index.ts");
const probePath = join(repoRoot, "tests", "shared", "e2e-scripted-probe.ts");
const TIMEOUT_MS = 120_000;

// The fixture project: one pre-existing error (the baseline), one clean
// file, a tsconfig so the server roots at the project and the language is
// TypeScript.
const APP_TS = [
	"let n: number = \"text\";", // pre-existing error 2322
	"export function helper(): number {",
	"  return 1;",
	"}",
	"console.log(helper);",
	"",
].join("\n");
const UTIL_TS = "export const utilValue = 1;\n";

const PRE_EXISTING_ERROR = "Type 'string' is not assignable to type 'number'";
const EDIT_ERROR = "Type 'number' is not assignable to type 'string'";
const SWEEP_ERROR = "Type 'number' is not assignable to type 'boolean'";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

async function runSession(label, { trusted, settings, cases, check, prepare, withRepoBin = true }) {
	const cwd = mkdtempSync(join(tmpdir(), `lsp-e2e-${label}-`));
	if (prepare) await prepare(cwd);
	const caseFile = join(cwd, "e2e-case.json");
	writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({
		compilerOptions: { strict: true, noEmit: true, target: "es2022" },
		files: ["app.ts", "util.ts"],
	}, null, 2) + "\n");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "app.ts"), APP_TS);
	writeFileSync(join(cwd, "util.ts"), UTIL_TS);
	if (settings !== null) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ lsp: settings }, null, 2) + "\n");
	}
	writeFileSync(caseFile, JSON.stringify({ runId: 0, toolCall: { id: "none", name: "noop", arguments: {} } }));

	const child = spawn(
		process.execPath,
		[
			piCli,
			"--mode", "rpc",
			"--extension", extensionPath,
			"--extension", probePath,
			...(trusted ? ["--approve"] : []),
		],
		{
			cwd,
			env: {
				...process.env,
				// The pinned language server binary, and the extension's
				// state (the per-call log) inside the throwaway project.
				PATH: withRepoBin ? `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}` : process.env.PATH ?? "",
				PI_CODING_AGENT_DIR: join(cwd, ".agent"),
				E2E_CASE_FILE: caseFile,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
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
				// Non-JSONL startup noise.
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
						`timed out waiting for ${command}\nevents:\n${events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\nstderr:\n${stderr}`,
					),
				);
			}, TIMEOUT_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve(record);
			});
			child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n");
		});
	const waitFor = async (predicate, what, timeoutMs = TIMEOUT_MS) => {
		// The transcript's raw entries are visible mid-turn, unlike the
		// message projection: this is how the driver acts while a turn is
		// still running (before the sweep at its end).
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const record = await request("get_entries");
			if (!record.success) throw new Error(`get_entries: ${JSON.stringify(record)}`);
			const found = (record.data?.entries ?? []).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstderr tail:\n${stderr.slice(-3000)}`);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};
	const allMessages = async () => {
		const record = await request("get_messages");
		if (!record.success) throw new Error(`get_messages: ${JSON.stringify(record)}`);
		return record.data?.messages ?? [];
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	try {
		await sleep(6000); // session start has run by now
		const setModel = await request("set_model", { provider: "e2efa", modelId: "e2e-1" });
		if (!setModel.success) fail(`set_model: ${JSON.stringify(setModel)}\nstderr:\n${stderr}`);

		for (const [index, test] of cases.entries()) {
			writeFileSync(
				caseFile,
				JSON.stringify({ runId: index + 1, toolCall: test.toolCall, calls: test.calls, externalWrite: test.externalWrite }),
			);
			// The prompt RPC only resolves when the turn has ended, sweep
			// included: a case that drives the machine mid-turn must see the
			// tool result first, act, and only then let the turn finish.
			const promptPromise = request("prompt", { message: `run case ${index + 1}` });
			if (test.waitForResultId) {
				const entry = await waitFor(
					(record) =>
						record.type === "message" &&
						record.message?.role === "toolResult" &&
						record.message.toolCallId === test.waitForResultId,
					`the ${test.waitForResultId} tool result`,
					);
				const result = entry.message;
				if (result.isError !== (test.expectError ?? false)) {
					fail(`case ${index + 1} (${test.name}): result error flag is ${result.isError}`);
				}
				test.expectResult?.(result);
			}
			const prompt = await promptPromise;
			if (!prompt.success)
				fail(`case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}\nstderr tail:\n${stderr.slice(-3000)}`);
			if (test.waitForCustom) {
				const custom = await waitFor(
					(record) => record.type === "custom_message" && record.customType === "lsp-sweep",
					`the sweep message of case ${index + 1}`,
				);
				test.expectCustom?.(custom);
			}
			if (test.settle) await sleep(test.settle);
			if (test.check) {
				try {
					const messages = await allMessages();
					test.check(messages);
				} catch (error) {
					fail(`case ${index + 1} (${test.name}): ${error.message}`);
				}
			}
			console.log(`ok: case ${index + 1}: ${test.name}`);
		}
		if (extensionErrors.length > 0) {
			fail(`extension errors:\n${extensionErrors.map((e) => JSON.stringify(e).slice(0, 500)).join("\n")}`);
		}
		check?.(await allMessages(), cwd);
	} finally {
		child.kill();
		if (!process.env.LSP_E2E_KEEP) rmSync(cwd, { recursive: true, force: true });
		else console.log(`kept fixture: ${cwd}`);
	}
}

function lastText(message) {
	const text = message.content?.filter((b) => b.type === "text").map((b) => b.text).join("");
	return text;
}

/** The lsp tools' activation, from the transcript's system message. */
function activeLspTools(messages) {
	const system = messages.find((m) => m.role === "system");
	const added = system?.toolsAdded?.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean) ?? [];
	return added.filter((name) => name.startsWith("lsp_"));
}

/**
 * The standard six-case loop and its disk check, shared by the classic run
 * and the TypeScript 7 run: same fixture, same expectations. The only
 * difference is which real server serves it.
 */
function standardLoop() {
	return {
		cases: [
			{
				name: "reads seed the Open documents and settle the baseline",
				calls: [
					{ id: "seed-app", name: "read", arguments: { path: "app.ts", limit: 50 } },
					{ id: "seed-util", name: "read", arguments: { path: "util.ts", limit: 50 } },
				],
				// The real server needs its project load before it
				// publishes; give it time so the baseline is settled by
				// the edit case.
				settle: 12_000,
				check: (messages) => {
					if (activeLspTools(messages).length === 0) {
						throw new Error("the lsp tools did not activate in a project that has a server");
					}
				},
			},
			{
				name: "an edit that breaks the file: stock text kept, only the new diagnostic reported",
				toolCall: {
					id: "edit-break",
					name: "edit",
					arguments: {
						path: "app.ts",
						edits: [{ oldText: "console.log(helper);", newText: "const broken: string = 42;\nconsole.log(helper);" }],
					},
				},
				waitForResultId: "edit-break",
				expectResult: (result) => {
					const [stock, note] = result.content;
					if (!stock.text.startsWith("Successfully replaced 1 block(s) in app.ts.")) {
						throw new Error(`stock text missing or changed:\n${stock.text}`);
					}
					if (stock.text.includes("LSP:")) throw new Error(`stock block touched by the annotation:\n${stock.text}`);
					if (!note || note.type !== "text") throw new Error(`no annotation block after the stock text:\n${JSON.stringify(result.content)}`);
					if (!note.text.includes("1 new diagnostic")) throw new Error(`annotation does not name the one new diagnostic:\n${note.text}`);
					if (!note.text.includes(EDIT_ERROR)) throw new Error(`the new diagnostic is not named:\n${note.text}`);
					if (note.text.includes(PRE_EXISTING_ERROR)) {
						throw new Error(`the pre-existing error rode the annotation (baseline failed):\n${note.text}`);
					}
				},
			},
			{
				name: "lsp_diagnostics answers from the real server",
				toolCall: { id: "diag-app", name: "lsp_diagnostics", arguments: { file: "app.ts" } },
				waitForResultId: "diag-app",
				expectResult: (result) => {
					const text = result.content[0].text;
					if (!text.includes("2 diagnostics")) throw new Error(`expected both current errors, got:\n${text}`);
					if (!text.includes(PRE_EXISTING_ERROR) || !text.includes(EDIT_ERROR)) {
						throw new Error(`the current errors are missing:\n${text}`);
					}
				},
			},
			{
				name: "the Sweep reports a late external change and the turn does not continue",
				toolCall: {
					id: "edit-clean",
					name: "edit",
					arguments: {
						path: "app.ts",
						edits: [{ oldText: "console.log(helper);", newText: "// note\nconsole.log(helper);" }],
					},
				},
				// A change lands outside the edit tool, after the tool
				// results and before the turn end: the probe writes it
				// right before the turn's done answer, in a file the
				// server has open.
				externalWrite: { file: "util.ts", text: "export const utilValue: boolean = 1;\n" },
				waitForResultId: "edit-clean",
				expectResult: (result) => {
					const [stock, note] = result.content;
					if (!stock.text.startsWith("Successfully replaced 1 block(s) in app.ts.")) {
						throw new Error(`stock text missing:\n${stock.text}`);
					}
					if (!note?.text?.includes("no new diagnostics")) {
						throw new Error(`a clean edit must report no new diagnostics:\n${note?.text}`);
					}
				},
				waitForCustom: true,
				expectCustom: (custom) => {
					const text = Array.isArray(custom.content) ? custom.content.map((b) => b.text).join("") : custom.content;
					if (!text.includes("LSP sweep:")) throw new Error(`sweep message malformed:\n${text}`);
					if (!text.includes("util.ts")) throw new Error(`the sweep did not name the changed file:\n${text}`);
					if (!text.includes(SWEEP_ERROR)) throw new Error(`the sweep did not name the new error:\n${text}`);
				},
			},
			{
				name: "lsp_hover returns the real type",
				toolCall: { id: "hover-n", name: "lsp_hover", arguments: { file: "app.ts", line: 1, character: 4 } },
				waitForResultId: "hover-n",
				expectResult: (result) => {
					const text = result.content[0].text;
					if (!text.includes("number")) throw new Error(`hover did not carry the type:\n${text}`);
				},
			},
			{
				name: "lsp_references finds the real usage",
				toolCall: { id: "refs-helper", name: "lsp_references", arguments: { file: "app.ts", line: 2, character: 19 } },
				waitForResultId: "refs-helper",
				expectResult: (result) => {
					const text = result.content[0].text;
					// helper is defined at L2 and used once, at L7 in the
				// final file: the server must name that usage.
					if (!text.includes("L7")) {
						throw new Error(`the real usage of helper was not found:\n${text}`);
					}
				},
			},
		],
		check: (messages, cwd) => {
			const doneAnswers = messages.filter((m) => m.role === "assistant" && lastText(m) === "done");
			// One "done" per case. A sweep continuation would add another.
			if (doneAnswers.length !== 6) {
				fail(`the sweep continued the turn: ${doneAnswers.length} turn-end answers`);
			}
			const app = readFileSync(join(cwd, "app.ts"), "utf8");
			const expected =
				APP_TS.replace("console.log(helper);", "const broken: string = 42;\nconsole.log(helper);").replace(
					"console.log(helper);",
					"// note\nconsole.log(helper);",
				);
			if (app !== expected) {
				fail(`the file on disk is not what the built-in tool wrote:\n${app}`);
			}
		},
	};
}

function runEnabled() {
	return runSession("enabled", { trusted: true, settings: null, ...standardLoop() });
}

/** Install TypeScript 7 in the fixture: the project's own compiler. */
async function installTypeScript7(cwd) {
	const { execFileSync } = await import("node:child_process");
	execFileSync("npm", ["install", "typescript@7", "--no-audit", "--no-fund", "--loglevel=error"], {
		cwd,
		timeout: 180_000,
		stdio: "pipe",
	});
}

/**
 * The standard loop over a TypeScript 7 project (ADR 0044): the fixture
 * installs typescript@7, no language server is on any PATH, so the only
 * way the loop passes is the project's own native tsc (tsc --lsp
 * --stdio), found by the registry without any settings. The final check
 * reads the per-call log and proves the server that served was that tsc.
 */
function runTs7Enabled() {
	const loop = standardLoop();
	return runSession(
		"ts7",
		{
			trusted: true,
			settings: null,
			prepare: installTypeScript7,
			withRepoBin: false,
			cases: loop.cases,
			check: (messages, cwd) => {
				loop.check(messages, cwd);
				const log = join(cwd, ".agent", "lsp", cwd.replace(/[^A-Za-z0-9._-]/g, "-"), "usage.jsonl");
				const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
				const servers = new Set(records.filter((r) => r.server).map((r) => r.server));
				if (servers.size === 0) fail("the TS7 run left no per-call log: no server served it");
				if (![...servers].every((s) => s === "tsc")) {
					fail(`the TS7 run was not served by the native tsc: ${[...servers].join(", ")}`);
				}
			},
		},
	);
}

function runDisabled() {
	return runSession(
		"disabled",
		{
			trusted: true,
			// Every built-in language off: no server may start on any
			// machine, no matter which binaries it has.
			settings: {
				servers: {
					typescript: { disabled: true },
					"c-cpp": { disabled: true },
					rust: { disabled: true },
					python: { disabled: true },
					go: { disabled: true },
				},
			},
			cases: [
				{
					name: "disabled: the lsp tools stay inactive",
					calls: [{ id: "seed-app", name: "read", arguments: { path: "app.ts", limit: 50 } }],
					settle: 2000,
					check: (messages) => {
						if (activeLspTools(messages).length !== 0) {
							throw new Error(`the lsp tools activated despite the server being disabled: ${activeLspTools(messages).join(", ")}`);
						}
					},
				},
				{
					name: "disabled: the edit result is stock alone",
					toolCall: {
						id: "edit-break",
						name: "edit",
						arguments: {
							path: "app.ts",
							edits: [{ oldText: "console.log(helper);", newText: "const broken: string = 42;\nconsole.log(helper);" }],
						},
					},
					waitForResultId: "edit-break",
					expectResult: (result) => {
						if (result.content.length !== 1) {
							throw new Error(`the result must be the stock text alone:\n${JSON.stringify(result.content)}`);
						}
						if (!result.content[0].text.startsWith("Successfully replaced 1 block(s) in app.ts.")) {
							throw new Error(`stock text changed:\n${result.content[0].text}`);
						}
						if (result.content[0].text.includes("LSP")) throw new Error(`annotation present despite the off switch:\n${result.content[0].text}`);
					},
				},
			],
		},
	);
}

function runUntrusted() {
	return runSession(
		"untrusted",
		{
			trusted: false,
			// The empty settings file makes the project trust-requiring;
			// without it pi would auto-trust the empty fixture. Nothing
			// here opts in, so no server may start.
			settings: {},
			cases: [
				{
					name: "untrusted: no server starts, no tools activate",
					calls: [{ id: "seed-app", name: "read", arguments: { path: "app.ts", limit: 50 } }],
					settle: 3000,
					check: (messages) => {
						if (activeLspTools(messages).length !== 0) {
							throw new Error(`the lsp tools activated in an untrusted project: ${activeLspTools(messages).join(", ")}`);
						}
					},
				},
				{
					name: "untrusted: the edit result is stock alone",
					toolCall: {
						id: "edit-break",
						name: "edit",
						arguments: {
							path: "app.ts",
							edits: [{ oldText: "console.log(helper);", newText: "const broken: string = 42;\nconsole.log(helper);" }],
						},
					},
					waitForResultId: "edit-break",
					expectResult: (result) => {
						if (result.content.length !== 1) {
							throw new Error(`the result must be the stock text alone:\n${JSON.stringify(result.content)}`);
						}
						if (result.content[0].text.includes("LSP")) throw new Error(`annotation present in an untrusted project:\n${result.content[0].text}`);
					},
				},
			],
		},
	);
}

(async () => {
	await runEnabled();
	console.log("ok: enabled run");
	await runTs7Enabled();
	console.log("ok: ts7 run");
	await runDisabled();
	console.log("ok: disabled run");
	await runUntrusted();
	console.log("ok: untrusted run");
	console.log("E2E OK");
})().catch((error) => fail(error.stack ?? String(error)));
