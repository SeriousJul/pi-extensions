/**
 * E2E for the pruning extension.
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * extension loaded, and no live LLM call. A small probe extension
 * (written to the throwaway directory) records the active tool names on
 * session start, because the RPC surface exposes tools only through the
 * session the extension itself sees. Asserts:
 *
 *   1. no extension error at load or first use
 *   2. the recall tool is registered (active in the agent's tool set)
 *   3. the /pruning command exists and its settings subcommand shows the
 *      current keys, edits them, and persists to the project settings file
 *
 *   node tests/pruning/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "pruning", "index.ts");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

const probeSource = `
export default function (pi) {
	pi.on("session_start", () => {
		pi.appendEntry("e2e-probe", { tools: pi.getActiveTools() });
	});
}
`;

async function main() {
	const cwd = mkdtempSync(join(tmpdir(), "pruning-e2e-"));
	// A probe extension records the active tool names from inside the
	// session, and a project settings file keeps the /pruning settings
	// write inside the throwaway directory. The project file pins every key
	// the test asserts on, so the machine's global settings (which may set
	// pruning.enabled) cannot change the merged view.
	const probePath = join(cwd, "e2e-probe.ts");
	writeFileSync(probePath, probeSource);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const projectSettingsPath = join(cwd, ".pi", "settings.json");
	writeFileSync(projectSettingsPath, JSON.stringify({ pruning: { enabled: true, minResultTokens: 1500 } }, null, 2) + "\n");

	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy and the duplicate tool name
	// (recall) stops the session starting.
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extensionPath, "--extension", probePath], {
		cwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
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
	const respondUi = (id, fields = {}) => {
		child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...fields }) + "\n");
	};
	const waitFor = (predicate, what, timeoutMs = TIMEOUT_MS) =>
		new Promise((resolve, reject) => {
			const deadline = Date.now() + timeoutMs;
			const check = () => {
				const found = events.find(predicate);
				if (found) return resolve(found);
				if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}\nevents:\n${events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\nstderr:\n${stderr}`));
				setTimeout(check, 200);
			};
			check();
		});

	try {
		// 2: the recall tool is active in the agent's tool set.
		await new Promise((resolve) => setTimeout(resolve, 5000)); // session start has run by now
		const entries = await request("get_entries");
		if (!entries.success) fail(`get_entries: ${JSON.stringify(entries)}`);
		const probeEntry = (entries.data?.entries ?? []).find((e) => e.customType === "e2e-probe");
		if (!probeEntry) fail("no e2e-probe entry in the session");
		if (!Array.isArray(probeEntry.data?.tools) || !probeEntry.data.tools.includes("recall")) {
			fail(`recall tool not active; active tools: ${JSON.stringify(probeEntry.data?.tools)}`);
		}
		console.log("ok: the recall tool is registered and active");

		// 3: the /pruning command exists.
		const commands = await request("get_commands");
		if (!commands.success) fail(`get_commands: ${JSON.stringify(commands)}`);
		if (!(commands.data?.commands ?? []).some((c) => c.name === "pruning")) {
			fail(`pruning command not found; commands: ${JSON.stringify((commands.data?.commands ?? []).map((c) => c.name))}`);
		}
		console.log("ok: the /pruning command exists");

		// 3: the settings subcommand shows the current keys (read from the
		// project settings file written above) and then offers the picker,
		// which the test cancels. The prompt response only lands after the
		// handler settles, so the picker is answered first.
		const show = request("prompt", { message: "/pruning settings" });
		const picker = await waitFor((e) => e.type === "extension_ui_request" && e.method === "select", "the settings picker");
		respondUi(picker.id, { cancelled: true });
		const shown = await show;
		if (!shown.success) fail(`prompt /pruning settings: ${JSON.stringify(shown)}`);
		const shownNotify = await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && e.message.includes("pruning: enabled=true"), "the settings notification");
		if (!shownNotify.message.includes("minResultTokens=1500")) fail(`settings notification did not show the project value: ${shownNotify.message}`);
		console.log("ok: /pruning settings shows the current keys");

		// 3: editing a key persists to the project settings file.
		const edit = await request("prompt", { message: "/pruning settings minResultTokens=2500" });
		if (!edit.success) fail(`prompt /pruning settings minResultTokens=2500: ${JSON.stringify(edit)}`);
		const saved = await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && e.message.includes("minResultTokens=2500"), "the save notification");
		if (!saved.message.includes("saved to")) fail(`save notification did not name the target file: ${saved.message}`);
		const written = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
		if (written.pruning?.minResultTokens !== 2500) fail(`project settings not updated: ${JSON.stringify(written)}`);
		console.log("ok: /pruning settings edits persist to the project settings file");

		// 1: no extension error anywhere in the run.
		if (extensionErrors.length > 0) fail(`extension errors: ${JSON.stringify(extensionErrors)}`);
		console.log("ok: no extension errors");
	} finally {
		child.kill();
		rmSync(cwd, { recursive: true, force: true });
	}
	console.log("pruning E2E passed");
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
