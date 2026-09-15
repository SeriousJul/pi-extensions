import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutput } from "../../extensions/sync/cli.ts";

const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["PI_SYNC_HOME", "PI_SYNC_STATE_DIR", "PI_SYNC_TOKEN", "PI_SYNC_GITHUB_BASE_URL"];
const dirs: string[] = [];

function setEnv(values: Record<string, string>): void {
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		if (values[key] !== undefined) process.env[key] = values[key];
		else delete process.env[key];
	}
}
afterEach(async () => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture(): { output: CliOutput; lines: string[]; errors: string[] } {
	const lines: string[] = [];
	const errors: string[] = [];
	return { output: { out: (l) => lines.push(l), err: (l) => errors.push(l) }, lines, errors };
}

describe("pi-sync CLI argument handling", () => {
	it("prints usage for help and exits 0", async () => {
		setEnv({});
		const c = capture();
		const code = await main(["help"], c.output);
		expect(code).toBe(0);
		expect(c.lines.join("\n")).toContain("pi-sync init [gist-id] [--yes] [--force]");
	});

	it("prints usage with exit 2 when no command is given", async () => {
		setEnv({});
		const c = capture();
		expect(await main([], c.output)).toBe(2);
		expect(c.lines.join("\n")).toContain("usage:");
	});

	it("init without a gist id is the create path; without a token it explains the device flow", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-sync-cli-notoken-"));
		dirs.push(home);
		setEnv({ PI_SYNC_HOME: home });
		const c = capture();
		expect(await main(["init"], c.output)).toBe(1);
		expect(c.errors.join("\n")).toContain("PI_SYNC_TOKEN");
	});

	it("rejects an unknown command", async () => {
		setEnv({});
		const c = capture();
		expect(await main(["bogus"], c.output)).toBe(2);
		expect(c.errors.join("\n")).toContain("unknown command: bogus");
	});

	it("fails with the token guidance when no token is configured", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-sync-cli-"));
		dirs.push(home);
		setEnv({ PI_SYNC_HOME: home });
		const c = capture();
		expect(await main(["status"], c.output)).toBe(1);
		expect(c.errors.join("\n")).toContain("PI_SYNC_TOKEN");
	});
});

/**
 * A stateful secret gist over loopback HTTP: POST stores, PATCH replaces, GET
 * returns the current files. The real Gist transport runs against it; no
 * network is involved.
 */
function gistStub(id: string): Promise<{ url: string; close: () => Promise<void> }> {
	const state: Record<string, { content: string }> = {};
	let exists = false;
	const server = createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const gist = () => ({ id, updated_at: "2026-01-01T00:00:00Z", files: { ...state } });
		if (req.method === "GET" && req.url === `/gists/${id}`) {
			if (exists) return send(200, gist());
			return send(404, { message: "Not Found" });
		}
		if (req.method === "POST" && req.url === "/gists") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const parsed = JSON.parse(body);
				for (const [name, file] of Object.entries(parsed.files as Record<string, { content: string } | null>)) {
					if (file !== null) state[name] = file as { content: string };
				}
				exists = true;
				send(201, gist());
			});
			return;
		}
		if (req.method === "PATCH" && req.url === `/gists/${id}`) {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const parsed = JSON.parse(body);
				for (const [name, file] of Object.entries(parsed.files as Record<string, { content: string } | null>)) {
					if (file === null) delete state[name];
					else state[name] = file as { content: string };
				}
				send(200, gist());
			});
			return;
		}
		send(404, { message: `no canned route for ${req.method} ${req.url}` });
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
		});
	});
}

describe("pi-sync CLI end-to-end against a loopback Gist stub", () => {
	it("init without an id creates the gist; status then works; a second device joins by id", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-sync-cli-e2e-"));
		dirs.push(home);
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, "AGENTS.md"), "# agents");
		await writeFile(join(home, "OPINIONS.md"), "op");

		const stub = await gistStub("created-id");
		setEnv({ PI_SYNC_HOME: home, PI_SYNC_TOKEN: "loopback-token", PI_SYNC_GITHUB_BASE_URL: stub.url });

		const initA = capture();
		expect(await main(["init", "--yes"], initA.output)).toBe(0);
		// --yes confirms ahead, but the preview is still shown.
		expect(initA.lines.join("\n")).toContain("preview, nothing written yet");
		expect(initA.lines.join("\n")).toContain("created secret gist created-id");
		expect(initA.lines.join("\n")).toContain("pi-sync init created-id");

		// The local manifest records the gist id.
		const manifest = JSON.parse(await readFile(join(home, ".pi", "sync", "manifest.json"), "utf8"));
		expect(manifest.backendOptions.gistId).toBe("created-id");

		const status = capture();
		expect(await main(["status"], status.output)).toBe(0);
		expect(status.lines.join("\n")).toContain("pi sync status (gist created-id)");
		expect(status.lines.join("\n")).toContain("in sync");

		// A fresh device joins by id and receives the tree.
		const homeB = await mkdtemp(join(tmpdir(), "pi-sync-cli-e2e-b-"));
		dirs.push(homeB);
		setEnv({ PI_SYNC_HOME: homeB, PI_SYNC_TOKEN: "loopback-token", PI_SYNC_GITHUB_BASE_URL: stub.url });
		const init = capture();
		expect(await main(["init", "created-id", "--yes"], init.output)).toBe(0);
		// The join preview is shown too.
		expect(init.lines.join("\n")).toContain("preview, nothing written yet");
		expect(await readFile(join(homeB, "AGENTS.md"), "utf8")).toBe("# agents");
		expect(await readFile(join(homeB, "OPINIONS.md"), "utf8")).toBe("op");

		await stub.close();
	});

	it("a deleted gist is reported as not found with the gist id", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-sync-cli-gone-"));
		dirs.push(home);
		const stub = await gistStub("some-id");
		setEnv({ PI_SYNC_HOME: home, PI_SYNC_TOKEN: "loopback-token", PI_SYNC_GITHUB_BASE_URL: stub.url });
		await mkdir(join(home, ".pi", "sync"), { recursive: true });
		await writeFile(
			join(home, ".pi", "sync", "manifest.json"),
			JSON.stringify({ v: 1, backend: "github-gist", backendOptions: { gistId: "some-id" }, include: [], exclude: [] }),
		);
		const c = capture();
		expect(await main(["status"], c.output)).toBe(1);
		expect(c.errors.join("\n")).toContain("some-id");
		expect(c.errors.join("\n")).toContain("not found");
		await stub.close();
	});
});
