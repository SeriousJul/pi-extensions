/**
 * The token lifecycle (issues #37, #38): the device flow protocol, the
 * refresh of a managed token, and the auth session that bounds them.
 * A stub OAuth transport keeps every test off the network.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthSession, type DeviceFlowHooks } from "../../extensions/sync/auth.ts";
import { createGistBackend, type GistTransport } from "../../extensions/sync/backends/github-gist.ts";
import { runDeviceFlow, type OAuthTransport } from "../../extensions/sync/deviceflow.ts";
import { needsProactiveRefresh, refreshAccessToken } from "../../extensions/sync/refresh.ts";
import { parseManagedToken, stateDirFor, tokenPathFor, writeManagedToken } from "../../extensions/sync/token.ts";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StubCall {
	path: string;
	body: Record<string, string>;
}

/**
 * A stub of the two GitHub OAuth endpoints. `deviceResponses` and
 * `tokenResponses` are consumed in order; the last one repeats.
 */
function stubOAuth(options: {
	deviceResponses?: { status: number; json: unknown }[];
	tokenResponses: { status: number; json: unknown }[];
}): { transport: OAuthTransport; calls: StubCall[] } {
	const calls: StubCall[] = [];
	let tokenIndex = 0;
	let deviceIndex = 0;
	const transport: OAuthTransport = {
		async request(method, url, opts) {
			const body = JSON.parse(opts.body ?? "{}") as Record<string, string>;
			const path = new URL(url).pathname;
			calls.push({ path, body });
			if (path === "/login/device/code") {
				const canned = (options.deviceResponses ?? [{ status: 200, json: { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.01 } }])[
					Math.min(deviceIndex++, (options.deviceResponses?.length ?? 1) - 1)
				];
				return { status: canned.status, text: JSON.stringify(canned.json) };
			}
			const canned = options.tokenResponses[Math.min(tokenIndex++, options.tokenResponses.length - 1)];
			return { status: canned.status, text: JSON.stringify(canned.json) };
		},
	};
	return { transport, calls };
}

describe("runDeviceFlow (issue #37)", () => {
	it("shows the code, polls, and stores the managed token pair on success", async () => {
		const home = await tempDir("pi-sync-df-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({
			tokenResponses: [
				{ status: 200, json: { error: "authorization_pending" } },
				{ status: 200, json: { error: "authorization_pending" } },
				{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } },
			],
		});
		const status: string[] = [];
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: (line) => status.push(line),
			askRetry: async () => false,
		});
		expect(result.ok).toBe(true);
		expect(result.token?.accessToken).toBe("at");
		expect(calls[0].body).toEqual({ client_id: "client-1", scope: "gist" });
		expect(calls[1].body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc", client_id: "client-1" });
		expect(status[0]).toContain("ABCD-1234");
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("at");
		expect(stored?.refreshToken).toBe("rt");
	});

	it("posts the device endpoints to the web host (github.com), not the API host", async () => {
		const home = await tempDir("pi-sync-df-host-");
		const stateDir = stateDirFor(home, {});
		const urls: string[] = [];
		const transport: OAuthTransport = {
			async request(_method, url) {
				urls.push(url);
				if (url.endsWith("/login/device/code")) {
					return { status: 200, text: JSON.stringify({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.01 }) };
				}
				return { status: 200, text: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 28800 }) };
			},
		};
		const result = await runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: () => undefined, askRetry: async () => false });
		expect(result.ok).toBe(true);
		// api.github.com answers the OAuth endpoints with a 404; the flow
		// must target the web host.
		expect(urls).toEqual(["https://github.com/login/device/code", "https://github.com/login/oauth/access_token"]);
	});

	it("surfaces GitHub's error when the device code request is refused", async () => {
		const home = await tempDir("pi-sync-df-disabled-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({
			deviceResponses: [{ status: 400, json: { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" } }],
			tokenResponses: [],
		});
		const result = await runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: () => undefined, askRetry: async () => false });
		expect(result.ok).toBe(false);
		// The error names what GitHub said, so an app without the device-flow
		// opt-in is fixable from the message.
		expect(result.error).toContain("device_flow_disabled");
		expect(result.error).toContain("Device Flow must be explicitly enabled for this App");
	});

	it("slow_down raises the polling interval by 5 seconds (RFC 8628)", async () => {
		vi.useFakeTimers();
		try {
			const home = await tempDir("pi-sync-df-slow-");
			const stateDir = stateDirFor(home, {});
			// The stub device answer polls every 10 ms; a slow_down must hold
			// the next poll back to 5 s 10 ms.
			const { transport, calls } = stubOAuth({
				tokenResponses: [
					{ status: 200, json: { error: "slow_down" } },
					{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } },
				],
			});
			const pending = runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: () => undefined, askRetry: async () => false });
			await vi.advanceTimersByTimeAsync(100);
			const polls = () => calls.filter((c) => c.path === "/login/oauth/access_token").length;
			expect(polls()).toBe(1); // still sleeping the raised interval
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await pending;
			expect(result.ok).toBe(true);
			expect(polls()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers a fresh code on expired_token and re-runs from the top", async () => {
		const home = await tempDir("pi-sync-df-exp-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({
			deviceResponses: [
				{ status: 200, json: { device_code: "dc1", user_code: "AAAA-1111", expires_in: 900, interval: 0.01 } },
				{ status: 200, json: { device_code: "dc2", user_code: "BBBB-2222", expires_in: 900, interval: 0.01 } },
			],
			tokenResponses: [
				{ status: 400, json: { error: "expired_token" } },
				{ status: 200, json: { access_token: "at2", refresh_token: "rt2", expires_in: 28800 } },
			],
		});
		const retries: number[] = [];
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: () => undefined,
			askRetry: async () => {
				retries.push(1);
				return true;
			},
		});
		expect(result.ok).toBe(true);
		expect(result.token?.accessToken).toBe("at2");
		expect(retries).toHaveLength(1);
		const codes = calls.filter((c) => c.path === "/login/device/code");
		expect(codes).toHaveLength(2); // a fresh code, never a silent retry
	});

	it("cancels when the user declines the retry after a denial", async () => {
		const home = await tempDir("pi-sync-df-denied-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "denied" } }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});

	it("reports an unknown flow error cleanly", async () => {
		const home = await tempDir("pi-sync-df-err-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "client_id_not_found" } }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "bad",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("client_id_not_found");
	});

	it("fails cleanly when the code request is rejected", async () => {
		const home = await tempDir("pi-sync-df-nocode-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ deviceResponses: [{ status: 401, json: { message: "Bad credentials" } }], tokenResponses: [{ status: 200, json: {} }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "bad",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBeUndefined();
		expect(result.error).toContain("could not start the device flow");
	});

	it("aborts cleanly", async () => {
		const home = await tempDir("pi-sync-df-abort-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { error: "authorization_pending" } }] });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			signal: controller.signal,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});

	it("drops its abort listener when each poll sleep ends (no growth over a long poll)", async () => {
		const home = await tempDir("pi-sync-df-listeners-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { error: "authorization_pending" } }] });
		const controller = new AbortController();
		const base = controller.signal;
		let adds = 0;
		let removes = 0;
		// Count the abort listeners the flow adds and removes on the signal.
		const signal: AbortSignal = new Proxy(base, {
			get(target, prop) {
				if (prop === "addEventListener") {
					return (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
						if (type === "abort") adds++;
						return target.addEventListener(type, listener, options);
					};
				}
				if (prop === "removeEventListener") {
					return (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
						if (type === "abort") removes++;
						return target.removeEventListener(type, listener, options);
					};
				}
				return Reflect.get(target, prop);
			},
		});
		const pending = runDeviceFlow({ stateDir, clientId: "client-1", transport, signal, onStatus: () => undefined, askRetry: async () => false });
		// The stub device answer polls every 10 ms; wait for several poll
		// sleeps to resolve, then the listeners must not have accumulated.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(adds).toBeGreaterThanOrEqual(3);
		expect(adds - removes).toBeLessThanOrEqual(1); // only the in-flight sleep keeps one
		controller.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});
});

describe("refresh of a managed token (issue #38)", () => {
	it("refreshes with the rolling refresh token and persists the new pair", async () => {
		const home = await tempDir("pi-sync-refresh-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at2", refresh_token: "rt2", expires_in: 28800 } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt", transport });
		expect(result.ok).toBe(true);
		expect(calls[0].body).toEqual({ grant_type: "refresh_token", client_id: "client-1", refresh_token: "rt" });
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("at2");
		expect(stored?.refreshToken).toBe("rt2");
	});

	it("keeps the old refresh token when the response omits it", async () => {
		const home = await tempDir("pi-sync-refresh-noroll-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at2", expires_in: 28800 } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt-kept", transport });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.token.refreshToken).toBe("rt-kept");
	});

	it("a rejected refresh means the refresh token is dead", async () => {
		const home = await tempDir("pi-sync-refresh-dead-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "bad_verification_code" } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt", transport });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.refreshDead).toBe(true);
	});

	it("needsProactiveRefresh triggers inside the skew window", () => {
		const now = Date.now();
		expect(needsProactiveRefresh({ expiresMs: now + 30_000 }, now)).toBe(true); // 5-minute skew
		expect(needsProactiveRefresh({ expiresMs: now + 10 * 60_000 }, now)).toBe(false);
		expect(needsProactiveRefresh({ expiresMs: now - 1_000 }, now)).toBe(true);
	});
});

describe("the auth session (issue #38)", () => {
	const hooks: DeviceFlowHooks = { onStatus: () => undefined, askRetry: async () => false };

	it("uses a hand-written token as-is and never manages it on 401", async () => {
		const home = await tempDir("pi-sync-auth-plain-");
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_TOKEN: "hand-written" } });
		expect(built.session?.token).toBe("hand-written");
		expect(built.session?.source).toBe("env");
		expect(await built.session?.renew()).toBeUndefined(); // hand-written: never refreshed
	});

	it("never refreshes or re-runs a hand-written plain-file token either", async () => {
		const home = await tempDir("pi-sync-auth-plainfile-");
		const stateDir = stateDirFor(home, {});
		await mkdir(stateDir, { recursive: true });
		await writeFile(tokenPathFor(stateDir), "plain-file-token\n", { mode: 0o600 });
		const { transport, calls } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } }] });
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			oauthTransport: transport,
			deviceFlow: { run: () => runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: hooks.onStatus, askRetry: hooks.askRetry }) },
		});
		expect(built.session?.token).toBe("plain-file-token");
		expect(built.session?.source).toBe("plain-file");
		expect(await built.session?.renew()).toBeUndefined(); // hand-written: never managed
		expect(calls).toHaveLength(0); // no refresh or device flow ever attempted
		expect((await readFile(tokenPathFor(stateDir), "utf8")).trim()).toBe("plain-file-token"); // untouched
	});

	it("reports the fix instead of starting a flow when no token exists in a non-interactive context", async () => {
		const home = await tempDir("pi-sync-auth-none-");
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home } });
		expect(built.session).toBeUndefined();
		expect(built.error).toContain("PI_SYNC_TOKEN");
	});

	it("names the setup step when a tty run has no OAuth client id", async () => {
		const home = await tempDir("pi-sync-auth-noclient-");
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home },
			deviceFlow: { run: async () => ({ ok: false, error: "should not run" }) },
		});
		expect(built.session).toBeUndefined();
		expect(built.error).toContain("setup-sync-wizard.sh");
	});

	it("starts the device flow on a fresh interactive device and stores the token", async () => {
		const home = await tempDir("pi-sync-auth-flow-");
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } }] });
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			deviceFlow: { run: () => runDeviceFlow({ stateDir: stateDirFor(home, { PI_SYNC_HOME: home }), clientId: "client-1", transport, onStatus: hooks.onStatus, askRetry: hooks.askRetry }) },
		});
		expect(built.session?.token).toBe("at");
		expect(built.session?.source).toBe("managed-file");
	});

	it("proactively re-runs the device flow in an interactive context when the stored refresh token is dead", async () => {
		const home = await tempDir("pi-sync-auth-proactive-dead-");
		const stateDir = stateDirFor(home, {});
		const soon = Date.now() + 60_000; // inside the 5-minute skew: proactive refresh triggers
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt-dead", obtainedMs: soon - 28_740_000, expiresMs: soon });
		// First token-endpoint call is the refresh (rejected: dead); the
		// second is the device-flow poll (granted a fresh pair).
		const { transport } = stubOAuth({
			tokenResponses: [
				{ status: 400, json: { error: "bad_verification_code" } },
				{ status: 200, json: { access_token: "flow-at", refresh_token: "flow-rt", expires_in: 28800 } },
			],
		});
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			oauthTransport: transport,
			deviceFlow: { run: () => runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: hooks.onStatus, askRetry: hooks.askRetry }) },
		});
		expect(built.session?.token).toBe("flow-at");
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("flow-at");
		expect(stored?.refreshToken).toBe("flow-rt");
	});

	it("proactively refreshes a managed token inside the skew window", async () => {
		const home = await tempDir("pi-sync-auth-proactive-");
		const stateDir = stateDirFor(home, {});
		const soon = Date.now() + 60_000; // inside the 5-minute skew
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt", obtainedMs: soon - 28_740_000, expiresMs: soon });
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "new", refresh_token: "rt2", expires_in: 28800 } }] });
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" }, oauthTransport: transport });
		expect(built.session?.token).toBe("new");
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("new");
	});

	it("renew() after a 401 refreshes once and persists; a second renew() is a no-op", async () => {
		const home = await tempDir("pi-sync-auth-renew-");
		const stateDir = stateDirFor(home, {});
		const far = Date.now() + 6 * 3_600_000; // outside the skew: no proactive refresh
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt", obtainedMs: far - 28_800_000, expiresMs: far });
		let refreshCalls = 0;
		const transport: OAuthTransport = {
			async request(_method, _url, opts) {
				refreshCalls++;
				expect(JSON.parse(opts.body ?? "{}").refresh_token).toBe("rt");
				return { status: 200, text: JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 28800 }) };
			},
		};
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" }, oauthTransport: transport });
		expect(built.session?.token).toBe("old");
		const first = await built.session?.renew();
		expect(first).toBe("new");
		const second = await built.session?.renew();
		expect(second).toBeUndefined(); // the session bound: at most one renewal
		expect(refreshCalls).toBe(1);
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("new");
	});

	it("renew() falls through to the device flow when the refresh token is dead", async () => {
		const home = await tempDir("pi-sync-auth-renew-flow-");
		const stateDir = stateDirFor(home, {});
		const far = Date.now() + 6 * 3_600_000;
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt-dead", obtainedMs: far - 28_800_000, expiresMs: far });
		// First token-endpoint call is the refresh (rejected: dead); the
		// second is the device-flow poll (granted a fresh pair).
		const { transport } = stubOAuth({
			tokenResponses: [
				{ status: 400, json: { error: "bad_verification_code" } },
				{ status: 200, json: { access_token: "flow-at", refresh_token: "flow-rt", expires_in: 28800 } },
			],
		});
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			oauthTransport: transport,
			deviceFlow: { run: () => runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: hooks.onStatus, askRetry: hooks.askRetry }) },
		});
		expect(built.session?.token).toBe("old");
		const renewed = await built.session?.renew();
		expect(renewed).toBe("flow-at");
	});

	it("a successful refresh whose token-file write fails returns a result instead of throwing", async () => {
		const stateDir = await tempDir("pi-sync-refresh-writefail-");
		// A directory where the token file belongs: the write must fail even as root.
		await mkdir(join(stateDir, "token"));
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "new", refresh_token: "rt2", expires_in: 28800 } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt", transport });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("could not be written");
			// The refresh already rotated the stored refresh token, so the
			// stored pair is dead: the device flow is the way back.
			expect(result.refreshDead).toBe(true);
		}
	});

	it("a mid-operation 401 walks one refresh attempt, one device-flow re-run, and one retry", async () => {
		const home = await tempDir("pi-sync-auth-chain-");
		const stateDir = stateDirFor(home, {});
		const far = Date.now() + 6 * 3_600_000; // outside the skew: no proactive refresh
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt-dead", obtainedMs: far - 28_800_000, expiresMs: far });
		// First token-endpoint call is the mid-operation refresh (rejected:
		// dead); the second is the device-flow poll (granted a fresh pair).
		const { transport: oauth } = stubOAuth({
			tokenResponses: [
				{ status: 400, json: { error: "bad_verification_code" } },
				{ status: 200, json: { access_token: "flow-at", refresh_token: "flow-rt", expires_in: 28800 } },
			],
		});
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			oauthTransport: oauth,
			deviceFlow: { run: () => runDeviceFlow({ stateDir, clientId: "client-1", transport: oauth, onStatus: hooks.onStatus, askRetry: hooks.askRetry }) },
		});
		expect(built.session?.token).toBe("old");
		// The gist side: 401 with the stale token, success with the flow token.
		const gistAuth: string[] = [];
		const gistTransport: GistTransport = {
			async request(_method, _url, opts) {
				gistAuth.push(opts.headers.Authorization ?? "");
				return gistAuth.length === 1
					? { status: 401, text: "" }
					: { status: 200, text: JSON.stringify({ id: "gid-1", updated_at: "2026-01-01T00:00:00Z", files: {} }) };
			},
		};
		const backend = createGistBackend({ gistId: "gid-1", token: built.session!.token, transport: gistTransport, onAuthFailure: built.session!.renew });
		const result = await backend.fetch();
		expect(result.ok).toBe(true);
		expect(gistAuth).toEqual(["Bearer old", "Bearer flow-at"]); // one retry, with the re-issued token
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("flow-at"); // the re-issued pair is persisted
	});
});
