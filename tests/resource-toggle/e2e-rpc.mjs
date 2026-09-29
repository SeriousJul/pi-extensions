/**
 * E2E for the resource-toggle extension.
 *
 * A real pi process in RPC mode runs in a sandboxed home (its own agent
 * dir, no model config: only extension commands and get_commands are used)
 * and a temporary trusted project. The sandbox holds a dummy fixture
 * extension in the global extensions dir (one command, one tool) and a
 * second dummy in the project extensions dir, plus the resource-toggle
 * extension.
 *
 * Asserted, on the settings file content and on what the live session
 * exposes:
 *   1. both dummies are visible at start (command list + the dummy tool in
 *      the live tool registry, reported by the dummy command);
 *   2. /disable lands the right pattern in the sandboxed settings file and
 *      the dummy command and tool are gone from the session after the
 *      reload;
 *   3. a re-enable and reload brings them back;
 *   4. project mode disables a project resource in the project file, and a
 *      global resource by Shadow entry, which wins over the global state;
 *      /inherit clears the project side again;
 *   5. the self-guard refuses to disable resource-toggle itself, and a
 *      missing name and an ambiguous name are reported clearly;
 *   6. a package-bundled extension that is "disabled" only by an old no-op
 *      package-relative pattern in the extensions array is still active
 *      (the incident), and /disable on it lands the packages-array filter
 *      and self-heals the no-op pattern; /enable swaps the filter and the
 *      command returns; project mode writes the filter into the project
 *      file and /inherit collapses the entry back to the plain string.
 *      The package entry is spelled "~/pkg": pi and the toggle both
 *      expand the leading tilde, and the project-mode rewrite lands the
 *      real relative path.
 *   7. a single-file local package is loaded unconditionally by pi, so
 *      the toggle is refused with a clear message and nothing is written.
 *
 *   Deliberate deviation from the spec's Seam 2: the spec pins a local
 *   install of this repository with the real quota extension and an
 *   assertion on its footer status piece. The quota piece depends on a
 *   live quota read and stays invisible without a login, so it cannot be
 *   observed in a sandboxed home. The package cycle asserts on command
 *   and tool liveness instead: the dummy command reports the live tool
 *   registry from the session, so a still-live command and tool are direct
 *   evidence the package factory did not run the filter.
 *
 *   node tests/resource-toggle/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "resource-toggle", "index.ts");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	if (sandbox) console.error(`sandbox kept at ${sandbox}`);
	process.exit(1);
}

// --- sandbox ------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "resource-toggle-e2e-"));
const agentDir = join(sandbox, "agent");
const project = join(sandbox, "project");
const globalSettingsPath = join(agentDir, "settings.json");
const projectSettingsPath = join(project, ".pi", "settings.json");

mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
writeFileSync(globalSettingsPath, JSON.stringify({ defaultProjectTrust: "always" }, null, 2) + "\n");
writeFileSync(projectSettingsPath, "{}\n");

const dummyBody = (name, tool) => `
export default function (pi: any): void {
	pi.registerCommand("${name}", {
		description: "E2E fixture command",
		async handler(_args: string, ctx: any): Promise<void> {
			ctx.ui.notify(\`${name} active tools: \` + pi.getActiveTools().sort().join(","), "info");
		},
	});
	pi.registerTool({
		name: "${tool}",
		label: "Dummy",
		description: "E2E fixture tool",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "${tool}" }], details: {} }),
	});
}
`;
writeFileSync(join(agentDir, "extensions", "dummy.ts"), dummyBody("dummy", "dummy_tool"));
writeFileSync(join(project, ".pi", "extensions", "dummy2.ts"), dummyBody("dummy2", "dummy2_tool"));

// A local package with two extensions. The global settings carry the
// package as a plain entry plus an old no-op package-relative pattern in
// the extensions array, exactly the harmed shape the incident left behind:
// the pattern resolves against the agent dir, where nothing matches, so pi
// ignores it and the "disabled" command is still active.
const pkgDir = join(sandbox, "pkg");
mkdirSync(join(pkgDir, "extensions"), { recursive: true });
writeFileSync(
	join(pkgDir, "package.json"),
	JSON.stringify({ name: "e2e-pkg", version: "0.0.0" }, null, 2) + "\n",
);
writeFileSync(join(pkgDir, "extensions", "quota.ts"), dummyBody("quota", "quota_tool"));
writeFileSync(join(pkgDir, "extensions", "pkgother.ts"), dummyBody("pkgother", "pkgother_tool"));
// A single-file local package source: pi loads the file unconditionally and
// never applies a packages-array filter to it, so its state cannot be
// toggled. HOME is the sandbox, so ~/single.ts is a sandbox path.
writeFileSync(join(sandbox, "single.ts"), dummyBody("single", "single_tool"));
const globalSeed = {
	defaultProjectTrust: "always",
	// "~/pkg": HOME is the sandbox, so the entry names the local package with
	// a tilde, exactly as a user would write it.
	packages: ["~/pkg", "~/single.ts"],
	extensions: ["-extensions/quota.ts"],
};
writeFileSync(globalSettingsPath, JSON.stringify(globalSeed, null, 2) + "\n");

const readGlobal = () => JSON.parse(readFileSync(globalSettingsPath, "utf8"));
const readProject = () => JSON.parse(readFileSync(projectSettingsPath, "utf8"));

// --- pi RPC ---------------------------------------------------------------------

function startRpc() {
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--extension", extensionPath],
		{
			cwd: project,
			env: { ...process.env, HOME: sandbox, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const notifies = [];
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
		extensionErrors,
		getStderr: () => stderr,
		close() {
			child.kill();
			rmSync(sandbox, { recursive: true, force: true });
		},
	};
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
	// --- Phase 1: both dummies visible at start ---------------------------------

	const commands = (await rpc.request("get_commands")).data.commands.map((c) => c.name);
	for (const name of ["dummy", "dummy2", "resources", "enable", "disable", "inherit"]) {
		if (!commands.includes(name)) fail(`missing command ${name} at start: ${commands}`);
	}
	console.log("ok: resource-toggle and both dummies are visible at start");

	await rpc.request("prompt", { message: "/dummy" });
	let note = await waitFor(
		() => rpc.notifies.find((n) => (n.message ?? "").startsWith("dummy active tools:")),
		"dummy notify",
		rpc.getStderr,
	);
	if (!note.message.includes("dummy_tool")) fail(`/dummy missing dummy_tool:\n${note.message}`);
	if (!note.message.includes("resource_toggle")) fail(`/dummy missing resource_toggle:\n${note.message}`);
	console.log("ok: the live session exposes the dummy tool and the resource_toggle tool");

	// --- Phase 2: disable globally ------------------------------------------------

	let seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable dummy" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Ambiguous name")),
		"ambiguous report",
		rpc.getStderr,
	);
	if (!note.message.includes("dummy.ts") || !note.message.includes("dummy2.ts")) {
		fail(`ambiguous report does not list both candidates:\n${note.message}`);
	}
	console.log("ok: an ambiguous name lists its candidates");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable dummy.ts" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Disabled extension")),
		"disable report",
		rpc.getStderr,
	);
	if (!note.message.includes("rebinds every extension")) fail(`disable report missing reload note:\n${note.message}`);
	await waitFor(() => readGlobal().extensions?.includes("-extensions/dummy.ts"), "disable pattern in global settings", rpc.getStderr);
	await waitForCommands(["dummy"], false);
	console.log("ok: disable lands -extensions/dummy.ts and the dummy command is gone after the reload");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/resources" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("resources (global view)")),
		"/resources table",
		rpc.getStderr,
	);
	const dummyLine = (note.message ?? "").split("\n").find((l) => l.startsWith("dummy.ts")) ?? "";
	if (!dummyLine.includes("disabled")) fail(`/resources does not show dummy.ts disabled:\n${note.message}`);
	const dummy2Line = (note.message ?? "").split("\n").find((l) => l.startsWith("dummy2.ts")) ?? "";
	if (!dummy2Line.includes("enabled")) fail(`/resources does not show dummy2.ts enabled:\n${note.message}`);
	console.log("ok: /resources in RPC mode prints the text table with the right states");

	// --- Phase 3: re-enable ---------------------------------------------------------

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/enable dummy.ts" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Enabled extension")),
		"enable report",
		rpc.getStderr,
	);
	await waitFor(
		() => {
			const ext = readGlobal().extensions ?? [];
			return ext.includes("+extensions/dummy.ts") && !ext.includes("-extensions/dummy.ts");
		},
		"enable pattern in global settings",
		rpc.getStderr,
	);
	await waitForCommands(["dummy"], true);
	await rpc.request("prompt", { message: "/dummy" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("dummy active tools:")),
		"dummy notify after re-enable",
		rpc.getStderr,
	);
	if (!note.message.includes("dummy_tool")) fail(`/dummy after re-enable missing dummy_tool:\n${note.message}`);
	console.log("ok: re-enable and reload bring the dummy command and tool back");

	// --- Phase 4: project mode ------------------------------------------------------

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable dummy2.ts --project" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Disabled extension")),
		"project disable report",
		rpc.getStderr,
	);
	await waitFor(
		() => JSON.stringify(readProject().extensions) === JSON.stringify(["-extensions/dummy2.ts"]),
		"disable pattern in project settings",
		rpc.getStderr,
	);
	await waitForCommands(["dummy2"], false);
	console.log("ok: project mode disables the project resource in the project file");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/enable dummy2.ts --project" });
	await waitFor(
		() => JSON.stringify(readProject().extensions) === JSON.stringify(["+extensions/dummy2.ts"]),
		"enable pattern in project settings",
		rpc.getStderr,
	);
	await waitForCommands(["dummy2"], true);
	console.log("ok: project mode re-enables the project resource");

	// --- Phase 5: shadow entries ------------------------------------------------------

	const dummyPath = join(agentDir, "extensions", "dummy.ts");
	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable dummy.ts --project" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Disabled extension")),
		"shadow disable report",
		rpc.getStderr,
	);
	await waitFor(
		() =>
			(readProject().extensions ?? []).includes(dummyPath) &&
			(readProject().extensions ?? []).includes(`-${dummyPath}`) &&
			(readGlobal().extensions ?? []).includes("+extensions/dummy.ts"),
		"shadow entries in project settings, global file untouched",
		rpc.getStderr,
	);
	await waitForCommands(["dummy"], false);
	console.log("ok: a project-mode disable of a global resource writes a Shadow entry that wins");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/inherit dummy.ts" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Cleared the project override")),
		"inherit report",
		rpc.getStderr,
	);
	await waitFor(
		() => !readProject().extensions.includes(dummyPath) && !readProject().extensions.includes(`-${dummyPath}`),
		"shadow entries to be removed",
		rpc.getStderr,
	);
	await waitForCommands(["dummy"], true);
	console.log("ok: inherit clears the project side and the resource returns to the global state");

	// --- Phase 6: self-guard and name errors -------------------------------------------

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable resource-toggle" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Refused")),
		"self-guard refusal",
		rpc.getStderr,
	);
	if (!note.message.includes("resource-toggle")) fail(`self-guard refusal is unclear:\n${note.message}`);
	const globalAfter = readGlobal();
	if ((globalAfter.extensions ?? []).some((e) => String(e).includes("resource-toggle"))) {
		fail(`self-guard wrote settings anyway: ${JSON.stringify(globalAfter)}`);
	}
	console.log("ok: the extension refuses to disable itself");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable nope" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("No resource matches")),
		"no-match report",
		rpc.getStderr,
	);
	if (!note.message.includes("nope")) fail(`no-match report is unclear:\n${note.message}`);
	console.log("ok: a name that matches nothing is reported");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/inherit dummy.ts --global" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("inherit is project mode only")),
		"inherit --global refusal",
		rpc.getStderr,
	);
	console.log("ok: inherit rejects the global flag");

	// --- Phase 7: package resources --------------------------------------------------

	// The incident: the old no-op pattern did not disable the package
	// extension, so its command is active despite the settings file.
	await waitForCommands(["quota", "pkgother"], true);
	await rpc.request("prompt", { message: "/quota" });
	note = await waitFor(
		() => rpc.notifies.find((n) => (n.message ?? "").startsWith("quota active tools:")),
		"quota notify at start",
		rpc.getStderr,
	);
	if (!note.message.includes("quota_tool")) fail(`/quota missing quota_tool:\n${note.message}`);
	console.log("ok: the no-op pattern leaves the package command active (incident reproduced)");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable quota.ts" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Disabled extension")),
		"package disable report",
		rpc.getStderr,
	);
	if (!note.message.includes("rebinds every extension")) fail(`package disable report missing reload note:\n${note.message}`);
	await waitFor(
		() => {
			const g = readGlobal();
			const entry = (g.packages ?? []).find((p) => typeof p === "object" && p.source === "~/pkg");
			return entry && JSON.stringify(entry.extensions) === JSON.stringify(["-extensions/quota.ts"]);
		},
		"packages filter in global settings",
		rpc.getStderr,
	);
	await waitFor(
		() => !(readGlobal().extensions ?? []).some((e) => String(e).includes("quota")),
		"no-op pattern self-healed out of the extensions array",
		rpc.getStderr,
	);
	await waitForCommands(["quota"], false);
	console.log("ok: package disable lands the packages filter, self-heals the no-op, and the command is gone");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/enable quota.ts" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Enabled extension")),
		"package enable report",
		rpc.getStderr,
	);
	await waitFor(
		() => {
			const g = readGlobal();
			const entry = (g.packages ?? []).find((p) => typeof p === "object" && p.source === "~/pkg");
			return entry && JSON.stringify(entry.extensions) === JSON.stringify(["+extensions/quota.ts"]);
		},
		"enable filter in global settings",
		rpc.getStderr,
	);
	await waitForCommands(["quota"], true);
	console.log("ok: package enable swaps the filter and the command returns");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable quota.ts --project" });
	await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Disabled extension")),
		"project package disable report",
		rpc.getStderr,
	);
	await waitFor(
		() => {
			const p = readProject();
			const entry = (p.packages ?? []).find((e) => typeof e === "object");
			// A local source is rewritten relative to the project dir for
			// portability: sandbox/project/.pi -> sandbox/pkg is ../../pkg.
			return entry && entry.source === "../../pkg" && JSON.stringify(entry.extensions) === JSON.stringify(["-extensions/quota.ts"]);
		},
		"packages filter in project settings",
		rpc.getStderr,
	);
	// The global + filter stays; the project - entry replaces it for this session.
	await waitForCommands(["quota"], false);
	console.log("ok: project mode writes the project filter that replaces the global one");

	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/inherit quota.ts" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Cleared the project override")),
		"package inherit report",
		rpc.getStderr,
	);
	await waitFor(
		() => JSON.stringify(readProject().packages) === JSON.stringify(["../../pkg"]),
		"project entry collapsed to the plain relative source string",
		rpc.getStderr,
	);
	await waitForCommands(["quota"], true);
	console.log("ok: inherit collapses the project entry to the plain string and the command returns");

	// --- Phase 8: single-file package refusal ---------------------------------

	// The single-file source is loaded unconditionally: its command is live
	// from the start, and a toggle of it is refused without a settings write.
	await waitForCommands(["single"], true);
	const globalBeforeRefusal = readGlobal();
	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/disable single" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("Refused")),
		"single-file refusal",
		rpc.getStderr,
	);
	if (!note.message.includes("single-file")) fail(`single-file refusal is unclear:\n${note.message}`);
	if (JSON.stringify(readGlobal()) !== JSON.stringify(globalBeforeRefusal)) {
		fail(`single-file refusal wrote settings: ${JSON.stringify(readGlobal())}`);
	}
	await waitForCommands(["single"], true);
	console.log("ok: a single-file package toggle is refused with a clear message and nothing is written");

	// The headless table agrees with the live session state.
	seen = rpc.notifies.length;
	await rpc.request("prompt", { message: "/resources" });
	note = await waitFor(
		() => rpc.notifies.slice(seen).find((n) => (n.message ?? "").startsWith("resources (global view)")),
		"/resources table after package toggles",
		rpc.getStderr,
	);
	const quotaLine = (note.message ?? "").split("\n").find((l) => l.startsWith("quota.ts")) ?? "";
	if (!quotaLine.includes("(package)") || !quotaLine.includes("enabled")) {
		fail(`/resources does not show quota.ts as an enabled package resource:\n${note.message}`);
	}
	console.log("ok: the headless table agrees with the live session");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

// --- helpers -------------------------------------------------------------------

async function waitForCommands(names, present) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const list = (await rpc.request("get_commands")).data.commands.map((c) => c.name);
		const ok = present ? names.every((n) => list.includes(n)) : names.every((n) => !list.includes(n));
		if (ok) return;
		if (Date.now() > deadline) fail(`commands ${JSON.stringify(names)} not ${present ? "present" : "gone"}: ${list}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

console.log("resource-toggle E2E passed");
