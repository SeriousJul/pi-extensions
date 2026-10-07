/**
 * E2E for the skill-command extension.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with a
 * fixture skill, and drives the exact injection shape issue #126 reports:
 * a skill command whose name and arguments are separated by a NEWLINE, as
 * the factory's consultation templates inject them. pi's built-in expansion
 * parses the name up to the first space, so the newline shape passes
 * through unexpanded, and the recorded user message still starts with the
 * literal "/skill:" line. With the fixture skill's
 * disable-model-invocation frontmatter, the skill is also absent from the
 * system prompt's skills section, so the model gets no pointer to it and
 * must hunt the filesystem.
 *
 *   1. extension run: the newline-injected command is expanded to the
 *      <skill> block before the message is recorded
 *   2. extension run: the space-separated command still expands
 *   3. extension run: non-skill input is recorded byte-identical
 *   4. control run (no extension): the newline shape passes through
 *      unexpanded - the upstream gap the extension closes
 *
 * Any extension_error event fails the run.
 *
 *   node tests/skill-command/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "skill-command", "index.ts");
const fixturePath = join(repoRoot, "tests", "skill-command", "fixture", "loop-fixture");
const TIMEOUT_MS = 30_000;
const INJECTED = "/skill:loop-fixture\n\nDo the fixture thing.";
const SPACED = "/skill:loop-fixture Do the fixture thing.";
const PLAIN = "Do the fixture thing.";

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function startRpc(withExtension) {
	const cwd = mkdtempSync(join(tmpdir(), "skill-command-e2e-"));
	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy; the fixture skill is loaded
	// explicitly with --skill, so the run is isolated from machine config.
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--no-extensions", "--skill", fixturePath, ...(withExtension ? ["--extension", extensionPath] : [])],
		{
			cwd,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
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

function userTexts(messages) {
	return (messages ?? [])
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join(""),
		);
}

/**
 * Send the prompt, wait for the user message that carries it, then abort the
 * turn. The message lands in the agent state before the model call answers,
 * so no model reply is required: the abort stops the in-flight call, keeps
 * the run fast and deterministic, and leaves the session idle for the next
 * prompt.
 */
async function promptAndRecord(rpc, message) {
	const prompt = await rpc.request("prompt", { message });
	if (!prompt.success) fail(`prompt: ${JSON.stringify(prompt)}`);
	let recorded;
	const deadline = Date.now() + 15_000;
	for (;;) {
		const state = await rpc.request("get_messages");
		if (!state.success) fail(`get_messages: ${JSON.stringify(state)}`);
		const texts = userTexts(state.data?.messages);
		const last = texts[texts.length - 1];
		// Expanded or untouched, the recorded message starts with what the
		// prompt started with, minus nothing: expansion rewrites the leading
		// "/skill:" line into the <skill> block and keeps the args.
		if (last !== undefined && (last.startsWith("/skill:") || last.startsWith("<skill") || last === message)) {
			recorded = last;
			break;
		}
		if (Date.now() > deadline) fail(`user message for ${JSON.stringify(message.slice(0, 40))} never appeared`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const aborted = await rpc.request("abort");
	if (!aborted.success) fail(`abort: ${JSON.stringify(aborted)}`);
	return recorded;
}

// 1-3: extension run
const withExt = startRpc(true);
try {
	const commands = await withExt.request("get_commands");
	if (!commands.success) fail(`get_commands: ${JSON.stringify(commands)}`);
	if (!(commands.data?.commands ?? []).some((command) => command.name === "skill:loop-fixture")) {
		fail("fixture skill not discoverable; the loop is invalid");
	}
	console.log("ok: fixture skill discoverable (skill:loop-fixture in command list)");

	const injected = await promptAndRecord(withExt, INJECTED);
	if (!injected.startsWith('<skill name="loop-fixture"')) {
		fail(`newline-injected command was not expanded; recorded head: ${injected.split("\n").slice(0, 2).join(" | ").slice(0, 120)}`);
	}
	if (!injected.includes("Do the fixture thing.")) {
		fail("expanded command lost its arguments");
	}
	if (!injected.includes("FIXTURE SKILL BODY.")) {
		fail("expanded command does not carry the skill body");
	}
	console.log("ok: newline-injected skill command expands to the <skill> block");

	const spaced = await promptAndRecord(withExt, SPACED);
	if (!spaced.startsWith('<skill name="loop-fixture"')) {
		fail(`space-separated command was not expanded; recorded head: ${spaced.split("\n").slice(0, 2).join(" | ").slice(0, 120)}`);
	}
	console.log("ok: space-separated skill command still expands");

	const plain = await promptAndRecord(withExt, PLAIN);
	if (plain !== PLAIN) {
		fail(`non-skill input was modified; recorded head: ${plain.slice(0, 120)}`);
	}
	console.log("ok: non-skill input is recorded byte-identical");
} finally {
	if (withExt.extensionErrors.length > 0) fail(`extension run: ${JSON.stringify(withExt.extensionErrors)}`);
	withExt.close();
}

// 4: control run documents the upstream gap
const control = startRpc(false);
try {
	const recorded = await promptAndRecord(control, INJECTED);
	if (recorded !== INJECTED) {
		fail(`control run unexpectedly expanded or modified the injected command; recorded head: ${recorded.slice(0, 120)}`);
	}
	console.log("ok: without the extension the newline shape passes through unexpanded (the bug the extension closes)");
} finally {
	if (control.extensionErrors.length > 0) fail(`control run: ${JSON.stringify(control.extensionErrors)}`);
	control.close();
}

console.log("skill-command E2E passed");
