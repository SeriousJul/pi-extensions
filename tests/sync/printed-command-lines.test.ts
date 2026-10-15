/**
 * ADR 0039 (issue #135): every command line sync prints is runnable as
 * printed, from any working directory.
 *
 * The test does what a user does: it runs the real CLI
 * (`node .../extensions/sync/cli.mjs`) from a temporary working directory
 * outside the checkout, with a clean PI_SYNC_HOME and no OAuth client id,
 * and captures the error text. It then executes, verbatim, exactly the
 * command lines that text printed, and asserts they work: the wizard's
 * banner appears and it writes the client id file into the state dir, and
 * the CLI line runs the tool.
 *
 * It also covers a checkout copied into a path that contains a space (the
 * printed line must be quoted, and the quoted line must run), and the
 * Account setup script's own closing advice (an absolute CLI line, whether
 * the script is invoked by absolute path or by relative path).
 *
 * Nothing touches the network: a loopback stub plays the GitHub
 * device-code endpoint the wizard's live check posts to.
 */
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";


const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI_PATH = join(REPO_ROOT, "extensions", "sync", "cli.mjs");
const WIZARD_PATH = join(REPO_ROOT, "scripts", "setup-sync-wizard.sh");
const CLIENT_ID = "abcdef0123456789abcdef0123456789";

const dirs: string[] = [];
const servers: Server[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The loopback stand-in for GitHub's device-code endpoint: the wizard's
 * live check posts the pasted client id to ${base}/login/device/code.
 */
function deviceCodeStub(respond: (client: string) => { status: number; json: unknown }): Promise<{ url: string }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/login/device/code") {
				const client = new URLSearchParams(body).get("client_id") ?? "";
				const answer = respond(client);
				res.writeHead(answer.status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(answer.json));
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ message: "no canned route" }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			servers.push(server);
			resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
		});
	});
}

/** A bin dir that hides the browser opener and provides curl. */
async function wizardBinDir(): Promise<string> {
	const bin = await tempDir("pi-sync-print-bin-");
	await writeFile(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	for (const tool of ["sed", "grep", "mktemp", "chmod", "mkdir", "curl"]) await symlink("/usr/bin/" + tool, join(bin, tool));
	return bin;
}

/** The env a user would have: the OS env minus every PI_SYNC_* variable. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("PI_SYNC_")) env[key] = value;
	}
	return { ...env, ...extra };
}

interface ShellRun {
	output: string;
	status: number | null;
}

/**
 * Paste one line into a shell, exactly as a user would: `bash -c <line>`
 * from the given working directory, with piped stdin.
 */
function runShell(line: string, cwd: string, env: Record<string, string>, stdin: string = ""): Promise<ShellRun> {
	return new Promise((resolve) => {
		const child: ChildProcessWithoutNullStreams = spawn("bash", ["-c", line], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d: Buffer) => (output += d.toString()));
		child.stderr.on("data", (d: Buffer) => (output += d.toString()));
		if (stdin !== "") child.stdin.write(stdin);
		child.stdin.end();
		const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("close", (status) => {
			clearTimeout(guard);
			resolve({ output, status });
		});
	});
}

/** The wizard line the output printed: `bash <script>`, bare or single-quoted. */
function printedWizardLine(output: string): string {
	const m = output.match(/\bbash\s+('[^']+'|\S+)/);
	if (!m) throw new Error(`no \`bash ...\` command line in output:\n${output}`);
	const token = m[1].replace(/'/g, "");
	if (!token.endsWith("setup-sync-wizard.sh")) throw new Error(`the printed bash line is not the Account setup script:\n${output}`);
	return `bash ${m[1]}`;
}

/** The CLI entry the output printed: `node <abs cli.mjs>`, bare or quoted. */
function printedCliEntry(output: string): string {
	const m = output.match(/\bnode\s+('[^']*cli\.mjs[^']*'|[^\s]+?cli\.mjs)/);
	if (!m) throw new Error(`no \`node .../cli.mjs\` command line in output:\n${output}`);
	return `node ${m[1]}`;
}

/** The human's answers: the banner pause, then the pasted client id. */
const WIZARD_STDIN = `
${CLIENT_ID}
`;

describe("ADR 0039: printed command lines run as printed (issue #135)", () => {
	it("clean device: the CLI error names runnable lines, and they run", async () => {
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" } }));
		const binDir = await wizardBinDir();
		// The user's working directory: nowhere near the checkout.
		const cwd = await tempDir("pi-sync-print-cwd-");
		const home = await tempDir("pi-sync-print-home-");
		const stateDir = join(home, ".pi", "sync");
		const env = cleanEnv({
			PI_SYNC_HOME: home,
			PI_SYNC_STATE_DIR: stateDir,
			PI_SYNC_GITHUB_BASE_URL: stub.url,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		});

		// The real CLI, from outside the checkout, with a clean home and no
		// client id: the error it prints is what the user reads.
		const first = await runShell(`node ${CLI_PATH} init`, cwd, env);
		expect(first.status).toBe(1);
		const wizardLine = printedWizardLine(first.output);
		// The printed line names the script by an absolute path: it resolves
		// from the temporary working directory, not from the checkout.
		expect(wizardLine).toContain(WIZARD_PATH);
		// The CLI line the error printed names the CLI entry by absolute path.
		expect(printedCliEntry(first.output).replace(/'/g, "")).toContain(CLI_PATH);

		// The user pastes the printed wizard line. It runs, shows its banner,
		// and writes the client id into the state dir the CLI reads.
		const wizard = await runShell(wizardLine, cwd, env, WIZARD_STDIN);
		expect(wizard.status, wizard.output).toBe(0);
		expect(wizard.output).toContain("pi sync setup (GitHub OAuth app)");
		expect(wizard.output).toContain("2 stages");
		const file = join(stateDir, "oauth-client.json");
		const data = JSON.parse(await readFile(file, "utf8")) as { oauthClientId: string };
		expect(data.oauthClientId).toBe(CLIENT_ID);
		expect((await lstat(file)).mode & 0o777).toBe(0o600);

		// The absolute CLI line, from the same temporary working directory,
		// runs the tool. It reports the ordinary no-token fix, not a crash.
		const entry = printedCliEntry(first.output).replace(/'/g, "");
		const second = await runShell(`node ${entry} status`, cwd, env);
		expect(second.status).toBe(1);
		expect(second.output).toContain("pi-sync:");
		expect(second.output).not.toContain("Cannot find module");
	}, 60_000);

	it("a path with a space is printed quoted, and the quoted line runs", async () => {
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234" } }));
		const binDir = await wizardBinDir();
		// A copy of the checkout in a directory whose name contains a space,
		// as an install under a spaced path would be.
		const spaceRoot = await tempDir("pi sync-");
		cpSync(REPO_ROOT, spaceRoot, {
			recursive: true,
			filter: (src) => !src.includes("node_modules") && !src.endsWith(".git"),
		});
		symlinkSync(join(REPO_ROOT, "node_modules"), join(spaceRoot, "node_modules"));
		const cliCopy = join(spaceRoot, "extensions", "sync", "cli.mjs");
		const wizardCopy = join(spaceRoot, "scripts", "setup-sync-wizard.sh");
		const cwd = await tempDir("pi-sync-space-cwd-");
		const home = await tempDir("pi-sync-space-home-");
		const stateDir = join(home, ".pi", "sync");
		const env = cleanEnv({
			PI_SYNC_HOME: home,
			PI_SYNC_STATE_DIR: stateDir,
			PI_SYNC_GITHUB_BASE_URL: stub.url,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		});

		const first = await runShell(`node '${cliCopy}' init`, cwd, env);
		expect(first.status).toBe(1);
		// The spaced path is quoted, so the line is pasteable as printed.
		const wizardLine = printedWizardLine(first.output);
		expect(wizardLine).toBe(`bash '${wizardCopy}'`);

		// The user pastes the quoted line. It runs and writes the client id.
		const wizard = await runShell(wizardLine, cwd, env, WIZARD_STDIN);
		expect(wizard.status, wizard.output).toBe(0);
		expect(wizard.output).toContain("pi sync setup (GitHub OAuth app)");
		const data = JSON.parse(await readFile(join(stateDir, "oauth-client.json"), "utf8")) as { oauthClientId: string };
		expect(data.oauthClientId).toBe(CLIENT_ID);
		// The wizard's closing advice is an absolute CLI line into the copy,
		// quoted because the path has a space.
		expect(wizard.output).toContain(`node '${cliCopy}' init`);
	}, 60_000);

	it("the wizard's closing advice is an absolute CLI line, however it is invoked", async () => {
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234" } }));
		const binDir = await wizardBinDir();
		const home = await tempDir("pi-sync-print-adv-");
		const stateDir = join(home, ".pi", "sync");
		const env = cleanEnv({
			PI_SYNC_HOME: home,
			PI_SYNC_STATE_DIR: stateDir,
			PI_SYNC_GITHUB_BASE_URL: stub.url,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		});

		const runWizard = (scriptArg: string, cwd: string): Promise<ShellRun> =>
			runShell(`bash ${scriptArg}`, cwd, env, WIZARD_STDIN);

		// Invoked by absolute path, from a working directory outside the checkout.
		const byAbs = await runWizard(WIZARD_PATH, await tempDir("pi-sync-print-advcwd1-"));
		expect(byAbs.status, byAbs.output).toBe(0);
		expect(byAbs.output).toContain(`node ${CLI_PATH} init`);

		// Invoked by relative path from the checkout root: the advice is still
		// absolute.
		const byRel = await runWizard("scripts/setup-sync-wizard.sh", REPO_ROOT);
		expect(byRel.status, byRel.output).toBe(0);
		expect(byRel.output).toContain(`node ${CLI_PATH} init`);

		// The advice runs: from any working directory, the line starts the CLI.
		const advice = await runShell(`node ${CLI_PATH} init`, await tempDir("pi-sync-print-advrun-"), env);
		expect(advice.status).toBe(1);
		expect(advice.output).toContain("pi-sync:");
		expect(advice.output).not.toContain("Cannot find module");
	}, 60_000);
});
