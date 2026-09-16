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
 * 4. The uses column counts tool calls from a fixture sessions tree (pointed
 *    at with PI_SESSIONS_DIR): fork-copied lines count once, and /ctx 90d
 *    switches the window and admits the older call.
 *
 * The pi run uses the real HOME so it starts with a working model config,
 * but the usage scan is pointed at the fixture tree with its own cache file.
 * --no-extensions keeps only the one extension under test: on a machine
 * where this repo is installed as a pi package, discovery loads a second
 * copy and the duplicate command names (ctx:1, ctx:2) stop /ctx resolving.
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

// --- fixture sessions tree for the uses column --------------------------------

const sessionsDir = join(projectDir, "sessions");
mkdirSync(join(sessionsDir, "proj"), { recursive: true });
const nowMs = Date.now();
const DAY = 86_400_000;
const call = (name, args) => ({ type: "toolCall", id: "x", name, arguments: args ?? {} });
const msg = (id, daysAgo, calls) =>
	JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(nowMs - daysAgo * DAY).toISOString(),
		message: { role: "assistant", content: calls },
	});
const aLines = [
	msg("a1", 1, [call("bash"), call("bash"), call("read")]),
	msg("a2", 40, [call("write")]),
	// A recent skill load: the e2e-skill row must show 1.
	msg("a3", 1, [call("read", { path: join(projectDir, "e2e-skill", "SKILL.md") })]),
].join("\n");
writeFileSync(join(sessionsDir, "proj", "a.jsonl"), aLines);
// The fork copies a's lines byte-identical and adds one own bash call.
writeFileSync(join(sessionsDir, "proj", "a-fork.jsonl"), aLines + "\n" + msg("f1", 1, [call("bash")]) + "\n");
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
		[piCli, "--mode", "rpc", "--no-extensions", "--extension", extensionPath, "--skill", skillDir, "--no-skills", "--append-system-prompt", appendText],
		{
			cwd: projectDir,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SESSIONS_DIR: sessionsDir,
				PI_TOOL_USAGE_CACHE: join(projectDir, "tool-usage-cache.json"),
			},
		},
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
				if (record.type === "extension_ui_request" && record.method === "setStatus" && record.statusKey === "pi-extensions") {
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

	const firstNote = await waitFor(
		() => rpc.notifies.find((n) => (n.message ?? "").startsWith("initial context:")),
		"/ctx notify record",
		rpc.getStderr,
	);
	const firstMessage = firstNote.message ?? "";
	if (!firstMessage.match(/^initial context: [\d,]+ tokens \(\d+\.\d% of [\d,]+ window\)$/m)) {
		fail(`/ctx missing the totals header:\n${firstMessage}`);
	}
	for (const expected of ["name  src", "base prompt", "append text", "AGENTS.md", "e2e-skill", "cwd", "(built-in schema)", "TOTAL"]) {
		if (!firstMessage.includes(expected)) fail(`/ctx (first) missing ${expected}:\n${firstMessage}`);
	}
	if (firstMessage.includes("provider report")) fail(`/ctx (first) should not have a provider reference yet:\n${firstMessage}`);
	if (firstMessage.includes("injection")) fail(`/ctx (first) should not flag an injection:\n${firstMessage}`);
	console.log("ok: /ctx before the first call breaks down the prompt and lists built-in tool schemas");

	// The uses column: bash 3 (the fork's copy counts once), read 2 (one of
	// them loads e2e-skill, so the skill row shows 1 too), write 0 in 30d,
	// and TOTAL 5 (tool calls only).
	const rowLine = (message, name) => {
		const line = message.split("\n").find((l) => l.trim().startsWith(name));
		if (!line) fail(`/ctx (first) missing the ${name} row:\n${message}`);
		return line;
	};
	if (!firstMessage.includes("uses(30d)")) fail(`/ctx (first) missing the uses(30d) header:\n${firstMessage}`);
	if (!rowLine(firstMessage, "bash").match(/ 3(  \u2588+)?\s*$/)) fail(`/ctx (first) bash row does not end in 3:\n${rowLine(firstMessage, "bash")}`);
	if (!rowLine(firstMessage, "read").match(/ 2(  \u2588+)?\s*$/)) fail(`/ctx (first) read row does not end in 2:\n${rowLine(firstMessage, "read")}`);
	if (!rowLine(firstMessage, "write").match(/ 0(  \u2588+)?\s*$/)) fail(`/ctx (first) write row does not end in 0:\n${rowLine(firstMessage, "write")}`);
	if (!rowLine(firstMessage, "e2e-skill").match(/ 1(  \u2588+)?\s*$/)) fail(`/ctx (first) e2e-skill row does not end in 1:\n${rowLine(firstMessage, "e2e-skill")}`);
	if (!rowLine(firstMessage, "TOTAL").match(/ 5  \u2588/)) fail(`/ctx (first) TOTAL row does not sum to 5:\n${rowLine(firstMessage, "TOTAL")}`);
	console.log("ok: the uses column counts the fixture tree, fork copies once, skill loads count, 30d window");

	const status = await waitFor(
		() => rpc.statuses[rpc.statuses.length - 1],
		"footer status",
		rpc.getStderr,
	);
	if (!/^ctx: .+ \(\d+\.\d%\)/.test(status.statusText ?? "")) {
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
	const second = await rpc.request("prompt", { message: "/ctx 90d" });
	if (!second.success) fail(`/ctx (second): ${JSON.stringify(second)}`);
	const secondNote = await waitFor(
		() =>
			rpc.notifies
				.slice(seen)
				.find((n) => (n.message ?? "").startsWith("initial context:")),
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
	// The 90d window admits the 40-day write call.
	if (!secondMessage.includes("uses(90d)")) fail(`/ctx (second) missing the uses(90d) header:\n${secondMessage}`);
	const rowLine90 = (name) => {
		const line = secondMessage.split("\n").find((l) => l.trim().startsWith(name));
		if (!line) fail(`/ctx (second) missing the ${name} row:\n${secondMessage}`);
		return line;
	};
	if (!rowLine90("write").match(/ 1(  \u2588+)?\s*$/)) fail(`/ctx (second) write row does not end in 1:\n${rowLine90("write")}`);
	if (!rowLine90("TOTAL").match(/ 6  \u2588/)) fail(`/ctx (second) TOTAL row does not sum to 6:\n${rowLine90("TOTAL")}`);
	console.log("ok: /ctx after the first call shows captured tools and the provider reference, with no injection");
	console.log("ok: /ctx 90d switches the window and admits the older call");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

console.log("initial-context E2E passed");
