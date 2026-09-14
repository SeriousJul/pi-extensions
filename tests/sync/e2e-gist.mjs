/**
 * Opt-in E2E against the real GitHub, walking the full onboarding path:
 * clean home -> auth -> gist create -> preview confirm -> joined device.
 *
 * Two auth modes, picked by what you have set:
 *
 *   PAT mode (default): PI_SYNC_TOKEN holds a personal access token with
 *   gist scope. Non-interactive: init runs with --yes. Human actions: 0.
 *
 *   Device flow mode: PI_SYNC_OAUTH_CLIENT_ID (or the setup wizard's
 *   oauth-client.json in a throwaway home) plus a real terminal. The CLI
 *   runs on a pty and the human enters the device code in the browser,
 *   then confirms the preview. Human actions: 2 per device.
 *
 * Either way the run is measured for human actions and records the count.
 * The run is opt-in: without PI_SYNC_TOKEN or a client id it skips (exit 0),
 * so it is safe in CI.
 *
 *   node tests/sync/e2e-gist.mjs [--device-flow]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "extensions", "sync", "cli.mjs");
const token = process.env.PI_SYNC_TOKEN?.trim();
const clientId = process.env.PI_SYNC_OAUTH_CLIENT_ID?.trim();
const deviceFlow = process.argv.includes("--device-flow") || (!token && clientId);

// Deferred: record the first failure, let the finally block clean up the
// gist and homes, and exit non-zero only after the cleanup has run.
let failure = null;
function fail(message) {
	if (failure === null) failure = message;
}

if (!token && !clientId) {
	console.log("SKIP: set PI_SYNC_TOKEN (PAT, gist scope) for non-interactive mode,");
	console.log("      or PI_SYNC_OAUTH_CLIENT_ID (device flow, needs a terminal) for interactive mode.");
	console.log("      The real-GitHub e2e is opt-in; see extensions/sync/README.md.");
	process.exit(0);
}
if (deviceFlow && !clientId) fail("--device-flow needs PI_SYNC_OAUTH_CLIENT_ID (or scripts/setup-sync-wizard.sh)");
if (deviceFlow && !process.stdout.isTTY) fail("device flow mode needs a real terminal (a pty)");

const homes = [];
let gistId;
let humanActions = 0;

function humanAction(label) {
	humanActions += 1;
	console.log(`\nHUMAN ACTION ${humanActions}: ${label}`);
}

function newHome(name) {
	const home = mkdtempSync(join(tmpdir(), name));
	homes.push(home);
	return home;
}

function childEnv(home) {
	const env = { ...process.env, PI_SYNC_HOME: home, PI_SYNC_STATE_DIR: join(home, ".pi", "sync") };
	if (!token) delete env.PI_SYNC_TOKEN; // device flow mode: the homes must be clean of any token
	return env;
}

function runSync(home, args, label) {
	const result = spawnSync(process.execPath, [cliPath, ...args], { env: childEnv(home), encoding: "utf8" });
	if (result.status !== 0) fail(`${label} (exit ${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	return result.stdout ?? "";
}

/**
 * Device flow mode: run the CLI on a real terminal (util-linux `script`),
 * because the device flow and the preview confirm both prompt.
 */
function runSyncTty(home, args, label) {
	const result = spawnSync("script", ["-qec", `node ${cliPath} ${args}`, "/dev/null"], {
		env: { ...childEnv(home), TERM: process.env.TERM ?? "xterm" },
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (result.status !== 0) fail(`${label} (exit ${result.status})`);
}

function gistIdFromManifest(home) {
	const manifest = JSON.parse(readFileSync(join(home, ".pi", "sync", "manifest.json"), "utf8"));
	if (!manifest.backendOptions?.gistId) fail(`device manifest does not record the gist id: ${JSON.stringify(manifest.backendOptions)}`);
	return manifest.backendOptions.gistId;
}

const homeA = newHome("pi-sync-e2e-a-");
const homeB = newHome("pi-sync-e2e-b-");

try {
	// 1. Device A onboards: auth, then create the shared tree.
	writeFileSync(join(homeA, "AGENTS.md"), "# agents e2e\n");
	if (deviceFlow) {
		humanAction("in the browser, enter the device code the wizard prints (approve the pi sync app)");
		humanAction("confirm the create preview (type y)");
		runSyncTty(homeA, ["init"], "device A init (device flow)");
	} else {
		// PAT mode: the hand-written token is already in env; --yes answers
		// the preview confirm for the scripted run.
		const out = runSync(homeA, ["init", "--yes"], "device A init (create)");
		if (!out.includes("created secret gist")) fail(`create report missing the gist line:\n${out}`);
	}
	gistId = gistIdFromManifest(homeA);
	console.log(`ok: device A onboarded; created secret gist ${gistId}`);

	// 2. Device B joins by id and adopts the tree.
	if (deviceFlow) {
		humanAction("in the browser, enter the device code for the second device (approve the pi sync app)");
		humanAction("confirm the join preview (type y)");
		runSyncTty(homeB, [`init ${gistId}`], "device B init (device flow)");
	} else {
		const out = runSync(homeB, ["init", gistId, "--yes"], "device B init (join)");
		if (!out.includes("manifest adopted")) fail(`join report missing the adoption line:\n${out}`);
	}
	if (readFileSync(join(homeB, "AGENTS.md"), "utf8") !== "# agents e2e\n") fail("device B did not adopt AGENTS.md");
	console.log("ok: device B joined and adopted the tree");

	// 3. Device A edits and pushes; device B pulls. Machine actions only.
	writeFileSync(join(homeA, "AGENTS.md"), "# agents e2e v2\n");
	runSync(homeA, ["push"], "device A second push");
	runSync(homeB, ["pull"], "device B pull");
	if (readFileSync(join(homeB, "AGENTS.md"), "utf8") !== "# agents e2e v2\n") fail("device B pull did not take the new AGENTS.md");
	console.log("ok: device B pulled the edit");

	// 4. Device B status: in sync after the pull.
	const status = runSync(homeB, ["status"], "device B status");
	if (!status.includes("in sync")) fail(`status is not in sync:\n${status}`);
	console.log("ok: device B reports in sync");
} finally {
	// Delete the gist no matter what failed, then drop the homes.
	if (gistId) {
		let accessToken;
		if (token) {
			accessToken = token;
		} else {
			// Device flow mode: reuse the managed token device A stored.
			const managed = JSON.parse(readFileSync(join(homeA, ".pi", "sync", "token"), "utf8").trim());
			accessToken = managed.accessToken;
		}
		const del = spawnSync(
			process.execPath,
			[
				"-e",
				"const id = process.env.PI_SYNC_GIST_ID; const at = process.env.PI_SYNC_AT; fetch('https://api.github.com/gists/' + id, { method: 'DELETE', headers: { Authorization: 'bearer ' + at, 'User-Agent': 'pi-sync-e2e', Accept: 'application/vnd.github+json' } }).then((r) => console.log('gist delete: ' + r.status)).catch((e) => console.error('gist delete error: ' + e.message));",
			],
			{ stdio: "inherit", env: { PI_SYNC_GIST_ID: gistId, PI_SYNC_AT: accessToken } },
		);
		if (del.status !== 0) fail("could not run the gist cleanup");
	}
	for (const home of homes) rmSync(home, { recursive: true, force: true });
}

if (failure !== null) {
	console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(`\nPASS: sync e2e against the real GitHub (${deviceFlow ? "device flow" : "PAT"} mode)`);
console.log(`human actions: ${humanActions}`);
