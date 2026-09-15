/**
 * The one-time OAuth app setup (issue #34): the guided wizard that walks the
 * GitHub dashboard and writes the public client id to the sync state dir, and
 * the client id resolution the extension performs on every run.
 *
 * The wizard is driven with piped stdin (a "human" in the test) and a
 * loopback stub for the device-code check it runs against GitHub; nothing
 * touches the network.
 */
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createAuthSession } from "../../extensions/sync/auth.ts";
import { CLIENT_ID_ENV, clientIdPathFor, resolveClientId } from "../../extensions/sync/config.ts";
import { runDeviceFlow, type OAuthTransport } from "../../extensions/sync/deviceflow.ts";
import { stateDirFor } from "../../extensions/sync/token.ts";

const WIZARD_PATH = join(import.meta.dirname, "..", "..", "scripts", "setup-sync-wizard.sh");

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
function deviceCodeStub(
	respond: (client: string) => { status: number; json: unknown },
): Promise<{ url: string; seen: { client: string }[] }> {
	const seen: { client: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/login/device/code") {
				const client = new URLSearchParams(body).get("client_id") ?? "";
				seen.push({ client });
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
			resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen });
		});
	});
}

/** A bin dir that hides the browser opener and, optionally, curl. */
async function wizardBinDir(withCurl: boolean): Promise<string> {
	const bin = await tempDir("pi-sync-wiz-bin-");
	const opener = join(bin, "xdg-open");
	await writeFile(opener, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const tools = withCurl ? ["sed", "grep", "mktemp", "chmod", "mkdir", "curl"] : ["sed", "grep", "mktemp", "chmod", "mkdir"];
	for (const tool of tools) await symlink("/usr/bin/" + tool, join(bin, tool));
	return bin;
}

interface WizardRun {
	output: string;
	status: number | null;
}

/**
 * Run the real wizard script with piped stdin. `lines` are the human's
 * answers, in order (banner pause, pasted client id, confirms).
 */
function runWizard(lines: string[], env: Record<string, string>): Promise<WizardRun> {
	return new Promise((resolve) => {
		const child: ChildProcessWithoutNullStreams = spawn("/usr/bin/bash", [WIZARD_PATH], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (d: Buffer) => (output += d.toString()));
		child.stderr.on("data", (d: Buffer) => (output += d.toString()));
		child.stdin.write(lines.join("\n") + "\n");
		child.stdin.end();
		const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("close", (status) => {
			clearTimeout(guard);
			resolve({ output, status });
		});
	});
}

/** Read the client id the way the extension does, from this state dir. */
function readClientId(stateDir: string): string | undefined {
	return resolveClientId("", { PI_SYNC_STATE_DIR: stateDir }).clientId;
}

const WIZARD_ENV = (stateDir: string, baseUrl: string, binDir: string): Record<string, string> => ({
	PI_SYNC_STATE_DIR: stateDir,
	PI_SYNC_GITHUB_BASE_URL: baseUrl,
	PATH: `${binDir}:${process.env.PATH}`,
});

describe("resolveClientId (issue #34)", () => {
	it("reads the client id from the config file the wizard writes", async () => {
		const home = await tempDir("pi-sync-cid-");
		const stateDir = stateDirFor(home, {});
		await mkdir(stateDir, { recursive: true });
		await writeFile(clientIdPathFor(stateDir), JSON.stringify({ oauthClientId: "  file-client " }));
		const resolution = resolveClientId(home, {});
		expect(resolution.clientId).toBe("file-client");
		expect(resolution.error).toBeUndefined();
	});

	it("lets the environment override win over the config file", async () => {
		const home = await tempDir("pi-sync-cid-env-");
		const stateDir = stateDirFor(home, {});
		await mkdir(stateDir, { recursive: true });
		await writeFile(clientIdPathFor(stateDir), JSON.stringify({ oauthClientId: "file-client" }));
		const resolution = resolveClientId(home, { [CLIENT_ID_ENV]: "env-client" });
		expect(resolution.clientId).toBe("env-client");
		expect(resolution.error).toBeUndefined();
	});

	it("honors a custom state dir for the config file", async () => {
		const home = await tempDir("pi-sync-cid-dir-");
		const stateDir = await tempDir("pi-sync-cid-state-");
		await writeFile(clientIdPathFor(stateDir), JSON.stringify({ oauthClientId: "custom-dir-client" }));
		const resolution = resolveClientId(home, { PI_SYNC_STATE_DIR: stateDir });
		expect(resolution.clientId).toBe("custom-dir-client");
	});

	it("names the setup step when the config is absent, without a stack trace", async () => {
		const home = await tempDir("pi-sync-cid-none-");
		const resolution = resolveClientId(home, {});
		expect(resolution.clientId).toBeUndefined();
		expect(resolution.error).toContain("scripts/setup-sync-wizard.sh");
		expect(resolution.error).toContain("oauth-client.json");
		expect(resolution.error).toContain(CLIENT_ID_ENV);
		expect(resolution.error).not.toContain("    at ");
	});

	it("reports a malformed config as a fix, not a throw", async () => {
		const home = await tempDir("pi-sync-cid-bad-");
		const stateDir = stateDirFor(home, {});
		await mkdir(stateDir, { recursive: true });
		await writeFile(clientIdPathFor(stateDir), "not json");
		const broken = resolveClientId(home, {});
		expect(broken.clientId).toBeUndefined();
		expect(broken.error).toContain("not valid JSON");
		await writeFile(clientIdPathFor(stateDir), JSON.stringify({ other: 1 }));
		const missing = resolveClientId(home, {});
		expect(missing.clientId).toBeUndefined();
		expect(missing.error).toContain("oauthClientId");
	});
});

describe("createAuthSession with the client id from the config file (issue #34)", () => {
	it("feeds the device flow the id read from the config file, with no env override", async () => {
		const home = await tempDir("pi-sync-auth-cfg-");
		const stateDir = stateDirFor(home, {});
		await mkdir(stateDir, { recursive: true });
		await writeFile(clientIdPathFor(stateDir), JSON.stringify({ oauthClientId: "file-client" }));
		const seen: { client: string }[] = [];
		const transport: OAuthTransport = {
			async request(_method, _url, opts) {
				const body = JSON.parse(opts.body ?? "{}") as Record<string, string>;
				seen.push({ client: body.client_id ?? "" });
				const path = new URL(_url).pathname;
				if (path === "/login/device/code") {
					return { status: 200, text: JSON.stringify({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.01 }) };
				}
				return { status: 200, text: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 28800 }) };
			},
		};
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home },
			oauthTransport: transport,
			deviceFlow: { run: () => runDeviceFlow({ stateDir, clientId: resolveClientId(home, { PI_SYNC_HOME: home }).clientId ?? "", transport, onStatus: () => undefined, askRetry: async () => false }) },
		});
		expect(built.session?.token).toBe("at");
		expect(built.session?.source).toBe("managed-file");
		expect(seen.length).toBeGreaterThanOrEqual(1);
		for (const call of seen) expect(call.client).toBe("file-client"); // the config file id drove the flow
	});
});

describe("scripts/setup-sync-wizard.sh (issue #34)", () => {
	it("walks the dashboard, verifies the id against GitHub, and writes the config file", async () => {
		const stateDir = await tempDir("pi-sync-wiz-state-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" } }));
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789"], WIZARD_ENV(stateDir, stub.url, binDir));
		expect(run.status).toBe(0);
		for (const line of [
			"github.com/settings/developers",
			"New OAuth App",
			"Use expiring tokens",
			"http://127.0.0.1",
			"device flow opt-in box",
			"verified against GitHub",
		]) {
			expect(run.output, `missing "${line}"`).toContain(line);
		}
		expect(stub.seen).toEqual([{ client: "abcdef0123456789abcdef0123456789" }]);
		const file = clientIdPathFor(stateDir);
		const data = JSON.parse(await readFile(file, "utf8")) as { oauthClientId: string };
		expect(data.oauthClientId).toBe("abcdef0123456789abcdef0123456789");
		expect((await lstat(file)).mode & 0o777).toBe(0o600);
	});

	it("refuses to store an id GitHub rejects, unless the human insists", async () => {
		const stateDir = await tempDir("pi-sync-wiz-reject-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 400, json: { error: "invalid_client" } }));
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789", "n"], WIZARD_ENV(stateDir, stub.url, binDir));
		expect(run.status).toBe(1);
		expect(run.output).toContain("GitHub did not accept that client id");
		expect(readClientId(stateDir)).toBeUndefined();
	});

	it("names the fix when GitHub says the app has the device flow disabled", async () => {
		const stateDir = await tempDir("pi-sync-wiz-disabled-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 400, json: { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" } }));
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789", "y"], WIZARD_ENV(stateDir, stub.url, binDir));
		expect(run.status).toBe(0);
		expect(run.output).toContain("device flow is disabled for that app");
		expect(run.output).toContain("device flow opt-in box");
		// the wizard opens the settings page where the opt-in box lives
		expect(run.output).toContain(`${stub.url}/settings/developers`);
		expect(readClientId(stateDir)).toBe("abcdef0123456789abcdef0123456789");
	});

	it("stores anyway when the human accepts an id GitHub rejected", async () => {
		const stateDir = await tempDir("pi-sync-wiz-insist-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 400, json: { error: "invalid_client" } }));
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789", "y"], WIZARD_ENV(stateDir, stub.url, binDir));
		expect(run.status).toBe(0);
		expect(readClientId(stateDir)).toBe("abcdef0123456789abcdef0123456789");
	});

	it("re-runs idempotently: the same id changes nothing", async () => {
		const stateDir = await tempDir("pi-sync-wiz-again-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234" } }));
		const env = WIZARD_ENV(stateDir, stub.url, binDir);
		const first = await runWizard(["", "abcdef0123456789abcdef0123456789"], env);
		expect(first.status).toBe(0);
		const before = await readFile(clientIdPathFor(stateDir), "utf8");
		const second = await runWizard(["", "abcdef0123456789abcdef0123456789"], env);
		expect(second.status).toBe(0);
		expect(second.output).toContain("already stored");
		expect(await readFile(clientIdPathFor(stateDir), "utf8")).toBe(before);
		expect(readClientId(stateDir)).toBe("abcdef0123456789abcdef0123456789");
	});

	it("asks before replacing a stored id and keeps the old one on no", async () => {
		const stateDir = await tempDir("pi-sync-wiz-replace-");
		const binDir = await wizardBinDir(true);
		const stub = await deviceCodeStub(() => ({ status: 200, json: { user_code: "ABCD-1234" } }));
		const env = WIZARD_ENV(stateDir, stub.url, binDir);
		await runWizard(["", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], env);
		const run = await runWizard(["", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "n"], env);
		expect(run.status).toBe(0);
		expect(run.output).toContain("Replace the existing client id");
		expect(readClientId(stateDir)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	});

	it("refuses a value that does not look like a client id unless insisted", async () => {
		const stateDir = await tempDir("pi-sync-wiz-format-");
		const binDir = await wizardBinDir(true);
		const run = await runWizard(["", "not-a-hex-id", "n"], WIZARD_ENV(stateDir, "http://127.0.0.1:1", binDir));
		expect(run.status).toBe(1);
		expect(run.output).toContain("does not look like a GitHub client id");
		expect(readClientId(stateDir)).toBeUndefined();
	});

	it("degrades to a note and continues when curl is missing (offline machine)", async () => {
		const stateDir = await tempDir("pi-sync-wiz-nocurl-");
		const binDir = await wizardBinDir(false);
		// PATH is the bin dir alone: with a fallback, curl from /usr/bin would be found.
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789"], { ...WIZARD_ENV(stateDir, "http://127.0.0.1:1", binDir), PATH: binDir });
		expect(run.status).toBe(0);
		expect(run.output).toContain("curl is not installed");
		expect(readClientId(stateDir)).toBe("abcdef0123456789abcdef0123456789");
	});

	it("degrades to a warning and a confirm when GitHub is unreachable", async () => {
		const stateDir = await tempDir("pi-sync-wiz-offline-");
		const binDir = await wizardBinDir(true);
		const run = await runWizard(["", "abcdef0123456789abcdef0123456789", "y"], WIZARD_ENV(stateDir, "http://127.0.0.1:1", binDir));
		expect(run.status).toBe(0);
		expect(run.output).toContain("GitHub did not accept that client id");
		expect(readClientId(stateDir)).toBe("abcdef0123456789abcdef0123456789");
	});
});
