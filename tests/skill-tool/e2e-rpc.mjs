/**
 * E2E for the skill-tool extension (issue #143).
 *
 * The ticket: a skill's instructions say "call the Skill tool for X"; pi
 * has no such tool, so the model re-types the skill's install path by
 * hand, guesses wrong (a sibling bucket, a mangled directory name), and
 * the read dies with ENOENT (session 01a13a4d). The fixture mirrors the
 * ticket's layout: `grill-docs` sits in `b-bucket` and references
 * `grilling` and `domain-modeling`, which sit in `a-bucket` - so the
 * sibling path the ticket's model guessed does not exist.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * fixture tree loaded and no live LLM: a probe extension registers a
 * scripted provider that stands in for the model following the skill's
 * instructions. The agent dir is a throwaway, so the skill registry is
 * exactly the fixture tree: every known name is one of the three fixtures.
 *
 *   extension run:
 *     1. /skill:grill-docs expands, and both referenced skills load by
 *        name from the tree pi points at: no ENOENT anywhere
 *     2. an unknown name gets back the loaded names to correct against
 *   control run (no skill tool):
 *     3. the same name-based call has no tool at all
 *     4. the model's only remaining path is guessing, and the guess
 *        ENOENTs - the ticket's symptom, reproduced deterministically
 *
 * Any extension_error event fails the run.
 *
 *   node tests/skill-tool/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "skill-tool", "index.ts");
const noopPath = join(repoRoot, "tests", "skill-tool", "noop-extension.ts");
const probePath = join(repoRoot, "tests", "skill-tool", "e2e-probe.ts");
const fixtureRoot = join(repoRoot, "tests", "skill-tool", "fixture", "skills");
const grillingPath = join(fixtureRoot, "a-bucket", "grilling", "SKILL.md");
const domainModelingPath = join(fixtureRoot, "a-bucket", "domain-modeling", "SKILL.md");
/** The sibling path the ticket's model guessed: grill-docs's bucket, grilling's name. */
const guessedPath = join(fixtureRoot, "b-bucket", "grilling", "SKILL.md");
const TIMEOUT_MS = 90_000;
/** The exact /skill: command the ticket's session submitted. */
const PROMPT = "/skill:grill-docs Stress-test this plan.";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function startRpc(label, extensionPath) {
	const cwd = mkdtempSync(join(tmpdir(), `skill-tool-e2e-${label}-`));
	const agentDir = mkdtempSync(join(tmpdir(), `skill-tool-e2e-${label}-agent-`));
	const caseFile = join(cwd, "e2e-case.json");
	writeFileSync(caseFile, JSON.stringify({ runId: 0, calls: [] }));
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--no-extensions", "--skill", fixtureRoot, "--extension", extensionPath, "--extension", probePath],
		{
			cwd,
			env: { ...process.env, E2E_CASE_FILE: caseFile, PI_CODING_AGENT_DIR: agentDir },
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
	// pi writes sessions under `<agentDir>/sessions/--<cwd slug>--/<id>.jsonl`.
	const sessionFile = () => {
		const files = [];
		const walk = (dir) => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
			}
		};
		walk(join(agentDir, "sessions"));
		if (files.length !== 1) throw new Error(`expected one session file, found ${JSON.stringify(files)}\nstderr:\n${stderr}`);
		return files[0];
	};
	return {
		request,
		events,
		extensionErrors,
		caseFile,
		sessionFile,
		async waitForTurn(what) {
			const deadline = Date.now() + TIMEOUT_MS;
			for (;;) {
				const record = await request("get_state");
				if (record.success && record.data?.isStreaming === false && record.data?.needsContinuation !== true) return;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstderr:\n${stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		},
		close() {
			child.stdin.end();
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** The user texts pi recorded, in order, from the real session file. */
function userTexts(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry) => {
			const content = entry.message.content;
			return typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
		});
}

/** The first text blocks of one tool result, joined, from the session file. */
function resultText(file, toolCallId) {
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolCallId === toolCallId);
	if (entries.length !== 1) throw new Error(`expected one tool result for ${toolCallId}, got ${entries.length}`);
	const content = entries[0].message.content ?? [];
	return {
		isError: entries[0].message.isError === true,
		text: content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("|"),
	};
}

/** Every tool result text in the session, for the ENOENT sweep. */
function allResultTexts(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
		.map((entry) =>
			(entry.message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("|"),
		);
}

/** Drive the cases through one pi process, then run each case's asserts. */
async function runCases(label, extensionPath, cases) {
	const rpc = startRpc(label, extensionPath);
	try {
		await new Promise((resolve) => setTimeout(resolve, 6000)); // session start has run by now
		const setModel = await rpc.request("set_model", { provider: "e2st", modelId: "e2e-1" });
		if (!setModel.success) fail(`set_model: ${JSON.stringify(setModel)}\nevents:\n${lastStderr(rpc)}`);
		for (const [index, test] of cases.entries()) {
			writeFileSync(rpc.caseFile, JSON.stringify({ runId: index + 1, calls: test.calls }));
			const prompt = await rpc.request("prompt", { message: test.prompt ?? PROMPT });
			if (!prompt.success) fail(`${label} case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}`);
			await rpc.waitForTurn(`${label} case ${index + 1} to settle`);
			// The session file lands with the first prompt, so it exists by now.
			await test.assert({ file: rpc.sessionFile() });
			console.log(`ok: ${label} case ${index + 1}: ${test.name}`);
		}
		if (rpc.extensionErrors.length > 0) fail(`${label}: extension errors: ${JSON.stringify(rpc.extensionErrors)}`);
	} finally {
		rpc.close();
	}
}

function lastStderr(rpc) {
	// stderr is captured inside startRpc's closure; the events array doubles
	// as the diagnostic surface on failure.
	return rpc.events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n").slice(-2000);
}

// 1-2: extension run
await runCases(
	"extension",
	extensionPath,
	[
		{
			name: "/skill:grill-docs expands and both referenced skills load by name, with no ENOENT",
			calls: [
				{ id: "e2-ref1", name: "skill", arguments: { name: "grilling" } },
				{ id: "e2-ref2", name: "skill", arguments: { name: "domain-modeling" } },
			],
			assert: ({ file }) => {
				const texts = userTexts(file);
				const recorded = texts.find((text) => text.startsWith("<skill name=\"grill-docs\""));
				if (!recorded) fail("the /skill: command was not expanded into the <skill> block:\n" + texts.join("\n---\n"));
				if (!recorded.includes("Call the Skill tool twice")) fail("the expansion lost the skill body:\n" + recorded.slice(0, 300));
				if (!recorded.includes("location=")) fail("the expansion lost the location attribute");

				const grilling = resultText(file, "e2-ref1");
				if (grilling.isError) fail(`loading grilling by name failed: ${grilling.text.slice(0, 300)}`);
				if (!grilling.text.includes("GRILLING BODY.")) fail(`grilling's body is missing from the result:\n${grilling.text.slice(0, 300)}`);
				if (!grilling.text.includes(`location="${grillingPath}"`))
					fail(`the result does not name the real file pi points at:\n${grilling.text.slice(0, 300)}`);
				if (!existsSync(grillingPath)) fail(`the named file does not exist: ${grillingPath}`);

				const modeling = resultText(file, "e2-ref2");
				if (modeling.isError) fail(`loading domain-modeling by name failed: ${modeling.text.slice(0, 300)}`);
				if (!modeling.text.includes("DOMAIN MODELING BODY."))
					fail(`domain-modeling's body is missing from the result:\n${modeling.text.slice(0, 300)}`);
				if (!modeling.text.includes(`location="${domainModelingPath}"`))
					fail(`the result does not name the real file pi points at:\n${modeling.text.slice(0, 300)}`);

				if (allResultTexts(file).some((text) => text.includes("ENOENT"))) {
					fail("a tool result in the ticket's flow still dies with ENOENT:\n" + allResultTexts(file).join("\n---\n"));
				}
			},
		},
		{
			name: "an unknown name gets back the loaded names to correct against",
			calls: [{ id: "e2-unknown", name: "skill", arguments: { name: "no-such-skill" } }],
			assert: ({ file }) => {
				const result = resultText(file, "e2-unknown");
				if (!result.isError) fail(`the unknown name did not fail: ${result.text.slice(0, 200)}`);
				if (!result.text.includes("is not loaded in this session")) fail(`no correction guidance in the error:\n${result.text}`);
				for (const name of ["domain-modeling", "grill-docs", "grilling"]) {
					if (!result.text.includes(name)) fail(`the loaded list is missing ${name}:\n${result.text}`);
				}
			},
		},
	],
);

// 3-4: control run documents the gap the extension closes
await runCases(
	"control",
	noopPath,
	[
		{
			name: "without the skill tool the name-based call has no tool at all",
			calls: [{ id: "ctl-tool", name: "skill", arguments: { name: "grilling" } }],
			assert: ({ file }) => {
				const result = resultText(file, "ctl-tool");
				if (!result.isError) fail(`the unknown tool did not fail: ${result.text.slice(0, 200)}`);
				if (result.text.includes("GRILLING BODY.")) fail(`the skill loaded without the tool: ${result.text.slice(0, 200)}`);
				console.log(`note: pi answers the tool-less call with: ${result.text.split("\n")[0].slice(0, 120)}`);
			},
		},
		{
			name: "the only remaining path is guessing, and the ticket's guess ENOENTs",
			calls: [{ id: "ctl-guess", name: "read", arguments: { path: guessedPath, offset: 1, limit: 2000 } }],
			assert: ({ file }) => {
				const result = resultText(file, "ctl-guess");
				if (!result.isError) fail(`the guessed path unexpectedly read: ${result.text.slice(0, 200)}`);
				if (!/ENOENT|no such file/i.test(result.text)) {
					fail(`the ticket's symptom (ENOENT on the guessed path) did not reproduce:\n${result.text}`);
				}
			},
		},
	],
);

console.log("skill-tool E2E passed");
