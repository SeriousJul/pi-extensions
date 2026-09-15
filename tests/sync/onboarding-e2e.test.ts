/**
 * The onboarding proof (issue #40): the real CLI, in a real terminal, from a
 * clean home to a joined device. A loopback stub plays GitHub (the OAuth
 * device flow endpoints plus the Gist API); nothing touches the network.
 *
 * The "human" is the test: it reads the code the wizard prints, then
 * approves the device on the stub (entering the code), then answers the
 * preview confirm with y. A second clean device joins by id the same way.
 * The run is opt-in live against real GitHub: tests/sync/e2e-gist.mjs.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI_PATH = join(import.meta.dirname, "..", "..", "extensions", "sync", "cli.mjs");

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

/** Strip ANSI so pty output matches plainly. */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => resolve(body));
	});
}

/**
 * The loopback GitHub stub: the two OAuth device flow endpoints plus the
 * Gist API. `approve` plays the human: until it is set, the device code
 * polls return authorization_pending, exactly as before the code is entered.
 */
function githubStub(): Promise<{ url: string; approve: () => void; gist: { id: string; files: Record<string, string> } }> {
	const state = { approved: false };
	const gist = { id: "e2e-gist-1", files: {} as Record<string, string> };
	let gistExists = false;
	const server = createServer(async (req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method === "POST" && req.url === "/login/device/code") {
			return send(200, { device_code: "dc-e2e", user_code: "WXYZ-9999", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.02 });
		}
		if (req.method === "POST" && req.url === "/login/oauth/access_token") {
			const body = JSON.parse((await readBody(req)) || "{}") as { grant_type?: string };
			if (body.grant_type === "refresh_token") return send(200, { access_token: "e2e-at-2", refresh_token: "e2e-rt-2", expires_in: 28800 });
			if (!state.approved) return send(400, { error: "authorization_pending" });
			return send(200, { access_token: "e2e-at", refresh_token: "e2e-rt", expires_in: 28800 });
		}
		if (req.method === "GET" && req.url === `/gists/${gist.id}`) {
			if (!gistExists) return send(404, { message: "Not Found" });
			return send(200, { id: gist.id, updated_at: "2026-01-01T00:00:00Z", files: Object.fromEntries(Object.entries(gist.files).map(([n, c]) => [n, { content: c }])) });
		}
		if (req.method === "POST" && req.url === "/gists") {
			const parsed = JSON.parse((await readBody(req)) || "{}") as { files?: Record<string, { content: string } | null> };
			for (const [name, file] of Object.entries(parsed.files ?? {})) {
				if (file !== null) gist.files[name] = file.content;
			}
			gistExists = true;
			return send(201, { id: gist.id });
		}
		if (req.method === "PATCH" && req.url === `/gists/${gist.id}`) {
			const parsed = JSON.parse((await readBody(req)) || "{}") as { files?: Record<string, { content: string } | null> };
			for (const [name, file] of Object.entries(parsed.files ?? {})) {
				if (file === null) delete gist.files[name];
				else gist.files[name] = file.content;
			}
			return send(200, { id: gist.id });
		}
		send(404, { message: `no canned route for ${req.method} ${req.url}` });
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			servers.push(server);
			resolve({ url: `http://127.0.0.1:${port}`, approve: () => (state.approved = true), gist });
		});
	});
}

interface PtySession {
	child: ChildProcessWithoutNullStreams;
	output: () => string;
	waitFor: (needle: string, label: string) => Promise<void>;
	send: (line: string) => void;
	waitExit: () => Promise<number>;
}

/**
 * Run the real CLI on a real terminal (a pty via util-linux `script`), so
 * the interactive device flow and the preview confirm actually prompt.
 */
function runCliTty(args: string, env: Record<string, string>): PtySession {
	const child = spawn("script", ["-qec", `node ${CLI_PATH} ${args}`, "/dev/null"], {
		env: { ...process.env, TERM: "dumb", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	child.stdout.on("data", (d: Buffer) => (buffer += d.toString()));
	child.stderr.on("data", (d: Buffer) => (buffer += d.toString()));
	// Registered at spawn: a late registration can miss the exit event.
	const exitPromise = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
	return {
		child,
		output: () => stripAnsi(buffer),
		waitFor: (needle, label) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 30_000;
				const tick = () => {
					if (buffer.includes(needle)) return resolve();
					if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}; output so far:\n${stripAnsi(buffer)}`));
					setTimeout(tick, 100);
				};
				tick();
			}),
		send: (line) => child.stdin.write(line),
		waitExit: () => exitPromise,
	};
}

// The pty comes from util-linux `script`; skip where it is not installed.
const hasPtyScript = (() => {
	try {
		execFileSync("script", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!hasPtyScript)("onboarding proof: clean home to joined device (issue #40)", () => {
	it("walks the full wizard: device flow, create, preview confirm, joined second device", async () => {
		const stub = await githubStub();
		const homeA = await tempDir("pi-sync-onboard-a-");
		await writeFile(join(homeA, "AGENTS.md"), "# agents from A");
		const envA = { PI_SYNC_HOME: homeA, PI_SYNC_OAUTH_CLIENT_ID: "e2e-client", PI_SYNC_GITHUB_BASE_URL: stub.url };

		const cli = runCliTty("init", envA);
		try {
			// Step 1: the device flow asks for a code.
			await cli.waitFor("enter the code WXYZ-9999", "the device flow code prompt");
			// The human enters the code: the stub now approves the device.
			stub.approve();
			// Step 2: the token lands; the create path shows the preview.
			await cli.waitFor("token stored", "the token storage line");
			await cli.waitFor("preview, nothing written yet", "the create preview");
			// Step 3: the human confirms.
			cli.send("y\n");
			await cli.waitFor("created secret gist e2e-gist-1", "the created-gist line");
			const code = await Promise.race([cli.waitExit(), new Promise<number>((r) => setTimeout(() => r(-9999), 15_000))]);
			expect(code).toBe(0);
			expect(cli.output()).toContain("pushed 1 file(s)");
			expect(cli.output()).toContain("pi-sync init e2e-gist-1");

			// The clean home is now a joined device: managed token, manifest, base.
			const tokenText = (await readFile(join(homeA, ".pi", "sync", "token"), "utf8")).trim();
			const managed = JSON.parse(tokenText);
			expect(managed.v).toBe(1);
			expect(managed.origin).toBe("device-flow");
			expect(managed.accessToken).toBe("e2e-at");
			const manifest = JSON.parse(await readFile(join(homeA, ".pi", "sync", "manifest.json"), "utf8"));
			expect(manifest.backendOptions.gistId).toBe("e2e-gist-1");
			expect(stub.gist.files["AGENTS.md"]).toBe("# agents from A");
			expect(stub.gist.files[".pi-sync-manifest.json"]).toBeDefined();
		} finally {
			cli.child.kill("SIGKILL");
		}

		// The second clean device joins by id, the same wizard way.
		const homeB = await tempDir("pi-sync-onboard-b-");
		const envB = { PI_SYNC_HOME: homeB, PI_SYNC_OAUTH_CLIENT_ID: "e2e-client", PI_SYNC_GITHUB_BASE_URL: stub.url };
		const cliB = runCliTty(`init e2e-gist-1`, envB);
		try {
			await cliB.waitFor("arriving", "the join preview");
			await cliB.waitFor("Proceed?", "the join confirm");
			cliB.send("y\n");
			await cliB.waitFor("manifest adopted", "the join report");
			const code = await Promise.race([cliB.waitExit(), new Promise<number>((r) => setTimeout(() => r(-9999), 15_000))]);
			expect(code).toBe(0);
			expect(await readFile(join(homeB, "AGENTS.md"), "utf8")).toBe("# agents from A");
			expect(JSON.parse(await readFile(join(homeB, ".pi", "sync", "manifest.json"), "utf8")).backendOptions.gistId).toBe("e2e-gist-1");
		} finally {
			cliB.child.kill("SIGKILL");
		}
	}, 120_000);

	it("declining the preview writes nothing on either path", async () => {
		const stub = await githubStub();
		const homeA = await tempDir("pi-sync-onboard-n-");
		await writeFile(join(homeA, "AGENTS.md"), "# agents");
		const envA = { PI_SYNC_HOME: homeA, PI_SYNC_OAUTH_CLIENT_ID: "e2e-client", PI_SYNC_GITHUB_BASE_URL: stub.url };
		const cli = runCliTty("init", envA);
		try {
			await cli.waitFor("enter the code WXYZ-9999", "the device flow code prompt");
			stub.approve();
			await cli.waitFor("Proceed?", "the create confirm");
			cli.send("n\n");
			await cli.waitFor("init declined", "the decline line");
			const code = await Promise.race([cli.waitExit(), new Promise<number>((r) => setTimeout(() => r(-9999), 15_000))]);
			expect(code).toBe(1);
			// The token was stored (the flow is past), but the gist was not
			// created and the device did not join: no manifest, no base.
			expect(stub.gist.files).toEqual({});
			let manifestRead = "";
			try {
				manifestRead = await readFile(join(homeA, ".pi", "sync", "manifest.json"), "utf8");
			} catch {
				manifestRead = "";
			}
			expect(manifestRead).toBe("");
		} finally {
			cli.child.kill("SIGKILL");
		}
	}, 120_000);
});
