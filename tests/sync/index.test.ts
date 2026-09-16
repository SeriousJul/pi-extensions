/**
 * The pi entrypoint's TUI wiring, pinned on a mock pi. The startup notice
 * (issue #36): the probe logic itself is covered in ops.test.ts; here we pin
 * what the wiring decides about the status line: a token-holding device that
 * has not joined shows the `run /sync init` nudge, a device with no token
 * stays silent, and the token file on disk is read from the state dir the
 * same way the probe does. The not-joined path never reaches the backend, so
 * these tests run with no network and no real token.
 *
 * The device flow dialog (issue #37): the dialog shows the one-time code by
 * updating a mounted component. The TUI only repaints when the component
 * asks for it, so every status change must request a render; the loopback
 * stub answers the device code request slowly, like real GitHub does, so the
 * code line lands after the dialog's first paint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import syncExtension from "../../extensions/sync/index.ts";
import { writeManagedToken } from "../../extensions/sync/token.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface StatusCall {
	key: string;
	value: string | undefined;
}

const NUDGE = "sync: not joined - run /sync init";

function makeCtx(calls: StatusCall[]): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => {
				calls.push({ key, value });
			},
		},
	} as unknown as ExtensionContext;
}

/** Load the real entrypoint on a mock pi and grab the session_start handler. */
async function loadSession(): Promise<{ calls: StatusCall[]; fire: () => void }> {
	const calls: StatusCall[] = [];
	let onSessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (name === "session_start") onSessionStart = fn;
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	syncExtension(pi);
	const ctx = makeCtx(calls);
	return {
		calls,
		fire: () => onSessionStart!({}, ctx),
	};
}

/** The value the status line last took (the line is always the "sync" key). */
function lastStatus(calls: StatusCall[]): string | undefined {
	return calls[calls.length - 1]?.value;
}

function settle(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

/** Poll a condition the background notice drives, with a bounded timeout. */
async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await settle(5);
	}
}

const ENV_KEYS = ["PI_SYNC_TOKEN", "PI_SYNC_STATE_DIR", "PI_SYNC_HOME", "PI_SYNC_GITHUB_BASE_URL", "PI_SYNC_OAUTH_CLIENT_ID"] as const;
const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(async () => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k]!;
	}
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("startup notice at the entrypoint seam (issue #36)", () => {
	it("nudges when a token exists but the device has not joined", async () => {
		process.env.PI_SYNC_TOKEN = "ghs_test";
		process.env.PI_SYNC_HOME = await tempDir("sync-idx-home-");
		process.env.PI_SYNC_STATE_DIR = await tempDir("sync-idx-state-");
		const { calls, fire } = await loadSession();
		fire();
		await until(() => lastStatus(calls) === NUDGE, "the not-joined nudge");
		expect(lastStatus(calls)).toBe(NUDGE);
	});

	it("stays silent when there is no token", async () => {
		delete process.env.PI_SYNC_TOKEN;
		process.env.PI_SYNC_HOME = await tempDir("sync-idx-home-");
		process.env.PI_SYNC_STATE_DIR = await tempDir("sync-idx-state-");
		const { calls, fire } = await loadSession();
		fire();
		// Give the background notice a chance to (wrongly) show the nudge.
		await settle(80);
		expect(lastStatus(calls)).toBeUndefined();
		expect(calls.some((c) => c.value === NUDGE)).toBe(false);
	});

	/**
	 * A joined device against a loopback GitHub: the API 401s any access
	 * token but the refreshed one, and the OAuth endpoint renews only the
	 * live refresh token. The state dir holds the manifest and an expired
	 * managed token, so only a renewed token can read the gist.
	 */
	async function joinedHome(refreshLive: boolean): Promise<{ home: string; state: string; url: string; close: () => Promise<void> }> {
		const home = await tempDir("sync-idx-home-");
		const state = await tempDir("sync-idx-state-");
		await writeFile(join(home, "AGENTS.md"), "local v2\n");
		await writeManagedToken(state, {
			accessToken: "ghs_expired",
			refreshToken: "rt-live",
			obtainedMs: Date.now() - 9 * 3600 * 1000,
			expiresMs: Date.now() - 3600 * 1000, // expired an hour ago
		});
		const manifest = { v: 1, backend: "github-gist", backendOptions: { gistId: "e2e-gist-id" }, include: ["AGENTS.md"], exclude: [] };
		await writeFile(join(state, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
		const gist = {
			id: "e2e-gist-id",
			updated_at: new Date(Date.now() - 3600 * 1000).toISOString(),
			files: {
				[".pi-sync-manifest.json"]: { content: JSON.stringify({ ...manifest, backendOptions: {} }) },
				["AGENTS.md"]: { content: "remote v1\n" },
			},
		};
		const server = createServer((req, res) => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.method === "POST" && req.url === "/login/oauth/access_token") {
				let body = "";
				req.on("data", (c) => (body += c));
				req.on("end", () => {
					const data = JSON.parse(body || "{}") as { refresh_token?: string };
					if (refreshLive && data.refresh_token === "rt-live") {
						return send(200, { access_token: "ghs_new", refresh_token: "rt-live-2", expires_in: 28800 });
					}
					return send(400, { error: "bad_refresh_token" });
				});
				return;
			}
			if (req.method === "GET" && req.url === "/gists/e2e-gist-id") {
				if (req.headers.authorization === "Bearer ghs_new") return send(200, gist);
				return send(401, { message: "Bad credentials" });
			}
			send(404, { message: "no canned route" });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		return {
			home,
			state,
			url: `http://127.0.0.1:${port}`,
			close: () => new Promise<void>((r) => server.close(() => r())),
		};
	}

	it("renews an expired token at startup and shows the drift line", async () => {
		const env = await joinedHome(true);
		process.env.PI_SYNC_HOME = env.home;
		process.env.PI_SYNC_STATE_DIR = env.state;
		process.env.PI_SYNC_GITHUB_BASE_URL = env.url;
		process.env.PI_SYNC_OAUTH_CLIENT_ID = "e2e-client";
		try {
			const { calls, fire } = await loadSession();
			fire();
			// Only the renewed token can read the gist, so a drift line proves
			// the startup path renewed the token.
			// The herdr-style line keeps an up-arrow for ahead and a down-arrow
			// for behind; the mock theme strips the color.
			await until(() => /^sync: ↑\d+( ↓\d+)?$/.test(lastStatus(calls) ?? ""), "the drift line");
			expect(lastStatus(calls)).toMatch(/^sync: ↑\d+( ↓\d+)?$/);
		} finally {
			await env.close();
		}
	});

	it("stays silent when the token is expired and the refresh is dead", async () => {
		const env = await joinedHome(false);
		process.env.PI_SYNC_HOME = env.home;
		process.env.PI_SYNC_STATE_DIR = env.state;
		process.env.PI_SYNC_GITHUB_BASE_URL = env.url;
		process.env.PI_SYNC_OAUTH_CLIENT_ID = "e2e-client";
		try {
			const { calls, fire } = await loadSession();
			fire();
			// Give the background notice a chance to (wrongly) show a line.
			await settle(80);
			expect(calls.every((c) => c.value === undefined), "no status line at all").toBe(true);
		} finally {
			await env.close();
		}
	});
});

describe("device flow dialog repaint at the entry seam (issue #37)", () => {
	/**
	 * Loopback GitHub: the device code arrives 30 ms after the request (like
	 * real GitHub, after the dialog's first paint). The token never arrives.
	 */
	async function pendingStub(): Promise<{ url: string; close: () => Promise<void> }> {
		const server = createServer((req, res) => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.method === "POST" && req.url === "/login/device/code") {
				setTimeout(
					() => send(200, { device_code: "dc-1", user_code: "WXYZ-9999", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 60 }),
					30,
				);
				return;
			}
			if (req.method === "POST" && req.url === "/login/oauth/access_token") {
				return send(400, { error: "authorization_pending" });
			}
			send(404, { message: "no canned route" });
		});
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const { port } = server.address() as AddressInfo;
				resolve({
					url: `http://127.0.0.1:${port}`,
					close: () => new Promise<void>((r) => server.close(() => r())),
				});
			});
		});
	}

	interface DialogCapture {
		component: { render: (width: number) => string[]; handleInput: (data: string) => void };
		requestRender: ReturnType<typeof vi.fn>;
	}

	/** A TUI-mode ctx that captures custom dialogs and counts render requests. */
	function dialogCtx(captures: DialogCapture[]): ExtensionContext {
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
		};
		return {
			hasUI: true,
			mode: "tui",
			ui: {
				theme,
				setStatus: () => undefined,
				confirm: async () => false,
				custom: (factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => unknown) => {
					const requestRender = vi.fn();
					const component = factory({ requestRender }, theme, {}, () => undefined) as DialogCapture["component"];
					captures.push({ component, requestRender });
					return Promise.resolve(undefined);
				},
			},
		} as unknown as ExtensionContext;
	}

	it("asks the TUI to repaint when the code line arrives", async () => {
		delete process.env.PI_SYNC_TOKEN;
		process.env.PI_SYNC_OAUTH_CLIENT_ID = "e2e-client";
		process.env.PI_SYNC_HOME = await tempDir("sync-dlg-home-");
		process.env.PI_SYNC_STATE_DIR = await tempDir("sync-dlg-state-");
		const stub = await pendingStub();
		process.env.PI_SYNC_GITHUB_BASE_URL = stub.url;
		const captures: DialogCapture[] = [];
		let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		const pi = {
			on: () => undefined,
			registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				if (name === "sync") handler = def.handler;
			},
		} as unknown as ExtensionAPI;
		syncExtension(pi);
		try {
			const runPromise = handler!("init", dialogCtx(captures));
			await until(() => captures.length >= 1, "the device flow dialog");
			const dialog = captures[0];
			await until(() => dialog.component.render(80).join("\n").includes("WXYZ-9999"), "the code line in the dialog");
			// The status changed after the dialog's first paint. The TUI only
			// repaints on request, so the dialog must ask for it.
			expect(dialog.requestRender).toHaveBeenCalled();
			dialog.component.handleInput("\x1b"); // cancel: end the run
			await runPromise;
		} finally {
			await stub.close();
		}
	});
});
