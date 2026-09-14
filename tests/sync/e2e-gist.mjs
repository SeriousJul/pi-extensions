/**
 * Opt-in E2E against the real GitHub Gist API.
 *
 * Runs the pi-sync CLI (jiti-loaded TypeScript) in two throwaway homes:
 *
 *   1. device A pushes: a secret gist is created, and the local manifest
 *      records the gist id
 *   2. device B inits by gist id: it adopts the shared tree
 *   3. device A edits and pushes; device B pulls the new content
 *   4. the gist is deleted again, so the run leaves no secret behind
 *
 * Needs a personal access token with gist scope in PI_SYNC_TOKEN. Without it
 * the run is skipped (exit 0), so it is safe in CI.
 *
 *   node tests/sync/e2e-gist.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "extensions", "sync", "cli.mjs");
const token = process.env.PI_SYNC_TOKEN?.trim();

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

if (!token) {
	console.log("SKIP: PI_SYNC_TOKEN is not set; the real-Gist e2e is opt-in.");
	process.exit(0);
}

const homes = [];
let gistId;

function newHome(name) {
	const home = mkdtempSync(join(tmpdir(), name));
	homes.push(home);
	return home;
}

function runSync(home, args) {
	const child = spawnSync(process.execPath, [cliPath, ...args], {
		env: { ...process.env, PI_SYNC_HOME: home, PI_SYNC_STATE_DIR: join(home, ".pi", "sync") },
		encoding: "utf8",
	});
	return { code: child.status, out: child.stdout ?? "", err: child.stderr ?? "" };
}

function expectOk(home, args, label) {
	const result = runSync(home, args);
	if (result.code !== 0) {
		fail(`${label} (exit ${result.code})\n${result.out}${result.err}`);
	}
	return result.out;
}

const homeA = newHome("pi-sync-e2e-a-");
const homeB = newHome("pi-sync-e2e-b-");

try {
	// 1. Device A pushes a fresh tree.
	writeFileSync(join(homeA, "AGENTS.md"), "# agents e2e\n");
	const firstPush = expectOk(homeA, ["push"], "device A first push");
	gistId = firstPush.match(/created secret gist (\S+)/)?.[1];
	if (!gistId) fail(`no gist id in the first push output:\n${firstPush}`);
	console.log(`ok: device A pushed, created gist ${gistId}`);

	const manifestA = JSON.parse(readFileSync(join(homeA, ".pi", "sync", "manifest.json"), "utf8"));
	if (manifestA.backendOptions?.gistId !== gistId) fail(`device A manifest does not record the gist id: ${JSON.stringify(manifestA.backendOptions)}`);

	// 2. Device B joins by id and adopts the tree.
	const init = expectOk(homeB, ["init", gistId], "device B init");
	if (!init.includes("manifest adopted")) fail(`init report missing the adoption line:\n${init}`);
	if (readFileSync(join(homeB, "AGENTS.md"), "utf8") !== "# agents e2e\n") fail("device B did not adopt AGENTS.md");
	console.log("ok: device B joined and adopted the tree");

	// 3. Device A edits and pushes; device B pulls.
	writeFileSync(join(homeA, "AGENTS.md"), "# agents e2e v2\n");
	expectOk(homeA, ["push"], "device A second push");
	expectOk(homeB, ["pull"], "device B pull");
	if (readFileSync(join(homeB, "AGENTS.md"), "utf8") !== "# agents e2e v2\n") fail("device B pull did not take the new AGENTS.md");
	console.log("ok: device B pulled the edit");

	// 4. Device B status: in sync after the pull.
	const status = expectOk(homeB, ["status"], "device B status");
	if (!status.includes("in sync")) fail(`status is not in sync:\n${status}`);
	console.log("ok: device B reports in sync");
} finally {
	// Delete the gist no matter what failed, then drop the homes.
	if (gistId) {
		const del = spawnSync(
			process.execPath,
			[
				"-e",
				`fetch("https://api.github.com/gists/${gistId}", { method: "DELETE", headers: { Authorization: "bearer ${token}", "User-Agent": "pi-sync-e2e", Accept: "application/vnd.github+json" } }).then((r) => console.log("gist delete: " + r.status)).catch((e) => console.error("gist delete error: " + e.message));`,
			],
			{ stdio: "inherit" },
		);
		if (del.status !== 0) fail("could not run the gist cleanup");
	}
	for (const home of homes) rmSync(home, { recursive: true, force: true });
}

console.log("PASS: sync e2e against the real GitHub Gist API");
